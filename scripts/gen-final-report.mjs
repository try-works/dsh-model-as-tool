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
  // MOD is the MULTIMODAL EmbeddingGemma family. An earlier version of this report
  // labelled it "modular composition" and grouped it with Code Mode purely because both
  // were unstarted, which is a reason to check a label rather than to invent one.
  MOD: 'Multimodal EmbeddingGemma 2 inference',
  P26: 'MCP revision 2026-07-28, section 20',
}

/**
 * Unstarted work that is IMPLEMENTATION, not a missing upstream artifact.
 *
 * Corrected after review. An earlier version of this report classified all four of the
 * following as external blockers. None of them is: DSH publishes PTC sources, EXT-20
 * assigns worker hosting to THIS project, MODEL-04 permits a managed native Windows
 * executable, and the Laya TypeScript source and checkpoint are both obtainable even
 * though the npm name is not. They are work not yet done, and calling them blocked
 * removed the obligation to do them.
 */
const IMPLEMENTATION_GAPS = [
  ['extension-host worker bridge and lifecycle (EXT-20)', ['EXT']],
  ['DSH PTC composition and the external run surface (CODE-01..03)', ['CODE']],
  ['provider-neutral LLM broker and recipe interpreter (HLM, RCP)', ['HLM', 'RCP']],
  ['multimodal EmbeddingGemma 2 inference (MOD-01..)', ['MOD']],
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
add('| The MCP wire layer is schema-conformant for revision `2026-07-28` | 39 checks that validate SAVED REQUEST/RESPONSE FIXTURES against the pinned, hashed upstream schema. **This is not live server conformance**: the probe reads frozen files from disk and never starts the server, which its own documentation states. Live conformance against the running server is not yet demonstrated. |')
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
add('## What actually runs on this host')
add('')
add('An earlier version of this report said no real model runs here. **That was wrong**, and '
  + '`scripts/verify-built.mjs` disproves it on every `npm run verify`:')
add('')
add('```')
add('$ npm run verify:built')
add('tools:      lang_detect, stt_transcribe, model_tools')
add('inference:  "kann ich das haben" -> de')
add('catalog:    18 models, 2 runnable, 2 installed')
add('skills:     desert-ant-tongue, desert-ant-voz')
add('OK — the built artifact loads through package main and works under plain Node.')
add('```')
add('')
add('That is a genuine inference through the BUILT artifact, resolved through the package '
  + '`main` under plain Node with no TypeScript loader, and it must return `de` for German or '
  + 'the check throws. Tongue is pure JavaScript with its weights bundled, so no runtime, '
  + 'download or accelerator is required. Voz runs through `onnxruntime-node` on CPU.')
add('')
add('The accurate statement is therefore much narrower than the one it replaced: **two of the '
  + 'eighteen catalogued models run on this host, and the other sixteen do not** — most because '
  + 'their LiteRT/TFLite runtime has no win32-x64 native build, `title` because it is Apple-only, '
  + 'and six because they are closed beta with no shipping SDK.')
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
add('### Unstarted work that is IMPLEMENTATION, not a missing artifact')
add('')
add('An earlier version of this report classified these as external blockers. That was wrong, '
  + 'and the correction matters because a blocker removes the obligation to do the work.')
add('')
for (const [gap, families] of IMPLEMENTATION_GAPS) {
  const count = families.reduce((sum, family) => sum + (byFamily.get(family)?.NOT_RUN ?? 0), 0)
  add(`- **${gap}** — ${count} unstarted requirements in ${families.map(f => `\`${f}\``).join(', ')}`)
}
add('')
add('Each of these is repository work with a known route: DSH publishes its PTC runtime sources, '
  + '`EXT-20` assigns managed executable worker hosting to this project, `MODEL-04` permits a '
  + 'managed native Windows executable, and the Laya TypeScript source and trained checkpoint are '
  + 'obtainable even though the npm name is not.')
add('')
add('### Genuinely external, and narrowly stated')
add('')
add('- **npm `laya-ts` returns 404.** This makes the npm ROUTE unavailable. It does **not** '
  + 'establish that the TypeScript implementation or the checkpoint is unavailable, and the '
  + 'maintainer-side source build described in `DEC-02` has not been attempted.')
add('- **A model-quality gate that has not been met.** The Laya multilingual checkpoint ships '
  + 'uncalibrated, so packaging it does not make it a reliable default. That is a qualification '
  + 'result, not a blocker, and it is reported rather than worked around.')
add('- **Target-platform qualification.** Windows clean-install and multi-client interoperability '
  + 'have not been run on an authorized machine.')
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
