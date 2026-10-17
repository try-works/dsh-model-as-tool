/**
 * The managed extension worker (EXT-20, SDK half).
 *
 * Every test here drives the BUILT SDK lib under plain Node: the worker class
 * is imported from `../lib/worker.js` and the child it spawns is
 * `lib/worker/worker-child.js` — no tsx, no workspace resolution — so a pass
 * here is a statement about the packed world, not the source tree. The
 * fixture extensions are written to a temp directory as plain-JS ESM files
 * with NO imports: they are honest ToolModeExtensionV1 shapes, not SDK
 * consumers.
 *
 * Requirement links: EXT-20 (managed process, scrubbed env, bounded framing,
 * cancellation, distinct lifetimes).
 */

import { after, describe, it } from 'node:test'
import { getEventListeners } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { ManagedExtensionWorker, WorkerLimits } from '../src/worker.ts'

const BUILT_WORKER = new URL('../lib/worker.js', import.meta.url)
const BUILT_CHILD = new URL('../lib/worker/worker-child.js', import.meta.url)
const BUILT = existsSync(fileURLToPath(BUILT_WORKER)) && existsSync(fileURLToPath(BUILT_CHILD))
const SKIP = BUILT ? undefined : 'the built SDK lib is missing; run `npm run build:sdk` first'

type WorkerModule = {
  ManagedExtensionWorker: typeof ManagedExtensionWorker
  scrubbedEnv: (env: NodeJS.ProcessEnv, passthrough?: readonly string[]) => Record<string, string>
}

/** The BUILT worker module, imported once at the top level (plain Node path). */
const workerModule: WorkerModule | undefined = BUILT
  ? await import(BUILT_WORKER.href) as WorkerModule
  : undefined

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix = 'tmx-worker-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Write a plain-JS fixture entry and return its absolute path. */
function fixture(source: string, extensionId: string): string {
  const dir = scratch()
  const path = join(dir, 'entry.mjs')
  writeFileSync(path, source, 'utf8')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', toolMode: { manifest: './tool-mode.extension.json' } }))
  writeFileSync(join(dir, 'tool-mode.extension.json'), JSON.stringify({
    id: extensionId, models: [{ id: 'real-model' }, { id: 'inspect-only' }],
    implementations: ['echo-default', 'echo', 'controlled', 'hang-default', 'huge-default'].map(id => ({ id, modelId: 'real-model' })),
  }))
  return path
}

const FAST: WorkerLimits = { readyTimeoutMs: 20_000, killTimeoutMs: 2_000, maxLineBytes: 256 * 1024, maxInputBytes: 1024 * 1024 }

/** An echo fixture: doubles the input text and reports its own pid and env facts. */
const ECHO = `
export default {
  apiVersion: 1,
  async create(ctx) {
    return {
      async createProvider({ modelId }) {
        if (modelId !== 'real-model') throw new Error('createProvider rejects implementationId: ' + modelId)
        return {
          async inspect() { return { readiness: 'ready', features: ['echo'], missing: [] } },
          async load() {},
          async invoke(request) {
            if (request.input.crash === true) { process.exit(1) }
            return {
              doubled: String(request.input.text ?? '').repeat(2),
              pid: process.pid,
              managed: process.env.TOOL_MODE_MANAGED_WORKER ?? 'absent',
              planted: process.env.PLANTED_MARKER ?? 'absent',
              passthrough: process.env.MY_OPERATOR_VAR ?? 'absent',
              invocationId: request.context.invocationId,
            }
          },
          async unload() {},
          async dispose() {},
        }
      },
      async dispose() {},
    }
  },
}
`

/** One controllable operation: delayed success, ignored abort, or cooperative abort. */
const CONTROLLED = ECHO.replace(
  "if (request.input.crash === true)",
  `if (request.input.started) process.stderr.write(String(request.input.started) + '\\n');
            if (request.input.hang === true) await new Promise(() => {});
            if (request.input.cooperate === true) {
              await new Promise((resolve, reject) => {
                const abort = () => reject(new Error('abort acknowledged'));
                if (request.context.signal.aborted) abort();
                else request.context.signal.addEventListener('abort', abort, { once: true });
              });
            }
            if (request.input.delayMs) await new Promise(resolve => setTimeout(resolve, request.input.delayMs));
            if (request.input.crash === true)`,
)

/** An entry that cannot activate. */
const THROWING = `
export default {
  apiVersion: 1,
  async create() { throw new Error('activation exploded') },
}
`

/** An entry that hangs forever, ignoring the abort. */
const HANGING = `
export default {
  apiVersion: 1,
  async create() {
    return {
      async createProvider({ modelId }) {
        if (modelId !== 'real-model') throw new Error('createProvider rejects implementationId: ' + modelId)
        return {
          async inspect() { return { readiness: 'ready', features: [], missing: [] } },
          async load() {},
          async invoke() { await new Promise(() => {}) },
          async unload() {},
          async dispose() {},
        }
      },
      async dispose() {},
    }
  },
}
`

/** An entry that returns an oversized payload. */
const HUGE = `
export default {
  apiVersion: 1,
  async create() {
    return {
      async createProvider({ modelId }) {
        if (modelId !== 'real-model') throw new Error('createProvider rejects implementationId: ' + modelId)
        return {
          async inspect() { return { readiness: 'ready', features: [], missing: [] } },
          async load() {},
          async invoke() { return { big: 'x'.repeat(1024 * 1024) } },
          async unload() {},
          async dispose() {},
        }
      },
      async dispose() {},
    }
  },
}
`

describe('EXT-20 — the managed worker runs the BUILT lib under plain Node', { skip: SKIP }, () => {
  const { ManagedExtensionWorker } = workerModule ?? ({} as WorkerModule)
  if (!BUILT || workerModule === undefined) return

  it('invokes a fixture extension and returns its real result through the worker child', async () => {
    const worker = ManagedExtensionWorker.create({
      extensionId: '@acme/echo',
      entryPath: fixture(ECHO, '@acme/echo'),
      generation: 1,
      limits: FAST,
      diagnostics: () => {},
    })
    const result = await worker.invoke({ implementationId: 'echo-default', input: { text: 'hi' } })
    assert.deepEqual(result, {
      doubled: 'hihi',
      pid: worker.pid,
      managed: '1',
      planted: 'absent',
      passthrough: 'absent',
      invocationId: 'inv-@acme/echo-1',
    })
    // One process per extension identity: a second invocation reuses it.
    const again = await worker.invoke({ implementationId: 'echo-default', input: { text: 'x' } })
    assert.equal(again.pid, worker.pid)
    await worker.dispose()
    assert.equal(worker.alive, false)
  })

  it('scrubs the child environment to the allowlist plus explicit passthrough (the definitive scrub proof)', async () => {
    // The scrub is a SPAWN-TIME snapshot taken at create(): the environment is
    // planted BEFORE the worker exists, the way a real host environment is.
    process.env.PLANTED_MARKER = 'this must not reach the child'
    process.env.MY_OPERATOR_VAR = 'operator-approved'
    const worker = ManagedExtensionWorker.create({
      extensionId: '@acme/scrub',
      entryPath: fixture(ECHO, '@acme/scrub'),
      generation: 1,
      envPassthrough: ['MY_OPERATOR_VAR'],
      limits: FAST,
      diagnostics: () => {},
    })
    try {
      const result = await worker.invoke({ implementationId: 'echo-default', input: { text: 'a' } })
      assert.equal(result.planted, 'absent', 'the planted host marker must be absent in the child')
      assert.equal(result.passthrough, 'operator-approved', 'the explicit passthrough must arrive')
      assert.equal(result.managed, '1')
    } finally {
      delete process.env.PLANTED_MARKER
      delete process.env.MY_OPERATOR_VAR
      await worker.dispose()
    }
  })

  it('a fixture whose entry throws fails the CALL, and the caller stays alive', async () => {
    const worker = ManagedExtensionWorker.create({
      extensionId: '@acme/throwing',
      entryPath: fixture(THROWING, '@acme/throwing'),
      generation: 1,
      limits: FAST,
      diagnostics: () => {},
    })
    await assert.rejects(
      worker.invoke({ implementationId: 'any', input: {} }),
      (error: unknown) => {
        // Shape-checked, not instanceof: the BUILT lib's ManagementError is a
        // separate class identity from the source one this test imports.
        assert.equal((error as { code?: unknown }).code, 'EXTENSION_FAULT', 'the failure must use the management vocabulary')
        assert.match(String((error as Error).message), /exited before reporting ready/)
        return true
      },
    )
    // The caller process is demonstrably alive: the store machinery still works.
    assert.equal(worker.inFlight, 0)
    await worker.dispose()
  })

  it('kills an unresponsive child within the kill deadline and never hangs the caller', async () => {
    const worker = ManagedExtensionWorker.create({
      extensionId: '@acme/hanging',
      entryPath: fixture(HANGING, '@acme/hanging'),
      generation: 1,
      limits: FAST,
      diagnostics: () => {},
    })
    const controller = new AbortController()
    const started = Date.now()
    const pending = worker.invoke({ implementationId: 'hang-default', input: {}, signal: controller.signal })
    controller.abort()
    await assert.rejects(
      pending,
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'EXTENSION_FAULT', 'the failure must use the management vocabulary')
        assert.match(String((error as Error).message), /did not settle the cancelled invocation/)
        return true
      },
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 10_000, `the kill deadline must bound the wait (took ${elapsed} ms)`)
    assert.equal(worker.alive, false, 'the hung child must be killed, not left running')
    await worker.dispose()
  })

  it('ordinary inference longer than killTimeoutMs succeeds without any abort', { timeout: 5_000 }, async () => {
    const worker = ManagedExtensionWorker.create({
      extensionId: '@acme/slow', entryPath: fixture(CONTROLLED, '@acme/slow'), generation: 1,
      limits: { ...FAST, killTimeoutMs: 40 }, diagnostics: () => {},
    })
    const controller = new AbortController()
    try {
      const result = await worker.invoke({
        implementationId: 'controlled', input: { text: 'slow', delayMs: 200 }, signal: controller.signal,
      })
      assert.equal(result.doubled, 'slowslow')
      assert.equal(worker.inFlight, 0)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
      controller.abort() // A settled call must not leave a listener that kills its worker.
      await delay(100)
      assert.equal(worker.alive, true)
    } finally { await worker.dispose() }
  })

  it('starts the kill deadline only at abort; noncancelled peers get worker faults', { timeout: 5_000 }, async () => {
    let acknowledge: (() => void) | undefined
    const started = new Promise<void>(resolve => { acknowledge = resolve })
    const worker = ManagedExtensionWorker.create({
      extensionId: '@acme/shared', entryPath: fixture(CONTROLLED, '@acme/shared'), generation: 1,
      limits: { ...FAST, killTimeoutMs: 60 },
      diagnostics: line => { if (line.endsWith('running')) acknowledge?.() },
    })
    const controller = new AbortController()
    const peerController = new AbortController()
    try {
      // Warm the lazy worker before starting concurrent calls.
      await worker.invoke({ implementationId: 'controlled', input: {} })
      const cancelled = worker.invoke({
        implementationId: 'controlled', input: { hang: true, started: 'running' }, signal: controller.signal,
      })
      const peer = worker.invoke({ implementationId: 'controlled', input: { hang: true }, signal: peerController.signal })
      const cancelledCheck = assert.rejects(cancelled, /did not settle the cancelled invocation within 60 ms/)
      const peerCheck = assert.rejects(peer, (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'EXTENSION_FAULT')
        assert.match((error as Error).message, /another invocation did not settle after abort/)
        assert.doesNotMatch((error as Error).message, /the cancelled invocation/)
        return true
      })
      await started
      await delay(180) // Longer than the grace: neither ordinary call may be killed yet.
      assert.equal(worker.alive, true)
      assert.equal(worker.inFlight, 2)
      const abortedAt = Date.now()
      controller.abort()
      await Promise.all([cancelledCheck, peerCheck])
      assert.ok(Date.now() - abortedAt < 1_500, 'abort must bound the caller wait')
      assert.equal(worker.alive, false)
      assert.equal(worker.inFlight, 0)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
      assert.equal(getEventListeners(peerController.signal, 'abort').length, 0)
      // A delayed exit event from the killed process must not fault its replacement.
      const result = await worker.invoke({ implementationId: 'controlled', input: { text: 'new' } })
      assert.equal(result.doubled, 'newnew')
    } finally { await worker.dispose() }
  })

  it('pre-aborted cooperative calls receive cancel after invoke and clear the deadline', { timeout: 5_000 }, async () => {
    const worker = ManagedExtensionWorker.create({
      extensionId: '@acme/cooperative', entryPath: fixture(CONTROLLED, '@acme/cooperative'), generation: 1,
      limits: { ...FAST, killTimeoutMs: 200 }, diagnostics: () => {},
    })
    const controller = new AbortController()
    controller.abort()
    try {
      await assert.rejects(worker.invoke({
        implementationId: 'controlled', input: { cooperate: true }, signal: controller.signal,
      }), /the invocation was cancelled/)
      await delay(300)
      assert.equal(worker.alive, true, 'cooperative cancellation must clear the kill timer')
      assert.equal(worker.inFlight, 0)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    } finally { await worker.dispose() }
  })

  it('refused protocol writes clear pending calls and abort listeners', { timeout: 5_000 }, async () => {
    const worker = ManagedExtensionWorker.create({
      extensionId: '@acme/write-limit', entryPath: fixture(ECHO, '@acme/write-limit'), generation: 1,
      limits: { ...FAST, maxLineBytes: 256 }, diagnostics: () => {},
    })
    const controller = new AbortController()
    try {
      await assert.rejects(worker.invoke({
        implementationId: 'echo', input: { text: 'x'.repeat(500) }, signal: controller.signal,
      }), /request exceeded the protocol line cap/)
      assert.equal(worker.inFlight, 0)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
      controller.abort()
      assert.equal(worker.alive, true)
    } finally { await worker.dispose() }
  })

  it('reports a configured ready timeout as timeout, not cancellation', { timeout: 5_000 }, async () => {
    const worker = ManagedExtensionWorker.create({
      extensionId: '@acme/never-ready',
      entryPath: fixture(THROWING.replace("throw new Error('activation exploded')", 'await new Promise(() => {})'), '@acme/never-ready'),
      generation: 1, limits: { ...FAST, readyTimeoutMs: 100 }, diagnostics: () => {},
    })
    try {
      await assert.rejects(worker.invoke({ implementationId: 'any', input: {} }), (error: unknown) => {
        assert.match((error as Error).message, /did not report ready within 100 ms/)
        assert.doesNotMatch((error as Error).message, /cancel/)
        return true
      })
      assert.equal(worker.alive, false)
      assert.equal(worker.inFlight, 0)
    } finally { await worker.dispose() }
  })

  it('a crashing child faults the call and the next invocation respawns a fresh process', async () => {
    const worker = ManagedExtensionWorker.create({
      extensionId: '@acme/crashy',
      entryPath: fixture(ECHO, '@acme/crashy'),
      generation: 1,
      limits: FAST,
      diagnostics: () => {},
    })
    const first = await worker.invoke({ implementationId: 'echo-default', input: { text: 'stable' } })
    const firstPid = first.pid as number
    await assert.rejects(
      worker.invoke({ implementationId: 'echo-default', input: { crash: true } }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'EXTENSION_FAULT', 'the failure must use the management vocabulary')
        assert.match(String((error as Error).message), /worker process exited/)
        return true
      },
    )
    assert.equal(worker.alive, false)
    // Restart-on-exit: the next invocation spawns a new process and serves.
    const second = await worker.invoke({ implementationId: 'echo-default', input: { text: 'back' } })
    assert.notEqual(second.pid, firstPid, 'the respawned worker must be a distinct process')
    await worker.dispose()
  })

  it('gives two extensions distinct worker processes', async () => {
    const alpha = ManagedExtensionWorker.create({
      extensionId: '@acme/alpha',
      entryPath: fixture(ECHO, '@acme/alpha'),
      generation: 1,
      limits: FAST,
      diagnostics: () => {},
    })
    const beta = ManagedExtensionWorker.create({
      extensionId: '@acme/beta',
      entryPath: fixture(ECHO, '@acme/beta'),
      generation: 1,
      limits: FAST,
      diagnostics: () => {},
    })
    const fromAlpha = await alpha.invoke({ implementationId: 'echo-default', input: { text: 'a' } })
    const fromBeta = await beta.invoke({ implementationId: 'echo-default', input: { text: 'b' } })
    assert.notEqual(fromAlpha.pid, fromBeta.pid, 'one worker per extension identity')
    await alpha.dispose()
    await beta.dispose()
  })

  it('kills a child that violates the line cap, instead of buffering an unbounded payload', async () => {
    const worker = ManagedExtensionWorker.create({
      extensionId: '@acme/huge',
      entryPath: fixture(HUGE, '@acme/huge'),
      generation: 1,
      limits: FAST,
      diagnostics: () => {},
    })
    await assert.rejects(
      worker.invoke({ implementationId: 'huge-default', input: {} }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'EXTENSION_FAULT', 'the failure must use the management vocabulary')
        assert.match(String((error as Error).message), /line exceeded|failed/)
        return true
      },
    )
    assert.equal(worker.alive, false)
    await worker.dispose()
  })

  it('uses manifest model IDs and rejects model IDs supplied as implementations', async () => {
    const worker = ManagedExtensionWorker.create({ extensionId: '@acme/mapping', entryPath: fixture(ECHO, '@acme/mapping'), generation: 1, limits: FAST, diagnostics: () => {} })
    try {
      assert.equal((await worker.invoke({ implementationId: 'echo-default', input: { text: 'mapped' } })).doubled, 'mappedmapped')
      await assert.rejects(worker.invoke({ implementationId: 'real-model', input: {} }), /unknown implementation/)
      assert.equal(worker.alive, true)
    } finally { await worker.dispose() }
  })

  it('round-trips bounded typed media and names unsupported typed values', async () => {
    const source = ECHO.replace("doubled: String(request.input.text ?? '').repeat(2),", `doubled: String(request.input.text ?? '').repeat(2),
              bytes: request.input.bytes, samples: request.input.samples,
              isBytes: request.input.bytes instanceof Uint8Array,
              isSamples: request.input.samples instanceof Float32Array,`)
    const worker = ManagedExtensionWorker.create({ extensionId: '@acme/binary', entryPath: fixture(source, '@acme/binary'), generation: 1, limits: FAST, diagnostics: () => {} })
    try {
      const bytes = new Uint8Array([0, 255, 7])
      const samples = new Float32Array([0, -1, 0.25])
      const result = await worker.invoke({ implementationId: 'echo-default', input: { bytes, samples } as unknown as import('../src/runtime.ts').JsonObject })
      assert.equal(result.isBytes, true)
      assert.equal(result.isSamples, true)
      assert.deepEqual(result.bytes, bytes)
      assert.deepEqual(result.samples, samples)
      await assert.rejects(worker.invoke({ implementationId: 'echo-default', input: { values: new Uint16Array([7]) } as unknown as import('../src/runtime.ts').JsonObject }), /unsupported worker typed value: Uint16Array/)
      await assert.rejects(worker.invoke({ implementationId: 'echo-default', input: { bytes: new Uint8Array(1024 * 1024 + 1) } as unknown as import('../src/runtime.ts').JsonObject }), /binary payload exceeds byte limit/)
      assert.equal(worker.alive, true)
    } finally { await worker.dispose() }
  })

  it('fails closed on caller path authorization without host authority', async () => {
    const source = ECHO.replace("if (request.input.crash === true)", "request.context.resolvePath(request.input.path); if (request.input.crash === true)")
    const worker = ManagedExtensionWorker.create({ extensionId: '@acme/path', entryPath: fixture(source, '@acme/path'), generation: 1, limits: FAST, diagnostics: () => {} })
    try {
      await assert.rejects(worker.invoke({ implementationId: 'echo-default', input: { path: 'C:/secret' } }), /path access denied.*no configured host path authority/)
      assert.equal(worker.alive, true)
    } finally { await worker.dispose() }
  })

  it('inspects per model in the child, loads only prepared assets, reuses explicit configuration, and disposes providers', async () => {
    const marker = join(scratch(), 'lifecycle.log')
    const source = `
      import { appendFileSync } from 'node:fs';
      const marker = ${JSON.stringify(marker)};
      let creates = 0;
      export default { apiVersion: 1, async create() { return {
        async createProvider({modelId, configuration}) {
          const created = ++creates; let loaded = false; let asset;
          appendFileSync(marker, 'create:' + modelId + ':' + created + '\\n');
          return {
            async inspect(signal) { return { readiness: loaded ? 'ready' : 'prepared-cold', features: [String(process.pid), modelId, String(created), JSON.stringify(configuration), String(signal.aborted)], missing: [] } },
            async load({assets, signal}) { if (signal.aborted) throw new Error('load aborted'); asset = assets.get('weights'); if (!asset || asset.digest !== 'sha256:verified') throw new Error('host asset required'); loaded = true; appendFileSync(marker, 'load:' + asset.path + '\\n') },
            async invoke() { if (!loaded) throw new Error('must load before invoke'); return { modelId, configuration, created, asset, pid: process.pid } },
            async unload() { loaded = false; appendFileSync(marker, 'unload:' + modelId + ':' + created + '\\n') },
            async dispose() { appendFileSync(marker, 'dispose:' + modelId + ':' + created + '\\n') },
          };
        }, async dispose() { appendFileSync(marker, 'extension-dispose\\n') }
      } } };
    `
    const worker = ManagedExtensionWorker.create({ extensionId: '@acme/lifecycle', entryPath: fixture(source, '@acme/lifecycle'), generation: 1, limits: FAST, diagnostics: () => {} })
    try {
      const inspection = await worker.inspect('inspect-only')
      assert.equal(inspection.readiness, 'prepared-cold')
      assert.equal(Number(inspection.features[0]), worker.pid)
      assert.notEqual(Number(inspection.features[0]), process.pid)
      assert.equal(inspection.features[1], 'inspect-only')
      await assert.rejects(worker.inspect('echo-default'), /unknown model/)
      const configuration = { runtime: 'approved', nested: { b: 2, a: 1 } }
      await worker.inspect('real-model', { configuration })
      await assert.rejects(worker.invoke({ implementationId: 'echo', input: {} }), /must load before invoke/)
      const assets = { assetIds: ['weights'], get(id: string) { return id === 'weights' ? { path: 'C:/host/prepared/weights.bin', digest: 'sha256:verified' } : undefined } }
      await worker.load('real-model', { assets, configuration: { nested: { a: 1, b: 2 }, runtime: 'approved' } })
      const result = await worker.invoke({ implementationId: 'echo', input: {} })
      assert.equal(result.created, 2, 'inspect/load/invoke must share the exact model+canonical-config provider')
      assert.deepEqual(result.configuration, configuration)
      assert.deepEqual(result.asset, assets.get('weights'))
      assert.equal((await worker.inspect('real-model')).readiness, 'ready')
      await worker.unload('real-model')
      await assert.rejects(worker.invoke({ implementationId: 'echo', input: {} }), /must load before invoke/)
      await worker.load('real-model', { assets })
      await assert.rejects(worker.load('real-model', { assets: { assetIds: [], get() { return undefined } } }), /host asset required/)
    } finally { await worker.dispose() }
    const lifecycle = readFileSync(marker, 'utf8')
    assert.equal((lifecycle.match(/create:/g) ?? []).length, 2)
    // Pin the exact transcript. The explicit unload precedes the reload; then
    // dispose unloads EVERY created provider (even one never loaded), disposes
    // each exactly once, and runs extension dispose last. real-model:2 has two
    // unload lines — the explicit one and the dispose sweep — so no
    // `unload:X\ndispose:X` adjacency can hold; the full sequence is the contract.
    assert.equal(lifecycle, 'create:inspect-only:1\n'
      + 'create:real-model:2\n'
      + 'load:C:/host/prepared/weights.bin\n'
      + 'unload:real-model:2\n'
      + 'load:C:/host/prepared/weights.bin\n'
      + 'unload:inspect-only:1\n'
      + 'unload:real-model:2\n'
      + 'dispose:inspect-only:1\n'
      + 'dispose:real-model:2\n'
      + 'extension-dispose\n')
    assert.ok(lifecycle.endsWith('extension-dispose\n'))
  })

  it('brokers synchronous paths only through the request-scoped trusted host callback', async () => {
    const source = ECHO.replace("doubled: String(request.input.text ?? '').repeat(2),", 'canonical: request.context.resolvePath(request.input.path),')
    const worker = ManagedExtensionWorker.create({ extensionId: '@acme/broker', entryPath: fixture(source, '@acme/broker'), generation: 1, limits: { ...FAST, resolvePathTimeoutMs: 100 }, diagnostics: () => {} })
    try {
      const candidates: string[] = []
      const result = await worker.invoke({ implementationId: 'echo', input: { path: '../candidate' }, resolvePath: async candidate => { candidates.push(candidate); return 'C:/authorized/canonical.wav' } })
      assert.equal(result.canonical, 'C:/authorized/canonical.wav')
      assert.deepEqual(candidates, ['../candidate'])
      await assert.rejects(worker.invoke({ implementationId: 'echo', input: { path: 'C:/secret' } }), /no configured host path authority/)
      await assert.rejects(worker.invoke({ implementationId: 'echo', input: { path: 'denied' }, resolvePath() { throw new Error('operator denied candidate') } }), /operator denied candidate/)
      await assert.rejects(worker.invoke({ implementationId: 'echo', input: { path: 'hang' }, resolvePath: () => new Promise(() => {}) }), /broker deadline elapsed/)
      assert.equal(worker.alive, true)
      assert.equal(worker.inFlight, 0)
    } finally { await worker.dispose() }
  })

  it('cancels provider load, aborts pending dispose calls, and caps child diagnostics', async () => {
    const source = ECHO.replace('async load() {},', `async load({signal}) { await new Promise((resolve, reject) => { const abort = () => reject(new Error('load abort observed')); if (signal.aborted) abort(); else signal.addEventListener('abort', abort, {once:true}); }) },`)
      .replace("if (request.input.crash === true)", "for(let i=0;i<100;i++) ctx.logger.log('info', 'x'.repeat(5000)); if (request.input.crash === true)")
    const lines: string[] = []
    const worker = ManagedExtensionWorker.create({ extensionId: '@acme/load-cancel', entryPath: fixture(source, '@acme/load-cancel'), generation: 1, limits: FAST, diagnostics: line => lines.push(line) })
    try {
      await worker.inspect('real-model')
      const controller = new AbortController()
      const loading = worker.load('real-model', { assets: { assetIds: [], get() { return undefined } }, signal: controller.signal })
      controller.abort()
      await assert.rejects(loading, /cancelled/)
      await worker.invoke({ implementationId: 'echo', input: {} })
      assert.ok(lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0) < 70 * 1024)
      const pending = worker.load('real-model', { assets: { assetIds: [], get() { return undefined } } })
      const rejected = assert.rejects(pending, /disposed/)
      await Promise.all([worker.dispose(), worker.dispose(), rejected])
      assert.equal(worker.inFlight, 0)
      assert.equal(worker.alive, false)
    } finally { await worker.dispose() }
  })

  it('malformed frames kill the expendable child, fail pending, and leave the parent alive', async () => {
    const frames: unknown[] = [null, [], 42, 'scalar', {}, { kind: null }, { kind: 4 }, { kind: 'unknown' },
      { kind: 'result', id: 1, value: {} }, { kind: 'result', id: 'x', value: [] },
      { kind: 'result', id: 'x', value: null }, { kind: 'error', id: 'x', message: {} },
      { kind: 'fault', message: 1 }, { kind: 'ready', value: {} },
      { kind: 'result', id: 'x', value: { binary: { $toolModeBinaryV1: 'Uint8Array', data: 'not base64!' } } }]
    for (const [index, frame] of frames.entries()) {
      const source = ECHO.replace("if (request.input.crash === true)", `process.stdout.write(${JSON.stringify(JSON.stringify(frame) + '\n')}); await new Promise(() => {}); if (request.input.crash === true)`)
      const extensionId = `@acme/malformed-${index}`
      const worker = ManagedExtensionWorker.create({ extensionId, entryPath: fixture(source, extensionId), generation: 1, limits: FAST, diagnostics: () => {} })
      try {
        await assert.rejects(worker.invoke({ implementationId: 'echo-default', input: {} }), (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'EXTENSION_FAULT')
          assert.match((error as Error).message, /malformed protocol/)
          return true
        })
        assert.equal(worker.alive, false)
        assert.equal(worker.inFlight, 0)
        assert.ok(process.pid > 0)
      } finally { await worker.dispose() }
    }
    const healthy = ManagedExtensionWorker.create({ extensionId: '@acme/healthy', entryPath: fixture(ECHO, '@acme/healthy'), generation: 1, limits: FAST, diagnostics: () => {} })
    try { assert.equal((await healthy.invoke({ implementationId: 'echo-default', input: { text: 'alive' } })).doubled, 'alivealive') }
    finally { await healthy.dispose() }
  })

  it('refuses to serve after dispose, with the management vocabulary', async () => {
    const worker = ManagedExtensionWorker.create({
      extensionId: '@acme/disposed',
      entryPath: fixture(ECHO, '@acme/disposed'),
      generation: 1,
      limits: FAST,
      diagnostics: () => {},
    })
    await worker.invoke({ implementationId: 'echo-default', input: { text: 'one' } })
    await worker.dispose()
    await assert.rejects(
      worker.invoke({ implementationId: 'echo-default', input: { text: 'two' } }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'EXTENSION_FAULT', 'the failure must use the management vocabulary')
        assert.match(String((error as Error).message), /was disposed/)
        return true
      },
    )
  })
})
