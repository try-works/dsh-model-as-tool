import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { activateExtension } from '@try-works/tool-mode-extension-sdk'
import extension from '../src/index.ts'
import { classifySelection } from '../src/vectors.ts'

/** A host-issued context (the same shape embedding-real uses). */
function context() {
  return {
    extensionId: '@try-works/extension-embeddinggemma',
    extensionVersion: '0.1.1',
    activationGeneration: 1,
    storage: { directory: '', async read() { return undefined }, async write() { /* no-op */ } },
    logger: { log: () => { /* silent */ } },
    signal: new AbortController().signal,
    configuration: {},
  }
}

/** The call-scoped invocation context. */
function invocation(signal: AbortSignal = new AbortController().signal) {
  return {
    invocationId: 'derived-tools-test',
    signal,
    limits: { maxInputBytes: 8 * 1024 * 1024, maxAudioSeconds: 300, maxResultBytes: 4 * 1024 * 1024 },
    resolvePath: (candidate: string) => candidate,
  }
}

test('classifySelection: selected only when BOTH the score and the margin clear (MOD-11)', () => {
  // A strong best with a clear margin selects.
  assert.deepEqual(
    classifySelection([{ id: 'a', score: 0.9 }, { id: 'b', score: 0.2 }], 0.5, 0.1),
    { status: 'selected', label: 'a' },
  )
  // The best clears the score but NOT the margin: honest abstention.
  assert.deepEqual(
    classifySelection([{ id: 'a', score: 0.9 }, { id: 'b', score: 0.85 }], 0.5, 0.1),
    { status: 'abstained' },
  )
  // The margin clears but the score does not: abstention.
  assert.deepEqual(
    classifySelection([{ id: 'a', score: 0.3 }, { id: 'b', score: 0.1 }], 0.5, 0.1),
    { status: 'abstained' },
  )
  // A single label with a score above min_score has an infinite margin: selected.
  assert.deepEqual(
    classifySelection([{ id: 'only', score: 0.7 }], 0.5, 0.1),
    { status: 'selected', label: 'only' },
  )
  // No labels at all: abstained, never a fabricated decision.
  assert.deepEqual(classifySelection([], 0.5, 0.1), { status: 'abstained' })
  // The score order is by score, not input order; ties keep the input order.
  assert.deepEqual(
    classifySelection([{ id: 'first', score: 0.8 }, { id: 'second', score: 0.8 }], 0.5, 0),
    { status: 'selected', label: 'first' },
  )
})

test('media_find_moments VIDEO windows now VALIDATE and reach the prepared check (no fabricated refusal)', async () => {
  // The video window path is real (MOD-13): per-window 1 fps sampling through
  // the fused video pipeline. Without a prepared provider the call refuses
  // NOT_PREPARED — the validator no longer blocks video by name.
  const instance = await activateExtension(extension, context() as never)
  const provider = await instance.createProvider({ modelId: 'embeddinggemma-2', configuration: {} })
  await assert.rejects(
    provider.invoke({
      implementationId: 'embeddinggemma2-moments',
      input: {
        query: { id: 'q', parts: [{ kind: 'text', text: 'query' }] },
        media: { kind: 'video', path: 'C:/clip.avi' },
        windowSeconds: 2,
        strideSeconds: 1,
      },
      context: invocation(),
    }),
    /not prepared|NOT_PREPARED|load\(\)/,
  )
  // An audio item that supplies the video-only sampling field is also refused.
  const wav = join(tmpdir(), 'derived-moments.wav')
  writeFileSync(wav, Buffer.alloc(44)) // a stub; the refusal fires before any decode
  await assert.rejects(
    provider.invoke({
      implementationId: 'embeddinggemma2-moments',
      input: {
        query: { id: 'q', parts: [{ kind: 'text', text: 'query' }] },
        media: { kind: 'audio', path: wav },
        windowSeconds: 2,
        strideSeconds: 1,
        sampling: { mode: 'uniform', maxFrames: 8 },
      },
      context: invocation(),
    }),
    /"sampling" is a video-only field/,
  )
  rmSync(wav, { force: true })
  await instance.dispose('test end')
})

test('semantic_classify refuses duplicate label ids and bad margins (validator, no weights)', async () => {
  const instance = await activateExtension(extension, context() as never)
  const provider = await instance.createProvider({ modelId: 'embeddinggemma-2', configuration: {} })
  await assert.rejects(
    provider.invoke({
      implementationId: 'embeddinggemma2-classify',
      input: {
        item: { id: 'i', parts: [{ kind: 'text', text: 'x' }] },
        labels: [
          { id: 'dup', description: 'one' },
          { id: 'dup', description: 'two' },
        ],
      },
      context: invocation(),
    }),
    /duplicate label id/,
  )
  await assert.rejects(
    provider.invoke({
      implementationId: 'embeddinggemma2-classify',
      input: {
        item: { id: 'i', parts: [{ kind: 'text', text: 'x' }] },
        labels: [{ id: 'a', description: 'one' }],
        min_margin: Number.NaN,
      },
      context: invocation(),
    }),
    /"min_margin" must be a finite number/,
  )
  await instance.dispose('test end')
})

test('semantic_deduplicate refuses an out-of-range threshold (validator, no weights)', async () => {
  const instance = await activateExtension(extension, context() as never)
  const provider = await instance.createProvider({ modelId: 'embeddinggemma-2', configuration: {} })
  await assert.rejects(
    provider.invoke({
      implementationId: 'embeddinggemma2-deduplicate',
      input: {
        items: [{ id: 'a', parts: [{ kind: 'text', text: 'x' }] }],
        threshold: 1,
      },
      context: invocation(),
    }),
    /"threshold" must be a finite number in the open interval \(-1, 1\)/,
  )
  await instance.dispose('test end')
})

test('the three derived tools are declared in the manifest and in contracts.ts (MOD-15 separation)', async () => {
  // The manifest/contracts agreement is asserted by extension.test.ts; this
  // pins the SEPARATION the per-tool toggle needs: each derived tool has its
  // own manifest entry + implementation, so disabling media_find_moments can
  // never disable multimodal_embed.
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(
    join(process.cwd(), 'packages', 'extension-embeddinggemma', 'tool-mode.extension.json'),
    'utf8',
  )) as { tools: Array<{ id: string; name: string }>; implementations: Array<{ id: string }> }
  const names = manifest.tools.map(tool => tool.name)
  for (const expected of ['multimodal_embed', 'semantic_classify', 'semantic_deduplicate', 'media_find_moments']) {
    assert.ok(names.includes(expected), `${expected} must be declared separately`)
  }
  const implementationIds = manifest.implementations.map(implementation => implementation.id)
  for (const expected of ['embeddinggemma2-onnx', 'embeddinggemma2-classify', 'embeddinggemma2-deduplicate', 'embeddinggemma2-moments']) {
    assert.ok(implementationIds.includes(expected), `${expected} must be bound separately`)
  }
})
