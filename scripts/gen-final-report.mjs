/**
 * Generate `verification/FINAL-REPORT.md` from the recorded evidence.
 *
 * GENERATED rather than written, for the same reason the traceability table is: a
 * hand-written summary of 317 tracked items drifts from the data it summarises, and the
 * drift is always in the flattering direction.
 *
 * The report states what is NOT achieved as prominently as what is, because the honest
 * headline of this work is that most of the normative requirements are not implemented.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const status = JSON.parse(readFileSync('docs/tool-mode/status.json', 'utf8'))
const inventory = JSON.parse(readFileSync('verification/requirements.json', 'utf8'))
const rows = inventory.requirements

const FAMILIES = {
  BASE: 'Foundational rules: tool identity, schemas, authority, packaging',
  ARCH: 'Host composition and responsibility boundaries',
  RUN: 'Listener, plugin and process lifecycle',
  MCP: 'Model Context Protocol wire conformance',
  SEC: 'Authorization, isolation and sandboxing',
  DECL: 'Authored-once declarations and discovery',
  TOOL: 'Per-tool behavioural contracts',
  MODEL: 'Model identity, qualification and capability',
  LIC: 'Licensing, attribution and permission records',
  RES: 'Resources, budgets, preparation and loading',
  CODE: 'Code Mode',
  OBS: 'Observability and diagnostics',
  EXT: 'Extension protocol and management',
  HLM: 'Host language model integration',
  RCP: 'Recipe runtime',
  DEC: 'Decision-tool decisions',
  NDL: 'Needle integration decisions',
  TDD: 'Verification discipline and evidence',
  MOD: 'Modular composition',
  P26: 'MCP revision 2026-07-28, section 20',
}

/** Families whose unstarted work is dominated by infrastructure that does not exist. */
const CAUSES = [
  ['needs a worker, PTC or recipe runtime that does not exist here', ['HLM', 'RCP', 'CODE', 'MOD']],
  ['needs a model or package that is not published', ['DEC', 'NDL']],
  ['needs a real model running to be exercised', ['TOOL', 'MODEL', 'RES']],
]

const byFamily = new Map()
for (const item of rows) {
  const family = item.id.startsWith('AT-') ? 'AT' : item.id.split('-')[0]
  if (!byFamily.has(family)) byFamily.set(family, { DONE: 0, PARTIAL: 0, BLOCKED: 0, NOT_RUN: 0 })
  const entry = byFamily.get(family)
  entry[item.requirementStatus] = (entry[item.requirementStatus] ?? 0) + 1
}

const totals = { DONE: 0, PARTIAL: 0, BLOCKED: 0, NOT_RUN: 0 }
for (const entry of byFamily.values()) {
  for (const key of Object.keys(totals)) totals[key] += entry[key] ?? 0
}
const total = rows.length
const normative = rows.filter(item => !item.id.startsWith('AT-')).length
const acceptance = total - normative

const done = rows.filter(item => item.requirementStatus === 'DONE')
const blocked = rows.filter(item => item.requirementStatus === 'BLOCKED')

/** The first sentence of an item's recorded evidence, for the blocked list. */
function firstSentence(id) {
  const evidence = status.requirements?.[id]?.evidence
  if (typeof evidence !== 'string') return ''
  return evidence.split(/(?<=\.)\s/)[0]
}

const out = []
const add = line => out.push(line)

add('# Tool Mode — final report')
add('')
add('**Generated** from `verification/requirements.json` and `docs/tool-mode/status.json`')
add('by `scripts/gen-final-report.mjs`. Do not edit by hand; run `npm run final-report`.')
add('')
add('## The headline, before the detail')
add('')
add(`Of **${total} tracked items** — ${normative} normative requirements and ${acceptance} acceptance `
  + `tests — **${totals.DONE} are done**, ${totals.PARTIAL} are partial, ${totals.BLOCKED} are blocked `
  + `by something outside this repository, and **${totals.NOT_RUN} were never started**.`)
add('')
add('**The objective is not achieved.** It asked for the Tool Mode specifications to be implemented and '
  + 'verified against the checklist. Most of the normative requirements are unimplemented. What follows '
  + 'states what genuinely stands and what does not, so the numbers above are not left to speak for '
  + 'themselves.')
add('')
add('## What genuinely stands')
add('')
add('Each claim below is verified by an artifact or an automated check, not by assertion.')
add('')
add('| Claim | How it is verified |')
add('| --- | --- |')
add('| Five packages are published and installable | `@try-works/dsh-model-as-tool@0.1.3`, `tool-mode-contracts@0.1.0`, `tool-mode-extension-sdk@0.1.0`, and both extensions at `0.1.0`, each confirmed by a consumer install from the registry |')
add('| The published host contains no model-specific code | `npm run verify:architecture` fails on a model name, branch or import in host source — and the installed artifact was read to confirm `tongue.js` and `voz.js` are absent from it |')
add('| Extensions depend only on the published SDK | The same gate: a host-package import, or a path escaping the package, is a violation |')
add('| The MCP layer conforms to revision `2026-07-28` | 39 checks against a pinned upstream schema, hashed and recorded at a specific commit |')
add('| The verification harness refuses to over-claim | A gate asserts the inventory never reports a pass for a partial requirement, never derives a pass from an absence of failure, and reports a blocked item as blocked |')
add('| There is one dispatch authority | A gate fails the build when a dispatch layer calls a tool definition\'s `execute` rather than the registry pipeline |')
add('| Shipped packages declare their licences | Both extensions declare all five layers with no gaps, resolved through the same discovery path a host uses |')
add('| A failed or interrupted preparation cannot become ready | Asserted for the acquisition path (digest verified before an atomic rename) and the deployment path (a failure is recorded and the next caller retries) |')
add('')
add('## The requirements that are done')
add('')
if (done.length === 0) add('_None._')
for (const item of done) {
  add(`- **${item.id}** — ${item.summary || '(no summary recorded)'}`)
}
add('')
add('## Blocked, with the concrete condition')
add('')
add('These are not implementation gaps. There is no artifact to integrate, and no further work inside '
  + 'this repository changes that.')
add('')
for (const item of blocked) {
  add(`- **${item.id}** — ${item.summary || ''}`)
  const sentence = firstSentence(item.id)
  if (sentence) add(`  - ${sentence}`)
}
add('')
add('## Where every family stands')
add('')
add('| Family | What it covers | Done | Partial | Blocked | Not run |')
add('| --- | --- | --- | --- | --- | --- |')
for (const family of Object.keys(FAMILIES).sort()) {
  const entry = byFamily.get(family)
  if (entry === undefined) continue
  add(`| \`${family}\` | ${FAMILIES[family]} | ${entry.DONE} | ${entry.PARTIAL} | ${entry.BLOCKED} | ${entry.NOT_RUN} |`)
}
const at = byFamily.get('AT')
if (at) {
  add(`| \`AT\` | The 90 acceptance tests from the verification checklist | ${at.DONE} | ${at.PARTIAL} | ${at.BLOCKED} | ${at.NOT_RUN} |`)
}
add('')
add('### The dominant cause is absent infrastructure, not absent effort')
add('')
for (const [cause, families] of CAUSES) {
  const count = families.reduce((sum, family) => sum + (byFamily.get(family)?.NOT_RUN ?? 0), 0)
  add(`- **${count} unstarted requirements ${cause}** — ${families.map(f => `\`${f}\``).join(', ')}`)
}
add('')
add('A worker runtime, a PTC runtime, a published decision package and a Node-distributed extraction '
  + 'model do not exist on this machine. Requirements that depend on them can be specified and '
  + 'recorded; they cannot be demonstrated, and they are not recorded as demonstrated.')
add('')
add('## What this report does not claim')
add('')
add('- It does not claim the specifications are implemented. Most are not.')
add('- It does not claim the partial items are nearly finished. Each carries its own recorded remaining '
  + 'scope, and many of those gaps are structural rather than incremental.')
add('- It does not treat a passing test suite as evidence about unimplemented requirements. The suite '
  + 'covers what exists, and says nothing about what does not.')
add('- It does not claim a green `npm run verify` means the work is complete. It means the code that '
  + 'exists is correct, which is a different and much smaller statement.')
add('')
add('## Reproducing every claim above')
add('')
add('```')
add('npm run verify         # typecheck, build, tests, architecture, MCP probe, inventory, traceability')
add('npm run verification   # regenerate verification/requirements.json from the recorded status')
add('npm run final-report   # regenerate this document')
add('npm run release:gate   # exits nonzero while any mandatory gate is not done -- RED BY DESIGN')
add('```')
add('')
add('`npm run release:gate` is deliberately red and is kept separate from `npm run verify`. Collapsing '
  + 'the two would make one of them lie: the suite passing means the code that exists is correct, and '
  + 'the release gate failing means the specifications are not finished. Both are true at once.')
add('')

writeFileSync('verification/FINAL-REPORT.md', out.join('\n'))
console.log(`final report written: ${total} items — ${totals.DONE} done, ${totals.PARTIAL} partial, ${totals.BLOCKED} blocked, ${totals.NOT_RUN} not run`)
