import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'

import { discoverExtension } from '@try-works/tool-mode-extension-sdk'
import { join } from 'node:path'

import { allFinite, meanPool, MINILM_DIMENSIONS, normalize } from '../src/pure.ts'
import { basicTokenize, encodeText, parseVocab, UNK_ID } from '../src/tokenizer.ts'

const PACKAGE_DIR = join(process.cwd(), 'packages', 'extension-minilm-embed')

/**
 * The prepared group directory (onnx/model.onnx + vocab.txt). The qualification
 * run passes MINILM_ASSETS_DIR; otherwise the standard local acquisition path is
 * used. When neither exists the weight-dependent tests SKIP with that reason —
 * they never fake a pass.
 */
function groupDir(): string | undefined {
  const roots = [
    process.env.MINILM_ASSETS_DIR === undefined ? undefined : join(process.env.MINILM_ASSETS_DIR, 'embed-group'),
    'E:/tmp/minilm-assets/embed-group',
  ]
  return roots.find(root => root !== undefined && existsSync(join(root, 'vocab.txt')))
}

test('meanPool averages the REAL token rows (TOOL-04 recipe, no weights)', () => {
  // Two token rows of width 3.
  const hidden = new Float32Array([1, 2, 3, 5, 6, 7])
  const pooled = meanPool(hidden, 2)
  assert.deepEqual(Array.from(pooled), [3, 4, 5])
})

test('normalize produces a unit vector and refuses a zero vector (TOOL-04)', () => {
  const normalized = normalize(new Float32Array([3, 4]))
  const norm = Math.sqrt(normalized[0]! ** 2 + normalized[1]! ** 2)
  assert.ok(Math.abs(norm - 1) < 1e-6)
  assert.ok(allFinite(Array.from(normalized)))
  assert.throws(() => normalize(new Float32Array([0, 0, 0])), /zero vector/)
})

test('the space identity is 384 — NEVER the EmbeddingGemma 2 768 space (BASE-12)', () => {
  assert.equal(MINILM_DIMENSIONS, 384)
  assert.notEqual(MINILM_DIMENSIONS, 768)
})

test('the manifest declares the standard text.embed contract with no placeholder model bindings', () => {
  const discovery = discoverExtension(PACKAGE_DIR)
  assert.equal(discovery.manifest.id, '@try-works/extension-minilm-embed')
  assert.equal(discovery.manifest.execution.kind, 'module')
  const implementation = discovery.manifest.implementations[0]!
  assert.equal(implementation.contractId, 'text.embed')
  assert.equal(implementation.contractVersion, '1.0.0')
  // The tools array is EMPTY: this package implements a known standard
  // descriptor, so it defines no new contract of its own (EXT-21).
  assert.deepEqual(discovery.manifest.tools, [])
})

test('the lock records the MEASURED acquisition — real digests, no placeholders', () => {
  const lock = JSON.parse(
    readFileSync(join(PACKAGE_DIR, 'models.lock.json'), 'utf8'),
  ) as { assetSets: { 'minilm-l6-onnx': { pinning: { state: string; revision: string }; groups: Array<{ assets: Array<{ digest: string; bytes: number }> }> } } }
  const set = lock.assetSets['minilm-l6-onnx']!
  assert.equal(set.pinning.state, 'measured')
  assert.match(set.pinning.revision, /^[0-9a-f]{40}$/)
  const assets = set.groups.flatMap(group => group.assets)
  assert.equal(assets.length, 2, 'onnx/model.onnx + vocab.txt')
  for (const asset of assets) {
    assert.match(asset.digest, /^[0-9a-f]{64}$/, 'every digest is a measured SHA-256')
    assert.ok(asset.bytes > 0)
  }
})

/**
 * The golden ids below were recorded from the HF reference tokenizer
 * (AutoTokenizer over the pinned sentence-transformers/all-MiniLM-L6-v2
 * repository) and compared 8/8 against this implementation on 2026-10-18.
 */
test('the tokenizer reproduces the uncased BERT ids exactly (golden fixtures)', (t) => {
  const dir = groupDir()
  if (dir === undefined) return t.skip('the pinned group directory is absent; acquisition is recorded in models.lock.json')
  const vocab = parseVocab(readFileSync(join(dir, 'vocab.txt'), 'utf8'))
  assert.deepEqual(encodeText('The quick brown fox jumps over the lazy dog.', vocab).inputIds,
    [101, 1996, 4248, 2829, 4419, 14523, 2058, 1996, 13971, 3899, 1012, 102])
  assert.deepEqual(encodeText('Hello, world!', vocab).inputIds, [101, 7592, 1010, 2088, 999, 102])
  assert.deepEqual(encodeText("Don't stop believin'.", vocab).inputIds,
    [101, 2123, 1005, 1056, 2644, 19337, 2666, 6371, 1005, 1012, 102])
  // Accents are stripped by the uncased pipeline: Über café -> uber cafe.
  assert.deepEqual(encodeText('Über café naïve façade résumé', vocab).inputIds,
    [101, 19169, 7668, 15743, 8508, 13746, 102])
  // Whitespace runs collapse; tabs/newlines are separators, not tokens.
  assert.deepEqual(encodeText('multi   space\tand\nnewlines', vocab).inputIds,
    [101, 4800, 2686, 1998, 2047, 12735, 102])
})

test('basic tokenization folds, splits punctuation, and keeps CJK per character', () => {
  assert.deepEqual(basicTokenize('Über café'), ['uber', 'cafe'])
  assert.deepEqual(basicTokenize('a,b!'), ['a', ',', 'b', '!'])
  assert.deepEqual(basicTokenize('中文'), ['中', '文'])
  // A word the vocabulary cannot piece at all yields exactly one UNK.
  assert.deepEqual(encodeText('hello', parseVocab('')).inputIds, [101, UNK_ID, 102])
})
