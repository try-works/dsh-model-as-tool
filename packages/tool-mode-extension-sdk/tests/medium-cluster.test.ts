/**
 * The MEDIUM SDK cluster (task-66): EXT-08 install preview, EXT-12 provenance
 * recording, EXT-29 tombstone retry, and the EXT-31 CLI update/rollback/
 * purge-assets subcommands with structured --json output.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

import {
  createZipArchiveSource,
  commitUpdate,
  ExtensionStore,
  ManagementError,
  recordApproval,
  rollback,
  runToolModeCli,
  stagedInstall,
  stageUpdate,
  type CliIo,
} from '../src/index.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmx-med-'))
  dirs.push(dir)
  return dir
}

const sha512 = (bytes: Uint8Array): string => createHash('sha512').update(bytes).digest('hex')

function capture(): { io: CliIo; lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return { io: { out: l => lines.push(l), err: l => errors.push(l) }, lines, errors }
}

/** Build an extension archive with a controllable manifest. */
function buildExtension(version: string, manifest: Record<string, unknown>): Uint8Array {
  const zip = new AdmZip()
  zip.addFile('package.json', Buffer.from(JSON.stringify({
    name: '@acme/cli-ext', version, type: 'module',
    exports: { './tool-mode': './index.js', './tool-mode.extension.json': './tool-mode.extension.json', './package.json': './package.json' },
    toolMode: { manifest: './tool-mode.extension.json' },
  })))
  zip.addFile('tool-mode.extension.json', Buffer.from(JSON.stringify(manifest)))
  zip.addFile('index.js', Buffer.from('export const ok = true'))
  return new Uint8Array(zip.toBuffer())
}

function baseManifest(version: string): Record<string, unknown> {
  return {
    protocolVersion: '1.1.0', id: '@acme/cli-ext', version,
    displayName: 'CLI Ext', description: 'An extension used to exercise the MEDIUM SDK cluster.',
    activation: { policy: 'operator', deactivatable: true }, runtimeApi: 1,
    compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
    execution: { kind: 'module', entry: './index.js' },
    permissions: { networkOrigins: [], inputFiles: false, storage: 'none', secrets: [], nativeCode: false },
    models: [], tools: [], implementations: [], skills: [],
  }
}

describe('EXT-08 — the install preview runs BEFORE materialization', () => {
  it('a permission-bearing manifest yields the delta preview, and a refusing preview aborts', async () => {
    const store = scratch()
    const manifest = {
      ...baseManifest('1.0.0'),
      permissions: { networkOrigins: ['https://example.com'], inputFiles: true, storage: 'extension-private', secrets: ['s'], nativeCode: true },
    }
    const bytes = buildExtension('1.0.0', manifest)
    const seen: unknown[] = []
    let aborted = false
    try {
      await stagedInstall({
        source: { kind: 'local', requested: '@acme/cli-ext@1.0.0' },
        storeDir: store,
        expectedSha512: sha512(bytes),
        archive: createZipArchiveSource(async () => bytes),
        preview: async preview => {
          seen.push(preview)
          throw new ManagementError('PERMISSION_REQUIRED', 'install', 'the operator declined the preview', 'Review the listed permissions deliberately.')
        },
      })
      assert.fail('a refusing preview must abort the install')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'PERMISSION_REQUIRED')
      aborted = true
    }
    assert.equal(aborted, true)
    const preview = seen[0] as { permissions: { networkOrigins: string[]; nativeCode: boolean }; requiresApproval: boolean }
    assert.deepEqual(preview.permissions.networkOrigins, ['https://example.com'])
    assert.equal(preview.permissions.nativeCode, true)
    assert.equal(preview.requiresApproval, true)
    assert.equal(existsSync(join(store, 'extensions')), false, 'nothing was promoted after the refusal')
  })

  it('an approving preview lets the install proceed and records the deltas it listed', async () => {
    const store = scratch()
    const bytes = buildExtension('1.0.0', baseManifest('1.0.0'))
    const seen: unknown[] = []
    const result = await stagedInstall({
      source: { kind: 'local', requested: '@acme/cli-ext@1.0.0' },
      storeDir: store,
      expectedSha512: sha512(bytes),
      archive: createZipArchiveSource(async () => bytes),
      preview: async preview => { seen.push(preview) },
    })
    assert.equal(result.activation, 'inactive')
    const preview = seen[0] as { extensionId: string; requiresApproval: boolean; downloadImplications: string }
    assert.equal(preview.extensionId, '@acme/cli-ext')
    assert.equal(preview.requiresApproval, false)
    assert.match(preview.downloadImplications, /no model assets declared/)
  })
})

describe('EXT-12 — provenance is recorded as data, never as trust', () => {
  it('registry provenance fields travel with the install record verbatim', async () => {
    const store = scratch()
    const bytes = buildExtension('1.0.0', baseManifest('1.0.0'))
    await stagedInstall({
      source: { kind: 'registry', requested: '@acme/cli-ext@1.0.0' },
      storeDir: store,
      expectedSha512: sha512(bytes),
      archive: createZipArchiveSource(async () => bytes),
      provenance: {
        registryIntegrity: 'sha512-deadbeef',
        provenance: true,
        attestations: ['sigstore-1'],
        signatures: ['keyid-abc'],
      },
    })
    const record = new ExtensionStore(store).listInstalled().value[0]
    assert.deepEqual(record?.provenance, {
      registryIntegrity: 'sha512-deadbeef',
      provenance: true,
      attestations: ['sigstore-1'],
      signatures: ['keyid-abc'],
    })
    // The provenance fields never substitute for the operator-supplied digest:
    // a mismatched archive still refuses.
    const wrong = buildExtension('1.0.0', baseManifest('1.0.0'))
    await assert.rejects(
      stagedInstall({
        source: { kind: 'registry', requested: '@acme/cli-ext@1.0.0' },
        storeDir: join(store, 'other'),
        expectedSha512: '0'.repeat(128),
        archive: createZipArchiveSource(async () => wrong),
        provenance: { provenance: true },
      }),
      error => error instanceof ManagementError && error.code === 'INTEGRITY_MISMATCH',
    )
  })
})

describe('EXT-29 — cleanup-pending tombstones and the bounded retry loop', () => {
  it('a tombstoned directory is retried and deleted inside the exclusive section', async () => {
    const store = scratch()
    const target = join(scratch(), 'leftover')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'kept.txt'), 'x')
    const extensions = new ExtensionStore(store)
    extensions.writeCleanupTombstone(target, 'Windows still held the file')
    // The retry runs at the start of every exclusive section.
    await extensions.exclusive(async () => undefined)
    assert.equal(existsSync(target), false, 'the owned deletion was retried')
    assert.equal(existsSync(join(extensions.cleanupPendingDir())), false, 'the tombstone is removed on success')
  })

  it('a tombstone at the attempts cap stays as the truthful CLEANUP_PENDING record', async () => {
    const store = scratch()
    const tombstoneDir = join(store, 'cleanup-pending')
    mkdirSync(tombstoneDir, { recursive: true })
    writeFileSync(join(tombstoneDir, 'stuck.json'), JSON.stringify({
      path: 'Q:/unreachable/leftover', attempts: 5, since: new Date().toISOString(), reason: 'still locked',
    }))
    const extensions = new ExtensionStore(store)
    const outcome = extensions.retryCleanupPending()
    assert.equal(outcome.retried, 0)
    assert.equal(outcome.kept, 1, 'the capped tombstone is kept as evidence')
    assert.equal(existsSync(join(tombstoneDir, 'stuck.json')), true)
  })

  it('a tombstone whose target already vanished counts as deleted', async () => {
    const store = scratch()
    const extensions = new ExtensionStore(store)
    extensions.writeCleanupTombstone(join(store, 'never-existed'), 'previous attempt failed')
    const outcome = extensions.retryCleanupPending()
    assert.equal(outcome.deleted, 1)
    assert.equal(existsSync(extensions.cleanupPendingDir()), false)
  })
})

describe('EXT-31 — the update/rollback/purge CLI subcommands and --json', () => {
  async function installV1(store: string): Promise<void> {
    const bytes = buildExtension('1.0.0', baseManifest('1.0.0'))
    await stagedInstall({
      source: { kind: 'local', requested: '@acme/cli-ext@1.0.0' },
      storeDir: store, expectedSha512: sha512(bytes),
      archive: createZipArchiveSource(async () => bytes),
    })
    new ExtensionStore(store).writeProfileState('default', [], undefined, { '@acme/cli-ext': '1.0.0' }, {})
  }

  async function stageV2(store: string): Promise<void> {
    const bytes = buildExtension('1.1.0', baseManifest('1.1.0'))
    const staged = await stageUpdate({
      storeDir: store,
      source: { kind: 'local', requested: '@acme/cli-ext@1.1.0' },
      archive: createZipArchiveSource(async () => bytes),
    })
    recordApproval({ storeDir: store, extensionId: staged.extensionId, stagedVersion: staged.stagedVersion, decision: { approved: true } })
  }

  it('extensions update --to commits the staged version (offline pointerOnly) with --json output', async () => {
    const store = scratch()
    await installV1(store)
    await stageV2(store)
    const { io, lines } = capture()
    const code = await runToolModeCli(['extensions', 'update', '@acme/cli-ext', '--to', '1.1.0', '--store', store, '--json'], io)
    assert.equal(code, 0, lines.join('\n'))
    const doc = JSON.parse(lines[0] as string) as { command: string; exit: number }
    assert.equal(doc.command, 'extensions update')
    assert.equal(doc.exit, 0)
    const pointers = new ExtensionStore(store).readProfilePointers('default')
    assert.equal(pointers.value.activeVersions['@acme/cli-ext'], '1.1.0')
  })

  it('extensions rollback restores the previous pointer, and --to mismatches refuse by name', async () => {
    const store = scratch()
    await installV1(store)
    await stageV2(store)
    await commitUpdate({ storeDir: store, profile: 'default', extensionId: '@acme/cli-ext', stagedVersion: '1.1.0', pointerOnly: true })
    const mismatch = capture()
    const mismatchCode = await runToolModeCli(['extensions', 'rollback', '@acme/cli-ext', '--to', '9.9.9', '--store', store], mismatch.io)
    assert.equal(mismatchCode, 1)
    assert.match(mismatch.errors.join('\n'), /does not match the recorded previous version/)
    const { io, errors } = capture()
    const code = await runToolModeCli(['extensions', 'rollback', '@acme/cli-ext', '--store', store], io)
    assert.equal(code, 0, errors.join('\n'))
    const pointers = new ExtensionStore(store).readProfilePointers('default')
    assert.equal(pointers.value.activeVersions['@acme/cli-ext'], '1.0.0', 'the pointer is restored')
  })

  it('extensions purge-assets refuses honestly (offline CLI owns no asset registry)', async () => {
    const store = scratch()
    await installV1(store)
    const { io, lines } = capture()
    const code = await runToolModeCli(['extensions', 'purge-assets', '@acme/cli-ext', '--store', store, '--json'], io)
    assert.equal(code, 1)
    const doc = JSON.parse(lines[0] as string) as { exit: number; errors: string[] }
    assert.equal(doc.exit, 1)
    assert.match(doc.errors.join('\n'), /deployment coordinator/)
  })

  it('--json produces one JSON document for list, with the exit code as the status', async () => {
    const store = scratch()
    await installV1(store)
    const { io, lines } = capture()
    const code = await runToolModeCli(['extensions', 'list', '--store', store, '--json'], io)
    assert.equal(code, 0)
    const doc = JSON.parse(lines[0] as string) as { command: string; exit: number; output: string[] }
    assert.equal(doc.command, 'extensions list')
    assert.equal(doc.exit, 0)
    assert.ok(doc.output.some(line => line.includes('@acme/cli-ext')))
  })
})
