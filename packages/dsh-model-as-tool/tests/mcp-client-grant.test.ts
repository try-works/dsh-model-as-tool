/**
 * Per-client external grants (SEC-04, SEC-03, SEC-01 tails), proved at three layers.
 *
 * The defect this closes was recorded in round 65: external MCP calls dispatched through
 * the HOST'S OWN interactive grant — `ctx.tools.execute` under the operator's authority,
 * with `callerKind: 'interactive'` — so an external client WAS the operator as far as
 * authorization and receipts were concerned. The 'narrower external grant' SEC-04 asks
 * for simply did not exist.
 *
 * This file proves the replacement:
 *
 * - unit: the grant derivation — the default is the live surface, a per-client override
 *   narrows it, and the identity is the CLIENT's own (`external:<id>`), never the
 *   operator's;
 * - binding: a surface.execute carrying a caller runs granted tools and REFUSES
 *   non-granted ones through the SEC-03 authority, while the caller-less (native/
 *   interactive) path is unchanged;
 * - HTTP, end to end: two OAuth clients with different granted sets get different
 *   outcomes for the SAME tool, `model_tools` never appears on the external surface,
 *   and the receipts surface names the CLIENT's grant rather than pretending the
 *   operator called.
 *
 * Requirement links: SEC-04, SEC-03, SEC-01, BASE-05, MCP-12, OBS-02.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { resolveClientGrant, type ClientGrantConfig } from '../src/mcp/client-grant.ts'
import { authorizeTool, AuthorityError } from '../src/authority.ts'
import { createHttpHandler, type HttpRequestDescription } from '../src/mcp/http.ts'
import { createLocalOAuthServer, type LocalOAuthServer } from '../src/mcp/oauth.ts'
import { META_KEYS, PROTOCOL_VERSION } from '../src/mcp/protocol.ts'
import type { McpHost } from '../src/mcp/server.ts'
import type { HostSurface } from '../src/mcp/host-binding.ts'
import { cleanup, callTool, mountPlugin } from './helpers.ts'
import { STANDARD_CONTRACTS, type ToolContract } from '@try-works/tool-mode-contracts'
import { createExternalGrantContext, createProgramRunner, serveProgram } from '../src/tool-mode-run.ts'
import { mountPtcRuntimeIfAbsent, PTC_SERVICE } from '../src/ptc-runtime.ts'

after(async () => { await cleanup() })

const SURFACE = ['lang_detect', 'stt_transcribe', 'tool_mode_run']

describe('SEC-04 — the grant derivation', () => {
  it('defaults to the live surface, under the CLIENT\'s own identity', () => {
    const caller = resolveClientGrant('client-a', undefined, SURFACE)
    assert.equal(caller.clientId, 'client-a')
    assert.equal(caller.grantId, 'external:client-a', 'the grant is the client\'s own, never the operator\'s')
    assert.deepEqual(caller.allowedTools, SURFACE)
    assert.equal(caller.recordingPolicy, 'receipts', 'external calls default to recorded (OBS-02)')
    assert.ok(caller.limits.maxInputBytes > 0)
  })

  it('lets a per-client override narrow the set, while a peer keeps the default', () => {
    const config: ClientGrantConfig = {
      perClient: {
        'client-narrow': { allowedTools: ['lang_detect'] },
        'client-none': { allowedTools: [] },
      },
    }
    const narrow = resolveClientGrant('client-narrow', config, SURFACE)
    assert.deepEqual(narrow.allowedTools, ['lang_detect'])
    const none = resolveClientGrant('client-none', config, SURFACE)
    assert.deepEqual(none.allowedTools, [], 'an explicitly empty grant permits nothing')
    const peer = resolveClientGrant('client-b', config, SURFACE)
    assert.deepEqual(peer.allowedTools, SURFACE, 'an unlisted client keeps the default')
  })

  it('honours a default allowlist, recording policy and limits overrides', () => {
    const caller = resolveClientGrant('client-c', {
      allowedTools: ['lang_detect'],
      recordingPolicy: 'none',
      limits: { maxInputBytes: 1024 },
    }, SURFACE)
    assert.deepEqual(caller.allowedTools, ['lang_detect'])
    assert.equal(caller.recordingPolicy, 'none')
    assert.equal(caller.limits.maxInputBytes, 1024)
    assert.equal(caller.grantId, 'external:client-c')
  })

  it('intersects an override with the LIVE surface, so a non-surface name grants nothing (H3)', () => {
    const caller = resolveClientGrant('client-typo', {
      perClient: { 'client-typo': { allowedTools: ['lang_detect', 'stt_transcibe'] } },
    }, SURFACE)
    assert.deepEqual(
      caller.allowedTools,
      ['lang_detect'],
      'a typo naming a non-surface tool must not silently grant it',
    )
    // The default path (the surface itself) passes through the intersection unchanged.
    const byDefault = resolveClientGrant('client-default', undefined, SURFACE)
    assert.deepEqual(byDefault.allowedTools, SURFACE)
  })
})

describe('SEC-04 — the surface executes under the CALLER\'s grant, not the host\'s', () => {
  /** A surface whose execute mirrors the host wiring: authorize, then dispatch. */
  function makeSurface(options: { readonly runs?: string[] } = {}): { surface: HostSurface; runs: string[] } {
    const runs: string[] = []
    const contract = STANDARD_CONTRACTS[0] as ToolContract
    const surface: HostSurface = {
      published: [
        { toolName: 'lang_detect', contract },
        { toolName: 'stt_transcribe', contract },
      ],
      async execute({ name, caller }) {
        if (caller !== undefined) {
          try {
            authorizeTool({
              grantId: caller.grantId,
              allowedTools: caller.allowedTools,
              approvedRoots: [],
              remoteDestinations: [],
              hostedCode: false,
              recordingPolicy: caller.recordingPolicy,
              limits: caller.limits,
            }, name)
          } catch (error) {
            return { isError: true, message: error instanceof Error ? error.message : String(error) }
          }
        }
        runs.push(name)
        return { isError: false, value: { ran: name } }
      },
    }
    void options
    return { surface, runs }
  }

  it('runs a tool the caller is granted, and refuses one it is not — naming the grant', async () => {
    const { surface, runs } = makeSurface()
    const caller = resolveClientGrant('client-narrow', { perClient: { 'client-narrow': { allowedTools: ['lang_detect'] } } }, SURFACE)

    const granted = await surface.execute({
      name: 'lang_detect', arguments: {}, signal: new AbortController().signal, callId: 'c-1', caller,
    })
    assert.equal(granted.isError, false)
    assert.deepEqual(runs, ['lang_detect'])

    const refused = await surface.execute({
      name: 'stt_transcribe', arguments: {}, signal: new AbortController().signal, callId: 'c-2', caller,
    })
    assert.equal(refused.isError, true, 'a tool granted to the operator but not to the client must stay refused')
    assert.match(refused.message ?? '', /not granted to this caller/)
    assert.deepEqual(runs, ['lang_detect'], 'the refused tool must never dispatch')
  })

  it('keeps the caller-less (native/interactive) path unchanged', async () => {
    const { surface, runs } = makeSurface()
    const result = await surface.execute({
      name: 'stt_transcribe', arguments: {}, signal: new AbortController().signal, callId: 'c-3',
    })
    assert.equal(result.isError, false, 'the operator path carries no client grant and is not narrowed')
    assert.deepEqual(runs, ['stt_transcribe'])
  })

  it('the SEC-03 authority vocabulary carries the refusal', () => {
    const caller = resolveClientGrant('client-x', { allowedTools: [] }, SURFACE)
    assert.throws(
      () => authorizeTool({
        grantId: caller.grantId,
        allowedTools: caller.allowedTools,
        approvedRoots: [], remoteDestinations: [], hostedCode: false,
        recordingPolicy: caller.recordingPolicy, limits: caller.limits,
      }, 'lang_detect'),
      (error: unknown) => error instanceof AuthorityError && error.code === 'TOOL_NOT_GRANTED',
    )
  })
})

const ISSUER = 'https://client-grant.local'
const AUDIENCE = 'client-grant-mcp'

function makeOAuth(): LocalOAuthServer {
  return createLocalOAuthServer({ issuer: ISSUER, audience: AUDIENCE, tokenLifetimeSeconds: 900 })
}

/** A tools/call body naming a tool, for the HTTP layer. */
function callBody(id: string, tool: string, text: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      _meta: {
        [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
        [META_KEYS.clientCapabilities]: {},
      },
      name: tool,
      arguments: { text },
    },
  })
}

function requestFor(token: string, tool: string, body: string): HttpRequestDescription {
  return {
    method: 'POST',
    path: '/mcp',
    remoteAddress: '127.0.0.1',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-method': tool === 'tools/list' ? 'tools/list' : 'tools/call',
      'mcp-protocol-version': PROTOCOL_VERSION,
      // The header must name the CALLED tool, or the transport refuses with a
      // header mismatch before any grant check (P26-05).
      'mcp-name': tool,
    },
    body,
  }
}

/** A tools/list body, for the visibility check (H2). */
function listBody(id: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/list',
    params: {
      _meta: {
        [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
        [META_KEYS.clientCapabilities]: {},
      },
    },
  })
}

describe('SEC-04 — two authenticated clients, two grants, one surface (end to end)', () => {
  it('one client calls lang_detect, the other gets the grant refusal; model_tools stays invisible', async () => {
    // The REAL host: its published surface and its wired accounting.
    const ctx = await mountPlugin({})
    const host = ctx.get('model-tools.mcp-host') as McpHost | undefined
    assert.ok(host !== undefined, 'the host must expose its own MCP surface')

    const server = makeOAuth()
    server.upsertClient({ clientId: 'client-a', secret: 'secret-a', scope: ['mcp:call'] })
    server.upsertClient({ clientId: 'client-b', secret: 'secret-b', scope: ['mcp:call'] })
    const tokenA = await server.issueAccessToken('client-a')
    const tokenB = await server.issueAccessToken('client-b')

    const handler = createHttpHandler({
      path: '/mcp',
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      allowedOrigins: [],
      auth: { scheme: 'oauth-resource-server', server, requiredScope: ['mcp:call'] },
      rateLimit: false,
      grants: {
        perClient: {
          // A narrower grant: lang_detect only — stt_transcribe is on the surface
          // and granted to the operator, but NOT to this client (SEC-03).
          'client-a': { allowedTools: ['lang_detect'] },
          // An empty grant permits nothing.
          'client-b': { allowedTools: [] },
        },
      },
    }, host)

    // (d) model_tools never appears on the external surface, whatever the grant.
    const listed = host.listTools().map(tool => tool.name)
    assert.equal(listed.includes('model_tools'), false, 'the management surface stays host-local')
    assert.ok(listed.includes('lang_detect'), `the surface must publish lang_detect, saw: ${listed.join(', ')}`)

    // client-a CAN call lang_detect.
    const aOk = await handler(requestFor(tokenA, 'lang_detect', callBody('a-1', 'lang_detect', 'kann ich das haben')))
    assert.equal(aOk.status, 200, `client-a must be served: ${aOk.body}`)
    const aWire = JSON.parse(aOk.body) as { result?: { structuredContent?: { language?: string } } }
    assert.equal(aWire.result?.structuredContent?.language, 'de', 'the granted call must reach real inference')

    // H2: tools/list is scoped to the CALLER's grant — client-a sees only
    // lang_detect, client-b (empty grant) sees nothing. The grant stays the
    // authority for CALLS; this only narrows what a client is shown.
    const aList = await handler(requestFor(tokenA, 'tools/list', listBody('l-1')))
    assert.equal(aList.status, 200, aList.body)
    const aListWire = JSON.parse(aList.body) as { result?: { tools?: Array<{ name: string }> } }
    assert.deepEqual(
      aListWire.result?.tools?.map(tool => tool.name),
      ['lang_detect'],
      'a narrowed client must see only its granted tools',
    )
    const bList = await handler(requestFor(tokenB, 'tools/list', listBody('l-2')))
    assert.equal(bList.status, 200, bList.body)
    const bListWire = JSON.parse(bList.body) as { result?: { tools?: Array<{ name: string }> } }
    assert.deepEqual(bListWire.result?.tools, [], 'an empty grant shows an empty list')

    // client-a CANNOT call stt_transcribe: granted to the operator, absent from this
    // client's grant — the refusal names the grant (SEC-03).
    const aDenied = await handler(requestFor(tokenA, 'stt_transcribe', callBody('a-2', 'stt_transcribe', 'kann ich das haben')))
    assert.equal(aDenied.status, 200, 'a grant refusal is a tool error, not a protocol error')
    const aDeniedWire = JSON.parse(aDenied.body) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } }
    assert.equal(aDeniedWire.result?.isError, true)
    assert.match(aDeniedWire.result?.content?.[0]?.text ?? '', /not granted to this caller/)

    // client-b's grant is empty: even lang_detect is refused.
    const bDenied = await handler(requestFor(tokenB, 'lang_detect', callBody('b-1', 'lang_detect', 'kann ich das haben')))
    assert.equal(bDenied.status, 200)
    const bDeniedWire = JSON.parse(bDenied.body) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } }
    assert.equal(bDeniedWire.result?.isError, true)
    assert.match(bDeniedWire.result?.content?.[0]?.text ?? '', /not granted to this caller/)

    // An unauthenticated caller never reaches any grant at all.
    const anon = await handler(requestFor('forged-token', 'lang_detect', callBody('x-1', 'lang_detect', 'text')))
    assert.equal(anon.status, 400)

    // The receipts surface names the CLIENT, never the operator (SEC-04).
    const receipts = await callTool(ctx, 'model_tools', { action: 'receipts' })
    assert.equal(receipts.isError, false)
    const external = (receipts.value as { external?: Array<Record<string, unknown>> }).external ?? []
    const aEntry = external.find(entry => entry.clientId === 'client-a')
    assert.ok(aEntry !== undefined, 'the external accounting must record the client identity')
    assert.equal(aEntry.grantId, 'external:client-a', 'the grant recorded is the CLIENT\'s, not local-interactive')
    assert.equal(external.some(entry => entry.grantId === 'local-interactive'), false, 'no external entry may claim the operator identity')
  })
})

describe('SEC-04 — composition honors the CLIENT grant (H1)', () => {
  /** Load the Node PTC backend and the DSH service stack it mounts into. */
  async function loadBackend() {
    try {
      const backendModule = await import('@deepseek-ai/dsh-ptc-runtime-node') as {
        NodePtcRuntime?: unknown
        default?: unknown
      }
      // The SAME service stack the composition suite mounts for the backend: the
      // runtime injects session-projection, fs-local, subprocess-local and
      // sandbox-local services, and an empty context cannot provide them.
      const [{ Context }, sessionProjection, fsLocal, subprocessLocal, sandboxLocal, sandboxPolicy] =
        await Promise.all([
          import('@deepseek-ai/cordis'),
          import('@deepseek-ai/dsh-session-projection'),
          import('@deepseek-ai/dsh-fs-local'),
          import('@deepseek-ai/dsh-subprocess-local'),
          import('@deepseek-ai/dsh-sandbox-local'),
          import('@deepseek-ai/dsh-sandbox-policy'),
        ])
      const plugins = [
        (sessionProjection as { default?: unknown }).default ?? sessionProjection,
        (fsLocal as { default?: unknown }).default ?? fsLocal,
        (subprocessLocal as { default?: unknown }).default ?? subprocessLocal,
        (sandboxLocal as { default?: unknown }).default ?? sandboxLocal,
      ]
      return {
        backend: backendModule.NodePtcRuntime ?? backendModule.default,
        buildRuntimeContext: async () => {
          const ctx = new (Context as new () => {
            plugin(plugin: unknown, config?: unknown): Promise<unknown>
            get(name: string): unknown
          })()
          for (const plugin of plugins) await ctx.plugin(plugin)
          const policy = (sandboxPolicy as { default?: unknown }).default ?? sandboxPolicy
          await ctx.plugin(policy, { mode: 'danger-full-access' })
          await mountPtcRuntimeIfAbsent(ctx as never, backendModule.NodePtcRuntime ?? backendModule.default, {
            timeoutMs: 30_000,
            maxTimeoutMs: 60_000,
          })
          return ctx
        },
      }
    } catch (error) {
      return { unavailable: error instanceof Error ? error.message : String(error) }
    }
  }

  it('a tool_mode_run-only client cannot compose host-granted tools through a program', async () => {
    const loaded = await loadBackend()
    if ('unavailable' in loaded) {
      // The backend is a deployment fact (EXT-19); without it the composition path
      // cannot run, which is not the subject of this test.
      assert.equal(typeof loaded.unavailable, 'string')
      return
    }
    // The REAL plugin registry (lang_detect et al.) for resolve and visibility...
    const ctx = await mountPlugin({})
    // ...and a context carrying the backend's own service stack for the runtime.
    const runtimeCtx = await loaded.buildRuntimeContext()
    assert.ok(runtimeCtx.get(PTC_SERVICE) !== undefined, 'the runtime service must be present')

    // The SAME wiring the host uses (index.ts): the grant is read PER RUN from the
    // external-grant context, falling back to the host's own grant on the native path.
    const grants = createExternalGrantContext()
    const runner = createProgramRunner({
      context: runtimeCtx as never,
      backend: loaded.backend,
      grant: () => grants.current() ?? ['lang_detect', 'stt_transcribe'],
      visible: () => ctx.tools.schemas().map(schema => schema.name),
      resolve: name => async (args: Record<string, unknown>) => {
        const result = await ctx.tools.execute({
          signal: new AbortController().signal,
          callId: `h1_${name}_${Date.now().toString(36)}` as never,
          name,
          arguments: args,
        })
        if (result.isError) throw new Error(result.error?.message ?? `${name} failed`)
        return result.value
      },
      runtime: () => runtimeCtx.get(PTC_SERVICE) as never,
      operatorGranted: () => true,
    })

    const program = {
      description: 'probe the composition gate',
      code: 'const r = await tools.lang_detect({ text: "kann ich das haben" }); return r.language;',
      tools: ['lang_detect'],
    }

    // The external caller's grant is tool_mode_run ONLY: the program's sub-call to
    // lang_detect must be refused in the grant vocabulary (SEC-03 stays the
    // authority through composition).
    await assert.rejects(
      grants.run(['tool_mode_run'], () => serveProgram(program, runner, {
        receiptId: 'rcpt_h1_external', catalogRevision: '1',
      })),
      /lang_detect: forbidden|not granted/i,
      'a client granted only tool_mode_run must not reach host-granted tools through a program',
    )

    // The host/interactive path (no grant context) runs the SAME program for real.
    const report = await serveProgram(program, runner, { receiptId: 'rcpt_h1_host', catalogRevision: '1' })
    assert.equal(report.result, 'de', 'the host path must still run the program and reach real inference')
    assert.equal(report.meta.toolCalls, 1)
  })
})
