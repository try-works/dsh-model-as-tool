/**
 * Tongue adapter — on-device language identification for short text.
 *
 * Tongue is the one Desert Ant model that runs in plain Node on every platform:
 * it is pure JavaScript with no WASM or inference runtime, and its 2 MB model
 * ships inside the npm package. That makes it the reference adapter: the module
 * is imported on first use, the loaded model is cached for the process, and the
 * synchronous `detect()` is wrapped in the async tool contract.
 *
 * @module @dsh-plugins/dsh-model-tools/adapters/tongue
 */

import type { ModelCatalogEntry } from '../types.ts'
import {
  optionalInteger,
  requireString,
  throwIfAborted,
  type JsonValue,
  type ModelAdapter,
} from './types.ts'

/** The subset of the Tongue module surface this adapter depends on. */
interface TongueCandidate {
  readonly language: string
  readonly probability: number
}

interface TongueDetection {
  readonly language: string
  readonly reliability?: string
  readonly candidates?: readonly TongueCandidate[]
  readonly isTooCloseToCall?: boolean
}

interface TongueInstance {
  detect(text: string): TongueDetection
  dispose?(): void
}

interface TongueModule {
  Tongue: { load(options?: { from?: string }): Promise<TongueInstance> }
}

/** Default number of runner-up candidates reported to the model. */
const DEFAULT_TOP = 3
const MAX_TOP = 20

/**
 * Build the Tongue adapter.
 *
 * The model is loaded once and reused, because `Tongue.load()` parses the
 * bundled 2 MB weight file and detection afterwards is synchronous.
 * @param entry - the catalog entry this adapter serves.
 * @returns the adapter, or undefined if the entry is not Tongue.
 */
export function createTongueAdapter(entry: ModelCatalogEntry): ModelAdapter | undefined {
  if (entry.id !== 'tongue') return undefined

  let loaded: Promise<TongueInstance> | undefined

  const load = async (): Promise<TongueInstance> => {
    loaded ??= (async () => {
      try {
        // A dynamic import keyed off a variable keeps this out of the module
        // graph until the tool is actually called: the package is an optional
        // dependency, so a static import would break installs that skip it.
        const specifier = entry.npmPackage as string
        const module = await import(specifier) as unknown as TongueModule
        return await module.Tongue.load()
      } catch (error) {
        // Clear the cache so a transient failure (or a later install) can be
        // retried by the next call rather than poisoning the tool for the life
        // of the plugin.
        loaded = undefined
        throw new Error(
          `Tongue could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })()
    return loaded
  }

  return {
    modelId: entry.id,
    async invoke({ args, signal }): Promise<Record<string, JsonValue>> {
      throwIfAborted(signal)
      const text = requireString(args, 'text')
      const top = optionalInteger(args, 'top', { min: 1, max: MAX_TOP, fallback: DEFAULT_TOP })

      const tongue = await load()
      throwIfAborted(signal)

      const detection = tongue.detect(text)
      const candidates = (detection.candidates ?? []).slice(0, top)
      return {
        language: detection.language,
        reliability: detection.reliability ?? 'unknown',
        isTooCloseToCall: detection.isTooCloseToCall ?? false,
        candidates: candidates.map(candidate => ({
          language: candidate.language,
          probability: candidate.probability,
        })),
      }
    },
    async dispose() {
      if (loaded === undefined) return
      const instance = await loaded.catch(() => undefined)
      instance?.dispose?.()
      loaded = undefined
    },
  }
}
