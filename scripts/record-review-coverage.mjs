/**
 * Record which parts of this repository HAVE been independently reviewed, and which have not.
 *
 * WHY THIS FILE EXISTS. Adversarial review has been the single most productive activity in this
 * work: the `-32021` value-type defect, a 413 body that was not a JSON-RPC error at all, the
 * pinned schema's non-uniform error definitions, and the entire `ptc-authority`/`ptc-runtime`
 * unreachability finding all came from reviewers rather than from the suite.
 *
 * That makes it important to say WHERE the review stops. A reader who sees two review reports in
 * a directory will reasonably assume the code was reviewed, and a review that silently covers
 * half the work is worse than none — it converts an open question into a false assurance. This is
 * the same failure the status file had when `MCP-01` contradicted `MCP-02` in the same document.
 *
 * Run: node scripts/record-review-coverage.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const path = 'docs/tool-mode/status.json'
const status = JSON.parse(readFileSync(path, 'utf8'))
const requirements = status.requirements ?? status

const COVERAGE =
  ' REVIEW COVERAGE, stated because a directory containing review reports invites the assumption '
  + 'that everything was reviewed. TWO independent adversarial reviews exist and both examined the '
  + 'MCP wire layer and the extension/security surface as they stood around round 10: '
  + '`docs/tool-mode/ADVERSARIAL-REVIEW-MCP.md` and `ADVERSARIAL-REVIEW-SECURITY.md`. Their '
  + 'findings were fixed rather than recorded — the runtime-shadow escape, the `-32021` shape, the '
  + 'HTTP-400 mapping, the defaulted required field, an advertised-but-unserved subscription '
  + 'feature, and the `ptc-authority`/`ptc-runtime` zero-caller discovery. WHAT IS NOT REVIEWED: '
  + 'everything built afterwards — the declarative slice end to end, the OBS-01/03/04 work, the '
  + 'live schema validation, the workspace link map, and the record reconciliation — has NOT been '
  + 'independently reviewed. TWO REVIEW ATTEMPTS WERE COMMISSIONED AND NEITHER DELIVERED: the first covered four large '
  + 'areas, the second was narrowed to a single file with a 200-line report cap and an explicit '
  + 'instruction to finish. Both were given the environment traps that cost their predecessors '
  + 'time. NO REPORT EXISTS from either, so the post-round-10 work stands as VERIFIED BY ITS '
  + 'AUTHOR — a weaker claim than the earlier work carries, and the honest reason the goal is '
  + 'left open rather than marked done.'

const OWNER = 'MCP-01'
const owner = requirements[OWNER]
if (owner === undefined) {
  console.log(`${OWNER} is absent; review coverage cannot be attached to a requirement`)
} else if (String(owner.evidence ?? '').includes('REVIEW COVERAGE')) {
  console.log(`${OWNER} already states the review coverage`)
} else {
  owner.evidence = `${String(owner.evidence ?? '').replace(/\s+$/, '')}${COVERAGE}`
  console.log(`attached review coverage to ${OWNER}`)
}

writeFileSync(path, `${JSON.stringify(status, null, 2)}\n`)
console.log('')
console.log('Attached to a REAL requirement id, because both generators map status entries onto')
console.log("the spec's requirement list — an invented key is written and never reported.")
