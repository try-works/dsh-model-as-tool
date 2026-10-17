/**
 * MODEL-05 — the tongue qualification record is REAL and the path it names
 * actually runs (real inference, real SHA).
 *
 * The record lives in the extension's models.lock.json next to the asset set it
 * qualifies. This test proves two things a written record alone cannot:
 *
 * 1. The artifactSha in the record IS the SHA-256 of the weight file the
 *    installed package ships — recomputed here, not copied from the record.
 * 2. The path the record names (this Node ABI, this architecture, this
 *    execution provider) runs REAL inference: the installed @desert-ant-labs/tongue
 *    package detects known-language inputs correctly.
 *
 * The model package is an OPTIONAL dependency, so the file skips (rather than
 * fails) when it is absent — the same rule the extension's own inspect uses.
 */

import { readFileSync, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pipeline } from 'node:stream/promises'
import semver from 'semver'

import { discoverExtension } from '@try-works/tool-mode-extension-sdk'

after(() => {})

/** SHA-256 of a file, streamed so the 2 MB bin never sits fully in memory. */
async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** Load the installed model package, or skip ONLY the real-inference half when absent. */
const TONGUE_PACKAGE = '@desert-ant-labs/tongue'
const packageResolvable = (() => {
  try {
    import.meta.resolve(`${TONGUE_PACKAGE}/package.json`)
    return true
  } catch {
    return false
  }
})()
const SKIP = packageResolvable ? undefined : `the optional dependency ${TONGUE_PACKAGE} is not installed`

/** The lock record this test qualifies. */
function lockQualification(): Record<string, unknown> {
  const discovery = discoverExtension(
    new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  )
  const lock = JSON.parse(readFileSync(new URL('../models.lock.json', import.meta.url), 'utf8')) as {
    assetSets: Record<string, { qualification?: Record<string, unknown> }>
  }
  const assetSet = discovery.manifest.models[0]?.assetSet
  assert.ok(assetSet !== undefined, 'the manifest must declare a model with an asset set')
  const qualification = lock.assetSets[assetSet]?.qualification
  assert.ok(qualification !== undefined, 'the lock must carry a qualification record')
  return qualification
}

describe('MODEL-05 — the tongue qualification record', () => {
  const QUALIFICATION_FIELDS = [
    'modelRevision', 'artifactSha', 'tokenizer', 'processor',
    'engineVersion', 'nodeAbi', 'architecture', 'executionProvider',
  ] as const

  it('carries every field the record requires, none blank', () => {
    const record = lockQualification()
    for (const field of QUALIFICATION_FIELDS) {
      const value = record[field]
      assert.equal(typeof value, 'string', `${field} must be a string`)
      assert.ok(value.length > 0, `${field} must not be blank`)
    }
  })

  it('the DECLARED dependency range admits the revision the record qualifies', () => {
    // The round-46 review's sharpest finding: the extension's own range used to
    // admit only 1.2.0 while the record qualifies 3.6.0, so a clean install ran
    // a revision nothing qualified. The range must admit the recorded revision,
    // or the record and the install agree on nothing.
    const record = lockQualification()
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      optionalDependencies?: Record<string, string>
    }
    const range = manifest.optionalDependencies?.[TONGUE_PACKAGE]
    assert.ok(typeof range === 'string' && range.length > 0, 'the extension must declare the model package range')
    assert.ok(
      semver.satisfies(String(record.modelRevision), range),
      `the declared range ${range} does not admit the qualified revision ${String(record.modelRevision)}`,
    )
  })

  it('names the ACTUAL loaded artifact: the SHA is recomputed from the shipped bin', { skip: SKIP }, async () => {
    const record = lockQualification()
    const binUrl = import.meta.resolve(`${TONGUE_PACKAGE}/model/tongue_int8.bin`)
    const binPath = new URL(binUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1')
    const recomputed = await sha256(binPath)
    assert.equal(record.artifactSha, `sha256:${recomputed}`, 'the record must name the bytes that actually ship')
  })

  it('names the REAL revision: the installed package version', { skip: SKIP }, () => {
    const record = lockQualification()
    const manifest = JSON.parse(readFileSync(
      new URL(import.meta.resolve(`${TONGUE_PACKAGE}/package.json`)).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      'utf8',
    )) as { version: string }
    assert.equal(record.modelRevision, manifest.version)
  })

  it('RUNS REAL INFERENCE through the qualified path, detecting known languages', { skip: SKIP }, async () => {
    const record = lockQualification()
    assert.equal(record.architecture, process.arch, 'the record must match this process architecture')
    assert.equal(record.nodeAbi.split(' ')[0], process.versions.modules, 'the record must match this Node ABI')

    const { Tongue } = await import(TONGUE_PACKAGE) as {
      Tongue: { load(): Promise<{ detect(text: string): { language?: string } }> }
    }
    const model = await Tongue.load()
    // A small matrix of unambiguous samples: a correct implementation returns
    // the language for each, and the assertions are on the REAL result.
    const samples: [string, string][] = [
      ['this is a sentence about engineering', 'en'],
      ['esta es una frase en español', 'es'],
      ['dies ist ein deutscher satz', 'de'],
      ['voici une phrase française', 'fr'],
    ]
    for (const [text, expected] of samples) {
      const detection = model.detect(text)
      assert.equal(
        detection.language,
        expected,
        `the qualified path must detect ${JSON.stringify(text)} as ${expected}, got ${String(detection.language)}`,
      )
    }
  })

  it('the extension invoke produces the FULL contract payload from real inference', { skip: SKIP }, async () => {
    // The round-46 review: the matrix asserted only `language` on the RAW model,
    // so a lookup-table stub would pass and the contract fields the caller sees
    // (reliability, tooCloseToCall, ranked candidates) were unproven. This drives
    // the extension's OWN invoke() mapping — the code a host calls — and asserts
    // the contract shape on real results.
    const entry = await import('../src/index.ts')
    const instance = await entry.default.create({
      extensionId: '@try-works/extension-desert-ant-tongue',
      extensionVersion: '0.1.0',
      activationGeneration: 1,
      storage: { directory: '', async read() { return undefined }, async write() { /* no-op */ } },
      logger: { log: () => { /* silent */ } },
      signal: new AbortController().signal,
      configuration: {},
    })
    const provider = await instance.createProvider({ modelId: 'tongue', configuration: {} })
    const payload = await provider.invoke({
      implementationId: 'tongue',
      input: { text: 'this is a sentence about engineering', top: 3 },
      context: { signal: new AbortController().signal },
    })
    // The contract requires a language string, a reliability verdict from the
    // fixed vocabulary, a boolean tie flag, and ranked candidates with bounded
    // probabilities.
    assert.equal(payload.language, 'en')
    assert.ok(['confident', 'likely', 'tentative', 'unknown'].includes(String(payload.reliability)), `reliability ${String(payload.reliability)} is not in the contract vocabulary`)
    assert.equal(typeof payload.isTooCloseToCall, 'boolean')
    const candidates = payload.candidates as readonly { language: string; probability: number }[]
    assert.ok(Array.isArray(candidates))
    assert.equal(candidates[0]?.language, 'en', 'the top candidate must be the detected language')
    for (const candidate of candidates) {
      assert.ok(typeof candidate.language === 'string' && candidate.language.length > 0)
      assert.ok(typeof candidate.probability === 'number' && candidate.probability >= 0 && candidate.probability <= 1)
    }
    await provider.dispose()
  })
})
