/**
 * OBS-02, wired end to end: an EXTERNAL call through the host's OWN MCP surface
 * produces an accounting record, and that record carries sizes and class —
 * never the payload.
 *
 * Before the round-63 fix the host's `createMcpHost` was built WITHOUT an
 * `onAccounted`, so the accounting the binding computed was dropped and the
 * receipts surface had no external half. The host now exposes its own mcp host
 * as the `model-tools.mcp-host` service and wires the accounting into a bounded
 * ring that the `receipts` action reports.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'

import { createHttpHandler } from '../src/mcp/http.ts'
import { PROTOCOL_VERSION } from '../src/mcp/protocol.ts'
import type { McpHost } from '../src/mcp/host-binding.ts'
import { cleanup, callTool, mountPlugin } from './helpers.ts'

after(async () => { await cleanup() })

const TOKEN = 'obs02-external-token'

describe('OBS-02 — an external call is WIRED into the host receipt surface', () => {
  it('a real tools/call lands in the external accounting ring, with sizes and class, never a payload', async () => {
    const ctx: Context = await mountPlugin({})
    const host = ctx.get('model-tools.mcp-host') as McpHost | undefined
    assert.ok(host !== undefined, 'the host must expose its own MCP surface')
    const handler = createHttpHandler({
      path: '/mcp',
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      allowedOrigins: [],
      auth: { scheme: 'static-token', token: TOKEN, clientId: 'obs02' },
      // External accounting is the subject; the AT-12 rate limiter is the subject of
      // mcp-rate-limit.test.ts.
      rateLimit: false,
    }, host)

    const response = await handler({
      method: 'POST',
      path: '/mcp',
      remoteAddress: '127.0.0.1',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'mcp-protocol-version': PROTOCOL_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'lang_detect',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
          name: 'lang_detect',
          arguments: { text: 'kann ich das haben' },
        },
      }),
    })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    if (response.status !== 200) return
    // THE INFERENCE RESULT, asserted so the test proves a real successful call
    // rather than a canned-success stub (the round-65 review's strength note):
    // the external call must carry the actual detected language.
    const wire = JSON.parse(response.body) as { result?: { structuredContent?: { language?: string } } }
    assert.equal(wire.result?.structuredContent?.language, 'de', 'the external call must return the real inference result')

    // The receipt surface must now carry the external half.
    const receipts = await callTool(ctx, 'model_tools', { action: 'receipts' })
    if (receipts.isError) {
      assert.fail(`receipts action refused: ${JSON.stringify(receipts)}`)
    }
    const value = (receipts as { value?: { receipts?: { receiptId: string }[]; external?: unknown[] } }).value
    const external = value?.external
    assert.ok(Array.isArray(external) && external.length >= 1, 'an external call must be recorded')
    const entry = external[external.length - 1] as Record<string, unknown>
    assert.ok(typeof entry.receiptId === 'string' && entry.receiptId.length > 0)
    // CORRELATION (round 65): the external accounting joins the NATIVE ring by
    // the receipt id the host dispatch issued, when the contract payload's meta
    // carries it — the two rings are no longer unjoinable. The same call also
    // produced a native receipt; the ids must match.
    const native = value?.receipts?.find(candidate => candidate.receiptId === entry.receiptId)
    assert.ok(native !== undefined, `the external accounting must correlate with a native receipt (external id ${String(entry.receiptId)})`)
    assert.equal(entry.failureClass, 'none')
    assert.ok(typeof entry.totalMs === 'number' && entry.totalMs >= 0)
    assert.ok(typeof entry.inputBytes === 'number' && entry.inputBytes > 0, 'the request crossed the boundary, so its size is measured')
    assert.ok(typeof entry.outputBytes === 'number' && entry.outputBytes >= 0)
    assert.ok(typeof entry.engineVersion === 'string')
    // The record has NO field through which a payload could arrive: the shape
    // is exactly the projection, so any extra field would fail this assertion.
    // SEC-04: the external entry additionally names the CLIENT'S grant identity —
    // identity only, still never the payload.
    assert.deepEqual(Object.keys(entry).sort(), ['clientId', 'engineVersion', 'failureClass', 'grantId', 'inputBytes', 'outputBytes', 'reason', 'receiptId', 'totalMs'])
    assert.equal(entry.grantId, 'external:obs02', 'the record must carry the CLIENT grant, not the operator identity')
    assert.equal(entry.clientId, 'obs02')
  })
})
