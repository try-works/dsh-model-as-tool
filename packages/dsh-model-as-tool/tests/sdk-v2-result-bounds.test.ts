import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import { createHttpHandler, type HttpRequestDescription, type HttpTransportConfig } from '../src/mcp/http.ts'
import { META_KEYS, PROTOCOL_VERSION } from '../src/mcp/protocol.ts'
import type { McpHost, McpToolDefinition } from '../src/mcp/server.ts'

const config: HttpTransportConfig = {
  path: '/mcp', host: '127.0.0.1', port: 0, maxBodyBytes: 1024 * 1024,
  allowedOrigins: [], rateLimit: false,
  auth: { scheme: 'static-token', token: 'bounds-token', clientId: 'bounds-client' },
}
const meta = { [META_KEYS.protocolVersion]: PROTOCOL_VERSION, [META_KEYS.clientCapabilities]: {} }

function request(method = 'tools/call', params: Record<string, unknown> = {}, headers: Record<string, string> = {}): HttpRequestDescription {
  return { method: 'POST', path: '/mcp', remoteAddress: '127.0.0.1',
    headers: { authorization: 'Bearer bounds-token', 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': method, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { _meta: meta, ...params } }),
  }
}
const schema = JSON.parse(readFileSync('docs/tool-mode/specs/mcp-2026-07-28/schema.json', 'utf8'))
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
ajv.addSchema(schema, 'official2026')
function pinned(name: string, value: unknown) {
  const validate = ajv.compile({ $ref: `official2026#/$defs/${name}` })
  assert.equal(validate(value), true, JSON.stringify(validate.errors))
}

/** A host serving one tool that always returns the same outcome. */
function outcomeHost(definitions: McpToolDefinition[], outcome: unknown): McpHost {
  return {
    serverInfo: { name: 'bounds-test', version: '1' },
    listTools: () => definitions,
    async callTool() { return outcome as never },
  }
}

describe('official SDK v2 result bounds', { concurrency: false }, () => {
  it('clamps accepted tool failures through toolErrorResult and keeps the denied path pinned', async () => {
    const big = 'x'.repeat(1024 * 1024)
    const definition: McpToolDefinition = {
      name: 'boom', description: 'Boom', importedFromMcp: false,
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    }
    const hidden: McpToolDefinition = {
      name: 'hidden', description: 'Hidden', importedFromMcp: false,
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    }
    const host = outcomeHost([definition, hidden], { text: big, isError: true, structured: null })
    // Accepted call: the registered callback must clamp through toolErrorResult.
    const accepted = await createHttpHandler(config, host)(request('tools/call', { name: 'boom', arguments: {} }, { 'mcp-name': 'boom' }))
    assert.equal(accepted.status, 200, accepted.body)
    const acceptedResult = JSON.parse(accepted.body).result
    assert.equal(acceptedResult.isError, true)
    const acceptedText: string = acceptedResult.content[0].text
    assert.ok(acceptedText.length <= 2001, `clamped text is ${acceptedText.length} chars`)
    assert.equal(acceptedText, `${big.slice(0, 2000)}…`, 'the protocol 2000-char clamp with ellipsis')
    pinned('CallToolResult', acceptedResult)
    // Denied call: the request-specific handler already used toolErrorResult and
    // must keep the same clamp, not a raw outcome.
    const denied = createHttpHandler(
      { ...config, grants: { perClient: { 'bounds-client': { allowedTools: ['boom'] } } } },
      host,
    )
    const deniedResponse = await denied(request('tools/call', { name: 'hidden', arguments: {} }, { 'mcp-name': 'hidden' }))
    assert.equal(deniedResponse.status, 200, deniedResponse.body)
    const deniedResult = JSON.parse(deniedResponse.body).result
    assert.equal(deniedResult.isError, true)
    assert.equal(deniedResult.resultType, 'complete')
    const deniedText: string = deniedResult.content[0].text
    assert.equal(deniedText, `${big.slice(0, 2000)}…`)
    assert.equal('structuredContent' in deniedResult, false)
    pinned('CallToolResult', deniedResult)
  })

  const valueCases: ReadonlyArray<{ label: string; outputSchema: Record<string, unknown>; structured: unknown }> = [
    { label: 'array', outputSchema: { type: 'array', items: { type: 'integer' } }, structured: [1, 2, 3] },
    { label: 'string', outputSchema: { type: 'string' }, structured: 'plain' },
    { label: 'number zero', outputSchema: { type: 'number' }, structured: 0 },
    { label: 'boolean false', outputSchema: { type: 'boolean' }, structured: false },
    { label: 'null', outputSchema: { type: 'null' }, structured: null },
    // The object case keeps its prior shape and must not regress.
    { label: 'object', outputSchema: { type: 'object', properties: { a: { type: 'string' } } }, structured: { a: 'x' } },
  ]
  for (const { label, outputSchema, structured } of valueCases) {
    it(`emits structuredContent for a ${label} value, not a tool error`, async () => {
      const definition: McpToolDefinition = {
        name: 'p', description: 'P', importedFromMcp: false,
        inputSchema: { type: 'object' }, outputSchema,
      }
      const host = outcomeHost([definition], { text: 'ok', structured })
      const response = await createHttpHandler(config, host)(request('tools/call', { name: 'p', arguments: {} }, { 'mcp-name': 'p' }))
      assert.equal(response.status, 200, response.body)
      const result = JSON.parse(response.body).result
      assert.equal(result.isError, undefined, `expected success, got ${response.body}`)
      assert.ok('structuredContent' in result, `structuredContent must reach the wire: ${response.body}`)
      assert.deepEqual(result.structuredContent, structured)
      // The handler authors its own text block, so the SDK must not auto-append
      // a JSON.stringify rendering for non-object values (SEP-2106 §4.3).
      assert.deepEqual(result.content, [{ type: 'text', text: 'ok' }])
      pinned('CallToolResult', result)
    })
  }

  it('omits the structuredContent key when the host produced no structured value', async () => {
    const definition: McpToolDefinition = {
      name: 'p', description: 'P', importedFromMcp: false,
      // An empty schema declares no result shape, so the adapter registers no
      // outputSchema and the SDK must not convert the content-only outcome
      // into an "output schema but no structured content" tool error.
      inputSchema: { type: 'object' }, outputSchema: {},
    }
    const host = outcomeHost([definition], { text: 'ok', structured: undefined })
    const response = await createHttpHandler(config, host)(request('tools/call', { name: 'p', arguments: {} }, { 'mcp-name': 'p' }))
    assert.equal(response.status, 200, response.body)
    const result = JSON.parse(response.body).result
    assert.equal(result.isError, undefined, `expected success, got ${response.body}`)
    assert.equal('structuredContent' in result, false, `no structuredContent key: ${response.body}`)
    assert.deepEqual(result.content, [{ type: 'text', text: 'ok' }])
    pinned('CallToolResult', result)
  })
})
