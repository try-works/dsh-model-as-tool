/**
 * Per-client MCP request rate limiting (AT-12), proved at both layers.
 *
 * AT-12's named gap was that ZERO rate limiting existed anywhere in the host: an
 * authenticated client could drive unbounded inference traffic and nothing counted it.
 * This file proves the counter that now exists:
 *
 * - unit: fixed-window semantics (exhaustion, boundary reset, deny-then-recover),
 *   per-client independence, configuration validation and the idle-eviction bound;
 * - HTTP: a valid-token client hits 429 after N requests with a JSON-RPC error body
 *   that CONFORMS TO THE PINNED SCHEMA (validated with the same Ajv2020 harness the
 *   live-schema suite uses), while a second client is unaffected;
 * - authentication failures never consume budget — counting them would turn the
 *   limiter into an auth oracle, where a 429 after N guesses leaks that a credential
 *   exists.
 *
 * Requirement links: AT-12, P26-03 (error codes), P26-15 (authentication).
 */

import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Ajv2020 from 'ajv/dist/2020.js'

import { createHttpHandler, type HttpRequestDescription } from '../src/mcp/http.ts'
import { DEFAULT_HTTP_CONFIG } from '../src/mcp/http.ts'
import { createLocalOAuthServer, type LocalOAuthServer } from '../src/mcp/oauth.ts'
import { ERROR_CODES, META_KEYS, PROTOCOL_VERSION } from '../src/mcp/protocol.ts'
import type { McpHost } from '../src/mcp/server.ts'
import {
  createRateLimiter,
  DEFAULT_RATE_LIMIT_POLICY,
  type RateLimitPolicy,
} from '../src/mcp/rate-limit.ts'

/** A fake surface that answers every tools/list call, so admission is observable. */
const host: McpHost = {
  serverInfo: { name: 'rate-limit-test', version: '1' },
  listTools: () => [],
  async callTool() {
    return { isError: false, value: {} }
  },
}

const SCHEMA_PATH = 'docs/tool-mode/specs/mcp-2026-07-28/schema.json'

/** The pinned-schema validator for the generic JSON-RPC error envelope. */
function pinnedEnvelopeValidator() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as { $defs?: Record<string, unknown> }
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
  ajv.addSchema(schema as object, 'pinned')
  return ajv.compile({ $ref: 'pinned#/$defs/JSONRPCErrorResponse' })
}

const CONFORMS = pinnedEnvelopeValidator()

/** Assert a body is a conformant JSON-RPC error envelope per the pinned schema. */
function assertEnvelope(body: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body)
  assert.ok(
    CONFORMS(parsed),
    `the 429 body must conform to the pinned JSONRPCErrorResponse:\n${JSON.stringify(CONFORMS.errors, null, 2)}`,
  )
  return parsed as Record<string, unknown>
}

/** A well-formed request description against a static-token handler. */
function staticRequest(token: string, body: string = listBody('rl-1')): HttpRequestDescription {
  return {
    method: 'POST',
    path: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': 'tools/list',
    },
    body,
    remoteAddress: '127.0.0.1',
  }
}

function listBody(id: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/list',
    params: {
      _meta: {
        [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
        [META_KEYS.clientInfo]: { name: 'rate-limit-test', version: '1.0.0' },
        [META_KEYS.clientCapabilities]: {},
      },
    },
  })
}

describe('AT-12 — the limiter counts fixed windows per client', () => {
  it('admits up to the limit, refuses beyond it, and names when the window opens', () => {
    let now = 0
    const limiter = createRateLimiter({ maxRequests: 2, windowMs: 1000, maxClients: 10 }, () => now)
    assert.deepEqual(limiter.admit('alpha'), { admitted: true })
    assert.deepEqual(limiter.admit('alpha'), { admitted: true })
    const refused = limiter.admit('alpha')
    assert.equal(refused.admitted, false)
    if (refused.admitted) return
    assert.equal(refused.retryAfterMs, 1000, 'the refusal must name the next window boundary')
    assert.equal(limiter.remaining('alpha'), 0)
  })

  it('resets at the window boundary, so a client is denied only for the window it exhausted', () => {
    let now = 0
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 1000, maxClients: 10 }, () => now)
    assert.deepEqual(limiter.admit('alpha'), { admitted: true })
    assert.equal(limiter.admit('alpha').admitted, false)
    // The clock crosses the boundary; the previous window's count must not follow it.
    now = 1000
    assert.deepEqual(limiter.admit('alpha'), { admitted: true })
    now = 1500
    const mid = limiter.admit('alpha')
    assert.equal(mid.admitted, false)
    if (!mid.admitted) assert.equal(mid.retryAfterMs, 500, 'from mid-window, retryAfter names the next boundary')
  })

  it('keeps clients independent: one client exhausting its window leaves a peer untouched', () => {
    const limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000, maxClients: 10 })
    limiter.admit('alpha')
    limiter.admit('alpha')
    assert.equal(limiter.admit('alpha').admitted, false)
    assert.deepEqual(limiter.admit('beta'), { admitted: true }, 'a second client has its own bucket')
    assert.deepEqual(limiter.admit('beta'), { admitted: true })
    assert.equal(limiter.admit('beta').admitted, false)
    assert.equal(limiter.remaining('alpha'), 0)
    assert.equal(limiter.remaining('beta'), 0)
    assert.equal(limiter.remaining('gamma'), 2, 'an unknown client starts with the full budget')
    assert.equal(limiter.trackedClients(), 2)
  })

  it('validates the policy at construction, so a broken config fails at startup', () => {
    const broken: RateLimitPolicy = { maxRequests: 0, windowMs: 60_000, maxClients: 10 }
    assert.throws(() => createRateLimiter(broken), /maxRequests must be a positive integer/)
    assert.throws(() => createRateLimiter({ ...broken, maxRequests: 1, windowMs: 0 }), /windowMs/)
    assert.throws(() => createRateLimiter({ ...broken, maxRequests: 1, maxClients: -1 }), /maxClients/)
    assert.throws(() => createRateLimiter({ maxRequests: 1.5, windowMs: 60_000, maxClients: 10 }), /positive integer/)
  })

  it('stays bounded: a new client at capacity evicts the longest-idle entry', () => {
    let now = 0
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000, maxClients: 2 }, () => now)
    limiter.admit('first')
    now = 100
    limiter.admit('second')
    // A third client arrives: the map is full, so the longest-idle entry goes.
    now = 200
    assert.deepEqual(limiter.admit('third'), { admitted: true })
    assert.equal(limiter.trackedClients(), 2, 'the map must stay bounded at maxClients')
    assert.equal(limiter.remaining('first'), 1, 'the evicted client starts a fresh bucket if it returns')
    assert.equal(limiter.remaining('second'), 0)
  })

  it('ships a default of 60 requests per minute per client', () => {
    assert.equal(DEFAULT_RATE_LIMIT_POLICY.maxRequests, 60)
    assert.equal(DEFAULT_RATE_LIMIT_POLICY.windowMs, 60_000)
    assert.equal(DEFAULT_RATE_LIMIT_POLICY.maxClients, 10_000)
  })
})

describe('AT-12 — the HTTP layer enforces the limit after authentication', () => {
  const TOKEN = 'rate-limit-token-a'

  function limitedHandler(policy: RateLimitPolicy) {
    return createHttpHandler({
      path: '/mcp',
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      allowedOrigins: [],
      auth: { scheme: 'static-token', token: TOKEN, clientId: 'client-a' },
      rateLimit: policy,
    }, host)
  }

  it('refuses the (N+1)th request with 429 and a pinned-schema JSON-RPC error body', async () => {
    const handler = limitedHandler({ maxRequests: 3, windowMs: 60_000, maxClients: 10 })
    for (let index = 0; index < 3; index += 1) {
      const ok = await handler(staticRequest(TOKEN, listBody(`ok-${index}`)))
      assert.equal(ok.status, 200, `request ${index + 1} must be admitted: ${ok.body}`)
    }
    const refused = await handler(staticRequest(TOKEN, listBody('refused')))
    assert.equal(refused.status, 429, `the 4th request must be refused: ${refused.body}`)
    const body = assertEnvelope(refused.body)
    const error = body.error as { code: number; message: string; data: { retryAfterMs: number } }
    assert.equal(error.code, ERROR_CODES.rateLimited, 'the refusal carries the documented implementation-defined code')
    assert.equal(error.code, -32001)
    assert.match(error.message, /rate limit exceeded/)
    assert.ok(error.data.retryAfterMs > 0 && error.data.retryAfterMs <= 60_000, 'retryAfterMs must name the window boundary')
    assert.equal(body.id, undefined, 'the body was never examined, so no id is echoed (the pinned RequestId does not admit null)')
    assert.ok(Number(refused.headers['retry-after']) > 0, 'a 429 carries Retry-After')
  })

  it('applies the DEFAULT policy when the configuration names none', async () => {
    const handler = createHttpHandler({
      ...DEFAULT_HTTP_CONFIG,
      port: 0,
      auth: { scheme: 'static-token', token: TOKEN, clientId: 'client-a' },
    }, host)
    for (let index = 0; index < DEFAULT_RATE_LIMIT_POLICY.maxRequests; index += 1) {
      const ok = await handler(staticRequest(TOKEN, listBody(`d-${index}`)))
      assert.equal(ok.status, 200)
    }
    const refused = await handler(staticRequest(TOKEN, listBody('default-refused')))
    assert.equal(refused.status, 429, 'the default config must enforce the default limit')
  })

  it('honours an explicit false, disabling the limit', async () => {
    const handler = createHttpHandler({
      ...DEFAULT_HTTP_CONFIG,
      port: 0,
      auth: { scheme: 'static-token', token: TOKEN, clientId: 'client-a' },
      rateLimit: false,
    }, host)
    for (let index = 0; index < DEFAULT_RATE_LIMIT_POLICY.maxRequests + 5; index += 1) {
      const ok = await handler(staticRequest(TOKEN, listBody(`off-${index}`)))
      assert.equal(ok.status, 200, `with rateLimit false, request ${index + 1} must be admitted`)
    }
  })

  it('never counts an authentication failure: the budget is untouched by rejected credentials', async () => {
    const handler = limitedHandler({ maxRequests: 2, windowMs: 60_000, maxClients: 10 })
    // A caller hammering wrong credentials gets 401s, and none of them move the counter.
    for (let index = 0; index < 5; index += 1) {
      const refused = await handler(staticRequest('wrong-token', listBody(`bad-${index}`)))
      assert.equal(refused.status, 401)
    }
    // The VALID client's first two requests are still admitted in full.
    assert.equal((await handler(staticRequest(TOKEN, listBody('ok-1')))).status, 200)
    assert.equal((await handler(staticRequest(TOKEN, listBody('ok-2')))).status, 200)
    assert.equal((await handler(staticRequest(TOKEN, listBody('ok-3')))).status, 429, 'only the third valid request exhausts the budget')
  })

  it('counts every AUTHENTICATED request, malformed bodies included, because the check precedes parsing', async () => {
    const handler = limitedHandler({ maxRequests: 3, windowMs: 60_000, maxClients: 10 })
    assert.equal((await handler(staticRequest(TOKEN, listBody('ok-1')))).status, 200)
    assert.equal((await handler(staticRequest(TOKEN, listBody('ok-2')))).status, 200)
    // A malformed body is refused at parsing — but it already consumed its admission.
    assert.equal((await handler(staticRequest(TOKEN, '{not json'))).status, 400)
    assert.equal(
      (await handler(staticRequest(TOKEN, listBody('ok-3')))).status,
      429,
      'the malformed request consumed budget: the limiter guards the endpoint, not only well-formed inference',
    )
  })
})

describe('AT-12 — per-client identity under the OAuth scheme', () => {
  const ISSUER = 'https://rate-limit.local'
  const AUDIENCE = 'rate-limit-mcp'

  function makeServer(): LocalOAuthServer {
    return createLocalOAuthServer({ issuer: ISSUER, audience: AUDIENCE, tokenLifetimeSeconds: 900 })
  }

  function oauthHandler(server: LocalOAuthServer) {
    return createHttpHandler({
      path: '/mcp',
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      allowedOrigins: [],
      auth: { scheme: 'oauth-resource-server', server, requiredScope: ['mcp:call'] },
      rateLimit: { maxRequests: 2, windowMs: 60_000, maxClients: 10 },
    }, host)
  }

  it('keys the bucket on the verified SUBJECT: one client\'s 429 leaves a peer unaffected', async () => {
    const server = makeServer()
    server.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:call'] })
    server.upsertClient({ clientId: 'beta', secret: 'beta-secret', scope: ['mcp:call'] })
    const alphaToken = await server.issueAccessToken('alpha')
    const betaToken = await server.issueAccessToken('beta')
    const handler = oauthHandler(server)

    assert.equal((await handler(staticRequest(alphaToken, listBody('a-1')))).status, 200)
    assert.equal((await handler(staticRequest(alphaToken, listBody('a-2')))).status, 200)
    assert.equal((await handler(staticRequest(alphaToken, listBody('a-3')))).status, 429, 'alpha exhausted its window')

    assert.equal((await handler(staticRequest(betaToken, listBody('b-1')))).status, 200, 'beta keeps its own bucket')
    assert.equal((await handler(staticRequest(betaToken, listBody('b-2')))).status, 200)
    assert.equal((await handler(staticRequest(betaToken, listBody('b-3')))).status, 429)
  })

  it('an invalid or insufficient-scope credential is refused without consuming any budget', async () => {
    const server = makeServer()
    server.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:call'] })
    server.upsertClient({ clientId: 'narrow', secret: 'narrow-secret', scope: ['mcp:read'] })
    const alphaToken = await server.issueAccessToken('alpha')
    const narrowToken = await server.issueAccessToken('narrow')
    const handler = oauthHandler(server)

    // Wrong token and wrong scope fail authentication FIRST and never reach the counter.
    // A forged token is an RFC 6750 `invalid_request` (400), so both failure shapes
    // matter: neither consumes a single unit of the valid client's budget.
    for (let index = 0; index < 4; index += 1) {
      assert.equal((await handler(staticRequest('forged-token', listBody(`f-${index}`)))).status, 400)
    }
    assert.equal((await handler(staticRequest(narrowToken, listBody('n-1')))).status, 403, 'insufficient scope is a 403, not a budget hit')

    // The valid client's full budget is intact.
    assert.equal((await handler(staticRequest(alphaToken, listBody('ok-1')))).status, 200)
    assert.equal((await handler(staticRequest(alphaToken, listBody('ok-2')))).status, 200)
    assert.equal((await handler(staticRequest(alphaToken, listBody('ok-3')))).status, 429, 'only valid requests consumed budget')
  })
})
