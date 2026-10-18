/**
 * The operator-gated executable-preparation approval (RES-02), task-90.
 *
 * RES-02 says a prebuilt engine download counts as executable installation, so it
 * needs a SEPARATE approval from approving a model download. The Remote prepare
 * path has no per-call argument, so the approval is the operator's standing config
 * value: with it off the registry returns its exact refusal and acquires nothing;
 * with it on the same digest-pinned plan is approved and prepared.
 *
 * The fixture's "engine" is 23 deterministic bytes, and the acquisition source is
 * injected, so this proves the gate without a network or a real binary.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stagedInstallFromDirectory } from '@try-works/tool-mode-extension-sdk'

import type { AcquisitionSource } from '../src/asset-acquisition.ts'
import { Config } from '../src/index.ts'
import { cleanup, mountPlugin, tempDir } from './helpers.ts'

after(async () => { await cleanup() })

const FIXTURE_DIR = join(process.cwd(), 'packages', 'dsh-model-as-tool', 'tests', 'fixtures', 'executable-extension')
const EXTENSION_ID = '@try-works/fixture-executable'
const MODEL_ID = 'fixture-executable-model'
const ENGINE_BYTES = Buffer.from('fixture-exec-engine-v1\n')

/** The registry's RES-02 refusal, byte-for-byte. The gate must not paraphrase it. */
const RES02_REFUSAL =
  'the plan includes an EXECUTABLE asset, which requires the separate executable-preparation approval (RES-02); this call did not grant it'

/** A source that counts reads and serves the fixture bytes. */
function countingSource(readCount: { value: number }): AcquisitionSource {
  return {
    supportsRanges: false,
    async fetchRange(_asset, from, to) {
      readCount.value += 1
      return ENGINE_BYTES.slice(from, to + 1)
    },
  }
}

/** The service surface the tests call. */
interface ModelToolsService {
  prepare(id: string): Promise<{
    prepared: boolean
    reason: string | null
    plan: { requiresExecutableApproval: boolean; assets: readonly { executable: boolean }[] } | null
    readiness: Readonly<Record<string, string>>
    groups: readonly string[]
    activationReady: boolean
  }>
  enable(id: string): Promise<{ active: boolean }>
}

/** Install the fixture and mount the plugin with an injected source; returns the service. */
async function mountWithGate(options: { readonly allowExecutablePreparation?: boolean }): Promise<{
  service: ModelToolsService
  cacheRoot: string
  reads: { value: number }
}> {
  const storeDir = tempDir()
  await stagedInstallFromDirectory({ sourceDir: FIXTURE_DIR, storeDir, allowSourceDirectories: true })
  const stateFile = join(tempDir(), 'state.json')
  const reads = { value: 0 }
  const ctx = await mountPlugin({
    extensionStore: storeDir,
    stateFile,
    assetSourceFactory: () => countingSource(reads),
    ...options.allowExecutablePreparation === undefined
      ? {}
      : { allowExecutablePreparation: options.allowExecutablePreparation },
  })
  const service = ctx.get('modelTools') as ModelToolsService | undefined
  assert.ok(service !== undefined, 'apply must provide the modelTools service')
  return { service, cacheRoot: join(dirname(stateFile), 'asset-cache'), reads }
}

describe('the executable-preparation approval defaults to OFF', () => {
  it('defaults the config value to false and preserves an explicit true', async () => {
    const validate = Config['~standard'].validate
    const omitted = await validate({ stateFile: 'state.json' })
    assert.equal(omitted.value.allowExecutablePreparation, false)
    const explicit = await validate({ stateFile: 'state.json', allowExecutablePreparation: true })
    assert.equal(explicit.value.allowExecutablePreparation, true)
  })

  it('returns the exact RES-02 refusal and acquires NOTHING when the gate is off', async () => {
    const { service, cacheRoot, reads } = await mountWithGate({})
    const prepared = await service.prepare(EXTENSION_ID)
    assert.equal(prepared.prepared, false)
    assert.equal(prepared.reason, RES02_REFUSAL)
    assert.equal(prepared.plan?.requiresExecutableApproval, true)
    assert.deepEqual(prepared.plan?.assets.map(asset => asset.executable), [true])
    assert.deepEqual({ ...prepared.readiness }, { [MODEL_ID]: 'needs-preparation' })
    assert.deepEqual([...prepared.groups], [])
    assert.equal(prepared.activationReady, false)
    assert.equal(reads.value, 0, 'the refusal must happen BEFORE any fetch')
    assert.equal(existsSync(join(cacheRoot, 'groups')), false, 'nothing may be materialized without the approval')
  })
})

describe('the operator gate approves executable assets as a standing approval', () => {
  it('prepares the executable plan, materializes the verified file and records readiness', async () => {
    const { service, cacheRoot, reads } = await mountWithGate({ allowExecutablePreparation: true })
    const prepared = await service.prepare(EXTENSION_ID)
    assert.equal(prepared.prepared, true)
    assert.equal(prepared.reason, null)
    assert.equal(prepared.plan?.requiresExecutableApproval, true)
    assert.deepEqual([...prepared.groups], ['native-engine'])
    assert.deepEqual({ ...prepared.readiness }, { [MODEL_ID]: 'prepared-cold' })
    assert.equal(prepared.activationReady, true)
    assert.ok(reads.value >= 1, 'the approved bytes were fetched once')
    const materialized = join(cacheRoot, 'groups', EXTENSION_ID.replaceAll('/', '__'), MODEL_ID, 'native-engine', 'engine.bin')
    assert.equal(existsSync(materialized), true)
    assert.deepEqual(new Uint8Array(readFileSync(materialized)), new Uint8Array(ENGINE_BYTES))
    // The approval unlocks the normal flow: the deployment can now be activated.
    const enabled = await service.enable(EXTENSION_ID)
    assert.equal(enabled.active, true)
  })
})
