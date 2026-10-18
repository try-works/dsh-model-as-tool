/**
 * The Desert Ant Voz extension.
 *
 * The adapter that used to live at
 * `@try-works/dsh-model-as-tool/src/adapters/voz.ts`. With this extraction the
 * host holds no model-specific implementation at all, which is what BASE-09
 * requires: a first-party package is reached through the same public entry as a
 * third-party one, so no built-in code has a privilege a published package lacks.
 *
 * It imports ONLY `@try-works/tool-mode-extension-sdk` (EXT-02), plus its own
 * optional runtime dependencies at call time.
 *
 * Voz has no prebuilt Node core: it runs one WebAssembly/ONNX pipeline everywhere
 * and requires the caller to hand it an ONNX Runtime module. `onnxruntime-node`
 * ships win32-x64 binaries, which is what makes Voz the one audio model that works
 * on Windows. Loading is expensive — roughly 349 MB of weights plus three compiled
 * ONNX graphs — so the instance is cached and loaded on `load()`, never on import
 * or `create()` (EXT-19).
 *
 * @module @try-works/extension-desert-ant-voz
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
const VOZ_PACKAGE = '@desert-ant-labs/voz'

/** The ONNX Runtime binding, an optional dependency of this extension. */
const DEFAULT_ORT_RUNTIME = 'onnxruntime-node'

/** Cap on the words returned inline, so a long recording cannot flood the context. */
const MAX_WORDS = 2000

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

/**
 * Map the native transcription to the DECLARED contract payload
 * (schemas/stt-transcribe.output.json, TASK-115): `text` + the honest
 * `coverage` object, with the optional `words` when requested. The native
 * wordCount/realtimeFactor/wordsTruncated are NOT in the schema and are
 * dropped.
 *
 * COVERAGE FORMULA (documented honestly): the provider exposes per-word time
 * spans but no audio duration, so
 * - transcribedSeconds = last word end − first word start (0 with no spans);
 * - complete = the transcription was not truncated by MAX_WORDS (the ONLY
 *   truncation signal the provider exposes);
 * - totalSeconds = null (no duration is available — never fabricated).
 */
export function mapTranscription(
  result: VozResult,
  includeWords: boolean,
): Record<string, unknown> {
  const nativeWords = result.words ?? []
  const words = includeWords
    ? nativeWords.slice(0, MAX_WORDS).map(word => ({
        text: word.text,
        start: word.start,
        end: word.end,
      }))
    : undefined
  const truncated = nativeWords.length > MAX_WORDS
  const first = nativeWords[0]
  const last = nativeWords[nativeWords.length - 1]
  const transcribedSeconds = first !== undefined && last !== undefined
    ? Math.max(0, last.end - first.start)
    : 0
  const value: Record<string, unknown> = {
    text: result.text,
    coverage: {
      complete: !truncated,
      transcribedSeconds,
      totalSeconds: null,
      reason: null,
    },
  }
  if (words !== undefined) value['words'] = words
  return value
}

/** Throw if the signal has been aborted. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('the invocation was aborted')
  }
}

/**
 * Read the CONTRACT input's audio path (TASK-120).
 *
 * The host validates the caller's input against
 * schemas/stt-transcribe.input.json — `{audio: {path, ...}}` with
 * additionalProperties: false — and hands that document to the handler. The
 * native `audio_path` name this used to read is never present on the wire,
 * which was the live failure.
 * @param input - the validated contract input.
 * @returns the caller-supplied path, still unauthorized.
 */
export function audioPathOf(input: Readonly<JsonObject>): string {
  const audio = input.audio
  const path = audio !== null && typeof audio === 'object'
    ? (audio as Readonly<JsonObject>)['path']
    : undefined
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('argument "audio.path" must be a non-empty string')
  }
  return path
}

/**
 * Read the contract's `timestamps` selection into the words decision
 * (TASK-120): 'word' requires the per-word spans, and an implementation that
 * cannot supply them must ERROR rather than omit them (the schema's rule).
 */
export function includeWordsFor(input: Readonly<JsonObject>): boolean {
  const timestamps = input.timestamps
  if (timestamps !== undefined && timestamps !== null && timestamps !== 'none' && timestamps !== 'word') {
    throw new Error(`unsupported "timestamps" value ${JSON.stringify(timestamps)} (the schema allows "none" or "word")`)
  }
  return timestamps === 'word'
}

/** Build the provider for the Voz deployment. */
function createVozProvider(context: ExtensionContextV1): ModelProviderV1 {
  let loaded: Promise<VozInstance> | undefined
  let disposed = false

  const load = async (): Promise<VozInstance> => {
    loaded ??= (async () => {
      try {
        // Both specifiers are variables: each is an optional dependency that may
        // legitimately be absent, and a static import would break installs that
        // skip them.
        const ort = await import(DEFAULT_ORT_RUNTIME)
        const module = await import(VOZ_PACKAGE) as unknown as VozModule
        return await module.Voz.load({ ort })
      } catch (error) {
        // Clear the cache so a transient failure, or a later install, can be
        // retried rather than poisoning the provider for the process lifetime.
        loaded = undefined
        throw new Error(
          `Voz could not be loaded: ${error instanceof Error ? error.message : String(error)}. `
          + 'Voz needs onnxruntime-node installed beside the extension.',
        )
      }
    })()
    return loaded
  }

  return {
    async inspect(signal): Promise<ProviderInspectionV1> {
      throwIfAborted(signal)
      // EXT-18: inspection reads approved local state only. It reports whether the
      // dependencies RESOLVE without loading 349 MB of weights or transcribing.
      const missing: { name: string; reason: string }[] = []
      for (const specifier of [DEFAULT_ORT_RUNTIME, VOZ_PACKAGE]) {
        try {
          const resolved = import.meta.resolve?.(specifier)
          if (typeof resolved !== 'string') throw new Error('unresolved')
        } catch {
          missing.push({ name: specifier, reason: `install ${specifier} to enable this deployment` })
        }
      }
      if (missing.length > 0) {
        return { readiness: 'needs-preparation', features: ['speech-to-text', 'word-timestamps'], missing }
      }
      return {
        // The runtime package and model package resolve, so the deployment is
        // prepared and callable even when it is currently cold. Cold residency is
        // handled by load/admission; it is prepared-cold rather than warm ready.
        readiness: loaded === undefined ? 'prepared-cold' : 'ready',
        features: ['speech-to-text', 'word-timestamps'],
        missing: [],
        ...loaded === undefined ? { reason: 'the model is prepared but cold; it loads on first use' } : {},
      }
    },

    async load(request: { readonly assets: Readonly<PreparedAssetMapV1>; readonly signal: AbortSignal }) {
      throwIfAborted(request.signal)
      // The weights are downloaded by the model package into its own cache on
      // first load, not by the host: the asset lock declares an empty asset set
      // because the host prepares nothing itself.
      await load()
    },

    async invoke({ input, context: invocation }): Promise<JsonObject> {
      throwIfAborted(invocation.signal)
      if (disposed) throw new Error('the provider has been disposed')

      const requested = audioPathOf(input)
      // SEC-06: the caller-supplied path is authorized by the HOST before it is
      // opened, and the CANONICAL path is what gets opened. Validating the string
      // and then opening it would leave a check-then-open window a symlink wins.
      const audioPath = invocation.resolvePath(requested)

      /**
       * TASK-120, the language request: the voz package documents 25 languages
       * and auto-detects, and exposes NO per-call language parameter. The
       * published artifacts carry no retrievable code list, so this
       * implementation cannot verify per-code support — an explicit,
       * well-formed language request is therefore honored by the model's own
       * auto-detection (recorded honestly in the README), and the schema's
       * malformed-code refusals happen before this handler runs. The residual
       * (no per-code supported set) is documented, never silently invented.
       */
      const requestedLanguage = input.language
      if (requestedLanguage !== undefined && requestedLanguage !== null
        && (typeof requestedLanguage !== 'string' || requestedLanguage.length < 2)) {
        throw new Error('"language" must be a BCP-47/ISO 639 code of at least two characters')
      }
      const includeWords = includeWordsFor(input)

      const voz = await load()
      throwIfAborted(invocation.signal)

      const result = await voz.transcribe(audioPath)
      throwIfAborted(invocation.signal)

      if (includeWords && (result.words === undefined || result.words.length === 0)) {
        throw new Error('timestamps "word" was requested but the model produced no word spans; refuse rather than omit')
      }

      // The pure contract mapping (TASK-115): the host validates the payload
      // against schemas/stt-transcribe.output.json with
      // additionalProperties: false, so the emitted fields are exactly the
      // declared ones (the formula is documented on mapTranscription).
      return mapTranscription(result, includeWords) as unknown as JsonObject
    },

    async unload(signal) {
      throwIfAborted(signal)
      // Dropping the cache is honest here only because the next call reloads; if a
      // provider ever holds a process-level resource this must release it too.
      if (loaded === undefined) return
      const instance = await loaded.catch(() => undefined)
      instance?.dispose?.()
      loaded = undefined
    },

    async dispose() {
      disposed = true
      if (loaded !== undefined) {
        const instance = await loaded.catch(() => undefined)
        instance?.dispose?.()
        loaded = undefined
      }
      context.logger.log('debug', 'voz provider disposed')
    },
  }
}

export default defineExtension({
  apiVersion: 1,
  async create(context): Promise<ExtensionInstanceV1> {
    return {
      async createProvider({ modelId }) {
        if (modelId !== 'voz') {
          throw new Error(`this extension implements the "voz" model, not "${modelId}"`)
        }
        // A handle only: no download, no load (EXT-19).
        return createVozProvider(context)
      },
      async dispose(reason) {
        context.logger.log('debug', `voz extension disposed: ${reason}`)
      },
    }
  },
})
