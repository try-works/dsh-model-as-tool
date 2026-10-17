import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { describe, it, mock } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { McpServer } from '@modelcontextprotocol/server'
import { createHttpHandler, createHttpStreamHandler, startHttpServer, type HttpTransportConfig } from '../src/mcp/http.ts'
import { META_KEYS, PROTOCOL_VERSION } from '../src/mcp/protocol.ts'
import type { McpHost } from '../src/mcp/server.ts'

const config: HttpTransportConfig = {
  path: '/mcp', host: '127.0.0.1', port: 0, maxBodyBytes: 4096, allowedOrigins: [], rateLimit: false,
  auth: { scheme: 'static-token', token: 'stream-token', clientId: 'stream-client' },
}
const headers = {
  authorization: 'Bearer stream-token', 'content-type': 'application/json',
  accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION,
  'mcp-method': 'tools/call', 'mcp-name': 'echo',
}
const body = JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: {
  name: 'echo', arguments: { text: 'ok' }, _meta: {
    [META_KEYS.protocolVersion]: PROTOCOL_VERSION, [META_KEYS.clientCapabilities]: {},
  },
} })
const description = { method: 'POST', path: '/mcp', remoteAddress: '127.0.0.1', headers, body }
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function makeHost(call?: McpHost['callTool']): McpHost {
  return {
    serverInfo: { name: 'stream-test', version: '1' },
    listTools: () => [{ name: 'echo', description: 'Echo', importedFromMcp: false,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
    callTool: call ?? (async (_name, args) => ({ text: String(args.text), structured: { text: args.text } })),
  }
}
function progressBeforeCallback() {
  const original = McpServer.prototype.registerTool
  return mock.method(McpServer.prototype, 'registerTool', function (this: McpServer, name: string, options: any, callback: any) {
    return original.call(this, name, options, async (args: any, ctx: any) => {
      await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 'live', progress: 1 } })
      return callback(args, ctx)
    })
  })
}

// Every wait is bounded by the test timeout, not a timing-based streaming claim.
describe('production SDK v2 streaming and disconnect cancellation', { concurrency: false, timeout: 10000 }, () => {
  it('real socket delivers progress BEFORE deliberately released final completion, without a session', async () => {
    const release = deferred()
    const dispatched = deferred()
    let finished = false
    const host = makeHost(async (_name, args, signal, caller) => {
      assert.equal(caller?.clientId, 'stream-client')
      assert.equal(signal?.aborted, false)
      dispatched.resolve()
      await release.promise
      finished = true
      return { text: 'ok', structured: { text: args.text } }
    })
    const registration = progressBeforeCallback()
    const endpoint = await startHttpServer(config, host)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await fetch(endpoint.url, { method: 'POST', headers, body })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
      assert.equal(response.headers.get('mcp-session-id'), null)
      reader = response.body!.getReader()
      const first = new TextDecoder().decode((await reader.read()).value)
      assert.match(first, /notifications\/progress/)
      await dispatched.promise
      assert.equal(finished, false, 'progress was not buffered until final completion')
      assert.doesNotMatch(first, /structuredContent/)
      release.resolve()
      let remainder = ''
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        remainder += new TextDecoder().decode(next.value)
      }
      assert.match(remainder, /structuredContent/)
      assert.equal(finished, true)
    } finally {
      release.resolve()
      await reader?.cancel().catch(() => {})
      registration.mock.restore()
      await endpoint.close()
    }
  })

  for (const progress of [false, true]) {
    it(`client disconnect AFTER dispatch aborts host work ${progress ? 'during SSE' : 'before response headers'}; next request works`, async () => {
      const dispatched = deferred()
      const stopped = deferred()
      let executions = 0
      let finals = 0
      let hostSignal: AbortSignal | undefined
      const host = makeHost(async (_name, args, signal) => {
        executions++
        if (executions > 1) return { text: 'ok', structured: { text: args.text } }
        hostSignal = signal
        dispatched.resolve()
        try {
          await delay(60000, undefined, { signal })
          finals++
          return { text: 'should not finish', structured: { text: 'wrong' } }
        } finally { stopped.resolve() }
      })
      const registration = progress ? progressBeforeCallback() : undefined
      const endpoint = await startHttpServer(config, host)
      const abort = new AbortController()
      let response: Response | undefined
      const pending = fetch(endpoint.url, { method: 'POST', headers, body, signal: abort.signal })
      // Observe the pre-headers fetch rejection immediately, avoiding an unhandled rejection.
      const fetched = pending.then(value => { response = value }, error => {
        assert.equal(abort.signal.aborted, true)
        assert.ok(error)
      })
      try {
        await dispatched.promise
        if (progress) {
          await fetched
          assert.match(new TextDecoder().decode((await response!.body!.getReader().read()).value), /notifications\/progress/)
        }
        abort.abort()
        await stopped.promise
        await fetched
        assert.equal(hostSignal?.aborted, true)
        assert.equal(finals, 0, 'cancelled business work never produces a final result')
        const next = await fetch(endpoint.url, { method: 'POST', headers, body })
        assert.equal(next.status, 200)
        assert.match(await next.text(), /structuredContent/)
        assert.equal(executions, 2)
      } finally {
        abort.abort()
        registration?.mock.restore()
        await endpoint.close()
      }
    })
  }

  it('real socket refuses invalid credentials, rate and oversize bytes before SDK callback', async () => {
    let executions = 0
    const host = makeHost(async () => { executions++; return { text: 'ok', structured: { text: 'ok' } } })
    const registration = mock.method(McpServer.prototype, 'registerTool')
    const endpoint = await startHttpServer({ ...config, rateLimit: { maxRequests: 1, windowMs: 60000, maxClients: 8 } }, host)
    try {
      const invalid = await fetch(endpoint.url, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' }, body })
      assert.equal(invalid.status, 401); await invalid.text()
      // Authenticated invalid JSON consumes the first rate slot without constructing SDK.
      const first = await fetch(endpoint.url, { method: 'POST', headers, body: 'invalid' })
      assert.equal(first.status, 400); await first.text()
      const limited = await fetch(endpoint.url, { method: 'POST', headers, body })
      assert.equal(limited.status, 429); await limited.text()
      const large = await fetch(endpoint.url, { method: 'POST', headers, body: 'x'.repeat(config.maxBodyBytes + 1) })
      assert.equal(large.status, 413)
      const refusal = await large.json() as any
      assert.equal(refusal.id, undefined)
      assert.equal(refusal.error.code, -32600)
      assert.equal(executions, 0)
      assert.equal(registration.mock.callCount(), 0)
    } finally { registration.mock.restore(); await endpoint.close() }
  })

  it('finite facade still materializes SSE, while stream-reader cancel stops host work', async () => {
    const registration = progressBeforeCallback()
    try {
      const finite = await createHttpHandler(config, makeHost())(description)
      assert.match(finite.body, /notifications\/progress/)
      assert.match(finite.body, /structuredContent/)
      const stopped = deferred()
      const dispatched = deferred()
      let signal: AbortSignal | undefined
      const response = await createHttpStreamHandler(config, makeHost(async (_name, _args, received) => {
        signal = received; dispatched.resolve()
        try { await delay(60000, undefined, { signal: received }) }
        finally { stopped.resolve() }
        return { text: 'never', structured: {} }
      }))(description)
      const reader = response.body!.getReader()
      await reader.read()
      await dispatched.promise
      await reader.cancel('consumer stopped')
      await stopped.promise
      assert.equal(signal?.aborted, true)
    } finally { registration.mock.restore() }
  })

  it('endpoint close aborts outstanding work and does not wait indefinitely for listener close', async () => {
    const dispatched = deferred()
    const stopped = deferred()
    const endpoint = await startHttpServer(config, makeHost(async (_name, _args, signal) => {
      dispatched.resolve()
      try { await delay(60000, undefined, { signal }) } finally { stopped.resolve() }
      return { text: 'never', structured: {} }
    }))
    const pending = fetch(endpoint.url, { method: 'POST', headers, body }).catch(() => undefined)
    try {
      await dispatched.promise
      await endpoint.close()
      await stopped.promise
      await pending
    } finally { await endpoint.close().catch(() => {}) }
  })

  it('truncated incoming upload is cleaned up and never enters SDK', async () => {
    let executions = 0
    const endpoint = await startHttpServer(config, makeHost(async () => { executions++; return { text: '', structured: {} } }))
    try {
      await new Promise<void>(resolve => {
        const req = httpRequest(endpoint.url, { method: 'POST', headers: { ...headers, 'content-length': String(body.length + 100) } })
        req.on('error', () => {})
        req.on('socket', socket => {
          socket.once('connect', () => { req.write(body.slice(0, 20)); req.destroy(); resolve() })
        })
      })
      const next = await fetch(endpoint.url, { method: 'POST', headers, body })
      assert.equal(next.status, 200); await next.text()
      assert.equal(executions, 1)
    } finally { await endpoint.close() }
  })
})
