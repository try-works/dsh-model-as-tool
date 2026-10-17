import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { discoverExtension } from '@try-works/tool-mode-extension-sdk'
import { answerConfidence, decideFromLogits, MAX_OPTIONS, MAX_SCORE_LEVELS, softmax, validateOptions } from '../src/pure.ts'

const PACKAGE_DIR = join(process.cwd(), 'packages', 'extension-laya')

test('H5: softmax mirrors the vendored runtime (stable max subtraction)', () => {
  const p = softmax([1, 2, 3])
  const sum = p.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9)
  assert.ok(p[0]! < p[1]! && p[1]! < p[2]!)
  // Large logits stay finite: the max-subtraction prevents overflow.
  const large = softmax([1000, 1000.1])
  assert.ok(Number.isFinite(large[0]) && Number.isFinite(large[1]))
})

test('H5: decideFromLogits argmaxes with EXACT ties broken by input order', () => {
  const tied = decideFromLogits(['a', 'b', 'c'], [0.5, 0.5, 0.1])
  assert.equal(tied.label, 'a')
  assert.ok(Math.abs(tied.probabilities[0]! - tied.probabilities[1]!) < 1e-9)
  const clear = decideFromLogits(['a', 'b'], [-1, 2])
  assert.equal(clear.label, 'b')
  assert.equal(clear.index, 1)
  // The confidence is the probability mass on the answer (answerConfidence).
  assert.equal(clear.confidence, answerConfidence(clear.probabilities))
  assert.ok(clear.confidence > 0.5)
})

test('H5: option bounds + duplicates + shape refusals are precise', () => {
  assert.deepEqual(validateOptions(['x', 'y'], MAX_OPTIONS), ['x', 'y'])
  assert.throws(() => validateOptions(['only-one'], MAX_OPTIONS), /at least 2 options/)
  assert.throws(() => validateOptions(Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => String(i)), MAX_OPTIONS), /exceed the 32-option bound/)
  assert.throws(() => validateOptions(['a', 'a'], MAX_OPTIONS), /duplicate option label/)
  assert.throws(() => validateOptions(['a', ''], MAX_OPTIONS), /non-empty string/)
  assert.throws(() => validateOptions(Array.from({ length: MAX_SCORE_LEVELS + 1 }, (_, i) => String(i)), MAX_SCORE_LEVELS), /exceed the 10-option bound/)
})

test('H5: the manifest declares the decision family with the UNCALIBRATED honesty', () => {
  const discovery = discoverExtension(PACKAGE_DIR)
  const manifest = discovery.manifest
  assert.equal(manifest.id, '@try-works/extension-laya')
  assert.deepEqual(manifest.tools.map(tool => tool.name), ['decision_choose', 'decision_test', 'decision_score'])
  assert.equal(manifest.implementations.length, 3)
  assert.match(manifest.description, /UNCALIBRATED/)
  assert.equal(manifest.network?.requiredTelemetry, false)
  assert.equal(manifest.network?.otherNetworkUse, false)
})

test('H5: the lock pins the six artifacts with the measured digests (no placeholder hashes)', () => {
  const lock = JSON.parse(readFileSync(join(PACKAGE_DIR, 'models.lock.json'), 'utf8')) as {
    assetSets: {
      'laya-decision-onnx': {
        conversion: { revision: string }
        groups: Array<{ assets: Array<{ digest: string; bytes: number; file: string }> }>
      }
    }
  }
  const set = lock.assetSets['laya-decision-onnx']!
  assert.equal(set.conversion.revision, '7b928d828b7b0e022f929d9bd2e44165aa270148')
  const assets = set.groups.flatMap(group => group.assets)
  assert.equal(assets.length, 6)
  const byFile = new Map(assets.map(asset => [asset.file, asset]))
  assert.equal(byFile.get('encoder.onnx')!.digest, 'A774C5C634B99D1A4CED21ACBF11B9617A5CD55C7C7957BD52480B17D95A97F4')
  assert.equal(byFile.get('encoder.onnx')!.bytes, 2451566)
  assert.equal(byFile.get('encoder.onnx.data')!.bytes, 1227816960)
  assert.equal(byFile.get('head.onnx')!.digest, '7F6B9AC15D5FDF9EEBB352E66BDD3CE799D32885F1446014D268D8C53207858B')
  assert.equal(byFile.get('head.onnx.data')!.digest, '0292A4EB478C2C3EC0B6555B4A4093BC802E965654D7AEB4AC22907A17F261D3')
  assert.equal(byFile.get('tokenizer.json')!.digest, '609D8F4C067CD3950F88594C5A802616CEA245823836EF5848EE4FC40AAB5B6F')
  assert.equal(byFile.get('rl_agent_config.json')!.digest, '25061739243B617AD88D1219BA6F8A9C86C5881CA28DF024FA2D9B3B2FCC30C6')
})
