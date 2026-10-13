/**
 * MCP host-binding tests (MCP-08, MCP-09, MCP-11, MCP-12).
 *
 * These verify where the data COMES FROM, which is what both requirements are
 * about. MCP-09 is satisfied only if the output schema is taken from the contract
 * rather than from DSH's model-facing projection, and MCP-08 only if invocation goes
 * through the host's execute path with a server-issued identity. Neither is visible
 * from the shape of a response, so the tests assert provenance instead.
 *
 * Requirement links: MCP-08, MCP-09, MCP-11, MCP-12, MCP-13.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

import * as plugin from '../src/index.ts'
import { createMcpHost, derivePayloadSchema, type HostSurface, type PublishedTool } from '../src/mcp/host-binding.ts'
import { dispatch } from '../src/mcp/server.ts'
import { META_KEYS, PROTOCOL_VERSION, type WireRequest } from '../src/mcp/protocol.ts'
import { STANDARD_CONTRACTS } from '@try-works/tool-mode-contracts'
import { cleanup, mountPlugin } from './helpers.ts'

after(async () => { await cleanup() })

/** A contract with a meta envelope, as the standard contracts have. */
const CONTRACT = STANDARD_CONTRACTS.find(contract => contract.toolName === 'lang_detect')!

describe('MCP-09 — schemas come from the contract', () => {
  it('removes ONLY the reserved meta property from the payload schema', () => {
    const payload = derivePayloadSchema(CONTRACT.outputSchema)
    const properties = payload.properties as Record<string, unknown>
    // §16.4: the payload schema is the final tool schema with only the reserved
    // `meta` property and its required entry removed.
    assert.equal('meta' in properties, false, 'meta must be removed')
    assert.equal((payload.required as unknown[] | undefined)?.includes('meta'), false)
    // Everything else survives: a schema that dropped more would under-declare the
    // result the contract actually enforces.
    const original = Object.keys(CONTRACT.outputSchema.properties as Record<string, unknown>)
      .filter(key => key !== 'meta')
    assert.deepEqual(Object.keys(properties).sort(), original.sort())
  })

  it('preserves the remaining constraints verbatim', () => {
    const payload = derivePayloadSchema(CONTRACT.outputSchema)
    const original = structuredClone(CONTRACT.outputSchema as Record<string, unknown>)
    delete (original.properties as Record<string, unknown>).meta
    original.required = (original.required as unknown[]).filter(entry => entry !== 'meta')
    assert.deepEqual(payload, original)
  })

  it('does not mutate the contract it derived from', () => {
    const before = JSON.stringify(CONTRACT.outputSchema)
    derivePayloadSchema(CONTRACT.outputSchema)
    // The contract is shared and validated against elsewhere; a derivation that
    // edited it in place would corrupt every later validation.
    assert.equal(JSON.stringify(CONTRACT.outputSchema), before)
  })

  it('exports an output schema for every published tool', () => {
    const surface: HostSurface = {
      published: [{ toolName: CONTRACT.toolName, contract: CONTRACT }],
      execute: async () => ({ isError: false, value: {} }),
    }
    const host = createMcpHost({ surface, serverInfo: { name: 'x', version: '1' } })
    const [tool] = host.listTools()
    // DSH's model-facing `schemas()` omits output, so a tool published from it would
    // have no declared result shape at all.
    assert.ok(tool?.outputSchema, 'every exported tool must declare its result shape')
    assert.ok(tool?.inputSchema)
    assert.equal(tool?.importedFromMcp, false)
  })
})

describe('MCP-08 — invocation goes through the host path', () => {
  it('passes a server-issued call id and the CALLER signal', async () => {
    const seen: { callId?: string; signal?: AbortSignal; name?: string } = {}
    const surface: HostSurface = {
      published: [{ toolName: CONTRACT.toolName, contract: CONTRACT }],
      async execute({ name, callId, signal }) {
        seen.name = name
        seen.callId = callId
        seen.signal = signal
        return { isError: false, value: { language: 'de' } }
      },
    }
    const host = createMcpHost({ surface, serverInfo: { name: 'x', version: '1' } })
    const callerSignal = new AbortController().signal
    await host.callTool(CONTRACT.toolName, { text: 'hallo' }, callerSignal)

    assert.equal(seen.name, CONTRACT.toolName)
    // Server-issued, so a caller cannot forge the identity a receipt records.
    assert.match(String(seen.callId), /^mcp_/)
    // The CALLER's signal, so cancellation reaches the actual work.
    assert.equal(seen.signal, callerSignal)
  })

  it('issues a distinct call id per invocation', async () => {
    const ids: string[] = []
    const surface: HostSurface = {
      published: [{ toolName: 't', contract: CONTRACT }],
      async execute({ callId }) { ids.push(callId); return { isError: false, value: {} } },
    }
    const host = createMcpHost({ surface, serverInfo: { name: 'x', version: '1' } })
    await host.callTool('t', {}, new AbortController().signal)
    await host.callTool('t', {}, new AbortController().signal)
    assert.notEqual(ids[0], ids[1])
  })

  it('reports a host failure as a tool error, not a fabricated success', async () => {
    const surface: HostSurface = {
      published: [{ toolName: 't', contract: CONTRACT }],
      async execute() { return { isError: true, message: 'the model is unprepared' } },
    }
    const host = createMcpHost({ surface, serverInfo: { name: 'x', version: '1' } })
    const outcome = await host.callTool('t', {}, new AbortController().signal)
    assert.equal(outcome.isError, true)
    assert.match(outcome.text, /unprepared/)
    assert.equal(outcome.structured, null)
  })

  it('returns the canonical value unchanged (MCP-11)', async () => {
    const value = { language: 'de', candidates: [{ language: 'nl', probability: 0.3 }] }
    const surface: HostSurface = {
      published: [{ toolName: 't', contract: CONTRACT }],
      async execute() { return { isError: false, value } },
    }
    const host = createMcpHost({ surface, serverInfo: { name: 'x', version: '1' } })
    const outcome = await host.callTool('t', {}, new AbortController().signal)
    // A redaction applied here would be content-only, and MCP-11 says that is not a
    // confidentiality control: the canonical value would still be reachable.
    assert.deepEqual(outcome.structured, value)
  })

  it('bounds the model-readable rendering', async () => {
    const surface: HostSurface = {
      published: [{ toolName: 't', contract: CONTRACT }],
      async execute() { return { isError: false, value: { text: 'x'.repeat(200_000) } } },
    }
    const host = createMcpHost({ surface, serverInfo: { name: 'x', version: '1' } })
    const outcome = await host.callTool('t', {}, new AbortController().signal)
    // The bound is the slice, plus the truncation marker appended after it.    assert.ok(outcome.text.length <= 100_100, 'the rendering is copied into a context and must be bounded')
    assert.match(outcome.text, /truncated/)
  })
})

describe('MCP-12 — a tool that cannot be exported faithfully is withheld', () => {
  it('omits it entirely and reports the reason', () => {
    const withheld: PublishedTool[] = []
    const surface: HostSurface = {
      published: [
        { toolName: 'good', contract: CONTRACT },
        { toolName: 'ui_only', contract: CONTRACT, notExportableReason: 'uses a UI-only API' },
      ],
      execute: async () => ({ isError: false, value: {} }),
    }
    const host = createMcpHost({
      surface,
      serverInfo: { name: 'x', version: '1' },
      onWithheld: tool => withheld.push(tool),
    })
    const names = host.listTools().map(tool => tool.name)
    // Partly serializing it would tell a client the tool exists and then fail in a
    // way the client cannot interpret.
    assert.deepEqual(names, ['good'])
    assert.equal(withheld[0]?.toolName, 'ui_only')
    assert.match(String(withheld[0]?.notExportableReason), /UI-only/)
  })

  it('refuses to call a withheld tool even if asked by name', async () => {
    const surface: HostSurface = {
      published: [{ toolName: 'ui_only', contract: CONTRACT, notExportableReason: 'non-JSON callback' }],
      execute: async () => ({ isError: false, value: {} }),
    }
    const host = createMcpHost({ surface, serverInfo: { name: 'x', version: '1' } })
    const outcome = await host.callTool('ui_only', {}, new AbortController().signal)
    assert.equal(outcome.isError, true)
    assert.match(outcome.text, /unknown tool/)
  })
})

describe('MCP-08 / MCP-09 — end to end through the plugin', () => {
  let counter = 0
  function request(method: string, params: Record<string, unknown> = {}): WireRequest {
    return {
      jsonrpc: '2.0',
      id: `host-${++counter}`,
      method,
      params: {
        ...params,
        _meta: {
          [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
          [META_KEYS.clientInfo]: { name: 'binding-test', version: '1.0.0' },
          [META_KEYS.clientCapabilities]: {},
        },
      },
    }
  }

  it('the control tool exposes what MCP would export', async () => {
    const ctx = await mountPlugin()
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('mcp-list'),
      name: 'model_tools',
      arguments: { action: 'mcp' },
    })
    if (result.isError) throw new Error(`expected success: ${result.error.message}`)
    const exported = (result.value as { mcp: { name: string; hasOutputSchema: boolean }[] }).mcp
    assert.ok(exported.length > 0, 'the plugin publishes at least one contract tool')
    // The MCP-09 fact, observable: every exported tool declares its result shape.
    for (const tool of exported) {
      assert.equal(tool.hasOutputSchema, true, `${tool.name} must declare an output schema`)
    }
  })

  it('exports exactly the tools the host registered', async () => {
    const ctx = await mountPlugin()
    const listed = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('mcp-vs-registry'),
      name: 'model_tools',
      arguments: { action: 'mcp' },
    })
    if (listed.isError) throw new Error('expected success')
    const exported = (listed.value as { mcp: { name: string }[] }).mcp.map(tool => tool.name).sort()
    const registered = ctx.tools.schemas()
      .map(schema => schema.name)
      .filter(name => name !== 'model_tools')
      .sort()
    // The MCP surface is built from `registeredContracts`, so it cannot advertise a
    // tool the publication surface withheld.
    assert.deepEqual(exported, registered)
  })

  it('a tools/list over the binding returns contract-derived schemas', async () => {
    const ctx = await mountPlugin()
    const listed = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('mcp-schemas'),
      name: 'model_tools',
      arguments: { action: 'mcp' },
    })
    if (listed.isError) throw new Error('expected success')
    const exported = (listed.value as { mcp: { name: string }[] }).mcp
    const surface: HostSurface = {
      published: exported.map(entry => ({
        toolName: entry.name,
        contract: STANDARD_CONTRACTS.find(contract => contract.toolName === entry.name)!,
      })),
      execute: async () => ({ isError: false, value: { language: 'de' } }),
    }
    const host = createMcpHost({ surface, serverInfo: { name: 'dsh-tool-mode', version: '0.1.0' } })
    const { response } = await dispatch(request('tools/list'), host)
    const tools = (response?.result as { tools: { name: string; outputSchema: unknown }[] }).tools
    for (const tool of tools) {
      assert.ok(tool.outputSchema, `${tool.name} must carry an output schema over the wire`)
    }
  })
})
