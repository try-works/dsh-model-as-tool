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
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { ManagementError } from './../errors.ts'
import type { ExtensionState } from './../state.ts'

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
}

/** The lock document. */
export interface StoreLock {
  readonly lockVersion: 1
  readonly extensions: readonly InstalledRecord[]
}

/** A profile's persisted activation state (EXT-25, dimensions 2-6). */
export interface ProfileStateFile {
  readonly stateVersion: 1
  readonly profile: string
  readonly extensions: readonly ExtensionState[]
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
   * @param profile - the profile name.
   * @returns the states and any diagnostic.
   */
  readProfileState(profile: string): StateReadResult<readonly ExtensionState[]> {
    const { value, diagnostic } = readJsonBounded(this.profileStatePath(profile))
    if (diagnostic !== undefined) return { value: [], corrupt: true, diagnostic }
    if (value === undefined) return { value: [], corrupt: false }
    const file = value as ProfileStateFile
    if (typeof file !== 'object' || file === null || !Array.isArray(file.extensions)) {
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
    return { value: file.extensions, corrupt: false }
  }

  /**
   * Persist one profile's activation state.
   * @param profile - the profile name.
   * @param extensions - the complete state set for that profile.
   * @throws ManagementError when the write fails.
   */
  writeProfileState(profile: string, extensions: readonly ExtensionState[]): void {
    writeJsonAtomic(this.profileStatePath(profile), {
      stateVersion: 1,
      profile,
      extensions,
    } satisfies ProfileStateFile)
  }
}
