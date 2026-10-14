/**
 * The capture path and the metadata-only profile (OBS-03).
 *
 * OBS-03 begins from a premise that is easy to skip past: **this plugin's defaults cannot
 * guarantee privacy**, because a sibling DSH logging plugin can capture bodies that this plugin
 * never writes. A test suite cannot prove a negative about software it does not control, so what
 * these tests check is the part that IS checkable — that the plugin's own claims are accurate,
 * complete about what it does not control, and that the metadata-only profile actually refuses.
 *
 * Requirement links: OBS-03, OBS-01, OBS-04.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { admitsTool, CAPTURE_PATH, profilePolicy } from '../src/capture-path.ts'

/** A deployment that retains nothing and needs reconstructable inputs — the conflict case. */
const CONFLICTING = { retainsBodies: false, requiresReconstructableInputs: true }
/** A deployment with no conflict. */
const COMPATIBLE = { retainsBodies: true, requiresReconstructableInputs: true }

describe('OBS-03 — the capture path names what this plugin does NOT control', () => {
  it('lists every surface, including the ones outside this plugin', () => {
    const names = CAPTURE_PATH.map(surface => surface.surface)
    /**
     * The requirement is to document the FULL path, and a list of this plugin's own writes
     * would be misleading precisely because a reader would take it as complete. The
     * outside-our-control surfaces are asserted by name so they cannot be dropped.
     */
    assert.ok(names.some(name => /logging plugin/i.test(name)), 'the sibling-plugin case OBS-03 names must be listed')
    assert.ok(names.some(name => /LLM service/i.test(name)), 'the DSH LLM service must be listed')
    assert.ok(names.some(name => /managed-worker/i.test(name)), 'extension output must be listed')
  })

  it('distinguishes "we do not write here" from "nothing is written here"', () => {
    /**
     * The distinction the field exists for. A surface this plugin does not write is NOT thereby
     * safe, and conflating the two is how a privacy claim becomes false without anyone lying.
     */
    const notOurs = CAPTURE_PATH.filter(surface => !surface.writtenByThisPlugin)
    assert.ok(notOurs.length >= 4, `expected the uncontrolled surfaces, saw ${notOurs.length}`)
    for (const surface of notOurs) {
      assert.ok(surface.control.length > 0, `${surface.surface} must say what an operator can do`)
      assert.ok(surface.contents.length > 0, `${surface.surface} must say what lands there`)
    }
  })

  it('the DSH LLM service is named as the surface this plugin CANNOT close', () => {
    const llm = CAPTURE_PATH.find(surface => /LLM service/i.test(surface.surface))
    assert.ok(llm !== undefined)
    // Naming it as a controllable surface would be the dishonest version of this list.
    assert.equal(llm?.writtenByThisPlugin, false)
    assert.match(String(llm?.control), /operator-level policy, not a plugin setting/)
  })

  it('says of the journal that a harness run recording nothing CANNOT EXIST', () => {
    const journal = CAPTURE_PATH.find(surface => /auxiliary-call journal/i.test(surface.surface))
    assert.equal(journal?.writtenByThisPlugin, true)
    /**
     * This is not a claim about diligence; it is enforced. `HarnessBroker` refuses to CONSTRUCT
     * without a journal sink — "Refusing to construct a broker that would report nothing" —
     * which the declarative-slice tests hit directly.
     */
    assert.match(String(journal?.contents), /refuses to construct/)
  })

  it('every surface this plugin DOES write is metadata', () => {
    const ours = CAPTURE_PATH.filter(surface => surface.writtenByThisPlugin)
    assert.ok(ours.length >= 3, 'the plugin writes receipts, accounting and the journal')
    for (const surface of ours) {
      // None of the three is a body store, and the accounting record is asserted to have no
      // field that could hold one.
      assert.doesNotMatch(
        surface.contents,
        /request or response (body|bodies)|the prompt|the arguments/i,
        `${surface.surface} must not be a body store`,
      )
    }
  })
})

describe('OBS-03 — the metadata-only profile', () => {
  it('writes no bodies under EITHER profile', () => {
    // The plugin never wrote bodies; the profile is about what it will SERVE, not about a
    // logging toggle. Saying otherwise would imply a body path exists to be switched off.
    assert.equal(profilePolicy('standard', COMPATIBLE).writesBodies, false)
    assert.equal(profilePolicy('metadata-only', COMPATIBLE).writesBodies, false)
  })

  it('reports the residual surfaces in BOTH profiles', () => {
    /**
     * The difference between the profiles is what THIS plugin serves — not what a sibling does.
     * Listing the residual risk only for the strict profile would imply the standard one closes
     * it, which is exactly the misreading OBS-03 warns about.
     */
    const standard = profilePolicy('standard', COMPATIBLE).residualSurfaces
    const strict = profilePolicy('metadata-only', COMPATIBLE).residualSurfaces
    assert.deepEqual(strict, standard)
    assert.ok(standard.length >= 4)
  })

  it('PERMITS harness execution where the deployment has no conflict', () => {
    assert.equal(profilePolicy('metadata-only', COMPATIBLE).permitsHarnessExecution, true)
  })

  it('REFUSES harness execution where no-retention conflicts with reconstructability', () => {
    const policy = profilePolicy('metadata-only', CONFLICTING)
    assert.equal(policy.permitsHarnessExecution, false)
  })

  it('admits a NON-harness tool even under the refusing profile', () => {
    /**
     * The refusal is about harness-backed execution only. A local-specialist tool that calls no
     * model has no body for the reconstructability contract to be about, and refusing it would
     * remove working functionality for no privacy gain.
     */
    const decision = admitsTool('metadata-only', CONFLICTING, false)
    assert.equal(decision.admitted, true)
  })

  it('refuses a HARNESS-BACKED tool, naming both forbidden alternatives', () => {
    const decision = admitsTool('metadata-only', CONFLICTING, true)
    assert.equal(decision.admitted, false)
    // The reason states why the two obvious escapes are not available, so a reader does not
    // conclude the plugin is merely being conservative.
    assert.match(String(decision.reason), /Logging bodies against the policy and bypassing DSH are both forbidden/)
  })

  it('the STANDARD profile still serves harness tools under the same conflict', () => {
    /**
     * Asserted so the refusal is a PROPERTY OF THE PROFILE rather than of the policy alone. A
     * deployment that accepts body retention gets the tools; one that refuses retention and
     * still needs reconstructability is told to choose the metadata-only profile and lose them.
     */
    assert.equal(admitsTool('standard', CONFLICTING, true).admitted, true)
  })
})
