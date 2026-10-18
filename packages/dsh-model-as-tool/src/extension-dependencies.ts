/**
 * First-party dependency graphs for developer-mode extension installs (EXT-09).
 *
 * Installing a first-party package from its checkout must satisfy the SAME
 * discipline the SDK applies to a registry install: every declared runtime
 * dependency is resolved to an exact version, verified by content, and
 * materialized INSIDE the extension's own immutable installation directory. The
 * SDK owns that discipline (`installDependencyGraph`); this module supplies the
 * host half it deliberately leaves injected:
 *
 * - the RESOLVER: the exact version of a declared dependency is the one already
 *   installed in the host's own tree, found by walking `node_modules` upward from
 *   the source checkout exactly the way Node would. No registry request is made,
 *   no version is guessed, and a dependency that is not installed refuses the
 *   install instead of being skipped.
 * - the ARCHIVE: the resolved package directory is turned into a deterministic
 *   zip whose SHA-512 is the integrity the SDK verifies before extraction. The
 *   archive is an ordinary package archive — `node_modules` is excluded because
 *   the SDK resolves the transitive graph itself, and the package's declared
 *   install-time scripts are left in place so the SDK's own refusal (EXT-10)
 *   decides whether the dependency is admissible.
 *
 * Two properties matter for truthfulness:
 *
 * - **The host's node_modules is READ, never written.** The only write target is
 *   the SDK's staging directory, which becomes the extension's private
 *   `node_modules`; the resolver asserts this by construction (it has no write
 *   path outside the archive bytes).
 * - **A declaration is never silently dropped.** Every name the extension
 *   declares is either materialized or the whole install fails with a named
 *   `DEPENDENCY_UNSATISFIED` reason.
 *
 * INTEGRITY NOTE. The SDK's dependency lock records the SHA-512 of the archive
 * bytes it verified (`verifyIntegrity`), which is what this module computes. The
 * directory's own identity is additionally checked with the SDK's
 * `digestInstalledContent` before and after the archive is built, so a checkout
 * that changes while it is being archived refuses rather than shipping bytes that
 * no longer match what was resolved.
 *
 * @module @try-works/dsh-model-as-tool/extension-dependencies
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import {
  createZipArchiveSource,
  DEFAULT_ARCHIVE_LIMITS,
  digestInstalledContent,
  ManagementError,
  refuseInstallScripts,
  type ArchiveSource,
  type DependencyContent,
  type DependencyResolver,
  type InstallDependencyGraph,
  type InstallSource,
} from '@try-works/tool-mode-extension-sdk'

/** A package identity: one optional scope segment, then one name segment. */
const PACKAGE_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i

/**
 * The dependency archive byte cap.
 *
 * The SDK's `installDependencyGraph` calls `fetch` with a 256 MiB bound and
 * requires the source to enforce it, so this module refuses an archive it could
 * not truthfully hand over under that contract.
 */
export const MAX_DEPENDENCY_ARCHIVE_BYTES = 256 * 1024 * 1024

/** One dependency resolved from the host's own installed tree. */
export interface FirstPartyDependency {
  /** The package name, as declared. */
  readonly name: string
  /** The EXACT version recorded by the installed copy. */
  readonly version: string
  /** The absolute directory the installed copy occupies. */
  readonly directory: string
}

/** Where to look for installed dependencies. */
export interface DependencySearch {
  /** The checkout whose declared dependency is being installed. */
  readonly sourcePackageDir: string
  /**
   * Additional package roots searched after the source checkout's own ancestors.
   *
   * The host's own module directory is always searched, so a dependency installed
   * for the host (rather than for the extension checkout) is still found.
   */
  readonly extraSearchRoots?: readonly string[]
}

/** Bounds and seams for one first-party dependency graph. */
export interface FirstPartyDependencyGraphOptions extends DependencySearch {
  /** Total source bytes accepted per dependency; defaults to the SDK archive total bound. */
  readonly maxSourceBytes?: number
  /** Per-file bytes accepted; defaults to the SDK archive per-entry bound. */
  readonly maxEntryBytes?: number
  /** Archive bytes accepted per dependency; defaults to {@link MAX_DEPENDENCY_ARCHIVE_BYTES}. */
  readonly maxArchiveBytes?: number
  /** Forwarded to the SDK graph: maximum dependency depth. */
  readonly maxDepth?: number
  /** Forwarded to the SDK graph: maximum number of dependency packages. */
  readonly maxPackages?: number
  /**
   * The operator gate for PREINSTALLED dependency content (task-84).
   *
   * When true, a dependency resolved from the host's installed tree is supplied as
   * the already-materialized directory instead of being re-archived as bytes: the
   * SDK copies it into the extension's own install directory and records
   * `provenance: 'preinstalled'`, which states that the content arrived from an
   * operator-completed install and that this installer ran no lifecycle script.
   * DEFAULT OFF: without the gate, the bytes arm applies and a dependency whose
   * package.json declares an install-time script refuses exactly as before.
   */
  readonly allowPreinstalled?: boolean
  /**
   * The operator-configured root every preinstalled directory must live under.
   * REQUIRED when {@link FirstPartyDependencyGraphOptions.allowPreinstalled} is true;
   * the SDK enforces the containment, this factory refuses a gate with no root.
   */
  readonly preinstalledRoot?: string
}

/** The pieces, exposed so tests and diagnostics can inspect resolution without materializing. */
export interface FirstPartyDependencyGraph {
  /** The graph the SDK's directory installer consumes. */
  readonly graph: InstallDependencyGraph
  /** The resolver half, callable on its own. */
  readonly resolver: DependencyResolver
  /** The archive half, callable on its own. */
  readonly archive: ArchiveSource
}

/** The optional graph fields this factory copies only when they were configured. */
interface OptionalGraphFields {
  allowPreinstalled?: boolean
  preinstalledRoot?: string
  maxDepth?: number
  maxPackages?: number
}

/**
 * Refuse an identity that cannot safely become a path component.
 * @param name - the declared dependency name.
 * @throws ManagementError `DEPENDENCY_UNSATISFIED` for an unusable name.
 */
function assertUsableName(name: string): void {
  if (!PACKAGE_ID.test(name)) {
    throw new ManagementError(
      'DEPENDENCY_UNSATISFIED',
      'install',
      `${JSON.stringify(name)} is not a package name; a dependency declaration must be a name like @scope/name`,
      'Correct the dependency name in the extension package.json.',
    )
  }
}

/** Read one installed package's identity, or undefined when it is not a package. */
function readInstalledPackage(directory: string, expectedName: string): FirstPartyDependency | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  // SAFETY: the value came from JSON.parse and the object guard above; every field
  // is re-checked (name equality, string version) before it reaches the caller, so
  // an unexpected shape is treated as "not this package" rather than trusted.
  const recorded = parsed as { readonly name?: unknown; readonly version?: unknown }
  const name = recorded.name
  const version = recorded.version
  if (name !== expectedName) return undefined
  if (typeof version !== 'string' || version.length === 0) return undefined
  return { name: expectedName, version, directory }
}

/**
 * Look for a package in the `node_modules` directory of a starting point and every
 * ancestor, exactly the order Node's own resolver applies.
 * @param start - a directory inside the requesting tree.
 * @param name - the dependency name.
 * @returns the installed package, or undefined when no ancestor holds it.
 */
function walkNodeModules(start: string, name: string): FirstPartyDependency | undefined {
  let current = resolve(start)
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = join(current, 'node_modules', ...name.split('/'))
    if (existsSync(join(candidate, 'package.json'))) {
      const found = readInstalledPackage(candidate, name)
      if (found !== undefined) return found
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** The host's own module directory: the fallback tree for host-installed dependencies. */
function hostModuleDirectory(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/**
 * Resolve one declared dependency from the host's installed tree.
 *
 * The source checkout's own ancestor chain is searched first (the tree whose
 * `package.json` declared the dependency), then the host's own module chain, then
 * any explicitly configured roots. The first installed package whose own
 * `package.json` name matches wins; nothing is downloaded and no version is
 * inferred.
 * @param search - where to look.
 * @param name - the declared dependency name.
 * @param range - the declared spec, used only in the refusal message.
 * @returns the installed dependency.
 * @throws ManagementError `DEPENDENCY_UNSATISFIED` when it is not installed.
 */
export function resolveFirstPartyDependency(
  search: DependencySearch,
  name: string,
  range: string,
): FirstPartyDependency {
  assertUsableName(name)
  const origins = [resolve(search.sourcePackageDir), hostModuleDirectory()]
  for (const origin of origins) {
    const found = walkNodeModules(origin, name)
    if (found !== undefined) return found
  }
  for (const root of search.extraSearchRoots ?? []) {
    const candidate = join(resolve(root), 'node_modules', ...name.split('/'))
    if (existsSync(join(candidate, 'package.json'))) {
      const found = readInstalledPackage(candidate, name)
      if (found !== undefined) return found
    }
  }
  throw new ManagementError(
    'DEPENDENCY_UNSATISFIED',
    'install',
    `${name} (declared as ${JSON.stringify(range)}) is not installed anywhere in the host's own dependency tree, `
      + 'so it cannot be materialized into the extension',
    'Install the dependency for the host first (or bundle it with the extension); the installer never downloads '
      + 'dependencies for a source-directory install and never silently drops a declared one.',
  )
}

/** One file selected for the dependency archive. */
interface ArchivedFile {
  /** Path relative to the package root, using `/` separators. */
  readonly relative: string
  /** Absolute source path. */
  readonly absolute: string
  /** File size in bytes. */
  readonly size: number
}

/**
 * Collect a package directory's files as archive entries.
 *
 * `node_modules` is skipped (the SDK resolves the transitive graph through this
 * same resolver), and any symbolic link or junction inside the tree is REFUSED
 * rather than followed: a link is how a package reaches bytes outside the content
 * that was resolved.
 * @param root - the package directory.
 * @param limits - the byte bounds.
 * @returns the selected files, in sorted walk order.
 */
function collectPackageFiles(
  root: string,
  limits: { readonly maxSourceBytes: number; readonly maxEntryBytes: number },
): readonly ArchivedFile[] {
  const files: ArchivedFile[] = []
  let totalBytes = 0
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        throw new ManagementError(
          'DEPENDENCY_UNSATISFIED',
          'install',
          `the installed dependency contains a symbolic link at ${absolute}; a link makes the archived content differ from the content that was resolved`,
          'Repair the installed dependency so the tree contains plain files, then retry.',
        )
      }
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(absolute)
        continue
      }
      if (!entry.isFile()) {
        throw new ManagementError(
          'DEPENDENCY_UNSATISFIED',
          'install',
          `the installed dependency contains ${absolute}, which is neither a file nor a directory`,
          'Repair the installed dependency, then retry.',
        )
      }
      const size = lstatSync(absolute).size
      if (size > limits.maxEntryBytes) {
        throw new ManagementError(
          'DEPENDENCY_UNSATISFIED',
          'install',
          `the dependency file ${absolute} is ${size} bytes, over the ${limits.maxEntryBytes}-byte per-file bound`,
          'Use a dependency whose individual files fit the archive bounds, or install it outside the extension.',
        )
      }
      totalBytes += size
      if (totalBytes > limits.maxSourceBytes) {
        throw new ManagementError(
          'DEPENDENCY_UNSATISFIED',
          'install',
          `the dependency tree at ${root} is over the ${limits.maxSourceBytes}-byte archive bound`,
          'Use a dependency whose installed tree fits the bounds, or install it outside the extension.',
        )
      }
      files.push({ relative: relativePath(root, absolute), absolute, size })
    }
  }
  walk(root)
  if (files.length === 0) {
    throw new ManagementError(
      'DEPENDENCY_UNSATISFIED',
      'install',
      `the installed dependency at ${root} contains no files`,
      'Repair the installed dependency, then retry.',
    )
  }
  return files
}

/** A path relative to the package root, using `/` separators for the archive. */
function relativePath(root: string, absolute: string): string {
  return relative(resolve(root), absolute).split('\\').join('/')
}

/** Whether a directory is the root or lives underneath it. */
function isUnder(root: string, candidate: string): boolean {
  const rootPath = resolve(root)
  const candidatePath = resolve(candidate)
  if (candidatePath === rootPath) return true
  const relativePathFromRoot = relative(rootPath, candidatePath)
  return relativePathFromRoot.length > 0 && !relativePathFromRoot.startsWith('..') && !isAbsolute(relativePathFromRoot)
}

/** The archive built for one resolved dependency. */
interface BuiltDependencyArchive {
  /** The exact bytes the graph's archive source will serve. */
  readonly bytes: Uint8Array
  /** SHA-512 of those bytes: the integrity the SDK verifies before extraction. */
  readonly integrity: string
  /** The installed tree's own content digest, checked around the build. */
  readonly contentDigest: string
}

/**
 * Build a deterministic zip of one installed dependency directory.
 *
 * The result is the archive the SDK's dependency graph fetches and verifies. Its
 * SHA-512 is the integrity handed to the graph; the directory's own
 * `digestInstalledContent` is checked before and after the build so a concurrent
 * change refuses.
 * @param dependency - the resolved installed dependency.
 * @param limits - the byte bounds.
 * @returns the archive bytes, their integrity, and the directory digest.
 * @throws ManagementError `DEPENDENCY_UNSATISFIED` for any refusal.
 */
export function buildDependencyArchive(
  dependency: FirstPartyDependency,
  limits: {
    readonly maxSourceBytes: number
    readonly maxEntryBytes: number
    readonly maxArchiveBytes: number
  },
): BuiltDependencyArchive {
  const files = collectPackageFiles(dependency.directory, limits)
  // The same content-digest discipline the SDK applies to a directory install:
  // the tree's identity is checked around the build, so the archive cannot be
  // assembled from a tree that changed while it was being read.
  let before: string
  try {
    before = digestInstalledContent(dependency.directory)
  } catch (error) {
    throw new ManagementError(
      'DEPENDENCY_UNSATISFIED',
      'install',
      `the installed dependency ${dependency.name}@${dependency.version} could not be digested: ${error instanceof Error ? error.message : String(error)}`,
      'Repair the installed dependency so every file is readable, then retry.',
    )
  }
  const zip = new AdmZip()
  for (const file of files) zip.addFile(file.relative, readFileSync(file.absolute))
  const bytes = new Uint8Array(zip.toBuffer())
  if (bytes.byteLength > limits.maxArchiveBytes) {
    throw new ManagementError(
      'DEPENDENCY_UNSATISFIED',
      'install',
      `the dependency ${dependency.name}@${dependency.version} archives to ${bytes.byteLength} bytes, over the ${limits.maxArchiveBytes}-byte dependency bound`,
      'Use a dependency whose archive fits the installer bound, or install it outside the extension.',
    )
  }
  const after = digestInstalledContent(dependency.directory)
  if (before !== after) {
    throw new ManagementError(
      'DEPENDENCY_UNSATISFIED',
      'install',
      `the installed dependency ${dependency.name}@${dependency.version} changed while it was being archived`,
      'Make sure nothing is installing into the host tree, then retry.',
    )
  }
  return {
    bytes,
    integrity: createHash('sha512').update(bytes).digest('hex'),
    contentDigest: after,
  }
}

/**
 * How this host can supply one declared dependency.
 *
 * This is the narrow seam between the host's resolution policy and the SDK's
 * dependency graph: `registry-bytes` is the verified-archive path (the SDK verifies
 * the SHA-512 and extracts the bytes), and `preinstalled` is the operator-gated
 * path (the SDK copies an already-materialized directory and records
 * `provenance: 'preinstalled'`, never running a lifecycle script).
 */
export type DependencySupply =
  | {
      /** The host built verified archive bytes for this dependency. */
      readonly kind: 'registry-bytes'
      readonly dependency: FirstPartyDependency
      /** SHA-512 of exactly the bytes `archive.fetch` will serve. */
      readonly integrity: string
      readonly bytes: Uint8Array
    }
  | {
      /** The host has an already-materialized installation for this dependency. */
      readonly kind: 'preinstalled'
      readonly dependency: FirstPartyDependency
      /** Documented by the SDK to mean: no lifecycle script was run by this installer. */
      readonly provenance: 'preinstalled'
    }

/**
 * Decide how this host supplies one dependency, applying the operator gate.
 *
 * With the preinstalled gate on, the resolved directory is returned as-is (the SDK
 * copies it and records provenance; scripts are not run and are NOT stripped).
 * With the gate off, the bytes arm applies: the SDK's EXT-10 refusal is consulted
 * BEFORE any archive is built, so a script-declaring dependency refuses cheaply
 * with the SDK's exact named error, then the archive is built and its SHA-512 is
 * returned as the integrity the SDK will verify.
 * @param options - the search tree and gate.
 * @param limits - the archive bounds used by the bytes arm.
 * @param name - the declared dependency name.
 * @param range - the declared dependency spec, for refusals.
 * @returns the supply decision.
 * @throws ManagementError `DEPENDENCY_UNSATISFIED` for every refusal.
 */
function resolveDependency(
  options: FirstPartyDependencyGraphOptions,
  limits: { readonly maxSourceBytes: number; readonly maxEntryBytes: number; readonly maxArchiveBytes: number },
  name: string,
  range: string,
): DependencySupply {
  const dependency = resolveFirstPartyDependency(options, name, range)
  if (options.allowPreinstalled === true) {
    const root = options.preinstalledRoot
    if (root === undefined || !isUnder(root, dependency.directory)) {
      throw new ManagementError(
        'DEPENDENCY_UNSATISFIED',
        'install',
        `${dependency.name}@${dependency.version} is installed at ${dependency.directory}, outside the operator-configured preinstalled root ${root ?? '(none configured)'}; preinstalled content may only be copied from inside that root`,
        'Configure the preinstalled-dependency root so it contains the host tree this dependency was installed into.',
      )
    }
    return { kind: 'preinstalled', dependency, provenance: 'preinstalled' }
  }
  // The SDK's own EXT-10 gate runs before any bytes are built: a dependency that
  // declares an install-time script refuses here with the SDK's exact named error
  // instead of after a full archive/extract cycle. The SDK checks again after
  // extraction; this copy is the cheap, identical refusal.
  refuseInstallScripts(dependency.directory, dependency.name, dependency.version)
  const built = buildDependencyArchive(dependency, limits)
  return { kind: 'registry-bytes', dependency, integrity: built.integrity, bytes: built.bytes }
}

/**
 * Create the first-party dependency graph supplied to the SDK's directory installer.
 *
 * Resolution and archiving happen lazily, one dependency at a time: `resolve`
 * builds the exact bytes the SDK will verify and `fetch` hands back those same
 * bytes, so the integrity the lock records is the integrity of the served archive
 * rather than a value guessed from metadata. Only the most recently built archive
 * is retained, which matches the SDK's resolve-then-fetch sequence and bounds
 * memory to one dependency.
 *
 * The preinstalled-content gate is OPT-IN and OFF by default, matching the SDK:
 * without it every dependency is served as verified bytes and EXT-10 applies. With
 * it, the SDK requires `preinstalledRoot`, copies the resolved directory into the
 * extension's own `node_modules`, and records `provenance: 'preinstalled'`.
 * @param options - the search tree, bounds, gate and forwarded graph limits.
 * @returns the install-dependency graph plus its resolver and archive halves.
 * @throws ManagementError `DEPENDENCY_UNSATISFIED` when the gate has no root.
 */
export function createFirstPartyDependencyGraph(
  options: FirstPartyDependencyGraphOptions,
): FirstPartyDependencyGraph {
  const limits = {
    maxSourceBytes: options.maxSourceBytes ?? DEFAULT_ARCHIVE_LIMITS.maxTotalBytes,
    maxEntryBytes: options.maxEntryBytes ?? DEFAULT_ARCHIVE_LIMITS.maxEntryBytes,
    maxArchiveBytes: options.maxArchiveBytes ?? MAX_DEPENDENCY_ARCHIVE_BYTES,
  }
  let preinstalledGate: { readonly allowPreinstalled: true; readonly preinstalledRoot: string } | undefined
  if (options.allowPreinstalled === true) {
    const root = options.preinstalledRoot
    if (root === undefined || root.trim().length === 0) {
      throw new ManagementError(
        'DEPENDENCY_UNSATISFIED',
        'install',
        'the preinstalled-dependency gate is enabled but no operator-configured preinstalled root was supplied',
        'Configure the root directory that contains the host dependency tree, or leave the gate off.',
      )
    }
    preinstalledGate = { allowPreinstalled: true, preinstalledRoot: resolve(root) }
  }
  /** The archive built by the most recent resolve, keyed by name@version. */
  let latest: { readonly key: string; readonly bytes: Uint8Array } | undefined
  const keyOf = (name: string, version: string): string => `${name}@${version}`

  const resolver: DependencyResolver = {
    async resolve(name, range): Promise<DependencyContent> {
      const supply = resolveDependency(options, limits, name, range)
      const key = keyOf(supply.dependency.name, supply.dependency.version)
      if (supply.kind === 'preinstalled') {
        return {
          name: supply.dependency.name,
          version: supply.dependency.version,
          dir: supply.dependency.directory,
          provenance: 'preinstalled',
        }
      }
      latest = { key, bytes: supply.bytes }
      return {
        name: supply.dependency.name,
        version: supply.dependency.version,
        tarball: { kind: 'local', requested: key } satisfies InstallSource,
        integrity: supply.integrity,
      }
    },
  }

  const archive = createZipArchiveSource(async source => {
    if (latest === undefined || latest.key !== source.requested) {
      throw new ManagementError(
        'DEPENDENCY_UNSATISFIED',
        'install',
        `the dependency archive ${source.requested} was not built by the resolver, so it cannot be served`,
        'Retry the install; the graph builds each archive immediately before the SDK fetches it.',
      )
    }
    if (latest.bytes.byteLength > MAX_DEPENDENCY_ARCHIVE_BYTES) {
      throw new ManagementError(
        'DEPENDENCY_UNSATISFIED',
        'install',
        `the dependency archive ${source.requested} is ${latest.bytes.byteLength} bytes, over the ${MAX_DEPENDENCY_ARCHIVE_BYTES}-byte fetch bound`,
        'Use a dependency whose archive fits the installer bound.',
      )
    }
    return latest.bytes
  })

  /** The optional graph fields, added only when configured (no empty-object spreads). */
  const optionalGraphFields: OptionalGraphFields = {}
  if (preinstalledGate !== undefined) {
    optionalGraphFields.allowPreinstalled = preinstalledGate.allowPreinstalled
    optionalGraphFields.preinstalledRoot = preinstalledGate.preinstalledRoot
  }
  if (options.maxDepth !== undefined) optionalGraphFields.maxDepth = options.maxDepth
  if (options.maxPackages !== undefined) optionalGraphFields.maxPackages = options.maxPackages
  const graph: InstallDependencyGraph = {
    resolver,
    archive,
    ...optionalGraphFields,
  }
  return { graph, resolver, archive }
}

/** Re-export for callers that want the size bound wording. */
export { DEFAULT_ARCHIVE_LIMITS }
