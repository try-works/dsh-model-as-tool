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

import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ManagementError } from './../errors.ts'
import { verifyIntegrity } from './archive.ts'
import type { ArchiveSource, InstallSource } from './staged.ts'

/** One locked runtime dependency (EXT-12's dependency-lock record). */
export interface LockedDependency {
  /** The package name, e.g. `@acme/lib`. */
  readonly name: string
  /** The EXACT version the range resolved to. */
  readonly version: string
  /** The registry-recorded SHA-512 (lowercase hex) that was verified. */
  readonly integrity: string
  /** The requested spec, recorded verbatim for the audit trail. */
  readonly resolvedFrom: string
}

/** The injected registry half: resolve a name/range to an exact tarball. */
export interface DependencyResolver {
  /**
   * Resolve a name and version spec ONCE to an exact version, its tarball
   * source and the registry-recorded integrity.
   * @param name - the package name.
   * @param range - the declared spec (an exact version or a range).
   */
  resolve(name: string, range: string): Promise<{ name: string; version: string; tarball: InstallSource; integrity: string }>
}

/** Bounds and providers for one dependency installation. */
export interface InstallDependencyGraph {
  readonly resolver: DependencyResolver
  readonly archive: ArchiveSource
  readonly maxDepth?: number
  readonly maxPackages?: number
}

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

/**
 * Resolve, fetch, verify and materialize one extension's dependency graph.
 *
 * Bounded BFS: ranges resolve exactly once, tarballs verify against their
 * registry integrity, scripts are refused, and the graph is flattened into
 * the extension's own `node_modules` (a private root — no hoisting into any
 * other tree). Version conflicts within one graph are REFUSED rather than
 * silently duplicated; the count and depth caps refuse runaway graphs by name.
 *
 * @param packageDir - the extracted extension package directory.
 * @param graph - the injected resolver/archive plus the bounds.
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
