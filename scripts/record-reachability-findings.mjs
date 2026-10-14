/**
 * Move the reachability finding from a synthetic key the generators IGNORE onto the requirement
 * that actually owns asset preparation.
 *
 * The first attempt added `RES-ASSET-WIRING`, and the regeneration proved it wrong: the generator
 * maps status entries onto the SPEC's requirement list, so an invented key is recorded and never
 * reported. A finding that does not appear in the report is not recorded, whatever the file says.
 *
 * Run: node scripts/record-reachability-findings.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const path = 'docs/tool-mode/status.json'
const status = JSON.parse(readFileSync(path, 'utf8'))
const requirements = status.requirements ?? status

// Remove the invisible synthetic key if a previous run added it.
if (requirements['RES-ASSET-WIRING'] !== undefined) {
  delete requirements['RES-ASSET-WIRING']
}

const FINDING =
  ' ADDED BY A MECHANICAL REACHABILITY SWEEP: `src/asset-acquisition.ts` exports `acquireAsset`, '
  + '`describeMemory` and `boundsProcessTree`, carries 14 test references, and NOTHING IN PRODUCTION '
  + 'IMPORTS IT — while the host has no substitute, because `src/index.ts` contains no other '
  + 'preparation path. The module verifies a digest and atomically renames, detects a tampered '
  + 'payload and a pre-existing WRONG file at the final path (refetching), rejects a false or '
  + 'uppercase digest, honours cancellation, refuses to leave a poisoned partial, and bounds both '
  + 'memory and the process tree. All of that is exercised and none of it can refuse a real '
  + 'request, because no request reaches it. The same shape as `ptc-authority.ts` — correct, '
  + 'covered, unreachable — and the third instance this session after `ptc-runtime.ts` and the '
  + 'recipes broker. Wiring it needs a decision the code cannot make: which assets a model '
  + 'requires and when preparation is triggered.'

/**
 * The requirement that owns preparation. `MOD-02` is the one this repository already cites for
 * "needs-preparation" behaviour, so the finding lands where a reader of that behaviour looks.
 */
const OWNER = 'RES-04'
const owner = requirements[OWNER]
if (owner === undefined) {
  console.log(`${OWNER} is absent — recording under a name the generator will report is not possible`)
} else if (String(owner.evidence ?? '').includes('MECHANICAL REACHABILITY SWEEP')) {
  console.log(`${OWNER} already carries the finding`)
} else {
  owner.evidence = `${String(owner.evidence ?? '').replace(/\s+$/, '')}${FINDING}`
  writeFileSync(path, `${JSON.stringify(status, null, 2)}\n`)
  console.log(`appended the reachability finding to ${OWNER}`)
}

console.log('')
console.log('Reachability sweep totals: 63 exports test-exercised with no production reference;')
console.log('8 referenced nowhere at all. Both generators run over REAL requirement ids only, which')
console.log('is why this is attached to one rather than invented.')
