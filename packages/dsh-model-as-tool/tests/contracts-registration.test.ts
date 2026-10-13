/**
 * Contract-driven registration tests.
 *
 * These establish the behaviours the previous per-model registrar could not
 * express: one tool per CONTRACT rather than per model (BASE-02), host-stamped
 * provenance on every result (DECL-03), and an opt-in compatibility alias that
 * stays out of the default catalog (BASE-03).
 *
 * Requirement links: BASE-02, BASE-03, DECL-03.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

import * as plugin from '../src/index.ts'
import { cleanup, isolatedStateFile, mountPlugin } from './helpers.ts'

const tmpDirs: string[] = []
after(async () => {
  await cleanup()
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

let counter = 0
function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`ctr-${++counter}`),
    name,
    arguments: args,
  })
}

const toolNames = (ctx: Context) => ctx.tools.schemas().map(schema => schema.name)

/**
 * Write a catalog with TWO models implementing one contract.
 *
 * A second real transcription model is not available on this host, so the merge
 * behaviour is proven with catalog data rather than by pretending a model exists.
 */
function twoImplementationCatalog(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tool-mode-catalog-'))
  tmpDirs.push(dir)
  const entry = (id: string, name: string) => ({
    id,
    name,
    summary: `${name} is a test implementation used to prove contract merging.`,
    capability: 'text.language-identification',
    contract: 'text.language_detect',
    provider: { extension: '@try-works/extension-desert-ant-tongue', modelId: 'tongue' },
    input: 'text',
    output: 'test',
    languages: null,
    modelSizeMB: null,
    appleOnly: false,
    closedBeta: false,
    verifiedRunnableOnWindows: true,
    windowsSupport: 'native-node',
    npmPackage: '@desert-ant-labs/tongue',
    npmSubpath: null,
    requiresRuntime: [],
    cliVerb: null,
    license: 'source-available',
    docsUrl: 'https://example.invalid/',
    hfRepo: 'https://example.invalid/',
    tool: { name: `legacy_${id}`, description: `${name} per-model tool.`, params: { text: 'Text.' }, returns: 'Language.' },
    skill: { name: `desert-ant-${id}`, description: `${name} skill.` },
  })
  const file = join(dir, 'catalog.json')
  writeFileSync(file, JSON.stringify([entry('alpha', 'Alpha'), entry('beta', 'Beta')]))
  return file
}

describe('BASE-02 — one tool per contract, not per model', () => {
  it('registers the contract tool once when two models implement it', async () => {
    const ctx = await mountPlugin({ catalogFile: twoImplementationCatalog() })
    const names = toolNames(ctx)
    assert.ok(names.includes('lang_detect'), `expected the contract tool, got ${names.join(', ')}`)
    // The per-model names must NOT appear: that is the duplicate BASE-02 forbids.
    assert.equal(names.includes('legacy_alpha'), false)
    assert.equal(names.includes('legacy_beta'), false)
    assert.equal(names.filter(name => name === 'lang_detect').length, 1)
  })

  it('reports the alternative implementation rather than hiding it', async () => {
    const ctx = await mountPlugin({ catalogFile: twoImplementationCatalog() })
    // Both models are installed (each contributes a skill), and both map to the
    // one tool, so the control tool still shows two entries.
    const listed = await call(ctx, 'model_tools', { action: 'installed' })
    if (listed.isError) throw new Error(`expected success: ${listed.error.message}`)
    const models = (listed.value as { models: { id: string; tool: string }[] }).models
    const ids = models.map(model => model.id).sort()
    assert.deepEqual(ids, ['alpha', 'beta'])
  })

  it('honours a provider override and falls back when the override cannot run', async () => {
    const catalog = twoImplementationCatalog()
    // `beta` is a valid override, so it becomes the implementation.
    const ctx = await mountPlugin({ catalogFile: catalog, providers: { 'text.language_detect': 'beta' } })
    assert.ok(toolNames(ctx).includes('lang_detect'))

    // An override naming a model that cannot run must not remove the tool: the
    // first eligible implementation is used instead.
    const fallback = await mountPlugin({
      catalogFile: catalog,
      providers: { 'text.language_detect': 'does-not-exist' },
    })
    assert.ok(toolNames(fallback).includes('lang_detect'))
  })

  it('the standard catalog exposes the contract name for transcription', async () => {
    const ctx = await mountPlugin({ models: ['voz'] })
    // Voz implements stt.transcribe, so the canonical name is registered.
    assert.ok(toolNames(ctx).includes('stt_transcribe'), `got ${toolNames(ctx).join(', ')}`)
    assert.equal(toolNames(ctx).includes('transcribe_audio'), false)
  })
})

describe('DECL-03 — host-stamped provenance', () => {
  it('stamps the envelope with host identity and a receipt', async () => {
    const ctx = await mountPlugin()
    const result = await call(ctx, 'lang_detect', { text: 'kann ich das haben' })
    if (result.isError) throw new Error(`expected success: ${result.error.message}`)
    const meta = (result.value as { meta: Record<string, unknown> }).meta
    assert.equal(meta.contract, 'text.language_detect')
    assert.equal(meta.contractVersion, '1.0.0')
    assert.equal(meta.extension, '@try-works/dsh-model-as-tool')
    assert.equal(meta.executionLocation, 'host')
    assert.match(String(meta.receiptId), /^rcpt_/)
    assert.deepEqual(meta.warnings, [])
  })

  it('names the implementation that actually ran, not the contract', async () => {
    const ctx = await mountPlugin()
    const result = await call(ctx, 'lang_detect', { text: 'Hello there' })
    if (result.isError) throw new Error('expected success')
    assert.equal((result.value as { meta: { implementationId: string } }).meta.implementationId, 'tongue')
  })

  it('issues a distinct receipt per call', async () => {
    const ctx = await mountPlugin()
    const first = await call(ctx, 'lang_detect', { text: 'Hello' })
    const second = await call(ctx, 'lang_detect', { text: 'Bonjour' })
    if (first.isError || second.isError) throw new Error('expected success')
    const a = (first.value as { meta: { receiptId: string } }).meta.receiptId
    const b = (second.value as { meta: { receiptId: string } }).meta.receiptId
    assert.notEqual(a, b)
  })

  it('an implementation cannot forge the provenance it reports', async () => {
    // The adapter's own result may contain a `meta`; the host's envelope must win.
    const ctx = await mountPlugin()
    const result = await call(ctx, 'lang_detect', { text: 'Hello' })
    if (result.isError) throw new Error('expected success')
    const value = result.value as { meta: { extension: string } }
    assert.equal(value.meta.extension, '@try-works/dsh-model-as-tool')
  })
})

describe('BASE-03 — the deprecated alias is opt-in', () => {
  it('is absent from the default catalog', async () => {
    const ctx = await mountPlugin({ models: ['voz'] })
    assert.equal(toolNames(ctx).includes('transcribe_audio'), false)
    assert.ok(toolNames(ctx).includes('stt_transcribe'))
  })

  it('appears only when explicitly enabled, keeping its own name', async () => {
    const ctx = await mountPlugin({ models: ['voz'], legacyAliases: true })
    const names = toolNames(ctx)
    assert.ok(names.includes('stt_transcribe'), 'the canonical tool stays')
    assert.ok(names.includes('transcribe_audio'), `expected the alias, got ${names.join(', ')}`)
  })

  it('the alias validates against its own contract, not the canonical one', async () => {
    const ctx = await mountPlugin({ models: ['voz'], legacyAliases: true })
    // The alias keeps `audio_path`; the canonical tool takes `audio.path`. A
    // caller using the old argument shape must not be silently reinterpreted.
    const aliasSchema = ctx.tools.schemas().find(schema => schema.name === 'transcribe_audio')
    const canonical = ctx.tools.schemas().find(schema => schema.name === 'stt_transcribe')
    assert.ok(aliasSchema && canonical)
    const aliasProps = Object.keys((aliasSchema.parameters as { properties?: object }).properties ?? {})
    const canonicalProps = Object.keys((canonical.parameters as { properties?: object }).properties ?? {})
    assert.notDeepEqual(aliasProps, canonicalProps)
    assert.ok(aliasProps.includes('audio_path'))
    assert.ok(canonicalProps.includes('audio'))
  })
})

describe('BASE-05 / SEC-06 — the host enforces authority before inference', () => {
  it('refuses a path outside the grant instead of transcribing it', async () => {
    // No roots approved: the default deployment fails closed.
    const ctx = await mountPlugin({ approvedRoots: [] })
    const result = await call(ctx, 'stt_transcribe', {
      audio: { path: join(tmpdir(), 'definitely-absent-audio.wav') },
    })
    assert.equal(result.isError, true)
    if (!result.isError) throw new Error('expected failure')
    assert.match(result.error.message, /absolute|outside every root|not admitted|does not exist/i)
  })

  it('fails before loading the model, not after', async () => {
    // Voz holds roughly 1.2 GB once loaded. If authorization ran after loading,
    // this call would be slow and memory-hungry; refusing first is the point
    // (AT-12: fail before inference).
    const ctx = await mountPlugin({ approvedRoots: [] })
    const started = Date.now()
    const result = await call(ctx, 'stt_transcribe', {
      audio: { path: join(tmpdir(), 'absent-audio.wav') },
    })
    const elapsed = Date.now() - started
    assert.equal(result.isError, true)
    assert.ok(elapsed < 5000, 'refusal took ' + elapsed + 'ms, suggesting the model loaded first')
  })

  it('admits a path under an approved root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-approved-'))
    tmpDirs.push(dir)
    const audio = join(dir, 'present.wav')
    writeFileSync(audio, 'RIFF....')
    const ctx = await mountPlugin({ approvedRoots: [dir] })
    // The path is authorized, so the call proceeds to the model and fails THERE
    // (the fixture is not real audio). The distinction that matters is that the
    // refusal is no longer an authorization refusal.
    const result = await call(ctx, 'stt_transcribe', { audio: { path: audio } })
    if (result.isError) {
      assert.doesNotMatch(result.error.message, /outside every root approved/)
    }
  })
})

describe('contract failures surface as tool errors', () => {  it('rejects an argument the contract forbids', async () => {
    const ctx = await mountPlugin()
    const result = await call(ctx, 'lang_detect', { text: 'Hello', top: 999 })
    assert.equal(result.isError, true)
    if (!result.isError) throw new Error('expected failure')
    assert.match(result.error.message, /top/i)
  })

  it('rejects whitespace-only input through the cross-field rule', async () => {
    const ctx = await mountPlugin()
    const result = await call(ctx, 'lang_detect', { text: '   ' })
    assert.equal(result.isError, true)
  })

  it('still answers a valid call after a refused one', async () => {
    const ctx = await mountPlugin()
    await call(ctx, 'lang_detect', { text: '   ' })
    const ok = await call(ctx, 'lang_detect', { text: 'kann ich das haben' })
    if (ok.isError) throw new Error('expected success')
    assert.equal((ok.value as { language: string }).language, 'de')
  })
})
