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

/** The model deployment this extension implements. */
const MODEL_ID = 'embeddinggemma-2'

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
 * Why an invocation cannot run in this build.
 *
 * This constant is the honest core of the provider: the ONNX session is not wired, so there is
 * no state in which this deployment produces a vector. It is stated once and reused so the
 * inspection, the load and the invocation cannot describe the same gap three different ways.
 */
const INFERENCE_NOT_WIRED =
  'the EmbeddingGemma 2 ONNX inference path is not wired in this build (0.1.0): the package declares the model '
  + 'deployment, its asset groups and its tool contracts, and implements the deterministic vector operations the '
  + 'derived tools use, but no session is created and no vector is computed'

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
 * The refusal is by NAME and happens before any model work. The alternative — ignoring an
 * image part and embedding the remaining text — returns a plausible vector for an input the
 * caller did not send, which is worse than an error: the caller has no way to notice.
 * @param value - the candidate part.
 * @param where - a path for the error message.
 */
function requirePart(value: unknown, where: string): void {
  const part = requireObject(value, where)
  const kind: unknown = part.kind
  if (!isOneOf(kind, PART_KINDS)) {
    throw new Error(`${where}: "kind" must be one of ${PART_KINDS.join(', ')}`)
  }
  if (!isOneOf(kind, SUPPORTED_PART_KINDS)) {
    throw new Error(
      `${where}: this build reads ${SUPPORTED_PART_KINDS.join(' and ')} parts only, so a "${kind}" part is refused. `
      + 'Node image, audio and video decoding (MOD-07) is not implemented yet, and embedding the rest of the item '
      + 'while the caller believed the media was included would be a silently wrong answer (MOD-20)',
    )
  }
  requireString(part, 'text', where, CALL_LIMITS.maxTextCharacters)
  if (part.language !== undefined) requireString(part, 'language', where, 64)
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

/** An implementation's contract plus the validator for its arguments (EXT-22). */
interface Service {
  readonly contract: OwnedToolContract
  readonly validate: (input: Readonly<JsonObject>) => void
}

/** The argument validators, keyed by implementation id. */
const ARGUMENT_VALIDATORS: Readonly<Record<string, (input: Readonly<JsonObject>) => void>> = {
  'embeddinggemma2-onnx': validateEmbedInput,
  'embeddinggemma2-similarity': validateSimilarityInput,
  'embeddinggemma2-rank': validateRankInput,
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

/**
 * Run one implementation.
 *
 * THIS IS THE SEAM THE INFERENCE SLICE FILLS. Until it is filled it is the honest refusal: the
 * argument checks above have already run, so a malformed call has failed for its own reason,
 * and everything left needs a session that does not exist. It reports what is missing on this
 * host, names the build, and says plainly that nothing was computed.
 *
 * @param contract - the contract being served.
 * @param signal - cancellation.
 * @returns the domain payload, once an implementation exists.
 * @throws Error in every call this build can make.
 */
async function runInference(contract: OwnedToolContract, signal: AbortSignal): Promise<JsonObject> {
  throwIfAborted(signal)
  const gaps = runtimeGaps()
  const detail = gaps.length === 0
    ? ''
    : ` Missing on this host: ${gaps.map(gap => gap.name).join(', ')}.`
  throw new Error(
    `${contract.toolName} cannot run on this deployment: ${INFERENCE_NOT_WIRED}.${detail} `
    + 'No vector was computed and no result is reported.',
  )
}

/** Build the provider for the EmbeddingGemma 2 deployment. */
function createEmbeddingGemmaProvider(context: ExtensionContextV1): ModelProviderV1 {
  let disposed = false

  return {
    async inspect(signal): Promise<ProviderInspectionV1> {
      throwIfAborted(signal)
      /**
       * EXT-18: inspection reads approved local state only and reports what the build can
       * ACTUALLY run. Both halves of that are honest here and neither of them is `ready`:
       *
       * - `features` is EMPTY, and that is the correct answer rather than an omission. A
       *   feature list is a claim about what can run; listing `semantic-similarity` before an
       *   ONNX session exists would be exactly the fabrication this method is specified to
       *   avoid. The manifest's tool declarations say what the tools WILL do; this says what
       *   this build does.
       * - `readiness` is `unprepared`, which is the provider-level form of the lifecycle's
       *   `needs-preparation` diagnostic: the package is valid and active, its tools are
       *   describable, and preparation happens on first use (EXT-26).
       *
       * Asset state is NOT read here. The host supplies verified assets to `load()` and
       * nowhere else, so inspection must not guess whether preparation has happened.
       */
      const missing = [
        ...runtimeGaps(),
        { name: 'embeddinggemma-2-onnx-inference', reason: INFERENCE_NOT_WIRED },
      ]
      return {
        readiness: 'unprepared',
        features: [],
        missing,
        reason:
          'needs preparation: this build wires no ONNX session, and the runtime packages and the qualified '
          + `asset groups (${ASSET_GROUPS.join(', ')}) must all be present before one can be created`,
      }
    },

    async load(request: { readonly assets: Readonly<PreparedAssetMapV1>; readonly signal: AbortSignal }) {
      throwIfAborted(request.signal)
      // The host acquires and verifies the pinned bytes and hands over LOCAL paths; the
      // extension fetches nothing itself, which is why the manifest declares no network origin
      // for it while the deployment's own preparation does use the network once.
      const gaps = runtimeGaps()
      const absentGroups = ASSET_GROUPS.filter(group => request.assets.get(group) === undefined)
      if (gaps.length > 0 || absentGroups.length > 0) {
        const problems = [
          ...gaps.map(gap => `${gap.name} does not resolve on this host`),
          ...absentGroups.map(group => `the "${group}" asset group was not prepared`),
        ]
        throw new Error(
          `EmbeddingGemma 2 is not prepared: ${problems.join('; ')}. The deployment reports needs-preparation rather `
          + 'than loading a partial route (MOD-02)',
        )
      }
      // Every declared group is present and both runtime packages resolve — and this build
      // STILL cannot infer. Refusing here is the point: recording a successful load would tell
      // the host the deployment is callable when nothing can produce a vector.
      throw new Error(`EmbeddingGemma 2 cannot be loaded: ${INFERENCE_NOT_WIRED}`)
    },

    async invoke({ implementationId, input, context: invocation }): Promise<JsonObject> {
      throwIfAborted(invocation.signal)
      if (disposed) throw new Error('the provider has been disposed')
      // Validation runs BEFORE any model work, so a malformed call fails for its own reason
      // rather than being reported later as an unavailable model.
      const service = serviceFor(implementationId)
      service.validate(input)
      return await runInference(service.contract, invocation.signal)
    },

    async unload(signal) {
      throwIfAborted(signal)
      // Nothing is loaded in this build, so unloading releases nothing and re-reporting that is
      // the honest outcome. The next slice must release its sessions here rather than leave
      // them resident: this method is the only place the host asks for that.
    },

    async dispose() {
      disposed = true
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
