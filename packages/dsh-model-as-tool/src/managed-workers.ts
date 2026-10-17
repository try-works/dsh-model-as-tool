/**
 * The host's managed-worker registry (EXT-20, the host half).
 *
 * The SDK ships the mechanism — {@link ManagedExtensionWorker}, a scrubbed-environment
 * child process speaking the bounded invoke protocol — and this module is the host-side
 * LIFETIME discipline: ONE worker process per extension per activation GENERATION,
 * reused across invocations, disposed the moment the generation advances (a
 * re-activation gets a fresh process, the old one never serves another call).
 *
 * What stays OUT of the worker, by construction:
 *
 * - the grant: the host authorizes the caller BEFORE dispatch ever builds a provider,
 *   so `providerFor` here runs only for calls that already passed authorization, and
 *   the worker receives exactly `{implementationId, input}` — no grant, no caller
 *   identity, no configuration secrets;
 * - the schemas: input validation happened host-side before the call, and the returned
 *   value is validated against the declared output schema by the same path that
 *   validates the in-process result — the worker's payload is treated as untrusted
 *   data exactly like an in-process provider's;
 * - receipts and accounting: untouched — they record the call in the same code path.
 *
 * IDENTITY: the worker is keyed by the extension's TRUE MANIFEST ID, never by a path
 * or a package specifier (an install path must not leak into diagnostics or collide
 * with a package name). The SDK child also derives its implementation->model mapping
 * from the owning package.json + the manifest beside the entry, so this registry
 * STAGES a host-owned worker directory — package.json + the manifest + a junction to
 * the entry's directory — when the entry's own package root does not carry them
 * (a staged store copy extracts no manifest). The entry's REAL bytes are the ones the
 * worker executes: the junction resolves to the verified installed copy, never a host
 * rewrite.
 *
 * Every worker failure surfaces as the SDK's ManagementError vocabulary
 * (EXTENSION_FAULT), which the dispatch path converts into a tool error; the host
 * process is never affected.
 *
 * @module @try-works/dsh-model-as-tool/managed-workers
 */

import { ManagedExtensionWorker } from '@try-works/tool-mode-extension-sdk'
import type { JsonObject, PreparedAssetMapV1, ProviderInspectionV1 } from '@try-works/tool-mode-extension-sdk'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

/** What the host needs to route one extension's calls out of process. */
export interface ManagedWorkerBinding {
  /**
   * The extension's TRUE MANIFEST ID (the `id` field of the manifest), which keys
   * the worker and is passed to the child as its identity. Never a path.
   */
  readonly extensionId: string
  /** Absolute path of the built `./tool-mode` entry (plain Node ESM). */
  readonly entryPath: string
  /**
   * Absolute path of the extension manifest, when the host can resolve one. Absent
   * (a store copy with no extracted manifest), the worker cannot derive the model
   * mapping and the call fails with the precise reason — until the SDK lands the
   * host-supplied mapping API.
   */
  readonly manifestPath?: string
  /** The activation generation this binding serves (EXT-20 lifetime discipline). */
  readonly generation: number
  /** Explicit environment names passed through to the scrubbed child env. */
  readonly envPassthrough?: readonly string[]
}

/** The dispatch-provider shape the registry hands back. */
export interface ManagedWorkerProvider {
  load(request: {
    /** The manifest model id the assets prepare (worker.load keys by model id). */
    readonly modelId: string
    readonly assets: Readonly<PreparedAssetMapV1>
    readonly signal: AbortSignal
  }): Promise<void>
  invoke(request: {
    readonly implementationId: string
    readonly input: Readonly<Record<string, unknown>>
    readonly context: unknown
  }): Promise<Record<string, unknown>>
}

/**
 * The catalog-adapter surface a managed worker serves (EXT-20, host half).
 *
 * This is what the ProviderBridge uses in managed mode. The worker receives the
 * narrow validated input plus a REQUEST-SCOPED path broker (the host's own
 * authority, `resolvePath` — omitted means denial by the protocol), and answers
 * with the payload; the host then applies the same reserved-meta assertion and
 * contract translation as the in-process path. The worker never sees the grant,
 * the caller identity or the host environment. Inspection and load/unload run
 * ENTIRELY in the managed process through the SDK's inspect/load/unload APIs.
 */
export interface ManagedWorkerAdapter {
  /** Inspect one manifest model, entirely in the managed process (EXT-18). */
  inspect(modelId: string, options?: { readonly signal?: AbortSignal }): Promise<ProviderInspectionV1>
  /** Load the host-prepared assets for one model in the managed process. */
  load(modelId: string, options: { readonly assets: Readonly<PreparedAssetMapV1>; readonly signal?: AbortSignal }): Promise<void>
  /** Release one model's loaded resources without disposing the worker. */
  unload(modelId: string, options?: { readonly signal?: AbortSignal }): Promise<void>
  /** Invoke one implementation through the managed process. */
  invoke(request: {
    readonly implementationId: string
    readonly input: Readonly<Record<string, unknown>>
    readonly signal?: AbortSignal
    /** The HOST's request-scoped canonical path broker; omitted means the child denies. */
    readonly resolvePath?: (candidate: string) => string | Promise<string>
  }): Promise<Record<string, unknown>>
  /** Dispose the worker process and forget it (deactivation/teardown). */
  dispose(): Promise<void>
  /** The child pid, when the process is alive. */
  pid(): number | undefined
}

/** Which provider lifecycle phases the CURRENT protocol serves in the child. */
export interface ManagedWorkerCapabilities {
  /** TRUE: the SDK child serves the inspect message. */
  readonly inspect: true
  /** TRUE: the SDK child serves the load/unload messages (host-prepared assets only). */
  readonly load: true
}

/** One worker holder, keyed by generation. */
interface WorkerHolder {
  readonly generation: number
  readonly worker: ManagedExtensionWorker
  /** The staged owning-package dir, when the binding needed one. */
  readonly stagedDir: string | undefined
}

/** The registry of live extension workers. */
export interface ManagedWorkerRegistry {
  /**
   * The dispatch provider for one extension, creating or reusing the worker bound to
   * the CURRENT generation. A generation change disposes the old process before the
   * new one is created, so a stale worker can never serve a new activation's calls.
   */
  providerFor(binding: ManagedWorkerBinding): Promise<ManagedWorkerProvider>
  /**
   * The catalog-adapter surface for one extension (the ProviderBridge's managed
   * path): invoke over the wire, disposal, and the child pid. The same
   * per-generation binding discipline as {@link providerFor}.
   */
  adapterFor(binding: ManagedWorkerBinding): Promise<ManagedWorkerAdapter>
  /** Dispose one extension's worker and forget it (the deactivation hook). */
  dispose(extensionId: string): Promise<void>
  /** What the current SDK protocol serves, for the callers that refuse the rest. */
  capabilities(): ManagedWorkerCapabilities
  /** The live bindings, for tests and diagnostics. */
  bindings(): readonly { readonly extensionId: string; readonly generation: number; readonly pid: number | undefined }[]
  /** Dispose every worker (host teardown). */
  disposeAll(): Promise<void>
}

/**
 * Create the host's managed-worker registry.
 * @returns the registry.
 */
export function createManagedWorkerRegistry(): ManagedWorkerRegistry {
  const holders = new Map<string, WorkerHolder>()

  /**
   * Resolve the entry the CHILD must run, staging a host-owned owning-package
   * layout when the entry's own package root does not carry one (a staged store
   * copy extracts no package.json/manifest, which the SDK child needs for its
   * implementation->model mapping). The staged dir carries a package.json and the
   * REAL manifest bytes plus a junction to the entry's directory, so the bytes the
   * worker executes are exactly the verified installed copy's.
   */
  const resolveChildEntry = (binding: ManagedWorkerBinding): { entryPath: string; stagedDir: string | undefined } => {
    // Walk up from the entry looking for the OWNING package: the nearest package.json
    // that actually declares a toolMode.manifest. A store copy extracts neither, so a
    // stray unrelated package.json higher up must NOT be mistaken for the owner (that
    // would hand the child a package whose manifest it would then misread).
    let root = dirname(binding.entryPath)
    let owned = false
    for (;;) {
      const candidate = join(root, 'package.json')
      if (existsSync(candidate)) {
        try {
          const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { toolMode?: { manifest?: unknown } }
          if (typeof pkg.toolMode?.manifest === 'string') {
            owned = true
            break
          }
        } catch {
          // Unreadable or malformed: not an owner.
        }
      }
      const parent = dirname(root)
      if (parent === root) break
      root = parent
    }
    if (owned) return { entryPath: binding.entryPath, stagedDir: undefined }
    if (binding.manifestPath === undefined) {
      throw new Error(
        `the worker for ${binding.extensionId} cannot derive the model mapping: the entry's package root carries no `
        + 'package.json and the host holds no manifest path for it (a staged store copy). Until the SDK lands the '
        + 'host-supplied mapping API, this binding is refused rather than run with a guessed mapping.',
      )
    }
    const stagedDir = join(tmpdir(), `tmw-${binding.extensionId.replace(/[^A-Za-z0-9._-]/g, '_')}-${binding.generation}-${process.pid}`)
    mkdirSync(join(stagedDir, 'lib'), { recursive: true })
    writeFileSync(join(stagedDir, 'package.json'), JSON.stringify({
      name: binding.extensionId,
      version: '0.0.0-worker',
      type: 'module',
      toolMode: { manifest: './tool-mode.extension.json' },
    }))
    // The REAL manifest bytes, so the child's identity and mapping checks run on
    // exactly what the host verified.
    writeFileSync(join(stagedDir, 'tool-mode.extension.json'), readFileSync(binding.manifestPath))
    // A junction (Windows, no elevation) or symlink to the entry's directory — the
    // child's mapping walks UP from the staged entry and finds the staged owner.
    symlinkSync(dirname(binding.entryPath), join(stagedDir, 'lib'), process.platform === 'win32' ? 'junction' : 'dir')
    return { entryPath: join(stagedDir, 'lib', basename(binding.entryPath)), stagedDir }
  }

  const bind = async (binding: ManagedWorkerBinding): Promise<WorkerHolder> => {
    const current = holders.get(binding.extensionId)
    if (current !== undefined && current.generation === binding.generation) {
      return current
    }
    // EXT-20: a generation change disposes the OLD worker before any new process is
    // created — the previous generation's process never answers this generation's call.
    if (current !== undefined) {
      await current.worker.dispose()
      if (current.stagedDir !== undefined) rmSync(current.stagedDir, { recursive: true, force: true })
      holders.delete(binding.extensionId)
    }
    const { entryPath, stagedDir } = resolveChildEntry(binding)
    const holder: WorkerHolder = {
      generation: binding.generation,
      stagedDir,
      worker: ManagedExtensionWorker.create({
        extensionId: binding.extensionId,
        entryPath,
        generation: binding.generation,
        ...binding.envPassthrough === undefined ? {} : { envPassthrough: binding.envPassthrough },
      }),
    }
    holders.set(binding.extensionId, holder)
    return holder
  }

  return {
    async providerFor(binding) {
      const holder = await bind(binding)
      return {
        async load(request) {
          // The HOST-VERIFIED prepared assets reach the child through the
          // SDK's load API (host-prepared assets ONLY — nothing else is sent,
          // and the child never auto-loads). An empty map reaches the child as
          // an empty map: the extension's own load refuses a missing group by
          // name rather than the host inventing a verification.
          await holder.worker.load(request.modelId, {
            assets: request.assets,
            signal: request.signal,
          })
        },
        async invoke(request) {
          // The GRANT and the schemas were already enforced host-side; the worker
          // receives the validated input and nothing else. No resolvePath broker is
          // supplied on the dispatch path: an extension tool needing a host-authorized
          // path is refused by the child's own denial rather than given an identity
          // resolver (the protocol's omitted-callback rule).
          return await holder.worker.invoke({
            implementationId: request.implementationId,
            input: request.input as JsonObject,
            ...(request.context as { signal?: AbortSignal } | undefined)?.signal === undefined
              ? {}
              : { signal: (request.context as { signal: AbortSignal }).signal },
          }) as Record<string, unknown>
        },
      }
    },

    async adapterFor(binding) {
      const holder = await bind(binding)
      let disposed = false
      return {
        async inspect(modelId, options) {
          if (disposed) throw new Error(`the managed worker for ${binding.extensionId} was disposed`)
          return await holder.worker.inspect(modelId, {
            ...options?.signal === undefined ? {} : { signal: options.signal },
          })
        },
        async load(modelId, options) {
          if (disposed) throw new Error(`the managed worker for ${binding.extensionId} was disposed`)
          // Host-prepared assets ONLY — the map the host verified; nothing else is
          // sent to the child, and the child never auto-loads.
          await holder.worker.load(modelId, {
            assets: options.assets,
            ...options.signal === undefined ? {} : { signal: options.signal },
          })
        },
        async unload(modelId, options) {
          if (disposed) throw new Error(`the managed worker for ${binding.extensionId} was disposed`)
          await holder.worker.unload(modelId, {
            ...options?.signal === undefined ? {} : { signal: options.signal },
          })
        },
        async invoke(request) {
          if (disposed) {
            throw new Error(`the managed worker for ${binding.extensionId} was disposed`)
          }
          return await holder.worker.invoke({
            implementationId: request.implementationId,
            input: request.input as JsonObject,
            ...request.signal === undefined ? {} : { signal: request.signal },
            ...request.resolvePath === undefined ? {} : { resolvePath: request.resolvePath },
          }) as Record<string, unknown>
        },
        async dispose() {
          if (disposed) return
          disposed = true
          await holder.worker.dispose()
          if (holders.get(binding.extensionId) === holder) holders.delete(binding.extensionId)
          if (holder.stagedDir !== undefined) rmSync(holder.stagedDir, { recursive: true, force: true })
        },
        pid() {
          return holder.worker.pid
        },
      }
    },

    async dispose(extensionId) {
      const holder = holders.get(extensionId)
      holders.delete(extensionId)
      if (holder !== undefined) {
        await holder.worker.dispose()
        if (holder.stagedDir !== undefined) rmSync(holder.stagedDir, { recursive: true, force: true })
      }
    },

    capabilities() {
      // The verified SDK child protocol now serves inspect, load/unload and the
      // invoke resolvePath broker.
      return { inspect: true, load: true }
    },

    bindings() {
      return [...holders.entries()].map(([extensionId, holder]) => ({
        extensionId,
        generation: holder.generation,
        pid: holder.worker.pid,
      }))
    },
    async disposeAll() {
      const live = [...holders.values()]
      holders.clear()
      await Promise.all(live.map(holder => holder.worker.dispose()))
      for (const holder of live) {
        if (holder.stagedDir !== undefined) rmSync(holder.stagedDir, { recursive: true, force: true })
      }
    },
  }
}
