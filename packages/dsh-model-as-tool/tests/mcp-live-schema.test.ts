/**
 * LIVE schema conformance: the server's OWN responses validated against the PINNED schema.
 *
 * THE GAP THIS CLOSES, and it is the one that let a real defect through. Every other MCP check
 * in this repository validates SAVED FIXTURES — recorded message bodies, checked against the
 * pinned definitions. That is worth having, and it cannot catch a defect in a message no
 * fixture covers. It is exactly how `-32021` shipped a body with `data.unsupported` where the
 * pinned `MissingRequiredClientCapabilityError` REQUIRES `data.requiredCapabilities`: the
 * generic `JSONRPCErrorResponse` accepts any `data`, every fixture took that path, and no
 * fixture exercised the specific error at all. Adversarial review found it by validating the
 * real body with Ajv; nothing in the suite would have.
 *
 * So this test starts the REAL server, makes REAL requests over a real socket, and validates
 * every response body against the pinned schema. A conformance claim that never inspects a live
 * response is a claim about the fixtures.
 *
 * Requirement links: P26-02, P26-03, P26-04, P26-05, P26-13, MCP-01.
 */

import { readFileSync } from 'node:fs'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Ajv2020 from 'ajv/dist/2020.js'

import { createMcpHost, type HostSurface, type PublishedTool } from '../src/mcp/host-binding.ts'
import { startHttpServer, type HttpTransportConfig } from '../src/mcp/http.ts'
import { META_KEYS, PROTOCOL_VERSION } from '../src/mcp/protocol.ts'
import { STANDARD_CONTRACTS } from '@try-works/tool-mode-contracts'
import { cleanup, mountPlugin } from './helpers.ts'

after(async () => { await cleanup() })

const TOKEN = 'live-schema-token'
const SCHEMA_PATH = 'docs/tool-mode/specs/mcp-2026-07-28/schema.json'

/** The pinned schema, with a validator per definition. */
function pinnedValidators() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
    $defs?: Record<string, unknown>
    definitions?: Record<string, unknown>
  }
  const defs = schema.$defs ?? schema.definitions ?? {}
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
  // The definitions reference each other by `#/$defs/...`, so the whole schema must be added
  // and the individual definitions resolved against it rather than compiled standalone.
  ajv.addSchema(schema as object, 'pinned')
  const validators = new Map<string, ReturnType<typeof ajv.compile>>()
  for (const name of Object.keys(defs)) {
    try {
      validators.set(name, ajv.compile({ $ref: `pinned#/$defs/${name}` }))
    } catch {
      // A definition that cannot compile standalone is skipped rather than failing the file;
      // the ones that matter for responses are asserted to exist below.
    }
  }
  return { validators, definitions: defs }
}

const { validators, definitions } = pinnedValidators()

/**
 * THE PINNED ERROR DEFINITIONS ARE NOT UNIFORM, and validating the wrong half is silently wrong.
 *
 * Four of them are BARE ERROR OBJECTS (`{code, message, data}`):
 *   MethodNotFoundError, InvalidParamsError, ParseError, InvalidRequestError
 * and three are FULL ENVELOPES (`{error, id, jsonrpc}`):
 *   HeaderMismatchError, MissingRequiredClientCapabilityError, UnsupportedProtocolVersionError
 *
 * Handing a response envelope to `MethodNotFoundError` fails on `required: [code]` at the TOP
 * level — which says nothing about the server and everything about the check. A conformance
 * harness has to know which half each definition describes, so this one does it by inspection
 * rather than by a hard-coded list that would rot.
 */
/**
 * Which definitions describe a BARE ERROR OBJECT rather than a full envelope.
 *
 * Derived from the SCHEMA rather than hard-coded, so a definition that changes shape is
 * followed instead of silently mis-validated.
 */
const ERROR_OBJECT_DEFINITIONS = new Set(
  Object.entries(definitions)
    .filter(([, definition]) => {
      const properties = (definition as { properties?: Record<string, unknown> }).properties ?? {}
      return 'code' in properties && !('jsonrpc' in properties)
    })
    .map(([name]) => name),
)

/** Validate a live response body against a pinned definition, reporting Ajv's own errors. */
function assertConforms(definition: string, body: unknown, label: string): void {
  const validate = validators.get(definition)
  assert.ok(validate !== undefined, `the pinned schema must define ${definition}`)
  if (validate === undefined) return
  /**
   * The half that definition describes. An error-object definition is checked against the
   * response's `error` member; an envelope definition against the whole body.
   */
  const subject = ERROR_OBJECT_DEFINITIONS.has(definition)
    ? (body as { error?: unknown }).error
    : body
  assert.ok(
    subject !== undefined,
    `${label}: ${definition} describes ${ERROR_OBJECT_DEFINITIONS.has(definition) ? 'the error member' : 'the envelope'}, which the response does not carry`,
  )
  const ok = validate(subject)
  assert.ok(
    ok,
    `${label}: the live response does not conform to ${definition}:\n`
    + `${JSON.stringify(validate.errors, null, 2)}\n`
    + `subject: ${JSON.stringify(subject).slice(0, 400)}`,
  )
}

/** Start the real server backed by the real registry. */
async function liveServer(options: { readonly maxBodyBytes?: number } = {}) {
  const ctx = await mountPlugin({})
  const registered = new Set(ctx.tools.schemas().map(schema => schema.name))
  const published: PublishedTool[] = STANDARD_CONTRACTS
    .filter(contract => registered.has(contract.toolName))
    .map(contract => ({ toolName: contract.toolName, contract }))
  const surface: HostSurface = {
    published,
    async execute({ name, arguments: args }) {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: `live-schema-${name}-${Date.now()}` as never,
        name,
        arguments: args,
      })
      if (result.isError) return { isError: true, message: result.error?.message ?? 'the tool failed' }
      return { isError: false, value: result.value }
    },
  }
  const host = createMcpHost({ surface, serverInfo: { name: 'tool-mode', version: '0.1.3' } })
  const config: HttpTransportConfig = {
    path: '/mcp',
    host: '127.0.0.1',
    port: 0,
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
    allowedOrigins: [],
    auth: { scheme: 'static-token', token: TOKEN, clientId: 'test-client' },
    // This file validates responses against the pinned schema; the AT-12 rate limiter
    // is the subject of mcp-rate-limit.test.ts.
    rateLimit: false,
  } as HttpTransportConfig
  const endpoint = await startHttpServer(config, host)
  return { ctx, endpoint }
}

/** The `_meta` every modern request must carry (P26-02). */
function meta(extra: Record<string, unknown> = {}) {
  return {
    [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
    [META_KEYS.clientCapabilities]: {},
    [META_KEYS.clientInfo]: { name: 'live-schema', version: '1.0.0' },
    ...extra,
  }
}

/** One request over a real socket. */
async function rpc(
  url: string,
  body: unknown,
  options: { readonly versionHeader?: boolean; readonly nameHeader?: string } = {},
) {
  const method = (body as { method?: string }).method ?? ''
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${TOKEN}`,
  }
  if (options.versionHeader !== false) headers['mcp-protocol-version'] = PROTOCOL_VERSION
  if (method.length > 0) headers['mcp-method'] = method
  if (options.nameHeader !== undefined) headers['mcp-name'] = options.nameHeader
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: response.status, json: JSON.parse(await response.text()) as Record<string, unknown> }
}

describe('P26-13 — the server\'s LIVE responses conform to the pinned schema', () => {
  it('server/discover', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta() },
      })
      assert.equal(response.status, 200)
      assertConforms('DiscoverResultResponse', response.json, 'server/discover')
    } finally {
      await endpoint.close()
    }
  })

  it('tools/list', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta() },
      })
      assert.equal(response.status, 200)
      assertConforms('ListToolsResultResponse', response.json, 'tools/list')
    } finally {
      await endpoint.close()
    }
  })

  it('tools/call — a real invocation', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'lang_detect', arguments: { text: 'kann ich das haben' }, _meta: meta() },
      }, { nameHeader: 'lang_detect' })
      assert.equal(response.status, 200)
      /**
       * THIS IS THE ASSERTION THAT WOULD HAVE CAUGHT THE DEFECT CLASS. The live body is handed
       * to Ajv against the pinned definition, so a shape no fixture covers is still checked.
       */
      assertConforms('CallToolResultResponse', response.json, 'tools/call')
    } finally {
      await endpoint.close()
    }
  })

  it('a HEADER MISMATCH conforms to its OWN definition, not just the generic one', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: meta() },
      }, { versionHeader: false })
      assert.equal(response.status, 400)
      const error = response.json.error as { code?: number } | undefined
      assert.equal(error?.code, -32020)
      /**
       * Validated against the SPECIFIC definition. The generic `JSONRPCErrorResponse` accepts
       * any `data`, which is precisely why validating against it proves so little — and why the
       * `-32021` defect survived a suite that only ever took that path.
       */
      assertConforms('HeaderMismatchError', response.json, 'a header mismatch')
    } finally {
      await endpoint.close()
    }
  })

  it('an UNSUPPORTED REQUIRED CAPABILITY conforms to ITS OWN definition', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/list',
        params: {
          _meta: meta({
            // `required` is an ARRAY of names a client NEEDS; mere presence is not a requirement.
            [META_KEYS.clientCapabilities]: { required: ['sampling'] },
          }),
        },
      })
      assert.equal(response.status, 400)
      const error = response.json.error as { code?: number; data?: Record<string, unknown> } | undefined
      assert.equal(error?.code, -32021)
      /**
       * THE REGRESSION GUARD FOR THE DEFECT ADVERSARIAL REVIEW FOUND. This server sent
       * `data.unsupported` where the pinned definition requires `data.requiredCapabilities`.
       * Validating against `MissingRequiredClientCapabilityError` fails on the old shape and
       * passes on the corrected one — which is the whole difference between this test and the
       * fixture probe.
       */
      assertConforms('MissingRequiredClientCapabilityError', response.json, '-32021')
      /**
       * AND THE VALUE'S TYPE, which is where this went wrong twice.
       *
       * MY FIRST VERSION OF THIS ASSERTION WAS ITSELF THE BUG: it required
       * `Array.isArray(data.requiredCapabilities)`, encoding the array shape that the pinned
       * schema rejects. A test asserting the wrong shape is how a wrong value becomes
       * load-bearing — the same pattern as the contract-id mismatch, where two tests were
       * defending an invented namespace.
       *
       * The schema is explicit: `requiredCapabilities` is a `$ref ClientCapabilities`, an
       * OBJECT keyed by capability name. So the assertion is on the object and on the key.
       */
      const required = error?.data?.requiredCapabilities as Record<string, unknown> | undefined
      assert.ok(required !== null && typeof required === 'object' && !Array.isArray(required),
        `requiredCapabilities must be a capabilities OBJECT, saw ${JSON.stringify(required)}`)
      assert.ok('sampling' in (required ?? {}), 'the unsupported capability must be named as a key')
    } finally {
      await endpoint.close()
    }
  })

  it('an UNSUPPORTED PROTOCOL VERSION conforms to ITS OWN definition', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/list',
        params: { _meta: meta({ [META_KEYS.protocolVersion]: '1999-01-01' }) },
      })
      const error = response.json.error as { code?: number } | undefined
      // Either a version rejection or a header mismatch is defensible here depending on which
      // check runs first; what is NOT acceptable is a body that conforms to neither.
      assert.ok(error?.code === -32022 || error?.code === -32020, `unexpected code ${error?.code}`)
      assertConforms(
        error?.code === -32022 ? 'UnsupportedProtocolVersionError' : 'HeaderMismatchError',
        response.json,
        'an unsupported version',
      )
    } finally {
      await endpoint.close()
    }
  })

  /**
   * THE ERROR PATHS, which is where shapes are least likely to be fixture-covered — and where
   * the one live defect found so far actually lived. Each is validated against its SPECIFIC
   * definition, because the generic `JSONRPCErrorResponse` accepts any `data` and proves almost
   * nothing.
   */
  it('an unknown method conforms to MethodNotFoundError', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 10, method: 'tools/nonexistent', params: { _meta: meta() },
      })
      const error = response.json.error as { code?: number } | undefined
      assert.equal(error?.code, -32601)
      assertConforms('MethodNotFoundError', response.json, 'an unknown method')
    } finally {
      await endpoint.close()
    }
  })

  it('MISSING REQUIRED METADATA conforms to InvalidParamsError (P26-02)', async () => {
    const { endpoint } = await liveServer()
    try {
      // No `_meta` at all: P26-02 requires the protocol version and client capabilities there.
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0', id: 11, method: 'tools/list', params: {},
      })
      const error = response.json.error as { code?: number } | undefined
      assert.equal(error?.code, -32602, `expected invalid params, saw ${JSON.stringify(response.json).slice(0, 200)}`)
      assertConforms('InvalidParamsError', response.json, 'missing required metadata')
    } finally {
      await endpoint.close()
    }
  })

  it('malformed JSON conforms to ParseError', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${TOKEN}`,
          'mcp-protocol-version': PROTOCOL_VERSION,
        },
        body: '{ not json',
      })
      const json = JSON.parse(await response.text()) as Record<string, unknown>
      const error = json.error as { code?: number } | undefined
      assert.equal(error?.code, -32700)
      assertConforms('ParseError', json, 'malformed JSON')
    } finally {
      await endpoint.close()
    }
  })

  it('an OVERSIZED body conforms to InvalidRequestError, with no id (413)', async () => {
    const { endpoint } = await liveServer({ maxBodyBytes: 256 })
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${TOKEN}`,
          'mcp-protocol-version': PROTOCOL_VERSION,
          'mcp-method': 'tools/list',
        },
        // Comfortably over the 256-byte limit this server was started with, so the refusal is
        // reached without pushing megabytes through a socket for no additional evidence.
        body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/list', params: { _meta: meta(), pad: 'x'.repeat(600) } }),
      })
      assert.equal(response.status, 413)
      const json = JSON.parse(await response.text()) as Record<string, unknown>
      /**
       * AND THE `id` IS ABSENT, which the pinned `RequestId` (`string | integer`) requires: the
       * body was too large to read, so there is no id to echo. `id: null` would be rejected.
       */
      assert.equal('id' in json, false, `the 413 body must omit id, saw ${JSON.stringify(json)}`)
      assertConforms('InvalidRequestError', json, 'an oversized body')
    } finally {
      await endpoint.close()
    }
  })

  it('a TOOL-ERROR result conforms to CallToolResultResponse', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await rpc(endpoint.url, {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        // An argument the contract rejects: the tool runs and FAILS, which is a tool-error
        // RESULT rather than a JSON-RPC error (P26-04).
        params: { name: 'lang_detect', arguments: { text: 12345 }, _meta: meta() },
      }, { nameHeader: 'lang_detect' })
      assert.equal(response.status, 200, 'a domain failure is still a successful response')
      assertConforms('CallToolResultResponse', response.json, 'a tool-error result')
    } finally {
      await endpoint.close()
    }
  })

  it('a stdio-only cancellation notification is refused over HTTP with a valid error envelope', async () => {
    const { endpoint } = await liveServer()
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${TOKEN}`,
          'mcp-protocol-version': PROTOCOL_VERSION,
          'mcp-method': 'notifications/cancelled',
        },
        // No id: a notification carries none and expects no response.
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } }),
      })
      assert.equal(response.status, 400)
      // There are no core client-to-server HTTP notifications in this revision.
      // A refusal must be explicit; 202 applies only to accepted notifications.
      const body = await response.json() as { error: { code: number; message: string } }
      assert.equal(body.error.code, -32600)
      assert.match(body.error.message, /does not accept standalone notifications/)
      assertConforms('JSONRPCErrorResponse', body, 'unsupported HTTP notification')
    } finally {
      await endpoint.close()
    }
  })
})
