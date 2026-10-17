/**
 * Install this repository's DSH plugin into a real DeepSeek Harness profile.
 *
 * This is the "make it testable" path. It mirrors how the reference plugin
 * (D:\DEV\dsh-memory) is installed: pack the package, let the harness install it
 * into a profile, declare it in `dsh.profile.bundles`, and prove the loader
 * composes the bundle patch with `--dump-config`.
 *
 * Steps:
 *   1. build the host package (and its bundled @try-works packages) unless --no-build
 *   2. initialize the profile if needed and give it the chosen template's bundles
 *   3. `npm pack` into the profile's own plugins/ dir (stable across temp cleanup;
 *      self-contained: bundledDependencies are inside the tarball)
 *   4. `dsh plugin --profile <p> add <tarball>`
 *   5. declare the package in the profile's `dsh.profile.bundles`
 *   6. `dsh --profile <p> --dump-config` and fail unless the plugin's row is present
 *
 * Usage:
 *   node scripts/install-dsh-plugin.mjs [--profile tool-mode-test] [--template web|headless|none]
 *       [--dsh-harness D:/deepseek-harness] [--no-build] [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const value = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const PROFILE = value('--profile', 'tool-mode-test')
const TEMPLATE = value('--template', 'web')
const HARNESS = resolve(value('--dsh-harness', process.env.DSH_HARNESS_ROOT ?? 'D:/deepseek-harness'))
const DSH_BIN = join(HARNESS, 'apps', 'cli', 'lib', 'bin.js')
const PKG_DIR = join(REPO, 'packages', 'dsh-model-as-tool')
const PKG_NAME = '@try-works/dsh-model-as-tool'

/** Shipped profile templates (apps/cli: PROFILE_TEMPLATES). */
const TEMPLATES = {
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  acp: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
  none: ['@deepseek-ai/dsh-base'],
}

/** Run a command and stream its output. npm must go through the command processor on win32. */
function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`)
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: options.capture === true ? 'pipe' : 'inherit',
    cwd: options.cwd ?? REPO,
    timeout: options.timeout ?? 600_000,
  })
}

/** `npm` refuses to spawn directly on Windows; route it through cmd.exe. */
function npm(args, options = {}) {
  if (process.platform === 'win32') {
    return run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', ['npm', ...args].join(' ')], options)
  }
  return run('npm', args, options)
}

const dsh = (args, options = {}) => run(process.execPath, [DSH_BIN, ...args], options)

function readdirNames(path) {
  return readdirSync(path, { withFileTypes: true })
}

/** Newest mtime under a directory, in ms. */
function newestMtime(dir) {
  let newest = 0
  const walk = path => {
    for (const entry of readdirNames(path)) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) walk(full)
      else newest = Math.max(newest, statSync(full).mtimeMs)
    }
  }
  if (existsSync(dir)) walk(dir)
  return newest
}

/** Build a package when its lib/ is absent or older than its sources. */
function buildIfStale(dir, config) {
  const source = join(REPO, dir, 'src')
  const lib = join(REPO, dir, 'lib', 'index.js')
  const libMtime = existsSync(lib) ? statSync(lib).mtimeMs : 0
  if (libMtime === 0 || newestMtime(source) > libMtime) {
    console.log(`building ${dir}`)
    run(process.execPath, [join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(REPO, dir, config)])
  }
}

function profileDir() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
  return join(home, 'profiles', PROFILE)
}

/** Ensure the profile exists and carries the chosen template's bundles plus ours. */
function ensureProfile() {
  const dir = profileDir()
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    // `--dump-config` initializes a profile on first use without booting it.
    dsh(['--profile', PROFILE, '--dump-config'], { capture: true, timeout: 300_000 })
  }
  if (!existsSync(manifestPath)) throw new Error(`the profile was not initialized: ${manifestPath} is missing`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const templateBundles = TEMPLATES[TEMPLATE] ?? TEMPLATES.web
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  // Keep the chosen template's bundles in order, then any other kept bundles, then ours.
  const next = [...templateBundles]
  for (const bundle of bundles) {
    if (!next.includes(bundle) && bundle !== PKG_NAME) next.push(bundle)
  }
  if (!next.includes(PKG_NAME)) next.push(PKG_NAME)
  manifest.dsh.profile.bundles = next
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`profile bundles: ${next.join(', ')}`)
  return dir
}

function pack(profile) {
  const stableDir = join(profile, 'plugins')
  mkdirSync(stableDir, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-plugin-pack-'))
  try {
    const output = npm(['pack', '--json'], { cwd: PKG_DIR, capture: true })
    const info = JSON.parse(output.slice(output.indexOf('[')))[0]
    const tarball = join(PKG_DIR, info.filename)
    const target = join(stableDir, info.filename)
    cpSync(tarball, target)
    rmSync(tarball, { force: true })
    console.log(`packed ${info.filename} (${info.entryCount} entries, ${info.size} bytes) -> ${target}`)
    return target
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function main() {
  if (!existsSync(DSH_BIN)) {
    throw new Error(`the DSH CLI was not found at ${DSH_BIN}; pass --dsh-harness <checkout>`)
  }
  if (!flag('--no-build')) {
    buildIfStale('packages/tool-mode-contracts', 'tsconfig.build.json')
    buildIfStale('packages/tool-mode-extension-sdk', 'tsconfig.build.json')
    buildIfStale('packages/tool-mode-recipes', 'tsconfig.build.json')
    buildIfStale('packages/dsh-model-as-tool', 'tsconfig.build.json')
  }
  const profile = ensureProfile()
  const tarball = pack(profile)
  if (flag('--dry-run')) {
    console.log(`dry-run: would install ${tarball} into profile ${PROFILE} (${profile})`)
    return
  }
  dsh(['plugin', '--profile', PROFILE, 'add', tarball], { timeout: 1_200_000 })
  const manifestPath = join(profileDir(), 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!(manifest.dsh?.profile?.bundles ?? []).includes(PKG_NAME)) {
    // `dsh plugin add` normally reconciles the bundle list; be explicit if it did not.
    dsh(['--profile', PROFILE, '--dump-config'], { capture: true, timeout: 300_000 })
    const again = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const bundles = again.dsh?.profile?.bundles ?? []
    if (!bundles.includes(PKG_NAME)) {
      again.dsh ??= {}
      again.dsh.profile ??= {}
      again.dsh.profile.bundles = [...bundles, PKG_NAME]
      writeFileSync(manifestPath, `${JSON.stringify(again, null, 2)}\n`)
      console.log(`declared ${PKG_NAME} in dsh.profile.bundles`)
    }
  }
  const dump = dsh(['--profile', PROFILE, '--dump-config'], { capture: true, timeout: 300_000 })
  if (!dump.includes('model-tools') || !dump.includes(PKG_NAME)) {
    console.error('the composed profile tree does not contain the plugin row; dump follows:')
    console.error(dump.slice(0, 4000))
    process.exitCode = 1
    return
  }
  console.log(`OK — ${PKG_NAME} is installed and composed into profile "${PROFILE}"`)
  console.log(`boot the web profile with: node "${DSH_BIN}" ${PROFILE}`)
  console.log(`inspect the tree: node "${DSH_BIN}" --profile ${PROFILE} --dump-config`)
}

main()
