/**
 * EXT-18 — the tongue inspection is honest about the bundled weight file.
 *
 * `inspect` must not merely prove the MODEL PACKAGE resolves: a corrupted install
 * whose bin is truncated would otherwise publish `prepared-cold` and fail on the
 * first call. The exported `inspectBundledWeights` helper is the verdict engine,
 * so these cases are pinned without touching the real installed package.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { inspectBundledWeights } from '../src/index.ts'

describe('EXT-18 — tongue weight-file inspection', () => {
  it('accepts a complete weight file', () => {
    const verdict = inspectBundledWeights(
      () => 'file:///tongue/dist/tongue_int8.bin',
      () => 2_104_940,
    )
    assert.deepEqual(verdict, { ok: true })
  })

  it('refuses a truncated weight file', () => {
    const verdict = inspectBundledWeights(
      () => 'file:///tongue/dist/tongue_int8.bin',
      () => 42,
    )
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /42 bytes/)
  })

  it('refuses a missing weight file', () => {
    const verdict = inspectBundledWeights(
      () => { throw new Error('not found') },
      () => 2_104_940,
    )
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /install @desert-ant-labs\/tongue/)
  })

  it('distinguishes a package that ships no weight subpath from a package that is absent', () => {
    // The package.json RESOLVES (the package is installed) but the bin subpath
    // does not — the remedy must say the installed revision is broken, not ask
    // the operator to install what is already there.
    const verdict = inspectBundledWeights(
      specifier => (specifier.endsWith('/package.json') ? 'file:///tongue/package.json' : undefined),
      () => 2_104_940,
    )
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /does not ship the weight file/)
    assert.doesNotMatch(verdict.reason, /^install /)
  })

  it('refuses when the weight file resolves but cannot be statted (deleted on disk)', () => {
    // The corruption case the helper exists for: the package is installed, the
    // exports subpath resolves, and the FILE is gone — statSync throws ENOENT.
    // This must come back as a reinstall verdict, not an uncaught throw.
    const verdict = inspectBundledWeights(
      () => 'file:///tongue/dist/tongue_int8.bin',
      () => { throw new Error('ENOENT: no such file') },
    )
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /cannot be read.*reinstall/s)
  })

  it('refuses a truncated weight file at the boundary', () => {
    const verdict = inspectBundledWeights(
      () => 'file:///tongue/dist/tongue_int8.bin',
      () => 999_999,
    )
    assert.equal(verdict.ok, false)
    assert.equal(verdict.size, 999_999)
    assert.match(verdict.reason, /999999 bytes/)
  })

  it('refuses when resolution returns nothing', () => {
    const verdict = inspectBundledWeights(
      () => undefined,
      () => 2_104_940,
    )
    assert.equal(verdict.ok, false)
  })
})
