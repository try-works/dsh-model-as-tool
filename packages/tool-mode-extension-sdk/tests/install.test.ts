/**
 * Staged installation tests (EXT-07, EXT-08, EXT-11).
 *
 * The archives here are REAL zip files built with `adm-zip`, not fabricated entry
 * lists. That distinction matters: the defenses are about how a real archive's
 * metadata can misrepresent its contents, so validating a hand-written array
 * would test the validator against the author's assumptions rather than against
 * an archive format.
 *
 * Requirement links: EXT-07, EXT-08, EXT-11.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { buildRawZip } from './raw-zip.ts'

import {
  createZipArchiveSource,
  DEFAULT_ARCHIVE_LIMITS,
  findPackageRoot,
  installPathFor,
  ManagementError,
  stagedInstall,
  validateArchiveEntries,
  verifyIntegrity,
  type ArchiveEntry,
  type InstallSource,
} from '../src/index.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix = 'tmx-install-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Build a valid extension package as a real zip, returning its bytes. */
function buildExtensionZip(extra?: (zip: AdmZip) => void, overrides?: {
  name?: string
  version?: string
  toolModeManifest?: string
  manifestId?: string
}): Uint8Array {
  const name = overrides?.name ?? '@acme/tool-mode-topics'
  const version = overrides?.version ?? '1.2.3'
  const zip = new AdmZip()
  const manifest = {
    protocolVersion: '1.1.0',
    id: overrides?.manifestId ?? name,
    version,
    displayName: 'Acme Topic Tools',
    description: 'Local topic classification using a packaged model recipe.',
    activation: { policy: 'operator', deactivatable: true },
    runtimeApi: 1,
    compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
    execution: { kind: 'module', entry: './index.js' },
    permissions: {
      networkOrigins: [], inputFiles: false, storage: 'extension-private', secrets: [], nativeCode: false,
    },
    models: [],
    tools: [],
    implementations: [],
    skills: [],
  }
  zip.addFile('package.json', Buffer.from(JSON.stringify({
    name,
    version,
    type: 'module',
    exports: { './tool-mode': './index.js' },
    toolMode: { manifest: overrides?.toolModeManifest ?? './tool-mode.extension.json' },
  })))
  zip.addFile('tool-mode.extension.json', Buffer.from(JSON.stringify(manifest)))
  // An entry that throws if it is ever imported: EXT-07 says install must not
  // import the executable entry, and reaching the assertions proves it did not.
  zip.addFile('index.js', Buffer.from('throw new Error("install must not import the entry")'))
  extra?.(zip)
  return new Uint8Array(zip.toBuffer())
}

/** SHA-512 of bytes, as the installer expects it. */
const digestOf = (bytes: Uint8Array) => createHash('sha512').update(bytes).digest('hex')

/** An archive source wired to fixed bytes, with no network involved. */
function sourceFor(bytes: Uint8Array) {
  return createZipArchiveSource(async () => bytes)
}

const SOURCE: InstallSource = { kind: 'registry', requested: '@acme/tool-mode-topics@1.2.3' }

describe('EXT-11 — archive entry defenses', () => {
  const entry = (path: string, extra: Partial<ArchiveEntry> = {}): ArchiveEntry =>
    ({ path, size: 10, kind: 'file', ...extra })

  it('refuses path traversal', () => {
    assert.throws(() => validateArchiveEntries([entry('package/../../etc/passwd')]), /traverses out of the package/)
  })

  it('refuses an absolute path', () => {
    assert.throws(() => validateArchiveEntries([entry('/etc/passwd')]), /is absolute/)
  })

  it('refuses a drive letter', () => {
    assert.throws(() => validateArchiveEntries([entry('C:/Windows/system32/x.dll')]), /drive letter/)
  })

  it('refuses a Windows device path', () => {
    assert.throws(() => validateArchiveEntries([entry('package/CON')]), /reserved Windows device name/)
    assert.throws(() => validateArchiveEntries([entry('package/LPT1.txt')]), /reserved Windows device name/)
  })

  it('refuses UNC and backslash separators', () => {
    assert.throws(() => validateArchiveEntries([entry('//server/share/x')]), /UNC path/)
    // A backslash is a filename character on POSIX and a separator on Windows, so
    // one archive would extract to two different trees.
    assert.throws(() => validateArchiveEntries([entry('package\\evil.js')]), /backslash/)
  })

  it('refuses a segment ending in a dot or space', () => {
    assert.throws(() => validateArchiveEntries([entry('package/evil.')]), /dot or space/)
    assert.throws(() => validateArchiveEntries([entry('package/evil ')]), /dot or space/)
  })

  it('refuses symlinks and hardlinks outright', () => {
    assert.throws(() => validateArchiveEntries([entry('package/link', { kind: 'symlink' })]), /links are refused/)
    assert.throws(() => validateArchiveEntries([entry('package/link', { kind: 'hardlink' })]), /links are refused/)
  })

  it('refuses duplicate entries rather than letting the last write win', () => {
    assert.throws(
      () => validateArchiveEntries([entry('package/a.js'), entry('package/a.js')]),
      /more than once/,
    )
  })

  it('refuses Windows case collisions', () => {
    // On a case-insensitive filesystem these are one file, so the archive would
    // extract differently per host.
    assert.throws(
      () => validateArchiveEntries([entry('package/A.js'), entry('package/a.js')]),
      /collide on a case-insensitive filesystem/,
    )
  })

  it('refuses too many entries, an oversized entry, and an oversized total', () => {
    const many = Array.from({ length: 5 }, (_, index) => entry(`package/f${index}.js`))
    assert.throws(() => validateArchiveEntries(many, { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 4 }), /over the 4 limit/)
    assert.throws(
      () => validateArchiveEntries([entry('package/big', { size: 1000 })], { ...DEFAULT_ARCHIVE_LIMITS, maxEntryBytes: 999 }),
      /over the per-entry limit/,
    )
    assert.throws(
      () => validateArchiveEntries([entry('package/a', { size: 600 }), entry('package/b', { size: 600 })],
        { ...DEFAULT_ARCHIVE_LIMITS, maxTotalBytes: 1000 }),
      /over the .* limit/,
    )
  })

  it('refuses an expansion bomb by ratio', () => {
    // Small on the wire, enormous on disk.
    assert.throws(
      () => validateArchiveEntries([entry('package/bomb', { size: 100_000_000, compressedSize: 1000 })],
        { ...DEFAULT_ARCHIVE_LIMITS, maxExpansionRatio: 100, maxTotalBytes: 1_000_000_000, maxEntryBytes: 1_000_000_000 }),
      /ratio limit/,
    )
  })

  it('accepts a clean entry list and returns normalized paths', () => {
    const paths = validateArchiveEntries([
      entry('package/package.json'),
      entry('package/./schemas/a.json'),
      entry('package/dir', { kind: 'directory', size: 0 }),
    ])
    assert.deepEqual(paths, ['package/package.json', 'package/schemas/a.json', 'package/dir'])
  })
})

describe('EXT-11 — package root resolution', () => {
  it('accepts package.json at the archive root', () => {
    assert.equal(findPackageRoot(['package.json', 'index.js']), '')
  })

  it('accepts a single wrapping directory', () => {
    assert.equal(findPackageRoot(['pkg/package.json', 'pkg/index.js']), 'pkg')
  })

  it('refuses an ambiguous archive with several candidate roots', () => {
    assert.throws(() => findPackageRoot(['a/package.json', 'b/package.json']), /ambiguous/)
  })

  it('refuses an archive with no package.json', () => {
    assert.throws(() => findPackageRoot(['index.js']), /no package.json/)
  })
})

describe('EXT-08 — integrity', () => {
  it('accepts matching hex, with or without the sha512- prefix', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const digest = digestOf(bytes)
    assert.equal(verifyIntegrity(bytes, digest), digest)
    assert.equal(verifyIntegrity(bytes, `sha512-${digest}`), digest)
  })

  it('accepts the npm registry form: case-sensitive base64 SRI (task-104 discovery)', () => {
    const bytes = Buffer.from('hello world')
    const digest = digestOf(bytes)
    const sri = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    // The base64 form carries '=' padding AND case-sensitive characters; a
    // correct digest must verify, not be corrupted by lowercasing.
    assert.match(sri, /=$/, 'the fixture is the padded npm SRI form')
    assert.equal(verifyIntegrity(bytes, sri), digest)
  })

  it('refuses a mismatch with advice not to retry blindly', () => {
    assert.throws(() => verifyIntegrity(new Uint8Array([1]), digestOf(new Uint8Array([2]))), (error: unknown) => {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'INTEGRITY_MISMATCH')
      assert.match(error.recovery, /do not retry blindly/i)
      return true
    })
  })
})

describe('EXT-07 / EXT-08 — staged installation', () => {
  it('installs a valid package and reports it INACTIVE', async () => {
    const store = scratch()
    const bytes = buildExtensionZip()
    const result = await stagedInstall({
      source: SOURCE,
      storeDir: store,
      expectedSha512: digestOf(bytes),
      archive: sourceFor(bytes),
    })
    // The returned activation is the point: a successful install is not a usable
    // tool, and the type says so.
    assert.equal(result.activation, 'inactive')
    assert.equal(result.extensionId, '@acme/tool-mode-topics')
    assert.equal(result.version, '1.2.3')
    assert.ok(existsSync(join(result.installPath, 'index.js')))
    // The fixture entry throws on import, so reaching here proves install never
    // imported it.
  })

  it('a hostile scripts field is NEVER read or executed (AT-28 sentinel)', async () => {
    // The install path is extraction-only: no npm, no shell, no exec. A package
    // whose package.json declares an install script that would write a sentinel
    // file installs cleanly and NO sentinel appears — the script has nothing to
    // run it, which is the property a sentinel test pins.
    const store = scratch()
    const sentinel = join(store, 'scripts-ran.sentinel')
    const bytes = buildExtensionZip(zip => {
      // Rebuild package.json WITH a hostile scripts field: the extractor writes
      // files verbatim, so the field lands on disk — what must NOT happen is its
      // execution.
      zip.addFile('package.json', Buffer.from(JSON.stringify({
        name: '@acme/tool-mode-topics',
        version: '1.2.3',
        type: 'module',
        exports: { './tool-mode': './index.js' },
        toolMode: { manifest: './tool-mode.extension.json' },
        scripts: {
          install: `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed')"`,
          postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed')"`,
          prepare: `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed')"`,
        },
      })))
    })
    const result = await stagedInstall({
      source: SOURCE, storeDir: store, expectedSha512: digestOf(bytes), archive: sourceFor(bytes),
    })
    assert.equal(result.activation, 'inactive')
    // The scripts field is on disk as DATA (extraction is verbatim)...
    const installedPkg = JSON.parse(readFileSync(join(result.installPath, 'package.json'), 'utf8'))
    assert.equal(typeof installedPkg.scripts.install, 'string')
    // ...but nothing executed it: no sentinel, anywhere in the store.
    assert.equal(existsSync(sentinel), false, 'an install script must have nothing that runs it')
    assert.equal(
      existsSync(join(result.installPath, 'scripts-ran.sentinel')),
      false,
      'a postinstall/prepare script must have nothing that runs it',
    )
  })

  it('leaves a receipt recording the digest and source', async () => {
    const store = scratch()
    const bytes = buildExtensionZip()
    const digest = digestOf(bytes)
    const result = await stagedInstall({
      source: SOURCE, storeDir: store, expectedSha512: digest, archive: sourceFor(bytes),
    })
    const receipt = JSON.parse(readFileSync(join(result.installPath, '.tool-mode-install.json'), 'utf8'))
    assert.equal(receipt.archiveDigest, digest)
    assert.equal(receipt.source.kind, 'registry')
    assert.equal(receipt.version, '1.2.3')
  })

  it('keys the installation directory by identity AND version', () => {
    const store = scratch()
    const v1 = installPathFor(store, '@acme/tool-mode-topics', '1.2.3')
    const v2 = installPathFor(store, '@acme/tool-mode-topics', '1.2.4')
    // Side by side, so an update never mutates a live directory (EXT-30).
    assert.notEqual(v1, v2)
    assert.match(v1, /1\.2\.3$/)
  })

  it('refuses an identity that is not a legal package name', () => {
    const store = scratch()
    // Escaping would turn this into a harmless-looking directory name and install
    // something under an identity no registry would accept, so it is refused.
    for (const bad of ['../../etc', 'UPPER', 'has space', '@scope/', 'a/../../b']) {
      assert.throws(() => installPathFor(store, bad, '1.0.0'), (error: unknown) => {
        assert.ok(error instanceof ManagementError)
        assert.equal(error.code, 'INVALID_EXTENSION')
        return true
      }, `${bad} must be refused`)
    }
    // A scoped name is legal and stays inside the store.
    assert.match(installPathFor(store, '@acme/tool-mode-topics', '1.0.0'), /extensions/)
  })

  it('refuses a non-semantic version', () => {
    assert.throws(() => installPathFor(scratch(), '@acme/x', 'v1'), /not a semantic version/)
  })

  it('refuses an archive whose integrity does not match', async () => {
    const store = scratch()
    const bytes = buildExtensionZip()
    await assert.rejects(
      stagedInstall({
        source: SOURCE, storeDir: store, expectedSha512: digestOf(new Uint8Array([9])), archive: sourceFor(bytes),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ManagementError)
        assert.equal(error.code, 'INTEGRITY_MISMATCH')
        return true
      },
    )
    // Nothing was promoted.
    assert.equal(existsSync(join(store, 'extensions')), false)
  })

  it('refuses a traversal entry inside a real archive', async () => {
    const store = scratch()
    // Built at the byte level: adm-zip rewrites `../` on write, so it cannot
    // produce the archive this defense exists to refuse.
    const bytes = buildRawZip([
      { name: 'package/../../../evil.js', data: Buffer.from('pwned') },
    ])
    await assert.rejects(
      stagedInstall({ source: SOURCE, storeDir: store, expectedSha512: digestOf(bytes), archive: sourceFor(bytes) }),
      /traverses out of the package|refused/,
    )
    assert.equal(existsSync(join(store, 'extensions')), false)
  })

  it('refuses a case-colliding pair inside a real archive', async () => {
    const store = scratch()
    const bytes = buildExtensionZip(zip => {
      zip.addFile('Schemas/A.json', Buffer.from('{}'))
      zip.addFile('schemas/a.json', Buffer.from('{}'))
    })
    await assert.rejects(
      stagedInstall({ source: SOURCE, storeDir: store, expectedSha512: digestOf(bytes), archive: sourceFor(bytes) }),
      /collide on a case-insensitive filesystem/,
    )
  })

  it('refuses a package whose manifest identity disagrees with the package', async () => {
    const store = scratch()
    const bytes = buildExtensionZip(undefined, { manifestId: '@acme/other' })
    await assert.rejects(
      stagedInstall({ source: SOURCE, storeDir: store, expectedSha512: digestOf(bytes), archive: sourceFor(bytes) }),
      /must equal the package name/,
    )
  })

  it('refuses a package whose manifest is missing', async () => {
    const store = scratch()
    const bytes = buildExtensionZip(undefined, { toolModeManifest: './absent.json' })
    await assert.rejects(
      stagedInstall({ source: SOURCE, storeDir: store, expectedSha512: digestOf(bytes), archive: sourceFor(bytes) }),
      /does not ship/,
    )
  })

  it('refuses to install the same version twice', async () => {
    const store = scratch()
    const bytes = buildExtensionZip()
    const args = { source: SOURCE, storeDir: store, expectedSha512: digestOf(bytes), archive: sourceFor(bytes) }
    await stagedInstall(args)
    await assert.rejects(stagedInstall(args), (error: unknown) => {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'UPGRADE_FAILED')
      return true
    })
  })

  it('leaves no quarantine behind, on success or failure', async () => {
    const store = scratch()
    const good = buildExtensionZip()
    await stagedInstall({
      source: SOURCE, storeDir: store, expectedSha512: digestOf(good), archive: sourceFor(good),
    })
    assert.deepEqual(readdirSync(join(store, '.staging')), [], 'staging must be empty after success')

    const bad = buildExtensionZip(zip => zip.addFile('../escape.js', Buffer.from('x')))
    await assert.rejects(stagedInstall({
      source: SOURCE, storeDir: store, expectedSha512: digestOf(bad), archive: sourceFor(bad),
    }))
    assert.deepEqual(readdirSync(join(store, '.staging')), [], 'staging must be empty after failure')
  })

  it('refuses an oversized fetch before inspecting it', async () => {
    const store = scratch()
    // 1 KB of zeros, packed so the archive is genuinely large enough to trip a
    // deliberately tiny limit.
    const zip = new AdmZip()
    zip.addFile('package/blob.bin', Buffer.alloc(4096))
    const bytes = new Uint8Array(zip.toBuffer())
    await assert.rejects(
      stagedInstall({
        source: SOURCE,
        storeDir: store,
        expectedSha512: digestOf(bytes),
        archive: sourceFor(bytes),
        limits: { maxArchiveBytes: 64, fetchTimeoutMs: 1000, archive: DEFAULT_ARCHIVE_LIMITS },
      }),
      /over the 64 limit/,
    )
  })
})
