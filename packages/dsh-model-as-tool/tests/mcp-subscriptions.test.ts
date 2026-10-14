/**
 * Catalog subscription tests (P26-09, P26-10).
 *
 * Each test targets one rule the requirement states, because a subscription
 * implementation that gets five of six right is indistinguishable from a broken one
 * on the sixth: a client waiting for an event that a rule should have delivered has
 * no way to tell a bug from a quiet catalog.
 *
 * Requirement links: P26-09, P26-10, P26-12.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  acknowledgeFilter,
  cancelSubscription,
  SUBSCRIPTION_ID_KEY,
  SubscriptionRegistry,
  SUPPORTED_FILTERS,
} from '../src/mcp/subscriptions.ts'
import { dispatch, type McpHost } from '../src/mcp/server.ts'
import { ADVERTISED_FEATURES, META_KEYS, PROTOCOL_VERSION, type WireRequest } from '../src/mcp/protocol.ts'

const host: McpHost = {
  serverInfo: { name: 'dsh-tool-mode', version: '0.1.0' },
  listTools: () => [],
  async callTool() { return { structured: null, text: '', isError: false } },
}

/** A subscriptions/listen request. */
function listen(id: string, notifications: Record<string, unknown>): WireRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'subscriptions/listen',
    params: {
      notifications,
      _meta: {
        [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
        [META_KEYS.clientCapabilities]: {},
      },
    },
  }
}

describe('P26-09 — acknowledge only what is supported', () => {
  it('acknowledges a requested supported filter', () => {
    assert.deepEqual(acknowledgeFilter({ toolsListChanged: true }), { toolsListChanged: true })
  })

  it('DROPS an unsupported requested filter rather than acknowledging it', () => {
    // An acknowledged type that never fires is indistinguishable from a broken
    // server, so the client is told the truth instead.
    const acknowledged = acknowledgeFilter({ toolsListChanged: true, promptsListChanged: true })
    assert.deepEqual(acknowledged, { toolsListChanged: true })
    assert.equal('promptsListChanged' in acknowledged, false)
  })

  it('does not acknowledge a type the client did NOT request', () => {
    // Granting one would start sending an unrequested notification.
    assert.deepEqual(acknowledgeFilter({}), {})
  })

  it('treats a false request as not requested', () => {
    assert.deepEqual(acknowledgeFilter({ toolsListChanged: false }), {})
  })

  it('declares exactly the filters it serves', () => {
    assert.deepEqual([...SUPPORTED_FILTERS], ['toolsListChanged'])
  })
})

describe('P26-09 — no event before the acknowledgement', () => {
  it('establishes a subscription and returns the acknowledgement with the result', () => {
    const registry = new SubscriptionRegistry()
    const { result, acknowledgement, subscriptionId } = registry.listen(listen('l1', { toolsListChanged: true }), 'client-a')

    // The result carries the subscription id the revision REQUIRES in its metadata.
    assert.equal((result._meta as Record<string, unknown>)[SUBSCRIPTION_ID_KEY], subscriptionId)
    assert.equal(result.resultType, 'complete')
    // And the acknowledgement names the filter the server will honour.
    assert.deepEqual((acknowledgement.params as { notifications: unknown }).notifications, { toolsListChanged: true })
    assert.equal(acknowledgement.method, 'notifications/subscriptions/acknowledged')
  })

  it('the subscription is marked announced before any publish can reach it', () => {
    const registry = new SubscriptionRegistry()
    registry.listen(listen('l1', { toolsListChanged: true }), 'client-a')
    // Publishing immediately after listen delivers, which proves the acknowledgement
    // state was set during listen rather than by the transport afterwards.
    assert.equal(registry.publishToolListChanged(2).length, 1)
  })

  it('responds over the wire with the acknowledgement as a follow-up message', async () => {
    const registry = new SubscriptionRegistry()
    const outcome = await dispatch(listen('l1', { toolsListChanged: true }), host, {
      subscriptions: registry,
      clientId: 'client-a',
    })
    const result = outcome.response?.result as { _meta: Record<string, unknown>; resultType: string }
    assert.equal(result.resultType, 'complete')
    /**
     * The meta key carries the REQUEST's own id, because that is the type the schema gives
     * it (`RequestId`) and what lets a client correlate the result with the call it made.
     * Asserted as an IDENTITY rather than by pattern: the earlier `/^sub_/` check required
     * an invented format the client had never seen.
     */
    assert.equal(result._meta[SUBSCRIPTION_ID_KEY], 'l1')
    // A notification is a SEPARATE message, not a member of the result: embedding it
    // would produce a frame that is neither a valid result nor a valid notification.
    assert.equal(outcome.followUp?.length, 1)
    assert.equal(outcome.followUp?.[0]?.method, 'notifications/subscriptions/acknowledged')
  })

  it('reports the method unsupported when the host offers no subscriptions', async () => {
    const outcome = await dispatch(listen('l1', { toolsListChanged: true }), host)
    // Accepting a subscription that can never fire would be worse than refusing it.
    assert.equal((outcome.response?.error as { code: number }).code, -32601)
  })
})

describe('P26-09 — events carry the subscription id and reach only their subscriber', () => {
  it('carries the subscription id in the notification metadata', () => {
    const registry = new SubscriptionRegistry()
    const { subscriptionId } = registry.listen(listen('l1', { toolsListChanged: true }), 'client-a')
    const [message] = registry.publishToolListChanged(3)
    const params = message?.notification.params as { _meta: Record<string, unknown>; generation: number }
    // Without it, a client holding several subscriptions cannot tell which one an
    // event belongs to.
    assert.equal(params._meta[SUBSCRIPTION_ID_KEY], subscriptionId)
    // The generation lets a client tell a real change from a duplicate delivery.
    assert.equal(params.generation, 3)
  })

  it('delivers only to a subscriber that requested the type', () => {
    const registry = new SubscriptionRegistry()
    registry.listen(listen('l1', { toolsListChanged: true }), 'wants-tools')
    registry.listen(listen('l2', {}), 'wants-nothing')
    const messages = registry.publishToolListChanged(2)
    assert.deepEqual(messages.map(message => message.clientId), ['wants-tools'])
  })

  it('NEVER delivers one client\'s catalog change to another', () => {
    // The leakage the requirement names: each subscription sees its own catalog.
    const registry = new SubscriptionRegistry()
    registry.listen(listen('l1', { toolsListChanged: true }), 'private-client')
    registry.listen(listen('l2', { toolsListChanged: true }), 'other-client')
    const messages = registry.publishToolListChanged(2)
    // One message PER subscriber, each addressed, rather than one shared broadcast
    // whose safety would depend on how the transport iterated it.
    assert.equal(messages.length, 2)
    const ids = messages.map(message => (message.notification.params as { _meta: Record<string, unknown> })._meta[SUBSCRIPTION_ID_KEY])
    assert.equal(new Set(ids).size, 2, 'each subscriber must receive its own subscription id')
    for (const message of messages) {
      assert.ok(['private-client', 'other-client'].includes(message.clientId))
    }
  })

  it('identifies the subscription BY the listen request that opened it', () => {
    const registry = new SubscriptionRegistry()
    const first = registry.listen(listen('l1', { toolsListChanged: true }), 'a').subscriptionId
    const second = registry.listen(listen('l2', { toolsListChanged: true }), 'b').subscriptionId

    /**
     * THE SUBSCRIPTION ID *IS* THE LISTEN REQUEST ID, and this test used to assert the
     * opposite.
     *
     * It required `/^sub_/` — a server-INVENTED format — while the pinned schema identifies
     * the subscription by the request that opened it. `CancelledNotification` states that
     * the stream-terminating cancellation "references the ID of the `subscriptions/listen`
     * request that opened the stream", and `SubscriptionsListenResultMetaObject` types its
     * required `subscriptionId` as a `RequestId`, "so the client can correlate it with the
     * originating subscription". An invented id the client never saw correlates with
     * nothing.
     *
     * A test that goes RED when the code is made CORRECT is worse than no test, because it
     * turns a divergence into a defended position. This one did exactly that.
     */
    assert.equal(first, 'l1')
    assert.equal(second, 'l2')
  })

  it('keeps two clients apart by BINDING, not by inventing an id', () => {
    /**
     * The concern the old assertion was reaching for is real; the fix is the binding rather
     * than an invented identifier. Each subscription records its owning client, and
     * revocation is filtered on it — so client-chosen ids are safe.
     */
    const registry = new SubscriptionRegistry()
    registry.listen(listen('l1', { toolsListChanged: true }), 'a')
    registry.listen(listen('l2', { toolsListChanged: true }), 'b')

    // Each client's revocation reaches its OWN subscription and no other.
    assert.equal(registry.revoke('a').length, 1)
    assert.equal(registry.revoke('b').length, 1)
    // And a second revocation for the same client finds nothing left to close.
    assert.equal(registry.revoke('a').length, 0)
  })
})

describe('P26-09 — revocation announces before closing', () => {
  it('sends a cancelled notification referencing the SUBSCRIPTION request', () => {
    const registry = new SubscriptionRegistry()
    const { subscriptionId } = registry.listen(listen('l1', { toolsListChanged: true }), 'client-a')
    const [teardown] = registry.revoke('client-a')
    assert.equal(teardown?.notification.method, 'notifications/cancelled')
    // References the listen request, so a client can match it to what it called.
    assert.equal((teardown?.notification.params as { requestId: string }).requestId, subscriptionId)
    assert.equal(teardown?.clientId, 'client-a')
  })

  it('stops delivering immediately after revocation', () => {
    const registry = new SubscriptionRegistry()
    registry.listen(listen('l1', { toolsListChanged: true }), 'client-a')
    registry.revoke('client-a')
    // No window in which one last event reaches a revoked client.
    assert.deepEqual([...registry.publishToolListChanged(4)], [])
    assert.deepEqual([...registry.active], [])
  })

  it('revokes only the targeted client', () => {
    const registry = new SubscriptionRegistry()
    registry.listen(listen('l1', { toolsListChanged: true }), 'client-a')
    registry.listen(listen('l2', { toolsListChanged: true }), 'client-b')
    registry.revoke('client-a')
    // Terminating one client's subscriptions must leave unrelated clients alive.
    assert.deepEqual(registry.publishToolListChanged(5).map(message => message.clientId), ['client-b'])
  })

  it('revoking a client with no subscriptions is a no-op', () => {
    assert.deepEqual([...new SubscriptionRegistry().revoke('nobody')], [])
  })

  it('closing a subscription requires ownership', () => {
    const registry = new SubscriptionRegistry()
    const { subscriptionId } = registry.listen(listen('l1', { toolsListChanged: true }), 'owner')
    // Without the check, one client could close another's subscription by guessing.
    assert.equal(registry.close(subscriptionId, 'intruder'), false)
    assert.equal(registry.forClient('owner').length, 1)
    assert.equal(registry.close(subscriptionId, 'owner'), true)
    assert.equal(registry.forClient('owner').length, 0)
  })

  it('builds a client cancellation naming the subscription', () => {
    assert.deepEqual(cancelSubscription('sub_1'), {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'sub_1' },
    })
  })
})

describe('P26-10 / P26-12 — the catalog stream stays a catalog stream', () => {
  it('emits only the tool-list-changed notification type', () => {
    const registry = new SubscriptionRegistry()
    registry.listen(listen('l1', { toolsListChanged: true }), 'a')
    for (const message of registry.publishToolListChanged(2)) {
      // No progress, no logging: progress belongs on the response stream of the call
      // that produced it, or one call's progress would reach every subscriber.
      assert.equal(message.notification.method, 'notifications/tools/list_changed')
    }
  })

  it('advertises subscriptions/listen only because toolsListChanged is served', () => {
    const entry = ADVERTISED_FEATURES.find(candidate => candidate.feature === 'subscriptions/listen')
    assert.equal(entry?.implemented, true)
    // And the narrow reality is stated on the wire by the acknowledgement rather
    // than by the feature list.
    assert.deepEqual([...SUPPORTED_FILTERS], ['toolsListChanged'])
  })
})
