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

import { createRequire } from 'node:module'
import { statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

/** Node resolution rooted at THIS module, so inspection never depends on `import.meta.resolve` being present. */
const requireFromHere = createRequire(import.meta.url)

/**
 * A complete Tongue bin is ~2.1 MB in every published revision this range admits.
 * Anything below this floor is treated as truncated or corrupt — an ASSUMPTION
 * about future revisions, not a fact about this one; a corrupt full-size bin is
 * caught at load() instead, because EXT-18 forbids parsing the file to prove it.
 */
const MIN_WEIGHT_BYTES = 1_000_000

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
      //
      // The check is not mere RESOLVABILITY: the weight file the package ships is
      // statted, so a package whose bin is missing or truncated (a corrupted
      // install) reports needs-preparation instead of publishing prepared-cold.
      // The subpath comes from the package's own exports map, so resolution
      // succeeds exactly when the file ships.
      const verdict = inspectBundledWeights(
        // `createRequire().resolve` exists on every supported Node and throws on
        // failure; `import.meta.resolve` appeared in 20.6 and would silently
        // degrade to undefined on older runtimes, which reads as "package absent"
        // while it is installed. The result is normalised to a file URL because
        // that is what the helper's statter consumes.
        specifier => {
          try {
            return pathToFileURL(requireFromHere.resolve(specifier)).href
          } catch {
            return undefined
          }
        },
        fileUrl => statSync(fileURLToPath(fileUrl)).size,
      )
      if (!verdict.ok) {
        return {
          readiness: 'needs-preparation',
          features: ['language-detection'],
          missing: [{ name: TONGUE_PACKAGE, reason: verdict.reason }],
        }
      }
      return {
        // The bundled model package is present AND its weight file is complete, so
        // the deployment is prepared and callable even when it is currently cold.
        // Residency is not readiness: the first invocation may load the package,
        // so this is prepared-cold rather than warm `ready`.
        readiness: loaded === undefined ? 'prepared-cold' : 'ready',
        features: ['language-detection', 'script-detection'],
        missing: [],
        ...loaded === undefined ? { reason: 'the model is prepared but cold; it loads on first use' } : {},
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

/**
 * The inspection logic, separated so the weight-file honesty is unit-testable.
 *
 * Inspection may not import or parse the model (EXT-18), so it cannot prove the
 * bin decodes; what it CAN prove without a load is that the file the package's
 * exports map advertises exists and is not obviously truncated. That is the
 * difference between "the package is installed" and "the deployment is prepared",
 * and the exported shape exists so a corrupted install is pinned by a test.
 * @param resolve - resolves a specifier to a file URL, like import.meta.resolve.
 * @param statSize - returns a file's byte size, like statSync().size.
 * @returns the readiness verdict for the bundled weight file.
 */
export function inspectBundledWeights(
  resolve: (specifier: string) => string | undefined,
  statSize: (fileUrl: string) => number,
): { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly size?: number } {
  let resolved: string | undefined
  try {
    resolved = resolve(`${TONGUE_PACKAGE}/model/tongue_int8.bin`)
  } catch {
    resolved = undefined
  }
  if (typeof resolved !== 'string') {
    /**
     * Distinguish the two facts behind an unresolvable bin: the PACKAGE absent
     * (remedy: install it) versus the package present but not shipping the weight
     * file at its documented subpath (remedy: the installed revision is broken).
     * Resolving the package's own manifest — present in every published version —
     * is what tells them apart, so the reason never tells an operator to install
     * a package that is already installed.
     */
    let packagePresent = false
    try {
      packagePresent = typeof resolve(`${TONGUE_PACKAGE}/package.json`) === 'string'
    } catch {
      packagePresent = false
    }
    return packagePresent
      ? { ok: false, reason: `the installed ${TONGUE_PACKAGE} does not ship the weight file at its documented subpath; reinstall or pin a known-good version` }
      : { ok: false, reason: `install ${TONGUE_PACKAGE} to enable this deployment` }
  }
  let size: number
  try {
    // Resolution can succeed while the FILE is gone (an exports target deleted on
    // disk), so the stat is its own failure mode: a corrupted install must get the
    // reinstall remedy rather than an uncaught throw the host flattens to 'failed'.
    size = statSize(resolved)
  } catch (error) {
    return {
      ok: false,
      reason: `the shipped weight file cannot be read (${error instanceof Error ? error.message : String(error)}); reinstall the package`,
    }
  }
  if (size < MIN_WEIGHT_BYTES) {
    return {
      ok: false,
      size,
      reason: `the shipped weight file is ${size} bytes, smaller than a complete Tongue bin; reinstall the package`,
    }
  }
  return { ok: true }
}
