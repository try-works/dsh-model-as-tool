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
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Ajv2020 from 'ajv/dist/2020.js'

import * as plugin from '../src/index.ts'
import { createMcpHost, derivePayloadSchema, type HostSurface, type PublishedTool } from '../src/mcp/host-binding.ts'
import { dispatch } from '../src/mcp/server.ts'
import { META_KEYS, PROTOCOL_VERSION, type WireRequest } from '../src/mcp/protocol.ts'
import { STANDARD_CONTRACTS } from '@try-works/tool-mode-contracts'
import { setConfinementDemonstratedForTest } from '../src/ptc-runtime.ts'
import { TOOL_MODE_RUN_CONTRACT } from '../src/tool-mode-run.ts'
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
        return { isError: false, value: { reliability: 'confident', tooCloseToCall: false, candidates: [{ language: 'de', probability: 1 }] } }
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

  it('returns the schema-valid MCP payload, with only reserved meta removed', async () => {
    const value = {
      reliability: 'confident',
      tooCloseToCall: false,
      candidates: [{ language: 'de', probability: 0.98 }],
      meta: { hostOnly: true },
    }
    const surface: HostSurface = {
      published: [{ toolName: 't', contract: CONTRACT }],
      async execute() { return { isError: false, value } },
    }
    const host = createMcpHost({ surface, serverInfo: { name: 'x', version: '1' } })
    const outcome = await host.callTool('t', {}, new AbortController().signal)
    assert.equal(outcome.isError, undefined)
    assert.deepEqual(outcome.structured, {
      reliability: 'confident',
      tooCloseToCall: false,
      candidates: [{ language: 'de', probability: 0.98 }],
    })
  })

  it('rejects a host success whose structured value violates the advertised output schema', async () => {
    const surface: HostSurface = {
      published: [{ toolName: 't', contract: CONTRACT }],
      async execute() {
        return {
          isError: false,
          value: {
            reliability: 'not-a-contract-value',
            tooCloseToCall: false,
            candidates: [{ language: 'de', probability: 0.98 }],
          },
        }
      },
    }
    const host = createMcpHost({ surface, serverInfo: { name: 'x', version: '1' } })
    const outcome = await host.callTool('t', {}, new AbortController().signal)
    assert.equal(outcome.isError, true)
    assert.match(outcome.text, /advertised MCP output schema/)
    assert.equal(outcome.structured, null)
  })

  it('bounds the model-readable rendering', async () => {
    const surface: HostSurface = {
      published: [{ toolName: 't', contract: CONTRACT }],
      async execute() {
        return {
          isError: false,
          value: { reliability: 'confident', tooCloseToCall: false, candidates: [{ language: 'x'.repeat(200_000), probability: 1 }] },
        }
      },
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
    /**
     * HOST CONTROL TOOLS ARE NAMED, not filtered by an ad-hoc string comparison.
     *
     * `model_tools` is the control surface, `tool_mode_run` is program execution (CODE-08
     * withholds it until the confinement tests pass), and `tool_mode_list`/`tool_mode_describe`
     * are the DECL-07 NATIVE discovery pair — read-only agent surfaces whose EXTERNAL half is
     * the MCP tools/list + the exported schemas themselves, so they are withheld from the
     * external surface rather than double-exported. None of the four is a model tool.
     *
     * Naming them means ADDING a tool now forces a decision: a registration that is neither
     * a contract tool nor a listed control tool fails this assertion, instead of silently
     * appearing on — or vanishing from — the external surface.
     */
    const HOST_CONTROL_TOOLS = new Set(['model_tools', 'tool_mode_run', 'tool_mode_list', 'tool_mode_describe'])
    const registered = ctx.tools.schemas()
      .map(schema => schema.name)
      .filter(name => !HOST_CONTROL_TOOLS.has(name))
      .sort()
    // The MCP surface is built from `registeredContracts`, so it cannot advertise a
    // tool the publication surface withheld.
    assert.deepEqual(exported, registered)
    // And the withheld control tool really is absent from the external surface, which is
    // the half CODE-08 depends on.
    assert.equal(exported.includes('tool_mode_run'), false, 'program execution must not be exported')
  })

  it('EXPORTS tool_mode_run when the gate opens (confinement evidence AND operator consent)', async () => {
    // The round-44 review named this the testability wall: the export branch had
    // no seam to open, so its first execution would have been in production. The
    // seam is the confinement-evidence setter, which requires the operator
    // environment marker (the setter ships in the built artifact and must be
    // inert without it). Set the marker, flip, and restore both in finally so no
    // other test sees an open gate.
    const originalMarker = process.env.DSH_PTC_CONFINEMENT_SEAM
    process.env.DSH_PTC_CONFINEMENT_SEAM = 'open-for-acceptance-test'
    setConfinementDemonstratedForTest(true)
    try {
      const ctx = await mountPlugin({ hostedCode: true })
      const listed = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('mcp-open-gate'),
        name: 'model_tools',
        arguments: { action: 'mcp' },
      })
      if (listed.isError) throw new Error('expected success')
      const exported = (listed.value as { mcp: { name: string }[] }).mcp
      const entry = exported.find(tool => tool.name === 'tool_mode_run')
      assert.ok(entry, `tool_mode_run must be exported when both gate facts hold, saw: ${exported.map(tool => tool.name).join(', ')}`)
    } finally {
      setConfinementDemonstratedForTest(false)
      if (originalMarker === undefined) delete process.env.DSH_PTC_CONFINEMENT_SEAM
      else process.env.DSH_PTC_CONFINEMENT_SEAM = originalMarker
    }
  })

  it('the tool_mode_run MCP projection conforms to the PINNED schema before it ever ships (P26-13)', () => {
    // The round-44 review's deeper point: the hand-written contract must be
    // schema-validated before its first live tools/list, not inspected. This
    // builds the SAME projection the binding builds and validates it against the
    // pinned $defs.Tool with Ajv 2020 — the exact validator the live suite uses.
    const surface: HostSurface = {
      published: [{ toolName: 'tool_mode_run', contract: TOOL_MODE_RUN_CONTRACT as never }],
      execute: async () => ({ isError: false, value: {} }),
    }
    const host = createMcpHost({ surface, serverInfo: { name: 'tool-mode', version: '0.1.3' } })
    const listed = host.listTools()
    const entry = listed.find(tool => tool.name === 'tool_mode_run')
    assert.ok(entry, 'the projection must include the tool')

    const schema = JSON.parse(readFileSync('docs/tool-mode/specs/mcp-2026-07-28/schema.json', 'utf8')) as {
      $defs?: Record<string, unknown>
      definitions?: Record<string, unknown>
    }
    const ajv = new Ajv2020({ strict: false, allErrors: true })
    ajv.addSchema(schema as object, 'pinned')
    const defs = schema.$defs ?? schema.definitions ?? {}
    const toolDef = defs.Tool
    assert.ok(toolDef !== undefined, 'the pinned schema must define Tool')
    const validate = ajv.compile({ $ref: 'pinned#/$defs/Tool' })
    const projected = {
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
    }
    assert.equal(validate(projected), true, `tool_mode_run projection violates the pinned Tool: ${JSON.stringify(validate.errors)}`)
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
      execute: async () => ({ isError: false, value: { reliability: 'confident', tooCloseToCall: false, candidates: [{ language: 'de', probability: 1 }] } }),
    }
    const host = createMcpHost({ surface, serverInfo: { name: 'dsh-tool-mode', version: '0.1.0' } })
    const { response } = await dispatch(request('tools/list'), host)
    const tools = (response?.result as { tools: { name: string; outputSchema: unknown }[] }).tools
    for (const tool of tools) {
      assert.ok(tool.outputSchema, `${tool.name} must carry an output schema over the wire`)
    }
  })
})
