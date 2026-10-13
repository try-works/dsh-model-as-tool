/**
 * Conformance tests against the PINNED upstream schema (MCP-01, P26-13).
 *
 * Every other test in this repository asserts against types and expectations
 * written HERE. These assert against the revision's own JSON Schema, fetched from
 * upstream and pinned by commit and digest, so a mistake in my reading of the
 * specification is caught by the specification rather than by my consistency with
 * myself.
 *
 * That is not hypothetical: pinning the schema immediately found three real
 * conformance errors in code that had passed every hand-written test —
 * a `DiscoverResult` carrying three fields the definition does not declare, a
 * `ListToolsResult` missing two it requires, and a metadata parser requiring
 * `clientInfo` when the schema makes it optional.
 *
 * Requirement links: MCP-01, MCP-04, P26-13.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'

import { dispatch, type McpHost, type McpToolDefinition } from '../src/mcp/server.ts'
import { ERROR_CODES, META_KEYS, PROTOCOL_VERSION, type WireRequest } from '../src/mcp/protocol.ts'

const SCHEMA_DIR = 'docs/tool-mode/specs/mcp-2026-07-28'

/** The pinned schema and its recorded provenance. */
const schemaText = readFileSync(`${SCHEMA_DIR}/schema.json`, 'utf8')
const schema = JSON.parse(schemaText) as { $defs: Record<string, object> }
const sourceCommit = readFileSync(`${SCHEMA_DIR}/SOURCE_COMMIT.txt`, 'utf8').trim()

/** Compile a validator for one named definition in the pinned schema. */
function validatorFor(definition: string) {
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  // The schema is self-contained: every $ref points inside $defs, which P26-13
  // requires (no network $ref loading by default).
  ajv.addSchema(schema as object, 'mcp')
  return ajv.compile({ $ref: `mcp#/$defs/${definition}` })
}

/** Render Ajv errors for a failure message. */
function render(errors: ReturnType<typeof validatorFor>['errors']): string {
  return (errors ?? []).map(error => `${error.instancePath || '(root)'} ${error.message ?? ''}`).join('; ')
}

const host: McpHost = {
  serverInfo: { name: 'dsh-tool-mode', version: '0.1.0' },
  listTools: (): McpToolDefinition[] => [{
    name: 'lang_detect',
    description: 'Identify the language of the supplied text.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
    outputSchema: { type: 'object', additionalProperties: false, required: ['language'], properties: { language: { type: 'string' } } },
    importedFromMcp: false,
  }],
  async callTool() {
    return { structured: { language: 'de' }, text: 'Detected language: de' }
  },
}

function request(method: string, params: Record<string, unknown> = {}): WireRequest {
  return {
    jsonrpc: '2.0',
    id: 'conf-1',
    method,
    params: {
      ...params,
      _meta: {
        [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
        [META_KEYS.clientInfo]: { name: 'conformance', version: '1.0.0' },
        [META_KEYS.clientCapabilities]: {},
      },
    },
  }
}

describe('MCP-01 — the schema is pinned, not recalled', () => {
  it('records the exact source commit', () => {
    assert.match(sourceCommit, /^[0-9a-f]{40}$/, 'the pin must be an immutable commit, not a branch or tag name')
  })

  it('pins the JSON Schema and the TypeScript source the revision publishes', () => {
    const json = readFileSync(`${SCHEMA_DIR}/schema.json`)
    const ts = readFileSync(`${SCHEMA_DIR}/schema.ts`)
    // Digests, so a later edit to the pinned copy is detectable.
    assert.equal(
      createHash('sha256').update(json).digest('hex'),
      'ef70b61f99b6d2e5e3b46863822eab08dff6a45bedc7a08914e0e5b133f40203',
      'the pinned JSON Schema changed; re-pin it deliberately and update the digest',
    )
    assert.equal(
      createHash('sha256').update(ts).digest('hex'),
      '742750af0bb8c716e7030c4977c992b55d1adc4407e9e66997db5846baedc2cd',
      'the pinned TypeScript schema changed',
    )
  })

  it('is a self-contained 2020-12 schema with no remote $ref', () => {
    const raw = JSON.stringify(schema)
    assert.equal((schema as { $schema?: string }).$schema, 'https://json-schema.org/draft/2020-12/schema')
    // P26-13: no network $ref loading by default, so every reference must be local.
    const remote = [...raw.matchAll(/"\$ref":"([^"]+)"/g)]
      .map(match => match[1] as string)
      .filter(ref => !ref.startsWith('#') && !ref.startsWith('mcp#'))
    assert.deepEqual(remote, [], 'every $ref must resolve inside the pinned schema')
  })

  it('defines the messages this server sends', () => {
    for (const definition of ['DiscoverResult', 'ListToolsResult', 'CallToolResult', 'Error']) {
      assert.ok(schema.$defs[definition], `${definition} must exist in the pinned schema`)
    }
  })
})

describe('P26-13 — our actual messages validate against the pinned schema', () => {
  it('a server/discover response is a valid DiscoverResultResponse', async () => {
    const { response } = await dispatch(request('server/discover'), host)
    const validate = validatorFor('DiscoverResultResponse')
    assert.ok(validate(response), `discover response is not schema-conformant: ${render(validate.errors)}`)
  })

  it('a tools/list response is a valid ListToolsResultResponse', async () => {
    const { response } = await dispatch(request('tools/list'), host)
    const validate = validatorFor('ListToolsResultResponse')
    assert.ok(validate(response), `tools/list response is not schema-conformant: ${render(validate.errors)}`)
  })

  it('a successful tools/call response is a valid CallToolResultResponse', async () => {
    const { response } = await dispatch(request('tools/call', { name: 'lang_detect', arguments: { text: 'hi' } }), host)
    const validate = validatorFor('CallToolResultResponse')
    assert.ok(validate(response), `tools/call response is not schema-conformant: ${render(validate.errors)}`)
  })

  it('a tool-error response is ALSO a valid CallToolResultResponse', async () => {
    const failing: McpHost = {
      ...host,
      async callTool() { return { structured: null, text: 'the model is unprepared', isError: true } },
    }
    const { response } = await dispatch(request('tools/call', { name: 'lang_detect', arguments: {} }), failing)
    // An application failure is a successful protocol result, so it must satisfy
    // the same definition as a success.
    const validate = validatorFor('CallToolResultResponse')
    assert.ok(validate(response), `tool-error response is not schema-conformant: ${render(validate.errors)}`)
  })

  it('a JSON-RPC error response is a valid JSONRPCErrorResponse', async () => {
    const { response } = await dispatch(request('tools/call', { name: 'absent' }), host)
    const validate = validatorFor('JSONRPCErrorResponse')
    assert.ok(validate(response), `error response is not schema-conformant: ${render(validate.errors)}`)
  })

  it('an unsupported-version error is a valid JSONRPCErrorResponse', async () => {
    const legacy = request('tools/list')
    ;(legacy.params?._meta as Record<string, unknown>)[META_KEYS.protocolVersion] = '2025-11-25'
    const { response } = await dispatch(legacy, host)
    const validate = validatorFor('JSONRPCErrorResponse')
    assert.ok(validate(response), `version error is not schema-conformant: ${render(validate.errors)}`)
    assert.equal((response?.error as { code: number }).code, ERROR_CODES.unsupportedProtocolVersion)
  })

  it('a header-mismatch response is a valid HeaderMismatchError', async () => {
    const { response } = await dispatch(request('tools/list'), host, {
      checkHeaders: true,
      headers: { protocolVersion: '2025-11-25', method: 'tools/list' },
    })
    const validate = validatorFor('HeaderMismatchError')
    assert.ok(validate(response), `header-mismatch response is not schema-conformant: ${render(validate.errors)}`)
  })
})

describe('P26-13 — the pinned schema rejects what we must not send', () => {
  it('a DiscoverResult MISSING its required fields is rejected', () => {
    // This is the defect the pin actually caught. The earlier implementation
    // returned protocolVersion/serverInfo/features and NONE of the five required
    // fields, so it was non-conformant by omission.
    const validate = validatorFor('DiscoverResult')
    const incomplete = {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: 'x', version: '1' },
      features: [],
    }
    assert.equal(validate(incomplete), false, 'a DiscoverResult without its required fields must be rejected')
  })

  it('this schema PERMITS additional properties, so extras alone are not a violation', () => {
    // Worth recording precisely, because the distinction changes what the defect
    // was: the definition declares no `additionalProperties: false`, so carrying an
    // undeclared field is not itself non-conformant. The failure was the MISSING
    // required fields. Stating it the other way would have overstated the finding.
    const validate = validatorFor('DiscoverResult')
    const complete = {
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      cacheScope: 'private',
      ttlMs: 0,
      resultType: 'complete',
      protocolVersion: PROTOCOL_VERSION,
    }
    assert.equal(validate(complete), true, 'extras are permitted when every required field is present')
  })

  it('a ListToolsResult without cacheScope or ttlMs is rejected', () => {
    const validate = validatorFor('ListToolsResult')
    assert.equal(validate({ tools: [], resultType: 'complete' }), false)
  })

  it('a result without resultType is rejected', () => {
    const validate = validatorFor('Result')
    assert.equal(validate({}), false)
  })

  it('an error without a code is rejected', () => {
    const validate = validatorFor('Error')
    assert.equal(validate({ message: 'x' }), false)
  })
})
