/**
 * The MCP 2026-07-28 wire core.
 *
 * The published `@modelcontextprotocol/sdk` (1.32.1) declares
 * `LATEST_PROTOCOL_VERSION = 2025-11-25` and does not list `2026-07-28` among its
 * supported revisions, so this is the "separately reviewed, schema-conformant
 * adaptation" MCP-01 permits where SDK support is incomplete. It is written
 * against the revision's own requirements rather than by changing a version string
 * on legacy behaviour, which MCP-01 explicitly says does not satisfy the
 * requirement.
 *
 * What makes this revision different, and what this module exists to enforce:
 *
 * - **No handshake.** `tools/list` and `tools/call` must work as the FIRST
 *   application request. There is no `initialize`, no
 *   `notifications/initialized`, no prior discovery call and no `Mcp-Session-Id`
 *   (P26-01). So there is no session state here to get wrong.
 * - **Per-request metadata.** Version and capabilities travel in `params._meta` on
 *   EVERY request, and are never inferred from an earlier one (P26-02). That is
 *   why `_meta` is parsed per request and not cached.
 * - **Server identity in results.** Every result envelope carries `resultType`,
 *   and the revision's guidance puts `serverInfo` in result metadata.
 * - **Errors stay in their lanes** (P26-04): a malformed protocol request is a
 *   JSON-RPC error, while an application tool failure is a tool-error RESULT. A
 *   failure wrapped as a successful payload is the specific mistake this prevents.
 *
 * @module @try-works/dsh-model-as-tool/mcp/protocol
 */

/** The revision this server speaks. */
export const PROTOCOL_VERSION = '2026-07-28'

/**
 * Revisions this server can also serve.
 *
 * Kept explicit and short. P26-03 requires an unsupported version to be answered
 * with the supported list, so the list must be a fact rather than a guess.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [PROTOCOL_VERSION]

/** The `_meta` keys the revision defines. */
export const META_KEYS = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
} as const

/**
 * Error codes.
 *
 * The reserved range belongs to the protocol. P26-03 is explicit that custom
 * errors must not be allocated there, so this module declares only codes the
 * revision defines and refuses to mint new ones in that band.
 */
export const ERROR_CODES = {
  /** Standard JSON-RPC. */
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** MCP-reserved. */
  headerMismatch: -32020,
  unsupportedClientCapability: -32021,
  unsupportedProtocolVersion: -32022,
} as const

/** The convention for a tool that ran and returned a domain failure (P26-04). */
export interface ToolErrorPayload {
  /** Always true: an application failure, not a protocol failure. */
  readonly isError: true
  /** A bounded, model-readable explanation. */
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
}

/** A JSON-RPC request as this server receives it. */
export interface WireRequest {
  readonly jsonrpc: '2.0'
  readonly id?: string | number | null
  readonly method: string
  readonly params?: Record<string, unknown>
}

/** Per-request metadata, parsed fresh on every request (P26-02). */
export interface RequestMetadata {
  readonly protocolVersion: string
  readonly clientInfo: { readonly name: string; readonly version: string }
  readonly clientCapabilities: Readonly<Record<string, unknown>>
}

/** Raised for a request that must be answered with a JSON-RPC error. */
export class WireError extends Error {
  override readonly name = 'WireError'
  readonly code: number
  /** Structured detail, as the revision's schema defines for the code. */
  readonly data?: Record<string, unknown>

  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(message)
    this.code = code
    if (data !== undefined) this.data = data
  }
}

/** Whether a numeric code lies in the range reserved for the protocol. */
export function isReservedErrorCode(code: number): boolean {
  // JSON-RPC's own band plus MCP's -32000..-32099 allocation.
  return (code >= -32768 && code <= -32000)
}

/**
 * Parse `params._meta` from a request (P26-02).
 *
 * Missing required metadata is `invalid params`, not a defaulted value: inferring
 * a version or a capability from a preceding request is exactly what P26-02
 * forbids, and defaulting is inference with extra steps.
 *
 * The REQUIRED set is taken from the pinned revision schema's `RequestMetaObject`,
 * which requires `clientCapabilities` and `protocolVersion` — and NOT `clientInfo`.
 * Requiring `clientInfo` here would reject a request the schema admits, which is a
 * conformance failure in the opposite direction from accepting too much.
 *
 * @param params - the request parameters.
 * @returns the parsed metadata.
 * @throws WireError `-32602` when a required key is absent or malformed.
 */
export function parseRequestMetadata(params: Record<string, unknown> | undefined): RequestMetadata {
  const meta = params?._meta
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new WireError(
      ERROR_CODES.invalidParams,
      'params._meta is required on every modern request and must be an object',
    )
  }
  const record = meta as Record<string, unknown>
  const protocolVersion = record[META_KEYS.protocolVersion]
  if (typeof protocolVersion !== 'string' || protocolVersion.length === 0) {
    throw new WireError(
      ERROR_CODES.invalidParams,
      `params._meta["${META_KEYS.protocolVersion}"] is required and must be a string`,
    )
  }
  const capabilities = record[META_KEYS.clientCapabilities]
  if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) {
    throw new WireError(
      ERROR_CODES.invalidParams,
      `params._meta["${META_KEYS.clientCapabilities}"] is required and must be an object`,
    )
  }
  // Optional in the schema, so absent is admitted; present-but-malformed is not,
  // because a client that sends half an Implementation has sent a broken one.
  const clientInfo = record[META_KEYS.clientInfo]
  let info: { name: string; version: string } = { name: 'unknown', version: 'unknown' }
  if (clientInfo !== undefined) {
    if (typeof clientInfo !== 'object' || clientInfo === null) {
      throw new WireError(
        ERROR_CODES.invalidParams,
        `params._meta["${META_KEYS.clientInfo}"], when present, must be an object`,
      )
    }
    const candidate = clientInfo as Record<string, unknown>
    if (typeof candidate.name !== 'string' || typeof candidate.version !== 'string') {
      throw new WireError(ERROR_CODES.invalidParams, 'clientInfo needs a name and a version')
    }
    info = { name: candidate.name, version: candidate.version }
  }
  return {
    protocolVersion,
    // Self-reported and therefore for DIAGNOSTICS only: P26-02 is explicit that
    // clientInfo is not authentication, so nothing here is ever used to authorize.
    clientInfo: info,
    clientCapabilities: capabilities as Record<string, unknown>,
  }
}

/**
 * Negotiate the protocol version for one request (P26-03).
 *
 * @param metadata - the request metadata.
 * @returns the negotiated version.
 * @throws WireError `-32022` carrying the official `supported` and `requested` data.
 */
export function negotiateVersion(metadata: RequestMetadata): string {
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(metadata.protocolVersion)) {
    throw new WireError(
      ERROR_CODES.unsupportedProtocolVersion,
      `unsupported protocol version ${metadata.protocolVersion}`,
      // The revision defines this data shape; a bare message would leave the client
      // unable to choose a version it can speak.
      { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: metadata.protocolVersion },
    )
  }
  return metadata.protocolVersion
}

/** A feature this server advertises, and whether it is implemented. */
export interface FeatureDeclaration {
  readonly feature: string
  readonly implemented: boolean
}

/**
 * The advertised-feature matrix (P26-12).
 *
 * P26-12 forbids advertising Tasks, sampling, resource subscriptions, prompts or
 * UI extensions merely because an SDK exports their types. Declaring the matrix as
 * data — with `implemented: false` where that is the truth — means the server
 * cannot advertise a feature it does not have by accident.
 */
export const ADVERTISED_FEATURES: readonly FeatureDeclaration[] = [
  { feature: 'tools', implemented: true },
  { feature: 'server/discover', implemented: true },
  // Now implemented, for TOOL-catalog changes only. P26-12 forbids advertising a
  // feature that is not implemented, and permits advertising one that is: the
  // acknowledgement reports the supported subset, so the narrower reality is stated
  // on the wire rather than implied here.
  { feature: 'subscriptions/listen', implemented: true },
  { feature: 'tasks', implemented: false },
  { feature: 'sampling', implemented: false },
  { feature: 'elicitation', implemented: false },
  { feature: 'roots', implemented: false },
  { feature: 'prompts', implemented: false },
  { feature: 'resources/subscribe', implemented: false },
  { feature: 'logging', implemented: false },
]

/**
 * The capabilities object this server may advertise.
 *
 * Derived from {@link ADVERTISED_FEATURES} rather than written twice, so the
 * matrix and the advertised capabilities cannot disagree.
 * @returns the capability names that are genuinely implemented.
 */
export function implementedCapabilities(): string[] {
  return ADVERTISED_FEATURES.filter(entry => entry.implemented).map(entry => entry.feature)
}

/**
 * Whether a client's REQUIRED capability is one this server supports (P26-03).
 *
 * @param required - capability names the client declared as required.
 * @returns the unsupported names, empty when all are supported.
 */
export function unsupportedRequiredCapabilities(required: readonly string[]): string[] {
  const implemented = new Set(implementedCapabilities())
  // `tools` is the only capability a client can require of this server today; any
  // other requirement cannot be met, and P26-03 wants that answered with -32021
  // rather than attempted.
  return required.filter(name => !implemented.has(name))
}

/**
 * The caching fields every cacheable result must carry (P26-14).
 *
 * Taken from the pinned schema's `CacheableResult`, which REQUIRES `cacheScope` and
 * `ttlMs` on `DiscoverResult` and `ListToolsResult` alike. Tool Mode's
 * authorization-filtered catalogs are private, so the default TTL is zero and the
 * scope is private — a shared cache keyed on tool names would leak one caller's
 * permitted set to another.
 * @returns the caching fields.
 */
export function cacheableResultFields(): { readonly cacheScope: string; readonly ttlMs: number } {
  return { cacheScope: 'private', ttlMs: 0 }
}

/**
 * Build a successful result envelope (P26-04).
 *
 * Every modern result carries `resultType`, and `serverInfo` rides in result
 * metadata per the revision's guidance — `ResultMetaObject` admits exactly that
 * one key, which is what this writes.
 * @param result - the method-specific fields.
 * @param serverInfo - this server's identity.
 * @returns the result object, including `resultType` and `_meta`.
 */
export function successResult(
  result: Record<string, unknown>,
  serverInfo: { readonly name: string; readonly version: string },
): Record<string, unknown> {
  // The metadata is MERGED rather than replaced. A method-specific result may carry
  // its own `_meta` members that the revision requires —
  // `SubscriptionsListenResult` must contain
  // `io.modelcontextprotocol/subscriptionId` — and overwriting the object dropped
  // it, sending a result with a required field missing. A subscription test caught
  // this; the pinned schema would have caught it too, and did not only because the
  // fixture corpus has no subscription case yet.
  const existing = typeof result._meta === 'object' && result._meta !== null
    ? result._meta as Record<string, unknown>
    : {}
  return {
    ...result,
    resultType: 'complete',
    _meta: {
      ...existing,
      [META_KEYS.serverInfo]: { name: serverInfo.name, version: serverInfo.version },
    },
  }
}

/**
 * Build a tool-error RESULT (P26-04).
 *
 * The distinction this preserves is the whole point: an application failure is a
 * successful protocol exchange carrying `isError`, while a malformed request is a
 * JSON-RPC error. Wrapping a domain failure as protocol success, or an
 * infrastructure failure as a successful domain payload, are both forbidden.
 * @param message - a bounded, model-readable explanation.
 * @returns the tool-error result.
 */
export function toolErrorResult(message: string): ToolErrorPayload {
  return {
    // Truncated because a stack trace or an unbounded message would be neither
    // model-readable nor safe to return.
    isError: true,
    content: [{ type: 'text', text: message.length > 2000 ? `${message.slice(0, 2000)}…` : message }],
  }
}

/**
 * Build a JSON-RPC error response.
 *
 * When the request id is UNKNOWN the `id` member is omitted rather than set to
 * `null`. JSON-RPC 2.0 conventionally allows `id: null` for an undeterminable id,
 * but the pinned revision schema types `RequestId` as `string | integer` and does
 * not admit null — while `id` itself is optional. Omitting it is therefore the
 * conformant way to say "unknown", and the independent probe caught this by
 * rejecting a captured 401 whose id was null.
 *
 * @param id - the request id, or null when it could not be determined.
 * @param error - the failure.
 * @returns the response envelope.
 */
export function errorResponse(
  id: string | number | null,
  error: WireError | { code: number; message: string; data?: Record<string, unknown> },
): Record<string, unknown> {
  const data = 'data' in error ? error.data : undefined
  return {
    jsonrpc: '2.0',
    ...id === null ? {} : { id },
    error: {
      code: error.code,
      message: error.message,
      ...data === undefined ? {} : { data },
    },
  }
}

/** A parsed HTTP request's relevant fields. */
export interface HeaderInput {
  /** The `MCP-Protocol-Version` header, if present. */
  readonly protocolVersion?: string
  /** The `Mcp-Method` header, if present. */
  readonly method?: string
  /** The `Mcp-Name` header, if present. */
  readonly name?: string
}

/**
 * Decode the revision's Base64 sentinel encoding (P26-05).
 *
 * A header value may be encoded with the official `=?base64?…?=` sentinel, and it
 * must be decoded BEFORE comparison. Comparing the encoded form would let a client
 * present a value that decodes to something else entirely.
 * @param value - the raw header value.
 * @returns the decoded value.
 */
export function decodeHeaderValue(value: string): string {
  const match = /^=\?base64\?(.*)\?=$/s.exec(value)
  if (match === null) return value
  try {
    return Buffer.from(match[1] as string, 'base64').toString('utf8')
  } catch {
    // A malformed sentinel is left as-is so the comparison against the body fails
    // and reports a mismatch, rather than being silently accepted as something.
    return value
  }
}

/**
 * Check the required headers against the body (P26-05).
 *
 * Headers are checked against BODY FIELDS, so a request cannot claim one method in
 * a header and another in its body. Every mismatch is `HeaderMismatch` (-32020),
 * which the HTTP layer reports as 400.
 * @param headers - the relevant request headers.
 * @param body - the parsed request.
 * @returns nothing when the headers agree.
 * @throws WireError `-32020` naming the first disagreement.
 */
export function assertHeadersMatch(headers: HeaderInput, body: WireRequest): void {
  const fail = (detail: string): never => {
    throw new WireError(ERROR_CODES.headerMismatch, detail)
  }
  const version = headers.protocolVersion === undefined ? undefined : decodeHeaderValue(headers.protocolVersion)
  if (version === undefined) {
    return fail('the MCP-Protocol-Version header is required')
  }
  const bodyVersion = (body.params?._meta as Record<string, unknown> | undefined)?.[META_KEYS.protocolVersion]
  if (typeof bodyVersion === 'string' && version !== bodyVersion) {
    return fail(`the MCP-Protocol-Version header (${version}) does not match the request body (${bodyVersion})`)
  }
  const method = headers.method === undefined ? undefined : decodeHeaderValue(headers.method)
  if (method !== undefined && method !== body.method) {
    return fail(`the Mcp-Method header (${method}) does not match the request method (${body.method})`)
  }
  // `Mcp-Name` is required only for a named call. Requiring it universally would
  // reject a correct `tools/list`, which has no name.
  if (body.method === 'tools/call') {
    const name = headers.name === undefined ? undefined : decodeHeaderValue(headers.name)
    if (name === undefined) return fail('the Mcp-Name header is required for tools/call')
    const bodyName = body.params?.name
    if (typeof bodyName === 'string' && name !== bodyName) {
      return fail(`the Mcp-Name header (${name}) does not match the request name (${bodyName})`)
    }
  }
}

/**
 * Parse a newline-delimited stdio frame (P26-08).
 *
 * Stdio carries protocol traffic on stdout and diagnostics on stderr, so a line
 * that is not a JSON object is a protocol error rather than something to log and
 * skip: silently dropping it would leave a client waiting for a response that
 * never comes.
 * @param line - one line of input.
 * @returns the parsed request, or undefined for a blank line.
 * @throws WireError `-32700` when the line is not a JSON object.
 */
export function parseStdioLine(line: string): WireRequest | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new WireError(ERROR_CODES.parseError, 'the frame is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WireError(ERROR_CODES.invalidRequest, 'the frame is not a JSON-RPC object')
  }
  const request = parsed as WireRequest
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    throw new WireError(ERROR_CODES.invalidRequest, 'the frame is not a JSON-RPC 2.0 request')
  }
  return request
}

/**
 * Serialize one stdio frame.
 * @param message - the response or notification.
 * @returns the line, newline-terminated.
 */
export function serializeStdioFrame(message: unknown): string {
  // A newline inside the JSON would produce two frames and desynchronise the
  // stream, so the compact form is used and embedded newlines are escaped by
  // JSON.stringify itself.
  return `${JSON.stringify(message)}\n`
}
