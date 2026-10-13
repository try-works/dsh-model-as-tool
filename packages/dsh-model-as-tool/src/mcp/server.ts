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
  ADVERTISED_FEATURES,
  assertHeadersMatch,
  ERROR_CODES,
  errorResponse,
  negotiateVersion,
  parseRequestMetadata,
  PROTOCOL_VERSION,
  successResult,
  toolErrorResult,
  unsupportedRequiredCapabilities,
  WireError,
  type HeaderInput,
  type WireRequest,
} from './protocol.ts'

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
        { unsupported },
      )
    }

    switch (request.method) {
      case 'server/discover':
        return {
          response: { jsonrpc: '2.0', id, result: successResult(discoverResult(host), host.serverInfo) },
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
              },
              host.serverInfo,
            ),
          },
          httpStatus: 200,
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
      // Header problems are a transport-level rejection as well as a JSON-RPC error.
      httpStatus: wire.code === ERROR_CODES.headerMismatch || wire.code === ERROR_CODES.invalidParams ? 400 : 200,
    }
  }
}

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

/** The `server/discover` result. */
function discoverResult(host: McpHost): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: { name: host.serverInfo.name, version: host.serverInfo.version },
    // The machine-readable matrix (P26-12), including what is NOT implemented, so
    // a client can tell "absent" from "unmentioned".
    features: ADVERTISED_FEATURES.map(entry => ({ ...entry })),
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
