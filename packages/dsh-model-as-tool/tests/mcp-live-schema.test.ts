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
  return validators
}

const validators = pinnedValidators()

/** Validate a live response body against a pinned definition, reporting Ajv's own errors. */
function assertConforms(definition: string, body: unknown, label: string): void {
  const validate = validators.get(definition)
  assert.ok(validate !== undefined, `the pinned schema must define ${definition}`)
  if (validate === undefined) return
  const ok = validate(body)
  assert.ok(
    ok,
    `${label}: the live response does not conform to ${definition}:\n`
    + `${JSON.stringify(validate.errors, null, 2)}\n`
    + `body: ${JSON.stringify(body).slice(0, 400)}`,
  )
}

/** Start the real server backed by the real registry. */
async function liveServer() {
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
    maxBodyBytes: 1024 * 1024,
    allowedOrigins: [],
    auth: { kind: 'static-token', token: TOKEN },
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
})
