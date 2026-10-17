/**
 * The deterministic decision maths (H5), model-free and mirroring the vendored
 * runtime's formulas so the tests can pin the mapping WITHOUT weights.
 *
 * The vendored laya-ts `common.js` is the authority for these formulas
 * (softmax, confidenceFromProbs, answerConfidence); this module re-states the
 * same arithmetic so the extension's boundary — logit → label → confidence —
 * is testable in isolation, and so a reviewer can see that the reported
 * confidence is EXACTLY the runtime's uncalibrated probability mass (DEC-08).
 */

/** The option-count bounds the vendored runtime enforces (structured.js). */
export const MAX_OPTIONS = 32
export const MAX_SCORE_LEVELS = 10

/** Softmax, mirroring the vendored common.js exactly. */
export function softmax(z: readonly number[]): number[] {
  const m = Math.max(...z)
  const e = z.map(v => Math.exp(v - m))
  const s = e.reduce((a, b) => a + b, 0)
  return e.map(v => v / s)
}

/** Probability mass on the reported answer — the vendored answerConfidence. */
export function answerConfidence(p: readonly number[]): number {
  if (p.length < 1) return 1
  return Math.min(1, Math.max(0, Math.max(...p)))
}

/** One boundary decision: logits → label + confidence. */
export interface BoundaryDecision {
  readonly index: number
  readonly label: string
  readonly confidence: number
  readonly probabilities: readonly number[]
}

/**
 * Map logits to a boundary decision: softmax, argmax, and ties broken by the
 * INPUT order of the labels (deterministic; the vendored runtime's stable
 * argmax does the same).
 */
export function decideFromLogits(labels: readonly string[], logits: readonly number[]): BoundaryDecision {
  if (labels.length === 0) throw new Error('at least one label is required')
  if (labels.length !== logits.length) throw new Error('one logit per label')
  const probabilities = softmax(logits)
  let index = 0
  for (let i = 1; i < probabilities.length; i += 1) {
    if (probabilities[i]! > probabilities[index]!) index = i
  }
  return {
    index,
    label: labels[index]!,
    confidence: answerConfidence(probabilities),
    probabilities,
  }
}

/**
 * Validate the caller's options: the bounds, the uniqueness and the shape the
 * schema enforces, re-asserted here so the runtime refusal is precise.
 */
export function validateOptions(options: readonly string[], max: number): string[] {
  if (!Array.isArray(options)) throw new Error('"options" must be an array of strings')
  if (options.length < 2) throw new Error(`at least 2 options are required, got ${options.length}`)
  if (options.length > max) throw new Error(`${options.length} options exceed the ${max}-option bound`)
  const seen = new Set<string>()
  for (const option of options) {
    if (typeof option !== 'string' || option.length === 0) throw new Error('every option must be a non-empty string')
    if (seen.has(option)) throw new Error(`duplicate option label ${JSON.stringify(option)} is refused`)
    seen.add(option)
  }
  return [...options]
}
