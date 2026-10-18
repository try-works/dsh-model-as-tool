/**
 * The host's prepared-assets path (RES-02/03/05, the last in-repo slice):
 * lock reading → preparation plan → approval-gated, digest-verified acquisition
 * into an isolated content-addressed cache → the prepared-cold readiness flip →
 * the PreparedAssetMapV1 the provider routes consume.
 *
 * The verified components this module finally gives callers to:
 *
 * - `planPreparation`/`DeploymentIdentity` (deployment-coordinator.ts) — the
 *   pre-approval disclosure;
 * - `acquireAsset` (asset-acquisition.ts) — digest+size verified, atomic,
 *   resumable acquisition with tamper refusal;
 * - `createHttpSource` (http-acquisition.ts) — the default ranged source.
 *
 * Honesty rules carried through:
 *
 * - a lock with no digests REFUSES (no guessed values);
 * - an executable asset WITHOUT the explicit executable-preparation approval
 *   refuses (RES-02);
 * - a tampered final path is refused and never flips readiness;
 * - the cache lives under the host's isolated state dir, never the repo or
 *   HOME; a REAL network run is opt-in (the default source), and the suite
 *   injects a local file source so it performs no network.
 *
 * @module @try-works/dsh-model-as-tool/prepared-assets
 */

import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { acquireAsset, type AcquisitionSource, type AcquisitionStore } from './asset-acquisition.ts'
import type { DeploymentIdentity, PlannedAsset, PreparationPlan } from './deployment-coordinator.ts'

/** One lock asset, read from an extension's models.lock.json. */
interface LockAsset {
  readonly id: string
  readonly file: string
  readonly bytes: number
  readonly source: string
  readonly digest: string
  readonly executable: boolean
}

/** One lock group with its enabled modalities and assets. */
export interface LockGroup {
  readonly id: string
  readonly assets: readonly LockAsset[]
}

/** One lock asset set, with the pinning state and license. */
interface LockAssetSet {
  readonly groups: readonly LockGroup[]
  readonly revision: string
  readonly license: { readonly name: string; readonly url: string }
}

/** A parsed asset lock, ready to plan from. */
export interface ParsedAssetLock {
  readonly revision: string
  readonly license: { readonly name: string; readonly url: string }
  readonly sets: Readonly<Record<string, LockAssetSet>>
}

/** One verified asset FILE inside a prepared group (EXT-18). */
export interface PreparedAssetFile {
  /** The lock's asset id, e.g. `needle-engine-win-x64`. */
  readonly assetId: string
  /** The lock's package-relative file path, e.g. `needle.exe`. */
  readonly file: string
  /** The absolute path the file was materialized at. */
  readonly path: string
  /** The pinned digest the materialized bytes verified against. */
  readonly digest: string
}

/** The group directories one preparation materialized. */
export interface PreparedGroup {
  /** The group id (text-backbone, vision-encoder, ...). */
  readonly groupId: string
  /** The absolute directory holding the lock's per-asset file layout. */
  readonly path: string
  /** The digests this group holds. */
  readonly digests: readonly string[]
  /**
   * The individual verification handles of this group's assets.
   *
   * EXT-18's `PreparedAssetMapV1` is a mapping from asset ids to local handles, and
   * a deployment may resolve an individual file by its lock asset id rather than a
   * group directory (extension-needle does exactly that). Both projections are
   * carried so neither consumer has to guess the other's convention.
   */
  readonly files: readonly PreparedAssetFile[]
}

/** The outcome of one preparation. */
export type PreparationOutcome =
  | { readonly ok: true; readonly groups: readonly PreparedGroup[] }
  | { readonly ok: false; readonly reason: string }

/**
 * Parse a models.lock.json document.
 *
 * A lock with no digest on any asset REFUSES: a preparation built on guessed
 * bytes would verify nothing (RES-03).
 * @param bytes - the lock document.
 * @returns the parsed lock.
 */
export function parseAssetLock(bytes: string): ParsedAssetLock {
  let document: unknown
  try {
    document = JSON.parse(bytes)
  } catch (error) {
    throw new Error(`the asset lock is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof document !== 'object' || document === null) throw new Error('the asset lock is not a document')
  const root = document as Record<string, unknown>
  const assetSets = root['assetSets']
  if (typeof assetSets !== 'object' || assetSets === null) throw new Error('the asset lock declares no assetSets')
  const sets: Record<string, LockAssetSet> = {}
  for (const [setId, rawSet] of Object.entries(assetSets as Record<string, unknown>)) {
    const set = rawSet as Record<string, unknown>
    const revision = typeof set['pinning'] === 'object' && set['pinning'] !== null
      ? (set['pinning'] as Record<string, unknown>)['revision']
      : undefined
    const license = typeof set['license'] === 'object' && set['license'] !== null
      ? set['license'] as Record<string, unknown>
      : {}
    const rawGroups = set['groups']
    if (!Array.isArray(rawGroups)) throw new Error(`asset set ${setId} declares no groups`)
    const groups: LockGroup[] = rawGroups.map((rawGroup: unknown, groupIndex: number) => {
      const group = rawGroup as Record<string, unknown>
      const rawAssets = group['assets']
      if (!Array.isArray(rawAssets)) throw new Error(`asset set ${setId} group ${groupIndex} declares no assets`)
      const assets: LockAsset[] = rawAssets.map((rawAsset: unknown, assetIndex: number) => {
        const asset = rawAsset as Record<string, unknown>
        const digest = typeof asset['digest'] === 'string' ? asset['digest'] : ''
        const bytes = typeof asset['bytes'] === 'number' ? asset['bytes'] : NaN
        const id = typeof asset['id'] === 'string' ? asset['id'] : ''
        const file = typeof asset['file'] === 'string' ? asset['file'] : ''
        const source = typeof asset['source'] === 'string' ? asset['source'] : ''
        if (digest.length === 0 || !Number.isFinite(bytes) || id.length === 0 || file.length === 0) {
          throw new Error(
            `asset set ${setId} group ${groupIndex} asset ${assetIndex} is incomplete; a lock without pinned digests and sizes refuses (RES-03)`,
          )
        }
        return { id, file, bytes, source, digest, executable: asset['executable'] === true }
      })
      return { id: typeof group['id'] === 'string' ? group['id'] : `group-${groupIndex}`, assets }
    })
    sets[setId] = {
      groups,
      revision: typeof revision === 'string' ? revision : '',
      license: {
        name: typeof license['name'] === 'string' ? license['name'] : 'undeclared',
        url: typeof license['url'] === 'string' ? license['url'] : '',
      },
    }
  }
  const lockRevision = Object.values(sets)[0]?.revision ?? ''
  if (lockRevision.length === 0) throw new Error('the asset lock pins no model revision; a preparation cannot be planned')
  return { revision: lockRevision, license: Object.values(sets)[0]?.license ?? { name: 'undeclared', url: '' }, sets }
}

/** The identity the lock implies for one model deployment. */
export function identityFor(
  extensionId: string,
  modelId: string,
  lock: ParsedAssetLock,
): DeploymentIdentity {
  return {
    extensionId,
    modelId,
    modelRevision: lock.revision,
    engineVersion: 'onnxruntime-node',
    quantization: 'unquantized-fp32',
    tokenizer: 'gemma',
    preprocessingRecipe: 'pinned',
  }
}

/** The flat PlannedAsset list for one asset set. */
export function plannedAssets(lock: ParsedAssetLock, assetSetId: string): readonly PlannedAsset[] {
  const set = lock.sets[assetSetId]
  if (set === undefined) throw new Error(`the lock declares no asset set "${assetSetId}"`)
  return set.groups.flatMap(group => group.assets.map(asset => ({
    assetId: `${group.id}/${asset.id}`,
    bytes: asset.bytes,
    source: asset.source,
    digest: asset.digest,
    executable: asset.executable,
  })))
}

/** The group map for one asset set, keyed by group id. */
export function lockGroups(lock: ParsedAssetLock, assetSetId: string): readonly LockGroup[] {
  const set = lock.sets[assetSetId]
  if (set === undefined) throw new Error(`the lock declares no asset set "${assetSetId}"`)
  return set.groups
}

/**
 * Whether one lock `source` is a resolvable http(s) download URL.
 * @param source - the lock's source string.
 * @returns whether a transfer can be planned for it.
 */
export function isFetchableAssetSource(source: string): boolean {
  /**
   * A source is fetchable when it has a URI SCHEME at all: https/http, a `file:`
   * deployment lock, or the injected-source test scheme (`fixture:`). A PROSE
   * description ("the split export of the pinned checkpoint") has no scheme and
   * cannot plan a transfer.
   */
  return /^[a-z][a-z0-9+.-]*:/i.test(source.trim())
}

/** The minimum an asset needs for a source check. */
export interface AssetSourceProbe {
  readonly assetId: string
  readonly source: string
  readonly digest: string
}

/**
 * The operator-facing reason an asset has no transferable location.
 *
 * A prose `source` (e.g. "the split export of the pinned checkpoint") is not a
 * download URL; the bytes must be produced by the documented export and placed in
 * the prepared-assets cache (file name = the pinned digest) before a transfer-free
 * preparation can succeed.
 * @param assetId - the lock asset id.
 * @param source - the prose/non-URL source.
 * @returns the exact refusal reason.
 */
export function assetSourceUnavailableReason(assetId: string, source: string): string {
  return `the asset lock declares no download URL for ${assetId}: its source is ${JSON.stringify(source)}; `
    + 'the artifacts must be produced by the documented export and placed in the prepared-assets cache'
}

/**
 * The first planned asset with neither an http(s) URL nor bytes already in the cache.
 *
 * A cache hit is a legitimate source: a later acquisition still verifies the blob
 * against the pinned digest, so pre-seeded artifacts are verified rather than trusted.
 * @param assets - the planned assets to check.
 * @param cacheRoot - the content-addressed cache root (blob filename = digest).
 * @returns the first unavailable asset, or undefined when every asset is reachable.
 */
export function firstUnavailableAssetSource(
  assets: readonly AssetSourceProbe[],
  cacheRoot: string,
): AssetSourceProbe | undefined {
  return assets.find(asset => !isFetchableAssetSource(asset.source) && !existsSync(join(cacheRoot, asset.digest)))
}

/** The filesystem store acquisition needs, over node:fs. */
function fsStore(): AcquisitionStore {
  return {
    write(path, bytes) {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, bytes)
    },
    read(path) {
      if (!existsSync(path)) return undefined
      return new Uint8Array(readFileSync(path))
    },
    sizeOf(path) {
      if (!existsSync(path)) return 0
      return statSyncSize(path)
    },
    rename(from, to) {
      renameSync(from, to)
    },
    remove(path) {
      rmSync(path, { force: true })
    },
    exists(path) {
      return existsSync(path)
    },
  }
}

/** Synchronous size (the store interface is sync). */
function statSyncSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** The host-side prepared-assets registry (session-scoped). */
export interface PreparedAssetRegistry {
  /** The content-addressed cache root (blob filename = the pinned digest). */
  readonly cacheDirectory: string
  /** The plan the last extensions-prepare-plan built, per extension id. */
  plans(): ReadonlyMap<string, PreparationPlan>
  /** The acquired group map per extension id (PreparedAssetMapV1 shapes). */
  assetMapFor(extensionId: string): PreparedAssetMap | undefined
  /** All acquired group directories per extension id. */
  groupsFor(extensionId: string): readonly PreparedGroup[]
  /**
   * Prepare one plan: acquire every asset (digest+size verified, atomic), then
   * materialize the group directories. Idempotent: an already-acquired asset is
   * a cache hit and its bytes are never re-fetched.
   */
  prepare(
    extensionId: string,
    plan: PreparationPlan,
    groups: readonly LockGroup[],
    options: {
      readonly source: AcquisitionSource
      readonly allowExecutable: boolean
      readonly signal: AbortSignal
    },
  ): Promise<PreparationOutcome>
}

/** The PreparedAssetMapV1 shape the provider routes consume. */
export interface PreparedAssetMap {
  readonly assetIds: readonly string[]
  get(assetId: string): { readonly path: string; readonly digest: string } | undefined
}

/** Options for the registry factory. */
export interface PreparedAssetRegistryOptions {
  /** The isolated cache root (the host's state dir, never the repo or HOME). */
  readonly cacheRoot: string
  /** The default acquisition source (real network, opt-in). */
  readonly defaultSource?: AcquisitionSource
}

/**
 * The management-channel surface the host wires over the registry: the plan
 * disclosure (before approval) and the acquisition (the approval itself, with
 * the executable gate). The plan cache lives in the caller so a disclosed plan
 * is exactly what a later prepare executes.
 */
export interface PrepareAssetsSurface {
  /** Build and cache the preparation plan for one installed extension. */
  plan(extensionId: string): PreparationPlan
  /** The lock groups behind the cached plan (the prepare call needs the layout). */
  groupsForPlan(extensionId: string): readonly LockGroup[]
  /** The manifest model id the plan prepares. */
  modelIdFor(extensionId: string): string
  /** Acquire every planned asset with the given source. */
  prepare(
    extensionId: string,
    options: { readonly source: AcquisitionSource; readonly allowExecutable: boolean; readonly signal: AbortSignal },
  ): Promise<PreparationOutcome>
  /** The prepared map, or undefined before a successful prepare. */
  assetMapFor(extensionId: string): PreparedAssetMap | undefined
  /** The underlying registry (diagnostics/tests). */
  readonly registry: PreparedAssetRegistry
}


/** One in-flight or completed preparation, per extension. */
interface HeldPreparation {
  readonly plan: PreparationPlan
  readonly groups: readonly PreparedGroup[]
}

/**
 * Create the prepared-assets registry.
 * @param options - the cache root and the default source.
 * @returns the registry.
 */
export function createPreparedAssetRegistry(options: PreparedAssetRegistryOptions): PreparedAssetRegistry {
  const cacheRoot = options.cacheRoot
  const held = new Map<string, HeldPreparation>()
  // The content-addressed blob pool, shared across extensions (RES-03: two
  // owners share one set of bytes).

  return {
    cacheDirectory: cacheRoot,
    plans() {
      return new Map([...held.entries()].map(([extensionId, preparation]) => [extensionId, preparation.plan]))
    },

    assetMapFor(extensionId) {
      const preparation = held.get(extensionId)
      if (preparation === undefined) return undefined
      /**
       * TWO projections over one verified preparation, both truthful:
       *
       * - the GROUP id resolves to the group directory (embeddinggemma's selective
       *   loading asks for `text-backbone` and reads `onnx/model.onnx` under it);
       * - each ASSET id resolves to the individual materialized file (needle asks
       *   for `needle-engine-win-x64` and needs the executable's path).
       *
       * The SDK documents the map as asset ids to local handles, so the per-asset
       * entries are the canonical projection and the group entry is the directory
       * convenience the first-party group consumers already rely on. An exact
       * asset-id match wins over a group-id match; the ids are namespaced by the
       * lock and a collision is not silently served as the other kind.
       */
      const groupHandles = new Map<string, { readonly path: string; readonly digest: string }>()
      const assetHandles = new Map<string, { readonly path: string; readonly digest: string }>()
      for (const group of preparation.groups) {
        groupHandles.set(group.groupId, { path: group.path, digest: group.digests.join(',') })
        for (const file of group.files) {
          assetHandles.set(file.assetId, { path: file.path, digest: file.digest })
        }
      }
      return {
        assetIds: [...groupHandles.keys(), ...assetHandles.keys()],
        get(assetId) {
          return assetHandles.get(assetId) ?? groupHandles.get(assetId)
        },
      }
    },

    groupsFor(extensionId) {
      return held.get(extensionId)?.groups ?? []
    },

    async prepare(extensionId, plan, groups, options) {
      /**
       * A lock whose assets carry PROSE sources (no URL) has no transferable
       * location; refuse BEFORE any acquisition, naming the asset, instead of
       * surfacing a URL-parse error from deep inside the transport. Artifacts
       * already materialized in the content-addressed cache are a legitimate
       * source (a later acquisition still verifies their digest).
       */
      const unavailable = firstUnavailableAssetSource(
        groups.flatMap(group => group.assets.map(asset => ({ assetId: `${group.id}/${asset.id}`, source: asset.source, digest: asset.digest }))),
        cacheRoot,
      )
      if (unavailable !== undefined) {
        return { ok: false, reason: assetSourceUnavailableReason(unavailable.assetId, unavailable.source) }
      }
      if (!options.allowExecutable && plan.requiresExecutableApproval) {
        return {
          ok: false,
          reason: 'the plan includes an EXECUTABLE asset, which requires the separate executable-preparation approval (RES-02); this call did not grant it',
        }
      }
      const store = fsStore()
      mkdirSync(cacheRoot, { recursive: true })
      const prepared: PreparedGroup[] = []
      for (const group of groups) {
        const groupDir = join(cacheRoot, 'groups', plan.identity.extensionId.replaceAll('/', '__'), plan.identity.modelId, group.id)
        const digests: string[] = []
        const files: PreparedAssetFile[] = []
        for (const asset of group.assets) {
          const planned: PlannedAsset = {
            assetId: asset.id,
            bytes: asset.bytes,
            source: asset.source,
            digest: asset.digest,
            executable: asset.executable,
          }
          // NO in-memory blob shortcut: acquireAsset re-verifies the on-disk
          // bytes on every call (a cache HIT transfers zero bytes but still
          // checks the digest), so a blob tampered on disk is re-acquired
          // rather than trusted from a stale memory record — and two owners
          // still share the verified bytes.
          const result = await acquireAsset(planned, {
            store,
            source: options.source,
            root: cacheRoot,
            signal: options.signal,
          })
          if (!result.acquired) {
            return { ok: false, reason: `${group.id}/${asset.id}: ${result.reason}` }
          }
          const blob = { digest: result.digest, path: result.path }
          // Materialize the lock's per-asset FILE layout inside the group dir via
          // a hard link: the provider resolves `${groupDir}/onnx/model.onnx` etc.
          // The link shares the verified blob's bytes (same volume); the digest
          // was verified at acquisition and the blob path never changes.
          mkdirSync(join(groupDir, asset.file, '..'), { recursive: true })
          const linkTarget = join(groupDir, asset.file)
          if (!existsSync(linkTarget)) {
            try {
              linkSync(blob.path, linkTarget)
            } catch {
              // Hard links can fail across volumes; a copy is the fallback and
              // is equally verified because the blob's digest was checked.
              writeFileSync(linkTarget, readFileSync(blob.path))
            }
          } else if (createHash('sha256').update(readFileSync(linkTarget)).digest('hex') !== asset.digest) {
            // A tampered FINAL path never poisons readiness: it is removed and
            // the verified blob re-linked.
            rmSync(linkTarget, { force: true })
            linkSync(blob.path, linkTarget)
          }
          digests.push(asset.digest)
          files.push({ assetId: asset.id, file: asset.file, path: linkTarget, digest: asset.digest })
        }
        prepared.push({ groupId: group.id, path: groupDir, digests, files })
      }
      held.set(extensionId, { plan, groups: prepared })
      return { ok: true, groups: prepared }
    },
  }
}
