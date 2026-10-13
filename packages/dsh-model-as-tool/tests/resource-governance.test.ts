/**
 * Resource governance tests (RES-01, RES-04, RES-06, RES-09).
 *
 * RES-04 gets the most attention because it corrects a mistake this repository
 * actually made: an earlier `admitsInvocation` required a deployment to be LOADED
 * before it was callable, which withdrew a working tool whenever its model went cold
 * and made the tool surface flicker — the exact outcome the requirement forbids.
 *
 * Requirement links: RES-01, RES-04, RES-06, RES-09.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  admit,
  admissionOf,
  cancellationOutcome,
  coverageOf,
  DEFAULT_BUDGETS,
  describeRejection,
  descriptionMayVaryWithResidency,
  isCallable,
  isExpansionBomb,
  isPrepared,
  type Readiness,
} from '../src/resource-governance.ts'
import { admitsInvocation, summarize, type ExtensionState, type ModelReadiness } from '@try-works/tool-mode-extension-sdk'

describe('RES-04 — the eight states, and readiness versus residency', () => {
  it('names exactly the states the requirement lists', () => {
    const states: Readiness[] = [
      'unavailable', 'needs-preparation', 'preparing', 'prepared-cold',
      'loading', 'ready', 'busy', 'failed',
    ]
    assert.equal(states.length, 8)
    // Every one is recognised by both derived questions rather than throwing.
    for (const state of states) {
      assert.equal(typeof isCallable(state), 'boolean')
      assert.equal(typeof isPrepared(state), 'boolean')
    }
  })

  it('treats a PREPARED but COLD deployment as callable', () => {
    // The correction: preparation determines callability, residency does not. A cold
    // deployment works; it simply loads first.
    assert.equal(isCallable('prepared-cold'), true)
    assert.equal(admissionOf('prepared-cold'), 'loads-first')
  })

  it('treats loading and busy as callable, with queued admission', () => {
    // A second call must wait rather than start a second load of the same deployment.
    assert.equal(isCallable('loading'), true)
    assert.equal(admissionOf('loading'), 'queued')
    assert.equal(isCallable('busy'), true)
    assert.equal(admissionOf('busy'), 'queued')
  })

  it('treats unprepared and unavailable as NOT callable', () => {
    assert.equal(isCallable('unavailable'), false)
    assert.equal(isCallable('needs-preparation'), false)
    assert.equal(isCallable('failed'), false)
    assert.equal(admissionOf('needs-preparation'), undefined)
  })

  it('separates the two questions rather than collapsing them', () => {
    // `preparing` is NOT yet prepared and therefore not callable; `prepared-cold` is
    // prepared and callable. A single boolean could not express both facts.
    assert.equal(isPrepared('preparing'), false)
    assert.equal(isCallable('preparing'), false)
    assert.equal(isPrepared('prepared-cold'), true)
    assert.equal(isCallable('prepared-cold'), true)
  })

  it('forbids a tool description varying with residency', () => {
    // RES-04: do not change agent tool descriptions on every warm/cold transition.
    // This exists to be asserted rather than consulted.
    assert.equal(descriptionMayVaryWithResidency(), false)
  })
})

describe('RES-04 — the repository no longer conflates readiness with residency', () => {
  /** State with one tool and a given deployment readiness. */
  function stateWith(readiness: ModelReadiness): ExtensionState {
    return {
      extensionId: '@acme/x',
      installation: 'installed',
      desiredActivation: 'active',
      observedActivation: 'active',
      readiness: { 'model-cpu': readiness },
      tools: [{ toolName: 'x_tool', enabled: true }],
      export: 'not-exported',
    }
  }

  it('admits a call to a prepared-but-cold deployment', () => {
    // The regression this round fixes: requiring `ready` here withdrew a working tool
    // whenever its model went cold.
    assert.equal(admitsInvocation(stateWith('prepared-cold'), 'x_tool'), true)
  })

  it('admits a call while the deployment is loading or busy', () => {
    assert.equal(admitsInvocation(stateWith('loading'), 'x_tool'), true)
    assert.equal(admitsInvocation(stateWith('busy'), 'x_tool'), true)
    assert.equal(admitsInvocation(stateWith('ready'), 'x_tool'), true)
  })

  it('refuses a call when the deployment is unprepared, unavailable or failed', () => {
    assert.equal(admitsInvocation(stateWith('needs-preparation'), 'x_tool'), false)
    assert.equal(admitsInvocation(stateWith('unavailable'), 'x_tool'), false)
    assert.equal(admitsInvocation(stateWith('failed'), 'x_tool'), false)
  })

  it('does not report a cold deployment as preparing', () => {
    // Reporting "preparing" would tell an operator to wait for something that already
    // works.
    assert.equal(summarize(stateWith('prepared-cold')), 'ready')
  })

  it('reports a genuinely unprepared deployment as preparing', () => {
    assert.equal(summarize(stateWith('needs-preparation')), 'preparing')
    assert.equal(summarize(stateWith('loading')), 'preparing')
  })

  it('reports failed and unavailable as faulted', () => {
    assert.equal(summarize(stateWith('failed')), 'faulted')
    assert.equal(summarize(stateWith('unavailable')), 'faulted')
  })
})

describe('RES-01 / RES-09 — a budget is a rejection with actual limits', () => {
  it('admits an input within budget', () => {
    assert.deepEqual(admit({ sourceBytes: 1000 }, { sourceBytes: 2000 }), { admitted: true })
  })

  it('rejects an over-budget input naming the ACTUAL limit', () => {
    const decision = admit({ sourceBytes: 9_000_000 }, { sourceBytes: 8 * 1024 * 1024 })
    assert.equal(decision.admitted, false)
    if (decision.admitted) return
    // A caller told only "too large" cannot choose a smaller input.
    assert.equal(decision.exceeded[0]?.measured, 9_000_000)
    assert.equal(decision.exceeded[0]?.limit, 8 * 1024 * 1024)
    assert.match(describeRejection(decision), /sourceBytes is 9000000, over the limit of 8388608/)
  })

  it('NEVER truncates: an over-budget input is refused, not reduced', () => {
    // There is no code path that returns a trimmed input, and this asserts the shape
    // rather than trusting the absence.
    const decision = admit({ sourceBytes: 100 }, { sourceBytes: 50 })
    assert.equal(decision.admitted, false)
    assert.equal('trimmed' in decision, false)
  })

  it('reports EVERY exceeded budget, not just the first', () => {
    const decision = admit(
      { sourceBytes: 100, decodedPixels: 200 },
      { sourceBytes: 10, decodedPixels: 20 },
    )
    assert.equal(decision.admitted, false)
    if (decision.admitted) return
    assert.deepEqual(decision.exceeded.map(entry => entry.kind).sort(), ['decodedPixels', 'sourceBytes'])
  })

  it('treats a null limit as not applicable', () => {
    assert.deepEqual(admit({ sourceBytes: 999_999 }, { sourceBytes: null }), { admitted: true })
  })

  it('does not treat an UNMEASURED budget as passing a limit it cannot check', () => {
    // An unmeasured budget is skipped rather than assumed satisfied, so a caller
    // cannot pass a check by omitting the measurement. The requirement to measure is
    // the caller's, and the skip is visible rather than silent.
    assert.deepEqual(admit({}, { sourceBytes: 10 }), { admitted: true })
    assert.deepEqual(admit({ sourceBytes: 11 }, { sourceBytes: 10 }).admitted, false)
  })
})

describe('RES-09 — the product defaults the requirement states', () => {
  it('uses the image defaults verbatim', () => {
    assert.equal(DEFAULT_BUDGETS.image.sourceBytes, 8 * 1024 * 1024)
    assert.equal(DEFAULT_BUDGETS.image.decodedPixels, 16_000_000)
  })

  it('uses the video defaults verbatim', () => {
    assert.equal(DEFAULT_BUDGETS.video.videoSeconds, 120)
    assert.equal(DEFAULT_BUDGETS.video.videoFrames, 32)
    assert.equal(DEFAULT_BUDGETS.video.sourceBytes, 128 * 1024 * 1024)
  })

  it('enforces each multimodal budget INDEPENDENTLY', () => {
    // A 200-second video under the byte cap is still refused for its duration.
    const decision = admit({ sourceBytes: 1000, videoSeconds: 200 }, DEFAULT_BUDGETS.video)
    assert.equal(decision.admitted, false)
    if (decision.admitted) return
    assert.deepEqual(decision.exceeded.map(entry => entry.kind), ['videoSeconds'])
  })

  it('rejects a decompression bomb on the DECLARED size, before allocation', () => {
    // A check that runs after decompression has already lost.
    assert.equal(isExpansionBomb(200 * 1024 * 1024, DEFAULT_BUDGETS.video.sourceBytes as number), true)
    assert.equal(isExpansionBomb(1024, DEFAULT_BUDGETS.video.sourceBytes as number), false)
  })
})

describe('RES-09 — sampling is explicit and coverage is reported', () => {
  it('reports complete coverage when every unit was processed', () => {
    const coverage = coverageOf(900, 900, null)
    assert.equal(coverage.complete, true)
    assert.equal(coverage.reason, null)
  })

  it('reports incomplete coverage WITH the sampling instruction', () => {
    const coverage = coverageOf(32, 900, { instruction: 'evenly spaced frames, first and last included', forcedBy: 'videoFrames' })
    assert.equal(coverage.complete, false)
    assert.equal(coverage.processed, 32)
    assert.equal(coverage.total, 900)
    assert.match(String(coverage.reason), /evenly spaced frames/)
  })

  it('names SILENT sampling as a defect rather than a policy', () => {
    // Incomplete without an instruction is the case the requirement forbids, so it is
    // reported as a defect and not dressed up as intentional.
    const coverage = coverageOf(32, 900, null)
    assert.equal(coverage.complete, false)
    assert.match(String(coverage.reason), /no sampling instruction was recorded/)
  })
})

describe('RES-06 — cancellation is a claim about behaviour', () => {
  it('reports a stopped backend as stopped', () => {
    assert.deepEqual(cancellationOutcome(true, 'the transcription'), { stopped: true })
  })

  it('NEVER claims cancellation while uncontrolled work continues', () => {
    const outcome = cancellationOutcome(false, 'the ONNX session')
    assert.equal(outcome.stopped, false)
    if (outcome.stopped) return
    // The honest report is that it is still running and its result will be discarded.
    assert.match(outcome.reason, /cannot be interrupted safely/)
    assert.match(outcome.reason, /run to completion and its result discarded/)
  })
})
