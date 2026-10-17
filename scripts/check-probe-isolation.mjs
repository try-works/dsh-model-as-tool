/**
 * Regression guard: the verification probes must isolate their durable state.
 *
 * THE INCIDENT THIS PREVENTS. The round-67 orchestration script mounted the packed
 * plugin with `{}` config — no `stateFile` — so its AT-90 disable/enable chain
 * PERSISTED a tongue-disable into the developer's REAL `~/.dsh/model-as-tool/state.json`.
 * Every later default-config boot (the packed probe included) honored that persisted
 * choice, and `lang_detect` silently vanished from the verification pipeline. The fix
 * was state isolation in the three probe scripts; this guard makes a future un-isolated
 * mount FAIL THE PIPELINE instead of failing silently weeks later.
 *
 * What it asserts, mechanically, over the three probe scripts:
 * - every `ctx.plugin(plugin, <config>)` mount passes a `stateFile`;
 * - that path references a THROWAWAY location (the project/scratch dir or a temp dir),
 *   never a literal home path;
 * - the scripts never derive state storage from the developer's home or environment
 *   (`homedir`, `USERPROFILE`, `DSH_HOME`, `~/.dsh`, `defaultStateFile`).
 *
 * The guard checks ITSELF on every run: a deliberately un-isolated fixture mount and a
 * home-path fixture mount MUST be flagged, otherwise the detector is broken and the run
 * fails for that reason. A mount shape the guard cannot see also fails, so the scanner
 * cannot silently stop matching after a refactor.
 *
 * Usage:
 *   node scripts/check-probe-isolation.mjs          # gate: 0 when every mount is isolated
 *   node scripts/check-probe-isolation.mjs --list   # print the mounts found
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The probe scripts that mount the host plugin. */
const PROBES = [
  'scripts/verify-packed-install.mjs',
  'scripts/e2e-orchestration.mjs',
  'scripts/verify-built.mjs',
]

/** Anything that reads the developer's real configuration must never appear. */
const HOME_MARKERS = /\b(homedir|USERPROFILE|DSH_HOME|defaultStateFile)\b|\.dsh/

/** A plugin mount whose config is a single-line object literal (every current mount). */
const MOUNT = /ctx\.plugin\(\s*plugin\s*,\s*(\{[^}]*\})/g

/** Tokens that name a throwaway location rather than the operator's machine state. */
const THROWAWAY = /(project|scratch|stateDir|tmpdir|join\()/

const problems = []
const mounts = []

/** Strip comments so the guard reads CODE, not the incident notes that mention the home path. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
}

/** Scan one source text; every failure is appended to the given list. */
function scanInto(problemsOut, mountsOut, label, source) {
  const code = stripComments(source)
  const mountsHere = []
  for (const match of code.matchAll(MOUNT)) {
    const config = match[1]
    mountsHere.push(config)
    mountsOut.push(`${label}: ${config}`)
    if (!config.includes('stateFile')) {
      problemsOut.push(`${label} mounts the plugin without an isolated stateFile: ${config}`)
      continue
    }
    if (!THROWAWAY.test(config)) {
      problemsOut.push(`${label} names a stateFile outside a throwaway location: ${config}`)
    }
  }
  if (HOME_MARKERS.test(code)) {
    problemsOut.push(`${label} references the developer's home or environment for state storage`)
  }
  if (mountsHere.length === 0) {
    problemsOut.push(`${label} mounts the plugin in a shape this guard cannot see; extend the guard`)
  }
}

/**
 * The guard checks ITSELF first: a detector that cannot flag an un-isolated mount is
 * itself the defect this guard exists to prevent. The fixtures' EXPECTED failures are
 * asserted here and never counted against the real gate.
 */
function selfCheck() {
  const negativeFixtures = [
    ['fixture-unisolated', 'await ctx.plugin(plugin, {})'],
    ['fixture-home-path', 'await ctx.plugin(plugin, { stateFile: join(process.env.DSH_HOME, "model-as-tool/state.json") })'],
  ]
  for (const [label, source] of negativeFixtures) {
    const found = []
    scanInto(found, [], label, source)
    if (found.length === 0) {
      problems.push(`self-check: the guard FAILED to flag the ${label} fixture`)
    }
  }
  const positive = []
  scanInto(positive, [], 'fixture-isolated', 'await ctx.plugin(plugin, { stateFile: join(project, "probe-state.json") })')
  if (positive.length > 0) {
    problems.push('self-check: the guard FLAGGED a correctly isolated fixture mount')
  }
}

selfCheck()
for (const relative of PROBES) {
  scanInto(problems, mounts, relative, readFileSync(join(ROOT, relative), 'utf8'))
}

if (process.argv.includes('--list')) {
  for (const mount of mounts) console.log(mount)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`probe-isolation: ${problem}`)
  process.exit(1)
}
console.log(`probe-isolation: ${mounts.length} plugin mount(s) across ${PROBES.length} probe script(s), all with isolated state`)
