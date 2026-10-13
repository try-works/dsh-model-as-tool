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
} from '@try-works/tool-mode-extension-sdk'

import { createInvocationAuthority, type ToolGrant } from './authority.ts'
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

  constructor(options: {
    readonly grant: ToolGrant
    readonly activationGeneration: number
    readonly log?: (message: string, fields?: Record<string, unknown>) => void
  }) {
    this.#grant = options.grant
    this.#generation = options.activationGeneration
    this.#log = options.log ?? (() => {})
  }

  /** The extensions currently activated, for diagnostics. */
  get activatedExtensions(): readonly string[] {
    return [...this.#activated.keys()]
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
    return pending
  }

  /** Run one invocation through the provider. */
  async #invoke(
    provider: ModelProviderV1,
    binding: ProviderBinding,
    invocation: AdapterInvocation,
  ): Promise<Record<string, JsonValue>> {
    const authority = invocation.authority ?? createInvocationAuthority(this.#grant, 'interactive')
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

    // The host authors the reserved root `meta` (EXT-17). An extension supplying
    // one is asserting its own provenance, which it does not get to do.
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
  let packageJsonPath: string
  try {
    // `import.meta.resolve` is the resolver the runtime itself uses, so the
    // extension is found exactly as Node would find it at call time.
    packageJsonPath = import.meta.resolve(`${specifier}/package.json`)
  } catch (error) {
    throw new ProviderBridgeError(
      `model "${entry.id}" declares the extension "${specifier}", which could not be resolved: `
      + `${error instanceof Error ? error.message : String(error)}. Install it, or correct the catalog binding.`,
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
  return loadExtensionModule(discovery.entryPath)
}
