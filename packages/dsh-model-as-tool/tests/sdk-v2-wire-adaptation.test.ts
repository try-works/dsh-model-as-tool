import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it, mock } from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import { McpServer } from '@modelcontextprotocol/server'
import { createHttpHandler, type HttpRequestDescription, type HttpTransportConfig } from '../src/mcp/http.ts'
import { META_KEYS, PROTOCOL_VERSION } from '../src/mcp/protocol.ts'
import { createMcpHost } from '../src/mcp/host-binding.ts'
import { STANDARD_CONTRACTS } from '@try-works/tool-mode-contracts'
import type { McpHost, McpToolDefinition } from '../src/mcp/server.ts'

const config: HttpTransportConfig = {
  path: '/mcp', host: '127.0.0.1', port: 0, maxBodyBytes: 1024 * 1024,
  allowedOrigins: [], rateLimit: false,
  auth: { scheme: 'static-token', token: 'wire-token', clientId: 'wire-client' },
}
const meta = { [META_KEYS.protocolVersion]: PROTOCOL_VERSION, [META_KEYS.clientCapabilities]: {} }
const definition: McpToolDefinition = {
  name: 'echo', description: 'Echo', importedFromMcp: false,
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
}
const host: McpHost = {
  serverInfo: { name: 'wire-test', version: '1' }, listTools: () => [definition],
  async callTool(_name, args) { return { text: String(args.text), structured: { text: args.text } } },
}
function request(method = 'tools/list', params: Record<string, unknown> = {}, headers: Record<string, string> = {}): HttpRequestDescription {
  return { method: 'POST', path: '/mcp', remoteAddress: '127.0.0.1',
    headers: { authorization: 'Bearer wire-token', 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': method, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { _meta: meta, ...params } }),
  }
}
const schema = JSON.parse(readFileSync('docs/tool-mode/specs/mcp-2026-07-28/schema.json', 'utf8'))
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
ajv.addSchema(schema, 'official2026')
function pinned(name: string, value: unknown) {
  const validate = ajv.compile({ $ref: `official2026#/$defs/${name}` })
  assert.equal(validate(value), true, JSON.stringify(validate.errors))
}
const sentinel = (value: string) => `=?base64?${Buffer.from(value).toString('base64')}?=`

describe('official SDK wire adaptations preserve the published boundary', { concurrency: false }, () => {
  it('requires the pinned method header before SDK execution; valid calls use SDK registration', async () => {
    const handler = createHttpHandler(config, host)
    let executed = 0
    const original = McpServer.prototype.registerTool
    const registration = mock.method(McpServer.prototype, 'registerTool', function (this: McpServer, name: string, options: any, callback: any) {
      return original.call(this, name, options, async (...args: any[]) => { executed++; return callback(...args) })
    })
    try {
      const call = request('tools/call', { name: 'echo', arguments: { text: 'ok' } }, { 'mcp-name': 'echo' })
      const { 'mcp-method': _omitted, ...headers } = call.headers
      const omitted = await handler({ ...call, headers })
      assert.equal(omitted.status, 400, omitted.body)
      assert.equal(JSON.parse(omitted.body).error.code, -32020)
      assert.equal(executed, 0, 'missing required headers must fail before inference')
      const response = await handler(call)
      assert.equal(response.status, 200, response.body)
      assert.equal(JSON.parse(response.body).result.structuredContent.text, 'ok')
      assert.equal(executed, 1)
      const mismatch = await handler({ ...call, headers: { ...call.headers, 'mcp-method': 'tools/list' } })
      assert.equal(mismatch.status, 400)
      assert.equal(JSON.parse(mismatch.body).error.code, -32020)
      const invalid = await handler({ ...call, headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 4 }) })
      assert.equal(invalid.status, 400)
      assert.equal(executed, 1)
    } finally { registration.mock.restore() }
  })

  it('decodes sentinel method/version before SDK comparison and preserves encoded names', async () => {
    const response = await createHttpHandler(config, host)(request('tools/call', {
      name: 'echo', arguments: { text: 'ok' },
    }, { 'mcp-method': sentinel('tools/call'), 'mcp-protocol-version': sentinel(PROTOCOL_VERSION), 'mcp-name': sentinel('echo') }))
    assert.equal(response.status, 200, response.body)
    assert.equal(JSON.parse(response.body).result.structuredContent.text, 'ok')
    const mismatch = await createHttpHandler(config, host)(request('tools/list', {}, { 'mcp-method': sentinel('tools/call') }))
    assert.equal(mismatch.status, 400)
    assert.equal(JSON.parse(mismatch.body).error.code, -32020)
  })

  it('preserves finite SSE mid-call notifications before the final SDK response', async () => {
    const original = McpServer.prototype.registerTool
    const registration = mock.method(McpServer.prototype, 'registerTool', function (this: McpServer, name: string, options: any, callback: any) {
      return original.call(this, name, options, async (args: any, ctx: any) => {
        await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 'wire-progress', progress: 1 } })
        return callback(args, ctx)
      })
    })
    try {
      const response = await createHttpHandler(config, host)(request('tools/call', {
        name: 'echo', arguments: { text: 'ok' },
      }, { 'mcp-name': 'echo' }))
      assert.equal(response.status, 200, response.body)
      assert.match(response.headers['content-type'] ?? '', /text\/event-stream/)
      const messages = response.body.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
      assert.equal(messages[0].method, 'notifications/progress')
      assert.equal(messages.at(-1).result.structuredContent.text, 'ok')
    } finally { registration.mock.restore() }
  })

  it('keeps SDK sentinel decoding for non-ASCII and literal-sentinel tool names', async () => {
    for (const name of ['你好', '=?base64?literal?=']) {
      const namedHost: McpHost = { ...host, listTools: () => [{ ...definition, name }] }
      const response = await createHttpHandler(config, namedHost)(request('tools/call', {
        name, arguments: { text: 'ok' },
      }, { 'mcp-name': sentinel(name) }))
      assert.equal(response.status, 200, response.body)
      assert.equal(JSON.parse(response.body).result.structuredContent.text, 'ok')
    }
  })

  it('rejects missing/malformed metadata as HTTP400 InvalidParams before SDK construction', async () => {
    const registration = mock.method(McpServer.prototype, 'registerTool')
    try {
      for (const invalidMeta of [undefined, {}, { ...meta, [META_KEYS.clientCapabilities]: [] }, { ...meta, [META_KEYS.clientInfo]: { name: 'no-version' } }]) {
        const response = await createHttpHandler(config, host)(request('tools/list', { _meta: invalidMeta }))
        assert.equal(response.status, 400, response.body)
        assert.equal(JSON.parse(response.body).error.code, -32602)
      }
      assert.equal(registration.mock.callCount(), 0)
    } finally { registration.mock.restore() }
  })

  it('keeps clientInfo optional and returns the exact pinned unsupported-version shape and HTTP400', async () => {
    const handler = createHttpHandler(config, host)
    assert.equal((await handler(request())).status, 200)
    const response = await handler(request('tools/list', { _meta: { ...meta, [META_KEYS.protocolVersion]: '2099-01-01' } }, { 'mcp-protocol-version': '2099-01-01' }))
    assert.equal(response.status, 400)
    const body = JSON.parse(response.body)
    assert.deepEqual(body.error.data, { supported: [PROTOCOL_VERSION], requested: '2099-01-01' })
    pinned('UnsupportedProtocolVersionError', body)
  })

  it('enforces the published required-capability extension before SDK with pinned error data', async () => {
    const response = await createHttpHandler(config, host)(request('tools/list', {
      _meta: { ...meta, [META_KEYS.clientCapabilities]: { required: ['sampling', 'subscriptions/listen'] } },
    }))
    assert.equal(response.status, 400, response.body)
    const body = JSON.parse(response.body)
    assert.equal(body.error.code, -32021)
    assert.deepEqual(body.error.data.requiredCapabilities, { sampling: {}, 'subscriptions/listen': {} })
    pinned('MissingRequiredClientCapabilityError', body)
  })

  it('does not advertise subscriptions and keeps empty granted tools/list functional', async () => {
    const handler = createHttpHandler({ ...config, grants: { perClient: { 'wire-client': { allowedTools: [] } } } }, host)
    const list = await handler(request())
    assert.equal(list.status, 200, list.body)
    assert.deepEqual(JSON.parse(list.body).result.tools, [])
    const discover = await handler(request('server/discover'))
    assert.equal(JSON.parse(discover.body).result.capabilities.tools.listChanged, false)
    const listen = await handler(request('subscriptions/listen'))
    assert.equal(JSON.parse(listen.body).error.code, -32601)
  })

  it('refuses initialize, unsupported/stdio notifications and response messages without dropping them', async () => {
    const handler = createHttpHandler(config, host)
    const initialize = await handler(request('initialize'))
    assert.notEqual(initialize.status, 200, initialize.body)
    for (const method of ['notifications/initialized', 'notifications/cancelled', 'notifications/extension']) {
      const notification = request(method)
      const body = JSON.parse(notification.body); delete body.id
      const response = await handler({ ...notification, body: JSON.stringify(body) })
      assert.equal(response.status, 400)
      assert.match(response.body, /does not accept standalone notifications/)
    }
    assert.equal((await handler({ ...request(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })).status, 400)
  })

  it('routes known ungranted calls through shared host denial/accounting without registering or listing them', async () => {
    let businessExecutions = 0
    const accounted: unknown[] = []
    const contract = STANDARD_CONTRACTS.find(item => item.toolName === 'lang_detect')!
    const bound = createMcpHost({ serverInfo: host.serverInfo,
      surface: { published: [{ toolName: 'lang_detect', contract }], async execute({ name, caller }) {
        // Like the production HostSurface, the shared host execution boundary
        // applies the authenticated grant before entering model business logic.
        if (caller !== undefined && !caller.allowedTools.includes(name)) {
          return { isError: true, message: 'external grant does not allow this tool' }
        }
        businessExecutions++; return { isError: false, value: { language: 'de' } }
      } }, onAccounted: record => accounted.push(record),
    })
    const handler = createHttpHandler({ ...config, grants: { perClient: { 'wire-client': { allowedTools: [] } } } }, bound)
    const registration = mock.method(McpServer.prototype, 'registerTool')
    try {
      assert.deepEqual(JSON.parse((await handler(request())).body).result.tools, [])
      const response = await handler(request('tools/call', { name: 'lang_detect', arguments: { text: 'Hallo' } }, { 'mcp-name': 'lang_detect' }))
      assert.equal(response.status, 200, response.body)
      const body = JSON.parse(response.body)
      assert.equal(body.error, undefined)
      assert.equal(body.result.isError, true)
      assert.equal(body.result.resultType, 'complete')
      pinned('CallToolResult', body.result)
      assert.equal(registration.mock.callCount(), 0)
      assert.equal(businessExecutions, 0)
      assert.equal(accounted.length, 1)
      const unknown = await handler(request('tools/call', { name: 'unknown', arguments: {} }, { 'mcp-name': 'unknown' }))
      assert.equal(JSON.parse(unknown.body).error.code, -32602)
      assert.equal(accounted.length, 1)
    } finally { registration.mock.restore() }
  })
})
