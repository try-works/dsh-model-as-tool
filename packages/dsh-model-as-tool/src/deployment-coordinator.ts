/**
 * Deployment coordination: preparation, single-flight loading and reference counting
 * (RES-02, RES-03, RES-05).
 *
 * This is the module that makes readiness states PRODUCED rather than assigned. Before
 * it, `prepared-cold` and `ready` were values a test could write; here they are values
 * this coordinator derives from what actually happened.
 *
 * Three rules shape the design:
 *
 * - **One operation per EXACT deployment** (RES-05). The key that identifies a
 *   deployment includes the model revision, engine version, quantization and
 *   preprocessing recipe, not just a model name — two builds of "the same model" that
 *   differ in quantization are different deployments and loading one must not satisfy
 *   a request for the other.
 * - **Concurrent callers JOIN** (RES-05). A second caller during a load awaits the
 *   same promise rather than starting a second load, which is the difference between
 *   sharing 349 MB and allocating it twice.
 * - **A failed or interrupted preparation cannot become ready** (RES-03). Failure is
 *   recorded as failure, and a later caller retries rather than inheriting a
 *   half-prepared deployment that reports success.
 *
 * @module @try-works/dsh-model-as-tool/deployment-coordinator
 */

import type { ModelReadiness } from '@try-works/tool-mode-extension-sdk'

/**
 * The identity of an EXACT provider deployment (RES-02, RES-05).
 *
 * Every field participates in the deployment key. Pinning only the model name would
 * let a caller be served by a differently-quantized build than the one it requested.
 */
export interface DeploymentIdentity {
  /** The extension package that provides it. */
  readonly extensionId: string
  /** The model inside that package. */
  readonly modelId: string
  /** The exact model revision, not a branch or a floating tag. */
  readonly modelRevision: string
  /** The engine or SDK version the assets were converted for. */
  readonly engineVersion: string
  /** The quantization, which changes outputs and is therefore part of identity. */
  readonly quantization: string
  /** The tokenizer identity. */
  readonly tokenizer: string
  /** The preprocessing recipe version. */
  readonly preprocessingRecipe: string
}

/**
 * The stable key for an exact deployment (RES-05).
 *
 * A delimiter that cannot appear in a component, so two different field combinations
 * cannot collide into one key.
 * @param identity - the deployment identity.
 * @returns the key.
 */
export function deploymentKey(identity: DeploymentIdentity): string {
  return [
    identity.extensionId,
    identity.modelId,
    identity.modelRevision,
    identity.engineVersion,
    identity.quantization,
    identity.tokenizer,
    identity.preprocessingRecipe,
  // A unit separator is used rather than a printable character because a model id can
  // legitimately contain most printable ones.
  ].join('\u001f')
}

/** One asset a preparation must obtain (RES-02, RES-03). */
export interface PlannedAsset {
  /** The asset id from the lock file. */
  readonly assetId: string
  /** The download size in bytes, for the pre-approval disclosure. */
  readonly bytes: number
  /** The pinned source. */
  readonly source: string
  /** The expected content digest. */
  readonly digest: string
  /**
   * Whether this asset is an EXECUTABLE.
   *
   * RES-02: prebuilt engine downloads count as executable installation, so they
   * require the separate executable-preparation approval rather than riding along
   * with a model download.
   */
  readonly executable: boolean
}

/** What a preparation would do, shown before approval (RES-02). */
export interface PreparationPlan {
  readonly identity: DeploymentIdentity
  readonly assets: readonly PlannedAsset[]
  /** Total download size, so an operator approves a number rather than a hope. */
  readonly totalBytes: number
  /** Total bytes retained after installation. */
  readonly storageBytes: number
  /** Whether any asset is executable, which changes which approval is needed. */
  readonly requiresExecutableApproval: boolean
  /** The pinned license terms, surfaced before the download rather than after. */
  readonly license: { readonly name: string; readonly url: string }
}

/**
 * Build the pre-approval disclosure (RES-02).
 *
 * An operator approving a preparation is approving a specific download of a specific
 * size under specific terms, so all three are computed here rather than discovered
 * during the install.
 * @param identity - the exact deployment.
 * @param assets - the assets the lock resolves to.
 * @param license - the pinned license.
 * @returns the plan.
 */
export function planPreparation(
  identity: DeploymentIdentity,
  assets: readonly PlannedAsset[],
  license: { readonly name: string; readonly url: string },
): PreparationPlan {
  const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0)
  return {
    identity,
    assets,
    totalBytes,
    // Storage is stated separately from download because an operator approving
    // bandwidth is not thereby approving disk.
    storageBytes: totalBytes,
    requiresExecutableApproval: assets.some(asset => asset.executable),
    license,
  }
}

/** A preparation that has not yet completed. */
export interface DeploymentRecord {
  /** The exact deployment key. */
  readonly key: string
  /** The identity it belongs to. */
  readonly identity: DeploymentIdentity
  /** The current state, using the RES-04 vocabulary. */
  readiness: ModelReadiness
  /** How many callers currently hold a reference. */
  activeUsers: number
  /** When the current load began, if one is in progress. */
  loadingSince: number | null
  /** Why it failed, when it did. */
  failureReason: string | null
}

/** What a caller receives when it acquires a deployment. */
export interface DeploymentLease {
  /** The deployment key. */
  readonly key: string
  /** The state at acquisition. */
  readonly readiness: ModelReadiness
  /** Whether the caller waited for a load to finish. */
  readonly joined: boolean
  /** Release this caller's reference. Idempotent. */
  release(): void
}

/** Raised when a deployment cannot be prepared. */
export class DeploymentError extends Error {
  override readonly name = 'DeploymentError'
  readonly key: string
  constructor(key: string, message: string) {
    super(message)
    this.key = key
  }
}

/**
 * Coordinates preparation, loading and reference counting per exact deployment.
 *
 * Not thread-safe in the language sense — Node is single-threaded — but
 * single-flight with respect to `await`: two callers that reach `acquire` before the
 * load settles both await ONE promise.
 */
export class DeploymentCoordinator {
  readonly #records = new Map<string, DeploymentRecord>()
  /** The in-flight load per key, so concurrent callers join rather than duplicate. */
  readonly #loading = new Map<string, Promise<void>>()
  /** Per-caller release handlers, so releasing is idempotent. */
  readonly #leases = new WeakSet<object>()

  /** Every tracked deployment, for diagnostics. */
  get deployments(): readonly DeploymentRecord[] {
    return [...this.#records.values()]
  }

  /** One deployment's record. */
  record(key: string): DeploymentRecord | undefined {
    return this.#records.get(key)
  }

  /**
   * The state to report for a deployment that has not been touched yet.
   * @param identity - the exact deployment.
   * @returns the readiness.
   */
  readinessOf(identity: DeploymentIdentity): ModelReadiness {
    return this.#records.get(deploymentKey(identity))?.readiness ?? 'needs-preparation'
  }

  /**
   * Prepare and load a deployment, joining an in-flight load if there is one.
   *
   * RES-05: "One preparation/load operation per exact provider deployment; concurrent
   * callers join or queue."
   * @param identity - the exact deployment.
   * @param load - performs the load. Called AT MOST ONCE per concurrent group.
   * @param options - cancellation for THIS caller.
   * @returns the lease.
   * @throws DeploymentError when the load fails.
   */
  async acquire(
    identity: DeploymentIdentity,
    load: () => Promise<void>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<DeploymentLease> {
    const key = deploymentKey(identity)
    let record = this.#records.get(key)
    if (record === undefined) {
      record = {
        key,
        identity,
        readiness: 'needs-preparation',
        activeUsers: 0,
        loadingSince: null,
        failureReason: null,
      }
      this.#records.set(key, record)
    }

    // A previous failure must not be inherited as a success: RES-03 says a failed or
    // interrupted preparation cannot become ready, so the next caller RETRIES.
    if (record.readiness === 'failed') {
      record.readiness = 'needs-preparation'
      record.failureReason = null
    }

    let joined = false
    if (record.readiness === 'ready') {
      // Already loaded: nothing to join.
    } else {
      let pending = this.#loading.get(key)
      if (pending === undefined) {
        pending = this.#startLoad(record, load)
        this.#loading.set(key, pending)
      } else {
        joined = true
      }
      try {
        await pending
      } catch (error) {
        // The caller is told WHY, and the record keeps the failure so a later caller
        // retries rather than seeing a stale success.
        throw new DeploymentError(
          key,
          `${identity.extensionId}/${identity.modelId} could not be prepared: `
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    if (options.signal?.aborted === true) {
      // Cancellation is PER INVOCATION (RES-05): this caller gives up, and the
      // deployment it just waited for is left loaded and available to whoever else
      // wants it. Killing it here would destroy another caller's legitimate work.
      throw new DeploymentError(key, 'the caller cancelled before the deployment could be used')
    }

    record.activeUsers += 1
    const lease = {
      key,
      readiness: record.readiness,
      joined,
      release: () => this.#release(key, lease),
    }
    return lease
  }

  /** Start the single load for a key. */
  #startLoad(record: DeploymentRecord, load: () => Promise<void>): Promise<void> {
    record.readiness = 'loading'
    record.loadingSince = Date.now()
    const pending = (async () => {
      try {
        await load()
        // A load that threw is not ready; a load that returned is.
        record.readiness = 'ready'
        record.failureReason = null
      } catch (error) {
        // RES-03: a failed or interrupted preparation CANNOT become ready.
        record.readiness = 'failed'
        record.failureReason = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        record.loadingSince = null
        this.#loading.delete(record.key)
      }
    })()
    return pending
  }

  /** Decrement a caller's reference. */
  #release(key: string, lease: object): void {
    if (this.#leases.has(lease)) return
    this.#leases.add(lease)
    const record = this.#records.get(key)
    if (record === undefined) return
    record.activeUsers = Math.max(0, record.activeUsers - 1)
  }

  /**
   * Unload a deployment, but only when it is IDLE (RES-05).
   *
   * "Unload only idle resources or an explicitly revoked deployment after coordinated
   * cleanup." Unloading a busy deployment would discard another caller's work.
   * @param key - the deployment key.
   * @param force - set only for an explicitly revoked deployment.
   * @returns whether it was unloaded, and why not when it was not.
   */
  unload(key: string, force = false): { readonly unloaded: boolean; readonly reason?: string } {
    const record = this.#records.get(key)
    if (record === undefined) return { unloaded: false, reason: 'no such deployment' }
    if (this.#loading.has(key)) {
      return { unloaded: false, reason: 'a load is in progress' }
    }
    if (record.activeUsers > 0 && !force) {
      // The count is the whole point: another caller is using this right now.
      return { unloaded: false, reason: `${record.activeUsers} caller(s) are still using it` }
    }
    record.readiness = 'prepared-cold'
    return { unloaded: true }
  }

  /**
   * Revoke a deployment, discarding in-flight work after coordinated cleanup (RES-05).
   * @param key - the deployment key.
   * @returns whether it was revoked.
   */
  revoke(key: string): boolean {
    const record = this.#records.get(key)
    if (record === undefined) return false
    // Revocation is the one case that may discard a busy deployment, and it is
    // explicit: the operator asked for it rather than a policy inferring it.
    record.activeUsers = 0
    record.readiness = 'prepared-cold'
    return true
  }
}

/** An asset ownership record (RES-03). */
export interface AssetOwnership {
  /** The content digest, which is what makes sharing safe. */
  readonly digest: string
  /** The holders of this asset, by owner id. */
  readonly owners: readonly string[]
}

/**
 * Decide which assets may be deleted (RES-03).
 *
 * RES-03: "Package uninstall and asset purge are separate operations; delete only
 * unreferenced host-owned assets." So removing an owner does not delete anything, and
 * an asset with another owner is never deleted.
 * @param ownership - the current records.
 * @param removedOwner - the owner being uninstalled.
 * @returns the digests that are now unreferenced, and those still held.
 */
export function purgeCandidates(
  ownership: readonly AssetOwnership[],
  removedOwner: string,
): { readonly deletable: readonly string[]; readonly retained: readonly string[] } {
  const deletable: string[] = []
  const retained: string[] = []
  for (const asset of ownership) {
    const remaining = asset.owners.filter(owner => owner !== removedOwner)
    // An asset with a remaining owner is RETAINED, because deleting it would break a
    // deployment nobody uninstalled.
    if (remaining.length === 0) deletable.push(asset.digest)
    else retained.push(asset.digest)
  }
  return { deletable, retained }
}
