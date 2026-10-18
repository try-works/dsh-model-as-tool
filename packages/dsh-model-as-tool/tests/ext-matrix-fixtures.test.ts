/**
 * Offline tests for the extension-matrix fixtures and output validators (task-111).
 *
 * WHAT THESE TESTS PROVE, AND WHAT THEY CANNOT. They prove that every committed
 * fixture satisfies the schema the host actually advertises for that tool, that
 * the binary assets are exactly what their deterministic builders produce, and
 * that every validator accepts a fabricated GOOD output and refuses the BAD ones
 * with the expected named check. They do NOT prove a model behaves well, and the
 * fabricated GOOD outputs are NOT model output: they are contract-shaped values
 * written to exercise the validators. The live model verdicts come from the
 * matrix harness, which this module never replaces.
 *
 * No network, no host mount, no model assets: everything here is files and pure
 * functions, so the suite is fast and runs anywhere.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { textEmbed, textRerank } from '@try-works/tool-mode-contracts'
import { PLANNING_TOOL_INPUT_SCHEMA } from '../src/planning.ts'

/** The tests directory. */
const HERE = dirname(fileURLToPath(import.meta.url))
/** The repository root (tests -> package -> packages -> root). */
const REPO_ROOT = resolve(HERE, '..', '..', '..')
/** The committed fixture root. */
const FIXTURE_ROOT = join(HERE, 'fixtures', 'ext-matrix')

/** A JSON value: the domain of every committed fixture and fabricated output. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue }

// Dynamic imports keep this TypeScript test free of declaration files for the
// dependency-free .mjs modules that ship beside the repository scripts.
const outputs: any = await import(new URL('../../../scripts/lib/ext-matrix-outputs.mjs', import.meta.url).href)
const subset: any = await import(new URL('../../../scripts/lib/json-schema-subset.mjs', import.meta.url).href)
const wav: any = await import(new URL('../../../scripts/voz-wav.mjs', import.meta.url).href)
const builders: any = await import(new URL('./fixtures/ext-matrix/build-fixtures.mjs', import.meta.url).href)

/** Every extension id the matrix must cover, exactly once as a package. */
const EXPECTED_EXTENSIONS = [
  '@try-works/extension-desert-ant-tongue',
  '@try-works/extension-desert-ant-voz',
  '@try-works/extension-laya',
  '@try-works/extension-needle',
  '@try-works/extension-minilm-embed',
  '@try-works/extension-minilm-rerank',
  '@try-works/extension-embeddinggemma',
  '@try-works/extension-declarative-recipes',
]

/** The per-extension tool/contract counts this matrix covers. */
const EXPECTED_COUNTS = {
  '@try-works/extension-desert-ant-tongue': 1,
  '@try-works/extension-desert-ant-voz': 1,
  '@try-works/extension-laya': 3,
  '@try-works/extension-needle': 2,
  '@try-works/extension-minilm-embed': 1,
  '@try-works/extension-minilm-rerank': 1,
  '@try-works/extension-embeddinggemma': 6,
  '@try-works/extension-declarative-recipes': 2,
} satisfies Record<string, number>

/** The package directory that owns one extension id. */
function packageDir(extensionId: string): string {
  const name = extensionId.replace(/^@try-works\//, '')
  return join(REPO_ROOT, 'packages', name)
}

/** Read one package manifest. */
function manifestOf(extensionId: string): any {
  return JSON.parse(readFileSync(join(packageDir(extensionId), 'tool-mode.extension.json'), 'utf8'))
}

/** The shared Tool Mode envelope used by the fabricated GOOD outputs. */
function meta(contract: string, extension: string): JsonValue {
  return {
    contract,
    contractVersion: '1.0.0',
    implementationId: 'fixture-test-impl',
    extension,
    extensionVersion: '0.1.0',
    activationGeneration: 1,
    executionLocation: 'device',
    receiptId: 'rcpt_fixture_test',
    warnings: [],
  }
}

/** One processing record in EmbeddingGemma's declared shape. */
function processingRecord(id: string, modalities: string[]): JsonValue {
  return { id, modalities, sourceRanges: [], sampledVideoFrames: [], observedAudioSampleRates: [], truncated: false }
}

/** A unit vector of `dimensions` length built from the supplied leading values. */
function unit(values: number[], dimensions: number): number[] {
  const padded = new Array<number>(dimensions).fill(0)
  for (const [index, value] of values.entries()) if (index < dimensions) padded[index] = value
  const length = Math.sqrt(padded.reduce((sum, value) => sum + value * value, 0))
  return padded.map(value => value / length)
}

const vecA = unit([1, 0.9, 0.1], 384)
const vecB = unit([1, 0.85, 0.15], 384)
const vecC = unit([-1, 0.1, -0.2], 384)
const mmA = unit([1, 0.5, 0.25], 768)
const mmB = unit([1, 0.4, 0.2], 768)

/** Wrap a payload the way the real host returns a successful tool result. */
function hostResult(payload: JsonValue): JsonValue {
  const serialized = JSON.stringify(payload)
  return {
    isError: false,
    value: payload,
    content: [{ type: 'text', text: serialized === undefined ? String(payload) : serialized }],
  }
}

/**
 * Fabricated GOOD outputs — CONTRACT-SHAPED, not model output.
 *
 * Every one is derived from the entry's declared schema and its fixture input,
 * so a change to either makes the agreement test below fail loudly rather than
 * silently accepting shapes the contract no longer declares.
 */
const GOOD = {
  lang_detect: {
    language: 'en',
    reliability: 'confident',
    tooCloseToCall: false,
    candidates: [
      { language: 'en', probability: 0.97 },
      { language: 'de', probability: 0.02 },
      { language: 'fr', probability: 0.01 },
    ],
  },
  stt_transcribe: {
    text: 'hello world',
    coverage: { complete: true, transcribedSeconds: 1.0, totalSeconds: null, reason: null },
    words: [
      { text: 'hello', start: 0.1, end: 0.5 },
      { text: 'world', start: 0.6, end: 1.0 },
    ],
    language: 'en',
  },
  decision_choose: {
    chosen: 'Canary deployment',
    confidence: 0.71,
    answer_confidence: 0.71,
    calibrated: false,
    probabilities: {
      'Rolling deployment': 0.1,
      'Canary deployment': 0.71,
      'Blue-green deployment': 0.12,
      'Recreate (stop, then start)': 0.07,
    },
    abstained: false,
    action: { act_probability: 0.9 },
  },
  decision_test: {
    decision: 'yes',
    confidence: 0.8,
    calibrated: false,
    probabilities: { yes: 0.8, no: 0.2 },
    abstained: false,
  },
  decision_score: {
    score: 'high',
    confidence: 0.66,
    calibrated: false,
    probabilities: { 'very low': 0.02, low: 0.05, medium: 0.12, high: 0.66, 'very high': 0.15 },
    abstained: false,
  },
  tools_plan: {
    proposals: [
      {
        name: 'structured_extract',
        arguments: {
          text: 'Invoice INV-2024-0042 was issued by Northwind Traders for 1,250.00 USD.',
          instruction: 'Extract the invoice number and total amount.',
          schema: { type: 'object', properties: { invoiceNumber: { type: 'string' } }, required: ['invoiceNumber'] },
        },
        offered: true,
        valid: true,
        issues: [],
      },
    ],
    rejected: [],
    reasoning: 'The request asks for fields from one sentence, so one extraction call is enough.',
    confidence: 0.8,
    grounding: { ungrounded: [], negation: false },
    meta: meta('@try-works/extension-needle/tools_plan', '@try-works/extension-needle'),
  },
  structured_extract: {
    extraction: {
      vendor: 'Northwind Traders',
      customer: 'Acme Corporation',
      invoiceNumber: 'INV-2024-0042',
      totalAmount: 1250,
      currency: 'USD',
      dueInDays: 30,
    },
    proposed: true,
    valid: true,
    issues: [],
    reasoning: 'The invoice line names the vendor, customer, number and total.',
    confidence: 0.8,
    grounding: { ungrounded: [], negation: false },
    meta: meta('@try-works/extension-needle/structured_extract', '@try-works/extension-needle'),
  },
  text_embed: {
    embeddings: [vecA, vecB, vecC],
    dimensions: 384,
    normalized: true,
    meta: meta('text.embed', '@try-works/extension-minilm-embed'),
  },
  text_rerank: {
    results: [
      { id: 'doc-a', score: 3.2 },
      { id: 'doc-b', score: 1.1 },
      { id: 'doc-c', score: -2.0 },
      { id: 'doc-d', score: -2.5 },
    ],
    scoreKind: 'ranking_logit',
    meta: meta('text.rerank', '@try-works/extension-minilm-rerank'),
  },
  multimodal_embed: {
    vectors: [
      {
        id: 'poem-text',
        values: mmA,
        dimensions: 768,
        normalized: true,
        embeddingSpaceId: 'eg2-text-backbone-v1',
        purpose: 'similarity',
        role: 'symmetric',
      },
      {
        id: 'canvas-image',
        values: mmB,
        dimensions: 768,
        normalized: true,
        embeddingSpaceId: 'eg2-text-backbone-v1',
        purpose: 'similarity',
        role: 'symmetric',
      },
    ],
    processing: [
      processingRecord('poem-text', ['text']),
      processingRecord('canvas-image', ['image']),
    ],
    meta: meta('@try-works/extension-embeddinggemma/multimodal_embed', '@try-works/extension-embeddinggemma'),
  },
  semantic_similarity: {
    score: 0.87,
    scoreKind: 'cosine_similarity',
    embeddingSpaceId: 'eg2-text-backbone-v1',
    processing: [processingRecord('deploy-left', ['text']), processingRecord('deploy-right', ['text'])],
    meta: meta('@try-works/extension-embeddinggemma/semantic_similarity', '@try-works/extension-embeddinggemma'),
  },
  semantic_rank: {
    results: [
      { id: 'rank-rollback', score: 0.91 },
      { id: 'rank-invoice', score: 0.42 },
      { id: 'rank-weather', score: 0.11 },
      { id: 'rank-legend', score: 0.03 },
    ],
    scoreKind: 'cosine_similarity',
    embeddingSpaceId: 'eg2-text-backbone-v1',
    processing: [
      processingRecord('rollback-query', ['text']),
      processingRecord('rank-rollback', ['text']),
      processingRecord('rank-invoice', ['text']),
      processingRecord('rank-weather', ['text']),
      processingRecord('rank-legend', ['text']),
    ],
    meta: meta('@try-works/extension-embeddinggemma/semantic_rank', '@try-works/extension-embeddinggemma'),
  },
  semantic_classify: {
    status: 'selected',
    label: 'bug',
    scores: [
      { id: 'bug', score: 0.62 },
      { id: 'feature', score: 0.21 },
      { id: 'question', score: 0.15 },
    ],
    scoreKind: 'cosine_similarity',
    calibrated: false,
    embeddingSpaceId: 'eg2-text-backbone-v1',
    processing: [processingRecord('support-message', ['text'])],
    meta: meta('@try-works/extension-embeddinggemma/semantic_classify', '@try-works/extension-embeddinggemma'),
  },
  semantic_deduplicate: {
    groups: [
      {
        representativeId: 'deploy-1',
        members: [{ id: 'deploy-1', score: 1 }, { id: 'deploy-2', score: 0.97 }],
      },
      {
        representativeId: 'invoice-1',
        members: [{ id: 'invoice-1', score: 1 }, { id: 'invoice-2', score: 0.95 }],
      },
      {
        representativeId: 'weather-1',
        members: [{ id: 'weather-1', score: 1 }],
      },
    ],
    algorithm: 'greedy_representative_cosine_v1',
    threshold: 0.9,
    embeddingSpaceId: 'eg2-text-backbone-v1',
    meta: meta('@try-works/extension-embeddinggemma/semantic_deduplicate', '@try-works/extension-embeddinggemma'),
  },
  media_find_moments: {
    matches: [
      { startSeconds: 1, endSeconds: 2, score: 0.4 },
      { startSeconds: 0, endSeconds: 1, score: 0.2 },
    ],
    scoreKind: 'cosine_similarity',
    localization: 'window_level',
    embeddingSpaceId: 'eg2-text-backbone-v1',
    windowsEvaluated: 3,
    sampledFrameTimestampsSeconds: [],
    processing: [processingRecord('moments-query', ['text'])],
    meta: meta('@try-works/extension-embeddinggemma/media_find_moments', '@try-works/extension-embeddinggemma'),
  },
  text_title: JSON.stringify({
    title: 'Deployment pipeline migration',
    description: 'Deployment pipelines run tests, build images and promote releases; the 2024 migration moved 12 services to the new cluster without downtime.',
  }),
  image_describe: 'A white rectangular canvas with a solid red square on the left and a large blue circle on the right.',
} satisfies Record<string, JsonValue>

/** A deep copy for a mutation, so one BAD case cannot leak into the next. */
function clone<T>(value: T): T {
  // SAFETY: fixture values are JSON by construction (object, array, string,
  // number, boolean or null), so a JSON round-trip stays inside T's domain.
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Fabricated BAD outputs: each starts from the GOOD value and applies one
 * mutation that must be refused with the named check. The table is exhaustive
 * per matrix id — a validator with no negative case is not tested at all.
 */
const BAD: { id: string, label: string, mutate: (good: JsonValue) => JsonValue, expect: string }[] = [
  {
    id: 'lang_detect',
    label: 'the top guess is the wrong language',
    mutate: good => { good.language = 'fr'; return good },
    expect: 'language-top-guess',
  },
  {
    id: 'lang_detect',
    label: 'the language code is not ISO-639-1',
    mutate: good => { good.language = 'english'; return good },
    expect: 'language-is-iso6391',
  },
  {
    id: 'stt_transcribe',
    label: 'coverage claims more audio than the file contains',
    mutate: good => { good.coverage.transcribedSeconds = 99; return good },
    expect: 'coverage-within-audio',
  },
  {
    id: 'stt_transcribe',
    label: 'a word ends after the audio',
    mutate: good => { good.words[1].end = 9; return good },
    expect: 'words-within-audio',
  },
  {
    id: 'decision_choose',
    label: 'the chosen option was never offered',
    mutate: good => { good.chosen = 'Deploy from a laptop'; return good },
    expect: 'chosen-is-option',
  },
  {
    id: 'decision_test',
    label: 'a free-form decision instead of yes/no',
    mutate: good => { good.decision = 'maybe'; return good },
    expect: 'decision-is-boolean-vocabulary',
  },
  {
    id: 'decision_score',
    label: 'a level outside the caller\'s levels',
    mutate: good => { good.score = 'catastrophic'; return good },
    expect: 'score-is-level',
  },
  {
    id: 'tools_plan',
    label: 'the plan contains a rejected proposal',
    mutate: good => {
      good.rejected = [{ name: 'unregistered_tool', arguments: {}, offered: false, valid: false, issues: ['not offered'] }]
      return good
    },
    expect: 'plan-rejections-empty',
  },
  {
    id: 'tools_plan',
    label: 'a proposal is marked invalid',
    mutate: good => { good.proposals[0].valid = false; return good },
    expect: 'plan-proposals-valid',
  },
  {
    id: 'structured_extract',
    label: 'the extraction violates the caller schema but claims valid',
    mutate: good => { delete good.extraction.vendor; return good },
    expect: 'extraction-matches-caller-schema',
  },
  {
    id: 'structured_extract',
    label: 'a null extraction reported as valid',
    mutate: good => { good.extraction = null; good.valid = true; return good },
    expect: 'valid-flag-consistent',
  },
  {
    id: 'text_embed',
    label: 'the unrelated text is closer than the related one',
    mutate: good => { good.embeddings = [vecA, vecC, vecB]; return good },
    expect: 'embedding-related-closer',
  },
  {
    id: 'text_embed',
    label: 'a vector is not unit norm',
    mutate: good => { good.embeddings[1] = good.embeddings[1].map((value: number) => value * 2); return good },
    expect: 'embedding-normalized',
  },
  {
    id: 'text_rerank',
    label: 'the relevant document is not first',
    mutate: good => { good.results = [good.results[1], good.results[0], good.results[2], good.results[3]]; return good },
    expect: 'rerank-relevant-first',
  },
  {
    id: 'multimodal_embed',
    label: 'a vector has the wrong width',
    mutate: good => { good.vectors[0].dimensions = 512; return good },
    expect: 'vector-dimensions',
  },
  {
    id: 'multimodal_embed',
    label: 'truncated is reported true, which v1 forbids',
    mutate: good => { good.processing[0].truncated = true; return good },
    expect: 'processing-truncated-false',
  },
  {
    id: 'semantic_similarity',
    label: 'a cosine outside [-1,1]',
    mutate: good => { good.score = 1.4; return good },
    expect: 'output-schema',
  },
  {
    id: 'semantic_rank',
    label: 'the relevant candidate is not first',
    mutate: good => { good.results[0] = { id: 'rank-weather', score: 0.91 }; return good },
    expect: 'rank-relevant-first',
  },
  {
    id: 'semantic_classify',
    label: 'a label the caller never supplied',
    mutate: good => { good.label = 'incident'; return good },
    expect: 'classify-label-allowed',
  },
  {
    id: 'semantic_deduplicate',
    label: 'an input item is missing from the grouping',
    mutate: good => { good.groups[2].members = []; return good },
    expect: 'dedup-covers-items',
  },
  {
    id: 'media_find_moments',
    label: 'a window ends after the media',
    mutate: good => { good.matches[0].endSeconds = 9; return good },
    expect: 'moment-window-bounds',
  },
  {
    id: 'media_find_moments',
    label: 'video frame timestamps on an audio call',
    mutate: good => { good.sampledFrameTimestampsSeconds = [0.5, 1.5]; return good },
    expect: 'moments-audio-no-video-frames',
  },
  {
    id: 'text_title',
    label: 'an empty title',
    mutate: () => JSON.stringify({ title: '', description: 'A description that is otherwise fine.' }),
    expect: 'title-length',
  },
  {
    id: 'text_title',
    label: 'prose instead of the one JSON object the recipe requires',
    mutate: () => 'Sure! Here is a title: Deployment pipeline migration.',
    expect: 'title-strict-json',
  },
  {
    id: 'image_describe',
    label: 'the description merely echoes the filename',
    mutate: () => 'tiny-canvas.png',
    expect: 'description-not-filename',
  },
  {
    id: 'image_describe',
    label: 'a placeholder non-description',
    mutate: () => 'I cannot see the image.',
    expect: 'description-not-placeholder',
  },
]

after(() => {
  // Nothing is written by these tests; the hook is kept so a future file-backed
  // case has one obvious place to clean up.
})

describe('fixture inventory (task-111)', () => {
  it('covers exactly the eight extensions and their 17 tools/contracts', () => {
    const entries = outputs.MATRIX_TOOLS
    assert.equal(entries.length, 17, `the matrix must have 17 invocations, saw ${entries.length}`)
    const extensions = [...new Set(entries.map(entry => entry.extension))].sort()
    assert.deepEqual(extensions, [...EXPECTED_EXTENSIONS].sort())
    for (const extension of EXPECTED_EXTENSIONS) {
      const count = entries.filter(entry => entry.extension === extension).length
      assert.equal(count, EXPECTED_COUNTS[extension], `${extension} must contribute ${EXPECTED_COUNTS[extension]} entries, saw ${count}`)
    }
    assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length, 'matrix ids must be unique')
    assert.equal(new Set(entries.map(entry => entry.toolName)).size, entries.length, 'tool names must be unique')
    for (const entry of entries) {
      assert.ok(['tool', 'contract'].includes(entry.kind), `${entry.id} has an unknown kind ${entry.kind}`)
      assert.ok(String(entry.toolName).length > 0, `${entry.id} must name a tool`)
      assert.ok(String(entry.contractId).length > 0, `${entry.id} must name a contract`)
      assert.ok(Array.isArray(entry.checks) && entry.checks.length > 0, `${entry.id} must document its checks`)
    }
  })

  it('has every committed fixture and no fixture over the 2 MB budget in total', () => {
    let total = 0
    for (const relative of outputs.FIXTURE_FILES) {
      const file = join(FIXTURE_ROOT, relative)
      assert.ok(existsSync(file), `the committed fixture ${relative} is missing`)
      total += statSync(file).size
    }
    assert.ok(total < 2 * 1024 * 1024, `fixtures must total under 2 MB, saw ${total} bytes`)
  })

  it('keeps machine-specific absolute paths out of the committed inputs', () => {
    for (const relative of outputs.FIXTURE_FILES) {
      if (!relative.endsWith('.json')) continue
      const text = readFileSync(join(FIXTURE_ROOT, relative), 'utf8')
      assert.doesNotMatch(
        text,
        /"(?:[A-Za-z]:[\\/]|\/(?:Users|home|root)\/|\\\\[^"]+)/,
        `${relative} must not commit a machine-specific path`,
      )
    }
  })

  it('validates every fixture against the caller-facing input schema', () => {
    for (const entry of outputs.MATRIX_TOOLS) {
      const verdict = outputs.validateFixtureInput(entry.id)
      assert.deepEqual(verdict.issues, [], `${entry.id} fixture is invalid: ${verdict.issues.join('; ')} (source ${verdict.source})`)
      assert.ok(String(verdict.source ?? '').length > 0)
    }
  })

  it('loads inputs that are JSON-serializable and materializes absolute asset paths', () => {
    for (const entry of outputs.MATRIX_TOOLS) {
      const input = outputs.loadInput(entry.input)
      assert.deepEqual(JSON.parse(JSON.stringify(input)), input, `${entry.id} input must survive a JSON round-trip`)
      const text = JSON.stringify(input)
      assert.doesNotMatch(text, /"\.\/assets\//, `${entry.id} input still carries an unresolved relative asset path`)
    }
    const stt = outputs.loadInput('stt-transcribe')
    assert.ok(stt.audio.path.includes('tone-2s-16k-mono.wav'))
    assert.equal(stt.audio.sampleRateHz, 16000)
    const image = outputs.loadInput('image-describe')
    assert.equal(image.image.mediaType, 'image/png')
    assert.ok(Array.isArray(image.image.bytes) && image.image.bytes.length > 0)
    assert.equal(image.image.path, undefined, 'typed media must replace the path, not travel beside it')
  })

  it('validates the extra language and silence fixtures too', () => {
    for (const name of ['lang-detect-fr', 'lang-detect-de', 'lang-detect-ja', 'lang-detect-zh', 'lang-detect-ambiguous']) {
      const verdict = outputs.validateFixtureInput('lang_detect', outputs.loadInput(name))
      assert.deepEqual(verdict.issues, [], `${name}: ${verdict.issues.join('; ')}`)
    }
    const silence = outputs.validateFixtureInput('stt_transcribe', outputs.loadInput('stt-transcribe-silence'))
    assert.deepEqual(silence.issues, [], `silence fixture: ${silence.issues.join('; ')}`)
  })
})

describe('binary assets are deterministic and correctly shaped', () => {
  it('matches the committed PNG byte-for-byte and is a 96x64 RGB image', () => {
    const committed = readFileSync(join(FIXTURE_ROOT, 'assets', 'tiny-canvas.png'))
    assert.ok(committed.equals(builders.buildCanvasPng()), 'tiny-canvas.png must equal its deterministic builder output')
    assert.equal(committed.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(committed.toString('ascii', 12, 16), 'IHDR')
    assert.equal(committed.readUInt32BE(16), 96)
    assert.equal(committed.readUInt32BE(20), 64)
    assert.equal(committed[24], 8, '8-bit channel depth')
    assert.equal(committed[25], 2, 'truecolour RGB')
  })

  it('matches the committed WAVs byte-for-byte and measures 16 kHz mono PCM', () => {
    const tone = readFileSync(join(FIXTURE_ROOT, 'assets', 'tone-2s-16k-mono.wav'))
    const silence = readFileSync(join(FIXTURE_ROOT, 'assets', 'silence-1s-16k-mono.wav'))
    assert.ok(tone.equals(builders.buildToneWav()))
    assert.ok(silence.equals(builders.buildSilenceWav()))

    const toneWave = wav.parseWave(tone)
    assert.equal(toneWave.audioFormat, 1, 'PCM')
    assert.equal(toneWave.channels, 1, 'mono')
    assert.equal(toneWave.sampleRate, 16000)
    assert.equal(toneWave.bitsPerSample, 16)
    assert.ok(Math.abs(toneWave.durationSeconds - 2) < 1e-9)

    const silenceWave = wav.parseWave(silence)
    assert.equal(silenceWave.sampleRate, 16000)
    assert.ok(Math.abs(silenceWave.durationSeconds - 1) < 1e-9)
    assert.ok(
      silenceWave.dataRanges.every((range: { offset: number, length: number }) =>
        silence.subarray(range.offset, range.offset + range.length).every(byte => byte === 0)),
      'the silence fixture must really be silent',
    )
  })
})

describe('validators accept fabricated GOOD outputs', () => {
  it('accepts a contract-shaped GOOD output for every matrix entry', () => {
    const ids = Object.keys(GOOD)
    assert.equal(ids.length, (outputs.MATRIX_TOOLS).length, 'every matrix entry needs a GOOD fabrication')
    for (const entry of outputs.MATRIX_TOOLS) {
      assert.ok(entry.id in GOOD, `${entry.id} has no GOOD fabrication`)
      const verdict = outputs.validateToolOutput(entry.id, hostResult(GOOD[entry.id]))
      assert.equal(
        verdict.ok,
        true,
        `${entry.id} GOOD output was refused: ${JSON.stringify(verdict.checks.filter((check: any) => !check.ok))}`,
      )
      assert.deepEqual(verdict.failures, [])
      assert.ok(verdict.checks.length >= 2, `${entry.id} must run its schema and semantic checks`)
      const declarative = entry.contractId === 'text.title' || entry.contractId === 'image.describe'
      const structural = declarative
        ? verdict.checks.some((check: any) => check.name === 'title-strict-json' || check.name === 'description-shape')
        : verdict.checks.some((check: any) => check.name === 'output-schema')
      assert.ok(structural, `${entry.id} must run its declared structural check`)
    }
  })

  it('accepts the language fixture under every covered language', () => {
    for (const [name, expected] of [
      ['lang-detect', 'en'],
      ['lang-detect-fr', 'fr'],
      ['lang-detect-de', 'de'],
      ['lang-detect-ja', 'ja'],
      ['lang-detect-zh', 'zh'],
    ] as const) {
      const good = clone(GOOD.lang_detect)
      good.language = expected
      good.candidates = [{ language: expected, probability: 0.96 }, { language: 'en', probability: 0.01 }]
      const verdict = outputs.validateToolOutput('lang_detect', hostResult(good), { expectedLanguage: expected })
      assert.equal(verdict.ok, true, `${name}: ${JSON.stringify(verdict.checks.filter((check: any) => !check.ok))}`)
    }
    // The ambiguous fixture may legitimately come back tentative or unknown; the
    // validator must still accept an honest low-confidence result.
    const ambiguous = {
      language: null,
      reliability: 'unknown',
      tooCloseToCall: true,
      candidates: [],
    }
    assert.equal(outputs.validateToolOutput('lang_detect', hostResult(ambiguous), { expectedLanguage: null }).ok, true)
  })

  it('accepts the CONTRACT post-mapping shapes the providers must emit (task-115)', () => {
    // Voz will emit exactly {text, coverage}: no native `wordCount`, no missing
    // coverage. The validator must accept that shape, and must still REFUSE a
    // result that leaks the pre-mapping native field.
    const coverageOnly = {
      text: 'hello world',
      coverage: { complete: true, transcribedSeconds: 1.0, totalSeconds: 2, reason: null },
    }
    const accepted = outputs.validateToolOutput('stt_transcribe', hostResult(coverageOnly))
    assert.equal(accepted.ok, true, JSON.stringify(accepted.checks.filter((check: any) => !check.ok)))

    const leakedNative = { ...coverageOnly, wordCount: 2 }
    const refused = outputs.validateToolOutput('stt_transcribe', hostResult(leakedNative))
    assert.equal(refused.ok, false)
    assert.ok(refused.failures.includes('output-schema'), JSON.stringify(refused.failures))

    // Tongue will emit tooCloseToCall, and only the schema's fields. The native
    // isTooCloseToCall spelling is a violation the strict validator must keep.
    const nativeSpelling = { ...GOOD.lang_detect, isTooCloseToCall: false }
    delete nativeSpelling.tooCloseToCall
    const tongueRefused = outputs.validateToolOutput('lang_detect', hostResult(nativeSpelling))
    assert.equal(tongueRefused.ok, false)
    assert.ok(tongueRefused.failures.includes('output-schema'), JSON.stringify(tongueRefused.failures))
  })

  it('accepts the honest empty transcript for the silence fixture and refuses invented words', () => {
    const input = outputs.loadInput('stt-transcribe-silence')
    const honest = {
      text: '',
      coverage: { complete: true, transcribedSeconds: 0, totalSeconds: 1, reason: null },
      words: [],
      language: 'en',
    }
    const verdict = outputs.validateToolOutput('stt_transcribe', hostResult(honest), { input })
    assert.equal(verdict.ok, true, JSON.stringify(verdict.checks.filter((check: any) => !check.ok)))

    const invented = clone(honest)
    invented.text = 'the migration succeeded'
    invented.words = [{ text: 'the', start: 0, end: 0.2 }]
    invented.coverage.transcribedSeconds = 0.2
    const refused = outputs.validateToolOutput('stt_transcribe', hostResult(invented), { input })
    assert.equal(refused.ok, false)
    assert.ok(refused.failures.includes('silent-audio-empty-transcript'), JSON.stringify(refused.failures))
  })
})

describe('validators refuse fabricated BAD outputs', () => {
  for (const [index, bad] of BAD.entries()) {
    it(`refuses ${bad.id} case ${index + 1}: ${bad.label}`, () => {
      const good = GOOD[bad.id]
      assert.notEqual(good, undefined, `${bad.id} has no GOOD fabrication to mutate`)
      const mutated = bad.mutate(clone(good))
      const verdict = outputs.validateToolOutput(bad.id, hostResult(mutated))
      assert.equal(verdict.ok, false, `${bad.id} accepted a BAD output (${bad.label}): ${JSON.stringify(mutated)}`)
      assert.ok(
        verdict.failures.includes(bad.expect),
        `${bad.id} expected the check ${JSON.stringify(bad.expect)}, saw ${JSON.stringify(verdict.failures)}`,
      )
    })
  }

  it('has at least one negative case for every matrix id', () => {
    const covered = new Set(BAD.map(entry => entry.id))
    for (const entry of outputs.MATRIX_TOOLS) {
      assert.ok(covered.has(entry.id), `${entry.id} has no BAD output case`)
    }
  })
})

describe('result-shape normalisation', () => {
  it('accepts a bare payload, an MCP structuredContent result and a JSON text block', () => {
    assert.equal(outputs.validateToolOutput('lang_detect', GOOD.lang_detect).ok, true)
    assert.equal(outputs.validateToolOutput('lang_detect', { isError: false, structuredContent: GOOD.lang_detect, content: [] }).ok, true)
    assert.equal(outputs.validateToolOutput('lang_detect', {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(GOOD.lang_detect) }],
    }).ok, true)
  })

  it('reports a host refusal as a named refusal rather than throwing', () => {
    const verdict = outputs.validateToolOutput('media_find_moments', {
      isError: true,
      error: { message: 'VIDEO media is refused by name in this build', code: 'unsupported' },
      content: [{ type: 'text', text: 'VIDEO media is refused by name in this build' }],
    })
    assert.equal(verdict.ok, false)
    assert.ok(verdict.refusal.includes('VIDEO media is refused'))
    assert.deepEqual(verdict.failures, ['output-is-success'])
  })

  it('refuses a missing result and an unknown matrix id', () => {
    assert.deepEqual(outputs.validateToolOutput('lang_detect', undefined).failures, ['output-is-structured-result'])
    assert.deepEqual(outputs.validateToolOutput('not_a_tool', GOOD.lang_detect).failures, ['known-matrix-entry'])
  })

  it('summarizes verdicts for the harness report', () => {
    const good = outputs.validateToolOutput('lang_detect', hostResult(GOOD.lang_detect))
    const bad = outputs.validateToolOutput('text_embed', hostResult({ embeddings: [], dimensions: 384, normalized: true }))
    const summary = outputs.summarizeVerdicts([good, bad])
    assert.equal(summary.total, 2)
    assert.equal(summary.passed, 1)
    assert.equal(summary.failed, 1)
    assert.equal(summary.failures[0]?.id, 'text_embed')
  })
})

describe('the validator copy stays pinned to the packages that declare the contracts', () => {
  it('pins every extension output-schema path to its manifest', () => {
    for (const entry of outputs.MATRIX_TOOLS) {
      if (entry.schemaPath === undefined) continue
      const manifest = manifestOf(entry.extension)
      const tool = manifest.tools.find((candidate: any) => candidate.name === entry.toolName)
      assert.ok(tool !== undefined, `${entry.extension} no longer declares the tool ${entry.toolName}`)
      const declared = normalize(join(packageDir(entry.extension), tool.outputSchema))
      const pinned = normalize(join(REPO_ROOT, entry.schemaPath))
      assert.equal(pinned, declared, `${entry.id}: the pinned schema path must equal the manifest's declared path`)
      assert.ok(existsSync(pinned), `${entry.id}: ${entry.schemaPath} is missing`)
    }
  })

  it('pins the copied contract schemas to @try-works/tool-mode-contracts', () => {
    const embeddedEmbed = outputs.declaredOutputSchemaFor('text_embed')
    assert.deepEqual([...embeddedEmbed.required].sort(), [...textEmbed.outputSchema.required].sort())
    assert.deepEqual(Object.keys(embeddedEmbed.properties).sort(), Object.keys(textEmbed.outputSchema.properties).sort())
    assert.deepEqual(subset.validateSchema(textEmbed.outputSchema, GOOD.text_embed), [])

    const embeddedRerank = outputs.declaredOutputSchemaFor('text_rerank')
    assert.deepEqual([...embeddedRerank.required].sort(), [...textRerank.outputSchema.required].sort())
    assert.deepEqual(Object.keys(embeddedRerank.properties).sort(), Object.keys(textRerank.outputSchema.properties).sort())
    assert.deepEqual(subset.validateSchema(textRerank.outputSchema, GOOD.text_rerank), [])
  })

  it('pins the copied tools_plan caller schema to the host planning module', () => {
    const copied: any = JSON.parse(JSON.stringify(outputs.HOST_PLANNING_INPUT_SCHEMA))
    const source: any = JSON.parse(JSON.stringify(PLANNING_TOOL_INPUT_SCHEMA))
    assert.deepEqual(copied.required, source.required)
    assert.deepEqual(Object.keys(copied.properties).sort(), Object.keys(source.properties).sort())
    for (const [name, property] of Object.entries(source.properties)) {
      for (const keyword of ['type', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum']) {
        if (keyword in property) {
          assert.deepEqual(
            copied.properties[name][keyword],
            property[keyword],
            `tools_plan caller schema drift on ${name}.${keyword}`,
          )
        }
      }
      if (property.items !== undefined) {
        assert.deepEqual(copied.properties[name].items, property.items)
      }
    }
    assert.deepEqual(subset.validateSchema(source, outputs.loadInput('tools-plan')), [])
  })

  it('derives the declarative recipe fixtures from the committed recipe files', () => {
    for (const [id, file] of [['text_title', 'text-title.json'], ['image_describe', 'describe-image.json']] as const) {
      const entry = (outputs.MATRIX_TOOLS).find(candidate => candidate.id === id)
      const recipe = JSON.parse(readFileSync(join(packageDir(entry.extension), 'recipes', file), 'utf8'))
      const { schema, source } = outputs.callerInputSchemaFor(entry)
      assert.ok(source.endsWith(file))
      assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(recipe.inputs).sort())
      const required = Object.entries(recipe.inputs)
        .filter(([, declaration]: [string, any]) => declaration.required === true)
        .map(([name]) => name)
        .sort()
      assert.deepEqual([...schema.required].sort(), required)
      if (id === 'image_describe') {
        assert.deepEqual(schema.properties.image.properties.mediaType.enum, recipe.inputs.image.mediaTypes)
      }
    }
  })

  it('keeps every declared input schema compilable by the dependency-free subset', () => {
    for (const entry of outputs.MATRIX_TOOLS) {
      const { schema } = outputs.callerInputSchemaFor(entry)
      assert.doesNotThrow(() => subset.compileSubset(schema), `${entry.id} input schema does not compile`)
      if (entry.schemaPath !== undefined) {
        const outputSchema = JSON.parse(readFileSync(join(REPO_ROOT, entry.schemaPath), 'utf8'))
        assert.doesNotThrow(() => subset.compileSubset(outputSchema), `${entry.id} output schema does not compile`)
      }
    }
  })
})
