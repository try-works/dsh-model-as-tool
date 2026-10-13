/**
 * Verification-evidence tests (TDD-01, TDD-06, TDD-09, TDD-10).
 *
 * TDD-06 is the requirement with teeth: "A required platform/model/API test skipped
 * for missing hardware, credentials or SDK support is BLOCKED/NOT_RUN, never PASS."
 * These tests assert the ARTIFACTS against that rule, because the rule is about what
 * the evidence is allowed to claim rather than about what the code does.
 *
 * Requirement links: TDD-01, TDD-06, TDD-09, TDD-10.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

after(() => { /* nothing to clean: these tests only read */ })

const REQUIREMENTS = 'verification/requirements.json'
const EVIDENCE = 'verification/evidence.json'
const REPORT = 'verification/RELEASE-REPORT.md'

/** The statuses TDD-06 admits. */
const TEST_STATUSES = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN', 'NOT_APPLICABLE']

function requirements() {
  return JSON.parse(readFileSync(REQUIREMENTS, 'utf8'))
}

function evidence() {
  return JSON.parse(readFileSync(EVIDENCE, 'utf8'))
}

describe('TDD-01 — the requirement inventory', () => {
  it('exists and covers every normative ID including all acceptance tests', () => {
    const inventory = requirements()
    // AT-01..AT-90 are named explicitly by the requirement.
    assert.equal(inventory.acceptanceTestCount, 90, 'all AT-01..AT-90 must be inventoried')
    assert.ok(inventory.requirementCount >= 210, `expected at least 210 requirements, found ${inventory.requirementCount}`)
  })

  it('includes section 20, which a narrower pattern silently excluded', () => {
    const ids = new Set(requirements().requirements.map(entry => entry.id))
    // The family name contains digits, and a `[A-Z]{2,6}` pattern missed the whole
    // family for several rounds. This asserts the correction holds.
    assert.ok(ids.has('P26-01'), 'P26-01 must be inventoried')
    assert.ok(ids.has('P26-17'), 'P26-17 must be inventoried')
    assert.ok(ids.has('P26-09'), 'P26-09 must be inventoried')
  })

  it('maps each requirement to an owning module, a layer and a platform', () => {
    for (const entry of requirements().requirements) {
      assert.ok(entry.owningModule, `${entry.id} needs an owning module`)
      assert.ok(entry.testLayer, `${entry.id} needs a test layer`)
      assert.ok(entry.requiredPlatform, `${entry.id} needs a required platform`)
    }
  })

  it('records the source digest, so the inventory is tied to pinned text', () => {
    for (const entry of requirements().requirements) {
      assert.match(entry.sourceDigest, /^[0-9a-f]{64}$/, `${entry.id} needs a source digest`)
    }
  })

  it('contains no status key that names a non-existent requirement', () => {
    // Two keys once named MCP-14 and MCP-17, which do not exist: the MCP family ends
    // at 13, and the intended requirements were section 20's P26-14 and P26-17.
    const inventoryIds = new Set(requirements().requirements.map(entry => entry.id))
    const recorded = JSON.parse(readFileSync('docs/tool-mode/status.json', 'utf8'))
    const orphaned = [
      ...Object.keys(recorded.requirements ?? {}),
      ...Object.keys(recorded.acceptance ?? {}),
    ].filter(id => !inventoryIds.has(id))
    assert.deepEqual(orphaned, [], 'every recorded status must name a real requirement')
  })
})

describe('TDD-06 — no false passes', () => {
  it('uses only the mandated statuses', () => {
    for (const entry of evidence().requirements) {
      assert.ok(TEST_STATUSES.includes(entry.testStatus), `${entry.id} has status ${entry.testStatus}`)
    }
  })

  it('NEVER reports PASS for a requirement that is only PARTIAL', () => {
    // The false pass the requirement names. PARTIAL is work that does not meet its
    // stated outcome, so it is FAIL at the test level.
    for (const entry of evidence().requirements) {
      if (entry.requirementStatus === 'PARTIAL') {
        assert.notEqual(entry.testStatus, 'PASS', `${entry.id} is PARTIAL and must not be PASS`)
        assert.equal(entry.testStatus, 'FAIL')
      }
    }
  })

  it('reports BLOCKED as BLOCKED, never as PASS or NOT_RUN', () => {
    for (const entry of evidence().requirements) {
      if (entry.requirementStatus === 'BLOCKED') assert.equal(entry.testStatus, 'BLOCKED')
    }
  })

  it('does not derive PASS from the mere absence of a failure', () => {
    // A requirement with no recorded status is NOT_RUN. Treating "we did not test it"
    // as "it passed" is the same false pass in a quieter form.
    for (const entry of evidence().requirements) {
      if (entry.requirementStatus === 'NOT_RUN') assert.equal(entry.testStatus, 'NOT_RUN')
    }
  })

  it('the release gate exits nonzero while any mandatory gate is not PASS', () => {
    let exited = 0
    try {
      execFileSync('node', ['scripts/gen-verification.mjs', '--release-gate'], { stdio: 'pipe' })
    } catch (error) {
      exited = (error as { status?: number }).status ?? 0
    }
    // This run has far more than zero unresolved requirements, so a zero exit would
    // mean the gate is not actually wired to the count.
    assert.notEqual(exited, 0, 'the release gate must exit nonzero while gates are unresolved')
  })
})

describe('TDD-09 — evidence records carry the required identities', () => {
  it('records git, package, runtime and command identities', () => {
    const record = evidence()
    assert.match(record.git.commit, /^[0-9a-f]{40}$/, 'a commit identity is required')
    assert.ok(record.packages.length >= 5, 'installed package identities are required')
    assert.equal(record.platform.os, process.platform)
    assert.ok(record.platform.node.startsWith('v'))
    assert.match(record.command, /npm run verify/)
  })

  it('flags a dirty working tree, so the evidence is not mistaken for a commit', () => {
    // Evidence gathered against a dirty tree describes a state that exists in no
    // commit and cannot be reproduced from the commit alone.
    assert.equal(typeof evidence().git.dirty, 'boolean')
  })

  it('records a timestamp', () => {
    assert.match(evidence().generatedAt, /^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('TDD-10 — the release report', () => {
  it('exists and carries the required sections', () => {
    assert.ok(existsSync(REPORT), 'verification/RELEASE-REPORT.md must exist')
    const text = readFileSync(REPORT, 'utf8')
    for (const section of [
      'Installed package identities',
      'Requirement status',
      'MCP conformance matrix',
      'Model and modality support',
      'Known limitations and unresolved gates',
      'How to reproduce',
    ]) {
      assert.ok(text.includes(section), `the report needs a "${section}" section`)
    }
  })

  it('states what it does NOT claim', () => {
    const text = readFileSync(REPORT, 'utf8')
    // TDD-10: do not present the specification, a compilation pass or generated
    // example output as evidence that implementation or live inference occurred.
    assert.match(text, /does NOT claim/)
    assert.match(text, /never PASS/i)
  })

  it('records the MCP conformance facts rather than a version string', () => {
    const text = readFileSync(REPORT, 'utf8')
    // "A report whose only protocol assertion is a string equality for 2026-07-28
    // fails this gate", so the matrix records the pinned commit and the SDK's
    // inability to speak the revision alongside it.
    assert.match(text, /5f5440bb26a62e2cf3440b92da5a667efa03b267/)
    assert.match(text, /Official SDK supports the revision \| NO/)
  })

  it('says which models have NOT been run against real inference', () => {
    const text = readFileSync(REPORT, 'utf8')
    // The distinction between "extracted and tested" and "ran a real model" is the
    // one most easily lost in a status summary.
    assert.match(text, /not yet run against a real inference/)
  })
})

describe('TDD-06 — every recorded status is one of the five vocabulary values', () => {
  /**
   * A status recorded as an OBJECT rather than a string was silently coerced to
   * `[object Object]` by every consumer, which removed the item from the inventory's
   * counts while leaving it present in the source. Three acceptance tests were lost that
   * way, and nothing noticed, because the coercion is invisible in both directions.
   */
  const VOCABULARY = ['DONE', 'PARTIAL', 'BLOCKED', 'NOT_RUN', 'NOT_APPLICABLE']

  it('records requirement statuses as plain strings from the vocabulary', () => {
    const status = JSON.parse(readFileSync('docs/tool-mode/status.json', 'utf8'))
    const offenders: string[] = []
    for (const [id, entry] of Object.entries(status.requirements ?? {})) {
      if (typeof entry?.status !== 'string') offenders.push(`${id}: ${typeof entry?.status}`)
      else if (!VOCABULARY.includes(entry.status)) offenders.push(`${id}: ${entry.status}`)
    }
    assert.deepEqual(offenders, [], 'a status must be a vocabulary string, never a nested object')
  })

  it('records acceptance statuses in a shape both generators agree on', () => {
    /**
     * An acceptance entry is EITHER a plain string OR `{status, evidence}`.
     *
     * Both shapes are present in the file, and the two generators disagreed about which
     * to expect: one read a string, the other read `.status`. The result was three
     * acceptance tests whose status coerced to `[object Object]` in one and `undefined`
     * in the other. This asserts what matters - that a status can be EXTRACTED and is a
     * vocabulary value - rather than insisting on one shape, because forcing a single
     * shape on both would only move the breakage to whichever was not updated.
     */
    const status = JSON.parse(readFileSync('docs/tool-mode/status.json', 'utf8'))
    const offenders: string[] = []
    for (const [id, value] of Object.entries(status.acceptance ?? {})) {
      const extracted = typeof value === 'string' ? value : (value as { status?: unknown })?.status
      if (typeof extracted !== 'string') offenders.push(`${id}: no extractable status (${typeof value})`)
      else if (!VOCABULARY.includes(extracted)) offenders.push(`${id}: ${extracted}`)
    }
    assert.deepEqual(offenders, [], 'every acceptance entry must yield a vocabulary status')
  })

  it('does not let a malformed status reach the generated inventory', () => {
    // The gate is about the OUTPUT too: whatever the source says, the inventory a
    // consumer reads must never contain a coerced value.
    const requirements = JSON.parse(readFileSync(REQUIREMENTS, 'utf8'))
    for (const item of requirements.requirements) {
      assert.equal(
        typeof item.requirementStatus, 'string',
        `${item.id} has a non-string status in the generated inventory`,
      )
      assert.equal(item.requirementStatus.includes('[object'), false, `${item.id} was coerced`)
    }
  })
})
describe('the README states the same counts the evidence does', () => {
  /**
   * A README quoting counts that have drifted is worse than one quoting none, because a
   * reader has no way to tell which numbers are current. These are checked rather than
   * trusted, in the same spirit as the traceability table being generated.
   */
  it('quotes the inventory counts it claims', () => {
    const readme = readFileSync('README.md', 'utf8')
    const requirements = JSON.parse(readFileSync(REQUIREMENTS, 'utf8')).requirements
    const counts = { DONE: 0, PARTIAL: 0, BLOCKED: 0, NOT_RUN: 0 }
    for (const item of requirements) counts[item.requirementStatus] += 1
    // The README states these in prose: "3 are done, 95 are partial, 6 are blocked and
    // 213 were never started".
    // The counts sit inside one bold span, so the `**` closes after the LAST number
    // rather than after the first.
    const stated = readme.match(
      /(\d+) are done, (\d+) are\s+partial, (\d+) are blocked and\s+(\d+) were never started/,
    )
    assert.ok(stated, 'the README must state the four counts')
    assert.deepEqual(
      [Number(stated[1]), Number(stated[2]), Number(stated[3]), Number(stated[4])],
      [counts.DONE, counts.PARTIAL, counts.BLOCKED, counts.NOT_RUN],
      'the README counts have drifted from the evidence',
    )
  })

  it('states the tracked total it claims', () => {
    const readme = readFileSync('README.md', 'utf8')
    const inventory = JSON.parse(readFileSync(REQUIREMENTS, 'utf8'))
    /**
     * `requirementCount` counts EVERY tracked item, acceptance tests included, so the
     * normative figure has to be derived rather than read. The field name is misleading
     * and this is the one place that has to know it.
     */
    const normative = inventory.requirements.filter(entry => !entry.id.startsWith('AT-')).length
    // Prose wraps, so a count and its noun may be separated by a newline.`n    assert.match(readme, new RegExp(`${normative}\\s+requirements`))
    assert.match(readme, new RegExp(`${inventory.acceptanceTestCount}\\s+acceptance tests`))
  })

  it('points a reader at the generated final report', () => {
    // The honest summary must be reachable from the front door.
    const readme = readFileSync('README.md', 'utf8')
    assert.match(readme, /verification\/FINAL-REPORT\.md/)
  })
})