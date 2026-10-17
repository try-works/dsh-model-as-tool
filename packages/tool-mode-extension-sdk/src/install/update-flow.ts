/**
 * EXT-30 staged update and rollback (slices 1+2 of the approved design,
 * docs/tool-mode/EXT-30-UPDATE-DESIGN.md).
 *
 * The two properties this module exists to enforce:
 *
 * - **Side-by-side, never in place.** A new version is fetched into
 *   `staging/`, validated as DATA (manifest, integrity, schema/license/
 *   permission deltas, structural-static self-tests), approved by an operator,
 *   and only then promoted to its OWN version directory. The currently active
 *   version's bytes are never mutated.
 * - **The active version is a POINTER, committed atomically.** The profile
 *   state document carries `activeVersions`/`previousVersions` maps written by
 *   the store's single atomic writer under the store lock. Rollback restores
 *   the pointer; it never copies bytes over a live install, never re-enables
 *   disabled tools, never undoes revocations (those facts live beside the
 *   pointer and are not touched).
 *
 * A post-commit rebind failure rolls the pointer back AUTOMATICALLY and names
 * the reason. A corrupted version directory fails closed everywhere.
 *
 * Slice 1's self-tests are STRUCTURAL/STATIC only (manifest, referenced files,
 * schema JSON parses): host-executed self-tests arrive with slice 3, and this
 * module never executes extension code.
 *
 * @module @try-works/tool-mode-extension-sdk/install/update-flow
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ManagementError } from './../errors.ts'
import { discoverExtension, type ExtensionDiscovery } from './../discovery.ts'
import type { ExtensionManifest, ManifestTool } from './../manifest.ts'
import { digestInstalledContent, ExtensionStore, type InstalledRecord } from './store.ts'
import { installPathFor, type ArchiveSource, type InstallLimits, type InstallSource, DEFAULT_INSTALL_LIMITS } from './staged.ts'
import { validateArchiveEntries, verifyIntegrity } from './archive.ts'
/** One schema compatibility finding (EXT-30's schema recheck). */
export interface SchemaDelta {
  readonly toolName: string
  readonly file: 'input' | 'output'
  /** True when a pinned composition would silently change meaning. */
  readonly breaking: boolean
  readonly detail: string
}

/** The staged update's validation report (EXT-30's gates, slice 1). */
export interface UpdateValidationReport {
  readonly manifestOk: boolean
  /** The current version the deltas were computed against. */
  readonly comparedAgainst: string
  readonly schemaDeltas: readonly SchemaDelta[]
  /** Set when the manifest licence declaration changed. */
  readonly licenseDelta?: string
  /** Permission EXPANSIONS, one entry per expansion (AT-35). */
  readonly permissionDeltas: readonly string[]
  readonly selfTests: { readonly kind: 'structural-static'; readonly passed: boolean; readonly detail: string }
  /** True when an operator approval is required before the commit. */
  readonly requiresApproval: boolean
}

/** The outcome of a successful stage (nothing is visible or active yet). */
export interface UpdateStageResult {
  readonly extensionId: string
  readonly stagedVersion: string
  /** Absolute path of the staged extraction (not the installed pool). */
  readonly stagedPath: string
  readonly report: UpdateValidationReport
}

/** The outcome of a commit (the pointer moved; the old pointer is the rollback target). */
export interface UpdateCommitResult {
  readonly extensionId: string
  readonly activeVersion: string
  readonly previousVersion?: string
}

/** The outcome of a rollback (pointer restore only). */
export interface UpdateRollbackResult {
  readonly extensionId: string
  readonly activeVersion: string
  readonly previousVersion?: string
  /**
   * The rebindRestored hook's own failure, when it threw or rejected. The hook
   * is a POST-RESTORE observer: its error is reported here, never thrown — the
   * pointer restore has already committed and must not be rolled back again.
   */
  readonly hookFailure?: string
}

/** The staged-update metadata, persisted beside the staged extraction. */
interface UpdateStageMetadata {
  readonly extensionId: string
  readonly stagedVersion: string
  readonly stagedPath: string
  readonly currentVersion: string
  readonly archiveDigest: string
  readonly contentDigest: string
  readonly report: UpdateValidationReport
  readonly stagedAt: string
}

/** The current-installed comparison base: the named version, or the highest recorded one. */
function currentRecord(store: ExtensionStore, extensionId: string, currentVersion: string | undefined): InstalledRecord {
  const records = store.listInstalled().value.filter(record => record.extensionId === extensionId)
  if (records.length === 0) {
    throw new ManagementError(
      'UPGRADE_FAILED',
      'install',
      `${extensionId} is not installed; an update updates an existing extension`,
      'Install the extension first; an update never creates a fresh installation.',
    )
  }
  const record = currentVersion === undefined
    ? records.reduce((latest, candidate) => (
      candidate.version.localeCompare(latest.version, undefined, { numeric: true }) > 0 ? candidate : latest
    ))
    : records.find(candidate => candidate.version === currentVersion)
  if (record === undefined) {
    throw new ManagementError(
      'UPGRADE_FAILED',
      'install',
      `${extensionId}@${currentVersion as string} is not installed; the comparison base does not exist`,
      'Stage the update against the version that is actually installed.',
    )
  }
  return record
}

/** Parse one schema file for the delta computation; unparseable is a refusal. */
function schemaShape(text: string): { properties: Readonly<Record<string, string>>; required: readonly string[] } {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the schema file is not a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const properties: Record<string, string> = {}
  const raw = record.properties
  if (raw !== undefined) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('the schema properties are not an object')
    for (const [name, declaration] of Object.entries(raw as Record<string, unknown>)) {
      const type = (declaration as { type?: unknown } | undefined)?.type
      properties[name] = typeof type === 'string' ? type : 'unknown'
    }
  }
  const required = Array.isArray(record.required) && record.required.every(entry => typeof entry === 'string')
    ? record.required as unknown as string[]
    : []
  return { properties, required }
}

/** Compute the schema deltas for one tool between the current and staged manifests. */
function schemaDeltasFor(
  current: ExtensionManifest,
  staged: ExtensionManifest,
  currentDir: string,
  stagedDir: string,
): { deltas: SchemaDelta[]; unparseable?: string } {
  const deltas: SchemaDelta[] = []
  const byContract = new Map<string, ManifestTool>()
  for (const tool of current.tools) byContract.set(tool.contractId, tool)
  for (const tool of staged.tools) {
    const previous = byContract.get(tool.contractId)
    if (previous === undefined) {
      deltas.push({ toolName: tool.name, file: 'input', breaking: false, detail: 'a new tool; additive' })
      continue
    }
    for (const file of ['input', 'output'] as const) {
      const currentPath = file === 'input' ? previous.inputSchema : previous.outputSchema
      const stagedPath = file === 'input' ? tool.inputSchema : tool.outputSchema
      let currentShape: ReturnType<typeof schemaShape>
      let stagedShape: ReturnType<typeof schemaShape>
      try {
        currentShape = schemaShape(readFileSync(join(currentDir, currentPath), 'utf8'))
        stagedShape = schemaShape(readFileSync(join(stagedDir, stagedPath), 'utf8'))
      } catch (error) {
        return {
          deltas: [],
          unparseable: `${tool.name} ${file} schema: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      const problems: string[] = []
      for (const [name, type] of Object.entries(currentShape.properties)) {
        if (!(name in stagedShape.properties)) {
          problems.push(`removed property ${JSON.stringify(name)}`)
        } else if (stagedShape.properties[name] !== type) {
          problems.push(`changed type of ${JSON.stringify(name)} from ${type} to ${stagedShape.properties[name]}`)
        }
      }
      for (const name of stagedShape.required) {
        if (!currentShape.required.includes(name) && name in currentShape.properties) {
          problems.push(`made ${JSON.stringify(name)} required (it was optional)`)
        }
      }
      if (problems.length > 0) {
        deltas.push({ toolName: tool.name, file, breaking: true, detail: problems.join('; ') })
      }
    }
  }
  for (const tool of current.tools) {
    if (!staged.tools.some(candidate => candidate.contractId === tool.contractId)) {
      deltas.push({
        toolName: tool.name, file: 'input', breaking: true,
        detail: `the staged version drops the published contract ${JSON.stringify(tool.contractId)}; pinned compositions would fail`,
      })
    }
  }
  return { deltas }
}

/** Render the manifest licence declaration (the delta comparator's stable form). */
function licenseForm(manifest: ExtensionManifest): string {
  return JSON.stringify({
    license: manifest.license,
    layers: manifest.licenses?.map(layer => ({
      layer: layer.layer, name: layer.name, url: layer.url,
      openSource: layer.openSource, redistribution: layer.redistribution,
    })),
  })
}

/** List permission EXPANSIONS (staged vs current). Reductions need no approval. */
function permissionDeltasFor(current: ExtensionManifest, staged: ExtensionManifest): string[] {
  const deltas: string[] = []
  const previous = new Set(current.permissions.networkOrigins)
  for (const origin of staged.permissions.networkOrigins) {
    if (!previous.has(origin)) deltas.push(`new network origin ${JSON.stringify(origin)}`)
  }
  if (staged.permissions.inputFiles && !current.permissions.inputFiles) deltas.push('inputFiles: false -> true')
  if (staged.permissions.storage !== 'none' && current.permissions.storage === 'none') deltas.push('storage: none -> extension-private')
  const previousSecrets = new Set(current.permissions.secrets)
  for (const secret of staged.permissions.secrets) {
    if (!previousSecrets.has(secret)) deltas.push(`new declared secret ${JSON.stringify(secret)}`)
  }
  if (staged.permissions.nativeCode && !current.permissions.nativeCode) deltas.push('nativeCode: false -> true')
  return deltas
}

const stageMetadataPath = (stagedDir: string): string => join(stagedDir, 'update-stage.json')

/**
 * Stage an update (EXT-30 slice 1).
 *
 * Fetch → integrity → entry validation → extract into `staging/` → manifest
 * discovery → schema/licence/permission deltas against the current version →
 * structural-static self-tests. A BREAKING schema delta or an unparseable
 * schema REFUSES the stage (the staged directory is removed); a licence or
 * permission delta only marks the stage as requiring approval. The installed
 * version is never touched.
 *
 * @param options - the source, store, injected archive source, and limits.
 * @returns the staged update and its validation report.
 * @throws ManagementError for every rejection path.
 */
export async function stageUpdate(options: {
  readonly storeDir: string
  readonly source: InstallSource
  readonly archive: ArchiveSource
  readonly expectedSha512?: string
  /** The comparison base; defaults to the highest recorded version. */
  readonly currentVersion?: string
  readonly limits?: InstallLimits
}): Promise<UpdateStageResult> {
  const limits = options.limits ?? DEFAULT_INSTALL_LIMITS
  const store = new ExtensionStore(options.storeDir)
  const stagedBase = join(resolve(options.storeDir), 'staging')
  mkdirSync(stagedBase, { recursive: true })
  const attempt = join(stagedBase, `attempt-${process.pid}-${Date.now().toString(36)}`)
  const extracted = join(attempt, 'package')
  mkdirSync(extracted, { recursive: true })
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
    // Integrity: verified against the declared digest when one is given; the
    // computed digest is always recorded for the admission-time re-check.
    const archiveDigest = options.expectedSha512 === undefined
      ? createHash('sha512').update(bytes).digest('hex')
      : verifyIntegrity(bytes, options.expectedSha512)
    validateArchiveEntries(options.archive.list(bytes), limits.archive)
    options.archive.extract(bytes, extracted, '')
    const discovery = discoverExtension(extracted)
    const current = currentRecord(store, discovery.packageName, options.currentVersion)
    const currentDiscovery: ExtensionDiscovery = discoverExtension(current.installPath)
    const schema = schemaDeltasFor(currentDiscovery.manifest, discovery.manifest, current.installPath, extracted)
    if (schema.unparseable !== undefined) {
      throw new ManagementError(
        'UPGRADE_FAILED',
        'install',
        `the staged package carries an unparseable schema (${schema.unparseable}); a manifest pointing at unparseable `
          + 'schemas is refused rather than activated',
        'Fix the schema files and republish.',
      )
    }
    const breaking = schema.deltas.filter(delta => delta.breaking)
    if (breaking.length > 0) {
      throw new ManagementError(
        'UPGRADE_FAILED',
        'install',
        `the update changes published contracts incompatibly (${breaking.map(delta =>
          `${delta.toolName} ${delta.file}: ${delta.detail}`).join('; ')})`
          + '; breaking contract changes require a reviewed migration (EXT-30)',
        'Publish a compatible version, or conduct the reviewed migration the contract change needs.',
      )
    }
    const currentLicense = licenseForm(currentDiscovery.manifest)
    const stagedLicense = licenseForm(discovery.manifest)
    const permissionDeltas = permissionDeltasFor(currentDiscovery.manifest, discovery.manifest)
    const report: UpdateValidationReport = {
      manifestOk: true,
      comparedAgainst: current.version,
      schemaDeltas: schema.deltas,
      ...currentLicense === stagedLicense ? {} : { licenseDelta: 'the manifest licence declaration changed; operator approval required' },
      permissionDeltas,
      selfTests: {
        kind: 'structural-static',
        passed: true,
        detail: 'structural/static checks only (manifest, referenced files, schema JSON parses); '
          + 'host-executed self-tests arrive with slice 3',
      },
      requiresApproval: currentLicense !== stagedLicense || permissionDeltas.length > 0,
    }
    const contentDigest = digestInstalledContent(extracted)
    // The attempt directory is renamed to the CANONICAL staged location, so the
    // staged bytes have a stable identity that a commit in ANOTHER process can
    // find and re-verify. The metadata record lives BESIDE the package dir, so
    // admission moves only the package and the record stays out of the install.
    const canonical = stagedPathFor(options.storeDir, discovery.packageName, discovery.packageVersion)
    renameSync(attempt, canonical)
    const metadata: UpdateStageMetadata = {
      extensionId: discovery.packageName,
      stagedVersion: discovery.packageVersion,
      stagedPath: join(canonical, 'package'),
      currentVersion: current.version,
      archiveDigest,
      contentDigest,
      report,
      stagedAt: new Date().toISOString(),
    }
    writeFileSync(stageMetadataPath(canonical), `${JSON.stringify(metadata, null, 2)}\n`)
    return {
      extensionId: discovery.packageName,
      stagedVersion: discovery.packageVersion,
      stagedPath: join(canonical, 'package'),
      report,
    }
  } catch (error) {
    // A refused stage leaves NO partial visibility: the staged extraction is
    // removed on every rejection path. The installed version was never touched.
    rmSync(attempt, { recursive: true, force: true })
    throw error
  }
}

/** Read and verify the staged-update metadata (fail-closed corruption). */
function readStageMetadata(stagedPath: string): UpdateStageMetadata {
  const path = stageMetadataPath(stagedPath)
  if (!existsSync(path)) {
    throw new ManagementError(
      'EXTENSION_FAULT',
      'install',
      `the staged update at ${stagedPath} has no metadata record; it cannot be trusted`,
      'Stage the update again; a staged directory without its record is never committed.',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ManagementError(
      'EXTENSION_FAULT',
      'install',
      `the staged update metadata is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      'Stage the update again; a corrupt record fails closed.',
    )
  }
  const candidate = parsed as Partial<UpdateStageMetadata>
  if (typeof candidate.extensionId !== 'string' || typeof candidate.stagedVersion !== 'string'
    || typeof candidate.stagedPath !== 'string' || typeof candidate.archiveDigest !== 'string'
    || typeof candidate.contentDigest !== 'string' || typeof candidate.report !== 'object') {
    throw new ManagementError(
      'EXTENSION_FAULT',
      'install',
      'the staged update metadata is malformed',
      'Stage the update again; a malformed record fails closed.',
    )
  }
  return candidate as UpdateStageMetadata
}

/** Locate the staged path for one extension/version (id sanitized for the path). */
function stagedPathFor(storeDir: string, extensionId: string, version: string): string {
  const safe = extensionId.replaceAll('/', '__')
  return join(resolve(storeDir), 'staging', `${safe}--${version}.staged`)
}

/**
 * Record ONE operator approval decision for a staged update (EXT-30).
 *
 * The record is retained for the store's lifetime and is write-once per staged
 * version (see {@link ExtensionStore.recordApproval}).
 * @param options - the store, the staged identity, and the decision.
 */
export function recordApproval(options: {
  readonly storeDir: string
  readonly extensionId: string
  readonly stagedVersion: string
  readonly decision: { approved: true } | { approved: false; reason: string }
}): void {
  new ExtensionStore(options.storeDir).recordApproval(options.extensionId, options.stagedVersion, options.decision)
}

/**
 * Commit a staged, approved update (EXT-30, two-phase seam).
 *
 * Under the store lock, in order: verify the approval → verify the staged
 * bytes (digest re-check, fail-closed) → verify the CURRENT active version's
 * directory (fail-closed) → admit the staged version to its OWN version
 * directory (never the live one) → **quiescePrevious** (the host stops
 * old-generation admissions BEFORE the pointer moves; a failure aborts the
 * commit with the pointer unchanged) → commit the pointer atomically via the
 * profile-state writer → **rebindNext** (the host republishes the new
 * generation; a failure rolls the pointer back AUTOMATICALLY and names the
 * reason).
 *
 * REBIND-REVERT CONTRACT: the automatic rollback after a rebindNext failure
 * runs NO further hooks — quiescePrevious is not re-run and no restore hook
 * fires. A host whose rebind needs its own revert must supply it INSIDE its
 * all-or-nothing rebindNext wrapper; the SDK never re-enters host hooks.
 *
 * NO-SEAM REFUSAL: a commit with no rebindNext REFUSES by default (the durable
 * pointer must not advance while nothing republishes the surface). Pass
 * `pointerOnly: true` as the explicit, documented deployment opt-out.
 *
 * @param options - the store, profile, staged identity, and the two-phase hooks.
 * @returns the committed pointer and the previous one.
 * @throws ManagementError for every rejection path.
 */
export async function commitUpdate(options: {
  readonly storeDir: string
  readonly profile: string
  readonly extensionId: string
  readonly stagedVersion: string
  /** Explicit opt-out: commit the pointer with NO hooks (deployment tooling only). */
  readonly pointerOnly?: boolean
  readonly hooks?: {
    /** Runs under the store lock BEFORE the pointer write; a failure aborts the commit. */
    readonly quiescePrevious?: (previousVersion: string) => Promise<void>
    /** Runs AFTER the pointer write; a failure auto-rolls the pointer back. */
    readonly rebindNext?: (stagedVersion: string) => Promise<void>
  }
}): Promise<UpdateCommitResult> {
  const quiescePrevious = options.hooks?.quiescePrevious
  const rebindNext = options.hooks?.rebindNext
  const store = new ExtensionStore(options.storeDir)
  return await store.exclusive(async () => {
    const approval = store.readApproval(options.extensionId, options.stagedVersion)
    if (approval.corrupt) {
      throw new ManagementError(
        'EXTENSION_FAULT',
        'install',
        `the approval record is unreadable: ${approval.diagnostic ?? 'unknown reason'}`,
        'Inspect the record deliberately; an unreadable approval never proceeds.',
      )
    }
    if (approval.value === undefined || !approval.value.approved) {
      throw new ManagementError(
        'UPGRADE_FAILED',
        'install',
        `${options.extensionId}@${options.stagedVersion} has no APPROVED record; the commit is refused`,
        'Record an explicit operator approval first; a commit never invents consent.',
      )
    }

    // NO-SEAM REFUSAL (fail closed): an approved commit with no rebindNext must
    // not move the durable pointer while nothing republishes the surface.
    if (rebindNext === undefined && options.pointerOnly !== true) {
      throw new ManagementError(
        'UPGRADE_FAILED',
        'install',
        `${options.extensionId}@${options.stagedVersion} cannot commit without a rebind seam: nothing would republish `
          + 'the new surface after the pointer moved',
        'Provide hooks.rebindNext (with hooks.quiescePrevious for the two-phase ordering), or pass pointerOnly: true '
          + 'for a deliberate deployment-tooling pointer commit.',
      )
    }

    const stagedPath = stagedPathFor(options.storeDir, options.extensionId, options.stagedVersion)
    const metadata = readStageMetadata(stagedPath)
    if (!existsSync(metadata.stagedPath) || digestInstalledContent(metadata.stagedPath) !== metadata.contentDigest) {
      throw new ManagementError(
        'EXTENSION_FAULT',
        'install',
        'the staged bytes changed or disappeared after staging; the commit is refused',
        'Stage the update again; a commit never proceeds over unverified bytes.',
      )
    }

    const pointers = store.readProfilePointers(options.profile)
    if (pointers.corrupt) {
      throw new ManagementError('EXTENSION_FAULT', 'install', `the profile pointers are unreadable: ${pointers.diagnostic ?? 'unknown reason'}`, 'Repair the profile state deliberately.')
    }
    const previous = pointers.value.activeVersions[options.extensionId]
    if (previous === undefined) {
      throw new ManagementError(
        'UPGRADE_FAILED',
        'install',
        `${options.extensionId} has no recorded active version; an update commits over an existing pointer`,
        'Activate the installed version first, or use the install flow for a fresh extension.',
      )
    }
    if (previous === options.stagedVersion) {
      throw new ManagementError(
        'UPGRADE_FAILED',
        'install',
        `${options.extensionId} is already active at ${options.stagedVersion}`,
        'Stage a different version.',
      )
    }

    // Fail closed: the CURRENT active version's directory must still verify.
    const currentRecordEntry = store.listInstalled().value.find(
      record => record.extensionId === options.extensionId && record.version === previous,
    )
    if (currentRecordEntry === undefined) {
      throw new ManagementError(
        'EXTENSION_FAULT',
        'install',
        `the active version ${previous} of ${options.extensionId} is not recorded; the commit is refused`,
        'Inspect the store lock; an update never commits over an unrecorded version.',
      )
    }
    const currentCheck = store.verifyUnchanged(currentRecordEntry)
    if (!currentCheck.unchanged) {
      throw new ManagementError(
        'EXTENSION_FAULT',
        'install',
        `cannot commit: the active version changed on disk (${currentCheck.diagnostic ?? 'unknown reason'})`,
        'Restore the active version or reinstall it; a commit never overwrites a changed live directory.',
      )
    }

    // Admission: promote the staged bytes to their OWN version directory.
    const destination = installPathFor(options.storeDir, options.extensionId, options.stagedVersion)
    const alreadyAdmitted = store.listInstalled().value.some(
      record => record.extensionId === options.extensionId && record.version === options.stagedVersion,
    )
    if (!alreadyAdmitted) {
      if (existsSync(destination)) {
        throw new ManagementError(
          'EXTENSION_FAULT',
          'install',
          `${options.extensionId}@${options.stagedVersion} exists on disk without a lock record; the commit is refused`,
          'Inspect the store; a directory without its record is never promoted over.',
        )
      }
      mkdirSync(join(destination, '..'), { recursive: true })
      renameSync(metadata.stagedPath, destination)
      writeFileSync(join(destination, '.tool-mode-install.json'), `${JSON.stringify({
        extensionId: options.extensionId,
        version: options.stagedVersion,
        archiveDigest: metadata.archiveDigest,
        source: { kind: 'update-stage', requested: 'staged update (EXT-30)' },
        installedAt: new Date().toISOString(),
      }, null, 2)}\n`)
      store.recordInstall({
        extensionId: options.extensionId,
        version: options.stagedVersion,
        installPath: destination,
        archiveDigest: metadata.archiveDigest,
        contentDigest: digestInstalledContent(destination),
        source: { kind: 'update-stage', requested: 'staged update (EXT-30)' },
        installedAt: new Date().toISOString(),
      })
    }
    // The staged directory is spent either way: the admitted copy is the
    // installation, and the stage metadata must not linger as a second source
    // of truth.
    rmSync(stagedPath, { recursive: true, force: true })

    const extensions = store.readProfileState(options.profile)
    if (extensions.corrupt) {
      throw new ManagementError('EXTENSION_FAULT', 'install', `the profile state is unreadable: ${extensions.diagnostic ?? 'unknown reason'}`, 'Repair the profile state deliberately.')
    }
    const priorPrevious = pointers.value.previousVersions[options.extensionId]
    const nextActive = { ...pointers.value.activeVersions, [options.extensionId]: options.stagedVersion }
    const nextPrevious = { ...pointers.value.previousVersions, [options.extensionId]: previous }

    // PHASE 1 — quiescePrevious: the host stops old-generation admissions
    // BEFORE the pointer moves. A failure ABORTS the commit: the pointer is
    // unchanged and rebindNext never runs.
    if (quiescePrevious !== undefined) {
      try {
        await quiescePrevious(previous)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new ManagementError(
          'UPGRADE_FAILED',
          'install',
          `the quiesce of ${previous} failed before the pointer commit; the commit is aborted and the pointer is unchanged: ${reason}`,
          'The previous version stays active. Diagnose the quiesce failure, then retry the commit.',
        )
      }
    }

    store.writeProfileState(options.profile, extensions.value, undefined, nextActive, nextPrevious)

    // PHASE 2 — rebindNext: the host republishes the new generation. A failure
    // rolls the pointer back AUTOMATICALLY and runs NO further hooks (the
    // rebind-revert contract: the host's own wrapper owns any revert it needs).
    if (rebindNext !== undefined) {
      try {
        await rebindNext(options.stagedVersion)
      } catch (error) {
        // AUTOMATIC ROLLBACK: the pointer returns to the previous version and
        // the reason is reported — the durable answer is never "half updated".
        const reason = error instanceof Error ? error.message : String(error)
        const rolledActive = { ...nextActive, [options.extensionId]: previous }
        const rolledPrevious = {
          ...nextPrevious,
          [options.extensionId]: priorPrevious ?? previous,
        }
        store.writeProfileState(options.profile, extensions.value, undefined, rolledActive, rolledPrevious)
        throw new ManagementError(
          'UPGRADE_FAILED',
          'install',
          `the rebind failed after the pointer commit; the pointer was rolled back to ${previous}: ${reason}`,
          'The previous version stays active. Diagnose the rebind failure, then retry the commit or stage a new version.',
        )
      }
    }

    return { extensionId: options.extensionId, activeVersion: options.stagedVersion, previousVersion: previous }
  })
}

/**
 * Roll back one extension to its previous active version (EXT-30 slice 2).
 *
 * POINTER RESTORE ONLY: no bytes are copied over any live install, disabled
 * tools stay disabled, revocations stay revoked (those facts live in the
 * profile state beside the pointer). The previous version's directory is
 * verified first; a corrupt previous version refuses the rollback (quarantine,
 * the current pointer stays).
 *
 * The optional `rebindRestored` hook (the host's republish of the restored
 * generation) runs AFTER the pointer restore. Its failure is REPORTED on the
 * result as `hookFailure` — the restore stands and no second rollback runs.
 *
 * @param options - the store, profile, extension, and the optional restore hook.
 * @returns the restored pointer.
 */
export async function rollback(options: {
  readonly storeDir: string
  readonly profile: string
  readonly extensionId: string
  /** Runs AFTER the pointer restore; a failure is reported, never rolled back again. */
  readonly rebindRestored?: (restoredVersion: string) => Promise<void>
}): Promise<UpdateRollbackResult> {
  const store = new ExtensionStore(options.storeDir)
  return await store.exclusive(async () => {
    const pointers = store.readProfilePointers(options.profile)
    if (pointers.corrupt) {
      throw new ManagementError('EXTENSION_FAULT', 'install', `the profile pointers are unreadable: ${pointers.diagnostic ?? 'unknown reason'}`, 'Repair the profile state deliberately.')
    }
    const active = pointers.value.activeVersions[options.extensionId]
    const previous = pointers.value.previousVersions[options.extensionId]
    if (active === undefined) {
      throw new ManagementError('UPGRADE_FAILED', 'install', `${options.extensionId} has no recorded active version to roll back from`, 'Activate an installed version first.')
    }
    if (previous === undefined) {
      throw new ManagementError('UPGRADE_FAILED', 'install', `${options.extensionId} has no previous version to roll back to`, 'There is no retained working version; nothing is restored.')
    }
    const record = store.listInstalled().value.find(
      candidate => candidate.extensionId === options.extensionId && candidate.version === previous,
    )
    if (record === undefined) {
      throw new ManagementError('EXTENSION_FAULT', 'install', `the rollback target ${previous} is not recorded; refusing`, 'Inspect the store lock; an unrecorded version is never restored.')
    }
    const check = store.verifyUnchanged(record)
    if (!check.unchanged) {
      throw new ManagementError(
        'EXTENSION_FAULT',
        'install',
        `cannot roll back: the previous version ${previous} changed on disk (${check.diagnostic ?? 'unknown reason'}); the extension stays quarantined on its current pointer`,
        'Restore or reinstall the previous version deliberately; a rollback never points at unverified bytes.',
      )
    }
    const extensions = store.readProfileState(options.profile)
    if (extensions.corrupt) {
      throw new ManagementError('EXTENSION_FAULT', 'install', `the profile state is unreadable: ${extensions.diagnostic ?? 'unknown reason'}`, 'Repair the profile state deliberately.')
    }
    const nextActive = { ...pointers.value.activeVersions, [options.extensionId]: previous }
    const nextPrevious = { ...pointers.value.previousVersions, [options.extensionId]: active }
    store.writeProfileState(options.profile, extensions.value, undefined, nextActive, nextPrevious)

    // The POST-RESTORE observer runs after the pointer restore has committed.
    // Its failure is REPORTED, never thrown: the restore must not be rolled
    // back again over a hook error (no double rollback).
    let hookFailure: string | undefined
    if (options.rebindRestored !== undefined) {
      try {
        await options.rebindRestored(previous)
      } catch (error) {
        hookFailure = error instanceof Error ? error.message : String(error)
      }
    }
    return {
      extensionId: options.extensionId,
      activeVersion: previous,
      previousVersion: active,
      ...hookFailure === undefined ? {} : { hookFailure },
    }
  })
}
