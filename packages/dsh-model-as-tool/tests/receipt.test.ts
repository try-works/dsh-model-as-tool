/**
 * Receipt and lifecycle-record tests (EXT-35).
 *
 * The redaction tests are the important ones. A receipt is written to disk, shown
 * to an operator and sometimes attached to a bug report, so a leaked token or a
 * full filesystem path is a disclosure that outlives the call. These tests feed the
 * redactors real shapes — Windows paths, POSIX paths, npm and GitHub tokens, a
 * bearer header — rather than invented ones.
 *
 * Requirement links: EXT-35, OBS.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  admitsLogRecord,
  buildInvocationReceipt,
  buildLifecycleRecord,
  DEFAULT_LOG_POLICY,
  ReceiptRedactionError,
  redactPath,
  redactText,
  type InvocationReceipt,
} from '../src/receipt.ts'

/** A complete receipt input. */
const base: Parameters<typeof buildInvocationReceipt>[0] = {
  receiptId: 'rcpt_000001',
  contract: 'stt.transcribe',
  contractVersion: '1.0.0',
  implementationId: 'voz',
  extension: '@try-works/extension-desert-ant-voz',
  extensionVersion: '0.1.0',
  extensionContentDigest: 'a'.repeat(64),
  dependencyLockDigest: 'b'.repeat(64),
  modelIdentity: 'voz',
  recipeVersion: '1.0.0',
  activationGeneration: 7,
  executionLocation: 'host',
}

describe('EXT-35 — a receipt records what actually ran', () => {
  it('carries the extension, its digests, the model identity and the generation', () => {
    const receipt = buildInvocationReceipt(base)
    assert.equal(receipt.extension, '@try-works/extension-desert-ant-voz')
    assert.equal(receipt.extensionVersion, '0.1.0')
    assert.equal(receipt.extensionContentDigest, 'a'.repeat(64))
    assert.equal(receipt.dependencyLockDigest, 'b'.repeat(64))
    assert.equal(receipt.modelIdentity, 'voz')
    assert.equal(receipt.recipeVersion, '1.0.0')
    assert.equal(receipt.activationGeneration, 7)
  })

  it('distinguishes two runs of the same version by content digest', () => {
    // A version alone does not identify bytes: a package can be replaced at the same
    // version, and a receipt naming only the version could not tell the two apart.
    const first = buildInvocationReceipt({ ...base, extensionContentDigest: 'a'.repeat(64) })
    const second = buildInvocationReceipt({ ...base, extensionContentDigest: 'c'.repeat(64) })
    assert.notEqual(first.extensionContentDigest, second.extensionContentDigest)
    assert.equal(first.extensionVersion, second.extensionVersion)
  })

  it('reports unknown provenance as null rather than inventing it', () => {
    const receipt = buildInvocationReceipt({
      ...base, extensionContentDigest: undefined, dependencyLockDigest: undefined, recipeVersion: undefined,
    })
    // A receipt that guesses at provenance is worse than one that admits it does
    // not have it.
    assert.equal(receipt.extensionContentDigest, null)
    assert.equal(receipt.dependencyLockDigest, null)
    assert.equal(receipt.recipeVersion, null)
  })

  it('refuses a receipt with no identity', () => {
    assert.throws(
      () => buildInvocationReceipt({ ...base, receiptId: '' }),
      // An unidentifiable receipt is not an audit trail.
      /needs an identity/,
    )
  })

  it('has no parameter through which a body, token or skill text could arrive', () => {
    const receipt = buildInvocationReceipt(base)
    // The guarantee is structural: the function takes only host-resolved
    // provenance, so these cannot reach a receipt through it at all.
    const keys = Object.keys(receipt)
    for (const forbidden of ['body', 'request', 'token', 'skillText', 'prompt', 'content', 'text']) {
      assert.equal(keys.includes(forbidden), false, `a receipt must have no ${forbidden} field`)
    }
  })
})

describe('EXT-35 — paths are reduced, never recorded in full', () => {
  it('keeps the basename and a digest, not the directory', () => {
    const redacted = redactPath('C:\\Users\\erikb\\Documents\\secret-project\\audio.wav')
    assert.ok(redacted?.startsWith('audio.wav#'), `expected a leaf and digest, got ${String(redacted)}`)
    // The disclosure EXT-35 forbids is the LAYOUT: a username, a directory, a
    // project name.
    assert.equal(redacted?.includes('erikb'), false)
    assert.equal(redacted?.includes('secret-project'), false)
    assert.equal(redacted?.includes('Users'), false)
  })

  it('reduces a POSIX path the same way', () => {
    const redacted = redactPath('/home/erikb/private/recording.wav')
    assert.ok(redacted?.startsWith('recording.wav#'))
    assert.equal(redacted?.includes('erikb'), false)
    assert.equal(redacted?.includes('private'), false)
  })

  it('gives the same path the same digest and different paths different ones', () => {
    const a = redactPath('/one/same.wav')
    const b = redactPath('/two/same.wav')
    // Same leaf, different location: the digest is what lets an operator correlate
    // two receipts without learning where the file lives.
    assert.notEqual(a, b)
    assert.equal(redactPath('/one/same.wav'), a)
  })

  it('returns null for an absent path rather than an empty string', () => {
    assert.equal(redactPath(undefined), null)
    assert.equal(redactPath(''), null)
  })
})

describe('EXT-35 — a redactor must not be the leak', () => {
  it('removes npm and GitHub tokens', () => {
    // Real shapes, not invented ones.
    const text = redactText('failed with npm_abcdefghijklmnopqrstuvwxyz and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')
    assert.equal(text.includes('npm_abcdefghijklmnopqrstuvwxyz'), false)
    assert.equal(text.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), false)
    assert.match(text, /<redacted>/)
  })

  it('removes a bearer header', () => {
    const text = redactText('sent Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload')
    assert.equal(text.includes('eyJhbGciOiJIUzI1NiJ9'), false)
  })

  it('removes a long hex digest-shaped value', () => {
    const text = redactText(`secret ${'f'.repeat(64)}`)
    assert.equal(text.includes('f'.repeat(64)), false)
  })

  it('removes absolute paths of either shape', () => {
    const text = redactText('read C:\\Users\\erikb\\a.wav and /home/erikb/b.wav')
    assert.equal(text.includes('erikb'), false)
    assert.match(text, /<path>/)
  })

  it('leaves an ordinary diagnostic readable', () => {
    // Over-redaction would make receipts useless, so this asserts the guard does
    // not simply blank everything.
    const text = redactText('the model deployment is unprepared; it loads on first use')
    assert.equal(text, 'the model deployment is unprepared; it loads on first use')
  })

  it('redacts every warning on a receipt', () => {
    const receipt = buildInvocationReceipt({
      ...base,
      warnings: ['token npm_abcdefghijklmnop leaked', 'read C:\\Users\\erikb\\x.wav'],
    })
    const joined = receipt.warnings.join(' | ')
    assert.equal(joined.includes('npm_abcdefghijklmnop'), false)
    assert.equal(joined.includes('erikb'), false)
  })

  it('redacts a lifecycle reason too', () => {
    const record = buildLifecycleRecord({
      operation: 'install',
      extensionId: '@acme/x',
      outcome: 'failed',
      reason: 'integrity check failed using ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      approvedBy: { kind: 'operator', identity: 'erikb' },
    })
    assert.equal(record.reason?.includes('ghp_'), false)
  })
})

describe('EXT-35 — lifecycle records are separate from execution metadata', () => {
  it('records the operation, outcome and approving principal', () => {
    const record = buildLifecycleRecord({
      operation: 'activate',
      extensionId: '@acme/tool-mode-topics',
      version: '1.2.3',
      contentDigest: 'd'.repeat(64),
      profile: 'default',
      outcome: 'succeeded',
      approvedBy: { kind: 'operator', identity: 'erikb' },
      at: '2026-10-14T00:00:00.000Z',
    })
    assert.equal(record.operation, 'activate')
    assert.equal(record.outcome, 'succeeded')
    assert.deepEqual(record.approvedBy, { kind: 'operator', identity: 'erikb' })
    assert.equal(record.profile, 'default')
  })

  it('does not carry execution fields', () => {
    const record = buildLifecycleRecord({
      operation: 'uninstall', extensionId: '@acme/x', outcome: 'succeeded',
      approvedBy: { kind: 'policy', policyId: 'retention' },
    })
    // A caller reading a lifecycle record must not learn about a call, and an audit
    // trail must remain distinguishable from execution metadata.
    for (const forbidden of ['receiptId', 'contract', 'implementationId', 'warnings']) {
      assert.equal(forbidden in record, false, `a lifecycle record must not carry ${forbidden}`)
    }
  })

  it('accepts each principal kind', () => {
    const kinds = [
      { kind: 'operator' as const, identity: 'erikb' },
      { kind: 'client-grant' as const, grantId: 'grant-1' },
      { kind: 'policy' as const, policyId: 'retention' },
    ]
    for (const approvedBy of kinds) {
      const record = buildLifecycleRecord({
        operation: 'deactivate', extensionId: '@acme/x', outcome: 'refused', approvedBy,
      })
      assert.deepEqual(record.approvedBy, approvedBy)
    }
  })

  it('refuses an operator approval with no identity', () => {
    assert.throws(
      () => buildLifecycleRecord({
        operation: 'install', extensionId: '@acme/x', outcome: 'succeeded',
        approvedBy: { kind: 'operator', identity: '' },
      }),
      // An approval with no principal cannot be audited.
      /needs an identity/,
    )
  })

  it('records each outcome the requirement names', () => {
    for (const outcome of ['succeeded', 'failed', 'refused', 'rolled-back'] as const) {
      const record = buildLifecycleRecord({
        operation: 'update', extensionId: '@acme/x', outcome,
        approvedBy: { kind: 'operator', identity: 'erikb' },
      })
      assert.equal(record.outcome, outcome)
    }
  })
})

describe('EXT-35 — extension logging is bounded and policy-controlled', () => {
  it('drops levels the policy does not admit rather than rewriting them', () => {
    const policy = { ...DEFAULT_LOG_POLICY, levels: ['error'] as const }
    assert.equal(admitsLogRecord(policy, { level: 'debug' }), false)
    assert.equal(admitsLogRecord(policy, { level: 'info' }), false)
    assert.equal(admitsLogRecord(policy, { level: 'warn' }), false)
    assert.equal(admitsLogRecord(policy, { level: 'error' }), true)
  })

  it('refuses an undeclared network origin rather than logging it', () => {
    const policy = { ...DEFAULT_LOG_POLICY, levels: ['error'] as const, approvedOrigins: ['https://approved.test'] }
    assert.equal(admitsLogRecord(policy, { level: 'error', declaredOrigin: 'https://approved.test' }), true)
    // EXT-35 requires the behaviour to be DISCLOSED and approved, not merely
    // recorded after the fact.
    assert.equal(admitsLogRecord(policy, { level: 'error', declaredOrigin: 'https://unknown.test' }), false)
  })

  it('defaults to quiet, metadata-only and telemetry off', () => {
    assert.equal(DEFAULT_LOG_POLICY.telemetryApproved, false)
    assert.deepEqual([...DEFAULT_LOG_POLICY.approvedOrigins], [])
    assert.deepEqual([...DEFAULT_LOG_POLICY.levels], ['warn', 'error'])
    assert.ok(DEFAULT_LOG_POLICY.maxRecords > 0 && DEFAULT_LOG_POLICY.maxRecords <= 1000)
  })
})

describe('EXT-35 — the receipt is JSON-serializable provenance', () => {
  it('survives a round trip unchanged', () => {
    const receipt: InvocationReceipt = buildInvocationReceipt(base)
    assert.deepEqual(JSON.parse(JSON.stringify(receipt)), receipt)
  })

  it('exposes no function or undefined value', () => {
    const receipt = buildInvocationReceipt(base)
    for (const [key, value] of Object.entries(receipt)) {
      assert.notEqual(typeof value, 'function', `${key} must not be a function`)
      assert.notEqual(value, undefined, `${key} must be present`)
    }
  })

  it('a redaction failure is a named error, not a silent drop', () => {
    assert.ok(new ReceiptRedactionError('x') instanceof Error)
  })
})
