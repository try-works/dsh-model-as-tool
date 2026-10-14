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
import {
  describeNetwork,
  noNetworkEligibility,
  resolveLicenses,
  type LicenseLayer,
  type NoNetworkVerdict,
  type ResolvedLicenseRecord,
} from './licensing.ts'
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
  /**
   * The resolved per-layer licence record (LIC-01).
   *
   * Produced by discovery rather than left to a consumer, so every caller resolves
   * the same way and a package that declares no licences gets the same explicit gap
   * report as one that declares an incomplete set.
   */
  readonly licenses: ResolvedLicenseRecord
  /** The layers the package did NOT declare, which are gaps rather than defaults. */
  readonly licenseGaps: readonly LicenseLayer[]
  /**
   * Whether the package is eligible for a strict no-network deployment (LIC-04).
   *
   * Derived from the declaration, and a package that declares nothing is NOT
   * eligible: silence about telemetry cannot be read as an absence of telemetry.
   */
  readonly noNetwork: NoNetworkVerdict
  /** How the package may truthfully describe its network behaviour. */
  readonly networkDescription: string
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
  /**
   * The `exports` map is required of a MODULE package and NOT of a declarative one.
   *
   * This check used to run here, unconditionally, and it made a declarative package
   * UNDISCOVERABLE: such a package ships no code, so it has no entry points to export, and
   * demanding an `exports` map asked it to declare something it does not have. The failure
   * read "package.json must declare an explicit \"exports\" map" — advice a package with no
   * module cannot act on.
   *
   * The requirement is now applied AFTER the manifest is read, where the execution kind is
   * known. `exportsField` is still read here so the shape check happens in one place.
   */
  const exportsField = pkg.exports
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
  /** A declarative package has no exports map at all, so there is no entry to look for. */
  const entry = typeof exportsField === 'object' && exportsField !== null
    ? exportTarget((exportsField as Record<string, unknown>)['./tool-mode'])
    : undefined
  const entryPath = entry === undefined ? undefined : resolve(root, entry)
  if (entryPath !== undefined && !entryPath.startsWith(root + sep)) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      'the ./tool-mode export points outside the package directory',
      'Point the export at a file inside the package.',
    )
  }

  // Named alidated because manifest already holds the parsed package.json above.
  const validated = validateManifest(raw, { packageName, packageVersion, packageDir: root })

  /**
   * The `exports` requirement, applied where the execution KIND is known.
   *
   * A module package must declare its public entry points, because the host resolves one in
   * order to load it, and implicit resolution is not admitted. A DECLARATIVE package has no
   * module to load: its behaviour is a set of recipe files resolved by the
   * `recipes/<implementation-id>.json` convention instead. Requiring an `exports` map of it
   * demanded a declaration it cannot meaningfully make, and rejected every declarative
   * package before its kind could even be read.
   */
  const declarative = (validated as unknown as { execution: { kind: string } }).execution.kind === 'declarative'
  if (!declarative
    && (typeof exportsField !== 'object' || exportsField === null || Object.keys(exportsField as object).length === 0)) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      'package.json must declare an explicit "exports" map',
      'Declare the public entry points; implicit resolution is not admitted.',
    )
  }

  /**
   * Licence resolution happens HERE rather than being left to each consumer.
   *
   * Every caller then resolves the same way, and a package that declares nothing gets
   * the same explicit gap report as one that declares an incomplete set — rather than
   * one consumer treating silence as permission and another not.
   */
  const { record: licenses, gaps: licenseGaps } = resolveLicenses(
    packageName,
    (validated.licenses ?? []).map((entry: NonNullable<typeof validated.licenses>[number]) => ({
      layer: entry.layer,
      name: entry.name,
      url: entry.url,
      openSource: entry.openSource,
      redistribution: entry.redistribution,
      attributionRequired: entry.attributionRequired,
      ...entry.attributionText === undefined ? {} : { attributionText: entry.attributionText },
      obligations: entry.obligations ?? [],
    })),
  )

  /**
   * Network behaviour is TAKEN FROM THE DECLARATION, and a package that declares
   * nothing is treated as telemetry-bearing rather than telemetry-free: silence about
   * telemetry cannot be read as an absence of telemetry (LIC-04).
   */
  const declaredNetwork = validated.network ?? { requiredTelemetry: true, otherNetworkUse: true }
  const networkBehaviour = {
    extensionId: packageName,
    requiredTelemetry: declaredNetwork.requiredTelemetry,
    otherNetworkUse: declaredNetwork.otherNetworkUse,
    ...declaredNetwork.telemetryContent === undefined ? {} : { telemetryContent: declaredNetwork.telemetryContent },
  }

  return {
    packageName,
    packageVersion,
    packageDir: root,
    manifestPath,
    ...entryPath === undefined ? {} : { entryPath },
    manifest: validated,
    exports: typeof exportsField === 'object' && exportsField !== null ? Object.keys(exportsField) : [],
    licenses,
    licenseGaps,
    noNetwork: noNetworkEligibility(networkBehaviour),
    networkDescription: describeNetwork(networkBehaviour),
  }
}
