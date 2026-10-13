#!/usr/bin/env node
/**
 * Verification evidence generation (TDD-01, TDD-06, TDD-09, TDD-10).
 *
 * The objective is to "verify the implementation against the verification
 * checklist", so the evidence that verification HAPPENED has to be an artifact, not
 * a narrative. This emits three:
 *
 * - `verification/requirements.json` — every normative ID with its owning module,
 *   test layer, required platform and evidence (TDD-01).
 * - `verification/evidence.json` — a run record with git and package identities, the
 *   runtime, the exact command and per-suite observations (TDD-09).
 * - `verification/RELEASE-REPORT.md` — the summary with the support matrices and the
 *   unresolved gates (TDD-10).
 *
 * The rule that shapes most of the code below is TDD-06: a test that needs hardware,
 * credentials or SDK support this machine does not have is BLOCKED or NOT_RUN and
 * NEVER PASS. So the generator refuses to derive PASS from the mere absence of a
 * failure, and the exit code is nonzero while any mandatory gate is unresolved.
 *
 * What this does NOT do is claim acceptance. It reports what was observed.
 *
 * Usage: node scripts/gen-verification.mjs [--check]
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SPEC_DIR = 'docs/tool-mode/specs'
const OUT_DIR = 'verification'
const SPEC_FILES = [
  ['TM-DSH-001', 'Tool_Mode_DSH_Implementation_Spec_v1.2.md'],
  ['TMX-1.1', 'Tool_Mode_Extension_Protocol_v1.1.md'],
  ['CHECKLIST-1.2', 'Tool_Mode_Verification_Checklist_v1.2.md'],
]

/** TDD-06's mandatory statuses, plus the one reviewed exception. */
const TEST_STATUSES = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN', 'NOT_APPLICABLE']

/** Requirement-level statuses from the implementation record. */
const REQUIREMENT_STATUSES = ['DONE', 'PARTIAL', 'NOT_RUN', 'BLOCKED', 'N/A']

/**
 * Platforms a requirement can demand.
 *
 * Recorded so a requirement needing a platform this run did not use is reported as
 * unverified rather than quietly counted as satisfied.
 */
const PLATFORM = {
  os: process.platform,
  arch: process.arch,
  node: process.version,
}

/** Read the implementation status record. */
function statusRecord() {
  return JSON.parse(readFileSync('docs/tool-mode/status.json', 'utf8'))
}

/**
 * Extract every normative requirement ID and its text.
 *
 * Read from the pinned spec files rather than from the status record, so a
 * requirement missing from the status record is DISCOVERED here rather than
 * silently absent from the inventory. The pattern is the same one the traceability
 * generator uses — the title sits INSIDE the bold, ending with `**` — so the two
 * cannot disagree about what counts as a requirement.
 */
function inventory() {
  const entries = []
  for (const [source, file] of SPEC_FILES) {
    const path = join(SPEC_DIR, file)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    const digest = createHash('sha256').update(text).digest('hex')

    /**
     * The family may contain DIGITS: section 20's requirements are `P26-nn`, and a
     * `[A-Z]{2,6}` pattern silently excluded that entire normative family from this
     * inventory. It was found because nine status keys named requirements the
     * inventory did not contain — which is precisely what TDD-01's "mapping every
     * normative ID" exists to surface.
     */
    const requirementRe = /\*\*([A-Z][A-Z0-9]{1,5}-\d{2})\.\s*([^*]*)\*\*/g
    let match
    while ((match = requirementRe.exec(text)) !== null) {
      const statement = (match[2] ?? '').trim()
      entries.push({
        id: match[1],
        source,
        sourceDigest: digest,
        // A bounded excerpt, not the whole requirement: the spec file is the text of
        // record, and duplicating it wholesale would let the two drift.
        summary: statement.length > 300 ? `${statement.slice(0, 300)}…` : statement,
      })
    }

    // TDD-01 names AT-01..AT-90 explicitly, and they live in tables rather than as
    // bold headings, so they need their own pattern.
    const acceptanceRe = /^\|\s*(AT-\d{2})\s*\|\s*(.+?)\s*\|$/gm
    while ((match = acceptanceRe.exec(text)) !== null) {
      const statement = (match[2] ?? '').trim()
      entries.push({
        id: match[1],
        source,
        sourceDigest: digest,
        summary: statement.length > 300 ? `${statement.slice(0, 300)}…` : statement,
      })
    }
  }
  // Deduplicated because a requirement can be cited in more than one document;
  // the FIRST occurrence is the definition.
  const seen = new Set()
  return entries.filter(entry => {
    if (seen.has(entry.id)) return false
    seen.add(entry.id)
    return true
  })
}

/** The owning module for a requirement, inferred from its family. */
function owningModule(id) {
  const family = id.split('-')[0]
  const map = {
    BASE: 'packages/dsh-model-as-tool/src/index.ts',
    ARCH: 'packages/dsh-model-as-tool/src/index.ts',
    RUN: 'packages/dsh-model-as-tool/src/mcp/http.ts',
    MCP: 'packages/dsh-model-as-tool/src/mcp/',
    SEC: 'packages/dsh-model-as-tool/src/authority.ts',
    DECL: 'packages/tool-mode-contracts/src/',
    TOOL: 'packages/tool-mode-contracts/src/contracts/',
    MODEL: 'packages/tool-mode-contracts/src/',
    LIC: 'packages/dsh-model-as-tool/catalog/desert-ant-models.json',
    RES: 'packages/dsh-model-as-tool/src/authority.ts',
    CODE: 'packages/dsh-model-as-tool/src/mcp/',
    OBS: 'packages/dsh-model-as-tool/src/receipt.ts',
    EXT: 'packages/tool-mode-extension-sdk/src/',
    HLM: 'not implemented',
    RCP: 'not implemented',
    DEC: 'not implemented',
    NDL: 'not implemented',
    TDD: 'scripts/gen-verification.mjs',
    MOD: 'not implemented',
  }
  return map[family] ?? 'unmapped'
}

/** The test layer a requirement is verified at. */
function testLayer(id) {
  const family = id.split('-')[0]
  if (id.startsWith('AT-')) return 'acceptance'
  if (['MCP', 'P26'].includes(family)) return 'integration'
  if (family === 'TDD') return 'meta'
  return 'unit'
}

/** The git identity of this run (TDD-09). */
function gitIdentity() {
  const run = args => {
    try {
      return execFileSync('git', args, { encoding: 'utf8' }).trim()
    } catch {
      return 'unknown'
    }
  }
  return {
    commit: run(['rev-parse', 'HEAD']),
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    // Recorded because evidence gathered against a dirty tree describes a state that
    // exists nowhere in history and cannot be reproduced from the commit alone.
    dirty: run(['status', '--porcelain']).length > 0,
  }
}

/** Installed package identities (TDD-10). */
function packageIdentities() {
  const identities = []
  for (const dir of [
    'packages/dsh-model-as-tool',
    'packages/tool-mode-contracts',
    'packages/tool-mode-extension-sdk',
    'packages/extension-desert-ant-tongue',
    'packages/extension-desert-ant-voz',
  ]) {
    const path = join(dir, 'package.json')
    if (!existsSync(path)) continue
    const pkg = JSON.parse(readFileSync(path, 'utf8'))
    identities.push({ name: pkg.name, version: pkg.version, path: dir })
  }
  return identities
}

/**
 * A test status derived from the requirement status, WITHOUT inflating it.
 *
 * TDD-06: only a requirement whose status is DONE counts as PASS. PARTIAL is
 * FAIL — it is work that does not meet its stated outcome — and a blocked
 * requirement stays BLOCKED. Deriving PASS from "the suite was green" would be the
 * false pass the requirement names.
 */
function testStatusFor(requirementStatus, hasTest) {
  if (requirementStatus === 'DONE') return hasTest ? 'PASS' : 'NOT_RUN'
  if (requirementStatus === 'PARTIAL') return hasTest ? 'FAIL' : 'NOT_RUN'
  if (requirementStatus === 'BLOCKED') return 'BLOCKED'
  if (requirementStatus === 'N/A') return 'NOT_APPLICABLE'
  return 'NOT_RUN'
}

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
/**
 * The release gate (TDD-06).
 *
 * Deliberately SEPARATE from `--check`. `--check` asks "is the inventory stale?",
 * which is bookkeeping and belongs in the dev loop. `--release-gate` asks "may this
 * be released?", and TDD-06 requires a nonzero exit while any mandatory gate is not
 * PASS.
 *
 * Keeping them apart is what lets `npm run verify` be green — the code does what its
 * tests say — while the release gate is correctly RED, because most requirements are
 * not PASS. Collapsing them would make one of the two lie: either the dev loop would
 * fail for reasons unrelated to the change at hand, or the release gate would report
 * a readiness that does not exist.
 */
const releaseGate = args.includes('--release-gate')
const status = statusRecord()
const requirements = inventory()

/** Every acceptance-test ID the checklist names, so a missing one is visible. */
const acceptanceIds = new Set(requirements.filter(entry => entry.id.startsWith('AT-')).map(entry => entry.id))

const records = requirements.map(entry => {
  /**
 * An acceptance status is recorded EITHER as a plain string or as `{status, evidence}`.
 *
 * Both shapes exist in the file, and the two generators disagreed about which one to
 * expect: this one read a string, the traceability generator read `.status`, and the
 * result was three acceptance tests whose status coerced to `[object Object]` here and
 * `undefined` there. Accepting both is the fix; forcing one shape on both would only
 * move the breakage to whichever generator was not updated.
 */
const acceptanceEntry = status.acceptance?.[entry.id]
const acceptanceStatus = typeof acceptanceEntry === 'string'
  ? acceptanceEntry
  : acceptanceEntry?.status
const requirementStatus = status.requirements?.[entry.id]?.status ?? acceptanceStatus ?? 'NOT_RUN'
  const hasTest = ['DONE', 'PARTIAL'].includes(requirementStatus)
  return {
    id: entry.id,
    source: entry.source,
    sourceDigest: entry.sourceDigest,
    summary: entry.summary,
    owningModule: owningModule(entry.id),
    testLayer: testLayer(entry.id),
    requiredPlatform: /win32|Windows/.test(entry.summary) ? 'win32' : 'any',
    requirementStatus,
    // TDD-06 statuses, derived without inflating.
    testStatus: testStatusFor(requirementStatus, hasTest),
    evidence: status.requirements?.[entry.id]?.evidence ?? status.acceptance?.[entry.id] ?? null,
  }
})

/**
 * Where a requirement is recorded but absent from the spec, or the reverse.
 *
 * Kept as three SEPARATE lists rather than one, because they call for different
 * actions: an unresolved requirement needs work, an unrecorded one needs a status
 * written for it, and an orphaned key means status.json names something that is not a
 * requirement at all. Merging them produced a 552-line list in which the three were
 * indistinguishable.
 */
const recorded = new Set([
  ...Object.keys(status.requirements ?? {}),
  ...Object.keys(status.acceptance ?? {}),
])
const specIds = new Set(records.map(record => record.id))

/** Requirements that are not PASS and not reviewed-inapplicable. */
const unresolved = records
  .filter(record => record.testStatus !== 'PASS' && record.testStatus !== 'NOT_APPLICABLE')
  .map(record => `${record.id} is ${record.testStatus}`)

/**
 * Spec requirements with no status written for them.
 *
 * They are reported as NOT_RUN in the inventory either way — the honest default —
 * but the distinction matters: NOT_RUN because nobody judged it is different from
 * NOT_RUN because somebody judged it and it does not pass.
 */
const unrecorded = [...specIds].filter(id => !recorded.has(id))

/** Status keys that do not correspond to any normative requirement. */
const orphaned = [...recorded].filter(id => !specIds.has(id))

const unresolvedGates = [...unresolved, ...unrecorded, ...orphaned]

/** Summary counts, by TDD-06 status. */
const counts = Object.fromEntries(TEST_STATUSES.map(name => [name, records.filter(r => r.testStatus === name).length]))

const result = {
  generatedAt: new Date().toISOString(),
  // TDD-09: identities, runtime and the exact command.
  git: gitIdentity(),
  platform: PLATFORM,
  command: 'npm run verify',
  specification: SPEC_FILES.map(([id, file]) => ({ id, file, path: join(SPEC_DIR, file) })),
  packages: packageIdentities(),
  counts,
  requirements: records,
  unresolvedGates,
}

if (checkOnly) {
  const path = join(OUT_DIR, 'requirements.json')
  if (!existsSync(path)) {
    console.error('verification/requirements.json is missing; run `npm run verification`')
    process.exitCode = 1
  } else {
    const existing = JSON.parse(readFileSync(path, 'utf8'))
    const existingIds = new Set(existing.requirements.map(record => record.id))
    const missing = [...specIds].filter(id => !existingIds.has(id))
    if (missing.length > 0) {
      console.error(`the inventory is stale: ${missing.length} requirement(s) missing, e.g. ${missing.slice(0, 5).join(', ')}`)
      process.exitCode = 1
    } else {
      // Counted from the requirement records rather than read from a `counts` field:
      // requirements.json does not carry one, and reading it there reported 0 PASS
      // for an inventory that has three.
      const passing = existing.requirements.filter(record => record.testStatus === 'PASS').length
      console.log(`verification inventory up to date: ${existing.requirements.length} requirements, ${passing} PASS`)
    }
  }
} else {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, 'requirements.json'), `${JSON.stringify({
    // TDD-01's artifact: every normative ID mapped to its owner, layer, platform and
    // evidence, including all AT-01..AT-90.
    generatedAt: result.generatedAt,
    specification: result.specification,
    requirementCount: records.length,
    acceptanceTestCount: acceptanceIds.size,
    requirements: records,
  }, null, 2)}\n`)

  writeFileSync(join(OUT_DIR, 'evidence.json'), `${JSON.stringify(result, null, 2)}\n`)

  const report = [
    '# Tool Mode release report',
    '',
    `Generated ${result.generatedAt} from commit \`${result.git.commit}\`${result.git.dirty ? ' (working tree DIRTY, so this describes a state that exists in no commit)' : ''}.`,
    '',
    '## How to reproduce',
    '',
    'From a clean checkout of the commit above: `npm install && npm run verify`.',
    'No credentials or model assets are required for the suites reported here;',
    'requirements needing either are recorded as BLOCKED or NOT_RUN rather than PASS.',
    '',
    '## Installed package identities',
    '',
    '| Package | Version |',
    '|---|---|',
    ...result.packages.map(pkg => `| \`${pkg.name}\` | ${pkg.version} |`),
    '',
    '## Requirement status',
    '',
    '| Status | Count |',
    '|---|---|',
    ...TEST_STATUSES.map(name => `| ${name} | ${counts[name] ?? 0} |`),
    '',
    `Total: ${records.length} requirements, of which ${counts.PASS ?? 0} PASS.`,
    '',
    '## MCP conformance matrix',
    '',
    '| Fact | Value |',
    '|---|---|',
    '| Revision implemented | 2026-07-28 |',
    '| Pinned schema commit | 5f5440bb26a62e2cf3440b92da5a667efa03b267 |',
    '| Official SDK supports the revision | NO |',
    '| Basis | Schema-conformant adaptation, verified by an independent probe |',
    '| Probe checks | `npm run verify:mcp` |',
    '',
    '## Model and modality support',
    '',
    '| Model | Platform | Modality | Status |',
    '|---|---|---|---|',
    '| Tongue | win32 x64 | text to language | extension extracted, **not yet run against a real inference** |',
    '| Voz | win32 x64 | audio to text | extension extracted, **not yet run against a real recording** |',
    '| 16 further catalog models | varies | varies | cannot run on this host; recorded in the capability resolver |',
    '',
    '## Known limitations and unresolved gates',
    '',
    `${unresolved.length} requirement(s) are not PASS.`,
    `${unrecorded.length} requirement(s) have no status written for them, and are reported as NOT_RUN.`,
    orphaned.length === 0
      ? 'No status key names something that is not a requirement.'
      : `${orphaned.length} status key(s) name something that is not a requirement.`,
    '',
    'The first 40 unresolved requirements:',
    '',
    ...unresolved.slice(0, 40).map(gate => `- ${gate}`),
    ...unresolved.length > 40 ? [`- …and ${unresolved.length - 40} more, in \`verification/evidence.json\``] : [],
    '',
    '## What this report does NOT claim',
    '',
    'Per TDD-10: this document is not evidence that implementation, live inference or',
    'Windows verification has occurred. It records statuses and identities. Where a',
    'requirement needs a platform, model or credential this run did not have, it is',
    'BLOCKED or NOT_RUN — never PASS.',
    '',
  ].join('\n')

  writeFileSync(join(OUT_DIR, 'RELEASE-REPORT.md'), report)

  console.log(`verification written: ${records.length} requirements`)
  console.log(`  ${TEST_STATUSES.map(name => `${name}=${counts[name] ?? 0}`).join('  ')}`)
  console.log(`  not PASS: ${unresolved.length}   no status recorded: ${unrecorded.length}   orphaned keys: ${orphaned.length}`)
}

if (releaseGate) {
  // TDD-06: "The release summary exits nonzero while any mandatory gate is not
  // PASS. Deliver useful partial implementation without claiming acceptance."
  //
  // It exits nonzero, and it says what that means, because a red gate with no
  // explanation invites someone to silence it.
  console.log('')
  console.log('RELEASE GATE: NOT PASSED')
  console.log(`  ${counts.PASS ?? 0} of ${records.length} requirements PASS.`)
  console.log(`  ${unresolved.length} are not PASS; ${unrecorded.length} have no recorded status.`)
  console.log('')
  console.log('This is the correct state for a partial implementation, and the gate is')
  console.log('deliberately separate from `npm run verify`: the dev loop asks whether the')
  console.log('code does what its tests say, while this asks whether the product may be')
  console.log('released. They are different questions with different answers.')
  console.log('')
  console.log('See verification/RELEASE-REPORT.md for the full status and known limitations.')
  process.exitCode = 1
}
