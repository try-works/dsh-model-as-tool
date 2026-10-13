/**
 * Manifest validation and normalization (EXT-14, EXT-16).
 *
 * Validation runs on data read from a package before any of its code is imported,
 * so a malformed or hostile manifest is rejected without executing anything.
 *
 * The checks below are the ones a JSON Schema cannot express: uniqueness of local
 * IDs, agreement between the manifest and the package, referenced files that
 * actually exist, and compatibility. EXT-14 is explicit that "unknown required
 * features or incompatible protocol majors block activation", so an unrecognised
 * feature is an error rather than a warning.
 *
 * @module @try-works/tool-mode-extension-sdk/manifest
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import { ManagementError } from './errors.ts'

/** The TMX protocol version this SDK implements. */
export const TMX_PROTOCOL_VERSION = '1.1.0'

/** The module runtime API major this SDK implements (EXT-16). */
export const RUNTIME_API_MAJOR = 1

/** Features this SDK host knows how to provide (EXT-14). */
export const KNOWN_FEATURES: readonly string[] = [
  'provider-worker-v1',
  'verified-assets-v1',
  'declarative-recipes-v1',
  'harness-executors-v1',
]

/** Largest manifest accepted, in bytes. Bounded so a huge file cannot be parsed. */
export const MAX_MANIFEST_BYTES = 512 * 1024

/** A validated manifest, normalized to the current protocol minor (EXT-16). */
export interface ExtensionManifest {
  readonly protocolVersion: string
  readonly id: string
  readonly version: string
  readonly displayName: string
  readonly description: string
  readonly license?: string
  readonly activation: { readonly policy: 'operator' | 'bundled-default'; readonly deactivatable: boolean }
  readonly runtimeApi: number
  readonly compatibility: { readonly hostApi: string; readonly requiredFeatures: readonly string[] }
  readonly execution: {
    readonly kind: 'module' | 'declarative'
    readonly entry?: string
    readonly isolation?: 'managed-process' | 'host-inline'
  }
  readonly configurationSchema?: string
  /**
   * Per-layer licences (LIC-01).
   *
   * Absent means UNDECLARED, which the resolution reports as a gap for every layer
   * rather than treating silence as permission.
   */
  readonly licenses?: readonly ManifestLicense[]
  /** Declared network behaviour (LIC-04). */
  readonly network?: ManifestNetwork
  readonly permissions: {
    readonly networkOrigins: readonly string[]
    readonly inputFiles: boolean
    readonly storage: 'none' | 'extension-private'
    readonly secrets: readonly string[]
    readonly nativeCode: boolean
  }
  readonly models: readonly ManifestModel[]
  readonly tools: readonly ManifestTool[]
  readonly implementations: readonly ManifestImplementation[]
  readonly skills: readonly ManifestSkill[]
  /** True when a 1.0 manifest was normalized to module execution (EXT-16). */
  readonly normalizedFrom?: string
}

/** One layer's licence, as the manifest declares it (LIC-01). */
export interface ManifestLicense {
  readonly layer: 'code' | 'engine' | 'weights' | 'conversion-artifacts' | 'sdk'
  readonly name: string
  readonly url: string
  readonly openSource: boolean
  readonly redistribution: 'permitted' | 'not-permitted' | 'unclear'
  readonly attributionRequired: boolean
  readonly attributionText?: string
  readonly obligations?: readonly string[]
}

/** Declared network behaviour (LIC-04). */
export interface ManifestNetwork {
  readonly requiredTelemetry: boolean
  readonly otherNetworkUse: boolean
  readonly telemetryContent?: readonly string[]
}

/** A declared model and its asset set. */
export interface ManifestModel {
  readonly id: string
  readonly assetSet: string
  readonly assetLock: string
  readonly platforms: readonly { readonly os: string; readonly arch: string; readonly accelerator?: string }[]
}

/** A declared tool contribution. */
export interface ManifestTool {
  readonly id: string
  readonly name: string
  readonly contractId: string
  readonly contractVersion: string
  readonly description: string
  readonly inputSchema: string
  readonly outputSchema: string
}

/** A declared implementation binding. */
export interface ManifestImplementation {
  readonly id: string
  readonly contractId: string
  readonly contractVersion: string
  readonly modelId?: string
  readonly recipeVersion: string
}

/** A declared skill contribution. */
export interface ManifestSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly path: string
  readonly requiresTools?: readonly string[]
}

let cachedValidator: ValidateFunction | undefined

/**
 * Compile the shipped manifest schema.
 *
 * `strict: false` because the schema uses 2020-12 keywords Ajv's strict mode
 * rejects when they are merely annotated, and `allErrors` so a rejection lists
 * every problem rather than the first.
 * @returns the compiled validator.
 */
function manifestValidator(): ValidateFunction {
  cachedValidator ??= (() => {
    const schemaUrl = new URL('../schema/extension-manifest-1.1.0.schema.json', import.meta.url)
    const schema = JSON.parse(readFileSync(schemaUrl, 'utf8')) as object
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    return ajv.compile(schema)
  })()
  return cachedValidator
}

/** Render Ajv errors as stable strings. */
function renderErrors(errors: ValidateFunction['errors']): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const error of errors ?? []) {
    const path = error.instancePath === '' ? '(root)' : error.instancePath
    const line = `${path} ${error.message ?? 'is invalid'}`
    if (!seen.has(line)) {
      seen.add(line)
      out.push(line)
    }
  }
  return out
}

/**
 * Normalize a raw manifest to the current protocol minor.
 *
 * A 1.0 manifest is lifted to module execution WITHOUT touching its installed
 * bytes: EXT-16 requires the normalization to be a view, not an edit, because the
 * recorded digest must keep describing what is on disk.
 *
 * The provenance of the lift is returned SEPARATELY rather than written into the
 * object. The manifest schema is closed, and rightly so — an SDK-internal
 * annotation is not an author-facing field, and adding it to the document to slip
 * it past validation would be exactly the kind of silent widening the schema
 * exists to prevent.
 * @param raw - the decoded manifest.
 * @returns the normalized value plus the protocol version it was lifted from.
 */
function normalizeManifest(raw: Record<string, unknown>): {
  readonly value: Record<string, unknown>
  readonly normalizedFrom?: string
} {
  const protocolVersion = String(raw.protocolVersion ?? '')
  if (protocolVersion.startsWith('1.0.')) {
    return {
      value: { ...raw, execution: { kind: 'module', ...(raw.execution as object ?? {}) } },
      normalizedFrom: protocolVersion,
    }
  }
  return { value: raw }
}

/**
 * Validate a raw manifest.
 *
 * Beyond the schema, this enforces the cross-field rules EXT-14 names:
 * unique local IDs, exact agreement with the package, referenced files that
 * exist, and a compatibility range this host satisfies.
 * @param raw - the decoded manifest.
 * @param options - package identity and the directory referenced files resolve against.
 * @returns the validated manifest.
 * @throws ManagementError with `INVALID_EXTENSION` or `INCOMPATIBLE_PROTOCOL`.
 */
export function validateManifest(
  raw: unknown,
  options: {
    /** The package's own `name`, which the manifest id must equal exactly. */
    readonly packageName: string
    /** The package's own `version`, which the manifest version must equal exactly. */
    readonly packageVersion: string
    /** Directory referenced files resolve against; omit to skip the existence check. */
    readonly packageDir?: string
  },
): ExtensionManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      'the manifest is not a JSON object',
      'Ship a manifest object; see the extension-manifest schema in the SDK.',
    )
  }
  const normalized = normalizeManifest(raw as Record<string, unknown>)
  const validate = manifestValidator()
  if (!validate(normalized.value)) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      `the manifest does not satisfy the schema: ${renderErrors(validate.errors).join('; ')}`,
      'Correct the reported fields and republish; the schema is shipped with the SDK.',
    )
  }
  // The lift provenance is attached AFTER validation, so the closed schema never
  // has to admit an SDK-internal field.
  const manifest = {
    ...(normalized.value as unknown as ExtensionManifest),
    ...normalized.normalizedFrom === undefined ? {} : { normalizedFrom: normalized.normalizedFrom },
  }

  if (manifest.id !== options.packageName) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      `the manifest id ${JSON.stringify(manifest.id)} must equal the package name ${JSON.stringify(options.packageName)} exactly`,
      'Make the manifest id and package.json name identical, including scope.',
    )
  }
  if (manifest.version !== options.packageVersion) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      `the manifest version ${JSON.stringify(manifest.version)} must equal the package version ${JSON.stringify(options.packageVersion)} exactly`,
      'Make the manifest version and package.json version identical.',
    )
  }

  const unknownFeatures = manifest.compatibility.requiredFeatures.filter(
    feature => !KNOWN_FEATURES.includes(feature),
  )
  if (unknownFeatures.length > 0) {
    // EXT-14: an unknown REQUIRED feature blocks activation. Reporting it is more
    // useful than silently proceeding without the capability the author asked for.
    throw new ManagementError(
      'INCOMPATIBLE_PROTOCOL',
      'discover',
      `the host does not provide required feature(s): ${unknownFeatures.join(', ')}`,
      'Upgrade the host, or drop the feature from compatibility.requiredFeatures if it is optional.',
    )
  }

  assertUniqueIds(manifest)
  if (options.packageDir !== undefined) assertReferencedFilesExist(manifest, options.packageDir)
  return manifest
}

/** Reject duplicate local IDs, which would make a contribution ambiguous. */
function assertUniqueIds(manifest: ExtensionManifest): void {
  for (const [label, ids] of [
    ['models', manifest.models.map(model => model.id)],
    ['tools', manifest.tools.map(tool => tool.id)],
    ['implementations', manifest.implementations.map(implementation => implementation.id)],
    ['skills', manifest.skills.map(skill => skill.id)],
  ] as const) {
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
    if (duplicate !== undefined) {
      throw new ManagementError(
        'INVALID_EXTENSION',
        'discover',
        `duplicate ${label} id ${JSON.stringify(duplicate)}`,
        'Give every contribution in the manifest a unique local id.',
      )
    }
  }
  // A tool NAME is caller-facing, so a duplicate there is a naming conflict rather
  // than a manifest error (EXT-22).
  const names = manifest.tools.map(tool => tool.name)
  const duplicateName = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicateName !== undefined) {
    throw new ManagementError(
      'TOOL_NAME_CONFLICT',
      'discover',
      `two tools declare the caller-facing name ${JSON.stringify(duplicateName)}`,
      'Give each tool a distinct name, or declare the duplicate as an implementation of the existing contract.',
    )
  }
}

/** Reject a manifest referencing a file the package does not ship. */
function assertReferencedFilesExist(manifest: ExtensionManifest, packageDir: string): void {
  const referenced: string[] = [
    ...manifest.models.map(model => model.assetLock),
    ...manifest.tools.flatMap(tool => [tool.inputSchema, tool.outputSchema]),
    ...manifest.skills.map(skill => skill.path),
    ...manifest.configurationSchema === undefined ? [] : [manifest.configurationSchema],
    ...manifest.execution.entry === undefined ? [] : [manifest.execution.entry],
  ]
  for (const relative of referenced) {
    // Schema files are offline package files; a remote $ref is never fetched and a
    // path that escapes the package is refused before it can be read.
    const absolute = resolve(packageDir, relative)
    const root = resolve(packageDir)
    if (!absolute.startsWith(root + sep) && absolute !== root) {
      throw new ManagementError(
        'INVALID_EXTENSION',
        'discover',
        `the manifest references ${JSON.stringify(relative)}, which escapes the package directory`,
        'Reference package-relative files only.',
      )
    }
    const target = isAbsolute(relative) ? normalize(relative) : join(packageDir, relative)
    if (!existsSync(target)) {
      throw new ManagementError(
        'INVALID_EXTENSION',
        'discover',
        `the manifest references ${JSON.stringify(relative)}, which the package does not ship`,
        'Include the referenced file in the published package, or correct the path.',
      )
    }
  }
}
