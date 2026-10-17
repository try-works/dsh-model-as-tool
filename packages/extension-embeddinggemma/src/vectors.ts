/**
 * Deterministic vector operations for the EmbeddingGemma 2 embedding space
 * (MOD-01, MOD-04, MOD-09, MOD-10, MOD-12; BASE-12).
 *
 * Every function here is PURE and model-free: no ONNX session, no weights and no network
 * access. That is the point. The dimension, normalization and space-identity rules, and the
 * similarity maths the derived tools rest on, can be established and tested before any
 * inference exists — and when one of them fails, the failure is a contract or coding defect
 * rather than a model-quality question.
 *
 * WHAT THIS MODULE IS NOT: passing its tests is NOT model evidence. MOD-16 requires pinned
 * golden fixtures compared against a qualified conversion, MOD-17 requires real cross-modal
 * retrieval results, and MOD-19 requires measurements from the built package on Windows CPU.
 * None of that exists yet. A test over a hand-written vector shows the arithmetic is correct;
 * it never shows the model is.
 *
 * The embedding-space rules are MIRRORED from the host's
 * `packages/dsh-model-as-tool/src/model-qualification.ts` rather than imported, because
 * EXT-02 admits only the published SDK: an extension that reached into host internals would
 * be unbuildable for anyone who has not installed the host and would break on any host
 * refactor. Two copies of one rule can drift, so the mirror is deliberate and narrow — the
 * rule and its rationale are copied, and each copy cites the requirement it enforces.
 *
 * @module @try-works/extension-embeddinggemma/vectors
 */

/**
 * The dimensionalities EmbeddingGemma 2 can produce (MOD-01).
 *
 * Mirrored from `EMBEDDINGGEMMA2_DIMENSIONS` in the host's model-qualification module. The
 * model card describes 768 reduced to 512, 256 and 128. Recorded as a CLOSED SET rather
 * than a maximum, because a width that is not on this list is not a space this model
 * produces: treating 384 as "smaller, therefore also fine" is exactly the substitution
 * BASE-12 forbids.
 */
export const EMBEDDINGGEMMA2_DIMENSIONS: readonly number[] = [768, 512, 256, 128]

/**
 * The width produced when the caller asks for no reduction (MOD-04).
 *
 * The default is 768; an operator may select a smaller qualified space instead. What a
 * caller may NOT do is change a stored vector's dimension in place, which is why a width
 * travels with a vector rather than being assumed at comparison time.
 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 768

/**
 * How far from unit norm a vector may sit before it is re-scaled (MOD-04).
 *
 * A vector normalized in float64 lands within roughly 1e-15 of unit norm, so this bound
 * only has to absorb accumulation across a batch of operations. It is deliberately not
 * tighter: re-scaling a vector that is already unit norm changes its last bits, which makes
 * repeated normalization non-idempotent — and MOD-04's reduced route must renormalize
 * exactly once after truncation, not a little on every pass.
 */
export const NORMALIZATION_TOLERANCE = 1e-6

/**
 * How far outside [-1, 1] a cosine may land before it is a defect rather than rounding (MOD-09).
 *
 * MOD-09 permits clipping "tiny documented floating-point excursions" and nothing else. A
 * cosine of 3 is not a rounding artifact; returning 1 for it would hide the defect behind a
 * plausible number. 1e-6 is orders of magnitude above what double-precision accumulation
 * over even 768 terms produces.
 */
export const SIMILARITY_CLIP_TOLERANCE = 1e-6

/**
 * The most items one deduplication call accepts (MOD-12).
 *
 * Grouping compares each item against every existing representative, so it is O(n²) in
 * cosine computations. The bound is declared rather than left implicit so the refusal is
 * reviewable; a caller with more items must page them rather than hand over an unbounded list.
 */
export const MAX_DEDUPLICATION_ITEMS = 512

/** One embedding space's identity (MOD-03, BASE-12). */
export interface EmbeddingSpace {
  /** The model that produces the space, e.g. `embeddinggemma-2`. */
  readonly modelId: string
  /** The width of the vectors it produces. */
  readonly dimensions: number
  /** Whether vectors in this space are stored L2-normalized. */
  readonly normalized: boolean
  /**
   * The canonical identity of the space's content (MOD-03), when the producer records one.
   *
   * A model NAME is not an identity: one name covers several conversions, quantizations and
   * task recipes, and MOD-14 requires reuse across those to be refused. Optional because an
   * older stored index may predate the id — in which case the mismatch check reports that a
   * match cannot be established rather than assuming one.
   */
  readonly embeddingSpaceId?: string
}

/** The verdict for one value checked as an embedding vector (MOD-04). */
export type VectorVerdict =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string }

/** One caller-supplied vector with the ID its results are matched back to (MOD-05, MOD-10). */
export interface IdentifiedVector {
  /** The caller's correlation label. Preserved verbatim: it is not a permission and not a model input. */
  readonly id: string
  /** The vector itself. */
  readonly vector: readonly number[]
}

/** One scored ID, as the derived tools report it (MOD-09, MOD-10). */
export interface ScoredVector {
  /** The caller's ID. */
  readonly id: string
  /** The cosine similarity against the query or the representative it was grouped under. */
  readonly score: number
}

/** One group of near-duplicates with the representative they were compared against (MOD-12). */
export interface DeduplicationGroup {
  /** The first item of the group, which every member score is relative to. */
  readonly representativeId: string
  /**
   * Every member of the group, representative first with a score of exactly 1.
   *
   * The representative is included rather than implied, so a caller never has to add it back
   * to reconstruct the grouping.
   */
  readonly members: readonly ScoredVector[]
}

/**
 * Whether a stated width is one EmbeddingGemma 2 can produce (MOD-01).
 * @param dimensions - the stated width.
 * @returns whether it is a documented width.
 */
export function isEmbeddingGemma2Width(dimensions: number): boolean {
  return EMBEDDINGGEMMA2_DIMENSIONS.includes(dimensions)
}

/**
 * Check an untrusted value as an embedding vector of a declared width (MOD-04).
 *
 * Returns a verdict rather than throwing, because this runs over decoded caller input where
 * "this is not a vector" is an expected answer rather than a fault. The reason is explicit
 * and names the element or the widths, because "invalid vector" leaves a caller unable to
 * tell a wrong length from a NaN at index 300.
 *
 * NaN, Infinity and -Infinity are all rejected, and they must NOT be normalized away: a
 * non-finite element makes every downstream score NaN, and MOD-04 requires rejecting such
 * output rather than silently repairing it.
 *
 * @param vector - the candidate value, untrusted.
 * @param expectedDimensions - the width the space declares.
 * @returns the verdict.
 * @throws Error when `expectedDimensions` is not a positive integer: that is a defect in the
 * caller, not a property of the input, so it is not reported as a verdict about the input.
 */
export function validateVector(vector: unknown, expectedDimensions: number): VectorVerdict {
  if (!Number.isInteger(expectedDimensions) || expectedDimensions <= 0) {
    throw new Error(`expectedDimensions must be a positive integer; received ${String(expectedDimensions)}`)
  }
  if (!Array.isArray(vector)) {
    return {
      valid: false,
      reason: `the value is ${describeValue(vector)} where a ${expectedDimensions}-dimensional array was declared`,
    }
  }
  if (vector.length !== expectedDimensions) {
    return {
      valid: false,
      reason: `the vector has ${vector.length} dimension(s) where the space declares ${expectedDimensions}`,
    }
  }
  for (let index = 0; index < vector.length; index += 1) {
    const element: unknown = vector[index]
    if (typeof element !== 'number') {
      return {
        valid: false,
        reason: `element ${index} is ${describeValue(element)} where a finite number is required`,
      }
    }
    if (!Number.isFinite(element)) {
      return {
        valid: false,
        reason: `element ${index} is ${describeNonFinite(element)}; every element of an embedding must be finite`,
      }
    }
  }
  return { valid: true }
}

/**
 * Whether one embedding space may silently stand in for another (BASE-12).
 *
 * Mirrored, not imported, from the host's model-qualification module, and as narrow as the
 * original: only the DIMENSIONS are compared. EmbeddingGemma 2 is 768-dimensional and MiniLM
 * is 384-dimensional, so substituting one for the other silently would compare vectors of
 * different widths and produce meaningless similarity rather than an error — which is why the
 * substitution is refused and why a replacement requires an explicit re-index.
 *
 * This is the MINIMUM bar, not the whole check. {@link assertEmbeddingSpace} applies the
 * stricter identity MOD-03 and MOD-14 describe, because two spaces can share a width and
 * still not be comparable.
 *
 * @param from - the space in use.
 * @param to - the proposed replacement.
 * @returns whether the substitution is safe without an explicit migration.
 */
export function maySubstituteSilently(from: EmbeddingSpace, to: EmbeddingSpace): boolean {
  return from.dimensions === to.dimensions
}

/**
 * Assert that a space is the one the caller requires (MOD-03, MOD-04, BASE-12, MOD-14).
 *
 * Stricter than {@link maySubstituteSilently} on purpose. Dimension equality is necessary and
 * not sufficient:
 *
 * - the same model at 768 and at 512 produces vectors that cannot be compared in place
 *   (MOD-04), so a reduced width is a DIFFERENT space, not a smaller view of this one;
 * - an unnormalized vector indexed beside a normalized one is not a cosine pair (MOD-03);
 * - two conversions of one model share the name but not the space (MOD-14).
 *
 * A check that only counted dimensions would pass all three, which is why the failure modes
 * are separated into distinct reasons instead of one "incompatible" message.
 *
 * @param space - the space actually in hand.
 * @param expected - the space the caller requires.
 * @throws Error naming exactly what differs.
 */
export function assertEmbeddingSpace(space: EmbeddingSpace, expected: EmbeddingSpace): void {
  const mismatch = spaceMismatch(space, expected)
  if (mismatch !== undefined) throw new Error(`incompatible embedding space: ${mismatch}`)
}

/**
 * L2-normalize a vector (MOD-04).
 *
 * Idempotent BY CONSTRUCTION: a vector already within {@link NORMALIZATION_TOLERANCE} of unit
 * norm is returned with its values untouched rather than re-scaled. That is the difference
 * between "normalizing before every use is harmless" and "normalizing before every use costs
 * the last bits every time", and MOD-04's reduced route — truncate, then renormalize once —
 * depends on the first behaviour.
 *
 * A zero vector is REFUSED, not repaired. It has no direction, so any unit vector would be an
 * invented answer, and MOD-04 says to reject zero/NaN/Infinity rather than silently normalize.
 *
 * @param vector - the vector to normalize.
 * @returns a new vector of the same width, with unit norm within tolerance.
 * @throws Error for an empty, zero or non-finite vector.
 */
export function normalizeL2(vector: readonly number[]): readonly number[] {
  const norm = l2Norm(vector)
  if (norm === 0) {
    throw new Error('a zero vector has no direction and cannot be L2-normalized (MOD-04: reject it rather than normalize it)')
  }
  if (Math.abs(norm - 1) <= NORMALIZATION_TOLERANCE) {
    // A copy, so a caller cannot reach back into the input through the result. The VALUES
    // are the input's, which is what "left alone" means here: no re-scaling happens.
    return [...vector]
  }
  return vector.map(element => element / norm)
}

/**
 * Whether a vector is already at unit norm within the declared tolerance (MOD-04).
 * @param vector - the vector to measure.
 * @returns whether it is already unit norm.
 * @throws Error when the vector is empty or holds a non-finite element.
 */
export function isUnitNorm(vector: readonly number[]): boolean {
  return Math.abs(l2Norm(vector) - 1) <= NORMALIZATION_TOLERANCE
}

/**
 * Reduce an embedding to a smaller documented width (MOD-04, AT-43).
 *
 * MOD-04's route is "leading-dimension truncation then L2 renormalization", and the
 * renormalization is not optional. Truncation removes components, so the truncated vector is
 * shorter than unit length and a cosine against it would be scaled by that deficit: every
 * similarity would drift downward with no error to explain it.
 *
 * Growing a vector is refused rather than attempted. The removed components cannot be
 * recovered, so a 256-dimensional vector cannot become a 768-dimensional one in place; MOD-04
 * states that stored vectors cannot change dimension in place, and the honest route is to
 * re-embed through the wider space and re-index.
 *
 * @param vector - the vector to reduce.
 * @param target - the requested width, which must be one EmbeddingGemma 2 produces.
 * @returns the reduced, renormalized vector.
 * @throws Error for an undocumented width, a vector narrower than the target, or a non-finite input.
 */
export function reduceDimensions(vector: readonly number[], target: number): readonly number[] {
  if (!isEmbeddingGemma2Width(target)) {
    throw new Error(
      `${target} is not a width EmbeddingGemma 2 produces; the documented widths are `
      + `${EMBEDDINGGEMMA2_DIMENSIONS.join(', ')} (MOD-01)`,
    )
  }
  if (vector.length < target) {
    throw new Error(
      `a ${vector.length}-dimensional vector cannot be widened to ${target}; reduction is lossy, so stored `
      + 'vectors must be re-embedded through the wider route and re-indexed (MOD-04)',
    )
  }
  return normalizeL2(vector.slice(0, target))
}

/**
 * Cosine similarity between two vectors (MOD-09).
 *
 * Every way this could return NaN is an explicit error instead: a width mismatch, a
 * non-finite element, a zero vector, or a norm too large to represent. Returning NaN from a
 * similarity tool is the failure the requirement names — it propagates into a ranking
 * silently, and because NaN compares false against every threshold, "no match" and "broken
 * input" become the same answer.
 *
 * The result is a raw cosine and NOT a probability that the two inputs mean the same thing
 * (MOD-09). Tiny excursions beyond [-1, 1] caused by accumulation are clipped; anything
 * larger is reported as a defect rather than clamped to a plausible number.
 *
 * @param left - the first vector.
 * @param right - the second vector.
 * @returns the cosine, in [-1, 1].
 * @throws Error on any of the conditions above.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new Error(
      `cosine similarity requires two vectors of one width; received ${left.length} and ${right.length} dimensions`,
    )
  }
  if (left.length === 0) throw new Error('cosine similarity requires two non-empty vectors')
  // Both norms are measured BEFORE the dot product, so a non-finite element is reported as
  // itself rather than as a NaN score three steps later.
  const leftNorm = l2Norm(left)
  const rightNorm = l2Norm(right)
  if (leftNorm === 0 || rightNorm === 0) {
    throw new Error('cosine similarity is undefined for a zero vector: a zero vector has no direction (MOD-09)')
  }
  let dot = 0
  for (let index = 0; index < left.length; index += 1) {
    // The widths were compared above, so both reads are in range; noUncheckedIndexedAccess
    // cannot see that, hence the assertion.
    dot += (left[index] as number) * (right[index] as number)
  }
  const raw = dot / (leftNorm * rightNorm)
  if (!Number.isFinite(raw)) {
    throw new Error('the cosine is not finite; the elements are too large to compare in double precision')
  }
  if (raw > 1 || raw < -1) {
    if (Math.abs(raw) - 1 > SIMILARITY_CLIP_TOLERANCE) {
      throw new Error(
        `the cosine is ${raw}, outside [-1, 1] by more than the declared rounding tolerance of `
        + `${SIMILARITY_CLIP_TOLERANCE}; that is a defect in the inputs, not rounding (MOD-09)`,
      )
    }
    // Clipped only within the documented tolerance, so a caller can rely on the range.
    return raw > 1 ? 1 : -1
  }
  return raw
}

/**
 * Rank candidates against a query by cosine similarity (MOD-10).
 *
 * STABILITY IS CONSTRUCTED, NOT ASSUMED. The comparator orders by descending score and then
 * by the candidate's original position, so the result is a total order that does not depend on
 * the engine's sort being stable. `Array.prototype.sort` is stable in current V8, and relying
 * on that would make a tie's outcome a property of the runtime rather than of this function.
 *
 * `topK` is bounded in both directions. Rejecting `topK > candidates.length` rather than
 * quietly returning fewer rows is deliberate: a short result would be read as "there was
 * nothing else", when in fact the caller asked for more candidates than it supplied.
 *
 * @param query - the query vector.
 * @param candidates - the candidate vectors, each with the caller's ID.
 * @param topK - how many results to return; must be in [1, candidates.length].
 * @returns the ranked IDs with their scores, best first.
 * @throws Error for a non-positive or oversized `topK`, duplicate IDs, or a candidate whose
 * width differs from the query's.
 */
export function rankBySimilarity(
  query: readonly number[],
  candidates: readonly IdentifiedVector[],
  topK: number,
): readonly ScoredVector[] {
  if (!Number.isInteger(topK) || topK <= 0) {
    throw new Error(`topK must be a positive integer; received ${String(topK)}`)
  }
  if (topK > candidates.length) {
    throw new Error(
      `topK ${topK} exceeds the ${candidates.length} candidate(s) supplied; returning fewer rows would be `
      + 'indistinguishable from having ranked fewer candidates (MOD-10)',
    )
  }
  assertUniqueIds(candidates, 'candidate')
  const scored = candidates.map((candidate, index) => {
    if (candidate.vector.length !== query.length) {
      throw new Error(
        `candidate ${JSON.stringify(candidate.id)} has ${candidate.vector.length} dimension(s) where the query `
        + `has ${query.length}; both must come from one embedding space (MOD-14)`,
      )
    }
    return { id: candidate.id, score: cosineSimilarity(query, candidate.vector), index }
  })
  // Descending score, then original input order. The subtraction is safe because
  // cosineSimilarity throws rather than returning NaN, and a score minus itself is 0.
  scored.sort((left, right) => (right.score - left.score) || (left.index - right.index))
  return scored.slice(0, topK).map(entry => ({ id: entry.id, score: entry.score }))
}

/**
 * The MOD-11 selection rule, pure and model-free (testable without weights).
 *
 * A label is SELECTED only when the best raw cosine clears `minScore` AND its
 * margin over the runner-up clears `minMargin`. Otherwise the honest answer is
 * ABSTAINED with no label — an embedding scorer never fabricates a calibrated
 * probability to force a decision (MOD-11, DECL-04).
 * @param scored - the label scores, in the caller's label order.
 * @param minScore - the minimum score for the best label.
 * @param minMargin - the minimum margin over the runner-up.
 * @returns the selection.
 */
export function classifySelection(
  scored: readonly { readonly id: string; readonly score: number }[],
  minScore: number,
  minMargin: number,
): { readonly status: 'selected' | 'abstained'; readonly label?: string } {
  const ordered = [...scored].sort((left, right) => right.score - left.score)
  const best = ordered[0]
  if (best === undefined) return { status: 'abstained' }
  const runnerUp = ordered[1]?.score ?? Number.NEGATIVE_INFINITY
  return best.score >= minScore && best.score - runnerUp >= minMargin
    ? { status: 'selected', label: best.id }
    : { status: 'abstained' }
}

/**
 * Group near-duplicate vectors by deterministic greedy representative selection (MOD-12).
 *
 * The algorithm is specified rather than chosen: each item in INPUT ORDER is compared against
 * the existing representatives, the highest-scoring representative at or above the threshold
 * wins (ties by representative order), and otherwise the item starts a new group. Each member
 * score is relative to its own representative.
 *
 * Similarity is not transitive, and the grouping does not pretend it is: with a threshold of
 * 0.8, a chain of A≈B and B≈C does NOT merge A with C merely because they share a neighbour.
 * C is compared with the representative A, and if that comparison fails it becomes its own
 * group — which is the honest answer, since A and C are not near-duplicates.
 *
 * @param items - the items to group, in the caller's order.
 * @param threshold - the minimum cosine for an item to join a group; must be in [-1, 1].
 * @returns the groups, each representative first with a score of exactly 1.
 * @throws Error for an out-of-range threshold, more than {@link MAX_DEDUPLICATION_ITEMS}
 * items, duplicate IDs, or vectors of differing widths.
 */
/**
 * Plan the moments windows over a source duration (MOD-13), the SAME math for
 * audio samples and video seconds: windows advance by the stride, the FINAL
 * window clips to the source end and is included exactly once.
 * @param duration - the source length (seconds).
 * @param windowSeconds - the window length.
 * @param strideSeconds - the advance between windows.
 * @param maxWindows - the per-call window cap (MOD-08).
 * @returns the planned windows in source order.
 */
export function planMomentsWindows(
  duration: number,
  windowSeconds: number,
  strideSeconds: number,
  maxWindows: number,
): readonly { start: number; end: number }[] {
  if (!(windowSeconds > 0) || !(strideSeconds > 0)) throw new Error('window and stride must be positive')
  const windows: { start: number; end: number }[] = []
  for (let start = 0; start + windowSeconds <= duration; start += strideSeconds) {
    windows.push({ start, end: start + windowSeconds })
  }
  const last = windows[windows.length - 1]
  const tailStart = Math.max(0, duration - windowSeconds)
  if (last === undefined || last.start < tailStart) {
    windows.push({ start: tailStart, end: duration })
  }
  if (windows.length > maxWindows) {
    throw new Error(
      `the source produces ${windows.length} windows, over the ${maxWindows}-window limit for one call (MOD-08)`,
    )
  }
  return windows
}

export function deduplicateGroups(
  items: readonly IdentifiedVector[],
  threshold: number,
): readonly DeduplicationGroup[] {
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    throw new Error(`threshold must be a finite number; received ${String(threshold)}`)
  }
  if (threshold < -1 || threshold > 1) {
    // A cosine threshold outside [-1, 1] is met by every pair or by none, so it is a caller
    // error rather than a policy the caller could have meant.
    throw new Error(`threshold ${threshold} is outside [-1, 1], the range a cosine similarity can take`)
  }
  if (items.length > MAX_DEDUPLICATION_ITEMS) {
    throw new Error(
      `${items.length} items exceed the declared bound of ${MAX_DEDUPLICATION_ITEMS} for one deduplication `
      + 'call; the grouping is O(n^2) in cosine computations, so page the items (MOD-12)',
    )
  }
  assertUniqueIds(items, 'item')
  const first = items[0]
  if (first === undefined) return []
  const width = first.vector.length
  const groups: { representativeId: string; representative: readonly number[]; members: ScoredVector[] }[] = []
  for (const item of items) {
    if (item.vector.length !== width) {
      throw new Error(
        `item ${JSON.stringify(item.id)} has ${item.vector.length} dimension(s) where ${JSON.stringify(first.id)} `
        + `has ${width}; one grouping call compares one embedding space (MOD-14)`,
      )
    }
    // A zero vector has no direction: it can neither represent a group (whose first member
    // score is declared as exactly 1) nor be scored against one. Checked for EVERY item,
    // including each representative, because a representative is never compared with itself.
    if (l2Norm(item.vector) === 0) {
      throw new Error(
        `item ${JSON.stringify(item.id)} is a zero vector and has no direction; it cannot represent or join a `
        + 'group (MOD-12)',
      )
    }
    let best: (typeof groups)[number] | undefined
    let bestScore = Number.NEGATIVE_INFINITY
    for (const group of groups) {
      const score = cosineSimilarity(item.vector, group.representative)
      // STRICTLY greater, so the earliest representative keeps an exact tie (MOD-12: ties by
      // representative order).
      if (score >= threshold && score > bestScore) {
        best = group
        bestScore = score
      }
    }
    if (best === undefined) {
      groups.push({
        representativeId: item.id,
        representative: item.vector,
        // Exactly 1: a vector's cosine with itself is 1 for any non-zero vector, so writing
        // the measured value would report a differently-rounded number per item.
        members: [{ id: item.id, score: 1 }],
      })
    } else {
      best.members.push({ id: item.id, score: bestScore })
    }
  }
  return groups.map(group => ({
    representativeId: group.representativeId,
    members: [...group.members],
  }))
}

/** Why a space cannot stand in for another, or undefined when it can (MOD-03, BASE-12, MOD-14). */
function spaceMismatch(actual: EmbeddingSpace, expected: EmbeddingSpace): string | undefined {
  if (actual.dimensions !== expected.dimensions) {
    return `${actual.modelId} produces ${actual.dimensions}-dimensional vectors and ${expected.modelId} produces `
      + `${expected.dimensions}; existing vectors are not comparable and require an explicit re-index (BASE-12). `
      + 'A reduced width from the same model is a DIFFERENT space, not a smaller view of this one (MOD-04)'
  }
  if (actual.normalized !== expected.normalized) {
    return `${actual.modelId} stores ${actual.normalized ? 'L2-normalized' : 'unnormalized'} vectors where `
      + `${expected.modelId} stores ${expected.normalized ? 'L2-normalized' : 'unnormalized'} ones; a dot product `
      + 'over unnormalized vectors is not a cosine, so the two cannot be mixed (MOD-03)'
  }
  if (actual.embeddingSpaceId !== expected.embeddingSpaceId) {
    if (actual.embeddingSpaceId === undefined || expected.embeddingSpaceId === undefined) {
      return 'one of the two spaces records no embeddingSpaceId, so an identity match cannot be established; MOD-03 '
        + 'requires the id to be computed from canonical content, and MOD-14 refuses reuse that cannot be shown to match'
    }
    return `the recorded embeddingSpaceIds differ (${actual.embeddingSpaceId} and ${expected.embeddingSpaceId}); one `
      + 'model name covers several conversions, quantizations and task recipes, and MOD-14 refuses mixing them'
  }
  return undefined
}

/** Reject duplicate IDs, which would make a result ambiguous (MOD-05). */
function assertUniqueIds(items: readonly IdentifiedVector[], what: string): void {
  const seen = new Set<string>()
  for (const item of items) {
    if (item.id.length === 0) throw new Error(`a ${what} has an empty id; every ${what} carries a caller-supplied id`)
    if (seen.has(item.id)) {
      throw new Error(
        `duplicate ${what} id ${JSON.stringify(item.id)}; results are matched back by id, so a duplicate makes the `
        + 'answer ambiguous (MOD-05)',
      )
    }
    seen.add(item.id)
  }
}

/**
 * Measure a vector's Euclidean norm, refusing anything that has no norm.
 * @param vector - the vector to measure.
 * @returns the norm.
 * @throws Error when the vector is empty or holds a non-finite element.
 */
function l2Norm(vector: readonly number[]): number {
  if (vector.length === 0) throw new Error('an empty vector has no norm and no direction')
  let sum = 0
  for (let index = 0; index < vector.length; index += 1) {
    const element: unknown = vector[index]
    if (typeof element !== 'number' || !Number.isFinite(element)) {
      throw new Error(
        `element ${index} is ${typeof element === 'number' ? describeNonFinite(element) : describeValue(element)}; `
        + 'every element of an embedding must be finite (MOD-04)',
      )
    }
    sum += element * element
  }
  const norm = Math.sqrt(sum)
  if (!Number.isFinite(norm)) {
    throw new Error('the vector norm is not finite; the elements are too large to measure in double precision')
  }
  return norm
}

/** Describe a value's kind for an error message, without printing a large payload. */
function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `an array of ${value.length} element(s)`
  return `a value of type ${typeof value}`
}

/** Name a non-finite number exactly, because NaN and Infinity need different fixes. */
function describeNonFinite(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  return value > 0 ? 'Infinity' : '-Infinity'
}
