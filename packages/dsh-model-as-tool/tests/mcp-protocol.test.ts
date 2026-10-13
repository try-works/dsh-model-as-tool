/**
 * MCP 2026-07-28 wire-core tests.
 *
 * Section 20 of the spec is unusually precise — it names exact error codes, exact
 * `_meta` keys and exact distinctions — so these tests assert the named values
 * rather than a general shape. Where the requirement forbids something ("do not
 * advertise X merely because the SDK exports it"), there is a test that the thing
 * is genuinely absent.
 *
 * Requirement links: MCP-01, MCP-04, MCP-05, MCP-10, P26-01..P26-05, P26-12.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  ADVERTISED_FEATURES,
  assertHeadersMatch,
  decodeHeaderValue,
  ERROR_CODES,
  errorResponse,
  implementedCapabilities,
  isReservedErrorCode,
  META_KEYS,
  negotiateVersion,
  parseRequestMetadata,
  parseStdioLine,
  PROTOCOL_VERSION,
  serializeStdioFrame,
  successResult,
  SUPPORTED_PROTOCOL_VERSIONS,
  toolErrorResult,
  unsupportedRequiredCapabilities,
  WireError,
  type WireRequest,
} from '../src/mcp/protocol.ts'

/** A valid modern request, exactly as the spec's fixture shows it. */
function modernRequest(overrides: Partial<WireRequest> = {}): WireRequest {
  return {
    jsonrpc: '2.0',
    id: 'catalog-1',
    method: 'tools/list',
    params: {
      _meta: {
        [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
        [META_KEYS.clientInfo]: { name: 'tool-mode-conformance', version: '1.0.0' },
        [META_KEYS.clientCapabilities]: {},
      },
    },
    ...overrides,
  }
}

describe('MCP-01 / MCP-04 — the revision is the requested one', () => {
  it('speaks exactly 2026-07-28, not a relabelled legacy revision', () => {
    assert.equal(PROTOCOL_VERSION, '2026-07-28')
    assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], ['2026-07-28'])
  })

  it('accepts the spec\u2019s own minimal modern request fixture', () => {
    // P26-01: a valid tools/list must be processable as the FIRST application
    // request. There is no session state in this module to require, and this
    // fixture is byte-for-byte the one the spec prints.
    const metadata = parseRequestMetadata(modernRequest().params)
    assert.equal(negotiateVersion(metadata), '2026-07-28')
    assert.equal(metadata.clientInfo.name, 'tool-mode-conformance')
  })
})

describe('P26-02 — required per-request metadata', () => {
  it('rejects a request with no _meta as invalid params', () => {
    assert.throws(() => parseRequestMetadata({}), (error: unknown) => {
      assert.ok(error instanceof WireError)
      // The exact code the requirement names.
      assert.equal(error.code, ERROR_CODES.invalidParams)
      assert.equal(error.code, -32602)
      return true
    })
  })

  it('rejects a missing protocolVersion rather than defaulting it', () => {
    assert.throws(
      () => parseRequestMetadata({ _meta: { [META_KEYS.clientInfo]: { name: 'a', version: '1' }, [META_KEYS.clientCapabilities]: {} } }),
      // Defaulting would be inference from nothing, which is what P26-02 forbids.
      /protocolVersion.*required/,
    )
  })

  it('requires clientCapabilities but ADMITS a request without clientInfo', () => {
    // The pinned schema's RequestMetaObject requires protocolVersion and
    // clientCapabilities only. Requiring clientInfo here would reject a request the
    // schema admits - a conformance failure in the opposite direction from
    // accepting too much, and the reason the schema is pinned rather than recalled.
    const withoutInfo = parseRequestMetadata({
      _meta: {
        [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
        [META_KEYS.clientCapabilities]: {},
      },
    })
    assert.equal(withoutInfo.clientInfo.name, 'unknown')

    assert.throws(
      () => parseRequestMetadata({ _meta: { [META_KEYS.protocolVersion]: PROTOCOL_VERSION } }),
      /clientCapabilities.*required/,
    )
  })

  it('rejects a clientInfo that is present but malformed', () => {
    // Absent is admitted; half an Implementation is a broken one.
    assert.throws(
      () => parseRequestMetadata({
        _meta: {
          [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
          [META_KEYS.clientInfo]: { name: 'a' },
          [META_KEYS.clientCapabilities]: {},
        },
      }),
      /name and a version/,
    )
  })

  it('parses metadata fresh per request and never from a previous one', () => {
    // P26-02: capabilities and version are never inferred from a preceding request.
    // The function is pure over its argument, so there is nowhere for a previous
    // request's values to persist.
    const first = parseRequestMetadata(modernRequest().params)
    const second = parseRequestMetadata({
      _meta: {
        [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
        [META_KEYS.clientInfo]: { name: 'other', version: '9.9.9' },
        [META_KEYS.clientCapabilities]: { tools: {} },
      },
    })
    assert.equal(first.clientInfo.name, 'tool-mode-conformance')
    assert.equal(second.clientInfo.name, 'other')
    assert.deepEqual(first.clientCapabilities, {})
  })
})

describe('P26-03 — version and capability errors', () => {
  it('answers an unsupported version with -32022 carrying supported and requested', () => {
    assert.throws(
      () => negotiateVersion({
        protocolVersion: '2025-11-25',
        clientInfo: { name: 'legacy', version: '1' },
        clientCapabilities: {},
      }),
      (error: unknown) => {
        assert.ok(error instanceof WireError)
        assert.equal(error.code, -32022)
        // The data shape is defined by the revision; a bare message would leave the
        // client unable to choose a version it can speak.
        assert.deepEqual(error.data, { supported: ['2026-07-28'], requested: '2025-11-25' })
        return true
      },
    )
  })

  it('uses -32021 for an unsupported REQUIRED client capability', () => {
    assert.equal(ERROR_CODES.unsupportedClientCapability, -32021)
    assert.deepEqual([...unsupportedRequiredCapabilities(['tools'])], [])
    assert.deepEqual([...unsupportedRequiredCapabilities(['tools', 'sampling'])], ['sampling'])
  })

  it('never allocates a custom error in the reserved range', () => {
    // P26-03 forbids it, so the guard exists and the declared codes are all
    // protocol-defined values.
    assert.equal(isReservedErrorCode(-32022), true)
    assert.equal(isReservedErrorCode(-32602), true)
    for (const code of Object.values(ERROR_CODES)) {
      assert.ok(isReservedErrorCode(code), `${code} must be a protocol-defined code`)
    }
  })
})

describe('P26-04 — result shape and the error distinction', () => {
  it('every result envelope carries resultType and serverInfo metadata', () => {
    const result = successResult({ tools: [] }, { name: 'dsm', version: '0.1.0' })
    assert.equal(result.resultType, 'complete')
    assert.deepEqual(result._meta, { [META_KEYS.serverInfo]: { name: 'dsm', version: '0.1.0' } })
  })

  it('an application failure is a tool-error RESULT, not a JSON-RPC error', () => {
    const failure = toolErrorResult('the model deployment is unprepared')
    assert.equal(failure.isError, true)
    assert.equal(failure.content[0]?.type, 'text')
    // No JSON-RPC error member: the protocol exchange SUCCEEDED and the tool failed.
    assert.equal('error' in failure, false)
  })

  it('a malformed protocol request is a JSON-RPC error, not a result', () => {
    const response = errorResponse('catalog-1', new WireError(ERROR_CODES.invalidParams, 'no _meta'))
    assert.equal(response.jsonrpc, '2.0')
    assert.equal(response.id, 'catalog-1')
    assert.deepEqual(response.error, { code: -32602, message: 'no _meta' })
    // The two must not be conflated in either direction.
    assert.equal('result' in response, false)
  })

  it('bounds a tool-error message so it stays model-readable', () => {
    const failure = toolErrorResult('x'.repeat(5000))
    const text = failure.content[0]?.text ?? ''
    assert.ok(text.length <= 2001, 'a tool-error message must be bounded')
    assert.match(text, /…$/)
  })

  it('carries structured error data when the code defines it', () => {
    const response = errorResponse(null, new WireError(-32022, 'bad version', { supported: ['2026-07-28'] }))
    assert.deepEqual((response.error as { data: unknown }).data, { supported: ['2026-07-28'] })
  })
})

describe('P26-05 — headers are checked against the body', () => {
  it('accepts a request whose headers agree with its body', () => {
    assertHeadersMatch(
      { protocolVersion: '2026-07-28', method: 'tools/list' },
      modernRequest(),
    )
  })

  it('requires the protocol-version header', () => {
    assert.throws(() => assertHeadersMatch({ method: 'tools/list' }, modernRequest()), (error: unknown) => {
      assert.ok(error instanceof WireError)
      assert.equal(error.code, ERROR_CODES.headerMismatch)
      assert.equal(error.code, -32020)
      return true
    })
  })

  it('rejects a header that disagrees with the body version', () => {
    assert.throws(
      () => assertHeadersMatch({ protocolVersion: '2025-11-25', method: 'tools/list' }, modernRequest()),
      /does not match the request body/,
    )
  })

  it('rejects a method header that disagrees with the body method', () => {
    assert.throws(
      () => assertHeadersMatch({ protocolVersion: '2026-07-28', method: 'tools/call' }, modernRequest()),
      /does not match the request method/,
    )
  })

  it('requires Mcp-Name for tools/call and checks it against the body', () => {
    const call = modernRequest({
      method: 'tools/call',
      params: {
        name: 'describe_image',
        arguments: {},
        _meta: {
          [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
          [META_KEYS.clientInfo]: { name: 'a', version: '1' },
          [META_KEYS.clientCapabilities]: {},
        },
      },
    })
    assert.throws(
      () => assertHeadersMatch({ protocolVersion: '2026-07-28', method: 'tools/call' }, call),
      /Mcp-Name header is required/,
    )
    assert.throws(
      () => assertHeadersMatch({ protocolVersion: '2026-07-28', method: 'tools/call', name: 'other' }, call),
      /does not match the request name/,
    )
    assertHeadersMatch({ protocolVersion: '2026-07-28', method: 'tools/call', name: 'describe_image' }, call)
  })

  it('does NOT require Mcp-Name for tools/list, which has no name', () => {
    // Requiring it universally would reject a correct request.
    assertHeadersMatch({ protocolVersion: '2026-07-28', method: 'tools/list' }, modernRequest())
  })

  it('decodes the Base64 sentinel BEFORE comparing', () => {
    // Comparing the encoded form would let a client present a value that decodes to
    // something else entirely.
    const encoded = `=?base64?${Buffer.from('tools/list', 'utf8').toString('base64')}?=`
    assert.equal(decodeHeaderValue(encoded), 'tools/list')
    assertHeadersMatch({ protocolVersion: '2026-07-28', method: encoded }, modernRequest())

    // And a sentinel that decodes to the WRONG value is still a mismatch.
    const wrong = `=?base64?${Buffer.from('tools/call', 'utf8').toString('base64')}?=`
    assert.throws(
      () => assertHeadersMatch({ protocolVersion: '2026-07-28', method: wrong }, modernRequest()),
      /does not match the request method/,
    )
  })

  it('leaves an ordinary header value unchanged', () => {
    assert.equal(decodeHeaderValue('tools/list'), 'tools/list')
  })
})

describe('P26-08 — stdio framing', () => {
  it('parses one frame and ignores a blank line', () => {
    assert.equal(parseStdioLine('   '), undefined)
    const request = parseStdioLine(JSON.stringify(modernRequest()))
    assert.equal(request?.method, 'tools/list')
    assert.equal(request?.id, 'catalog-1')
  })

  it('reports malformed JSON as a parse error rather than skipping the line', () => {
    assert.throws(() => parseStdioLine('{not json'), (error: unknown) => {
      assert.ok(error instanceof WireError)
      // Skipping would leave a client waiting for a response that never comes.
      assert.equal(error.code, ERROR_CODES.parseError)
      return true
    })
  })

  it('rejects a non-JSON-RPC object', () => {
    assert.throws(() => parseStdioLine('[1,2,3]'), /not a JSON-RPC object/)
    assert.throws(() => parseStdioLine('{"method":"x"}'), /not a JSON-RPC 2.0 request/)
  })

  it('preserves the request id across a round trip', () => {
    const line = serializeStdioFrame({ jsonrpc: '2.0', id: 42, result: {} })
    assert.ok(line.endsWith('\n'), 'each frame is newline-terminated')
    const parsed = JSON.parse(line) as { id: number }
    assert.equal(parsed.id, 42)
  })

  it('emits exactly one frame per message', () => {
    const line = serializeStdioFrame({ jsonrpc: '2.0', id: 'a', result: { text: 'multi\nline' } })
    // A newline inside the JSON would produce two frames and desynchronise the
    // stream, so it must be escaped rather than emitted raw.
    assert.equal(line.split('\n').length, 2)
  })
})

describe('P26-12 — the advertised-feature matrix', () => {
  it('does not advertise a feature that is not implemented', () => {
    // P26-12: do not advertise Tasks, sampling, resources, prompts or UI extensions
    // merely because an SDK exports their types.
    const advertised = implementedCapabilities()
    for (const forbidden of ['tasks', 'sampling', 'elicitation', 'roots', 'prompts', 'resources/subscribe', 'logging']) {
      assert.equal(advertised.includes(forbidden), false, `${forbidden} must not be advertised`)
    }
    assert.ok(advertised.includes('tools'))
  })

  it('declares each unimplemented feature explicitly rather than omitting it', () => {
    // The matrix is machine-readable, so a client can tell "not implemented" from
    // "not mentioned".
    for (const name of ['tasks', 'sampling', 'prompts']) {
      const entry = ADVERTISED_FEATURES.find(candidate => candidate.feature === name)
      assert.ok(entry, `${name} must appear in the matrix`)
      assert.equal(entry.implemented, false)
    }
  })

  it('keeps the matrix and the advertised capabilities consistent', () => {
    // Derived rather than written twice, so they cannot disagree.
    assert.deepEqual(
      implementedCapabilities(),
      ADVERTISED_FEATURES.filter(entry => entry.implemented).map(entry => entry.feature),
    )
  })
})
