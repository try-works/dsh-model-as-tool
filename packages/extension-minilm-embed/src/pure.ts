/**
 * The deterministic MiniLM maths, pure and model-free (TOOL-04).
 *
 * Mean pooling over the real token rows, L2 normalization, and the tie-stable
 * ranking sort — every function here runs without weights, so the pooling and
 * normalization recipe is established by test before any inference exists.
 */

/**
 * Mean-pool the last hidden state over the token axis.
 *
 * The MiniLM recipe: average the REAL token rows (the caller's `tokens` count
 * — the graph may carry padding rows the mask selects out; the bounded adapter
 * feeds one sequence at a time, so every row is real here).
 * @param hidden - [tokens, width] floats, row-major.
 * @param tokens - the row count.
 * @returns the pooled [width] vector.
 */
export function meanPool(hidden: Float32Array, tokens: number): Float32Array {
  if (tokens <= 0) throw new Error('meanPool requires at least one token row')
  const width = hidden.length / tokens
  if (!Number.isInteger(width)) throw new Error('the hidden state does not divide into token rows')
  const pooled = new Float32Array(width)
  for (let row = 0; row < tokens; row += 1) {
    for (let col = 0; col < width; col += 1) {
      pooled[col] = (pooled[col] as number) + (hidden[row * width + col] as number)
    }
  }
  for (let col = 0; col < width; col += 1) {
    pooled[col] = (pooled[col] as number) / tokens
  }
  return pooled
}

/**
 * L2-normalize a vector (TOOL-04: the MiniLM recipe normalizes after pooling).
 *
 * A zero vector has no direction and is REFUSED — a normalized zero would
 * fabricate a unit vector from nothing.
 */
export function normalize(vector: Float32Array): Float32Array {
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm)
  if (norm === 0) throw new Error('a zero vector has no direction and cannot be normalized (TOOL-04)')
  const out = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i += 1) out[i] = (vector[i] as number) / norm
  return out
}

/** Every normalized value is finite (TOOL-04's finiteness rule). */
export function allFinite(vector: readonly number[]): boolean {
  return vector.every(Number.isFinite)
}

/** The pinned space width — 384, never the 768 of the EmbeddingGemma 2 space. */
export const MINILM_DIMENSIONS = 384
