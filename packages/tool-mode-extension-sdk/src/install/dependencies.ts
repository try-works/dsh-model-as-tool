/**
 * Installer-owned dependency graphs (EXT-09).
 *
 * An extension's runtime dependencies are resolved through the operator's
 * registry EXACTLY ONCE (ranges lock to exact versions), fetched, verified
 * against their registry-recorded SHA-512, and materialized into the
 * extension's OWN immutable installation directory — never the host's
 * node_modules, never the user's workspace. Lifecycle scripts are refused,
 * never silently skipped or run: a dependency whose package declares
 * `prepare`/`preinstall`/`install`/`postinstall` refuses the install with a
 * named error. The resolved graph (name, exact version, integrity, requested
 * spec) is recorded in the install record (EXT-12).
 *
 * The registry half is INJECTED, like the archive source: the SDK owns the
 * graph discipline, the host supplies the configured registry and the tarball
 * transport. An extension's runtime can only import what this installer
 * materialized — undeclared resolution attempts fail at module load, because
 * the runtime SDK link is the only bridge into the host tree.
 *
 * @module @try-works/tool-mode-extension-sdk/install/dependencies
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ManagementError } from './../errors.ts'
import { verifyIntegrity } from './archive.ts'
import type { ArchiveSource, InstallSource } from './staged.ts'

/** One locked runtime dependency (EXT-12's dependency-lock record). */
export interface LockedDependency {
  /** The package name, e.g. `@acme/lib`. */
  readonly name: string
  /** The EXACT version the range resolved to. */
  readonly version: string
  /**
   * Registry arm: the registry-recorded SHA-512 that was verified.
   * Preinstalled arm: the SHA-256 content digest of the EXACT bytes the
   * installer copied into the extension's own tree (never a digest the
   * resolver supplied, so the record covers what was actually materialized).
   */
  readonly integrity: string
  /** The requested spec, recorded verbatim for the audit trail. */
  readonly resolvedFrom: string
  /**
   * How the content arrived. ABSENT means the registry arm — existing locks
   * and install records stay valid without this field.
   *
   * `'preinstalled'` IS the "scripts were not run by the installer" statement:
   * the content arrived already materialized by a completed host install, so
   * this installer ran NO lifecycle script on it — the package.json's scripts
   * field is left untouched, never stripped and never executed (EXT-10's
   * never-silently-skip rule is honored by provenance, not by editing bytes).
   */
  readonly provenance?: 'registry' | 'preinstalled'
  /**
   * Present exactly when `provenance` is `'preinstalled'`: the operator-supplied
   * source directory the content was copied from, as the resolver returned it.
   */
  readonly preinstalledFrom?: string
}

/** One dependency the resolver supplies: registry bytes or preinstalled content. */
export type DependencyContent =
  | {
    readonly name: string
    readonly version: string
    readonly tarball: InstallSource
    readonly integrity: string
    readonly provenance?: 'registry'
  }
  | {
    readonly name: string
    readonly version: string
    readonly dir: string
    readonly provenance: 'preinstalled'
  }

/** The injected registry half: resolve a name/range to an exact dependency. */
export interface DependencyResolver {
  /**
   * Resolve a name and version spec ONCE to an exact version. The registry arm
   * returns the tarball source and the registry-recorded integrity; the
   * preinstalled arm returns an operator-approved materialized directory — the
   * installer copies it and computes its own digest from the copied bytes.
   * @param name - the package name.
   * @param range - the declared spec (an exact version or a range).
   */
  resolve(name: string, range: string): Promise<DependencyContent>
}

/** Bounds and providers for one dependency installation. */
export interface InstallDependencyGraph {
  readonly resolver: DependencyResolver
  readonly archive: ArchiveSource
  readonly maxDepth?: number
  readonly maxPackages?: number
  /**
   * The OPT-IN operator gate for preinstalled content. ABSENT (the default)
   * means any preinstalled-armed resolve result REFUSES by name — a normal
   * install of script-declaring registry bytes still refuses under EXT-10.
   */
  readonly allowPreinstalled?: boolean
  /**
   * The operator-configured root every preinstalled directory must live
   * under. REQUIRED when `allowPreinstalled` is true; the installer refuses a
   * directory outside it (path-escape refusal) rather than copying.
   */
  readonly preinstalledRoot?: string
  /** One preinstalled copy's size bound in bytes. Default 512 MiB. */
  readonly maxPreinstalledBytes?: number
  /** One preinstalled copy's file-count bound. Default 10 000. */
  readonly maxPreinstalledFiles?: number
}

/** The defaults for one preinstalled-content copy. */
const DEFAULT_PREINSTALLED_BYTES = 512 * 1024 * 1024
const DEFAULT_PREINSTALLED_FILES = 10_000

/** The install-time lifecycle scripts whose presence is a refusal, never a skip. */
const REFUSED_SCRIPTS: readonly string[] = ['prepare', 'preinstall', 'install', 'postinstall']

/** Read a package.json's runtime dependencies as name→spec pairs. */
function declaredDependencies(packageDir: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  } catch (error) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'install',
      `the package.json could not be read: ${error instanceof Error ? error.message : String(error)}`,
      'The archive must ship a parseable package.json.',
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ManagementError('INVALID_EXTENSION', 'install', 'the package.json is not an object', 'Ship a valid package.json.')
  }
  const dependencies = (parsed as Record<string, unknown>)['dependencies']
  if (dependencies === undefined) return {}
  if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'install',
      'the package.json dependencies field is not a name→version object',
      'Declare runtime dependencies as a plain object of exact versions or ranges.',
    )
  }
  const result: Record<string, string> = {}
  for (const [name, spec] of Object.entries(dependencies as Record<string, unknown>)) {
    if (typeof spec !== 'string' || spec.length === 0) {
      throw new ManagementError(
        'INVALID_EXTENSION',
        'install',
        `the dependency ${JSON.stringify(name)} declares a non-string spec`,
        'Declare a version string for every runtime dependency.',
      )
    }
    result[name] = spec
  }
  return result
}

/** Refuse a dependency whose package declares install-time lifecycle scripts. */
export function refuseInstallScripts(packageDir: string, name: string, version: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  } catch (error) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'install',
      `the dependency ${name}@${version} ships an unparseable package.json: ${error instanceof Error ? error.message : String(error)}`,
      'The dependency tarball must ship a parseable package.json.',
    )
  }
  if (typeof parsed !== 'object' || parsed === null) return
  const scripts = (parsed as Record<string, unknown>)['scripts']
  if (typeof scripts !== 'object' || scripts === null) return
  for (const key of REFUSED_SCRIPTS) {
    if (key in scripts) {
      throw new ManagementError(
        'DEPENDENCY_UNSATISFIED',
        'install',
        `${name}@${version} declares a "${key}" lifecycle script; the installer never runs or silently skips install-time scripts (EXT-10)`,
        'Publish a version of the dependency that needs no install-time script (prebuilt artifacts only), or pin a different version.',
      )
    }
  }
}

/** The content digest of one materialized tree (the digestInstalledContent algorithm). */
function digestContentOf(directory: string): string {
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
 * Copy one preinstalled directory tree into the extension's own install dir.
 *
 * A COPY, never a link: the operator's host tree stays untouched and the
 * extension owns its bytes. Reparse points inside the tree are refused (the
 * same junction defense the archive path gets), and the copy is bounded.
 */
function copyPreinstalledTree(
  source: string,
  destination: string,
  limits: { readonly files: number; readonly bytes: number },
): void {
  mkdirSync(destination, { recursive: true })
  let files = 0
  let bytes = 0
  const walk = (from: string, to: string): void => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const fromPath = join(from, entry.name)
      const toPath = join(to, entry.name)
      if (entry.isSymbolicLink() || (entry.isFile() === false && entry.isDirectory() === false)) {
        throw new ManagementError(
          'DEPENDENCY_UNSATISFIED',
          'install',
          `${fromPath} is a reparse point; preinstalled content must not smuggle links into the installation`,
          'Point at a real directory tree, or resolve the dependency from registry bytes.',
        )
      }
      if (entry.isDirectory()) {
        walk(fromPath, toPath)
        continue
      }
      files += 1
      bytes += statSync(fromPath).size
      if (files > limits.files || bytes > limits.bytes) {
        throw new ManagementError(
          'DEPENDENCY_UNSATISFIED',
          'install',
          `the preinstalled content exceeds the copy bounds (${limits.files} files / ${limits.bytes} bytes)`,
          'Raise the operator bounds deliberately, or resolve the dependency from registry bytes.',
        )
      }
      copyFileSync(fromPath, toPath)
    }
  }
  walk(source, destination)
}

/**
 * Resolve, fetch, verify and materialize one extension's dependency graph.
 *
 * Bounded BFS: ranges resolve exactly once, registry tarballs verify against
 * their registry integrity, scripts are refused on the registry arm, and the
 * graph is flattened into the extension's own `node_modules` (a private root —
 * no hoisting into any other tree). Version conflicts within one graph are
 * REFUSED rather than silently duplicated; the count and depth caps refuse
 * runaway graphs by name.
 *
 * The PREINSTALLED arm is operator-gated: only when `allowPreinstalled` is set
 * does a resolver-supplied directory get copied (bounded, path-escape-checked
 * against `preinstalledRoot`, reparse-point-refused) into the extension's own
 * tree, with the record's provenance stating that the installer ran no
 * lifecycle script on it.
 *
 * @param packageDir - the extracted extension package directory.
 * @param graph - the injected resolver/archive plus the bounds and the gate.
 * @returns the locked dependency records, in materialization order.
 */
export async function installDependencyGraph(
  packageDir: string,
  graph: InstallDependencyGraph,
): Promise<readonly LockedDependency[]> {
  const maxDepth = graph.maxDepth ?? 3
  const maxPackages = graph.maxPackages ?? 64
  const declared = declaredDependencies(packageDir)
  if (Object.keys(declared).length === 0) return []

  const nodeModules = join(packageDir, 'node_modules')
  const locked: LockedDependency[] = []
  const visited = new Set<string>()
  const hoisted = new Map<string, string>() // name -> exact version already materialized
  const queue: { name: string; range: string; depth: number }[] = Object.entries(declared)
    .map(([name, range]) => ({ name, range, depth: 0 }))

  while (queue.length > 0) {
    const entry = queue.shift() as { name: string; range: string; depth: number }
    if (visited.has(`${entry.name}@${entry.range}`)) continue
    visited.add(`${entry.name}@${entry.range}`)
    if (entry.depth > maxDepth) {
      throw new ManagementError(
        'DEPENDENCY_UNSATISFIED',
        'install',
        `the dependency graph exceeds the ${maxDepth}-level depth bound at ${entry.name}`,
        'Flatten the dependency tree or raise the operator bound deliberately.',
      )
    }
    if (locked.length >= maxPackages && !hoisted.has(entry.name)) {
      throw new ManagementError(
        'DEPENDENCY_UNSATISFIED',
        'install',
        `the dependency graph exceeds the ${maxPackages}-package bound`,
        'Reduce the graph or raise the operator bound deliberately.',
      )
    }

    const resolvedEntry = await graph.resolver.resolve(entry.name, entry.range)
    const existing = hoisted.get(resolvedEntry.name)
    if (existing !== undefined && existing !== resolvedEntry.version) {
      throw new ManagementError(
        'DEPENDENCY_UNSATISFIED',
        'install',
        `the dependency graph needs both ${resolvedEntry.name}@${existing} and ${resolvedEntry.name}@${resolvedEntry.version}; `
          + 'conflicting versions inside one extension are refused rather than silently duplicated',
        'Pin the two requesters to one version, or publish a compatible version.',
      )
    }
    if (existing !== undefined) {
      // Already materialized at the same exact version: nothing more to fetch.
      const transitive = declaredDependencies(join(nodeModules, resolvedEntry.name))
      for (const [childName, childRange] of Object.entries(transitive)) {
        if (!visited.has(`${childName}@${childRange}`)) queue.push({ name: childName, range: childRange, depth: entry.depth + 1 })
      }
      continue
    }

    if (resolvedEntry.provenance === 'preinstalled') {
      // The preinstalled arm: operator-gated, boundary-checked, copied (never
      // linked), digested from the copied bytes, and recorded truthfully.
      if (graph.allowPreinstalled !== true) {
        throw new ManagementError(
          'DEPENDENCY_UNSATISFIED',
          'install',
          `${resolvedEntry.name}@${resolvedEntry.version} resolved to preinstalled content, but the preinstalled source is not enabled by the operator (allowPreinstalled)`,
          'Enable the preinstalled source deliberately for this install, or resolve the dependency from registry bytes.',
        )
      }
      if (graph.preinstalledRoot === undefined) {
        throw new ManagementError(
          'DEPENDENCY_UNSATISFIED',
          'install',
          'preinstalled content requires an operator-configured preinstalledRoot so the source boundary can be enforced',
          'Set preinstalledRoot to the directory that holds the host-tree packages.',
        )
      }
      const root = resolve(graph.preinstalledRoot)
      const dir = resolve(resolvedEntry.dir)
      const rel = relative(root, dir)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || !existsSync(dir)) {
        throw new ManagementError(
          'DEPENDENCY_UNSATISFIED',
          'install',
          `the preinstalled directory ${dir} is outside the operator-configured root ${root} (path-escape refused)`,
          'Only preinstalled directories inside preinstalledRoot may be copied.',
        )
      }
      // Honesty check: the content must BE the package the resolver claims.
      let dirPackage: { name?: unknown; version?: unknown }
      try {
        const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
        dirPackage = parsed
      } catch (error) {
        throw new ManagementError(
          'DEPENDENCY_UNSATISFIED',
          'install',
          `the preinstalled content at ${dir} ships an unreadable package.json: ${error instanceof Error ? error.message : String(error)}`,
          'Preinstalled content must ship a parseable package.json.',
        )
      }
      if (dirPackage.name !== resolvedEntry.name || dirPackage.version !== resolvedEntry.version) {
        throw new ManagementError(
          'DEPENDENCY_UNSATISFIED',
          'install',
          `the preinstalled content at ${dir} is ${String(dirPackage.name)}@${String(dirPackage.version)}, not the resolved ${resolvedEntry.name}@${resolvedEntry.version}`,
          'Point at the directory that actually holds the resolved package.',
        )
      }
      const attempt = join(nodeModules, `.dep-${process.pid}-${Date.now().toString(36)}`)
      mkdirSync(attempt, { recursive: true })
      try {
        // The scripts field is left UNTOUCHED and NO lifecycle script is run:
        // the content arrived already materialized by a completed host install,
        // and provenance:'preinstalled' records exactly that.
        copyPreinstalledTree(dir, attempt, {
          files: graph.maxPreinstalledFiles ?? DEFAULT_PREINSTALLED_FILES,
          bytes: graph.maxPreinstalledBytes ?? DEFAULT_PREINSTALLED_BYTES,
        })
        const digest = digestContentOf(attempt)
        const destination = join(nodeModules, resolvedEntry.name)
        mkdirSync(join(destination, '..'), { recursive: true })
        renameSync(attempt, destination)
        hoisted.set(resolvedEntry.name, resolvedEntry.version)
        locked.push({
          name: resolvedEntry.name,
          version: resolvedEntry.version,
          integrity: digest,
          resolvedFrom: entry.range,
          provenance: 'preinstalled',
          preinstalledFrom: resolvedEntry.dir,
        })
        const transitive = declaredDependencies(destination)
        for (const [childName, childRange] of Object.entries(transitive)) {
          if (!visited.has(`${childName}@${childRange}`)) queue.push({ name: childName, range: childRange, depth: entry.depth + 1 })
        }
      } finally {
        rmSync(attempt, { recursive: true, force: true })
      }
      continue
    }

    const bytes = await graph.archive.fetch(resolvedEntry.tarball, {
      maxBytes: 256 * 1024 * 1024,
      timeoutMs: 120_000,
    })
    const digest = verifyIntegrity(bytes, resolvedEntry.integrity)

    const attempt = join(nodeModules, `.dep-${process.pid}-${Date.now().toString(36)}`)
    mkdirSync(attempt, { recursive: true })
    try {
      // The archive source strips the package root itself (the same contract
      // stagedInstall relies on), so the extracted content IS the package.
      graph.archive.extract(bytes, attempt, '')
      refuseInstallScripts(attempt, resolvedEntry.name, resolvedEntry.version)
      const destination = join(nodeModules, resolvedEntry.name)
      mkdirSync(join(destination, '..'), { recursive: true })
      renameSync(attempt, destination)
      hoisted.set(resolvedEntry.name, resolvedEntry.version)
      locked.push({
        name: resolvedEntry.name,
        version: resolvedEntry.version,
        integrity: digest,
        resolvedFrom: entry.range,
      })
      const transitive = declaredDependencies(destination)
      for (const [childName, childRange] of Object.entries(transitive)) {
        if (!visited.has(`${childName}@${childRange}`)) queue.push({ name: childName, range: childRange, depth: entry.depth + 1 })
      }
    } finally {
      rmSync(attempt, { recursive: true, force: true })
    }
  }
  return locked
}
