/**
 * The loopback HTTP transport (MCP-02, MCP-03, SEC-02, P26-05..P26-08, P26-15).
 *
 * `P26-15` is decisive about the shape of this: *"Plain unauthenticated loopback is
 * not this product's default."* So the endpoint requires a credential, and because
 * the OAuth 2.1 resource-server profile is NOT implemented, the credential is
 * offered explicitly as **custom static-token authentication** and makes no OAuth
 * conformance claim. The requirement permits that mode while forbidding the claim;
 * implementing half of OAuth and calling it OAuth would be the failure it names.
 *
 * The handler is a pure function of a request description rather than a socket
 * listener. Every security property here — the loopback check, Host and Origin
 * validation, size limits, authentication — is then testable without binding a
 * port, which matters because these are exactly the paths a socket-based test
 * would leave to manual checking.
 *
 * @module @try-works/dsh-model-as-tool/mcp/http
 */

import { timingSafeEqual } from 'node:crypto'
import { toWebRequest } from '@modelcontextprotocol/node'
import type { ServerResponse } from 'node:http'
import type { ExternalCaller } from './client-grant.ts'
import {
  assertHeadersMatch,
  decodeHeaderValue,
  ERROR_CODES,
  errorResponse,
  negotiateVersion,
  parseRequestMetadata,
  unsupportedRequiredCapabilities,
  WireError,
  type HeaderInput,
} from './protocol.ts'
import type { McpHost } from './server.ts'
import { serveSdkV2Request } from './sdk-v2.ts'
import type { WireRequest } from './protocol.ts'
import { oauthChallenge, oauthErrorStatus, type LocalOAuthServer } from './oauth.ts'
import {
  createRateLimiter,
  DEFAULT_RATE_LIMIT_POLICY,
  type RateLimitPolicy,
} from './rate-limit.ts'
import { resolveClientGrant, type ClientGrantConfig } from './client-grant.ts'

/** How the endpoint authenticates. */
export interface StaticTokenAuth {
  /**
   * The scheme this endpoint implements.
   *
   * Named `static-token` rather than `oauth` so nothing downstream can mistake it
   * for the OAuth profile, and so a log or a status report that prints this value
   * cannot imply a conformance that was never tested.
   */
  readonly scheme: 'static-token'
  /** The accepted token, compared in constant time. */
  readonly token: string
  /** The caller identity recorded for the grant, for receipts and audit. */
  readonly clientId: string
  /**
   * The durable credential store holding GENERATED static-token credentials (SEC-01).
   *
   * When present, a presented bearer token is also checked against the stored
   * credentials (constant-time over the whole registry), and the matched client's
   * OWN identity drives grants, receipts and rate limiting — never the configured
   * primary `clientId`. Absent keeps the single-token behavior.
   */
  readonly registry?: import('./credential-store.ts').ClientCredentialStore
}

/** The OAuth 2.1 resource-server scheme (P26-15). */
export interface OAuthResourceServerAuth {
  /**
   * The scheme this endpoint implements: the local embedded authorization server
   * issues HS256 credentials and this endpoint verifies them per RFC 6750, with
   * audience and scope validation and per-client revocation.
   */
  readonly scheme: 'oauth-resource-server'
  /** The embedded server: verifier, issuer and revocation registry. */
  readonly server: LocalOAuthServer
  /** The scope a caller must hold to reach the MCP endpoint. */
  readonly requiredScope?: readonly string[]
}

/** The union of supported authentication schemes. */
export type HttpAuth = StaticTokenAuth | OAuthResourceServerAuth

/** Transport configuration. */
export interface HttpTransportConfig {
  /** Path the endpoint serves. */
  readonly path: string
  /** Bind address; only a loopback address is admitted. */
  readonly host: string
  /** Port. */
  readonly port: number
  /** Maximum request body size in bytes (SEC-02). */
  readonly maxBodyBytes: number
  /**
   * Origins permitted to call from a browser.
   *
   * Empty by default, which refuses every browser origin. SEC-02 requires
   * unapproved origins to be REJECTED, so an empty list is a working configuration
   * rather than a missing one, and CORS is not used as authentication anywhere.
   */
  readonly allowedOrigins: readonly string[]
  readonly auth: HttpAuth
  /**
   * Per-client request rate limiting (AT-12).
   *
   * Absent means the DEFAULT policy applies — 60 requests per client per minute — so
   * the transport is bounded by default rather than only when someone remembers to ask.
   * A policy overrides the default; `false` disables limiting explicitly. The count is
   * keyed on the AUTHENTICATED client identity (the static-token `clientId` or the OAuth
   * subject), never on the socket address, and an unauthenticated request never moves a
   * counter — counting auth failures would leak credential existence through 429 timing.
   */
  readonly rateLimit?: RateLimitPolicy | false
  /**
   * Per-client external grants (SEC-04).
   *
   * After authentication, each client's grant is DERIVED here — from this
   * configuration, the authenticated identity and the live published surface — and
   * travels with the call as caller identity. Absent means the default: every client
   * is granted exactly the live surface, recorded under its own `external:<clientId>`
   * grant identity. A request body can never supply or extend a grant (BASE-05).
   */
  readonly grants?: ClientGrantConfig
}

/** A conservative default: loopback, the illustrative port, a small body cap,
 * and the default per-client rate limit (AT-12). */
export const DEFAULT_HTTP_CONFIG: Omit<HttpTransportConfig, 'auth'> = {
  path: '/mcp',
  host: '127.0.0.1',
  port: 3765,
  maxBodyBytes: 4 * 1024 * 1024,
  allowedOrigins: [],
  rateLimit: DEFAULT_RATE_LIMIT_POLICY,
}

/** One HTTP request, described rather than received. */
export interface HttpRequestDescription {
  readonly method: string
  /** The request path, without query. */
  readonly path: string
  /** Lower-cased header names to values. */
  readonly headers: Readonly<Record<string, string | undefined>>
  /** The raw body. */
  readonly body: string
  /** The peer address, as the socket reports it. */
  readonly remoteAddress: string
}

/** One HTTP response. */
export interface HttpResponseDescription {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** Whether an address is loopback. */
export function isLoopback(address: string): boolean {
  // `::ffff:127.0.0.1` is how a v4 loopback appears on a dual-stack socket, and
  // `::1` is v6 loopback. Treating either as remote would break a correct client;
  // treating a real remote address as loopback would defeat the binding.
  const normalised = address.startsWith('::ffff:') ? address.slice(7) : address
  return normalised === '127.0.0.1' || normalised === '::1' || normalised.startsWith('127.')
}

/** Render a response. */
function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponseDescription {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }
}

/**
 * Compare a presented token against the accepted one in constant time.
 *
 * Length is compared first because `timingSafeEqual` throws on a length mismatch;
 * that leaks length, which is not a useful secret here since the token is generated
 * by the operator rather than guessed byte by byte.
 * @param presented - the token from the request.
 * @param accepted - the configured token.
 * @returns whether they match.
 */
function tokenMatches(presented: string, accepted: string): boolean {
  const left = Buffer.from(presented, 'utf8')
  const right = Buffer.from(accepted, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Validate the Host header when the client supplies one. */
function hostHeaderAllowed(header: string | undefined, config: HttpTransportConfig): boolean {
  if (header === undefined || header.length === 0) return true
  const value = header.toLowerCase()
  const authority = value.startsWith('[')
    ? value.slice(1, value.indexOf(']'))
    : (value.split(':')[0] ?? '')
  const configured = config.host.toLowerCase()
  const allowed = new Set([configured])
  if (isLoopback(configured)) {
    allowed.add('localhost')
    allowed.add('127.0.0.1')
    allowed.add('::1')
  }
  return allowed.has(authority)
}

/**
 * Build the request handler.
 *
 * Ordering is deliberate and matches P26-16's list: transport identity (loopback,
 * size, method, path) is settled before authentication, and authentication before
 * any protocol parsing. A request that is not from the loopback is refused without
 * its token being examined at all.
 * @param config - the transport configuration.
 * @param host - the MCP surface.
 * @returns the handler.
 */
interface AcceptedRequest {
  readonly caller: ExternalCaller
  readonly token: string
  readonly headers: Headers
}

function createRequestGate(
  config: HttpTransportConfig,
  host: McpHost,
): (request: HttpRequestDescription) => Promise<AcceptedRequest | HttpResponseDescription> {
  /**
   * THE LIMITER IS PER-HANDLER STATE, in memory and unpersisted (AT-12).
   *
   * One limiter per bound endpoint, keyed by the authenticated client identity.
   * Absent configuration means the DEFAULT policy applies, so the endpoint is
   * bounded even when the operator configured nothing; `false` disables it; a
   * policy overrides it. Construction validates the policy, so a broken
   * configuration fails when the transport starts rather than mid-request.
   */
  const effectivePolicy = config.rateLimit === false
    ? DEFAULT_RATE_LIMIT_POLICY
    : (config.rateLimit ?? DEFAULT_RATE_LIMIT_POLICY)
  const limiter = config.rateLimit === false
    ? undefined
    : createRateLimiter(effectivePolicy)

  return async (request: HttpRequestDescription): Promise<AcceptedRequest | HttpResponseDescription> => {
    // 0. DISCOVERY METADATA (RFC 8414/9728), when the OAuth scheme serves it.
    // Metadata endpoints are the ONE thing served unauthenticated: a client must
    // learn the issuer, audience and token endpoint BEFORE it can hold a token.
    if (config.auth.scheme === 'oauth-resource-server') {
      if (request.method === 'GET' && request.path === '/.well-known/oauth-protected-resource') {
        return respond(200, config.auth.server.protectedResourceMetadata())
      }
      if (request.method === 'GET' && request.path === '/.well-known/oauth-authorization-server') {
        return respond(200, config.auth.server.authorizationServerMetadata())
      }
    }

    // 1. Loopback only (MCP-02, SEC-02). Checked against the SOCKET address, not a
    // header: a header is caller-supplied, and trusting one would make the binding
    // decorative.
    if (!isLoopback(request.remoteAddress)) {
      return respond(403, { error: 'this endpoint serves loopback clients only' })
    }
    if (!hostHeaderAllowed(request.headers.host, config)) {
      return respond(403, { error: 'the Host header is not approved for this endpoint' })
    }

    // 2. Size limit (SEC-02), measured on the received bytes.
    const bodyBytes = Buffer.byteLength(request.body, 'utf8')
    if (bodyBytes > config.maxBodyBytes) {
      // 413 rather than 400: the request may be perfectly well formed and merely
      // too large, and a client needs to tell those apart.
      /**
       * NO `id` — the pinned schema neither permits nor requires one here.
       *
       * This wrote `id: null`, which `RequestId` (`type: ["string","integer"]`) REJECTS:
       * `null` is not a string and not an integer. `JSONRPCErrorResponse` requires only
       * `["error","jsonrpc"]`, so the id is optional — and when the body was too large to
       * read there is no id to echo anyway. Omitting it is both valid and honest.
       */
      return respond(413, {
        jsonrpc: '2.0',
        error: { code: ERROR_CODES.invalidRequest, message: `the request body exceeds ${config.maxBodyBytes} bytes` },
      })
    }

    // 3. Method and path. No legacy GET/SSE-session assumptions (P26-05).
    if (request.method !== 'POST') {
      return respond(405, errorResponse(null, {
        code: ERROR_CODES.invalidRequest,
        message: 'this endpoint accepts POST only',
      }), { allow: 'POST' })
    }
    if (request.path !== config.path) {
      return respond(404, { error: `no endpoint at ${request.path}` })
    }

    // 4. Origin (SEC-02). An unapproved browser origin is refused, and CORS is
    // never treated as authentication: passing this check grants nothing.
    const origin = request.headers.origin
    if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
      return respond(403, { error: 'this origin is not approved for the endpoint' })
    }

    // 5. Authentication (P26-15). Applied to EVERY request including discovery,
    // because an unauthenticated endpoint is not this product's default.
    const presented = bearerOf(request.headers.authorization)
    if (presented === undefined) {
      return respond(401, errorResponse(null, {
        code: ERROR_CODES.invalidRequest,
        message: 'authentication is required',
      }), { 'www-authenticate': 'Bearer' })
    }
    /** The AUTHENTICATED client identity, resolved once and used for rate limiting. */
    let clientId: string
    if (config.auth.scheme === 'static-token') {
      let matched: string | undefined
      if (tokenMatches(presented, config.auth.token)) matched = config.auth.clientId
      // SEC-01: a GENERATED static-token credential authenticates through the
      // durable store, carrying its OWN client identity into grants and receipts.
      if (matched === undefined && config.auth.registry !== undefined) {
        matched = config.auth.registry.bySecret(presented)?.clientId
      }
      if (matched === undefined) {
        // The message does not distinguish "unknown" from "expired": with a static
        // token there is nothing to expire, and a more specific message would only
        // help an attacker.
        return respond(401, errorResponse(null, {
          code: ERROR_CODES.invalidRequest,
          message: 'the presented credential is not accepted',
        }), { 'www-authenticate': 'Bearer' })
      }
      clientId = matched
    } else {
      const verdict = await config.auth.server.verify(presented, config.auth.requiredScope)
      if (!verdict.ok) {
        // An RFC 6750 challenge names WHY: invalid_token vs insufficient_scope are
        // different client instructions, and flattening them would misdirect a
        // client that could otherwise self-correct. The STATUS follows §3.1 the
        // same way: invalid_request 400, invalid_token 401, insufficient_scope
        // 403 (the F4 gap was one flat 401 for all three).
        return respond(oauthErrorStatus(verdict.error), errorResponse(null, {
          code: ERROR_CODES.invalidRequest,
          message: verdict.error.description,
        }), { 'www-authenticate': oauthChallenge(verdict.error) })
      }
      clientId = verdict.token.clientId
    }

    /**
     * 5.5. Per-client rate limiting (AT-12), AFTER authentication and BEFORE the
     * body is examined.
     *
     * A refused request is answered here without parsing, so a rate-limited caller
     * cannot make the transport pay body-processing cost per attempt, and the
     * counter is keyed on the identity the transport just proved — never the
     * remote address, which every loopback client shares. Unauthenticated and
     * malformed-credential requests were already refused at step 5 WITHOUT moving
     * a counter: counting them would turn the limiter into an authentication
     * oracle, where a 429 after N attempts tells a caller whether a credential
     * exists.
     *
     * The `id` is OMITTED, exactly as the oversize-body refusal omits it: the body
     * was never examined, so there is no id to echo, and the pinned `RequestId`
     * does not admit `null`. The envelope is still a conformant
     * `JSONRPCErrorResponse`, and `Retry-After` names when the window opens.
     */
    if (limiter !== undefined) {
      const decision = limiter.admit(clientId)
      if (!decision.admitted) {
        return respond(429, errorResponse(null, {
          code: ERROR_CODES.rateLimited,
          message: `rate limit exceeded: at most ${effectivePolicy.maxRequests} `
            + `requests per client per ${Math.round(effectivePolicy.windowMs / 1000)}s window (AT-12)`,
          data: { retryAfterMs: decision.retryAfterMs },
        }), { 'retry-after': String(Math.ceil(decision.retryAfterMs / 1000)) })
      }
    }

    /**
     * 5.5. The per-client external grant (SEC-04), DERIVED here because the
     * authentication verdict just happened: the grant is built from the verified
     * client identity, the operator's grant configuration and the LIVE published
     * surface — never from anything in the request body, which is what BASE-05
     * forbids. The derived identity travels with the dispatch as CALLER identity,
     * so the surface can authorize against the CLIENT's grant instead of the
     * host's own interactive grant.
     */
    const caller = resolveClientGrant(clientId, config.grants, host.listTools().map(tool => tool.name))

    // 6. Parse, then check headers against the body (P26-05).
    let parsed: unknown
    try {
      parsed = JSON.parse(request.body)
    } catch {
      return respond(400, errorResponse(null, { code: ERROR_CODES.parseError, message: 'the body is not valid JSON' }))
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return respond(400, errorResponse(null, { code: ERROR_CODES.invalidRequest, message: 'the body is not a JSON-RPC object' }))
    }
    const wire = parsed as WireRequest
    if (wire.jsonrpc !== '2.0' || typeof wire.method !== 'string'
      || (wire.id !== undefined && typeof wire.id !== 'string'
        && !(typeof wire.id === 'number' && Number.isInteger(wire.id)))) {
      return respond(400, errorResponse(null, {
        code: ERROR_CODES.invalidRequest, message: 'the body is not a JSON-RPC 2.0 request or notification',
      }))
    }

    // Built conditionally rather than with explicit `undefined` values, because
    // `exactOptionalPropertyTypes` distinguishes "absent" from "present and
    // undefined" — and so does the header check, which treats a missing header
    // differently from an empty one.
    const headerInput: HeaderInput = {
      ...request.headers['mcp-protocol-version'] === undefined
        ? {}
        : { protocolVersion: request.headers['mcp-protocol-version'] },
      ...request.headers['mcp-method'] === undefined ? {} : { method: request.headers['mcp-method'] },
      ...request.headers['mcp-name'] === undefined ? {} : { name: request.headers['mcp-name'] },
    }
    try {
      assertHeadersMatch(headerInput, wire)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // P26-05 names HTTP 400 and HeaderMismatch together.
      return respond(400, errorResponse(wire.id ?? null, { code: ERROR_CODES.headerMismatch, message }))
    }

    // Pinned metadata failures are transport rejections (HTTP 400), not SDK
    // dispatch errors under HTTP 200. Keep the shared wire validation, not a
    // second business dispatcher. Optional clientInfo remains optional.
    if (wire.id !== undefined && wire.method !== 'initialize') {
      try {
        const metadata = parseRequestMetadata(wire.params)
        negotiateVersion(metadata)
        const declared = metadata.clientCapabilities.required
        const required = Array.isArray(declared)
          ? declared.filter((name): name is string => typeof name === 'string') : []
        const unsupported = unsupportedRequiredCapabilities(required)
        if (unsupported.length > 0) {
          throw new WireError(ERROR_CODES.unsupportedClientCapability,
            `the client requires unsupported capability: ${unsupported.join(', ')}`,
            { requiredCapabilities: Object.fromEntries(unsupported.map(name => [name, {}])) })
        }
      } catch (error) {
        if (!(error instanceof WireError)) throw error
        return respond(400, errorResponse(wire.id, error))
      }
    }

    // 7. The OFFICIAL v2 server handles the protocol, not our handwritten dispatch.
    // This finite response-description interface cannot carry open subscriptions.
    // Refuse before creating a subscription rather than swallowing notifications.
    if (wire.id !== undefined && wire.method === 'subscriptions/listen') {
      return respond(404, errorResponse(wire.id ?? null, {
        code: ERROR_CODES.methodNotFound,
        message: 'this HTTP transport does not offer open subscription streams',
      }))
    }
    // Pinned Streamable HTTP defines NO client-to-server notifications;
    // notifications/cancelled is stdio-only. 202/no body is mandatory only IF a
    // notification is accepted. We implement no extension notification handlers,
    // so explicitly refuse rather than silently dropping unsupported messages.
    if (wire.id === undefined) {
      return respond(400, errorResponse(null, {
        code: ERROR_CODES.invalidRequest,
        message: 'this stateless endpoint does not accept standalone notifications',
      }))
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(name, value)
    }
    // Normalize sentinel values only AFTER shared validation. The pinned
    // transport requires Mcp-Method; do not synthesize a missing header here or
    // bypass assertHeadersMatch's required-header/mismatch rejection.
    if (headerInput.method !== undefined) headers.set('mcp-method', decodeHeaderValue(headerInput.method))
    if (headerInput.protocolVersion !== undefined) {
      headers.set('mcp-protocol-version', decodeHeaderValue(headerInput.protocolVersion))
    }
    // The SDK already decodes Mcp-Name correctly (including non-ASCII and
    // literal sentinels), so preserve its original wire encoding here.
    return { caller, token: presented, headers }
  }
}

/**
 * Shared, guarded Fetch/stream core. The Node adapter's toNodeHandler is NOT
 * used directly: its early 413 has a different wire envelope, it does not watch
 * IncomingMessage.aborted, and its close/drain listeners are not removed.
 * Use its official bounded Request conversion only AFTER our unchanged gate.
 */
export function createHttpStreamHandler(
  config: HttpTransportConfig,
  host: McpHost,
): (request: HttpRequestDescription, signal?: AbortSignal) => Promise<Response> {
  const gate = createRequestGate(config, host)
  return async (request, signal) => {
    const verdict = await gate(request)
    if ('status' in verdict) {
      return new Response(verdict.body, { status: verdict.status, headers: verdict.headers })
    }
    signal?.throwIfAborted()
    const webRequest = await toWebRequest({
      method: request.method,
      url: config.path,
      // Host was validated already; never let an untrusted authority affect URL
      // construction. Keep the actual normalized headers on the Request below.
      headers: { host: 'localhost' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(request.body, 'utf8') },
    }, undefined, {
      maxRequestBodySize: config.maxBodyBytes,
      ...signal === undefined ? {} : { signal },
    })
    return serveSdkV2Request(host, verdict.caller,
      new Request(webRequest, { headers: verdict.headers }), verdict.token)
  }
}

/** Finite, materializing test facade; production sockets use the stream core. */
export function createHttpHandler(
  config: HttpTransportConfig,
  host: McpHost,
): (request: HttpRequestDescription) => Promise<HttpResponseDescription> {
  const stream = createHttpStreamHandler(config, host)
  return async request => {
    const response = await stream(request)
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    }
  }
}

/** Extract a bearer token from an Authorization header. */
function bearerOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]
}

/**
 * Whether this transport may claim OAuth conformance.
 *
 * The static-token scheme may not; the oauth-resource-server scheme may, because
 * it verifies HS256 credentials, audience, expiry and scope against the embedded
 * server and answers RFC 6750 challenges — a conformant subset, not an invention.
 * The claim is per-DEPLOYMENT, which is what a status report needs: a host using
 * static tokens must still report false.
 * @param auth - the live auth configuration.
 * @returns whether the live scheme may claim the OAuth 2.1 resource-server profile.
 */
export function claimsOAuthConformance(auth: HttpAuth): boolean {
  return auth.scheme === 'oauth-resource-server'
}

/**
 * The authentication profile this transport reports.
 *
 * A machine-readable statement of what is actually implemented, so a client or an
 * operator can tell custom authentication from the OAuth profile without reading
 * the source.
 * @param auth - the live auth configuration.
 * @returns the auth profile description.
 */
export function authProfile(auth: HttpAuth): Record<string, unknown> {
  if (auth.scheme === 'static-token') {
    return {
      scheme: 'static-token',
      // Stated explicitly rather than left to inference.
      oauth21ResourceServer: false,
      perClientRevocable: true,
      note: 'Custom authentication. The OAuth 2.1 resource-server profile is not used and is not claimed.',
    }
  }
  return {
    scheme: 'oauth-resource-server',
    oauth21ResourceServer: true,
    perClientRevocable: true,
    issuer: auth.server.authorizationServerMetadata().issuer,
    audience: auth.server.protectedResourceMetadata().resource,
    note: 'OAuth 2.1 resource-server profile via the embedded local authorization server: '
      + 'HS256 credentials, RFC 6750 challenges, audience/expiry/scope validation, per-client revocation.',
  }
}

/** A bound endpoint. */
export interface BoundEndpoint {
  /** The address actually bound, which for port 0 is the one the OS chose. */
  readonly host: string
  readonly port: number
  /** The full URL clients should use. */
  readonly url: string
  /** Stop serving and release the port. */
  close(): Promise<void>
}

/** Wait for capacity without stranding a promise on a disconnected socket. */
function waitForDrain(outgoing: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      outgoing.off('drain', onDrain)
      outgoing.off('error', onError)
      outgoing.off('close', onAbort)
      signal.removeEventListener('abort', onAbort)
    }
    const onDrain = (): void => { cleanup(); resolve() }
    const onError = (error: Error): void => { cleanup(); reject(error) }
    const onAbort = (): void => { cleanup(); reject(signal.reason ?? new Error('HTTP response closed')) }
    outgoing.once('drain', onDrain)
    outgoing.once('error', onError)
    outgoing.once('close', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted || outgoing.destroyed) onAbort()
  })
}

/** Pump bytes, never text-materialize SSE, and cancel even a blocked read. */
async function writeStreamResponse(response: Response, outgoing: ServerResponse, signal: AbortSignal): Promise<void> {
  const reader = response.body?.getReader()
  const onAbort = (): void => { void reader?.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener('abort', onAbort, { once: true })
  let drained = false
  try {
    signal.throwIfAborted()
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    outgoing.flushHeaders()
    if (reader !== undefined) {
      while (true) {
        const next = await reader.read()
        signal.throwIfAborted()
        if (next.done) break
        if (!outgoing.write(next.value)) await waitForDrain(outgoing, signal)
      }
    }
    drained = true
    outgoing.end()
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (!drained) await reader?.cancel(signal.reason).catch(() => {})
    reader?.releaseLock()
  }
}

/**
 * Bind the endpoint on loopback.
 *
 * The bind address is validated rather than trusted: a configuration naming a
 * routable address is REFUSED at startup rather than silently exposing the endpoint,
 * because a server that logs a warning and binds anyway is a server that is exposed.
 * @param config - the transport configuration.
 * @param host - the MCP surface.
 * @param options - an optional pre-built server module, so a test can drive a fake.
 * @returns the bound endpoint.
 * @throws Error when the bind address is not loopback.
 */
export async function startHttpServer(
  config: HttpTransportConfig,
  host: McpHost,
): Promise<BoundEndpoint> {
  if (!isLoopback(config.host)) {
    // MCP-02 puts LAN and public binding out of scope; refusing at startup is the
    // only enforcement that cannot be forgotten later.
    throw new Error(
      `refusing to bind ${config.host}: this endpoint serves loopback only (MCP-02). `
      + 'A routable bind address would expose inference to the network.',
    )
  }
  const { createServer } = await import('node:http')
  const handler = createHttpStreamHandler(config, host)
  const active = new Set<AbortController>()

  const server = createServer((incoming, outgoing) => {
    const abort = new AbortController()
    active.add(abort)
    const onAborted = (): void => { abort.abort(new Error('HTTP client disconnected')) }
    const onClose = (): void => { if (!outgoing.writableFinished) onAborted() }
    const cleanup = (): void => {
      incoming.off('aborted', onAborted)
      incoming.off('error', onAborted)
      outgoing.off('close', onClose)
      outgoing.off('error', onAborted)
      active.delete(abort)
    }
    incoming.once('aborted', onAborted)
    incoming.once('error', onAborted)
    outgoing.once('close', onClose)
    outgoing.once('error', onAborted)
    const chunks: Buffer[] = []
    let received = 0
    let refused = false
    incoming.on('data', (chunk: Buffer) => {
      if (refused || abort.signal.aborted) return
      received += chunk.byteLength
      // Bound DURING receipt, and free already buffered chunks on refusal.
      if (received > config.maxBodyBytes) {
        refused = true
        chunks.length = 0
        outgoing.writeHead(413, { 'content-type': 'application/json', connection: 'close' })
        outgoing.end(JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: ERROR_CODES.invalidRequest,
            message: `the request body exceeds ${config.maxBodyBytes} bytes`,
          },
        }))
        cleanup()
        return
      }
      chunks.push(chunk)
    })
    incoming.once('end', () => {
      if (refused || abort.signal.aborted) { cleanup(); return }
      const body = Buffer.concat(chunks).toString('utf8')
      chunks.length = 0
      void (async () => {
        try {
          const response = await handler({
            method: incoming.method ?? 'POST',
            path: (incoming.url ?? '/').split('?')[0] as string,
            headers: incoming.headers as Record<string, string | undefined>,
            body,
            remoteAddress: incoming.socket.remoteAddress ?? '',
          }, abort.signal)
          await writeStreamResponse(response, outgoing, abort.signal)
        } catch (error) {
          if (abort.signal.aborted || outgoing.destroyed) return
          if (outgoing.headersSent) {
            // A partial SSE response cannot be replaced by a JSON error.
            outgoing.destroy(error instanceof Error ? error : new Error(String(error)))
          } else {
            outgoing.writeHead(500, { 'content-type': 'application/json' })
            outgoing.end(JSON.stringify({ error: error instanceof Error ? error.message : 'internal error' }))
          }
        } finally {
          cleanup()
        }
      })()
    })
    // No 'end' event is guaranteed on a truncated upload.
    incoming.once('close', () => { if (!incoming.complete) cleanup() })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Bound to the loopback interface specifically, not to all interfaces.
    server.listen(config.port, config.host, () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port
  return {
    host: config.host,
    port,
    url: `http://${config.host}:${port}${config.path}`,
    async close() {
      for (const abort of active) abort.abort(new Error('HTTP endpoint closed'))
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
        // server.close alone waits indefinitely for active/keep-alive sockets.
        server.closeAllConnections()
      })
    },
  }
}
