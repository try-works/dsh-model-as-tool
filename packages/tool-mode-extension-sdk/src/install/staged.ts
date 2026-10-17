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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { linkRuntimeSdk, RUNTIME_SDK_NAME, type RuntimeLinkOutcome } from './runtime-link.ts'
import { join, resolve, sep } from 'node:path'
import { ManagementError } from './../errors.ts'
import { discoverExtension, type ExtensionDiscovery } from './../discovery.ts'
import { digestInstalledContent, ExtensionStore } from './store.ts'
import { installDependencyGraph, type InstallDependencyGraph, type LockedDependency } from './dependencies.ts'
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
 * The EXT-08 operator approval PREVIEW, produced before materialization.
 *
 * The caller inspects the permissions/licences/models/download implications
 * and may refuse (throw) to abort the install while nothing is promoted.
 */
export interface InstallPreview {
  readonly extensionId: string
  readonly version: string
  readonly permissions: ExtensionDiscovery['manifest']['permissions']
  /** Declared model asset sets with their platform descriptors. */
  readonly models: readonly { readonly id: string; readonly assetSet: string; readonly platforms: readonly string[] }[]
  /** The declared licence layers, as `layer: name` strings. */
  readonly licenses: readonly string[]
  /** What the install implies for downloads and preparation consent. */
  readonly downloadImplications: string
  /** Whether this install warrants an explicit operator approval. */
  readonly requiresApproval: boolean
}

/**
 * Provenance fields recorded AS DATA, NEVER AS TRUST (EXT-12): where the
 * registry reported integrity/provenance flags, they travel with the install
 * record for audit; verification is always against the operator-supplied
 * digest, never against these fields alone.
 */
export interface InstallProvenance {
  /** The registry-recorded integrity string, verbatim. */
  readonly registryIntegrity?: string
  /** Whether the registry reported a build-provenance attestation. */
  readonly provenance?: boolean
  /** Reported attestation references, verbatim. */
  readonly attestations?: readonly string[]
  /** Reported signature references, verbatim. */
  readonly signatures?: readonly string[]
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
  /**
   * The injected dependency graph installer (EXT-09). When the package
   * declares runtime dependencies and this is omitted, the install REFUSES
   * with DEPENDENCY_UNSATISFIED rather than materializing an unresolvable
   * extension.
   */
  readonly dependencies?: InstallDependencyGraph
  /** The EXT-08 operator approval preview, called before materialization. */
  readonly preview?: (preview: InstallPreview) => void | Promise<void>
  /** Provenance fields recorded as data, never as trust (EXT-12). */
  readonly provenance?: InstallProvenance
}): Promise<StagedInstallResult> {
  const limits = options.limits ?? DEFAULT_INSTALL_LIMITS
  const storeDir = resolve(options.storeDir)
  const staging = join(storeDir, '.staging')
  // A unique per-attempt directory, so two concurrent installs cannot collide and
  // a crashed attempt leaves evidence rather than a half-written package.
  const attempt = join(staging, `attempt-${process.pid}-${Date.now().toString(36)}`)

  mkdirSync(attempt, { recursive: true })
    /** Set when the runtime link could not be made, reported rather than thrown. */
    let runtimeLinkDiagnostic: RuntimeLinkOutcome | undefined
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

    // EXT-09: the extension's runtime dependencies are resolved, verified and
    // materialized into the extension's OWN directory before promotion. A
    // package that declares dependencies without a provided graph installer is
    // REFUSED rather than installed as a guaranteed-broken extension.
    let lockedDependencies: readonly LockedDependency[] = []
    let declaredDependenciesCount = 0
    try {
      const packageJson = JSON.parse(readFileSync(join(extracted, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, unknown>
      }
      declaredDependenciesCount = Object.keys(packageJson.dependencies ?? {}).length
    } catch {
      // The package.json was already read by discovery; this cannot fail.
    }
    if (declaredDependenciesCount > 0) {
      if (options.dependencies === undefined) {
        throw new ManagementError(
          'DEPENDENCY_UNSATISFIED',
          'install',
          `${discovery.packageName} declares ${declaredDependenciesCount} runtime dependenc${declaredDependenciesCount === 1 ? 'y' : 'ies'} but no dependency-graph installer was provided; the extension would be installed broken`,
          'Provide the operator-configured registry resolver, or publish the extension with every runtime dependency bundled.',
        )
      }
      lockedDependencies = await installDependencyGraph(extracted, options.dependencies)
    }

    // EXT-08: the operator approval PREVIEW runs BEFORE materialization — the
    // caller sees the permissions/licenses/platform/download implications and
    // may refuse (throw) to abort the install while nothing is promoted.
    if (options.preview !== undefined) {
      const manifest = discovery.manifest
      await options.preview({
        extensionId: discovery.packageName,
        version: discovery.packageVersion,
        permissions: manifest.permissions,
        models: manifest.models.map(model => ({
          id: model.id,
          assetSet: model.assetSet,
          platforms: model.platforms.map(platform => `${platform.os}-${platform.arch}${platform.accelerator === undefined ? '' : `-${platform.accelerator}`}`),
        })),
        licenses: (manifest.licenses ?? []).map(layer => `${layer.layer}: ${layer.name}`),
        downloadImplications: manifest.models.length === 0
          ? 'no model assets declared; nothing is downloaded at install'
          : `${manifest.models.length} model asset set(s) declared; downloads require the separate preparation consent, never the install`,
        requiresApproval: manifest.permissions.nativeCode
          || manifest.permissions.networkOrigins.length > 0
          || manifest.permissions.storage !== 'none'
          || manifest.models.length > 0,
      })
    }

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

    /**
     * Make the RUNTIME SDK resolvable from inside the installed package.
     *
     * Without this the package lands in a directory with no `node_modules`, so an extension
     * that declares the SDK — which the protocol requires it to depend on — dies on its
     * first import with ERR_MODULE_NOT_FOUND. It is discoverable and activatable and cannot
     * RUN, which is the worst of the three states because nothing reports it as broken.
     *
     * A failure here is RECORDED rather than thrown: a package that imports nothing (a
     * declarative or tool-only extension) runs fine without the link, and failing the
     * install would break working packages to fix a problem they do not have.
     */
    runtimeLinkDiagnostic = linkRuntimeSdk(destination)

    /**
     * A SHADOWED RUNTIME FAILS THE INSTALL.
     *
     * If the package shipped its own copy of the host SDK, the extension would execute
     * against THAT copy while the operator was told the link was merely already present.
     * Installing it is worse than refusing, because the receipt would then describe a
     * containment the installation does not have. This is the one link outcome that is
     * fatal rather than reported.
     */
    if (runtimeLinkDiagnostic.reason === 'sdk-shadowed') {
      rmSync(destination, { recursive: true, force: true })
      throw new ManagementError(
        'INVALID_EXTENSION',
        'install',
        runtimeLinkDiagnostic.detail ?? 'the package ships its own copy of the host runtime SDK',
        'Remove node_modules/' + RUNTIME_SDK_NAME
          + ' from the package; an extension must run against the host runtime.',
      )
    }

    writeFileSync(join(destination, '.tool-mode-install.json'), `${JSON.stringify({
      extensionId: discovery.packageName,
      version: discovery.packageVersion,
      archiveDigest,
      ...runtimeLinkDiagnostic === undefined ? {} : { runtimeLink: runtimeLinkDiagnostic },
      source: { kind: options.source.kind, requested: options.source.requested },
      ...lockedDependencies.length === 0 ? {} : { dependencies: lockedDependencies },
      ...options.provenance === undefined ? {} : { provenance: options.provenance },
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
      ...runtimeLinkDiagnostic === undefined ? {} : { runtimeLink: runtimeLinkDiagnostic },
        // Digest the content as installed, so a later edit is detectable.
        contentDigest: digestInstalledContent(destination),
        source: { kind: options.source.kind, requested: options.source.requested },
        ...lockedDependencies.length === 0 ? {} : { dependencies: lockedDependencies },
        ...options.provenance === undefined ? {} : { provenance: options.provenance },
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
      ...runtimeLinkDiagnostic === undefined ? {} : { runtimeLink: runtimeLinkDiagnostic },
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