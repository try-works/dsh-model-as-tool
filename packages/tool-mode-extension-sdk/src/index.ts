/**
 * `@try-works/tool-mode-extension-sdk` — the public author-facing contract (EXT-17).
 *
 * This package MUST work without importing DSH or the Tool Mode host: an extension
 * author depends on it to build and test a package that the host can load later,
 * and a cyclic dependency on the host would make that impossible. It contains
 * schemas, types, validation and lifecycle vocabulary — never a model
 * implementation and never host code.
 *
 * @module @try-works/tool-mode-extension-sdk
 */

export {
  MANAGEMENT_ERROR_CODES,
  ManagementError,
  sanitizeRecovery,
  type ManagementErrorCode,
  type ManagementErrorShape,
  type ManagementOperation,
} from './errors.ts'

export {
  admitsInvocation,
  installedInactive,
  summarize,
  type DesiredActivation,
  type ExportAuthorization,
  type ExtensionState,
  type ExtensionSummary,
  type InstallationState,
  type ModelReadiness,
  type ObservedActivation,
  type ToolSelection,
} from './state.ts'

export {
  KNOWN_FEATURES,
  MAX_MANIFEST_BYTES,
  RUNTIME_API_MAJOR,
  TMX_PROTOCOL_VERSION,
  validateManifest,
  type ExtensionManifest,
  type ManifestImplementation,
  type ManifestModel,
  type ManifestSkill,
  type ManifestTool,
} from './manifest.ts'

export {
  discoverExtension,
  MAX_PACKAGE_JSON_BYTES,
  type ExtensionDiscovery,
} from './discovery.ts'

export {
  DEFAULT_ARCHIVE_LIMITS,
  findPackageRoot,
  validateArchiveEntries,
  verifyIntegrity,
  type ArchiveEntry,
  type ArchiveEntryKind,
  type ArchiveLimits,
} from './install/archive.ts'

export {
  DEFAULT_INSTALL_LIMITS,
  installPathFor,
  stagedInstall,
  type ArchiveSource,
  type InstallLimits,
  type InstallSource,
  type StagedInstallResult,
} from './install/staged.ts'

export { createZipArchiveSource } from './install/zip-source.ts'

export {
  digestInstalledContent,
  ExtensionStore,
  LOCK_FILE,
  type InstalledRecord,
  type ProfileStateFile,
  type StateReadResult,
  type StoreLock,
} from './install/store.ts'

export {
  assessReadiness,
  DEFAULT_STOP_GRACE_MS,
  ExtensionLifecycle,
  type ActivationDiagnostic,
  type ActivationResult,
  type Contribution,
  type ContributionRegistrar,
  type DeactivationResult,
} from './install/lifecycle.ts'

export {
  assertNoReservedMeta,
  defineExtension,
  EXTENSION_API_VERSION,
  RESERVED_META_FIELD,
  type DisposeReason,
  type ExtensionContextV1,
  type ExtensionInstanceV1,
  type ExtensionLoggerV1,
  type ExtensionStorageV1,
  type InvocationContextV1,
  type JsonObject,
  type JsonValue,
  type ModelProviderV1,
  type PreparedAssetMapV1,
  type ProviderInspectionV1,
  type ToolModeExtensionV1,
} from './runtime.ts'

export {
  activateExtension,
  EXTENSION_ENTRY,
  loadExtensionModule,
  resolveExtensionEntry,
} from './load.ts'