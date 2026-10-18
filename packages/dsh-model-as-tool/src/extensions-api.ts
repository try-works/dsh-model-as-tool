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
}

/** The result of an enable/disable request. */
export interface ExtensionToggleResult {
  readonly id: string
  readonly active: boolean
  readonly disabled: boolean
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
}
