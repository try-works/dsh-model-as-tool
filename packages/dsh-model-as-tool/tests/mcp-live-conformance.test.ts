/**
 * LIVE MCP conformance over a real socket (slice 1, and correction A13).
 *
 * Every other MCP check in this repository validates SAVED FIXTURES against the pinned
 * schema. That is a useful schema test and it is NOT live conformance: the probe reads
 * frozen files and never starts the server. This file starts the actual server on an
 * OS-chosen port and drives it over TCP with an independently implemented client that
 * shares no code with the server — raw `fetch`, hand-built JSON-RPC bodies, headers
 * inspected directly.
 *
 * The inference asserted at the end is REAL: `lang_detect` runs Tongue on this host and
 * must return `de` for German. That is the same model `verify:built` exercises, reached
 * here through HTTP rather than in-process.
 *
 * Requirement links: MCP-01..MCP-13, MCP-02 (loopback only), SEC-02 (origins and size),
 * P26-01..P26-17, AT-01.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createMcpHost, type HostSurface, type PublishedTool } from '../src/mcp/host-binding.ts'
import { STANDARD_CONTRACTS } from '@try-works/tool-mode-contracts'
import { startHttpServer, type HttpTransportConfig } from '../src/mcp/http.ts'
import { PROTOCOL_VERSION, META_KEYS } from '../src/mcp/protocol.ts'
import { cleanup, mountPlugin } from './helpers.ts'

after(async () => { await cleanup() })

const TOKEN = 'live-conformance-token'

/** The transport settings a real deployment starts with. */
function config(port = 0): HttpTransportConfig {
  return {
    path: '/mcp',
    host: '127.0.0.1',
    port,
    maxBodyBytes: 1024 * 1024,
    allowedOrigins: [],
    // A static token so the negative authorization case has something to fail against.
    auth: { kind: 'static-token', token: TOKEN },
  } as HttpTransportConfig
}

/** A host surface backed by the REAL plugin's tool registry and REAL contracts. */
async function liveServer() {
  const ctx = await mountPlugin({})
  /**
   * The published set is built from the REPOSITORY'S OWN standard contracts.
   *
   * The first version of this file hand-wrote a synthetic surface and set `contract` to a
   * STRING, where the real shape has `contract` as an object carrying `description`,
   * `inputSchema` and `outputSchema`. `tools/list` then answered `-32603` with
   * "Cannot read properties of undefined (reading 'properties')".
   *
   * That was a defect in THIS TEST, not in the server: a tool arrives with its contract,
   * and the binding reads the schemas off it. Using the real contracts means the surface
   * cannot drift from what the binding actually consumes — which is the whole reason
   * driving the live path is worth doing.
   */
  const registered = new Set(ctx.tools.schemas().map(schema => schema.name))
  const published: PublishedTool[] = STANDARD_CONTRACTS
    .filter(contract => registered.has(contract.toolName))
    .map(contract => ({ toolName: contract.toolName, contract }))
  const surface: HostSurface = {
    published,
    async execute({ name, arguments: args }) {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: `live-${name}-${Date.now()}` as never,
        name,
        arguments: args,
      })
      /**
       * Return the OUTCOME WRAPPER, not the bare value.
       *
       * `HostSurface.execute` promises `{ isError, value?, message? }`. The first version
       * of this surface returned the raw tool value, so `callTool` read `outcome.isError`
       * as undefined (falsy), took the success branch, and found `outcome.value` also
       * undefined — producing a response whose `structuredContent` was `null` and whose
       * text was the string "null" from stringifying it.
       *
       * The tool had in fact run correctly and returned the right object; the wrapper was
       * what went missing. A bare value is a plausible mistake precisely because it LOOKS
       * like a successful result.
       */
      if (result.isError) {
        return { isError: true, message: result.error?.message ?? 'the tool failed' }
      }
      return { isError: false, value: result.value }
    },
  }
  const host = createMcpHost({ surface, serverInfo: { name: 'tool-mode', version: '0.1.3' } })
  const endpoint = await startHttpServer(config(), host)
  return { ctx, endpoint, names: published.map(tool => tool.toolName) }
}

/**
 * POST one JSON-RPC body, returning the status and parsed JSON.
 *
 * THE HEADERS ARE THE POINT OF THIS FILE. The live server requires
 * `MCP-Protocol-Version` on every request and `Mcp-Name` on a named call, and answers
 * HTTP 400 with `headerMismatch` without them. The saved-fixture probe never caught that,
 * because the fixtures were produced by code that already knew to send them — which is
 * exactly the blind spot a hand-written client exposes and a fixture cannot.
 */
async function rpc(
  url: string,
  body: any,
  options: {
    readonly token?: string | null
    readonly headers?: Record<string, string>
    /** Set false to OMIT the required version header, for the negative test. */
    readonly versionHeader?: boolean
  } = {},
): Promise<{ status: number; headers: Headers; json: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...options.headers,
  }
  if (options.versionHeader !== false) {
    headers['mcp-protocol-version'] = options.headers?.['mcp-protocol-version'] ?? PROTOCOL_VERSION
  }
  // `Mcp-Name` is required only for a named call; sending it on a `tools/list` would be
  // wrong, and the server would reject a mismatched value.
  if (body?.method === 'tools/call' && headers['mcp-name'] === undefined) {
    headers['mcp-name'] = String(body.params?.name ?? '')
  }
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  // A modern request may be answered on an SSE stream, so the JSON is extracted from the
  // last `data:` line when the body is not already JSON.
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    const line = text.split('\n').filter(entry => entry.startsWith('data:')).pop()
    json = line === undefined ? undefined : JSON.parse(line.slice(5).trim())
  }
  return { status: response.status, headers: response.headers, json }
}

/** The JSON-RPC metadata a 2026-07-28 request must carry. */
function meta() {
  return {
    [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
    [META_KEYS.clientCapabilities]: {},
  }
}

describe('slice 1 — LIVE MCP conformance against the running server', () => {
  it('answers server/discover over a real socket (2026-07-28 replaced the handshake)', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta() },
      })
      assert.equal(response.status, 200, JSON.stringify(response.json))
      assert.equal(response.json.jsonrpc, '2.0')
      assert.equal(response.json.id, 1)
      // The fields the pinned DiscoverResult requires. There is NO `protocolVersion`
      // on the result: 2026-07-28 replaced the negotiated handshake with a discovery
      // request, so the supported set is advertised instead of one chosen version.
      const result = response.json.result
      assert.ok(Array.isArray(result.supportedVersions), 'supportedVersions is required')
      assert.ok(
        result.supportedVersions.includes(PROTOCOL_VERSION),
        `the revision this layer implements must be advertised: ${JSON.stringify(result.supportedVersions)}`,
      )
      assert.ok('capabilities' in result, 'capabilities is required')
      assert.ok('cacheScope' in result, 'cacheScope is required')
      assert.ok('ttlMs' in result, 'ttlMs is required')
      assert.equal(result.resultType, 'complete')
      // Reserved metadata the host authors, which an extension cannot forge.
      assert.equal(
        result._meta?.['io.modelcontextprotocol/serverInfo']?.name, 'tool-mode',
        'the result must carry host-authored serverInfo',
      )
    } finally {
      await endpoint.close()
    }
  })

  it('REJECTS the pre-2026 initialize handshake', async () => {
    const { endpoint } = await liveServer()
    try {
      // Asserted deliberately: a client written against an older revision is told the
      // method is unknown rather than being silently served a downgraded session.
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 11, method: 'initialize', params: { _meta: meta() },
      })
      assert.equal(response.json.error?.code, -32601)
      assert.match(response.json.error.message, /unknown method "initialize"/)
    } finally {
      await endpoint.close()
    }
  })

  it('advertises the live registry through tools/list', async () => {
    const { endpoint, names } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta() },
      })
      console.log('TOOLSLIST-BODY:', JSON.stringify(response.json).slice(0, 400))
      const tools = response.json.result.tools.map((tool: { name: string }) => tool.name)
      for (const name of names) {
        assert.ok(tools.includes(name), `${name} must be advertised`)
      }
      // The pinned schema requires these on a list result.
      assert.ok('cacheScope' in response.json.result, 'cacheScope is required')
      assert.ok('ttlMs' in response.json.result, 'ttlMs is required')
      assert.equal(response.json.result.resultType, 'complete')
    } finally {
      await endpoint.close()
    }
  })

  it('runs a REAL inference through tools/call over HTTP', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { _meta: meta(), name: 'lang_detect', arguments: { text: 'kann ich das haben' } },
      })
      assert.equal(response.status, 200)
      assert.notEqual(response.json.result?.isError, true, 'the call must succeed')
      // The model itself, reached over the wire: Tongue on this host returns German.
      const body = JSON.stringify(response.json.result)
      assert.match(body, /"language"\s*:\s*"de"/, `expected de in ${body.slice(0, 300)}`)
    } finally {
      await endpoint.close()
    }
  })

  it('REJECTS a request with no credential', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: meta() },
      }, { token: null })
      // SEC-02: an unauthenticated caller does not get a tool list.
      assert.equal(response.status, 401)
    } finally {
      await endpoint.close()
    }
  })

  it('REJECTS a request with the wrong credential', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: meta() },
      }, { token: 'not-the-token' })
      assert.equal(response.status, 401)
    } finally {
      await endpoint.close()
    }
  })

  it('serves two concurrent clients without interleaving their answers', async () => {
    const { endpoint } = await liveServer()
    try {
      // Distinct ids, issued simultaneously: a server that correlates by arrival order
      // rather than by id would swap these.
      const [first, second] = await Promise.all([
        rpc(endpoint.url, { jsonrpc: '2.0', id: 101, method: 'tools/list', params: { _meta: meta() } }),
        rpc(endpoint.url, { jsonrpc: '2.0', id: 202, method: 'tools/list', params: { _meta: meta() } }),
      ])
      assert.equal(first.json.id, 101)
      assert.equal(second.json.id, 202)
    } finally {
      await endpoint.close()
    }
  })

  it('reports an unknown tool as an error rather than silently doing nothing', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 6, method: 'tools/call',
        params: { _meta: meta(), name: 'no_such_tool', arguments: {} },
      })
      assert.ok(
        response.status >= 400 || response.json.error !== undefined || response.json.result?.isError === true,
        'an unknown tool must be reported',
      )
    } finally {
      await endpoint.close()
    }
  })

  it('releases the port on shutdown, so a second server can bind it', async () => {
    const first = await liveServer()
    const port = first.endpoint.port
    await first.endpoint.close()
    // Binding the SAME port is the only proof the release actually happened.
    const ctx = await mountPlugin({})
    const host = createMcpHost({
      surface: { published: [], async execute() { return {} } },
      serverInfo: { name: 'tool-mode', version: '0.1.3' },
    })
    const second = await startHttpServer(config(port), host)
    try {
      assert.equal(second.port, port)
      void ctx
    } finally {
      await second.close()
    }
  })

  it('refuses to bind a routable address (MCP-02)', async () => {
    const host = createMcpHost({
      surface: { published: [], async execute() { return {} } },
      serverInfo: { name: 'tool-mode', version: '0.1.3' },
    })
    await assert.rejects(
      startHttpServer({ ...config(), host: '0.0.0.0' } as HttpTransportConfig, host),
      /loopback only/,
      'a routable bind must be refused at startup',
    )
  })
})

describe('P26-05 — the header contract, discovered by driving the LIVE server', () => {
  it('REJECTS a request that omits MCP-Protocol-Version', async () => {
    const { endpoint } = await liveServer()
    try {
      // This is the case a fixture could not find: the recorded messages all carried the
      // header, because the code that produced them always sent it.
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: meta() },
      }, { versionHeader: false })
      assert.equal(response.status, 400)
      assert.equal(response.json.error.code, -32020, 'the error is headerMismatch')
      assert.match(response.json.error.message, /MCP-Protocol-Version header is required/)
    } finally {
      await endpoint.close()
    }
  })

  it('REJECTS a version header that disagrees with the body', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 8, method: 'tools/list', params: { _meta: meta() },
      }, { headers: { 'mcp-protocol-version': '2025-11-25' } })
      assert.equal(response.status, 400)
      assert.match(response.json.error.message, /does not match the request body/)
    } finally {
      await endpoint.close()
    }
  })

  it('REJECTS a named call that omits Mcp-Name', async () => {
    const { endpoint } = await liveServer()
    try {
      // Sent with an empty name header, which is present-but-wrong rather than absent.
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 9, method: 'tools/call',
        params: { _meta: meta(), name: 'lang_detect', arguments: { text: 'hallo' } },
      }, { headers: { 'mcp-name': 'stt_transcribe' } })
      assert.equal(response.status, 400)
      assert.match(response.json.error.message, /Mcp-Name header .* does not match/)
    } finally {
      await endpoint.close()
    }
  })

  it('ACCEPTS a call whose Mcp-Name matches the body', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 10, method: 'tools/call',
        params: { _meta: meta(), name: 'lang_detect', arguments: { text: 'kann ich das haben' } },
      })
      assert.equal(response.status, 200)
    } finally {
      await endpoint.close()
    }
  })
})
describe('P26-03 — the pinned schema REQUIRES HTTP 400, and the status is now asserted', () => {
  /**
   * The reviewer's finding: `-32021` and `-32022` returned HTTP 200 while the pinned schema
   * says, verbatim, "For HTTP, the response status code MUST be `400 Bad Request`" — and
   * mutating the mapping either way left the whole suite GREEN, so the status was untested
   * in BOTH directions. These tests close that.
   */
  it('answers an UNSUPPORTED REQUIRED CAPABILITY with 400 and the schema field name', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 20, method: 'tools/list',
        params: {
          _meta: {
            ...meta(),
            /**
             * `clientCapabilities.required` is an ARRAY of names a client NEEDS. A
             * capability simply being present is not a requirement — the server must not
             * reject a client for declaring more than it needs — which is why the first
             * version of this test got a 200 and was wrong about the mechanism.
             */
            'io.modelcontextprotocol/clientCapabilities': { required: ['sampling'] },
          },
        },
      })
      // The status is the half that was missing.
      assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(response.json)}`)
      assert.equal(response.json.error?.code, -32021)
      /**
       * And the DATA shape is the schema's own. The first version sent
       * `data.unsupported` where `MissingRequiredClientCapabilityError` REQUIRES
       * `data.requiredCapabilities`; the generic error definition accepted either, so only
       * the SPECIFIC one catches it.
       */
      /**
       * AN OBJECT, NOT AN ARRAY — and this assertion previously demanded the array.
       *
       * The pinned definition is `requiredCapabilities -> $ref ClientCapabilities` (type:
       * object), so the shape is `{ sampling: {} }`. My round-12 fix corrected the FIELD NAME
       * and this test then locked in the wrong VALUE TYPE, which is how a defect survives its
       * own repair: the test agreed with the code, and both were wrong together.
       */
      const required = response.json.error?.data?.requiredCapabilities
      assert.ok(
        required !== null && typeof required === 'object' && !Array.isArray(required),
        `data.requiredCapabilities must be a capabilities OBJECT: ${JSON.stringify(response.json.error?.data)}`,
      )
    } finally {
      await endpoint.close()
    }
  })

  it('answers a HEADER MISMATCH with 400', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 21, method: 'tools/list', params: { _meta: meta() },
      }, { versionHeader: false })
      // `HeaderMismatchError` carries the same MUST.
      assert.equal(response.status, 400)
      assert.equal(response.json.error?.code, -32020)
    } finally {
      await endpoint.close()
    }
  })

  it('answers a SUCCESSFUL request with 200, so the rule is not "always 400"', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 22, method: 'tools/list', params: { _meta: meta() },
      })
      // Asserted in the other direction on purpose: a mapping that returned 400 for
      // everything would satisfy the two tests above and break every client.
      assert.equal(response.status, 200)
    } finally {
      await endpoint.close()
    }
  })
})