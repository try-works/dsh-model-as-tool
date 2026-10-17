/**
 * The EmbeddingGemma 2 extension (MOD-01..MOD-20).
 *
 * This is an INDEPENDENT track. It shares no adapter, no runtime and no code with the Desert
 * Ant packages or with any other model package: EmbeddingGemma 2 supplies embeddings, and this
 * extension owns the contracts that expose them (EXT-21). Like every first-party package it
 * imports ONLY `@try-works/tool-mode-extension-sdk` (EXT-02) plus its own optional runtime
 * dependencies at call time, so a third-party package has exactly the same access it does.
 *
 * WHAT THIS BUILD IS, AND IS NOT. It declares the model deployment with its three separately
 * loadable asset groups (MOD-02), declares the three tool contracts it owns, implements the
 * deterministic vector operations those tools rest on (`./vectors.ts`), and validates a call's
 * arguments against the rules MOD-05 and MOD-06 state. It creates NO ONNX session, downloads
 * nothing, and computes no embedding: the inference path is the next slice. The provider
 * therefore reports `unprepared` with the reasons, and an invocation fails with the reason it
 * cannot run — it never reports a load it did not perform and never invents a vector.
 *
 * A deterministic arithmetic test passing is not evidence about the model. MOD-16 (pinned
 * golden fixtures), MOD-17 (real cross-modal retrieval), MOD-19 (measurements from the built
 * package on Windows CPU) all require the artifact that this build does not yet run.
 *
 * @module @try-works/extension-embeddinggemma
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

import {
  admitsRole,
  CALL_LIMITS,
  contractForImplementation,
  EMBEDDING_PURPOSES,
  EMBEDDING_ROLES,
  OWNED_TOOL_CONTRACTS,
  PART_KINDS,
  SUPPORTED_PART_KINDS,
  type EmbeddingPurpose,
  type EmbeddingRole,
  type OwnedToolContract,
} from './contracts.ts'
import { DEFAULT_EMBEDDING_DIMENSIONS, EMBEDDINGGEMMA2_DIMENSIONS, isEmbeddingGemma2Width } from './vectors.ts'
import { classifySelection, cosineSimilarity, deduplicateGroups, planMomentsWindows, rankBySimilarity, reduceDimensions } from './vectors.ts'
import {
  createAudioEncoder,
  createTextEmbedder,
  createVideoEncoder,
  createVisionEncoder,
  MODALITY_FEATURE_DIM,
  patchifyVideoFrame,
  videoGridFor,
  VIDEO_PREPROCESSING,
  VIDEO_SOFT_TOKEN,
  type AudioEncoder,
  type TextEmbedder,
  type VideoEncoder,
  type VisionEncoder,
} from './inference.ts'
import {
  AUDIO_PREPROCESSING,
  bicubicResizeChw,
  decodeImage,
  decodeVideoFrameToPixels,
  decodeWav,
  MEDIA_LIMITS,
  melSpectrogram,
  sampleVideoFrames,
  type ParsedVideo,
  IMAGE_PREPROCESSING,
} from './media.ts'

/** The model deployment this extension implements. */
const MODEL_ID = 'embeddinggemma-2'

/** The asset id the host prepares for text-only inference (MOD-02). */
const TEXT_BACKBONE_ASSET = 'text-backbone'

/** The asset id the host prepares for the vision group (MOD-02). */
const VISION_ENCODER_ASSET = 'vision-encoder'

/** The asset id the host prepares for the audio group (MOD-02). */
const AUDIO_ENCODER_ASSET = 'audio-encoder'

/**
 * The placeholder token STRINGS the shipped tokenizer maps to the pinned soft
 * tokens (tokenizer.json added tokens, config.json ids):
 *
 *   '<|image>'  = boi_token_id 255999        '<|audio>'  = boa_token_id 256000
 *   '<|image|>' = image_token_id 258880      '<|audio|>' = audio_token_id 258881
 *   '<image|>'  = eoi_token_id 258882        '<audio|>'  = eoa_token_id 258883
 *
 * One media part occupies one delimited block of soft tokens in the prompt —
 * `vision_soft_tokens_per_image` / `audio_seq_length` repetitions — and the
 * encoder feature rows correspond, in order, to those block positions. This is
 * the reconstruction the qualification record pins: it is falsifiable by the
 * cross-modal shared-space sanity assertions, which would fail if the rows and
 * the soft-token positions disagreed.
 */
const IMAGE_BEGIN = '<|image>'
const IMAGE_SOFT = '<|image|>'
const IMAGE_END = '<image|>'
const AUDIO_BEGIN = '<|audio>'
const AUDIO_SOFT = '<|audio|>'
const AUDIO_END = '<audio|>'

/**
 * The canonical embedding-space identity (MOD-03), computed from CONTENT: the pinned
 * backbone's revision and its weights digest, not from the mutable model name.
 */
const TEXT_BACKBONE_SPACE_ID = 'embeddinggemma-2/text/daa72c512439-9fd452bfc691'

/** The ONNX client library the qualified route is specified to use (MOD-01). */
const TRANSFORMERS_PACKAGE = '@huggingface/transformers'

/** The native CPU execution provider. `onnxruntime-node` ships prebuilt win32-x64 binaries. */
const ORT_PACKAGE = 'onnxruntime-node'

/**
 * The asset groups MOD-02 requires to load SEPARATELY.
 *
 * A text-only call must not fetch or load the vision or audio weights, so the groups are named
 * here as the deployment's loading boundaries rather than as one opaque bundle. The host
 * prepares whichever groups it has verified, and `load()` refuses a deployment where the group
 * a call needs is absent instead of silently running without it.
 *
 * Exported so the package's own test can assert that this list and the asset lock's groups are
 * the same three, rather than trusting two hand-maintained lists to stay equal.
 */
export const ASSET_GROUPS = ['text-backbone', 'vision-encoder', 'audio-encoder'] as const

/**
 * Why an invocation cannot run, once the extension's real text path exists.
 *
 * The ONNX session and the tokenizer are wired (see ./inference.ts); what remains for a
 * call to be impossible is a deployment that did not prepare the text backbone or
 * resolve the runtime packages — the honest states that are refused by NAME here.
 */
const NOT_PREPARED =
  'the EmbeddingGemma 2 deployment is not prepared: load() must be called with the verified "text-backbone" '
  + 'asset group before any embedding is computed'

/** Throw if the signal has been aborted. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('the invocation was aborted')
  }
}

/** Narrow a value to one of a closed set, without a cast. */
function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

/**
 * The runtime packages this deployment needs that do not resolve on this host.
 *
 * Resolution is a READ. It reports what is missing without installing, downloading or loading
 * anything, which is what EXT-18 permits inspection to do and all it may do.
 * @returns one entry per missing specifier.
 */
function runtimeGaps(): { name: string; reason: string }[] {
  const missing: { name: string; reason: string }[] = []
  for (const specifier of [TRANSFORMERS_PACKAGE, ORT_PACKAGE]) {
    try {
      const resolved = import.meta.resolve?.(specifier)
      if (typeof resolved !== 'string') throw new Error('unresolved')
    } catch {
      missing.push({ name: specifier, reason: `install ${specifier} to enable this deployment` })
    }
  }
  return missing
}

/** Read a non-empty bounded string field. */
function requireString(
  object: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  maxLength: number,
): string {
  const value = object[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${where}: "${key}" must be a non-empty string`)
  }
  if (value.length > maxLength) {
    throw new Error(
      `${where}: "${key}" is ${value.length} characters, over the ${maxLength}-character limit; an over-context input `
      + 'is refused rather than shortened (MOD-08)',
    )
  }
  return value
}

/** Read a field that must be an object. */
function requireObject(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

/**
 * Validate one part, and refuse a modality this build does not read (MOD-07, MOD-20).
 *
 * A media part is validated STRUCTURALLY (bounded path, an optional audio range whose end
 * exceeds its start) and its decoding happens later, in the bounded Node decoders; a VIDEO
 * part is refused by NAME because its frame sampling is the recorded third slice. Ignoring a
 * media part and embedding the remaining parts would return a plausible vector for an input
 * the caller did not send, which is worse than an error: the caller has no way to notice.
 * @param value - the candidate part.
 * @param where - a path for the error message.
 */
function requirePart(value: unknown, where: string): void {
  const part = requireObject(value, where)
  const kind: unknown = part.kind
  if (!isOneOf(kind, PART_KINDS)) {
    throw new Error(`${where}: "kind" must be one of ${PART_KINDS.join(', ')}`)
  }
  if (kind === 'video') {
    // The fused VIDEO path is reconstructed (H4): the bounded sampler, the
    // per-frame video grid and the fused video_features scatter. Validate the
    // part shape here; the sampling bounds are enforced in the assemble path.
    const path: unknown = part.path
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error(`${where}: a "video" part requires a non-empty "path" (MOD-07)`)
    }
    const range: unknown = part.range
    if (range !== undefined && range !== null && (typeof range !== 'object'
      || typeof (range as { startSeconds?: unknown }).startSeconds !== 'number'
      || typeof (range as { endSeconds?: unknown }).endSeconds !== 'number')) {
      throw new Error(`${where}: a "video" part's "range" must name startSeconds and endSeconds (MOD-18)`)
    }
    const sampling: unknown = part.sampling
    if (sampling !== undefined && sampling !== null) {
      const mode = (sampling as { mode?: unknown }).mode
      const maxFrames = (sampling as { maxFrames?: unknown }).maxFrames
      if (mode !== 'uniform' || typeof maxFrames !== 'number' || !Number.isInteger(maxFrames)
        || maxFrames < 1 || maxFrames > VIDEO_PREPROCESSING.maxFrames) {
        throw new Error(
          `${where}: a "video" part's "sampling" must be { mode: "uniform", maxFrames: 1..${VIDEO_PREPROCESSING.maxFrames} } (MOD-08)`,
        )
      }
    }
    return
  }
  if (!isOneOf(kind, SUPPORTED_PART_KINDS)) {
    throw new Error(`${where}: this build reads ${SUPPORTED_PART_KINDS.join(', ')} parts only`)
  }
  if (kind === 'text' || kind === 'code') {
    requireString(part, 'text', where, CALL_LIMITS.maxTextCharacters)
    if (part.language !== undefined) requireString(part, 'language', where, 64)
    return
  }
  // Image and audio parts carry a host-authorized path; the extension never
  // fetches, and the decoders read ONLY that local file (SEC-06).
  requireString(part, 'path', where, 4096)
  if (kind === 'audio' && part.range !== undefined) {
    const range = requireObject(part.range, `${where} range`)
    const start = range.startSeconds
    const end = range.endSeconds
    if (typeof start !== 'number' || typeof end !== 'number' || start < 0 || end <= start) {
      throw new Error(`${where}: the audio range must have endSeconds > startSeconds >= 0; an inverted or empty window is refused (MOD-18)`)
    }
  }
}

/**
 * Validate one multimodal item and return its id (MOD-05, MOD-06).
 * @param value - the candidate item.
 * @param where - a path for the error message.
 * @returns the item's id.
 */
function requireItem(value: unknown, where: string): string {
  const item = requireObject(value, where)
  const id = requireString(item, 'id', where, CALL_LIMITS.maxIdCharacters)
  const parts: unknown = item.parts
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error(`${where}: "parts" must be a non-empty array; an item with no parts has nothing to embed`)
  }
  if (parts.length > CALL_LIMITS.maxPartsPerItem) {
    throw new Error(
      `${where}: "parts" carries ${parts.length} entries, over the ${CALL_LIMITS.maxPartsPerItem}-part limit for one item`,
    )
  }
  for (const [index, part] of parts.entries()) requirePart(part, `${where} part ${index}`)
  if (item.title !== undefined) requireString(item, 'title', where, CALL_LIMITS.maxTitleCharacters)
  return id
}

/**
 * Reject a repeated id inside one list (MOD-05).
 *
 * Ids are how a caller matches a result back to its input, so a duplicate does not make the
 * answer merely untidy — it makes two different results indistinguishable. Ids in two NAMED
 * positions (a similarity call's `left` and `right`) are not compared, because position
 * identifies those and comparing an item with itself is a legitimate call.
 * @param ids - the ids, in input order.
 * @param where - a label for the error message.
 */
function assertUniqueIds(ids: readonly string[], where: string): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(
        `${where}: duplicate item id ${JSON.stringify(id)}; ids are how results are matched back to inputs, so a `
        + 'duplicate makes the answer ambiguous (MOD-05)',
      )
    }
    seen.add(id)
  }
}

/**
 * Read the requested width (MOD-01, MOD-04).
 *
 * A width the model does not produce is refused rather than rounded to the nearest one,
 * because rounding would silently return vectors from a different embedding space than the
 * caller asked for — and a stored 384-dimensional index must never be quietly fed 768-wide
 * vectors (BASE-12).
 * @param input - the validated arguments.
 * @returns the requested width, defaulting to 768.
 */
function requireDimensions(input: Readonly<JsonObject>): number {
  const value = input.dimensions
  if (value === undefined || value === null) return DEFAULT_EMBEDDING_DIMENSIONS
  if (typeof value !== 'number' || !isEmbeddingGemma2Width(value)) {
    throw new Error(
      `"dimensions" must be one of ${EMBEDDINGGEMMA2_DIMENSIONS.join(', ')}; EmbeddingGemma 2 produces no other `
      + 'width, and a reduced width is a different embedding space (MOD-01, MOD-04)',
    )
  }
  return value
}

/**
 * Read and check the purpose/role pair (MOD-05, MOD-06).
 *
 * The schema shipped with the contract carries the same rule as an `if`/`then` constraint. It
 * is repeated here because the schema protects the host's validated path while this protects
 * the implementation, which can be reached by another route.
 * @param input - the validated arguments.
 * @returns the checked pair.
 */
function requirePurposeRole(input: Readonly<JsonObject>): { purpose: EmbeddingPurpose; role: EmbeddingRole } {
  const purpose: unknown = input.purpose
  const role: unknown = input.role
  if (!isOneOf(purpose, EMBEDDING_PURPOSES)) {
    throw new Error(`"purpose" must be one of ${EMBEDDING_PURPOSES.join(', ')} (MOD-06)`)
  }
  if (!isOneOf(role, EMBEDDING_ROLES)) {
    throw new Error(`"role" must be one of ${EMBEDDING_ROLES.join(', ')} (MOD-05)`)
  }
  if (!admitsRole(purpose, role)) {
    throw new Error(
      `the role ${JSON.stringify(role)} is not admitted for the purpose ${JSON.stringify(purpose)}: retrieval and `
      + 'code_retrieval admit query or document, and the symmetric purposes require symmetric (MOD-05)',
    )
  }
  return { purpose, role }
}

/** Validate a `multimodal_embed` call (MOD-05, MOD-06, MOD-08). */
function validateEmbedInput(input: Readonly<JsonObject>): void {
  const items: unknown = input.items
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('"items" must be a non-empty array')
  }
  if (items.length > CALL_LIMITS.maxItems) {
    throw new Error(
      `"items" carries ${items.length} entries, over the ${CALL_LIMITS.maxItems}-item limit for one call (MOD-08)`,
    )
  }
  assertUniqueIds(items.map((item, index) => requireItem(item, `items[${index}]`)), 'items')
  requirePurposeRole(input)
  requireDimensions(input)
}

/** Validate a `semantic_similarity` call (MOD-09). */
function validateSimilarityInput(input: Readonly<JsonObject>): void {
  requireItem(input.left, 'left')
  requireItem(input.right, 'right')
  // No purpose or role: MOD-09 fixes the symmetric similarity recipe for this tool, so a
  // caller-supplied one would be a way to request an unqualified pairing through a tool that
  // cannot honour it.
  requireDimensions(input)
}

/** Validate a `semantic_rank` call (MOD-10). */
function validateRankInput(input: Readonly<JsonObject>): void {
  requireItem(input.query, 'query')
  const candidates: unknown = input.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('"candidates" must be a non-empty array')
  }
  if (candidates.length > CALL_LIMITS.maxCandidates) {
    throw new Error(
      `"candidates" carries ${candidates.length} entries, over the ${CALL_LIMITS.maxCandidates}-candidate limit for `
      + 'one call (MOD-10)',
    )
  }
  assertUniqueIds(
    candidates.map((candidate, index) => requireItem(candidate, `candidates[${index}]`)),
    'candidates',
  )
  const topK: unknown = input.top_k
  if (topK !== undefined && topK !== null) {
    if (typeof topK !== 'number' || !Number.isInteger(topK) || topK <= 0) {
      throw new Error(`"top_k" must be a positive integer; received ${JSON.stringify(topK)} (MOD-10)`)
    }
    if (topK > candidates.length) {
      throw new Error(
        `"top_k" ${topK} exceeds the ${candidates.length} candidate(s) supplied; returning fewer rows would be `
        + 'indistinguishable from having ranked fewer candidates (MOD-10)',
      )
    }
  }
  requireDimensions(input)
}

/** Validate a `semantic_classify` call (MOD-11). */
function validateClassifyInput(input: Readonly<JsonObject>): void {
  requireItem(input.item, 'item')
  const labels: unknown = input.labels
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new Error('"labels" must be a non-empty array')
  }
  if (labels.length > CALL_LIMITS.maxClassifyLabels) {
    throw new Error(
      `"labels" carries ${labels.length} entries, over the ${CALL_LIMITS.maxClassifyLabels}-label limit for one call (MOD-08)`,
    )
  }
  const ids = new Set<string>()
  for (const [index, rawLabel] of labels.entries()) {
    const label = rawLabel as Readonly<JsonObject> | undefined
    const id = typeof label?.id === 'string' ? label.id : ''
    const description = typeof label?.description === 'string' ? label.description : ''
    if (id.length === 0) throw new Error(`labels[${index}]: "id" must be a non-empty string`)
    if (description.length === 0) throw new Error(`labels[${index}]: "description" must be a non-empty string`)
    if (ids.has(id)) throw new Error(`labels[${index}]: duplicate label id ${JSON.stringify(id)}`)
    ids.add(id)
  }
  for (const field of ['min_score', 'min_margin']) {
    const value = input[field]
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error(`"${field}" must be a finite number when present (MOD-11)`)
    }
  }
  requireDimensions(input)
}

/** Validate a `semantic_deduplicate` call (MOD-12). */
function validateDeduplicateInput(input: Readonly<JsonObject>): void {
  const items: unknown = input.items
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('"items" must be a non-empty array')
  }
  if (items.length > CALL_LIMITS.maxDedupItems) {
    throw new Error(
      `"items" carries ${items.length} entries, over the ${CALL_LIMITS.maxDedupItems}-item limit for one call (MOD-08)`,
    )
  }
  assertUniqueIds(items.map((item, index) => requireItem(item, `items[${index}]`)), 'items')
  const threshold: unknown = input.threshold
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= -1 || threshold >= 1) {
    throw new Error('"threshold" must be a finite number in the open interval (-1, 1) (MOD-12)')
  }
  requireDimensions(input)
}

/** Validate a `media_find_moments` call (MOD-13). */
function validateMomentsInput(input: Readonly<JsonObject>): void {
  requireItem(input.query, 'query')
  const media = input.media as Readonly<JsonObject> | undefined
  const kind = typeof media?.kind === 'string' ? media.kind : ''
  if (kind !== 'audio' && kind !== 'video') {
    throw new Error('"media.kind" must be "audio" or "video" (MOD-13)')
  }
  const path = typeof media?.path === 'string' ? media.path : ''
  if (path.length === 0) throw new Error('"media.path" must be a non-empty string (MOD-13)')
  if (kind === 'audio' && input.sampling !== undefined && input.sampling !== null) {
    throw new Error('"sampling" is a video-only field; an audio item must not supply it (MOD-13)')
  }
  const windowSeconds: unknown = input.windowSeconds
  const strideSeconds: unknown = input.strideSeconds
  if (typeof windowSeconds !== 'number' || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new Error('"windowSeconds" must be a positive finite number (MOD-13)')
  }
  if (typeof strideSeconds !== 'number' || !Number.isFinite(strideSeconds) || strideSeconds <= 0) {
    throw new Error('"strideSeconds" must be a positive finite number (MOD-13)')
  }
  if (windowSeconds > MEDIA_LIMITS.maxAudioSeconds) {
    throw new Error(`"windowSeconds" ${windowSeconds} exceeds the ${MEDIA_LIMITS.maxAudioSeconds} s model window (MOD-08)`)
  }
  const topK: unknown = input.top_k
  if (topK !== undefined && topK !== null && (typeof topK !== 'number' || !Number.isInteger(topK) || topK <= 0)) {
    throw new Error('"top_k" must be a positive integer when present (MOD-13)')
  }
  requireDimensions(input)
}
interface Service {
  readonly contract: OwnedToolContract
  readonly validate: (input: Readonly<JsonObject>) => void
}

/** The argument validators, keyed by implementation id. */
const ARGUMENT_VALIDATORS: Readonly<Record<string, (input: Readonly<JsonObject>) => void>> = {
  'embeddinggemma2-onnx': validateEmbedInput,
  'embeddinggemma2-similarity': validateSimilarityInput,
  'embeddinggemma2-rank': validateRankInput,
  'embeddinggemma2-classify': validateClassifyInput,
  'embeddinggemma2-deduplicate': validateDeduplicateInput,
  'embeddinggemma2-moments': validateMomentsInput,
}

/**
 * Resolve the service one implementation id names.
 *
 * A contract without a validator is treated as unimplementable rather than as "no validation
 * needed": every implementation this package ships validates its arguments, and a build that
 * forgot to would otherwise run on unchecked input.
 * @param implementationId - the implementation the host selected.
 * @returns the contract and its validator.
 * @throws Error when this package does not serve that implementation.
 */
function serviceFor(implementationId: string): Service {
  const contract = contractForImplementation(implementationId)
  const validate = contract === undefined ? undefined : ARGUMENT_VALIDATORS[contract.implementationId]
  if (contract === undefined || validate === undefined) {
    throw new Error(
      `this extension implements ${OWNED_TOOL_CONTRACTS.map(entry => `"${entry.implementationId}"`).join(', ')}, `
      + `not ${JSON.stringify(implementationId)}`,
    )
  }
  return { contract, validate }
}

/** One assembled item: the fused prompt plus the modality feature rows in soft-token order. */
interface AssembledItem {
  readonly prompt: string
  readonly imageRows: Float32Array
  readonly audioRows: Float32Array
  readonly videoRows: Float32Array
  readonly processing: Record<string, unknown>
}

/** The per-group encoders a media part needs; an absent group is refused by NAME. */
interface MediaEngines {
  vision(): Promise<VisionEncoder>
  audio(): Promise<AudioEncoder>
  video(): Promise<VideoEncoder>
}

/** Concatenate feature-row chunks in part order. */
function concatRows(chunks: readonly Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Embed raw 16 kHz mono samples as one AUDIO item through the fused model
 * (MOD-13's window path).
 *
 * The same pipeline assembleItem's audio branch uses — bounded decoder output →
 * mel → the audio encoder → the variable-length audio soft-token block → the
 * fused run → the requested reduction — without going through a file path, so a
 * WINDOW slice of an already-decoded source can be embedded directly.
 */
async function embedAudioSamples(
  engine: TextEmbedder,
  encoder: AudioEncoder,
  samples: Float32Array,
  dimensions: number,
  signal: AbortSignal,
): Promise<readonly number[]> {
  throwIfAborted(signal)
  const mel = melSpectrogram(samples)
  const rows = await encoder.encode(mel, mel.length / AUDIO_PREPROCESSING.melBins, AUDIO_PREPROCESSING.melBins)
  const audioRows = rows.length / MODALITY_FEATURE_DIM
  const prompt = AUDIO_BEGIN + AUDIO_SOFT.repeat(audioRows) + AUDIO_END
  const { ids } = await engine.tokenize(prompt)
  const embedded = await engine.runFused(ids, new Float32Array(0), rows, new Float32Array(0))
  return reduceDimensions(Array.from(embedded), dimensions)
}

/**
 * Assemble one item into the fused prompt and the modality feature rows.
 *
 * The prompt interleaves the title, the text/code parts, and one delimited soft-token block
 * per media part — in the caller's part ORDER, which MOD-06 declares significant — and the
 * encoder feature rows are collected in the same order, so row k of `imageRows` corresponds
 * to the k-th image soft token in the prompt. Every decoding measurement the processing
 * record owes (audio source rates, ranges actually used) is captured HERE, from what the
 * decoders did, never guessed from the request.
 * @param item - the validated item.
 * @param engines - the prepared per-group encoders.
 * @param signal - the caller's cancellation.
 * @returns the assembled prompt, feature rows and the honest processing record.
 */
async function assembleItem(
  item: Readonly<Record<string, unknown>>,
  engines: MediaEngines,
  signal: AbortSignal,
): Promise<AssembledItem> {
  const title: unknown = item.title
  const parts = item.parts as readonly Readonly<Record<string, unknown>>[]
  const promptParts: string[] = []
  if (typeof title === 'string' && title.length > 0) promptParts.push(title)
  const imageChunks: Float32Array[] = []
  const audioChunks: Float32Array[] = []
  const videoChunks: Float32Array[] = []
  const sourceRanges: { partIndex: number; range: { startSeconds: number; endSeconds: number } }[] = []
  const audioRates: { partIndex: number; sourceHz: number; modelHz: number }[] = []
  const videoTimestamps: number[] = []
  for (const [index, part] of parts.entries()) {
    throwIfAborted(signal)
    const kind = String(part.kind)
    if (kind === 'text' || kind === 'code') {
      promptParts.push(String(part.text))
      continue
    }
    if (kind === 'image') {
      const encoder = await engines.vision()
      const image = await decodeImage(String(part.path))
      const rows = await encoder.encode(image.pixels)
      promptParts.push(IMAGE_BEGIN + IMAGE_SOFT.repeat(IMAGE_PREPROCESSING.softTokensPerImage) + IMAGE_END)
      imageChunks.push(rows)
      continue
    }
    if (kind === 'audio') {
      const encoder = await engines.audio()
      const range = part.range as { startSeconds: number; endSeconds: number } | undefined
      const audio = await decodeWav(String(part.path), range)
      const mel = melSpectrogram(audio.samples)
      const rows = await encoder.encode(mel, mel.length / AUDIO_PREPROCESSING.melBins, AUDIO_PREPROCESSING.melBins)
      /**
       * THE AUDIO BLOCK IS VARIABLE-LENGTH, and a fixed repeat was wrong. The
       * encoder subsamples the mel frames to roughly one feature row per four
       * frames (measured: 119 frames -> 30 rows), while the fused model gathers
       * exactly one feature row per audio soft token — so the prompt must repeat
       * the soft token once per ROW the encoder actually produced, never the
       * fixed 280-token maximum. The previous fixed repeat placed 280 tokens for
       * 30 rows and the gather fell off the end (idx out of bounds) on every
       * real audio call.
       */
      const audioRows = rows.length / MODALITY_FEATURE_DIM
      promptParts.push(AUDIO_BEGIN + AUDIO_SOFT.repeat(audioRows) + AUDIO_END)
      audioChunks.push(rows)
      sourceRanges.push({
        partIndex: index,
        range: {
          startSeconds: range?.startSeconds ?? 0,
          endSeconds: range?.endSeconds ?? audio.seconds,
        },
      })
      audioRates.push({ partIndex: index, sourceHz: audio.sourceRate, modelHz: AUDIO_PREPROCESSING.samplingRate })
      continue
    }
    if (kind === 'video') {
      /**
       * THE FUSED VIDEO PATH (H4), faithful to the pinned transformers
       * EmbeddingGemma2VideoProcessor the conversion was exported from:
       * bounded AVI/DIB sampling (1 fps, 32-frame cap) → per-frame BGR24 →
       * CHW float with the pinned 1/255 rescale → the aspect-ratio-preserving
       * resize to the 140-token (1260-patch) video grid → patchify with the
       * [col,row] axial positions and -1 padding → the SAME vision-encoder
       * graph per frame (1260 rows each) → the fused model's video_features.
       * The prompt block repeats the single video soft token once per REAL
       * per-frame soft token (nPatches // 9) — the padded rows are masked by
       * their -1 positions inside the graph, never by prompt omission.
       */
      const encoder = await engines.video()
      const video = await sampleVideoFrames(String(part.path))
      const frames = video.samples
      const partsBlocks: string[] = []
      for (const frame of frames) {
        throwIfAborted(signal)
        const pixels = decodeVideoFrameToPixels(frame.bytes, video.width, video.height)
        const grid = videoGridFor(video.height, video.width)
        const resized = bicubicResizeChw(pixels, video.height, video.width, grid.height, grid.width)
        const prepared = patchifyVideoFrame(resized, grid.height, grid.width)
        const rows = await encoder.encode(prepared)
        const softTokens = prepared.realPatches / VIDEO_PREPROCESSING.pooling ** 2
        partsBlocks.push(VIDEO_SOFT_TOKEN.repeat(softTokens))
        videoChunks.push(rows)
        videoTimestamps.push(frame.timestampSeconds)
      }
      promptParts.push(partsBlocks.join(''))
      sourceRanges.push({
        partIndex: index,
        range: {
          startSeconds: video.sampleTimestamps[0] ?? 0,
          endSeconds: (video.sampleTimestamps[video.sampleTimestamps.length - 1] ?? 0) + 1,
        },
      })
      continue
    }
    // Unreachable: part kinds are validated before assembly.
    throw new Error(`"${kind}" parts are not assembled by this build`)
  }
  return {
    prompt: promptParts.join(' '),
    imageRows: concatRows(imageChunks),
    audioRows: concatRows(audioChunks),
    videoRows: concatRows(videoChunks),
    processing: {
      id: item.id,
      modalities: parts.map(part => part.kind),
      sourceRanges,
      sampledVideoFrames: videoTimestamps,
      observedAudioSampleRates: audioRates,
      truncated: false,
    },
  }
}

/** The vector record, in the contract's `vector` shape (MOD-03, MOD-04). */
function vectorRecord(
  id: string,
  values: readonly number[],
  dimensions: number,
  purpose: EmbeddingPurpose,
  role: EmbeddingRole,
): Record<string, unknown> {
  return {
    id,
    values: [...values],
    dimensions,
    normalized: true,
    embeddingSpaceId: TEXT_BACKBONE_SPACE_ID,
    purpose,
    role,
  }
}

/**
 * Embed one item — text and/or media — and reduce it to the requested width (MOD-04).
 * @param engine - the loaded text backbone.
 * @param item - the validated item.
 * @param engines - the per-group encoders.
 * @param dimensions - the requested width.
 * @param signal - the caller's cancellation.
 * @returns the reduced vector and the honest processing record.
 */
async function embedItem(
  engine: TextEmbedder,
  item: Readonly<Record<string, unknown>>,
  engines: MediaEngines,
  dimensions: number,
  signal: AbortSignal,
): Promise<{ values: readonly number[]; processing: Record<string, unknown> }> {
  const assembled = await assembleItem(item, engines, signal)
  throwIfAborted(signal)
  const { ids } = await engine.tokenize(assembled.prompt)
  const embedded = await engine.runFused(ids, assembled.imageRows, assembled.audioRows, assembled.videoRows)
  // The model's sentence_embedding is already unit-norm; the reduction renormalizes
  // after the leading-dimension truncation, exactly as MOD-04 specifies.
  return { values: reduceDimensions(Array.from(embedded), dimensions), processing: assembled.processing }
}

/**
 * Embed ONE video window (MOD-13): the window's 1 fps samples run through the
 * SAME fused video pipeline as a whole-video part — per-frame video grid →
 * vision encoder → the fused model's video_features — and the window's vector
 * is the fused sentence embedding of the video-only prompt block. Never
 * synthesized over image-grid rows.
 */
async function embedVideoWindow(
  engine: TextEmbedder,
  encoder: VideoEncoder,
  video: ParsedVideo,
  dimensions: number,
  signal: AbortSignal,
): Promise<{ values: readonly number[]; timestamps: readonly number[] }> {
  const blocks: string[] = []
  const videoRows: Float32Array[] = []
  const timestamps: number[] = []
  for (const frame of video.samples) {
    throwIfAborted(signal)
    const pixels = decodeVideoFrameToPixels(frame.bytes, video.width, video.height)
    const grid = videoGridFor(video.height, video.width)
    const resized = bicubicResizeChw(pixels, video.height, video.width, grid.height, grid.width)
    const prepared = patchifyVideoFrame(resized, grid.height, grid.width)
    const rows = await encoder.encode(prepared)
    const softTokens = prepared.realPatches / VIDEO_PREPROCESSING.pooling ** 2
    blocks.push(VIDEO_SOFT_TOKEN.repeat(softTokens))
    videoRows.push(rows)
    timestamps.push(frame.timestampSeconds)
  }
  const prompt = blocks.join('')
  const { ids } = await engine.tokenize(prompt)
  const embedded = await engine.runFused(ids, new Float32Array(0), new Float32Array(0), concatRows(videoRows))
  return { values: reduceDimensions(Array.from(embedded), dimensions), timestamps }
}

/** Build the provider for the EmbeddingGemma 2 deployment. */
function createEmbeddingGemmaProvider(context: ExtensionContextV1): ModelProviderV1 {
  let disposed = false
  let embedderPromise: Promise<TextEmbedder> | undefined
  let visionPromise: Promise<VisionEncoder> | undefined
  let audioPromise: Promise<AudioEncoder> | undefined
  let videoPromise: Promise<VideoEncoder> | undefined

  const ensureEngine = async (): Promise<TextEmbedder> => {
    if (disposed) throw new Error('the provider has been disposed')
    if (embedderPromise === undefined) throw new Error(NOT_PREPARED)
    return await embedderPromise
  }

  const engines: MediaEngines = {
    async vision() {
      if (disposed) throw new Error('the provider has been disposed')
      if (visionPromise === undefined) {
        throw new Error(
          `the "${VISION_ENCODER_ASSET}" asset group was not prepared, so an image part cannot be embedded (MOD-02). `
          + 'The deployment prepares the groups it has verified; an image call never touches the text-only group',
        )
      }
      return await visionPromise
    },
    async audio() {
      if (disposed) throw new Error('the provider has been disposed')
      if (audioPromise === undefined) {
        throw new Error(
          `the "${AUDIO_ENCODER_ASSET}" asset group was not prepared, so an audio part cannot be embedded (MOD-02). `
          + 'The deployment prepares the groups it has verified; an audio call never touches the text-only group',
        )
      }
      return await audioPromise
    },
    async video() {
      // The fused VIDEO path rides on the VISION group (MOD-02: a video call
      // fetches text + vision only, never audio) — the same exported
      // vision-encoder graph serves the per-frame video grid.
      if (disposed) throw new Error('the provider has been disposed')
      if (videoPromise === undefined) {
        throw new Error(
          `the "${VISION_ENCODER_ASSET}" asset group was not prepared, so a video part cannot be embedded (MOD-02). `
          + 'A video call uses the vision encoder group; the audio group is never touched',
        )
      }
      return await videoPromise
    },
  }

  return {
    async inspect(signal): Promise<ProviderInspectionV1> {
      throwIfAborted(signal)
      /**
       * EXT-18: inspection reads approved local state only and reports what the build can
       * ACTUALLY run. With the text path wired and the media groups implemented, the honest
       * states are:
       *
       * - the runtime packages resolve but nothing has loaded yet: `prepared-cold` — the
       *   sessions are created on the first `load()` with the host-verified assets;
       * - a package does not resolve: `needs-preparation` naming exactly which one.
       *
       * Asset state is NOT read here. The host supplies verified assets to `load()` and
       * nowhere else, so inspection must not guess whether preparation has happened.
       */
      const gaps = runtimeGaps()
      if (gaps.length > 0) {
        return {
          readiness: 'needs-preparation',
          features: [],
          missing: gaps,
          reason: `needs preparation: ${gaps.map(gap => gap.name).join(', ')} must resolve on this host`,
        }
      }
      return {
        readiness: embedderPromise === undefined ? 'prepared-cold' : 'ready',
        features: ['text-embeddings', 'image-embeddings', 'audio-embeddings', 'video-embeddings', 'semantic-similarity', 'semantic-ranking'],
        missing: [],
        ...embedderPromise === undefined
          ? { reason: 'the model is prepared but cold; it loads on first use with the host-verified asset groups' }
          : {},
      }
    },

    async load(request: { readonly assets: Readonly<PreparedAssetMapV1>; readonly signal: AbortSignal }) {
      throwIfAborted(request.signal)
      // The host acquires and verifies the pinned bytes and hands over LOCAL paths; the
      // extension fetches nothing itself, which is why the manifest declares no network origin
      // for it while the deployment's own preparation does use the network once.
      const gaps = runtimeGaps()
      const backbone = request.assets.get(TEXT_BACKBONE_ASSET)
      if (gaps.length > 0 || backbone === undefined) {
        const problems = [
          ...gaps.map(gap => `${gap.name} does not resolve on this host`),
          ...backbone === undefined ? [`the "${TEXT_BACKBONE_ASSET}" asset group was not prepared`] : [],
        ]
        throw new Error(
          `EmbeddingGemma 2 is not prepared: ${problems.join('; ')}. The deployment reports needs-preparation rather `
          + 'than loading a partial route (MOD-02)',
        )
      }
      /**
       * MOD-02: each GROUP loads only from its own verified directory. The text backbone is
       * required for every call; the vision and audio encoders are created only when their
       * groups were prepared, and a call never reads a group it does not use — a text-only
       * call creates no media session at all.
       */
      embedderPromise ??= createTextEmbedder(backbone.path)
      const vision = request.assets.get(VISION_ENCODER_ASSET)
      if (vision !== undefined) {
        visionPromise ??= createVisionEncoder(vision.path)
        // The video path rides the SAME vision group (MOD-02): one group
        // directory, two pinned grids through the one exported encoder graph.
        videoPromise ??= createVideoEncoder(vision.path)
      }
      const audio = request.assets.get(AUDIO_ENCODER_ASSET)
      if (audio !== undefined) audioPromise ??= createAudioEncoder(audio.path)
      await embedderPromise
    },

    async invoke({ implementationId, input, context: invocation }): Promise<JsonObject> {
      throwIfAborted(invocation.signal)
      if (disposed) throw new Error('the provider has been disposed')
      // Validation runs BEFORE any model work, so a malformed call fails for its own reason
      // rather than being reported later as an unavailable model.
      const service = serviceFor(implementationId)
      service.validate(input)
      const engine = await ensureEngine()
      throwIfAborted(invocation.signal)
      const dimensions = requireDimensions(input)

      if (service.contract.toolName === 'multimodal_embed') {
        const { purpose, role } = requirePurposeRole(input)
        const items = input.items as readonly Readonly<Record<string, unknown>>[]
        const vectors: Record<string, unknown>[] = []
        const processing: Record<string, unknown>[] = []
        for (const item of items) {
          throwIfAborted(invocation.signal)
          const embedded = await embedItem(engine, item, engines, dimensions, invocation.signal)
          vectors.push(vectorRecord(String(item.id), embedded.values, dimensions, purpose, role))
          processing.push(embedded.processing)
        }
        return { vectors, processing } as unknown as JsonObject
      }

      if (service.contract.toolName === 'semantic_similarity') {
        const left = input.left as Readonly<Record<string, unknown>>
        const right = input.right as Readonly<Record<string, unknown>>
        const leftEmbedded = await embedItem(engine, left, engines, dimensions, invocation.signal)
        const rightEmbedded = await embedItem(engine, right, engines, dimensions, invocation.signal)
        const score = cosineSimilarity(leftEmbedded.values, rightEmbedded.values)
        return {
          score,
          scoreKind: 'cosine_similarity',
          embeddingSpaceId: TEXT_BACKBONE_SPACE_ID,
          processing: [leftEmbedded.processing, rightEmbedded.processing],
        } as unknown as JsonObject
      }

      // semantic_rank
      if (service.contract.toolName === 'semantic_rank') {
      const query = input.query as Readonly<Record<string, unknown>>
      const candidates = input.candidates as readonly Readonly<Record<string, unknown>>[]
      const queryEmbedded = await embedItem(engine, query, engines, dimensions, invocation.signal)
      const candidateVectors: { id: string; vector: readonly number[] }[] = []
      const candidateProcessing: Record<string, unknown>[] = []
      for (const candidate of candidates) {
        throwIfAborted(invocation.signal)
        const embedded = await embedItem(engine, candidate, engines, dimensions, invocation.signal)
        candidateVectors.push({ id: String(candidate.id), vector: embedded.values })
        candidateProcessing.push(embedded.processing)
      }
      const topK = typeof input.top_k === 'number' ? input.top_k : candidates.length
      const ranked = rankBySimilarity(queryEmbedded.values, candidateVectors, topK)
      return {
        results: ranked.map(entry => ({ id: entry.id, score: entry.score })),
        scoreKind: 'cosine_similarity',
        embeddingSpaceId: TEXT_BACKBONE_SPACE_ID,
        processing: [queryEmbedded.processing, ...candidateProcessing],
      } as unknown as JsonObject
      }

      if (service.contract.toolName === 'semantic_classify') {        // MOD-11: the item is embedded once and scored against every label
        // description. Raw cosine scores only — calibrated is always false, and
        // an embedding scorer is NOT the dedicated decision model.
        const item = input.item as Readonly<Record<string, unknown>>
        const labels = input.labels as unknown as readonly { id: string; description: string }[]
        const itemEmbedded = await embedItem(engine, item, engines, dimensions, invocation.signal)
        const labelVectors: { id: string; vector: readonly number[] }[] = []
        for (const label of labels) {
          throwIfAborted(invocation.signal)
          const embedded = await embedItem(
            engine,
            { id: label.id, parts: [{ kind: 'text', text: label.description }] },
            engines,
            dimensions,
            invocation.signal,
          )
          labelVectors.push({ id: label.id, vector: embedded.values })
        }
        const scored = labelVectors
          .map(label => ({ id: label.id, score: cosineSimilarity(itemEmbedded.values, label.vector) }))
          .sort((a, b) => b.score - a.score)
        const minScore = typeof input.min_score === 'number' ? input.min_score : 0
        const minMargin = typeof input.min_margin === 'number' ? input.min_margin : 0
        const selection = classifySelection(scored, minScore, minMargin)
        return {
          status: selection.status,
          ...selection.label === undefined ? {} : { label: selection.label },
          scores: scored,
          scoreKind: 'cosine_similarity',
          calibrated: false,
          embeddingSpaceId: TEXT_BACKBONE_SPACE_ID,
          processing: [itemEmbedded.processing],
        } as unknown as JsonObject
      }

      if (service.contract.toolName === 'semantic_deduplicate') {
        // MOD-12: the reviewed pure grouping maths in vectors.ts (greedy
        // representative selection in input order, ties by representative
        // order; not transitive; never touches source files).
        const items = input.items as readonly Readonly<Record<string, unknown>>[]
        const threshold = input.threshold as number
        const embeddedItems: { id: string; vector: readonly number[] }[] = []
        for (const item of items) {
          throwIfAborted(invocation.signal)
          const embedded = await embedItem(engine, item, engines, dimensions, invocation.signal)
          embeddedItems.push({ id: String(item.id), vector: embedded.values })
        }
        const groups = deduplicateGroups(embeddedItems, threshold)
        return {
          groups: groups.map(group => ({
            representativeId: group.representativeId,
            members: group.members.map(member => ({ id: member.id, score: member.score })),
          })),
          algorithm: 'greedy_representative_cosine_v1',
          threshold,
          embeddingSpaceId: TEXT_BACKBONE_SPACE_ID,
        } as unknown as JsonObject
      }

      // media_find_moments (MOD-13): windows ranked by embedding cosine —
      // AUDIO windows through the mel path, VIDEO windows through the REAL
      // fused video pipeline (per-window 1 fps sampling → video grid → vision
      // encoder → fused video_features), never synthesized over image rows.
      {
        const query = input.query as Readonly<Record<string, unknown>>
        const media = input.media as { kind: string; path: string; range?: { startSeconds: number; endSeconds: number } }
        const windowSeconds = input.windowSeconds as number
        const strideSeconds = input.strideSeconds as number
        const queryEmbedded = await embedItem(engine, query, engines, dimensions, invocation.signal)

        if (media.kind === 'video') {
          const encoder = await engines.video()
          const whole = await sampleVideoFrames(media.path)
          const wholeDuration = whole.declaredFps > 0
            ? whole.frames / whole.declaredFps
            : (whole.sampleTimestamps[whole.sampleTimestamps.length - 1] ?? 0) + 1
          const sourceStart = media.range?.startSeconds ?? 0
          const duration = Math.max(0, Math.min(media.range?.endSeconds ?? wholeDuration, wholeDuration) - sourceStart)
          const windows = planMomentsWindows(duration, windowSeconds, strideSeconds, CALL_LIMITS.maxMomentWindows)
          const windowScores: { start: number; end: number; score: number; timestamps: readonly number[] }[] = []
          for (const window of windows) {
            throwIfAborted(invocation.signal)
            const video = await sampleVideoFrames(media.path, {
              startSeconds: sourceStart + window.start,
              endSeconds: sourceStart + window.end,
            })
            const embedded = await embedVideoWindow(engine, encoder, video, dimensions, invocation.signal)
            windowScores.push({
              ...window,
              score: cosineSimilarity(queryEmbedded.values, embedded.values),
              timestamps: embedded.timestamps,
            })
          }
          const ordered = [...windowScores].sort((a, b) => b.score - a.score || a.start - b.start)
          const topK = typeof input.top_k === 'number' ? input.top_k : ordered.length
          const matches = ordered.slice(0, topK).map(window => ({
            startSeconds: sourceStart + window.start,
            endSeconds: sourceStart + window.end,
            score: window.score,
          }))
          return {
            matches,
            scoreKind: 'cosine_similarity',
            localization: 'window_level',
            embeddingSpaceId: TEXT_BACKBONE_SPACE_ID,
            windowsEvaluated: windows.length,
            sampledFrameTimestampsSeconds: [...new Set(windowScores.flatMap(window => window.timestamps))].sort((a, b) => a - b),
            processing: [queryEmbedded.processing],
          } as unknown as JsonObject
        }

        const encoder = await engines.audio()
        const audio = await decodeWav(media.path, media.range)
        const rate = AUDIO_PREPROCESSING.samplingRate
        const windowSamples = Math.round(windowSeconds * rate)
        const strideSamples = Math.round(strideSeconds * rate)
        const sourceStart = media.range?.startSeconds ?? 0
        // Windows advance by the stride; the FINAL window clips to the source end
        // and is included exactly once (never a duplicate of the previous one).
        const windows: { start: number; end: number }[] = []
        for (let start = 0; start + windowSamples <= audio.samples.length; start += strideSamples) {
          windows.push({ start, end: start + windowSamples })
        }
        const last = windows[windows.length - 1]
        const tailStart = Math.max(0, audio.samples.length - windowSamples)
        if (last === undefined || last.start < tailStart) {
          windows.push({ start: tailStart, end: audio.samples.length })
        }
        if (windows.length > CALL_LIMITS.maxMomentWindows) {
          throw new Error(
            `the source produces ${windows.length} windows, over the ${CALL_LIMITS.maxMomentWindows}-window limit for one call (MOD-08)`,
          )
        }
        const windowScores: { start: number; end: number; score: number }[] = []
        for (const window of windows) {
          throwIfAborted(invocation.signal)
          const samples = audio.samples.subarray(window.start, window.end)
          const vector = await embedAudioSamples(engine, encoder, samples, dimensions, invocation.signal)
          windowScores.push({ ...window, score: cosineSimilarity(queryEmbedded.values, vector) })
        }
        const ordered = [...windowScores].sort((a, b) => b.score - a.score || a.start - b.start)
        const topK = typeof input.top_k === 'number' ? input.top_k : ordered.length
        const matches = ordered.slice(0, topK).map(window => ({
          startSeconds: sourceStart + window.start / rate,
          endSeconds: sourceStart + window.end / rate,
          score: window.score,
        }))
        return {
          matches,
          scoreKind: 'cosine_similarity',
          localization: 'window_level',
          embeddingSpaceId: TEXT_BACKBONE_SPACE_ID,
          windowsEvaluated: windows.length,
          sampledFrameTimestampsSeconds: [],
          processing: [queryEmbedded.processing],
        } as unknown as JsonObject
      }
    },

    async unload(signal) {
      throwIfAborted(signal)
      if (embedderPromise === undefined) return
      const engine = await embedderPromise.catch(() => undefined)
      embedderPromise = undefined
      await engine?.dispose()
    },

    async dispose() {
      disposed = true
      if (embedderPromise !== undefined) {
        const engine = await embedderPromise.catch(() => undefined)
        embedderPromise = undefined
        await engine?.dispose()
      }
      if (visionPromise !== undefined) {
        const encoder = await visionPromise.catch(() => undefined)
        visionPromise = undefined
        await encoder?.dispose()
      }
      if (audioPromise !== undefined) {
        const encoder = await audioPromise.catch(() => undefined)
        audioPromise = undefined
        await encoder?.dispose()
      }
      if (videoPromise !== undefined) {
        const encoder = await videoPromise.catch(() => undefined)
        videoPromise = undefined
        await encoder?.dispose()
      }
      context.logger.log('debug', 'embeddinggemma provider disposed')
    },
  }
}

export default defineExtension({
  apiVersion: 1,
  async create(context): Promise<ExtensionInstanceV1> {
    return {
      async createProvider({ modelId }) {
        if (modelId !== MODEL_ID) {
          throw new Error(`this extension implements the "${MODEL_ID}" model, not "${modelId}"`)
        }
        // A handle only: no import, no download, no load (EXT-19).
        return createEmbeddingGemmaProvider(context)
      },
      async dispose(reason) {
        context.logger.log('debug', `embeddinggemma extension disposed: ${reason}`)
      },
    }
  },
})
