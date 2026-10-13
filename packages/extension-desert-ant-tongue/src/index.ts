/**
 * The Desert Ant Tongue extension.
 *
 * This is the adapter that used to live at
 * `@try-works/dsh-model-as-tool/src/adapters/tongue.ts`. It moved out because
 * BASE-09 forbids a private built-in adapter path: the host must reach every
 * model through the same public extension API, so a first-party package has no
 * privileges a third-party one lacks.
 *
 * It imports ONLY `@try-works/tool-mode-extension-sdk` (EXT-02). Importing host
 * internals would make it unbuildable without the host and would break on any
 * host refactor, which is exactly the coupling the extraction exists to remove.
 *
 * The model itself is loaded lazily on `load()`, never on import or `create()`
 * (EXT-19), because `Tongue.load()` parses a bundled 2 MB weight file.
 *
 * @module @try-works/extension-desert-ant-tongue
 */

import {
  defineExtension,
  type ExtensionContextV1,
  type ExtensionInstanceV1,
  type JsonObject,
  type ModelProviderV1,
  type PreparedAssetMapV1,
  type ProviderInspectionV1,
} from '@try-works/tool-mode-extension-sdk'

/** The npm package carrying the model. */
const TONGUE_PACKAGE = '@desert-ant-labs/tongue'

/** Default number of runner-up candidates reported. */
const DEFAULT_TOP = 3
const MAX_TOP = 20

/** The shape of the `@desert-ant-labs/tongue` module we depend on. */
interface TongueModule {
  Tongue: {
    load(): Promise<TongueInstance>
  }
}

/** One detection result, as the package reports it. */
interface TongueDetection {
  readonly language?: string
  readonly reliability?: string
  readonly isTooCloseToCall?: boolean
  readonly candidates?: readonly { readonly language: string; readonly probability: number }[]
}

/** A loaded Tongue model. */
interface TongueInstance {
  detect(text: string): TongueDetection
}

/** Read a required string argument. */
function requireString(input: Readonly<JsonObject>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`argument "${key}" must be a non-empty string`)
  }
  return value
}

/** Read an optional bounded integer argument. */
function optionalInteger(
  input: Readonly<JsonObject>,
  key: string,
  bounds: { min: number; max: number; fallback: number },
): number {
  const value = input[key]
  if (value === undefined || value === null) return bounds.fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`argument "${key}" must be an integer`)
  }
  return Math.min(Math.max(value, bounds.min), bounds.max)
}

/** Throw if the signal has been aborted. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('the invocation was aborted')
  }
}

/** Build the provider for the Tongue deployment. */
function createTongueProvider(context: ExtensionContextV1): ModelProviderV1 {
  /** The loaded model, cached so repeated calls do not re-parse the weights. */
  let loaded: Promise<TongueInstance> | undefined
  let disposed = false

  const load = async (): Promise<TongueInstance> => {
    loaded ??= (async () => {
      try {
        // A dynamic import keyed off a constant keeps the package out of the
        // module graph until the model is actually needed: it is an optional
        // dependency, so a static import would break installs that skip it.
        const module = await import(TONGUE_PACKAGE) as unknown as TongueModule
        return await module.Tongue.load()
      } catch (error) {
        // Clear the cache so a transient failure, or a later install, can be
        // retried by the next call rather than poisoning the provider.
        loaded = undefined
        throw new Error(`Tongue could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    return loaded
  }

  return {
    async inspect(signal): Promise<ProviderInspectionV1> {
      throwIfAborted(signal)
      // Inspection reads approved local state only (EXT-18): it reports whether the
      // model can be loaded without loading it, downloading anything or inferring.
      try {
        const resolved = import.meta.resolve?.(TONGUE_PACKAGE)
        if (typeof resolved !== 'string') {
          return {
            readiness: 'unprepared',
            features: ['language-detection'],
            missing: [{ name: TONGUE_PACKAGE, reason: 'the package could not be resolved on this host' }],
          }
        }
      } catch {
        return {
          readiness: 'unprepared',
          features: ['language-detection'],
          missing: [{ name: TONGUE_PACKAGE, reason: `install ${TONGUE_PACKAGE} to enable this deployment` }],
        }
      }
      return {
        readiness: loaded === undefined ? 'unprepared' : 'ready',
        features: ['language-detection', 'script-detection'],
        missing: [],
        ...loaded === undefined ? { reason: 'the model is not loaded yet; it loads on first use' } : {},
      }
    },

    async load(request: { readonly assets: Readonly<PreparedAssetMapV1>; readonly signal: AbortSignal }) {
      throwIfAborted(request.signal)
      // Tongue ships its weights INSIDE the npm package, so there is no separate
      // asset to prepare and the asset map is legitimately empty.
      await load()
    },

    async invoke({ input, context: invocation }): Promise<JsonObject> {
      throwIfAborted(invocation.signal)
      if (disposed) throw new Error('the provider has been disposed')
      const text = requireString(input, 'text')
      const top = optionalInteger(input, 'top', { min: 1, max: MAX_TOP, fallback: DEFAULT_TOP })

      const tongue = await load()
      throwIfAborted(invocation.signal)

      const detection = tongue.detect(text)
      const candidates = (detection.candidates ?? []).slice(0, top)
      // The domain payload only: the host authors the reserved root `meta`
      // (EXT-17), so nothing here may supply one.
      return {
        language: detection.language ?? null,
        reliability: detection.reliability ?? 'unknown',
        isTooCloseToCall: detection.isTooCloseToCall ?? false,
        candidates: candidates.map(candidate => ({
          language: candidate.language,
          probability: candidate.probability,
        })),
      }
    },

    async unload(signal) {
      throwIfAborted(signal)
      // Tongue holds no process-level resource beyond the parsed weights, and
      // re-parsing them on the next call is cheap, so unloading is a cache drop.
      loaded = undefined
    },

    async dispose() {
      disposed = true
      loaded = undefined
      context.logger.log('debug', 'tongue provider disposed')
    },
  }
}

export default defineExtension({
  apiVersion: 1,
  async create(context): Promise<ExtensionInstanceV1> {
    return {
      async createProvider({ modelId }) {
        if (modelId !== 'tongue') {
          throw new Error(`this extension implements the "tongue" model, not "${modelId}"`)
        }
        // A handle only: no download, no load (EXT-19).
        return createTongueProvider(context)
      },
      async dispose(reason) {
        context.logger.log('debug', `tongue extension disposed: ${reason}`)
      },
    }
  },
})
