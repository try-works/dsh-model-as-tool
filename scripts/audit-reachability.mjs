/**
 * Reachability audit: which exported symbols does PRODUCTION code never reference?
 *
 * WHY THIS EXISTS. Three times this session a fully-tested component turned out to have zero
 * production callers — `ptc-authority.ts`, `ptc-runtime.ts`, and the entire recipes broker (132
 * passing tests, no importer). Each was found by a reviewer's aside or by accident, and each time
 * the cost was a segment of the work being provably correct and provably unreachable.
 *
 * A test suite cannot report this, because the suite imports by RELATIVE PATH: `foo.test.ts` can
 * exercise `foo.ts` forever while no production module ever mentions it. That is what makes
 * reachability a different question from coverage, and worth asking mechanically.
 *
 * WHAT IT DOES NOT PROVE. A symbol can be exported as a package's public API and legitimately
 * have no in-repo caller — that is what an SDK is. So this reports and a human decides; it is a
 * prompt for judgement, not a gate.
 *
 * Run: node scripts/audit-reachability.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = 'packages'
const isTest = path => /\.test\.ts$/.test(path)
const isDeclaration = path => /\.d\.ts$/.test(path)
const isBuildOutput = path => /[\\/](node_modules|lib|dist)[\\/]/.test(path)

/** Every `.ts`/`.mjs` file, tests included — tests are EVIDENCE of use, so they must be scanned. */
function sources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'lib' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sources(full, out)
    else if (/\.(ts|mjs)$/.test(entry) && !isDeclaration(full) && !isBuildOutput(full)) out.push(full)
  }
  return out
}

const all = sources(ROOT)
/** Read each file ONCE. */
const text = new Map(all.map(file => [file, readFileSync(file, 'utf8')]))

/** Exported declarations, keyed by the file that declares them. */
const exportsByFile = new Map()
for (const file of all) {
  if (isTest(file)) continue
  const body = text.get(file)
  const names = []
  for (const match of body.matchAll(
    /^export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm,
  )) names.push(match[1])
  // A re-export list contributes NAMES; an `export {}` with no source is a local re-export.
  for (const match of body.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop()?.trim()
      if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) names.push(name)
    }
  }
  if (names.length > 0) exportsByFile.set(file, [...new Set(names)])
}

/**
 * How often a name appears ANYWHERE, including the file that declares it.
 *
 * THE DECLARING FILE MUST BE COUNTED, and excluding it was a false-positive mode: `authorizePath`
 * is declared in `authority.ts` and USED at `authority.ts:317`, so it is wired — but a
 * cross-file-only count reports zero production references and flags it. The question worth asking
 * is whether a symbol is referenced at all beyond its own declaration, which is what this counts.
 *
 * The declaration itself is one occurrence, so the threshold is `> 1` rather than `> 0`.
 */
function references(name, declaringFile) {
  const pattern = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g')
  let production = 0
  let tests = 0
  for (const file of all) {
    const hits = (text.get(file).match(pattern) ?? []).length
    if (hits === 0) continue
    // One occurrence in the declaring file is the declaration; anything more is a use.
    const usable = file === declaringFile ? Math.max(0, hits - 1) : hits
    if (usable === 0) continue
    if (isTest(file)) tests += usable
    else production += usable
  }
  return { production, tests }
}

console.log('=== exported outside an entry point, with NO production reference ===')
console.log('')
const flagged = []
for (const [file, names] of exportsByFile) {
  for (const name of names) {
    const { production, tests } = references(name, file)
    if (production > 0) continue
    flagged.push({ file: relative('.', file), name, tests })
  }
}

/** Test-only use is the interesting case: exercised, never wired. */
const testOnly = flagged.filter(entry => entry.tests > 0)
const unused = flagged.filter(entry => entry.tests === 0)

console.log(`--- EXERCISED BY TESTS, NEVER WIRED (${testOnly.length}) — the pattern to look for ---`)
for (const entry of testOnly) console.log(`  ${entry.file}\n      ${entry.name}  (test references: ${entry.tests})`)
console.log('')
console.log(`--- no reference anywhere outside their own file (${unused.length}) — may be API surface ---`)
for (const entry of unused.slice(0, 20)) console.log(`  ${entry.file}  ${entry.name}`)
if (unused.length > 20) console.log(`  ... and ${unused.length - 20} more`)
console.log('')
console.log(`${flagged.length} flagged. A flagged symbol is a QUESTION, not a defect.`)
console.log('Entry-point files (index.ts, bin/*) are excluded: an SDK export legitimately has no in-repo caller.')
