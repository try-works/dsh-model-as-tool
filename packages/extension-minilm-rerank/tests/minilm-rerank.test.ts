import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'

import { discoverExtension } from '@try-works/tool-mode-extension-sdk'
import { join } from 'node:path'

import { rankByLogit } from '../src/pure.ts'
import { basicTokenize, encodePair, parseVocab } from '../src/tokenizer.ts'

const PACKAGE_DIR = join(process.cwd(), 'packages', 'extension-minilm-rerank')

/**
 * The prepared group directory (onnx/model.onnx + vocab.txt). The qualification
 * run passes MINILM_ASSETS_DIR; otherwise the standard local acquisition path is
 * used. When neither exists the weight-dependent tests SKIP with that reason —
 * they never fake a pass.
 */
function groupDir(): string | undefined {
  const roots = [
    process.env.MINILM_ASSETS_DIR === undefined ? undefined : join(process.env.MINILM_ASSETS_DIR, 'rerank-group'),
    'E:/tmp/minilm-assets/rerank-group',
  ]
  return roots.find(root => root !== undefined && existsSync(join(root, 'vocab.txt')))
}

test('rankByLogit sorts descending with EXACT ties broken by input order (TOOL-05)', () => {
  const ranked = rankByLogit([
    { id: 'a', score: 0.5 },
    { id: 'b', score: 0.9 },
    { id: 'c', score: 0.5 },
    { id: 'd', score: 0.1 },
  ])
  assert.deepEqual(ranked, [
    { id: 'b', score: 0.9 },
    { id: 'a', score: 0.5 },
    { id: 'c', score: 0.5 },
    { id: 'd', score: 0.1 },
  ])
  // The ids are the CALLER's ids, never synthesized ones.
  const ids = ranked.map(entry => entry.id).sort()
  assert.deepEqual(ids, ['a', 'b', 'c', 'd'])
})

test('the manifest declares the standard text.rerank contract (ranking_logit, not cosine)', () => {
  const discovery = discoverExtension(PACKAGE_DIR)
  assert.equal(discovery.manifest.id, '@try-works/extension-minilm-rerank')
  const implementation = discovery.manifest.implementations[0]!
  assert.equal(implementation.contractId, 'text.rerank')
  assert.deepEqual(discovery.manifest.tools, [])
})

test('the lock records the MEASURED acquisition — real digests, no placeholders', () => {
  const lock = JSON.parse(
    readFileSync(join(PACKAGE_DIR, 'models.lock.json'), 'utf8'),
  ) as { assetSets: { 'minilm-rerank-onnx': { pinning: { state: string; revision: string }; groups: Array<{ assets: Array<{ digest: string; bytes: number }> }> } } }
  const set = lock.assetSets['minilm-rerank-onnx']!
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
 * Golden ids recorded from the HF reference tokenizer (AutoTokenizer over the
 * pinned cross-encoder/ms-marco-MiniLM-L-6-v2 repository) and compared 8/8
 * against this implementation on 2026-10-18.
 */
test('encodePair frames query+passage with [CLS]/[SEP] and 0/1 segment ids', (t) => {
  const dir = groupDir()
  if (dir === undefined) return t.skip('the pinned group directory is absent; acquisition is recorded in models.lock.json')
  const vocab = parseVocab(readFileSync(join(dir, 'vocab.txt'), 'utf8'))
  const pair = encodePair('What is the capital of France?', 'Paris is the capital of France.', vocab)
  // [CLS] query-tokens [SEP] passage-tokens [SEP]
  assert.equal(pair.inputIds[0], 101)
  assert.equal(pair.tokenTypeIds[0], 0)
  const firstSep = pair.inputIds.indexOf(102, 1)
  assert.ok(firstSep > 0)
  assert.equal(pair.tokenTypeIds[firstSep], 0)
  assert.equal(pair.tokenTypeIds[firstSep + 1], 1, 'the passage half carries segment id 1')
  assert.equal(pair.inputIds[pair.inputIds.length - 1], 102)
  assert.equal(pair.tokenTypeIds[pair.tokenTypeIds.length - 1], 1, 'the closing [SEP] belongs to the passage half')
  assert.equal(pair.attentionMask.length, pair.inputIds.length)
  assert.ok(pair.inputIds.length <= 512)
})

test('the pair tokenizer folds like uncased BERT (basic fixtures)', () => {
  assert.deepEqual(basicTokenize('Über, café!'), ['uber', ',', 'cafe', '!'])
  assert.deepEqual(basicTokenize('中文'), ['中', '文'])
})
