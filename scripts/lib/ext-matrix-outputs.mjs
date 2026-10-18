/**
 * Fixtures and output validators for the extension matrix (task-111).
 *
 * WHAT THIS MODULE IS. The extension matrix installs and activates all eight
 * first-party Tool Mode extensions, invokes every tool or contract they
 * contribute with a committed fixture, and then has to answer one question per
 * call: does the ACTUAL output the host returned satisfy the contract the
 * package DECLARED, and does it pass the semantic checks that a schema cannot
 * express (a correctly-shaped 383-dimensional vector is still a broken
 * embedding)?
 *
 * WHAT IT DELIBERATELY IS NOT. It does not install, prepare, enable or
 * dispatch anything, and it does not decide whether an extension loaded. The
 * harness (task-110) owns the lifecycle and records load failures separately;
 * this module judges only a result it is handed. That split is what lets a
 * load failure and a WRONG RESULT be reported as different things instead of
 * collapsing into one opaque FAIL.
 *
 * DEPENDENCY-FREE ON PURPOSE. `scripts/ext-matrix.mjs` runs from the repository
 * root as plain ESM, on a machine that may have no installed root dependencies.
 * This module therefore imports only `node:fs`, `node:path`, `node:url`, the
 * committed WAV header reader and the local JSON-Schema subset validator.
 *
 * THE IMPORT CONTRACT (frozen with task-110):
 *
 *   import { MATRIX_TOOLS, loadInput, validateToolOutput, summarizeVerdicts,
 *            FIXTURE_DIR, FIXTURE_FILES } from '<repo>/scripts/lib/ext-matrix-outputs.mjs'
 *
 *   for (const entry of MATRIX_TOOLS) {
 *     const args = loadInput(entry.input, options.inputDir)   // JSON-serializable
 *     const result = await invoke(entry.toolName, args)        // full ToolExecutionResult
 *     const verdict = validateToolOutput(entry.id, result)
 *   }
 *   const summary = summarizeVerdicts(verdicts)
 *
 * `validateToolOutput` accepts the FULL host result object
 * (`{isError, value?, content, meta?}` as returned by `ctx.tools.execute`), an
 * MCP-shaped result (`{isError, structuredContent?, content}`), or a bare
 * payload. A refusal-shaped result is reported as `ok: false` with a
 * `refusal` string rather than thrown, so the harness can print the exact
 * host refusal instead of losing it.
 *
 * @module scripts/lib/ext-matrix-outputs
 */

/* oxlint-disable anti-slop/no-runtime-typeof */
/*
 * Justification for the disable above: this module IS the I/O boundary the rule
 * asks for. It validates host- and model-produced JSON that no TypeScript
 * declaration can describe (the whole point of the matrix is that a tool may
 * return a shape its contract does not declare). Every `typeof` below is a
 * declared-schema check on that boundary, not a representation shortcut after
 * parsing; the domain value is the verdict object returned by
 * `validateToolOutput`, whose keys and types are fixed.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compileSubset } from './json-schema-subset.mjs'
import { parseWave } from '../voz-wav.mjs'

/** The repository root, found from this module's own location. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The committed fixture root. */
export const FIXTURE_DIR = join(REPO_ROOT, 'packages', 'dsh-model-as-tool', 'tests', 'fixtures', 'ext-matrix')

/** Where the committed argument fixtures live, relative to a fixture root. */
const INPUTS_REL = 'inputs'

/** Where the binary fixtures live, relative to a fixture root. */
const ASSETS_REL = 'assets'

// ---------------------------------------------------------------------------
// Fixture-backed helpers
// ---------------------------------------------------------------------------

/** Read and parse one JSON file; a missing or malformed fixture is a named error. */
function readJsonFile(file) {
  if (!existsSync(file)) throw new Error(`the fixture file ${file} does not exist`)
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`the fixture file ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The fixture root for a call: an explicit override wins, else the committed root. */
function fixtureRoot(inputDir) {
  return typeof inputDir === 'string' && inputDir.trim() !== '' ? resolve(inputDir) : FIXTURE_DIR
}

/** Resolve one relative asset reference to an existing file, or fail by name. */
function assetPath(reference, root) {
  if (isAbsolute(reference)) return reference
  const cleaned = reference.startsWith('./') ? reference.slice(2) : reference
  for (const candidate of [join(root, cleaned), join(FIXTURE_DIR, cleaned)]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `the fixture asset ${JSON.stringify(reference)} does not exist under ${join(root, cleaned)} `
    + `or ${join(FIXTURE_DIR, cleaned)}`,
  )
}

/**
 * Rewrite relative asset references into what the host tool expects.
 *
 * - A plain `path` string becomes an ABSOLUTE path (stt_transcribe, the
 *   embeddinggemma media parts, media_find_moments).
 * - An object carrying `mediaType` and `path` is read and becomes the typed
 *   media form `{ mediaType, bytes }` that the declarative image recipe takes
 *   at the tool boundary. It is deliberately NOT a path: passing a path as text
 *   lets a text-only model invent a description of an image it never received.
 *
 * Everything else is copied unchanged, so an override directory holding the
 * same layout works without a second code path.
 */
function rewriteAssets(value, root) {
  if (Array.isArray(value)) return value.map(item => rewriteAssets(item, root))
  if (typeof value !== 'object' || value === null) return value
  if (
    typeof value.mediaType === 'string'
    && typeof value.path === 'string'
    && value.bytes === undefined
  ) {
    const file = assetPath(value.path, root)
    return { mediaType: value.mediaType, bytes: [...readFileSync(file)] }
  }
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    out[key] = key === 'path' && typeof entry === 'string'
      ? assetPath(entry, root)
      : rewriteAssets(entry, root)
  }
  return out
}

/**
 * Load one fixture argument object for the harness.
 *
 * The second argument is the harness's `--input-dir` override. It is optional:
 * an empty or omitted value means the committed fixture root. A fixture id that
 * is not in {@link MATRIX_TOOLS} is treated as a fixture NAME, which is what
 * the offline tests use for the extra language and silence fixtures.
 *
 * @param {string} id - a matrix id (`lang_detect`) or fixture name (`lang-detect-fr`).
 * @param {string} [inputDir] - an override fixture root.
 * @returns {Record<string, unknown>} JSON-serializable tool arguments.
 */
export function loadInput(id, inputDir) {
  const entry = MATRIX_TOOLS.find(candidate => candidate.id === id)
  const name = entry === undefined ? id : entry.input
  const root = fixtureRoot(inputDir)
  const candidates = [
    join(root, INPUTS_REL, `${name}.json`),
    join(root, `${name}.json`),
  ]
  const file = candidates.find(candidate => existsSync(candidate))
  if (file === undefined) {
    throw new Error(`the fixture ${JSON.stringify(id)} is not in MATRIX_TOOLS and no input file exists at ${candidates[0]}`)
  }
  return rewriteAssets(readJsonFile(file), root)
}

// ---------------------------------------------------------------------------
// The matrix: one entry per contributed tool or contract
// ---------------------------------------------------------------------------

/**
 * Every invocation the matrix performs, in extension order.
 *
 * `kind: 'tool'` means the extension's manifest declares a `tools` entry for it;
 * `kind: 'contract'` means the extension declares only an IMPLEMENTATION of a
 * standard contract, so the host publishes the contract's `toolName`
 * (`text_embed`, `text_rerank`, `text_title`, `describe_image`) and that name is
 * what the harness invokes. `schemaPath`, when present, is the exact
 * output-schema file the manifest declares — the offline suite asserts each
 * path still matches the manifest, so this table cannot drift from the packages.
 */
export const MATRIX_TOOLS = Object.freeze([
  {
    id: 'lang_detect',
    extension: '@try-works/extension-desert-ant-tongue',
    kind: 'tool',
    toolName: 'lang_detect',
    contractId: 'tool-mode/lang_detect',
    input: 'lang-detect',
    schemaPath: 'packages/extension-desert-ant-tongue/schemas/lang-detect.output.json',
    expected: { language: 'en' },
    checks: [
      'output-schema', 'language-is-iso6391', 'language-top-guess', 'reliability-verdict',
      'too-close-to-call-boolean', 'candidate-probabilities', 'candidates-present', 'candidates-rank-consistent',
    ],
    note: 'The long English fixture must be detected as en with the top candidate agreeing; probabilities are the vendor\'s uncalibrated values, only bounded here.',
  },
  {
    id: 'stt_transcribe',
    extension: '@try-works/extension-desert-ant-voz',
    kind: 'tool',
    toolName: 'stt_transcribe',
    contractId: 'tool-mode/stt_transcribe',
    input: 'stt-transcribe',
    schemaPath: 'packages/extension-desert-ant-voz/schemas/stt-transcribe.output.json',
    checks: [
      'output-schema', 'transcript-text-is-string', 'coverage-shape',
      'coverage-within-audio', 'words-shape', 'words-within-audio', 'silent-audio-empty-transcript',
    ],
    note: 'The fixture is a synthesized 2 s tone, NOT speech: this proves decoding, contract shape and duration-bounded coverage only. It cannot prove word accuracy, and no check here claims it. The silence fixture is used only by the offline honest-empty test.',
  },
  {
    id: 'decision_choose',
    extension: '@try-works/extension-laya',
    kind: 'tool',
    toolName: 'decision_choose',
    contractId: '@try-works/extension-laya/decision_choose',
    input: 'decision-choose',
    schemaPath: 'packages/extension-laya/schema/decision-choose.output.json',
    checks: [
      'output-schema', 'not-calibrated', 'chosen-is-option', 'confidence-in-range',
      'probabilities-are-probabilities', 'abstain-consistency',
    ],
    note: 'Every confidence is explicitly uncalibrated (DEC-08); the checks bound it and require the chosen label to be one of the caller\'s options.',
  },
  {
    id: 'decision_test',
    extension: '@try-works/extension-laya',
    kind: 'tool',
    toolName: 'decision_test',
    contractId: '@try-works/extension-laya/decision_test',
    input: 'decision-test',
    schemaPath: 'packages/extension-laya/schema/decision-test.output.json',
    checks: [
      'output-schema', 'not-calibrated', 'decision-is-boolean-vocabulary',
      'confidence-in-range', 'probabilities-are-probabilities', 'abstain-consistency',
    ],
    note: 'The decision must be yes/no/null, never a free-form string; confidence is uncalibrated.',
  },
  {
    id: 'decision_score',
    extension: '@try-works/extension-laya',
    kind: 'tool',
    toolName: 'decision_score',
    contractId: '@try-works/extension-laya/decision_score',
    input: 'decision-score',
    schemaPath: 'packages/extension-laya/schema/decision-score.output.json',
    checks: [
      'output-schema', 'not-calibrated', 'score-is-level', 'confidence-in-range',
      'probabilities-are-probabilities', 'abstain-consistency',
    ],
    note: 'The returned level must be one of the caller\'s ordinal levels; confidence is uncalibrated.',
  },
  {
    id: 'tools_plan',
    extension: '@try-works/extension-needle',
    kind: 'tool',
    toolName: 'tools_plan',
    contractId: '@try-works/extension-needle/tools_plan',
    input: 'tools-plan',
    schemaPath: 'packages/extension-needle/schema/tools-plan.output.json',
    checks: [
      'output-schema', 'plan-has-proposals', 'plan-proposals-valid',
      'plan-rejections-empty', 'plan-names-offered', 'plan-proposals-are-data',
    ],
    note: 'The fixture names only structured_extract, a REAL tool registered by the same extension, because the host correctly refuses a plan over unregistered names. A valid single-step plan is proposals with offered=true, valid=true and no rejections; proposals are inert data.',
  },
  {
    id: 'structured_extract',
    extension: '@try-works/extension-needle',
    kind: 'tool',
    toolName: 'structured_extract',
    contractId: '@try-works/extension-needle/structured_extract',
    input: 'structured-extract',
    schemaPath: 'packages/extension-needle/schema/structured-extract.output.json',
    checks: [
      'output-schema', 'extraction-shape', 'proposed-flag-consistent',
      'extraction-matches-caller-schema', 'valid-flag-consistent', 'issues-shape', 'issues-published',
    ],
    note: 'The extraction must satisfy the CALLER schema in the fixture, and the package\'s own valid/issues report must agree with an independent re-validation; a blob is never accepted as an extraction.',
  },
  {
    id: 'text_embed',
    extension: '@try-works/extension-minilm-embed',
    kind: 'contract',
    toolName: 'text_embed',
    contractId: 'text.embed',
    input: 'text-embed',
    checks: [
      'output-schema', 'embedding-count', 'dimensions-384', 'embedding-normalized',
      'embedding-finite', 'embedding-related-closer',
    ],
    note: 'Contract text.embed. The 384-d space is the legacy MiniLM space and is never mixed with the 768-d EmbeddingGemma space. The measured norms and the two cosines are reported.',
  },
  {
    id: 'text_rerank',
    extension: '@try-works/extension-minilm-rerank',
    kind: 'contract',
    toolName: 'text_rerank',
    contractId: 'text.rerank',
    input: 'text-rerank',
    checks: [
      'output-schema', 'rerank-ids-preserved', 'rerank-score-monotone',
      'rerank-relevant-first', 'rerank-logit-score-kind',
    ],
    note: 'Contract text.rerank. Scores are RANKING LOGITS, not embedding cosines; the relevant document (doc-a) must rank first and scores must be monotone with the returned order.',
  },
  {
    id: 'multimodal_embed',
    extension: '@try-works/extension-embeddinggemma',
    kind: 'tool',
    toolName: 'multimodal_embed',
    contractId: '@try-works/extension-embeddinggemma/multimodal_embed',
    input: 'multimodal-embed',
    schemaPath: 'packages/extension-embeddinggemma/schema/multimodal-embed.output.json',
    checks: [
      'output-schema', 'vectors-match-items', 'vector-dimensions', 'vector-normalized',
      'vector-finite', 'vector-record-fields', 'processing-record', 'processing-truncated-false',
    ],
    note: 'Two items in one shared space: a text and a real PNG image. A missing vision asset makes the provider refuse by name, which the harness records separately; this validator only judges a returned output.',
  },
  {
    id: 'semantic_similarity',
    extension: '@try-works/extension-embeddinggemma',
    kind: 'tool',
    toolName: 'semantic_similarity',
    contractId: '@try-works/extension-embeddinggemma/semantic_similarity',
    input: 'semantic-similarity',
    schemaPath: 'packages/extension-embeddinggemma/schema/semantic-similarity.output.json',
    checks: [
      'output-schema', 'similarity-range', 'similarity-score-kind',
      'similarity-space-id', 'similarity-processing-both-sides',
    ],
    note: 'A cosine in [-1,1] with its scoreKind and space declared; it is not a probability that the two mean the same thing.',
  },
  {
    id: 'semantic_rank',
    extension: '@try-works/extension-embeddinggemma',
    kind: 'tool',
    toolName: 'semantic_rank',
    contractId: '@try-works/extension-embeddinggemma/semantic_rank',
    input: 'semantic-rank',
    schemaPath: 'packages/extension-embeddinggemma/schema/semantic-rank.output.json',
    checks: [
      'output-schema', 'rank-count', 'rank-ids-preserved', 'rank-scores-descending',
      'rank-relevant-first', 'rank-score-kind',
    ],
    note: 'The caller\'s ids are preserved, the scores descend with the order, and the rollback document ranks first for a rollback query.',
  },
  {
    id: 'semantic_classify',
    extension: '@try-works/extension-embeddinggemma',
    kind: 'tool',
    toolName: 'semantic_classify',
    contractId: '@try-works/extension-embeddinggemma/semantic_classify',
    input: 'semantic-classify',
    schemaPath: 'packages/extension-embeddinggemma/schema/semantic-classify.output.json',
    checks: [
      'output-schema', 'classify-status', 'classify-label-allowed',
      'classify-scores-complete', 'classify-not-calibrated',
    ],
    note: 'An embedding label scorer is NOT the dedicated decision model: calibrated is always false and the selected label must be one of the caller\'s label ids.',
  },
  {
    id: 'semantic_deduplicate',
    extension: '@try-works/extension-embeddinggemma',
    kind: 'tool',
    toolName: 'semantic_deduplicate',
    contractId: '@try-works/extension-embeddinggemma/semantic_deduplicate',
    input: 'semantic-deduplicate',
    schemaPath: 'packages/extension-embeddinggemma/schema/semantic-deduplicate.output.json',
    checks: [
      'output-schema', 'dedup-groups-shape', 'dedup-covers-items', 'dedup-representative-member',
      'dedup-scores-range', 'dedup-algorithm-threshold',
    ],
    note: 'Greedy representative grouping: every input id appears exactly once, each representative is one of its own members, and grouping is explicitly not transitive.',
  },
  {
    id: 'media_find_moments',
    extension: '@try-works/extension-embeddinggemma',
    kind: 'tool',
    toolName: 'media_find_moments',
    contractId: '@try-works/extension-embeddinggemma/media_find_moments',
    input: 'media-find-moments',
    schemaPath: 'packages/extension-embeddinggemma/schema/media-find-moments.output.json',
    checks: [
      'output-schema', 'moments-matches-present', 'moment-windows-ordered',
      'moment-window-bounds', 'moments-windows-evaluated', 'moments-audio-no-video-frames',
    ],
    note: 'AUDIO media over the committed 2 s WAV. This is embedding retrieval, not transcription. VIDEO is not attempted by this fixture: the committed asset set has no video, so the matrix reports audio support only and does not claim video.',
  },
  {
    id: 'text_title',
    extension: '@try-works/extension-declarative-recipes',
    kind: 'contract',
    toolName: 'text_title',
    contractId: 'text.title',
    input: 'text-title',
    checks: [
      'title-strict-json', 'title-length', 'description-length',
      'title-grounding', 'title-no-invented-numbers',
    ],
    note: 'Contract text.title served as a declarative recipe. The recipe asks for ONE JSON object, so prose or a code fence is refused. The title must share a content word with the source and must not introduce a number the source does not contain.',
  },
  {
    id: 'image_describe',
    extension: '@try-works/extension-declarative-recipes',
    kind: 'contract',
    toolName: 'describe_image',
    contractId: 'image.describe',
    input: 'image-describe',
    checks: [
      'description-shape', 'description-visible-content',
      'description-not-filename', 'description-not-placeholder',
    ],
    note: 'Contract image.describe served as a declarative recipe. The PNG is real typed media, and the description must name visible content (the red rectangle / blue circle / white field) rather than echo the filename or a placeholder.',
  },
])

/** Every extra committed input that is not itself a matrix invocation. */
const EXTRA_INPUTS = Object.freeze([
  'lang-detect-fr', 'lang-detect-de', 'lang-detect-ja', 'lang-detect-zh', 'lang-detect-ambiguous',
  'stt-transcribe-silence',
])

/** Every committed fixture file, for the harness report and the offline inventory test. */
export const FIXTURE_FILES = Object.freeze([
  'README.md',
  'build-fixtures.mjs',
  ...MATRIX_TOOLS.map(entry => `${INPUTS_REL}/${entry.input}.json`),
  ...EXTRA_INPUTS.map(name => `${INPUTS_REL}/${name}.json`),
  `${ASSETS_REL}/tiny-canvas.png`,
  `${ASSETS_REL}/tone-2s-16k-mono.wav`,
  `${ASSETS_REL}/silence-1s-16k-mono.wav`,
])

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

/** The shared Tool Mode envelope, copied from `@try-works/tool-mode-contracts/meta.ts`. */
const TOOL_META_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'contract', 'contractVersion', 'implementationId', 'extension',
    'extensionVersion', 'activationGeneration', 'executionLocation',
    'receiptId', 'warnings',
  ],
  properties: {
    contract: { type: 'string', minLength: 1 },
    contractVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    implementationId: { type: 'string', minLength: 1 },
    extension: { type: 'string', minLength: 1 },
    extensionVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+' },
    activationGeneration: { type: 'integer', minimum: 0 },
    executionLocation: { type: 'string', enum: ['host', 'device', 'team-server', 'remote'] },
    receiptId: { type: 'string', minLength: 1 },
    warnings: { type: 'array', items: { type: 'string' } },
  },
}

/** Compose a closed contract output schema with the shared envelope. */
function withMeta(payload, requiredPayload) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...requiredPayload, 'meta'],
    properties: { ...payload, meta: TOOL_META_SCHEMA },
  }
}

/**
 * The output schemas of the FOUR contract-only entries, copied from
 * `packages/tool-mode-contracts/src/contracts/{text-embed,text-rerank}.ts`.
 *
 * The packages declare these, not the extensions, and this module cannot import
 * a workspace package from a dependency-free root script. The offline suite
 * asserts the property/required sets still match the contracts package, so this
 * copy is pinned rather than trusted.
 */
const CONTRACT_OUTPUT_SCHEMAS = Object.freeze({
  'text.embed': withMeta({
    embeddings: {
      type: 'array',
      items: { type: 'array', items: { type: 'number' } },
    },
    dimensions: { const: 384 },
    normalized: { const: true },
  }, ['embeddings', 'dimensions', 'normalized']),
  'text.rerank': withMeta({
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'score'],
        properties: { id: { type: 'string' }, score: { type: 'number' } },
      },
    },
    scoreKind: { const: 'ranking_logit' },
  }, ['results', 'scoreKind']),
})

/**
 * The CALLER-FACING `tools_plan` input schema (NDL-02).
 *
 * The extension's shipped input schema is its PROVIDER contract (full tool
 * declarations), while the host advertises and validates this narrower shape:
 * the caller names tools as strings and the host turns those names into the
 * frozen snapshot entries. The fixture therefore uses THIS shape, and the
 * offline suite pins the copy against `packages/dsh-model-as-tool/src/planning.ts`.
 */
export const HOST_PLANNING_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['request', 'tools'],
  properties: {
    request: { type: 'string', minLength: 1, maxLength: 32_768 },
    tools: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', minLength: 1 } },
    system: { type: 'string', maxLength: 4_096 },
    max_new_tokens: { type: 'integer', minimum: 16, maximum: 4_096 },
  },
})

/**
 * The caller-facing input schemas of the TWO minilm contracts, copied from
 * `packages/tool-mode-contracts/src/contracts/{text-embed,text-rerank}.ts`.
 * The offline suite pins the property/required sets against the package.
 */
const CONTRACT_INPUT_SCHEMAS = Object.freeze({
  'text.embed': {
    type: 'object',
    additionalProperties: false,
    required: ['texts'],
    properties: {
      texts: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 32_768 } },
    },
  },
  'text.rerank': {
    type: 'object',
    additionalProperties: false,
    required: ['query', 'documents'],
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 32_768 },
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
            text: { type: 'string', minLength: 1, maxLength: 32_768 },
          },
        },
      },
      top_k: { type: 'integer', minimum: 1, maximum: 256 },
    },
  },
})

/** The packages that own each extension id, for manifest/schema reads. */
const EXTENSION_PACKAGES = Object.freeze({
  '@try-works/extension-desert-ant-tongue': 'extension-desert-ant-tongue',
  '@try-works/extension-desert-ant-voz': 'extension-desert-ant-voz',
  '@try-works/extension-laya': 'extension-laya',
  '@try-works/extension-needle': 'extension-needle',
  '@try-works/extension-minilm-embed': 'extension-minilm-embed',
  '@try-works/extension-minilm-rerank': 'extension-minilm-rerank',
  '@try-works/extension-embeddinggemma': 'extension-embeddinggemma',
  '@try-works/extension-declarative-recipes': 'extension-declarative-recipes',
})

/** Read one extension's manifest. */
function readManifest(entry) {
  const packageName = EXTENSION_PACKAGES[entry.extension]
  if (packageName === undefined) throw new Error(`no package is mapped for the extension ${entry.extension}`)
  const file = join(REPO_ROOT, 'packages', packageName, 'tool-mode.extension.json')
  return readJsonFile(file)
}

/** Convert a declarative recipe's per-property `required` flags into a root schema. */
function recipeInputSchema(recipe) {
  const properties = {}
  const required = []
  for (const [name, raw] of Object.entries(recipe.inputs ?? {})) {
    const declaration = isRecord(raw) ? raw : {}
    const property = {}
    for (const [key, value] of Object.entries(declaration)) {
      if (key === 'required' || key === 'description' || key === 'mediaTypes' || key === 'maxBytes') continue
      property[key] = value
    }
    if (declaration.type === 'image') {
      // The tool boundary carries typed media in its JSON-safe form, not a path.
      properties[name] = {
        type: 'object',
        additionalProperties: false,
        required: ['mediaType', 'bytes'],
        properties: {
          mediaType: { type: 'string', enum: Array.isArray(declaration.mediaTypes) ? declaration.mediaTypes : ['image/png'] },
          bytes: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 255 } },
        },
      }
    } else {
      properties[name] = property
    }
    if (declaration.required === true) required.push(name)
  }
  return { type: 'object', additionalProperties: false, required, properties }
}

/**
 * The caller-facing input schema a committed fixture must satisfy.
 *
 * Three cases exist, and conflating them would validate a fixture against the
 * wrong contract:
 * - a manifest-declared TOOL uses the schema in its package;
 * - `tools_plan` uses the HOST's planning schema, because the host brokers the
 *   caller's tool NAMES into the extension's provider contract;
 * - a CONTRACT-only implementation uses the standard contract's schema, or the
 *   declarative recipe's declared inputs for `text.title`/`image.describe`.
 * @param {{id?: string, extension: string, kind: string, toolName: string, contractId?: string}} entry - a matrix entry.
 * @returns {{schema: Record<string, unknown>, source: string}} the schema and where it came from.
 */
export function callerInputSchemaFor(entry) {
  if (entry.id === 'tools_plan') {
    return { schema: HOST_PLANNING_INPUT_SCHEMA, source: 'packages/dsh-model-as-tool/src/planning.ts#PLANNING_TOOL_INPUT_SCHEMA' }
  }
  if (entry.contractId !== undefined && CONTRACT_INPUT_SCHEMAS[entry.contractId] !== undefined) {
    return {
      schema: CONTRACT_INPUT_SCHEMAS[entry.contractId],
      source: `tool-mode-contracts#${entry.contractId}.inputSchema`,
    }
  }
  if (entry.extension === '@try-works/extension-declarative-recipes') {
    const recipeFile = entry.id === 'text_title' ? 'text-title.json' : 'describe-image.json'
    const recipe = readJsonFile(join(REPO_ROOT, 'packages', 'extension-declarative-recipes', 'recipes', recipeFile))
    return { schema: recipeInputSchema(recipe), source: `extension-declarative-recipes/recipes/${recipeFile}` }
  }
  const manifest = readManifest(entry)
  const tool = (Array.isArray(manifest.tools) ? manifest.tools : []).find(candidate => candidate.name === entry.toolName)
  if (tool === undefined || typeof tool.inputSchema !== 'string') {
    throw new Error(`the manifest for ${entry.extension} declares no input schema for ${entry.toolName}`)
  }
  const file = join(REPO_ROOT, 'packages', EXTENSION_PACKAGES[entry.extension], tool.inputSchema)
  return { schema: readJsonFile(file), source: `${EXTENSION_PACKAGES[entry.extension]}/${tool.inputSchema}` }
}

/**
 * Validate one committed fixture argument object against the caller-facing
 * schema the host actually advertises for that tool.
 * @param {string} id - a matrix id.
 * @param {Record<string, unknown>} [input] - loaded input; loaded from the fixture when omitted.
 * @returns {{ok: boolean, issues: string[], source: string}} the fixture verdict.
 */
export function validateFixtureInput(id, input) {
  const entry = MATRIX_TOOLS.find(candidate => candidate.id === id)
  if (entry === undefined) return { ok: false, issues: [`${JSON.stringify(id)} is not a MATRIX_TOOLS id`], source: 'none' }
  const { schema, source } = callerInputSchemaFor(entry)
  const value = input !== undefined ? input : loadInput(entry.input)
  const issues = validatorFor(`input:${id}`, schema)(value)
  return { ok: issues.length === 0, issues, source }
}

/** The declared output schema for one matrix id, for the offline drift test. */
export function declaredOutputSchemaFor(id) {
  const entry = MATRIX_TOOLS.find(candidate => candidate.id === id)
  return entry === undefined ? undefined : outputSchemaFor(entry)
}

/** Cache of compiled validators, keyed by schema identity. */
const compiled = new Map()

/** Compile (once) and return a schema validator from a cache key. */
function validatorFor(key, schema) {
  const existing = compiled.get(key)
  if (existing !== undefined) return existing
  const validate = compileSubset(schema)
  compiled.set(key, validate)
  return validate
}

/** The declared output schema for an entry, read from its committed fixture path. */
function outputSchemaFor(entry) {
  if (entry.contractId !== undefined && CONTRACT_OUTPUT_SCHEMAS[entry.contractId] !== undefined) {
    return CONTRACT_OUTPUT_SCHEMAS[entry.contractId]
  }
  if (typeof entry.schemaPath !== 'string') return undefined
  const file = join(REPO_ROOT, entry.schemaPath)
  const schema = readJsonFile(file)
  return schema
}

// ---------------------------------------------------------------------------
// Result normalisation
// ---------------------------------------------------------------------------

/** Parse JSON only when the text looks like a JSON document. */
function tryJsonObject(text) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { ok: false, value: undefined }
  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch {
    return { ok: false, value: undefined }
  }
}

/** Concatenate the text blocks of a host/MCP result content array. */
function textFromContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * Extract the payload a validator should judge, and tell a refusal apart from a
 * malformed result.
 *
 * Handles, in order: an MCP/DSH error result (`isError: true`), the canonical
 * `value` of a DSH ToolExecutionSuccess, an MCP `structuredContent`, a bare
 * `payload`/`result`, a JSON text block, a plain string (the declarative
 * recipes return the model's text as the value), and finally a direct payload
 * object (what the offline GOOD/BAD fabrications pass).
 * @param {unknown} output - the result the harness holds.
 * @returns {{kind:'success', payload:unknown} | {kind:'refusal', message:string} | {kind:'unknown', reason:string}}
 */
export function normalizeToolResult(output) {
  if (output === undefined || output === null) {
    return { kind: 'unknown', reason: 'the tool returned no result at all (undefined/null)' }
  }
  if (typeof output === 'string') {
    const parsed = tryJsonObject(output)
    return { kind: 'success', payload: parsed.ok ? parsed.value : output }
  }
  if (typeof output !== 'object' || Array.isArray(output)) {
    return { kind: 'unknown', reason: `the tool returned a ${Array.isArray(output) ? 'array' : typeof output}, not a result object` }
  }
  if (output.isError === true) {
    const error = output.error
    const fromError = typeof error === 'string'
      ? error
      : typeof error === 'object' && error !== null && typeof error.message === 'string'
        ? error.message
        : ''
    const fromContent = textFromContent(output.content)
    const message = [fromError, fromContent].filter(part => part !== '').join(' — ').slice(0, 800)
    return { kind: 'refusal', message: message === '' ? 'the host reported a tool error with no message' : message }
  }
  if (Object.hasOwn(output, 'value') && output.value !== undefined) {
    return { kind: 'success', payload: output.value }
  }
  if (Object.hasOwn(output, 'structuredContent') && output.structuredContent !== undefined) {
    return { kind: 'success', payload: output.structuredContent }
  }
  if (Object.hasOwn(output, 'payload') && output.payload !== undefined) {
    return { kind: 'success', payload: output.payload }
  }
  const contentText = textFromContent(output.content)
  if (contentText !== '') {
    const parsed = tryJsonObject(contentText)
    return { kind: 'success', payload: parsed.ok ? parsed.value : contentText }
  }
  if (Object.hasOwn(output, 'result') && output.result !== undefined) {
    return normalizeToolResult(output.result)
  }
  // A direct payload object: the offline tests and a bare contract payload.
  return { kind: 'success', payload: output }
}

// ---------------------------------------------------------------------------
// Small check helpers
// ---------------------------------------------------------------------------

/** Append one named check. */
function check(checks, name, ok, detail) {
  checks.push(typeof detail === 'string' && detail !== '' ? { name, ok, detail } : { name, ok })
}

/** Whether a value is a plain JSON object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a finite number, or undefined. */
function numberOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** L2 norm of a numeric array. */
function norm(values) {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
}

/** Cosine similarity of two equal-length numeric arrays. */
function cosine(left, right) {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm)
  return denominator === 0 ? 0 : dot / denominator
}

/** Every entry is a finite number. */
function allFinite(values) {
  return Array.isArray(values) && values.every(value => typeof value === 'number' && Number.isFinite(value))
}

/** Character count by code point. */
function lengthOf(text) {
  return [...text].length
}

/** The content words of a text, for the title-grounding checks. */
function contentWords(text) {
  const stop = new Set([
    'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'your', 'you',
    'this', 'that', 'is', 'are', 'be', 'it', 'at', 'by', 'as', 'how', 'what', 'why',
  ])
  return new Set((text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []).filter(word => !stop.has(word)))
}

/** Every number appearing in a string, as written. */
function numbersIn(text) {
  return text.match(/\d+(?:[.,]\d+)*/g) ?? []
}

// ---------------------------------------------------------------------------
// Per-tool semantic validators
// ---------------------------------------------------------------------------

/** lang_detect: ISO-639-1 code in the candidates, top guess, bounded probabilities. */
function validateLangDetect(payload, context) {
  const { checks, entry, options } = context
  const expected = Object.hasOwn(options, 'expectedLanguage') ? options.expectedLanguage : entry.expected?.language
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
  check(
    checks,
    'language-is-iso6391',
    payload.language === null || (typeof payload.language === 'string' && /^[a-z]{2}$/.test(payload.language)),
    `language=${JSON.stringify(payload.language)}`,
  )
  check(
    checks,
    'language-top-guess',
    expected === undefined || payload.language === expected,
    `expected ${JSON.stringify(expected)}, saw ${JSON.stringify(payload.language)}`,
  )
  check(
    checks,
    'reliability-verdict',
    ['confident', 'likely', 'tentative', 'unknown'].includes(payload.reliability),
    `reliability=${JSON.stringify(payload.reliability)}`,
  )
  check(checks, 'too-close-to-call-boolean', typeof payload.tooCloseToCall === 'boolean')
  const probabilitiesValid = Array.isArray(payload.candidates) && candidates.every(candidate =>
    isRecord(candidate)
    && typeof candidate.language === 'string'
    && numberOf(candidate.probability) !== undefined
    && candidate.probability >= 0
    && candidate.probability <= 1)
  check(checks, 'candidate-probabilities', probabilitiesValid, `${candidates.length} candidate(s)`)
  check(
    checks,
    'candidates-present',
    expected === undefined || expected === null || candidates.length > 0,
    `${candidates.length} candidate(s) for an expected ${JSON.stringify(expected)}`,
  )
  check(
    checks,
    'candidates-rank-consistent',
    payload.language === null || candidates.length === 0 || candidates[0]?.language === payload.language,
    `top candidate=${JSON.stringify(candidates[0]?.language ?? null)}`,
  )
}

/** stt_transcribe: shape plus duration-bounded coverage and word timings. */
function validateSttTranscribe(payload, context) {
  const { checks, input } = context
  const duration = audioDurationSeconds(input)
  check(checks, 'transcript-text-is-string', typeof payload.text === 'string')
  const coverage = isRecord(payload.coverage) ? payload.coverage : undefined
  const coverageWellFormed = coverage !== undefined
    && typeof coverage.complete === 'boolean'
    && numberOf(coverage.transcribedSeconds) !== undefined
    && coverage.transcribedSeconds >= 0
    && (coverage.totalSeconds === null || coverage.totalSeconds === undefined || numberOf(coverage.totalSeconds) !== undefined)
    && (coverage.reason === null || coverage.reason === undefined || typeof coverage.reason === 'string')
  check(checks, 'coverage-shape', coverageWellFormed)
  if (duration !== undefined && coverage !== undefined) {
    const transcribed = numberOf(coverage.transcribedSeconds) ?? -1
    check(
      checks,
      'coverage-within-audio',
      transcribed <= duration + 0.15,
      `transcribedSeconds=${transcribed} audio=${duration}s`,
    )
  } else {
    check(checks, 'coverage-within-audio', false, 'the audio duration could not be measured from the fixture WAV')
  }
  const words = payload.words
  const wordsWellFormed = words === null || words === undefined || (Array.isArray(words) && words.every(word =>
    isRecord(word)
    && typeof word.text === 'string'
    && numberOf(word.start) !== undefined
    && numberOf(word.end) !== undefined
    && word.start >= 0
    && word.start <= word.end))
  check(checks, 'words-shape', wordsWellFormed, Array.isArray(words) ? `${words.length} word(s)` : String(words))
  if (Array.isArray(words) && duration !== undefined) {
    const bounded = words.every(word => numberOf(word.end) !== undefined && word.end <= duration + 0.15)
    check(checks, 'words-within-audio', bounded, `audio=${duration}s`)
  } else {
    check(checks, 'words-within-audio', true, Array.isArray(words) ? 'no measurable duration' : 'no word timings returned')
  }
  /**
   * A SILENT fixture is the honest empty-input case. This check runs only when
   * the referenced WAV is digital silence, so it can never punish a tone or real
   * speech. It asserts the two things an honest implementation owes silence: an
   * empty transcript, and zero transcribed seconds. Invented words fail here.
   */
  const silence = audioSilence(input)
  if (silence !== undefined && silence.silent) {
    const transcribed = coverage === undefined ? undefined : numberOf(coverage.transcribedSeconds)
    check(
      checks,
      'silent-audio-empty-transcript',
      typeof payload.text === 'string'
        && payload.text.trim() === ''
        && transcribed === 0,
      `text=${JSON.stringify((payload.text ?? '').slice(0, 80))} transcribedSeconds=${String(transcribed)}`,
    )
  }
}

/** decision_choose: one of the offered options (or an honest abstention). */
function validateDecisionChoose(payload, context) {
  const { checks, input } = context
  const options = Array.isArray(input.options) ? input.options : []
  check(checks, 'not-calibrated', payload.calibrated === false)
  check(checks, 'chosen-is-option', payload.chosen === null || options.includes(payload.chosen), `chosen=${JSON.stringify(payload.chosen)}`)
  check(checks, 'confidence-in-range', numberOf(payload.confidence) !== undefined && payload.confidence >= 0 && payload.confidence <= 1, `confidence=${payload.confidence}`)
  check(checks, 'probabilities-are-probabilities', probabilitiesValid(payload.probabilities))
  check(
    checks,
    'abstain-consistency',
    payload.abstained === true
      ? payload.chosen === null
      : payload.abstained === false && options.includes(payload.chosen),
    `abstained=${payload.abstained}, chosen=${JSON.stringify(payload.chosen)}`,
  )
}

/** decision_test: yes/no/null decision with uncalibrated confidence. */
function validateDecisionTest(payload, context) {
  const { checks } = context
  check(checks, 'not-calibrated', payload.calibrated === false)
  check(
    checks,
    'decision-is-boolean-vocabulary',
    payload.decision === null || payload.decision === 'yes' || payload.decision === 'no',
    `decision=${JSON.stringify(payload.decision)}`,
  )
  check(checks, 'confidence-in-range', numberOf(payload.confidence) !== undefined && payload.confidence >= 0 && payload.confidence <= 1)
  check(checks, 'probabilities-are-probabilities', probabilitiesValid(payload.probabilities))
  check(
    checks,
    'abstain-consistency',
    payload.abstained === true ? payload.decision === null : payload.abstained === false && payload.decision !== null,
    `abstained=${payload.abstained}, decision=${JSON.stringify(payload.decision)}`,
  )
}

/** decision_score: one of the caller's ordinal levels. */
function validateDecisionScore(payload, context) {
  const { checks, input } = context
  const levels = Array.isArray(input.levels) ? input.levels : []
  check(checks, 'not-calibrated', payload.calibrated === false)
  check(checks, 'score-is-level', payload.score === null || levels.includes(payload.score), `score=${JSON.stringify(payload.score)}`)
  check(checks, 'confidence-in-range', numberOf(payload.confidence) !== undefined && payload.confidence >= 0 && payload.confidence <= 1)
  check(checks, 'probabilities-are-probabilities', probabilitiesValid(payload.probabilities))
  check(
    checks,
    'abstain-consistency',
    payload.abstained === true ? payload.score === null : payload.abstained === false && levels.includes(payload.score),
    `abstained=${payload.abstained}, score=${JSON.stringify(payload.score)}`,
  )
}

/** Whether a decision family `probabilities` object is a bounded score map. */
function probabilitiesValid(probabilities) {
  if (!isRecord(probabilities)) return false
  const values = Object.values(probabilities)
  return values.length > 0 && values.every(value => numberOf(value) !== undefined && value >= 0 && value <= 1)
}

/** tools_plan: one valid, offered, inert proposal and no host rejections. */
function validateToolsPlan(payload, context) {
  const { checks, input } = context
  const offeredNames = Array.isArray(input.tools) ? input.tools.filter(name => typeof name === 'string') : []
  const proposals = Array.isArray(payload.proposals) ? payload.proposals : []
  const rejected = Array.isArray(payload.rejected) ? payload.rejected : []
  check(checks, 'plan-has-proposals', proposals.length >= 1, `${proposals.length} proposal(s)`)
  const proposalsValid = proposals.length > 0 && proposals.every(proposal =>
    isRecord(proposal)
    && typeof proposal.name === 'string'
    && isRecord(proposal.arguments)
    && proposal.offered === true
    && proposal.valid === true
    && Array.isArray(proposal.issues)
    && proposal.issues.length === 0)
  check(checks, 'plan-proposals-valid', proposalsValid)
  check(checks, 'plan-rejections-empty', rejected.length === 0, `${rejected.length} rejection(s)`)
  const namesOffered = proposals.every(proposal => offeredNames.includes(proposal.name))
  check(checks, 'plan-names-offered', namesOffered, `offered=${JSON.stringify(offeredNames)}`)
  check(
    checks,
    'plan-proposals-are-data',
    proposals.every(proposal => !Object.hasOwn(proposal, 'execute') && !Object.hasOwn(proposal, 'handle') && !Object.hasOwn(proposal, 'result')),
    'proposals carry only name/arguments/offered/valid/issues',
  )
}

/** structured_extract: the extraction satisfies the CALLER schema, or is an honest null. */
function validateStructuredExtract(payload, context) {
  const { checks, input } = context
  const extraction = payload.extraction
  const proposed = payload.proposed
  const valid = payload.valid
  const issues = Array.isArray(payload.issues) ? payload.issues : undefined
  check(checks, 'extraction-shape', extraction === null || isRecord(extraction), `extraction=${extraction === null ? 'null' : typeof extraction}`)
  check(checks, 'proposed-flag-consistent', typeof proposed === 'boolean' && (proposed === (extraction !== null)))
  check(checks, 'issues-shape', issues !== undefined && issues.every(issue => typeof issue === 'string'))
  if (extraction !== null && isRecord(extraction) && isRecord(input.schema)) {
    const violations = validatorFor(`caller:${JSON.stringify(input.schema)}`, input.schema)(extraction)
    check(checks, 'extraction-matches-caller-schema', violations.length === 0, violations.slice(0, 6).join('; '))
    check(
      checks,
      'valid-flag-consistent',
      valid === (violations.length === 0),
      `valid=${valid} but the independent re-validation found ${violations.length} violation(s)`,
    )
    if (valid !== true) {
      check(checks, 'issues-published', (issues ?? []).length > 0, 'a non-valid extraction must publish its violations')
    }
  } else {
    check(checks, 'extraction-matches-caller-schema', extraction === null, 'no extraction to validate')
    check(checks, 'valid-flag-consistent', valid === false, 'a null extraction cannot be reported valid')
  }
}

/** text_embed: 384-d unit vectors; related texts closer than the unrelated one. */
function validateTextEmbed(payload, context) {
  const { checks, input } = context
  const texts = Array.isArray(input.texts) ? input.texts : []
  const embeddings = Array.isArray(payload.embeddings) ? payload.embeddings : []
  check(checks, 'embedding-count', embeddings.length === texts.length, `${embeddings.length} vectors for ${texts.length} texts`)
  check(checks, 'dimensions-384', payload.dimensions === 384, `dimensions=${payload.dimensions}`)
  check(checks, 'embedding-normalized', payload.normalized === true)
  const wellFormed = embeddings.length > 0 && embeddings.every(vector => Array.isArray(vector) && vector.length === 384 && allFinite(vector))
  check(checks, 'embedding-finite', wellFormed)
  if (!wellFormed || texts.length < 3) return
  const norms = embeddings.map(vector => norm(vector))
  const unit = norms.every(value => Math.abs(value - 1) <= 0.02)
  check(
    checks,
    'embedding-normalized',
    payload.normalized === true && unit,
    `measured norms ${norms.map(value => value.toFixed(4)).join(', ')}`,
  )
  const related = cosine(embeddings[0], embeddings[1])
  const unrelated = cosine(embeddings[0], embeddings[2])
  check(
    checks,
    'embedding-related-closer',
    related > unrelated + 0.02,
    `cos(related)=${related.toFixed(4)} cos(unrelated)=${unrelated.toFixed(4)}`,
  )
}

/** text_rerank: caller ids preserved, logit scores monotone, relevant doc first. */
function validateTextRerank(payload, context) {
  const { checks, input } = context
  const documents = Array.isArray(input.documents) ? input.documents : []
  const expectedIds = documents.map(document => document.id)
  const results = Array.isArray(payload.results) ? payload.results : []
  check(checks, 'rerank-logit-score-kind', payload.scoreKind === 'ranking_logit', `scoreKind=${JSON.stringify(payload.scoreKind)}`)
  const idsPreserved = results.length === expectedIds.length
    && results.every(result => expectedIds.includes(result.id))
    && new Set(results.map(result => result.id)).size === expectedIds.length
  check(checks, 'rerank-ids-preserved', idsPreserved, `results=${JSON.stringify(results.map(result => result.id))}`)
  const monotone = results.every((result, index) =>
    numberOf(result.score) !== undefined
    && (index === 0 || result.score <= results[index - 1].score + 1e-9))
  check(checks, 'rerank-score-monotone', monotone)
  const first = results[0]?.id
  const relevant = results.find(result => result.id === 'doc-a')
  const irrelevant = results.filter(result => result.id === 'doc-c' || result.id === 'doc-d')
  check(
    checks,
    'rerank-relevant-first',
    first === 'doc-a'
      && relevant !== undefined
      && irrelevant.every(result => numberOf(result.score) !== undefined && relevant.score > result.score),
    `first=${JSON.stringify(first)}`,
  )
}

/** multimodal_embed: one unit vector per item, with its processing record. */
function validateMultimodalEmbed(payload, context) {
  const { checks, input } = context
  const items = Array.isArray(input.items) ? input.items : []
  const dimensions = typeof input.dimensions === 'number' ? input.dimensions : 768
  const vectors = Array.isArray(payload.vectors) ? payload.vectors : []
  const processing = Array.isArray(payload.processing) ? payload.processing : []
  check(checks, 'vectors-match-items', vectors.length === items.length, `${vectors.length} vectors for ${items.length} items`)
  const vectorsWellFormed = vectors.every((vector, index) =>
    isRecord(vector)
    && vector.id === items[index]?.id
    && vector.dimensions === dimensions
    && Array.isArray(vector.values)
    && vector.values.length === dimensions
    && allFinite(vector.values))
  check(checks, 'vector-dimensions', vectorsWellFormed, `dimensions=${dimensions}`)
  if (vectorsWellFormed) {
    const norms = vectors.map(vector => norm(vector.values))
    check(
      checks,
      'vector-normalized',
      vectors.every(vector => vector.normalized === true) && norms.every(value => Math.abs(value - 1) <= 0.02),
      `measured norms ${norms.map(value => value.toFixed(4)).join(', ')}`,
    )
  } else {
    check(checks, 'vector-normalized', false, 'the vectors could not be measured')
  }
  check(checks, 'vector-finite', vectorsWellFormed)
  check(
    checks,
    'vector-record-fields',
    vectors.every(vector =>
      isRecord(vector)
      && typeof vector.embeddingSpaceId === 'string'
      && vector.embeddingSpaceId.length > 0
      && vector.purpose === input.purpose
      && vector.role === input.role),
  )
  const processingValid = processing.length === items.length && processing.every((record, index) =>
    isRecord(record)
    && record.id === items[index]?.id
    && Array.isArray(record.modalities)
    && record.modalities.length > 0
    && Array.isArray(record.sourceRanges)
    && Array.isArray(record.sampledVideoFrames)
    && Array.isArray(record.observedAudioSampleRates))
  check(checks, 'processing-record', processingValid)
  check(checks, 'processing-truncated-false', processing.every(record => record.truncated === false))
}

/** semantic_similarity: a declared cosine in one space. */
function validateSemanticSimilarity(payload, context) {
  const { checks } = context
  check(checks, 'similarity-range', numberOf(payload.score) !== undefined && payload.score >= -1 && payload.score <= 1, `score=${payload.score}`)
  check(checks, 'similarity-score-kind', payload.scoreKind === 'cosine_similarity')
  check(checks, 'similarity-space-id', typeof payload.embeddingSpaceId === 'string' && payload.embeddingSpaceId.length > 0)
  check(checks, 'similarity-processing-both-sides', Array.isArray(payload.processing) && payload.processing.length >= 2)
}

/** semantic_rank: caller ids, descending cosines, the relevant candidate first. */
function validateSemanticRank(payload, context) {
  const { checks, input } = context
  const candidates = Array.isArray(input.candidates) ? input.candidates : []
  const candidateIds = candidates.map(candidate => candidate.id)
  const topK = typeof input.top_k === 'number' ? input.top_k : candidateIds.length
  const results = Array.isArray(payload.results) ? payload.results : []
  check(checks, 'rank-count', results.length === topK, `${results.length} results, top_k=${topK}`)
  check(
    checks,
    'rank-ids-preserved',
    results.length > 0
      && results.every(result => candidateIds.includes(result.id))
      && new Set(results.map(result => result.id)).size === results.length,
  )
  check(
    checks,
    'rank-scores-descending',
    results.every((result, index) => numberOf(result.score) !== undefined
      && result.score >= -1 && result.score <= 1
      && (index === 0 || result.score <= results[index - 1].score + 1e-9)),
  )
  check(checks, 'rank-relevant-first', results[0]?.id === 'rank-rollback', `first=${JSON.stringify(results[0]?.id)}`)
  check(checks, 'rank-score-kind', payload.scoreKind === 'cosine_similarity')
}

/** semantic_classify: an allowed label, full scores, never calibrated. */
function validateSemanticClassify(payload, context) {
  const { checks, input } = context
  const labels = Array.isArray(input.labels) ? input.labels : []
  const labelIds = labels.map(label => label.id)
  check(checks, 'classify-status', payload.status === 'selected' || payload.status === 'abstained', `status=${JSON.stringify(payload.status)}`)
  check(
    checks,
    'classify-label-allowed',
    payload.status === 'selected' && typeof payload.label === 'string' && labelIds.includes(payload.label),
    `label=${JSON.stringify(payload.label)} allowed=${JSON.stringify(labelIds)}`,
  )
  const scores = Array.isArray(payload.scores) ? payload.scores : []
  const scoresComplete = scores.length === labelIds.length
    && scores.every((entry, index) => isRecord(entry)
      && entry.id === labelIds[index]
      && numberOf(entry.score) !== undefined
      && entry.score >= -1
      && entry.score <= 1)
  const descending = scores.every((entry, index) => index === 0 || entry.score <= scores[index - 1].score + 1e-9)
  check(checks, 'classify-scores-complete', scoresComplete, `${scores.length} score(s) for ${labelIds.length} label(s)`)
  check(checks, 'classify-scores-descending', descending)
  check(checks, 'classify-not-calibrated', payload.calibrated === false)
}

/** semantic_deduplicate: every item exactly once, representatives are members. */
function validateSemanticDeduplicate(payload, context) {
  const { checks, input } = context
  const itemIds = (Array.isArray(input.items) ? input.items : []).map(item => item.id)
  const groups = Array.isArray(payload.groups) ? payload.groups : []
  const groupsValid = groups.length > 0 && groups.every(group =>
    isRecord(group)
    && typeof group.representativeId === 'string'
    && Array.isArray(group.members)
    && group.members.every(member => isRecord(member) && typeof member.id === 'string' && numberOf(member.score) !== undefined))
  check(checks, 'dedup-groups-shape', groupsValid, `${groups.length} group(s)`)
  const assigned = groups.flatMap(group => Array.isArray(group.members) ? group.members.map(member => member.id) : [])
  const covers = assigned.length === itemIds.length
    && itemIds.every(id => assigned.filter(entry => entry === id).length === 1)
  check(checks, 'dedup-covers-items', covers, `assigned=${JSON.stringify(assigned)}`)
  check(
    checks,
    'dedup-representative-member',
    groups.every(group => Array.isArray(group.members) && group.members.some(member => member.id === group.representativeId)),
  )
  check(
    checks,
    'dedup-scores-range',
    groups.every(group => group.members.every(member => member.score >= -1 && member.score <= 1)),
  )
  check(
    checks,
    'dedup-algorithm-threshold',
    payload.algorithm === 'greedy_representative_cosine_v1' && payload.threshold === input.threshold && typeof payload.embeddingSpaceId === 'string' && payload.embeddingSpaceId.length > 0,
  )
}

/** media_find_moments: ranked source-time windows bounded by the real audio. */
function validateMediaFindMoments(payload, context) {
  const { checks, input } = context
  const matches = Array.isArray(payload.matches) ? payload.matches : []
  const topK = typeof input.top_k === 'number' ? input.top_k : matches.length
  const duration = mediaDurationSeconds(input)
  check(checks, 'moments-matches-present', matches.length >= 1 && matches.length <= topK, `${matches.length} match(es), top_k=${topK}`)
  const windowsWellFormed = matches.every(match =>
    isRecord(match)
    && numberOf(match.startSeconds) !== undefined
    && numberOf(match.endSeconds) !== undefined
    && numberOf(match.score) !== undefined
    && match.startSeconds >= 0
    && match.endSeconds >= match.startSeconds
    && match.score >= -1
    && match.score <= 1)
  check(checks, 'moment-windows-ordered', windowsWellFormed && matches.every((match, index) => index === 0 || match.score <= matches[index - 1].score + 1e-9))
  check(
    checks,
    'moment-window-bounds',
    duration === undefined
      ? false
      : windowsWellFormed && matches.every(match => match.endSeconds <= duration + 0.15),
    duration === undefined ? 'the media duration could not be measured' : `media duration=${duration}s`,
  )
  check(
    checks,
    'moments-windows-evaluated',
    typeof payload.windowsEvaluated === 'number'
      && Number.isInteger(payload.windowsEvaluated)
      && payload.windowsEvaluated >= Math.max(1, matches.length),
    `windowsEvaluated=${payload.windowsEvaluated}`,
  )
  check(
    checks,
    'moments-audio-no-video-frames',
    payload.localization === 'window_level'
      && payload.scoreKind === 'cosine_similarity'
      && Array.isArray(payload.sampledFrameTimestampsSeconds)
      && payload.sampledFrameTimestampsSeconds.length === 0,
  )
}

/** text.title: ONE strict JSON object, grounded in the source and bounded. */
function validateTextTitle(payload, context) {
  const { checks, input } = context
  let record
  if (typeof payload === 'string') {
    const parsed = parseStrictJsonObject(payload)
    record = parsed.record
    check(checks, 'title-strict-json', parsed.ok, parsed.ok ? undefined : parsed.reason)
  } else {
    record = isRecord(payload) ? payload : undefined
    check(checks, 'title-strict-json', record !== undefined, `the tool returned a ${typeof payload}`)
  }
  if (record === undefined) {
    check(checks, 'title-length', false, 'no title to measure')
    check(checks, 'description-length', false, 'no description to measure')
    check(checks, 'title-grounding', false, 'no title to ground')
    check(checks, 'title-no-invented-numbers', false, 'no title to check')
    return
  }
  if (record.refused === true) {
    check(checks, 'title-length', false, `the model refused: ${String(record.refusalReason ?? 'no reason given')}`)
    return
  }
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  check(checks, 'title-length', title.length >= 1 && lengthOf(title) <= 80, `${lengthOf(title)} characters`)
  check(checks, 'description-length', description.length >= 1 && lengthOf(description) <= 240, `${lengthOf(description)} characters`)
  const sourceText = typeof input.text === 'string' ? input.text : ''
  const sourceWords = contentWords(sourceText)
  const titleWords = contentWords(title)
  const grounded = sourceWords.size === 0 || [...titleWords].some(word => sourceWords.has(word))
  check(checks, 'title-grounding', grounded, `title=${JSON.stringify(title)}`)
  const sourceNumbers = new Set(numbersIn(sourceText))
  const invented = [...numbersIn(title), ...numbersIn(description)].filter(number => !sourceNumbers.has(number))
  check(checks, 'title-no-invented-numbers', invented.length === 0, `invented=${JSON.stringify(invented)}`)
}

/** image.describe: a real description of visible content, not a filename echo. */
function validateImageDescribe(payload, context) {
  const { checks } = context
  const description = typeof payload === 'string'
    ? payload
    : isRecord(payload) && typeof payload.description === 'string'
      ? payload.description
      : ''
  const trimmed = description.trim()
  check(checks, 'description-shape', trimmed.length >= 12 && lengthOf(trimmed) <= 4000, `${lengthOf(trimmed)} characters`)
  const visible = /(red|blue|white|circle|square|rectangle|shape|colour|color)/i.test(trimmed)
  check(checks, 'description-visible-content', visible, `description=${JSON.stringify(trimmed.slice(0, 160))}`)
  const filenameEcho = /(tiny[-_ ]?canvas|tiny[-_ ]?canvas\.png|image[-_ ]?describe|\.png\b|data:image)/i.test(trimmed)
  check(checks, 'description-not-filename', !filenameEcho)
  const placeholder = /^(i (cannot|can't|can not) see|no image|unable to (view|see)|as an ai\b)/i.test(trimmed)
  check(checks, 'description-not-placeholder', !placeholder)
}

/** Parse the recipe's strict ONE-JSON-object response. */
function parseStrictJsonObject(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('```')) {
    return { ok: false, reason: 'the response is wrapped in a code fence; the recipe requires one bare JSON object' }
  }
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return { ok: false, reason: 'the response is not a single JSON object' }
  }
  try {
    const parsed = JSON.parse(trimmed)
    if (!isRecord(parsed)) return { ok: false, reason: 'the response is not a JSON object' }
    return { ok: true, record: parsed }
  } catch (error) {
    return { ok: false, reason: `the response is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Measure a fixture WAV's duration, or undefined with a readable reason. */
function audioDurationSeconds(input) {
  const path = isRecord(input.audio) && typeof input.audio.path === 'string' ? input.audio.path : undefined
  return wavDuration(path)
}

/** Measure a media fixture's audio duration (audio only). */
function mediaDurationSeconds(input) {
  const media = isRecord(input.media) ? input.media : undefined
  if (media === undefined || media.kind !== 'audio' || typeof media.path !== 'string') return undefined
  return wavDuration(media.path)
}

/** Read one WAV duration through the repository's chunk-walking parser. */
function wavDuration(path) {
  if (path === undefined || !existsSync(path)) return undefined
  try {
    return parseWave(readFileSync(path)).durationSeconds
  } catch {
    return undefined
  }
}

/**
 * Whether a fixture WAV is DIGITAL SILENCE (every payload byte zero).
 *
 * Returns undefined when the file is missing or not a measurable PCM WAV, so a
 * broken fixture is reported by the bounded-coverage checks rather than being
 * misread as silence.
 * @param {Record<string, unknown>} input - the tool input carrying `audio.path`.
 * @returns {{silent: boolean, durationSeconds: number} | undefined}
 */
function audioSilence(input) {
  const path = isRecord(input.audio) && typeof input.audio.path === 'string' ? input.audio.path : undefined
  if (path === undefined || !existsSync(path)) return undefined
  try {
    const bytes = readFileSync(path)
    const wave = parseWave(bytes)
    const silent = wave.dataRanges.every(range => {
      for (let offset = range.offset; offset < range.offset + range.length; offset += 1) {
        if (bytes[offset] !== 0) return false
      }
      return true
    })
    return { silent, durationSeconds: wave.durationSeconds }
  } catch {
    return undefined
  }
}

/** The semantic validator for each matrix id. */
const VALIDATORS = Object.freeze({
  lang_detect: validateLangDetect,
  stt_transcribe: validateSttTranscribe,
  decision_choose: validateDecisionChoose,
  decision_test: validateDecisionTest,
  decision_score: validateDecisionScore,
  tools_plan: validateToolsPlan,
  structured_extract: validateStructuredExtract,
  text_embed: validateTextEmbed,
  text_rerank: validateTextRerank,
  multimodal_embed: validateMultimodalEmbed,
  semantic_similarity: validateSemanticSimilarity,
  semantic_rank: validateSemanticRank,
  semantic_classify: validateSemanticClassify,
  semantic_deduplicate: validateSemanticDeduplicate,
  media_find_moments: validateMediaFindMoments,
  text_title: validateTextTitle,
  image_describe: validateImageDescribe,
})

// ---------------------------------------------------------------------------
// The public verdict API
// ---------------------------------------------------------------------------

/**
 * Judge one tool result against its entry's declared schema and semantics.
 *
 * @param {string} id - a {@link MATRIX_TOOLS} id.
 * @param {unknown} output - the FULL host tool result (or a bare payload).
 * @param {{ inputDir?: string, input?: Record<string, unknown>, expectedLanguage?: string }} [options]
 *   Optional overrides for offline tests; the harness needs none.
 * @returns {{
 *   id: string, ok: boolean,
 *   checks: {name: string, ok: boolean, detail?: string}[],
 *   failures: string[],
 *   note: string | null,
 *   refusal: string | null,
 * }} the verdict.
 */
export function validateToolOutput(id, output, options = {}) {
  const entry = MATRIX_TOOLS.find(candidate => candidate.id === id)
  if (entry === undefined) {
    return {
      id,
      ok: false,
      checks: [{ name: 'known-matrix-entry', ok: false, detail: `${JSON.stringify(id)} is not a MATRIX_TOOLS id` }],
      failures: ['known-matrix-entry'],
      note: null,
      refusal: null,
    }
  }
  const normalized = normalizeToolResult(output)
  if (normalized.kind === 'refusal') {
    return {
      id,
      ok: false,
      checks: [{ name: 'output-is-success', ok: false, detail: normalized.message }],
      failures: ['output-is-success'],
      note: `the host returned a refusal: ${normalized.message}`,
      refusal: normalized.message,
    }
  }
  if (normalized.kind === 'unknown') {
    return {
      id,
      ok: false,
      checks: [{ name: 'output-is-structured-result', ok: false, detail: normalized.reason }],
      failures: ['output-is-structured-result'],
      note: null,
      refusal: null,
    }
  }

  const payload = normalized.payload
  const checks = []
  const schema = outputSchemaFor(entry)
  if (schema !== undefined) {
    const violations = validatorFor(entry.schemaPath ?? `${entry.contractId}#output`, schema)(payload)
    check(checks, 'output-schema', violations.length === 0, violations.slice(0, 8).join('; '))
  }

  let input
  try {
    input = options.input !== undefined ? options.input : loadInput(entry.input, options.inputDir)
  } catch (error) {
    check(checks, 'fixture-available', false, error instanceof Error ? error.message : String(error))
    input = {}
  }
  const validator = VALIDATORS[id]
  if (validator === undefined) {
    check(checks, 'validator-implemented', false, `no semantic validator is registered for ${id}`)
  } else if (isRecord(payload) || typeof payload === 'string') {
    validator(payload, { checks, entry, input: isRecord(input) ? input : {}, options })
  } else {
    check(checks, 'payload-shape', false, `the payload is a ${typeof payload}, not an object or string`)
  }

  const failures = checks.filter(entry => entry.ok !== true).map(entry => entry.name)
  return {
    id,
    ok: failures.length === 0,
    checks,
    failures,
    note: entry.note ?? null,
    refusal: null,
  }
}

/**
 * Aggregate verdicts for the harness report.
 * @param {{id: string, ok: boolean, failures?: string[], note?: string|null, refusal?: string|null}[]} verdicts - the per-call verdicts.
 * @returns {{total:number, passed:number, failed:number, failures:{id:string, failures:string[], detail?:string}[]}}
 */
export function summarizeVerdicts(verdicts) {
  const list = Array.isArray(verdicts) ? verdicts : []
  const failures = list
    .filter(verdict => verdict.ok !== true)
    .map(verdict => {
      const failure = {
        id: verdict.id,
        failures: Array.isArray(verdict.failures) ? verdict.failures : [],
      }
      if (verdict.refusal !== null && verdict.refusal !== undefined) failure.detail = verdict.refusal
      return failure
    })
  return {
    total: list.length,
    passed: list.length - failures.length,
    failed: failures.length,
    failures,
  }
}
