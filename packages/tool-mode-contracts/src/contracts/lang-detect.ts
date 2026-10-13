/**
 * `text.language_detect` — the language-identification contract (TOOL-03).
 *
 * TOOL-03 requires three things a naive wrapper loses: ambiguity must survive to
 * the caller, empty input has a defined answer rather than an exception, and the
 * score's MEANING is declared. It also forbids a specific mistake worth naming in
 * the schema: a text language detector is not evidence about the language spoken
 * in audio it never processed, so the contract says so instead of leaving a
 * caller to infer capability from a similar-looking tool.
 *
 * @module @try-works/tool-mode-contracts/contracts/lang-detect
 */

import { withMeta } from '../meta.ts'
import type { ToolContract } from '../registry.ts'

/** The `text.language_detect` contract at version 1.0.0. */
export const langDetect: ToolContract = {
  contract: 'text.language_detect',
  version: '1.0.0',
  toolName: 'lang_detect',
  description:
    'Identify the language of a short piece of text. Returns the best language, a reliability '
    + 'verdict and ranked alternatives, because short text is often genuinely ambiguous between '
    + 'related languages and collapsing that to one answer would overstate the result.',

  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: {
        type: 'string',
        minLength: 1,
        maxLength: 4096,
        description: 'The text to identify. Only the leading portion is examined.',
      },
      top: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        default: 3,
        description: 'How many ranked alternatives to return.',
      },
    },
  },

  outputSchema: withMeta(
    {
      language: { type: ['string', 'null'], description: 'Best candidate, or null when input had no language signal.' },
      reliability: {
        type: 'string',
        enum: ['confident', 'likely', 'tentative', 'unknown'],
        description: 'Vendor-reported verdict. Not a calibrated probability.',
      },
      tooCloseToCall: {
        type: 'boolean',
        description: 'True when the leading candidates are within the implementation\'s declared tie margin.',
      },
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['language', 'probability'],
          properties: {
            language: { type: 'string' },
            probability: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
    },
    ['reliability', 'tooCloseToCall', 'candidates'],
  ),

  semantics: {
    scoreKind: 'vendor-reported-probability',
    calibrated: false,
    ambiguityPreserved: true,
    emptyInputMeaning: 'null-language-with-empty-candidates',
    appliesTo: 'written-text-only',
  },

  limits: {
    maxInputCharacters: 4096,
    examinedCharacters: 512,
    maxCandidates: 20,
  },

  unsupported: [
    'Spoken language: this reads written text only. It is not evidence about the language spoken in audio it has not processed (TOOL-03).',
    'Translation or transliteration.',
    'Confident single answers for one or two words: those are frequently ambiguous and are reported as such.',
    'Documents beyond the examined prefix: only the leading characters are considered.',
  ],
}
