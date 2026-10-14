/**
 * The stdio bridge (MCP-03, P26-05, P26-06, P26-08).
 *
 * `P26-05` is explicit that the bridge IS AN HTTP CLIENT, not a second protocol
 * implementation: it must generate the modern per-request headers correctly and
 * talk to the same endpoint a network client uses. So there is no second
 * interpretation of the protocol here to drift out of step with the first.
 *
 * What P26-08 requires, and how each is met:
 *
 * - **Stdout is exclusively protocol traffic; diagnostics go to stderr.** The two
 *   sinks are separate parameters, so a diagnostic cannot reach stdout by being
 *   written to "the output" — there is no single output to confuse.
 * - **Request IDs and per-request metadata are preserved.** The body is forwarded
 *   verbatim; the bridge regenerates only the HEADERS, which is the one thing the
 *   transport requires it to derive.
 * - **One stdio process is not one conversation.** Nothing is retained between
 *   requests except in-flight cancellation state, which is keyed by request id and
 *   removed when the request settles.
 * - **EOF shuts down bridge-owned requests without killing the host.** Closing
 *   aborts what this bridge has in flight; the host is a separate process.
 * - **Cancellation is per request.** `notifications/cancelled` aborts exactly the
 *   referenced request, so cancelling one call cannot cancel another sharing the
 *   worker.
 *
 * @module @try-works/dsh-model-as-tool/mcp/stdio
 */

import { PROTOCOL_VERSION, type WireRequest } from './protocol.ts'

/** Where the bridge writes. Two sinks, deliberately not one. */
export interface BridgeIo {
  /** Protocol traffic. Newline-delimited JSON and nothing else. */
  protocol(line: string): void
  /** Diagnostics. Never protocol traffic. */
  diagnostic(line: string): void
}

/** How the bridge reaches the endpoint. */
export interface BridgeEndpoint {
  /** The URL to POST to. */
  readonly url: string
  /** The bearer token, from the operator's configuration and never from a client. */
  readonly token: string
  /**
   * The request function. Injected so a test can drive the bridge without a socket
   * and without a real host.
   */
  readonly fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
  ) => Promise<{ status: number; headers: Record<string, string>; body: string }>
}

/** A running bridge. */
export interface StdioBridge {
  /**
   * Handle one line of stdin.
   * @param line - the raw line, with or without its newline.
   * @returns the protocol line to emit, or undefined when none is due.
   */
  handleLine(line: string): Promise<string | undefined>
  /** Abort every request this bridge owns, as EOF does. */
  close(): void
  /** How many requests this bridge currently owns in flight. */
  readonly inFlight: number
}

/** Build the headers for one request (P26-05). */
export function headersFor(request: WireRequest, token: string): Record<string, string> {
  // The version comes from the BODY, not from a constant, so a request declaring an
  // unsupported version is refused by the endpoint's header check rather than being
  // silently relabelled by the bridge.
  const bodyVersion = (request.params?._meta as Record<string, unknown> | undefined)
    ?.['io.modelcontextprotocol/protocolVersion']
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'mcp-protocol-version': typeof bodyVersion === 'string' ? bodyVersion : PROTOCOL_VERSION,
    'mcp-method': request.method,
  }
  // `Mcp-Name` is required for a named call and must match the body, so it is
  // derived from the body rather than guessed.
  if (request.method === 'tools/call' && typeof request.params?.name === 'string') {
    headers['mcp-name'] = request.params.name
  }
  return headers
}

/**
 * Create a bridge to a running MCP endpoint.
 *
 * @param endpoint - the endpoint and its injected request function.
 * @param io - the protocol and diagnostic sinks.
 * @returns the bridge.
 */
export function createStdioBridge(endpoint: BridgeEndpoint, io: BridgeIo): StdioBridge {
  /** In-flight requests, keyed by request id, so cancellation is per request. */
  const inFlight = new Map<string, AbortController>()

  return {
    get inFlight(): number {
      return inFlight.size
    },

    async handleLine(line: string): Promise<string | undefined> {
      const trimmed = line.trim()
      // A blank line is a keep-alive, not a malformed frame: skipping it is correct
      // and reporting it would spam a diagnostic channel for no reason.
      if (trimmed.length === 0) return undefined

      let request: WireRequest
      try {
        request = JSON.parse(trimmed) as WireRequest
      } catch {
        // A malformed frame is answered on the PROTOCOL channel, because the client
        // is waiting for a response and a diagnostic would not reach it.
        /**
         * The `id` is OMITTED rather than set to `null`, which is the rule `protocol.ts`
         * documents three hundred lines away and this site contradicted.
         *
         * JSON-RPC 2.0 conventionally allows `id: null` for an undeterminable id, but the
         * pinned revision types `RequestId` as `string | integer` and does not admit null,
         * while `id` itself is OPTIONAL. A frame that failed to parse has no id to echo, so
         * omitting it is the conformant way to say "unknown".
         */
        return frame({
          jsonrpc: '2.0',
          error: { code: -32700, message: 'the frame is not valid JSON' },
        })
      }

      // P26-06: a cancellation names the request it cancels and nothing else.
      if (request.method === 'notifications/cancelled') {
        const target = request.params?.requestId
        const key = target === undefined ? undefined : String(target)
        if (key !== undefined) {
          const controller = inFlight.get(key)
          if (controller === undefined) {
            // Reported, not ignored: a cancellation for an unknown request usually
            // means the client and bridge disagree about what is in flight.
            io.diagnostic(`cancellation for unknown request ${key}`)
          } else {
            controller.abort(new Error('cancelled by the client'))
            inFlight.delete(key)
            io.diagnostic(`cancelled request ${key}`)
          }
        }
        // A notification is acknowledged with nothing at all.
        return undefined
      }

      const controller = new AbortController()
      const key = request.id === undefined || request.id === null ? undefined : String(request.id)
      if (key !== undefined) inFlight.set(key, controller)

      try {
        const response = await endpoint.fetch(endpoint.url, {
          method: 'POST',
          headers: headersFor(request, endpoint.token),
          // The body is forwarded VERBATIM: ids and per-request metadata survive
          // exactly, because the bridge regenerates only the headers.
          body: trimmed,
          signal: controller.signal,
        })
        if (response.status === 202 || response.body.length === 0) {
          // A notification has no response to forward.
          return undefined
        }
        if (response.status >= 400 && !looksLikeJsonRpc(response.body)) {
          // A transport-level failure has no JSON-RPC body to forward, so it is
          // reported as a diagnostic AND as a protocol error: a client waiting for a
          // response must not be left waiting because the failure was transport.
          io.diagnostic(`the endpoint returned HTTP ${response.status}`)
          return frame({
            jsonrpc: '2.0',
            id: request.id ?? null,
            error: { code: -32603, message: `the endpoint returned HTTP ${response.status}` },
          })
        }
        return frame(JSON.parse(response.body))
      } catch (error) {
        if (controller.signal.aborted) {
          // Cancellation is not a failure to report: the client asked for it.
          io.diagnostic(`request ${key ?? '(unknown)'} ended by cancellation`)
          return undefined
        }
        const message = error instanceof Error ? error.message : String(error)
        io.diagnostic(`the request to the endpoint failed: ${message}`)
        return frame({
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: { code: -32603, message: `the bridge could not reach the endpoint: ${message}` },
        })
      } finally {
        if (key !== undefined) inFlight.delete(key)
      }
    },

    close(): void {
      // P26-08: EOF shuts down BRIDGE-OWNED requests. The host is a separate
      // process and is not touched here.
      for (const [key, controller] of inFlight) {
        controller.abort(new Error('the bridge is closing'))
        io.diagnostic(`aborted in-flight request ${key} on close`)
      }
      inFlight.clear()
    },
  }
}

/** Serialize one protocol frame. */
function frame(message: unknown): string {
  return JSON.stringify(message)
}

/** Whether a body is a JSON-RPC message rather than a transport error page. */
function looksLikeJsonRpc(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { jsonrpc?: unknown }
    return parsed.jsonrpc === '2.0'
  } catch {
    return false
  }
}
