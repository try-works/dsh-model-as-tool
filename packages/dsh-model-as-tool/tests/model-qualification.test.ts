/**
 * Model qualification tests (MODEL-01, MODEL-04, MODEL-05, MODEL-06).
 *
 * These assert the ways of claiming more than is known, which is what all four
 * requirements are about: a platform table standing in for correct inference, a model's
 * modality list standing in for an adapter's, a brand standing in for a capability test,
 * and an unevaluated capability collapsing into a known absence.
 *
 * Requirement links: MODEL-01, MODEL-04, MODEL-05, MODEL-06.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  advertisableModalities,
  describeCapability,
  describeSubstitution,
  EMBEDDINGGEMMA2_DIMENSIONS,
  executionModeVerdict,
  isEmbeddingGemma2Width,
  isQualified,
  maySubstituteSilently,
  modelNameImpliesCapability,
  qualificationGaps,
  QUALIFICATION_FIELDS,
  resolveCapability,
  type ExecutionMode,
  type QualificationRecord,
} from '../src/model-qualification.ts'
import { QUALIFICATION_FIELDS as SDK_QUALIFICATION_FIELDS } from '@try-works/tool-mode-extension-sdk'

describe('MODEL-05 — the host and SDK field vocabularies cannot drift', () => {
  it('the two mirrored field lists are EQUAL', () => {
    // The round-47 review proved the "cannot drift" claim had no test behind it.
    // The SDK enforces records at discovery using ITS list; the host evaluates
    // records with ITS list. If either changes alone, packages and hosts disagree
    // silently — so the sets are asserted equal here, the same anti-drift pattern
    // the embedding/needle mirrors use.
    assert.deepEqual(
      [...QUALIFICATION_FIELDS].sort(),
      [...SDK_QUALIFICATION_FIELDS].sort(),
    )
  })
})

/** A complete qualification record. */
const QUALIFIED: QualificationRecord = {
  modelRevision: 'a1b2c3d4',
  artifactSha: 'e'.repeat(64),
  tokenizer: 'gemma-tokenizer-v2',
  processor: 'preproc-1.2.0',
  engineVersion: 'onnxruntime-node-1.20.0',
  nodeAbi: '127',
  architecture: 'x64',
  executionProvider: 'cpu',
}

describe('MODEL-05 — a working model is not a qualified path', () => {
  it('qualifies a complete record', () => {
    assert.equal(isQualified(QUALIFIED), true)
    assert.deepEqual([...qualificationGaps(QUALIFIED)], [])
  })

  it('reports EVERY missing field, not just the first', () => {
    const gaps = qualificationGaps({ modelRevision: 'a1b2c3d4' })
    // Each of these can independently be the difference between an import that works
    // and inference that is correct.
    assert.deepEqual([...gaps].sort(), [
      'architecture', 'artifactSha', 'engineVersion', 'executionProvider',
      'nodeAbi', 'processor', 'tokenizer',
    ])
    assert.equal(isQualified({ modelRevision: 'a1b2c3d4' }), false)
  })

  it('treats an EMPTY string as missing, not as recorded', () => {
    // A field present but blank is a gap wearing the shape of an answer.
    assert.equal(isQualified({ ...QUALIFIED, executionProvider: '' }), false)
    assert.deepEqual([...qualificationGaps({ ...QUALIFIED, tokenizer: '' })], ['tokenizer'])
  })

  it('requires the artifact hash, which is what makes the path reproducible', () => {
    assert.deepEqual([...qualificationGaps({ ...QUALIFIED, artifactSha: '' })], ['artifactSha'])
  })
})

describe('MODEL-05 — what is advertised is the INTERSECTION', () => {
  it('advertises only what the ADAPTER can also do', () => {
    // The model supports video; this adapter does not. Advertising the model list would
    // promise something the adapter cannot deliver.
    const advertisable = advertisableModalities({
      modelSupports: ['text', 'code', 'image', 'audio', 'video', 'embedding'],
      adapterSupports: ['text', 'code', 'embedding'],
    })
    assert.deepEqual([...advertisable], ['text', 'code', 'embedding'])
    assert.equal(advertisable.includes('video'), false)
  })

  it('NAMES the model-only modalities rather than omitting them', () => {
    const described = describeCapability({
      modelSupports: ['text', 'video'],
      adapterSupports: ['text'],
    })
    // A reader must not be left to infer that the model lacks video when in fact the
    // adapter does.
    assert.match(described, /advertisable: text/)
    assert.match(described, /the model also supports video, which this adapter does not/)
  })

  it('does not mention model-only modalities when there are none', () => {
    const described = describeCapability({ modelSupports: ['text'], adapterSupports: ['text'] })
    assert.equal(described.includes('also supports'), false)
  })

  it('reports an empty intersection as such', () => {
    const described = describeCapability({ modelSupports: ['video'], adapterSupports: ['text'] })
    assert.match(described, /no modality is advertisable through this adapter/)
  })

  it('an empty adapter list advertises nothing', () => {
    assert.deepEqual([...advertisableModalities({ modelSupports: ['text'], adapterSupports: [] })], [])
  })
})

describe('MODEL-06 — unknown is not unsupported', () => {
  it('reports three DISTINCT states', () => {
    assert.equal(resolveCapability(true), 'supported')
    assert.equal(resolveCapability(false), 'unsupported')
    // The collapse the requirement forbids: an unevaluated capability appearing as a
    // known absence.
    assert.equal(resolveCapability(undefined), 'unknown')
  })

  it('does not infer an unevaluated capability from a sibling', () => {
    // Text support says nothing about video support, so an unobserved video capability
    // stays unknown however well text performs.
    const observed = { text: true, video: undefined as boolean | undefined }
    assert.equal(resolveCapability(observed.text), 'supported')
    assert.equal(resolveCapability(observed.video), 'unknown')
  })

  it('NEVER treats a model name as a capability test', () => {
    // Brand recognition is not evidence, and a rule living only in a comment is one a
    // future branch will not read.
    assert.equal(modelNameImpliesCapability(), false)
  })

  it('records unknown and unsupported separately, not merely differently named', () => {
    const states = [resolveCapability(true), resolveCapability(false), resolveCapability(undefined)]
    assert.equal(new Set(states).size, 3)
  })
})

describe('MODEL-04 — the execution modes an end user may be asked for', () => {
  it('accepts the three permitted modes', () => {
    for (const mode of ['js-wasm-node', 'onnxruntime-node', 'managed-native-windows'] as const) {
      assert.equal(executionModeVerdict(mode).acceptable, true, `${mode} must be acceptable`)
    }
  })

  it('REFUSES Python on an end user machine, while allowing maintainers to use it', () => {
    const verdict = executionModeVerdict('python-required')
    assert.equal(verdict.acceptable, false)
    // The distinction is the point: Python is fine for export and verification by
    // maintainers, and not fine as a consumer requirement.
    assert.match(String(verdict.reason), /must not be required on an end user machine/)
  })

  it('refuses WSL, Docker, a GPU and a consumer compile', () => {
    for (const mode of ['wsl-required', 'docker-required', 'gpu-required', 'consumer-compile'] as const) {
      assert.equal(executionModeVerdict(mode).acceptable, false, `${mode} must be refused`)
    }
  })

  it('refuses a browser-only API, which does not establish Node support', () => {
    const verdict = executionModeVerdict('browser-only')
    assert.equal(verdict.acceptable, false)
    assert.match(String(verdict.reason), /browser-only APIs do not establish Node support/)
  })

  it('gives every refusal a reason', () => {
    const modes: ExecutionMode[] = [
      'python-required', 'wsl-required', 'docker-required', 'gpu-required', 'browser-only', 'consumer-compile',
    ]
    for (const mode of modes) {
      const verdict = executionModeVerdict(mode)
      assert.equal(verdict.acceptable, false)
      assert.ok(verdict.reason && verdict.reason.length > 0, `${mode} needs a reason`)
    }
  })
})

describe('MODEL-01 / BASE-12 — embedding spaces are not interchangeable', () => {
  const gemma = { modelId: 'embeddinggemma-2', dimensions: 768 }
  const minilm = { modelId: 'all-MiniLM-L6-v2', dimensions: 384 }

  it('REFUSES a silent substitution across different widths', () => {
    // Comparing 768-dimensional vectors against a 384-dimensional index produces
    // meaningless similarity rather than an error, which is why this is refused.
    assert.equal(maySubstituteSilently(minilm, gemma), false)
    assert.match(describeSubstitution(minilm, gemma), /require an explicit re-index/)
  })

  it('permits a substitution at the same width', () => {
    assert.equal(maySubstituteSilently(gemma, { modelId: 'other-768', dimensions: 768 }), true)
    assert.match(describeSubstitution(gemma, { modelId: 'other-768', dimensions: 768 }), /matching/)
  })

  it('names both widths in the refusal, so the migration is actionable', () => {
    const described = describeSubstitution(minilm, gemma)
    assert.match(described, /768-dimensional/)
    assert.match(described, /384/)
  })

  it('records the documented reduced widths', () => {
    // A reduction applied inconsistently produces vectors that cannot be compared with
    // each other, so the widths are recorded rather than inferred.
    assert.deepEqual([...EMBEDDINGGEMMA2_DIMENSIONS], [768, 512, 256, 128])
    for (const width of EMBEDDINGGEMMA2_DIMENSIONS) assert.equal(isEmbeddingGemma2Width(width), true)
    assert.equal(isEmbeddingGemma2Width(384), false)
  })
})
