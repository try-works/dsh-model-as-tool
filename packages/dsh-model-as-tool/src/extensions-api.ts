/**
 * The wire contract between the Settings page and the host for extension
 * management (install / enable / disable).
 *
 * This module is the single source of truth both halves implement:
 * - the host service (`extensions-service.ts`) produces these values;
 * - the generated/registered Remote artifact exposes them as `remote.modelTools`;
 * - the browser half calls them after installing its Install/Enable controls.
 *
 * Every method is deliberately explicit about what is UNKNOWN rather than
 * inventing state: `store` is null when no extension store is configured, and a
 * row's `integrity` is absent when nothing was ever installed.
 *
 * @module @try-works/dsh-model-as-tool/extensions-api
 */

/** One extension, as the UI needs it. */
/** What kind of prerequisite an extension (or a model it serves) has. */
export type ExtensionRequirementKind =
  | 'store'
  | 'source'
  | 'dependencies'
  | 'assets'
  | 'executable'
  | 'harness-model'
  | 'platform'
  | 'integrity'
  | 'activation'

/** The action that clears an unmet requirement, when the deployment supports it. */
export type ExtensionRequirementAction =
  | 'install'
  | 'prepare'
  | 'enable'
  | 'config'
  | 'none'

/**
 * ONE activation prerequisite, computed by the host BEFORE install/enable.
 *
 * The point of this list is that a user never discovers a deployment gap by
 * clicking Enable and reading an EXTENSION_FAULT: `blocked` rows carry the exact
 * requirement that is unmet and the action (if any) that would satisfy it. A
 * requirement is reported even when satisfied, so the page can distinguish
 * "nothing to do" from "we did not look".
 */
export interface ExtensionRequirement {
  readonly kind: ExtensionRequirementKind
  readonly satisfied: boolean
  /** Exact, actionable text; empty only when satisfied and self-evident. */
  readonly reason: string
  readonly action: ExtensionRequirementAction
}

export interface ExtensionState {
  /** The extension's package identity, for example `@try-works/extension-laya`. */
  readonly id: string
  /** The package name to install from, when the host knows one. */
  readonly package: string | null
  /** Installed version, absent when the store does not hold it. */
  readonly version: string | null
  /** Whether the store holds an installed copy. */
  readonly installed: boolean
  /** Whether the host restored it on this load. */
  readonly active: boolean
  /** Whether the operator disabled it (config `disabledExtensions`). */
  readonly disabled: boolean
  /** Content verification of the installed copy. */
  readonly integrity: 'unchanged' | 'changed' | 'unknown'
  /** Tool names the extension exports once active. */
  readonly tools: readonly string[]
  /** Why the extension cannot install or activate, when known. */
  readonly reason: string | null
  /** Every prerequisite this deployment checked, satisfied or not. */
  readonly requirements: readonly ExtensionRequirement[]
  /**
   * Whether ANY unmet requirement blocks activation. Derived from
   * `requirements`; carried explicitly so the page never has to re-derive it.
   */
  readonly blocked: boolean
}

/** The state of the extension surface. */
export interface ExtensionsDescribeResult {
  /** The configured extension store directory, or null when unconfigured. */
  readonly store: string | null
  /** Whether the host can write to the store (install/enable/disable). */
  readonly writable: boolean
  /** Where the host would install first-party extensions from, or null. */
  readonly sourceDir: string | null
  /** One row per extension the host knows about. */
  readonly extensions: readonly ExtensionState[]
}

/** The result of an install request. */
export interface ExtensionInstallResult {
  readonly id: string
  readonly version: string
  /** Installation is not activation: `active` is false until it is enabled. */
  readonly active: boolean
  /** Which route actually supplied the installed bytes. */
  readonly source: 'registry' | 'directory'
  /** The exact version the request resolved to (equals `version` today). */
  readonly resolvedVersion: string
}

/** The result of an enable/disable request. */
export interface ExtensionToggleResult {
  readonly id: string
  readonly active: boolean
  readonly disabled: boolean
}

/**
 * The readiness vocabulary a preparation reports (EXT-25 / RES-04).
 *
 * Only `prepared-cold`, `loading`, `ready` and `busy` permit activation; the
 * others name WHY they do not.
 */
export type ExtensionModelReadiness =
  | 'unavailable'
  | 'needs-preparation'
  | 'preparing'
  | 'prepared-cold'
  | 'loading'
  | 'ready'
  | 'busy'
  | 'failed'

/**
 * Readiness for each DECLARED model deployment, keyed by the manifest's model id.
 *
 * Declared ids are the projection: a stale readiness entry for a deployment the
 * current manifest no longer declares is not reported.
 */
export type ExtensionReadinessMap = Readonly<Record<string, ExtensionModelReadiness>>

/** One asset in the RES-02 preparation disclosure. */
export interface ExtensionPreparationAsset {
  /** The stable asset id (`<group>/<asset>`). */
  readonly assetId: string
  /** Download size in bytes. */
  readonly bytes: number
  /** The pinned source the bytes come from. */
  readonly source: string
  /** Whether the asset is executable, which needs the separate approval (RES-02). */
  readonly executable: boolean
}

/**
 * The pre-approval disclosure of what a preparation downloads (RES-02).
 *
 * The same fields the management channel's `extensions-prepare-plan` action
 * discloses; it travels with the result so the page can show bytes, storage,
 * terms and the executable gate.
 */
export interface ExtensionPreparationPlan {
  /** The manifest model deployment the assets belong to. */
  readonly modelId: string
  /** The pinned model revision. */
  readonly modelRevision: string
  /** Every asset the preparation acquires. */
  readonly assets: readonly ExtensionPreparationAsset[]
  /** Total download bytes. */
  readonly totalBytes: number
  /** Total bytes retained after installation (stated separately from download). */
  readonly storageBytes: number
  /** Whether any asset is executable and therefore needs the separate approval. */
  readonly requiresExecutableApproval: boolean
  /** The pinned license terms, surfaced before the download. */
  readonly license: { readonly name: string; readonly url: string }
}

/** The result of a preparation request. */
export interface ExtensionPrepareResult {
  readonly id: string
  /** Whether every declared asset was verified and the readiness was recorded. */
  readonly prepared: boolean
  /** Why the preparation did not complete, when it did not; null on success. */
  readonly reason: string | null
  /** The RES-02 disclosure this call executed, when a plan could be resolved. */
  readonly plan: ExtensionPreparationPlan | null
  /** The readiness per DECLARED model deployment after the call. */
  readonly readiness: ExtensionReadinessMap
  /** The prepared asset group ids (empty when nothing was prepared). */
  readonly groups: readonly string[]
  /**
   * Whether no KNOWN blocker remains for activation: the installed bytes verify
   * and every declared deployment is in a callable readiness state.
   *
   * This is the preparation question only; it does not promise that activation
   * will publish (a schema or contribution refusal can still fail an enable).
   */
  readonly activationReady: boolean
}

/** The methods the HOST service implements (raw values, in-process). */
export interface ModelToolsRemote {
  /** Read the current state; the page calls this on mount and after each action. */
  describe(signal?: AbortSignal): Promise<ExtensionsDescribeResult>
  /** Install one extension from `source`, or the configured first-party source. */
  install(id: string, source?: string, signal?: AbortSignal): Promise<ExtensionInstallResult>
  /** Activate an installed extension (removes it from `disabledExtensions`). */
  enable(id: string, signal?: AbortSignal): Promise<ExtensionToggleResult>
  /** Deactivate an extension (adds it to `disabledExtensions`). */
  disable(id: string, signal?: AbortSignal): Promise<ExtensionToggleResult>
  /**
   * Acquire and verify the installed extension's model assets, then record the
   * resulting readiness so a following `enable` can activate it.
   */
  prepare(id: string, signal?: AbortSignal): Promise<ExtensionPrepareResult>
}

/**
 * The Remote wire result wrapper.
 *
 * A generated Remote call resolves a `RemoteResult`, never a bare value: the
 * gateway answers `{ok:true,value}` or `{ok:false,error}`. Declared locally (not
 * imported) so this package does not couple to the harness gateway types, and
 * because the browser half is plain JS that reads `.ok` structurally.
 */
export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code?: string; readonly message: string } }

/**
 * The methods the BROWSER half calls, as `ctx.remote.modelTools`.
 *
 * Two wire facts a caller must respect:
 * - `describe`/`enable`/`disable` resolve a {@link RemoteResult}, not a raw value.
 * - The install method is named `installExtension`, not `install`: the harness
 *   client's RemoteNamespaceService owns a private method `install`, and the
 *   gateway rejects a descriptor method that collides with it
 *   ("client api: method ... conflicts with its namespace service"). The host
 *   service keeps `install`, and the descriptor maps the wire name to it.
 */
export interface ModelToolsRemoteClient {
  describe(signal?: AbortSignal): Promise<RemoteResult<ExtensionsDescribeResult>>
  installExtension(
    id: string,
    source?: string,
    signal?: AbortSignal,
  ): Promise<RemoteResult<ExtensionInstallResult>>
  enable(id: string, signal?: AbortSignal): Promise<RemoteResult<ExtensionToggleResult>>
  disable(id: string, signal?: AbortSignal): Promise<RemoteResult<ExtensionToggleResult>>
  /**
   * Acquire/verify the extension's model assets and record readiness. The wire
   * name is `prepare` (no collision with the namespace service's members).
   */
  prepare(id: string, signal?: AbortSignal): Promise<RemoteResult<ExtensionPrepareResult>>
}
