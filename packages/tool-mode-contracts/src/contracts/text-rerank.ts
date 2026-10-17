/**
 * `text.rerank` — the cross-encoder reranking contract (TOOL-05).
 *
 * Model-free: any conforming implementation binds to it. The scores are
 * RANKING LOGITS from a cross-encoder — not embedding cosines, and the two
 * score kinds are never interchangeable (the semantic_rank tool's
 * cosine_similarity is a different quantity).
 *
 * @module @try-works/tool-mode-contracts/contracts/text-rerank
 */

import { withMeta } from '../meta.ts'
import type { ToolContract } from '../registry.ts'

/** The `text.rerank` contract at version 1.0.0. */
export const textRerank: ToolContract = {
  contract: 'text.rerank',
  version: '1.0.0',
  toolName: 'text_rerank',
  description:
    'Score query/document pairs with a cross-encoder and return the caller\'s own ids in descending '
    + 'ranking-logit order with exact ties broken by input order. The scores are cross-encoder '
    + 'logits (scoreKind "ranking_logit"), NOT embedding cosines: the two are not interchangeable. '
    + 'A positive top_k within the candidate count is required when supplied.',

  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['query', 'documents'],
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 32768 },
      documents: {
        type: 'array',
        minItems: 1,
        maxItems: 256,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'text'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 128 },
            text: { type: 'string', minLength: 1, maxLength: 32768 },
          },
        },
        description: 'The documents in the caller\'s order; that order breaks exact score ties (TOOL-05).',
      },
      top_k: { type: 'integer', minimum: 1, maximum: 256 },
    },
  },

  outputSchema: withMeta(
    {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'score'],
          properties: {
            id: { type: 'string' },
            score: { type: 'number' },
          },
        },
      },
      scoreKind: { const: 'ranking_logit' },
    },
    ['results', 'scoreKind'],
  ),

  semantics: {
    scoreKind: 'ranking-logit',
    calibrated: false,
    emptyInputMeaning: 'binding-error',
    appliesTo: 'written-text-only',
  },

  limits: {
    maxDocuments: 256,
    maxInputCharacters: 32768,
    maxTopK: 256,
  },

  unsupported: [
    'Treating ranking logits as embedding cosines.',
    'Negative or zero top_k when supplied.',
  ],
}
