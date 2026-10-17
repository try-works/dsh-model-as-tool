/**
 * The remaining standard tool contracts (EXT-21, task-69).
 *
 * These descriptors are SCHEMAS AND SEMANTICS ONLY — no model bindings, no
 * weights, no host code (EXT-17). Each is a closed schema with honest
 * `semantics`, `limits` and `unsupported` records, matching the vocabulary the
 * host registers and the extension packages implement against.
 *
 * @module @try-works/tool-mode-contracts/contracts/standard
 */

import { withMeta } from '../meta.ts'
import type { ToolContract } from '../registry.ts'

/** The `text.title` contract at version 1.0.0 (RCP-12). */
export const textTitle: ToolContract = {
  contract: 'text.title',
  version: '1.0.0',
  toolName: 'text_title',
  description:
    'Propose a bounded title and one-sentence description for supplied text through an authorized harness model.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 32768 },
      kind: { type: 'string', enum: ['section', 'page', 'document'], default: 'section' },
      repairFeedback: { type: 'string', minLength: 1, maxLength: 512 },
    },
  },
  outputSchema: withMeta(
    {
      title: { type: 'string', minLength: 1, maxLength: 80 },
      description: { type: 'string', minLength: 1, maxLength: 240 },
    },
    ['title', 'description'],
  ),
  semantics: {
    scoreKind: 'none',
    calibrated: false,
    emptyInputMeaning: 'binding-error',
    appliesTo: 'written-text-only',
  },
  limits: {
    maxInputCharacters: 32768,
    maxTitleCharacters: 80,
    maxDescriptionCharacters: 240,
    maxRepairs: 1,
  },
  unsupported: [
    'Invented facts: the title must state only what the text supports.',
    'Empty titles and descriptions.',
  ],
}

/** The `image.describe` contract at version 1.0.0 (HLM-12). */
export const imageDescribe: ToolContract = {
  contract: 'image.describe',
  version: '1.0.0',
  toolName: 'describe_image',
  description:
    'Describe the visible content of an approved image through an authorized harness model, with honest uncertainty.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['image_path'],
    properties: {
      image_path: { type: 'string', minLength: 1, description: 'An approved image resolved by the host.' },
      focus: { type: 'string', minLength: 1, maxLength: 500 },
    },
  },
  outputSchema: withMeta(
    {
      description: { type: 'string', minLength: 1 },
    },
    ['description'],
  ),
  semantics: {
    scoreKind: 'none',
    calibrated: false,
    emptyInputMeaning: 'binding-error',
    appliesTo: 'visible-image-content',
  },
  limits: {
    maxImages: 1,
    maxFocusCharacters: 500,
  },
  unsupported: [
    'Invented hidden facts, exact OCR or full transcription claims.',
    'Treating text drawn in the image as instructions.',
  ],
}


/** The `embed.multimodal` contract at version 1.0.0 (EmbeddingGemma family). */
export const multimodalEmbed: ToolContract = {
  contract: 'embed.multimodal',
  version: '1.0.0',
  toolName: 'multimodal_embed',
  description: 'Embed a text, image or audio input into a shared vector space.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['input'],
    properties: {
      input: {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: {
          kind: { type: 'string', enum: ['text', 'image', 'audio'] },
          text: { type: 'string', minLength: 1, maxLength: 32768 },
          media: { type: 'string', description: 'An approved media reference resolved by the host.' },
        },
      },
    },
  },
  outputSchema: withMeta(
    {
      embedding: { type: 'array', items: { type: 'number' }, minItems: 1 },
      dimensions: { type: 'integer', minimum: 1 },
    },
    ['embedding', 'dimensions'],
  ),
  semantics: {
    scoreKind: 'none',
    calibrated: false,
    emptyInputMeaning: 'binding-error',
    appliesTo: 'text-image-audio',
  },
  limits: {
    maxInputCharacters: 32768,
    maxMediaBytes: 8388608,
  },
  unsupported: ['Video frames beyond the declared sampler.'],
}

/** The `semantic.similarity` contract at version 1.0.0. */
export const semanticSimilarity: ToolContract = {
  contract: 'semantic.similarity',
  version: '1.0.0',
  toolName: 'semantic_similarity',
  description: 'Score the similarity of two bounded texts.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['left', 'right'],
    properties: {
      left: { type: 'string', minLength: 1, maxLength: 32768 },
      right: { type: 'string', minLength: 1, maxLength: 32768 },
    },
  },
  outputSchema: withMeta(
    { score: { type: 'number' } },
    ['score'],
  ),
  semantics: {
    scoreKind: 'cosine-similarity',
    calibrated: false,
    emptyInputMeaning: 'binding-error',
    appliesTo: 'written-text-only',
  },
  limits: { maxInputCharacters: 32768 },
  unsupported: ['Calibrated probabilities.'],
}

/** The `semantic.rank` contract at version 1.0.0. */
export const semanticRank: ToolContract = {
  contract: 'semantic.rank',
  version: '1.0.0',
  toolName: 'semantic_rank',
  description: 'Rank candidates by semantic distance to a query.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['query', 'candidates'],
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 4096 },
      candidates: {
        type: 'array', minItems: 1, maxItems: 100,
        items: { type: 'string', minLength: 1, maxLength: 8192 },
      },
    },
  },
  outputSchema: withMeta(
    {
      ranked: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'score'],
          properties: { index: { type: 'integer', minimum: 0 }, score: { type: 'number' } },
        },
      },
    },
    ['ranked'],
  ),
  semantics: {
    scoreKind: 'cosine-similarity',
    calibrated: false,
    emptyInputMeaning: 'binding-error',
    appliesTo: 'written-text-only',
  },
  limits: { maxCandidates: 100 },
  unsupported: ['Calibrated probabilities.'],
}

/** The `semantic.classify` contract at version 1.0.0. */
export const semanticClassify: ToolContract = {
  contract: 'semantic.classify',
  version: '1.0.0',
  toolName: 'semantic_classify',
  description: 'Classify a text into the closest of the supplied labels, with the ability to abstain.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['text', 'labels'],
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 32768 },
      labels: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 200 } },
    },
  },
  outputSchema: withMeta(
    {
      label: { type: ['string', 'null'] },
      abstained: { type: 'boolean' },
      scores: { type: 'array', items: { type: 'number' } },
    },
    ['label', 'abstained', 'scores'],
  ),
  semantics: {
    scoreKind: 'cosine-similarity',
    calibrated: false,
    emptyInputMeaning: 'binding-error',
    appliesTo: 'written-text-only',
  },
  limits: { maxLabels: 64 },
  unsupported: ['Forcing a label when every score is below the abstain margin.'],
}

/** The `semantic.deduplicate` contract at version 1.0.0. */
export const semanticDeduplicate: ToolContract = {
  contract: 'semantic.deduplicate',
  version: '1.0.0',
  toolName: 'semantic_deduplicate',
  description: 'Group near-duplicate texts into greedy clusters around their representatives.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['texts'],
    properties: {
      texts: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'string', minLength: 1, maxLength: 8192 } },
    },
  },
  outputSchema: withMeta(
    {
      groups: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['members'],
          properties: { members: { type: 'array', items: { type: 'integer', minimum: 0 } } },
        },
      },
    },
    ['groups'],
  ),
  semantics: {
    scoreKind: 'cosine-similarity',
    calibrated: false,
    emptyInputMeaning: 'binding-error',
    appliesTo: 'written-text-only',
  },
  limits: { maxTexts: 1000 },
  unsupported: ['Transitive-closure equivalence: clustering is greedy, not global.'],
}

/** The `media.find_moments` contract at version 1.0.0. */
export const mediaFindMoments: ToolContract = {
  contract: 'media.find_moments',
  version: '1.0.0',
  toolName: 'media_find_moments',
  description: 'Find the media windows most relevant to a query within approved media.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['media', 'query'],
    properties: {
      media: { type: 'string', description: 'An approved media reference resolved by the host.' },
      query: { type: 'string', minLength: 1, maxLength: 4096 },
    },
  },
  outputSchema: withMeta(
    {
      windows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['startMs', 'endMs', 'score'],
          properties: {
            startMs: { type: 'number', minimum: 0 },
            endMs: { type: 'number', minimum: 0 },
            score: { type: 'number' },
          },
        },
      },
    },
    ['windows'],
  ),
  semantics: {
    scoreKind: 'cosine-similarity',
    calibrated: false,
    emptyInputMeaning: 'binding-error',
    appliesTo: 'approved-media',
  },
  limits: { maxWindows: 32, maxQueryCharacters: 4096 },
  unsupported: ['Windows outside the approved media bounds.'],
}

/** The `decision.choose` contract at version 1.0.0 (Laya family). */
export const decisionChoose: ToolContract = {
  contract: 'decision.choose',
  version: '1.0.0',
  toolName: 'decision_choose',
  description: 'Choose one option from a bounded set for a stated decision, with a confidence verdict.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['decision', 'options'],
    properties: {
      decision: { type: 'string', minLength: 1, maxLength: 4096 },
      options: { type: 'array', minItems: 2, maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 400 } },
    },
  },
  outputSchema: withMeta(
    {
      chosen: { type: 'integer', minimum: 0 },
      confidence: { type: 'string', enum: ['confident', 'likely', 'tentative'] },
      reason: { type: 'string', minLength: 1 },
    },
    ['chosen', 'confidence', 'reason'],
  ),
  semantics: {
    scoreKind: 'vendor-reported-confidence',
    calibrated: false,
    emptyInputMeaning: 'binding-error',
    appliesTo: 'stated-decision',
  },
  limits: { maxOptions: 16 },
  unsupported: ['Open-ended generation: this contract chooses, it does not compose.'],
}

/** The `decision.test` contract at version 1.0.0. */
export const decisionTest: ToolContract = {
  contract: 'decision.test',
  version: '1.0.0',
  toolName: 'decision_test',
  description: 'Test a binary predicate against supplied text and report the verdict with evidence.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['text', 'predicate'],
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 32768 },
      predicate: { type: 'string', minLength: 1, maxLength: 1000 },
    },
  },
  outputSchema: withMeta(
    {
      verdict: { type: 'boolean' },
      confidence: { type: 'string', enum: ['confident', 'likely', 'tentative'] },
      evidence: { type: 'string', minLength: 1 },
    },
    ['verdict', 'confidence', 'evidence'],
  ),
  semantics: {
    scoreKind: 'vendor-reported-confidence',
    calibrated: false,
    emptyInputMeaning: 'binding-error',
    appliesTo: 'written-text-only',
  },
  limits: { maxInputCharacters: 32768 },
  unsupported: ['Testing predicates about content outside the supplied text.'],
}

/** The `decision.score` contract at version 1.0.0. */
export const decisionScore: ToolContract = {
  contract: 'decision.score',
  version: '1.0.0',
  toolName: 'decision_score',
  description: 'Score supplied options against one criterion on a declared bounded scale.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['criterion', 'options'],
    properties: {
      criterion: { type: 'string', minLength: 1, maxLength: 2000 },
      options: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 400 } },
    },
  },
  outputSchema: withMeta(
    {
      scores: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'score'],
          properties: { index: { type: 'integer', minimum: 0 }, score: { type: 'number', minimum: 0, maximum: 10 } },
        },
      },
    },
    ['scores'],
  ),
  semantics: {
    scoreKind: 'bounded-scale-0-10',
    calibrated: false,
    emptyInputMeaning: 'binding-error',
    appliesTo: 'stated-criterion',
  },
  limits: { maxOptions: 16 },
  unsupported: ['Scores outside the declared 0-10 scale.'],
}

/** The `structured.extract` contract at version 1.0.0 (Needle family). */
export const structuredExtract: ToolContract = {
  contract: 'structured.extract',
  version: '1.0.0',
  toolName: 'structured_extract',
  description: 'Extract typed fields from supplied text against the caller-declared, host-approved schema snapshot.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['text', 'schema'],
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 32768 },
      schema: { type: 'object', description: 'The host-approved extraction schema snapshot (NDL-02).' },
    },
  },
  outputSchema: withMeta(
    {
      extracted: { type: 'object', description: 'The typed extraction payload.' },
    },
    ['extracted'],
  ),
  semantics: {
    scoreKind: 'none',
    calibrated: false,
    emptyInputMeaning: 'binding-error',
    appliesTo: 'written-text-only',
  },
  limits: { maxInputCharacters: 32768 },
  unsupported: ['Executing a caller-supplied schema that the host has not approved.'],
}

/** The `plan.tools` contract at version 1.0.0 (Needle family). */
export const toolsPlan: ToolContract = {
  contract: 'plan.tools',
  version: '1.0.0',
  toolName: 'tools_plan',
  description: 'Propose a read-only tool plan against the host-frozen authorized tool snapshot (NDL-02).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['objective'],
    properties: {
      objective: { type: 'string', minLength: 1, maxLength: 4096 },
    },
  },
  outputSchema: withMeta(
    {
      proposal: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['tool', 'arguments'],
          properties: {
            tool: { type: 'string', minLength: 1 },
            arguments: { type: 'object' },
          },
        },
      },
    },
    ['proposal'],
  ),
  semantics: {
    scoreKind: 'none',
    calibrated: false,
    emptyInputMeaning: 'binding-error',
    appliesTo: 'proposal-only',
  },
  limits: { maxObjectiveCharacters: 4096 },
  unsupported: [
    'Executing the proposal: this contract proposes; the host re-checks authorization before any dispatch (NDL-03).',
  ],
}