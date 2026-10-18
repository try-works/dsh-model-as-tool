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
  type InstalledRecord,
} from '@try-works/tool-mode-extension-sdk'
import type {
  ExtensionInstallResult,
  ExtensionState,
  ExtensionToggleResult,
  ExtensionsDescribeResult,
  ModelToolsRemote,
} from './extensions-api.ts'

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
  /** The extension has no installed record in the store, so it cannot be activated. */
  | 'extension-not-installed'
  /** The store lock or the profile state document is unreadable, so activation state cannot be trusted. */
  | 'extension-store-unreadable'
  /** The host mounted no lifecycle (no store at load), so activation state cannot change. */
  | 'extension-activation-unavailable'
  /** `activate` refused or failed; the SDK's named error is carried in the message. */
  | 'extension-activation-failed'
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
}

/** One first-party package found under the configured source directory. */
interface SourcePackage {
  readonly id: string
  readonly version: string | null
  readonly tools: readonly string[]
  /** Set when the package exists but cannot be used as an extension. */
  readonly problem: string | null
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
    try {
      const discovery = discoverExtension(directory)
      packages.push({
        id: discovery.packageName,
        version: discovery.packageVersion,
        tools: discovery.manifest.tools.map(tool => tool.name),
        problem: null,
      })
    } catch (error) {
      const id = declaredPackageName(directory)
      if (id === undefined) continue
      packages.push({
        id,
        version: null,
        tools: [],
        problem: `the package at ${directory} is not a usable extension: ${messageOf(error)}`,
      })
    }
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

  /** The declared tool names of an installed copy, or `[]` when its manifest is unreadable. */
  #declaredTools(installPath: string): readonly string[] {
    try {
      return discoverExtension(installPath).manifest.tools.map(tool => tool.name)
    } catch {
      return []
    }
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

    let integrity: ExtensionState['integrity'] = 'unknown'
    let integrityReason: string | null = null
    if (record !== undefined && view.storeDir !== '') {
      try {
        const verdict = new ExtensionStore(view.storeDir).verifyUnchanged(record)
        integrity = verdict.unchanged ? 'unchanged' : 'changed'
        if (!verdict.unchanged) {
          integrityReason = `the installed content is not the content that was recorded: ${verdict.diagnostic ?? 'it changed on disk after installation'}`
        }
      } catch (error) {
        integrity = 'unknown'
        integrityReason = `the installed content could not be digested, so its integrity is unknown: ${messageOf(error)}`
      }
    }

    const active = state !== undefined
      && state.observedActivation === 'active'
      && (state.ownerPid === undefined || state.ownerPid === process.pid)

    const declaredTools = record === undefined ? [] : this.#declaredTools(record.installPath)
    const stateTools = state?.tools.map(tool => tool.toolName) ?? []
    const tools = declaredTools.length > 0
      ? declaredTools
      : stateTools.length > 0
        ? stateTools
        : view.sourcePackage?.tools ?? []

    const version = record?.version ?? view.sourcePackage?.version ?? null
    const reason = this.#reasonFor({ ...view, state, integrityReason, active, installed })

    return {
      id: view.id,
      package: view.id,
      version,
      installed,
      active,
      disabled: view.disabled,
      integrity,
      tools: [...tools],
      reason,
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
    if (view.state?.observedActivation === 'failed') {
      return 'activation failed in this host; re-enable it after fixing the reported package problem'
    }
    if (view.state?.observedActivation === 'quarantined') {
      return 'the host quarantined it: some contributions could not be withdrawn, so it is not fully stopped'
    }
    if (view.state?.observedActivation === 'activating' || view.state?.observedActivation === 'deactivating') {
      return `a ${view.state.observedActivation} operation was interrupted; the recorded state is not settled`
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
      })
    } catch (error) {
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
    const ownedHere = current?.observedActivation === 'active'
      && (current.ownerPid === undefined || current.ownerPid === process.pid)
    if (!ownedHere) {
      try {
        await lifecycle.activate(extensionId, record.version)
      } catch (error) {
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
