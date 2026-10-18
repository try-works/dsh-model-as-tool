/**
 * Offline tests for the extension-matrix harness logic (task-110).
 *
 * These exercise the transport-free decision surface only: argv parsing, the exact
 * gateway envelope, requirement coherence, blocker classification, matrix
 * aggregation and report rendering. No network, no host mount, no model assets.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const libUrl = new URL('../../../scripts/lib/ext-matrix-lib.mjs', import.meta.url).href
// Dynamic import so this TypeScript test does not require a declaration file for
// the dependency-free ESM harness library that ships beside the repo scripts.
const lib = await import(libUrl)
const outputsUrl = new URL('../../../scripts/lib/ext-matrix-outputs.mjs', import.meta.url).href
const outputs = await import(outputsUrl)

/** A throwaway directory for the snapshot test. */
function tempDirForHarness(): string {
  return mkdtempSync(join(tmpdir(), 'ext-matrix-harness-test-'))
}

/** Build a coherent describe row for the coherence tests. */
function coherentRow(overrides = {}) {
  return {
    id: '@try-works/extension-x',
    installed: true,
    blocked: false,
    active: true,
    tools: ['x_tool'],
    requirements: [
      { kind: 'store', satisfied: true, reason: 'store configured', action: 'none' },
      { kind: 'integrity', satisfied: true, reason: 'unchanged', action: 'none' },
    ],
    ...overrides,
  }
}

describe('argv parsing', () => {
  it('parses the documented flags and normalizes the base URL', () => {
    const options = lib.parseArgs([
      '--base-url', 'http://127.0.0.1:3097/',
      '--token', 'abc',
      '--only', 'tongue',
      '--only', 'needle',
      '--input-dir', 'E:/fixtures',
      '--out-dir', 'E:/out',
      '--skip-invoke',
    ])
    assert.equal(options.baseUrl, 'http://127.0.0.1:3097')
    assert.equal(options.token, 'abc')
    assert.deepEqual(options.only, ['tongue', 'needle'])
    assert.equal(options.inputDir, 'E:/fixtures')
    assert.equal(options.skipInvoke, true)
  })

  it('refuses missing credentials, bad URLs and unknown flags', () => {
    assert.throws(() => lib.parseArgs([]), lib.UsageError)
    assert.throws(() => lib.parseArgs(['--base-url', 'http://x']), /token/i)
    assert.throws(() => lib.parseArgs(['--base-url', 'ftp://x', '--token', 't']), /http/i)
    assert.throws(() => lib.parseArgs(['--base-url', 'http://x', '--token', 't', '--bogus']), /unknown argument/)
  })
})

describe('gateway RPC shape', () => {
  it('builds the exact client-request envelope and connect URL', () => {
    assert.deepEqual(lib.rpcEnvelope('modelTools/describe', {}, 'r1'), {
      type: 'client-request', rpcId: 'r1', method: 'modelTools/describe', payload: { args: {} },
    })
    assert.equal(lib.connectUrl('http://127.0.0.1:3097', 'a b/c'), 'http://127.0.0.1:3097/connect?token=a%20b%2Fc&interactions=none')
  })

  it('parses both server-response branches and rejects a foreign id', () => {
    assert.deepEqual(
      lib.parseRpcResponse({ type: 'server-response', rpcId: 'r1', result: { ok: true, value: { extensions: [] } } }, 'r1'),
      { ok: true, value: { extensions: [] } },
    )
    const failure = lib.parseRpcResponse({
      type: 'server-response', rpcId: 'r1',
      result: { ok: false, error: { code: 'gateway/internal', message: 'boom', details: {} } },
    }, 'r1')
    assert.equal(failure.ok, false)
    assert.equal(failure.error.message, 'boom')
    assert.throws(() => lib.parseRpcResponse({ type: 'server-response', rpcId: 'other', result: { ok: true, value: 1 } }, 'r1'), /rpcId mismatch/)
    assert.throws(() => lib.parseRpcResponse({ type: 'nope' }, 'r1'), /server-response/)
  })

  it('calls a modelTools method over the API route and surfaces a host refusal', async () => {
    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body), cookie: init.headers.cookie })
      return {
        ok: true,
        async json() {
          return { type: 'server-response', rpcId: JSON.parse(init.body).rpcId, result: { ok: true, value: { extensions: [1] } } }
        },
      }
    }
    const value = await lib.callModelTools({ baseUrl: 'http://127.0.0.1:1', cookie: 'dsh-auth-x', fetchImpl }, 'describe', {})
    assert.deepEqual(value, { extensions: [1] })
    assert.equal(seen[0].url, 'http://127.0.0.1:1/api/modelTools/describe')
    assert.equal(seen[0].body.method, 'modelTools/describe')
    assert.deepEqual(seen[0].body.payload.args, {})
    assert.equal(seen[0].cookie, 'dsh-auth-x')

    const refusing = async (_url: string, init: { body: string }) => ({
      ok: true,
      async json() {
        return {
          type: 'server-response', rpcId: JSON.parse(init.body).rpcId,
          result: { ok: false, error: { code: 'gateway/internal', message: 'refused', details: {} } },
        }
      },
    })
    await assert.rejects(
      lib.callModelTools({ baseUrl: 'http://127.0.0.1:1', cookie: 'c', fetchImpl: refusing }, 'enable', { id: 'x' }),
      (error: unknown) => error instanceof lib.RpcRefusal && /refused/.test(error.message),
    )
  })

  it('extracts the dsh-auth cookie from the connect exchange', async () => {
    const fetchImpl = async () => ({
      status: 302,
      headers: { getSetCookie: () => ['dsh-auth-abc=xyz; Path=/; HttpOnly'], get: () => null },
    })
    const transport = await lib.connectOperator({ baseUrl: 'http://127.0.0.1:1', token: 't' }, fetchImpl)
    assert.equal(transport.cookie, 'dsh-auth-abc=xyz')
  })
})

describe('requirement coherence', () => {
  it('accepts a coherent row and reports each incoherence', () => {
    assert.deepEqual(lib.requirementCoherence([coherentRow()]), [])
    assert.match(lib.requirementCoherence([coherentRow({ blocked: true })])[0], /blocked is true but no unmet/)
    assert.match(
      lib.requirementCoherence([coherentRow({
        blocked: false,
        requirements: [{ kind: 'platform', satisfied: false, reason: 'unsupported', action: 'none' }],
      })])[0],
      /blocked is false but platform/,
    )
    assert.match(
      lib.requirementCoherence([coherentRow({
        requirements: [
          { kind: 'store', satisfied: true, reason: 'ok', action: 'none' },
          { kind: 'store', satisfied: true, reason: 'ok', action: 'none' },
        ],
      })])[0],
      /duplicate requirement kind/,
    )
    assert.match(
      lib.requirementCoherence([coherentRow({
        requirements: [{ kind: 'mystery', satisfied: true, reason: 'ok', action: 'none' }],
      })])[0],
      /unknown requirement kind/,
    )
    assert.match(
      lib.requirementCoherence([coherentRow({
        requirements: [{ kind: 'store', satisfied: true, reason: '', action: 'none' }],
      })])[0],
      /empty reason/,
    )
  })
})

describe('blocker classification and aggregation', () => {
  it('classifies a platform refusal as a NAMED blocker and a timeout as FAIL', () => {
    assert.equal(lib.classifyRefusal(new Error('the extension supports darwin-arm64-cpu but this host is win32/x64')).outcome, 'SKIPPED')
    assert.equal(lib.classifyRefusal(new Error('the extension\'s tools cannot load: runtime missing')).outcome, 'SKIPPED')
    assert.equal(lib.classifyRefusal(new Error('the tarball ... no bytes arrived for 250 ms')).outcome, 'FAIL')
    assert.equal(lib.classifyRefusal(Object.assign(new Error('unexpected'), { code: 'gateway/internal' })).outcome, 'FAIL')
  })

  it('exits 0 only for PASS or SKIPPED with a named host blocker', () => {
    const passing = lib.aggregateMatrix([
      { id: 'a', name: 'a', status: 'PASS', durationMs: 5, tools: [] },
      { id: 'b', name: 'b', status: 'SKIPPED', blocker: 'platform unsupported: ...', durationMs: 3, tools: [] },
    ])
    assert.equal(passing.exitCode, 0)
    assert.equal(passing.summary.pass, 1)
    assert.equal(passing.summary.skippedWithNamedBlocker, 1)

    const unnamedSkip = lib.aggregateMatrix([{ id: 'a', name: 'a', status: 'SKIPPED', blocker: null, durationMs: 1, tools: [] }])
    assert.equal(unnamedSkip.exitCode, 1)
    const failing = lib.aggregateMatrix([{ id: 'a', name: 'a', status: 'FAIL', durationMs: 1, tools: [] }])
    assert.equal(failing.exitCode, 1)
    assert.equal(lib.aggregateMatrix([], { coherenceIssues: ['bad'] }).exitCode, 1)
    assert.equal(lib.aggregateMatrix([], { preconditionError: 'no validator' }).exitCode, 1)
  })

  it('selects extensions by name, id or tool and refuses an unknown selector', () => {
    assert.deepEqual(lib.selectExtensions(['tongue']).map((entry: { name: string }) => entry.name), ['tongue'])
    assert.deepEqual(lib.selectExtensions(['@try-works/extension-needle']).map((entry: { name: string }) => entry.name), ['needle'])
    assert.deepEqual(lib.selectExtensions(['text_embed']).map((entry: { name: string }) => entry.name), ['minilm-embed'])
    assert.throws(() => lib.selectExtensions(['nope']), lib.UsageError)
    assert.equal(lib.selectExtensions([]).length, lib.MATRIX_EXTENSIONS.length)
  })

  it('renders the matrix with durations and the exact blocker text', () => {
    const markdown = lib.renderMarkdown({
      baseUrl: 'http://127.0.0.1:3097',
      generatedAt: '2026-01-01T00:00:00.000Z',
      exitCode: 1,
      rows: [
        { name: 'tongue', status: 'PASS', durationMs: 1234, blocker: null, detail: null },
        { name: 'laya', status: 'SKIPPED', durationMs: 10, blocker: 'platform unsupported: darwin only' },
        { name: 'needle', status: 'FAIL', durationMs: 5, detail: 'boom' },
      ],
      tools: [{ id: 'lang_detect', extension: 'tongue', ok: true }],
      summary: { coherenceIssues: ['row blocked incoherently'] },
    })
    assert.match(markdown, /tongue \| PASS \| 1\.2s/)
    assert.match(markdown, /laya \| SKIPPED .*platform unsupported: darwin only/)
    assert.match(markdown, /needle \| FAIL .*boom/)
    assert.match(markdown, /lang_detect \| tongue \| PASS/)
    assert.match(markdown, /row blocked incoherently/)
  })
})

describe('task-119 invocation fixes', () => {
  it('resolves invocation media paths to absolute, existing files', () => {
    const stt = outputs.MATRIX_TOOLS.find((entry: { id: string }) => entry.id === 'stt_transcribe')
    const args = lib.resolveInvocationArgs(outputs.loadInput(stt.input), outputs.FIXTURE_DIR)
    assert.equal(typeof args.audio?.path, 'string')
    assert.equal(args.audio.path.startsWith(outputs.FIXTURE_DIR), true)
    assert.equal(existsSync(args.audio.path), true)
    assert.throws(
      () => lib.resolveInvocationArgs({ audio: { path: 'assets/missing.wav' } }, outputs.FIXTURE_DIR),
      /does not exist/,
    )
    assert.throws(() => lib.resolveInvocationArgs({ audio: { path: '' } }, outputs.FIXTURE_DIR), /empty/)
  })

  it('maps manifest tools and standard-contract implementations to registered names', () => {
    const contractToolNames = new Map([['text.embed', 'text_embed'], ['text.title', 'text_title'], ['image.describe', 'describe_image']])
    assert.deepEqual(
      lib.manifestToolNames({ tools: [{ name: 'lang_detect' }], implementations: [] }, contractToolNames),
      ['lang_detect'],
    )
    assert.deepEqual(
      lib.manifestToolNames({ tools: [], implementations: [{ contractId: 'text.embed' }, { contractId: 'text.title' }] }, contractToolNames),
      ['text_embed', 'text_title'],
    )
    assert.deepEqual(lib.manifestToolNames({ tools: [], implementations: [{ contractId: 'unknown.contract' }] }, contractToolNames), [])
  })

  it('classifies ONLY the exact no-LLM host blocker as skippable', () => {
    assert.match(
      lib.invocationEnvironmentBlocker('no chat model is configured for this deployment, so declarative extensions cannot be served') ?? '',
      /harness limitation/,
    )
    assert.match(lib.invocationEnvironmentBlocker('this deployment composes no harness model provider') ?? '', /harness limitation/)
    assert.equal(lib.invocationEnvironmentBlocker('the extension failed to import its entry'), null)
    assert.equal(lib.invocationEnvironmentBlocker('unknown tool text_embed'), null)
  })

  it('classifies ONLY the empty tools_plan result as the named planning harness skip', () => {
    const verdict = { ok: false, failures: ['plan-has-proposals'] }
    assert.equal(lib.isPlanningHarnessSkip('tools_plan', verdict, { value: { proposals: [] } }), true)
    assert.equal(lib.isPlanningHarnessSkip('tools_plan', verdict, { structuredContent: { proposals: [] } }), true)
    assert.equal(lib.isPlanningHarnessSkip('tools_plan', verdict, { value: { proposals: [{ tool: 'structured_extract' }] } }), false)
    assert.equal(lib.isPlanningHarnessSkip('structured_extract', verdict, { value: { proposals: [] } }), false)
    assert.equal(lib.isPlanningHarnessSkip('tools_plan', { ok: true }, { value: { proposals: [] } }), false)
    assert.match(lib.PLANNING_HARNESS_BLOCKER, /host planning adapter/)
    assert.match(lib.PLANNING_HARNESS_BLOCKER, /harness limitation/)
    assert.equal(lib.isInvocationAssetHarnessSkip({ ok: false, refusal: 'the "text-backbone" asset group was not prepared, so text_embed cannot run (MOD-02). The lock records the acquisition status' }), true)
    assert.equal(lib.isInvocationAssetHarnessSkip({ ok: false, refusal: 'unknown tool text_embed' }), false)
    assert.equal(lib.isInvocationAssetHarnessSkip({ ok: true }), false)
  })

  it('finds a prepared artifact inside the live cache groups', () => {
    const cacheRoot = tempDirForHarness()
    const groupDir = join(cacheRoot, 'groups', '@try-works__extension-needle', 'needle3', 'native-engine')
    mkdirSync(groupDir, { recursive: true })
    writeFileSync(join(groupDir, 'needle.exe'), 'engine')
    try {
      assert.equal(lib.findPreparedArtifact(cacheRoot, 'needle.exe'), join(groupDir, 'needle.exe'))
      assert.equal(lib.findPreparedArtifact(cacheRoot, 'absent.bin'), undefined)
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it('selects the plugin build hermetically and only touches a profile on explicit opt-in', async () => {
    const host = await import(new URL('../../../scripts/lib/ext-matrix-host.mjs', import.meta.url).href)
    const savedPlugin = process.env.EXT_MATRIX_PLUGIN
    const savedProfile = process.env.EXT_MATRIX_PROFILE
    try {
      delete process.env.EXT_MATRIX_PLUGIN
      delete process.env.EXT_MATRIX_PROFILE
      assert.match(host.pluginModuleHref(), /packages\/dsh-model-as-tool\/src\/index\.ts$/, 'the DEFAULT is the repository source')
      process.env.EXT_MATRIX_PLUGIN = 'E:/tmp/explicit-plugin.mjs'
      assert.equal(host.pluginModuleHref(), 'E:/tmp/explicit-plugin.mjs')
      delete process.env.EXT_MATRIX_PLUGIN
      process.env.EXT_MATRIX_PROFILE = 'ext-matrix-profile-that-does-not-exist-for-this-test'
      assert.throws(() => host.pluginModuleHref(), /names a profile with no installed plugin build/)
    } finally {
      if (savedPlugin === undefined) delete process.env.EXT_MATRIX_PLUGIN
      else process.env.EXT_MATRIX_PLUGIN = savedPlugin
      if (savedProfile === undefined) delete process.env.EXT_MATRIX_PROFILE
      else process.env.EXT_MATRIX_PROFILE = savedProfile
    }
  })

  it('copies the live store private directory (and lock install paths) into the snapshot', async () => {
    const host = await import(new URL('../../../scripts/lib/ext-matrix-host.mjs', import.meta.url).href)
    const sdk = await import('@try-works/tool-mode-extension-sdk')
    const live = tempDirForHarness()
    const installPath = join(live, 'extensions', '@try-works', 'fixture', '1.0.0')
    mkdirSync(join(live, 'extension-private', '@try-works', 'fixture'), { recursive: true })
    writeFileSync(join(live, 'extension-private', '@try-works', 'fixture', 'needle.exe'), 'engine')
    mkdirSync(installPath, { recursive: true })
    writeFileSync(join(installPath, 'package.json'), '{}')
    new sdk.ExtensionStore(live).recordInstall({
      extensionId: '@try-works/fixture',
      version: '1.0.0',
      installPath,
      archiveDigest: 'a'.repeat(128),
      contentDigest: 'b'.repeat(64),
      source: { kind: 'local', requested: live },
      installedAt: new Date().toISOString(),
    })
    const snapshot = host.snapshotStore(live)
    try {
      const copied = join(snapshot, 'extension-private', '@try-works', 'fixture', 'needle.exe')
      assert.equal(existsSync(copied), true)
      assert.equal(readFileSync(copied, 'utf8'), 'engine')
      const record = new sdk.ExtensionStore(snapshot).listInstalled().value.find((candidate: { extensionId: string }) => candidate.extensionId === '@try-works/fixture')
      assert.equal(record?.installPath, installPath, 'the snapshot keeps the LIVE absolute install path')
    } finally {
      rmSync(snapshot, { recursive: true, force: true })
      rmSync(live, { recursive: true, force: true })
    }
  })
})

describe('task-111 contract compatibility (real fixtures + validators)', () => {
  it('covers every matrix tool and maps every entry to a known extension', () => {
    const expectedTools = new Set(lib.MATRIX_EXTENSIONS.flatMap((entry: { tools: string[] }) => entry.tools))
    const seen = new Set(outputs.MATRIX_TOOLS.map((entry: { id: string, toolName: string }) => entry.toolName))
    for (const tool of expectedTools) {
      assert.equal(seen.has(tool as string), true, `MATRIX_TOOLS is missing ${tool as string}`)
    }
    for (const entry of outputs.MATRIX_TOOLS) {
      const mapped = lib.MATRIX_EXTENSIONS.find((candidate: { id?: string, name?: string, tools: string[] }) =>
        candidate.id === entry.extension || candidate.name === entry.extension || candidate.tools.includes(entry.toolName))
      assert.ok(mapped !== undefined, `${entry.id} maps to no matrix extension`)
      const args = outputs.loadInput(entry.input)
      assert.doesNotThrow(() => JSON.stringify(args), `${entry.id}: loadInput must be JSON-serializable`)
    }
  })

  it('never throws on a malformed result and keeps refusal-less failures as failures', () => {
    for (const entry of outputs.MATRIX_TOOLS) {
      const verdict = outputs.validateToolOutput(entry.id, { garbage: true })
      assert.equal(typeof verdict.ok, 'boolean')
      assert.ok(Array.isArray(verdict.failures))
      assert.equal(lib.verdictFailed(verdict), true)
    }
    assert.equal(lib.verdictFailed({ ok: true }), false)
    assert.equal(lib.verdictFailed({ ok: false, refusal: 'no video decode on this host' }), false)
    assert.equal(lib.verdictFailed({ ok: false, refusal: '' }), true)
    assert.equal(lib.verdictFailed({ ok: false, failures: ['shape'] }), true)
  })
})
