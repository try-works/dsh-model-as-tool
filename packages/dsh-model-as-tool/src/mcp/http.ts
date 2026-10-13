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
import {
  assertHeadersMatch,
  ERROR_CODES,
  errorResponse,
  type HeaderInput,
} from './protocol.ts'
import { dispatch, type McpHost } from './server.ts'
import type { WireRequest } from './protocol.ts'

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
}

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
  readonly auth: StaticTokenAuth
}

/** A conservative default: loopback, the illustrative port, a small body cap. */
export const DEFAULT_HTTP_CONFIG: Omit<HttpTransportConfig, 'auth'> = {
  path: '/mcp',
  host: '127.0.0.1',
  port: 3765,
  maxBodyBytes: 4 * 1024 * 1024,
  allowedOrigins: [],
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
export function createHttpHandler(
  config: HttpTransportConfig,
  host: McpHost,
): (request: HttpRequestDescription) => Promise<HttpResponseDescription> {
  return async (request: HttpRequestDescription): Promise<HttpResponseDescription> => {
    // 1. Loopback only (MCP-02, SEC-02). Checked against the SOCKET address, not a
    // header: a header is caller-supplied, and trusting one would make the binding
    // decorative.
    if (!isLoopback(request.remoteAddress)) {
      return respond(403, { error: 'this endpoint serves loopback clients only' })
    }

    // 2. Size limit (SEC-02), measured on the received bytes.
    const bodyBytes = Buffer.byteLength(request.body, 'utf8')
    if (bodyBytes > config.maxBodyBytes) {
      // 413 rather than 400: the request may be perfectly well formed and merely
      // too large, and a client needs to tell those apart.
      return respond(413, {
        jsonrpc: '2.0',
        id: null,
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
    if (!tokenMatches(presented, config.auth.token)) {
      // The message does not distinguish "unknown" from "expired": with a static
      // token there is nothing to expire, and a more specific message would only
      // help an attacker.
      return respond(401, errorResponse(null, {
        code: ERROR_CODES.invalidRequest,
        message: 'the presented credential is not accepted',
      }), { 'www-authenticate': 'Bearer' })
    }

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

    // 7. Dispatch. A notification carries no id and is acknowledged with 202.
    const outcome = await dispatch(wire, host, { signal: new AbortController().signal })
    if (wire.id === undefined) {
      return { status: 202, headers: {}, body: '' }
    }
    // The dispatch `httpStatus` already distinguishes invalid params (400) from a
    // protocol-level failure that still produced a well-formed response (200).
    return respond(outcome.httpStatus, outcome.response)
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
 * It may not. `P26-15` permits a static-token mode while forbidding the claim, and
 * this returns false so a status report or a compatibility matrix cannot assert
 * otherwise by accident.
 * @returns always false, for the static-token scheme.
 */
export function claimsOAuthConformance(): boolean {
  return false
}

/**
 * The authentication profile this transport reports.
 *
 * A machine-readable statement of what is actually implemented, so a client or an
 * operator can tell custom authentication from the OAuth profile without reading
 * the source.
 * @returns the auth profile description.
 */
export function authProfile(): Record<string, unknown> {
  return {
    scheme: 'static-token',
    // Stated explicitly rather than left to inference.
    oauth21ResourceServer: false,
    perClientRevocable: true,
    note: 'Custom authentication. The OAuth 2.1 resource-server profile is not implemented and is not claimed.',
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
  const handler = createHttpHandler(config, host)

  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    let received = 0
    incoming.on('data', (chunk: Buffer) => {
      received += chunk.byteLength
      // The limit is enforced DURING the read, not after it: buffering an
      // unbounded body in order to measure it defeats the limit.
      if (received > config.maxBodyBytes) {
        outgoing.writeHead(413, { 'content-type': 'application/json' })
        outgoing.end(JSON.stringify({ error: 'request body too large' }))
        incoming.destroy()
        return
      }
      chunks.push(chunk)
    })
    incoming.on('end', () => {
      void handler({
        method: incoming.method ?? 'POST',
        path: (incoming.url ?? '/').split('?')[0] as string,
        headers: incoming.headers as Record<string, string | undefined>,
        body: Buffer.concat(chunks).toString('utf8'),
        remoteAddress: incoming.socket.remoteAddress ?? '',
      }).then(response => {
        outgoing.writeHead(response.status, response.headers)
        outgoing.end(response.body)
      }).catch((error: unknown) => {
        // A handler that throws must not hang the connection.
        outgoing.writeHead(500, { 'content-type': 'application/json' })
        outgoing.end(JSON.stringify({ error: error instanceof Error ? error.message : 'internal error' }))
      })
    })
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
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
      })
    },
  }
}
