import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'

import { createZipArchiveSource, ExtensionStore, stagedInstall, stageUpdate } from '@try-works/tool-mode-extension-sdk'
import { createUpdateHostSurface } from '../src/update-surface.ts'
import { callTool, cleanup, mountPlugin, tempDir } from './helpers.ts'

const EXTENSION_ID = '@try-works/fixture-update-worker'

/** One fixture package directory (version-tagged manifest), zipped. */
function fixturePackage(options: { version: string; secrets: readonly string[] }): { dir: string; zip(): Uint8Array } {
  const dir = join(tmpdir(), `fixture-update-${options.version.replaceAll('.', '-')}-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: EXTENSION_ID,
    version: options.version,
    private: true,
    type: 'module',
    exports: { './tool-mode': './lib/index.mjs' },
    toolMode: { manifest: './tool-mode.extension.json' },
  }))
  writeFileSync(join(dir, 'tool-mode.extension.json'), JSON.stringify({
    protocolVersion: '1.1.0',
    id: EXTENSION_ID,
    version: options.version,
    displayName: 'Update fixture',
    description: 'A deterministic fixture for the host update surface (EXT-30 slice 3).',
    activation: { policy: 'operator', deactivatable: true },
    runtimeApi: 1,
    compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
    execution: { kind: 'module', entry: './lib/index.mjs' },
    permissions: {
      networkOrigins: [],
      inputFiles: false,
      storage: 'extension-private',
      secrets: [...options.secrets],
      nativeCode: false,
    },
    models: [],
    tools: [],
    implementations: [],
    skills: [],
  }))
  writeFileSync(join(dir, 'lib', 'index.mjs'), 'export default { apiVersion: 1, async create() { return { async dispose() {} } } }\n')
  const zip = () => {
    const archive = new AdmZip()
    const walk = (current: string): void => {
      for (const entry of readdirSync(current)) {
        const full = join(current, entry)
        if (statSync(full).isDirectory()) walk(full)
        else archive.addFile(relative(dir, full).replace(/\\/g, '/'), readFileSync(full))
      }
    }
    walk(dir)
    return new Uint8Array(archive.toBuffer())
  }
  return { dir, zip }
}

/** A recording fake for the lifecycle hooks. */
function fakeHooks(behavior: {
  quiesce?: 'ok' | 'throw'
  rebind?: 'ok' | 'throw' | 'hang'
  rejectVersions?: readonly string[]
} = {}) {
  const calls: string[] = []
  return {
    calls,
    hooks: {
      async quiesce(extensionId: string) {
        calls.push(`quiesce ${extensionId}`)
        if (behavior.quiesce === 'throw') throw new Error('the quiesce hook failed (fixture)')
      },
      async rebind(extensionId: string, version: string) {
        calls.push(`rebind ${extensionId}@${version}`)
        if (behavior.rebind === 'hang') {
          await new Promise(() => { /* never settles: the timeout bound must fire */ })
        }
        if (behavior.rebind === 'throw' || behavior.rejectVersions?.includes(version)) {
          throw new Error(`the rebind hook refused ${extensionId}@${version} (fixture)`)
        }
      },
    },
  }
}

async function preparedStore(): Promise<{ storeDir: string; v1: { dir: string }; v2: { dir: string; sha512: string } }> {
  const storeDir = mkdtempSync(join(tmpdir(), 'update-surface-'))
  const v1 = fixturePackage({ version: '1.0.0', secrets: [] })
  const v1Bytes = v1.zip()
  await stagedInstall({
    source: { kind: 'local', requested: v1.dir },
    storeDir,
    expectedSha512: createHash('sha512').update(v1Bytes).digest('hex'),
    archive: createZipArchiveSource(() => v1Bytes),
  })
  // Activate v1 through the store profile so a pointer exists (the surface's
  // commit needs a previous pointer for the restore logic). ownerPid is a DEAD
  // pid (the managed-workers fixture convention): the mounted host's restore
  // adopts a legacy owner instead of refusing a same-process stranger.
  const store = new ExtensionStore(storeDir)
  store.writeProfileState('default', [{
    extensionId: EXTENSION_ID,
    version: '1.0.0',
    desiredActivation: 'active',
    observedActivation: 'active',
    readiness: {},
    tools: [],
    ownerPid: 2147483647,
  }], undefined, { [EXTENSION_ID]: '1.0.0' }, {})

  const v2 = fixturePackage({ version: '1.1.0', secrets: ['db-secret'] })
  const v2Bytes = v2.zip()
  await stageUpdate({
    storeDir,
    source: { kind: 'local', requested: v2.dir },
    archive: createZipArchiveSource(() => v2Bytes),
    expectedSha512: createHash('sha512').update(v2Bytes).digest('hex'),
  })
  return { storeDir, v1, v2: { dir: v2.dir, sha512: createHash('sha512').update(v2Bytes).digest('hex') } }
}

test('the MANAGEMENT channel serves the round trip: pending → approve → commit → rollback (AT-39)', async () => {
  const { storeDir } = await preparedStore()
  const ctx = await mountPlugin({
    stateFile: join(storeDir, 'state.json'),
    credentialsFile: join(storeDir, 'credentials.json'),
    extensionStore: storeDir,
  })
  try {
    // The pending listing goes through the management tool, never the MCP surface.
    const pending = await callTool(ctx, 'model_tools', { action: 'extensions-pending' })
    assert.equal(pending.isError, false, JSON.stringify(pending))
    const entries = (pending.value as { pending: Array<{ extensionId: string; stagedVersion: string; requiresApproval: boolean }> }).pending
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.stagedVersion, '1.1.0')
    assert.equal(entries[0]!.requiresApproval, true)

    // Deny first: the commit must refuse.
    const denied = await callTool(ctx, 'model_tools', { action: 'extensions-deny', model: EXTENSION_ID, version: '1.1.0' })
    assert.equal(denied.isError, false, JSON.stringify(denied))
    const commitDenied = await callTool(ctx, 'model_tools', { action: 'extensions-commit', model: EXTENSION_ID, version: '1.1.0' })
    assert.equal(commitDenied.isError, true)
    assert.match(JSON.stringify(commitDenied), /has no APPROVED record/)

    // The write-once decision stands; the audit record names the denial.
    const afterDeny = await callTool(ctx, 'model_tools', { action: 'extensions-pending' })
    const deniedEntry = (afterDeny.value as { pending: Array<{ approval?: { approved: boolean } }> }).pending[0]!
    assert.equal(deniedEntry.approval?.approved, false)

    // A denied record is write-once; a new version must be staged for a new decision.
    // Stage v2 afresh under a NEW version so the approve path can run.
    const v3 = fixturePackage({ version: '1.2.0', secrets: ['db-secret'] })
    const v3Bytes = v3.zip()
    await stageUpdate({
      storeDir,
      source: { kind: 'local', requested: v3.dir },
      archive: createZipArchiveSource(() => v3Bytes),
      expectedSha512: createHash('sha512').update(v3Bytes).digest('hex'),
    })
    const approved = await callTool(ctx, 'model_tools', { action: 'extensions-approve', model: EXTENSION_ID, version: '1.2.0' })
    assert.equal(approved.isError, false, JSON.stringify(approved))
    const committed = await callTool(ctx, 'model_tools', { action: 'extensions-commit', model: EXTENSION_ID, version: '1.2.0' })
    assert.equal(committed.isError, false, JSON.stringify(committed))
    const committedValue = (committed.value as { updateResult: { activeVersion: string; previousVersion?: string } }).updateResult
    assert.equal(committedValue.activeVersion, '1.2.0')
    assert.equal(committedValue.previousVersion, '1.0.0')

    const rolled = await callTool(ctx, 'model_tools', { action: 'extensions-rollback', model: EXTENSION_ID })
    assert.equal(rolled.isError, false, JSON.stringify(rolled))
    const rolledValue = (rolled.value as { updateResult: { activeVersion: string; previousVersion?: string } }).updateResult
    assert.equal(rolledValue.activeVersion, '1.0.0')
    assert.equal(rolledValue.previousVersion, '1.2.0')

    // The management actions are the ONLY door: the MCP export never carries them.
    const exported = await callTool(ctx, 'model_tools', { action: 'mcp' })
    assert.equal(exported.isError, false)
    assert.equal(
      JSON.stringify(exported).includes('extensions-commit'),
      false,
      'the update actions must not appear anywhere but the management channel',
    )
  } finally {
    await cleanup()
  }
  rmSync(storeDir, { recursive: true, force: true })
})

test('the pending listing shows the staged update, its deltas and the approval state', async () => {
  const { storeDir } = await preparedStore()
  const { hooks, calls } = fakeHooks()
  const surface = createUpdateHostSurface({ storeDir, profile: 'default', hooks })
  const pending = surface.listPendingUpdates()
  assert.equal(pending.length, 1)
  const entry = pending[0]!
  assert.equal(entry.extensionId, EXTENSION_ID)
  assert.equal(entry.stagedVersion, '1.1.0')
  assert.equal(entry.currentVersion, '1.0.0')
  assert.deepEqual(entry.report.permissionDeltas, ['new declared secret "db-secret"'], 'the secrets expansion is the AT-35 delta')
  assert.equal(entry.report.requiresApproval, true)
  assert.equal(entry.approval, undefined, 'no approval before the operator decides')
  assert.deepEqual(calls, [], 'listing never drives the lifecycle hooks')
  rmSync(storeDir, { recursive: true, force: true })
})

test('a DENIED approval never commits: the SDK refuses and the hooks never run', async () => {
  const { storeDir } = await preparedStore()
  const { hooks, calls } = fakeHooks()
  const surface = createUpdateHostSurface({ storeDir, profile: 'default', hooks })
  surface.decide(EXTENSION_ID, '1.1.0', { approved: false, reason: 'review refused the new secret' })
  await assert.rejects(surface.commit(EXTENSION_ID, '1.1.0'), /has no APPROVED record/)
  assert.deepEqual(calls, [], 'a denied commit must never quiesce or rebind')
  const pointers = new ExtensionStore(storeDir).readProfilePointers('default')
  assert.equal(pointers.value.activeVersions[EXTENSION_ID], '1.0.0', 'the pointer is unchanged')
  rmSync(storeDir, { recursive: true, force: true })
})

test('an APPROVED commit runs quiesce → pointer → rebind in order, and rollback restores', async () => {
  const { storeDir } = await preparedStore()
  const { hooks, calls } = fakeHooks()
  const surface = createUpdateHostSurface({ storeDir, profile: 'default', hooks })
  surface.decide(EXTENSION_ID, '1.1.0', { approved: true })

  const committed = await surface.commit(EXTENSION_ID, '1.1.0')
  assert.equal(committed.activeVersion, '1.1.0')
  assert.equal(committed.previousVersion, '1.0.0')
  assert.deepEqual(calls, [
    'quiesce @try-works/fixture-update-worker',
    'rebind @try-works/fixture-update-worker@1.1.0',
  ], 'the two-phase order is quiesce BEFORE the pointer move, rebind after')

  calls.length = 0
  const rolled = await surface.rollback(EXTENSION_ID)
  assert.equal(rolled.activeVersion, '1.0.0')
  assert.equal(rolled.previousVersion, '1.1.0')
  assert.equal(rolled.hookFailure, undefined)
  assert.deepEqual(calls, ['rebind @try-works/fixture-update-worker@1.0.0'], 'rollback republishes the restored version')
  rmSync(storeDir, { recursive: true, force: true })
})

test('a rebind failure reverts INSIDE the wrapper and the commit rejects (all-or-nothing)', async () => {
  const { storeDir } = await preparedStore()
  const { hooks, calls } = fakeHooks({ rejectVersions: ['1.1.0'] })
  const surface = createUpdateHostSurface({ storeDir, profile: 'default', hooks })
  surface.decide(EXTENSION_ID, '1.1.0', { approved: true })

  await assert.rejects(surface.commit(EXTENSION_ID, '1.1.0'), /the rebind hook refused/)
  // The wrapper restored the previous surface BEFORE rethrowing; the SDK's
  // auto-rollback then moved the pointer back to 1.0.0 — which the wrapper's
  // restore had already republished. Exactly TWO rebind calls: the failed one
  // and the restore (the SDK never re-runs hooks).
  assert.deepEqual(calls, [
    'quiesce @try-works/fixture-update-worker',
    'rebind @try-works/fixture-update-worker@1.1.0',
    'rebind @try-works/fixture-update-worker@1.0.0',
  ])
  const pointers = new ExtensionStore(storeDir).readProfilePointers('default')
  assert.equal(pointers.value.activeVersions[EXTENSION_ID], '1.0.0', 'the pointer rolled back')
  rmSync(storeDir, { recursive: true, force: true })
})

test('a quiesce failure aborts the commit with the pointer unchanged and the surface restored', async () => {
  const { storeDir } = await preparedStore()
  const { hooks, calls } = fakeHooks({ quiesce: 'throw' })
  const surface = createUpdateHostSurface({ storeDir, profile: 'default', hooks })
  surface.decide(EXTENSION_ID, '1.1.0', { approved: true })

  await assert.rejects(surface.commit(EXTENSION_ID, '1.1.0'), /the quiesce hook failed/)
  // The quiesce threw BEFORE the pointer write, so the pointer is unchanged;
  // the host wrapper re-bound the current pointer's surface (1.0.0) so the
  // aborted commit leaves the old catalog published.
  assert.deepEqual(calls, [
    'quiesce @try-works/fixture-update-worker',
    'rebind @try-works/fixture-update-worker@1.0.0',
  ])
  const pointers = new ExtensionStore(storeDir).readProfilePointers('default')
  assert.equal(pointers.value.activeVersions[EXTENSION_ID], '1.0.0')
  rmSync(storeDir, { recursive: true, force: true })
})

test('a HANGING rebindRestored is bounded host-side and reported as the hookFailure', async () => {
  const { storeDir } = await preparedStore()
  const { hooks } = fakeHooks()
  const surface = createUpdateHostSurface({ storeDir, profile: 'default', hooks })
  surface.decide(EXTENSION_ID, '1.1.0', { approved: true })
  await surface.commit(EXTENSION_ID, '1.1.0')

  // Now make the RESTORED rebind hang: the rollback's hook is bound host-side
  // and its failure is reported through the SDK's hookFailure — the restore
  // itself stays durable (no double rollback).
  const hanging = fakeHooks({ rebind: 'hang' })
  const hangingSurface = createUpdateHostSurface({ storeDir, profile: 'default', hooks: hanging.hooks, rebindTimeoutMs: 300 })
  const rolled = await hangingSurface.rollback(EXTENSION_ID)
  assert.equal(rolled.activeVersion, '1.0.0', 'the pointer restore is durable')
  assert.match(rolled.hookFailure ?? '', /timed out after 300 ms \(host-side bound\)/)
  rmSync(storeDir, { recursive: true, force: true })
})
