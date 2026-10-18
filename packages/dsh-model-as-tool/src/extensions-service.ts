/**
 * The HOST half of the extension-management surface (Settings → Model as Tool).
 *
 * This module implements {@link ModelToolsRemote} from `extensions-api.ts` and is
 * deliberately WIRE-AGNOSTIC: it imports `node:*` and the published SDK, never DSH,
 * never the client page, and never the generated Typert artifact. That boundary is
 * what lets the same implementation be exercised by unit tests without a Context,
 * by the plugin at `apply`, and by whatever transports the browser half uses.
 *
 * The governing rule is TRUTHFULNESS over convenience, because every field here is
 * shown to an operator who is about to change what code their host runs:
 *
 * - `store` is `null` when no extension store is configured, rather than an empty
 *   string that a caller could mistake for a mounted store.
 * - `writable` is derived from a real access check on the store path and from the
 *   store lock being readable, not assumed from "the config mentions a directory".
 * - `installed` means a record exists in the store lock; `active` means the
 *   persisted observation was made by THIS process; `integrity` is `unknown` when
 *   the installed bytes could not be digested, never `unchanged` by default.
 * - `reason` names the FIRST condition that prevents install/activation, so a UI
 *   can show why an extension is not usable instead of guessing.
 *
 * INSTALLATION IS NOT ACTIVATION (EXT-07): `install` returns `active: false` and
 * never calls the lifecycle. `enable`/`disable` are the only activation paths.
 *
 * FIRST-PARTY DEPENDENCIES (EXT-09): a source-directory install also supplies the
 * SDK's dependency graph (`extension-dependencies.ts`), which resolves every
 * declared runtime dependency from the host's own installed tree and refuses the
 * install by name when one is missing. With the operator's preinstalled-content
 * gate on, the resolved directory is copied by the SDK and recorded with
 * `provenance: 'preinstalled'`; with it off (the default), the dependency is served
 * as verified archive bytes and EXT-10's lifecycle-script refusal applies.
 *
 * PERSISTENCE, STATED HONESTLY:
 *
 * - Activation intent is durable through the SDK: `ExtensionLifecycle.activate`
 *   writes `desiredActivation: 'active'` and `deactivate` writes `'inactive'` into
 *   the profile state document, so a restart follows the operator's last toggle
 *   even when nothing else persists.
 * - The operator's `disabledExtensions` list is a CONFIG value (Settings form). This
 *   service cannot write plugin config from the host: no config writer is injected.
 *   It therefore keeps this process's toggles as an in-memory override, seeded from
 *   `disabledExtensions`, and exposes `persistDisabledExtensions` as the seam a host
 *   with a config writer supplies. Without that seam, a toggle is truthfully
 *   reported as affecting this process only, and a `disable` survives restart via
 *   the SDK's durable `desiredActivation: 'inactive'` while an `enable` of an id
 *   still listed in config will be filtered by the restore gate on the next load.
 *
 * @module @try-works/dsh-model-as-tool/extensions-service
 */

import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  digestInstalledContent,
  discoverExtension,
  ExtensionStore,
  ManagementError,
  stagedInstallFromDirectory,
  type ExtensionLifecycle,
  type ExtensionState as SdkExtensionState,
  type InstallDependencyGraph,
  type InstalledRecord,
} from '@try-works/tool-mode-extension-sdk'
import type {
  ExtensionInstallResult,
  ExtensionModelReadiness,
  ExtensionPreparationPlan,
  ExtensionPrepareResult,
  ExtensionReadinessMap,
  ExtensionRequirement,
  ExtensionRequirementAction,
  ExtensionRequirementKind,
  ExtensionState,
  ExtensionToggleResult,
  ExtensionsDescribeResult,
  ModelToolsRemote,
} from './extensions-api.ts'
import { createFirstPartyDependencyGraph, resolveFirstPartyDependency } from './extension-dependencies.ts'
import type { AcquisitionSource } from './asset-acquisition.ts'
import { createHttpSource } from './http-acquisition.ts'
import type { PreparationOutcome, PrepareAssetsSurface } from './prepared-assets.ts'
import type { PreparationPlan } from './deployment-coordinator.ts'

/**
 * The readiness values that permit activation (the SDK's callable set).
 *
 * `prepared-cold` is callable: the model loads on first use. Every other value is
 * a concrete blocker this service names in a row reason and in the enable refusal.
 */
const CALLABLE_READINESS: ReadonlySet<string> = new Set<string>([
  'prepared-cold',
  'loading',
  'ready',
  'busy',
])

/**
 * The order an unmet requirement is surfaced in (row reason and enable preflight).
 *
 * Integrity and platform first (nothing the operator can do in the page will clear
 * them), then what the operator CAN act on: dependencies, the harness model, the
 * executable approval, model assets, activation cleanup; store/source last because
 * an installed row already satisfied them.
 */
const REQUIREMENT_PRIORITY: readonly ExtensionRequirementKind[] = [
  'integrity',
  'platform',
  'dependencies',
  'harness-model',
  'executable',
  'assets',
  'activation',
  'store',
  'source',
]

/**
 * Whether one UNMET requirement actually prevents this row from reaching active.
 *
 * A not-yet-installed row is blocked only by facts that would stop the INSTALL or
 * would make the eventual activation impossible (store/source, dependencies,
 * platform, harness model). Readiness, executable approval, integrity and
 * activation state describe installed bytes, so they are not meaningful before an
 * install and do not by themselves make the Install button impossible.
 * @param installed - whether the store holds an installed copy.
 * @param requirement - the requirement to classify.
 * @returns whether the unmet requirement blocks the row.
 */
function blocksRow(installed: boolean, requirement: ExtensionRequirement): boolean {
  if (requirement.satisfied) return false
  if (installed) return true
  return requirement.kind === 'store'
    || requirement.kind === 'source'
    || requirement.kind === 'dependencies'
    || requirement.kind === 'platform'
    || requirement.kind === 'harness-model'
}

/** Build one requirement value. */
function requirement(
  kind: ExtensionRequirementKind,
  satisfied: boolean,
  reason: string,
  action: ExtensionRequirementAction = 'none',
): ExtensionRequirement {
  return { kind, satisfied, reason, action }
}

/** The highest-priority UNMET requirement that blocks this row, or undefined. */
function firstBlockingRequirement(
  requirements: readonly ExtensionRequirement[],
  installed: boolean,
): ExtensionRequirement | undefined {
  for (const kind of REQUIREMENT_PRIORITY) {
    const found = requirements.find(candidate => candidate.kind === kind)
    if (found !== undefined && blocksRow(installed, found)) return found
  }
  return undefined
}

/** What the host can report about the shared harness model provider (declarative extensions). */
export interface HarnessProviderStatus {
  /** Whether a provider is composed and able to serve declarative extensions. */
  readonly available: boolean
  /** Provider identity when available, for the satisfied reason. */
  readonly provider?: string
  /** Model identity the provider serves, when known. */
  readonly model?: string
  /**
   * REQUIRED when `available` is false: why not, and the exact remediation.
   *
   * Used VERBATIM as the harness-model requirement reason (and the enable preflight
   * message), so it must be operator-facing and name the configuration that fixes it.
   */
  readonly reason?: string
  /** What clears it; defaults to `config`. */
  readonly action?: 'config' | 'none'
}

/** The lifecycle surface this service needs. Narrower than the class, so a test can double it. */
export type ExtensionActivation = Pick<ExtensionLifecycle, 'stateOf' | 'activate' | 'deactivate'>

/** The directory installer signature the service delegates to. */
export type DirectoryInstaller = (options: Parameters<typeof stagedInstallFromDirectory>[0]) => ReturnType<typeof stagedInstallFromDirectory>

/** Every named refusal this service raises. */
export type ExtensionsServiceErrorCode =
  /** `install`/`enable`/`disable` need `config.extensionStore`; it is not configured. */
  | 'extension-store-unconfigured'
  /** `install` had no explicit source and `config.extensionSourceDir` is not configured. */
  | 'extension-source-unconfigured'
  /** The resolved source directory does not exist, or is not a directory. */
  | 'extension-source-missing'
  /** The requested id is not a usable package identity (a path could escape the source root). */
  | 'extension-id-invalid'
  /** The source package's own name is not the id that was requested. */
  | 'extension-source-mismatch'
  /** The source directory does not contain a discoverable extension package. */
  | 'extension-source-invalid'
  /** Source-directory installs are developer mode and must be allowed by configuration. */
  | 'extension-source-directories-not-allowed'
  /** The integrity digest of the source or the installed copy could not be computed. */
  | 'extension-digest-unavailable'
  /** The SDK installer refused or failed; its own named error is carried in the message. */
  | 'extension-install-failed'
  /** A declared runtime dependency could not be resolved, verified or materialized. */
  | 'extension-dependency-unsatisfied'
  /** The extension has no installed record in the store, so it cannot be activated. */
  | 'extension-not-installed'
  /** The store lock or the profile state document is unreadable, so activation state cannot be trusted. */
  | 'extension-store-unreadable'
  /** The host mounted no lifecycle (no store at load), so activation state cannot change. */
  | 'extension-activation-unavailable'
  /** `activate` refused or failed; the SDK's named error is carried in the message. */
  | 'extension-activation-failed'
  /** Activation is refused because a declared model's assets were never prepared. */
  | 'extension-preparation-required'
  /** The host mounted no prepared-assets surface, so assets cannot be prepared here. */
  | 'extension-preparation-unavailable'
  /** The preparation plan could not be resolved or its readiness could not be recorded. */
  | 'extension-preparation-failed'
  /** A prerequisite the deployment cannot satisfy blocks activation before any lifecycle call. */
  | 'extension-requirement-unmet'
  /** `deactivate` refused or failed; the SDK's named error is carried in the message. */
  | 'extension-deactivation-failed'
  /** The host's disabled-list writer rejected the new list after the action landed. */
  | 'extension-override-persist-failed'

/**
 * A named refusal from the extension-management surface.
 *
 * The `code` is stable and machine-readable; the message is operator-facing and
 * names the concrete condition (path, SDK code, or identity) rather than a generic
 * "failed", because the Settings page shows it verbatim.
 */
export class ExtensionsServiceError extends Error {
  override readonly name = 'ExtensionsServiceError'
  readonly code: ExtensionsServiceErrorCode

  constructor(code: ExtensionsServiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

/** The host's disabled-list store. `list` is read live; `set` is called after a toggle. */
export interface ExtensionsServiceOptions {
  /** `config.extensionStore`; empty means no extension store is configured. */
  readonly storeDir?: string
  /**
   * `config.extensionSourceDir`: the directory that holds first-party package
   * checkouts, one directory per package. Empty means no source directory.
   */
  readonly sourceDir?: string
  /**
   * `config.extensions.allowSourceDirectories`: the explicit developer-mode gate.
   * Absent/false refuses every directory install with a named error.
   */
  readonly allowSourceDirectories?: boolean
  /** The lifecycle profile; defaults to `default`, the profile the host restores. */
  readonly profile?: string
  /** Read `config.disabledExtensions` live. */
  readonly disabledExtensions?: () => readonly string[]
  /**
   * Persist the effective disabled list. The host's implementation must arrange for
   * `disabledExtensions()` to return the same list afterwards; a rejection is
   * surfaced as `extension-override-persist-failed`.
   */
  readonly persistDisabledExtensions?: (ids: readonly string[]) => void | Promise<void>
  /**
   * The mounted lifecycle, read lazily. Absent means the host mounted none, and
   * `enable`/`disable` refuse with `extension-activation-unavailable` instead of
   * pretending the durable state changed.
   */
  readonly lifecycle?: () => ExtensionActivation | undefined
  /** Declare that this host cannot write the store (read-only mount). */
  readonly readOnly?: boolean
  /** INTERNAL TEST SEAM: the directory installer, defaulting to the SDK's staged path. */
  readonly installDirectory?: DirectoryInstaller
  /** INTERNAL TEST SEAM: the content digest, defaulting to the SDK's installed-content digest. */
  readonly digestContent?: (directory: string) => string
  /**
   * INTERNAL TEST SEAM: the dependency graph for a first-party source checkout.
   *
   * The default resolves each declared dependency from the host's own installed
   * tree (`extension-dependencies.ts`) and refuses the install, by name, when one
   * is not installed or is inadmissible. The graph is part of the same
   * developer-mode source-directory gate; it is never consulted for anything else.
   */
  readonly dependencyGraph?: (sourcePackageDir: string) => InstallDependencyGraph
  /**
   * Operator gate for PREINSTALLED dependency content (task-84); DEFAULT OFF.
   *
   * When on, a dependency resolved from the host's installed tree is copied by the
   * SDK into the extension's own install directory and recorded with
   * `provenance: 'preinstalled'` — the content arrived from an operator-completed
   * install and this installer ran no lifecycle script. When off, the bytes arm
   * applies and EXT-10's script refusal is unchanged. Requires
   * {@link ExtensionsServiceOptions.preinstalledDependenciesRoot}.
   */
  readonly allowPreinstalledDependencies?: boolean
  /** The operator-configured root preinstalled dependency directories must live under. */
  readonly preinstalledDependenciesRoot?: string
  /**
   * The mounted prepared-assets surface, read lazily (the plugin constructs it in
   * `apply` after this service). Absent means the host mounted no asset surface,
   * and `prepare` refuses with `extension-preparation-unavailable`.
   */
  readonly prepareSurface?: () => PrepareAssetsSurface | undefined
  /**
   * The acquisition source a preparation uses. Defaults to the real ranged HTTP
   * source; a test injects a local source and the suite therefore performs no
   * network.
   */
  readonly preparationSource?: () => AcquisitionSource
  /**
   * Read the operator's STANDING RES-02 approval for executable assets.
   *
   * DEFAULT FALSE. When false, `prepare` passes `allowExecutable: false` and the
   * prepared-assets registry returns its exact refusal without acquiring anything.
   * When the operator explicitly configured the approval, that is the standing
   * consent for the digest-pinned plans this host resolves; the management channel
   * (`extensions-prepare`) still takes its own PER-CALL flag and is unaffected.
   */
  readonly allowExecutablePreparation?: () => boolean
  /**
   * Read the host's harness-model provider status (task-93 seam).
   *
   * Consulted only for `execution.kind === 'declarative'` extensions, which are
   * served by the host's harness broker and therefore need a composed LlmProvider.
   * Absent means the host cannot answer; the harness-model requirement is then
   * reported unsatisfied with an honest "provider status unknown" reason.
   */
  readonly harnessProviderStatus?: () => HarnessProviderStatus | undefined
  /**
   * Notified when this service changes an extension's activation intent.
   *
   * The host's contribution registrar refuses to publish a tool for an extension
   * absent from its activated set, so a runtime `enable` must admit the id BEFORE
   * the lifecycle publishes and revoke it when activation fails or the extension is
   * disabled. The host implementations may reconcile against the lifecycle state.
   */
  readonly onActivationChange?: (extensionId: string, active: boolean) => void
}

/** One first-party package found under the configured source directory. */
interface SourcePackage {
  readonly id: string
  readonly version: string | null
  readonly tools: readonly string[]
  /** Everything the requirement model reads from the checkout. */
  readonly facts: ExtensionFacts
  /** Set when the package exists but cannot be used as an extension. */
  readonly problem: string | null
}

/** An installed copy's content-verification verdict. */
interface IntegrityView {
  readonly integrity: ExtensionState['integrity']
  /** The diagnostic text when the verdict is not `unchanged`. */
  readonly reason: string | null
}

/** Everything the requirement model needs about one row, already read by the caller. */
interface RequirementInput {  readonly id: string
  readonly installed: boolean
  readonly record: InstalledRecord | undefined
  readonly state: SdkExtensionState | undefined
  readonly integrity: ExtensionState['integrity']
  readonly integrityReason: string | null
  readonly storeDir: string
  readonly sourceDir: string
  readonly lockCorrupt: boolean
  readonly lockDiagnostic: string | null
  readonly profileStates: ProfileStateView
  readonly sourcePackage: SourcePackage | undefined
  readonly facts: ExtensionFacts
}

/**
 * The directory a first-party checkout for one package identity occupies.
 *
 * A source directory holds PACKAGE DIRECTORIES, not scoped directories: the
 * workspace layout is `packages/extension-laya`, whose package name is
 * `@try-works/extension-laya`. The scope is therefore dropped and the final path
 * segment is used, which is the only mapping that requires no registry lookup.
 * @param extensionId - the extension identity, which equals its package name.
 * @returns the directory name under the configured source directory.
 */
export function packageDirFor(extensionId: string): string {
  const slash = extensionId.lastIndexOf('/')
  return slash === -1 ? extensionId : extensionId.slice(slash + 1)
}

/** A package identity: one optional scope segment, then one name segment. */
const PACKAGE_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i

/**
 * Refuse an identity that cannot safely become a path component.
 *
 * `packageDirFor` is joined onto the source directory, so an id such as `..` or
 * one carrying a separator would address a directory outside the configured root.
 * @param extensionId - the requested id.
 * @throws ExtensionsServiceError `extension-id-invalid`.
 */
function assertUsableId(extensionId: string): void {
  if (!PACKAGE_ID.test(extensionId)) {
    throw new ExtensionsServiceError(
      'extension-id-invalid',
      `${JSON.stringify(extensionId)} is not a package identity; expected a name like @scope/name`,
    )
  }
}

/** A message from an arbitrary thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One platform a manifest's model deployment declares. */
interface DeclaredPlatform {
  readonly os: string
  readonly arch: string
  readonly accelerator?: string
}

/** One runtime dependency the extension's package.json declares. */
interface DeclaredDependency {
  readonly name: string
  readonly range: string
}

/**
 * Everything the requirement model reads from one package directory.
 *
 * Discovery supplies the manifest facts; package.json supplies the runtime
 * dependencies. A package whose manifest cannot be read still yields its identity
 * and dependency declarations when package.json is readable, so a broken checkout
 * can be reported by name with a reason instead of vanishing.
 */
interface ExtensionFacts {
  readonly packageName: string | null
  readonly packageVersion: string | null
  readonly packageDir: string | null
  readonly tools: readonly string[]
  readonly models: readonly string[]
  /** `module` or `declarative`; undefined when the manifest could not be read. */
  readonly executionKind: string | undefined
  readonly platforms: readonly DeclaredPlatform[]
  readonly dependencies: readonly DeclaredDependency[]
  /** Set when discovery failed; the requirement/reason text reports it. */
  readonly problem: string | null
}

/** Facts for a row with no readable package directory. */
const EMPTY_FACTS: ExtensionFacts = {
  packageName: null,
  packageVersion: null,
  packageDir: null,
  tools: [],
  models: [],
  executionKind: undefined,
  platforms: [],
  dependencies: [],
  problem: null,
}

/** Read a package.json's `dependencies` as name→range pairs; empty when unreadable. */
function readDeclaredDependencies(packageDir: string | null): readonly DeclaredDependency[] {
  if (packageDir === null) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return []
    // SAFETY: the value came from JSON.parse and the object guard above; only
    // string-valued dependency specs are kept, so an unexpected shape yields an
    // empty declaration rather than a trusted one.
    const dependencies = (parsed as { readonly dependencies?: unknown }).dependencies
    if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) return []
    const declared: DeclaredDependency[] = []
    // SAFETY: the dependency container was checked to be a non-array object; only
    // string entries become declared dependencies, and non-strings are ignored.
    for (const [name, range] of Object.entries(dependencies as Record<string, unknown>)) {
      if (typeof range === 'string' && range.length > 0) declared.push({ name, range })
    }
    return declared
  } catch {
    return []
  }
}

/**
 * Read one package directory's declared facts without importing or executing it.
 * @param packageDir - the installed copy or first-party checkout.
 * @returns the facts, with `problem` set (and manifest facts empty) when discovery fails.
 */
function readExtensionFacts(packageDir: string): ExtensionFacts {
  const dependencies = readDeclaredDependencies(packageDir)
  try {
    const discovery = discoverExtension(packageDir)
    const manifest = discovery.manifest
    return {
      packageName: discovery.packageName,
      packageVersion: discovery.packageVersion,
      packageDir,
      tools: manifest.tools.map(tool => tool.name),
      models: manifest.models.map(model => model.id),
      executionKind: manifest.execution.kind,
      platforms: manifest.models.flatMap(model => model.platforms),
      dependencies,
      problem: null,
    }
  } catch (error) {
    return {
      ...EMPTY_FACTS,
      packageName: null,
      packageVersion: null,
      packageDir,
      dependencies,
      problem: `the package at ${packageDir} is not a usable extension: ${messageOf(error)}`,
    }
  }
}

/** A short human label for one declared platform. */
function platformLabel(platform: DeclaredPlatform): string {
  return `${platform.os}-${platform.arch}${platform.accelerator === undefined ? '' : `-${platform.accelerator}`}`
}

/**
 * Whether the host's own platform matches any declared deployment platform.
 * @param platforms - the manifest's declared platforms.
 * @returns whether this host can run the declared deployment.
 */
function hostPlatformMatches(platforms: readonly DeclaredPlatform[]): boolean {
  return platforms.some(platform => platform.os === process.platform && platform.arch === process.arch)
}

/**
 * Every declared deployment whose recorded readiness does not permit activation.
 *
 * A deployment with NO recorded readiness is reported as `needs-preparation`
 * because that is the constant the SDK's lifecycle projects for an undeclared
 * state (`#readinessOf` defaults every declared model to `needs-preparation`);
 * reporting anything else would invent a fact the host does not hold.
 * @param readiness - the persisted readiness map (may be empty).
 * @param declaredModels - the manifest's model deployment ids.
 * @returns one operator-facing line per blocker, most actionable phrasing first.
 */
function preparationBlockers(
  readiness: Readonly<Record<string, string>>,
  declaredModels: readonly string[],
): string[] {
  const blockers: string[] = []
  for (const modelId of declaredModels) {
    const value = readiness[modelId] ?? 'needs-preparation'
    if (CALLABLE_READINESS.has(value)) continue
    if (value === 'needs-preparation') {
      blockers.push(`${modelId} needs its model assets prepared — run prepare for this extension`)
    } else if (value === 'preparing') {
      blockers.push(`${modelId} is still preparing its model assets`)
    } else if (value === 'unavailable') {
      blockers.push(`${modelId} is unavailable on this host — its runtime or assets are missing`)
    } else if (value === 'failed') {
      blockers.push(`${modelId} failed inspection on this host — repair or reinstall its assets, then prepare again`)
    } else {
      blockers.push(`${modelId} is ${value}, which does not permit activation`)
    }
  }
  return blockers
}

/** Project the SDK/coordinator readiness map onto the wire readiness vocabulary. */
function readinessView(
  readiness: Readonly<Record<string, string>>,
  declaredModels: readonly string[],
): ExtensionReadinessMap {
  const view: Record<string, ExtensionModelReadiness> = {}
  for (const modelId of declaredModels) {
    const value = readiness[modelId]
    // SAFETY: a readiness value read from the SDK's state is one of the SDK's
    // ModelReadiness literals, which is the same union as ExtensionModelReadiness;
    // an absent entry is projected as its documented default.
    view[modelId] = value === undefined ? 'needs-preparation' : value as ExtensionModelReadiness
  }
  return view
}

/**
 * Project the coordinator's plan onto the wire disclosure.
 *
 * The digest and identity fields the provider needs stay host-side; the page gets
 * the bytes, sources, executable flags, totals, terms and revision an operator
 * approves (the same fields the management channel discloses).
 * @param plan - the resolved preparation plan.
 * @returns the wire disclosure.
 */
function preparationPlanView(plan: PreparationPlan): ExtensionPreparationPlan {
  return {
    modelId: plan.identity.modelId,
    modelRevision: plan.identity.modelRevision,
    assets: plan.assets.map(asset => ({
      assetId: asset.assetId,
      bytes: asset.bytes,
      source: asset.source,
      executable: asset.executable,
    })),
    totalBytes: plan.totalBytes,
    storageBytes: plan.storageBytes,
    requiresExecutableApproval: plan.requiresExecutableApproval,
    license: { name: plan.license.name, url: plan.license.url },
  }
}

/**
 * Whether this process is likely able to create or write inside a directory.
 *
 * `access(W_OK)` is the strongest check available without performing a write, and
 * it can still report success on a Windows ACL that later denies one. That gap is
 * the reason every action names its write failure instead of trusting `writable`.
 * @param directory - the store directory (it may not exist yet).
 * @returns whether the nearest existing ancestor is a writable directory.
 */
function directoryWritable(directory: string): boolean {
  try {
    let candidate = resolve(directory)
    while (!existsSync(candidate)) {
      const parent = dirname(candidate)
      if (parent === candidate) return false
      candidate = parent
    }
    if (!statSync(candidate).isDirectory()) return false
    accessSync(candidate, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** The `readProfileState` result fields this module reads. */
interface ProfileStateView {
  readonly byId: ReadonlyMap<string, SdkExtensionState>
  readonly corrupt: boolean
  readonly diagnostic: string | null
}

/**
 * The SDK lifecycle state for one profile, indexed by extension id.
 * @param store - the extension store.
 * @param profile - the lifecycle profile.
 * @returns the states and whether the document could be trusted.
 */
function readProfileStates(store: ExtensionStore, profile: string): ProfileStateView {
  const result = store.readProfileState(profile)
  const byId = new Map<string, SdkExtensionState>()
  for (const state of result.value) byId.set(state.extensionId, state)
  return { byId, corrupt: result.corrupt, diagnostic: result.diagnostic ?? null }
}

/** Read a candidate package.json name for a directory whose discovery failed. */
function declaredPackageName(directory: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (parsed === null) return undefined
    // SAFETY: the value was parsed from the package's own package.json, and a
    // non-string `name` is rejected below rather than trusted. The null guard above
    // is what keeps the property read total for this boundary.
    const name = (parsed as { readonly name?: unknown }).name
    return typeof name === 'string' && PACKAGE_ID.test(name) ? name : undefined
  } catch {
    return undefined
  }
}

/**
 * Discover every first-party package under a source directory.
 *
 * A directory whose package.json is unreadable is not listed at all: without an
 * identity there is nothing truthful to name. A directory whose package.json names
 * a package but whose manifest is unusable is listed WITH the reason, so the
 * operator can see the broken checkout instead of an unexplained absence.
 * @param sourceDir - the configured source directory.
 * @returns packages in directory-name order.
 */
function listSourcePackages(sourceDir: string): readonly SourcePackage[] {
  let entries
  try {
    entries = readdirSync(sourceDir, { withFileTypes: true })
  } catch {
    return []
  }
  const packages: SourcePackage[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue
    const directory = join(sourceDir, entry.name)
    const facts = readExtensionFacts(directory)
    if (facts.packageName !== null && facts.problem === null) {
      packages.push({
        id: facts.packageName,
        version: facts.packageVersion,
        tools: facts.tools,
        facts,
        problem: null,
      })
      continue
    }
    const id = facts.packageName ?? declaredPackageName(directory)
    if (id === undefined) continue
    packages.push({
      id,
      version: facts.packageVersion,
      tools: facts.tools,
      facts: facts.problem === null
        ? { ...facts, problem: `the package at ${directory} could not be discovered as an extension` }
        : facts,
      problem: facts.problem ?? `the package at ${directory} could not be discovered as an extension`,
    })
  }
  return packages
}

/**
 * Select the current installed record for one identity.
 *
 * The EXT-30 active-version pointer wins when it names an installed version; a
 * store without pointers (the pre-update world) uses the last recorded version,
 * which is the order `recordInstall` appends in.
 * @param records - every installed record.
 * @param activeVersions - the EXT-30 pointer map.
 * @param extensionId - the identity to select.
 * @returns the selected record, or undefined when nothing is installed for the id.
 */
function selectInstalled(
  records: readonly InstalledRecord[],
  activeVersions: Readonly<Record<string, string>>,
  extensionId: string,
): InstalledRecord | undefined {
  const versions = records.filter(record => record.extensionId === extensionId)
  const newest = versions[versions.length - 1]
  if (newest === undefined) return undefined
  const pointedVersion = activeVersions[extensionId]
  return pointedVersion === undefined
    ? newest
    : versions.find(candidate => candidate.version === pointedVersion) ?? newest
}

/**
 * The extension-management service: describe, install, enable, disable.
 *
 * Construct one per host and share it between the wire transport and any local
 * surface; it owns the in-process override list and must not be duplicated, or two
 * instances would report different disabled sets.
 */
export class ExtensionsService implements ModelToolsRemote {
  readonly #options: ExtensionsServiceOptions
  /**
   * This process's disabled choices, layered over `config.disabledExtensions`.
   *
   * An override lives for the life of the process: a Settings save that rewrites
   * the config list cannot silently undo a toggle the operator just made here, and
   * the override is dropped on restart, when the persisted config is read again.
   */
  readonly #overrides = new Map<string, boolean>()

  constructor(options: ExtensionsServiceOptions = {}) {
    this.#options = options
  }

  /** The configured store as an absolute path, or `''` when unconfigured. */
  #storeDir(): string {
    const configured = this.#options.storeDir ?? ''
    return configured.trim().length === 0 ? '' : resolve(configured)
  }

  /** The configured source directory as an absolute path, or `''` when unconfigured. */
  #sourceDir(): string {
    const configured = this.#options.sourceDir ?? ''
    return configured.trim().length === 0 ? '' : resolve(configured)
  }

  /** The lifecycle profile this service reads and writes. */
  #profile(): string {
    return this.#options.profile ?? 'default'
  }

  /** The mounted lifecycle, or undefined when the host mounted none. */
  #lifecycle(): ExtensionActivation | undefined {
    return this.#options.lifecycle?.()
  }

  /**
   * Require a configured store.
   * @throws ExtensionsServiceError `extension-store-unconfigured`.
   * @returns the absolute store directory.
   */
  #requireStoreDir(): string {
    const storeDir = this.#storeDir()
    if (storeDir === '') {
      throw new ExtensionsServiceError(
        'extension-store-unconfigured',
        'no extension store is configured (config.extensionStore); install and activation state cannot be read or changed',
      )
    }
    return storeDir
  }

  /** The disabled set this process reports: configured ids, adjusted by local toggles. */
  #effectiveDisabled(): Set<string> {
    const ids = new Set(this.#options.disabledExtensions?.() ?? [])
    for (const [id, disabled] of this.#overrides) {
      if (disabled) ids.add(id)
      else ids.delete(id)
    }
    return ids
  }

  /** Record one toggle in this process. */
  #rememberDisabled(extensionId: string, disabled: boolean): void {
    this.#overrides.set(extensionId, disabled)
  }

  /**
   * Hand the effective disabled list to the host's writer, when one exists.
   * @throws ExtensionsServiceError `extension-override-persist-failed` when the
   *   writer rejects; the caller reports the partial outcome.
   */
  async #persistDisabled(): Promise<void> {
    const persist = this.#options.persistDisabledExtensions
    if (persist === undefined) return
    const ids = [...this.#effectiveDisabled()].sort()
    try {
      await persist(ids)
    } catch (error) {
      throw new ExtensionsServiceError(
        'extension-override-persist-failed',
        `the disabled list could not be persisted, so the change applies to this process only: ${messageOf(error)}`,
        { cause: error },
      )
    }
  }

  /** The content digest, through the test seam when one was supplied. */
  #digest(directory: string): string {
    const digest = this.#options.digestContent ?? digestInstalledContent
    return digest(directory)
  }

  /**
   * Select the installed version to operate on, refusing to guess over a corrupt store.
   *
   * A corrupt lock or profile document yields no records from the SDK's fail-closed
   * read, and treating that as "not installed" would tell the operator the package
   * is absent when the truth is that the store cannot be read.
   * @param storeDir - the configured store.
   * @param extensionId - the identity to select.
   * @returns the current installed record.
   * @throws ExtensionsServiceError `extension-store-unreadable` or `extension-not-installed`.
   */
  #requireInstalled(storeDir: string, extensionId: string): InstalledRecord {
    const store = new ExtensionStore(storeDir)
    const lock = store.readLock()
    if (lock.corrupt) {
      throw new ExtensionsServiceError(
        'extension-store-unreadable',
        `the extension store lock at ${store.lockPath} is unreadable, so ${extensionId} cannot be managed: ${lock.diagnostic ?? 'unknown reason'}`,
      )
    }
    const pointers = store.readProfilePointers(this.#profile())
    if (pointers.corrupt) {
      throw new ExtensionsServiceError(
        'extension-store-unreadable',
        `the profile activation state for ${this.#profile()} is unreadable, so ${extensionId} cannot be managed: ${pointers.diagnostic ?? 'unknown reason'}`,
      )
    }
    const selection = selectInstalled(lock.value.extensions, pointers.value.activeVersions, extensionId)
    if (selection === undefined) {
      throw new ExtensionsServiceError(
        'extension-not-installed',
        `${extensionId} has no installed record in ${storeDir}; install it before changing its activation state`,
      )
    }
    return selection
  }
  /** The directory installer, through the test seam when one was supplied. */
  #install(options: Parameters<typeof stagedInstallFromDirectory>[0]): ReturnType<typeof stagedInstallFromDirectory> {
    const install = this.#options.installDirectory ?? stagedInstallFromDirectory
    return install(options)
  }

  /**
   * The dependency graph a first-party source install resolves against.
   *
   * The SDK calls it only when the package declares runtime dependencies; the
   * default graph resolves each one from the host's own installed tree and refuses
   * by name when it cannot. Constructing it is cheap and performs no I/O.
   * @param sourcePackageDir - the checkout being installed.
   * @returns the graph the SDK's directory installer consumes.
   */
  #dependencyGraph(sourcePackageDir: string): InstallDependencyGraph {
    const supplied = this.#options.dependencyGraph
    if (supplied !== undefined) return supplied(sourcePackageDir)
    const root = this.#options.preinstalledDependenciesRoot
    const base = {
      sourcePackageDir,
      allowPreinstalled: this.#options.allowPreinstalledDependencies === true,
    }
    return (root === undefined
      ? createFirstPartyDependencyGraph(base)
      : createFirstPartyDependencyGraph({ ...base, preinstalledRoot: root })).graph
  }

  /**
   * Verify an installed copy's content digest.
   * @param storeDir - the configured store.
   * @param record - the installed record, when there is one.
   * @returns the integrity verdict plus the diagnostic text when it is not unchanged.
   */
  #integrityOf(
    storeDir: string,
    record: InstalledRecord | undefined,
  ): IntegrityView {
    if (record === undefined || storeDir === '') return { integrity: 'unknown', reason: null }
    try {
      const verdict = new ExtensionStore(storeDir).verifyUnchanged(record)
      return {
        integrity: verdict.unchanged ? 'unchanged' : 'changed',
        reason: verdict.unchanged
          ? null
          : `the installed content is not the content that was recorded: ${verdict.diagnostic ?? 'it changed on disk after installation'}`,
      }
    } catch (error) {
      return {
        integrity: 'unknown',
        reason: `the installed content could not be digested, so its integrity is unknown: ${messageOf(error)}`,
      }
    }
  }

  /**
   * Compute EVERY prerequisite this deployment checked, satisfied or not.
   *
   * The list is the answer to "why can't I enable this?" BEFORE an enable is
   * attempted: each unmet requirement names the exact fact and (when one exists)
   * the action that clears it. Nothing here executes extension code; the only I/O
   * is the store read the caller already performed, discovery of the package
   * directory, a host-tree dependency walk, and the preparation PLAN (not an
   * acquisition) when an executable approval might be pending.
   * @param input - the row's already-read facts.
   * @returns the requirements in display order (store, source, dependencies,
   *   platform, integrity, harness-model, executable, assets, activation).
   */
  #computeRequirements(input: RequirementInput): readonly ExtensionRequirement[] {
    const requirements: ExtensionRequirement[] = []

    // STORE: configured and readable. Writability is a surface property the page
    // already receives as `writable`; a read-only mount still answers reads.
    if (input.storeDir === '') {
      requirements.push(requirement('store', false, 'the extension store is not configured (config.extensionStore)', 'config'))
    } else if (input.lockCorrupt) {
      requirements.push(requirement(
        'store', false,
        `the extension store lock is unreadable, so no installed extension can be trusted: ${input.lockDiagnostic ?? 'unknown reason'}`,
        'config',
      ))
    } else if (input.profileStates.corrupt) {
      requirements.push(requirement(
        'store', false,
        `the profile activation state is unreadable, so the host restores nothing: ${input.profileStates.diagnostic ?? 'unknown reason'}`,
        'config',
      ))
    } else {
      requirements.push(requirement('store', true, `the extension store at ${input.storeDir} is configured and readable`))
    }

    // SOURCE: the package bytes an install would copy, or the installed copy.
    if (input.installed) {
      requirements.push(requirement(
        'source', true,
        `the installed copy is the source of record (version ${input.record?.version ?? 'unknown'})`,
      ))
    } else if (input.sourcePackage === undefined) {
      requirements.push(requirement(
        'source', false,
        input.sourceDir === ''
          ? 'not installed, and no first-party source directory is configured (config.extensionSourceDir)'
          : `no first-party package with this identity exists under ${input.sourceDir}`,
        input.sourceDir === '' ? 'config' : 'none',
      ))
    } else if (input.sourcePackage.problem !== null) {
      requirements.push(requirement('source', false, input.sourcePackage.problem, 'none'))
    } else if (this.#options.allowSourceDirectories !== true) {
      requirements.push(requirement(
        'source', false,
        'installing from a source directory is disabled by configuration (extensions.allowSourceDirectories)',
        'config',
      ))
    } else {
      requirements.push(requirement(
        'source', true,
        `the first-party package is available at ${join(input.sourceDir, packageDirFor(input.id))}`,
        'install',
      ))
    }

    // DEPENDENCIES: declared runtime dependencies must be resolvable/materialized.
    requirements.push(this.#dependencyRequirement(input))

    // PLATFORM: the manifest's declared deployment platforms must include this host.
    if (input.facts.problem !== null) {
      requirements.push(requirement('platform', false, input.facts.problem, 'none'))
    } else if (input.facts.platforms.length === 0) {
      requirements.push(requirement('platform', true, 'the extension declares no platform-specific model deployment'))
    } else if (hostPlatformMatches(input.facts.platforms)) {
      requirements.push(requirement(
        'platform', true,
        `the declared deployment supports this host (${process.platform}/${process.arch}: ${input.facts.platforms.map(platformLabel).join(', ')})`,
      ))
    } else {
      requirements.push(requirement(
        'platform', false,
        `the extension supports ${input.facts.platforms.map(platformLabel).join(', ')} but this host is ${process.platform}/${process.arch}`,
        'none',
      ))
    }

    // INTEGRITY: the installed bytes must still be the recorded bytes.
    if (!input.installed) {
      requirements.push(requirement('integrity', true, 'the extension is not installed, so there are no installed bytes to verify'))
    } else if (input.integrity === 'unchanged') {
      requirements.push(requirement('integrity', true, 'the installed content matches the recorded digest'))
    } else {
      requirements.push(requirement(
        'integrity', false,
        input.integrityReason ?? `the installed content's integrity is ${input.integrity}`,
        'install',
      ))
    }

    // HARNESS MODEL: only declarative packages are served by the host broker.
    if (input.facts.executionKind === 'declarative') {
      requirements.push(this.#harnessModelRequirement())
    }

    // Readiness drives both the executable gate and the assets requirement.
    const blockers = preparationBlockers(input.state?.readiness ?? {}, input.facts.models)

    // EXECUTABLE: a downloaded engine needs the separate RES-02 approval.
    if (input.facts.models.length === 0) {
      requirements.push(requirement('executable', true, 'the extension declares no model deployment, so no executable asset can be planned'))
    } else if (!input.installed) {
      requirements.push(requirement(
        'executable', true,
        'not installed yet; the executable-asset approval is checked once the preparation plan can be resolved',
      ))
    } else if (blockers.length === 0) {
      requirements.push(requirement(
        'executable', true,
        'every declared model deployment is already prepared or callable, so no executable approval is pending',
      ))
    } else {
      requirements.push(this.#executableRequirement(input.id))
    }

    // ASSETS: each declared deployment must be in a callable readiness state.
    if (input.facts.models.length === 0) {
      requirements.push(requirement('assets', true, 'the extension declares no model deployment to prepare'))
    } else if (!input.installed) {
      requirements.push(requirement(
        'assets', false,
        `not installed; ${input.facts.models.join(', ')} need${input.facts.models.length === 1 ? 's' : ''} model assets prepared after installation`,
        'install',
      ))
    } else if (blockers.length > 0) {
      requirements.push(requirement('assets', false, `activation blocked: ${blockers.join('; ')}`, 'prepare'))
    } else {
      requirements.push(requirement(
        'assets', true,
        `every declared model deployment is prepared or callable (${input.facts.models.join(', ')})`,
      ))
    }

    // ACTIVATION: a stored fault that a retry cannot clear.
    if (!input.installed) {
      requirements.push(requirement('activation', true, 'not installed; no activation state exists'))
    } else if (input.state?.observedActivation === 'quarantined') {
      requirements.push(requirement(
        'activation', false,
        'the host quarantined it: some contributions could not be withdrawn, so it is not fully stopped',
        'none',
      ))
    } else if (input.state?.observedActivation === 'activating' || input.state?.observedActivation === 'deactivating') {
      requirements.push(requirement(
        'activation', false,
        `a ${input.state.observedActivation} operation was interrupted; the recorded state is not settled`,
        'none',
      ))
    } else if (input.state?.observedActivation === 'failed') {
      const explained = requirements.some(candidate => !candidate.satisfied)
      requirements.push(requirement(
        'activation', true,
        explained
          ? 'the last activation attempt failed; the unmet requirement above is the actionable blocker'
          : 'the last activation attempt failed, but no remaining prerequisite blocks a retry, so enable retries activation',
      ))
    } else if (input.state === undefined) {
      requirements.push(requirement('activation', true, 'installed but never activated in this profile; no stored activation fault'))
    } else {
      requirements.push(requirement('activation', true, `the stored activation state is ${input.state.observedActivation}`))
    }

    return requirements
  }

  /** The dependencies requirement: materialized in the installed copy, or resolvable in the host tree. */
  #dependencyRequirement(input: RequirementInput): ExtensionRequirement {
    if (input.facts.dependencies.length === 0) {
      return requirement('dependencies', true, 'the package declares no runtime dependencies')
    }
    const count = input.facts.dependencies.length
    const missing: string[] = []
    if (input.installed && input.record !== undefined) {
      for (const dependency of input.facts.dependencies) {
        const installed = join(input.record.installPath, 'node_modules', ...dependency.name.split('/'), 'package.json')
        if (!existsSync(installed)) missing.push(`${dependency.name} (declared ${dependency.range})`)
      }
      return missing.length === 0
        ? requirement('dependencies', true, `all ${count} declared runtime dependenc${count === 1 ? 'y is' : 'ies are'} materialized inside the extension's own installation`)
        : requirement(
            'dependencies', false,
            `the installed copy is missing ${missing.length} declared runtime dependenc${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}`,
            'install',
          )
    }
    if (input.facts.packageDir === null) {
      return requirement('dependencies', false, 'the declared runtime dependencies cannot be inspected because the package directory is unknown', 'none')
    }
    for (const dependency of input.facts.dependencies) {
      try {
        resolveFirstPartyDependency({ sourcePackageDir: input.facts.packageDir }, dependency.name, dependency.range)
      } catch {
        missing.push(`${dependency.name} (declared ${dependency.range})`)
      }
    }
    return missing.length === 0
      ? requirement('dependencies', true, `all ${count} declared runtime dependenc${count === 1 ? 'y resolves' : 'ies resolve'} in the host's installed tree`)
      : requirement(
          'dependencies', false,
          `the host's tree is missing ${missing.length} declared runtime dependenc${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}; install the dependency for the host first`,
          'none',
        )
  }

  /** The harness-model requirement for a declarative package. */
  #harnessModelRequirement(): ExtensionRequirement {
    const status = this.#options.harnessProviderStatus?.()
    if (status === undefined) {
      return requirement(
        'harness-model', false,
        'the host could not report whether a harness model provider is available (provider status unknown); '
          + 'a declarative extension needs a composed provider, for example config.harnessModel',
        'config',
      )
    }
    if (status.available) {
      const identity = [status.provider, status.model].filter((part): part is string => part !== undefined && part.length > 0)
      return requirement(
        'harness-model', true,
        identity.length === 0
          ? 'a harness model provider is available for declarative extensions'
          : `a harness model provider is available (${identity.join(' / ')})`,
      )
    }
    return requirement(
      'harness-model', false,
      status.reason
        ?? 'no harness model provider is configured, so declarative extensions cannot be served; set config.harnessModel to a runnable model',
      status.action ?? 'config',
    )
  }

  /** The executable requirement for an installed, not-yet-callable model deployment. */
  #executableRequirement(extensionId: string): ExtensionRequirement {
    const surface = this.#options.prepareSurface?.()
    if (surface === undefined) {
      /**
       * No plan exists to approve, so this requirement is NOT what blocks the row:
       * the assets requirement names the missing preparation. Reporting it unmet
       * here would replace the actionable "run prepare" text with a host gap the
       * row cannot fix.
       */
      return requirement(
        'executable', true,
        'the prepared-assets surface is not mounted, so there is no preparation plan whose executable assets could be approved; '
          + 'the assets requirement reports the missing preparation',
      )
    }
    let plan: PreparationPlan
    try {
      plan = surface.plan(extensionId)
    } catch (error) {
      return requirement(
        'executable', true,
        `the preparation plan could not be inspected, so executable approval is not the blocker: ${messageOf(error)}`,
      )
    }
    if (!plan.requiresExecutableApproval) {
      return requirement('executable', true, 'the preparation plan declares no executable assets')
    }
    return this.#options.allowExecutablePreparation?.() === true
      ? requirement('executable', true, 'the preparation plan includes an executable asset and the operator approved executable preparation (config.allowExecutablePreparation)')
      : requirement(
          'executable', false,
          'activation blocked: the preparation plan includes an executable asset, and executable preparation is not approved for the client path '
            + '(config.allowExecutablePreparation is off)',
          'config',
        )
  }

  /**
   * Read the current state of the extension surface.
   *
   * Every row is derived from the store, the profile state and the source
   * directory; nothing is cached between calls, so a page that re-reads after an
   * action sees the committed result.
   * @param signal - cancellation.
   * @returns the store/source configuration and one row per known extension.
   */
  async describe(signal?: AbortSignal): Promise<ExtensionsDescribeResult> {
    signal?.throwIfAborted()
    const storeDir = this.#storeDir()
    const sourceDir = this.#sourceDir()
    const disabled = this.#effectiveDisabled()

    let lockCorrupt = false
    let lockDiagnostic: string | null = null
    let installed: readonly InstalledRecord[] = []
    let profileStates: ProfileStateView = { byId: new Map(), corrupt: false, diagnostic: null }
    let activeVersions: Readonly<Record<string, string>> = {}
    if (storeDir !== '') {
      const store = new ExtensionStore(storeDir)
      const lock = store.readLock()
      lockCorrupt = lock.corrupt
      lockDiagnostic = lock.diagnostic ?? null
      installed = lock.value.extensions
      profileStates = readProfileStates(store, this.#profile())
      activeVersions = store.readProfilePointers(this.#profile()).value.activeVersions
    }
    const sourcePackages = new Map<string, SourcePackage>()
    if (sourceDir !== '') {
      for (const candidate of listSourcePackages(sourceDir)) sourcePackages.set(candidate.id, candidate)
    }

    const ids = new Set<string>()
    for (const record of installed) ids.add(record.extensionId)
    for (const id of profileStates.byId.keys()) ids.add(id)
    for (const id of sourcePackages.keys()) ids.add(id)

    const extensions: ExtensionState[] = [...ids].sort().map(id => this.#describeOne({
      id,
      installed,
      activeVersions,
      profileStates,
      sourcePackage: sourcePackages.get(id),
      disabled: disabled.has(id),
      storeDir,
      sourceDir,
      lockCorrupt,
      lockDiagnostic,
    }))

    const writable = storeDir !== ''
      && !lockCorrupt
      && this.#options.readOnly !== true
      && directoryWritable(storeDir)

    return {
      store: storeDir === '' ? null : storeDir,
      writable,
      sourceDir: sourceDir === '' ? null : sourceDir,
      extensions,
    }
  }

  /** Build one row, keeping the reason precedence in one place. */
  #describeOne(view: {
    readonly id: string
    readonly installed: readonly InstalledRecord[]
    readonly activeVersions: Readonly<Record<string, string>>
    readonly profileStates: ProfileStateView
    readonly sourcePackage: SourcePackage | undefined
    readonly disabled: boolean
    readonly storeDir: string
    readonly sourceDir: string
    readonly lockCorrupt: boolean
    readonly lockDiagnostic: string | null
  }): ExtensionState {
    const selection = selectInstalled(view.installed, view.activeVersions, view.id)
    const record = selection
    const state = view.profileStates.byId.get(view.id)
    const installed = record !== undefined

    const integrity = this.#integrityOf(view.storeDir, record)
    const facts: ExtensionFacts = record !== undefined
      ? readExtensionFacts(record.installPath)
      : view.sourcePackage?.facts ?? EMPTY_FACTS

    const active = state !== undefined
      && state.observedActivation === 'active'
      && (state.ownerPid === undefined || state.ownerPid === process.pid)

    const stateTools = state?.tools.map(tool => tool.toolName) ?? []
    const tools = facts.tools.length > 0
      ? facts.tools
      : stateTools.length > 0
        ? stateTools
        : view.sourcePackage?.tools ?? []

    const requirements = this.#computeRequirements({
      id: view.id,
      installed,
      record,
      state,
      integrity: integrity.integrity,
      integrityReason: integrity.reason,
      storeDir: view.storeDir,
      sourceDir: view.sourceDir,
      lockCorrupt: view.lockCorrupt,
      lockDiagnostic: view.lockDiagnostic,
      profileStates: view.profileStates,
      sourcePackage: view.sourcePackage,
      facts,
    })
    const blocked = requirements.some(candidate => blocksRow(installed, candidate))

    const version = record?.version ?? view.sourcePackage?.version ?? null
    const reason = this.#reasonFor({
      ...view,
      state,
      integrityReason: integrity.reason,
      active,
      installed,
      requirements,
    })

    return {
      id: view.id,
      package: view.id,
      version,
      installed,
      active,
      disabled: view.disabled,
      integrity: integrity.integrity,
      tools: [...tools],
      reason,
      requirements,
      blocked,
    }
  }

  /** The first condition worth telling the operator about, or null when none is known. */
  #reasonFor(view: {
    readonly id: string
    readonly storeDir: string
    readonly sourceDir: string
    readonly lockCorrupt: boolean
    readonly lockDiagnostic: string | null
    readonly profileStates: ProfileStateView
    readonly sourcePackage: SourcePackage | undefined
    readonly disabled: boolean
    readonly state: SdkExtensionState | undefined
    readonly integrityReason: string | null
    readonly active: boolean
    readonly installed: boolean
    readonly requirements: readonly ExtensionRequirement[]
  }): string | null {
    if (view.lockCorrupt) {
      return `the extension store lock is unreadable, so no installed extension can be trusted: ${view.lockDiagnostic ?? 'unknown reason'}`
    }
    if (view.integrityReason !== null) return view.integrityReason
    if (view.profileStates.corrupt) {
      return `the profile activation state is unreadable, so the host restores nothing: ${view.profileStates.diagnostic ?? 'unknown reason'}`
    }
    if (view.storeDir === '') {
      return 'the extension store is not configured (config.extensionStore)'
    }
    /**
     * The highest-priority UNMET requirement that actually blocks this row is the
     * single summary. The wording is the requirement's own, so the page, the
     * preflight error and the requirement list never disagree.
     */
    const unmet = firstBlockingRequirement(view.requirements, view.installed)
    if (view.state?.observedActivation === 'failed') {
      return unmet?.reason
        ?? 'activation failed earlier in this host; the store records no remaining preparation blocker, so retry enable to see whether it succeeds'
    }
    if (view.state?.observedActivation === 'quarantined') {
      return unmet?.reason
        ?? 'the host quarantined it: some contributions could not be withdrawn, so it is not fully stopped'
    }
    if (view.state?.observedActivation === 'activating' || view.state?.observedActivation === 'deactivating') {
      return unmet?.reason
        ?? `a ${view.state.observedActivation} operation was interrupted; the recorded state is not settled`
    }
    if (view.disabled) {
      return 'disabled by the operator (config.disabledExtensions); the host does not restore it'
    }
    if (!view.installed) {
      if (view.sourcePackage?.problem !== null && view.sourcePackage?.problem !== undefined) return view.sourcePackage.problem
      if (view.sourceDir === '') {
        return 'not installed, and no first-party source directory is configured (config.extensionSourceDir)'
      }
      if (this.#options.allowSourceDirectories !== true) {
        return 'not installed; installing from a source directory is disabled by configuration (extensions.allowSourceDirectories)'
      }
      return view.sourcePackage === undefined
        ? 'not installed, and no first-party package with this identity exists under the configured source directory'
        : `not installed; the first-party package is available at ${join(view.sourceDir, packageDirFor(view.id))}`
    }
    if (unmet !== undefined) return unmet.reason
    if (!view.active) {
      if (view.state === undefined) return 'installed but never activated in this profile'
      return `installed; this host observes it as ${view.state.observedActivation} (desired ${view.state.desiredActivation})`
    }
    return null
  }

  /**
   * Install one extension from a local source directory (EXT-06 developer mode).
   *
   * Refusals are named and happen BEFORE the copy: an unconfigured store, an
   * unconfigured/missing source, a source whose package identity differs from the
   * requested id, a disallowed source-directory install, or content that cannot be
   * digested. The SDK then copies, validates, verifies and records the install; a
   * failure there is re-thrown as `extension-install-failed` with the SDK's own
   * named code in the message.
   *
   * INSTALLATION IS NOT ACTIVATION: the result is always `active: false`.
   * @param extensionId - the package identity to install.
   * @param source - an explicit source directory, or absent to use the configured one.
   * @param signal - cancellation.
   * @returns the installed identity and version.
   * @throws ExtensionsServiceError for every refusal and failure.
   */
  async install(extensionId: string, source?: string, signal?: AbortSignal): Promise<ExtensionInstallResult> {
    signal?.throwIfAborted()
    assertUsableId(extensionId)
    const storeDir = this.#requireStoreDir()

    const sourceDir = source !== undefined && source.trim().length > 0
      ? resolve(source)
      : (() => {
          const configured = this.#sourceDir()
          if (configured === '') {
            throw new ExtensionsServiceError(
              'extension-source-unconfigured',
              `no source was given for ${extensionId} and no first-party source directory is configured (config.extensionSourceDir)`,
            )
          }
          return join(configured, packageDirFor(extensionId))
        })()
    let sourceIsDirectory = false
    try {
      sourceIsDirectory = statSync(sourceDir).isDirectory()
    } catch {
      sourceIsDirectory = false
    }
    if (!sourceIsDirectory) {
      throw new ExtensionsServiceError(
        'extension-source-missing',
        `the source directory ${sourceDir} does not exist or is not a directory`,
      )
    }

    let discovered
    try {
      discovered = discoverExtension(sourceDir)
    } catch (error) {
      throw new ExtensionsServiceError(
        'extension-source-invalid',
        `the source directory ${sourceDir} is not a usable extension package: ${messageOf(error)}`,
        { cause: error },
      )
    }
    if (discovered.packageName !== extensionId) {
      throw new ExtensionsServiceError(
        'extension-source-mismatch',
        `the source directory ${sourceDir} contains ${JSON.stringify(discovered.packageName)}, not ${JSON.stringify(extensionId)}`,
      )
    }

    if (this.#options.allowSourceDirectories !== true) {
      throw new ExtensionsServiceError(
        'extension-source-directories-not-allowed',
        'source-directory installs are developer mode and are not allowed by the operator configuration (extensions.allowSourceDirectories)',
      )
    }

    // Refuse BEFORE copying when the source cannot be digested: an installation the
    // store cannot verify later would be bytes nobody can attest to (EXT-12/EXT-33).
    try {
      this.#digest(sourceDir)
    } catch (error) {
      throw new ExtensionsServiceError(
        'extension-digest-unavailable',
        `the content digest of ${sourceDir} could not be computed, so the install was refused before copying: ${messageOf(error)}`,
        { cause: error },
      )
    }

    let installed
    try {
      installed = await this.#install({
        sourceDir,
        storeDir,
        allowSourceDirectories: true,
        /**
         * The dependency graph is supplied only on this developer-mode path. It is
         * consulted by the SDK only when the package declares runtime dependencies;
         * every declared dependency is then resolved from the host's own installed
         * tree or the install fails with a named DEPENDENCY_UNSATISFIED reason.
         */
        dependencies: this.#dependencyGraph(sourceDir),
      })
    } catch (error) {
      if (error instanceof ManagementError && error.code === 'DEPENDENCY_UNSATISFIED') {
        throw new ExtensionsServiceError(
          'extension-dependency-unsatisfied',
          `[DEPENDENCY_UNSATISFIED] ${error.message}`,
          { cause: error },
        )
      }
      const named = error instanceof ManagementError ? `[${error.code}] ` : ''
      throw new ExtensionsServiceError(
        'extension-install-failed',
        `${named}${messageOf(error)}`,
        { cause: error },
      )
    }
    if (installed.archiveDigest.trim().length === 0) {
      throw new ExtensionsServiceError(
        'extension-digest-unavailable',
        `${installed.extensionId}@${installed.version} was installed without a content digest, so it cannot be verified before activation`,
      )
    }
    return { id: installed.extensionId, version: installed.version, active: false }
  }

  /**
   * Activate an installed extension and clear its disabled override.
   *
   * Activation runs through the mounted lifecycle, which verifies the installed
   * bytes, publishes the contributions and persists `desiredActivation: 'active'`.
   * The disabled list is updated only after activation succeeds, so a refused
   * activation does not leave the operator's override claiming a state change that
   * did not happen.
   * @param extensionId - the installed extension.
   * @param signal - cancellation.
   * @returns the id with the observed active/disabled state.
   * @throws ExtensionsServiceError for every refusal.
   */
  async enable(extensionId: string, signal?: AbortSignal): Promise<ExtensionToggleResult> {
    signal?.throwIfAborted()
    assertUsableId(extensionId)
    const storeDir = this.#requireStoreDir()
    const record = this.#requireInstalled(storeDir, extensionId)
    const lifecycle = this.#lifecycle()
    if (lifecycle === undefined) {
      throw new ExtensionsServiceError(
        'extension-activation-unavailable',
        `the extension lifecycle is not mounted, so ${extensionId} cannot be activated by this host`,
      )
    }

    const current = lifecycle.stateOf(extensionId)
    /**
     * THE PREFLIGHT. Every prerequisite the deployment can check is evaluated
     * BEFORE the lifecycle is touched: a deployment gap must never surface as the
     * SDK's generic EXTENSION_FAULT after an activation attempt. The refusal's code
     * maps the unmet requirement and its message is the requirement's own reason,
     * so the page, `describe()` and the error cannot disagree.
     */
    const preflightIntegrity = this.#integrityOf(storeDir, record)
    const preflightFacts = readExtensionFacts(record.installPath)
    const requirements = this.#computeRequirements({
      id: extensionId,
      installed: true,
      record,
      state: current,
      integrity: preflightIntegrity.integrity,
      integrityReason: preflightIntegrity.reason,
      storeDir,
      sourceDir: this.#sourceDir(),
      lockCorrupt: false,
      lockDiagnostic: null,
      profileStates: readProfileStates(new ExtensionStore(storeDir), this.#profile()),
      sourcePackage: undefined,
      facts: preflightFacts,
    })
    const unmet = firstBlockingRequirement(requirements, true)
    if (unmet !== undefined) {
      if (unmet.kind === 'assets') {
        // The established preparation refusal keeps its own code and wording.
        throw new ExtensionsServiceError('extension-preparation-required', unmet.reason)
      }
      if (unmet.kind === 'integrity') {
        // The activation path named the SDK's integrity code; the preflight keeps
        // that classification while refusing before the lifecycle call.
        throw new ExtensionsServiceError('extension-activation-failed', `[INTEGRITY_MISMATCH] ${unmet.reason}`)
      }
      throw new ExtensionsServiceError('extension-requirement-unmet', unmet.reason)
    }
    const ownedHere = current?.observedActivation === 'active'
      && (current.ownerPid === undefined || current.ownerPid === process.pid)
    if (!ownedHere) {
      /**
       * The registrar refuses a contribution from an extension outside its
       * activated set, so the id must be admitted BEFORE the lifecycle publishes.
       * A failed activation revokes the admission again (the host implementation
       * reconciles against the lifecycle state).
       */
      this.#options.onActivationChange?.(extensionId, true)
      try {
        await lifecycle.activate(extensionId, record.version)
      } catch (error) {
        this.#options.onActivationChange?.(extensionId, false)
        const named = error instanceof ManagementError ? `[${error.code}] ` : ''
        throw new ExtensionsServiceError(
          'extension-activation-failed',
          `${named}${messageOf(error)}`,
          { cause: error },
        )
      }
    }

    this.#rememberDisabled(extensionId, false)
    await this.#persistDisabled()
    const observed = lifecycle.stateOf(extensionId)
    return {
      id: extensionId,
      active: observed?.observedActivation === 'active'
        && (observed.ownerPid === undefined || observed.ownerPid === process.pid),
      disabled: this.#effectiveDisabled().has(extensionId),
    }
  }

  /**
   * Record the failed activation attempt a fresh extension needs before its
   * readiness can be written.
   *
   * The SDK's `recordReadiness` refuses an extension the profile has never seen,
   * and a freshly installed extension has no profile state until an activation is
   * attempted. The probe therefore performs the SAME attempt the operator's failed
   * Enable performs: every declared deployment defaults to `needs-preparation`, so
   * the SDK refuses at the readiness assessment, records the state, and publishes
   * nothing. Any other refusal is a real problem and is reported.
   * @param lifecycle - the mounted lifecycle.
   * @param extensionId - the installed extension.
   * @param version - its installed version.
   * @throws ExtensionsServiceError when the probe fails for a reason other than the
   *   expected preparation refusal.
   */
  async #recordPreparationBlocker(
    lifecycle: ExtensionActivation,
    extensionId: string,
    version: string,
  ): Promise<void> {
    try {
      await lifecycle.activate(extensionId, version)
    } catch (error) {
      if (error instanceof ManagementError && error.code === 'EXTENSION_FAULT') return
      throw new ExtensionsServiceError(
        'extension-preparation-failed',
        `the extension's activation record could not be written before preparation: ${messageOf(error)}`,
        { cause: error },
      )
    }
  }

  /**
   * Acquire and verify an installed extension's model assets, then record the
   * resulting readiness.
   *
   * This is the management-channel `extensions-prepare-plan` + `extensions-prepare`
   * pair behind one call, over the SAME host surface: the plan is resolved from the
   * installed manifest's asset lock, the acquisition runs through the injectable
   * source (the real ranged HTTP source unless the host injects one), and a
   * successful acquisition records `prepared-cold` through the lifecycle — which is
   * what lets a following `enable` activate the extension.
   *
   * The RES-02 executable gate is deliberately CLOSED here: the Remote call carries
   * no executable-approval argument, so a plan containing an executable asset is
   * returned as `prepared: false` with the registry's own reason rather than
   * acquired. The pinned EmbeddingGemma assets are not executable.
   * @param extensionId - the installed extension to prepare.
   * @param signal - cancellation.
   * @returns the disclosure that was executed and the resulting readiness.
   * @throws ExtensionsServiceError for every precondition and plan failure.
   */
  async prepare(extensionId: string, signal?: AbortSignal): Promise<ExtensionPrepareResult> {
    signal?.throwIfAborted()
    assertUsableId(extensionId)
    const storeDir = this.#requireStoreDir()
    const record = this.#requireInstalled(storeDir, extensionId)
    const surface = this.#options.prepareSurface?.()
    if (surface === undefined) {
      throw new ExtensionsServiceError(
        'extension-preparation-unavailable',
        `the prepared-assets surface is not mounted, so ${extensionId}'s model assets cannot be prepared by this host`,
      )
    }
    const declaredModels = readExtensionFacts(record.installPath).models
    if (declaredModels.length === 0) {
      throw new ExtensionsServiceError(
        'extension-preparation-failed',
        `${extensionId} declares no model deployment to prepare`,
      )
    }
    let plan: PreparationPlan
    try {
      plan = surface.plan(extensionId)
    } catch (error) {
      throw new ExtensionsServiceError(
        'extension-preparation-failed',
        `the preparation plan for ${extensionId} could not be resolved: ${messageOf(error)}`,
        { cause: error },
      )
    }
    const lifecycle = this.#lifecycle()
    if (lifecycle !== undefined && lifecycle.stateOf(extensionId) === undefined) {
      await this.#recordPreparationBlocker(lifecycle, extensionId, record.version)
    }
    /**
     * RES-02: the Remote path has no per-call executable argument, so the approval
     * is the operator's STANDING configuration value. With it off the registry
     * returns its exact refusal and NOTHING is acquired; with it on the same
     * digest-pinned plan is approved as a whole.
     */
    const allowExecutable = this.#options.allowExecutablePreparation?.() === true
    let outcome: PreparationOutcome
    try {
      outcome = await surface.prepare(extensionId, {
        source: (this.#options.preparationSource ?? createHttpSource)(),
        allowExecutable,
        signal: signal ?? new AbortController().signal,
      })
    } catch (error) {
      throw new ExtensionsServiceError(
        'extension-preparation-failed',
        `the preparation of ${extensionId} could not be recorded: ${messageOf(error)}`,
        { cause: error },
      )
    }
    const state = lifecycle?.stateOf(extensionId)
    const readiness = readinessView(state?.readiness ?? {}, declaredModels)
    if (!outcome.ok) {
      return {
        id: extensionId,
        prepared: false,
        reason: outcome.reason,
        plan: preparationPlanView(plan),
        readiness,
        groups: [],
        activationReady: false,
      }
    }
    const integrity = new ExtensionStore(storeDir).verifyUnchanged(record).unchanged
    const blockers = preparationBlockers(state?.readiness ?? {}, declaredModels)
    return {
      id: extensionId,
      prepared: true,
      reason: null,
      plan: preparationPlanView(plan),
      readiness,
      groups: outcome.groups.map(group => group.groupId),
      activationReady: integrity && blockers.length === 0,
    }
  }

  /**
   * Deactivate an installed extension and record it as disabled.
   *
   * The SDK's deactivation persists `desiredActivation: 'inactive'` BEFORE it
   * withdraws anything, so the durable answer survives a crash mid-withdrawal. The
   * disabled override is recorded only after the lifecycle call settles; a
   * deactivation that throws leaves the operator's list unchanged.
   * @param extensionId - the installed extension.
   * @param signal - cancellation.
   * @returns the id with the observed active/disabled state.
   * @throws ExtensionsServiceError for every refusal.
   */
  async disable(extensionId: string, signal?: AbortSignal): Promise<ExtensionToggleResult> {
    signal?.throwIfAborted()
    assertUsableId(extensionId)
    const storeDir = this.#requireStoreDir()
    // Not installed (or the store is unreadable) is still a refusal for disable:
    // there is no activation record this host could be switching off.
    this.#requireInstalled(storeDir, extensionId)
    const lifecycle = this.#lifecycle()
    if (lifecycle === undefined) {
      throw new ExtensionsServiceError(
        'extension-activation-unavailable',
        `the extension lifecycle is not mounted, so ${extensionId} cannot be deactivated by this host`,
      )
    }

    /**
     * An installed extension that was never activated has no profile state, and
     * `deactivate` refuses such an id. That is not an error for the operator: the
     * extension is already inactive, and recording the disabled choice is enough.
     */
    if (lifecycle.stateOf(extensionId) !== undefined) {
      try {
        await lifecycle.deactivate(extensionId)
      } catch (error) {
        if (!(error instanceof ManagementError && error.code === 'EXTENSION_INACTIVE')) {
          const named = error instanceof ManagementError ? `[${error.code}] ` : ''
          throw new ExtensionsServiceError(
            'extension-deactivation-failed',
            `${named}${messageOf(error)}`,
            { cause: error },
          )
        }
      }
    }

    this.#rememberDisabled(extensionId, true)
    await this.#persistDisabled()
    // The registrar's activated set follows the lifecycle: a deactivated extension
    // must not stay admitted to publish.
    this.#options.onActivationChange?.(extensionId, false)
    const observed = lifecycle.stateOf(extensionId)
    return {
      id: extensionId,
      active: observed?.observedActivation === 'active'
        && (observed.ownerPid === undefined || observed.ownerPid === process.pid),
      disabled: this.#effectiveDisabled().has(extensionId),
    }
  }
}

/**
 * Construct the extension-management service.
 * @param options - store/source configuration and the host's seams.
 * @returns a service satisfying {@link ModelToolsRemote}.
 */
export function createExtensionsService(options: ExtensionsServiceOptions = {}): ExtensionsService {
  return new ExtensionsService(options)
}
