/**
 * Capture sanitized MCP request/response fixtures (MCP-17).
 *
 * Run this deliberately, review the diff, and commit. The fixtures are FROZEN
 * FILES rather than values generated inside a test, because the requirement asks for
 * captured evidence: bytes on disk can be read, diffed and reviewed by someone who
 * does not run the code, and a test that regenerates its own expectations proves
 * only that the code is consistent with itself.
 *
 * Sanitization is by CONSTRUCTION here: every credential is a placeholder that was
 * never valid, and no fixture contains a real token, path or model input.
 *
 * Usage: npx tsx scripts/capture-mcp-fixtures.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

import { dispatch, type McpHost, type McpToolDefinition } from '../packages/dsh-model-as-tool/src/mcp/server.ts'
import {
  META_KEYS,
  PROTOCOL_VERSION,
  type WireRequest,
} from '../packages/dsh-model-as-tool/src/mcp/protocol.ts'
import { createHttpHandler, type HttpTransportConfig } from '../packages/dsh-model-as-tool/src/mcp/http.ts'

const OUT = 'docs/tool-mode/fixtures/mcp-2026-07-28'

/**
 * The capture endpoint's credential. A placeholder that was never valid ANYWHERE,
 * so its presence in a committed fixture discloses nothing.
 */
const PLACEHOLDER_TOKEN = 'PLACEHOLDER-NOT-A-REAL-TOKEN'

const host: McpHost = {
  serverInfo: { name: '@try-works/dsh-model-as-tool', version: '0.1.0' },
  listTools: (): McpToolDefinition[] => [{
    name: 'lang_detect',
    description: 'Identify the language of the supplied text.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string', minLength: 1 } },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['language'],
      properties: { language: { type: 'string' } },
    },
    importedFromMcp: false,
  },
  {
    // Published so the domain-failure fixture exercises a tool that EXISTS and
    // fails, rather than an unknown tool that never ran. The first capture used an
    // unpublished name and recorded an invalid-params error under a filename
    // claiming a domain failure.
    name: 'explodes',
    description: 'A tool whose model deployment is unprepared.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: { type: 'object', additionalProperties: false, properties: {} },
    importedFromMcp: false,
  }],
  async callTool(name, _args, signal) {
    if (signal.aborted) return { structured: null, text: 'cancelled', isError: true }
    if (name === 'explodes') return { structured: null, text: 'the model deployment is unprepared', isError: true }
    return { structured: { language: 'de' }, text: 'Detected language: de' }
  },
}

const httpConfig: HttpTransportConfig = {
  path: '/mcp',
  host: '127.0.0.1',
  port: 3765,
  maxBodyBytes: 4 * 1024 * 1024,
  allowedOrigins: [],
  auth: { scheme: 'static-token', token: PLACEHOLDER_TOKEN, clientId: 'fixture-capture' },
}
const httpHandler = createHttpHandler(httpConfig, host)

/** Build a modern request body. */
function body(method: string, params: Record<string, unknown> = {}, id: string | number = 'fixture-1'): WireRequest {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
        [META_KEYS.clientInfo]: { name: 'tool-mode-conformance', version: '1.0.0' },
        [META_KEYS.clientCapabilities]: {},
      },
    },
  }
}

/** One captured scenario. */
interface Fixture {
  readonly name: string
  readonly describes: string
  /** What the case demonstrates, in a sentence an auditor can check. */
  readonly expectation: string
  readonly request: unknown
  readonly response: unknown
  readonly http?: { readonly status: number; readonly headers: Record<string, string> }
}

const fixtures: Fixture[] = []

async function captureDirect(
  name: string,
  describes: string,
  expectation: string,
  request: WireRequest,
): Promise<void> {
  const outcome = await dispatch(request, host)
  fixtures.push({ name, describes, expectation, request, response: outcome.response })
}

async function captureHttp(
  name: string,
  describes: string,
  expectation: string,
  request: WireRequest,
  headers: Record<string, string | undefined>,
  /**
   * The peer address the request appears to come from.
   *
   * Parameterised because a capture that always passes the loopback address cannot
   * demonstrate a loopback REFUSAL — the first version of this did exactly that and
   * recorded a 200 under a filename claiming a 403. The independent probe caught it.
   */
  remoteAddress = '127.0.0.1',
): Promise<void> {
  const response = await httpHandler({
    method: 'POST',
    path: '/mcp',
    headers: { authorization: `Bearer ${PLACEHOLDER_TOKEN}`, ...headers },
    body: JSON.stringify(request),
    remoteAddress,
  })
  fixtures.push({
    name,
    describes,
    expectation,
    request,
    response: response.body.length > 0 ? JSON.parse(response.body) : null,
    http: { status: response.status, headers: response.headers },
  })
}

// --- Discovery -------------------------------------------------------------
await captureDirect(
  'discover',
  'server/discover as the first application request, with no initialize handshake',
  'the result carries supportedVersions, capabilities and the cacheable fields the revision requires',
  body('server/discover', {}, 'discover-1'),
)

await captureDirect(
  'tools-list',
  'tools/list as the first application request',
  'every tool declares both an input and an output schema, and the result is cacheable-private',
  body('tools/list', {}, 'catalog-1'),
)

// --- Tool invocation -------------------------------------------------------
await captureDirect(
  'tools-call-success',
  'a successful tools/call',
  'the canonical value is in structuredContent and resultType is complete',
  body('tools/call', { name: 'lang_detect', arguments: { text: 'hallo wereld' } }, 'call-1'),
)

await captureDirect(
  'tools-call-domain-failure',
  'a tools/call where the TOOL failed',
  'a successful protocol response carrying isError, NOT a JSON-RPC error',
  body('tools/call', { name: 'explodes', arguments: {} }, 'call-2'),
)

// --- Header and version errors ---------------------------------------------
await captureHttp(
  'header-mismatch',
  'a request whose MCP-Protocol-Version header disagrees with its body',
  'HTTP 400 with HeaderMismatch (-32020)',
  body('tools/list', {}, 'hdr-1'),
  { 'mcp-protocol-version': '2025-11-25', 'mcp-method': 'tools/list' },
)

await captureHttp(
  'header-name-mismatch',
  'a tools/call whose Mcp-Name header disagrees with the body',
  'HTTP 400 with HeaderMismatch (-32020), because the header is checked against the body',
  body('tools/call', { name: 'lang_detect', arguments: { text: 'x' } }, 'hdr-2'),
  { 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-method': 'tools/call', 'mcp-name': 'other_tool' },
)

await captureDirect(
  'unsupported-version',
  'a request declaring a revision this server does not speak',
  'error -32022 carrying the supported list and the requested version',
  {
    jsonrpc: '2.0',
    id: 'ver-1',
    method: 'tools/list',
    params: {
      _meta: {
        [META_KEYS.protocolVersion]: '2025-11-25',
        [META_KEYS.clientCapabilities]: {},
      },
    },
  },
)

await captureDirect(
  'missing-metadata',
  'a request with no params._meta',
  'error -32602, never a defaulted version or capability',
  { jsonrpc: '2.0', id: 'meta-1', method: 'tools/list' },
)

// --- Admission failures ----------------------------------------------------
await captureDirect(
  'unknown-tool',
  'a tools/call naming a tool that is not published',
  'error -32602, because nothing was invoked and a domain failure would be a fabrication',
  body('tools/call', { name: 'not_a_tool', arguments: {} }, 'call-3'),
)

await captureHttp(
  'unauthenticated',
  'a request with no credential',
  'HTTP 401 with a Bearer challenge; unauthenticated loopback is not the default',
  body('tools/list', {}, 'auth-1'),
  { authorization: undefined, 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-method': 'tools/list' },
)

await captureHttp(
  'remote-address',
  'a request that did not arrive over the loopback interface',
  'HTTP 403; the check reads the socket address, never a header',
  body('tools/list', {}, 'net-1'),
  { 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-method': 'tools/list' },
  // A genuinely non-loopback peer. The first capture of this fixture passed
  // 127.0.0.1 and therefore demonstrated the opposite of what it claimed; the
  // independent probe caught it by refusing a body where none was expected.
  '203.0.113.7',
)

// --- Concurrency and cancellation -----------------------------------------
await captureDirect(
  'concurrent-calls',
  'two tools/call requests issued together',
  'each response echoes ITS OWN id, so a client can match them',
  body('tools/call', { name: 'lang_detect', arguments: { text: 'concurrent' } }, 'conc-1'),
)

fixtures.push({
  name: 'cancellation',
  describes: 'a notifications/cancelled for an in-flight request, alongside the request it cancels',
  expectation: 'the notification carries no id and the cancelled request keeps its own identity',
  request: [
    body('tools/call', { name: 'lang_detect', arguments: { text: 'cancel me' } }, 'cancel-me'),
    {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'cancel-me', _meta: { [META_KEYS.protocolVersion]: PROTOCOL_VERSION } },
    },
  ],
  response: null,
})

await captureDirect(
  'unsupported-method',
  'a method this server does not implement',
  'error -32601; a method is never silently pretended to be served',
  body('resources/list', {}, 'meth-1'),
)

const concurrency = await Promise.all([
  dispatch(body('tools/list', {}, 'par-1'), host),
  dispatch(body('tools/list', {}, 'par-2'), host),
  dispatch(body('tools/list', {}, 'par-3'), host),
])
fixtures.push({
  name: 'concurrent-discovery',
  describes: 'three tools/list requests in flight together',
  expectation: 'three independent responses, each echoing its own id',
  request: ['par-1', 'par-2', 'par-3'],
  response: concurrency.map(entry => entry.response),
})

// --- Write the corpus ------------------------------------------------------
mkdirSync(OUT, { recursive: true })
for (const fixture of fixtures) {
  writeFileSync(`${OUT}/${fixture.name}.json`, `${JSON.stringify(fixture, null, 2)}\n`)
}

/** The revision the pinned schema came from, read from the pin itself. */
const pinnedCommit = execFileSync('node', ['-e', "process.stdout.write(require('node:fs').readFileSync('docs/tool-mode/specs/mcp-2026-07-28/SOURCE_COMMIT.txt','utf8').trim())"], { encoding: 'utf8' })

const sdkVersion = (() => {
  try {
    return execFileSync('node', ['-e', "process.stdout.write(require('@modelcontextprotocol/sdk/package.json').version)"], { encoding: 'utf8' })
  } catch {
    return 'not-installed'
  }
})()

writeFileSync(`${OUT}/MANIFEST.json`, `${JSON.stringify({
  capturedAt: new Date().toISOString(),
  revision: PROTOCOL_VERSION,
  // The protocol source of truth, by immutable commit.
  pinnedSchemaCommit: pinnedCommit,
  pinnedSchemaPath: 'docs/tool-mode/specs/mcp-2026-07-28/schema.json',
  /**
   * The official SDK's version, recorded even though it CANNOT speak this revision.
   * MCP-04 asks for the version and the compatibility matrix, and "the SDK we did
   * not use, and why" is part of that answer.
   */
  officialSdkVersion: sdkVersion,
  officialSdkSupportsRevision: false,
  officialSdkNote: '@modelcontextprotocol/sdk does not list 2026-07-28 in SUPPORTED_PROTOCOL_VERSIONS, so this server is the schema-conformant adaptation MCP-01 permits rather than an SDK configuration.',
  fixtureCount: fixtures.length,
  credentialPlaceholder: PLACEHOLDER_TOKEN,
  probe: 'scripts/probe-mcp-conformance.mjs',
}, null, 2)}\n`)

console.log(`captured ${fixtures.length} fixtures into ${OUT}`)
for (const fixture of fixtures) console.log(`  ${fixture.name.padEnd(28)} ${fixture.describes}`)
