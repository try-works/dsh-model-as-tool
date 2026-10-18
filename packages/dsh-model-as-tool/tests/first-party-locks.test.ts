/**
 * The REAL first-party asset locks, audited against the host's preparation planner.
 *
 * This is not a fixture suite: it reads every `packages/extension-NAME/models.lock.json`
 * that ships in this repository and resolves it through the SAME
 * `parseAssetLock` → `plannedAssets` → `planPreparation` path the Settings page's
 * Prepare call uses. It exists because a lock that no test ever planned could — and
 * did — ship without `groups`: extension-needle's lock declared a flat `assets`
 * array, so the live Prepare failed with "asset set needle3-native declares no
 * groups" after the host had already accepted the install.
 *
 * Two honest exceptions are pinned rather than papered over: the Desert Ant tongue
 * and voz sets declare NO host-fetched assets (the weights ship inside the npm
 * package, or the model package downloads them itself), so their plan is
 * truthfully zero-byte and they have no groups to declare.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { planPreparation, type PreparationPlan } from '../src/deployment-coordinator.ts'
import {
  identityFor,
  lockGroups,
  parseAssetLock,
  plannedAssets,
  type LockGroup,
  type ParsedAssetLock,
} from '../src/prepared-assets.ts'

/** One first-party extension's lock, as the planner resolves it. */
interface LockAudit {
  /** The package directory name, e.g. `extension-needle`. */
  readonly packageDir: string
  /** The extension identity from its manifest. */
  readonly extensionId: string
  /** The asset set the manifest's first model references. */
  readonly assetSet: string
  /** The parsed lock. */
  readonly lock: ParsedAssetLock
  /** The groups the planner reads. */
  readonly groups: readonly LockGroup[]
  /** The flattened planned assets. */
  readonly plan: PreparationPlan
  /** The modalities the manifest's model declares, when it declares any. */
  readonly modalities: readonly string[]
  /** The raw `enables` declarations per group id (the planner does not project them). */
  readonly enablesByGroup: ReadonlyMap<string, readonly string[]>
}

/** The first-party extensions whose locks are audited. A new package fails the list test. */
const FIRST_PARTY_EXTENSIONS = [
  'extension-desert-ant-tongue',
  'extension-desert-ant-voz',
  'extension-embeddinggemma',
  'extension-laya',
  'extension-minilm-embed',
  'extension-minilm-rerank',
  'extension-needle',
] as const

/** The sets that honestly declare no host-fetched assets. */
const ZERO_ASSET_SETS = new Set(['extension-desert-ant-tongue', 'extension-desert-ant-voz'])

/**
 * Read and plan every first-party extension lock.
 * @returns one audit per package, in package-name order.
 */
function auditLocks(): readonly LockAudit[] {
  const packagesRoot = join(process.cwd(), 'packages')
  const found = readdirSync(packagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('extension-'))
    .map(entry => entry.name)
    .filter(name => existsSync(join(packagesRoot, name, 'models.lock.json')))
    .sort()
  return found.map(packageDir => {
    const root = join(packagesRoot, packageDir)
    const manifest = JSON.parse(readFileSync(join(root, 'tool-mode.extension.json'), 'utf8')) as {
      id: string
      models?: { id: string; assetSet: string; assetLock: string; modalities?: string[] }[]
    }
    const model = manifest.models?.[0]
    assert.ok(model !== undefined, `${packageDir} declares no model deployment to audit`)
    const raw = JSON.parse(readFileSync(join(root, model.assetLock.replace(/^\.\//, '')), 'utf8')) as {
      assetSets?: Record<string, { groups?: { id?: unknown; enables?: unknown }[] }>
    }
    const enablesByGroup = new Map<string, readonly string[]>()
    for (const group of raw.assetSets?.[model.assetSet]?.groups ?? []) {
      if (typeof group.id !== 'string') continue
      if (!Array.isArray(group.enables) || !group.enables.every((value): value is string => typeof value === 'string')) continue
      enablesByGroup.set(group.id, group.enables)
    }
    const lock = parseAssetLock(readFileSync(join(root, model.assetLock.replace(/^\.\//, '')), 'utf8'))
    const groups = lockGroups(lock, model.assetSet)
    const plan = planPreparation(identityFor(manifest.id, model.id, lock), plannedAssets(lock, model.assetSet), lock.license)
    return {
      packageDir,
      extensionId: manifest.id,
      assetSet: model.assetSet,
      lock,
      groups,
      plan,
      modalities: model.modalities ?? [],
      enablesByGroup,
    }
  })
}

describe('every first-party extension lock resolves to a preparation plan', () => {
  it('covers exactly the first-party extensions that ship a lock', () => {
    assert.deepEqual(auditLocks().map(audit => audit.packageDir), [...FIRST_PARTY_EXTENSIONS])
  })

  it('plans positive bytes for every lock that declares host-fetched assets', () => {
    const audits = auditLocks().filter(audit => !ZERO_ASSET_SETS.has(audit.packageDir))
    assert.ok(audits.length >= 5)
    for (const audit of audits) {
      assert.ok(
        audit.plan.assets.length > 0,
        `${audit.packageDir} must plan at least one asset or be listed as a zero-asset exception`,
      )
      assert.ok(
        audit.plan.totalBytes > 0,
        `${audit.packageDir} plans ${audit.plan.totalBytes} bytes; a set with assets must plan bytes`,
      )
      assert.equal(audit.plan.storageBytes, audit.plan.totalBytes)
    }
  })

  it('resolves the bundled/model-managed sets to an explicit zero-asset plan', () => {
    for (const audit of auditLocks().filter(candidate => ZERO_ASSET_SETS.has(candidate.packageDir))) {
      assert.deepEqual([...audit.groups.map(group => group.id)], [], `${audit.packageDir} declares no groups by design`)
      assert.equal(audit.plan.assets.length, 0)
      assert.equal(audit.plan.totalBytes, 0, `${audit.packageDir} must not claim bytes the host never fetches`)
      assert.equal(audit.plan.requiresExecutableApproval, false)
    }
  })

  it('declares every group tidily: unique ids, unique asset ids, real digests, honest enables', () => {
    for (const audit of auditLocks()) {
      const groupIds = audit.groups.map(group => group.id)
      assert.equal(new Set(groupIds).size, groupIds.length, `${audit.packageDir} declares duplicate group ids`)
      const assetIds = audit.plan.assets.map(asset => asset.assetId)
      assert.equal(new Set(assetIds).size, assetIds.length, `${audit.packageDir} declares duplicate asset ids`)
      for (const asset of audit.plan.assets) {
        assert.match(asset.digest, /^[0-9a-f]{64}$/i, `${audit.packageDir} ${asset.assetId} must carry a 64-hex digest`)
        assert.ok(asset.bytes > 0, `${audit.packageDir} ${asset.assetId} must declare a positive byte count`)
      }
      for (const group of audit.groups) {
        assert.ok(group.assets.length > 0, `${audit.packageDir} group ${group.id} must not be an empty group`)
        for (const asset of group.assets) {
          assert.ok(asset.file.length > 0, `${audit.packageDir} ${group.id}/${asset.id} must declare a file name`)
        }
      }
      // `enables` must describe what the group actually provides, and a manifest that
      // declares modalities is the authority it must not exceed.
      for (const group of audit.groups) {
        const enables = audit.enablesByGroup.get(group.id)
        assert.ok(enables !== undefined && enables.length > 0, `${audit.packageDir} group ${group.id} needs honest enables`)
        if (audit.modalities.length > 0) {
          for (const modality of enables) {
            assert.ok(
              audit.modalities.includes(modality),
              `${audit.packageDir} group ${group.id} enables ${modality}, which the model does not declare`,
            )
          }
        }
      }
    }
  })

  it('keeps the measured EmbeddingGemma plan unchanged (11 assets, three selective groups)', () => {
    const audit = auditLocks().find(candidate => candidate.packageDir === 'extension-embeddinggemma')
    assert.ok(audit !== undefined)
    assert.deepEqual(audit.groups.map(group => group.id), ['text-backbone', 'vision-encoder', 'audio-encoder'])
    assert.equal(audit.plan.assets.length, 11)
    assert.equal(audit.plan.totalBytes, 2_960_874_003)
    assert.equal(audit.plan.requiresExecutableApproval, false)
    const audio = audit.plan.assets.find(asset => asset.assetId === 'audio-encoder/eg2-audio-model-data')
    assert.equal(audio?.bytes, 1_172_750_848)
    assert.equal(audio?.digest, '6943b910d1d1e9b5dffd4ccad63f61aa308ad10b70ed128bb61886b119da1e3a')
  })

  it('plans the Needle native route as one group and marks the engine executable (RES-02)', () => {
    const audit = auditLocks().find(candidate => candidate.packageDir === 'extension-needle')
    assert.ok(audit !== undefined)
    assert.deepEqual(audit.lock.sets[audit.assetSet]?.groups.map(group => group.id), ['native-engine'])
    assert.equal(audit.plan.assets.length, 2)
    assert.equal(audit.plan.totalBytes, 36_904_660)
    assert.equal(audit.plan.requiresExecutableApproval, true, 'the downloaded native engine needs the RES-02 approval')
    assert.deepEqual(
      audit.groups.flatMap(group => group.assets.map(asset => asset.file)).sort(),
      ['needle.exe', 'needle3.cact'],
    )
    const engine = audit.plan.assets.find(asset => asset.assetId === 'native-engine/needle-engine-win-x64')
    assert.equal(engine?.bytes, 1_569_280)
    assert.equal(engine?.digest, '47cd411a022d22e393d87ce091848fd446e6d25df2ce31b12a7328337557c85b')
    const weights = audit.plan.assets.find(asset => asset.assetId === 'native-engine/needle3-weights')
    assert.equal(weights?.bytes, 35_335_380)
    assert.equal(weights?.digest, 'c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38')
  })

  it('plans the Laya lock with its conversion revision as the deployment revision', () => {
    const audit = auditLocks().find(candidate => candidate.packageDir === 'extension-laya')
    assert.ok(audit !== undefined)
    assert.equal(audit.lock.revision, '7b928d828b7b0e022f929d9bd2e44165aa270148')
    assert.equal(audit.plan.assets.length, 6)
    assert.equal(audit.plan.totalBytes, 1_324_777_402)
    assert.equal(audit.plan.requiresExecutableApproval, false)
  })
})
