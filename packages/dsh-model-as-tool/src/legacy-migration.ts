/**
 * The startup hook that migrates a legacy model-id era `state.json` into the
 * versioned world (BASE-09, BASE-10), ONCE per profile — as a REAL
 * transaction with crash recovery, not a read-then-overwrite.
 *
 * Before this module the migration table existed only as an SDK library with
 * tests: nothing in the host's production startup ever ran it, so a real
 * upgrade kept reading the old-world document forever. This module is the
 * production caller. Its guarantees:
 *
 * - ONCE-ANCHOR + COMMIT: a non-secret sidecar marker
 *   (`<stateFile>.migrated.json`) is the commit record, written ATOMICALLY
 *   (temp + fsync + rename) as the LAST step of the transaction. The host's
 *   own state document keeps its exact shape — the store's writes are
 *   untouched and no parallel format is written. A marker is VALIDATED on
 *   every read (parse + exact version + list shape): a corrupt or
 *   foreign-version marker FAILS CLOSED instead of silently counting the
 *   profile as migrated;
 * - IMMUTABLE JOURNAL: before ANY mutation, the original legacy document is
 *   journaled to `<stateFile>.legacy-backup.json` with EXCLUSIVE creation
 *   (`wx`). The journal is the legacy INPUT for every recovery. Its
 *   first-write-wins behavior is guaranteed BY THE TRANSACTION LOCK (the
 *   exists-check before the rename is advisory, not a lock);
 * - RECOVERY: a crash between the host write and the marker leaves a journal
 *   WITHOUT a committed marker. The next boot detects that state and re-runs
 *   the transaction FROM THE VALIDATED JOURNAL — never from the already-
 *   rewritten state file, which has lost the staged enables, provider picks
 *   and prepared-asset facts. The host write MERGES with the current
 *   document (current enables are operator-era facts and are preserved;
 *   legacy disables are added), so an operator change after the crash is
 *   never discarded. A corrupt journal with no marker FAILS CLOSED;
 * - TRANSACTION LOCK: the whole transaction runs under an exclusive lock
 *   file with an ownership token and pid. A stale lock is NEVER taken over
 *   automatically — the read-then-remove sequence is not atomic and two
 *   concurrent reapers could delete a successor's fresh lock — so a held lock
 *   FAILS CLOSED at the deadline and the operator removes it deliberately;
 *   release removes only a token-owned lock (the same discipline as the
 *   credential store);
 * - the SDK profile half runs THROUGH the SDK's own
 *   `migrateLegacyProfileState` (its lock, idempotence, version gate) BEFORE
 *   the host document is written;
 * - DISABLED legacy choices are preserved — ALL of them, mapped or not: an
 *   unmapped disabled id that vanished from the host state would let a later
 *   package restore silently enable what the operator turned off. Unresolved
 *   ids are REPORTED separately, never enabled;
 * - legacy ENABLES are STAGED, never granted (BASE-10: a legacy enable is
 *   not consent to install, activate or prepare third-party code);
 * - every persisted artifact (marker, journal, lock) is NON-SECRET by
 *   construction: model ids, provider identifiers and counts, never a secret.
 *
 * @module @try-works/dsh-model-as-tool/legacy-migration
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  applyLegacyChoices,
  ExtensionStore,
  parseLegacyModelState,
  type MigrationEntry,
} from '@try-works/tool-mode-extension-sdk'
import { type PersistedState, type StateStore } from './state.ts'
import { StateError } from './state.ts'

/** The marker version this host writes; equality, never a lower bound. */
export const MIGRATION_MARKER_VERSION = 1 as const

/** What the startup hook did. */
export interface LegacyStartupOutcome {
  /** False when there was nothing to migrate (marker present, or fresh profile). */
  readonly ran: boolean
  /** The host choices to adopt after the run (the caller replaces its persisted copy). */
  readonly hostState: PersistedState
  /** Legacy model ids that were ENABLED and are therefore STAGED, never granted. */
  readonly staged: readonly string[]
  /** Legacy ids the table could not map; reported, never enabled. */
  readonly unresolved: readonly string[]
  /** A non-secret one-line summary for the startup log, when anything happened. */
  readonly logLine: string | undefined
  /** True when this run RECOVERED an interrupted transaction from the journal. */
  readonly recovered: boolean
}

/** The sidecar marker: non-secret, nothing but the once-anchor facts. */
interface MigrationMarker {
  readonly hostStateVersion: 1
  readonly migratedAt: string
  readonly legacy: boolean
  /** Durable, non-secret: the ids that were staged, so they are not lost. */
  readonly staged: readonly string[]
  /** Durable, non-secret: the ids the table could not map. */
  readonly unresolved: readonly string[]
}

/** The immutable journal of the ORIGINAL legacy document. */
interface LegacyBackup {
  readonly migratedAt: string
  /** The parsed legacy document, journaled BEFORE any mutation. */
  readonly legacyDocument: unknown
}

/** A held lock's record. No secrets, ever. */
interface LockRecord {
  readonly token: string
  readonly pid: number
  readonly at: number
}

/** The marker path for one state file. */
export function migrationMarkerPath(stateFile: string): string {
  return `${stateFile}.migrated.json`
}

/** The backup path for one state file. */
export function legacyBackupPath(stateFile: string): string {
  return `${stateFile}.legacy-backup.json`
}

/** The transaction lock path for one state file. */
export function migrationLockPath(stateFile: string): string {
  return `${stateFile}.migration.lock`
}

/** Unique ids in first-seen order. */
function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

/** A real blocking sleep, without burning the CPU. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * The transaction lock: exclusive creation, ownership token + pid, bounded
 * retries, and release removes ONLY a token-owned lock. There is NO automatic
 * stale takeover: two concurrent reapers could each read a stale record and
 * remove a SUCCESSOR's fresh lock between its create and its next open — the
 * read→rm sequence is not atomic. A lock whose holder cannot be proven live
 * therefore FAILS CLOSED at the deadline and the operator removes the lock
 * file deliberately.
 */
function acquireMigrationLock(stateFile: string): () => void {
  const lockPath = migrationLockPath(stateFile)
  const token = randomBytes(16).toString('hex')
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeFileSync(fd, JSON.stringify({ token, pid: process.pid, at: Date.now() }), 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      return () => {
        let held: LockRecord | undefined
        try {
          held = JSON.parse(readFileSync(lockPath, 'utf8')) as LockRecord
        } catch {
          return
        }
        if (held === undefined || held.token !== token) return
        try {
          rmSync(lockPath, { force: true })
        } catch {
          // Already gone.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() > deadline) {
        throw new StateError(
          'the legacy migration is locked by another writer; the transaction was not attempted '
          + `(remove ${lockPath} only after confirming no writer holds it)`,
        )
      }
      sleep(25)
    }
  }
}

/** Read and VALIDATE the marker; a corrupt or foreign marker fails closed. */
function readMarker(stateFile: string): MigrationMarker | undefined {
  let text: string
  try {
    text = readFileSync(migrationMarkerPath(stateFile), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new StateError(
      `cannot read the migration marker ${migrationMarkerPath(stateFile)}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new StateError(
      `the migration marker ${migrationMarkerPath(stateFile)} is not valid JSON and will not be trusted: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StateError(`the migration marker ${migrationMarkerPath(stateFile)} is not a JSON object`)
  }
  const marker = parsed as Partial<MigrationMarker>
  if (marker.hostStateVersion !== MIGRATION_MARKER_VERSION) {
    throw new StateError(
      `the migration marker ${migrationMarkerPath(stateFile)} was written by a different era `
      + `(hostStateVersion ${JSON.stringify(marker.hostStateVersion)}); this host writes ${MIGRATION_MARKER_VERSION}`,
    )
  }
  // The FULL shape is validated: a marker that parses but does not say what a
  // committed transaction says (legacy flag, timestamp, STRING id lists) is
  // corrupt, and trusting it would silently count the profile as migrated.
  if (typeof marker.legacy !== 'boolean' || typeof marker.migratedAt !== 'string') {
    throw new StateError(`the migration marker ${migrationMarkerPath(stateFile)} does not carry a committed transaction record`)
  }
  if (!Array.isArray(marker.staged) || marker.staged.some(id => typeof id !== 'string')) {
    throw new StateError(`the migration marker ${migrationMarkerPath(stateFile)} carries a malformed staged list`)
  }
  if (!Array.isArray(marker.unresolved) || marker.unresolved.some(id => typeof id !== 'string')) {
    throw new StateError(`the migration marker ${migrationMarkerPath(stateFile)} carries a malformed unresolved list`)
  }
  return marker as MigrationMarker
}

/** Write the marker ATOMICALLY: temp + fsync + rename, never a truncating write. */
function writeMarkerAtomic(stateFile: string, marker: MigrationMarker): void {
  mkdirSync(dirname(stateFile), { recursive: true })
  const temporary = `${migrationMarkerPath(stateFile)}.tmp-${randomBytes(8).toString('hex')}`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temporary, migrationMarkerPath(stateFile))
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/** Read and VALIDATE the journal; undefined only when it does not exist. */
function readBackup(stateFile: string): LegacyBackup | undefined {
  let text: string
  try {
    text = readFileSync(legacyBackupPath(stateFile), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new StateError(
      `cannot read the migration journal ${legacyBackupPath(stateFile)}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new StateError(
      `the migration journal ${legacyBackupPath(stateFile)} is not valid JSON; `
      + `an interrupted transaction cannot be recovered safely: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    || !('legacyDocument' in parsed)) {
    throw new StateError(`the migration journal ${legacyBackupPath(stateFile)} does not hold a legacyDocument`)
  }
  return parsed as LegacyBackup
}

/** Journal the ORIGINAL document EXCLUSIVELY: `wx` create; the first-write-wins
 * guarantee across retries comes from the TRANSACTION LOCK that serializes
 * writers, with the exists-check as an advisory belt. */
function journalLegacyDocument(stateFile: string, legacyDocument: unknown): void {
  mkdirSync(dirname(stateFile), { recursive: true })
  const temporary = `${legacyBackupPath(stateFile)}.tmp-${randomBytes(8).toString('hex')}`
  const backup: LegacyBackup = { migratedAt: new Date().toISOString(), legacyDocument }
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(backup, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    // link-or-rename is not available; the rename loses if a journal already
    // exists (first-write-wins), which is exactly the retry discipline.
    if (existsSync(legacyBackupPath(stateFile))) {
      rmSync(temporary, { force: true })
      return
    }
    renameSync(temporary, legacyBackupPath(stateFile))
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * Derive the migration facts from one legacy document (the SDK's table — no
 * parallel format): staged enables, unresolved ids, the disabled ids and the
 * enabled ids (the journal-enabled set the recovery merge stages by).
 */
function deriveFacts(legacyDocument: unknown, source: string): {
  readonly staged: string[]
  readonly unresolved: string[]
  readonly legacyDisabled: readonly string[]
  readonly legacyEnabled: readonly string[]
  readonly legacyJson: string
} {
  const legacy = parseLegacyModelState(legacyDocument, source)
  if (legacy.state === undefined) {
    throw new StateError(legacy.diagnostic ?? `${source} is not a usable legacy state document`)
  }
  const applied = applyLegacyChoices(legacy.state)
  const staged: string[] = []
  const unresolved: string[] = []
  for (const entry of applied.entries) {
    switch (entry.kind) {
      case 'enabled-choice':
        if (entry.outcome === 'staged') staged.push(entry.legacyModelId)
        else if (entry.outcome === 'unresolved' || entry.outcome === 'conflicting') unresolved.push(entry.legacyModelId)
        break
      case 'disabled-choice':
      case 'provider-selection':
      case 'prepared-asset':
        if (entry.outcome === 'unresolved') unresolved.push(entry.legacyModelId)
        break
    }
  }
  return {
    staged,
    unresolved,
    legacyDisabled: [...legacy.state.disabled],
    legacyEnabled: [...legacy.state.enabled],
    legacyJson: JSON.stringify(legacyDocument),
  }
}

/**
 * Run the one-time legacy startup migration (with crash recovery).
 *
 * @param options.stateFile - the host's configured isolated state path.
 * @param options.store - the host's state store over that path.
 * @param options.extensionStoreDir - when the deployment mounts an extension
 *   store, the SDK profile migration runs there too.
 * @param options.log - a non-secret log sink (the host's logger).
 * @returns the outcome; the caller ALWAYS adopts `hostState` (the hook returns
 * a fresh post-lock read on every path, so adopting it never re-applies a
 * pre-hook snapshot).
 */
export async function runLegacyStartupMigration(options: {
  readonly stateFile: string
  readonly store: StateStore
  readonly extensionStoreDir?: string
  readonly log?: (line: string) => void
}): Promise<LegacyStartupOutcome> {
  const { stateFile, store, extensionStoreDir, log } = options
  // The parent chain must exist BEFORE the lock file is created: a fresh
  // profile's first boot has no directory yet.
  mkdirSync(dirname(stateFile), { recursive: true })
  const release = acquireMigrationLock(stateFile)
  try {
    return await transaction(stateFile, store, extensionStoreDir, log)
  } finally {
    release()
  }
}

async function transaction(
  stateFile: string,
  store: StateStore,
  extensionStoreDir: string | undefined,
  log: ((line: string) => void) | undefined,
): Promise<LegacyStartupOutcome> {
  // The once-anchor, VALIDATED: a marker is trusted only when it parses and
  // carries exactly this host's version. A committed transaction is final.
  const marker = readMarker(stateFile)
  if (marker !== undefined) {
    return {
      ran: false,
      hostState: store.read(),
      staged: marker.staged,
      unresolved: marker.unresolved,
      logLine: undefined,
      recovered: false,
    }
  }

  // RECOVERY DECISION: a journal WITHOUT a committed marker is an interrupted
  // transaction. The legacy INPUT is the VALIDATED journal — never the
  // already-rewritten state file, which has lost the staged enables, provider
  // picks and prepared-asset facts.
  const backup = readBackup(stateFile)
  const recovered = backup !== undefined

  let legacyDocument: unknown
  if (recovered) {
    legacyDocument = backup.legacyDocument
  } else {
    let raw: string | undefined
    try {
      raw = readFileSync(stateFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new StateError(`cannot read ${stateFile}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (raw === undefined) {
      // A FRESH profile: nothing to migrate. The marker is written anyway so
      // the profile's own later enable/disable writes can never be mis-read as
      // a legacy era on a future boot.
      writeMarkerAtomic(stateFile, {
        hostStateVersion: MIGRATION_MARKER_VERSION,
        migratedAt: new Date().toISOString(),
        legacy: false,
        staged: [],
        unresolved: [],
      })
      return { ran: false, hostState: store.read(), staged: [], unresolved: [], logLine: undefined, recovered: false }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new StateError(
        `${stateFile} is not valid JSON and will not be migrated or overwritten: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
    // A document carrying a version key is not the legacy era. ANY version
    // fails closed here (the SDK's equality gate, not a lower bound).
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const version = (parsed as { stateVersion?: unknown }).stateVersion
      if (version !== undefined) {
        throw new StateError(
          `${stateFile} carries a stateVersion (${JSON.stringify(version)}) this host does not write; `
          + 'the migration refuses to re-interpret a versioned document',
        )
      }
    }
    legacyDocument = parsed
  }

  const facts = deriveFacts(legacyDocument, recovered ? legacyBackupPath(stateFile) : stateFile)

  // TRANSACTION ORDER — journal first (fresh runs only), SDK second, host
  // write third, marker last. The journal exists BEFORE any mutation, so a
  // crash at any later step leaves a recovery path from the original.
  if (!recovered) journalLegacyDocument(stateFile, legacyDocument)

  let sdkEntries: readonly MigrationEntry[] = []
  if (extensionStoreDir !== undefined && extensionStoreDir.length > 0) {
    const extensionStore = new ExtensionStore(extensionStoreDir)
    const report = await extensionStore.migrateLegacyProfileState('default', facts.legacyJson, legacyBackupPath(stateFile))
    sdkEntries = report.entries
  }

  // CONSERVATIVE MERGE, recovery only: the journal's ENABLED ids are legacy
  // facts and are ALWAYS staged — even if the current document still carries
  // them (a crash before the host write leaves the original legacy document
  // in place, and trusting its enables would grant what BASE-10 stages).
  // Current enables that are NOT journal-enabled ids are operator-era facts
  // from after the crash and are kept. On a first run the current document IS
  // the legacy document: nothing may be carried into `enabled` at all.
  const current = store.read()
  const journalEnabled = new Set(facts.legacyEnabled)
  const hostState: PersistedState = recovered
    ? {
        enabled: unique(current.enabled.filter(id => !journalEnabled.has(id))).sort(),
        disabled: unique([...current.disabled, ...facts.legacyDisabled]).sort(),
      }
    : {
        enabled: [],
        disabled: unique(facts.legacyDisabled).sort(),
      }
  store.write(hostState)

  const stagedIds = unique(facts.staged)
  const unresolvedIds = unique([...facts.unresolved, ...sdkEntries
    .filter(entry => entry.outcome === 'unresolved')
    .map(entry => entry.legacyModelId)])

  writeMarkerAtomic(stateFile, {
    hostStateVersion: MIGRATION_MARKER_VERSION,
    migratedAt: new Date().toISOString(),
    legacy: true,
    staged: stagedIds,
    unresolved: unresolvedIds,
  })

  const logLine = `${recovered ? 'legacy migration RECOVERED from the journal' : 'legacy migration'}: `
    + `${hostState.disabled.length} disabled choice(s) preserved, `
    + `${stagedIds.length} enable(s) staged (not granted), `
    + `${unresolvedIds.length} unresolved id(s) reported`
    + (unresolvedIds.length > 0 ? `: ${unresolvedIds.join(', ')}` : '')
    + (sdkEntries.length > 0 ? `; SDK profile entries: ${sdkEntries.length}` : '')
    + `; original document journaled at ${legacyBackupPath(stateFile)}`
  log?.(logLine)

  return { ran: true, hostState, staged: stagedIds, unresolved: unresolvedIds, logLine, recovered }
}
