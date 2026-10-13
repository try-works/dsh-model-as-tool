/**
 * The shared result envelope every Tool Mode tool returns (DECL-03).
 *
 * The envelope is what makes a result self-describing: a caller can tell which
 * contract and version produced it, which implementation actually ran, where it
 * ran, and whether the host attached any warnings. The host stamps the
 * authoritative provenance fields; an implementation cannot forge another
 * package's identity.
 *
 * DECL-04 is the reason `warnings` exists but a universal `confidence` does not:
 * a successful call means a valid result was produced, not that it is correct,
 * and a fabricated confidence number would claim more than the model supplied.
 *
 * @module @try-works/tool-mode-contracts/meta
 */

/** Where an implementation executed, relative to the caller (SPEC §6). */
export type ExecutionLocation =
  /** The harness host process itself. */
  | 'host'
  /** The user's own device. */
  | 'device'
  /** A user-controlled server on the local network. */
  | 'team-server'
  /** A remote service outside the user's control. */
  | 'remote'

/** Provenance and status metadata shared by every tool result. */
export interface ToolMeta {
  /** Contract identity, e.g. `stt.transcribe`. */
  readonly contract: string
  /** Semantic version of the CONTRACT, independent of the host release. */
  readonly contractVersion: string
  /** The implementation that actually executed, e.g. `voz-onnx`. */
  readonly implementationId: string
  /** Owning extension package identity. */
  readonly extension: string
  /** Extension version, stamped by the host. */
  readonly extensionVersion: string
  /** Which activation generation produced this result (DECL-08). */
  readonly activationGeneration: number
  /** Where the work happened. */
  readonly executionLocation: ExecutionLocation
  /** Host-issued receipt identity, for correlation and audit. */
  readonly receiptId: string
  /** Non-fatal conditions the caller should know about. */
  readonly warnings: readonly string[]
}

/** The JSON Schema for {@link ToolMeta}, used to validate every result. */
export const TOOL_META_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'contract', 'contractVersion', 'implementationId', 'extension',
    'extensionVersion', 'activationGeneration', 'executionLocation',
    'receiptId', 'warnings',
  ],
  properties: {
    contract: { type: 'string', minLength: 1 },
    contractVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    implementationId: { type: 'string', minLength: 1 },
    extension: { type: 'string', minLength: 1 },
    extensionVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+' },
    activationGeneration: { type: 'integer', minimum: 0 },
    executionLocation: { type: 'string', enum: ['host', 'device', 'team-server', 'remote'] },
    receiptId: { type: 'string', minLength: 1 },
    warnings: { type: 'array', items: { type: 'string' } },
  },
} as const

/**
 * Attach a `meta` property to a result schema.
 *
 * Contracts declare their own payload; the envelope is identical everywhere, so
 * it is composed here rather than retyped in each contract — retyping it is how
 * the shapes drift apart.
 * @param payload - the contract's payload schema properties.
 * @param requiredPayload - payload property names that are required.
 * @returns a closed object schema containing the payload plus `meta`.
 */
export function withMeta(
  payload: Record<string, unknown>,
  requiredPayload: readonly string[] = [],
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...requiredPayload, 'meta'],
    properties: { ...payload, meta: TOOL_META_SCHEMA },
  }
}
