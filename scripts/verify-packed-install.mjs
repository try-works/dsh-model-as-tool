/**
 * AT-01 — install the BUILT tarballs into a CLEAN temp project and load them
 * through plain Node.
 *
 * The repo's own node_modules are junctions into the DSH checkout, so a test that
 * loads the plugin from the workspace proves nothing about installability. This
 * script packs every artifact — the host with its bundled contracts/sdk/recipes,
 * the extensions, and the full closure of DSH peer packages — into REAL tarballs,
 * rewrites the checkout's `workspace:` dependency refs to caret ranges the packed
 * set satisfies, installs them into a throwaway project, and then runs a child
 * that imports the plugin BY PACKAGE NAME under plain Node (no tsx, no tsconfig,
 * no workspace junction).
 *
 * Usage: node scripts/verify-packed-install.mjs [--checkout <path>]
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECKOUT = resolve(process.argv.includes('--checkout') ? process.argv[process.argv.indexOf('--checkout') + 1] : process.env.DSH_CHECKOUT ?? 'D:/deepseek-harness')

/** This repository's own publishable packages. */
const WORKSPACE = {
  '@try-works/tool-mode-contracts': 'packages/tool-mode-contracts',
  '@try-works/tool-mode-extension-sdk': 'packages/tool-mode-extension-sdk',
  '@try-works/tool-mode-recipes': 'packages/tool-mode-recipes',
  '@try-works/extension-desert-ant-tongue': 'packages/extension-desert-ant-tongue',
  '@try-works/extension-desert-ant-voz': 'packages/extension-desert-ant-voz',
}

const scratch = mkdtempSync(join(tmpdir(), 'packed-install-'))
const tarballs = join(scratch, 'tarballs')
const staging = join(scratch, 'staging')
const project = join(scratch, 'project')
mkdirSync(tarballs, { recursive: true })
mkdirSync(staging, { recursive: true })
mkdirSync(project, { recursive: true })

// On Windows the sandbox cannot spawn `npm.cmd` directly (EINVAL); route through
// the command processor, which is how the shell itself runs npm.
function npm(args, cwd, timeoutMs = 300_000) {
  const spawnArgs = process.platform === 'win32'
    ? { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', ['npm', ...args].join(' ')] }
    : { file: 'npm', args }
  return spawnSync(spawnArgs.file, spawnArgs.args, { cwd, encoding: 'utf8', timeout: timeoutMs })
}

/** Find a package directory in the checkout by its declared name. */
const NAME_INDEX = (() => {
  const index = new Map()
  for (const base of ['packages', 'vendor']) {
    const walk = (dir, depth) => {
      if (depth > 4 || index.size > 4000) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1)
        else if (entry.name === 'package.json') {
          try {
            const manifest = JSON.parse(readFileSync(join(dir, entry.name), 'utf8'))
            if (typeof manifest.name === 'string' && !index.has(manifest.name)) index.set(manifest.name, dir)
          } catch { /* not a package manifest */ }
        }
      }
    }
    walk(join(CHECKOUT, base), 0)
  }
  return index
})()

/**
 * Resolve the closure of `@deepseek-ai/*` packages the host needs at runtime.
 * Starting from the host's declared peers and dependencies, every `@deepseek-ai/*`
 * dep is followed through the checkout, so a clean install has every runtime
 * import available as a tarball.
 */
function resolveClosure() {
  const host = JSON.parse(readFileSync(join(ROOT, 'packages', 'dsh-model-as-tool', 'package.json'), 'utf8'))
  const seen = new Map()
  const queue = [...Object.keys(host.peerDependencies ?? {}), ...Object.keys(host.dependencies ?? {})]
    .filter(name => name.startsWith('@deepseek-ai/') || name.startsWith('@try-works/'))
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    const dir = name.startsWith('@try-works/') ? join(ROOT, WORKSPACE[name] ?? '') : NAME_INDEX.get(name)
    if (dir === undefined || dir === '') {
      console.warn(`  skipped ${name}: not found in the checkout`)
      continue
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    seen.set(name, { dir, manifest })
    for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const dep of Object.keys(manifest[section] ?? {})) {
        if (dep.startsWith('@deepseek-ai/') && !seen.has(dep) && !queue.includes(dep)) queue.push(dep)
      }
    }
  }
  return seen
}

/** Replace every `workspace:` version ref with a caret range over the closure's version. */
function rewriteWorkspaceRefs(manifest, closure) {
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, range] of Object.entries(manifest[section] ?? {})) {
      if (typeof range !== 'string' || !range.startsWith('workspace:')) continue
      const target = closure.get(dep)
      manifest[section][dep] = target ? `^${target.manifest.version}` : '*'
    }
  }
}

/** Copy a package to staging (without node_modules), rewrite, and pack it. */
function stageAndPack(name, dir, closure) {
  const copy = join(staging, name.replaceAll('/', '__'))
  cpSync(dir, copy, {
    recursive: true,
    filter: source => !source.includes(`${join('node_modules')}`),
  })
  const manifestPath = join(copy, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  rewriteWorkspaceRefs(manifest, closure)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  const result = npm(['pack', '--pack-destination', tarballs], copy)
  if (result.status !== 0) {
    console.error(result.stdout)
    console.error(result.stderr)
    throw new Error(`npm pack failed for ${name}`)
  }
  const filename = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)
  if (!filename?.endsWith('.tgz')) throw new Error(`npm pack printed no tarball name for ${name}: ${result.stdout}`)
  return join(tarballs, filename)
}

/** Pack one package DIRECTLY in place (no staging, no rewriting). */
function packInPlace(name, dir) {
  const result = npm(['pack', '--pack-destination', tarballs], dir)
  if (result.status !== 0) {
    console.error(result.stdout)
    console.error(result.stderr)
    throw new Error(`npm pack failed for ${name}`)
  }
  const filename = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)
  if (!filename?.endsWith('.tgz')) throw new Error(`npm pack printed no tarball name for ${name}: ${result.stdout}`)
  return join(tarballs, filename)
}

try {
  console.log(`packing into ${scratch}`)
  const closure = resolveClosure()
  console.log(`resolved ${closure.size} packages from the DSH checkout`)
  const packages = []
  // The host carries contracts/sdk/recipes as bundledDependencies; its prepack
  // stages them from the workspace SIBLINGS, which only exist at its real
  // location, so the host is packed IN PLACE (its own node_modules junctions are
  // restored by its postpack). The host declares no workspace: refs, so nothing
  // needs rewriting.
  packages.push(packInPlace('@try-works/dsh-model-as-tool', join(ROOT, 'packages', 'dsh-model-as-tool')))
  for (const [name, relative] of Object.entries(WORKSPACE)) {
    const dir = join(ROOT, relative)
    if (!existsSync(join(dir, 'lib', 'index.js'))) {
      console.warn(`  skipped ${name}: no built lib/`)
      continue
    }
    packages.push(stageAndPack(name, dir, closure))
  }
  for (const [name, { dir, manifest }] of closure) {
    if (manifest.private === true) continue
    packages.push(stageAndPack(name, dir, closure))
  }

  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: 'packed-install-probe', version: '1.0.0', private: true, type: 'module',
  }))

  // Install EVERYTHING from tarballs: no junctions and no workspace resolution.
  // Third-party transitive deps (ajv, @standard-schema/spec, model packages the
  // extensions optionally depend on) may come from the configured registry, which
  // AT-01 does not forbid — what it forbids is resolving the Tool Mode bundle
  // through source symlinks, which no tarball here does.
  console.log(`installing ${packages.length} tarballs into a clean project`)
  const install = npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', ...packages], project)
  if (install.status !== 0) {
    console.error(install.stdout)
    console.error(install.stderr)
    throw new Error('npm install failed')
  }

  // The probe: import the plugin BY NAME through the clean project's node_modules.
  const probe = `
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '@try-works/dsh-model-as-tool'

if (typeof plugin.apply !== 'function') throw new Error('no apply')
const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(SkillRegistry)
// THE DURABLE STATE IS ISOLATED: this harness must never read or write the
// developer's real ~/.dsh/model-as-tool/state.json. A persistent "disabled"
// choice there (left by a previous non-isolated run) silently removed
// lang_detect from the packed boot, which is the regression this line prevents.
await ctx.plugin(plugin, { stateFile: ${JSON.stringify(join(project, 'probe-state.json'))} })
const signal = new AbortController().signal
const result = await ctx.tools.execute({ signal, callId: ToolCallId('packed-1'), name: 'lang_detect', arguments: { text: 'kann ich das haben' } })
if (result.isError) throw new Error('lang_detect failed: ' + result.error.message)
if (result.value.language !== 'de') throw new Error('expected de, got ' + result.value.language)
console.log('PACKED-OK lang_detect -> ' + result.value.language)
// The CODE-09 confinement seam ships in the packed lib, so the packed artifact
// must prove it is INERT: without the operator marker the setter throws and the
// gate cannot be opened by code that merely imports the module. The subpath is
// not in the exports map, so the module is imported by RESOLVED FILE PATH — the
// same route an in-process module would use — and the assertion is on the
// setter's behavior, not on resolution failing.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
const hostDir = fileURLToPath(new URL('.', pathToFileURL(require.resolve('@try-works/dsh-model-as-tool/package.json'))))
delete process.env.DSH_PTC_CONFINEMENT_SEAM
const seam = await import(pathToFileURL(hostDir + 'lib/ptc-runtime.js').href)
try {
  seam.setConfinementDemonstratedForTest(true)
  throw new Error('the confinement seam opened without the operator marker')
} catch (error) {
  if (error instanceof Error && error.message === 'the confinement seam opened without the operator marker') throw error
  console.log('PACKED-OK confinement seam closed without the operator marker')
}
// The VOZ tarball is verified too: discovery runs the manifest's referenced-file
// check, so a tarball missing models.lock.json (the round-38 defect) fails here
// even though stt_transcribe is never called.
import { discoverExtension } from '@try-works/tool-mode-extension-sdk'
const vozDir = fileURLToPath(new URL('.', pathToFileURL(require.resolve('@try-works/extension-desert-ant-voz/package.json'))))
const voz = discoverExtension(vozDir)
if (voz.manifest.models.length === 0) throw new Error('voz declares no models')
console.log('PACKED-OK voz discovery -> ' + voz.manifest.models.map(model => model.id).join(', '))
await ctx.fiber.dispose()
`
  writeFileSync(join(project, 'probe.mjs'), probe)
  const run = spawnSync(process.execPath, [join(project, 'probe.mjs')], {
    cwd: project, encoding: 'utf8', timeout: 120_000,
  })
  if (run.status !== 0) {
    console.error('--- probe stdout ---')
    console.error(run.stdout)
    console.error('--- probe stderr ---')
    console.error(run.stderr)
    throw new Error('the packed plugin failed to load or infer')
  }
  console.log(run.stdout.trim())

  console.log('\nOK — the packed host and extension tarballs install into a clean project')
  console.log('     and the plugin loads and infers through plain Node with no workspace junction.')
} finally {
  /**
   * The host's prepack STAGES bundled dependencies into the workspace's real
   * node_modules (replacing junctions with directories) and its postpack cleans
   * them — but only when pack succeeds. A failure in between leaves the checkout
   * staged, so the cleanup is repeated here as insurance. It is a no-op when the
   * postpack already ran.
   */
  const cleanup = npm(['run', '--if-present', 'postpack'], join(ROOT, 'packages', 'dsh-model-as-tool'), 120_000)
  if (cleanup.status !== 0) {
    console.warn('bundle: postpack cleanup did not run; run `node packages/dsh-model-as-tool/scripts/stage-bundle.mjs --clean`')
  }
  rmSync(scratch, { recursive: true, force: true })
}
