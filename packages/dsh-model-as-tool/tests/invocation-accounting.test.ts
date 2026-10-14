/**
 * Invocation accounting tests (OBS-01, OBS-05).
 *
 * Three things these tests are really about:
 *
 *   - the phase split must be MEASURED, not inferred, because a single duration cannot tell
 *     a slow queue from a slow load from slow inference;
 *   - the outcome CLASS must follow the caller's intent, because a deadline that fires also
 *     surfaces as an abort and checking the abort first would hide every timeout;
 *   - the record must have NOWHERE to put a payload. That is asserted structurally, since a
 *     module that merely declines to log bodies can start logging them in one commit.
 *
 * Requirement links: OBS-01, OBS-05.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  accountInvocation,
  classifyOutcome,
  measurementContext,
  PhaseTimer,
  type InvocationAccounting,
} from '../src/invocation-accounting.ts'

/** A controllable clock, so phases are tested rather than slept through. */
function fakeClock() {
  let now = 0
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

describe('OBS-01 — phases are MEASURED separately', () => {
  it('records queue, load and inference as distinct durations', () => {
    const clock = fakeClock()
    const timer = new PhaseTimer(clock.now)
    clock.advance(5)
    timer.begin('queued')
    clock.advance(20)
    timer.begin('load')
    clock.advance(300)
    timer.begin('inference')
    clock.advance(40)
    const timings = timer.finish()

    // Each phase is its own number. A single total could not distinguish "the model took
    // 300ms to load" from "the caller waited 300ms for a pool".
    assert.equal(timings.queuedMs, 20)
    assert.equal(timings.loadMs, 300)
    assert.equal(timings.inferenceMs, 40)
    assert.equal(timings.totalMs, 365)
  })

  it('does NOT force the total to equal the sum of the parts', () => {
    const clock = fakeClock()
    const timer = new PhaseTimer(clock.now)
    timer.begin('inference')
    clock.advance(100)
    // Time passes outside any declared phase; phases can also overlap in reality.
    const timings = timer.finish()
    // Asserted as an INEQUALITY on purpose: forcing equality would make the record wrong
    // whenever phases overlap, which is the common case for a shared deployment.
    assert.ok(timings.totalMs >= timings.inferenceMs)
    assert.equal(timings.totalMs, 100)
  })

  it('ACCUMULATES a phase that is re-entered', () => {
    const clock = fakeClock()
    const timer = new PhaseTimer(clock.now)
    timer.begin('inference')
    clock.advance(10)
    timer.begin('load')
    clock.advance(5)
    timer.begin('inference')
    clock.advance(7)
    const timings = timer.finish()
    // A retry that resumes inference must not RESET the earlier time.
    assert.equal(timings.inferenceMs, 17)
    assert.equal(timings.loadMs, 5)
  })

  it('reports zero for a phase that never ran, rather than omitting it', () => {
    const clock = fakeClock()
    const timer = new PhaseTimer(clock.now)
    timer.begin('inference')
    clock.advance(3)
    const timings = timer.finish()
    // An already-warm deployment has no load phase. `0` says "did not load"; an absent
    // field would say "not measured", which is a different claim.
    assert.equal(timings.loadMs, 0)
    assert.equal(timings.queuedMs, 0)
  })

  it('end() is idempotent and finish() closes an open phase', () => {
    const clock = fakeClock()
    const timer = new PhaseTimer(clock.now)
    timer.begin('inference')
    clock.advance(9)
    timer.end()
    timer.end()
    assert.equal(timer.finish().inferenceMs, 9)
  })
})

describe('OBS-01 — the outcome CLASS follows the caller intent', () => {
  it('reports none for a completed call', () => {
    assert.equal(classifyOutcome({ ok: true }), 'none')
  })

  it('reports POLICY-DENIED ahead of any failure', () => {
    // A denial is a decision, not a malfunction, and an operator filtering for faults must
    // not see it.
    assert.equal(classifyOutcome({ ok: false, denied: true, aborted: true }), 'policy-denied')
  })

  it('reports TIMEOUT ahead of cancelled, because a deadline also aborts', () => {
    /**
     * The ordering that matters. A deadline that fires surfaces as an abort too, so
     * checking `aborted` first would classify EVERY timeout as a cancellation and hide the
     * deadline entirely — the failure would look like the caller walking away.
     */
    assert.equal(classifyOutcome({ ok: false, aborted: true, timedOut: true }), 'timeout')
  })

  it('reports REFUSED ahead of a generic failure', () => {
    assert.equal(classifyOutcome({ ok: false, refused: true }), 'refused')
  })

  it('reports CANCELLED when the caller walked away', () => {
    assert.equal(classifyOutcome({ ok: false, aborted: true }), 'cancelled')
  })

  it('falls back to failed', () => {
    assert.equal(classifyOutcome({ ok: false }), 'failed')
  })

  it('a cancelled call is NEVER reported as a failure', () => {
    // The distinction a dashboard depends on: user-initiated stops must not inflate the
    // error rate.
    assert.notEqual(classifyOutcome({ ok: false, aborted: true }), 'failed')
  })
})

describe('OBS-01 — sizes, and NO place for a payload', () => {
  const base = {
    receiptId: 'r-1',
    timings: { queuedMs: 0, loadMs: 0, inferenceMs: 1, totalMs: 1 },
    failureClass: 'none' as const,
    engineVersion: 'test-1.0.0',
  }

  it('measures the SERIALIZED size, which is what crossed the boundary', () => {
    const record = accountInvocation({ ...base, input: { text: 'hello' }, output: { language: 'de' } })
    assert.equal(record.sizes.inputBytes, Buffer.byteLength(JSON.stringify({ text: 'hello' })))
    assert.equal(record.sizes.outputBytes, Buffer.byteLength(JSON.stringify({ language: 'de' })))
  })

  it('reports an absent output as ZERO bytes, not as unknown', () => {
    const record = accountInvocation({ ...base, input: {} })
    // Nothing crossed the boundary; `null` would invite a reader to treat it as unmeasured.
    assert.equal(record.sizes.outputBytes, 0)
  })

  it('reports an UNSERIALIZABLE value as -1 rather than understating it as empty', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const record = accountInvocation({ ...base, input: cyclic })
    // `0` would understate it; `-1` cannot be produced by a real payload, so it reads as
    // "unmeasured".
    assert.equal(record.sizes.inputBytes, -1)
  })

  it('HAS NOWHERE to put request or response content', () => {
    /**
     * Asserted structurally rather than promised in a comment. A `details` bag of type
     * `Record<string, unknown>` would undo this in one commit, so the record's own keys are
     * checked and the payload is confirmed absent from its serialization.
     */
    const record = accountInvocation({
      ...base,
      input: { text: 'a-secret-transcript' },
      output: { language: 'de' },
    })
    const keys = Object.keys(record)
    for (const forbidden of ['input', 'output', 'body', 'request', 'response', 'details', 'headers']) {
      assert.equal(keys.includes(forbidden), false, `the record must not carry ${forbidden}`)
    }
    // And the content really is not in there, however it is encoded.
    assert.equal(JSON.stringify(record).includes('a-secret-transcript'), false)
  })

  it('carries a REASON without carrying the payload', () => {
    const record = accountInvocation({ ...base, failureClass: 'refused', reason: 'the token was too long', input: {} })
    assert.equal(record.reason, 'the token was too long')
    // A class-level reason is the useful half; the body is not needed to act on it.
    assert.equal(Object.keys(record).includes('payload'), false)
  })
})

describe('OBS-05 — measured facts are separated from claims', () => {
  it('records the runtime the measurement was taken on', () => {
    const context = measurementContext('onnxruntime-node-1.20.0')
    // Read from the PROCESS rather than configured, so a record cannot claim a platform it
    // was not produced on — the specific defect OBS-05 names about Apple benchmarks being
    // presented as Windows performance.
    assert.equal(context.platform, process.platform)
    assert.equal(context.architecture, process.arch)
    assert.equal(context.nodeVersion, process.version)
    assert.equal(context.engineVersion, 'onnxruntime-node-1.20.0')
  })

  it('marks the timings as MEASURED here', () => {
    const record = accountInvocation({
      receiptId: 'r-2',
      timings: { queuedMs: 0, loadMs: 0, inferenceMs: 2, totalMs: 2 },
      failureClass: 'none',
      input: {},
      engineVersion: 'test',
    })
    // The alternative value exists so an imported figure can never be presented as one
    // taken here.
    assert.equal(record.timingSource, 'measured')
  })

  it('names the engine version alongside the measurement', () => {
    const record: InvocationAccounting = accountInvocation({
      receiptId: 'r-3',
      timings: { queuedMs: 0, loadMs: 0, inferenceMs: 0, totalMs: 0 },
      failureClass: 'none',
      input: {},
      engineVersion: 'voz-3.1.0',
    })
    // A latency figure without the engine that produced it is a vendor claim wearing a
    // measurement's clothes.
    assert.equal(record.measuredOn.engineVersion, 'voz-3.1.0')
  })
})
