/**
 * The public extension runtime API (EXT-17, EXT-18, EXT-19).
 *
 * These are the interfaces an extension author implements and a host calls. The
 * SDK owns them because an author must be able to build and test against them
 * WITHOUT DSH or the Tool Mode host present (EXT-02): an extension that imported
 * host internals would be unbuildable for anyone who has not installed the host,
 * and would break on every host refactor.
 *
 * The context objects are deliberately narrow. `ExtensionContextV1` carries no
 * DSH `ctx`, no registry mutation, no global credentials and no unfiltered
 * environment; `InvocationContextV1` carries no caller-supplied authority and no
 * arbitrary tool dispatch. An extension that needs a file or a secret asks the
 * host through a broker whose grants are the operator's, not the extension's.
 *
 * @module @try-works/tool-mode-extension-sdk/runtime
 */

/** A lossless JSON value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** A lossless JSON object, the shape every request and result uses. */
export type JsonObject = { [key: string]: JsonValue }

/** Why an extension is being disposed. */
export type DisposeReason = 'deactivate' | 'upgrade' | 'uninstall' | 'shutdown' | 'fault'

/** A bounded diagnostic logger. It carries no credentials and cannot be silenced upward. */
export interface ExtensionLoggerV1 {
  /**
   * Record a diagnostic.
   * @param level - severity.
   * @param message - what happened. Must not contain secrets.
   * @param fields - bounded structured detail.
   */
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: JsonObject): void
}

/**
 * Extension-private storage.
 *
 * Private means private to the extension across its own calls; it is not a shared
 * scratch space and not a route to the operator's filesystem.
 */
export interface ExtensionStorageV1 {
  /**
   * Read a value.
   * @param key - the key.
   * @returns the stored value, or undefined.
   */
  read(key: string): Promise<JsonValue | undefined>
  /**
   * Write a value.
   * @param key - the key.
   * @param value - the value to store.
   */
  write(key: string, value: JsonValue): Promise<void>
  /** Absolute path this extension may use for private files. */
  readonly directory: string
}

/** Host-issued context for one activated extension generation (EXT-18). */
export interface ExtensionContextV1 {
  /** The extension identity, as the host resolved it. */
  readonly extensionId: string
  /** The installed package version. */
  readonly extensionVersion: string
  /**
   * Catalog generation this activation belongs to.
   *
   * An extension may branch on it, but the HOST decides publication; an extension
   * cannot publish by incrementing anything it holds.
   */
  readonly activationGeneration: number
  /** Extension-private storage. */
  readonly storage: ExtensionStorageV1
  /** Bounded diagnostics. */
  readonly logger: ExtensionLoggerV1
  /** Aborted when the host begins disposing this generation. */
  readonly signal: AbortSignal
  /** Host-provided preparation state, when the host has prepared assets. */
  readonly configuration: Readonly<JsonObject>
}

/** What an inspection found (EXT-18). Read-only; never downloads or infers. */
export interface ProviderInspectionV1 {
  /** Whether the deployment is prepared and callable. */
  readonly readiness: 'unprepared' | 'preparing' | 'ready' | 'failed'
  /** Features this build actually provides, as opposed to what it declares. */
  readonly features: readonly string[]
  /** Prerequisites that are absent, each with a reason. */
  readonly missing: readonly { readonly name: string; readonly reason: string }[]
  /** The runtime the provider would use, e.g. a library version. */
  readonly runtimeVersion?: string
  /** Why the deployment is in this state. */
  readonly reason?: string
}

/** A verified local asset handle (EXT-18). */
export interface PreparedAssetMapV1 {
  /**
   * Resolve an asset.
   * @param assetId - the manifest asset id.
   * @returns the local path and the digest the host verified, or undefined.
   */
  get(assetId: string): { readonly path: string; readonly digest: string } | undefined
  /** The asset ids the host verified for this deployment. */
  readonly assetIds: readonly string[]
}

/** Call-scoped, host-granted access (EXT-18). */
export interface InvocationContextV1 {
  /** Opaque invocation identity, host-issued and not forgeable by a caller. */
  readonly invocationId: string
  /** Required abort signal. Implementations must observe it. */
  readonly signal: AbortSignal
  /** Effective limits in force for this call. */
  readonly limits: { readonly maxInputBytes: number; readonly maxAudioSeconds: number; readonly maxResultBytes: number }
  /**
   * Resolve a caller-supplied path against the caller's grants.
   * @param candidate - the path the caller supplied.
   * @returns the canonical authorized path.
   */
  resolvePath(candidate: string): string
  /**
   * Perform an approved network operation.
   * @param destination - the destination origin, which must be approved.
   * @param request - the request body.
   */
  fetch?(destination: string, request: JsonObject): Promise<JsonObject>
}

/** One model deployment's provider (EXT-17). */
export interface ModelProviderV1 {
  /**
   * Report readiness and features from approved local state only.
   *
   * MUST NOT download, infer, or authenticate to a remote endpoint.
   * @param signal - cancellation.
   */
  inspect(signal: AbortSignal): Promise<ProviderInspectionV1>
  /**
   * Load the prepared assets.
   *
   * The host calls this once per selected exact deployment, before any invoke.
   * @param request - the verified assets and cancellation.
   */
  load(request: { readonly assets: Readonly<PreparedAssetMapV1>; readonly signal: AbortSignal }): Promise<void>
  /**
   * Run one invocation.
   *
   * Returns the domain payload with the reserved root `meta` OMITTED: the host
   * authors that field, and an extension supplying one is rejected.
   * @param request - what to run.
   * @returns the domain payload.
   */
  invoke(request: {
    readonly implementationId: string
    readonly input: Readonly<JsonObject>
    readonly context: InvocationContextV1
  }): Promise<JsonObject>
  /**
   * Release loaded resources, keeping the provider usable.
   * @param signal - cancellation.
   */
  unload(signal: AbortSignal): Promise<void>
  /** Release everything. Idempotent, and settles only after owned resources stop. */
  dispose(): Promise<void>
}

/** An activated extension (EXT-17). */
export interface ExtensionInstanceV1 {
  /**
   * Create a provider for one model deployment.
   *
   * Creates a handle; it does not download or load. EXT-19 requires `create()` and
   * this call to stay lightweight.
   * @param request - which deployment, and its configuration.
   */
  createProvider(request: {
    readonly modelId: string
    readonly configuration: Readonly<JsonObject>
  }): Promise<ModelProviderV1>
  /**
   * Release this instance.
   * @param reason - why it is being disposed.
   */
  dispose(reason: DisposeReason): Promise<void>
}

/** What a module extension's `./tool-mode` entry default-exports (EXT-17). */
export interface ToolModeExtensionV1 {
  /** The runtime API major. Only 1 exists. */
  readonly apiVersion: 1
  /**
   * Activate.
   *
   * MUST be lightweight: no automatic downloads, model loads, inference,
   * listening sockets, global registration or unbounded background loops.
   * @param context - the host-issued context.
   */
  create(context: ExtensionContextV1): Promise<ExtensionInstanceV1>
}

/** The only apiVersion this SDK implements. */
export const EXTENSION_API_VERSION = 1

/**
 * Declare an extension, with its shape checked at the declaration site.
 *
 * Authors use this rather than exporting an object literal: it makes a typo in
 * `apiVersion` a compile error instead of a load-time rejection, which is the
 * difference between finding the mistake in an editor and in an operator's log.
 * @param extension - the extension to declare.
 * @returns the same extension, typed.
 */
export function defineExtension(extension: ToolModeExtensionV1): ToolModeExtensionV1 {
  if (extension.apiVersion !== EXTENSION_API_VERSION) {
    throw new Error(
      `extension apiVersion ${String(extension.apiVersion)} is not supported; this SDK implements ${EXTENSION_API_VERSION}`,
    )
  }
  if (typeof extension.create !== 'function') {
    throw new Error('extension must implement create(context)')
  }
  return extension
}

/**
 * The reserved root field the host authors, which an extension must not supply.
 *
 * EXT-17 reserves it so provenance cannot be forged: an extension that returned
 * its own `meta` would be asserting who ran it and under what receipt.
 */
export const RESERVED_META_FIELD = 'meta'

/**
 * Reject an extension result that tries to supply the reserved `meta` field.
 *
 * @param payload - the payload an extension returned.
 * @param implementationId - for the error message.
 * @throws Error when the payload carries `meta`.
 */
export function assertNoReservedMeta(payload: JsonObject, implementationId: string): void {
  if (RESERVED_META_FIELD in payload) {
    throw new Error(
      `implementation ${implementationId} returned a reserved root "${RESERVED_META_FIELD}" field; `
      + 'the host authors that metadata and will not accept an extension-supplied one',
    )
  }
}
