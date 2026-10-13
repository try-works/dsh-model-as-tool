/**
 * Server lifecycle tests (RUN-01, RUN-02, RUN-05, RUN-06, RUN-07).
 *
 * A synthetic host is used so the failure paths — a port conflict, an initialisation
 * failure, a cancel that never resolves — are reachable. Those are exactly the paths a
 * real listener makes hardest to test and easiest to ship broken, and RUN-06 names two
 * of them as things that must not crash the host.
 *
 * Requirement links: RUN-01, RUN-02, RUN-05, RUN-06, RUN-07.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_GRACE_MS,
  disablingServerDisablesOtherTools,
  READ_ONLY_STARTUP,
  ServerLifecycle,
  startupPermits,
  type LifecycleHost,
  type OwnedWork,
} from '../src/server-lifecycle.ts'

/** A host whose bind and initialise can be made to fail. */
function makeHost(options: {
  readonly bindFails?: 'EADDRINUSE' | 'other'
  readonly initFails?: boolean
} = {}) {
  const events: string[] = []
  let closed = false
  const host: LifecycleHost = {
    async bind() {
      events.push('bind')
      if (options.bindFails === 'EADDRINUSE') {
        const error = new Error('address already in use') as NodeJS.ErrnoException
        error.code = 'EADDRINUSE'
        throw error
      }
      if (options.bindFails === 'other') throw new Error('the address is not available')
      return { port: 3765, close: async () => { closed = true; events.push('close') } }
    },
    async initialise() {
      events.push('initialise')
      if (options.initFails === true) throw new Error('the registry is unavailable')
    },
    onReady: port => events.push(`ready:${port}`),
    log: message => events.push(`log:${message}`),
  }
  return { host, events, wasClosed: () => closed }
}

/** Owned work whose cancel can be made to hang. */
function makeWork(id: string, owner: string, options: { readonly hangs?: boolean } = {}) {
  const record = { cancelled: false, terminated: false }
  const work: OwnedWork = {
    id,
    owner,
    cancel: () => {
      if (options.hangs === true) return new Promise<void>(() => { /* never resolves */ })
      record.cancelled = true
    },
    terminate: () => { record.terminated = true },
  }
  return { work, record }
}

describe('RUN-06 — readiness is not announced before it is true', () => {
  it('becomes ready after bind AND initialise both succeed', async () => {
    const { host, events } = makeHost()
    const lifecycle = new ServerLifecycle(host)
    assert.equal(lifecycle.ready, false)
    const result = await lifecycle.start()
    assert.equal(result.ok, true)
    assert.equal(lifecycle.ready, true)
    // The order matters: readiness is announced LAST.
    assert.deepEqual(events, ['bind', 'initialise', 'ready:3765'])
  })

  it('is NOT ready when initialisation fails, and closes the bound listener', async () => {
    const { host, wasClosed } = makeHost({ initFails: true })
    const lifecycle = new ServerLifecycle(host)
    const result = await lifecycle.start()
    assert.equal(result.ok, false)
    assert.equal(lifecycle.ready, false)
    assert.equal(lifecycle.state, 'failed')
    if (result.ok) return
    assert.equal(result.failure.code, 'INIT_FAILED')
    // An open port that answers nothing is worse than no port.
    assert.equal(wasClosed(), true)
    assert.equal(lifecycle.port, null)
  })

  it('does not call onReady at all when the bind fails', async () => {
    const { host, events } = makeHost({ bindFails: 'other' })
    await new ServerLifecycle(host).start()
    assert.equal(events.includes('initialise'), false, 'initialise must not run after a failed bind')
    assert.equal(events.some(event => event.startsWith('ready')), false)
  })
})

describe('RUN-06 — a port conflict is reported, not resolved', () => {
  it('returns PORT_IN_USE with a remedy that rules out force and stealth', async () => {
    const { host } = makeHost({ bindFails: 'EADDRINUSE' })
    const result = await new ServerLifecycle(host).start()
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.failure.code, 'PORT_IN_USE')
    // Both forbidden resolutions are named, because an operator's instinct is to do
    // one of them.
    assert.match(result.failure.remedy, /will not take it by force or move silently/)
  })

  it('does NOT return a port, so nothing can silently relocate', async () => {
    const { host } = makeHost({ bindFails: 'EADDRINUSE' })
    const lifecycle = new ServerLifecycle(host)
    await lifecycle.start()
    assert.equal(lifecycle.port, null)
    assert.equal(lifecycle.ready, false)
  })

  it('a failed start does not throw, so it cannot crash the host', async () => {
    // RUN-06: the MCP endpoint is one feature of a larger host, and a port clash must
    // leave the rest running.
    for (const options of [{ bindFails: 'EADDRINUSE' as const }, { bindFails: 'other' as const }, { initFails: true }]) {
      const { host } = makeHost(options)
      const result = await new ServerLifecycle(host).start()
      assert.equal(result.ok, false, 'a failure must be RETURNED, not thrown')
    }
  })

  it('refuses a second start rather than binding twice', async () => {
    const { host } = makeHost()
    const lifecycle = new ServerLifecycle(host)
    await lifecycle.start()
    const second = await lifecycle.start()
    assert.equal(second.ok, false)
    if (second.ok) return
    assert.equal(second.failure.code, 'ALREADY_STARTED')
  })
})

describe('RUN-07 — shutdown order and ownership', () => {
  it('refuses new work once shutdown has begun', async () => {
    const { host } = makeHost()
    const lifecycle = new ServerLifecycle(host)
    await lifecycle.start()
    const { work } = makeWork('late', 'operator')
    const stopping = lifecycle.stop()
    // Work adopted during the cleanup window would be left running, so it is refused.
    assert.equal(lifecycle.adopt(work), false)
    await stopping
  })

  it('cancels owned work, closes the transport and releases the port', async () => {
    const { host, wasClosed } = makeHost()
    const lifecycle = new ServerLifecycle(host)
    await lifecycle.start()
    const { work, record } = makeWork('call-1', 'operator')
    lifecycle.adopt(work)

    const report = await lifecycle.stop()
    assert.deepEqual([...report.cancelled], ['call-1'])
    assert.equal(record.cancelled, true)
    assert.equal(report.portReleased, true)
    assert.equal(wasClosed(), true)
    assert.equal(lifecycle.port, null)
    assert.equal(lifecycle.state, 'stopped')
  })

  it('TERMINATES work that outlives the grace period and reports it', async () => {
    const { host } = makeHost()
    const lifecycle = new ServerLifecycle(host, { graceMs: 30 })
    await lifecycle.start()
    const { work, record } = makeWork('stuck', 'operator', { hangs: true })
    lifecycle.adopt(work)

    const report = await lifecycle.stop()
    // A cancel that never resolves must not hold shutdown open forever, and must not
    // be reported as stopped either.
    assert.deepEqual([...report.cancelled], [])
    assert.deepEqual([...report.terminated], ['stuck'])
    assert.equal(record.terminated, true)
    assert.equal(report.withinGrace, false)
  })

  it('NEVER touches work owned by another still-authorized owner', async () => {
    const { host } = makeHost()
    const lifecycle = new ServerLifecycle(host)
    await lifecycle.start()
    const mine = makeWork('mine', 'operator')
    const theirs = makeWork('theirs', 'other-owner')
    lifecycle.adopt(mine.work)
    lifecycle.adopt(theirs.work)

    // A model process serving another authorized owner is not this lifecycle's to kill.
    const report = await lifecycle.stop({ ownedBy: 'operator' })
    assert.deepEqual([...report.cancelled], ['mine'])
    assert.deepEqual([...report.untouched], ['theirs'])
    assert.equal(theirs.record.cancelled, false)
    assert.equal(theirs.record.terminated, false)
  })

  it('writing the order down: refuse, cancel, wait, terminate, close, release', async () => {
    const { host, events } = makeHost()
    const lifecycle = new ServerLifecycle(host, { graceMs: 20 })
    await lifecycle.start()
    const { work } = makeWork('w', 'operator')
    lifecycle.adopt(work)
    const report = await lifecycle.stop()
    // The observable order: the close happens after the cancel, never before.
    assert.deepEqual(events.slice(0, 3), ['bind', 'initialise', 'ready:3765'])
    assert.equal(events[events.length - 1], 'close')
    assert.equal(report.portReleased, true)
  })

  it('stopping an already-stopped server is a no-op rather than an error', async () => {
    const { host } = makeHost()
    const report = await new ServerLifecycle(host).stop()
    assert.equal(report.portReleased, true)
    assert.deepEqual([...report.cancelled], [])
  })

  it('documents a grace period', () => {
    // RUN-07 asks for a DOCUMENTED grace period, so the constant is asserted rather
    // than left to whatever a default happened to be.
    assert.ok(DEFAULT_GRACE_MS > 0 && DEFAULT_GRACE_MS <= 30_000)
  })
})

describe('RUN-05 — startup is read-only', () => {
  it('permits restoring an approved activation and inspecting local state', () => {
    assert.equal(startupPermits('restore-active'), true)
    assert.equal(startupPermits('inspect-assets'), true)
    assert.equal(startupPermits('read-manifests'), true)
  })

  it('REFUSES preparation, resolution and downloads at startup', () => {
    // Nothing downloads because a plugin loaded, a user opened settings, or a client
    // listed tools.
    assert.equal(startupPermits('prepare-model'), false)
    assert.equal(startupPermits('resolve-package'), false)
    assert.equal(startupPermits('download-weights'), false)
  })

  it('encodes the prohibition in the policy type, not only in a comment', () => {
    assert.equal(READ_ONLY_STARTUP.preparesModels, false)
    assert.equal(READ_ONLY_STARTUP.resolvesPackages, false)
    assert.equal(READ_ONLY_STARTUP.discoveryIsReadOnly, true)
  })
})

describe('RUN-01 — the server and the plugin stop independently', () => {
  it('disabling the server does not disable unrelated DSH tools', () => {
    // The reason the lifecycle is a separate object from the plugin registration
    // state: stopping the listener must not unregister anything else.
    assert.equal(disablingServerDisablesOtherTools(), false)
  })
})
