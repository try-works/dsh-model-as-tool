/**
 * Staged installation (EXT-07, EXT-08).
 *
 * The ordering is the security property. A package is fetched into quarantine,
 * verified, inspected as DATA, validated, and only then promoted into the store —
 * and promotion is not activation. Nothing in this module imports extension code,
 * runs inference, warms a model, or publishes a tool (EXT-07).
 *
 * The fetch and extract steps are INJECTED rather than implemented here, for two
 * reasons: the SDK must stay free of a network stack and an archive library, and
 * a test must be able to drive every rejection path without a real download or a
 * real filesystem. The host supplies the real implementations.
 *
 * @module @try-works/tool-mode-extension-sdk/install/staged
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { ManagementError } from './../errors.ts'
import { discoverExtension, type ExtensionDiscovery } from './../discovery.ts'
import { digestInstalledContent, ExtensionStore } from './store.ts'
import {
  DEFAULT_ARCHIVE_LIMITS,
  validateArchiveEntries,
  verifyIntegrity,
  type ArchiveEntry,
  type ArchiveLimits,
} from './archive.ts'

/** How an archive was obtained. */
export interface InstallSource {
  /** Where the archive came from, for the receipt. */
  readonly kind: 'registry' | 'url' | 'local'
  /** The requested source, recorded verbatim for the audit trail. */
  readonly requested: string
}

/** What a host must supply to install: bytes in, files out. */
export interface ArchiveSource {
  /**
   * Fetch the archive, bounded.
   *
   * The implementation MUST enforce the byte and time limits it is given: the
   * installer cannot bound a stream it never sees.
   * @param source - what to fetch.
   * @param limits - the byte and time bounds.
   * @returns the archive bytes.
   */
  fetch(source: InstallSource, limits: { readonly maxBytes: number; readonly timeoutMs: number }): Promise<Uint8Array>
  /**
   * List an archive's entries WITHOUT extracting them.
   * @param bytes - the archive bytes.
   * @returns the entry list.
   */
  list(bytes: Uint8Array): ArchiveEntry[]
  /**
   * Extract a validated archive into a directory.
   *
   * Only called after {@link validateArchiveEntries} has accepted the entry list,
   * so an implementation may assume every path is package-relative and link-free.
   * @param bytes - the archive bytes.
   * @param destination - the directory to extract into.
   * @param root - the package root prefix to strip, from `findPackageRoot`.
   */
  extract(bytes: Uint8Array, destination: string, root: string): void
}

/** Bounds for one installation attempt. */
export interface InstallLimits {
  /** Maximum archive bytes to fetch. */
  readonly maxArchiveBytes: number
  /** Fetch timeout in milliseconds. */
  readonly fetchTimeoutMs: number
  /** Entry-list bounds. */
  readonly archive: ArchiveLimits
}

/** Conservative install limits. */
export const DEFAULT_INSTALL_LIMITS: InstallLimits = {
  maxArchiveBytes: 256 * 1024 * 1024,
  fetchTimeoutMs: 120_000,
  archive: DEFAULT_ARCHIVE_LIMITS,
}

/** The result of a successful stage-then-promote installation. */
export interface StagedInstallResult {
  /** Extension identity from the validated manifest. */
  readonly extensionId: string
  /** Package version from the validated manifest. */
  readonly version: string
  /** Absolute path of the immutable installation directory. */
  readonly installPath: string
  /**
   * Always `'inactive'`. Installation is not activation (EXT-07); the field is
   * returned explicitly so a caller cannot mistake a successful install for a
   * usable tool.
   */
  readonly activation: 'inactive'
  /** What was discovered, without any of it having been executed. */
  readonly discovery: ExtensionDiscovery
  /** The verified archive digest, for the receipt (EXT-12). */
  readonly archiveDigest: string
}

/**
 * Install an extension into an operator-owned store, staged (EXT-08).
 *
 * Steps, in order: fetch into quarantine → verify integrity → list entries →
 * validate the entry list → extract → discover → validate compatibility →
 * promote atomically → record the installation. A failure at any step removes the
 * quarantine, so a partial install never becomes visible.
 *
 * The store is RECORDED rather than merely written to: an installation that is not
 * in the lock document cannot be activated later, because nothing would know what
 * bytes were approved.
 *
 * @param options - the source, the store, the injected archive source, and limits.
 * @returns the installed (but inactive) extension.
 * @throws ManagementError for every rejection path.
 */
export async function stagedInstall(options: {
  readonly source: InstallSource
  /** Absolute path of the operator-owned extension store. */
  readonly storeDir: string
  /** The declared SHA-512 of the archive (EXT-12). */
  readonly expectedSha512: string
  readonly archive: ArchiveSource
  readonly limits?: InstallLimits
  /** When false, the lock document is not updated. Defaults to true. */
  readonly record?: boolean
}): Promise<StagedInstallResult> {
  const limits = options.limits ?? DEFAULT_INSTALL_LIMITS
  const storeDir = resolve(options.storeDir)
  const staging = join(storeDir, '.staging')
  // A unique per-attempt directory, so two concurrent installs cannot collide and
  // a crashed attempt leaves evidence rather than a half-written package.
  const attempt = join(staging, `attempt-${process.pid}-${Date.now().toString(36)}`)

  mkdirSync(attempt, { recursive: true })
  try {
    const bytes = await options.archive.fetch(options.source, {
      maxBytes: limits.maxArchiveBytes,
      timeoutMs: limits.fetchTimeoutMs,
    })
    if (bytes.byteLength > limits.maxArchiveBytes) {
      throw new ManagementError(
        'INVALID_EXTENSION',
        'install',
        `the fetched archive is ${bytes.byteLength} bytes, over the ${limits.maxArchiveBytes} limit`,
        'Ask the publisher to reduce the package, or raise the operator limit deliberately.',
      )
    }

    // Integrity first: if the bytes are not the approved ones, nothing downstream
    // is worth doing.
    const archiveDigest = verifyIntegrity(bytes, options.expectedSha512)

    // Entry validation runs on the LIST, before extraction. A traversal entry
    // rejected here never reaches a path join.
    const entries = options.archive.list(bytes)
    validateArchiveEntries(entries, limits.archive)

    const extracted = join(attempt, 'package')
    mkdirSync(extracted, { recursive: true })
    options.archive.extract(bytes, extracted, '')

    // Discovery reads data and imports nothing; a manifest referencing a file the
    // package does not ship is refused before anything is promoted.
    const discovery = discoverExtension(extracted)

    // Promote by rename, which is atomic within a store. The destination is keyed
    // by identity AND version, so an update installs side by side rather than
    // mutating a live directory (EXT-30).
    const destination = installPathFor(storeDir, discovery.packageName, discovery.packageVersion)
    if (existsSync(destination)) {
      throw new ManagementError(
        'UPGRADE_FAILED',
        'install',
        `${discovery.packageName}@${discovery.packageVersion} is already installed`,
        'Install a different version, or uninstall the existing one first.',
      )
    }
    mkdirSync(join(destination, '..'), { recursive: true })
    renameSync(extracted, destination)
    writeFileSync(join(destination, '.tool-mode-install.json'), `${JSON.stringify({
      extensionId: discovery.packageName,
      version: discovery.packageVersion,
      archiveDigest,
      source: { kind: options.source.kind, requested: options.source.requested },
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`)

    // Recorded AFTER the bytes are in place: a lock entry naming a directory that
    // does not exist would be worse than no entry, because verification would then
    // report a missing installation as a changed one.
    if (options.record !== false) {
      const store = new ExtensionStore(storeDir)
      store.recordInstall({
        extensionId: discovery.packageName,
        version: discovery.packageVersion,
        installPath: destination,
        archiveDigest,
        // Digest the content as installed, so a later edit is detectable.
        contentDigest: digestInstalledContent(destination),
        source: { kind: options.source.kind, requested: options.source.requested },
        installedAt: new Date().toISOString(),
      })
    }

    return {
      extensionId: discovery.packageName,
      version: discovery.packageVersion,
      installPath: destination,
      activation: 'inactive',
      discovery,
      archiveDigest,
    }
  } finally {
    // Quarantine is removed on EVERY path, success included: the promoted copy is
    // the installation, and leaving a second copy behind would let the two drift.
    rmSync(attempt, { recursive: true, force: true })
  }
}

/**
 * The immutable installation directory for one extension version (EXT-33).
 *
 * The identity is VALIDATED rather than merely escaped. Escaping would turn
 * `../../etc` into a harmless-looking directory name and silently install
 * something under a package name that no registry would accept; refusing says
 * what is actually wrong.
 * @param storeDir - the operator's store root.
 * @param extensionId - the validated extension identity.
 * @param version - the validated version.
 * @returns the absolute installation path.
 * @throws ManagementError when the identity or version is not a legal one.
 */
export function installPathFor(storeDir: string, extensionId: string, version: string): string {
  // A package name is lower-case, may be scoped, and uses a restricted character
  // set. EXT-14 already requires the manifest id to equal the package name, so an
  // identity outside this grammar did not come from a real package.
  const SEGMENT = '[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?'
  const NAME = new RegExp(`^(?:@${SEGMENT}/)?${SEGMENT}$`)
  if (!NAME.test(extensionId)) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'install',
      `the extension identity ${JSON.stringify(extensionId)} is not a legal package name`,
      'Use a normal npm package name; the manifest id must equal it exactly.',
    )
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'install',
      `the version ${JSON.stringify(version)} is not a semantic version`,
      'Publish a semantic version.',
    )
  }
  // The separator is the one character a legal name cannot contain, so a
  // validated name needs no further escaping to stay inside the store.
  const path = join(resolve(storeDir), 'extensions', extensionId, version)
  const root = resolve(storeDir)
  if (!path.startsWith(root + sep)) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'install',
      'the extension identity would escape the extension store',
      'Use a normal package name.',
    )
  }
  return path
}
