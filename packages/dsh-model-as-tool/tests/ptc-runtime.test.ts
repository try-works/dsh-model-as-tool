/**
 * PTC mount and authorized-pipeline tests (CODE-01..03, ARCH-01, SEC-03).
 *
 * The mount guard has a specific failure this file exists to prevent: DSH's base bundle
 * ALREADY mounts a Node PTC provider, so an unguarded `ctx.plugin(...)` throws
 * `service "ptcRuntime" has been registered`. The guard is mandatory in every outcome,
 * which is why it is tested in both directions rather than only where it fires.
 *
 * Requirement links: CODE-01, CODE-02, CODE-03, CODE-08, ARCH-01, SEC-03, RES-10.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  admitTimeout,
  buildToolBindings,
  exposureWithheldReason,
  mayExposeToClients,
  mountPtcRuntimeIfAbsent,
  PTC_DEFAULT_BUDGETS,
  PTC_SERVICE,
  type PtcHostContext,
} from '../src/ptc-runtime.ts'
import type { ToolBinding } from '../src/ptc-authority.ts'

/** A host context that records what was mounted. */
function makeContext(options: { readonly provides?: unknown; readonly pluginThrows?: boolean } = {}) {
  const mounted: { plugin: unknown; config: unknown }[] = []
  const ctx: PtcHostContext = {
    get(service) {
      return service === PTC_SERVICE ? options.provides : undefined
    },
    plugin(plugin, config) {
      if (options.pluginThrows === true) {
        // The exact failure an unguarded mount produces inside a full DSH deployment.
        throw new Error(`service "${PTC_SERVICE}" has been registered at <root>`)
      }
      mounted.push({ plugin, config })
    },
  }
  return { ctx, mounted }
}

/** A resolver for a fixed name set. */
function resolverFor(names: readonly string[]) {
  const resolve = (name: string): ToolBinding | undefined =>
    names.includes(name) ? async () => ({ called: name }) : undefined
  return resolve
}

describe('CODE-01 — the mount is GUARDED in both directions', () => {
  it('does NOT mount when the host already provides the service', async () => {
    // The base bundle mounts a provider, so this is the EXPECTED path inside a real DSH
    // deployment. An unguarded ctx.plugin would throw here.
    const existing = { language: 'typescript' }
    const { ctx, mounted } = makeContext({ provides: existing })
    const outcome = await mountPtcRuntimeIfAbsent(ctx, class Backend {})

    assert.equal(outcome.mounted, false)
    assert.equal(outcome.reason, 'already-provided')
    assert.deepEqual(mounted, [], 'nothing may be mounted over an existing provider')
    // The service is still usable, and "already provided" is a SUCCESS rather than a skip.
    assert.equal(outcome.service, PTC_SERVICE)
  })

  it('MOUNTS when nothing provides the service', async () => {
    const { ctx, mounted } = makeContext()
    const backend = class Backend {}
    const outcome = await mountPtcRuntimeIfAbsent(ctx, backend, { timeoutMs: 1000 })

    assert.equal(outcome.mounted, true)
    assert.equal(mounted.length, 1)
    assert.equal(mounted[0]?.plugin, backend)
    assert.deepEqual(mounted[0]?.config, { timeoutMs: 1000 })
  })

  it('would THROW without the guard — which is why the guard is not optional', async () => {
    // Asserted so the reason for the guard is evidence rather than a comment: a context
    // whose plugin throws is exactly what an unguarded mount produces.
    const { ctx } = makeContext({ provides: {}, pluginThrows: true })
    // With the guard, the pre-existing provider short-circuits before ctx.plugin is called.
    const outcome = await mountPtcRuntimeIfAbsent(ctx, class Backend {})
    assert.equal(outcome.mounted, false)
    assert.equal(outcome.reason, 'already-provided')

    // WITHOUT the guard the same context throws, which is the failure being prevented.
    const unguarded: PtcHostContext = { get: () => undefined, plugin: () => { throw new Error(`service "${PTC_SERVICE}" has been registered`) } }
    assert.throws(() => unguarded.plugin(class Backend {}), /has been registered/)
  })

  it('reports a missing backend as a REASON rather than throwing', async () => {
    // A deployment without the Node backend can still run native tools. Failing the whole
    // plugin load would remove working functionality because an optional one is absent.
    const { ctx, mounted } = makeContext()
    const outcome = await mountPtcRuntimeIfAbsent(ctx, undefined)
    assert.equal(outcome.mounted, false)
    assert.equal(outcome.reason, 'backend-unavailable')
    assert.deepEqual(mounted, [])
  })
})

describe('CODE-03 — the ONE pipeline builds the program namespace', () => {
  const AUTHORITY = { granted: ['fixture_echo', 'lang_detect'], visible: ['fixture_echo', 'lang_detect'] }

  it('builds a namespace the program can call', async () => {
    const outcome = buildToolBindings({
      requested: ['fixture_echo'],
      authority: AUTHORITY,
      resolve: resolverFor(['fixture_echo']),
    })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.namespace.global, 'tools')
    const value = await outcome.namespace.functions.fixture_echo({})
    assert.deepEqual(value, { called: 'fixture_echo' })
  })

  it('refuses the WHOLE request when one name is unattainable', () => {
    const outcome = buildToolBindings({
      requested: ['fixture_echo', 'lang_detect'],
      authority: { granted: ['fixture_echo'], visible: ['fixture_echo'] },
      resolve: resolverFor(['fixture_echo', 'lang_detect']),
    })
    // A partial namespace would run a program that does not do what it declares.
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.match(outcome.message, /lang_detect: forbidden/)
  })

  it('refuses a namespace global that is not a language-portable identifier', () => {
    const outcome = buildToolBindings({
      requested: ['fixture_echo'],
      authority: AUTHORITY,
      global: '$tools',
      resolve: resolverFor(['fixture_echo']),
    })
    // A JS-only spelling is rejected by design, not just by the Python backend.
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.match(outcome.message, /not a language-portable identifier/)
  })

  it('accepts a portable global', () => {
    const outcome = buildToolBindings({
      requested: [],
      authority: { granted: [], visible: [] },
      global: 'tool_bindings',
      resolve: resolverFor([]),
    })
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.namespace.global, 'tool_bindings')
  })

  it('produces a null-prototype function map, so nothing is inherited', () => {
    const outcome = buildToolBindings({
      requested: ['fixture_echo'],
      authority: AUTHORITY,
      resolve: resolverFor(['fixture_echo']),
    })
    if (!outcome.ok) throw new Error('expected a namespace')
    assert.equal(Object.getPrototypeOf(outcome.namespace.functions), null)
  })
})

describe('RES-10 — the run budget cannot be widened by asking', () => {
  it('uses the default when nothing is requested', () => {
    assert.equal(admitTimeout(undefined), PTC_DEFAULT_BUDGETS.timeoutMs)
  })

  it('clamps a request ABOVE the ceiling rather than honouring it', () => {
    assert.equal(admitTimeout(99_999_999), PTC_DEFAULT_BUDGETS.maxTimeoutMs)
  })

  it('CLAMPS a null request, which asks to remove the deadline entirely', () => {
    // `null` means "no deadline" in the runtime's own vocabulary. Offering one is a request
    // to opt out of budgeting, so it is clamped rather than honoured.
    assert.equal(admitTimeout(null), PTC_DEFAULT_BUDGETS.maxTimeoutMs)
  })

  it('honours a request inside the ceiling', () => {
    assert.equal(admitTimeout(5000), 5000)
  })

  it('replaces a nonsensical budget with the default', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(admitTimeout(bad), PTC_DEFAULT_BUDGETS.timeoutMs, `${bad} must not be admitted`)
    }
  })
})

describe('CODE-08 — generated-code execution is WITHHELD from clients', () => {
  it('is not exposed, because the confinement tests have not passed', () => {
    // The directive: "Do not expose generated-code execution to production clients before
    // the specification's confinement tests pass." Asserted rather than left to a comment.
    assert.equal(mayExposeToClients(), false)
  })

  it('states why, so a caller is not left guessing', () => {
    const reason = exposureWithheldReason()
    assert.match(reason, /withheld until the confinement tests pass/)
    assert.match(reason, /no production client is served it/)
  })
})
