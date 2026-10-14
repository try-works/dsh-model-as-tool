/**
 * MCP method dispatch (MCP-05, MCP-06, MCP-08, MCP-09, MCP-13).
 *
 * The server is STATELESS by construction, which is what P26-01 requires: a
 * `tools/list` or `tools/call` must be processable as the first application
 * request. There is no session table here to require one, so the requirement is
 * satisfied by the shape of the code rather than by remembering to skip a check.
 *
 * Dispatch resolves ONE authorized definition and calls it through the host's
 * execution path (MCP-08), rather than reaching into a registry by name — the
 * difference matters because the host's path applies the grant, the receipt and
 * the result policy, while a direct lookup would bypass all three.
 *
 * @module @try-works/dsh-model-as-tool/mcp/server
 */

import {
  assertHeadersMatch,
  cacheableResultFields,
  implementedCapabilities,
  SUPPORTED_PROTOCOL_VERSIONS,
  ERROR_CODES,
  errorResponse,
  negotiateVersion,
  parseRequestMetadata,
  successResult,
  toolErrorResult,
  unsupportedRequiredCapabilities,
  WireError,
  type HeaderInput,
  type WireRequest,
} from './protocol.ts'
import type { SubscriptionRegistry } from './subscriptions.ts'

/** One tool as the MCP surface describes it. */
export interface McpToolDefinition {
  /** The caller-facing name. */
  readonly name: string
  /** A short human-readable title, when the contract declares one. */
  readonly title?: string
  /** What the tool does, written for a model. */
  readonly description: string
  /** The canonical input schema, JSON Schema 2020-12. */
  readonly inputSchema: Readonly<Record<string, unknown>>
  /** The canonical OUTPUT schema (MCP-09). */
  readonly outputSchema: Readonly<Record<string, unknown>>
  /** Whether this tool was imported from another MCP server. */
  readonly importedFromMcp: boolean
}

/** The outcome of invoking one tool. */
export interface ToolInvocationOutcome {
  /** The finalized, post-policy canonical value. */
  readonly structured: unknown
  /** A bounded, model-readable rendering. */
  readonly text: string
  /** Whether the tool itself failed. */
  readonly isError?: boolean
}

/** What dispatch needs from the host. */
export interface McpHost {
  /** This server's identity, reported in result metadata. */
  readonly serverInfo: { readonly name: string; readonly version: string }
  /**
   * The tools this caller may see, in deterministic order (MCP-06).
   * @returns the authorized definitions.
   */
  listTools(): readonly McpToolDefinition[]
  /**
   * Invoke one authorized tool through the host execution path (MCP-08).
   * @param name - the tool name.
   * @param args - the tool arguments.
   * @param signal - the caller's abort signal.
   * @returns the outcome.
   */
  callTool(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<ToolInvocationOutcome>
}

/** One dispatched response. */
export interface DispatchResult {
  /** The response envelope to send, or undefined for a notification. */
  readonly response?: Record<string, unknown>
  /** The HTTP status the transport should use. */
  readonly httpStatus: number
  /**
   * Notifications the transport must deliver after the response (P26-09).
   *
   * Carried on the result rather than written into the body, because a notification
   * is a separate message: embedding one inside a result would produce a frame that
   * is not a valid result and not a valid notification.
   */
  readonly followUp?: readonly Record<string, unknown>[]
}

/**
 * Project a definition into the MCP tool shape.
 *
 * `outputSchema` is taken from the resolved definition rather than from DSH's
 * model-facing `schemas()` projection, which intentionally omits `output`: a
 * schema-only export built from that projection would be missing the very field
 * MCP-09 requires.
 * @param definition - the resolved definition.
 * @returns the MCP tool descriptor.
 */
export function toMcpTool(definition: McpToolDefinition): Record<string, unknown> {
  return {
    name: definition.name,
    ...definition.title === undefined ? {} : { title: definition.title },
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
  }
}

/**
 * Dispatch one request.
 *
 * Stateless: nothing is retained between calls, so a valid request works as the
 * first one.
 * @param request - the parsed request.
 * @param host - the host surface.
 * @param options - headers and the caller's abort signal.
 * @returns the response and the HTTP status.
 */
export async function dispatch(
  request: WireRequest,
  host: McpHost,
  options: {
    readonly headers?: HeaderInput
    readonly signal?: AbortSignal
    /** Whether the transport checks headers at all; stdio has none to check. */
    readonly checkHeaders?: boolean
    /**
     * The catalog subscription registry (P26-09).
     *
     * Optional so a host that offers no subscriptions does not have to construct one;
     * subscriptions/listen then reports the method as unsupported rather than
     * accepting a subscription it cannot serve.
     */
    readonly subscriptions?: SubscriptionRegistry
    /** The authenticated client, which a subscription is bound to. */
    readonly clientId?: string
  } = {},
): Promise<DispatchResult> {
  const id = request.id ?? null
  try {
    if (options.checkHeaders === true && options.headers !== undefined) {
      assertHeadersMatch(options.headers, request)
    }
    const metadata = parseRequestMetadata(request.params)
    negotiateVersion(metadata)

    // Capabilities the CLIENT requires. A requirement this server cannot meet is
    // -32021 rather than a silent partial service.
    const required = requiredCapabilities(metadata.clientCapabilities)
    const unsupported = unsupportedRequiredCapabilities(required)
    if (unsupported.length > 0) {
      throw new WireError(
        ERROR_CODES.unsupportedClientCapability,
        `the client requires unsupported capability: ${unsupported.join(', ')}`,
        /**
         * THE PINNED SCHEMA'S OWN FIELD NAME, and this was WRONG.
         *
         * `MissingRequiredClientCapabilityError` REQUIRES `data.requiredCapabilities`. This
         * sent `{ unsupported: [...] }`, which Ajv rejects against the pinned definition:
         *
         *   INVALID -> /error/data must have required property 'requiredCapabilities'
         *
         * It went unnoticed because the GENERIC `JSONRPCErrorResponse` accepts ANY `data`,
         * every fixture took that path, and no fixture covered `-32021` at all — so the
         * conformance suite validated a shape the specific error definition forbids.
         * P26-03 requires `-32021` "and the schema-defined data"; this is that shape.
         */
        { requiredCapabilities: unsupported },
      )
    }

    switch (request.method) {
      case 'server/discover':
        return {
          response: { jsonrpc: '2.0', id, result: successResult(discoverResult(), host.serverInfo) },
          httpStatus: 200,
        }
      case 'tools/list':
        return {
          response: {
            jsonrpc: '2.0',
            id,
            result: successResult(
              {
                // Deterministic ordering (MCP-06): the caller sees a stable list, so
                // a client diffing two listings does not see spurious changes.
                tools: [...host.listTools()]
                  .sort((left, right) => left.name.localeCompare(right.name))
                  .map(toMcpTool),
                // Required by the schema's CacheableResult; omitting them makes the
                // result non-conformant even though the tool list is correct.
                ...cacheableResultFields(),
              },
              host.serverInfo,
            ),
          },
          httpStatus: 200,
        }
      case 'subscriptions/listen': {
        // P26-09. The acknowledgement is returned WITH the result rather than after
        // it, so the client cannot observe an event before being told what the server
        // agreed to send.
        //
        // A host with no registry reports the method as unsupported rather than
        // accepting a subscription it cannot serve: an acknowledged subscription that
        // never fires is indistinguishable from a broken server.
        if (options.subscriptions === undefined) {
          throw new WireError(
            ERROR_CODES.methodNotFound,
            'this server does not offer catalog subscriptions',
          )
        }
        const subscription = options.subscriptions.listen(request, options.clientId ?? 'unknown')
        return {
          response: { jsonrpc: '2.0', id, result: successResult(subscription.result, host.serverInfo) },
          httpStatus: 200,
          followUp: [subscription.acknowledgement],
        }
      }
      case 'tools/call':
        return await callTool(request, id, host, options.signal ?? new AbortController().signal)
      default:
        throw new WireError(ERROR_CODES.methodNotFound, `unknown method ${JSON.stringify(request.method)}`)
    }
  } catch (error) {
    const wire = error instanceof WireError
      ? error
      : new WireError(ERROR_CODES.internalError, error instanceof Error ? error.message : String(error))
    // An infrastructure failure must never be turned into a successful domain
    // payload (MCP-10), so it leaves as a JSON-RPC error.
    return {
      response: errorResponse(id, wire),
      /**
       * THE PINNED SCHEMA'S OWN `MUST`, read from the schema rather than inferred.
       *
       * Three error definitions state it in as many words — "For HTTP, the response status
       * code MUST be `400 Bad Request`":
       *
       *   HeaderMismatchError                  -> -32020
       *   MissingRequiredClientCapabilityError -> -32021
       *   UnsupportedProtocolVersionError      -> -32022
       *
       * Only the FIRST and `invalidParams` were mapped to 400, so a client requiring an
       * unsupported capability — or presenting an unsupported protocol version — received an
       * error body under a 200 status. The suite stayed green either way, so the status was
       * untested in BOTH directions.
       *
       * Kept as a named SET so the next transport-level rejection is a one-line addition
       * rather than another condition somebody can forget.
       */
      httpStatus: TRANSPORT_LEVEL_REJECTIONS.has(wire.code) ? 400 : 200,
    }
  }
}

/**
 * The JSON-RPC codes the pinned schema requires be answered with HTTP 400 as well.
 *
 * Every one of these definitions says, verbatim: "For HTTP, the response status code MUST
 * be `400 Bad Request`." Kept as a named set so the rule lives in ONE place and the next
 * transport-level rejection is an addition rather than another forgotten condition.
 */
const TRANSPORT_LEVEL_REJECTIONS = new Set<number>([
  ERROR_CODES.headerMismatch,              // -32020
  ERROR_CODES.unsupportedClientCapability, // -32021
  ERROR_CODES.unsupportedProtocolVersion,  // -32022
  ERROR_CODES.invalidParams,               // -32602, a malformed request shape
])

/** Handle `tools/call`. */
async function callTool(
  request: WireRequest,
  id: string | number | null,
  host: McpHost,
  signal: AbortSignal,
): Promise<DispatchResult> {
  const name = request.params?.name
  if (typeof name !== 'string' || name.length === 0) {
    throw new WireError(ERROR_CODES.invalidParams, 'tools/call requires params.name')
  }
  const args = request.params?.arguments
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    throw new WireError(ERROR_CODES.invalidParams, 'tools/call arguments must be an object')
  }

  const definition = host.listTools().find(tool => tool.name === name)
  if (definition === undefined) {
    // An unknown name is invalid params, not a tool error: nothing was invoked, so
    // reporting a domain failure would be a fabrication.
    throw new WireError(ERROR_CODES.invalidParams, `unknown tool ${JSON.stringify(name)}`)
  }
  // MCP-13: never re-export an imported MCP tool, or a server could delegate back
  // into itself through a loop that no caller can see.
  if (definition.importedFromMcp) {
    throw new WireError(
      ERROR_CODES.invalidParams,
      `tool ${JSON.stringify(name)} was imported from MCP and is not re-exported`,
    )
  }

  const outcome = await host.callTool(name, (args ?? {}) as Record<string, unknown>, signal)
  const result = outcome.isError === true
    // An application failure is a tool-error RESULT (P26-04), so the protocol
    // exchange still succeeded.
    ? toolErrorResult(outcome.text)
    : {
        content: [{ type: 'text', text: outcome.text }],
        // The finalized, post-policy canonical value (MCP-10).
        structuredContent: outcome.structured,
      }
  return {
    response: { jsonrpc: '2.0', id, result: successResult(result as Record<string, unknown>, host.serverInfo) },
    httpStatus: 200,
  }
}

/** The `server/discover` result, in the shape the pinned schema requires. */
function discoverResult(): Record<string, unknown> {
  return {
    // `supportedVersions` is the field the schema defines; there is no
    // `protocolVersion` on a DiscoverResult, which is the mistake pinning the schema
    // caught. A client learns the versions the server speaks, not one it picked.
    supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: serverCapabilities(),
    ...cacheableResultFields(),
  }
}

/**
 * The capabilities this server advertises.
 *
 * Derived from the feature matrix rather than restated, so the matrix a client
 * reads and the capabilities it is offered cannot disagree. P26-12: a feature is
 * advertised only when it is genuinely implemented.
 * @returns the `ServerCapabilities` object.
 */
function serverCapabilities(): Record<string, unknown> {
  const implemented = new Set(implementedCapabilities())
  return {
    ...implemented.has('tools') ? { tools: {} } : {},
    ...implemented.has('prompts') ? { prompts: {} } : {},
    ...implemented.has('resources/subscribe') ? { resources: {} } : {},
    ...implemented.has('logging') ? { logging: {} } : {},
  }
}

/**
 * Read the capabilities a client declared as REQUIRED.
 *
 * A client may declare capabilities it merely supports; only the required ones can
 * make a request unserviceable.
 * @param capabilities - the parsed capability object.
 * @returns the required capability names.
 */
function requiredCapabilities(capabilities: Readonly<Record<string, unknown>>): string[] {
  const required = capabilities.required
  if (!Array.isArray(required)) return []
  return required.filter((name): name is string => typeof name === 'string')
}
