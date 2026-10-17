/**
 * The host's UpdateHostSurface (EXT-30, slice 3): the operator approval
 * surface, the two-phase commit with quiesce/rebind hooks, and the standalone
 * rollback with a bounded rebindRestored.
 *
 * The SDK owns the durable mechanics (staging, validation reports, approval
 * RECORDS, the atomic pointer, the auto-rollback); this module owns the HOST
 * decisions the SDK refuses to invent (design doc §6):
 *
 * - the pending listing + approve/deny over the SDK's approval records;
 * - the quiesce (stop old-generation admissions) and the rebind (republish the
 *   new generation) — supplied as closures so the index wiring passes the
 *   lifecycle/registrar pair and tests can pass recorded fakes;
 * - the ALL-OR-NOTHING rebind wrapper: the SDK's auto-rollback re-runs NO
 *   hooks (the REBIND-REVERT contract), so a rebind failure restores the
 *   previous surface HERE, before the pointer rollback lands;
 * - the host-side timeout bound on rebindRestored (the SDK awaits it with no
 *   bound; only the management caller must not hang).
 *
 * The management channel stays the ONLY caller of this surface (AT-39).
 *
 * @module @dsh-model-as-tool/update-surface
 */

import { commitUpdate, recordApproval, rollback, ExtensionStore } from '@try-works/tool-mode-extension-sdk'
import type {
  UpdateCommitResult,
  UpdateRollbackResult,
  UpdateValidationReport,
} from '@try-works/tool-mode-extension-sdk'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** One pending staged update, from the staging directory + the approval record. */
export interface PendingUpdateEntry {
  readonly extensionId: string
  readonly stagedVersion: string
  /** The version the report was computed against. */
  readonly currentVersion: string
  readonly stagedAt: string
  readonly report: UpdateValidationReport
  /** The persisted approval, when one was recorded. */
  readonly approval?: { readonly approved: boolean; readonly reason?: string }
}

/** The host-side lifecycle closures the surface drives. */
export interface UpdateHostHooks {
  /** Stop old-generation admissions (withdraw handles, stop admitting). */
  readonly quiesce: (extensionId: string) => Promise<void>
  /** Publish the new generation's surface (must be all-or-nothing per the SDK contract). */
  readonly rebind: (extensionId: string, version: string) => Promise<void>
}

/** The operator approval surface + commit/rollback. */
export interface UpdateHostSurface {
  /** The pending staged updates with their reports and approval records. */
  listPendingUpdates(): PendingUpdateEntry[]
  /** Record ONE approval decision (write-once per staged version). */
  decide(
    extensionId: string,
    stagedVersion: string,
    decision: { approved: true } | { approved: false; reason: string },
  ): void
  /**
   * Commit a staged update through the two-phase seam.
   * @throws when the SDK refuses (no approved record, integrity, quiesce, rebind).
   */
  commit(extensionId: string, stagedVersion: string): Promise<UpdateCommitResult>
  /** Roll the pointer back with a TIME-BOUNDED rebindRestored. */
  rollback(extensionId: string): Promise<UpdateRollbackResult>
}

/** The surface options. */
export interface UpdateHostSurfaceOptions {
  readonly storeDir: string
  readonly profile: string
  readonly hooks: UpdateHostHooks
  /** The host-side bound on rebindRestored; default 30 s. */
  readonly rebindTimeoutMs?: number
}

/** The current pointer for one extension, read from the profile pointers. */
function currentPointer(store: ExtensionStore, profile: string, extensionId: string): string | undefined {
  const pointers = store.readProfilePointers(profile)
  if (pointers.corrupt) {
    throw new Error(`the profile pointers are unreadable: ${pointers.diagnostic ?? 'unknown reason'}`)
  }
  return pointers.value.activeVersions[extensionId]
}

/** The staged-update metadata file for one staged directory. */
const stageMetadataPath = (stagedDir: string): string => join(stagedDir, 'update-stage.json')

/**
 * A rebind failure whose PREVIOUS surface the wrapper already restored.
 *
 * The commit catch would otherwise restore the previous surface a second time
 * (the REBIND-REVERT contract: the wrapper owns the revert; the catch owns the
 * post-quiesce-failure restore, which is a different situation).
 */
class RebindRestoredFailure extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause })
    this.name = 'RebindRestoredFailure'
  }
}

/** Bound one promise host-side: the caller stops waiting, the work may continue. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms (host-side bound)`)), timeoutMs)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof (timer as { unref?: unknown }).unref === 'function') {
      // Kept REFERENCED deliberately: a hanging rebind must not let the process
      // exit mid-update; the timeout is what bounds it.
    }
  })
  try {
    return await Promise.race([promise, bound])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Create the host update surface.
 * @param options - the store location, profile, lifecycle hooks and the timeout bound.
 * @returns the surface.
 */
export function createUpdateHostSurface(options: UpdateHostSurfaceOptions): UpdateHostSurface {
  const store = new ExtensionStore(options.storeDir)
  const timeoutMs = options.rebindTimeoutMs ?? 30_000
  const { profile, hooks } = options
  /**
   * The surfaces the rebind wrapper ALREADY restored. The SDK wraps a failed
   * rebind into its own ManagementError, so the commit catch cannot see the
   * marker on the error itself; this in-surface set carries it instead (the
   * REBIND-REVERT contract: the wrapper's revert is never duplicated).
   */
  const wrapperRestored = new Set<string>()

  return {
    listPendingUpdates(): PendingUpdateEntry[] {
      const staging = join(options.storeDir, 'staging')
      if (!existsSync(staging)) return []
      const entries: PendingUpdateEntry[] = []
      for (const name of readdirSync(staging)) {
        if (!name.endsWith('.staged')) continue
        const stagedDir = join(staging, name)
        const metadataPath = stageMetadataPath(stagedDir)
        if (!existsSync(metadataPath)) continue // an aborted stage attempt; never listed
        let metadata: { extensionId: string; stagedVersion: string; currentVersion: string; stagedAt: string; report: UpdateValidationReport }
        try {
          metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as typeof metadata
        } catch {
          continue // a corrupt metadata record fails closed: not listed, never committed
        }
        if (typeof metadata.extensionId !== 'string' || typeof metadata.stagedVersion !== 'string'
          || typeof metadata.report !== 'object' || metadata.report === null) {
          continue
        }
        const approval = store.readApproval(metadata.extensionId, metadata.stagedVersion)
        if (approval.corrupt) {
          entries.push({ ...metadata, approval: { approved: false, reason: `the approval record is unreadable: ${approval.diagnostic ?? 'unknown reason'}` } })
          continue
        }
        entries.push({
          extensionId: metadata.extensionId,
          stagedVersion: metadata.stagedVersion,
          currentVersion: metadata.currentVersion,
          stagedAt: metadata.stagedAt,
          report: metadata.report,
          ...approval.value === undefined ? {} : {
            approval: {
              approved: approval.value.approved,
              ...('reason' in approval.value && typeof approval.value.reason === 'string'
                ? { reason: approval.value.reason }
                : {}),
            },
          },
        })
      }
      return entries
    },

    decide(extensionId, stagedVersion, decision) {
      recordApproval({ storeDir: options.storeDir, extensionId, stagedVersion, decision })
    },

    async commit(extensionId, stagedVersion) {
      // The pointer BEFORE the commit: the restore target when a post-quiesce
      // failure withdraws the old surface.
      const previous = currentPointer(store, profile, extensionId)
      /** True once the quiesce hook was INVOKED: after that a failure owes a restore. */
      let quiesced = false
      const quiescePrevious = async (): Promise<void> => {
        // Set BEFORE the hook runs: a quiesce that threw may have withdrawn the
        // surface partially, and the restore is the safe recovery either way.
        quiesced = true
        await hooks.quiesce(extensionId)
      }
      /**
       * ALL-OR-NOTHING with the revert INSIDE the wrapper (the REBIND-REVERT
       * contract): the SDK's auto-rollback re-runs no hooks, so a rebind that
       * partially published must restore the previous surface itself before
       * rethrowing. The previous pointer is still recorded under the rolled-back
       * value after the SDK's auto-rollback, so re-activating it lands on the
       * version the pointer will name.
       */
      const rebindNext = async (nextVersion: string): Promise<void> => {
        try {
          await withTimeout(hooks.rebind(extensionId, nextVersion), timeoutMs, `rebind ${extensionId}@${nextVersion}`)
        } catch (error) {
          if (previous !== undefined) {
            try {
              await withTimeout(hooks.rebind(extensionId, previous), timeoutMs, `rebind-restore ${extensionId}@${previous}`)
              wrapperRestored.add(`${extensionId}@${previous}`)
            } catch (restoreError) {
              // The restore failure rides along: the primary rebind error is the
              // named reason; the restore failure is recorded in the message.
              throw new Error(
                `${error instanceof Error ? error.message : String(error)} (and restoring ${extensionId}@${previous} also failed: `
                + `${restoreError instanceof Error ? restoreError.message : String(restoreError)})`,
              )
            }
          }
          // The previous surface is restored; the commit catch must NOT restore
          // it again — the marker distinguishes this path.
          throw new RebindRestoredFailure(error instanceof Error ? error.message : String(error), error)
        }
      }
      try {
        return await commitUpdate({
          storeDir: options.storeDir,
          profile,
          extensionId,
          stagedVersion,
          hooks: { quiescePrevious, rebindNext },
        })
      } catch (error) {
        /**
         * A failure AFTER the quiesce (pointer write failure, an integrity
         * refusal after the quiesce, or the auto-rollback after a rebind the
         * wrapper could NOT restore) left the old surface withdrawn while the
         * pointer names a version nothing republished. Restore the recorded
         * pointer's surface here; when the restore itself fails, name BOTH
         * failures. A rebind the wrapper ALREADY restored is skipped — it was
         * the wrapper's own revert (the REBIND-REVERT contract).
         */
        if (quiesced && !(error instanceof RebindRestoredFailure)) {
          const restored = currentPointer(store, profile, extensionId)
          if (restored !== undefined && !wrapperRestored.delete(`${extensionId}@${restored}`)) {
            try {
              await withTimeout(hooks.rebind(extensionId, restored), timeoutMs, `commit-restore ${extensionId}@${restored}`)
            } catch (restoreError) {
              throw new Error(
                `${error instanceof Error ? error.message : String(error)} (and restoring ${extensionId}@${restored} also failed: `
                + `${restoreError instanceof Error ? restoreError.message : String(restoreError)})`,
              )
            }
          }
        }
        throw error
      }
    },

    async rollback(extensionId) {
      // rebindRestored is bound HOST-side (the SDK awaits it unbounded after the
      // restore is durable); a timeout surfaces as the SDK's hookFailure.
      return await rollback({
        storeDir: options.storeDir,
        profile,
        extensionId,
        rebindRestored: async (restoredVersion: string) => {
          await withTimeout(hooks.rebind(extensionId, restoredVersion), timeoutMs, `rebind-restored ${extensionId}@${restoredVersion}`)
        },
      })
    },
  }
}
