/**
 * Official SDK v2 serving adapter, not a second business dispatcher.
 *
 * Upstream main inspected at 9bc40e903fde15534ec06ff4c1347d47000dbe16:
 * https://github.com/modelcontextprotocol/typescript-sdk/blob/9bc40e903fde15534ec06ff4c1347d47000dbe16/docs/serving/http.md
 * That revision's packages/server/package.json is 2.3.1; runtime uses the exact
 * npm release @modelcontextprotocol/server@2.3.1 (not a floating git dependency).
 * Registry provenance: https://registry.npmjs.org/@modelcontextprotocol/server/2.3.1
 * tarball SHA-1 a15440d5c06f3bad67360952fe58e6965b4a4ac7; integrity
 * sha512-e59MfWuSssj6DoQ96JCTqdW1AXT5/XtnTl0WWd6MU1Ka434fFUGGosCLJbGNySDhHGvxQWoRWK137FXYFkYNWw==
 * Protocol revision: 2026-07-28. Legacy handshakes/sessions are deliberately refused.
 */
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server'
import type { ExternalCaller } from './client-grant.ts'
import type { McpHost } from './server.ts'
import { toolErrorResult, type WireRequest } from './protocol.ts'

/**
 * Construct official serving around a caller already verified by the transport.
 * No credentials or grants are accepted from JSON-RPC params. Each factory call
 * reads the LIVE surface and creates a fresh server; business execution and its
 * accounting remain exclusively in host.callTool / createMcpHost.
 */
export function createSdkV2Handler(host: McpHost, caller: ExternalCaller, incoming?: WireRequest) {
  return createMcpHandler(({ authInfo }) => {
    if (authInfo?.clientId !== caller.clientId) {
      throw new Error('SDK serving requires the transport-verified caller')
    }
    const server = new McpServer(host.serverInfo, {
      supportedProtocolVersions: ['2026-07-28'],
      // Keep tools/list available for an empty caller-specific catalog; SDK
      // handlers otherwise appear only after the first registerTool call.
      capabilities: { tools: { listChanged: false } },
    })
    for (const tool of [...host.listTools()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!caller.allowedTools.includes(tool.name) || tool.importedFromMcp) continue
      server.registerTool(tool.name, {
        ...tool.title === undefined ? {} : { title: tool.title },
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema),
        // A definition with no declared result shape must register no
        // outputSchema: the SDK's output validator converts ANY registered
        // outputSchema plus an undefined structuredContent into a tool error
        // ("has an output schema but no structured content was provided"),
        // while the protocol dispatch serves the same host outcome as a
        // content-only success (server.ts). An empty schema is the
        // schema-less sentinel.
        ...tool.outputSchema === undefined || Object.keys(tool.outputSchema).length === 0
          ? {}
          : { outputSchema: fromJsonSchema<unknown>(tool.outputSchema) },
      }, async (args, ctx) => {
        const outcome = await host.callTool(tool.name, args, ctx.mcpReq.signal, caller)
        if (outcome.isError === true) {
          // An application failure is a tool-error RESULT (P26-04), clamped
          // exactly like the protocol dispatch clamps it: toolErrorResult
          // bounds the message to 2000 chars + '…' (protocol.ts:358-365).
          // The installed SDK's CallToolResult.content is mutable, so the
          // readonly payload content is copied, as the denied-call path does.
          const failure = toolErrorResult(outcome.text)
          return { isError: failure.isError, content: [...failure.content] }
        }
        // The pinned 2026-07-28 schema types structuredContent as `unknown` —
        // ANY JSON value (object, array, string, number, boolean, null:
        // docs/tool-mode/specs/mcp-2026-07-28/schema.ts CallToolResult). The
        // installed SDK's CallToolResultSchema is z.ZodUnknown and its 2026-era
        // projection is identity, so no runtime guard or cast is needed;
        // undefined means "no structured value" and is omitted.
        return {
          content: [{ type: 'text', text: outcome.text }],
          ...outcome.structured === undefined ? {} : { structuredContent: outcome.structured },
        }
      })
    }
    // Withheld known tools must remain invisible to tools/list, but SEC-03
    // requires policy denials in the tool-error lane. Override only this fresh
    // request's denied-call handler; accepted calls retain McpServer's genuine
    // registration/input/output pipeline. The shared host boundary owns the
    // refusal and its accounting; no unauthorized tool is ever registered.
    if (incoming !== undefined) {
      const deniedName = incoming.params?.name
      if (incoming.method === 'tools/call' && typeof deniedName === 'string'
        && !caller.allowedTools.includes(deniedName)
        && host.listTools().some(tool => tool.name === deniedName && !tool.importedFromMcp)) {
        server.server.setRequestHandler('tools/call', async (request, ctx) => {
          if (request.params.name !== deniedName) throw new Error('request-specific denial name changed')
          const outcome = await host.callTool(deniedName, request.params.arguments ?? {}, ctx.mcpReq.signal, caller)
          if (outcome.isError !== true) throw new Error('host accepted a tool outside the authenticated grant')
          return { isError: true, content: [...toolErrorResult(outcome.text).content] }
        })
      }
    }
    return server
  }, {
    legacy: 'reject',
    // NEVER 'json': that mode silently drops mid-call notifications. Auto keeps
    // every message, upgrading the response to SSE if one is emitted.
    responseMode: 'auto',
  })
}

/**
 * Live Fetch face. The per-request SDK handler belongs to the response body:
 * close it on drain, cancellation, abort or error, never when fetch returns SSE.
 * Linking a controller also makes a Web reader's cancel abort business execution.
 */
export async function serveSdkV2Request(
  host: McpHost,
  caller: ExternalCaller,
  request: Request,
  token: string,
): Promise<Response> {
  const incoming = await request.clone().json() as WireRequest
  const handler = createSdkV2Handler(host, caller, incoming)
  const abort = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let stopped = false
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closing === undefined) {
      stopped = true
      request.signal.removeEventListener('abort', onAbort)
      closing = handler.close()
    }
    return closing
  }
  const cancel = async (reason: unknown): Promise<void> => {
    abort.abort(reason)
    try { await reader?.cancel(reason) } finally { await close() }
  }
  const onAbort = (): void => { void cancel(request.signal.reason).catch(() => {}) }
  request.signal.addEventListener('abort', onAbort, { once: true })
  if (request.signal.aborted) onAbort()
  try {
    const response = await handler.fetch(new Request(request, { signal: abort.signal }), {
      authInfo: { token, clientId: caller.clientId, scopes: [] },
    })
    if (response.body === null) {
      await close()
      return response
    }
    reader = response.body.getReader()
    if (abort.signal.aborted) {
      await cancel(abort.signal.reason)
      throw abort.signal.reason ?? new Error('request aborted')
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader!.read()
          if (stopped) { controller.close(); return }
          if (next.done) {
            await close()
            reader!.releaseLock()
            controller.close()
          } else {
            controller.enqueue(next.value)
          }
        } catch (error) {
          await close()
          controller.error(error)
        }
      },
      async cancel(reason) { await cancel(reason) },
    }, { highWaterMark: 0 })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } catch (error) {
    await close()
    throw error
  }
}
