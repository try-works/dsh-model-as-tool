import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { after, test } from 'node:test'
import AdmZip from 'adm-zip'

import { createZipArchiveSource, ExtensionStore, stagedInstall } from '@try-works/tool-mode-extension-sdk'
import { acquireAsset } from '../src/asset-acquisition.ts'
import type { AcquisitionSource } from '../src/asset-acquisition.ts'
import type { PlannedAsset } from '../src/deployment-coordinator.ts'
import { createPreparedAssetRegistry, identityFor, lockGroups, parseAssetLock, plannedAssets } from '../src/prepared-assets.ts'
import { createDispatch, type DispatchEnvironment, type DispatchManifest } from '../src/extension-dispatch.ts'
import { callTool, cleanup, mountPlugin } from './helpers.ts'

/** The fixture asset bytes, keyed by the LOCK ASSET id. */
const ASSET_BYTES: Record<string, Buffer> = {
  'fixture-model': Buffer.from('fixture-model-weights-0001'),
  'fixture-tokenizer': Buffer.from('{"fixture":"tokenizer"}'),
  'fixture-audio': Buffer.from('fixture-audio-weights-0002'),
}

/** A local-file acquisition source: serves the fixture bytes, counts reads. */
function localSource(readCount: { value: number }): AcquisitionSource {
  return {
    supportsRanges: true,
    async fetchRange(asset: PlannedAsset, from: number, to: number): Promise<Uint8Array> {
      readCount.value += 1
      const name = asset.assetId.split('/').pop() ?? asset.assetId
      const bytes = ASSET_BYTES[name]
      if (bytes === undefined) throw new Error(`no local fixture for ${asset.assetId}`)
      return new Uint8Array(bytes.subarray(from, to + 1))
    },
  }
}

/** A small fixture lock whose digests match the fixture bytes. */
function fixtureLock(overrides: { bogusDigest?: string; executable?: boolean } = {}): string {
  const digestOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  return JSON.stringify({
    protocolVersion: '1.1.0',
    assetSets: {
      'fixture-set': {
        pinning: { state: 'measured', revision: 'fixture-revision-1', recordedAt: '2026-10-17' },
        license: { name: 'Fixture License', url: 'https://example.invalid/license' },
        groups: [
          {
            id: 'text-backbone',
            enables: ['text'],
            assets: [
              { id: 'fixture-model', file: 'onnx/model.onnx', bytes: ASSET_BYTES['fixture-model']!.byteLength, source: 'file://fixture/model.onnx', digest: digestOf(ASSET_BYTES['fixture-model']!) },
              { id: 'fixture-tokenizer', file: 'fixture-tokenizer', bytes: ASSET_BYTES['fixture-tokenizer']!.byteLength, source: 'file://fixture/tokenizer.json', digest: digestOf(ASSET_BYTES['fixture-tokenizer']!) },
            ],
          },
          {
            id: 'audio-encoder',
            enables: ['audio'],
            assets: [
              {
                id: 'fixture-audio',
                file: 'onnx/audio.onnx',
                bytes: ASSET_BYTES['fixture-audio']!.byteLength,
                source: 'file://fixture/audio.onnx',
                digest: overrides.bogusDigest ?? digestOf(ASSET_BYTES['fixture-audio']!),
                executable: overrides.executable ?? false,
              },
            ],
          },
        ],
      },
    },
  })
}

/** A fixture extension package: manifest (model + assetLock) + a provider. */
function fixtureExtension(): { dir: string; zip(): Uint8Array } {
  const dir = mkdtempSync(join(tmpdir(), 'prepared-fixture-'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@try-works/fixture-prepared-assets',
    version: '1.0.0',
    private: true,
    type: 'module',
    exports: { './tool-mode': './lib/index.mjs' },
    toolMode: { manifest: './tool-mode.extension.json' },
  }))
  writeFileSync(join(dir, 'models.lock.json'), fixtureLock())
  writeFileSync(join(dir, 'tool-mode.extension.json'), JSON.stringify({
    protocolVersion: '1.1.0',
    id: '@try-works/fixture-prepared-assets',
    version: '1.0.0',
    displayName: 'Prepared-assets fixture',
    description: 'A deterministic fixture for the prepared-assets acquisition path.',
    activation: { policy: 'operator', deactivatable: true },
    runtimeApi: 1,
    compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
    execution: { kind: 'module', entry: './lib/index.mjs' },
    permissions: { networkOrigins: [], inputFiles: false, storage: 'extension-private', secrets: [], nativeCode: false },
    models: [{ id: 'fixture-model', assetSet: 'fixture-set', assetLock: './models.lock.json', platforms: [{ os: 'win32', arch: 'x64', accelerator: 'cpu' }] }],
    tools: [],
    implementations: [],
    skills: [],
  }))
  writeFileSync(join(dir, 'lib', 'index.mjs'), `
let lastLoadAssets = null
export default {
  apiVersion: 1,
  async create() {
    return {
      async createProvider() {
        return {
          async inspect() {
            return { readiness: lastLoadAssets === null ? 'needs-preparation' : 'prepared-cold', features: ['fixture'], missing: [] }
          },
          async load({ assets }) {
            // Record what the host handed over; a REAL provider would read the
            // group directories for its model files.
            const ids = assets.assetIds ?? []
            const resolved = Object.fromEntries(ids.map(id => [id, assets.get(id)?.path ?? null]))
            lastLoadAssets = { ids, resolved }
          },
          async invoke(request) {
            return { echo: request.input.text ?? 'x', assets: lastLoadAssets }
          },
          async dispose() {},
        }
      },
      async dispose() {},
    }
  },
}
`)
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

async function installedFixture(): Promise<{ storeDir: string }> {
  const storeDir = mkdtempSync(join(tmpdir(), 'prepared-store-'))
  const fixture = fixtureExtension()
  const bytes = fixture.zip()
  await stagedInstall({
    source: { kind: 'local', requested: fixture.dir },
    storeDir,
    expectedSha512: createHash('sha512').update(bytes).digest('hex'),
    archive: createZipArchiveSource(() => bytes),
  })
  const store = new ExtensionStore(storeDir)
  store.writeProfileState('default', [{
    extensionId: '@try-works/fixture-prepared-assets',
    version: '1.0.0',
    desiredActivation: 'active',
    observedActivation: 'active',
    readiness: {},
    tools: [],
    ownerPid: 2147483647,
  }], undefined, { '@try-works/fixture-prepared-assets': '1.0.0' }, {})
  return { storeDir }
}

const cacheRoot = mkdtempSync(join(tmpdir(), 'prepared-cache-'))
after(() => rmSync(cacheRoot, { recursive: true, force: true }))

test('the SHIPPED embeddinggemma lock parses to a plan with the correct digests (no acquisition)', () => {
  const lockText = readFileSync(join(process.cwd(), 'packages', 'extension-embeddinggemma', 'models.lock.json'), 'utf8')
  const lock = parseAssetLock(lockText)
  assert.equal(lock.revision, 'daa72c51243991dfcaf9f9137d2c573d8f7790c0')
  const assets = plannedAssets(lock, 'embeddinggemma-2-onnx')
  const audioData = assets.find(asset => asset.assetId.includes('audio-model-data'))
  assert.ok(audioData !== undefined, 'the audio weights are planned')
  assert.equal(audioData.bytes, 1_172_750_848)
  assert.equal(audioData.digest, '6943b910d1d1e9b5dffd4ccad63f61aa308ad10b70ed128bb61886b119da1e3a')
  assert.equal(audioData.executable, false, 'none of the embeddinggemma assets are executable (RES-02 assert)')
  assert.ok(assets.every(asset => asset.executable === false))
  const plan = { identity: identityFor('@try-works/extension-embeddinggemma', 'embeddinggemma-2', lock), assets }
  assert.equal(plan.assets.length, 11, 'all eleven pinned files are planned')
  assert.equal(plan.assets.every(asset => asset.digest.length === 64 && asset.bytes > 0), true)
})

test('a lock with no digests refuses (no guessed values)', () => {
  const bad = JSON.stringify({
    assetSets: {
      'x': {
        pinning: { revision: 'rev' },
        license: { name: 'n', url: '' },
        groups: [{ id: 'g', assets: [{ id: 'a', file: 'f', bytes: 3, source: 's' }] }],
      },
    },
  })
  assert.throws(() => parseAssetLock(bad), /a lock without pinned digests and sizes refuses/)
})

test('prepare acquires every asset digest-verified, materializes group layouts, and is idempotent', async () => {
  const reads = { value: 0 }
  const registry = createPreparedAssetRegistry({ cacheRoot: join(cacheRoot, 'a') })
  const lock = parseAssetLock(fixtureLock())
  const identity = identityFor('@try-works/fixture-prepared-assets', 'fixture-model', lock)
  const planAssets = plannedAssets(lock, 'fixture-set')
  const groups = lockGroups(lock, 'fixture-set')
  // The plan object mirrors planPreparation's output shape for this test.
  const plan = {
    identity,
    assets: planAssets,
    totalBytes: planAssets.reduce((sum, asset) => sum + asset.bytes, 0),
    storageBytes: planAssets.reduce((sum, asset) => sum + asset.bytes, 0),
    requiresExecutableApproval: false,
    license: lock.license,
  }
  const first = await registry.prepare('@try-works/fixture-prepared-assets', plan, groups, {
    source: localSource(reads),
    allowExecutable: false,
    signal: new AbortController().signal,
  })
  assert.ok(first.ok)
  const readsAfterFirst = reads.value
  assert.ok(readsAfterFirst >= 3, 'all three assets were fetched')
  const textGroup = first.groups.find(group => group.groupId === 'text-backbone')!
  assert.ok(readFileSync(join(textGroup.path, 'onnx', 'model.onnx')).equals(ASSET_BYTES['fixture-model']!), 'the lock file layout is materialized')
  const map = registry.assetMapFor('@try-works/fixture-prepared-assets')!
  assert.deepEqual(map.assetIds, ['text-backbone', 'audio-encoder'])
  assert.equal(map.get('text-backbone')!.path, textGroup.path)

  // A second prepare is a cache hit: the verified blobs are never re-fetched.
  const second = await registry.prepare('@try-works/fixture-prepared-assets', plan, groups, {
    source: localSource(reads),
    allowExecutable: false,
    signal: new AbortController().signal,
  })
  assert.ok(second.ok)
  assert.equal(reads.value, readsAfterFirst, 'a second prepare must not refetch verified bytes')
})

test('a bogus digest refuses and never lands a poisoned group', async () => {
  const reads = { value: 0 }
  const registry = createPreparedAssetRegistry({ cacheRoot: join(cacheRoot, 'b') })
  const lock = parseAssetLock(fixtureLock({ bogusDigest: '0'.repeat(64) }))
  const plan = {
    identity: identityFor('@try-works/fixture-prepared-assets', 'fixture-model', lock),
    assets: plannedAssets(lock, 'fixture-set'),
    totalBytes: 100,
    storageBytes: 100,
    requiresExecutableApproval: false,
    license: lock.license,
  }
  const outcome = await registry.prepare('@try-works/fixture-prepared-assets', plan, lockGroups(lock, 'fixture-set'), {
    source: localSource(reads),
    allowExecutable: false,
    signal: new AbortController().signal,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /the asset digest is/)
  assert.equal(registry.assetMapFor('@try-works/fixture-prepared-assets'), undefined, 'a failed prepare never registers a map')
})

test('a tampered FINAL group path is re-linked from the verified blob, never trusted', async () => {
  const reads = { value: 0 }
  const registry = createPreparedAssetRegistry({ cacheRoot: join(cacheRoot, 'c') })
  const lock = parseAssetLock(fixtureLock())
  const groups = lockGroups(lock, 'fixture-set')
  const plan = {
    identity: identityFor('@try-works/fixture-prepared-assets', 'fixture-model', lock),
    assets: plannedAssets(lock, 'fixture-set'),
    totalBytes: 100,
    storageBytes: 100,
    requiresExecutableApproval: false,
    license: lock.license,
  }
  const first = await registry.prepare('@try-works/fixture-prepared-assets', plan, groups, {
    source: localSource(reads),
    allowExecutable: false,
    signal: new AbortController().signal,
  })
  assert.ok(first.ok)
  const modelPath = join(first.groups.find(group => group.groupId === 'text-backbone')!.path, 'onnx', 'model.onnx')
  writeFileSync(modelPath, Buffer.from('tampered bytes'))
  const again = await registry.prepare('@try-works/fixture-prepared-assets', plan, groups, {
    source: localSource(reads),
    allowExecutable: false,
    signal: new AbortController().signal,
  })
  assert.ok(again.ok)
  assert.ok(readFileSync(modelPath).equals(ASSET_BYTES['fixture-model']!), 'the tampered final path is restored from the verified blob')
})

test('an EXECUTABLE asset refuses without the explicit approval (RES-02)', async () => {
  const reads = { value: 0 }
  const registry = createPreparedAssetRegistry({ cacheRoot: join(cacheRoot, 'd') })
  const lock = parseAssetLock(fixtureLock({ executable: true }))
  const plan = {
    identity: identityFor('@try-works/fixture-prepared-assets', 'fixture-model', lock),
    assets: plannedAssets(lock, 'fixture-set'),
    totalBytes: 100,
    storageBytes: 100,
    requiresExecutableApproval: true,
    license: lock.license,
  }
  const refused = await registry.prepare('@try-works/fixture-prepared-assets', plan, lockGroups(lock, 'fixture-set'), {
    source: localSource(reads),
    allowExecutable: false,
    signal: new AbortController().signal,
  })
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /EXECUTABLE asset, which requires the separate executable-preparation approval/)
  const granted = await registry.prepare('@try-works/fixture-prepared-assets', plan, lockGroups(lock, 'fixture-set'), {
    source: localSource(reads),
    allowExecutable: true,
    signal: new AbortController().signal,
  })
  assert.ok(granted.ok)
})

test('the dispatch executor carries the prepared map into the provider load (both routes share it)', async () => {
  const loads: unknown[] = []
  const map = {
    assetIds: ['text-backbone'],
    get: (id: string) => (id === 'text-backbone' ? { path: 'E:/cache/groups/text-backbone', digest: 'd1' } : undefined),
  }
  const environment: DispatchEnvironment = {
    getManifest: () => ({
      tools: [{ name: 'fixture_tool', contractId: '@try-works/fixture/echo', contractVersion: '1.0.0' }],
      implementations: [{ id: 'fixture-impl', contractId: '@try-works/fixture/echo', contractVersion: '1.0.0', modelId: 'fixture-model' }],
    } as DispatchManifest),
    async providerFor() {
      return {
        async load(request) {
          loads.push(request.assets)
        },
        async invoke() {
          return { ok: true }
        },
      }
    },
    contextFor: (implementationId, signal) => ({ implementationId, signal }),
    assetsFor: () => map,
  }
  const dispatch = await createDispatch(environment, 'fixture_tool')
  assert.ok(dispatch.ok)
  await dispatch.execute({ text: 'x' }, new AbortController().signal)
  assert.equal(loads.length, 1)
  assert.equal(loads[0], map, 'the verified map reaches the load verbatim')
})

test('the MANAGEMENT channel discloses the plan and prepares with the INJECTED source (no network)', async () => {
  const { storeDir } = await installedFixture()
  const reads = { value: 0 }
  const ctx = await mountPlugin({
    stateFile: join(storeDir, 'state.json'),
    credentialsFile: join(storeDir, 'credentials.json'),
    extensionStore: storeDir,
    assetSourceFactory: () => localSource(reads),
  })
  try {
    const plan = await callTool(ctx, 'model_tools', { action: 'extensions-prepare-plan', model: '@try-works/fixture-prepared-assets' })
    assert.equal(plan.isError, false, JSON.stringify(plan))
    const disclosure = (plan.value as { plan: { assets: Array<{ bytes: number }>; totalBytes: number; requiresExecutableApproval: boolean; license: { name: string } } }).plan
    assert.equal(disclosure.assets.length, 3)
    assert.ok(disclosure.totalBytes > 0)
    assert.equal(disclosure.requiresExecutableApproval, false)
    assert.equal(disclosure.license.name, 'Fixture License')

    const prepared = await callTool(ctx, 'model_tools', { action: 'extensions-prepare', model: '@try-works/fixture-prepared-assets' })
    assert.equal(prepared.isError, false, JSON.stringify(prepared))
    assert.equal((prepared.value as { prepared: boolean }).prepared, true)
    assert.ok(reads.value >= 3, 'the injected source served the acquisition; no network was used')
  } finally {
    await cleanup()
  }
  rmSync(storeDir, { recursive: true, force: true })
})
