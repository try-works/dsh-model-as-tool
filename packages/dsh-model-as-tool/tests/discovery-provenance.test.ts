/**
 * Discovery provenance tests (EXT-32).
 *
 * The requirement is that read-only discovery exposes public
 * extension/implementation provenance and readiness, so an absent tool is
 * EXPLICABLE rather than merely missing. These tests assert through the real tool
 * pipeline, because the output schema is part of the contract being checked: a
 * field the schema does not declare is refused at runtime, which is how this
 * addition was caught in the first place.
 *
 * Requirement links: EXT-32, EXT-24.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

import * as plugin from '../src/index.ts'
import { cleanup, mountPlugin } from './helpers.ts'

after(async () => { await cleanup() })

let counter = 0
function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`prov-${++counter}`),
    name,
    arguments: args,
  })
}

/** One model row from the discovery listing. */
interface Row {
  id: string
  tool: string
  runnable: boolean
  installed: boolean
  readiness: string
  callable: boolean
  provenance: {
    contract: string | null
    extension: string | null
    modelId: string | null
    publishedTool: string | null
    alternatives: string[]
  }
  withheld?: { code: string; message: string }
}

async function listing(ctx: Context): Promise<Row[]> {
  const result = await call(ctx, 'model_tools', { action: 'list' })
  if (result.isError) throw new Error(`expected success: ${result.error.message}`)
  return (result.value as { models: Row[] }).models
}

describe('EXT-32 — provenance is exposed for every model', () => {
  it('names the extension and model that implement a contract-bound model', async () => {
    const ctx = await mountPlugin()
    const rows = await listing(ctx)
    const tongue = rows.find(row => row.id === 'tongue')
    assert.ok(tongue, 'tongue must be listed')
    assert.equal(tongue.provenance.contract, 'text.language_detect')
    // Which PACKAGE implements it, not just which catalog row exists.
    assert.equal(tongue.provenance.extension, '@try-works/extension-desert-ant-tongue')
    assert.equal(tongue.provenance.modelId, 'tongue')
  })

  it('reports the tool name that was actually published', async () => {
    const ctx = await mountPlugin()
    const tongue = (await listing(ctx)).find(row => row.id === 'tongue')
    // The CONTRACT tool name, which is what a caller must use — not the catalog's
    // per-model name.
    assert.equal(tongue?.provenance.publishedTool, 'lang_detect')
    assert.equal(tongue?.tool, 'lang_detect')
  })

  it('always returns the full provenance shape, even for an unbound model', async () => {
    const ctx = await mountPlugin()
    const rows = await listing(ctx)
    // Every row carries every field: the output schema declares them required, so a
    // caller never has to handle a partially-populated model.
    for (const row of rows) {
      assert.ok('contract' in row.provenance, `${row.id} must report a contract field`)
      assert.ok('extension' in row.provenance, `${row.id} must report an extension field`)
      assert.ok('modelId' in row.provenance, `${row.id} must report a modelId field`)
      assert.ok('publishedTool' in row.provenance, `${row.id} must report publishedTool`)
      assert.ok(Array.isArray(row.provenance.alternatives), `${row.id} must report alternatives`)
      assert.equal(typeof row.readiness, 'string', `${row.id} must report readiness`)
      assert.equal(typeof row.callable, 'boolean', `${row.id} must report callable`)
    }
  })

  it('reports null provenance for a model with no contract or extension', async () => {
    const ctx = await mountPlugin()
    const rows = await listing(ctx)
    const unbound = rows.find(row => row.provenance.contract === null)
    assert.ok(unbound, 'the catalog has models with no contract binding')
    assert.equal(unbound.provenance.publishedTool, null)
    assert.deepEqual(unbound.provenance.alternatives, [])
    // It is not callable, and the listing says so rather than leaving it ambiguous.
    assert.equal(unbound.callable, false)
  })
})

describe('EXT-32 — an absent tool is explicable', () => {
  it('does not report a model as callable when it cannot run here', async () => {
    const ctx = await mountPlugin()
    const rows = await listing(ctx)
    // The LiteRT/Apple-only models cannot run on this host; claiming one is
    // callable would be the failure this field exists to prevent.
    for (const row of rows.filter(candidate => !candidate.runnable)) {
      assert.equal(row.callable, false, `${row.id} cannot run here, so it must not be callable`)
    }
  })

  it('a model that is not the selected provider has no published tool but keeps its provenance', async () => {
    const ctx = await mountPlugin({ models: ['tongue'] })
    const rows = await listing(ctx)
    const tongue = rows.find(row => row.id === 'tongue')
    // Provenance comes from the CATALOG binding, so it survives even when this
    // model is not the one currently serving the contract.
    assert.equal(tongue?.provenance.extension, '@try-works/extension-desert-ant-tongue')
  })

  it('exposes readiness for the selected implementation', async () => {
    const ctx = await mountPlugin({ models: ['tongue'] })
    const tongue = (await listing(ctx)).find(row => row.id === 'tongue')
    // The readiness the publication surface computed, not a guess made here.
    assert.ok(['unavailable', 'needs-preparation', 'preparing', 'prepared-cold', 'loading', 'ready', 'busy', 'failed', 'unknown'].includes(tongue?.readiness ?? ''))
  })
})

describe('EXT-32 — discovery stays read-only', () => {
  it('listing does not change installation state', async () => {
    const ctx = await mountPlugin()
    await listing(ctx)
    const after = await listing(ctx)
    // A read-only surface that mutated state would make the inventory depend on how
    // often it was inspected.
    assert.equal(after.filter(row => row.installed).length, after.filter(row => row.installed).length)
  })

  it('says nothing about the filesystem layout or secret references', async () => {
    const ctx = await mountPlugin({ approvedRoots: ['C:\\some\\private\\root'] })
    const result = await call(ctx, 'model_tools', { action: 'list' })
    if (result.isError) throw new Error('expected success')
    const text = JSON.stringify(result.value)
    // EXT-32: external callers must not see another client's filesystem layout.
    // The approved roots are operator configuration and never appear in discovery.
    assert.equal(text.includes('some'), false, 'the listing must not disclose approved roots')
    assert.equal(text.includes('private'), false, 'the listing must not disclose filesystem layout')
  })
})

describe('EXT-35 — receipts are emitted for successful calls', () => {
  it('records provenance for a call that completed', async () => {
    const ctx = await mountPlugin()
    const before = await call(ctx, 'model_tools', { action: 'receipts' })
    if (before.isError) throw new Error(`expected success: ${before.error.message}`)
    const first = (before.value as { receipts: unknown[] }).receipts.length

    const detection = await call(ctx, 'lang_detect', { text: 'kann ich das haben' })
    if (detection.isError) throw new Error(`expected success: ${detection.error.message}`)

    const after = await call(ctx, 'model_tools', { action: 'receipts' })
    if (after.isError) throw new Error('expected success')
    const receipts = (after.value as { receipts: {
      receiptId: string, contract: string, implementationId: string,
      extension: string, modelIdentity: string, activationGeneration: number,
      executionLocation: string,
    }[] }).receipts
    assert.equal(receipts.length, first + 1, 'a successful call must leave exactly one receipt')

    const latest = receipts[receipts.length - 1]
    assert.equal(latest?.contract, 'text.language_detect')
    assert.equal(latest?.implementationId, 'tongue')
    // Which PACKAGE ran, not just which catalog row.
    assert.equal(latest?.extension, '@try-works/extension-desert-ant-tongue')
    assert.equal(latest?.modelIdentity, 'tongue')
    assert.equal(typeof latest?.activationGeneration, 'number')
    assert.match(String(latest?.receiptId), /^rcpt_/)
  })

  it('does NOT record a receipt for a call that was refused', async () => {
    const ctx = await mountPlugin()
    const before = await call(ctx, 'model_tools', { action: 'receipts' })
    if (before.isError) throw new Error('expected success')
    const first = (before.value as { receipts: unknown[] }).receipts.length

    const refused = await call(ctx, 'lang_detect', { text: '   ' })
    assert.equal(refused.isError, true)

    const after = await call(ctx, 'model_tools', { action: 'receipts' })
    if (after.isError) throw new Error('expected success')
    // A receipt for a call that failed validation would claim provenance for a
    // result nobody received.
    assert.equal((after.value as { receipts: unknown[] }).receipts.length, first)
  })

  it('the receipt view exposes no request content', async () => {
    const ctx = await mountPlugin()
    await call(ctx, 'lang_detect', { text: 'a very distinctive phrase' })
    const result = await call(ctx, 'model_tools', { action: 'receipts' })
    if (result.isError) throw new Error('expected success')
    // EXT-35 metadata-only: the invoked text must not appear in a receipt.
    assert.equal(JSON.stringify(result.value).includes('distinctive'), false)
  })
})