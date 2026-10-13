/**
 * MCP dispatch tests (MCP-05, MCP-06, MCP-08, MCP-09, MCP-10, MCP-13, P26-01..P26-04).
 *
 * The host is a stub rather than a real DSH context: what is under test is the
 * WIRE behaviour — which requests are admitted, which errors are which, and what
 * the envelopes contain — and a stub makes each of those assertable without an
 * inference call standing between the test and the thing it checks.
 *
 * Requirement links: MCP-05, MCP-06, MCP-08, MCP-09, MCP-10, MCP-13, P26-01..P26-04, P26-12.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { dispatch, toMcpTool, type McpHost, type McpToolDefinition } from '../src/mcp/server.ts'
import { ERROR_CODES, META_KEYS, PROTOCOL_VERSION, type WireRequest } from '../src/mcp/protocol.ts'

/** A definition the surface can publish. */
function definition(name: string, overrides: Partial<McpToolDefinition> = {}): McpToolDefinition {
  return {
    name,
    description: `The ${name} tool, used for dispatch testing.`,
    inputSchema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    // Present, because MCP-09 requires the CANONICAL output schema rather than
    // DSH's model-facing projection, which omits it.
    outputSchema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
    importedFromMcp: false,
    ...overrides,
  }
}

/** A host stub recording what was invoked. */
function makeHost(tools: readonly McpToolDefinition[] = [definition('lang_detect')]) {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const host: McpHost = {
    serverInfo: { name: 'dsh-tool-mode', version: '0.1.0' },
    listTools: () => tools,
    async callTool(name, args) {
      calls.push({ name, args })
      if (name === 'explodes') return { structured: null, text: 'the model is unprepared', isError: true }
      return { structured: { language: 'de' }, text: 'Detected language: de' }
    },
  }
  return { host, calls }
}

/** A modern request. */
function request(method: string, params: Record<string, unknown> = {}): WireRequest {
  return {
    jsonrpc: '2.0',
    id: 'req-1',
    method,
    params: {
      ...params,
      _meta: {
        [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
        [META_KEYS.clientInfo]: { name: 'test', version: '1.0.0' },
        [META_KEYS.clientCapabilities]: {},
      },
    },
  }
}

const resultOf = (response: Record<string, unknown> | undefined) => response?.result as Record<string, unknown>
const errorOf = (response: Record<string, unknown> | undefined) => response?.error as { code: number; message: string }

describe('P26-01 — a valid request works as the FIRST one', () => {
  it('answers tools/list with no initialize and no session', async () => {
    const { host } = makeHost()
    const { response, httpStatus } = await dispatch(request('tools/list'), host)
    // Nothing preceded this call and nothing was retained from a previous one.
    assert.equal(httpStatus, 200)
    assert.equal(errorOf(response), undefined)
    assert.equal(resultOf(response)?.resultType, 'complete')
  })

  it('answers tools/call as the first request too', async () => {
    const { host, calls } = makeHost()
    const { response } = await dispatch(
      request('tools/call', { name: 'lang_detect', arguments: { text: 'hallo' } }),
      host,
    )
    assert.equal(errorOf(response), undefined)
    assert.deepEqual(calls.map(entry => entry.name), ['lang_detect'])
  })

  it('retains nothing between two dispatches', async () => {
    const { host } = makeHost()
    const first = await dispatch(request('tools/list'), host)
    const second = await dispatch(request('tools/list'), host)
    // Two independent requests produce equal results, so no state accumulated.
    assert.deepEqual(resultOf(first.response)?.tools, resultOf(second.response)?.tools)
  })
})

describe('P26-02 / P26-03 — metadata and version errors reach the wire', () => {
  it('returns -32602 and HTTP 400 for a request with no _meta', async () => {
    const { host } = makeHost()
    const { response, httpStatus } = await dispatch({ jsonrpc: '2.0', id: 'x', method: 'tools/list' }, host)
    assert.equal(errorOf(response)?.code, ERROR_CODES.invalidParams)
    // The requirement names HTTP 400 specifically for invalid params.
    assert.equal(httpStatus, 400)
  })

  it('returns -32022 with the supported list for a legacy version', async () => {
    const { host } = makeHost()
    const legacy = request('tools/list')
    ;(legacy.params?._meta as Record<string, unknown>)[META_KEYS.protocolVersion] = '2025-11-25'
    const { response } = await dispatch(legacy, host)
    assert.equal(errorOf(response)?.code, -32022)
    assert.deepEqual((response?.error as { data: unknown }).data, {
      supported: ['2026-07-28'],
      requested: '2025-11-25',
    })
  })

  it('returns -32021 when the client requires a capability this server lacks', async () => {
    const { host } = makeHost()
    const demanding = request('tools/list')
    ;(demanding.params?._meta as Record<string, unknown>)[META_KEYS.clientCapabilities] = {
      required: ['tools', 'sampling'],
    }
    const { response } = await dispatch(demanding, host)
    assert.equal(errorOf(response)?.code, -32021)
  })

  it('does not mistake an OPTIONAL capability for a required one', async () => {
    const { host } = makeHost()
    const optional = request('tools/list')
    ;(optional.params?._meta as Record<string, unknown>)[META_KEYS.clientCapabilities] = {
      sampling: {},
      required: ['tools'],
    }
    const { response } = await dispatch(optional, host)
    // A client may declare what it merely supports; only `required` can make a
    // request unserviceable.
    assert.equal(errorOf(response), undefined)
  })
})

describe('P26-05 — header mismatches are refused', () => {
  it('returns -32020 and HTTP 400 when a header disagrees', async () => {
    const { host } = makeHost()
    const { response, httpStatus } = await dispatch(request('tools/list'), host, {
      checkHeaders: true,
      headers: { protocolVersion: '2025-11-25', method: 'tools/list' },
    })
    assert.equal(errorOf(response)?.code, -32020)
    assert.equal(httpStatus, 400)
  })

  it('does not check headers when the transport has none (stdio)', async () => {
    const { host } = makeHost()
    const { response } = await dispatch(request('tools/list'), host, { checkHeaders: false })
    assert.equal(errorOf(response), undefined)
  })
})

describe('MCP-05 / MCP-06 — discovery', () => {
  it('server/discover reports the revision and the feature matrix', async () => {
    const { host } = makeHost()
    const { response } = await dispatch(request('server/discover'), host)
    const result = resultOf(response)
    assert.equal(result?.protocolVersion, PROTOCOL_VERSION)
    const features = result?.features as { feature: string; implemented: boolean }[]
    // P26-12: the matrix is machine-readable, including what is NOT implemented, so
    // a client can tell "absent" from "unmentioned".
    assert.ok(features.some(entry => entry.feature === 'tasks' && entry.implemented === false))
  })

  it('tools/list is deterministically ordered', async () => {
    const { host } = makeHost([definition('zebra'), definition('alpha'), definition('middle')])
    const { response } = await dispatch(request('tools/list'), host)
    const tools = resultOf(response)?.tools as { name: string }[]
    assert.deepEqual(tools.map(tool => tool.name), ['alpha', 'middle', 'zebra'])
  })

  it('exports the canonical output schema, not an omitted one (MCP-09)', async () => {
    const { host } = makeHost()
    const { response } = await dispatch(request('tools/list'), host)
    const tools = resultOf(response)?.tools as Record<string, unknown>[]
    // DSH's model-facing `schemas()` intentionally omits `output`; a schema-only
    // export built from that projection would be missing this field entirely.
    assert.ok(tools[0]?.outputSchema, 'the tool must publish an output schema')
    assert.ok(tools[0]?.inputSchema)
    assert.equal(tools[0]?.name, 'lang_detect')
  })

  it('projecting a definition does not invent fields', () => {
    const projected = toMcpTool(definition('x'))
    assert.deepEqual(Object.keys(projected).sort(), ['description', 'inputSchema', 'name', 'outputSchema'])
  })
})

describe('MCP-10 / P26-04 — the error distinction on the wire', () => {
  it('an unknown tool is invalid params, not a tool error', async () => {
    const { host, calls } = makeHost()
    const { response } = await dispatch(request('tools/call', { name: 'absent', arguments: {} }), host)
    // Nothing was invoked, so a domain failure would be a fabrication.
    assert.equal(errorOf(response)?.code, ERROR_CODES.invalidParams)
    assert.equal(calls.length, 0)
  })

  it('an application failure is a SUCCESSFUL response carrying isError', async () => {
    const { host } = makeHost([definition('explodes')])
    const { response, httpStatus } = await dispatch(request('tools/call', { name: 'explodes', arguments: {} }), host)
    assert.equal(errorOf(response), undefined)
    assert.equal(httpStatus, 200)
    assert.equal(resultOf(response)?.isError, true)
    assert.equal(resultOf(response)?.resultType, 'complete')
  })

  it('a successful call carries structuredContent and a bounded text rendering', async () => {
    const { host } = makeHost()
    const { response } = await dispatch(request('tools/call', { name: 'lang_detect', arguments: { text: 'hi' } }), host)
    const result = resultOf(response)
    assert.deepEqual(result?.structuredContent, { language: 'de' })
    assert.equal((result?.content as { text: string }[])[0]?.text, 'Detected language: de')
  })

  it('an infrastructure failure is a JSON-RPC error, never a domain payload', async () => {
    const host: McpHost = {
      serverInfo: { name: 'x', version: '1' },
      listTools: () => [definition('boom')],
      callTool() { throw new Error('the worker died') },
    }
    const { response } = await dispatch(request('tools/call', { name: 'boom', arguments: {} }), host)
    assert.equal(errorOf(response)?.code, ERROR_CODES.internalError)
    assert.equal(resultOf(response), undefined)
  })

  it('rejects malformed arguments as invalid params', async () => {
    const { host } = makeHost()
    const { response } = await dispatch(request('tools/call', { name: 'lang_detect', arguments: 'nope' }), host)
    assert.equal(errorOf(response)?.code, ERROR_CODES.invalidParams)
  })

  it('rejects a tools/call with no name', async () => {
    const { host } = makeHost()
    const { response } = await dispatch(request('tools/call', {}), host)
    assert.equal(errorOf(response)?.code, ERROR_CODES.invalidParams)
  })

  it('reports an unknown method rather than pretending to serve it', async () => {
    const { host } = makeHost()
    const { response } = await dispatch(request('resources/list'), host)
    assert.equal(errorOf(response)?.code, ERROR_CODES.methodNotFound)
  })

  it('preserves the request id on every error path', async () => {
    const { host } = makeHost()
    // Each response must echo ITS OWN id, not a remembered one: a client matching
    // responses to requests cannot recover from a mismatched id.
    const cases: WireRequest[] = [
      { jsonrpc: '2.0', id: 'keep-me', method: 'tools/list' },
      request('nonsense'),
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'absent' } },
    ]
    for (const bad of cases) {
      const { response } = await dispatch(bad, host)
      assert.equal(response?.id, bad.id ?? null, `the id of ${bad.method} must be echoed`)
    }
  })
})

describe('MCP-13 — no re-export and no delegation loop', () => {
  it('refuses to invoke a tool imported from MCP', async () => {
    const { host, calls } = makeHost([definition('imported', { importedFromMcp: true })])
    const { response } = await dispatch(request('tools/call', { name: 'imported', arguments: {} }), host)
    // Re-exporting would let a server delegate back into itself through a loop no
    // caller can see.
    assert.equal(errorOf(response)?.code, ERROR_CODES.invalidParams)
    assert.match(errorOf(response)?.message ?? '', /not re-exported/)
    assert.equal(calls.length, 0)
  })
})
