/**
 * Contract tests.
 *
 * These establish the Milestone A requirement that a schema is not implemented
 * merely by being copied: every claim below exercises runtime validation, and the
 * negative cases assert that a violation is REFUSED rather than tolerated.
 *
 * Requirement links: DECL-01, DECL-02, DECL-03, DECL-04, BASE-02, BASE-04,
 * TOOL-01, TOOL-03.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  assertValidContract,
  assertValidInput,
  assertValidOutput,
  ContractError,
  ContractViolationError,
  crossFieldRules,
  langDetect,
  ProjectionError,
  projectToDsh,
  STANDARD_CONTRACTS,
  sttTranscribe,
  toDshParameters,
  withMeta,
  type ToolContract,
} from '../src/index.ts'

/** A minimal valid meta envelope, for building result fixtures. */
const meta = {
  contract: 'stt.transcribe',
  contractVersion: '1.0.0',
  implementationId: 'test-impl',
  extension: '@try-works/tool-mode-test',
  extensionVersion: '0.1.0',
  activationGeneration: 1,
  executionLocation: 'host',
  receiptId: 'rcpt_test_1',
  warnings: [],
}

describe('DECL-01 — contract identity', () => {
  it('every standard contract is valid and registers its validators', () => {
    for (const contract of STANDARD_CONTRACTS) assertValidContract(contract)
    assert.ok(STANDARD_CONTRACTS.length >= 2)
  })

  it('tool identity is independent of model identity (BASE-02)', () => {
    // The contract layer names tools and knows nothing about models: no standard
    // contract may mention a model id, which is what lets two models serve one
    // transcription tool instead of producing a duplicate each.
    for (const contract of STANDARD_CONTRACTS) {
      const text = JSON.stringify(contract)
      for (const model of ['voz', 'tongue', 'whisper', 'laya', 'gemma']) {
        assert.equal(
          text.toLowerCase().includes(`"${model}`),
          false,
          `${contract.contract} must not name the model ${model}`,
        )
      }
    }
  })

  it('rejects a contract whose toolName is not addressable', () => {
    const broken = { ...sttTranscribe, toolName: 'STT Transcribe' }
    assert.throws(() => assertValidContract(broken), (error: unknown) => {
      assert.ok(error instanceof ContractError)
      assert.match(error.message, /lower snake_case/)
      return true
    })
  })

  it('rejects a non-semantic contract version', () => {
    assert.throws(
      () => assertValidContract({ ...sttTranscribe, version: 'v1' }),
      /must be semantic/,
    )
  })
})

describe('DECL-02 — real schemas, not generic open objects', () => {
  it('refuses a contract whose output is an unconstrained open object', () => {
    const loose: ToolContract = {
      ...sttTranscribe,
      outputSchema: { type: 'object', additionalProperties: true, properties: { meta: {} } },
    }
    assert.throws(() => assertValidContract(loose), /must be closed/)
  })

  it('refuses a contract missing the shared meta envelope', () => {
    const bare: ToolContract = {
      ...sttTranscribe,
      outputSchema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
    }
    assert.throws(() => assertValidContract(bare), /meta/)
  })

  it('refuses a contract that claims universal support', () => {
    assert.throws(
      () => assertValidContract({ ...sttTranscribe, unsupported: [] }),
      /claims universal support/,
    )
  })

  it('publishes real requiredness rather than inferring it from order (BASE-04)', () => {
    const params = toDshParameters(sttTranscribe)
    assert.deepEqual(Object.keys(params), ['audio', 'language', 'timestamps'])
    assert.equal(params.audio?.required, true, 'audio is required because the schema says so')
    assert.equal(params.language?.required, undefined, 'language is optional')
    assert.equal(params.timestamps?.required, undefined)
  })

  it('preserves descriptions and defaults through projection', () => {
    const params = toDshParameters(langDetect)
    assert.match(String(params.text?.description), /text to identify/i)
    assert.equal(params.top?.default, 3)
  })

  it('reports a constraint DSH cannot advertise, and still enforces it (BASE-04)', () => {
    const constrained = toLooseContract({
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string', minLength: 3 } },
      },
    })
    const projection = projectToDsh(constrained)
    // It is not silently discarded: the parameter schema cannot advertise
    // minLength, so the fact is reported rather than lost.
    assert.deepEqual(projection.runtimeEnforced, ['text.minLength'])
    assert.equal((projection.parameters.text as { minLength?: unknown }).minLength, undefined)

    // And it is genuinely enforced, because argument validation runs against the
    // untouched contract rather than against the projected subset. Registering
    // first is required: validation refuses to run against an uncompiled contract
    // rather than silently skipping the check.
    assertValidContract(constrained)
    assertValidInput(constrained, { text: 'abc' })
    assert.throws(() => assertValidInput(constrained, { text: 'ab' }), ContractViolationError)
  })

  it('refuses to validate arguments before the contract is registered', () => {
    // A distinct contract id: validators are cached per contract, so reusing the
    // shared fixture's id would find a validator registered by an earlier test and
    // the assertion would pass for the wrong reason.
    assert.throws(
      () => assertValidInput(toLooseContract({ contract: 'test.unregistered', toolName: 'test_unregistered' }), { ok: true }),
      /before the contract was registered/,
    )
  })

  it('refuses a contract whose required property is not declared', () => {
    const inconsistent = toLooseContract({
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['missing'],
        properties: { present: { type: 'string' } },
      },
    })
    assert.throws(() => projectToDsh(inconsistent), ProjectionError)
  })
})

describe('DECL-03 / DECL-04 — the shared result envelope', () => {
  it('accepts a well-formed result', () => {
    const value = {
      text: 'hello',
      coverage: { complete: true, transcribedSeconds: 1.5 },
      words: null,
      language: 'en',
      meta,
    }
    assertValidOutput(sttTranscribe, value)
  })

  it('refuses a result missing the envelope', () => {
    const value = { text: 'hello', coverage: { complete: true, transcribedSeconds: 1.5 } }
    assert.throws(() => assertValidOutput(sttTranscribe, value), (error: unknown) => {
      assert.ok(error instanceof ContractViolationError)
      assert.match(error.message, /meta/)
      return true
    })
  })

  it('refuses a nested field violation, not only a top-level one (AT-11)', () => {
    const value = {
      text: 'hello',
      coverage: { complete: true, transcribedSeconds: -1 },
      meta,
    }
    assert.throws(() => assertValidOutput(sttTranscribe, value), /transcribedSeconds/)
  })

  it('refuses a fabricated confidence field (DECL-04)', () => {
    const value = {
      text: 'hi',
      coverage: { complete: true, transcribedSeconds: 1 },
      confidence: 0.95,
      meta,
    }
    assert.throws(() => assertValidOutput(sttTranscribe, value), /additional propert/i)
  })

  it('requires the caller-visible provenance fields', () => {
    const partial = { ...meta, receiptId: undefined }
    const value = { text: 'hi', coverage: { complete: true, transcribedSeconds: 1 }, meta: partial }
    assert.throws(() => assertValidOutput(sttTranscribe, value), /receiptId/)
  })
})

describe('TOOL-01 / TOOL-03 — declared semantics', () => {
  it('transcription declares that it does not translate and states its units', () => {
    assert.equal(sttTranscribe.semantics.translation, false)
    assert.equal(sttTranscribe.semantics.operation, 'transcription')
    assert.equal(sttTranscribe.semantics.timestampUnit, 'seconds')
    assert.equal(sttTranscribe.semantics.emptyResultMeaning, 'valid-empty-transcript')
  })

  it('marks partial coverage explicitly so an incomplete clip is not presented as complete', () => {
    const partial = {
      text: 'first words only',
      coverage: { complete: false, transcribedSeconds: 12, totalSeconds: 300, reason: 'duration cap' },
      meta,
    }
    assertValidOutput(sttTranscribe, partial)
    const shape = sttTranscribe.outputSchema as { properties: Record<string, { required: string[] }> }
    assert.ok(shape.properties.coverage?.required.includes('complete'))
  })

  it('an empty transcript is a valid result, not an error', () => {
    assertValidOutput(sttTranscribe, {
      text: '',
      coverage: { complete: true, transcribedSeconds: 0 },
      words: [],
      meta,
    })
  })

  it('language detection refuses to claim it processed audio (TOOL-03)', () => {
    assert.equal(langDetect.semantics.appliesTo, 'written-text-only')
    assert.ok(langDetect.unsupported.some(line => /spoken language/i.test(line)))
  })

  it('preserves ambiguity instead of collapsing it to one answer', () => {
    const ambiguous = {
      language: 'no',
      reliability: 'tentative',
      tooCloseToCall: true,
      candidates: [
        { language: 'no', probability: 0.51 },
        { language: 'da', probability: 0.49 },
      ],
      meta: { ...meta, contract: 'text.language_detect' },
    }
    assertValidOutput(langDetect, ambiguous)
  })
})

describe('BASE-04 — cross-field constraints', () => {
  it('rejects a channel count the admitted input forbids', () => {
    const rules = crossFieldRules(sttTranscribe)
    const violation = rules.map(rule => rule({ audio: { path: 'a.wav', channels: 2 } })).find(Boolean)
    assert.match(String(violation), /must be 1/)
  })

  it('rejects a sample rate that would silently require resampling', () => {
    const rules = crossFieldRules(sttTranscribe)
    const violation = rules.map(rule => rule({ audio: { path: 'a.wav', sampleRateHz: 44100 } })).find(Boolean)
    assert.match(String(violation), /16000/)
  })

  it('accepts the admitted input', () => {
    const rules = crossFieldRules(sttTranscribe)
    for (const rule of rules) {
      assert.equal(rule({ audio: { path: 'a.wav', sampleRateHz: 16000, channels: 1 } }), undefined)
    }
  })

  it('rejects whitespace-only language-detection input', () => {
    const rules = crossFieldRules(langDetect)
    const violation = rules.map(rule => rule({ text: '   ' })).find(Boolean)
    assert.match(String(violation), /non-whitespace/)
  })

  it('reports no rules for a contract that declares none', () => {
    assert.deepEqual(crossFieldRules(toLooseContract({})), [])
  })
})

describe('input validation', () => {
  it('refuses unknown top-level arguments', () => {
    assert.throws(
      () => assertValidInput(sttTranscribe, { audio: { path: 'a.wav' }, words: true }),
      ContractViolationError,
    )
  })

  it('refuses a missing required field', () => {
    assert.throws(() => assertValidInput(sttTranscribe, {}), /audio/)
  })

  it('accepts the minimal valid call', () => {
    assertValidInput(sttTranscribe, { audio: { path: 'a.wav' } })
  })
})

/** Build a minimal contract for projection-focused tests. */
function toLooseContract(overrides: Partial<ToolContract>): ToolContract {
  return {
    contract: 'test.projection',
    version: '1.0.0',
    toolName: 'test_projection',
    description: 'A contract used only to exercise projection behaviour.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: withMeta({ ok: { type: 'boolean' } }, ['ok']),
    semantics: { purpose: 'testing' },
    limits: {},
    unsupported: ['nothing: this contract exists only for tests'],
    ...overrides,
  }
}
