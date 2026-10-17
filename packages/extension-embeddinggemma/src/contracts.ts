/**
 * The tool contracts this package OWNS (DECL-01, EXT-21).
 *
 * This package is not implementing a host-recognised standard contract such as
 * `tool-mode/lang_detect`; it defines new ones, so it owns their public identity. EXT-21
 * requires a new contract to use its extension ID as the namespace, which is why every
 * `contractId` below begins with `@try-works/extension-embeddinggemma/`.
 *
 * The contract identity lives in TWO places that cannot import each other: this module, which
 * the extension code dispatches on, and `tool-mode.extension.json`, which the host reads as
 * data before any of this code runs (EXT-13). Duplicating identity is a drift risk, so the
 * package's test asserts that the manifest and this module agree field for field, and that
 * every schema file named here is present, closed and compilable. The schema DOCUMENTS are the
 * authority on shape; this module carries the identity and the dispatch mapping.
 *
 * The six tools this build serves are declared here and served by the provider:
 * multimodal_embed, semantic_similarity, semantic_rank, semantic_classify (MOD-11),
 * semantic_deduplicate (MOD-12) and media_find_moments (MOD-13).
 *
 * @module @try-works/extension-embeddinggemma/contracts
 */

/** The purposes the shared multimodal input vocabulary defines (MOD-06). */
export const EMBEDDING_PURPOSES = [
  'retrieval',
  'code_retrieval',
  'similarity',
  'classification',
  'clustering',
] as const

/** One embedding purpose. */
export type EmbeddingPurpose = (typeof EMBEDDING_PURPOSES)[number]

/** The roles a caller may state (MOD-05). */
export const EMBEDDING_ROLES = ['query', 'document', 'symmetric'] as const

/** One embedding role. */
export type EmbeddingRole = (typeof EMBEDDING_ROLES)[number]

/** The part kinds the shared multimodal input vocabulary defines. */
export const PART_KINDS = ['text', 'code', 'image', 'audio', 'video'] as const

/** One part kind. */
export type PartKind = (typeof PART_KINDS)[number]

/**
 * The part kinds THIS BUILD reads (MOD-20).
 *
 * The contracts admit image, audio and video parts because the model does. This build reads all
 * of them: text, code, image and audio through the bounded Node decoders and the wired
 * vision/audio encoders (MOD-07), and VIDEO through the fused video path — the bounded
 * uncompressed-DIB AVI sampler, the per-frame video grid (max_soft_tokens 140, a distinct
 * grid from the vision encoder's 42x60 image grid) and the fused model's video_features
 * scatter (MOD-20).
 */
export const SUPPORTED_PART_KINDS: readonly PartKind[] = ['text', 'code', 'image', 'audio', 'video']

/**
 * The declared limits on one call.
 *
 * Published here AND in the shipped schemas, because the two enforce at different moments — a
 * schema validates a decoded argument document, and these bound what the implementation does
 * with it — and a limit that exists in only one of the two places is a limit a caller can walk
 * around. The package's test asserts that the schema documents declare the same numbers, so
 * changing one without the other fails rather than drifting.
 */
export const CALL_LIMITS = {
  /** Most items one `multimodal_embed` call accepts. */
  maxItems: 64,
  /** Most candidates one `semantic_rank` call accepts. */
  maxCandidates: 256,
  /** Most parts one item may carry. */
  maxPartsPerItem: 16,
  /** Most characters of text or code one part may carry (MOD-08: over-context input is refused, not truncated). */
  maxTextCharacters: 4096,
  /** Most characters of a caller-supplied id. */
  maxIdCharacters: 128,
  /** Most characters of an optional item title. */
  maxTitleCharacters: 512,
  /** Most labels one `semantic_classify` call accepts. */
  maxClassifyLabels: 128,
  /** Most items one `semantic_deduplicate` call accepts. */
  maxDedupItems: 256,
  /** Most windows one `media_find_moments` call may evaluate. */
  maxMomentWindows: 256,
} as const

/** One tool contract this package owns and serves. */export interface OwnedToolContract {
  /** The manifest's local tool id, unique inside the package. */
  readonly toolId: string
  /** The caller-facing tool name. */
  readonly toolName: string
  /** The contract identity, namespaced by the extension id (EXT-21). */
  readonly contractId: string
  /** The contract's semantic version. */
  readonly contractVersion: string
  /** The implementation id the provider dispatches on. */
  readonly implementationId: string
  /** The caller-facing description. Identical to the manifest's, and asserted to be. */
  readonly description: string
  /** The shipped input schema, package-relative. */
  readonly inputSchema: string
  /** The shipped output schema, package-relative. */
  readonly outputSchema: string
}

/** The contracts this build declares and serves. */
export const OWNED_TOOL_CONTRACTS: readonly OwnedToolContract[] = [
  {
    toolId: 'multimodal-embed',
    toolName: 'multimodal_embed',
    contractId: '@try-works/extension-embeddinggemma/multimodal_embed',
    contractVersion: '1.0.0',
    implementationId: 'embeddinggemma2-onnx',
    description:
      'Embed one or more items into a shared embedding space over EmbeddingGemma 2. Returns L2-normalized vectors '
      + 'of 768, 512, 256 or 128 dimensions plus a per-item processing record of the modality, source range and '
      + 'video sampling that produced each one. This build reads text, code, image and audio parts; a video part is '
      + 'refused by name (the bounded frame sampler exists, but the model video grid and fused video scatter are '
      + 'not reconstructed). It does not describe an image in words, '
      + 'transcribe speech, return OCR text or produce calibrated decisions.',
    inputSchema: './schema/multimodal-embed.input.json',
    outputSchema: './schema/multimodal-embed.output.json',
  },
  {
    toolId: 'semantic-similarity',
    toolName: 'semantic_similarity',
    contractId: '@try-works/extension-embeddinggemma/semantic_similarity',
    contractVersion: '1.0.0',
    implementationId: 'embeddinggemma2-similarity',
    description:
      'Cosine similarity between two items embedded in one space over EmbeddingGemma 2, supporting text-to-text, '
      + 'text-to-image, text-to-audio and image-to-image pairings on a qualified build. The score is a cosine '
      + 'similarity, not a probability that the two mean the same thing, and it is comparable only within one '
      + 'embedding space. This build reads text, code, image and audio parts; a video part is refused by name.',
    inputSchema: './schema/semantic-similarity.input.json',
    outputSchema: './schema/semantic-similarity.output.json',
  },
  {
    toolId: 'semantic-rank',
    toolName: 'semantic_rank',
    contractId: '@try-works/extension-embeddinggemma/semantic_rank',
    contractVersion: '1.0.0',
    implementationId: 'embeddinggemma2-rank',
    description:
      'Rank candidate items against a query by embedding cosine similarity over EmbeddingGemma 2, returning '
      + 'the caller\'s own IDs in stable descending score order with exact ties broken by input order. This is '
      + 'embedding ranking, not the cross-encoder text_rerank tool: the two produce different score kinds and are '
      + 'not interchangeable. This build reads text, code, image and audio parts; a video part is refused by name.',
    inputSchema: './schema/semantic-rank.input.json',
    outputSchema: './schema/semantic-rank.output.json',
  },
  {
    toolId: 'semantic-classify',
    toolName: 'semantic_classify',
    contractId: '@try-works/extension-embeddinggemma/semantic_classify',
    contractVersion: '1.0.0',
    implementationId: 'embeddinggemma2-classify',
    description:
      'Classify one item against caller-supplied label descriptions by embedding cosine similarity over '
      + 'EmbeddingGemma 2 (MOD-11). Returns the best label with its raw cosine score plus every label score, or '
      + 'status "abstained" when the best score is below min_score or the margin to the runner-up is below '
      + 'min_margin. The scores are raw embedding cosines — calibrated is always false, and this is not the '
      + 'dedicated decision model: an embedding label scorer is not an equivalent implementation of a probabilistic '
      + 'decision contract. This build reads text, code, image and audio parts; a video part is refused by name.',
    inputSchema: './schema/semantic-classify.input.json',
    outputSchema: './schema/semantic-classify.output.json',
  },
  {
    toolId: 'semantic-deduplicate',
    toolName: 'semantic_deduplicate',
    contractId: '@try-works/extension-embeddinggemma/semantic_deduplicate',
    contractVersion: '1.0.0',
    implementationId: 'embeddinggemma2-deduplicate',
    description:
      'Group near-duplicate items by greedy representative clustering in input order over EmbeddingGemma 2 '
      + 'cosine similarity (MOD-12): each item joins the FIRST group whose representative scores at or above the '
      + 'threshold, otherwise it starts a new group. The result is deterministic for a fixed threshold, is not '
      + 'transitive (A may match B and B match C without A matching C), and never deletes, moves or rewrites '
      + 'source files. This build reads text, code, image and audio parts; a video part is refused by name.',
    inputSchema: './schema/semantic-deduplicate.input.json',
    outputSchema: './schema/semantic-deduplicate.output.json',
  },
  {
    toolId: 'media-find-moments',
    toolName: 'media_find_moments',
    contractId: '@try-works/extension-embeddinggemma/media_find_moments',
    contractVersion: '1.0.0',
    implementationId: 'embeddinggemma2-moments',
    description:
      'Find the source-time windows of one audio item that best match a query by embedding each window and '
      + 'ranking by cosine similarity (MOD-13). Returns window-level matches with source timestamps, the score '
      + 'kind, the number of windows evaluated and the sampled-frame timestamps (empty for audio). The final '
      + 'window is clipped to the actual source range and included exactly once. No transcription happens: this '
      + 'is embedding retrieval, not speech recognition. VIDEO media is refused by name in this build (the fused '
      + 'video-grid reconstruction is the separate recorded remainder).',
    inputSchema: './schema/media-find-moments.input.json',
    outputSchema: './schema/media-find-moments.output.json',
  },
]

/**
 * The contract one implementation serves (EXT-22: an implementation binds to a contract).
 * @param implementationId - the implementation id from the invocation.
 * @returns the contract, or undefined when this package does not serve that implementation.
 */
export function contractForImplementation(implementationId: string): OwnedToolContract | undefined {
  return OWNED_TOOL_CONTRACTS.find(contract => contract.implementationId === implementationId)
}

/**
 * Whether a purpose admits a role (MOD-05).
 *
 * Retrieval compares a query against documents, so it admits exactly those two roles; the
 * symmetric purposes compare like with like, so a query/document distinction there is a
 * caller error rather than a nuance. Returns a boolean instead of throwing so the caller can
 * report BOTH offending values in one message.
 *
 * This mirrors the `if`/`then` constraint in the shipped schemas. It is duplicated here
 * deliberately: the schema protects the host's validated path, and this protects the
 * implementation when it is reached by another route.
 *
 * @param purpose - the stated purpose.
 * @param role - the stated role.
 * @returns whether the combination is admitted.
 */
export function admitsRole(purpose: EmbeddingPurpose, role: EmbeddingRole): boolean {
  return purpose === 'retrieval' || purpose === 'code_retrieval'
    ? role === 'query' || role === 'document'
    : role === 'symmetric'
}
