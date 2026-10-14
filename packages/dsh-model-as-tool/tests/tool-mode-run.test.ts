/**
 * The authorized program pipeline, WIRED (CODE-02, CODE-03, CODE-08, ARCH-05).
 *
 * The finding this file answers came from adversarial review, not from a failing test:
 * `ptc-authority.ts` and `ptc-runtime.ts` had **zero callers outside tests**. Every control
 * in them was correct and thoroughly covered, and none of it ran. `tool_mode_run` did not
 * exist, the mount guard never executed, and the exposure gate guarded nothing because
 * there was no caller to refuse.
 *
 * These tests are therefore about CALLERS, not about behaviour in isolation. A control that
 * is only exercised by its own test is a symbol.
 *
 * Requirement links: CODE-02, CODE-03, CODE-05, CODE-08, ARCH-01, ARCH-05, SEC-03.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createProgramRunner, externalRefusal, type ProgramRuntime } from '../src/tool-mode-run.ts'
import { PTC_SERVICE, type PtcHostContext } from '../src/ptc-runtime.ts'
import type { ToolBinding } from '../src/ptc-authority.ts'
import { callTool, cleanup, mountPlugin, tempDir } from './helpers.ts'

after(async () => { await cleanup() })

/** A host context that records the mount, and can pretend a provider exists. */
function makeContext(options: { readonly provides?: unknown } = {}) {
  const mounted: unknown[] = []
  const context: PtcHostContext = {
    get: service => (service === PTC_SERVICE ? options.provides : undefined),
    plugin: (plugin) => { mounted.push(plugin) },
  }
  return { context, mounted }
}

/** A runtime that records what it was asked to run. */
function makeRuntime(options: { readonly fail?: string } = {}) {
  const requests: unknown[] = []
  const runtime: ProgramRuntime = {
    resolve: request => {
      requests.push(request)
      return request
    },
    async run(spec) {
      if (options.fail !== undefined) return { error: { kind: options.fail, message: 'probe' } }
      return { value: { ran: true } }
    },
  }
  return { runtime, requests }
}

/** A runner over a fixed grant and tool set. */
function makeRunner(overrides: {
  readonly grant?: readonly string[]
  readonly visible?: readonly string[]
  readonly bindings?: Record<string, ToolBinding>
  readonly runtime?: ProgramRuntime
  readonly provides?: unknown
  readonly backend?: unknown
} = {}) {
  const { context, mounted } = makeContext({ provides: overrides.provides })
  const runner = createProgramRunner({
    context,
    backend: overrides.backend,
    grant: overrides.grant ?? ['fixture_echo'],
    visible: overrides.visible ?? ['fixture_echo'],
    resolve: name => overrides.bindings?.[name],
    runtime: () => overrides.runtime,
  })
  return { runner, mounted }
}

describe('CODE-08 — the exposure gate now HAS a caller', () => {
  it('refuses an external caller, naming why', () => {
    const { runner } = makeRunner()
    // Before the wiring this returned false and NOTHING consulted it. Now a refusal is
    // reachable, which is the difference between a control and a symbol.
    const refusal = externalRefusal(runner)
    assert.ok(refusal, 'an external caller must be refused while exposure is withheld')
    assert.match(refusal.message, /withheld until the confinement tests pass/)
    assert.match(refusal.message, /no production client is served it/)
  })

  it('reports the gate state and its reason independently', () => {
    const { runner } = makeRunner()
    assert.equal(runner.externalExposurePermitted(), false)
    assert.match(runner.externalExposureReason(), /withheld/)
  })

  it('the refusal is the SAME text the gate reports, from one enforcement point', () => {
    const { runner } = makeRunner()
    assert.equal(externalRefusal(runner)?.message, runner.externalExposureReason())
  })
})

describe('CODE-02 — the mount is guarded and has a caller', () => {
  it('mounts the backend when nothing provides the service', async () => {
    const backend = class Backend {}
    const { runner, mounted } = makeRunner({ backend })
    const outcome = await runner.prepare()
    assert.equal(outcome.mounted, true)
    assert.deepEqual(mounted, [backend])
  })

  it('does NOT mount over a provider the host already has', async () => {
    const existing = { language: 'typescript' }
    const { runner, mounted } = makeRunner({ provides: existing, backend: class Backend {} })
    const outcome = await runner.prepare()
    // The base bundle mounts one, so this is the expected path in a real deployment and an
    // unguarded mount would throw here.
    assert.equal(outcome.mounted, false)
    assert.equal(outcome.reason, 'already-provided')
    assert.deepEqual(mounted, [])
  })

  it('reports a missing backend as a REASON rather than throwing', async () => {
    const { runner } = makeRunner({ backend: undefined })
    const outcome = await runner.prepare()
    assert.equal(outcome.mounted, false)
    assert.equal(outcome.reason, 'backend-unavailable')
  })

  it('prepare() is idempotent', async () => {
    const backend = class Backend {}
    const { runner, mounted } = makeRunner({ backend })
    await runner.prepare()
    await runner.prepare()
    // Re-running the guard must not double-mount.
    assert.equal(mounted.length, 1)
  })
})

describe('CODE-03 — ONE pipeline, and the GRANT is what limits it', () => {
  it('runs a program whose requested tools are granted and visible', async () => {
    const { runtime, requests } = makeRuntime()
    const { runner } = makeRunner({ runtime, bindings: { fixture_echo: async () => ({ ok: true }) } })
    const outcome = await runner.run({ program: 'return 1;', requested: ['fixture_echo'] })
    assert.equal(outcome.ok, true)
    assert.equal(requests.length, 1, 'the runtime must be reached exactly once')
  })

  it('REFUSES a program asking for a tool the host did not grant', async () => {
    const { runtime, requests } = makeRuntime()
    const { runner } = makeRunner({
      runtime,
      grant: ['fixture_echo'],
      visible: ['fixture_echo', 'lang_detect'],
      bindings: { fixture_echo: async () => ({}), lang_detect: async () => ({}) },
    })
    const outcome = await runner.run({ program: 'return 1;', requested: ['fixture_echo', 'lang_detect'] })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.code, 'unauthorized')
    assert.match(outcome.message, /lang_detect: forbidden/)
    // And nothing reached the runtime: the refusal is BEFORE execution, not during it.
    assert.equal(requests.length, 0)
  })

  it('refuses the WHOLE request rather than binding a subset', async () => {
    const { runtime, requests } = makeRuntime()
    const { runner } = makeRunner({ runtime, bindings: { fixture_echo: async () => ({}) } })
    const outcome = await runner.run({ program: 'return 1;', requested: ['fixture_echo', 'nope'] })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.code, 'unauthorized')
    assert.equal(requests.length, 0, 'a partial namespace must never execute')
  })

  it('reports UNAVAILABLE when no runtime is mounted, rather than pretending', async () => {
    const { runner } = makeRunner({ runtime: undefined })
    const outcome = await runner.run({ program: 'return 1;', requested: [] })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.code, 'unavailable')
    assert.match(outcome.message, /no PTC runtime is mounted/)
  })
})

describe('CODE-05 — cancellation is NOT reported as a failure', () => {
  it('classifies an aborted run as cancelled', async () => {
    const { runtime } = makeRuntime({ fail: 'abort' })
    const { runner } = makeRunner({ runtime })
    const outcome = await runner.run({ program: 'while(true){}', requested: [] })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    // A caller walking away must not inflate the error rate.
    assert.equal(outcome.code, 'cancelled')
  })

  it('classifies any other runtime error as failed', async () => {
    const { runtime } = makeRuntime({ fail: 'timeout' })
    const { runner } = makeRunner({ runtime })
    const outcome = await runner.run({ program: 'return 1;', requested: [] })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.code, 'failed')
  })
})

describe('CODE-03 — the budget cannot be widened by asking', () => {
  it('CLAMPS a null budget rather than removing the deadline', async () => {
    const { runtime, requests } = makeRuntime()
    const { runner } = makeRunner({ runtime })
    await runner.run({ program: 'return 1;', requested: [], timeoutMs: null })
    // `null` means "no deadline" in the runtime's vocabulary, which is a request to opt out
    // of budgeting entirely.
    const sent = requests[0] as { timeoutMs: number }
    assert.equal(sent.timeoutMs, 600_000)
  })

  it('clamps an oversized budget to the ceiling', async () => {
    const { runtime, requests } = makeRuntime()
    const { runner } = makeRunner({ runtime })
    await runner.run({ program: 'return 1;', requested: [], timeoutMs: 99_999_999 })
    assert.equal((requests[0] as { timeoutMs: number }).timeoutMs, 600_000)
  })
})

describe('the host REGISTERS tool_mode_run, so the gate is reachable through it', () => {
  it('is registered and REFUSES with the withheld reason', async () => {
    const ctx = await mountPlugin({})
    const names = ctx.tools.schemas().map(schema => schema.name)
    // The registration is what makes the gate reachable at all: before this, the refusal
    // existed and no caller could obtain it.
    assert.ok(names.includes('tool_mode_run'), `expected tool_mode_run, saw: ${names.join(', ')}`)

    const result = await callTool(ctx, 'tool_mode_run', {})
    assert.equal(result.isError, true, 'generated-code execution must be withheld')
    const message = JSON.stringify(result)
    assert.match(message, /withheld until the confinement tests pass/)
    void tempDir
  })
})
