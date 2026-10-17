/**
 * The operator-owned extension store (EXT-33).
 *
 * Three properties this module exists to guarantee:
 *
 * 1. **Identity survives restart.** Every installation is recorded in
 *    `extensions.lock.json` with its resolved source and a CONTENT digest, so the
 *    host can tell on a later boot whether the bytes it is about to activate are
 *    still the bytes it installed.
 * 2. **Corruption fails closed.** A state file that cannot be read yields NO
 *    active extensions and a diagnostic. The tempting alternative — falling back
 *    to "everything installed is active" — is precisely the failure EXT-33 names,
 *    because a corrupted file would silently enable every package on the machine.
 * 3. **A write that did not land is never reported as landed.** Every write goes
 *    through a temporary file and a rename, and a failure throws rather than
 *    leaving the caller believing a preference was stored.
 *
 * @module @try-works/tool-mode-extension-sdk/install/store
 */

import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { ManagementError } from './../errors.ts'
import type { ExtensionState } from './../state.ts'
import {
  STATE_SCHEMA_VERSION,
  STATE_VERSION,
  applyLegacyChoices,
  parseLegacyModelState,
  type LegacyModelState,
  type MigratedAssetRecord,
  type MigrationReport,
} from './migration.ts'
import type { LockedDependency } from './dependencies.ts'

/** Reentrant acquisition depth per resolved store root, process-local. */
const exclusiveDepth = new Map<string, number>()

/** The lock document name, as EXT-33 specifies. */
export const LOCK_FILE = 'extensions.lock.json'

/** One installed extension, as recorded at install time. */
export interface InstalledRecord {
  /** Extension identity, which equals the package name. */
  readonly extensionId: string
  /** Installed version. */
  readonly version: string
  /** Absolute installation directory. */
  readonly installPath: string
  /** SHA-512 of the archive the package was installed from (EXT-12). */
  readonly archiveDigest: string
  /**
   * Digest over the installed files. Re-checked before activation so a package
   * edited on disk after installation is detected rather than trusted.
   */
  readonly contentDigest: string
  /** Where the archive came from, recorded verbatim. */
  readonly source: { readonly kind: string; readonly requested: string }
  /** When it was installed, ISO 8601. */
  readonly installedAt: string
  /**
   * The installer-owned dependency graph (EXT-09, EXT-12): every runtime
   * dependency at its EXACT resolved version with its verified integrity.
   * Absent when the package declares no runtime dependencies.
   */
  readonly dependencies?: readonly LockedDependency[]
  /**
   * Provenance fields recorded AS DATA, NEVER AS TRUST (EXT-12): registry
   * integrity/provenance flags travel with the record for audit; verification
   * is always against the operator-supplied digest.
   */
  readonly provenance?: {
    readonly registryIntegrity?: string
    readonly provenance?: boolean
    readonly attestations?: readonly string[]
    readonly signatures?: readonly string[]
  }
}

/** The lock document. */
export interface StoreLock {
  readonly lockVersion: 1
  readonly extensions: readonly InstalledRecord[]
}

/**
 * A profile's persisted activation state (EXT-25, dimensions 2-6).
 *
 * The two version keys are BASE-09's: `stateVersion` is the migration-table era
 * (a document with a higher number was written by a newer SDK and is refused,
 * never rewritten), and `schemaVersion` identifies the schema dialect. Documents
 * written before `schemaVersion` existed (stateVersion 1, no schemaVersion key)
 * still read: the key was added without a data change, so there is no migration
 * step between them.
 */
export interface ProfileStateFile {
  readonly stateVersion: typeof STATE_VERSION
  readonly schemaVersion: string
  readonly profile: string
  readonly extensions: readonly ExtensionState[]
  /** Legacy prepared-asset mappings recorded by the BASE-09 migration. */
  readonly migratedAssets?: readonly MigratedAssetRecord[]
  /** EXT-30: the active version per extension, the update flow's pointer. */
  readonly activeVersions?: Readonly<Record<string, string>>
  /** EXT-30: the previous active version per extension, the rollback target. */
  readonly previousVersions?: Readonly<Record<string, string>>
}

/**
 * One EXT-30 approval decision for a staged update.
 *
 * Retained for the store's lifetime (audit trail, no expiry) and write-once per
 * staged version: a decision is a human act, and a later one never silently
 * overwrites it.
 */
export interface UpdateApprovalRecord {
  readonly extensionId: string
  readonly version: string
  readonly approved: boolean
  readonly deniedReason?: string
  readonly decidedAt: string
}

/** The outcome of reading state, which never throws on corruption. */
export interface StateReadResult<T> {
  readonly value: T
  /** Set when the file existed but could not be trusted. */
  readonly diagnostic?: string
  /** True when the file existed but could not be read or parsed. */
  readonly corrupt: boolean
}

const emptyLock = (): StoreLock => ({ lockVersion: 1, extensions: [] })

/**
 * Digest the files inside an installed package.
 *
 * Identity is `relative path` plus size plus a per-file digest, over a sorted
 * walk, so a renamed file, an edited file, an added file and a removed file all
 * change the result. The install receipt is excluded: it is store metadata, not
 * package content, and including it would make the digest depend on itself.
 * @param directory - the installed package directory.
 * @returns the content digest, lowercase hex.
 */
export function digestInstalledContent(directory: string): string {
  const hash = createHash('sha256')
  const files: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) files.push(absolute)
    }
  }
  walk(directory)
  for (const file of files.sort()) {
    const name = relative(directory, file).split(sep).join('/')
    if (name === '.tool-mode-install.json') continue
    const bytes = readFileSync(file)
    hash.update(name)
    hash.update('\0')
    hash.update(String(bytes.byteLength))
    hash.update('\0')
    hash.update(createHash('sha256').update(bytes).digest())
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * Whether a process with this pid exists. `process.kill(pid, 0)` is the probe.
 *
 * Exported because surface ownership is recorded as a PID: telling a GONE owner (a
 * crashed or restarted host, whose in-memory handles died with it) from a LIVE one
 * (another host still serving) is the same question the store lock asks.
 * @param pid - the process id to probe.
 * @returns whether the process exists.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process EXISTS but belongs to another user, which still
    // counts as alive: treating it as dead would let two writers collide.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Write a JSON document atomically, or throw. */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw new ManagementError(
      'EXTENSION_FAULT',
      'install',
      `the state file could not be written: ${error instanceof Error ? error.message : String(error)}`,
      'Check that the extension store is writable by the running account, then retry.',
    )
  }
}

/** Read a JSON document, or report why it could not be trusted. */
function readJsonBounded(path: string, maxBytes = 4 * 1024 * 1024): { value?: unknown; diagnostic?: string } {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    // Absent is not corrupt: a first run has no state yet.
    return {}
  }
  if (size > maxBytes) return { diagnostic: `the state file is ${size} bytes, over the ${maxBytes}-byte limit` }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { diagnostic: `the state file could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    return { value: JSON.parse(text) }
  } catch (error) {
    return { diagnostic: `the state file is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** The operator-owned extension store. */
export class ExtensionStore {
  /** Absolute path of the store root. */
  readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir)
  }

  /** Path of the lock document. */
  get lockPath(): string {
    return join(this.rootDir, LOCK_FILE)
  }

  /** Path of one profile's state file. */
  profileStatePath(profile: string): string {
    // A profile name reaches a path, so it is validated rather than escaped: a
    // name containing a separator would otherwise address another profile.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
      throw new ManagementError(
        'INVALID_EXTENSION',
        'install',
        `the profile name ${JSON.stringify(profile)} is not usable`,
        'Use letters, digits, dot, underscore or dash.',
      )
    }
    return join(this.rootDir, 'profiles', profile, 'state.json')
  }

  /**
   * Take exclusive ownership of the store for offline edits (EXT-31).
   *
   * EXT-31 requires offline edits to hold exclusive store ownership, because an
   * offline writer and a running host editing the same store would each be working
   * from a state the other cannot see. The lock records the owning process so a
   * stale lock from a crashed run can be reported as stale rather than blocking
   * forever.
   * @returns a release function.
   * @throws ManagementError with `EXTENSION_IN_USE` when another process holds it.
   */
  acquireExclusive(): () => void {
    const path = join(this.rootDir, 'store.lock')
    mkdirSync(this.rootDir, { recursive: true })
    const existing = readJsonBounded(path, 64 * 1024)
    if (existing.value !== undefined) {
      const holder = existing.value as { pid?: number; since?: string }
      if (typeof holder.pid === 'number' && holder.pid !== process.pid && isProcessAlive(holder.pid)) {
        throw new ManagementError(
          'EXTENSION_IN_USE',
          'install',
          `the extension store is owned by process ${holder.pid}${holder.since === undefined ? '' : ` since ${holder.since}`}`,
          'Stop the running host, or wait for it to release the store, before editing offline.',
        )
      }
      // A lock whose owner is gone is stale: refusing would block forever on a
      // crashed run, which is worse than proceeding under a fresh lock.
    }
    writeJsonAtomic(path, { pid: process.pid, since: new Date().toISOString() })
    let released = false
    return () => {
      if (released) return
      released = true
      const current = readJsonBounded(path, 64 * 1024).value as { pid?: number } | undefined
      // Only remove our OWN lock: a lock taken by someone else after ours was
      // replaced must not be deleted by our release.
      if (current?.pid === process.pid) rmSync(path, { force: true })
    }
  }

  /**
   * Run a state-mutating operation under the store lock (EXT-31).
   *
   * The HOST LIFECYCLE takes this around every state write, and the offline CLI
   * takes it around its edits; each side refuses while the other's process is
   * alive. Reentrancy is keyed by the RESOLVED STORE ROOT, not the instance:
   * the CLI creates fresh ExtensionStore objects around one directory, so
   * per-instance counting would let an inner acquisition overwrite the outer's
   * lock record (the round-49 review's hole 3). The depth is recorded only
   * AFTER the file lock is taken, so a refusal throws WITHOUT poisoning the
   * count (hole 1), and the lock file is removed only when the depth returns to
   * zero (hole 2: a concurrent section still holds it).
   * @param work - the mutating work.
   * @returns the work's result.
   */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    // Keyed by the CANONICAL path, not the lexical one: drive-letter case and
    // junctions make two spellings of one directory, and two keys for one store
    // would re-open the cross-instance overwrite this whole map exists to close
    // (the round-50 review's key-canonicalization finding). The directory may
    // not exist yet on a first-ever call, so it is created first; afterwards
    // realpathSync is safe. When canonicalization itself fails (a UNC/DFS edge),
    // the lexical resolved path is the fallback key: a divergent spelling is
    // better than a raw fs throw on a store the operator legitimately opened.
    mkdirSync(this.rootDir, { recursive: true })
    let canonical: string
    try {
      canonical = realpathSync.native(resolve(this.rootDir))
    } catch {
      canonical = resolve(this.rootDir)
    }
    const key = canonical
    const depth = exclusiveDepth.get(key) ?? 0
    if (depth === 0) {
      // May throw EXTENSION_IN_USE; the depth is NOT yet recorded, so a refusal
      // leaves this process able to acquire later.
      this.acquireExclusive()
      exclusiveDepth.set(key, 1)
      // EXT-29: retry owned deletions recorded by tombstones, bounded and
      // best-effort — the exclusive section is the one moment no other writer
      // can observe a half-deleted directory, and a failure here must never
      // block the operation the lock was taken for.
      try {
        this.retryCleanupPending()
      } catch {
        // Best-effort: the tombstones stay for the next exclusive section.
      }
    } else {
      exclusiveDepth.set(key, depth + 1)
    }
    try {
      return await work()
    } finally {
      const remaining = (exclusiveDepth.get(key) ?? 1) - 1
      if (remaining === 0) {
        exclusiveDepth.delete(key)
        // Remove our OWN lock record only: a record written by another process
        // (or by a later acquisition) must survive.
        const path = join(this.rootDir, 'store.lock')
        const current = readJsonBounded(path, 64 * 1024).value as { pid?: number } | undefined
        if (current?.pid === process.pid) rmSync(path, { force: true })
      } else {
        exclusiveDepth.set(key, remaining)
      }
    }
  }

  /**
   * Read the lock document.
   *
   * A corrupt lock fails closed with a diagnostic and NO records, rather than
   * reporting the store as empty-without-explanation or trusting a partial read.
   * @returns the lock and a diagnostic when it could not be trusted.
   */
  readLock(): StateReadResult<StoreLock> {
    const { value, diagnostic } = readJsonBounded(this.lockPath)
    if (diagnostic !== undefined) return { value: emptyLock(), corrupt: true, diagnostic }
    if (value === undefined) return { value: emptyLock(), corrupt: false }
    if (typeof value !== 'object' || value === null || !Array.isArray((value as StoreLock).extensions)) {
      return { value: emptyLock(), corrupt: true, diagnostic: 'the lock document has no extensions array' }
    }
    return { value: value as StoreLock, corrupt: false }
  }

  /** List installed extensions. */
  listInstalled(): StateReadResult<readonly InstalledRecord[]> {
    const lock = this.readLock()
    return { value: lock.value.extensions, corrupt: lock.corrupt, ...lock.diagnostic === undefined ? {} : { diagnostic: lock.diagnostic } }
  }

  /**
   * Record an installation.
   *
   * Throws when the write fails, so a caller never treats a lost record as a
   * completed install.
   * @param record - the installation to record.
   * @throws ManagementError when the same identity and version is already recorded.
   */
  recordInstall(record: InstalledRecord): void {
    const lock = this.readLock()
    if (lock.corrupt) {
      // Appending to a document we could not read would discard whatever it held.
      throw new ManagementError(
        'EXTENSION_FAULT',
        'install',
        `the store lock is unreadable, so a new record cannot be added safely: ${lock.diagnostic ?? 'unknown reason'}`,
        'Inspect the lock document and repair or remove it deliberately; do not append to it blindly.',
      )
    }
    const existing = lock.value.extensions.find(
      candidate => candidate.extensionId === record.extensionId && candidate.version === record.version,
    )
    if (existing !== undefined) {
      throw new ManagementError(
        'UPGRADE_FAILED',
        'install',
        `${record.extensionId}@${record.version} is already recorded as installed`,
        'Uninstall it first, or install a different version.',
      )
    }
    writeJsonAtomic(this.lockPath, {
      lockVersion: 1,
      extensions: [...lock.value.extensions, record],
    } satisfies StoreLock)
  }

  /**
   * Remove an installation record.
   *
   * Removing a record does NOT delete the installed bytes: deletion is a separate,
   * operator-driven step with its own failure modes (EXT-29), and conflating the
   * two would make a failed deletion look like a failed uninstall.
   * @param extensionId - the extension to forget.
   */
  removeRecord(extensionId: string): void {
    const lock = this.readLock()
    if (lock.corrupt) {
      throw new ManagementError(
        'EXTENSION_FAULT',
        'uninstall',
        `the store lock is unreadable, so a record cannot be removed safely: ${lock.diagnostic ?? 'unknown reason'}`,
        'Inspect the lock document and repair it deliberately.',
      )
    }
    writeJsonAtomic(this.lockPath, {
      lockVersion: 1,
      extensions: lock.value.extensions.filter(record => record.extensionId !== extensionId),
    } satisfies StoreLock)
  }

  /**
   * Check whether an installation still matches what was recorded (EXT-33).
   *
   * Run before activation: a package edited on disk after installation is a
   * different package, and activating it would execute bytes nobody approved.
   * @param record - the recorded installation.
   * @returns whether the content is unchanged, plus the current digest.
   */
  verifyUnchanged(record: InstalledRecord): { unchanged: boolean; contentDigest?: string; diagnostic?: string } {
    if (!existsSync(record.installPath)) {
      return { unchanged: false, diagnostic: 'the installation directory is missing' }
    }
    const contentDigest = digestInstalledContent(record.installPath)
    if (contentDigest !== record.contentDigest) {
      return {
        unchanged: false,
        contentDigest,
        diagnostic: 'the installed content differs from the recorded digest; the package changed on disk after installation',
      }
    }
    return { unchanged: true, contentDigest }
  }

  /**
   * Read one profile's activation state.
   *
   * A corrupt file yields NO states and a diagnostic. Returning the installed set
   * instead would be the failure EXT-33 names: corruption would enable everything.
   *
   * Versioning (BASE-09): a document with a HIGHER `stateVersion` was written by
   * a newer SDK and is refused, not read half-understood. A document with NO
   * `stateVersion` is either a legacy model-id era document (enabled/disabled
   * arrays, migrated via {@link ExtensionStore.migrateLegacyProfileState}) or
   * something this store never wrote — both fail closed with a diagnostic.
   * @param profile - the profile name.
   * @returns the states and any diagnostic.
   */
  readProfileState(profile: string): StateReadResult<readonly ExtensionState[]> {
    const { value, diagnostic } = readJsonBounded(this.profileStatePath(profile))
    if (diagnostic !== undefined) return { value: [], corrupt: true, diagnostic }
    if (value === undefined) return { value: [], corrupt: false }
    if (typeof value !== 'object' || value === null) {
      return { value: [], corrupt: true, diagnostic: 'the profile state is not a document' }
    }
    const file = value as Record<string, unknown>
    const stateVersion = file.stateVersion
    if (stateVersion === undefined) {
      if (Array.isArray(file.enabled) || Array.isArray(file.disabled)) {
        return {
          value: [], corrupt: true,
          diagnostic: 'the profile state is a legacy model-id era document (enabled/disabled arrays); migrate it with migrateLegacyProfileState',
        }
      }
      if (Array.isArray(file.extensions)) {
        return {
          value: [], corrupt: true,
          diagnostic: 'the profile state has no stateVersion key; a document this store never wrote cannot be trusted',
        }
      }
      return { value: [], corrupt: true, diagnostic: 'the profile state has no stateVersion key' }
    }
    // The gate is EQUALITY, not a lower bound (BASE-09): this SDK reads exactly
    // stateVersion 1. A document stamped 0, negative, fractional, or a
    // non-number is not this era's document and must not read as current — a
    // half-understood read is how a wrong era's choices get applied.
    if (stateVersion !== STATE_VERSION) {
      return {
        value: [], corrupt: true,
        diagnostic: `the profile state was written by a different SDK (stateVersion ${JSON.stringify(stateVersion)}); this SDK reads stateVersion ${STATE_VERSION}`,
      }
    }
    if (file.schemaVersion !== undefined && typeof file.schemaVersion !== 'string') {
      return { value: [], corrupt: true, diagnostic: 'the profile state schemaVersion is not a string' }
    }
    if (!Array.isArray(file.extensions)) {
      return { value: [], corrupt: true, diagnostic: 'the profile state has no extensions array' }
    }
    // Every entry must be structurally usable; one malformed entry invalidates the
    // whole file rather than silently dropping just that package.
    for (const state of file.extensions) {
      if (typeof state !== 'object' || state === null
        || typeof (state as ExtensionState).extensionId !== 'string'
        || typeof (state as ExtensionState).desiredActivation !== 'string'
        || typeof (state as ExtensionState).observedActivation !== 'string') {
        return { value: [], corrupt: true, diagnostic: 'a profile state entry is malformed' }
      }
    }
    return { value: file.extensions as unknown as readonly ExtensionState[], corrupt: false }
  }

  /**
   * Persist one profile's activation state.
   *
   * The document carries both BASE-09 version keys: `stateVersion` (the
   * migration era) and `schemaVersion` (the schema dialect), so a later reader
   * can tell an up-to-date document from a legacy one without guessing.
   *
   * MIGRATED-ASSET DURABILITY (BASE-09): when the caller does not pass
   * `migratedAssets`, the mappings already recorded in the file are PRESERVED
   * verbatim instead of dropped. Every lifecycle write and CLI edit calls this
   * method without the parameter, so requiring every caller to carry the
   * mappings through would mean the first forgetful writer silently loses the
   * migration's prepared-asset record; preserving by default makes the store
   * itself the keeper of them. Pass an empty array to clear them deliberately.
   * @param profile - the profile name.
   * @param extensions - the complete state set for that profile.
   * @param migratedAssets - durable legacy prepared-asset mappings. Omitted:
   *   preserve the existing ones. `[]`: clear them.
   * @throws ManagementError when the write fails.
   */
  writeProfileState(
    profile: string,
    extensions: readonly ExtensionState[],
    migratedAssets?: readonly MigratedAssetRecord[],
    activeVersions?: Readonly<Record<string, string>>,
    previousVersions?: Readonly<Record<string, string>>,
  ): void {
    let effective = migratedAssets
    if (effective === undefined) {
      // A current-version file's mappings survive; an absent or unreadable file
      // has none to preserve, and this write replaces the file anyway.
      const existing = this.readMigratedAssets(profile)
      if (!existing.corrupt) effective = existing.value
    }
    writeJsonAtomic(this.profileStatePath(profile), {
      stateVersion: STATE_VERSION,
      schemaVersion: STATE_SCHEMA_VERSION,
      profile,
      extensions,
      ...effective === undefined || effective.length === 0 ? {} : { migratedAssets: effective },
      ...activeVersions === undefined ? {} : { activeVersions },
      ...previousVersions === undefined ? {} : { previousVersions },
    } satisfies ProfileStateFile)
  }

  /**
   * Read the EXT-30 active-version pointers from one profile's state document.
   *
   * The maps are OPTIONAL document keys written only by the update flow: an
   * older document simply has no pointers, and a corrupt map fails closed
   * rather than being half-read. The read is separate from
   * {@link ExtensionStore.readProfileState} so the existing per-extension state
   * contract is untouched.
   * @param profile - the profile name.
   * @returns the pointer maps and any diagnostic.
   */
  readProfilePointers(profile: string): StateReadResult<{
    readonly activeVersions: Readonly<Record<string, string>>
    readonly previousVersions: Readonly<Record<string, string>>
  }> {
    const { value, diagnostic } = readJsonBounded(this.profileStatePath(profile))
    if (diagnostic !== undefined) return { value: { activeVersions: {}, previousVersions: {} }, corrupt: true, diagnostic }
    if (value === undefined) return { value: { activeVersions: {}, previousVersions: {} }, corrupt: false }
    if (typeof value !== 'object' || value === null) {
      return { value: { activeVersions: {}, previousVersions: {} }, corrupt: true, diagnostic: 'the profile state is not a document' }
    }
    const file = value as Record<string, unknown>
    const active = file.activeVersions
    const previous = file.previousVersions
    for (const [label, candidate] of [['activeVersions', active], ['previousVersions', previous]] as const) {
      if (candidate === undefined) continue
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        return { value: { activeVersions: {}, previousVersions: {} }, corrupt: true, diagnostic: `the profile state ${label} is not an object` }
      }
      for (const [id, version] of Object.entries(candidate as Record<string, unknown>)) {
        if (typeof version !== 'string') {
          return { value: { activeVersions: {}, previousVersions: {} }, corrupt: true, diagnostic: `the profile state ${label} entry ${JSON.stringify(id)} is not a version string` }
        }
      }
    }
    return {
      value: {
        activeVersions: (active as Record<string, string> | undefined) ?? {},
        previousVersions: (previous as Record<string, string> | undefined) ?? {},
      },
      corrupt: false,
    }
  }

  /** The approval-record path for one staged version (EXT-30, lifetime audit). */
  approvalPath(extensionId: string, version: string): string {
    return join(this.rootDir, 'approvals', `${extensionId}--${version}.json`)
  }

  /**
   * Read the approval record for one staged version.
   *
   * A corrupt record fails closed with the diagnostic: an update whose approval
   * cannot be read must NOT proceed as if it were approved.
   * @param extensionId - the extension.
   * @param version - the staged version.
   * @returns the record (or undefined when none was written) and any diagnostic.
   */
  readApproval(extensionId: string, version: string): StateReadResult<UpdateApprovalRecord | undefined> {
    const { value, diagnostic } = readJsonBounded(this.approvalPath(extensionId, version))
    if (diagnostic !== undefined) return { value: undefined, corrupt: true, diagnostic }
    if (value === undefined) return { value: undefined, corrupt: false }
    if (typeof value !== 'object' || value === null
      || typeof (value as Partial<UpdateApprovalRecord>).extensionId !== 'string'
      || typeof (value as Partial<UpdateApprovalRecord>).version !== 'string'
      || ((value as Partial<UpdateApprovalRecord>).approved !== true
        && (value as Partial<UpdateApprovalRecord>).approved !== false)) {
      return { value: undefined, corrupt: true, diagnostic: 'the approval record is malformed' }
    }
    return { value: value as UpdateApprovalRecord, corrupt: false }
  }

  /**
   * Record ONE approval decision for one staged version (EXT-30).
   *
   * The record is retained for the store's LIFETIME (audit trail, no expiry)
   * and is WRITE-ONCE per staged version: a later decision never silently
   * overwrites an earlier one. A denied record stays as the audit entry.
   * @param extensionId - the extension.
   * @param version - the staged version.
   * @param decision - the operator's decision.
   * @throws ManagementError when an earlier decision exists.
   */
  recordApproval(
    extensionId: string,
    version: string,
    decision: { approved: true } | { approved: false; reason: string },
  ): void {
    const existing = this.readApproval(extensionId, version)
    if (existing.corrupt) {
      throw new ManagementError(
        'EXTENSION_FAULT',
        'install',
        `the approval record for ${extensionId}@${version} is unreadable: ${existing.diagnostic ?? 'unknown reason'}`,
        'Inspect the record deliberately; a decision is never overwritten through a corrupt one.',
      )
    }
    if (existing.value !== undefined) {
      throw new ManagementError(
        'UPGRADE_FAILED',
        'install',
        `an approval decision already exists for ${extensionId}@${version}; decisions are write-once`,
        'Stage a new version for a new decision, or inspect the existing record.',
      )
    }
    mkdirSync(dirname(this.approvalPath(extensionId, version)), { recursive: true })
    writeJsonAtomic(this.approvalPath(extensionId, version), {
      extensionId,
      version,
      approved: decision.approved,
      ...decision.approved ? {} : { deniedReason: decision.reason },
      decidedAt: new Date().toISOString(),
    } satisfies UpdateApprovalRecord)
  }

  /**
   * Remove ONE version's installation record (EXT-30 admission rollback).
   *
   * The per-version removal exists for the update flow's failure cleanup: when
   * a commit fails after the new version was admitted, the new version's record
   * is removed while every OTHER version's record survives.
   * @param extensionId - the extension.
   * @param version - the version to forget.
   */
  removeVersionRecord(extensionId: string, version: string): void {
    const lock = this.readLock()
    if (lock.corrupt) {
      throw new ManagementError(
        'EXTENSION_FAULT',
        'install',
        `the store lock is unreadable, so a version record cannot be removed safely: ${lock.diagnostic ?? 'unknown reason'}`,
        'Inspect the lock document and repair it deliberately.',
      )
    }
    writeJsonAtomic(this.lockPath, {
      lockVersion: 1,
      extensions: lock.value.extensions.filter(
        record => !(record.extensionId === extensionId && record.version === version),
      ),
    } satisfies StoreLock)
  }

  /** The cleanup-pending tombstone directory. */
  cleanupPendingDir(): string {
    return join(this.rootDir, 'cleanup-pending')
  }

  /**
   * Record an owned deletion that could not complete (EXT-29).
   *
   * A tombstone keeps the CLEANUP_PENDING truth durable: the retry loop
   * ({@link ExtensionStore.retryCleanupPending}) re-attempts the deletion on
   * later runs, bounded, and the directory is never silently forgotten.
   * @param targetPath - the path the deletion could not remove.
   * @param reason - why the deletion failed.
   */
  writeCleanupTombstone(targetPath: string, reason: string): void {
    const dir = this.cleanupPendingDir()
    mkdirSync(dir, { recursive: true })
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    writeJsonAtomic(join(dir, `${token}.json`), {
      path: targetPath,
      attempts: 0,
      since: new Date().toISOString(),
      reason,
    })
  }

  /**
   * Retry owned deletions recorded by tombstones (EXT-29), bounded.
   *
   * Every tombstone under the attempts cap gets ONE retry attempt per call;
   * a still-failing deletion increments the counter and keeps the truthful
   * CLEANUP_PENDING record. A path that no longer exists counts as deleted.
   * @param maxAttempts - the attempts cap (default 5).
   * @returns the per-run counts.
   */
  retryCleanupPending(maxAttempts = 5): { retried: number; deleted: number; kept: number } {
    const dir = this.cleanupPendingDir()
    if (!existsSync(dir)) return { retried: 0, deleted: 0, kept: 0 }
    let retried = 0
    let deleted = 0
    let kept = 0
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue
      const tombstonePath = join(dir, entry)
      const { value } = readJsonBounded(tombstonePath, 64 * 1024)
      if (value === undefined || typeof value !== 'object') {
        // An unreadable tombstone is kept as evidence rather than deleted.
        kept += 1
        continue
      }
      const tombstone = value as { path?: unknown; attempts?: unknown; since?: unknown; reason?: unknown }
      if (typeof tombstone.path !== 'string') {
        kept += 1
        continue
      }
      const attempts = typeof tombstone.attempts === 'number' ? tombstone.attempts : 0
      if (attempts >= maxAttempts) {
        kept += 1
        continue
      }
      retried += 1
      try {
        rmSync(tombstone.path, { recursive: true, force: true })
        rmSync(tombstonePath, { force: true })
        deleted += 1
      } catch {
        writeJsonAtomic(tombstonePath, {
          path: tombstone.path,
          attempts: attempts + 1,
          since: typeof tombstone.since === 'string' ? tombstone.since : new Date().toISOString(),
          reason: typeof tombstone.reason === 'string' ? tombstone.reason : 'the owned deletion failed again',
        })
        kept += 1
      }
    }
    // An empty tombstone directory carries no pending state; removing it keeps
    // the store's truth surface clean. A directory with KEPT tombstones stays —
    // its records are the truthful CLEANUP_PENDING state.
    if (kept === 0) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Best-effort: an empty directory that cannot be removed changes nothing.
      }
    }
    return { retried, deleted, kept }
  }

  /**
   * Read the durable legacy prepared-asset mappings a migration recorded.
   *
   * Kept on the store rather than folded into `readProfileState` because the
   * state array is the lifecycle's working surface: changing its shape for the
   * asset record would make every writer a silent dropper of the record, which
   * is exactly the failure BASE-09's preservation clause names. The version
   * gate matches {@link ExtensionStore.readProfileState}.
   * @param profile - the profile name.
   * @returns the recorded mappings and any diagnostic.
   */
  readMigratedAssets(profile: string): StateReadResult<readonly MigratedAssetRecord[]> {
    const { value, diagnostic } = readJsonBounded(this.profileStatePath(profile))
    if (diagnostic !== undefined) return { value: [], corrupt: true, diagnostic }
    if (value === undefined) return { value: [], corrupt: false }
    if (typeof value !== 'object' || value === null) {
      return { value: [], corrupt: true, diagnostic: 'the profile state is not a document' }
    }
    const file = value as Record<string, unknown>
    const stateVersion = file.stateVersion
    if (stateVersion === undefined) {
      return { value: [], corrupt: true, diagnostic: 'the profile state has no stateVersion key' }
    }
    if (stateVersion !== STATE_VERSION) {
      return {
        value: [], corrupt: true,
        diagnostic: `the profile state was written by a different SDK (stateVersion ${JSON.stringify(stateVersion)}); this SDK reads stateVersion ${STATE_VERSION}`,
      }
    }
    if (file.migratedAssets === undefined) return { value: [], corrupt: false }
    if (!Array.isArray(file.migratedAssets)) {
      return { value: [], corrupt: true, diagnostic: 'the profile state migratedAssets is not an array' }
    }
    return { value: file.migratedAssets as unknown as readonly MigratedAssetRecord[], corrupt: false }
  }

  /**
   * Migrate a legacy model-id era document into this profile (BASE-09, BASE-10).
   *
   * The old world's `<DSH_HOME>/model-as-tool/state.json` held unversioned
   * `enabled`/`disabled` MODEL-ID arrays. The host reads that document and hands
   * its content here; this method runs it through the explicit migration table
   * and writes the versioned profile state atomically under the store lock.
   *
   * Guarantees, per BASE-10:
   * - Disabled choices are preserved as tool-level disables; nothing is
   *   installed, activated or prepared by the migration.
   * - Legacy enables are STAGED in the report, never granted.
   * - Unresolved mappings are reported, never silently enabled.
   * - A profile that already holds current-version state is left untouched
   *   (double migration is idempotent); a document this SDK cannot interpret is
   *   refused rather than overwritten.
   * @param profile - the profile to migrate into.
   * @param legacyJson - the legacy document's text. Omit it to migrate a
   *   legacy-shaped document found at the profile state path itself.
   * @param legacySource - description of the origin, for the report.
   * @returns the migration report.
   * @throws ManagementError when the input is not a usable legacy document or
   *   the profile already holds a document this SDK refuses to overwrite.
   */
  async migrateLegacyProfileState(
    profile: string,
    legacyJson?: string,
    legacySource = 'legacy model-id era state',
  ): Promise<MigrationReport> {
    // Validates the profile name before any file is touched.
    this.profileStatePath(profile)

    let legacy: LegacyModelState | undefined
    if (legacyJson !== undefined) {
      let parsed: unknown
      try {
        parsed = JSON.parse(legacyJson)
      } catch (error) {
        throw new ManagementError(
          'EXTENSION_FAULT',
          'update',
          `${legacySource} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          'Inspect the legacy state document and repair it; the extension store was not modified.',
        )
      }
      const result = parseLegacyModelState(parsed, legacySource)
      if (result.state === undefined) {
        throw new ManagementError(
          'EXTENSION_FAULT',
          'update',
          result.diagnostic ?? 'the legacy state document is not usable',
          'Inspect the legacy state document and repair it; the extension store was not modified.',
        )
      }
      legacy = result.state
    }

    // The store lock wraps the read-check-write: an offline CLI must not
    // interleave its edits between the migration's read and its write (EXT-31).
    return this.exclusive(async () => {
      const { value, diagnostic } = readJsonBounded(this.profileStatePath(profile))
      if (diagnostic !== undefined) {
        throw new ManagementError(
          'EXTENSION_FAULT',
          'update',
          `the profile state could not be read, so a migration cannot proceed safely: ${diagnostic}`,
          'Inspect the profile state document and repair or remove it deliberately; migration refuses to overwrite an unreadable document.',
        )
      }
      if (value !== undefined) {
        const version = (value as { stateVersion?: unknown }).stateVersion
        if (typeof version === 'number' && version === STATE_VERSION) {
          // Double migration is a no-op: the choices are already versioned.
          return {
            profile,
            legacySource,
            fromStateVersion: null,
            toStateVersion: STATE_VERSION,
            toSchemaVersion: STATE_SCHEMA_VERSION,
            alreadyCurrent: true,
            wroteState: false,
            entries: [],
          } satisfies MigrationReport
        }
        if (typeof version === 'number' && version !== STATE_VERSION) {
          // Equality, not a lower bound (BASE-09): a document stamped with any
          // other number — newer, 0, negative, fractional — is not this era's
          // document. Refusing to overwrite it is the fail-closed half of the
          // same rule readProfileState applies.
          throw new ManagementError(
            'EXTENSION_FAULT',
            'update',
            `the profile state was written by a different SDK (stateVersion ${version}); this SDK writes stateVersion ${STATE_VERSION}`,
            'Install a matching or newer SDK; the migration refuses to rewrite state it did not write.',
          )
        }
        if (legacy === undefined) {
          // The profile path itself may hold the legacy document (an SDK whose
          // store directory previously received the old world's file).
          const result = parseLegacyModelState(value, this.profileStatePath(profile))
          if (result.state !== undefined) {
            legacy = result.state
            legacySource = this.profileStatePath(profile)
          } else {
            throw new ManagementError(
              'EXTENSION_FAULT',
              'update',
              `the profile already holds a document this SDK cannot interpret: ${result.diagnostic ?? 'unknown shape'}`,
              'Inspect the profile state document and repair or remove it deliberately; the migration refuses to overwrite an unreadable document.',
            )
          }
        } else {
          throw new ManagementError(
            'EXTENSION_FAULT',
            'update',
            'the profile already holds an unversioned document; pass its content as the legacy input instead of a different document',
            'Inspect the profile state document and repair or remove it deliberately; the migration refuses to overwrite an unreadable document.',
          )
        }
      }
      if (legacy === undefined) {
        return {
          profile,
          legacySource,
          fromStateVersion: null,
          toStateVersion: STATE_VERSION,
          toSchemaVersion: STATE_SCHEMA_VERSION,
          alreadyCurrent: false,
          wroteState: false,
          skippedReason: 'no legacy document was provided and none was found at the profile state path',
          entries: [],
        } satisfies MigrationReport
      }
      const applied = applyLegacyChoices(legacy)
      this.writeProfileState(profile, applied.extensions, applied.migratedAssets)
      return {
        profile,
        legacySource,
        fromStateVersion: null,
        toStateVersion: STATE_VERSION,
        toSchemaVersion: STATE_SCHEMA_VERSION,
        alreadyCurrent: false,
        wroteState: true,
        entries: applied.entries,
      } satisfies MigrationReport
    })
  }
}
