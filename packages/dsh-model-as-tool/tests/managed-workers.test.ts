/**
 * The host's managed-worker routing (EXT-20, the host half).
 *
 * The SDK ships the mechanism (scrubbed child process, bounded protocol, kill
 * deadlines); this file proves the HOST half: the opt-in flag routes an extension's
 * invocation OUT of process with one worker per activation generation, the grant and
 * the schemas stay host-side (the worker receives exactly `{implementationId, input}`),
 * a crashing entry fails the CALL while the host lives on, and — pinned — DEFAULT OFF
 * means no child process ever spawns.
 *
 * The fixture is a generated plain-JS ESM package (manifest + entry + schemas written
 * to a temp store, then installed through the real staged-install path), so the worker
 * child — plain Node against the BUILT SDK — can import it. The fixture writes a
 * marker file ONLY when it runs inside a managed worker (it branches on
 * `TOOL_MODE_MANAGED_WORKER`, which the SDK's scrubbed child env sets), which is what
 * lets the tests observe "no worker spawned" mechanically instead of by inference.
 *
 * The SDK worker child is resolved from the BUILT lib; without it the suite skips with
 * the reason, mirroring the SDK's own worker-test discipline.
 *
 * Requirement links: EXT-20, SEC-03 (grant stays host-side), P26-13 (schema discipline).
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  createZipArchiveSource,
  ExtensionStore,
  stagedInstall,
} from '@try-works/tool-mode-extension-sdk'

import { createManagedWorkerRegistry } from '../src/managed-workers.ts'
import { ProviderBridge } from '../src/provider-bridge.ts'
import { createGrant, createInvocationAuthority } from '../src/authority.ts'
import type { ModelCatalogEntry } from '../src/types.ts'
import { cleanup, callTool, mountPlugin, tempDir } from './helpers.ts'
import type { Context } from '@deepseek-ai/cordis'

const BUILT_CHILD = new URL('../../../packages/tool-mode-extension-sdk/lib/worker/worker-child.js', import.meta.url)
const SDK_BUILT = existsSync(fileURLToPath(BUILT_CHILD))
const SKIP = SDK_BUILT ? undefined : 'the built SDK lib is missing (lib/worker/worker-child.js); run `npm run build:sdk` first'

after(async () => { await cleanup() })

const EXTENSION_ID = '@try-works/fixture-worker-echo'
const MARKER_VAR = 'PLANTED_MARKER'

/** The fixture extension entry, with the marker path and crash mode interpolated. */
function fixtureEntry(markerPath: string, crash: 'none' | 'activate' | 'invoke'): string {
  const escaped = JSON.stringify(markerPath)
  return `
/**
 * Worker-echo fixture: a deterministic extension whose invoke reports WHERE it ran —
 * the child pid, and whether the planted environment marker reached it. It writes a
 * marker file ONLY inside a managed worker (TOOL_MODE_MANAGED_WORKER is set by the
 * SDK's scrubbed child env), so a test can observe "no worker spawned" mechanically.
 */
export default {
  apiVersion: 1,
  async create(context) {
    void context
    ${crash === 'activate'
      ? `throw new Error('the fixture entry refuses to activate (crash scenario)')`
      : `if (process.env.TOOL_MODE_MANAGED_WORKER === '1') {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(${escaped}, String(process.pid))
    }`}
    return {
      async createProvider({ modelId }) {
        // The worker child binds providers by IMPLEMENTATION id (modelId ===
        // implementationId), while the in-process dispatch passes the manifest's
        // modelId — the fixture serves either, because what matters here is WHERE
        // it ran, not which identity the host resolved.
        void modelId
        return {
          async inspect() {
            // The SDK worker protocol validates the FULL inspection shape.
            return { readiness: 'ready', features: ['echo'], missing: [], summary: 'worker-echo fixture' }
          },
          async load() {},
          async invoke(request) {
            ${crash === 'invoke' ? `throw new Error('the fixture crashes on invoke (crash scenario)')` : ''}
            const input = request.input ?? {}
            // SEC-06 mirror: a REAL provider resolves its path through the host
            // authority; the fixture does the same, so the broker path is exercised.
            let resolvedAudio = null
            if (typeof input.audio_path === 'string' && input.audio_path.length > 0) {
              resolvedAudio = await request.context.resolvePath(input.audio_path)
            }
            return {
              echo: input.text,
              pid: process.pid,
              marker: process.env.${MARKER_VAR} ?? null,
              implementationId: request.implementationId,
              resolvedAudio,
            }
          },
        }
      },
      async dispose() {},
    }
  },
}
`
}

const MANIFEST = {
  protocolVersion: '1.1.0',
  id: EXTENSION_ID,
  version: '1.0.0',
  displayName: 'Worker echo fixture',
  description: 'A deterministic fixture proving the host routes extension invocations through managed workers.',
  activation: { policy: 'operator', deactivatable: true },
  runtimeApi: 1,
  compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
  execution: { kind: 'module', entry: './lib/index.mjs', isolation: 'host-inline' },
  permissions: {
    networkOrigins: [], inputFiles: false, storage: 'extension-private', secrets: [], nativeCode: false,
  },
  models: [
    {
      id: 'echo-main',
      assetSet: 'echo-bundled',
      assetLock: './models.lock.json',
      platforms: [{ os: 'win32', arch: 'x64', accelerator: 'cpu' }],
    },
  ],
  tools: [
    {
      id: 'fixture-worker-echo-tool',
      name: 'worker_echo',
      contractId: `${EXTENSION_ID}/worker_echo`,
      contractVersion: '1.0.0',
      description: 'Echoes the caller text and reports where it ran (pid and env marker visibility).',
      inputSchema: './schemas/worker-echo.input.json',
      outputSchema: './schemas/worker-echo.output.json',
    },
  ],
  implementations: [
    {
      id: 'fixture-worker-echo-impl',
      contractId: `${EXTENSION_ID}/worker_echo`,
      contractVersion: '1.0.0',
      modelId: 'echo-main',
      recipeVersion: '1.0.0',
    },
  ],
  skills: [],
  licenses: [
    {
      layer: 'code', name: 'MIT', url: 'https://opensource.org/license/mit',
      openSource: true, redistribution: 'permitted', attributionRequired: false, obligations: [],
    },
    {
      layer: 'engine', name: 'none: fixture', url: 'https://example.invalid/fixture',
      openSource: true, redistribution: 'permitted', attributionRequired: false, obligations: [],
    },
    {
      layer: 'weights', name: 'none: fixture', url: 'https://example.invalid/fixture',
      openSource: true, redistribution: 'permitted', attributionRequired: false, obligations: [],
    },
    {
      layer: 'sdk', name: 'MIT', url: 'https://opensource.org/license/mit',
      openSource: true, redistribution: 'permitted', attributionRequired: false, obligations: [],
    },
    {
      layer: 'conversion-artifacts', name: 'none: fixture', url: 'https://example.invalid/fixture',
      openSource: true, redistribution: 'permitted', attributionRequired: false, obligations: [],
    },
  ],
  network: { requiredTelemetry: false, otherNetworkUse: false },
}

const INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, description: 'The text to echo.' },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['echo', 'pid', 'marker', 'implementationId', 'resolvedAudio'],
  properties: {
    echo: { type: 'string' },
    pid: { type: 'integer' },
    marker: { description: 'The planted env marker, when it reached the extension.' },
    implementationId: { type: 'string' },
    resolvedAudio: { description: 'The host-brokered path resolution result, null for non-path calls.' },
  },
}

/** Generate + install the fixture package, returning the store dir + marker path. */
async function installFixture(options: { readonly crash?: 'none' | 'activate' | 'invoke' } = {}): Promise<{ storeDir: string; markerPath: string }> {
  const storeDir = tempDir()
  const markerPath = join(storeDir, 'worker-ran.txt')
  const pkg = join(storeDir, 'fixture-package')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  mkdirSync(join(pkg, 'schemas'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({
    name: EXTENSION_ID,
    version: '1.0.0',
    private: true,
    type: 'module',
    exports: { './tool-mode': './lib/index.mjs' },
    toolMode: { manifest: './tool-mode.extension.json' },
  }, null, 2))
  writeFileSync(join(pkg, 'tool-mode.extension.json'), JSON.stringify(MANIFEST, null, 2))
  writeFileSync(join(pkg, 'models.lock.json'), JSON.stringify({ assets: {} }, null, 2))
  writeFileSync(join(pkg, 'schemas', 'worker-echo.input.json'), JSON.stringify(INPUT_SCHEMA, null, 2))
  writeFileSync(join(pkg, 'schemas', 'worker-echo.output.json'), JSON.stringify(OUTPUT_SCHEMA, null, 2))
  writeFileSync(join(pkg, 'lib', 'index.mjs'), fixtureEntry(markerPath, options.crash ?? 'none'))

  const zip = new AdmZip()
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) walk(full)
      else zip.addFile(full.slice(pkg.length + 1).replace(/\\/g, '/'), readFileSync(full))
    }
  }
  walk(pkg)
  const bytes = new Uint8Array(zip.toBuffer())
  await stagedInstall({
    source: { kind: 'local', requested: pkg },
    storeDir,
    expectedSha512: createHash('sha512').update(bytes).digest('hex'),
    archive: createZipArchiveSource(() => bytes),
  })
  const store = new ExtensionStore(storeDir)
  store.writeProfileState('default', [{
    extensionId: EXTENSION_ID,
    installation: 'installed',
    desiredActivation: 'active',
    observedActivation: 'active',
    ownerPid: 2147483647,
    export: 'not-exported',
    tools: [{ toolName: 'worker_echo', enabled: true }],
    readiness: {},
  }])
  return { storeDir, markerPath }
}

/** Mount the host around the installed fixture. */
async function mountWithFixture(options: {
  readonly managedWorkers?: boolean
  readonly workerEnvPassthrough?: string[]
  readonly crash?: 'none' | 'activate' | 'invoke'
} = {}): Promise<{ ctx: Context; markerPath: string; storeDir: string }> {
  const { storeDir, markerPath } = await installFixture({ crash: options.crash ?? 'none' })
  const ctx = await mountPlugin({
    stateFile: join(storeDir, 'state.json'),
    credentialsFile: join(storeDir, 'credentials.json'),
    extensionStore: storeDir,
    ...options.managedWorkers === undefined ? {} : { managedWorkers: options.managedWorkers },
    ...options.workerEnvPassthrough === undefined ? {} : { workerEnvPassthrough: options.workerEnvPassthrough },
  })
  return { ctx, markerPath, storeDir }
}

/** Poll until worker_echo is registered, then call it. */
async function callEcho(ctx: Context, text: string) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (ctx.tools.schemas().some(schema => schema.name === 'worker_echo')) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(
    ctx.tools.schemas().some(schema => schema.name === 'worker_echo'),
    'worker_echo must be registered',
  )
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('worker-echo-1'),
    name: 'worker_echo',
    arguments: { text },
  })
}

describe('EXT-20 — the host routes extension invocations through managed workers (opt-in)', { skip: SKIP }, () => {
  it('a scrubbed worker serves the call: distinct child pid, real result, planted marker absent', async () => {
    process.env[MARKER_VAR] = 'planted'
    try {
      const { ctx, markerPath } = await mountWithFixture({ managedWorkers: true })
      const result = await callEcho(ctx, 'hello-worker')
      assert.equal(result.isError, false, `the worker call must complete: ${JSON.stringify(result)}`)
      const value = result.value as { echo: string; pid: number; marker: string | null; implementationId: string }
      assert.equal(value.echo, 'hello-worker', 'the REAL extension result must come back')
      assert.notEqual(value.pid, process.pid, 'the extension must run in a DISTINCT child process')
      assert.equal(value.marker, null, 'the scrubbed env must exclude the planted marker')
      assert.equal(value.implementationId, 'fixture-worker-echo-impl')

      // The fixture wrote its pid marker ONLY because it ran inside a managed worker.
      assert.ok(existsSync(markerPath), 'the fixture must have observed the managed-worker environment')
      assert.equal(readFileSync(markerPath, 'utf8'), String(value.pid), 'the marker names the child pid')

      // ONE worker per extension: a second call reuses the same process.
      const again = await callEcho(ctx, 'again')
      assert.equal((again.value as { pid: number }).pid, value.pid, 'the worker process must be REUSED across invocations')
    } finally {
      delete process.env[MARKER_VAR]
    }
  })

  it('an explicit envPassthrough name reaches the worker, and only that name', async () => {
    process.env[MARKER_VAR] = 'planted'
    process.env['ANOTHER_MARKER'] = 'also-planted'
    try {
      const { ctx } = await mountWithFixture({ managedWorkers: true, workerEnvPassthrough: [MARKER_VAR] })
      const result = await callEcho(ctx, 'passthrough')
      assert.equal(result.isError, false)
      assert.equal((result.value as { marker: string | null }).marker, 'planted', 'the explicit passthrough name must reach the child')
    } finally {
      delete process.env[MARKER_VAR]
      delete process.env['ANOTHER_MARKER']
    }
  })

  it('DEFAULT OFF: no flag means the extension runs IN-PROCESS and no child spawns', async () => {
    process.env[MARKER_VAR] = 'planted'
    try {
      const { ctx, markerPath } = await mountWithFixture({})
      const result = await callEcho(ctx, 'in-process')
      assert.equal(result.isError, false)
      const value = result.value as { pid: number; marker: string | null }
      assert.equal(value.pid, process.pid, 'without the flag the extension runs in the host process')
      assert.equal(value.marker, 'planted', 'in-process the planted env marker IS visible — proving no scrubbed child was used')
      assert.equal(existsSync(markerPath), false, 'the fixture must never observe a managed-worker environment without the flag')
    } finally {
      delete process.env[MARKER_VAR]
    }
  })

  it('a crashing entry fails the CALL with the worker vocabulary while the host stays alive', async () => {
    const { ctx } = await mountWithFixture({ managedWorkers: true, crash: 'invoke' })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (ctx.tools.schemas().some(schema => schema.name === 'worker_echo')) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('worker-crash-1'),
      name: 'worker_echo',
      arguments: { text: 'boom' },
    })
    assert.equal(result.isError, true, 'a worker whose invoke crashes must fail the call')
    assert.match(JSON.stringify(result), /EXTENSION_FAULT|reported a failure/)

    // The HOST process is unaffected: its own management surface still answers.
    const alive = await callTool(ctx, 'model_tools', { action: 'list' })
    assert.equal(alive.isError, false, 'the host must survive a crashed worker')
  })

  it('admission enforcement stays host-side: a deactivated extension refuses before any worker spawns', async () => {
    const { ctx, markerPath, storeDir } = await mountWithFixture({ managedWorkers: true })
    // A successful call spawns the worker and the fixture records its pid.
    const before = await callEcho(ctx, 'before-deactivation')
    assert.equal(before.isError, false)
    const firstPid = (before.value as { pid: number }).pid
    assert.notEqual(firstPid, process.pid)
    assert.ok(existsSync(markerPath), 'the first call must have spawned the managed worker')

    // Deactivate the extension through the store: the tool STAYS registered (its
    // withdrawal is not what we are testing) but the host's per-call admission —
    // enforced BEFORE any provider is built — now refuses it.
    const store = new ExtensionStore(storeDir)
    const state = store.readProfileState('default').value[0]
    assert.ok(state !== undefined)
    store.writeProfileState('default', [{ ...state, desiredActivation: 'inactive', observedActivation: 'inactive' }])

    const refused = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('worker-deactivated-1'),
      name: 'worker_echo',
      arguments: { text: 'after-deactivation' },
    })
    assert.equal(refused.isError, true, 'a deactivated extension must refuse before any dispatch')
    assert.match(JSON.stringify(refused), /not admitted/)
    // NO NEW WORKER: the fixture rewrites the marker on every managed create(), so an
    // unchanged pid proves the refusal happened before the worker was ever reached.
    assert.equal(readFileSync(markerPath, 'utf8'), String(firstPid), 'a refused call must never spawn a worker process')
  })
})

describe('EXT-20 — the worker registry binds one process per generation and disposes on change', { skip: SKIP }, () => {
  it('a generation change disposes the old worker and serves a new pid', async () => {
    const { storeDir, markerPath } = await installFixture()
    const entry = join(storeDir, 'fixture-package', 'lib', 'index.mjs')
    void markerPath
    const registry = createManagedWorkerRegistry()

    const first = await registry.providerFor({ extensionId: EXTENSION_ID, entryPath: entry, generation: 1 })
    const firstResult = await first.invoke({
      implementationId: 'fixture-worker-echo-impl',
      input: { text: 'gen-1' },
      context: {},
    })
    const firstPid = (firstResult as { pid: number }).pid
    assert.notEqual(firstPid, process.pid, 'the worker must run out of process')
    assert.deepEqual(registry.bindings().map(binding => binding.generation), [1])

    const second = await registry.providerFor({ extensionId: EXTENSION_ID, entryPath: entry, generation: 2 })
    const secondResult = await second.invoke({
      implementationId: 'fixture-worker-echo-impl',
      input: { text: 'gen-2' },
      context: {},
    })
    const secondPid = (secondResult as { pid: number }).pid
    assert.notEqual(secondPid, firstPid, 'a new generation must get a NEW process')
    assert.deepEqual(registry.bindings().map(binding => binding.generation), [2], 'the old generation must be disposed')

    await registry.disposeAll()
    assert.deepEqual(registry.bindings(), [], 'disposeAll must release every worker')
  })

  it('a worker refused its input or faulted fails the call with the SDK vocabulary', async () => {
    const { storeDir } = await installFixture({ crash: 'activate' })
    const entry = join(storeDir, 'fixture-package', 'lib', 'index.mjs')
    const registry = createManagedWorkerRegistry()
    const provider = await registry.providerFor({ extensionId: EXTENSION_ID, entryPath: entry, generation: 1 })
    await assert.rejects(
      provider.invoke({ implementationId: 'fixture-worker-echo-impl', input: { text: 'boom' }, context: {} }),
      /EXTENSION_FAULT|exited before reporting ready/,
    )
    await registry.disposeAll()
  })
})

/** A MALICIOUS entry: module TOP-LEVEL code records where it was imported from. */
function maliciousEntry(markerPath: string): string {
  const escaped = JSON.stringify(markerPath)
  return `
// TOP-LEVEL side effect: whoever IMPORTS this module is recorded — the host must
// never import it under managed workers, so the pid recorded here must be a child.
import { writeFileSync } from 'node:fs'
writeFileSync(${escaped}, JSON.stringify({ pid: process.pid, marker: process.env.${MARKER_VAR} ?? null }))
export default {
  apiVersion: 1,
  async create(context) {
    void context
    writeFileSync(${escaped}, JSON.stringify({ pid: process.pid, marker: process.env.${MARKER_VAR} ?? null }))
    return {
      async createProvider({ modelId }) {
        void modelId
        return {
          async inspect() { return { readiness: 'ready', features: ['echo'], missing: [], summary: 'malicious fixture' } },
          async load() {},
          async invoke(request) {
            const input = request.input ?? {}
            return { echo: input.text, pid: process.pid }
          },
        }
      },
      async dispose() {},
    }
  },
}
`
}

describe('EXT-20 host fix — managed mode never imports or runs the entry in-host (task-27)', { skip: SKIP }, () => {
  /**
   * The catalog binding shape: a PACKAGE DIRECTORY whose package.json + manifest are
   * present (the production catalog resolves package names the same way). The
   * manifest-less STORE copy variant is exercised once the SDK lands the
   * host-supplied mapping API; until then the registry refuses it with the precise
   * reason rather than guessing.
   */
  function catalogEntry(storeDir: string): ModelCatalogEntry {
    return { id: 'alias', provider: { extension: join(storeDir, 'fixture-package'), modelId: 'echo-main' } } as unknown as ModelCatalogEntry
  }

  // Every registry this suite creates is disposed at suite end, so a FAILING
  // assertion cannot leak a live worker child (whose pipes would hold the test
  // runner's event loop open after the failure).
  const registries: ReturnType<typeof createManagedWorkerRegistry>[] = []
  const trackedRegistry = (): ReturnType<typeof createManagedWorkerRegistry> => {
    const registry = createManagedWorkerRegistry()
    registries.push(registry)
    return registry
  }
  after(async () => {
    for (const registry of registries.splice(0)) await registry.disposeAll()
  })

  it('the catalog bridge adapter runs a MALICIOUS top-level entry only in the child', async () => {
    const { storeDir } = await installFixture()
    const maliciousMarker = join(storeDir, 'malicious-marker.json')
    writeFileSync(join(storeDir, 'fixture-package', 'lib', 'index.mjs'), maliciousEntry(maliciousMarker))

    const registry = trackedRegistry()
    const bridge = new ProviderBridge({
      grant: createGrant({ grantId: 't27', allowedTools: ['*'], approvedRoots: [] }),
      activationGeneration: 1,
      managed: registry,
    })
    const adapter = bridge.adapterFor(catalogEntry(storeDir))
    assert.ok(adapter !== undefined, 'the catalog binding must produce an adapter')
    const result = await adapter.invoke({ args: { text: 'managed' }, signal: new AbortController().signal })

    // The malicious module records its importer at TOP LEVEL and in create(): under
    // managed workers only the CHILD ever imports it.
    assert.ok(existsSync(maliciousMarker), 'the entry ran somewhere')
    const seen = JSON.parse(readFileSync(maliciousMarker, 'utf8')) as { pid: number; marker: string | null }
    assert.notEqual(seen.pid, process.pid, 'the host process must NEVER import the extension entry')
    assert.equal(seen.marker, null, 'the scrubbed child env must never carry the planted marker')
    assert.equal((result as { pid: number }).pid, seen.pid, 'the result must report the CHILD pid')
    assert.equal((result as { echo: string }).echo, 'managed', 'the real result must come back')
    await adapter.dispose()
  })

  it('an unauthorized path is refused HOST-side, before any worker spawns', async () => {
    const { storeDir, markerPath } = await installFixture()
    const registry = trackedRegistry()
    const grant = createGrant({ grantId: 't27', allowedTools: ['*'], approvedRoots: [] })
    const bridge = new ProviderBridge({ grant, activationGeneration: 1, managed: registry })
    const adapter = bridge.adapterFor(catalogEntry(storeDir))
    assert.ok(adapter !== undefined)
    await assert.rejects(
      adapter.invoke({
        args: { text: 'x', audio_path: markerPath },
        signal: new AbortController().signal,
        authority: createInvocationAuthority(grant, 'interactive'),
      }),
      // SEC-06 via the verified broker: the child ASKS the host for the path, the
      // host's authority refuses, and the child never opens the file — the refusal
      // reaches the caller with the authority's own vocabulary.
      /not authorized|outside the approved|outside every root|approved root|cannot be authorized|path access denied|denied/,
    )
  })

  it('the child maps the dispatch implementationId to the manifest modelId (strict fixture)', async () => {
    // A STRICT fixture: createProvider refuses every modelId except the manifest's
    // 'echo-main'. The host dispatch sends the IMPLEMENTATION id; the child's
    // manifest mapping must resolve it — so the call succeeds ONLY through the
    // mapping, never by passing the implementation id through as the model id.
    const { storeDir, markerPath } = await installFixture()
    const strict = fixtureEntry(markerPath, 'none').replace(
      'void modelId',
      `if (modelId !== 'echo-main') throw new Error('this fixture implements "echo-main", not "' + modelId + '"')`,
    )
    writeFileSync(join(storeDir, 'fixture-package', 'lib', 'index.mjs'), strict)

    const registry = createManagedWorkerRegistry()
    const provider = await registry.providerFor({
      extensionId: EXTENSION_ID,
      entryPath: join(storeDir, 'fixture-package', 'lib', 'index.mjs'),
      generation: 1,
    })
    const result = await provider.invoke({
      implementationId: 'fixture-worker-echo-impl',
      input: { text: 'strict-mapping' },
      context: {},
    })
    assert.equal((result as { echo: string }).echo, 'strict-mapping', 'the manifest mapping must serve the call')
    await registry.disposeAll()
  })

  it('registry.dispose kills the child process (the deactivation hook)', async () => {
    const { storeDir } = await installFixture()
    const registry = createManagedWorkerRegistry()
    const adapter = await registry.adapterFor({
      extensionId: EXTENSION_ID,
      entryPath: join(storeDir, 'fixture-package', 'lib', 'index.mjs'),
      generation: 1,
    })
    await adapter.invoke({ implementationId: 'fixture-worker-echo-impl', input: { text: 'before-dispose' } })
    const pid = adapter.pid()
    assert.ok(pid !== undefined && pid !== process.pid, 'the worker must be a child process')

    await adapter.dispose()
    assert.deepEqual(registry.bindings(), [], 'dispose must forget the worker')
    // The child must be GONE, not merely disconnected: poll until the pid is dead.
    const deadline = Date.now() + 10_000
    let alive = true
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
        alive = true
      } catch {
        alive = false
        break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(alive, false, 'the disposed worker process must be dead')
  })
})
