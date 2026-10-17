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

import { existsSync, readFileSync, statSync } from 'node:fs'
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
  'harness-model-recipes-v1',
  'typed-image-input-v1',
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
  /**
   * `"harness-model"` marks the spec §19.3 recipe binding; absent means the
   * module form. The SDK validates the SHAPE; whether the host supports the
   * binding is negotiated through the declared required features (EXT-14).
   */
  readonly kind?: 'harness-model'
  readonly contractId: string
  readonly contractVersion: string
  readonly modelId?: string
  readonly recipeVersion: string
  /** The package-relative recipe file of a harness-model binding (RCP-01). */
  readonly recipe?: string
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
  // has to admit an SDK-internal field. The §19.3 declarative example elides
  // `activation` and `runtimeApi`; the SDK defaults them at VALIDATION (the
  // bytes stay untouched): operator activation + runtime API major 1.
  const rawManifest = normalized.value as unknown as {
    activation?: ExtensionManifest['activation']
    runtimeApi?: number
  } & ExtensionManifest
  const manifest = {
    ...rawManifest,
    ...normalized.normalizedFrom === undefined ? {} : { normalizedFrom: normalized.normalizedFrom },
    ...rawManifest.activation === undefined
      ? { activation: { policy: 'operator' as const, deactivatable: true } }
      : {},
    ...rawManifest.runtimeApi === undefined ? { runtimeApi: 1 } : {},
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

  // §19.5: a declarative package with an executable entry is REFUSED — the two
  // execution modes are exclusive, and a declarative package claiming an entry
  // would blur the "no executable code" boundary the recipe path exists for.
  if (manifest.execution.kind === 'declarative' && manifest.execution.entry !== undefined) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      'a declarative package declares an executable entry; declarative packages ship static recipe files and no executable module (§19.5)',
      'Remove the execution.entry and any executable code, or publish the package as a module extension.',
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
    ...manifest.implementations.flatMap(implementation => implementation.recipe === undefined ? [] : [implementation.recipe]),
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

/**
 * The qualification-record fields a lock may declare (MODEL-05).
 *
 * Mirrored, not imported, from the host's `model-qualification` module, for the
 * same reason the embedding extension mirrors its dimension constants: the SDK
 * must stay buildable without the host (EXT-02), and a second definition that
 * drifts is caught by the discovery test asserting the field set.
 */
export const QUALIFICATION_FIELDS: readonly string[] = [
  'modelRevision', 'artifactSha', 'tokenizer', 'processor',
  'engineVersion', 'nodeAbi', 'architecture', 'executionProvider',
]

/** Largest lock file accepted, in bytes. Bounded so a huge file cannot be parsed. */
export const MAX_LOCK_BYTES = 1024 * 1024

/**
 * Validate the qualification records an asset lock declares.
 *
 * A `qualification` object is not decoration: if it is present it must carry
 * every field, each a non-blank string, or the package is refused at discovery —
 * a record that can silently rot into a claim the artifacts no longer satisfy is
 * worse than none (MODEL-05: a gap is not a qualification).
 * @param lockPath - the lock file's absolute path.
 * @param assetSet - the asset set whose record to check.
 */
function assertQualificationRecord(lockPath: string, assetSet: string): void {
  // STAT FIRST, READ SECOND (review finding): a hostile package can ship a
  // multi-GB lock, and buffering it before the cap check is the unbounded
  // allocation discovery must never perform. The stat is free, so the cap is
  // enforced on the byte count BEFORE any bytes are read.
  let stat: { size: number }
  try {
    stat = statSync(lockPath)
  } catch (error) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      `the asset lock cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      'Ship a valid JSON asset lock.',
    )
  }
  if (stat.size > MAX_LOCK_BYTES) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      `the asset lock is ${stat.size} bytes, over the ${MAX_LOCK_BYTES} cap`,
      'Keep the lock under the cap.',
    )
  }
  let lock: unknown
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch (error) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      `the asset lock cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      'Ship a valid JSON asset lock.',
    )
  }
  const sets = (lock as { assetSets?: Record<string, unknown> } | undefined)?.assetSets
  if (typeof sets !== 'object' || sets === null) return
  const set = sets[assetSet]
  if (typeof set !== 'object' || set === null) return
  const qualification = (set as { qualification?: unknown }).qualification
  if (qualification === undefined) return
  if (typeof qualification !== 'object' || qualification === null || Array.isArray(qualification)) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      `the ${assetSet} qualification record is not an object`,
      'Declare the record as an object with every MODEL-05 field, or remove it.',
    )
  }
  const record = qualification as Record<string, unknown>
  const missing = QUALIFICATION_FIELDS.filter(field => typeof record[field] !== 'string' || record[field].length === 0)
  if (missing.length > 0) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'discover',
      `the ${assetSet} qualification record is missing or has blank: ${missing.join(', ')}`,
      'Populate every MODEL-05 field with a non-blank string, or remove the record.',
    )
  }
}

/**
 * Validate the qualification records the manifest's asset locks declare.
 *
 * The assetLock path was ALREADY escape-checked and existence-checked by
 * `assertReferencedFilesExist` before this runs (discovery calls that first),
 * so the join here reuses a validated relative path rather than a raw one.
 * @param manifest - the validated manifest.
 * @param packageDir - the package directory.
 */
export function validateLockQualifications(manifest: ExtensionManifest, packageDir: string): void {
  for (const model of manifest.models) {
    const lockPath = join(packageDir, model.assetLock.replace(/^\.\//, ''))
    assertQualificationRecord(lockPath, model.assetSet)
  }
}
