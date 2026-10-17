/**
 * EXT-30 slices 1+2: staged update and pointer rollback (task-37).
 *
 * The flows are driven end-to-end through the store: stage → validate →
 * approve → commit, every gate refusal, the automatic post-commit rollback,
 * the standalone pointer-only rollback, fail-closed corruption, and
 * two-process serialization. All fixtures are LOCAL AdmZip archives; nothing
 * here executes extension code or touches the network.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

import {
  commitUpdate,
  createZipArchiveSource,
  digestInstalledContent,
  ExtensionLifecycle,
  ExtensionStore,
  ManagementError,
  recordApproval,
  rollback,
  stagedInstall,
  stageUpdate,
  type ContributionRegistrar,
} from '../src/index.ts'

/** A registrar stub: the pointer-preservation tests care about STATE writes. */
function stubRegistrar(): ContributionRegistrar {
  return {
    publish: contribution => `h:${contribution.extensionId}:${contribution.name}`,
    withdraw: () => { /* nothing to release */ },
  }
}

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmx-upd-'))
  dirs.push(dir)
  return dir
}

const sha512 = (bytes: Uint8Array): string => createHash('sha512').update(bytes).digest('hex')

/** Build a versioned extension archive with a controllable manifest. */
function buildVersion(
  version: string,
  manifest: Record<string, unknown>,
  schemas: { input: Record<string, unknown>; output: Record<string, unknown> },
): Uint8Array {
  const zip = new AdmZip()
  zip.addFile('package.json', Buffer.from(JSON.stringify({
    name: '@acme/updatable', version, type: 'module',
    exports: { './tool-mode': './index.js' },
    toolMode: { manifest: './tool-mode.extension.json' },
  })))
  zip.addFile('tool-mode.extension.json', Buffer.from(JSON.stringify(manifest)))
  zip.addFile('index.js', Buffer.from('export const ok = true'))
  zip.addFile('schemas/in.json', Buffer.from(JSON.stringify(schemas.input)))
  zip.addFile('schemas/out.json', Buffer.from(JSON.stringify(schemas.output)))
  return new Uint8Array(zip.toBuffer())
}

/** The v1 manifest/schemas every test builds on. */
function v1Material(): { manifest: Record<string, unknown>; schemas: { input: Record<string, unknown>; output: Record<string, unknown> } } {
  return {
    manifest: {
      protocolVersion: '1.1.0',
      id: '@acme/updatable',
      version: '1.0.0',
      displayName: 'Updatable',
      description: 'An extension used to exercise the EXT-30 update flow.',
      license: 'MIT',
      activation: { policy: 'operator', deactivatable: true },
      runtimeApi: 1,
      compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
      execution: { kind: 'module', entry: './index.js' },
      permissions: { networkOrigins: [], inputFiles: false, storage: 'none', secrets: [], nativeCode: false },
      models: [],
      tools: [{
        id: 'alpha', name: 'updatable_alpha', contractId: '@test/updatable.alpha', contractVersion: '1.0.0',
        description: 'The alpha tool.', inputSchema: './schemas/in.json', outputSchema: './schemas/out.json',
      }],
      implementations: [{ id: 'binding-alpha', contractId: '@test/updatable.alpha', contractVersion: '1.0.0', recipeVersion: '1.0.0' }],
      skills: [],
    },
    schemas: {
      input: {
        type: 'object',
        properties: { text: { type: 'string' }, count: { type: 'integer' } },
        required: ['text'],
      },
      output: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
    },
  }
}

/** Install v1 and seed the profile pointer (the "activated v1" starting state). */
async function installV1(store: string): Promise<void> {
  const material = v1Material()
  const bytes = buildVersion('1.0.0', material.manifest, material.schemas)
  await stagedInstall({
    source: { kind: 'local', requested: '@acme/updatable@1.0.0' },
    storeDir: store,
    expectedSha512: sha512(bytes),
    archive: createZipArchiveSource(async () => bytes),
  })
  new ExtensionStore(store).writeProfileState(
    'default', [], undefined,
    { '@acme/updatable': '1.0.0' }, {},
  )
}

/** Stage one version from an in-memory archive. */
async function stage(store: string, version: string, manifest: Record<string, unknown>, schemas: { input: Record<string, unknown>; output: Record<string, unknown> }, expectedSha512?: string) {
  const bytes = buildVersion(version, manifest, schemas)
  return await stageUpdate({
    storeDir: store,
    source: { kind: 'local', requested: `@acme/updatable@${version}` },
    archive: createZipArchiveSource(async () => bytes),
    ...expectedSha512 === undefined ? {} : { expectedSha512 },
  })
}

const codeOf = (error: unknown): string | undefined =>
  error instanceof ManagementError ? error.code : undefined

describe('EXT-30 slice 1 — stageUpdate validates and never touches the installed version', () => {
  it('a compatible stage passes every gate with no approval required', async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    const manifest = { ...material.manifest, version: '1.1.0' }
    const schemas = {
      input: { ...material.schemas.input, properties: { ...material.schemas.input.properties, optional: { type: 'string' } } },
      output: material.schemas.output,
    }
    const result = await stage(store, '1.1.0', manifest, schemas)
    assert.equal(result.extensionId, '@acme/updatable')
    assert.equal(result.stagedVersion, '1.1.0')
    assert.equal(result.report.manifestOk, true)
    assert.equal(result.report.requiresApproval, false)
    assert.equal(result.report.schemaDeltas.some(delta => delta.breaking), false)
    assert.ok(existsSync(result.stagedPath), 'the staged extraction stays in staging/')
    const current = new ExtensionStore(store).listInstalled().value.find(r => r.version === '1.0.0')
    assert.ok(current !== undefined)
    assert.equal(new ExtensionStore(store).verifyUnchanged(current).unchanged, true, 'the installed version is byte-identical')
  })

  it('a wrong declared digest refuses with INTEGRITY_MISMATCH and no staging survives', async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    const manifest = { ...material.manifest, version: '1.1.0' }
    try {
      await stage(store, '1.1.0', manifest, material.schemas, '0'.repeat(128))
      assert.fail('the stage must refuse a mismatched digest')
    } catch (error) {
      assert.equal(codeOf(error), 'INTEGRITY_MISMATCH')
    }
    assert.equal(existsSync(join(store, 'staging', '@acme__updatable--1.1.0.staged')), false, 'the refused stage leaves no staged bytes')
  })

  it('a BREAKING schema delta refuses the stage with UPGRADE_FAILED and leaves v1 untouched', async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    const manifest = { ...material.manifest, version: '1.1.0' }
    const schemas = {
      input: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }, // 'text' REMOVED
      output: material.schemas.output,
    }
    try {
      await stage(store, '1.1.0', manifest, schemas)
      assert.fail('the stage must refuse a breaking contract change')
    } catch (error) {
      assert.equal(codeOf(error), 'UPGRADE_FAILED')
      assert.match((error as ManagementError).message, /breaking contract changes require a reviewed migration/)
    }
    const v1 = new ExtensionStore(store).listInstalled().value.find(r => r.version === '1.0.0')
    assert.ok(v1 !== undefined)
    assert.equal(new ExtensionStore(store).verifyUnchanged(v1).unchanged, true)
    assert.equal(existsSync(join(store, 'staging', '@acme__updatable--1.1.0.staged')), false)
  })

  it('a license delta and a permission expansion mark the stage as requiring approval', async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    const manifest = {
      ...material.manifest, version: '1.1.0',
      license: 'Apache-2.0',
      permissions: { ...material.manifest.permissions, networkOrigins: ['https://example.com'], nativeCode: true },
    }
    const result = await stage(store, '1.1.0', manifest, material.schemas)
    assert.equal(result.report.requiresApproval, true)
    assert.equal(result.report.licenseDelta, 'the manifest licence declaration changed; operator approval required')
    assert.deepEqual(result.report.permissionDeltas, [
      'new network origin "https://example.com"',
      'nativeCode: false -> true',
    ])
  })
})

describe('EXT-30 slice 2 — approval, commit, automatic rollback', () => {
  it('stage → approve → commit moves the pointer and keeps v1 recorded as previous', async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    const result = await stage(store, '1.1.0', { ...material.manifest, version: '1.1.0' }, material.schemas)
    recordApproval({
      storeDir: store, extensionId: result.extensionId, stagedVersion: result.stagedVersion,
      decision: { approved: true },
    })
    const commit = await commitUpdate({
      storeDir: store, profile: 'default', extensionId: result.extensionId, stagedVersion: result.stagedVersion,
      pointerOnly: true,
    })
    assert.equal(commit.activeVersion, '1.1.0')
    assert.equal(commit.previousVersion, '1.0.0')
    const pointers = new ExtensionStore(store).readProfilePointers('default')
    assert.equal(pointers.corrupt, false)
    assert.equal(pointers.value.activeVersions['@acme/updatable'], '1.1.0')
    assert.equal(pointers.value.previousVersions['@acme/updatable'], '1.0.0')
    const v2 = new ExtensionStore(store).listInstalled().value.find(r => r.version === '1.1.0')
    assert.ok(v2 !== undefined, 'the new version is admitted to its own directory')
    assert.ok(existsSync(v2.installPath))
    assert.ok(existsSync(join(store, 'staging', '@acme__updatable--1.1.0.staged')) === false, 'the spent stage is removed')
  })

  it('a commit without an approval record refuses and the pointer is unchanged', async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    await stage(store, '1.1.0', { ...material.manifest, version: '1.1.0' }, material.schemas)
    try {
      await commitUpdate({ storeDir: store, profile: 'default', extensionId: '@acme/updatable', stagedVersion: '1.1.0' })
      assert.fail('the commit must refuse without an approval')
    } catch (error) {
      assert.equal(codeOf(error), 'UPGRADE_FAILED')
      assert.match((error as ManagementError).message, /no APPROVED record/)
    }
    const pointers = new ExtensionStore(store).readProfilePointers('default')
    assert.equal(pointers.value.activeVersions['@acme/updatable'], '1.0.0')
  })

  it('a DENIED approval refuses the commit and the denial is retained for the store lifetime', async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    await stage(store, '1.1.0', { ...material.manifest, version: '1.1.0' }, material.schemas)
    recordApproval({
      storeDir: store, extensionId: '@acme/updatable', stagedVersion: '1.1.0',
      decision: { approved: false, reason: 'the operator declined the nativeCode expansion' },
    })
    try {
      await commitUpdate({ storeDir: store, profile: 'default', extensionId: '@acme/updatable', stagedVersion: '1.1.0' })
      assert.fail('a denied stage must not commit')
    } catch (error) {
      assert.equal(codeOf(error), 'UPGRADE_FAILED')
    }
    // The denial survives a fresh store instance (lifetime retention).
    const approval = new ExtensionStore(store).readApproval('@acme/updatable', '1.1.0')
    assert.equal(approval.corrupt, false)
    assert.equal(approval.value?.approved, false)
    assert.equal(approval.value?.deniedReason, 'the operator declined the nativeCode expansion')
  })

  it('a rebind failure after the pointer commit rolls the pointer back AUTOMATICALLY and names the reason', async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    await stage(store, '1.1.0', { ...material.manifest, version: '1.1.0' }, material.schemas)
    recordApproval({
      storeDir: store, extensionId: '@acme/updatable', stagedVersion: '1.1.0',
      decision: { approved: true },
    })
    try {
      await commitUpdate({
        storeDir: store, profile: 'default', extensionId: '@acme/updatable', stagedVersion: '1.1.0',
        hooks: { rebindNext: async () => { throw new Error('the host registrar refused the rebind') } },
      })
      assert.fail('a failed rebind must surface as a failure')
    } catch (error) {
      assert.equal(codeOf(error), 'UPGRADE_FAILED')
      assert.match((error as ManagementError).message, /pointer was rolled back to 1\.0\.0/)
      assert.match((error as ManagementError).message, /host registrar refused the rebind/)
    }
    const pointers = new ExtensionStore(store).readProfilePointers('default')
    assert.equal(pointers.value.activeVersions['@acme/updatable'], '1.0.0', 'the durable answer is the previous version')
  })
})

describe('EXT-30 slice 3 SDK seams — two-phase commit, no-seam refusal, rollback-side hook', () => {
  it('a NO-SEAM commit (approved, no rebindNext, no pointerOnly) refuses by default with the pointer unchanged', async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    await stage(store, '1.1.0', { ...material.manifest, version: '1.1.0' }, material.schemas)
    recordApproval({ storeDir: store, extensionId: '@acme/updatable', stagedVersion: '1.1.0', decision: { approved: true } })
    try {
      await commitUpdate({ storeDir: store, profile: 'default', extensionId: '@acme/updatable', stagedVersion: '1.1.0' })
      assert.fail('the default must be fail-closed')
    } catch (error) {
      assert.equal(codeOf(error), 'UPGRADE_FAILED')
      assert.match((error as ManagementError).message, /without a rebind seam/)
    }
    const pointers = new ExtensionStore(store).readProfilePointers('default')
    assert.equal(pointers.value.activeVersions['@acme/updatable'], '1.0.0', 'the pointer is unchanged by the refusal')
  })

  it('a quiescePrevious failure ABORTS the commit before the pointer moves and rebindNext never runs', async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    await stage(store, '1.1.0', { ...material.manifest, version: '1.1.0' }, material.schemas)
    recordApproval({ storeDir: store, extensionId: '@acme/updatable', stagedVersion: '1.1.0', decision: { approved: true } })
    let rebindRuns = 0
    try {
      await commitUpdate({
        storeDir: store, profile: 'default', extensionId: '@acme/updatable', stagedVersion: '1.1.0',
        hooks: {
          quiescePrevious: async () => { throw new Error('the old generation cannot quiesce') },
          rebindNext: async () => { rebindRuns += 1 },
        },
      })
      assert.fail('a failed quiesce must abort the commit')
    } catch (error) {
      assert.equal(codeOf(error), 'UPGRADE_FAILED')
      assert.match((error as ManagementError).message, /quiesce of 1\.0\.0 failed before the pointer commit/)
      assert.match((error as ManagementError).message, /pointer is unchanged/)
    }
    assert.equal(rebindRuns, 0, 'rebindNext must never run after a quiesce failure')
    const pointers = new ExtensionStore(store).readProfilePointers('default')
    assert.equal(pointers.value.activeVersions['@acme/updatable'], '1.0.0')
  })

  it('the two-phase order pins quiesce BEFORE the pointer write and rebind AFTER it', async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    await stage(store, '1.1.0', { ...material.manifest, version: '1.1.0' }, material.schemas)
    recordApproval({ storeDir: store, extensionId: '@acme/updatable', stagedVersion: '1.1.0', decision: { approved: true } })
    const events: string[] = []
    const commit = await commitUpdate({
      storeDir: store, profile: 'default', extensionId: '@acme/updatable', stagedVersion: '1.1.0',
      hooks: {
        quiescePrevious: async () => {
          // Inside quiesce, the durable pointer must STILL be the old version.
          const pointers = new ExtensionStore(store).readProfilePointers('default')
          events.push(`quiesce:${pointers.value.activeVersions['@acme/updatable']}`)
        },
        rebindNext: async () => {
          const pointers = new ExtensionStore(store).readProfilePointers('default')
          events.push(`rebind:${pointers.value.activeVersions['@acme/updatable']}`)
        },
      },
    })
    assert.equal(commit.activeVersion, '1.1.0')
    assert.deepEqual(events, ['quiesce:1.0.0', 'rebind:1.1.0'], 'quiesce sees the OLD pointer, rebind sees the NEW one')
  })

  it('the automatic rollback after a rebind failure invokes ZERO further hooks (rebind-revert contract)', async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    await stage(store, '1.1.0', { ...material.manifest, version: '1.1.0' }, material.schemas)
    recordApproval({ storeDir: store, extensionId: '@acme/updatable', stagedVersion: '1.1.0', decision: { approved: true } })
    let quiesceRuns = 0
    try {
      await commitUpdate({
        storeDir: store, profile: 'default', extensionId: '@acme/updatable', stagedVersion: '1.1.0',
        hooks: {
          quiescePrevious: async () => { quiesceRuns += 1 },
          rebindNext: async () => { throw new Error('rebind exploded after publishing half the surface') },
        },
      })
      assert.fail('the rebind failure must surface')
    } catch (error) {
      assert.equal(codeOf(error), 'UPGRADE_FAILED')
    }
    assert.equal(quiesceRuns, 1, 'quiesce ran exactly once (its phase), never re-run by the rollback')
    const pointers = new ExtensionStore(store).readProfilePointers('default')
    assert.equal(pointers.value.activeVersions['@acme/updatable'], '1.0.0')
  })

  it('the rollback-side rebindRestored hook fires after the restore, and its failure is REPORTED without losing the restore', async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    await stage(store, '1.1.0', { ...material.manifest, version: '1.1.0' }, material.schemas)
    recordApproval({ storeDir: store, extensionId: '@acme/updatable', stagedVersion: '1.1.0', decision: { approved: true } })
    await commitUpdate({ storeDir: store, profile: 'default', extensionId: '@acme/updatable', stagedVersion: '1.1.0', pointerOnly: true })

    const seen: string[] = []
    const result = await rollback({
      storeDir: store, profile: 'default', extensionId: '@acme/updatable',
      rebindRestored: async version => { seen.push(version) },
    })
    assert.deepEqual(seen, ['1.0.0'], 'the hook receives the restored version')
    assert.equal(result.hookFailure, undefined)
    assert.equal(result.activeVersion, '1.0.0')

    // Now roll FORWARD again and fail the restore hook: the restore stands.
    const failing = await rollback({
      storeDir: store, profile: 'default', extensionId: '@acme/updatable',
      rebindRestored: async () => { throw new Error('the restored rebind failed') },
    })
    assert.equal(failing.activeVersion, '1.1.0', 'the pointer restore stands despite the hook failure')
    assert.equal(failing.hookFailure, 'the restored rebind failed', 'the hook error is reported, never thrown')
    const pointers = new ExtensionStore(store).readProfilePointers('default')
    assert.equal(pointers.value.activeVersions['@acme/updatable'], '1.1.0', 'no double rollback')
  })
})

describe('EXT-30 fix — lifecycle state writes preserve the update pointers (task-46)', () => {
  it('activate after a committed update preserves activeVersions/previousVersions', async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    await stage(store, '1.1.0', { ...material.manifest, version: '1.1.0' }, material.schemas)
    recordApproval({ storeDir: store, extensionId: '@acme/updatable', stagedVersion: '1.1.0', decision: { approved: true } })
    await commitUpdate({ storeDir: store, profile: 'default', extensionId: '@acme/updatable', stagedVersion: '1.1.0', pointerOnly: true })

    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: stubRegistrar(),
    })
    await lifecycle.activate('@acme/updatable', '1.1.0')

    const pointers = new ExtensionStore(store).readProfilePointers('default')
    assert.equal(pointers.corrupt, false)
    assert.equal(pointers.value.activeVersions['@acme/updatable'], '1.1.0', 'the pointer survives the activation write')
    assert.equal(pointers.value.previousVersions['@acme/updatable'], '1.0.0', 'the rollback target survives too')
  })

  it('startup-restore (restart adoption) and deactivate each preserve the pointers', async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    const first = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: stubRegistrar(),
    })
    await first.activate('@acme/updatable', '1.0.0')
    await stage(store, '1.1.0', { ...material.manifest, version: '1.1.0' }, material.schemas)
    recordApproval({ storeDir: store, extensionId: '@acme/updatable', stagedVersion: '1.1.0', decision: { approved: true } })
    await commitUpdate({ storeDir: store, profile: 'default', extensionId: '@acme/updatable', stagedVersion: '1.1.0', pointerOnly: true })

    // Simulate the persisted RESTART document: state says active, owner pid gone.
    const persisted = new ExtensionStore(store)
    const states = persisted.readProfileState('default')
    assert.equal(states.corrupt, false)
    const restartStates = states.value.map(state => {
      const { ownerPid: _gone, ...rest } = state as { ownerPid?: number } & typeof state
      return rest
    })
    persisted.writeProfileState('default', restartStates, undefined, { '@acme/updatable': '1.1.0' }, { '@acme/updatable': '1.0.0' })

    // A fresh lifecycle instance adopts the restart state and writes it back.
    const second = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: stubRegistrar(),
    })
    await second.activate('@acme/updatable', '1.0.0')
    let pointers = new ExtensionStore(store).readProfilePointers('default')
    assert.equal(pointers.value.activeVersions['@acme/updatable'], '1.1.0', 'startup-restore preserves the pointer')
    assert.equal(pointers.value.previousVersions['@acme/updatable'], '1.0.0')

    await second.deactivate('@acme/updatable')
    pointers = new ExtensionStore(store).readProfilePointers('default')
    assert.equal(pointers.value.activeVersions['@acme/updatable'], '1.1.0', 'deactivate preserves the pointer')
    assert.equal(pointers.value.previousVersions['@acme/updatable'], '1.0.0')
  })
})

describe('EXT-30 slice 2 — standalone rollback is pointer-only', () => {
  it('restores the previous pointer WITHOUT copying bytes over the live installs', async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    await stage(store, '1.1.0', { ...material.manifest, version: '1.1.0' }, material.schemas)
    recordApproval({ storeDir: store, extensionId: '@acme/updatable', stagedVersion: '1.1.0', decision: { approved: true } })
    await commitUpdate({ storeDir: store, profile: 'default', extensionId: '@acme/updatable', stagedVersion: '1.1.0', pointerOnly: true })
    const v1Record = new ExtensionStore(store).listInstalled().value.find(r => r.version === '1.0.0')
    const v2Record = new ExtensionStore(store).listInstalled().value.find(r => r.version === '1.1.0')
    assert.ok(v1Record !== undefined && v2Record !== undefined)
    const v1Before = digestInstalledContent(v1Record.installPath)
    const v2Before = digestInstalledContent(v2Record.installPath)

    const result = await rollback({ storeDir: store, profile: 'default', extensionId: '@acme/updatable' })
    assert.equal(result.activeVersion, '1.0.0')
    assert.equal(result.previousVersion, '1.1.0')
    const pointers = new ExtensionStore(store).readProfilePointers('default')
    assert.equal(pointers.value.activeVersions['@acme/updatable'], '1.0.0')
    assert.equal(digestInstalledContent(v1Record.installPath), v1Before, 'the restored version\'s bytes are untouched')
    assert.equal(digestInstalledContent(v2Record.installPath), v2Before, 'the rolled-back version\'s bytes are untouched')
  })

  it('refuses a rollback when the previous version changed on disk (fail closed)', async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    await stage(store, '1.1.0', { ...material.manifest, version: '1.1.0' }, material.schemas)
    recordApproval({ storeDir: store, extensionId: '@acme/updatable', stagedVersion: '1.1.0', decision: { approved: true } })
    await commitUpdate({ storeDir: store, profile: 'default', extensionId: '@acme/updatable', stagedVersion: '1.1.0', pointerOnly: true })
    const v1Record = new ExtensionStore(store).listInstalled().value.find(r => r.version === '1.0.0')
    assert.ok(v1Record !== undefined)
    writeFileSync(join(v1Record.installPath, 'tampered.txt'), 'tamper')
    try {
      await rollback({ storeDir: store, profile: 'default', extensionId: '@acme/updatable' })
      assert.fail('the rollback must refuse a corrupt previous version')
    } catch (error) {
      assert.equal(codeOf(error), 'EXTENSION_FAULT')
      assert.match((error as ManagementError).message, /changed on disk/)
    }
    const pointers = new ExtensionStore(store).readProfilePointers('default')
    assert.equal(pointers.value.activeVersions['@acme/updatable'], '1.1.0', 'the current pointer stays: the rollback never points at unverified bytes')
  })
})

describe('EXT-30 — two updaters are serialized by the store lock', () => {
  it('two racing commit processes leave exactly one consistent pointer and no lost state', { timeout: 60_000 }, async () => {
    const store = scratch()
    await installV1(store)
    const material = v1Material()
    await stage(store, '1.1.0', { ...material.manifest, version: '1.1.0' }, material.schemas)
    recordApproval({ storeDir: store, extensionId: '@acme/updatable', stagedVersion: '1.1.0', decision: { approved: true } })
    await stage(store, '1.2.0', { ...material.manifest, version: '1.2.0' }, material.schemas)
    recordApproval({ storeDir: store, extensionId: '@acme/updatable', stagedVersion: '1.2.0', decision: { approved: true } })

    const entryUrl = `file:///${process.cwd().replaceAll('\\', '/')}/packages/tool-mode-extension-sdk/src/index.ts`
    const child = (version: string) => `
      import { commitUpdate } from ${JSON.stringify(entryUrl)}
      try {
        const result = await commitUpdate({
          storeDir: ${JSON.stringify(store)}, profile: 'default',
          extensionId: '@acme/updatable', stagedVersion: ${JSON.stringify(version)},
          pointerOnly: true,
        })
        console.log('COMMITTED ' + version + ' prev=' + result.previousVersion)
      } catch (error) {
        console.log('REFUSED ' + version + ' ' + ((error && error.code) ?? error.constructor.name))
      }
    `
    const run = (version: string): Promise<string> => new Promise(resolve => {
      const childProcess = spawn(process.execPath, ['--import', 'tsx', '--input-type', 'module', '--eval', child(version)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      childProcess.stdout.on('data', chunk => { out += String(chunk) })
      childProcess.stderr.on('data', chunk => { out += String(chunk) })
      childProcess.on('close', () => resolve(out))
    })

    const [first, second] = await Promise.all([run('1.1.0'), run('1.2.0')])
    const outcome = `${first.trim()}\n${second.trim()}`
    assert.match(outcome, /COMMITTED|REFUSED/, 'each child settles with a named outcome, never a crash')

    const pointers = new ExtensionStore(store).readProfilePointers('default')
    assert.equal(pointers.corrupt, false, 'the profile document is intact after the race')
    const active = pointers.value.activeVersions['@acme/updatable']
    assert.ok(active === '1.1.0' || active === '1.2.0', `the final pointer is one consistent version, got ${active}`)
  })
})
