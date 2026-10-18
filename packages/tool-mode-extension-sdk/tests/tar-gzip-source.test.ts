/**
 * task-103 — the bounded npm-tarball (.tgz) ArchiveSource.
 *
 * Fixture tarballs are built IN-TEST (gzipSync + hand-built 512-byte tar
 * blocks); no network, no fixtures on disk. The same defense discipline as
 * the ZIP reader is asserted end to end, plus the inflate-time bound that
 * fires BEFORE the inflated payload is allocated.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createTarGzipArchiveSource,
  ManagementError,
  stagedInstall,
  validateArchiveEntries,
} from '../src/index.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmx-tgz-'))
  dirs.push(dir)
  return dir
}

const sha512 = (bytes: Uint8Array): string => createHash('sha512').update(bytes).digest('hex')

/** One 512-byte tar header block. */
function headerBlock(fields: { name: string; size: number; typeflag: string; linkname?: string; prefix?: string }): Buffer {
  const block = Buffer.alloc(512)
  block.write(fields.name, 0, 'utf8')
  // The size field is 11 OCTAL digits (tar sizes are octal, not decimal)
  // terminated by a SPACE at byte 135 (the 12-byte POSIX field).
  block.write(String(fields.size.toString(8)).padStart(11, '0'), 124, 'utf8')
  block.write(' ', 135, 'utf8')
  block.write(fields.typeflag, 156, 'utf8')
  if (fields.linkname !== undefined) block.write(fields.linkname, 157, 'utf8')
  if (fields.prefix !== undefined) block.write(fields.prefix, 345, 'utf8')
  block.write('ustar', 257, 'utf8')
  block.write('00', 263, 'utf8')
  // Checksum: the POSIX sum over the block (the checksum bytes read as spaces).
  for (let i = 148; i < 156; i += 1) block[i] = 32
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8')
  return block
}

/** One tar entry: header + padded data. */
function entryBlock(name: string, data: Buffer | string, typeflag = '0', extra: { linkname?: string; prefix?: string } = {}): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data) : data
  const header = headerBlock({ name, size: payload.byteLength, typeflag, ...extra })
  const padded = Math.ceil(payload.byteLength / 512) * 512
  const dataBlock = Buffer.alloc(padded)
  payload.copy(dataBlock)
  return Buffer.concat([header, dataBlock])
}

/** The directory entry for one path. */
function dirBlock(name: string): Buffer {
  return headerBlock({ name, size: 0, typeflag: '5' })
}

/** A full tar: the blocks, then two zero blocks. */
function tar(blocks: Buffer[]): Buffer {
  return Buffer.concat([...blocks, Buffer.alloc(1024)])
}

/** A gzipped tarball. */
function tgz(blocks: Buffer[]): Uint8Array {
  return new Uint8Array(gzipSync(tar(blocks)))
}

/** An npm-style tarball: everything rooted under package/, incl. the wrapper dir entry. */
function npmTgz(files: Record<string, string | Buffer>, extraBlocks: Buffer[] = []): Uint8Array {
  const blocks = [dirBlock('package')]
  for (const [path, content] of Object.entries(files)) {
    blocks.push(entryBlock(`package/${path}`, content))
  }
  return tgz([...blocks, ...extraBlocks])
}

/** The refusal helper: expect a named code with a message match. */
async function expectRefusal(promise: Promise<unknown>, pattern: RegExp, code = 'INVALID_EXTENSION'): Promise<void> {
  try {
    await promise
    assert.fail(`expected a refusal matching ${pattern}`)
  } catch (error) {
    assert.ok(error instanceof ManagementError, `expected ManagementError, got ${error instanceof Error ? error.constructor.name : String(error)}`)
    assert.equal(error.code, code)
    assert.match(error.message, pattern)
  }
}

/** List + validate, the way stagedInstall does before extraction. */
function validate(tgzBytes: Uint8Array) {
  const source = createTarGzipArchiveSource()
  const entries = source.list(tgzBytes)
  return validateArchiveEntries(entries)
}

describe('task-103 — the bounded npm-tarball ArchiveSource', () => {
  it('a normal npm package lists with the package/ root stripped and extracts to the destination', () => {
    const bytes = npmTgz({
      'package.json': JSON.stringify({ name: 'pkg', version: '1.0.0' }),
      'index.js': 'export const ok = true\n',
      'schemas/input.json': JSON.stringify({ type: 'object' }),
    })
    const source = createTarGzipArchiveSource()
    const entries = source.list(bytes)
    const paths = entries.map(entry => entry.path).sort()
    assert.deepEqual(paths, ['index.js', 'package.json', 'schemas/input.json'])
    const destination = scratch()
    source.extract(bytes, destination, '')
    assert.equal(readFileSync(join(destination, 'package.json'), 'utf8').includes('"name":"pkg"'), true)
    assert.equal(readFileSync(join(destination, 'schemas', 'input.json'), 'utf8').includes('"type":"object"'), true)
  })

  it('stagedInstall enforces the expected SHA-512 against the tarball bytes (mismatch then success)', async () => {
    const extension = npmTgz({
      'package.json': JSON.stringify({ name: '@acme/tgz-ext', version: '1.0.0', type: 'module', exports: { './tool-mode': './index.js' }, toolMode: { manifest: './tool-mode.extension.json' } }),
      'tool-mode.extension.json': JSON.stringify({
        protocolVersion: '1.1.0', id: '@acme/tgz-ext', version: '1.0.0',
        displayName: 'Tgz Ext', description: 'An npm-tarball extension.',
        activation: { policy: 'operator', deactivatable: true }, runtimeApi: 1,
        compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
        execution: { kind: 'module', entry: './index.js' },
        permissions: { networkOrigins: [], inputFiles: false, storage: 'none', secrets: [], nativeCode: false },
        models: [], tools: [], implementations: [], skills: [],
      }),
      'index.js': 'export const ok = true\n',
    })
    const archive = createTarGzipArchiveSource(async () => extension)
    const store = scratch()
    await expectRefusal(
      stagedInstall({
        source: { kind: 'registry', requested: '@acme/tgz-ext@1.0.0' },
        storeDir: store,
        archive,
        expectedSha512: sha512(new Uint8Array([1, 2, 3])),
      }),
      /INTEGRITY_MISMATCH|does not match/,
      'INTEGRITY_MISMATCH',
    )
    const result = await stagedInstall({
      source: { kind: 'registry', requested: '@acme/tgz-ext@1.0.0' },
      storeDir: store,
      archive,
      expectedSha512: sha512(extension),
    })
    assert.equal(result.extensionId, '@acme/tgz-ext')
  })

  it('a traversal entry refuses before any extraction', () => {
    const bytes = npmTgz({}, [entryBlock('package/../evil.js', 'x')])
    assert.throws(
      () => validate(bytes),
      (error: unknown) => {
        assert.ok(error instanceof ManagementError)
        assert.equal(error.code, 'INVALID_EXTENSION')
        assert.match(error.message, /traverses out of the package/)
        return true
      },
    )
  })

  it('symlink and hardlink entries refuse (never resolved)', () => {
    const symlink = npmTgz({}, [headerBlock({ name: 'package/lnk', size: 5, typeflag: '2', linkname: '/etc/passwd' }), Buffer.alloc(512)])
    assert.throws(() => validate(symlink), (error: unknown) => {
      assert.ok(error instanceof ManagementError)
      assert.match(error.message, /symlink; links are refused/)
      return true
    })
    const hardlink = npmTgz({}, [headerBlock({ name: 'package/lnk2', size: 0, typeflag: '1', linkname: 'package.json' })])
    assert.throws(() => validate(hardlink), (error: unknown) => {
      assert.ok(error instanceof ManagementError)
      assert.match(error.message, /hardlink; links are refused/)
      return true
    })
  })

  it('duplicate and case-colliding entries refuse', () => {
    assert.throws(
      () => validate(npmTgz({ 'a.js': 'x' }, [entryBlock('package/a.js', 'y')])),
      (error: unknown) => {
        assert.ok(error instanceof ManagementError)
        assert.match(error.message, /more than once/)
        return true
      },
    )
    assert.throws(
      () => validate(npmTgz({ 'A.js': 'x', 'a.js': 'y' })),
      (error: unknown) => {
        assert.ok(error instanceof ManagementError)
        assert.match(error.message, /collide on a case-insensitive filesystem/)
        return true
      },
    )
  })

  it('the inflate byte cap fires BEFORE the payload is allocated (bomb bound)', () => {
    const bytes = tgz([entryBlock('package/big.bin', Buffer.alloc(8 * 1024, 0))])
    const source = createTarGzipArchiveSource(undefined, { maxInflatedBytes: 1024 })
    assert.throws(
      () => source.list(bytes),
      (error: unknown) => {
        assert.ok(error instanceof ManagementError)
        assert.equal(error.code, 'INVALID_EXTENSION')
        assert.match(error.message, /inflates past the 1024-byte bound \(the cap fired BEFORE the payload was allocated\)/)
        return true
      },
    )
  })

  it('the expansion-ratio limit refuses a compressible bomb', () => {
    const bytes = tgz([entryBlock('package/big.bin', Buffer.alloc(256 * 1024, 0))])
    const source = createTarGzipArchiveSource(undefined, { maxExpansionRatio: 2 })
    assert.throws(
      () => source.list(bytes),
      (error: unknown) => {
        assert.ok(error instanceof ManagementError)
        assert.match(error.message, /expands .*x, over the 2x ratio limit/)
        return true
      },
    )
  })

  it('a truncated tarball refuses with a named message', () => {
    const full = tar([entryBlock('package/file.js', Buffer.alloc(2048, 1))])
    const truncated = gzipSync(full.subarray(0, 512 + 1000))
    assert.throws(
      () => createTarGzipArchiveSource().list(new Uint8Array(truncated)),
      (error: unknown) => {
        assert.ok(error instanceof ManagementError)
        assert.equal(error.code, 'INVALID_EXTENSION')
        assert.match(error.message, /truncated/)
        return true
      },
    )
  })

  it('GNU longname and pax path records resolve to the recorded path', () => {
    const longName = 'package/very/long/path/' + 'a'.repeat(100)
    // The 'L' record keeps its own name field ('././@LongLink') and carries the
    // long name in its DATA; the next file entry's name field is ignored in
    // favor of it.
    const longBlock = headerBlock({ name: '././@LongLink', size: longName.length + 1, typeflag: 'L' })
    const dataBlock = Buffer.alloc(Math.ceil((longName.length + 1) / 512) * 512)
    Buffer.from(longName + '\0').copy(dataBlock)
    const fixed = [dirBlock('package'), longBlock, dataBlock, entryBlock('ignored', 'long-name-content')]
    const source = createTarGzipArchiveSource()
    const destination = scratch()
    const bytes = tgz(fixed)
    source.extract(bytes, destination, '')
    assert.equal(readFileSync(join(destination, longName.slice('package/'.length)), 'utf8'), 'long-name-content')

    // A pax 'x' record overriding the path.
    const paxRecord = Buffer.from('27 path=package/renamed.js\n')
    const paxData = Buffer.concat([paxRecord, Buffer.alloc(512 - paxRecord.byteLength)])
    const paxBlocks = [
      dirBlock('package'),
      headerBlock({ name: 'PaxHeader', size: paxRecord.byteLength, typeflag: 'x' }),
      paxData,
      entryBlock('original-name', 'pax-content'),
    ]
    const destination2 = scratch()
    source.extract(tgz(paxBlocks), destination2, '')
    assert.equal(readFileSync(join(destination2, 'renamed.js'), 'utf8'), 'pax-content')
  })

  it('a mixed layout (entries under package/ AND outside it) refuses as ambiguous', () => {
    const bytes = tgz([
      dirBlock('package'),
      entryBlock('package/inside.js', 'x'),
      entryBlock('outside.js', 'y'),
    ])
    assert.throws(
      () => createTarGzipArchiveSource().list(bytes),
      (error: unknown) => {
        assert.ok(error instanceof ManagementError)
        assert.equal(error.code, 'INVALID_EXTENSION')
        assert.match(error.message, /mixes entries under "package\/" with entries outside it/)
        return true
      },
    )
  })

  it('an archive with no package/ wrapper extracts at the root unchanged', () => {
    const bytes = tgz([entryBlock('plain.json', '{"a":1}')])
    const source = createTarGzipArchiveSource()
    const destination = scratch()
    source.extract(bytes, destination, '')
    assert.equal(readFileSync(join(destination, 'plain.json'), 'utf8'), '{"a":1}')
  })
})
