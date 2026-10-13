/**
 * Model qualification and capability resolution (MODEL-01, MODEL-04, MODEL-05, MODEL-06).
 *
 * Four rules, each guarding a way of claiming more than is known:
 *
 * - **A platform table is not proof of correct inference** (MODEL-05). A record is
 *   qualified only when the exact revision, artifact hash, tokenizer, processor, engine
 *   version, ABI and execution provider are all recorded. A missing field is a GAP, and
 *   a gap is not a qualification.
 * - **A model's modality list is not an adapter's** (MODEL-05). A model can support
 *   video while the selected adapter does not, so what is ADVERTISED is the INTERSECTION
 *   of the two, described as such.
 * - **A model name is not a capability test** (MODEL-06). Capability comes from the
 *   resolved model, never from recognising a brand.
 * - **Unknown is not unsupported** (MODEL-06). The requirement says to record them
 *   separately, because collapsing them lets an unevaluated capability be reported as a
 *   known absence — or, worse, the reverse.
 *
 * @module @try-works/dsh-model-as-tool/model-qualification
 */

/**
 * What is known about one capability.
 *
 * Three states rather than two, because MODEL-06 requires unknown and unsupported to be
 * recorded separately.
 */
export type CapabilityState =
  /** Evaluated, and it works. */
  | 'supported'
  /** Evaluated, and it does not. */
  | 'unsupported'
  /** NOT evaluated. Reporting this as either of the others is the defect. */
  | 'unknown'

/** A capability of a model or an adapter. */
export type Modality = 'text' | 'code' | 'image' | 'audio' | 'video' | 'embedding'

/**
 * The exact path a model is executed through (MODEL-05).
 *
 * Every field is required for qualification, because each one has been the difference
 * between "the package imports" and "inference is correct".
 */
export interface QualificationRecord {
  /** The model revision, not a branch or floating tag. */
  readonly modelRevision: string
  /** The SHA of the exported artifact that is actually loaded. */
  readonly artifactSha: string
  /** The tokenizer identity. */
  readonly tokenizer: string
  /** The processor or preprocessing recipe identity. */
  readonly processor: string
  /** The engine or package version. */
  readonly engineVersion: string
  /** The Node ABI. */
  readonly nodeAbi: string
  /** The CPU architecture, e.g. `x64`. */
  readonly architecture: string
  /** The execution provider, e.g. `cpu` or `wasm`. */
  readonly executionProvider: string
}

/** The fields a qualification record must carry. */
export const QUALIFICATION_FIELDS: readonly (keyof QualificationRecord)[] = [
  'modelRevision', 'artifactSha', 'tokenizer', 'processor',
  'engineVersion', 'nodeAbi', 'architecture', 'executionProvider',
]

/**
 * Report which qualification fields are missing (MODEL-05).
 *
 * A platform table, a successful package import or a runnable base model is not proof of
 * correct inference, so a record with gaps is not a qualification however well it runs.
 * @param record - the partial record.
 * @returns the missing fields.
 */
export function qualificationGaps(record: Partial<QualificationRecord>): readonly (keyof QualificationRecord)[] {
  return QUALIFICATION_FIELDS.filter(field => {
    const value = record[field]
    return typeof value !== 'string' || value.length === 0
  })
}

/**
 * Whether a record qualifies a path (MODEL-05).
 * @param record - the partial record.
 * @returns whether every required field is present.
 */
export function isQualified(record: Partial<QualificationRecord>): record is QualificationRecord {
  return qualificationGaps(record).length === 0
}

/** What a model supports, and what an adapter supports. */
export interface ModalityClaim {
  readonly modelSupports: readonly Modality[]
  readonly adapterSupports: readonly Modality[]
}

/**
 * The capabilities that may be ADVERTISED (MODEL-05).
 *
 * The intersection, because a model can support a modality while the selected adapter
 * does not. Advertising the model's list would promise something the adapter cannot do.
 * @param claim - what each side supports.
 * @returns the advertisable modalities.
 */
export function advertisableModalities(claim: ModalityClaim): readonly Modality[] {
  const adapter = new Set(claim.adapterSupports)
  return claim.modelSupports.filter(modality => adapter.has(modality))
}

/**
 * Describe a model's capability as the INTERSECTION (MODEL-05).
 *
 * The description names what is not advertisable and why, so a reader is not left to
 * infer that the model lacks the modality when in fact the adapter does.
 * @param claim - what each side supports.
 * @returns a description that is true of the pairing.
 */
export function describeCapability(claim: ModalityClaim): string {
  const advertisable = advertisableModalities(claim)
  const adapter = new Set(claim.adapterSupports)
  // Named rather than omitted: the model supports these, this adapter does not.
  const modelOnly = claim.modelSupports.filter(modality => !adapter.has(modality))
  const base = advertisable.length === 0
    ? 'no modality is advertisable through this adapter'
    : `advertisable: ${advertisable.join(', ')}`
  return modelOnly.length === 0
    ? base
    : `${base} (the model also supports ${modelOnly.join(', ')}, which this adapter does not)`
}

/**
 * Resolve one capability (MODEL-06).
 *
 * A capability is resolved from what was EVALUATED. A model name is never consulted,
 * because a brand is not a capability test, and an unevaluated capability returns
 * `unknown` rather than being inferred from a sibling.
 * @param evidence - the observed result, or undefined when not evaluated.
 * @returns the state.
 */
export function resolveCapability(evidence: boolean | undefined): CapabilityState {
  if (evidence === undefined) return 'unknown'
  return evidence ? 'supported' : 'unsupported'
}

/**
 * Whether a model name may be used to infer a capability (MODEL-06).
 *
 * It may not. Returns false so the prohibition is asserted rather than merely intended:
 * a rule that lives only in a comment is one a future branch will not read.
 * @returns always false.
 */
export function modelNameImpliesCapability(): boolean {
  return false
}

/** How a candidate implementation executes (MODEL-04). */
export type ExecutionMode =
  /** Pure JavaScript or WASM usable in plain Node. */
  | 'js-wasm-node'
  /** Prebuilt ONNX Runtime for Node. */
  | 'onnxruntime-node'
  /** A managed native Windows executable with pinned assets. */
  | 'managed-native-windows'
  /** Requires Python on the end user's machine. */
  | 'python-required'
  /** Requires WSL. */
  | 'wsl-required'
  /** Requires Docker. */
  | 'docker-required'
  /** Requires a GPU. */
  | 'gpu-required'
  /** Only works in a browser. */
  | 'browser-only'
  /** Requires a consumer-side compile step. */
  | 'consumer-compile'

/** Why a mode was refused. */
export interface ModeVerdict {
  readonly acceptable: boolean
  readonly reason?: string
}

/**
 * Whether an execution mode is acceptable for the end user (MODEL-04).
 *
 * Python, WSL, Docker, a GPU and a consumer compile step are all refused: maintainers may
 * use Python to export artifacts, but it MUST NOT be required on an end user's Windows
 * machine. A browser-only API does not establish Node support.
 * @param mode - the mode.
 * @returns the verdict, with a reason when refused.
 */
export function executionModeVerdict(mode: ExecutionMode): ModeVerdict {
  switch (mode) {
    case 'js-wasm-node':
    case 'onnxruntime-node':
    case 'managed-native-windows':
      return { acceptable: true }
    case 'python-required':
      return {
        acceptable: false,
        reason: 'Python may be used by maintainers to export and verify artifacts, but must not be required on an end user machine',
      }
    case 'wsl-required':
      return { acceptable: false, reason: 'WSL must not be required on an end user machine' }
    case 'docker-required':
      return { acceptable: false, reason: 'Docker must not be required on an end user machine' }
    case 'gpu-required':
      return { acceptable: false, reason: 'no GPU requirement is permitted' }
    case 'browser-only':
      return { acceptable: false, reason: 'browser-only APIs do not establish Node support' }
    case 'consumer-compile':
      return { acceptable: false, reason: 'no consumer-side compile is permitted' }
  }
}

/** An embedding space identity (MODEL-01, BASE-12). */
export interface EmbeddingSpace {
  /** The model that produces it. */
  readonly modelId: string
  /** The dimensionality of the vectors it produces. */
  readonly dimensions: number
}

/**
 * Whether one embedding space may silently stand in for another (BASE-12).
 *
 * Only when the dimensions MATCH. EmbeddingGemma 2 is 768-dimensional and MiniLM is
 * 384-dimensional, so substituting one for the other silently would compare vectors of
 * different widths and produce meaningless similarity.
 * @param from - the space in use.
 * @param to - the proposed replacement.
 * @returns whether the substitution is safe without an explicit migration.
 */
export function maySubstituteSilently(from: EmbeddingSpace, to: EmbeddingSpace): boolean {
  return from.dimensions === to.dimensions
}

/**
 * Describe an embedding substitution (BASE-12).
 * @param from - the space in use.
 * @param to - the proposed replacement.
 * @returns a description naming the incompatibility when there is one.
 */
export function describeSubstitution(from: EmbeddingSpace, to: EmbeddingSpace): string {
  if (maySubstituteSilently(from, to)) {
    return `${to.modelId} produces ${to.dimensions}-dimensional vectors, matching ${from.modelId}`
  }
  return `${to.modelId} produces ${to.dimensions}-dimensional vectors and ${from.modelId} produces `
    + `${from.dimensions}; existing vectors are not comparable and require an explicit re-index`
}

/**
 * The reduced dimensionalities EmbeddingGemma 2 supports (MODEL-01).
 *
 * The model card describes 768 reducible to 512, 256 and 128. Recorded rather than
 * assumed, because a reduction that is not applied consistently produces vectors that
 * cannot be compared with each other.
 */
export const EMBEDDINGGEMMA2_DIMENSIONS: readonly number[] = [768, 512, 256, 128]

/**
 * Whether a stated dimensionality is one EmbeddingGemma 2 can produce (MODEL-01).
 * @param dimensions - the stated width.
 * @returns whether it is a documented width.
 */
export function isEmbeddingGemma2Width(dimensions: number): boolean {
  return EMBEDDINGGEMMA2_DIMENSIONS.includes(dimensions)
}
