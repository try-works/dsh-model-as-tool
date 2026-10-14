/**
 * Link this workspace against a DSH checkout.
 *
 * The plugin declares `@deepseek-ai/*` as PEER dependencies: at runtime DSH
 * supplies them, exactly as it does for every other plugin. For local
 * development they have to resolve to something, so this script points them at
 * a DSH checkout's built packages.
 *
 * It exists as a script rather than a handful of hand-made links because
 * `npm install` prunes anything in `node_modules` it does not own — so the links
 * must be reproducible with one command after any install.
 *
 * Usage:
 *   node scripts/link-dsh.mjs [--checkout <path>]
 *   DSH_CHECKOUT=/path/to/deepseek-harness node scripts/link-dsh.mjs
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const checkoutFlag = args.indexOf('--checkout')
const checkout = resolve(
  checkoutFlag === -1 ? (process.env.DSH_CHECKOUT ?? 'D:/deepseek-harness') : args[checkoutFlag + 1],
)

if (!existsSync(checkout)) {
  console.error(`DSH checkout not found at ${checkout}`)
  console.error('Pass --checkout <path> or set DSH_CHECKOUT.')
  process.exit(1)
}

/**
 * Peer packages the plugin imports, and where each lives in the checkout.
 *
 * The keys are the specifiers the source imports; the values are paths relative
 * to the checkout root.
 */
const PEERS = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/schemastery': 'vendor/schemastery',
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
  '@deepseek-ai/dsh-skill': 'packages/skill/skill',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-system-prompt': 'packages/core/system-prompt',
  '@deepseek-ai/dsh-scope': 'packages/core/scope',
  '@deepseek-ai/dsh-agent': 'packages/core/agent',
  '@deepseek-ai/dsh-session': 'packages/core/session',
  '@deepseek-ai/dsh-util-values': 'packages/util/values',
  '@deepseek-ai/dsh-ptc-runtime': 'packages/ptc-runtime/ptc-runtime',
  /**
   * The Node PTC backend and the services it composes.
   *
   * `dsh-ptc-runtime-node` is NOT in this repo's node_modules and NOT in any DSH profile
   * directory — it resolves only from the base bundle. Without a link here the import
   * fails with ERR_MODULE_NOT_FOUND, which is what made slice 2 look like a missing
   * upstream product when it was a missing resolution path. Its own peer set is
   * `dsh-ptc-runtime, dsh-session, dsh-timeout, dsh-fs, dsh-subprocess, dsh-sandbox,
   * dsh-sandbox-policy`, and every target below was confirmed to exist on this host.
   */
  '@deepseek-ai/dsh-ptc-runtime-node': 'packages/ptc-runtime/ptc-runtime-node',
  '@deepseek-ai/dsh-fs': 'packages/fs/fs',
  '@deepseek-ai/dsh-fs-local': 'packages/fs/fs-local',
  '@deepseek-ai/dsh-subprocess': 'packages/subprocess/subprocess',
  '@deepseek-ai/dsh-subprocess-local': 'packages/subprocess/subprocess-local',
  '@deepseek-ai/dsh-sandbox': 'packages/sandbox/sandbox',
  '@deepseek-ai/dsh-sandbox-local': 'packages/sandbox/sandbox-local',
  '@deepseek-ai/dsh-session-projection': 'packages/session/session-projection',
  '@deepseek-ai/dsh-timeout': 'packages/util/timeout',
  '@deepseek-ai/dsh-user-approval': 'packages/interaction/user-approval',
  '@deepseek-ai/dsh-sandbox-policy': 'packages/sandbox/sandbox-policy',
}

/**
 * Link one directory, replacing whatever is there.
 * @param linkPath - the path to create.
 * @param target - the existing directory it should point at.
 * @returns whether the link was created.
 */
function link(linkPath, target) {
  if (!existsSync(target)) {
    console.warn(`  skipped ${linkPath} (missing target ${target})`)
    return false
  }
  mkdirSync(dirname(linkPath), { recursive: true })
  // Remove first: a stale real directory would silently shadow the checkout and
  // make the plugin test against a copy nobody updates.
  rmSync(linkPath, { recursive: true, force: true })
  // `junction` is used on Windows because directory symlinks need elevation
  // there; it resolves to the same thing for module resolution.
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  return true
}

let linked = 0
console.log(`linking peers from ${checkout}`)
for (const [specifier, relative] of Object.entries(PEERS)) {
  if (link(join(root, 'node_modules', ...specifier.split('/')), join(checkout, relative))) linked += 1
}

/**
 * This repository's own publishable packages, linked by their published names.
 *
 * Sibling packages must resolve the way an installed deployment resolves them —
 * through node_modules by package name — otherwise the host would work inside the
 * monorepo and fail once published. These are linked even though they live here,
 * because the point is to exercise the same resolution path a consumer uses.
 */
/**
 * Every workspace package, because the map must be COMPLETE.
 *
 * It listed four of eight, and the omission was not cosmetic: `@try-works/tool-mode-recipes`
 * could not be imported by anything, which is why a package with 132 passing tests had zero
 * consumers. A reachability defect that looks like an architectural choice is the hardest kind
 * to notice — the import simply fails, and the failure is attributed to the dependency spec
 * rather than to this list.
 */
const WORKSPACE = {
  '@try-works/tool-mode-contracts': 'packages/tool-mode-contracts',
  '@try-works/tool-mode-extension-sdk': 'packages/tool-mode-extension-sdk',
  '@try-works/tool-mode-recipes': 'packages/tool-mode-recipes',
  '@try-works/extension-desert-ant-tongue': 'packages/extension-desert-ant-tongue',
  '@try-works/extension-desert-ant-voz': 'packages/extension-desert-ant-voz',
  '@try-works/extension-embeddinggemma': 'packages/extension-embeddinggemma',
  '@try-works/extension-needle': 'packages/extension-needle',
  '@try-works/extension-declarative-recipes': 'packages/extension-declarative-recipes',
}
let workspaceLinked = 0
for (const [specifier, relative] of Object.entries(WORKSPACE)) {
  if (link(join(root, 'node_modules', ...specifier.split('/')), join(root, relative))) workspaceLinked += 1
}

// The host package itself is deliberately NOT linked into the root `node_modules`.
// Doing so makes npm treat it as a member of the dependency tree, and the next
// `npm install` then prunes everything inside its own `node_modules` — including
// the model packages the tests need. Scripts that want the host resolve it by
// path instead; `verify-built` reads its `main` field directly.
console.log(`linked ${linked}/${Object.keys(PEERS).length} peer package(s), ${workspaceLinked}/${Object.keys(WORKSPACE).length} workspace package(s)`)
if (linked < Object.keys(PEERS).length) {
  console.error('some peers are missing; the checkout may be incomplete or built differently')
  process.exit(1)
}
