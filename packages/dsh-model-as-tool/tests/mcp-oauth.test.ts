/**
 * P26-15 / P26-16 — the OAuth 2.1 resource-server profile over the embedded
 * local authorization server.
 *
 * What this pins, which the static-token tests cannot: HS256 credential
 * verification, issuer/audience/expiry/scope validation, RFC 6750 challenges,
 * per-client independent revocation, and the discovery metadata endpoints.
 * The signing/verification primitives are Node's own WebCrypto — no token
 * cryptography is invented here, which is the boundary P26-15 draws.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { createLocalOAuthServer, oauthChallenge, challengeErrorCode } from '../src/mcp/oauth.ts'
import {
  authProfile,
  claimsOAuthConformance,
  createHttpHandler,
  type HttpAuth,
} from '../src/mcp/http.ts'
import { META_KEYS, PROTOCOL_VERSION } from '../src/mcp/protocol.ts'

after(() => {})

const ISSUER = 'https://tool-mode.local'
const AUDIENCE = 'tool-mode-mcp'

/** A well-formed JSON-RPC request against the test endpoint. */
function oauthRequest(overrides: Partial<{
  method: string
  path: string
  authorization: string
  headers: Record<string, string>
}> = {}): Parameters<ReturnType<typeof createHttpHandler>>[0] {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 'oauth-1',
    method: 'tools/list',
    params: {
      _meta: {
        [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
        [META_KEYS.clientInfo]: { name: 'oauth-test', version: '1.0.0' },
        [META_KEYS.clientCapabilities]: {},
      },
    },
  })
  return {
    method: overrides.method ?? 'POST',
    path: overrides.path ?? '/mcp',
    remoteAddress: '127.0.0.1',
    body,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': 'tools/list',
      ...overrides.authorization === undefined ? {} : { authorization: overrides.authorization },
      ...overrides.headers ?? {},
    },
  }
}

function makeServer() {
  return createLocalOAuthServer({ issuer: ISSUER, audience: AUDIENCE, tokenLifetimeSeconds: 900 })
}

describe('P26-15 — the embedded local authorization server', () => {
  it('issues a credential that verifies with its client identity and scope', async () => {
    const server = makeServer()
    server.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:read', 'mcp:call'] })
    const token = await server.issueAccessToken('alpha')
    const verdict = await server.verify(token, ['mcp:call'])
    assert.equal(verdict.ok, true)
    if (!verdict.ok) return
    assert.equal(verdict.token.clientId, 'alpha')
    assert.deepEqual(verdict.token.scope, ['mcp:read', 'mcp:call'])
    assert.equal(verdict.token.audience, AUDIENCE)
    assert.ok(verdict.token.jti.length > 0)
  })

  it('refuses a token from an unknown client', async () => {
    const server = makeServer()
    const other = makeServer()
    other.upsertClient({ clientId: 'intruder', secret: 'intruder-secret', scope: ['mcp:call'] })
    const token = await other.issueAccessToken('intruder')
    const verdict = await server.verify(token)
    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    assert.equal(verdict.error.code, 'invalid_token')
    assert.match(verdict.error.description, /unknown client/)
  })

  it('refuses a token whose signature does not verify (tampered payload)', async () => {
    const server = makeServer()
    server.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:call'] })
    const token = await server.issueAccessToken('alpha')
    const [header, , signature] = token.split('.')
    // Rewrite the payload to claim a wider scope, keeping the old signature.
    const forged = Buffer.from(JSON.stringify({
      iss: ISSUER, sub: 'alpha', aud: AUDIENCE, scope: 'admin:everything', iat: 1, exp: 9999999999,
    })).toString('base64url')
    const verdict = await server.verify(`${header}.${forged}.${signature}`)
    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    assert.equal(verdict.error.code, 'invalid_token')
    assert.match(verdict.error.description, /signature/)
  })

  it('refuses a token issued for a DIFFERENT audience', async () => {
    const server = makeServer()
    server.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:call'] })
    const wrongAudience = createLocalOAuthServer({ issuer: ISSUER, audience: 'some-other-resource' })
    wrongAudience.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:call'] })
    const token = await wrongAudience.issueAccessToken('alpha')
    const verdict = await server.verify(token)
    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    assert.equal(verdict.error.code, 'invalid_token')
    assert.match(verdict.error.description, /audience/)
  })

  it('refuses a token from a DIFFERENT issuer', async () => {
    const server = makeServer()
    server.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:call'] })
    const otherIssuer = createLocalOAuthServer({ issuer: 'https://evil.local', audience: AUDIENCE })
    otherIssuer.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:call'] })
    const token = await otherIssuer.issueAccessToken('alpha')
    const verdict = await server.verify(token)
    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    assert.equal(verdict.error.code, 'invalid_token')
    assert.match(verdict.error.description, /different authorization server/)
  })

  it('refuses an expired token', async () => {
    const server = createLocalOAuthServer({ issuer: ISSUER, audience: AUDIENCE, tokenLifetimeSeconds: -60 })
    server.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:call'] })
    const token = await server.issueAccessToken('alpha')
    const verdict = await server.verify(token)
    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    assert.equal(verdict.error.code, 'invalid_token')
    assert.match(verdict.error.description, /expired/)
  })

  it('refuses insufficient scope and names the required scope in the challenge', async () => {
    const server = makeServer()
    server.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:read'] })
    const token = await server.issueAccessToken('alpha')
    const verdict = await server.verify(token, ['mcp:call'])
    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    assert.equal(verdict.error.code, 'insufficient_scope')
    const challenge = oauthChallenge(verdict.error)
    assert.match(challenge, /insufficient_scope/)
    assert.match(challenge, /scope="mcp:call"/)
    assert.equal(challengeErrorCode(challenge), 'insufficient_scope')
  })

  it('revokes ONE client independently: its tokens fail, a peer client keeps working', async () => {
    const server = makeServer()
    server.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:call'] })
    server.upsertClient({ clientId: 'beta', secret: 'beta-secret', scope: ['mcp:call'] })
    const alphaToken = await server.issueAccessToken('alpha')
    const betaToken = await server.issueAccessToken('beta')

    server.revokeClient('alpha')
    const revokedAlpha = await server.verify(alphaToken)
    assert.equal(revokedAlpha.ok, false)
    if (revokedAlpha.ok) return
    assert.equal(revokedAlpha.error.code, 'invalid_token')
    assert.match(revokedAlpha.error.description, /revoked/)

    const stillValidBeta = await server.verify(betaToken)
    assert.equal(stillValidBeta.ok, true, 'a peer client must be untouched by another client\'s revocation')
  })

  it('publishes RFC 8414/9728 discovery metadata', async () => {
    const server = makeServer()
    server.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:call'] })
    const asMetadata = server.authorizationServerMetadata()
    assert.equal(asMetadata.issuer, ISSUER)
    // F3: no token_endpoint is advertised, because none is served — an RFC 8414
    // document must not point a client at an endpoint that does not exist.
    assert.equal(asMetadata.token_endpoint, undefined)
    assert.ok(Array.isArray(asMetadata.grant_types_supported))
    const prMetadata = server.protectedResourceMetadata()
    assert.equal(prMetadata.resource, AUDIENCE)
    assert.deepEqual(prMetadata.authorization_servers, [ISSUER])
    assert.ok((prMetadata.scopes_supported as string[]).includes('mcp:call'))
  })

  it('refuses a self-minted scope beyond the client\'s registered grant (F1)', async () => {
    const server = makeServer()
    // The client is registered for mcp:read only.
    server.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:read'] })
    // With symmetric keys the client can sign its own token; it crafts one
    // claiming a scope the registry never granted.
    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({
      iss: ISSUER, sub: 'alpha', aud: AUDIENCE, scope: 'mcp:call admin:everything',
      iat: now, exp: now + 600,
    })).toString('base64url')
    const key = await crypto.subtle.importKey(
      'raw', new Uint8Array([...createHash('sha256').update('alpha-secret').digest()]),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    )
    const signature = Buffer.from(await crypto.subtle.sign(
      'HMAC', key, new TextEncoder().encode(`${header}.${payload}`),
    )).toString('base64url')
    const verdict = await server.verify(`${header}.${payload}.${signature}`, ['mcp:read'])
    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    assert.equal(verdict.error.code, 'invalid_token')
    assert.match(verdict.error.description, /beyond this client's grant/)
  })

  it('refuses a scope name that is not an RFC 6749 scope-token', () => {
    const server = makeServer()
    assert.throws(
      () => server.upsertClient({ clientId: 'alpha', secret: 's', scope: ['mcp read with space'] }),
      /not an RFC 6749 scope-token/,
    )
  })
})

describe('P26-15 — the HTTP endpoint under the OAuth scheme', () => {
  const oauthAuth = (server: ReturnType<typeof makeServer>): HttpAuth =>
    ({ scheme: 'oauth-resource-server', server, requiredScope: ['mcp:call'] })

  const oauthHandler = (auth: HttpAuth) => createHttpHandler({
    path: '/mcp',
    host: '127.0.0.1',
    port: 0,
    maxBodyBytes: 1024 * 1024,
    allowedOrigins: [],
    auth,
    // This file exercises authentication and scope semantics; the AT-12 rate limiter
    // is the subject of mcp-rate-limit.test.ts.
    rateLimit: false,
  }, { serverInfo: { name: 'oauth-test', version: '1' }, listTools: () => [], callTool: async () => ({ isError: false as const, value: {} }) })

  it('serves the metadata endpoints unauthenticated', async () => {
    const server = makeServer()
    server.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:call'] })
    const handler = oauthHandler(oauthAuth(server))
    const pr = await handler(oauthRequest({ method: 'GET', path: '/.well-known/oauth-protected-resource' }))
    assert.equal(pr.status, 200)
    const as = await handler(oauthRequest({ method: 'GET', path: '/.well-known/oauth-authorization-server' }))
    assert.equal(as.status, 200)
  })

  it('answers a valid credential with dispatch, and reports the OAuth profile', async () => {
    const server = makeServer()
    server.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:call'] })
    const auth = oauthAuth(server)
    const handler = oauthHandler(auth)
    const token = await server.issueAccessToken('alpha')

    assert.equal(claimsOAuthConformance(auth), true)
    assert.equal(authProfile(auth).oauth21ResourceServer, true)
    assert.match(String(authProfile(auth).note), /OAuth 2\.1 resource-server profile/)

    const response = await handler(oauthRequest({ authorization: `Bearer ${token}` }))
    assert.equal(response.status, 200, response.body)
  })

  it('challenges an invalid credential with the RFC 6750 error code and the §3.1 STATUS', async () => {
    const server = makeServer()
    server.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:call'] })
    const handler = oauthHandler(oauthAuth(server))
    // A malformed credential is an invalid_request: RFC 6750 §3.1 assigns 400, so
    // the client knows the request itself is wrong rather than the credential
    // being merely stale (the F4 gap was one flat 401 for all three).
    const response = await handler(oauthRequest({ authorization: 'Bearer not.a.jwt' }))
    assert.equal(response.status, 400)
    const challenge = response.headers['www-authenticate'] as string
    assert.match(challenge, /^Bearer /)
    assert.equal(challengeErrorCode(challenge), 'invalid_request')
  })

  it('challenges an insufficient scope with the required scope named and the §3.1 STATUS', async () => {
    const server = makeServer()
    server.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:read'] })
    const handler = oauthHandler(oauthAuth(server))
    const token = await server.issueAccessToken('alpha')
    const response = await handler(oauthRequest({ authorization: `Bearer ${token}` }))
    // insufficient_scope is 403, not 401: the credential is fine, the grant is
    // too small, and a client told 401 would re-authenticate pointlessly.
    assert.equal(response.status, 403)
    const challenge = response.headers['www-authenticate'] as string
    assert.equal(challengeErrorCode(challenge), 'insufficient_scope')
    assert.match(challenge, /scope="mcp:call"/)
  })

  it('refuses a revoked credential at the HTTP layer', async () => {
    const server = makeServer()
    server.upsertClient({ clientId: 'alpha', secret: 'alpha-secret', scope: ['mcp:call'] })
    const handler = oauthHandler(oauthAuth(server))
    const token = await server.issueAccessToken('alpha')
    server.revokeClient('alpha')
    const response = await handler(oauthRequest({ authorization: `Bearer ${token}` }))
    assert.equal(response.status, 401)
    assert.equal(challengeErrorCode(response.headers['www-authenticate'] as string), 'invalid_token')
  })
})
