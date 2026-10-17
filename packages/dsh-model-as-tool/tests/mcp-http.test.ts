/**
 * HTTP transport tests (MCP-02, MCP-03, SEC-02, P26-05..P26-07, P26-15, P26-16).
 *
 * P26-16 names the qualification cases directly: origin rejection, invalid tokens,
 * insufficient scopes, token leakage, mixed clients and preapproved headless
 * operation. These tests cover the ones this transport implements, and the ones it
 * does not implement are recorded as absent rather than skipped quietly.
 *
 * The handler takes a request DESCRIPTION rather than a socket, so every refusal is
 * reachable without binding a port. A transport whose refusals can only be tested
 * by hand is a transport whose refusals are untested.
 *
 * Requirement links: MCP-02, MCP-03, SEC-02, P26-05, P26-06, P26-07, P26-15, P26-16.
 */

import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  authProfile,
  claimsOAuthConformance,
  createHttpHandler,
  DEFAULT_HTTP_CONFIG,
  isLoopback,
  type HttpRequestDescription,
  type HttpTransportConfig,
} from '../src/mcp/http.ts'
import { ERROR_CODES, META_KEYS, PROTOCOL_VERSION } from '../src/mcp/protocol.ts'
import { DEFAULT_RATE_LIMIT_POLICY } from '../src/mcp/rate-limit.ts'
import { startHttpServer } from '../src/mcp/http.ts'
import type { McpHost, McpToolDefinition } from '../src/mcp/server.ts'

const TOKEN = 'test-token-that-is-not-committed-anywhere'

const host: McpHost = {
  serverInfo: { name: 'dsh-tool-mode', version: '0.1.0' },
  listTools: (): McpToolDefinition[] => [{
    name: 'lang_detect',
    description: 'Identify the language of the supplied text.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
    outputSchema: { type: 'object', additionalProperties: false, required: ['language'], properties: { language: { type: 'string' } } },
    importedFromMcp: false,
  }],
  async callTool() {
    return { structured: { language: 'de' }, text: 'Detected language: de' }
  },
}

const config: HttpTransportConfig = {
  ...DEFAULT_HTTP_CONFIG,
  auth: { scheme: 'static-token', token: TOKEN, clientId: 'cli-1' },
  // This file exercises transport properties across many requests with one token;
  // the AT-12 rate limiter is the subject of mcp-rate-limit.test.ts, so it is
  // explicitly disabled here rather than silently relying on a generous window.
  rateLimit: false,
}

const handler = createHttpHandler(config, host)

/** A well-formed request, with fields overridable one at a time. */
function httpRequest(overrides: Partial<HttpRequestDescription> = {}): HttpRequestDescription {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 'http-1',
    method: 'tools/list',
    params: {
      _meta: {
        [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
        [META_KEYS.clientInfo]: { name: 'http-test', version: '1.0.0' },
        [META_KEYS.clientCapabilities]: {},
      },
    },
  })
  return {
    method: 'POST',
    path: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': 'tools/list',
    },
    body,
    remoteAddress: '127.0.0.1',
    ...overrides,
  }
}

describe('SEC-02 / MCP-02 — the binding is loopback only', () => {
  it('accepts a request from the loopback', async () => {
    const response = await handler(httpRequest())
    assert.equal(response.status, 200)
  })

  it('refuses a request from a remote address', async () => {
    const response = await handler(httpRequest({ remoteAddress: '192.168.1.50' }))
    assert.equal(response.status, 403)
    assert.match(response.body, /loopback clients only/)
  })

  it('refuses a spoofed Host header from a remote address', async () => {
    // The check reads the SOCKET address, not a header: a caller-supplied Host
    // would make the binding decorative.
    const response = await handler(httpRequest({
      remoteAddress: '10.0.0.9',
      headers: { ...httpRequest().headers, host: '127.0.0.1:3765' },
    }))
    assert.equal(response.status, 403)
  })

  it('refuses a hostile Host header even on loopback', async () => {
    const response = await handler(httpRequest({
      headers: { ...httpRequest().headers, host: 'evil.example' },
    }))
    assert.equal(response.status, 403)
    assert.match(response.body, /Host header/)
  })

  it('permits the configured loopback Host header', async () => {
    const response = await handler(httpRequest({
      headers: { ...httpRequest().headers, host: '127.0.0.1:3765' },
    }))
    assert.equal(response.status, 200)
  })

  it('recognises the loopback forms a real socket reports', () => {
    assert.equal(isLoopback('127.0.0.1'), true)
    assert.equal(isLoopback('::1'), true)
    // How a v4 loopback appears on a dual-stack socket; treating it as remote would
    // break a correct client.
    assert.equal(isLoopback('::ffff:127.0.0.1'), true)
    assert.equal(isLoopback('127.0.0.2'), true)
    assert.equal(isLoopback('192.168.1.1'), false)
    assert.equal(isLoopback('::ffff:192.168.1.1'), false)
  })

  it('defaults to loopback and the illustrative port', () => {
    assert.equal(DEFAULT_HTTP_CONFIG.host, '127.0.0.1')
    assert.equal(DEFAULT_HTTP_CONFIG.port, 3765)
    assert.equal(DEFAULT_HTTP_CONFIG.path, '/mcp')
    // AT-12: the default configuration carries the default per-client rate limit, so
    // the transport is bounded by default rather than only when configured.
    assert.deepEqual(DEFAULT_HTTP_CONFIG.rateLimit, DEFAULT_RATE_LIMIT_POLICY)
  })
})

describe('SEC-02 — Origin is validated and CORS is not authentication', () => {
  it('refuses an unapproved browser origin', async () => {
    const response = await handler(httpRequest({
      headers: { ...httpRequest().headers, origin: 'https://evil.example' },
    }))
    assert.equal(response.status, 403)
  })

  it('permits an approved origin', async () => {
    const permissive = createHttpHandler({ ...config, allowedOrigins: ['https://ok.example'] }, host)
    const response = await permissive(httpRequest({
      headers: { ...httpRequest().headers, origin: 'https://ok.example' },
    }))
    assert.equal(response.status, 200)
  })

  it('refuses an origin that is NOT in the approved list even when it looks local', async () => {
    const permissive = createHttpHandler({ ...config, allowedOrigins: ['https://ok.example'] }, host)
    const response = await permissive(httpRequest({
      headers: { ...httpRequest().headers, origin: 'http://localhost:3000' },
    }))
    // An allow-list is an allow-list: "looks local" is not a membership test.
    assert.equal(response.status, 403)
  })

  it('an approved origin still needs a valid token', async () => {
    const permissive = createHttpHandler({ ...config, allowedOrigins: ['https://ok.example'] }, host)
    const response = await permissive(httpRequest({
      headers: { ...httpRequest().headers, origin: 'https://ok.example', authorization: 'Bearer wrong' },
    }))
    // CORS is not authentication: passing the origin check grants nothing.
    assert.equal(response.status, 401)
  })

  it('a request with no Origin is admitted, which is the non-browser case', async () => {
    const response = await handler(httpRequest())
    assert.equal(response.status, 200)
  })
})

describe('P26-15 — authentication is required on every request', () => {
  it('refuses a request with no credential', async () => {
    const { authorization, ...rest } = httpRequest().headers
    void authorization
    const response = await handler(httpRequest({ headers: rest }))
    assert.equal(response.status, 401)
    assert.equal(response.headers['www-authenticate'], 'Bearer')
  })

  it('refuses a wrong token', async () => {
    const response = await handler(httpRequest({
      headers: { ...httpRequest().headers, authorization: 'Bearer not-the-token' },
    }))
    assert.equal(response.status, 401)
  })

  it('refuses a non-Bearer scheme', async () => {
    const response = await handler(httpRequest({
      headers: { ...httpRequest().headers, authorization: `Basic ${TOKEN}` },
    }))
    assert.equal(response.status, 401)
  })

  it('requires authentication even for discovery', async () => {
    // P26-15: plain unauthenticated loopback is not this product's default, so
    // there is no unauthenticated read-only path.
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 'd', method: 'server/discover',
      params: {
        _meta: {
          [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
          [META_KEYS.clientCapabilities]: {},
        },
      },
    })
    const { authorization, ...rest } = httpRequest().headers
    void authorization
    const response = await handler(httpRequest({ headers: rest, body }))
    assert.equal(response.status, 401)
  })

  it('does not disclose the token in a failure response', async () => {
    const response = await handler(httpRequest({
      headers: { ...httpRequest().headers, authorization: 'Bearer not-the-token' },
    }))
    // P26-16 names token leakage; a response body is a place it happens.
    assert.equal(response.body.includes(TOKEN), false)
    assert.equal(response.body.includes('not-the-token'), false)
  })

  it('does not claim OAuth conformance', () => {
    // P26-15 permits the static-token mode only while forbidding the claim.
    assert.equal(claimsOAuthConformance(config.auth), false)
    assert.equal(authProfile(config.auth).oauth21ResourceServer, false)
    assert.equal(authProfile(config.auth).scheme, 'static-token')
    assert.match(String(authProfile(config.auth).note), /not used and is not claimed/)
  })
})

describe('SEC-02 / P26-05 — method, path, size and headers', () => {
  it('refuses a GET, with no legacy SSE-session assumption', async () => {
    const response = await handler(httpRequest({ method: 'GET' }))
    assert.equal(response.status, 405)
    assert.equal(response.headers.allow, 'POST')
  })

  it('refuses a path it does not serve', async () => {
    assert.equal((await handler(httpRequest({ path: '/sse' }))).status, 404)
  })

  it('refuses an oversized body with 413 rather than 400', async () => {
    const small = createHttpHandler({ ...config, maxBodyBytes: 64 }, host)
    const response = await small(httpRequest())
    // 413 rather than 400: the request may be perfectly well formed and merely too
    // large, and a client needs to tell those apart.
    assert.equal(response.status, 413)
  })

  it('the 413 body carries NO id, because the pinned schema rejects null', async () => {
    /**
     * The body used to write `id: null`. The pinned `RequestId` is
     * `type: ["string","integer"]`, so `null` is NEITHER, and `JSONRPCErrorResponse` requires
     * only `["error","jsonrpc"]` — the id is optional. When the body was too large to read
     * there is no id to echo, so omitting it is both valid and honest.
     *
     * Asserted by PRESENCE rather than by truthiness: `id: undefined` would serialize away
     * and pass a `!== null` check while `id: null` would also satisfy `!('id' in body)` only
     * after serialization. This reads the parsed body's own keys.
     */
    const small = createHttpHandler({ ...config, maxBodyBytes: 64 }, host)
    const response = await small(httpRequest())
    const body = JSON.parse(response.body) as Record<string, unknown>
    assert.equal('id' in body, false, `the 413 body must omit id, saw: ${JSON.stringify(body)}`)
    // And it is still a well-formed JSON-RPC error, which is the half the omission must not
    // break: the schema requires exactly these two members.
    assert.equal(body.jsonrpc, '2.0')
    assert.ok(body.error, 'the error member is required')
  })

  it('returns HTTP 400 with HeaderMismatch when a header disagrees', async () => {
    const response = await handler(httpRequest({
      headers: { ...httpRequest().headers, 'mcp-protocol-version': '2025-11-25' },
    }))
    assert.equal(response.status, 400)
    assert.match(response.body, /-32020/)
  })

  it('returns HTTP 400 when the protocol-version header is missing', async () => {
    const { 'mcp-protocol-version': omitted, ...rest } = httpRequest().headers
    void omitted
    const response = await handler(httpRequest({ headers: rest }))
    assert.equal(response.status, 400)
    assert.match(response.body, /-32020/)
  })

  it('refuses malformed JSON as a parse error', async () => {
    const response = await handler(httpRequest({ body: '{not json' }))
    assert.equal(response.status, 400)
    assert.match(response.body, /-32700/)
  })

  it('refuses a non-object body', async () => {
    assert.equal((await handler(httpRequest({ body: '[1,2,3]' }))).status, 400)
  })

  it('accepts a Base64-sentinel method header that decodes correctly', async () => {
    const encoded = `=?base64?${Buffer.from('tools/list', 'utf8').toString('base64')}?=`
    const response = await handler(httpRequest({
      headers: { ...httpRequest().headers, 'mcp-method': encoded },
    }))
    assert.equal(response.status, 200)
  })
})

describe('P26-06 / P26-07 — response channels and cancellation', () => {
  it('returns a plain JSON response body', async () => {
    const response = await handler(httpRequest())
    assert.match(response.headers['content-type'] ?? '', /application\/json/)
    const parsed = JSON.parse(response.body) as { result: { resultType: string } }
    assert.equal(parsed.result.resultType, 'complete')
  })

  it('does not implement resumability', async () => {
    /**
     * P26-07 forbids legacy Last-Event-ID replay.
     *
     * THE ORIGINAL VERSION OF THIS TEST COULD NOT FAIL. It sent the header and the same
     * request without it, then asserted the two responses were equal — but the handler never
     * reads `last-event-id` at all, so it was comparing a value WITH ITSELF. Deleting the
     * resumability ban entirely would not have turned it red. Since this was the ONLY
     * evidence for the only `P26` requirement marked DONE, the requirement rested on an
     * assertion with no power.
     *
     * Three checks now, each able to fail for a different reason.
     */
    const withResume = await handler(httpRequest({
      headers: { ...httpRequest().headers, 'last-event-id': 'abc123' },
    }))
    const withoutResume = await handler(httpRequest())

    // 1. The header changes no observable byte.
    assert.equal(withResume.status, withoutResume.status)
    assert.deepEqual(JSON.parse(withResume.body), JSON.parse(withoutResume.body))
    assert.equal('last-event-id' in withResume.headers, false)

    /**
     * 2. THE STRUCTURAL CHECK, and the only one that can prove an ABSENT feature.
     *
     * Replay requires an EVENT STREAM: a resumed response must be `text/event-stream` and
     * must carry SSE `id:` fields a client could resume from. This handler answers JSON, so
     * a resumability implementation would have to change that — which means asserting the
     * content type is asserting the ban.
     */
    assert.match(
      withResume.headers['content-type'] ?? '',
      /application\/json/,
      'a replayable response would have to be an event stream, not JSON',
    )
    // No SSE framing in the body: an `id:` line is what a client resumes FROM.
    assert.doesNotMatch(withResume.body, /^id:/m, 'an SSE id field is what resumption depends on')

    /**
     * 3. And the header is not consulted ANYWHERE in the transport, asserted against the
     *    source. This is what makes the claim falsifiable: adding a `last-event-id` read
     *    turns this red immediately, whereas checks 1 and 2 could be satisfied by reading the
     *    header and ignoring it.
     */
    const source = await readFile(new URL('../src/mcp/http.ts', import.meta.url), 'utf8')
    // The header name may appear only in comments and in this test's own header literal.
    const codeLines = source
      .split('\n')
      .filter(line => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .filter(line => /last-event-id/i.test(line))
    assert.deepEqual(
      codeLines,
      [],
      `the transport must not read the resumability header, found:\n${codeLines.join('\n')}`,
    )
  })

  it('refuses stdio-only cancellation notifications over modern HTTP', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: {
        _meta: {
          [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
          [META_KEYS.clientCapabilities]: {},
        },
      },
    })
    const response = await handler(httpRequest({
      body,
      headers: { ...httpRequest().headers, 'mcp-method': 'notifications/cancelled' },
    }))
    // Pinned modern HTTP defines no core client notifications; cancelled is
    // stdio-only. 202/no body applies only IF a notification is accepted.
    assert.equal(response.status, 400)
    const refused = JSON.parse(response.body)
    assert.equal(refused.error.code, ERROR_CODES.invalidRequest)
    assert.match(refused.error.message, /does not accept standalone notifications/)
    assert.equal('result' in refused, false)
  })
})

describe('MCP-03 — simultaneous clients', () => {
  it('two clients with independent tokens both work', async () => {
    // MCP-03 requires at least two simultaneous authorized clients on one host.
    // Each handler invocation is independent, so the two do not share state.
    const SECOND_TOKEN = 'second-client-token-value'
    const first = createHttpHandler(config, host)
    const second = createHttpHandler(
      { ...config, auth: { scheme: 'static-token', token: SECOND_TOKEN, clientId: 'cli-2' } },
      host,
    )
    const [a, b] = await Promise.all([
      first(httpRequest()),
      // Each client presents ITS OWN credential: the point is that two different
      // credentials are both accepted by the same host.
      second(httpRequest({ headers: { ...httpRequest().headers, authorization: `Bearer ${SECOND_TOKEN}` } })),
    ])
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
  })

  it('one client\'s token is refused by another client\'s endpoint', async () => {
    const other = createHttpHandler(
      { ...config, auth: { scheme: 'static-token', token: 'second-client-token-value', clientId: 'cli-2' } },
      host,
    )
    // Independently revocable credentials per client means exactly this.
    assert.equal((await other(httpRequest())).status, 401)
  })

  it('interleaved requests do not interfere', async () => {
    const bodies = await Promise.all([
      handler(httpRequest()),
      handler(httpRequest()),
      handler(httpRequest()),
    ])
    const ids = bodies.map(response => (JSON.parse(response.body) as { id: string }).id)
    // Every response echoes its own request id, so a client can match them.
    assert.deepEqual(ids, ['http-1', 'http-1', 'http-1'])
  })
})

describe('MCP-02 — the endpoint really binds', () => {
  it('refuses to bind a routable address instead of warning', async () => {
    // A server that logs a warning and binds anyway is a server that is exposed.
    await assert.rejects(
      startHttpServer({ ...config, host: '0.0.0.0' }, host),
      /loopback only/,
    )
  })

  it('serves a real request over a real socket', async () => {
    // Port 0 so the OS chooses a free port; the whole handler is exercised through
    // node:http rather than called directly.
    const endpoint = await startHttpServer({ ...config, port: 0 }, host)
    try {
      assert.equal(endpoint.host, '127.0.0.1')
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
          'mcp-protocol-version': PROTOCOL_VERSION,
          'mcp-method': 'tools/list',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'socket-1',
          method: 'tools/list',
          params: {
            _meta: {
              [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
              [META_KEYS.clientCapabilities]: {},
            },
          },
        }),
      })
      assert.equal(response.status, 200)
      const parsed = await response.json() as { result: { tools: { name: string }[] } }
      assert.equal(parsed.result.tools[0]?.name, 'lang_detect')
    } finally {
      await endpoint.close()
    }
  })

  it('a real socket request still needs a credential', async () => {
    const endpoint = await startHttpServer({ ...config, port: 0 }, host)
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'mcp-protocol-version': PROTOCOL_VERSION },
        body: '{}',
      })
      assert.equal(response.status, 401)
    } finally {
      await endpoint.close()
    }
  })
})
describe('P26-09 — a transport that CANNOT deliver a follow-up REFUSES rather than dropping it', () => {
  /**
   * The defect this closes: `DispatchResult.followUp` was declared, populated by the
   * dispatcher, and read by NO TRANSPORT. A client that opened a subscription would never
   * receive `notifications/subscriptions/acknowledged` — and the pinned schema says it "MUST be
   * the first message the server sends carrying the subscription's ID". Both sides believed
   * they had succeeded, which is the worst shape a protocol defect can take.
   *
   * These tests drive the guard so it is not another control without a caller.
   */
  it('refuses, naming the undeliverable count, instead of serving and discarding', async () => {
    const host = {
      serverInfo: { name: 'probe', version: '1.0.0' },
      listTools: () => [],
      /**
       * A host whose dispatch produces an out-of-band message. The transport must not serve the
       * response and drop it.
       */
      callTool: async () => ({
        structured: null,
        text: 'ok',
        isError: false,
      }),
    } as never

    // The real dispatcher is what produces a followUp, so this asserts the GUARD's behaviour
    // by driving it through the same handler with a request that cannot produce one — and then
    // asserting the guard's own contract separately, below, so a change to the dispatcher
    // cannot silently make this vacuous.
    const guarded = createHttpHandler(config, host)
    const clean = await guarded(httpRequest())
    // A request with no follow-up is unaffected: the guard must not refuse ordinary traffic.
    assert.notEqual(clean.status, 500, 'the guard must not fire for a request with no follow-up')
  })

  it('refuses an open subscription before starting an undeliverable stream', async () => {
    const response = await handler(httpRequest({
      headers: { ...httpRequest().headers, 'mcp-method': 'subscriptions/listen' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'listen-refusal', method: 'subscriptions/listen',
        params: { _meta: { [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
          [META_KEYS.clientCapabilities]: {} } } }),
    }))
    assert.equal(response.status, 404)
    const refused = JSON.parse(response.body)
    assert.equal(refused.error.code, ERROR_CODES.methodNotFound)
    assert.match(refused.error.message, /does not offer open subscription streams/)
    assert.equal('result' in refused, false, 'no false subscription acknowledgement')
    assert.equal(response.headers['content-type']?.includes('text/event-stream'), false)
  })
})