/**
 * Voz adapter — on-device speech recognition with word timestamps.
 *
 * Voz has no prebuilt Node core; it runs the same WebAssembly/ONNX Runtime
 * pipeline everywhere and requires the caller to hand it an ONNX Runtime
 * module. `onnxruntime-node` ships win32-x64 binaries, which is what makes Voz
 * the one audio model that works on Windows.
 *
 * Loading is expensive (the weights are ~349 MB and ONNX Runtime compiles three
 * graphs), so the instance is cached for the process and reused.
 *
 * @module @dsh-plugins/dsh-model-tools/adapters/voz
 */

import type { ModelCatalogEntry } from '../types.ts'
import {
  optionalBoolean,
  requireString,
  throwIfAborted,
  type JsonValue,
  type ModelAdapter,
} from './types.ts'

/** One word with its time span, as Voz reports it. */
interface VozWord {
  readonly text: string
  readonly start: number
  readonly end: number
}

interface VozResult {
  readonly text: string
  readonly words?: readonly VozWord[]
  readonly realtimeFactor?: number
}

interface VozInstance {
  transcribe(
    input: unknown,
    options?: { readonly onProgress?: (fraction: number) => void },
  ): Promise<VozResult>
  dispose?(): void
}

interface VozModule {
  Voz: {
    load(options: {
      readonly ort: unknown
      readonly onProgress?: (fraction: number) => void
    }): Promise<VozInstance>
  }
}

/** Cap on the words returned inline, so a long recording cannot flood the context. */
const MAX_WORDS = 2000

/**
 * Build the Voz adapter.
 * @param entry - the catalog entry this adapter serves.
 * @returns the adapter, or undefined if the entry is not Voz.
 */
export function createVozAdapter(entry: ModelCatalogEntry): ModelAdapter | undefined {
  if (entry.id !== 'voz') return undefined

  let loaded: Promise<VozInstance> | undefined

  const load = async (): Promise<VozInstance> => {
    loaded ??= (async () => {
      try {
        // Both specifiers are variables for the same reason as Tongue: each is
        // an optional dependency that may legitimately be absent.
        const runtimeSpecifier = entry.requiresRuntime[0] ?? 'onnxruntime-node'
        const ort = await import(runtimeSpecifier)
        const module = await import(entry.npmPackage as string) as unknown as VozModule
        return await module.Voz.load({ ort })
      } catch (error) {
        loaded = undefined
        throw new Error(
          `Voz could not be loaded: ${error instanceof Error ? error.message : String(error)}. `
          + 'Voz needs onnxruntime-node installed beside the plugin.',
        )
      }
    })()
    return loaded
  }

  return {
    modelId: entry.id,
    async invoke({ args, signal }): Promise<Record<string, JsonValue>> {
      throwIfAborted(signal)
      const audioPath = requireString(args, 'audio_path')
      const includeWords = optionalBoolean(args, 'include_words', true)

      const voz = await load()
      throwIfAborted(signal)

      const result = await voz.transcribe(audioPath)
      throwIfAborted(signal)

      const value: Record<string, JsonValue> = {
        text: result.text,
        wordCount: result.words?.length ?? 0,
      }
      if (typeof result.realtimeFactor === 'number') {
        value.realtimeFactor = result.realtimeFactor
      }
      if (includeWords) {
        const words = result.words ?? []
        value.words = words.slice(0, MAX_WORDS).map(word => ({
          text: word.text,
          start: word.start,
          end: word.end,
        }))
        if (words.length > MAX_WORDS) value.wordsTruncated = true
      }
      return value
    },
    async dispose() {
      if (loaded === undefined) return
      const instance = await loaded.catch(() => undefined)
      instance?.dispose?.()
      loaded = undefined
    },
  }
}
