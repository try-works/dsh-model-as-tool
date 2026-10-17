/**
 * Materialize the official MCP v2 SDK packages the interop test drives.
 *
 * THE GAP THIS EXISTS TO CLOSE. The host package declares `@modelcontextprotocol/client`
 * and `@modelcontextprotocol/server` (2.3.1) as devDependencies, and the v2 interop test
 * is written against their real API — but a plain `npm install` in this repository CANNOT
 * fetch them: the host's own `@try-works/*` dependencies are unpublished workspace
 * packages, so npm walks them to the registry and dies with a 404, and an install at the
 * root prunes the `link:dsh` junctions this repo lives on. The result used to be a
 * skipped interop suite, i.e. the strongest conformance evidence silently absent.
 *
 * So this script does what npm cannot do here, the way `link:dsh` does it for the DSH
 * peers: it installs the pinned v2 packages into a THROWAWAY scratch project (which has
 * no `@try-works` dependencies to 404), then copies the packages that are missing from
 * this repository's `node_modules` into place. Copies are ADDITIVE and per-package:
 * anything already present is left alone, and no pruning happens anywhere, so the
 * `link:dsh` junctions survive.
 *
 * The pinned set is the registry-resolved closure of the two entry packages: npm
 * resolves `@modelcontextprotocol/core` (exact 2.3.1) and the transitive deps
 * (`zod`, `jose`, `cross-spawn`, `eventsource`, `pkce-challenge`, `eventsource-parser`)
 * in the scratch install; this script copies whatever of that closure is missing.
 *
 * Usage:
 *   node scripts/ensure-v2-sdk.mjs            # materialize when absent
 *   node scripts/ensure-v2-sdk.mjs --dry-run  # print what WOULD be done, change nothing
 */

import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeModules = join(root, 'node_modules')

const ENTRY_PACKAGES = ['@modelcontextprotocol/client@2.3.1', '@modelcontextprotocol/server@2.3.1']
const CLIENT_SENTINEL = join(nodeModules, '@modelcontextprotocol', 'client')

const dryRun = process.argv.includes('--dry-run')

/** Whether the interop packages are already materialized. */
function alreadyMaterialized() {
  return existsSync(CLIENT_SENTINEL)
}

if (alreadyMaterialized()) {
  console.log(`ensure-v2-sdk: ${CLIENT_SENTINEL} already present; nothing to do`)
  process.exit(0)
}

if (dryRun) {
  console.log('ensure-v2-sdk: DRY RUN — the following would be fetched into a scratch project and copied:')
  for (const entry of ENTRY_PACKAGES) console.log(`  install ${entry} (plus its registry-resolved closure)`)
  console.log('  then every missing package copied into', nodeModules)
  process.exit(0)
}

/**
 * Copy the missing packages from the scratch install into the repository's
 * node_modules, ADDITIVELY: an existing entry is never replaced, and scoped
 * directories merge package-by-package.
 * @param fromModules - the scratch node_modules.
 * @returns the number of copied package directories.
 */
function copyMissing(fromModules) {
  let copied = 0
  for (const entry of readdirSync(fromModules)) {
    const source = join(fromModules, entry)
    const target = join(nodeModules, entry)
    if (entry.startsWith('@')) {
      // A scope: merge its children one at a time so an unrelated package under the
      // same scope is untouched.
      for (const child of readdirSync(source)) {
        const childTarget = join(target, child)
        if (existsSync(childTarget)) continue
        if (dryRun) {
          console.log(`  would copy ${join(entry, child)}`)
          copied += 1
          continue
        }
        cpSync(join(source, child), childTarget, { recursive: true })
        console.log(`  copied ${join(entry, child)}`)
        copied += 1
      }
      continue
    }
    if (existsSync(target)) {
      console.log(`  kept existing ${entry} (not replaced)`)
      continue
    }
    if (dryRun) {
      console.log(`  would copy ${entry}`)
      copied += 1
      continue
    }
    cpSync(source, target, { recursive: true })
    console.log(`  copied ${entry}`)
    copied += 1
  }
  return copied
}

const scratch = mkdtempSync(join(tmpdir(), 'v2-sdk-'))
console.log(`ensure-v2-sdk: fetching the v2 packages into ${scratch}`)
// A scratch project with NO workspace dependencies: npm can resolve every package
// from the registry, which is exactly what a full-repo install cannot do here.
writeFileSync(join(scratch, 'package.json'), JSON.stringify({
  name: 'v2-sdk-scratch',
  version: '0.0.0',
  private: true,
}))

const npmArgs = [
  'install',
  '--no-save',
  '--package-lock=false',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  ...ENTRY_PACKAGES,
]
// Windows: a `.cmd` batch file cannot be spawned directly without a shell (EINVAL), so
// npm runs through cmd.exe exactly as a console would invoke it. The arguments are the
// constants above — nothing caller-supplied ever reaches the command line.
const command = process.platform === 'win32'
  ? { file: 'cmd.exe', args: ['/d', '/s', '/c', ['npm', ...npmArgs].map(quote).join(' ')] }
  : { file: 'npm', args: npmArgs }
const installed = spawnSync(command.file, command.args, { cwd: scratch, stdio: 'inherit' })

/** Quote one argument for cmd.exe, since the package specs are the only inputs. */
function quote(argument) {
  return /[\s"&|<>^]/.test(argument) ? `"${argument.replaceAll('"', '""')}"` : argument
}

if (installed.status !== 0) {
  rmSync(scratch, { recursive: true, force: true })
  console.error('ensure-v2-sdk: the scratch install failed; the registry may be unreachable.')
  console.error('The v2 interop test will stay skipped until the packages can be fetched.')
  process.exit(installed.status ?? 1)
}

const copied = copyMissing(join(scratch, 'node_modules'))
rmSync(scratch, { recursive: true, force: true })

if (dryRun) {
  console.log(`ensure-v2-sdk: dry run complete — ${copied} package(s) would be copied`)
} else if (!alreadyMaterialized()) {
  console.error('ensure-v2-sdk: the client package is STILL absent after copying; check the scratch install output')
  process.exit(1)
} else {
  console.log(`ensure-v2-sdk: ${copied} package(s) copied; the v2 interop suite can now run`)
}
