/**
 * Offline logic for the extension matrix harness (task-110).
 *
 * Everything here is transport-free and validator-agnostic so the harness's own
 * decisions can be unit-tested fast: argument parsing, the gateway RPC envelope,
 * requirement coherence, blocker classification, matrix aggregation and report
 * rendering. The live wiring lives in `scripts/ext-matrix.mjs`; the in-process
 * tool-invocation host lives in `scripts/lib/ext-matrix-host.mjs`.
 *
 * @module scripts/lib/ext-matrix-lib
 */

import { existsSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** The eight first-party extension packages, with the contract tools each owns. */
export const MATRIX_EXTENSIONS = [
  { id: '@try-works/extension-desert-ant-tongue', name: 'tongue', tools: ['lang_detect'] },
  { id: '@try-works/extension-desert-ant-voz', name: 'voz', tools: ['stt_transcribe'] },
  { id: '@try-works/extension-embeddinggemma', name: 'embeddinggemma', tools: [
    'multimodal_embed', 'semantic_similarity', 'semantic_rank', 'semantic_classify', 'semantic_deduplicate', 'media_find_moments',
  ] },
  { id: '@try-works/extension-laya', name: 'laya', tools: ['decision_choose', 'decision_test', 'decision_score'] },
  { id: '@try-works/extension-minilm-embed', name: 'minilm-embed', tools: ['text_embed'] },
  { id: '@try-works/extension-minilm-rerank', name: 'minilm-rerank', tools: ['text_rerank'] },
  { id: '@try-works/extension-needle', name: 'needle', tools: ['tools_plan', 'structured_extract'] },
  { id: '@try-works/extension-declarative-recipes', name: 'declarative-recipes', tools: ['text_title', 'describe_image'] },
]

/** Requirement kinds the host may report (kept in sync with the wire union). */
export const REQUIREMENT_KINDS = new Set([
  'store', 'source', 'dependencies', 'runtime', 'assets', 'executable', 'harness-model', 'platform', 'integrity', 'activation',
])

/** Requirement actions the host may report. */
export const REQUIREMENT_ACTIONS = new Set(['install', 'prepare', 'enable', 'config', 'none'])

/** Kinds that can prevent activation of an INSTALLED row. */
const INSTALLED_BLOCKING = new Set([...REQUIREMENT_KINDS].filter(kind => kind !== 'store' && kind !== 'source'))

/** Kinds that prevent a not-yet-installed row from ever installing/activating. */
const UNINSTALLED_BLOCKING = new Set(['store', 'source', 'dependencies', 'platform', 'harness-model', 'runtime'])

/**
 * Host-facing refusals that are an HONEST BLOCKER for this deployment.
 *
 * A matrix entry may be SKIPPED (exit 0) only for one of these, and only with the
 * exact host text recorded. Transport/timeout/unknown failures are FAIL.
 */
export const HOST_BLOCKER_PATTERNS = [
  [/requires? .*platform|supports only|but this host/i,
    'platform unsupported by this host'],
  [/no harness model provider|harness model provider|declarative extensions|config\.harnessModel/i,
    'the deployment composes no harness model provider'],
  [/allowExecutablePreparation.*off|executable preparation is not approved/i,
    'executable-asset preparation is not approved'],
  [/tools cannot load|tool runtime .* not installed|extension-runtime-unavailable/i,
    'optional tool runtime could not be materialized'],
  [/not found on the npm registry|no published version/i,
    'the registry has no satisfying package version'],
  [/needs its model assets prepared|extension-preparation-required/i,
    'the model assets are not prepared on this host'],
  [/ASSET_SOURCE_UNAVAILABLE|declares no download URL|must be produced by the documented export/i,
    'the asset lock declares no download location; the artifacts require the documented manual export'],
  [/missing.*sha512|declares no sha512/i,
    'the registry declares no verifiable integrity'],
  [/not usable extension|not a usable extension|EINTEGRITY|INTEGRITY_MISMATCH/i,
    'the package failed discovery or integrity verification'],
  [/already recorded as installed|UPGRADE_FAILED/i,
    'an incompatible version is already installed'],
]

/** Parse argv into harness options; throws a named UsageError for bad input. */
export class UsageError extends Error {
  name = 'UsageError'
}

/**
 * Parse the harness command line.
 * @param {readonly string[]} argv - process.argv.slice(2).
 * @returns {object} normalized options.
 */
export function parseArgs(argv) {
  const options = {
    baseUrl: '',
    token: '',
    tokenFile: '',
    only: [],
    outDir: 'verification/ext-matrix',
    inputDir: '',
    skipInvoke: false,
    dryRun: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = argv[index + 1]
    switch (argument) {
      case '--base-url': options.baseUrl = takeValue(argument, next); index += 1; break
      case '--token': options.token = takeValue(argument, next); index += 1; break
      case '--token-file': options.tokenFile = takeValue(argument, next); index += 1; break
      case '--only': options.only.push(takeValue(argument, next)); index += 1; break
      case '--out-dir': options.outDir = takeValue(argument, next); index += 1; break
      case '--input-dir': options.inputDir = takeValue(argument, next); index += 1; break
      case '--skip-invoke': options.skipInvoke = true; break
      case '--dry-run': options.dryRun = true; break
      case '--help': case '-h': options.help = true; break
      default: throw new UsageError(`unknown argument ${JSON.stringify(argument)}`)
    }
  }
  if (options.baseUrl.endsWith('/')) options.baseUrl = options.baseUrl.slice(0, -1)
  if (options.baseUrl === '' && !options.help) throw new UsageError('--base-url is required (e.g. http://127.0.0.1:3097)')
  if (!/^https?:\/\//i.test(options.baseUrl) && !options.help) throw new UsageError('--base-url must be http(s)')
  if (options.token === '' && options.tokenFile === '' && !options.help) {
    throw new UsageError('--token or --token-file is required (the token the launcher printed)')
  }
  // Normalize --only names to extension names/ids.
  options.only = options.only.map(value => value.trim()).filter(value => value.length > 0)
  return options
}

function takeValue(name, value) {
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value`)
  return value
}

/** The connect URL that exchanges the launch token for an API operator cookie. */
export function connectUrl(baseUrl, token) {
  return `${baseUrl}/connect?token=${encodeURIComponent(token)}&interactions=none`
}

/** Extract the operator cookie from a connect response's set-cookie headers. */
export function operatorCookie(headers) {
  const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  const fallback = headers.get('set-cookie')
  const candidates = values.length > 0 ? values : (fallback === null ? [] : [fallback])
  for (const candidate of candidates) {
    const pair = candidate.split(';', 1)[0]?.trim() ?? ''
    if (pair.startsWith('dsh-auth-')) return pair
  }
  return ''
}

/** The exact gateway client-request envelope (see client/connection/src/rpc.ts). */
export function rpcEnvelope(endpoint, args, rpcId) {
  return { type: 'client-request', rpcId, method: endpoint, payload: { args } }
}

/** A host refusal surfaced through the gateway's server-response error branch. */
export class RpcRefusal extends Error {
  name = 'RpcRefusal'
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
  }
}

/** Parse one `type:server-response` envelope; throws for malformed/foreign ids. */
export function parseRpcResponse(body, expectedRpcId) {
  if (typeof body !== 'object' || body === null || body.type !== 'server-response') {
    throw new Error('the gateway response is not a server-response envelope')
  }
  if (body.rpcId !== expectedRpcId) {
    throw new Error(`rpcId mismatch: sent ${expectedRpcId}, got ${String(body.rpcId)}`)
  }
  const result = body.result
  if (typeof result !== 'object' || result === null) throw new Error('the gateway response carries no result')
  if (result.ok === true) return { ok: true, value: result.value }
  if (result.ok !== false || typeof result.error !== 'object' || result.error === null) {
    throw new Error('the gateway failure branch is malformed')
  }
  const error = result.error
  return {
    ok: false,
    error: { code: String(error.code ?? 'unknown'), message: String(error.message ?? ''), details: error.details ?? {} },
  }
}

/**
 * Call one modelTools method against a live profile through the gateway RPC.
 * @param {object} transport - {fetchImpl, baseUrl, cookie} from connectOperator.
 * @param {string} method - e.g. 'describe' (namespace is fixed to modelTools).
 * @param {object} args - named wire arguments.
 * @returns {Promise<unknown>} the host member's value.
 * @throws {RpcRefusal} for a host refusal.
 */
export async function callModelTools(transport, method, args = {}) {
  const endpoint = `modelTools/${method}`
  const rpcId = `matrix-${method}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const response = await transport.fetchImpl(`${transport.baseUrl}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: transport.cookie },
    body: JSON.stringify(rpcEnvelope(endpoint, args, rpcId)),
  })
  if (!response.ok) {
    throw new Error(`transport failure for ${endpoint}: HTTP ${response.status}`)
  }
  const parsed = parseRpcResponse(await response.json(), rpcId)
  if (!parsed.ok) throw new RpcRefusal(parsed.error.code, parsed.error.message, parsed.error.details)
  return parsed.value
}

/** Connect, exchange the launch token for an operator cookie, and bind the transport. */
export async function connectOperator(options, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(connectUrl(options.baseUrl, options.token), { redirect: 'manual' })
  const cookie = operatorCookie(response.headers)
  if (cookie === '') {
    throw new Error(`the operator connect exchange failed: HTTP ${response.status} without a dsh-auth cookie`)
  }
  return { baseUrl: options.baseUrl, cookie, fetchImpl }
}

/**
 * Verify that every describe row's requirements are self-consistent.
 * @param {readonly object[]} rows - describe rows.
 * @returns {string[]} operator-facing issues (empty when coherent).
 */
export function requirementCoherence(rows) {
  const issues = []
  if (!Array.isArray(rows)) return ['describe returned no extensions array']
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id : '(row without id)'
    if (typeof row?.id !== 'string' || row.id.length === 0) issues.push('a row has no id')
    if (typeof row?.installed !== 'boolean') issues.push(`${id}: installed is not a boolean`)
    if (typeof row?.blocked !== 'boolean') issues.push(`${id}: blocked is not a boolean`)
    if (!Array.isArray(row?.tools)) issues.push(`${id}: tools is not an array`)
    if (!Array.isArray(row?.requirements)) { issues.push(`${id}: requirements is not an array`); continue }
    const kinds = new Set()
    for (const requirement of row.requirements) {
      if (typeof requirement !== 'object' || requirement === null) { issues.push(`${id}: a requirement is not an object`); continue }
      if (!REQUIREMENT_KINDS.has(requirement.kind)) issues.push(`${id}: unknown requirement kind ${String(requirement.kind)}`)
      if (kinds.has(requirement.kind)) issues.push(`${id}: duplicate requirement kind ${requirement.kind}`)
      kinds.add(requirement.kind)
      if (typeof requirement.satisfied !== 'boolean') issues.push(`${id}/${requirement.kind}: satisfied is not a boolean`)
      if (typeof requirement.reason !== 'string' || requirement.reason.length === 0) issues.push(`${id}/${requirement.kind}: empty reason`)
      if (!REQUIREMENT_ACTIONS.has(requirement.action)) issues.push(`${id}/${requirement.kind}: unknown action ${String(requirement.action)}`)
    }
    const unmet = row.requirements.filter(requirement => requirement.satisfied === false)
    const blockingSet = row.installed === true ? INSTALLED_BLOCKING : UNINSTALLED_BLOCKING
    const blockingUnmet = unmet.filter(requirement => blockingSet.has(requirement.kind))
    if (row.blocked === true && blockingUnmet.length === 0) {
      issues.push(`${id}: blocked is true but no unmet requirement actually blocks ${row.installed === true ? 'an installed' : 'a source-only'} row`)
    }
    if (row.blocked === false && blockingUnmet.length > 0) {
      issues.push(`${id}: blocked is false but ${blockingUnmet.map(requirement => requirement.kind).join(', ')} cannot be satisfied`)
    }
    if (row.blocked === true && (typeof row.reason !== 'string' || row.reason.length === 0)) {
      issues.push(`${id}: blocked row has no reason`)
    }
  }
  return issues
}

/**
 * Classify a refusal as an honest host blocker (SKIPPED, exit 0) or a FAIL.
 * @param {Error|{code?: string, message?: string}} error - the refusal.
 * @returns {{outcome: 'SKIPPED'|'FAIL', blocker: string|null}} classification.
 */
export function classifyRefusal(error) {
  const message = typeof error?.message === 'string' ? error.message : String(error)
  for (const [pattern, label] of HOST_BLOCKER_PATTERNS) {
    if (pattern.test(message)) return { outcome: 'SKIPPED', blocker: `${label}: ${message}` }
  }
  return { outcome: 'FAIL', blocker: null }
}

/** Resolve one --only selector ("tongue", a full id, or an index) to extension entries. */
export function selectExtensions(only) {
  if (only.length === 0) return [...MATRIX_EXTENSIONS]
  const selected = []
  for (const selector of only) {
    const match = MATRIX_EXTENSIONS.find(entry =>
      entry.name === selector || entry.id === selector || entry.tools.includes(selector))
    if (match === undefined) throw new UsageError(`--only ${JSON.stringify(selector)} names no matrix extension or tool`)
    if (!selected.some(entry => entry.id === match.id)) selected.push(match)
  }
  return selected
}

/**
 * Fold per-extension results into the matrix summary and the exit code.
 *
 * Exit 0 requires: no FAILs, no SKIPPED without a named host blocker, no
 * coherence/precondition failures, and (unless the operator passed --skip-invoke)
 * every selected extension's tool verdicts passing.
 * @param {readonly object[]} entries - per-extension results.
 * @param {object} extra - {coherenceIssues, invocationRan, preconditionError}.
 * @returns {{summary: object, exitCode: number}} aggregated outcome.
 */
export function aggregateMatrix(entries, extra = {}) {
  const rows = entries.map(entry => ({
    id: entry.id,
    name: entry.name,
    status: entry.status,
    durationMs: entry.durationMs ?? 0,
    blocker: entry.blocker ?? null,
    detail: entry.detail ?? null,
    tools: entry.tools ?? [],
  }))
  const summary = {
    total: rows.length,
    pass: rows.filter(row => row.status === 'PASS').length,
    fail: rows.filter(row => row.status === 'FAIL').length,
    skipped: rows.filter(row => row.status === 'SKIPPED').length,
    skippedWithNamedBlocker: rows.filter(row => row.status === 'SKIPPED' && typeof row.blocker === 'string' && row.blocker.length > 0).length,
    coherenceIssues: extra.coherenceIssues ?? [],
    invocationRan: extra.invocationRan !== false,
  }
  const invalidSkip = rows.some(row => row.status === 'SKIPPED' && (typeof row.blocker !== 'string' || row.blocker.length === 0))
  const exitCode = summary.fail === 0
    && summary.skippedWithNamedBlocker === summary.skipped
    && !invalidSkip
    && summary.coherenceIssues.length === 0
    && extra.preconditionError === undefined
    ? 0
    : 1
  return { rows, summary, exitCode }
}

/**
 * Whether a task-111 tool verdict must FAIL the extension.
 *
 * A verdict with `ok:false` is still an ALLOWABLE named outcome when the validator
 * reported `refusal` (e.g. media_find_moments honestly refusing without video
 * support); only a refusal-less failure fails the extension.
 * @param {{ok?: boolean, refusal?: unknown}} verdict - the validator verdict.
 * @returns {boolean} whether this verdict is a failure.
 */
export function verdictFailed(verdict) {
  if (verdict?.ok === true) return false
  return !(typeof verdict?.refusal === 'string' && verdict.refusal.length > 0)
}

/**
 * The tool names one extension manifest actually registers.
 *
 * Direct `tools[].name` entries plus the standard CONTRACT tool name of every
 * implementation (`text.embed` -> `text_embed`), never the dotted contract id.
 * @param {object} manifest - tool-mode.extension.json contents.
 * @param {ReadonlyMap<string, string>} contractToolNames - contract id -> tool name.
 * @returns {string[]} registered tool names.
 */
export function manifestToolNames(manifest, contractToolNames) {
  const names = new Set()
  for (const tool of manifest?.tools ?? []) {
    if (typeof tool?.name === 'string' && tool.name.length > 0) names.add(tool.name)
  }
  for (const implementation of manifest?.implementations ?? []) {
    const toolName = contractToolNames.get(implementation?.contractId)
    if (typeof toolName === 'string' && toolName.length > 0) names.add(toolName)
  }
  return [...names]
}

/**
 * Find a prepared artifact FILE under a live prepared-assets cache.
 *
 * The cache layout is `<cacheRoot>/groups/<extension__id>/<modelId>/<group>/<file>`.
 * The invocation host uses the LIVE prepared bytes read-only for extensions that
 * resolve artifacts from their private directory (needle reads its engine/weights
 * from there, or from the documented environment overrides).
 * @param {string} cacheRoot - the live asset cache root.
 * @param {string} fileName - the lock file name to find (e.g. needle.exe).
 * @returns {string|undefined} the absolute prepared path.
 */
export function findPreparedArtifact(cacheRoot, fileName) {
  const groups = join(cacheRoot, 'groups')
  if (!existsSync(groups)) return undefined
  const visit = (directory, depth) => {
    if (depth < 0) return undefined
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return undefined
    }
    for (const entry of entries) {
      if (entry.name === fileName && entry.isFile()) return join(directory, entry.name)
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const found = visit(join(directory, entry.name), depth - 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  return visit(groups, 6)
}

/** The named harness blocker for a planning call that cannot see the live agent snapshot. */
export const PLANNING_HARNESS_BLOCKER =
  'the in-process invocation host composes the host planning adapter but has no Agent turn context, '
  + 'so the frozen planning snapshot is not applied (harness limitation); the live agent host produces a real plan'

/**
 * Whether a tools_plan verdict is the harness's empty-plan limitation, not a product failure.
 *
 * The extension's own plan validator is right to reject `proposals: []`. The
 * in-process host invokes the tool outside an Agent turn, so the host planning
 * adapter's snapshot differs from the live agent's; an empty plan there must be a
 * named SKIP, never a product FAIL.
 * @param {string} id - the matrix invocation id.
 * @param {{ok?: boolean}} verdict - the validator verdict.
 * @param {unknown} result - the raw tool result.
 * @returns {boolean} whether this is the named planning limitation.
 */
export function isPlanningHarnessSkip(id, verdict, result) {
  if (id !== 'tools_plan') return false
  if (verdict?.ok === true) return false
  const value = result?.value ?? result?.structuredContent
  return typeof value === 'object' && value !== null && Array.isArray(value.proposals) && value.proposals.length === 0
}

/** The named harness blocker for an extension whose assets the snapshot host lacks. */
export const INVOCATION_ASSET_BLOCKER =
  'the in-process invocation host does not carry the live host\'s prepared-asset map (harness limitation); '
  + 'the live host serves this tool after a successful prepare'

/**
 * Whether a verdict is the snapshot host's missing prepared-asset map.
 *
 * The live host proves the extension loads and is callable; the separate
 * invocation process has no in-memory prepared-assets registry. Only the exact
 * MOD-02 "asset group was not prepared" refusal is skippable.
 * @param {{ok?: boolean, refusal?: unknown}} verdict - the validator verdict.
 * @returns {boolean} whether this is the named asset-map limitation.
 */
export function isInvocationAssetHarnessSkip(verdict) {
  if (verdict?.ok === true) return false
  return typeof verdict?.refusal === 'string' && /asset group was not prepared|the lock records the acquisition status/i.test(verdict.refusal)
}

/** Compare two dotted numeric-ish versions (enough for extension versions). */
export function compareVersions(left, right) {
  const parts = value => String(value).split(/[.+-]/).map(part => Number.parseInt(part, 10) || 0)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Classify an invocation-host refusal that is a HARNESS ENVIRONMENT LIMITATION.
 *
 * Only the exact no-LLM-provider blocker is skippable: the in-process host mounts
 * no harness provider for declarative recipes, while the live host serves them.
 * Anything else stays a FAIL so a real defect cannot hide behind the skip.
 * @param {string} message - the activation/invocation refusal text.
 * @returns {string|null} the named blocker, or null when it is not skippable.
 */
export function invocationEnvironmentBlocker(message) {
  if (/no chat model is configured|no harness model provider|harness model provider is not configured|config\.harnessModel/i.test(message)) {
    return 'the invocation host composes no LLM provider (harness limitation; the live host serves declarative recipes via the agent)'
  }
  return null
}

/**
 * Resolve and VERIFY every media `path` in invocation args before a call.
 *
 * A host validates `minLength: 1` on such a path and then opens it, so an empty or
 * relative path is a HARNESS bug. Path fields are resolved against the fixture
 * directory and must exist.
 * @param {unknown} value - the invocation args.
 * @param {string} fixtureDir - the committed fixture directory.
 * @returns {unknown} args with absolute, existing media paths.
 * @throws Error naming the offending path.
 */
export function resolveInvocationArgs(value, fixtureDir) {
  const walk = (node, key) => {
    if (Array.isArray(node)) return node.map(item => walk(item, key))
    if (typeof node === 'string') {
      if (key !== 'path') return node
      if (node.trim().length === 0) throw new Error('a fixture media path is empty')
      const absolute = isAbsolute(node) ? node : join(fixtureDir, node.replace(/^\.\//, ''))
      if (!existsSync(absolute)) throw new Error(`the fixture media path ${JSON.stringify(node)} does not exist at ${absolute}`)
      return absolute
    }
    if (typeof node === 'object' && node !== null) {
      const result = {}
      for (const [childKey, childValue] of Object.entries(node)) result[childKey] = walk(childValue, childKey)
      return result
    }
    return node
  }
  return walk(value, '')
}

/** Render the Markdown matrix report. */
export function renderMarkdown(report) {
  const lines = [
    '# Extension matrix',
    '',
    `- profile base URL: \`${report.baseUrl}\``,
    `- generated: ${report.generatedAt}`,
    `- exit: ${report.exitCode}`,
    '',
    '| extension | status | duration | blocker / detail |',
    '| --- | --- | --- | --- |',
  ]
  for (const row of report.rows) {
    const status = row.status === 'PASS' ? 'PASS' : row.status === 'SKIPPED' ? 'SKIPPED' : 'FAIL'
    const note = (row.blocker ?? row.detail ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
    lines.push(`| ${row.name} | ${status} | ${(row.durationMs / 1000).toFixed(1)}s | ${note} |`)
  }
  if (Array.isArray(report.tools) && report.tools.length > 0) {
    lines.push('', '## Tool verdicts', '', '| id | extension | verdict | detail |', '| --- | --- | --- | --- |')
    for (const tool of report.tools) {
      const verdict = tool.skipped === true ? 'SKIPPED' : tool.ok ? 'PASS' : 'FAIL'
      const detail = (tool.detail ?? tool.failures?.join(', ') ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
      lines.push(`| ${tool.id} | ${tool.extension} | ${verdict} | ${detail} |`)
    }
  }
  if (report.summary?.coherenceIssues?.length > 0) {
    lines.push('', '## Requirement coherence issues', '')
    for (const issue of report.summary.coherenceIssues) lines.push(`- ${issue}`)
  }
  return `${lines.join('\n')}\n`
}
