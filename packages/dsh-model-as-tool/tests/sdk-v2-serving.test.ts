import { after, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { STANDARD_CONTRACTS } from '@try-works/tool-mode-contracts'
import { createMcpHost, type HostSurface } from '../src/mcp/host-binding.ts'
import { createHttpHandler, startHttpServer, type HttpTransportConfig } from '../src/mcp/http.ts'
import { cleanup, mountPlugin } from './helpers.ts'

const TOKEN = 'sdk-v2-serving-token'
const config: HttpTransportConfig = {
  path: '/mcp', host: '127.0.0.1', port: 0, maxBodyBytes: 1024 * 1024,
  allowedOrigins: [], rateLimit: false,
  auth: { scheme: 'static-token', token: TOKEN, clientId: 'narrow-client' },
  grants: { perClient: { 'narrow-client': { allowedTools: ['lang_detect'] } } },
}
const metadata = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'direct-first-call', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
}
after(async () => { await cleanup() })

async function realHost() {
  const ctx = await mountPlugin({})
  const names = new Set(ctx.tools.schemas().map(schema => schema.name))
  const observed: Array<{ clientId: string; grantId: string; allowedTools: readonly string[] }> = []
  const accounted: unknown[] = []
  const surface: HostSurface = {
    published: STANDARD_CONTRACTS.filter(contract => names.has(contract.toolName))
      .map(contract => ({ toolName: contract.toolName, contract })),
    async execute({ name, arguments: args, caller, signal, callId }) {
      assert.ok(caller, 'verified ExternalCaller must reach business execution')
      observed.push(caller)
      assert.ok(caller.allowedTools.includes(name), 'business execution is within narrowed grant')
      const result = await ctx.tools.execute({ name, arguments: args, signal, callId: callId as never })
      return result.isError
        ? { isError: true, message: result.error?.message ?? 'tool failed' }
        : { isError: false, value: result.value }
    },
  }
  const host = createMcpHost({ surface, serverInfo: { name: 'sdk-serving-test', version: '1' },
    onAccounted: record => accounted.push(record) })
  return { host, observed, accounted }
}

describe('official SDK v2 is the production HTTP server', { concurrency: false }, () => {
  it('official modern client -> production socket -> official McpServer -> real lang_detect and accounting', async () => {
    const { host, observed, accounted } = await realHost()
    // An export check cannot satisfy this: this spies on the SDK SERVER's actual
    // registration method as requests travel through the production endpoint.
    let sdkToolExecutions = 0
    const originalRegister = McpServer.prototype.registerTool
    const registration = mock.method(McpServer.prototype, 'registerTool', function (this: McpServer, name: string, options: any, callback: any) {
      return originalRegister.call(this, name, options, async (...args: any[]) => {
        sdkToolExecutions++
        return callback(...args)
      })
    })
    const endpoint = await startHttpServer(config, host)
    const client = new Client({ name: 'official-modern', version: '1' }, {
      capabilities: {}, versionNegotiation: { mode: 'auto' },
    })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }))
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['lang_detect'])
      const result = await client.callTool({ name: 'lang_detect', arguments: { text: 'kann ich das haben' } })
      assert.equal(result.structuredContent?.language, 'de')
      assert.ok(registration.mock.callCount() >= 3, 'official McpServer instantiated per request')
      assert.equal(sdkToolExecutions, 1, 'official SDK invokes the registered tool callback')
      assert.equal(observed.length, 1)
      assert.equal(observed[0]?.clientId, 'narrow-client')
      assert.equal(observed[0]?.grantId, 'external:narrow-client')
      assert.equal(accounted.length, 1, 'existing host binding records real invocation')
      // SDK uses a protocol InvalidParams error for an unregistered (withheld)
      // tool, unlike the former handwritten dispatch's isError tool result.
      await assert.rejects(client.callTool({ name: 'embed_text', arguments: { text: 'hello' } }),
        /Tool embed_text not found/)
      assert.equal(observed.length, 1, 'non-granted tool never executes')
    } finally {
      registration.mock.restore()
      await client.close()
      await endpoint.close()
    }
  })

  it('first application request works without initialize, discover, or session', async () => {
    const { host, observed } = await realHost()
    const handler = createHttpHandler(config, host)
    const response = await handler({
      method: 'POST', path: '/mcp', remoteAddress: '127.0.0.1',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call', 'mcp-name': 'lang_detect' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {
        name: 'lang_detect', arguments: { text: 'kann ich das haben' }, _meta: metadata,
      } }),
    })
    assert.equal(response.status, 200, response.body)
    assert.equal(JSON.parse(response.body).result.structuredContent.language, 'de')
    assert.equal(response.headers['mcp-session-id'], undefined)
    assert.equal(observed.length, 1)
  })

  it('authentication, Host, Origin, body-size and rate-limit gates precede SDK construction', async () => {
    const { host } = await realHost()
    const registration = mock.method(McpServer.prototype, 'registerTool')
    const request = { method: 'POST', path: '/mcp', remoteAddress: '127.0.0.1',
      body: '{}', headers: {} as Record<string, string> }
    try {
      assert.equal((await createHttpHandler(config, host)(request)).status, 401)
      assert.equal((await createHttpHandler(config, host)({ ...request,
        headers: { authorization: `Bearer ${TOKEN}`, host: 'evil.invalid' } })).status, 403)
      assert.equal((await createHttpHandler(config, host)({ ...request,
        headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.invalid' } })).status, 403)
      assert.equal((await createHttpHandler({ ...config, maxBodyBytes: 1 }, host)(request)).status, 413)
      const limited = createHttpHandler({ ...config, rateLimit: { maxRequests: 1, windowMs: 60000, maxClients: 16 } }, host)
      const invalid = { ...request, headers: { authorization: `Bearer ${TOKEN}` }, body: 'bad-json' }
      assert.equal((await limited(invalid)).status, 400)
      assert.equal((await limited(invalid)).status, 429)
      assert.equal(registration.mock.callCount(), 0)
    } finally { registration.mock.restore() }
  })

  it('refuses standalone notifications explicitly instead of silently discarding them', async () => {
    const { host } = await realHost()
    const response = await createHttpHandler(config, host)({
      method: 'POST', path: '/mcp', remoteAddress: '127.0.0.1',
      headers: { authorization: `Bearer ${TOKEN}`, 'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'notifications/initialized' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    assert.equal(response.status, 400)
    assert.match(response.body, /does not accept standalone notifications/)
  })
})
