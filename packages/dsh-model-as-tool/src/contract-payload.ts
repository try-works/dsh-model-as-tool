/**
 * Translation from a model's native result to a contract's payload.
 *
 * The spec puts this responsibility on adapters: they "translate between the
 * capability's canonical representation and the model's native interface". It is
 * a separate module from the invoke adapters because the two change for different
 * reasons — an adapter changes when the vendor SDK does, a translator changes when
 * the contract does — and conflating them is how a contract silently drifts to
 * match whatever the SDK happened to return.
 *
 * The contract is the authority. When a translation cannot supply a field the
 * contract requires, that is reported rather than faked; TOOL-01 is explicit that
 * an incomplete clip must not be presented as fully transcribed.
 *
 * @module @try-works/dsh-model-as-tool/contract-payload
 */

import type { JsonValue } from './adapters/index.ts'

/** Raised when a native result cannot be expressed under its contract. */
export class PayloadTranslationError extends Error {
  override readonly name = 'PayloadTranslationError'
}

/** Best-effort read of a numeric field. */
function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Translate a native language-detection result into the `text.language_detect`
 * payload.
 *
 * The only rename is the vendor's `isTooCloseToCall` to the contract's
 * `tooCloseToCall`; every other field already matches, which is what makes this a
 * translation rather than a reshape.
 * @param native - the adapter's result.
 * @returns the contract payload, without the `meta` envelope the host stamps.
 */
function languageDetectPayload(native: Record<string, JsonValue>): Record<string, JsonValue> {
  const candidates = Array.isArray(native.candidates) ? native.candidates : []
  return {
    // A model that found no language signal returns null rather than a guess.
    language: typeof native.language === 'string' ? native.language : null,
    reliability: typeof native.reliability === 'string' ? native.reliability : 'unknown',
    tooCloseToCall: native.isTooCloseToCall === true,
    candidates: candidates as JsonValue,
  }
}

/**
 * Translate a native transcription result into the `stt.transcribe` payload.
 *
 * `coverage` is the interesting field. Voz streams the whole file and fails loudly
 * on a short decode, so a returned transcript covers all the audio it read;
 * `transcribedSeconds` is taken from the last word's end time, which is a lower
 * bound on the audio actually processed. When no words are reported, coverage is
 * reported as zero seconds with `complete: true` only because the engine ran to
 * completion — an empty transcript is a valid result (TOOL-01), not a failure.
 * @param native - the adapter's result.
 * @param requestedWords - whether the caller asked for word timings.
 * @returns the contract payload, without the `meta` envelope the host stamps.
 */
function transcribePayload(
  native: Record<string, JsonValue>,
  requestedWords: boolean,
): Record<string, JsonValue> {
  const words = Array.isArray(native.words) ? native.words : null
  if (requestedWords && words === null) {
    // TOOL-01: an unsupported timestamp request is an error, never a silent
    // omission the caller might read as "there were no word timings".
    throw new PayloadTranslationError(
      'word timestamps were requested but the implementation returned none; '
      + 'this is reported as an error rather than an empty list',
    )
  }
  let transcribedSeconds = 0
  if (words !== null && words.length > 0) {
    const last = words[words.length - 1] as { end?: unknown }
    transcribedSeconds = numberOf(last.end) ?? 0
  }
  const truncated = native.wordsTruncated === true
  return {
    text: typeof native.text === 'string' ? native.text : '',
    coverage: {
      complete: !truncated,
      transcribedSeconds,
      totalSeconds: null,
      reason: truncated ? 'word list truncated for transport; the transcript text is complete' : null,
    },
    words: words === null ? null : (words as JsonValue),
    language: typeof native.language === 'string' ? native.language : null,
  }
}

/**
 * Translate a contract's validated arguments into an adapter's native shape.
 *
 * This is the input half of the same seam as {@link toContractPayload}. An adapter
 * speaks its SDK's vocabulary — `audio_path` — while the contract publishes the
 * caller's vocabulary — `audio.path`. Without this translation the contract layer
 * would be cosmetic: the model would advertise one shape and the implementation
 * would read another, and every call would fail on a name that no longer exists.
 *
 * The contract is the authority here too, so the mapping is explicit and total
 * rather than a spread that happens to overlap.
 * @param contractId - the contract the call was validated against.
 * @param contractArgs - the validated contract arguments.
 * @returns the arguments the selected adapter expects.
 */
export function toNativeArgs(
  contractId: string,
  contractArgs: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  switch (contractId) {
    case 'stt.transcribe': {
      const audio = contractArgs.audio as { path?: unknown } | undefined
      return {
        audio_path: audio?.path,
        // The contract defaults `timestamps` to none, while the adapter defaults
        // its own flag to true. Mapping explicitly keeps the contract's default
        // authoritative instead of letting the adapter's leak through.
        include_words: contractArgs.timestamps === 'word',
        ...contractArgs.language === undefined ? {} : { language: contractArgs.language },
      }
    }
    default:
      // `text.language_detect` already shares its argument names with the adapter.
      return { ...contractArgs }
  }
}

/**
 * Translate a native implementation result into the payload its contract declares.
 * @param contractId - the contract the implementation was selected for.
 * @param native - the adapter's native result.
 * @param args - the validated arguments, for contract-conditional translation.
 * @returns the contract payload.
 * @throws PayloadTranslationError when the native result cannot satisfy the contract.
 */
export function toContractPayload(
  contractId: string,
  native: Record<string, JsonValue>,
  args: Readonly<Record<string, unknown>> = {},
): Record<string, JsonValue> {
  switch (contractId) {
    case 'text.language_detect':
      return languageDetectPayload(native)
    case 'stt.transcribe':
      return transcribePayload(native, args.timestamps === 'word')
    default:
      // A contract with no translator returns the native payload unchanged, which
      // the output schema then accepts or rejects on its own terms.
      return native
  }
}
