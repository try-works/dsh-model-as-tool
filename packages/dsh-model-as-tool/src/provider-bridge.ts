/**
 * Extension provider bridge.
 *
 * This is the ONLY route from a catalog entry to model code (BASE-09). The host
 * no longer imports an adapter for any model: it resolves the extension that
 * DECLARES the model, loads that extension through its public `./tool-mode`
 * entry, and asks it for a provider. A first-party package and a third-party
 * package take the same path, so there is no private built-in adapter route that
 * only first-party code can use — which is precisely what BASE-09 forbids.
 *
 * The binding from a catalog model to an extension is DATA, held in the model's
 * own catalog entry, not a switch on the model name. Adding a vendor therefore
 * means publishing a package and adding a catalog row, with no host change.
 *
 * @module @try-works/dsh-model-as-tool/provider-bridge
 */

import {
  activateExtension,
  assertNoReservedMeta,
  EXTENSION_ENTRY,
  loadExtensionModule,
  type ExtensionContextV1,
  type ExtensionInstanceV1,
  type JsonObject,
  type ModelProviderV1,
  type ProviderInspectionV1,
} from '@try-works/tool-mode-extension-sdk'

import { createInvocationAuthority, type ToolGrant } from './authority.ts'
import type { ManagedWorkerRegistry } from './managed-workers.ts'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModelCatalogEntry } from './types.ts'
import type { AdapterInvocation, JsonValue, ModelAdapter } from './adapters/types.ts'

/** How a model's provider is obtained. */
export interface ProviderBinding {
  /**
   * The extension package that implements the model, resolved like any other
   * dependency. A relative path is admitted so a first-party package can be used
   * from a checkout before it is published.
   */
  readonly extension: string
  /** The `modelId` the extension declares for this model. */
  readonly modelId: string
}

/**
 * An activated extension, cached per installation.
 *
 * Activation is per extension rather than per model, because one package may
 * declare several models and activating it once is both cheaper and truer to the
 * lifecycle: `create()` is the extension's activation, not the model's.
 */
interface ActivatedExtension {
  readonly instance: ExtensionInstanceV1
  /** Providers already created, keyed by model id. */
  readonly providers: Map<string, Promise<ModelProviderV1>>
}

/** Raised when a model cannot be served through its declared extension. */
export class ProviderBridgeError extends Error {
  override readonly name = 'ProviderBridgeError'
}

/**
 * Loads extensions and adapts their providers to the host's adapter interface.
 *
 * One bridge per plugin activation, so an extension is imported and activated
 * once no matter how many tools it serves.
 */
export class ProviderBridge {
  readonly #activated = new Map<string, Promise<ActivatedExtension>>()
  readonly #grant: ToolGrant
  readonly #generation: number
  readonly #log: (message: string, fields?: Record<string, unknown>) => void
  /**
   * The managed-worker registry (EXT-20). Present ONLY when the operator opted in
   * (`managedWorkers: true`): every executable route — catalog invocation and
   * inspection — then goes through the worker, and the in-process import/activate
   * path below is never taken for it. There is NO silent in-process fallback: a
   * phase the protocol cannot serve is REFUSED with its reason.
   */
  readonly #managed: ManagedWorkerRegistry | undefined

  constructor(options: {
    readonly grant: ToolGrant
    readonly activationGeneration: number
    readonly managed?: ManagedWorkerRegistry
    readonly log?: (message: string, fields?: Record<string, unknown>) => void
  }) {
    this.#grant = options.grant
    this.#generation = options.activationGeneration
    this.#managed = options.managed
    this.#log = options.log ?? (() => {})
  }

  /** The extensions currently activated, for diagnostics. */
  get activatedExtensions(): readonly string[] {
    return [...this.#activated.keys()]
  }

  /**
   * Inspect one extension-backed catalog entry through its provider.
   *
   * Inspection is the extension's read-only readiness path (EXT-18). It may import
   * and activate the extension, but it does not load model assets or invoke the
   * model; the provider itself must report only approved local state. This is used
   * by publication and discovery so the host does not equate "the package
   * resolves" with "the selected deployment is prepared".
   * @param entry - the catalog entry to inspect.
   * @param signal - cancellation for the read-only inspection.
   * @returns the provider's inspection, or undefined for entries with no provider binding.
   */
  async inspect(entry: ModelCatalogEntry, signal: AbortSignal): Promise<ProviderInspectionV1 | undefined> {
    const binding = entry.provider
    if (binding === undefined) return undefined
    if (this.#managed !== undefined) {
      // EXT-20, managed mode: inspection runs ENTIRELY in the managed process
      // through the verified SDK inspect API — the entry is never imported in-host.
      const resolved = await resolveExtensionPackage(binding.extension, entry)
      const worker = await this.#managed.adapterFor({
        extensionId: resolved.manifestId,
        entryPath: resolved.entryPath,
        manifestPath: resolved.manifestPath,
        generation: this.#generation,
      })
      return await worker.inspect(binding.modelId, { signal })
    }
    const activated = await this.#activate(binding.extension, entry)
    const provider = await this.#providerFor(activated, binding)
    return provider.inspect(signal)
  }

  /**
   * Inspect one extension INSTALLED IN THE STORE, keyed by its own manifest model id.
   *
   * The catalog-driven {@link inspect} cannot reach an extension that has no catalog
   * row (EmbeddingGemma and Needle ship declared tools but are not catalogued), which
   * left their deployments permanently `needs-preparation`. This route activates the
   * extension through its public entry and inspects the provider the MANIFEST declares,
   * so "prepared" can become a durable fact for store-installed packages too.
   *
   * Inspection remains read-only (EXT-18): no model assets are loaded.
   * @param specifier - the installed extension package name or ABSOLUTE install path.
   *   An absolute path runs the exact store copy the caller verified, rather than
   *   whatever the package name resolves to in the host's own dependency graph.
   * @param modelId - the model id the extension's manifest declares.
   * @param signal - cancellation for the read-only inspection.
   * @returns the provider's inspection, or undefined when the model is not declared.
   * @throws ProviderBridgeError when the package cannot be resolved or the provider
   *   refuses creation for this model id (the model's declaredness is the provider's
   *   to assert, so an undeclared id surfaces as a throw rather than undefined).
   */
  async inspectExtension(specifier: string, modelId: string, signal: AbortSignal): Promise<ProviderInspectionV1 | undefined> {
    if (this.#managed !== undefined) {
      // Managed mode: the SAME worker-backed inspection as the catalog path —
      // the entry is imported and created only in the child process.
      const entry = { id: modelId, provider: { extension: specifier, modelId } } as unknown as ModelCatalogEntry
      return await this.inspect(entry, signal)
    }
    const entry = { id: modelId, provider: { extension: specifier, modelId } } as unknown as ModelCatalogEntry
    const activated = await this.#activate(specifier, entry)
    const provider = await this.#providerFor(activated, { extension: specifier, modelId })
    return provider.inspect(signal)
  }

  /**
   * Build an adapter for one catalog entry.
   *
   * Returns undefined when the entry declares no provider binding, which is the
   * correct outcome for a model reached through a command transport instead.
   *
   * The adapter is LAZY: it does not import or activate the extension until the
   * first invocation. Two reasons, and the second is the important one:
   * registering a tool must not run somebody else's package code (EXT-19 requires
   * import and `create()` to stay lightweight), and a package that fails to load
   * must fail the CALL it was needed for rather than the registration of every
   * other tool in the catalog.
   * @param entry - the catalog entry.
   * @returns the adapter, or undefined when no extension implements this model.
   */
  adapterFor(entry: ModelCatalogEntry): ModelAdapter | undefined {
    const binding = entry.provider
    if (binding === undefined) return undefined

    if (this.#managed !== undefined) {
      /**
       * EXT-20, MANAGED MODE: the catalog invocation runs OUT OF PROCESS. The
       * bridge resolves the entry path by DISCOVERY ONLY (reading the manifest is
       * not importing), binds the worker to the activation generation, and sends
       * the pre-authorized input over the wire — the grant, the caller identity
       * and the host environment never cross, and the HOST resolves the path
       * authority before the wire because the child's resolver DENIES by design.
       */
      const registry = this.#managed
      return {
        modelId: entry.id,
        invoke: async (invocation: AdapterInvocation): Promise<Record<string, JsonValue>> => {
          const resolved = await resolveExtensionPackage(binding.extension, entry)
          const authority = invocation.authority ?? createInvocationAuthority(this.#grant, 'interactive')
          const input: JsonObject = {}
          for (const [key, value] of Object.entries(invocation.args)) {
            input[key] = value as JsonValue
          }
          // SEC-06: the HOST's authority is the child's path broker — the verified
          // SDK protocol asks the host for EVERY path the provider touches, and an
          // unauthorized candidate is refused by the authority inside this callback
          // BEFORE the child ever opens the file. The broker is request-scoped and
          // carries no grant or identity beyond the resolution function.
          const resolvePath = (candidate: string): string => authority.resolvePath(candidate)
          // EXT-20: the worker is keyed by the TRUE MANIFEST ID, never by the path
          // or the package specifier — and the manifest path rides along so the
          // registry can stage an owning-package layout for manifest-less store copies.
          const worker = await registry.adapterFor({
            extensionId: resolved.manifestId,
            entryPath: resolved.entryPath,
            manifestPath: resolved.manifestPath,
            generation: this.#generation,
          })
          // The CHILD's strict protocol maps IMPLEMENTATION ids to model ids through
          // the manifest, so the wire carries the manifest's implementation id for
          // this model — never the model id itself (a strict provider refuses a
          // model id passed as an implementation id).
          const implementationId = resolved.implementations
            .find(implementation => implementation.modelId === binding.modelId)?.id
            ?? binding.modelId
          const payload = await worker.invoke({
            implementationId,
            input,
            signal: invocation.signal,
            resolvePath,
          }) as JsonObject
          // The same reserved-root assertion as the in-process path (EXT-17).
          assertNoReservedMeta(payload, binding.modelId)
          return payload as Record<string, JsonValue>
        },
        dispose: async (): Promise<void> => {
          await registry.dispose(binding.extension)
        },
      }
    }

    return {
      modelId: entry.id,
      invoke: async (invocation: AdapterInvocation): Promise<Record<string, JsonValue>> => {
        const activated = await this.#activate(binding.extension, entry)
        const provider = await this.#providerFor(activated, binding)
        return this.#invoke(provider, binding, invocation)
      },
      // An arrow function, not a method: a method's `this` would be the adapter
      // object literal rather than the bridge, so `#activated` would not resolve.
      dispose: async (): Promise<void> => {
        // Provider-level disposal only when a provider was actually created:
        // disposing a model that was never called must not activate its extension
        // merely in order to shut it down.
        const activated = this.#activated.get(binding.extension)
        if (activated === undefined) return
        const provider = (await activated).providers.get(binding.modelId)
        if (provider !== undefined) await (await provider).dispose()
      },
    }
  }

  /** Release every activated extension. */
  async dispose(reason: 'deactivate' | 'upgrade' | 'uninstall' | 'shutdown' | 'fault' = 'shutdown'): Promise<void> {
    const extensions = [...this.#activated.values()]
    this.#activated.clear()
    for (const pending of extensions) {
      try {
        const activated = await pending
        for (const provider of activated.providers.values()) {
          await (await provider).dispose()
        }
        await activated.instance.dispose(reason)
      } catch (error) {
        // One extension failing to stop must not prevent the others from being
        // released, or a single bad package would leak every process it shares.
        this.#log('extension disposal failed', { error: String(error) })
      }
    }
  }

  /** Activate an extension package once, and reuse it. */
  async #activate(specifier: string, entry: ModelCatalogEntry): Promise<ActivatedExtension> {
    const existing = this.#activated.get(specifier)
    if (existing !== undefined) return existing

    const pending = (async (): Promise<ActivatedExtension> => {
      const loaded = await loadExtensionPackage(specifier, entry)
      const instance = await activateExtension(loaded, this.#contextFor(specifier))
      return { instance, providers: new Map() }
    })()
    this.#activated.set(specifier, pending)
    pending.catch(() => {
      if (this.#activated.get(specifier) === pending) this.#activated.delete(specifier)
    })
    return pending
  }

  /** Create or reuse the provider for one model. */
  async #providerFor(
    activated: ActivatedExtension,
    binding: ProviderBinding,
  ): Promise<ModelProviderV1> {
    const existing = activated.providers.get(binding.modelId)
    if (existing !== undefined) return existing
    const pending = activated.instance.createProvider({
      modelId: binding.modelId,
      configuration: {},
    })
    activated.providers.set(binding.modelId, pending)
    pending.catch(() => {
      if (activated.providers.get(binding.modelId) === pending) activated.providers.delete(binding.modelId)
    })
    return pending
  }

  /** Run one invocation through the provider. */
  async #invoke(
    provider: ModelProviderV1,
    binding: ProviderBinding,
    invocation: AdapterInvocation,
  ): Promise<Record<string, JsonValue>> {
    const authority = invocation.authority ?? createInvocationAuthority(this.#grant, 'interactive')

    /**
     * The load is deliberately NOT coordinated here.
     *
     * An earlier version routed `provider.load()` through the DeploymentCoordinator at
     * this point, and the suite caught the consequence: loading then happened BEFORE
     * the implementation authorized its inputs, so a call with a denied path loaded
     * ~349 MB of weights before refusing. SEC-06 wants the denial first, and the
     * extension performs path resolution inside `invoke`, so the coordinator cannot be
     * placed here without inverting that.
     *
     * The coordinator is therefore a tested, standalone component (RES-02/03/05) whose
     * place is INSIDE an implementation's own load path, where it can sit after the
     * checks that must precede a load. Wiring it here would have traded a security
     * property for a resource optimisation.
     */
    const input: JsonObject = {}
    for (const [key, value] of Object.entries(invocation.args)) {
      input[key] = value as JsonValue
    }

    const payload = await provider.invoke({
      implementationId: binding.modelId,
      input,
      context: {
        invocationId: `inv_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
        signal: invocation.signal,
        limits: authority.limits,
        resolvePath: candidate => authority.resolvePath(candidate),
      },
    })

    // The host authors the reserved root `meta` (EXT-17). An extension supplying one
    // is asserting its own provenance, which it does not get to do.
    assertNoReservedMeta(payload, binding.modelId)
    return payload as Record<string, JsonValue>
  }


  /** Build the context an extension receives, which carries no host internals. */
  #contextFor(extensionId: string): ExtensionContextV1 {
    const controller = new AbortController()
    return {
      extensionId,
      extensionVersion: '0.0.0',
      activationGeneration: this.#generation,
      storage: {
        // The host grants a directory it owns; the extension never receives a
        // path into the operator's own filesystem.
        directory: '',
        async read() { return undefined },
        async write() { /* replaced by the host storage layer */ },
      },
      logger: {
        log: (level, message, fields) => {
          this.#log(`${level}: ${message}`, fields as Record<string, unknown> | undefined)
        },
      },
      signal: controller.signal,
      configuration: {},
    }
  }
}

/**
 * Resolve an extension package's entry path, manifest identity and manifest path BY
 * DISCOVERY ONLY (EXT-20).
 *
 * This reads the package's metadata — the package.json and the manifest — and
 * returns the absolute `./tool-mode` entry path, the manifest's TRUE id, and the
 * manifest path WITHOUT importing the entry. Managed mode needs exactly this: the
 * worker child imports the entry in its own process and derives its model mapping
 * from the manifest, so the host must never load the module — and must key the
 * worker by the manifest id, never by a path.
 * @param specifier - the package name or absolute install path.
 * @param entry - the catalog entry, for diagnostics.
 * @returns the entry path, the manifest id and the manifest path.
 * @throws ProviderBridgeError when the package cannot be resolved or has no entry.
 */
async function resolveExtensionPackage(
  specifier: string,
  entry: ModelCatalogEntry,
): Promise<{
  readonly entryPath: string
  readonly manifestId: string
  readonly manifestPath: string
  readonly implementations: ReadonlyArray<{ readonly id: string; readonly modelId: string }>
}> {
  let packageJsonPath: string
  try {
    // `import.meta.resolve` is the resolver the runtime itself uses, so the
    // extension is found exactly as Node would find it at call time. An ABSOLUTE
    // path resolves to the exact installed copy.
    if (isAbsolute(specifier)) {
      packageJsonPath = pathToFileURL(join(specifier, 'package.json')).href
    } else {
      packageJsonPath = import.meta.resolve(`${specifier}/package.json`)
    }
  } catch (error) {
    const origin = isAbsolute(specifier)
      ? 'the installed package'
      : `the dependency "${specifier}"`
    throw new ProviderBridgeError(
      `model "${entry.id}" cannot reach ${origin}, which could not be resolved: `
      + `${error instanceof Error ? error.message : String(error)}. `
      + (isAbsolute(specifier)
        ? 'The store install path is unreadable; reinstall the package and retry.'
        : 'Install it, or correct the catalog binding.'),
    )
  }

  const { discoverExtension } = await import('@try-works/tool-mode-extension-sdk')
  const discovery = discoverExtension(
    new URL('.', packageJsonPath).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  )
  if (discovery.entryPath === undefined) {
    throw new ProviderBridgeError(
      `extension "${specifier}" declares no ${EXTENSION_ENTRY} entry, so it cannot provide model "${entry.id}"`,
    )
  }
  return {
    entryPath: discovery.entryPath,
    manifestId: discovery.manifest.id,
    manifestPath: discovery.manifestPath,
    implementations: discovery.manifest.implementations
      .filter((implementation): implementation is typeof implementation & { readonly modelId: string } =>
        typeof implementation.modelId === 'string')
      .map(implementation => ({ id: implementation.id, modelId: implementation.modelId })),
  }
}

/**
 * Import an extension package's public entry.
 *
 * The specifier is resolved by Node like any other dependency, then the package's
 * own discovery runs so the entry comes from its real `exports` map rather than
 * from a host-side convention.
 * @param specifier - the package name or path.
 * @param entry - the catalog entry, for diagnostics.
 * @returns the validated extension module.
 * @throws ProviderBridgeError when the package cannot be resolved or has no entry.
 */
async function loadExtensionPackage(specifier: string, entry: ModelCatalogEntry) {
  const { entryPath } = await resolveExtensionPackage(specifier, entry)
  return loadExtensionModule(entryPath)
}
