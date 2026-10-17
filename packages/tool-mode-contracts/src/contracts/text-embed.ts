/**
 * `text.embed` — the legacy MiniLM text-embedding contract (TOOL-04, BASE-12).
 *
 * Model-free: any conforming implementation binds to it. This is the 384-
 * dimensional MiniLM space, PRESERVED separately from the EmbeddingGemma 2
 * 768-dimensional space — the two must never be mixed, and a stored 384-d
 * index must never be quietly fed 768-wide vectors.
 *
 * @module @try-works/tool-mode-contracts/contracts/text-embed
 */

import { withMeta } from '../meta.ts'
import type { ToolContract } from '../registry.ts'

/** The `text.embed` contract at version 1.0.0. */
export const textEmbed: ToolContract = {
  contract: 'text.embed',
  version: '1.0.0',
  toolName: 'text_embed',
  description:
    'Embed a batch of texts into the legacy 384-dimensional MiniLM embedding space (mean pooling, '
    + 'L2-normalized, input order preserved). This is a compatibility space: stored 384-d vectors and '
    + 'indexes remain pinned to it, and switching to another model requires explicit re-embedding. '
    + 'All values are finite; an empty or overlong batch is refused, never silently truncated.',

  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['texts'],
    properties: {
      texts: {
        type: 'array',
        minItems: 1,
        maxItems: 32,
        items: { type: 'string', minLength: 1, maxLength: 32768 },
        description: 'The texts in the caller\'s order; that order is the embedding order (TOOL-04).',
      },
    },
  },

  outputSchema: withMeta(
    {
      embeddings: {
        type: 'array',
        items: {
          type: 'array',
          items: { type: 'number' },
          description: 'One 384-dimensional L2-normalized vector per input text, in input order.',
        },
      },
      dimensions: { const: 384 },
      normalized: { const: true },
    },
    ['embeddings', 'dimensions', 'normalized'],
  ),

  semantics: {
    scoreKind: 'none',
    calibrated: false,
    emptyInputMeaning: 'binding-error',
    appliesTo: 'written-text-only',
  },

  limits: {
    maxTexts: 32,
    maxInputCharacters: 32768,
    dimensions: 384,
  },

  unsupported: [
    'Mixing 384-dimensional and 768-dimensional vectors in one index.',
    'Silently truncating an overlong batch.',
  ],
}
