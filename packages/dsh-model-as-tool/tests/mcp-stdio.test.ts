/**
 * Stdio bridge tests (MCP-03, P26-05, P26-06, P26-08).
 *
 * The bridge is driven through its library entry with an injected request function
 * and two captured sinks. That shape is what lets the tests assert the property
 * that matters most — that a diagnostic NEVER reaches the protocol channel — by
 * checking the two sinks separately, which a single "output" stream could not show.
 *
 * Requirement links: MCP-03, P26-05, P26-06, P26-08.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'node:fs'

import { createStdioBridge, headersFor, type BridgeEndpoint } from '../src/mcp/stdio.ts'
import { META_KEYS, PROTOCOL_VERSION, type WireRequest } from '../src/mcp/protocol.ts'

/** A request function that records what it was asked and replies from a script. */
function makeEndpoint(replies: {
  status?: number
  body?: string
  /** Delay before replying, so cancellation can be raced. */
  delayMs?: number
  /** Fail instead of replying. */
  fail?: Error
} = {}) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = []
  const signals: AbortSignal[] = []
  const endpoint: BridgeEndpoint = {
    url: 'http://127.0.0.1:3765/mcp',
    token: 'bridge-token',
    async fetch(url, init) {
      calls.push({ url, headers: init.headers, body: init.body })
      signals.push(init.signal)
      if (replies.fail !== undefined) throw replies.fail
      if (replies.delayMs !== undefined) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, replies.delayMs)
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('aborted'))
          })
        })
      }
      return {
        status: replies.status ?? 200,
        headers: { 'content-type': 'application/json' },
        body: replies.body ?? JSON.stringify({ jsonrpc: '2.0', id: 'r1', result: { resultType: 'complete' } }),
      }
    },
  }
  return { endpoint, calls, signals }
}

/** Capture both sinks separately. */
function capture() {
  const protocol: string[] = []
  const diagnostics: string[] = []
  return { protocol, diagnostics, io: { protocol: (l: string) => protocol.push(l), diagnostic: (l: string) => diagnostics.push(l) } }
}

/** A modern request line. */
function line(request: Partial<WireRequest> & { method: string }): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 'r1',
    ...request,
    params: {
      ...request.params,
      _meta: {
        [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
        [META_KEYS.clientInfo]: { name: 'stdio-test', version: '1.0.0' },
        [META_KEYS.clientCapabilities]: {},
        ...(request.params?._meta as Record<string, unknown> | undefined),
      },
    },
  })
}

describe('P26-05 — the bridge generates the modern headers', () => {
  it('derives version, method and name from the body', () => {
    const call = JSON.parse(line({
      method: 'tools/call',
      params: { name: 'describe_image', arguments: {} },
    })) as WireRequest
    const headers = headersFor(call, 'tok')
    assert.equal(headers['mcp-method'], 'tools/call')
    assert.equal(headers['mcp-name'], 'describe_image')
    assert.equal(headers['mcp-protocol-version'], PROTOCOL_VERSION)
    assert.equal(headers.authorization, 'Bearer tok')
    assert.equal(headers['content-type'], 'application/json')
  })

  it('omits Mcp-Name for tools/list, which has no name', () => {
    const call = JSON.parse(line({ method: 'tools/list' })) as WireRequest
    // Sending an empty Mcp-Name would fail the endpoint's header check.
    assert.equal('mcp-name' in headersFor(call, 'tok'), false)
  })

  it('takes the version from the BODY rather than relabelling it', () => {
    const legacy = {
      jsonrpc: '2.0' as const,
      id: 'x',
      method: 'tools/list',
      params: { _meta: { [META_KEYS.protocolVersion]: '2025-11-25' } },
    }
    // Relabelling to the supported version would hide the mismatch from the
    // endpoint instead of letting it refuse the request.
    assert.equal(headersFor(legacy, 'tok')['mcp-protocol-version'], '2025-11-25')
  })
})

describe('MCP-03 / P26-08 — the two channels stay separate', () => {
  it('a success writes exactly one protocol frame and no diagnostic', async () => {
    const { endpoint } = makeEndpoint()
    const { protocol, diagnostics, io } = capture()
    const bridge = createStdioBridge(endpoint, io)
    const output = await bridge.handleLine(line({ method: 'tools/list' }))
    assert.ok(output, 'a response must be emitted')
    assert.equal(protocol.length, 0, 'the library returns the frame; the executable writes it')
    assert.deepEqual(diagnostics, [])
  })

  it('a transport failure produces BOTH a diagnostic and a protocol error', async () => {
    const { endpoint } = makeEndpoint({ fail: new Error('connection refused') })
    const { diagnostics, io } = capture()
    const bridge = createStdioBridge(endpoint, io)
    const output = await bridge.handleLine(line({ method: 'tools/list' }))
    // The diagnostic explains it to a human; the protocol error stops the CLIENT
    // waiting for a response that would otherwise never come.
    assert.match(diagnostics.join('\n'), /request to the endpoint failed: connection refused/)
    assert.ok(output, 'a client must not be left waiting because the failure was transport')
    assert.match(String(output), /-32603/)
  })

  it('a non-JSON-RPC error body is reported on both channels', async () => {
    const { endpoint } = makeEndpoint({ status: 502, body: '<html>bad gateway</html>' })
    const { diagnostics, io } = capture()
    const bridge = createStdioBridge(endpoint, io)
    const output = await bridge.handleLine(line({ method: 'tools/list' }))
    assert.match(diagnostics.join('\n'), /HTTP 502/)
    assert.match(String(output), /HTTP 502/)
  })

  it('forwards a JSON-RPC error body verbatim', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'r1', error: { code: -32020, message: 'header mismatch' } })
    const { endpoint } = makeEndpoint({ status: 400, body })
    const { io } = capture()
    const bridge = createStdioBridge(endpoint, io)
    // A well-formed protocol error is the client's to interpret, so it is forwarded
    // rather than being turned into a bridge diagnostic.
    assert.deepEqual(JSON.parse(String(await bridge.handleLine(line({ method: 'tools/list' })))), JSON.parse(body))
  })

  it('a malformed frame is answered on the PROTOCOL channel', async () => {
    const { endpoint } = makeEndpoint()
    const { diagnostics, io } = capture()
    const bridge = createStdioBridge(endpoint, io)
    const output = await bridge.handleLine('{not json')
    assert.match(String(output), /-32700/)
    assert.deepEqual(diagnostics, [], 'the client is waiting for a reply, so a diagnostic would not reach it')
  })

  it('ignores a blank line without emitting anything', async () => {
    const { endpoint, calls } = makeEndpoint()
    const { io } = capture()
    const bridge = createStdioBridge(endpoint, io)
    assert.equal(await bridge.handleLine('   '), undefined)
    assert.equal(calls.length, 0, 'a keep-alive must not become a request')
  })
})

describe('P26-08 — the body is forwarded verbatim', () => {
  it('preserves the request id and the per-request metadata exactly', async () => {
    const { endpoint, calls } = makeEndpoint()
    const { io } = capture()
    const bridge = createStdioBridge(endpoint, io)
    const original = line({ method: 'tools/list', id: 'conversation-42' })
    await bridge.handleLine(original)
    // The bridge regenerates only the HEADERS; everything else survives byte for
    // byte, so ids and metadata cannot drift between the two hops.
    assert.equal(calls[0]?.body, original)
    const parsed = JSON.parse(calls[0]?.body ?? '{}') as WireRequest
    assert.equal(parsed.id, 'conversation-42')
    assert.deepEqual(
      (parsed.params?._meta as Record<string, unknown>)[META_KEYS.clientInfo],
      { name: 'stdio-test', version: '1.0.0' },
    )
  })

  it('posts to the configured endpoint', async () => {
    const { endpoint, calls } = makeEndpoint()
    const { io } = capture()
    await createStdioBridge(endpoint, io).handleLine(line({ method: 'tools/list' }))
    assert.equal(calls[0]?.url, 'http://127.0.0.1:3765/mcp')
  })

  it('a notification gets no response frame', async () => {
    const { endpoint } = makeEndpoint({ status: 202, body: '' })
    const { io } = capture()
    const bridge = createStdioBridge(endpoint, io)
    const output = await bridge.handleLine(line({ method: 'notifications/initialized' }))
    // A notification has no id to answer.
    assert.equal(output, undefined)
  })
})

describe('P26-06 — cancellation is per request', () => {
  it('aborts exactly the referenced request', async () => {
    const { endpoint, signals } = makeEndpoint({ delayMs: 200 })
    const { diagnostics, io } = capture()
    const bridge = createStdioBridge(endpoint, io)

    // Two requests in flight at once, which is the case that matters: cancelling one
    // must not cancel the other, or a shared worker would be torn down under it.
    const first = bridge.handleLine(line({ method: 'tools/call', id: 'a', params: { name: 'x', arguments: {} } }))
    const second = bridge.handleLine(line({ method: 'tools/call', id: 'b', params: { name: 'y', arguments: {} } }))
    assert.equal(bridge.inFlight, 2)

    await bridge.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'a' },
    }))

    assert.equal(signals[0]?.aborted, true, 'the referenced request must be aborted')
    assert.equal(signals[1]?.aborted, false, 'the unrelated request must NOT be aborted')
    assert.match(diagnostics.join('\n'), /cancelled request a/)

    await Promise.all([first, second])
  })

  it('reports a cancellation for a request it does not own', async () => {
    const { endpoint } = makeEndpoint()
    const { diagnostics, io } = capture()
    const bridge = createStdioBridge(endpoint, io)
    // A disagreement about what is in flight is worth surfacing.
    await bridge.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'never-sent' },
    }))
    assert.match(diagnostics.join('\n'), /unknown request never-sent/)
  })

  it('removes a settled request from the in-flight set', async () => {
    const { endpoint } = makeEndpoint()
    const { io } = capture()
    const bridge = createStdioBridge(endpoint, io)
    await bridge.handleLine(line({ method: 'tools/list', id: 'done' }))
    // Nothing is retained after a request settles: one stdio process is not one
    // conversation, so there is no accumulating per-conversation state.
    assert.equal(bridge.inFlight, 0)
  })
})

describe('P26-08 — EOF shuts down bridge-owned requests only', () => {
  it('aborts everything it owns', async () => {
    const { endpoint, signals } = makeEndpoint({ delayMs: 200 })
    const { diagnostics, io } = capture()
    const bridge = createStdioBridge(endpoint, io)
    const pending = bridge.handleLine(line({ method: 'tools/call', id: 'a', params: { name: 'x', arguments: {} } }))
    assert.equal(bridge.inFlight, 1)

    bridge.close()
    assert.equal(signals[0]?.aborted, true)
    assert.equal(bridge.inFlight, 0)
    assert.match(diagnostics.join('\n'), /aborted in-flight request a on close/)
    await pending
  })

  it('close is idempotent', async () => {
    const { endpoint } = makeEndpoint()
    const { io } = capture()
    const bridge = createStdioBridge(endpoint, io)
    bridge.close()
    bridge.close()
    assert.equal(bridge.inFlight, 0)
  })

  it('does not touch the host, which is a separate process', () => {
    const { endpoint, calls } = makeEndpoint()
    const { io } = capture()
    const bridge = createStdioBridge(endpoint, io)
    bridge.close()
    // Closing the bridge must not attempt a shutdown request: the host is shared by
    // other clients and is not the bridge's to stop.
    assert.equal(calls.length, 0)
  })
})

describe('MCP-03 — the executable keeps stdout protocol-only', () => {
  /**
   * Stdout purity is a property of the EXECUTABLE, and this sandbox cannot spawn a
   * child with piped stdio (named pipes are blocked), so it is checked statically
   * instead of left unverified. A static check is weaker than running it, and that
   * limitation is recorded rather than glossed: what this proves is that no code
   * path in the file writes a non-protocol string to stdout.
   */
  function binSource(): string {
    const url = new URL('../bin/dsh-tool-mode-mcp-stdio.mjs', import.meta.url)
    return readFileSync(url, 'utf8')
  }

  it('writes to stdout in exactly two places, both protocol frames', () => {
    const source = binSource()
    const writes = [...source.matchAll(/process\.stdout\.write\(([^\n]*)\)/g)].map(match => match[0])
    assert.equal(writes.length, 2, `expected two stdout writes, found ${writes.length}: ${writes.join(' | ')}`)
    // Both must be a protocol frame followed by a newline, never a banner or log.
    for (const write of writes) {
      assert.match(write, /\.write\(`\$\{(line|output)\}\\n`\)/, `unexpected stdout write: ${write}`)
    }
  })

  it('routes every diagnostic to stderr', () => {
    const source = binSource()
    // There is no single "output" the code could confuse: diagnostics go through a
    // named sink that writes to stderr.
    assert.match(source, /const diagnostic = line => process\.stderr\.write/)
    assert.equal(/console\.log\(/.test(source), false, 'console.log writes to stdout and must not appear')
  })

  it('fails with guidance instead of hanging when no credential is configured', () => {
    const source = binSource()
    // P26-16: unattended operation must fail with setup guidance, never hang.
    assert.match(source, /DSH_TOOL_MODE_MCP_TOKEN/)
    assert.match(source, /process\.exit\(2\)/)
    assert.match(source, /never hang|must fail/i)
  })

  it('aborts bridge-owned requests on EOF without signalling the host', () => {
    const source = binSource()
    assert.match(source, /process\.stdin\.on\('end'/)
    assert.match(source, /bridge\.close\(\)/)
    // No shutdown request is sent to the host, which is shared and not the bridge's
    // to stop.
    assert.equal(/shutdown/.test(source), false)
  })
})