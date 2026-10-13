/**
 * Binding the MCP surface to the real DSH tool registry (MCP-08, MCP-09, MCP-12).
 *
 * Two requirements shape this module, and both are about where data comes from
 * rather than what it looks like:
 *
 * - **MCP-09**: DSH's model-facing `schemas()` projection INTENTIONALLY omits the
 *   output schema, so an export built from it would publish a tool with no declared
 *   result shape. The canonical schemas therefore come from the CONTRACTS, which is
 *   the only place that has them; `schemas()` is never consulted for a schema.
 * - **MCP-08**: invocation goes through the host's `execute` path with a
 *   server-issued call identity and the caller's abort signal. Resolving a tool and
 *   calling it directly would bypass the grant, the receipt and the result policy —
 *   the three things the host path exists to apply — so this module is given an
 *   executor rather than a registry to reach into.
 *
 * §16.4 defines the payload derivation precisely: an implementation returns the
 * domain payload with the reserved root `meta` OMITTED, and the payload schema is
 * the final tool schema with only that property and its required entry removed.
 * Everything else is preserved, because a schema that quietly dropped more would
 * under-declare the result.
 *
 * @module @try-works/dsh-model-as-tool/mcp/host-binding
 */

import type { ToolContract } from '@try-works/tool-mode-contracts'
import type { McpHost, McpToolDefinition, ToolInvocationOutcome } from './server.ts'

/** The reserved root field the host authors, never the implementation. */
const RESERVED_META = 'meta'

/**
 * Derive the payload schema from a contract's final output schema (§16.4).
 *
 * Only the reserved `meta` property and its `required` entry are removed. The rest
 * of the schema — including constraints on the remaining properties — is preserved
 * verbatim, because removing anything else would advertise a looser result than the
 * contract actually enforces.
 * @param outputSchema - the contract's output schema, including `meta`.
 * @returns the payload schema.
 */
export function derivePayloadSchema(
  outputSchema: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const clone = structuredClone(outputSchema as Record<string, unknown>)
  if (typeof clone.properties === 'object' && clone.properties !== null) {
    delete (clone.properties as Record<string, unknown>)[RESERVED_META]
  }
  if (Array.isArray(clone.required)) {
    clone.required = (clone.required as unknown[]).filter(entry => entry !== RESERVED_META)
  }
  return clone
}

/** One published tool as the host knows it. */
export interface PublishedTool {
  /** The tool name a caller uses. */
  readonly toolName: string
  /** The contract it implements, which carries the canonical schemas. */
  readonly contract: ToolContract
  /**
   * Why this tool is not exportable, when it is not (MCP-12).
   *
   * A host tool using a non-JSON callback, a UI-only API, an unsupported attachment
   * or a non-exportable policy must be REJECTED WITH A REASON rather than partly
   * serialized, so the reason travels with the tool instead of being discovered by a
   * caller whose call fails in a way nobody can explain.
   */
  readonly notExportableReason?: string
}

/** What the binding needs from the host. */
export interface HostSurface {
  /** The tools the host currently publishes. */
  readonly published: readonly PublishedTool[]
  /**
   * Execute one tool through the host path (MCP-08).
   *
   * Takes a server-issued call identity and the caller's signal; the implementation
   * MUST route this through the same execution path a native call uses.
   */
  execute(request: {
    readonly name: string
    readonly arguments: Readonly<Record<string, unknown>>
    readonly signal: AbortSignal
    /** Server-issued. A caller-supplied id would let a caller forge a receipt. */
    readonly callId: string
  }): Promise<{
    readonly isError: boolean
    readonly value?: unknown
    readonly message?: string
  }>
}

/**
 * Build the MCP host surface over a DSH tool surface.
 *
 * @param options - the host surface and this server's identity.
 * @returns the MCP host the dispatch layer consumes.
 */
export function createMcpHost(options: {
  readonly surface: HostSurface
  readonly serverInfo: { readonly name: string; readonly version: string }
  /** Called for each tool withheld, so a reason is recorded rather than lost. */
  readonly onWithheld?: (tool: PublishedTool) => void
}): McpHost {
  let counter = 0
  return {
    serverInfo: options.serverInfo,

    listTools(): readonly McpToolDefinition[] {
      const out: McpToolDefinition[] = []
      for (const published of options.surface.published) {
        // MCP-12: a tool that cannot be exported faithfully is withheld entirely,
        // with its reason recorded. Exporting a partial tool would tell a client the
        // tool exists and then fail in a way the client cannot interpret.
        if (published.notExportableReason !== undefined) {
          options.onWithheld?.(published)
          continue
        }
        out.push({
          name: published.toolName,
          description: published.contract.description,
          // Both schemas come from the CONTRACT. `schemas()` omits output, so using
          // it here would publish a tool with no declared result shape (MCP-09).
          inputSchema: published.contract.inputSchema,
          outputSchema: derivePayloadSchema(published.contract.outputSchema),
          // Nothing in this binding imports from another MCP server, so no tool is
          // a re-export (MCP-13).
          importedFromMcp: false,
        })
      }
      return out
    },

    async callTool(name, args, signal): Promise<ToolInvocationOutcome> {
      const definition = options.surface.published.find(tool => tool.toolName === name)
      // A tool that is not EXPORTABLE must not be callable either. Looking only for
      // its presence in `published` would let a client invoke by name exactly the
      // tool the export deliberately withheld — defeating MCP-12 through the back
      // door, since a client that guessed the name would get a partial result the
      // export refused to promise.
      if (definition === undefined || definition.notExportableReason !== undefined) {
        return {
          structured: null,
          text: `unknown tool ${JSON.stringify(name)}`,
          isError: true,
        }
      }
      const outcome = await options.surface.execute({
        name,
        arguments: args,
        signal,
        // Server-issued, monotonically increasing. A caller-supplied identity would
        // let a caller forge a receipt (BASE-05).
        callId: `mcp_${Date.now().toString(36)}_${(++counter).toString(36)}`,
      })
      if (outcome.isError) {
        return {
          structured: null,
          // Bounded by the dispatch layer when it becomes a tool-error result.
          text: outcome.message ?? 'the tool failed without reporting a reason',
          isError: true,
        }
      }
      return {
        // The canonical value, post-policy, exactly as the host returned it: a
        // redaction here would be a content-only control, which MCP-11 says is not a
        // confidentiality control at all.
        structured: outcome.value ?? null,
        text: renderBounded(outcome.value),
      }
    },
  }
}

/**
 * Render a bounded, model-readable representation of a canonical value.
 *
 * Bounded because a result is copied into a model's context, and an unbounded
 * rendering of a large value would consume it silently.
 * @param value - the canonical value.
 * @returns the text rendering.
 */
function renderBounded(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return text.length > 100_000 ? `${text.slice(0, 100_000)}…(truncated)` : text
}
