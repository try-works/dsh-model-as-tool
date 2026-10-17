import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deliverCatalogChange,
  MemoryDeliverySink,
  SubscriptionRegistry,
} from '../src/mcp/subscriptions.ts'

/** A minimal valid subscriptions/listen wire request. */
function listenWire(id: string, notifications: Record<string, boolean>) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'subscriptions/listen' as const,
    params: {
      _meta: { protocolVersion: '2026-07-28' },
      notifications,
    },
  }
}

test('P26-09 delivery: a subscriber receives the catalog change through the consumer (ack-first)', () => {
  const registry = new SubscriptionRegistry()
  const sink = new MemoryDeliverySink()
  const { acknowledgement } = registry.listen(listenWire('sub-a', { toolsListChanged: true }), 'client-a')
  // The acknowledgement precedes any publish: it was returned by listen().
  assert.equal(acknowledgement.method, 'notifications/subscriptions/acknowledged')
  const delivered = deliverCatalogChange(registry, 7, sink)
  assert.equal(delivered, 1)
  const queue = sink.forClient('client-a')
  assert.equal(queue.length, 1)
  assert.equal(queue[0]!.notification.method, 'notifications/tools/list_changed')
  assert.equal((queue[0]!.notification.params as { generation: number }).generation, 7)
  // The subscription id rides the meta, so a multi-subscription client can
  // attribute the event.
  const params = queue[0]!.notification.params as { _meta: Record<string, unknown> }
  assert.equal(params._meta['io.modelcontextprotocol/subscriptionId'], 'sub-a')
})

test('P26-09 delivery: an unauthorized client never sees another client\'s change', () => {
  const registry = new SubscriptionRegistry()
  const sink = new MemoryDeliverySink()
  registry.listen(listenWire('sub-a', { toolsListChanged: true }), 'client-a')
  registry.listen(listenWire('sub-b', { toolsListChanged: false }), 'client-b')
  const delivered = deliverCatalogChange(registry, 8, sink)
  // Only client-a asked for toolsListChanged; client-b's filter refused it.
  assert.equal(delivered, 1)
  assert.equal(sink.forClient('client-a').length, 1)
  assert.equal(sink.forClient('client-b').length, 0)
})

test('P26-09 delivery: revocation closes the stream and stops delivery entirely', () => {
  const registry = new SubscriptionRegistry()
  const sink = new MemoryDeliverySink()
  registry.listen(listenWire('sub-a', { toolsListChanged: true }), 'client-a')
  assert.equal(deliverCatalogChange(registry, 1, sink), 1)
  // The teardown-cancelled frames arrive BEFORE the stream closes (P26-09).
  const revoked = registry.revoke('client-a')
  assert.equal(revoked.length, 1)
  assert.equal(revoked[0]!.notification.method, 'notifications/cancelled')
  for (const message of revoked) sink.deliver(message)
  sink.closeClient('client-a', 'the grant for this subscription was revoked')
  // A later publish delivers nothing to the revoked client.
  const after = deliverCatalogChange(registry, 2, sink)
  assert.equal(after, 0)
  assert.equal(sink.closeReason('client-a'), 'the grant for this subscription was revoked')
})
