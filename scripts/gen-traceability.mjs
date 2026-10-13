/**
 * Generate the Tool Mode requirement traceability matrix.
 *
 * The matrix is DERIVED from the pinned specifications rather than maintained by
 * hand, so every normative requirement and every acceptance test appears by
 * construction and a status cannot silently go missing. Implementation status
 * lives in `status.json` beside this script; anything absent there is reported as
 * NOT_RUN, which is the honest default.
 *
 * Usage: node scripts/gen-traceability.mjs [--check]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const specDir = join(root, 'docs/tool-mode/specs')
const statusFile = join(root, 'docs/tool-mode/status.json')
const outFile = join(root, 'docs/tool-mode/TRACEABILITY.md')

/** The pinned specifications. The hashes are asserted, not decorative. */
const SPECS = [
  {
    file: 'Tool_Mode_DSH_Implementation_Spec_v1.2.md',
    sha256: 'b98db5026077b47d43cf033bb4026897d7b40797ef4903a2fdbbeb8255bba4bb',
    label: 'TM-DSH-001 v1.2',
  },
  {
    file: 'Tool_Mode_Extension_Protocol_v1.1.md',
    sha256: '016e6f57ff249cc62662f8ad2fdabfc7de262d3f8fb2af00b69c8e46b3f386f9',
    label: 'TMX v1.1',
  },
  {
    file: 'Tool_Mode_Verification_Checklist_v1.2.md',
    sha256: '2c34decf01986e0c1a59a293f429415bf45cf96134492dc3bb08a686be5c089d',
    label: 'checklist v1.2',
  },
]

/** Status vocabulary. Anything not recorded is NOT_RUN. */
const STATUS = ['DONE', 'PARTIAL', 'NOT_RUN', 'BLOCKED', 'N/A']

/** Families in the order the spec introduces them, with a one-line purpose. */
const FAMILY_ORDER = [
  'BASE', 'ARCH', 'RUN', 'MCP', 'SEC', 'DECL', 'TOOL', 'MODEL', 'LIC',
  'RES', 'CODE', 'OBS', 'EXT', 'HLM', 'RCP', 'DEC', 'NDL', 'TDD',
]

/** Read and verify one pinned specification. */
function readSpec(spec) {
  const path = join(specDir, spec.file)
  const text = readFileSync(path, 'utf8')
  const actual = createHash('sha256').update(text).digest('hex')
  if (actual !== spec.sha256) {
    throw new Error(
      `${spec.file} hash mismatch\n  expected ${spec.sha256}\n  actual   ${actual}\n`
      + 'The pinned specification changed. Re-verify the implementation against it '
      + 'before updating the recorded hash.',
    )
  }
  return { ...spec, text, lines: text.split('\n') }
}

/** Collapse whitespace and bound a title for the table. */
function tidy(text, max = 96) {
  const flat = text.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`
}

/**
 * Extract normative requirements of the form `**ID-nn. Title**`.
 * The trailing period inside the bold is what distinguishes a numbered
 * requirement from an incidental mention of the same token in prose.
 */
function extractRequirements(spec) {
  const found = []
  const re = /\*\*([A-Z][A-Z0-9]{1,5}-\d{2})\.\s*([^*]*)\*\*/g
  let match
  while ((match = re.exec(spec.text)) !== null) {
    const line = spec.text.slice(0, match.index).split('\n').length
    found.push({
      id: match[1],
      family: match[1].split('-')[0],
      title: tidy(match[2]),
      source: spec.file,
      label: spec.label,
      line,
      section: sectionAt(spec.lines, line),
    })
  }
  return found
}

/** The nearest preceding `## ` heading, for grouping the matrix. */
function sectionAt(lines, lineNumber) {
  for (let index = lineNumber - 1; index >= 0; index -= 1) {
    const heading = /^##\s+(.*)$/.exec(lines[index] ?? '')
    if (heading) return tidy(heading[1], 60)
  }
  return '(preamble)'
}

/** Extract acceptance tests from the `| AT-nn | description |` tables. */
function extractAcceptanceTests(specs) {
  const found = new Map()
  for (const spec of specs) {
    const re = /^\|\s*(AT-\d{2})\s*\|\s*(.+?)\s*\|$/gm
    let match
    while ((match = re.exec(spec.text)) !== null) {
      const id = match[1]
      // The main specification wins where both state the same test.
      if (!found.has(id) || spec.label === 'TM-DSH-001 v1.2') {
        found.set(id, {
          id,
          title: tidy(match[2], 130),
          source: spec.file,
          label: spec.label,
        })
      }
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** Load recorded status, defaulting everything to NOT_RUN. */
function loadStatus() {
  if (!existsSync(statusFile)) return { requirements: {}, acceptance: {}, notes: {} }
  const parsed = JSON.parse(readFileSync(statusFile, 'utf8'))
  return {
    requirements: parsed.requirements ?? {},
    acceptance: parsed.acceptance ?? {},
    notes: parsed.notes ?? {},
  }
}

/** Render one status cell, rejecting an unknown status outright. */
function statusOf(record, id, kind, notes) {
  const entry = record[id]
  if (entry === undefined) return { status: 'NOT_RUN', evidence: '—' }
  const status = entry.status
  if (!STATUS.includes(status)) {
    throw new Error(`${kind} ${id} has unknown status ${JSON.stringify(status)}; use one of ${STATUS.join(', ')}`)
  }
  const evidence = entry.evidence ?? '—'
  const note = notes[id]
  return { status, evidence: note === undefined ? evidence : `${evidence}<br>${tidy(note, 160)}` }
}

function main() {
  const specs = SPECS.map(readSpec)
  const requirements = specs.flatMap(extractRequirements)
  const acceptance = extractAcceptanceTests(specs)
  const status = loadStatus()

  // The main specification states that it consolidates the companion documents,
  // so EXT/HLM/RCP legitimately appear in both. The consolidated spec is the
  // authority; the companion is recorded as a cross-reference rather than
  // treated as a conflicting definition.
  const AUTHORITATIVE = 'TM-DSH-001 v1.2'
  const byId = new Map()
  const crossRefs = new Map()
  for (const item of requirements) {
    const prior = byId.get(item.id)
    if (prior === undefined) {
      byId.set(item.id, item)
      continue
    }
    if (prior.label === item.label) {
      throw new Error(`${item.id} is defined twice in ${item.label}`)
    }
    if (item.label === AUTHORITATIVE) {
      byId.set(item.id, item)
      crossRefs.set(item.id, [...(crossRefs.get(item.id) ?? []), prior.label])
    } else {
      crossRefs.set(item.id, [...(crossRefs.get(item.id) ?? []), item.label])
    }
  }
  const deduped = [...byId.values()]

  const byFamily = new Map()
  for (const item of deduped) {
    if (!byFamily.has(item.family)) byFamily.set(item.family, [])
    byFamily.get(item.family).push(item)
  }
  for (const list of byFamily.values()) list.sort((a, b) => a.id.localeCompare(b.id))

  const families = [...byFamily.keys()].sort((a, b) => {
    const ia = FAMILY_ORDER.indexOf(a)
    const ib = FAMILY_ORDER.indexOf(b)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b)
  })

  const count = (kind) => {
    const tally = Object.fromEntries(STATUS.map(s => [s, 0]))
    for (const item of kind) {
      const { status: value } = statusOf(status.requirements, item.id, 'requirement', status.notes)
      tally[value] += 1
    }
    return tally
  }
  const reqTally = count(deduped)
  const atRows = acceptance.map(item => ({
    ...item,
    ...statusOf(status.acceptance, item.id, 'acceptance test', status.notes),
  }))
  const atTally = Object.fromEntries(STATUS.map(s => [s, 0]))
  for (const row of atRows) atTally[row.status] += 1

  const pct = (n, total) => total === 0 ? '0%' : `${Math.round((n / total) * 100)}%`

  const out = []
  out.push('# Tool Mode — requirement traceability', '')
  out.push('GENERATED by `scripts/gen-traceability.mjs` from the pinned specifications.')
  out.push('Do not edit by hand: record status in `status.json` and regenerate.', '')
  out.push('| Specification | SHA-256 |', '| --- | --- |')
  for (const spec of specs) out.push(`| \`${spec.file}\` | \`${spec.sha256}\` |`)
  out.push('')
  out.push('Every normative requirement and acceptance test in those documents appears')
  out.push('below by construction. A requirement with no recorded status is `NOT_RUN`, which')
  out.push('is the honest default rather than an omission.', '')
  out.push('## Summary', '')
  out.push(`- Normative requirements: **${deduped.length}**`)
  out.push(`- Acceptance tests: **${acceptance.length}**`)
  out.push(`- Requirements DONE: **${reqTally.DONE}** / ${deduped.length} (${pct(reqTally.DONE, deduped.length)})`)
  out.push(`- Requirements BLOCKED: **${reqTally.BLOCKED}**`)
  out.push(`- Requirements NOT_RUN: **${reqTally.NOT_RUN}**`)
  out.push(`- Acceptance tests DONE: **${atTally.DONE}** / ${acceptance.length} (${pct(atTally.DONE, acceptance.length)})`)
  out.push('')
  out.push('## Requirements by family', '')
  out.push('| Family | Total | DONE | PARTIAL | NOT_RUN | BLOCKED |')
  out.push('| --- | ---: | ---: | ---: | ---: | ---: |')
  for (const family of families) {
    const list = byFamily.get(family)
    const tally = Object.fromEntries(STATUS.map(s => [s, 0]))
    for (const item of list) {
      tally[statusOf(status.requirements, item.id, 'requirement', status.notes).status] += 1
    }
    out.push(`| ${family} | ${list.length} | ${tally.DONE} | ${tally.PARTIAL} | ${tally.NOT_RUN} | ${tally.BLOCKED} |`)
  }
  out.push('')

  for (const family of families) {
    const list = byFamily.get(family)
    out.push(`## ${family} — ${list.length} requirement(s)`, '')
    out.push('| ID | Requirement | Section | Status | Evidence |')
    out.push('| --- | --- | --- | --- | --- |')
    for (const item of list) {
      const { status: value, evidence } = statusOf(status.requirements, item.id, 'requirement', status.notes)
      out.push(`| ${item.id} | ${item.title} | ${item.section} | ${value} | ${evidence} |`)
    }
    out.push('')
  }

  out.push('## Acceptance tests', '')
  out.push('| ID | Test | Status | Evidence |')
  out.push('| --- | --- | --- | --- |')
  for (const row of atRows) {
    out.push(`| ${row.id} | ${row.title} | ${row.status} | ${row.evidence} |`)
  }
  out.push('')

  const rendered = out.join('\n')
  if (process.argv.includes('--check')) {
    const current = existsSync(outFile) ? readFileSync(outFile, 'utf8') : ''
    if (current !== rendered) {
      console.error('docs/tool-mode/TRACEABILITY.md is stale; run: node scripts/gen-traceability.mjs')
      process.exit(1)
    }
    console.log(`traceability up to date: ${deduped.length} requirements, ${acceptance.length} acceptance tests`)
    return
  }

  writeFileSync(outFile, rendered)
  console.log(`requirements: ${deduped.length} across ${families.length} families`)
  console.log(`acceptance tests: ${acceptance.length}`)
  console.log(`status: ${reqTally.DONE} DONE, ${reqTally.PARTIAL} PARTIAL, ${reqTally.NOT_RUN} NOT_RUN, ${reqTally.BLOCKED} BLOCKED`)
  console.log('wrote docs/tool-mode/TRACEABILITY.md')
}

main()
