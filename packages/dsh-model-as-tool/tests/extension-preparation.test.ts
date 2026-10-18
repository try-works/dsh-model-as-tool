/**
 * Preparation, readiness recording and precisely-named activation blockers (task-85).
 *
 * The live defect these tests pin: a freshly installed EmbeddingGemma-class
 * extension cannot be enabled because its model assets were never prepared, and
 * the row said only "activation failed". The tests run the REAL plugin mount (real
 * lifecycle + the real prepared-assets surface), with an INJECTED local acquisition
 * source, so the whole plan → acquire → verify → record-readiness → enable chain is
 * exercised without a network.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  digestInstalledContent,
  ExtensionLifecycle,
  ExtensionStore,
  stagedInstallFromDirectory,
  type ContributionRegistrar,
} from '@try-works/tool-mode-extension-sdk'

import type { AcquisitionSource } from '../src/asset-acquisition.ts'
import { planPreparation } from '../src/deployment-coordinator.ts'
import {
  createExtensionsService,
  ExtensionsServiceError,
} from '../src/extensions-service.ts'
import { identityFor, lockGroups, parseAssetLock, plannedAssets } from '../src/prepared-assets.ts'
import { cleanup, mountPlugin, tempDir } from './helpers.ts'

after(async () => { await cleanup() })

const FIXTURE_DIR = join(process.cwd(), 'packages', 'dsh-model-as-tool', 'tests', 'fixtures', 'preparable-extension')
const EXTENSION_ID = '@try-works/fixture-preparable'
const MODEL_ID = 'fixture-preparable-model'
const ASSET_BYTES = Buffer.from('fixture-preparable-asset-v1\n')
const ASSET_DIGEST = createHash('sha256').update(ASSET_BYTES).digest('hex')

/** The exact row reason a model whose assets were never prepared must produce. */
const PREPARATION_BLOCKER =
  `activation blocked: ${MODEL_ID} needs its model assets prepared — run prepare for this extension`

/** The exact row reason after a failed activation whose only blocker was preparation. */
const RETRY_ENABLE_REASON =
  'activation failed earlier in this host; the store records no remaining preparation blocker, so retry enable to see whether it succeeds'

/** A local-file acquisition source serving exactly the bytes it was given. */
function localSource(bytes: Uint8Array): AcquisitionSource {
  return {
    supportsRanges: false,
    async fetchRange(_asset, from, to) {
      return bytes.slice(from, to + 1)
    },
  }
}

/** The service surface the tests call (the page calls the same members over the wire). */
interface ModelToolsService {
  describe(): Promise<{ extensions: { id: string; active: boolean; reason: string | null }[] }>
  enable(id: string): Promise<{ id: string; active: boolean; disabled: boolean }>
  prepare(id: string): Promise<{
    id: string
    prepared: boolean
    reason: string | null
    plan: {
      modelId: string
      modelRevision: string
      assets: readonly { assetId: string; bytes: number; source: string; executable: boolean }[]
      totalBytes: number
      storageBytes: number
      requiresExecutableApproval: boolean
      license: { name: string; url: string }
    } | null
    readiness: Readonly<Record<string, string>>
    groups: readonly string[]
    activationReady: boolean
  }>
}

/** Install the fixture package into a fresh store. */
async function installedStore(): Promise<string> {
  const storeDir = tempDir()
  await stagedInstallFromDirectory({ sourceDir: FIXTURE_DIR, storeDir, allowSourceDirectories: true })
  return storeDir
}

/** Mount the plugin over an installed fixture with an injected source; returns the service + paths. */
async function mountPreparedHost(source: AcquisitionSource): Promise<{ service: ModelToolsService; storeDir: string; cacheRoot: string; ctx: Awaited<ReturnType<typeof mountPlugin>> }> {
  const storeDir = await installedStore()
  const stateFile = join(tempDir(), 'state.json')
  const ctx = await mountPlugin({
    extensionStore: storeDir,
    stateFile,
    assetSourceFactory: () => source,
  })
  const service = ctx.get('modelTools') as ModelToolsService | undefined
  assert.ok(service !== undefined, 'apply must provide the modelTools service')
  return { service, storeDir, cacheRoot: join(dirname(stateFile), 'asset-cache'), ctx }
}

/** Assert a named service refusal. */
async function rejectsService(promise: Promise<unknown>, code: string): Promise<ExtensionsServiceError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof ExtensionsServiceError, `expected ExtensionsServiceError, got ${String(error)}`)
    assert.equal(error.code, code)
    return error
  }
  assert.fail(`expected a refusal with code ${code}`)
}

describe('an unprepared model deployment produces a precise, actionable blocker', () => {
  it('describe names the model and the prepare action instead of a generic failure', async () => {
    const { service } = await mountPreparedHost(localSource(ASSET_BYTES))
    const row = (await service.describe()).extensions.find(candidate => candidate.id === EXTENSION_ID)
    assert.ok(row !== undefined)
    assert.equal(row.active, false)
    assert.equal(row.reason, PREPARATION_BLOCKER)
  })

  it('enable refuses with the same named diagnostic instead of a bare activation failure', async () => {
    const { service } = await mountPreparedHost(localSource(ASSET_BYTES))
    const error = await rejectsService(service.enable(EXTENSION_ID), 'extension-preparation-required')
    assert.equal(error.message, PREPARATION_BLOCKER)
  })

  it('prepare records the readiness and the cache holds the verified bytes, without publishing', async () => {
    const { service, storeDir, cacheRoot, ctx } = await mountPreparedHost(localSource(ASSET_BYTES))
    // The probe activation that records the lifecycle state must publish nothing.
    assert.equal(ctx.tools.schemas().some(schema => schema.name === 'fixture_preparable_tool'), false)
    const prepared = await service.prepare(EXTENSION_ID)
    assert.equal(prepared.prepared, true)
    assert.equal(prepared.reason, null)
    assert.equal(prepared.plan?.modelId, MODEL_ID)
    assert.equal(prepared.plan?.modelRevision, 'fixture-preparable-revision-1')
    assert.equal(prepared.plan?.totalBytes, ASSET_BYTES.byteLength)
    assert.equal(prepared.plan?.storageBytes, ASSET_BYTES.byteLength)
    assert.equal(prepared.plan?.requiresExecutableApproval, false)
    assert.deepEqual(prepared.plan?.assets, [{
      assetId: 'text-backbone/fixture-tiny-asset',
      bytes: ASSET_BYTES.byteLength,
      source: 'fixture:tiny-asset',
      executable: false,
    }])
    assert.deepEqual({ ...prepared.readiness }, { [MODEL_ID]: 'prepared-cold' })
    assert.deepEqual([...prepared.groups], ['text-backbone'])
    assert.equal(prepared.activationReady, true)

    // The readiness landed durably, and the verified bytes landed in the isolated cache.
    const state = new ExtensionStore(storeDir).readProfileState('default').value.find(candidate => candidate.extensionId === EXTENSION_ID)
    assert.equal(state?.readiness[MODEL_ID], 'prepared-cold')
    const materialized = join(cacheRoot, 'groups', EXTENSION_ID.replaceAll('/', '__'), MODEL_ID, 'text-backbone', 'onnx', 'model.onnx')
    assert.equal(existsSync(materialized), true)
    assert.deepEqual(new Uint8Array(readFileSync(materialized)), new Uint8Array(ASSET_BYTES))

    // describe no longer blames preparation; the recorded failed state is named for what it is.
    const row = (await service.describe()).extensions.find(candidate => candidate.id === EXTENSION_ID)
    assert.equal(row?.reason, RETRY_ENABLE_REASON)

    // …and the extension can now be enabled and activated.
    const enabled = await service.enable(EXTENSION_ID)
    assert.deepEqual(enabled, { id: EXTENSION_ID, active: true, disabled: false })
    assert.equal(ctx.tools.schemas().some(schema => schema.name === 'fixture_preparable_tool'), true)
    const activeRow = (await service.describe()).extensions.find(candidate => candidate.id === EXTENSION_ID)
    assert.equal(activeRow?.active, true)
    assert.equal(activeRow?.reason, null)
  })

  it('prepares a freshly installed extension even before any enable attempt', async () => {
    const { service } = await mountPreparedHost(localSource(ASSET_BYTES))
    // A new install has no profile state; prepare must still record readiness.
    const prepared = await service.prepare(EXTENSION_ID)
    assert.equal(prepared.prepared, true)
    assert.equal(prepared.activationReady, true)
  })
})

describe('a tampered acquisition refuses and never flips readiness', () => {
  it('returns the digest refusal and keeps the extension unprepared', async () => {
    const tampered = Buffer.from(ASSET_BYTES)
    tampered[tampered.length - 1] = 'X'.charCodeAt(0)
    const { service, storeDir, cacheRoot } = await mountPreparedHost(localSource(tampered))
    const prepared = await service.prepare(EXTENSION_ID)
    assert.equal(prepared.prepared, false)
    assert.equal(prepared.activationReady, false)
    assert.match(prepared.reason ?? '', /text-backbone\/fixture-tiny-asset: the asset digest is [0-9a-f]{64}, not the pinned [0-9a-f]{64}/)
    assert.equal(prepared.plan?.modelId, MODEL_ID)
    assert.deepEqual([...prepared.groups], [])
    assert.deepEqual({ ...prepared.readiness }, { [MODEL_ID]: 'needs-preparation' })
    // No verified content-addressed blob and no materialized group path.
    assert.equal(existsSync(join(cacheRoot, ASSET_DIGEST)), false)
    assert.equal(existsSync(join(cacheRoot, 'groups')), false)
    // Readiness is unchanged, so the row still names the preparation blocker…
    const row = (await service.describe()).extensions.find(candidate => candidate.id === EXTENSION_ID)
    assert.equal(row?.reason, PREPARATION_BLOCKER)
    // …and the state file still records needs-preparation.
    const state = new ExtensionStore(storeDir).readProfileState('default').value.find(candidate => candidate.extensionId === EXTENSION_ID)
    assert.equal(state?.readiness[MODEL_ID], 'needs-preparation')
    // Enable still refuses with the actionable reason.
    await rejectsService(service.enable(EXTENSION_ID), 'extension-preparation-required')
  })
})

describe('prepare preconditions are named', () => {
  it('refuses when the host mounted no prepared-assets surface', async () => {
    const storeDir = await installedStore()
    const error = await rejectsService(createExtensionsService({ storeDir }).prepare(EXTENSION_ID), 'extension-preparation-unavailable')
    assert.match(error.message, /prepared-assets surface is not mounted/)
  })

  it('refuses an id that is not installed', async () => {
    await rejectsService(createExtensionsService({ storeDir: tempDir() }).prepare(EXTENSION_ID), 'extension-not-installed')
  })
})

describe('the real extension-embeddinggemma lock resolves to the disclosed plan (no acquisition)', () => {
  it('plans 11 pinned assets with the measured audio digest', () => {
    const packageDir = join(process.cwd(), 'packages', 'extension-embeddinggemma')
    const manifest = JSON.parse(readFileSync(join(packageDir, 'tool-mode.extension.json'), 'utf8')) as {
      id: string
      models: { id: string; assetSet: string; assetLock: string }[]
    }
    const model = manifest.models[0]
    assert.ok(model !== undefined)
    const lock = parseAssetLock(readFileSync(join(packageDir, model.assetLock.replace(/^\.\//, '')), 'utf8'))
    assert.equal(lock.revision, 'daa72c51243991dfcaf9f9137d2c573d8f7790c0')
    const groups = lockGroups(lock, model.assetSet)
    assert.deepEqual(groups.map(group => group.id), ['text-backbone', 'vision-encoder', 'audio-encoder'])
    const assets = plannedAssets(lock, model.assetSet)
    assert.equal(assets.length, 11)
    const plan = planPreparation(identityFor(manifest.id, model.id, lock), assets, lock.license)
    assert.equal(plan.identity.modelId, 'embeddinggemma-2')
    assert.equal(plan.totalBytes, 2_960_874_003)
    assert.equal(plan.storageBytes, 2_960_874_003)
    assert.equal(plan.requiresExecutableApproval, false)
    assert.equal(plan.license.name, 'Apache License 2.0')
    const audio = assets.find(asset => asset.assetId === 'audio-encoder/eg2-audio-model-data')
    assert.ok(audio !== undefined)
    assert.equal(audio.bytes, 1_172_750_848)
    assert.equal(audio.digest, '6943b910d1d1e9b5dffd4ccad63f61aa308ad10b70ed128bb61886b119da1e3a')
  })

  it('names the real EmbeddingGemma deployment in the live blocker string', async () => {
    const storeDir = tempDir()
    const packageDir = join(process.cwd(), 'packages', 'extension-embeddinggemma')
    const installPath = join(storeDir, 'extensions', '@try-works', 'extension-embeddinggemma', '0.1.0')
    for (const entry of ['package.json', 'tool-mode.extension.json', 'models.lock.json']) {
      cpSync(join(packageDir, entry), join(installPath, entry))
    }
    cpSync(join(packageDir, 'lib'), join(installPath, 'lib'), { recursive: true })
    cpSync(join(packageDir, 'schema'), join(installPath, 'schema'), { recursive: true })
    // task-113: the real package declares @huggingface/transformers and
    // onnxruntime-node as OPTIONAL tool runtimes. This test is about the ASSETS
    // blocker, so the runtimes are materialized as minimal stubs (the requirement
    // probes presence + a satisfying version, not the native engine itself).
    const runtimeStubs: readonly [string, string][] = [['@huggingface/transformers', '3.0.0'], ['onnxruntime-node', '1.20.0']]
    for (const [name, version] of runtimeStubs) {
      const runtimeDir = join(installPath, 'node_modules', ...name.split('/'))
      mkdirSync(runtimeDir, { recursive: true })
      writeFileSync(join(runtimeDir, 'package.json'), `${JSON.stringify({ name, version })}\n`)
    }
    const contentDigest = digestInstalledContent(installPath)
    const store = new ExtensionStore(storeDir)
    store.recordInstall({
      extensionId: '@try-works/extension-embeddinggemma',
      version: '0.1.0',
      installPath,
      archiveDigest: contentDigest,
      contentDigest,
      source: { kind: 'local', requested: packageDir },
      installedAt: new Date().toISOString(),
    })
    // The store state the live host recorded after the failed Enable, verbatim.
    store.writeProfileState('default', [{
      extensionId: '@try-works/extension-embeddinggemma',
      installation: 'installed',
      desiredActivation: 'active',
      observedActivation: 'failed',
      readiness: { 'embeddinggemma-2': 'needs-preparation' },
      tools: [],
      export: 'not-exported',
    }])
    const registrar: ContributionRegistrar = {
      publish: () => 'handle',
      withdraw: () => {},
    }
    const lifecycle = new ExtensionLifecycle({ store, profile: 'default', registrar })
    const service = createExtensionsService({ storeDir, lifecycle: () => lifecycle })
    const expected = 'activation blocked: embeddinggemma-2 needs its model assets prepared — run prepare for this extension'
    const row = (await service.describe()).extensions.find(candidate => candidate.id === '@try-works/extension-embeddinggemma')
    assert.equal(row?.reason, expected)
    const error = await rejectsService(service.enable('@try-works/extension-embeddinggemma'), 'extension-preparation-required')
    assert.equal(error.message, expected)
  })
})
