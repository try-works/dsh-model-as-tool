/**
 * TASK-114: the offline runtime-range drift test.
 *
 * Every extension declares runtime dependency ranges (dependencies +
 * optionalDependencies). A range with NO published version breaks the
 * extension's tool at load time — exactly the live voz defect (^1.0.0 with
 * only 3.4.0-4.0.0 published). This test asserts every declared range against
 * a COMMITTED registry snapshot (registry-snapshot.json) so the drift is
 * caught in the suite without any network. The snapshot is refreshed by the
 * task's live audit; a NEW runtime dependency must extend it.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

interface Snapshot {
  packages: Record<string, { published: string[] }>
}

const ROOT = join(process.cwd(), 'packages')
const snapshot = JSON.parse(
  readFileSync(join(process.cwd(), 'packages', 'extension-desert-ant-voz', 'tests', 'registry-snapshot.json'), 'utf8'),
) as Snapshot

/** Parse `major.minor.patch` into comparable numbers. */
function parseVersion(version: string): { major: number; minor: number; patch: number } {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (match === null) throw new Error(`cannot parse version ${JSON.stringify(version)}`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function compare(left: ReturnType<typeof parseVersion>, right: ReturnType<typeof parseVersion>): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}

/** Whether one published version satisfies the declared range. */
function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version)
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim())
  if (caret !== null) {
    const low = parseVersion(`${caret[1]}.${caret[2]}.${caret[3]}`)
    const high = low.major === 0
      ? low
      : { major: low.major, minor: Number.POSITIVE_INFINITY, patch: Number.POSITIVE_INFINITY }
    // ^x.y.z: >= low, < next major (x>0); for 0.x it is >= low < 0.(y+1).
    if (low.major === 0) {
      const upper = { major: 0, minor: low.minor + 1, patch: -1 }
      return compare(parsed, low) >= 0 && compare(parsed, upper) < 0
    }
    return compare(parsed, low) >= 0 && compare(parsed, high) < 0
  }
  const bounded = /^>=(\d+\.\d+\.\d+)\s*<(\d+)$/.exec(range.trim())
  if (bounded !== null) {
    const low = parseVersion(bounded[1]!)
    return compare(parsed, low) >= 0 && parsed.major < Number(bounded[2])
  }
  const floor = /^>=(\d+\.\d+\.\d+)$/.exec(range.trim())
  if (floor !== null) {
    return compare(parsed, parseVersion(floor[1]!)) >= 0
  }
  const exact = /^\d+\.\d+\.\d+$/.exec(range.trim())
  if (exact !== null) {
    return compare(parsed, parseVersion(exact[0])) === 0
  }
  throw new Error(`unsupported range shape ${JSON.stringify(range)} — extend this test when a new shape is declared`)
}

/** The runtime ranges one extension declares. */
function declaredRanges(packageJson: {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}): Array<{ package: string; range: string }> {
  return [
    ...Object.entries(packageJson.dependencies ?? {}),
    ...Object.entries(packageJson.optionalDependencies ?? {}),
  ].map(([name, range]) => ({ package: name, range }))
}

test('every extension runtime range has a published version in the committed snapshot (offline drift guard)', () => {
  const extensions = [
    'extension-desert-ant-voz',
    'extension-desert-ant-tongue',
    'extension-embeddinggemma',
    'extension-laya',
    'extension-minilm-embed',
    'extension-minilm-rerank',
    'extension-needle',
    'extension-declarative-recipes',
  ]
  const failures: string[] = []
  for (const extension of extensions) {
    const manifest = JSON.parse(readFileSync(join(ROOT, extension, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    for (const { package: name, range } of declaredRanges(manifest)) {
      const entry = snapshot.packages[name]
      if (entry === undefined) {
        failures.push(`${extension}: ${name} ${range} — the package is absent from the committed snapshot; record its published versions`)
        continue
      }
      const matches = entry.published.filter(version => satisfies(version, range))
      if (matches.length === 0) {
        failures.push(`${extension}: ${name} ${range} matches NONE of the published versions [${entry.published.join(', ')}]`)
      }
    }
  }
  assert.deepEqual(failures, [], 'every declared runtime range must resolve to a published version')
})

test('the voz range is the published line (the live defect is pinned)', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'extension-desert-ant-voz', 'package.json'), 'utf8')) as {
    optionalDependencies: Record<string, string>
    version: string
  }
  assert.equal(manifest.optionalDependencies['@desert-ant-labs/voz'], '^3.6.0')
  assert.equal(manifest.version, '0.1.5')
  const snapshotVoz = snapshot.packages['@desert-ant-labs/voz']!.published
  assert.ok(snapshotVoz.some(version => satisfies(version, '^3.6.0')), '^3.6.0 must resolve')
  assert.ok(!snapshotVoz.some(version => satisfies(version, '^1.0.0')), 'the old ^1.0.0 must NOT resolve (the regression is pinned)')
})
