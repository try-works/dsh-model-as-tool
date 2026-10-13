/**
 * Bounded static discovery (EXT-13).
 *
 * Discovery reads a package as DATA and never imports it. That ordering is the
 * security property, not an optimization: installation must not execute the
 * package, so the host inspects `package.json` and the manifest, decides whether
 * the package is acceptable, and only then considers running anything.
 *
 * Every read is bounded by a byte limit and every path is confined to the package
 * directory, so a hostile package cannot make discovery read an arbitrary file or
 * allocate without limit.
 *
 * @module @try-works/tool-mode-extension-sdk/discovery
 */

import { readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { ManagementError } from './errors.ts'
import { MAX_MANIFEST_BYTES, validateManifest, type ExtensionManifest } from './manifest.ts'

/** Largest `package.json` accepted, in bytes. */
export const MAX_PACKAGE_JSON_BYTES = 256 * 1024

/** What discovery learns about a package without running any of it. */
export interface ExtensionDiscovery {
  /** The package name from `package.json`. */
  readonly packageName: string
  /** The package version from `package.json`. */
  readonly packageVersion: string
  /** Absolute path of the unpacked package directory. */
  readonly packageDir: string
  /** Absolute path of the manifest the `toolMode.manifest` field names. */
  readonly manifestPath: string
  /**
   * Absolute path of the public `./tool-mode` entry, resolved from the package's
   * own `exports` map. Undefined for a declarative package, which has no module
   * entry to import.
   */
  readonly entryPath?: string
  /** The validated manifest. */
  readonly manifest: ExtensionManifest
  /** The declared public exports, which discovery requires to be explicit. */
  readonly exports: readonly string[]
}

/**
 * Resolve a `./tool-mode` export target to a path.
 *
 * An export value is either a string or a conditions object, and both appear in
 * real packages. The entry is read from the declaration rather than guessed from
 * a convention, so a package that points its entry elsewhere still loads.
 * @param value - the export value.
 * @returns the relative target, or undefined when there is none.
 */
function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const conditions = value as Record<string, unknown>
    // `default` is the condition Node itself falls back to.
    const target = conditions.default ?? conditions.import ?? conditions.node
    if (typeof target === 'string') return target
  }
  return undefined
}

/**
 * Read one bounded JSON file inside a package.
 *
 * @param path - absolute path to read.
 * @param maxBytes - the size bound.
 * @param what - a label for error messages.
 * @returns the decoded value.
 * @throws ManagementError when the file is missing, oversized, or not JSON.
 */
function readBoundedJson(path: string, maxBytes: number, what: string): unknown {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      `the package does not ship ${what}`,
      `Add ${what} to the published package.`,
    )
  }
  if (size > maxBytes) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      `${what} is ${size} bytes, over the ${maxBytes}-byte limit`,
      `Reduce ${what}; discovery reads it as bounded data before importing any code.`,
    )
  }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      `${what} could not be read`,
      'Check that the file is present and readable by the installing account.',
    )
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      `${what} is not valid JSON`,
      `Correct the JSON syntax in ${what}.`,
    )
  }
}

/**
 * Discover an extension package without importing it.
 *
 * Enforces the EXT-13 package requirements: a `package.json` declaring `name`,
 * `version`, `type: "module"`, an explicit `exports` map, and a `toolMode.manifest`
 * field pointing at a manifest inside the package.
 * @param packageDir - absolute path of the unpacked package.
 * @returns the discovery result.
 * @throws ManagementError with `INVALID_EXTENSION` for any violated requirement.
 */
export function discoverExtension(packageDir: string): ExtensionDiscovery {
  const root = resolve(packageDir)
  const manifest = readBoundedJson(join(root, 'package.json'), MAX_PACKAGE_JSON_BYTES, 'package.json')
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      'package.json is not an object',
      'Ship a valid package.json.',
    )
  }
  const pkg = manifest as Record<string, unknown>
  const packageName = pkg.name
  const packageVersion = pkg.version
  if (typeof packageName !== 'string' || packageName.length === 0) {
    throw new ManagementError('INVALID_EXTENSION', 'discover', 'package.json declares no name', 'Declare a name.')
  }
  if (typeof packageVersion !== 'string' || packageVersion.length === 0) {
    throw new ManagementError('INVALID_EXTENSION', 'discover', 'package.json declares no version', 'Declare a semantic version.')
  }
  if (pkg.type !== 'module') {
    // ESM-only keeps the loading path single and avoids a CJS interop surface the
    // host would otherwise have to reason about before importing anything.
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      'package.json must declare "type": "module"',
      'Publish the extension as an ES module.',
    )
  }
  const exportsField = pkg.exports
  if (typeof exportsField !== 'object' || exportsField === null || Object.keys(exportsField).length === 0) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      'package.json must declare an explicit "exports" map',
      'Declare the public entry points; implicit resolution is not admitted.',
    )
  }
  const toolMode = pkg.toolMode
  if (typeof toolMode !== 'object' || toolMode === null || typeof (toolMode as { manifest?: unknown }).manifest !== 'string') {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      'package.json must declare "toolMode": { "manifest": "./…" }',
      'Add the toolMode discovery field naming the extension manifest.',
    )
  }
  const declared = (toolMode as { manifest: string }).manifest
  const manifestPath = resolve(root, declared)
  if (!manifestPath.startsWith(root + sep)) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      'the declared manifest path escapes the package directory',
      'Reference the manifest by a package-relative path.',
    )
  }

  const raw = readBoundedJson(manifestPath, MAX_MANIFEST_BYTES, 'the extension manifest')
  const entry = exportTarget((exportsField as Record<string, unknown>)['./tool-mode'])
  const entryPath = entry === undefined ? undefined : resolve(root, entry)
  if (entryPath !== undefined && !entryPath.startsWith(root + sep)) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      'the ./tool-mode export points outside the package directory',
      'Point the export at a file inside the package.',
    )
  }

  return {
    packageName,
    packageVersion,
    packageDir: root,
    manifestPath,
    ...entryPath === undefined ? {} : { entryPath },
    manifest: validateManifest(raw, { packageName, packageVersion, packageDir: root }),
    exports: Object.keys(exportsField),
  }
}
