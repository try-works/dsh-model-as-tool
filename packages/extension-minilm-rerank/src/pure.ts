/**
 * The deterministic reranking maths, pure and model-free (TOOL-05).
 *
 * The cross-encoder produces one logit per query/document pair; the tie-stable
 * sort returns the caller's ids in descending score order with EXACT ties
 * broken by input order — no weights needed to establish this.
 */

/** One scored document. */
export interface ScoredDocument {
  readonly id: string
  readonly score: number
}

/**
 * Sort cross-encoder scores: descending score, then the original input order
 * for exact ties (TOOL-05: original ids, deterministic tie handling).
 * @param documents - the scored pairs in the caller's input order.
 * @returns the sorted result (the same ids, never synthesized ones).
 */
export function rankByLogit(documents: readonly ScoredDocument[]): readonly ScoredDocument[] {
  return [...documents]
    .map((document, index) => ({ ...document, index }))
    .sort((left, right) => (right.score - left.score) || (left.index - right.index))
    .map(({ id, score }) => ({ id, score }))
}
