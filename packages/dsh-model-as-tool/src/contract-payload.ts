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

/**
 * Translate the contract's caller-facing arguments into the implementation's
 * native vocabulary.
 * @param contractId - the contract the implementation was selected for.
 * @param contractArgs - the validated contract arguments.
 * @returns the native argument shape.
 */
export function toNativeArgs(
  contractId: string,
  contractArgs: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  void contractId
  /**
   * TASK-115/120/121: the extension implementations now speak the CONTRACT
   * vocabulary on BOTH sides (the tongue/voz mappings published in 0.1.3 and
   * 0.1.5 read {audio:{path}} and emit the contract payloads), so the host's
   * argument translation is a PASS-THROUGH — the old audio_path/include_words
   * native vocabulary no longer exists on the wire. A future implementation
   * with a genuinely different native vocabulary re-introduces its case here.
   */
  return { ...contractArgs }
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
  void contractId
  void args
  // TASK-115/120/121: the extension implementations emit the CONTRACT payloads
  // directly, so the result translation is the identity; the output schema's
  // validation is the authority that accepts or rejects the payload.
  return native
}
