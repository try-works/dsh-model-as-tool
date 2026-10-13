/**
 * Deterministic vector tests (MOD-01, MOD-04, MOD-09, MOD-10, MOD-12; BASE-12).
 *
 * Every vector in this file is HAND-WRITTEN. That matters for what these tests are allowed to
 * claim: they show the arithmetic, the bounds and the tie-breaking are correct, and they show
 * NOTHING about the model. MOD-16 requires pinned golden fixtures compared against a qualified
 * conversion, MOD-17 requires real cross-modal retrieval, and MOD-19 requires measurements from
 * the built package on Windows CPU. Passing here is implementation evidence, never model
 * evidence.
 *
 * The fixtures are chosen so the expected answer is derivable rather than recorded: 2-dimensional
 * unit vectors at exact angles make cosines exact by construction, which is why so many cases
 * below are two numbers long. A test that stored an expected score copied from a previous run
 * would agree with whatever the code did last, including a regression.
 *
 * Requirement links: MOD-01, MOD-04, MOD-09, MOD-10, MOD-12, BASE-12.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  assertEmbeddingSpace,
  cosineSimilarity,
  deduplicateGroups,
  EMBEDDINGGEMMA2_DIMENSIONS,
  isEmbeddingGemma2Width,
  isUnitNorm,
  MAX_DEDUPLICATION_ITEMS,
  maySubstituteSilently,
  normalizeL2,
  rankBySimilarity,
  reduceDimensions,
  validateVector,
  type EmbeddingSpace,
  type IdentifiedVector,
} from '../src/vectors.ts'

/** A 2-dimensional unit vector at an angle in degrees; its cosines with others are exact. */
function unit2(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180
  return [Math.cos(radians), Math.sin(radians)]
}

/** A deterministic, non-degenerate vector of any width. */
function ramp(dimensions: number): number[] {
  return Array.from({ length: dimensions }, (_unused, index) => (index % 7) - 3 + index / (dimensions + 1))
}

/** The cosine between two unit vectors at the given angles, computed independently of the module. */
function expectedCosine(leftDegrees: number, rightDegrees: number): number {
  return Math.cos(((leftDegrees - rightDegrees) * Math.PI) / 180)
}

/** The unit vector a space names, with an optional recorded content id. */
function space(dimensions: number, overrides: Partial<EmbeddingSpace> = {}): EmbeddingSpace {
  return { modelId: 'embeddinggemma-2', dimensions, normalized: true, ...overrides }
}

const MINILM_384: EmbeddingSpace = { modelId: 'all-MiniLM-L6-v2', dimensions: 384, normalized: true }

describe('MOD-04 — a vector is finite numbers of a declared width', () => {
  it('accepts a finite vector of the declared width', () => {
    for (const dimensions of EMBEDDINGGEMMA2_DIMENSIONS) {
      assert.deepEqual(validateVector(ramp(dimensions), dimensions), { valid: true }, `${dimensions} dimensions`)
    }
  })

  it('rejects a wrong length and names both widths', () => {
    const verdict = validateVector(ramp(384), 768)
    assert.equal(verdict.valid, false)
    // Both numbers are in the reason: a caller told only "invalid vector" cannot tell a
    // wrong-width payload from a corrupt one.
    assert.match(verdict.valid === false ? verdict.reason : '', /384 dimension\(s\) where the space declares 768/)
  })

  it('rejects NaN at the index that holds it', () => {
    const vector = ramp(4)
    vector[2] = Number.NaN
    const verdict = validateVector(vector, 4)
    assert.equal(verdict.valid, false)
    // Naming the index is what makes a 768-wide failure diagnosable at all.
    assert.match(verdict.valid === false ? verdict.reason : '', /element 2 is NaN/)
  })

  it('rejects Infinity and -Infinity, and says which', () => {
    // A non-finite element must never be normalized away: it makes every downstream score NaN,
    // and MOD-04 requires rejecting it instead of repairing it silently.
    const positive = validateVector([1, Number.POSITIVE_INFINITY], 2)
    const negative = validateVector([1, Number.NEGATIVE_INFINITY], 2)
    assert.match(positive.valid === false ? positive.reason : '', /element 1 is Infinity/)
    assert.match(negative.valid === false ? negative.reason : '', /element 1 is -Infinity/)
  })

  it('rejects a non-numeric element', () => {
    const verdict = validateVector(['0.5', 0.5], 2)
    assert.equal(verdict.valid, false)
    assert.match(verdict.valid === false ? verdict.reason : '', /element 0 is a value of type string/)
  })

  it('rejects a non-array, including null', () => {
    for (const value of [null, undefined, 0.5, 'vector', { 0: 1, length: 1 }]) {
      assert.equal(validateVector(value, 2).valid, false, `${String(value)} must not pass as a vector`)
    }
  })

  it('does not accept an empty array for any declared width', () => {
    // An empty array satisfies "every element is finite" vacuously, which is exactly why the
    // declared width is checked first.
    assert.equal(validateVector([], 768).valid, false)
    assert.equal(validateVector([], 1).valid, false)
  })

  it('throws for a nonsense declared width rather than reporting a verdict', () => {
    // The width comes from the space, not from the payload, so a bad one is this code's defect
    // and not a property of the caller's input.
    for (const width of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => validateVector([1], width), /expectedDimensions must be a positive integer/)
    }
  })

  it('knows which widths the model produces and refuses the rest', () => {
    assert.deepEqual([...EMBEDDINGGEMMA2_DIMENSIONS], [768, 512, 256, 128])
    for (const dimensions of EMBEDDINGGEMMA2_DIMENSIONS) assert.equal(isEmbeddingGemma2Width(dimensions), true)
    // 384 is the MiniLM width: refusing it here is the same rule the space check enforces,
    // applied to a single number instead of a pair of spaces.
    for (const dimensions of [384, 1024, 0, -768]) assert.equal(isEmbeddingGemma2Width(dimensions), false)
  })
})

describe('BASE-12 — an embedding space does not silently become another', () => {
  it('refuses to let a 384-dimensional MiniLM vector stand in for a 768-dimensional one', () => {
    const embeddinggemma = space(768)
    assert.equal(maySubstituteSilently(MINILM_384, embeddinggemma), false)
    assert.throws(
      () => assertEmbeddingSpace(MINILM_384, embeddinggemma),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        // Both widths and the remedy, because the failure is otherwise unactionable: the
        // vectors are not comparable and the index has to be rebuilt.
        assert.match(message, /384/)
        assert.match(message, /768/)
        assert.match(message, /re-index/)
        return true
      },
    )
  })

  it('treats the same model at a reduced width as a DIFFERENT space', () => {
    // The subtle half of BASE-12: 512 and 768 both come from EmbeddingGemma 2, so a name-based
    // check would pass them and compare vectors that do not share a basis (MOD-04).
    assert.equal(maySubstituteSilently(space(512), space(768)), false)
    assert.throws(() => assertEmbeddingSpace(space(512), space(768)), /reduced width from the same model/)
  })

  it('refuses a normalization mismatch at equal width', () => {
    // A dot product over unnormalized vectors is not a cosine, so the two cannot be mixed even
    // though every dimension agrees.
    assert.equal(maySubstituteSilently(space(768, { normalized: false }), space(768)), true)
    assert.throws(
      () => assertEmbeddingSpace(space(768, { normalized: false }), space(768)),
      /unnormalized vectors where embeddinggemma-2 stores L2-normalized ones/,
    )
  })

  it('refuses two spaces whose recorded content ids differ', () => {
    assert.throws(
      () => assertEmbeddingSpace(
        space(768, { embeddingSpaceId: 'onnx-q8-rev-a' }),
        space(768, { embeddingSpaceId: 'onnx-fp32-rev-b' }),
      ),
      /embeddingSpaceIds differ/,
    )
  })

  it('refuses to assume a match when only one side records an id', () => {
    // MOD-03 requires the id to be computed from canonical content. A vector with no recorded
    // id cannot be SHOWN to be from the expected space, and MOD-14 refuses reuse that cannot be
    // shown to match.
    assert.throws(
      () => assertEmbeddingSpace(space(768, { embeddingSpaceId: 'onnx-q8-rev-a' }), space(768)),
      /records no embeddingSpaceId/,
    )
    assert.throws(
      () => assertEmbeddingSpace(space(768), space(768, { embeddingSpaceId: 'onnx-q8-rev-a' })),
      /records no embeddingSpaceId/,
    )
  })

  it('accepts the same space, so the check is not merely always-throwing', () => {
    assert.equal(maySubstituteSilently(space(768), space(768)), true)
    assert.doesNotThrow(() => assertEmbeddingSpace(space(768), space(768)))
    assert.doesNotThrow(() => assertEmbeddingSpace(
      space(256, { embeddingSpaceId: 'onnx-q8-rev-a' }),
      space(256, { embeddingSpaceId: 'onnx-q8-rev-a' }),
    ))
  })
})

describe('MOD-04 — normalization is idempotent and refuses what has no direction', () => {
  it('normalizes to unit norm and preserves direction', () => {
    const normalized = normalizeL2([3, 4])
    assert.ok(Math.abs(normalized[0] as number - 0.6) < 1e-15)
    assert.ok(Math.abs(normalized[1] as number - 0.8) < 1e-15)
    assert.equal(isUnitNorm(normalized), true)
    // Direction is the ratio between components, so scaling must not change it.
    const scaled = normalizeL2([30, 40])
    assert.deepEqual(normalized, scaled)
  })

  it('is idempotent: a second pass changes nothing at all', () => {
    const once = normalizeL2(ramp(768))
    const twice = normalizeL2(once)
    // Exact element equality, not "close enough": a vector that is re-scaled on every pass loses
    // its last bits each time, and a caller that normalizes before every use would then get
    // slightly different vectors from identical input.
    assert.deepEqual(twice, once)
  })

  it('leaves an already-normalized vector untouched', () => {
    const unit = [0.6, 0.8]
    const before = [...unit]
    const after = normalizeL2(unit)
    // Values unchanged AND the input not mutated: "left alone" is a property of the values, and
    // the copy is what stops a caller mutating the input through the result.
    assert.deepEqual(after, before)
    assert.deepEqual(unit, before)
    assert.notEqual(after, unit)
  })

  it('refuses a zero vector rather than inventing a direction', () => {
    // MOD-04 names this case explicitly: reject zero output rather than silently normalizing it.
    // Any unit vector returned here would be a fabricated answer.
    assert.throws(() => normalizeL2([0, 0, 0]), /zero vector has no direction/)
  })

  it('refuses a non-finite element instead of returning NaN', () => {
    assert.throws(() => normalizeL2([1, Number.NaN]), /element 1 is NaN/)
    assert.throws(() => normalizeL2([Number.POSITIVE_INFINITY, 1]), /element 0 is Infinity/)
  })

  it('refuses an empty vector', () => {
    assert.throws(() => normalizeL2([]), /empty vector has no norm/)
  })

  it('reports unit norm for a unit vector and not for a scaled one', () => {
    assert.equal(isUnitNorm([0.6, 0.8]), true)
    assert.equal(isUnitNorm([6, 8]), false)
    assert.equal(isUnitNorm([1e-9, 0]), false)
  })
})

describe('MOD-04 — the reduced-width route truncates and renormalizes exactly once', () => {
  it('reduces 768 to 256 by leading-dimension truncation followed by renormalization', () => {
    const full = normalizeL2(ramp(768))
    const reduced = reduceDimensions(full, 256)
    assert.equal(reduced.length, 256)
    assert.equal(isUnitNorm(reduced), true)
    // The truncation keeps the LEADING dimensions: dropping a component changes the direction,
    // which is why the result is a different space rather than a compression of the same one.
    const first = full[0] as number
    const scale = (reduced[0] as number) / first
    for (const index of [1, 2, 17, 255]) {
      assert.ok(
        Math.abs((reduced[index] as number) - (full[index] as number) * scale) < 1e-15,
        `dimension ${index} must keep its ratio to the leading dimension`,
      )
    }
    // And the renormalization is not decorative: the truncated vector is shorter than unit
    // length before it is applied, so a cosine against it would be scaled by the deficit.
    const truncated = full.slice(0, 256)
    assert.ok(Math.hypot(...truncated) < 1, 'the truncated vector must be shorter than unit length')
  })

  it('is a no-op on a vector that is already the requested width', () => {
    const full = normalizeL2(ramp(768))
    assert.deepEqual(reduceDimensions(full, 768), full)
  })

  it('refuses to widen a vector in place', () => {
    // The removed components cannot be recovered, so MOD-04's "stored vectors cannot change
    // dimension in place" is enforced here rather than left to a caller's discipline.
    assert.throws(() => reduceDimensions(normalizeL2(ramp(256)), 768), /re-embedded through the wider route/)
  })

  it('refuses a target width the model does not produce', () => {
    assert.throws(() => reduceDimensions(normalizeL2(ramp(768)), 384), /384 is not a width EmbeddingGemma 2 produces/)
  })
})

describe('MOD-09 — cosine similarity refuses its NaN cases explicitly', () => {
  it('is 1 for parallel unit vectors and -1 for opposite ones', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1)
  })

  it('is 0 for orthogonal vectors', () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  })

  it('is scale-invariant, which is why normalization does not change a cosine', () => {
    assert.equal(cosineSimilarity([2, 0], [5, 0]), 1)
    assert.equal(cosineSimilarity([3, 0], [0, 7]), 0)
    assert.ok(Math.abs(cosineSimilarity([3, 4], [6, 8]) - 1) < 1e-15)
  })

  it('refuses mismatched widths instead of returning NaN', () => {
    // This is the exact 768-against-384 case in arithmetic form: NaN would propagate into a
    // ranking silently, and because NaN compares false against every threshold, "no match" and
    // "broken input" would become the same answer.
    assert.throws(() => cosineSimilarity([1, 0], [1, 0, 0]), /received 2 and 3 dimensions/)
  })

  it('refuses a non-finite input', () => {
    assert.throws(() => cosineSimilarity([1, Number.NaN], [1, 0]), /element 1 is NaN/)
    assert.throws(() => cosineSimilarity([1, 0], [Number.POSITIVE_INFINITY, 0]), /element 0 is Infinity/)
  })

  it('refuses a zero vector, where a cosine is undefined', () => {
    assert.throws(() => cosineSimilarity([0, 0], [1, 0]), /undefined for a zero vector/)
    assert.throws(() => cosineSimilarity([1, 0], [0, 0]), /undefined for a zero vector/)
  })

  it('refuses an empty vector', () => {
    assert.throws(() => cosineSimilarity([], []), /two non-empty vectors/)
  })

  it('refuses elements too large to measure rather than reporting an infinite norm', () => {
    assert.throws(() => cosineSimilarity([1e200, 1e200], [1e200, 1e200]), /norm is not finite/)
  })

  it('stays inside [-1, 1] and finite across a sweep of angles', () => {
    for (let degrees = 0; degrees <= 360; degrees += 7) {
      const score = cosineSimilarity(unit2(0), unit2(degrees))
      assert.ok(Number.isFinite(score), `angle ${degrees} produced ${score}`)
      assert.ok(score >= -1 && score <= 1, `angle ${degrees} produced ${score}`)
      assert.ok(Math.abs(score - expectedCosine(0, degrees)) < 1e-12, `angle ${degrees}`)
    }
    // A vector with itself is 1 up to rounding, or clipped to exactly 1 within the documented
    // tolerance — never outside the range either way.
    const self = cosineSimilarity(ramp(768), ramp(768))
    assert.ok(self <= 1 && self > 1 - 1e-12)
  })
})

describe('MOD-10 — ranking is stable by construction', () => {
  const query = unit2(0)

  it('orders by descending score and preserves the caller ids', () => {
    const ranked = rankBySimilarity(query, [
      { id: 'far', vector: unit2(80) },
      { id: 'near', vector: unit2(10) },
      { id: 'middle', vector: unit2(45) },
    ], 3)
    assert.deepEqual(ranked.map(entry => entry.id), ['near', 'middle', 'far'])
    assert.ok(Math.abs((ranked[0]?.score ?? 0) - expectedCosine(0, 10)) < 1e-12)
  })

  it('breaks an exact tie by INPUT order, not by id', () => {
    // The ids are deliberately not in alphabetical order and the vectors are identical, so an
    // implementation that sorted by id, or relied on an unstable sort, would produce a
    // different answer from the one MOD-10 specifies.
    const tied: IdentifiedVector[] = [
      { id: 'c', vector: [1, 0] },
      { id: 'a', vector: [1, 0] },
      { id: 'b', vector: [1, 0] },
    ]
    assert.deepEqual(rankBySimilarity(query, tied, 3).map(entry => entry.id), ['c', 'a', 'b'])
    // The same candidates in a different input order produce that order: the tie-break follows
    // the input, so the result is reproducible from the request alone.
    const reordered: IdentifiedVector[] = [
      { id: 'a', vector: [1, 0] },
      { id: 'c', vector: [1, 0] },
      { id: 'b', vector: [1, 0] },
    ]
    assert.deepEqual(rankBySimilarity(query, reordered, 3).map(entry => entry.id), ['a', 'c', 'b'])
  })

  it('returns the same order every time for a fully tied input', () => {
    const many: IdentifiedVector[] = Array.from({ length: 12 }, (_unused, index) => ({
      id: `item-${index}`,
      vector: [1, 0],
    }))
    const first = rankBySimilarity(query, many, 12).map(entry => entry.id)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      assert.deepEqual(rankBySimilarity(query, many, 12).map(entry => entry.id), first)
    }
    assert.deepEqual(first, many.map(entry => entry.id))
  })

  it('rejects a non-positive or non-integer topK', () => {
    const candidates: IdentifiedVector[] = [{ id: 'one', vector: [1, 0] }]
    for (const topK of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => rankBySimilarity(query, candidates, topK), /topK must be a positive integer/)
    }
  })

  it('rejects a topK larger than the candidate count rather than returning fewer rows', () => {
    const candidates: IdentifiedVector[] = [{ id: 'one', vector: [1, 0] }, { id: 'two', vector: [0, 1] }]
    assert.throws(() => rankBySimilarity(query, candidates, 3), /exceeds the 2 candidate\(s\) supplied/)
    // The boundary itself is legal, so the check is a bound and not an off-by-one.
    assert.equal(rankBySimilarity(query, candidates, 2).length, 2)
  })

  it('returns exactly topK results when topK is in range', () => {
    const candidates: IdentifiedVector[] = [
      { id: 'a', vector: unit2(0) },
      { id: 'b', vector: unit2(30) },
      { id: 'c', vector: unit2(60) },
    ]
    assert.equal(rankBySimilarity(query, candidates, 1).length, 1)
    assert.deepEqual(rankBySimilarity(query, candidates, 1).map(entry => entry.id), ['a'])
    assert.deepEqual(rankBySimilarity(query, candidates, 2).map(entry => entry.id), ['a', 'b'])
  })

  it('rejects duplicate candidate ids, which would make the answer ambiguous', () => {
    assert.throws(
      () => rankBySimilarity(query, [
        { id: 'same', vector: [1, 0] },
        { id: 'same', vector: [0, 1] },
      ], 2),
      /duplicate candidate id "same"/,
    )
  })

  it('rejects an empty candidate id', () => {
    assert.throws(() => rankBySimilarity(query, [{ id: '', vector: [1, 0] }], 1), /empty id/)
  })

  it('rejects a candidate whose width differs from the query, naming the candidate', () => {
    assert.throws(
      () => rankBySimilarity([1, 0], [{ id: 'wrong-width', vector: [1, 0, 0] }], 1),
      /candidate "wrong-width" has 3 dimension\(s\) where the query has 2/,
    )
  })

  it('leaves the caller array in its original order', () => {
    // The ranking sorts a copy. A function that reordered its caller's array would make the
    // INPUT order the tie-break depends on change underneath the caller.
    const candidates: IdentifiedVector[] = [
      { id: 'a', vector: unit2(60) },
      { id: 'b', vector: unit2(0) },
      { id: 'c', vector: unit2(30) },
    ]
    rankBySimilarity(query, candidates, 3)
    assert.deepEqual(candidates.map(entry => entry.id), ['a', 'b', 'c'])
  })
})

describe('MOD-12 — grouping is greedy, deterministic and not transitive', () => {
  it('groups near-duplicates under the first item as representative', () => {
    const groups = deduplicateGroups([
      { id: 'a', vector: unit2(0) },
      { id: 'b', vector: unit2(30) },
      { id: 'c', vector: unit2(60) },
    ], 0.8)
    assert.deepEqual(groups.map(group => group.representativeId), ['a', 'c'])
    assert.deepEqual(groups[0]?.members.map(member => member.id), ['a', 'b'])
    assert.deepEqual(groups[1]?.members.map(member => member.id), ['c'])
    // Each member's score is relative to its OWN representative, not to the previous member.
    assert.ok(
      Math.abs((groups[0]?.members[1]?.score ?? 0) - expectedCosine(0, 30)) < 1e-12,
      'b is scored against a, not against the item that came before it',
    )
  })

  it('does not merge a chain merely because A is near B and B is near C', () => {
    // Similarity is not transitive, so c is compared with the representative a: cos(60°) = 0.5
    // is below the threshold, and c becomes its own group even though cos(b, c) = cos(30°)
    // would have qualified. Merging the chain would report a and c as duplicates, which they
    // are not.
    const groups = deduplicateGroups([
      { id: 'a', vector: unit2(0) },
      { id: 'b', vector: unit2(30) },
      { id: 'c', vector: unit2(60) },
    ], 0.8)
    assert.equal(groups.length, 2)
    assert.equal(groups.some(group => group.members.some(member => member.id === 'c') && group.representativeId === 'a'), false)
  })

  it('breaks a representative tie by representative order', () => {
    // The fixture is built for a BIT-IDENTICAL tie: [0.5, 0.5] has the same numerator against
    // either axis and one norm for both comparisons, so the two cosines are the same double
    // rather than merely close. The assertion below checks that premise, because a near-tie
    // would let any comparison order pass and the test would prove nothing.
    const diagonal = [0.5, 0.5]
    const toEast = cosineSimilarity(diagonal, [1, 0])
    const toNorth = cosineSimilarity(diagonal, [0, 1])
    assert.equal(toEast, toNorth, 'the fixture must produce an exact tie')

    const groups = deduplicateGroups([
      { id: 'east', vector: [1, 0] },
      { id: 'north', vector: [0, 1] },
      { id: 'diagonal', vector: diagonal },
    ], 0.7)
    // north is orthogonal to east, so it starts its own group; diagonal then ties between the two
    // representatives and joins the EARLIER one, which makes the grouping a function of the input
    // order rather than of comparison order or of the engine's iteration.
    assert.deepEqual(groups.map(group => group.representativeId), ['east', 'north'])
    assert.deepEqual(groups[0]?.members.map(member => member.id), ['east', 'diagonal'])
    assert.deepEqual(groups[1]?.members.map(member => member.id), ['north'])
  })

  it('puts the representative first with a score of exactly 1', () => {
    const groups = deduplicateGroups([
      { id: 'first', vector: [3, 4] },
      { id: 'second', vector: [3, 4] },
    ], 0.99)
    assert.deepEqual(groups[0]?.members[0], { id: 'first', score: 1 })
  })

  it('treats a score exactly at the threshold as qualifying', () => {
    // The threshold is a floor, and the fixture uses the computed cosine itself so the boundary
    // is exercised rather than approximated by a nearby decimal.
    const threshold = cosineSimilarity(unit2(0), unit2(30))
    const groups = deduplicateGroups([
      { id: 'a', vector: unit2(0) },
      { id: 'b', vector: unit2(30) },
    ], threshold)
    assert.equal(groups.length, 1)
  })

  it('groups deterministically across runs', () => {
    const items: IdentifiedVector[] = [
      { id: 'a', vector: unit2(0) },
      { id: 'b', vector: unit2(5) },
      { id: 'c', vector: unit2(90) },
      { id: 'd', vector: unit2(95) },
      { id: 'e', vector: unit2(180) },
    ]
    const first = deduplicateGroups(items, 0.9)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.deepEqual(deduplicateGroups(items, 0.9), first)
    }
  })

  it('returns no groups for no items', () => {
    assert.deepEqual(deduplicateGroups([], 0.9), [])
  })

  it('rejects a threshold outside the range a cosine can take', () => {
    // A threshold of 2 is met by nothing and one of -2 by everything, so either is a caller
    // error rather than a policy the caller could have meant.
    for (const threshold of [1.5, -1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => deduplicateGroups([{ id: 'a', vector: [1, 0] }], threshold), /threshold/)
    }
    // The extremes themselves are legal: 1 groups only exact duplicates, -1 groups everything.
    assert.equal(deduplicateGroups([{ id: 'a', vector: [1, 0] }], 1).length, 1)
    assert.equal(deduplicateGroups([{ id: 'a', vector: [1, 0] }, { id: 'b', vector: [0, 1] }], -1).length, 1)
  })

  it('rejects duplicate ids, an empty id and mismatched widths', () => {
    assert.throws(
      () => deduplicateGroups([{ id: 'x', vector: [1, 0] }, { id: 'x', vector: [0, 1] }], 0.9),
      /duplicate item id "x"/,
    )
    assert.throws(() => deduplicateGroups([{ id: '', vector: [1, 0] }], 0.9), /empty id/)
    assert.throws(
      () => deduplicateGroups([{ id: 'a', vector: [1, 0] }, { id: 'b', vector: [1, 0, 0] }], 0.9),
      /item "b" has 3 dimension\(s\) where "a" has 2/,
    )
  })

  it('rejects a zero vector, which has no direction to group by', () => {
    // The representative's own score is declared as exactly 1, and a zero vector's cosine with
    // itself is undefined — so a zero vector must be refused rather than recorded as a group of
    // one with a score that cannot exist.
    assert.throws(
      () => deduplicateGroups([{ id: 'zero', vector: [0, 0, 0] }], 0.9),
      /item "zero" is a zero vector/,
    )
  })

  it('refuses more items than the declared bound, before doing the quadratic work', () => {
    const tooMany: IdentifiedVector[] = Array.from(
      { length: MAX_DEDUPLICATION_ITEMS + 1 },
      (_unused, index) => ({ id: `item-${index}`, vector: [1, 0] }),
    )
    assert.throws(() => deduplicateGroups(tooMany, 0.9), /exceed the declared bound/)
    // The bound itself is legal.
    const atBound = tooMany.slice(0, MAX_DEDUPLICATION_ITEMS)
    assert.equal(deduplicateGroups(atBound, 0.9).length, 1)
  })
})
