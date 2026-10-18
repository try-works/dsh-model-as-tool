/**
 * dsh-model-as-tool — install on-device models as DSH tools and skills.
 *
 * The plugin composes five layers: a JSON catalog describing every model, a
 * capability resolver that decides which of them can run in this process, an
 * adapter per runnable model, a registrar that turns each one into a DSH tool,
 * and a skill per tool that teaches the agent when to reach for it.
 *
 * Nothing is imported from a model package at plugin load, so a deployment that
 * installs none of them still starts cleanly and reports exactly what is
 * missing. A model only becomes a tool when its adapter can really invoke it.
 *
 * @module @try-works/dsh-model-as-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ParameterSchemaSpec, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
// Type-only: resolves the required ctx.skills service declaration. The skill
// service is read opportunistically via ctx.get(), so it stays optional.
import type {} from '@deepseek-ai/dsh-skill'
import { loadCatalog } from './catalog.ts'
import { resolveCapability, type ResolvedModel } from './capability.ts'
import { createAdapter } from './adapters/index.ts'
import { registerModelTool } from './registrar.ts'
import { registerContractTool, type ContractBinding, type HostIdentity } from './bindings.ts'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createContributionRegistrar, type RegistrableTool } from './extension-registrar.ts'
import { createExternalGrantContext, createProgramRunner, externalRefusal, serveProgram, TOOL_MODE_RUN_CONTRACT, PTC_SERVICE } from './tool-mode-run.ts'
import { buildDiagnostics } from './diagnostics.ts'
import { CAPTURE_PATH } from './capture-path.ts'
import { prepareDeclarative } from './harness-serving.ts'
import type { InvocationAccounting } from './invocation-accounting.ts'
import { createFileCredentialStore, defaultCredentialStoreFile } from './mcp/credential-store.ts'
import { buildHarnessLlmProvider, type HarnessModelConfig } from './harness-llm.ts'
import { parseRecipe, type LlmProvider, type RecipeManifest } from '@try-works/tool-mode-recipes'
import { createManagedWorkerRegistry } from './managed-workers.ts'
import { createDispatch, describeDispatchFailure, resolveImplementation, type DispatchEnvironment, type DispatchManifest } from './extension-dispatch.ts'
import {
  captureToolSchemaSnapshot,
  describePlanningRejections,
  hasPlanningInputShape,
  offerToolsFromSnapshot,
  PLANNING_EXCLUDED_TOOLS,
  PLANNING_TOOL_INPUT_SCHEMA,
  PLANNING_TOOL_NAME,
  recheckProposals,
  type RegistryToolSchema,
  type ToolSchemaSnapshot,
} from './planning.ts'
import {
  discoverExtension,
  loadExtensionModule,
  resolveDeclarativeImplementations,
  resolveExtensionEntry,
  type ExtensionContextV1 } from '@try-works/tool-mode-extension-sdk'
import type { JsonValue } from './adapters/types.ts'
import { ExtensionStore, ExtensionLifecycle, type ModelReadiness } from '@try-works/tool-mode-extension-sdk'
import { authorizeTool, createGrant } from './authority.ts'
import { ProviderBridge } from './provider-bridge.ts'
import { createUpdateHostSurface, type UpdateHostSurface } from './update-surface.ts'
import { SubscriptionRegistry, deliverCatalogChange, MemoryDeliverySink } from './mcp/subscriptions.ts'
import {
  createPreparedAssetRegistry,
  identityFor,
  lockGroups,
  parseAssetLock,
  plannedAssets,
  type LockGroup,
  type PrepareAssetsSurface,
  type PreparedAssetRegistry,
} from './prepared-assets.ts'
import { planPreparation } from './deployment-coordinator.ts'
import { createHttpSource } from './http-acquisition.ts'
import type { AcquisitionSource } from './asset-acquisition.ts'
import { buildSurface, type CatalogGeneration, type ImplementationCandidate } from './publication.ts'
import { buildInvocationReceipt, type InvocationReceipt } from './receipt.ts'
import { createMcpHost, type PublishedTool } from './mcp/host-binding.ts'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { STANDARD_CONTRACTS, assertAgainstSchema, compileSchema, projectSchemaToDsh, type ToolContract } from '@try-works/tool-mode-contracts'
import { renderSkillBody } from './skills.ts'
import { loadPlaybooks } from './playbook.ts'
import { commandExists, DEFAULT_CLI_COMMAND } from './transport.ts'
import {
  createFileStateStore,
  createMemoryStateStore,
  defaultStateFile,
  resolveSelection,
  withChoice,
  type PersistedState,
  type StateStore,
} from './state.ts'
import type { ModelCatalogEntry } from './types.ts'
import { runLegacyStartupMigration } from './legacy-migration.ts'

export const name = 'model-tools'
export const inject = ['tools']

/**
 * This package's version, stamped into every result as `extensionVersion`.
 * Kept as a literal so the runtime does not depend on reading its own manifest.
 */
export /** How many invocation receipts are retained in memory (EXT-35). */
const MAX_RETAINED_RECEIPTS = 200

const HOST_VERSION = '0.1.1'

/** Largest extension tool schema read at registration, in bytes. */
const MAX_SCHEMA_BYTES = 512 * 1024

/** The DSH value-schema keywords a recipe input may advertise (mirrors contracts/dsh.ts's DSH_SUPPORTED). */
const DSH_PARAMETER_KEYWORDS = new Set([
  'type', 'enum', 'const', 'description', 'default', 'examples',
  'items', 'properties', 'additionalProperties', 'required',
])

/** Plugin configuration. */
export interface Config {
  /** Catalog document to load; defaults to the bundled Desert Ant catalog. */
  catalogFile?: string
  /** Playbook document to load; defaults to the bundled playbooks. */
  playbookFile?: string
  /**
   * Model ids to expose. An empty list (the default) means every model that can
   * run here; a non-empty list is intersected with what can run, so naming an
   * unsupported model never registers a tool that would fail at call time.
   *
   * The field is an empty array rather than `undefined` when unset: the config
   * schema materializes a declared array, so the code treats empty as "no
   * explicit allowlist" instead of "expose nothing".
   */
  models?: string[]
  /** Model ids to exclude, applied after `models`. */
  exclude?: string[]
  /**
   * Register a tool for a model whose runtime is missing, so the failure is
   * reported at call time instead of the tool being absent. Off by default:
   * exposing a tool that cannot work wastes a model turn.
   */
  exposeUnavailable?: boolean
  /** Publish one skill per registered tool. Default true. */
  registerSkills?: boolean
  /** Register the `model_tools` inspection tool. Default true. */
  registerControlTool?: boolean
  /**
   * The operator's CONSENT to hosted code execution (CODE-10).
   *
   * Code execution is a SEPARATE consent from ordinary model-tool access, and it
   * ships disabled until granted. This flag is the grant: the operator turns it
   * on explicitly. It is checked in addition to — never instead of — the
   * confinement gate (CODE-09), which remains closed until the confinement
   * acceptance tests pass, so flipping this flag alone cannot expose the runtime.
   * Default false.
   */
  hostedCode?: boolean
  /**
   * The Desert Ant CLI transport, which runs on macOS and Linux and can reach
   * every shipping model — including the Apple-only ones that have no npm
   * package.
   */
  cli?: {
    /** Whether the CLI may be used when it is found on PATH. Default true. */
    enabled?: boolean
    /** Command name or absolute path. Default `desertant`. */
    command?: string
  }
  /**
   * A user-hosted bridge, reached over HTTP, for models this machine cannot run
   * itself — most importantly the Apple-only models.
   *
   * The plugin does not run this service; the user does, on a machine that can
   * execute the model. The licence forbids re-hosting the models as a service,
   * so point this at your own machine.
   */
  remote?: {
    /** Bridge base URL, for example `http://mac-studio.local:8787`. */
    endpoint?: string
    /** Optional bearer token sent to the bridge. */
    token?: string
  }
  /**
   * Whether in-process npm packages may be used. Set false to force every call
   * through the CLI or the bridge. Default true.
   */
  allowNpm?: boolean
  /**
   * Where the user's enable/disable choices are persisted. Defaults to
   * `<DSH_HOME>/model-as-tool/state.json`.
   */
  stateFile?: string
  /**
   * Where generated external MCP client credentials are persisted (SEC-01).
   *
   * Defaults to `<DSH_HOME>/model-as-tool/credentials.json`, next to the state file,
   * so the store inherits the operator profile's owner-only protection. A deployment
   * that disables persistence refuses generation rather than issuing a credential a
   * restart would forget.
   */
  credentialsFile?: string
  /**
   * Directory of the operator-owned EXTENSION store.
   *
   * When set, the host mounts the extension lifecycle and restores the extensions the
   * operator approved as active. Left unset, no extension is mounted and behaviour is
   * exactly as before - which is why this is a directory rather than a boolean: an
   * absent directory is a deployment that has no extensions, not one that forbade them.
   */
  extensionStore?: string
  /** INTERNAL TEST SEAM: the acquisition source extensions-prepare uses instead
   * of the ranged HTTP source. A suite injects a local file source so the
   * acquisition path is exercised with ZERO network; a deployment never sets
   * this, and the default stays the real opt-in source. */
  assetSourceFactory?: () => AcquisitionSource
  /** §12 config v3: the nested shape + the fixed-false flags (see the zod). */
  schemaVersion?: number
  extensions?: {
    protocolMajor?: number
    manifestVersion?: string
    registry?: string
    allowHttpsArchives?: boolean
    allowLocalArchives?: boolean
    allowSourceDirectories?: boolean
    automaticUpdates?: boolean
    runInstallScripts?: boolean
  }
  mcpV3?: {
    enabled?: boolean
    protocolVersions?: string[]
    legacyCompatibility?: boolean
    host?: string
    port?: number
    path?: string
    allowedOrigins?: string[]
    exportTools?: string[]
    catalogTtlMs?: number
    catalogCacheScope?: string
    auth?: { mode?: string; authorizationServerProfile?: string | null }
  }
  compositionV3?: {
    enabled?: boolean
    defaultTimeoutMs?: number
    maxTimeoutMs?: number
    maxToolCalls?: number
    maxConcurrentBindings?: number
    maxHarnessModelCalls?: number
  }
  multimodalV3?: {
    defaultDimensions?: number
    defaultOverflow?: string
    maxVideoFrames?: number
    audioSampleRateHz?: number
    selectiveEncoderLoading?: boolean
  }
  harnessExecutorV3?: {
    enabled?: boolean
    nativeSelection?: string
    externalDefaultProfile?: string | null
    profiles?: Readonly<Record<string, unknown>>[]
    defaultMaxAttempts?: number
    defaultRepairAttempts?: number
    defaultMaxOutputTokens?: number
    defaultTimeoutMs?: number
    inheritConversation?: boolean
    allowModelToolCalls?: boolean
  }
  recipesV3?: {
    schemaVersion?: string
    allowLocalAuthoring?: boolean
    automaticActivation?: boolean
    allowExecutableTemplates?: boolean
  }
  clientsV3?: Readonly<Record<string, unknown>>[]
  captureV3?: {
    bodies?: boolean
    retentionDays?: number
    maxBytes?: number
    auxiliaryLlmJournal?: { enabled?: boolean; retentionDays?: number }
  }
  /**
   * Whether `enable`/`disable` persist across restarts. Default true; false
   * restores the earlier session-scoped behaviour.
   */
  persist?: boolean
  /**
   * Which model serves each standard contract, as `{ "stt.transcribe": "voz" }`.
   *
   * Provider selection is host configuration (BASE-02), not something a caller
   * chooses per call. An override naming a model that cannot run here is ignored
   * in favour of the first eligible implementation rather than silently
   * registering a tool that would fail.
   */
  providers?: Record<string, string>
  /**
   * Register the deprecated per-model compatibility aliases.
   *
   * Off by default so they stay out of the default catalog and a caller sees one
   * transcription tool rather than two (BASE-03). When on, the alias keeps its
   * original argument and result contract through a tested adapter — it is never
   * silently reinterpreted as the new contract.
   */
  legacyAliases?: boolean
  /**
   * Filesystem roots this deployment authorizes (SEC-06).
   *
   * Empty by default, which fails closed: a path-bearing tool then refuses every
   * call rather than admitting an arbitrary path. An operator adds the roots this
   * machine may read from.
   */
  approvedRoots?: string[]
  /** Grant identity recorded in receipts; defaults to `local-interactive`. */
  grantId?: string
  /** Whether receipts may be recorded (SEC-03); default true. */
  recordReceipts?: boolean
  /**
   * The CODE-11 repair-attempt ceiling for bounded-repair tools.
   *
   * The FLAT key is the deprecated-alias-compatible spelling that drives
   * behaviour; `harnessExecutorV3.defaultRepairAttempts` is its v3 equivalent.
   * An integer 0..8; 0 disables repairs. Default 1. An invalid value refuses
   * at config parse, never silently clamps.
   */
  repairAttempts?: number
  /**
   * Which capture profile this deployment runs under (OBS-03).
   *
   * `standard` is the default. `metadata-only` is for a headless local-specialist deployment: it
   * REFUSES harness-backed execution where a no-retention policy cannot be honoured alongside
   * DSH's requirement that model-visible inputs be reconstructable — rather than logging bodies
   * against the policy or bypassing DSH, both of which are forbidden.
   */
  captureProfile?: 'standard' | 'metadata-only'
  /**
   * The deployment's harness provider, for executing DECLARATIVE packages (HLM-01).
   *
   * Supplied by the DEPLOYMENT rather than constructed here, because which model answers a
   * harness call is not this plugin's business — and the architecture gate forbids
   * model-specific code in the host. Absent means a declarative package resolves but is not
   * served, and the refusal says so at preparation rather than at the first invocation.
   */
  harnessProvider?: LlmProvider
  /**
   * Opt the host INTO a REAL DSH-backed harness provider (HLM-01/02/03).
   *
   * DEFAULT OFF: absent, nothing is wired and every existing test and packed probe is
   * unchanged. When set, the host builds a {@link DshLlmProvider} over the deployment's
   * DSH LLM surface (`ctx.llm`), reading the model's OWN capability descriptor, and uses
   * it for declarative recipes — with the image transport minted only when the DSH
   * attachment service is reachable, otherwise capabilities honestly report `unknown`
   * and the broker refuses image recipes rather than dropping them. An explicit
   * `harnessProvider` wins over this option (test doubles and prebuilt providers).
   */
  harnessModel?: HarnessModelConfig
  /**
   * Opt the host INTO routing extension invocations through managed worker
   * processes (EXT-20).
   *
   * DEFAULT OFF: absent, every extension runs in-process exactly as before, and no
   * child process is ever spawned by this plugin. When set, each extension's module
   * entry runs in a scrubbed-environment managed process — ONE process per extension
   * per activation generation, disposed when the generation advances — and the host's
   * dispatch discipline is unchanged: grant authorization and schema validation stay
   * HOST-side before the worker call, and the worker's result is validated against
   * the declared output schema exactly like the in-process path.
   */
  managedWorkers?: boolean
  /**
   * Extension ids the operator switched OFF in Settings.
   *
   * The store still holds them and their desired activation is unchanged; the
   * host simply does not restore them, so their tools never register. Removing
   * an id re-activates the extension on the next load.
   */
  disabledExtensions?: string[]
  /**
   * Environment names to pass through to managed workers, on top of the SDK's
   * bootstrap allowlist. Explicit names only — never `process.env` wholesale.
   */
  workerEnvPassthrough?: string[]
  /** Hard resource limits overriding the conservative defaults. */
  limits?: { maxInputBytes?: number; maxAudioSeconds?: number; maxResultBytes?: number }
}

/** Validate and default the plugin configuration. */
/**
 * Mark one Config field as Settings-UI editable.
 *
 * schemastery exposes a field to the settings mirror only when it carries the
 * volatile marker (the reference plugin `@try-works/dsh-memory` documents this:
 * "Only .volatile() fields are exposed to the Settings UI and may be written by
 * the config editor"). `.volatile()` also narrows the schema's inferred type, so
 * this helper keeps the declared `z<Config>` surface intact.
 * @param schema - the field schema.
 * @returns the same schema with the runtime volatile marker.
 */
function settingsField<T>(schema: z<T>): z<T> {
  return schema.volatile() as unknown as z<T>
}

export const Config: z<Config> = z.object({
  catalogFile: z.string(),
  playbookFile: z.string(),
  stateFile: z.string(),
  credentialsFile: z.string(),
  persist: z.boolean().default(true),
  providers: z.dict(z.string()).default({}),
  legacyAliases: z.boolean().default(false),
  /**
   * Settings → Model as Tool.
   *
   * Only volatile fields are exposed to the Settings UI and may be written by
   * the config editor; every other field is config-file only. Keep this surface
   * the operator knobs the client page edits.
   */
  approvedRoots: settingsField(z.array(z.string()).default([])),
  grantId: z.string().default('local-interactive'),
  recordReceipts: z.boolean().default(true),
  repairAttempts: settingsField(z.number().min(0).max(8).default(1)),
  limits: z.object({
    maxInputBytes: z.number(),
    maxAudioSeconds: z.number(),
    maxResultBytes: z.number(),
  }),
  models: settingsField(z.array(z.string()).default([])),
  exclude: settingsField(z.array(z.string()).default([])),
  exposeUnavailable: settingsField(z.boolean().default(false)),
  registerSkills: settingsField(z.boolean().default(true)),
  registerControlTool: settingsField(z.boolean().default(true)),
  hostedCode: z.boolean().default(false),
  cli: z.object({
    enabled: z.boolean().default(true),
    command: z.string().default(DEFAULT_CLI_COMMAND),
  }),
  remote: z.object({
    endpoint: z.string(),
    token: z.string(),
  }),
  harnessModel: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  managedWorkers: settingsField(z.boolean().default(false)),
  workerEnvPassthrough: z.array(z.string()).default([]),
  allowNpm: settingsField(z.boolean().default(true)),
  disabledExtensions: settingsField(z.array(z.string()).default([])),
  /**
   * §12 CONFIG V3: the proposed nested schemaVersion-3 shape. The spec's
   * fixed-false flags are parsed here and REJECTED when set true (unsupported
   * values refuse rather than being accepted as ineffective flags); the
   * remaining nested fields are carried as data for the launcher's doctor and
   * future wiring. The flat legacy fields above remain the deprecated aliases
   * that actually drive behavior, so existing v1/v2 configs stay green.
   */
  schemaVersion: z.number(),
  extensions: z.object({
    protocolMajor: z.number(),
    manifestVersion: z.string(),
    registry: z.string(),
    allowHttpsArchives: z.boolean(),
    allowLocalArchives: z.boolean(),
    allowSourceDirectories: z.boolean(),
    automaticUpdates: z.boolean(),
    runInstallScripts: z.boolean(),
  }),
  mcpV3: z.object({
    enabled: z.boolean(),
    protocolVersions: z.array(z.string()),
    legacyCompatibility: z.boolean(),
    host: z.string(),
    port: z.number(),
    path: z.string(),
    allowedOrigins: z.array(z.string()),
    exportTools: z.array(z.string()),
    catalogTtlMs: z.number(),
    catalogCacheScope: z.string(),
    auth: z.object({ mode: z.string(), authorizationServerProfile: z.any() }),
  }),
  compositionV3: z.object({
    enabled: z.boolean(),
    defaultTimeoutMs: z.number(),
    maxTimeoutMs: z.number(),
    maxToolCalls: z.number(),
    maxConcurrentBindings: z.number(),
    maxHarnessModelCalls: z.number(),
  }),
  multimodalV3: z.object({
    defaultDimensions: z.number(),
    defaultOverflow: z.string(),
    maxVideoFrames: z.number(),
    audioSampleRateHz: z.number(),
    selectiveEncoderLoading: z.boolean(),
  }),
  harnessExecutorV3: z.object({
    enabled: z.boolean(),
    nativeSelection: z.string(),
    externalDefaultProfile: z.any(),
    profiles: z.array(z.any()),
    defaultMaxAttempts: z.number(),
    defaultRepairAttempts: z.number().min(0).max(8),
    defaultMaxOutputTokens: z.number(),
    defaultTimeoutMs: z.number(),
    inheritConversation: z.boolean(),
    allowModelToolCalls: z.boolean(),
  }),
  recipesV3: z.object({
    schemaVersion: z.string(),
    allowLocalAuthoring: z.boolean(),
    automaticActivation: z.boolean(),
    allowExecutableTemplates: z.boolean(),
  }),
  clientsV3: z.array(z.any()),
  captureV3: z.object({
    bodies: z.boolean(),
    retentionDays: z.number(),
    maxBytes: z.number(),
    auxiliaryLlmJournal: z.object({ enabled: z.boolean(), retentionDays: z.number() }),
  }),
})

/**
 * §12: the spec's fixed-false flags REJECT unsupported values instead of being
 * accepted as ineffective flags. A config that sets any of them to true fails
 * the configuration with the named flag, never silently ignores it.
 * @param config - the parsed configuration.
 * @throws Error naming the first flag set to an unsupported value.
 */
export function assertConfigV3DisabledFlags(config: Config): void {
  const fixedFalse = [
    ['extensions.automaticUpdates', config.extensions?.automaticUpdates],
    ['extensions.runInstallScripts', config.extensions?.runInstallScripts],
    ['recipes.automaticActivation', config.recipesV3?.automaticActivation],
    ['recipes.allowExecutableTemplates', config.recipesV3?.allowExecutableTemplates],
    ['harnessExecutor.inheritConversation', config.harnessExecutorV3?.inheritConversation],
    ['harnessExecutor.allowModelToolCalls', config.harnessExecutorV3?.allowModelToolCalls],
  ] as const
  for (const [name, value] of fixedFalse) {
    if (value === true) {
      throw new Error(
        `${name} is fixed false in this implementation (spec §12); setting it to true is refused rather than `
        + 'accepted as an ineffective flag. Remove the field or set it to false.',
      )
    }
  }
}

/**
 * The CODE-11 repair-attempt ceiling for one configuration (task-74).
 *
 * The flat `repairAttempts` key drives; the v3 nested spelling
 * `harnessExecutorV3.defaultRepairAttempts` is its equivalent; absent both,
 * the default is 1. An out-of-range value is a REFUSAL, never a silent clamp:
 * a ceiling the operator did not write is a budget nobody approved.
 * @param config - the parsed configuration.
 * @throws Error naming the invalid value.
 */
export function repairCeilingOf(config: Config): number {
  const ceiling = config.repairAttempts ?? config.harnessExecutorV3?.defaultRepairAttempts ?? 1
  if (typeof ceiling !== 'number' || !Number.isInteger(ceiling) || ceiling < 0 || ceiling > 8) {
    throw new Error(
      `repairAttempts must be an integer between 0 and 8 (CODE-11); received ${JSON.stringify(ceiling)}. `
      + 'A repair ceiling outside this range is refused rather than silently clamped.',
    )
  }
  return ceiling
}

/** One registered model, as reported by `model_tools`. */
interface InstalledModel {
  readonly entry: ModelCatalogEntry
  readonly toolName: string
  readonly dispose: () => void
  disposeSkill?: () => void
  /** Disposer for the opt-in deprecated alias, when one was registered (BASE-03). */
  disposeAlias?: () => void
}

/** One model as the `model_tools` control tool reports it. */
export interface ModelDescriptor {
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly capability: string
  readonly input: string
  readonly tool: string
  readonly skill: string
  readonly runnable: boolean
  readonly route: string
  readonly reason: string
  readonly languages: number | null
  readonly license: string
  readonly docs: string
}

/** Render the model list the control tool returns, and the plugin logs. */
export function describeModels(resolved: readonly ResolvedModel[]): ModelDescriptor[] {
  return resolved.map(({ entry, verdict }) => ({
    id: entry.id,
    name: entry.name,
    summary: entry.summary,
    capability: entry.capability,
    input: entry.input,
    tool: entry.tool.name,
    skill: entry.skill.name,
    runnable: verdict.runnable,
    route: verdict.route,
    reason: verdict.reason,
    languages: entry.languages,
    license: entry.license,
    docs: entry.docsUrl,
  }))
}

/**
 * Register the Desert Ant model tools and skills.
 * @param ctx - the plugin context whose tool registry receives the definitions.
 * @param config - deployment configuration for which models to expose.
 */
/**
 * The Config fields the Settings page edits (marked volatile in the schema).
 *
 * schemastery parses a volatile field into a LIVE REFERENCE (`{ get() }`) rather
 * than a plain value, so the settings editor can commit a new value into the
 * running fiber. Every consumer here reads the plain value, so apply unwraps
 * them once and re-unwraps on `loader/volatile-update`.
 */
const VOLATILE_CONFIG_KEYS = [
  'approvedRoots', 'repairAttempts', 'models', 'exclude', 'exposeUnavailable',
  'registerSkills', 'registerControlTool', 'managedWorkers', 'allowNpm', 'disabledExtensions',
] as const

/** Read a plain value out of a volatile reference (or return it untouched). */
function unwrapVolatile<T>(value: T | { get(): T }): T {
  const candidate = value as { get?: () => T } | undefined
  return candidate !== undefined && typeof candidate.get === 'function' ? candidate.get() : value as T
}

/** Replace every volatile field on the config object with its current value. */
function absorbVolatileConfig(config: Config): void {
  const writable = config as unknown as Record<string, unknown>
  for (const key of VOLATILE_CONFIG_KEYS) {
    if (key in writable) writable[key] = unwrapVolatile(writable[key])
  }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  // Volatile fields arrive as live references; the rest of apply reads values.
  absorbVolatileConfig(config)
  // A Settings save commits a new volatile value into the running fiber; without
  // this the page would persist the change and the plugin keep the old value.
  // The event is declared by the harness loader (not by the cordis types this
  // package compiles against), so the name is cast rather than left unchecked.
  ctx.on('loader/volatile-update' as never, (() => {
    try {
      absorbVolatileConfig(config)
    } catch (error) {
      ctx.logger?.warn?.(`could not re-read volatile configuration: ${error instanceof Error ? error.message : String(error)}`)
    }
  }) as never)
  // §12: the fixed-false flags REFUSE unsupported values before anything runs.
  assertConfigV3DisabledFlags(config)
  const entries = loadCatalog(config.catalogFile)

  /**
   * Declared at the apply top so the catalog-change notifier (below) can read
   * the generation without a temporal-dead-zone window during the startup
   * install loop; the extension-store block assigns it.
   */
  let extensionLifecycle: ExtensionLifecycle | undefined

  /**
   * P26-09/MCP-07 (task-65 + task-73): the host-side catalog subscription
   * pipeline. Every lifecycle transition publishes
   * `notifications/tools/list_changed` and runs it through the DELIVERY
   * consumer (deliverCatalogChange): the registry's per-caller filtering
   * decides who gets the event, and the sink carries it to each client's
   * stream. The memory sink is the transport seam — a streaming transport
   * injects its own writer; the consumer path, the ack-first ordering and the
   * revocation discipline are all exercised by the tests.
   */
  const subscriptionRegistry = new SubscriptionRegistry()
  const subscriptionSink = new MemoryDeliverySink()
  const notifyCatalogChange = (): void => {
    const generation = extensionLifecycle?.generation ?? host.activationGeneration
    deliverCatalogChange(subscriptionRegistry, generation, subscriptionSink)
  }
  const playbooks = loadPlaybooks(config.playbookFile)
  const installed = new Map<string, InstalledModel>()

  // An empty allowlist means "no explicit selection" rather than "select
  // nothing": the config schema materializes a declared array to `[]`.
  const wanted = config.models !== undefined && config.models.length > 0
    ? new Set(config.models)
    : undefined
  const excluded = new Set(config.exclude ?? [])
  const exposeUnavailable = config.exposeUnavailable ?? false
  const registerSkills = config.registerSkills ?? true

  // Persistence: the config states the deployment default, the store records the
  // user's choices on top of it, so enable/disable outlives the session.
  const persist = config.persist ?? true
  const stateStore: StateStore = persist
    ? createFileStateStore(config.stateFile ?? defaultStateFile())
    : createMemoryStateStore()
  let persisted: PersistedState = stateStore.read()

  /**
   * BASE-09/10 LEGACY MIGRATION (one-time, per profile — task-26).
   *
   * A legacy model-id era state document is migrated on the FIRST startup that
   * sees it: disabled choices are preserved into the host's persisted state,
   * legacy enables are STAGED (never granted — no implicit consent to install,
   * activate or prepare third-party code), the original document is journaled,
   * and the SDK profile half runs through the SDK's own migration when an
   * extension store is mounted. A sidecar marker commits the transaction, so
   * every later startup is a byte-stable no-op. Corrupt or foreign-version
   * documents and markers fail the boot closed (src/legacy-migration.ts).
   */
  const legacy = persist
    ? await runLegacyStartupMigration({
        stateFile: config.stateFile ?? defaultStateFile(),
        store: stateStore,
        extensionStoreDir: config.extensionStore ?? '',
        log: line => ctx.logger.info(`model-tools: ${line}`),
      })
    : undefined
  // ALWAYS adopt the hook's fresh read: another process may have committed the
  // migration between OUR initial stateStore.read() above and the hook's lock,
  // and the pre-hook snapshot would silently re-apply the legacy enables.
  if (legacy !== undefined) persisted = legacy.hostState

  /**
   * The operator-owned credential store (SEC-01).
   *
   * Only a DEPLOYMENT THAT PERSISTS may generate credentials: with persistence off
   * there is nowhere owner-only to put a secret, and issuing one that a restart
   * would forget violates the fail-closed clause, so generation refuses.
   */
  const credentialStore = persist
    ? createFileCredentialStore(config.credentialsFile ?? defaultCredentialStoreFile())
    : undefined

  /**
   * The harness provider composition (HLM-01/02/03).
   *
   * An EXPLICIT `harnessProvider` (a test double, or a deployment-built provider) always
   * wins. Otherwise the opt-in `harnessModel` builds a REAL DSH-backed provider over the
   * deployment's `ctx.llm` — and only when that surface can actually serve the named
   * model; every failure falls closed to `undefined`, which is exactly the absent state
   * the declarative path already refuses honestly. DEFAULT OFF: no flag, no provider,
   * nothing changes anywhere.
   */
  const harnessProvider = config.harnessProvider !== undefined
    ? config.harnessProvider
    : config.harnessModel !== undefined
      ? await buildHarnessLlmProvider(
          {
            // ctx.get (not property access): the plugin declares only `tools` in its
            // inject list, so reading an undeclared service as a property would throw;
            // get() answers undefined for anything the deployment did not mount.
            ...ctx.get('llm') === undefined ? {} : { llm: ctx.get('llm') as unknown },
            ...ctx.get('attachments') === undefined
              ? {}
              : {
                  attachments: ctx.get('attachments') as
                    { saveImage(input: { data: Uint8Array; mediaType: string }): Promise<unknown> },
                },
          },
          config.harnessModel,
          message => ctx.logger?.warn?.(`model-tools: ${message}`),
        )
      : undefined

  /**
   * The managed-worker half (EXT-20), DEFAULT OFF.
   *
   * `managedWorkers` opts the deployment in; absent, the registry exists but never
   * receives a binding, so no child process is ever spawned. The per-extension
   * activation generation is captured at RESTORE (the host's only activation surface)
   * and the registry disposes the old process the moment a newer generation is bound.
   */
  const managedWorkers = config.managedWorkers ?? false
  const workerEnvPassthrough = config.workerEnvPassthrough ?? []
  const workerRegistry = createManagedWorkerRegistry()
  const activationGenerations = new Map<string, number>()

  const cliCommand = config.cli?.command ?? DEFAULT_CLI_COMMAND
  const cliEnabled = config.cli?.enabled ?? true
  // Established once: probing PATH per model would repeat identical work and
  // make the reported reasons depend on when they were read.
  const cliAvailable = cliEnabled && commandExists(cliCommand)
  const remoteEndpoint = config.remote?.endpoint
  const transportOptions = {
    cliCommand,
    ...remoteEndpoint !== undefined ? { endpoint: remoteEndpoint } : {},
    ...config.remote?.token !== undefined ? { token: config.remote.token } : {},
  }

  const resolved: ResolvedModel[] = entries.map(entry => ({
    entry,
    verdict: resolveCapability(entry, {
      cliAvailable,
      remoteEndpoint,
      ...config.allowNpm !== undefined ? { allowNpm: config.allowNpm } : {},
    }),
  }))
  const byId = new Map(resolved.map(item => [item.entry.id, item]))

  /**
   * Choose the implementation that serves each standard contract (BASE-02).
   *
   * A contract is registered once. Selection is host configuration: an explicit
   * `providers` override wins only if that model can actually run here, and
   * otherwise the first eligible implementation in catalog order is used. The
   * alternatives are kept so discovery can report them without a caller having to
   * choose a model.
   */
  // The host owns provenance and authority: `extension`/`version` name THIS
  // package, the receipt counter lives here, and the grant is built from operator
  // configuration, so an implementation can forge neither (BASE-05, DECL-03).
  let receiptCounter = 0
  /** The most recent invocation receipts (EXT-35), bounded so retention cannot grow without limit. */
  const invocationReceipts: InvocationReceipt[] = []
  /**
   * External (MCP) call accounting, bounded like the receipts (OBS-02).
   *
   * Kept SEPARATE from the native receipts: the shapes differ (a native receipt
   * is provenance — contract/implementation/extension identities — while an
   * external accounting is timings, class and sizes), and merging them would
   * force one record to pretend it is the other.
   */
  const externalAccountings: InvocationAccounting[] = []
  const grant = createGrant({
    grantId: config.grantId ?? 'local-interactive',
    // Every registered tool is granted to the interactive operator. EXTERNAL
    // clients do NOT share this grant: since round 66, each authenticated MCP
    // client's call carries its OWN derived grant (SEC-04) — resolved by the
    // transport, enforced at the surface boundary below with authorizeTool — so
    // an external call never dispatches as the operator. model_tools is part of
    // THIS grant only, which is why it is reachable interactively but never
    // appears on the external surface.
    allowedTools: [...STANDARD_CONTRACTS.map(contract => contract.toolName), 'model_tools'],
    approvedRoots: config.approvedRoots ?? [],
    hostedCode: false,
    recordingPolicy: config.recordReceipts === false ? 'none' : 'receipts',
    ...config.limits === undefined ? {} : { limits: config.limits },
  })
  const host: HostIdentity = {
    extension: '@try-works/dsh-model-as-tool',
    extensionVersion: HOST_VERSION,
    activationGeneration: 1,
    nextReceiptId: () => `rcpt_${(++receiptCounter).toString(36).padStart(6, '0')}`,
    grant,
    callerKind: 'interactive',
    // EXT-35: bounded in-memory retention. A receipt is provenance, not a log of
    // content, so retaining the last N costs little and makes the record
    // recoverable after the call rather than only during it.
    recordReceipt: receipt => {
      invocationReceipts.push(receipt)
      if (invocationReceipts.length > MAX_RETAINED_RECEIPTS) invocationReceipts.shift()
    },
  }

  /**
   * Extension providers, reached only through the public extension API (BASE-09).
   *
   * The host holds no adapter for any model: a catalog entry names the package
   * that implements it, and this bridge loads it. One bridge per activation, so an
   * extension serving several models is imported once.
   */
  const bridge = new ProviderBridge({
    grant,
    activationGeneration: host.activationGeneration,
    // EXT-20: the opt-in routes the bridge's catalog invocation AND inspection
    // through the managed-worker registry; without it the in-process path is
    // exactly as before (default OFF).
    ...managedWorkers ? { managed: workerRegistry } : {},
    log: (message, fields) => ctx.logger?.debug?.(`[model-as-tool] ${message}`, fields),
  })

  const contractById = new Map<string, ToolContract>(
    STANDARD_CONTRACTS.map(contract => [contract.contract, contract]),
  )
  const bindings = new Map<string, ContractBinding>()
  for (const contract of STANDARD_CONTRACTS) {
    const eligible = resolved.filter(
      item => item.entry.contract === contract.contract && item.verdict.runnable,
    )
    if (eligible.length === 0) continue
    const override = config.providers?.[contract.contract]
    const chosen = eligible.find(item => item.entry.id === override) ?? eligible[0]
    if (chosen === undefined) continue
    const adapter = createAdapter(chosen.entry, { route: chosen.verdict.route, ...transportOptions }, undefined, bridge)
    if (adapter === undefined) continue
    bindings.set(contract.contract, {
      contract,
      implementation: chosen.entry,
      adapter,
      route: chosen.verdict.route,
      alternatives: eligible.filter(item => item.entry.id !== chosen.entry.id).map(item => item.entry.id),
    })
  }


  /** Contracts already registered, so a second implementation joins rather than duplicates. */
  const registeredContracts = new Map<string, { toolName: string; dispose: () => void }>()

  /**
   * The MCP surface over the tools this activation actually published (MCP-08/09).
   *
   * It reads `registeredContracts`, so a tool appears over MCP only if it was
   * REGISTERED here — the publication surface already decided that, and re-deriving
   * it would let MCP advertise something the host had withheld.
   */
  const mcpHost = createMcpHost({
    serverInfo: { name: '@try-works/dsh-model-as-tool', version: HOST_VERSION },
    surface: {
      get published() {
        const out: PublishedTool[] = []
        for (const [contractId, registered] of registeredContracts) {
          const contract = contractById.get(contractId)
          if (contract === undefined) continue
          out.push({ toolName: registered.toolName, contract })
        }
        // CODE-02: `tool_mode_run` is exported over MCP exactly when the exposure
        // gate permits it — the conjunction of operator consent and confinement
        // evidence. While the gate is closed the export is simply absent, which is
        // the disabled-until-granted state CODE-10 names. The contract is ONE
        // shared definition (TOOL_MODE_RUN_CONTRACT), validated by a conformance
        // test before it ever appears on a live tools/list.
        if (programRunner.externalExposurePermitted()) {
          out.push({ toolName: 'tool_mode_run', contract: TOOL_MODE_RUN_CONTRACT as never })
        }
        return out
      },
      async execute({ name, arguments: args, signal, callId, caller }) {
        /**
         * SEC-04: AN EXTERNAL CLIENT RUNS UNDER ITS OWN GRANT, never the host's.
         *
         * The transport resolved the authenticated caller and its derived grant; the
         * host ENFORCES it here with the SEC-03 authority — a tool the operator is
         * granted but the client is not stays refused for that client. A call with no
         * caller (the native/interactive path) keeps the host's own authority, which
         * is unchanged.
         */
        if (caller !== undefined) {
          try {
            authorizeTool({
              grantId: caller.grantId,
              allowedTools: caller.allowedTools,
              approvedRoots: [],
              remoteDestinations: [],
              hostedCode: false,
              recordingPolicy: caller.recordingPolicy,
              limits: caller.limits,
            }, name)
          } catch (error) {
            // The refusal is a TOOL error, not a protocol error: the exchange
            // succeeded and the grant refused the work (P26-04, SEC-03).
            return { isError: true, message: error instanceof Error ? error.message : String(error) }
          }
        }
        // MCP-08: routed through the DSH tool runtime with a SERVER-ISSUED call
        // identity and the CALLER's signal, never by resolving a definition and
        // calling it directly — that path would bypass the grant, the receipt and
        // the result policy the runtime applies.
        //
        // SEC-04 COMPOSITION: an external call runs INSIDE the caller's grant
        // context, so any COMPOSED work — a tool_mode_run program dispatching
        // sub-calls — authorizes against the CLIENT's grant, not the host's
        // (H1). The native path carries no context and is unchanged.
        const result = caller === undefined
          ? await ctx.tools.execute({
              signal,
              callId: ToolCallId(callId),
              name,
              arguments: args,
            })
          : await externalGrantContext.run(caller.allowedTools, () => ctx.tools.execute({
              signal,
              callId: ToolCallId(callId),
              name,
              arguments: args,
            }))
        return result.isError
          ? { isError: true, message: result.error.message }
          : { isError: false, value: result.value }
      },
    },
    onWithheld: tool => ctx.logger.info(
      `model-tools: ${tool.toolName} is not exported over MCP: ${tool.notExportableReason ?? 'no reason given'}`,
    ),
    // OBS-02: the external half of the traffic gets its receipt WIRED rather than
    // dropped. The hook receives timings, class and SIZES — never the payload —
    // so this records the external call without duplicating a large result. The
    // ring is bounded exactly like the native one (EXT-35).
    onAccounted: accounting => {
      externalAccountings.push(accounting)
      if (externalAccountings.length > MAX_RETAINED_RECEIPTS) externalAccountings.shift()
    },
  })

  /**
   * THE HOST'S OWN MCP SURFACE, EXPOSED so an operator can serve it (OBS-02).
   *
   * Before this service existed the host's mcpHost was reachable only through
   * the model_tools inspection actions — which meant its `callTool` path (and
   * therefore the wired external accounting) had NO production caller. The
   * service is what `startHttpServer` composes over; a deployment that serves
   * MCP reads it here instead of rebuilding a surface that would not carry the
   * host's receipts.
   *
   * Guarded (round 65): `provide` THROWS if the name is already provided in the
   * scope (a double mount), and a context without `provide` must degrade with a
   * diagnostic rather than silently or loudly failing the mount.
   */
  try {
    ;(ctx as unknown as { provide?: (name: string, value: unknown) => void }).provide?.('model-tools.mcp-host', mcpHost)
  } catch (error) {
    ctx.logger?.warn?.(
      `model-tools: could not expose the MCP host service: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  /**
   * The publication decision for one catalog entry (EXT-24, EXT-32).
   *
   * ONE function decides what may be published, used by the installer and by the
   * discovery surface. Two call sites computing this separately is how a tool ends
   * up registered while discovery reports it withheld, or the reverse.
   */
  /**
   * The selected implementation's current preparation state.
   *
   * Capability resolution only proves that a route can be reached. For extension
   * providers that is not enough to publish a working tool: the extension's
   * read-only inspection owns the distinction between missing prerequisites,
   * prepared-cold and ready. Non-extension transports have no preparation
   * lifecycle yet, so their existing capability verdict remains the readiness
   * source.
   */
  const callableReadiness = new Set<ImplementationCandidate['readiness']>([
    'prepared-cold',
    'loading',
    'ready',
    'busy',
  ])

  const readinessOf = async (item: ResolvedModel): Promise<ImplementationCandidate['readiness']> => {
    if (item.verdict.route !== 'extension') return 'ready'
    try {
      const inspection = await bridge.inspect(item.entry, new AbortController().signal)
      return inspection?.readiness ?? 'failed'
    } catch (error) {
      ctx.logger.warn(
        `model-tools: ${item.entry.name} provider inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return 'failed'
    }
  }

  const implementationFor = async (item: ResolvedModel): Promise<ImplementationCandidate> => ({
    extensionId: item.entry.provider?.extension
      ?? item.entry.npmPackage
      ?? 'unknown',
    modelId: item.entry.id,
    readiness: await readinessOf(item),
    runnable: item.verdict.runnable,
  })

  const surfaceFor = async (entry: ModelCatalogEntry): Promise<CatalogGeneration | undefined> => {
    const binding = entry.contract === null ? undefined : bindings.get(entry.contract)
    if (binding === undefined) return undefined
    const selected = resolved.find(item => item.entry.id === binding.implementation.id)
    if (selected === undefined) return undefined
    return buildSurface({
      generation: host.activationGeneration,
      tools: [{
        name: binding.contract.toolName,
        contractId: binding.contract.contract,
        selectedModelId: binding.implementation.id,
        implementations: [
          await implementationFor(selected),
          ...await Promise.all(binding.alternatives.map(async alternativeId => {
            const alternative = resolved.find(item => item.entry.id === alternativeId)
            return alternative === undefined
              ? {
                  extensionId: 'unknown',
                  modelId: alternativeId,
                  readiness: 'failed' as const,
                  runnable: false,
                }
              : implementationFor(alternative)
          })),
        ],
      }],
      skills: [],
    })
  }

  /**
   * Register one model's tool and skill.
   *
   * A model bound to a standard contract contributes to that CONTRACT's single
   * tool; a model with no contract keeps its own per-model tool. Idempotent in
   * both cases, so the control tool can call it without first checking.
   * @param item - the resolved model to install.
   * @returns whether the model is installed after the call.
   */
  const install = async (item: ResolvedModel): Promise<boolean> => {
    const { entry, verdict } = item
    if (installed.has(entry.id)) return true
    if (!verdict.runnable && !exposeUnavailable) return false

    let toolName = entry.tool.name
    let dispose: () => void

    if (entry.contract !== null && contractById.has(entry.contract)) {
      const binding = bindings.get(entry.contract)
      if (binding === undefined) {
        // The model implements a contract but lost provider selection, or cannot
        // run. Report rather than register a second tool for the same contract.
        ctx.logger.info(
          `model-tools: ${entry.name} implements ${entry.contract} but is not the selected provider; `
          + 'no separate tool is registered (BASE-02)',
        )
        return false
      }

      /**
       * EXT-24: decide what may be published BEFORE registering anything.
       *
       * The surface is built whole and consulted first, so a tool is registered
       * only when the surface actually published it. Registering first and
       * reconciling afterwards is the state EXT-24 forbids: a caller would observe
       * an available tool whose binding was not yet in place.
       *
       * One helper serves the installer and the discovery surface, because two call
       * sites computing this separately is how a tool gets registered while
       * discovery reports it withheld, or the reverse.
       */
      const surface = await surfaceFor(entry)
      const decision = surface?.tools[0]
      if (decision === undefined) {
        const reason = surface?.withheld[0]
        ctx.logger.info(
          `model-tools: ${entry.name} is active but its tool is withheld (${reason?.code ?? 'unknown'}): `
          + `${reason?.message ?? 'no reason reported'}`,
        )
        return false
      }

      const existing = registeredContracts.get(entry.contract)
      if (existing !== undefined) {
        // Already served by another implementation: this model joins that tool.
        toolName = existing.toolName
        dispose = () => {}
      } else {
        const registered = registerContractTool(
          ctx as unknown as { tools: { register(definition: unknown): () => void } },
          binding,
          host,
        )
        registeredContracts.set(entry.contract, registered)
        toolName = registered.toolName
        dispose = registered.dispose
      }
    } else {
      if (verdict.route === 'extension') {
        const readiness = await readinessOf(item)
        if (!callableReadiness.has(readiness)) {
          ctx.logger.info(
            `model-tools: ${entry.name} is active but its provider reports ${readiness}; skipping ${entry.tool.name}`,
          )
          return false
        }
      }
      const adapter = createAdapter(entry, { route: verdict.route, ...transportOptions }, undefined, bridge)
      if (adapter === undefined) {
        // Runnable but no adapter yet: report rather than register a dead tool.
        ctx.logger.info(
          `model-tools: ${entry.name} can run here (${verdict.route}) but no adapter ships yet; skipping ${entry.tool.name}`,
        )
        return false
      }
      const registration = registerModelTool(
        ctx as unknown as { tools: { register(definition: unknown): () => void } },
        entry,
        adapter,
      )
      toolName = registration.toolName
      dispose = registration.dispose
    }

    const record: InstalledModel = { entry, toolName, dispose }

    if (registerSkills) {
      const skills = ctx.get('skills')
      if (skills !== undefined) {
        const body = renderSkillBody(entry, playbooks.get(entry.id))
        record.disposeSkill = skills.register({
          name: entry.skill.name,
          description: entry.skill.description,
          ...entry.skill.whenToUse !== undefined ? { whenToUse: entry.skill.whenToUse } : {},
          content: body,
          source: 'bundled',
        })
      }
    }

    // BASE-03: the deprecated alias is opt-in, so the default catalog shows one
    // transcription tool. It keeps its own name and adapter, never the new
    // contract's schema, so an old caller's arguments are not reinterpreted.
    if (config.legacyAliases === true && entry.contract !== null && entry.tool.name !== toolName) {
      const aliasAdapter = createAdapter(entry, { route: verdict.route, ...transportOptions }, undefined, bridge)
      if (aliasAdapter !== undefined) {
        const alias = registerModelTool(
          ctx as unknown as { tools: { register(definition: unknown): () => void } },
          entry,
          aliasAdapter,
        )
        record.disposeAlias = alias.dispose
        ctx.logger.info(`model-tools: registered deprecated alias ${alias.toolName} (BASE-03)`)
      }
    }

    installed.set(entry.id, record)
    ctx.logger.info(
      `model-tools: registered ${toolName} for ${entry.name} (${verdict.route})`,
    )
    notifyCatalogChange()
    return true
  }

  /**
   * Unregister one model's tool and skill.
   * @param modelId - the catalog id to remove.
   * @returns whether the model was installed.
   */
  const uninstall = (modelId: string): boolean => {
    const record = installed.get(modelId)
    if (record === undefined) return false
    record.disposeSkill?.()
    record.disposeAlias?.()
    record.dispose()
    // A contract-served model's registration is owned by the contract; dropping
    // the last model that used it must also release the contract's tool, or a
    // removed implementation would keep answering calls.
    if (record.entry.contract !== null) {
      const stillInstalled = [...installed.values()].some(
        other => other.entry.id !== modelId && other.entry.contract === record.entry.contract,
      )
      if (!stillInstalled) registeredContracts.delete(record.entry.contract)
    }
    installed.delete(modelId)
    ctx.logger.info(`model-tools: unregistered ${record.toolName}`)
    notifyCatalogChange()
    return true
  }

  /**
   * Record one user choice durably.
   *
   * A failed write is reported rather than swallowed: the caller asked for a
   * change that is supposed to survive a restart, and quietly keeping it
   * in-memory would make the next session silently disagree.
   * @param modelId - the model the user acted on.
   * @param enabled - true to turn on, false to turn off.
   * @returns whether the choice was written to the durable store.
   */
  const remember = (modelId: string, enabled: boolean): boolean => {
    persisted = withChoice(persisted, modelId, enabled)
    if (!persist) return false
    stateStore.write(persisted)
    return true
  }

  /** The configuration's own selection, before the user's choices are layered on. */
  const configuredIds = resolved
    .filter(item => (wanted === undefined || wanted.has(item.entry.id)) && !excluded.has(item.entry.id))
    .map(item => item.entry.id)

  for (const item of resolved) {
    const { install: selection, disabled } = resolveSelection(configuredIds, persisted)
    if (!selection.has(item.entry.id)) {
      if (disabled.has(item.entry.id) && item.verdict.runnable) {
        ctx.logger.info(`model-tools: ${item.entry.name} stays uninstalled (disabled by the user)`)
      }
      continue
    }
    // A model the user enabled that cannot run here is reported, not installed:
    // the persisted choice is kept so it takes effect once a route appears.
    await install(item)
  }

  /**
   * The host's EXT-30 update surface, constructed when the extension store is
   * configured (the management-channel actions below drive it). Declared here,
   * outside the control-tool registration, so the execute closure and the
   * extension-store block share it.
   */
  let updateSurface: UpdateHostSurface | undefined

  /**
   * The host's prepared-assets surface (RES-02/03/05, the last slice): lock
   * reading, the preparation plan, acquisition and the PreparedAssetMapV1 the
   * provider routes consume. Same outer-scope reason as updateSurface.
   */
  let prepareAssetsSurface: PrepareAssetsSurface | undefined

  if (config.registerControlTool ?? true) {
    ctx.tools.register(defineTool({
      name: 'model_tools',
      description:
        'Inspect and control the on-device models available to this agent: list what each one does and whether it '
        + 'can run on this machine, install a model\'s tool, or remove one. Installs and removals are remembered '
        + 'across restarts. Use it before calling a model tool when unsure which one fits, to install a model the '
        + 'user asked for, or to explain why a model is unavailable here. Models that cannot run in this process '
        + 'report the exact reason.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'installed', 'describe', 'enable', 'disable', 'reset', 'receipts', 'mcp', 'diagnostics', 'credentials', 'extensions-pending', 'extensions-approve', 'extensions-deny', 'extensions-commit', 'extensions-rollback', 'extensions-prepare-plan', 'extensions-prepare', 'extensions-license-basis'],
          description:
            'list: every catalogued model and whether it runs here. installed: only the models whose tools are '
            + 'registered. describe: full detail for one model. enable: install a model\'s tool and remember it. '
            + 'disable: remove a model\'s tool and remember it. reset: forget the remembered choice for one model, '
            + 'or for every model when no id is given. credentials: list or revoke external MCP client credentials '
            + '(SEC-01). GENERATION IS REFUSED HERE: the generated secret must never reach a model, so credentials '
            + 'are generated by the human-only CLI instead. extensions-pending: the staged extension updates awaiting '
            + 'an operator decision (EXT-30). extensions-approve/extensions-deny: record the operator decision for one '
            + 'staged update. extensions-commit: commit an APPROVED staged update (quiesce, pointer, rebind). '
            + 'extensions-rollback: restore the previous version pointer. extensions-prepare-plan: disclose the '
            + 'preparation plan (per-asset bytes, total, license, executable gate) for one installed extension. '
            + 'extensions-prepare: download and digest-verify the planned assets into the isolated cache and flip the '
            + 'deployment to prepared-cold (the acquisition IS the operator consent; a real download is opt-in).',
        },
        model: {
          type: 'string',
          description:
            'Model id, required for describe, enable and disable, and optional for reset (for example "tongue" or "title"). '
            + 'For the extensions actions it names the EXTENSION id (for example "@try-works/extension-desert-ant-voz").',
        },
        version: {
          type: 'string',
          description:
            'The staged extension version, required for extensions-approve, extensions-deny and extensions-commit.',
        },
        allowExecutable: {
          type: 'boolean',
          description:
            'The extensions-prepare action: set true to grant the separate EXECUTABLE-preparation approval (RES-02). Without it a plan containing an executable asset refuses. The pinned EmbeddingGemma assets are NOT executable.',
        },
        licenseBasis: {
          type: 'object',
          additionalProperties: false,
          description:
            'The extensions-license-basis action (LIC-03): the human-recorded permission basis — native use, '
            + 'external export, distribution and telemetry — for one provider, recorded with the approving principal.',
          properties: {
            native: { type: 'boolean' },
            export: { type: 'boolean' },
            distribution: { type: 'boolean' },
            telemetry: { type: 'boolean' },
          },
        },
        principal: {
          type: 'string',
          description: 'The approving principal (operator identity) for the extensions-license-basis action (LIC-03).',
        },
        sub: {
          type: 'string',
          enum: ['generate', 'list', 'revoke'],
          description:
            'The credentials action: list names existing clients, revoke removes one. generate is DECLARED for '
            + 'schema completeness but always refused on this model-visible surface (SEC-01): the secret must '
            + 'never reach a model, so generation happens in the human-only CLI.',
        },
        scheme: {
          type: 'string',
          enum: ['static-token', 'oauth-resource-server'],
          description: 'Which authentication scheme the generated credential is for.',
        },
        clientId: {
          type: 'string',
          description: 'The client identity to generate or revoke, at most 64 characters.',
        },
        scope: {
          type: 'array',
          items: { type: 'string' },
          description: 'OAuth scope tokens for the generated client; defaults to mcp:call.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            models: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  summary: { type: 'string', required: true },
                  capability: { type: 'string', required: true },
                  input: { type: 'string', required: true },
                  tool: { type: 'string', required: true },
                  skill: { type: 'string', required: true },
                  runnable: { type: 'boolean', required: true },
                  installed: { type: 'boolean', required: true },
                  /** The user's remembered choice for this model. */
                  choice: { type: 'string', required: true, enum: ['none', 'enabled', 'disabled'] },
                  route: { type: 'string', required: true },
                  reason: { type: 'string', required: true },
                  languages: {
                    required: true,
                    oneOf: [
                      { type: 'integer' },
                      { type: 'null' },
                    ],
                  },
                  license: { type: 'string', required: true },
                  docs: { type: 'string', required: true },
                  /**
                   * Public extension/implementation provenance (EXT-32).
                   *
                   * Declared rather than left open: a discovery surface that could
                   * return anything would let the shape drift unnoticed, and the
                   * output schema refusing undeclared fields is what caught this
                   * addition in the first place.
                   */
                  provenance: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      contract: {
                        required: true,
                        oneOf: [{ type: 'string' }, { type: 'null' }],
                      },
                      extension: {
                        required: true,
                        oneOf: [{ type: 'string' }, { type: 'null' }],
                      },
                      modelId: {
                        required: true,
                        oneOf: [{ type: 'string' }, { type: 'null' }],
                      },
                      publishedTool: {
                        required: true,
                        oneOf: [{ type: 'string' }, { type: 'null' }],
                      },
                      alternatives: { type: 'array', required: true, items: { type: 'string' } },
                    },
                  },
                  /** The deployment's readiness, so an absent tool is explicable. */
                  readiness: { type: 'string', required: true },
                  /** Whether the tool is genuinely callable right now. */
                  callable: { type: 'boolean', required: true },
                  /** Why the tool is absent, when it is. */
                  withheld: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      code: { type: 'string', required: true },
                      message: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
            installed: { type: 'integer', required: true },
            runnable: { type: 'integer', required: true },
            /** Set by the mcp action: what this host would export over MCP (MCP-09). */
            mcp: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  hasOutputSchema: { type: 'boolean', required: true },
                  title: {
                    required: true,
                    oneOf: [{ type: 'string' }, { type: 'null' }],
                  },
                },
              },
            },
            /** Set by the receipts action: recent invocation provenance (EXT-35). */
            receipts: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  receiptId: { type: 'string', required: true },
                  contract: { type: 'string', required: true },
                  implementationId: { type: 'string', required: true },
                  extension: { type: 'string', required: true },
                  modelIdentity: { type: 'string', required: true },
                  activationGeneration: { type: 'integer', required: true },
                  executionLocation: { type: 'string', required: true },
                },
              },
            },
            /**
             * Set by the receipts action: external (MCP) call accounting (OBS-02).
             *
             * Sizes, class and engine version — never a payload. Declared here so
             * the output projection admits the wired external half. SEC-04: the
             * entry also names the CLIENT's grant identity, so the operator can tell
             * who called — identity only, still never the payload.
             */
            external: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  receiptId: { type: 'string', required: true },
                  failureClass: { type: 'string', required: true },
                  reason: {
                    required: true,
                    oneOf: [{ type: 'string' }, { type: 'null' }],
                  },
                  totalMs: { type: 'number', required: true },
                  inputBytes: { type: 'integer', required: true },
                  outputBytes: { type: 'integer', required: true },
                  engineVersion: { type: 'string', required: true },
                  /** The CLIENT's grant identity (SEC-04); absent for host-initiated external calls. */
                  grantId: { type: 'string' },
                  clientId: { type: 'string' },
                },
              },
            },
            /**
             * Set by the diagnostics action: the OBS-04 surface.
             *
             * Declared here because DSH refuses an undeclared output property — which is a
             * useful constraint rather than an obstacle: it means a new action cannot quietly
             * return a shape no caller was told about. The declaration is deliberately SHALLOW
             * (`additionalProperties: true`) because the value schema DSL cannot express the
             * nested report faithfully, and a wrong declaration is worse than a permissive one.
             * See the note on unrepresentable keywords for the same reasoning.
             */
            capture: {
              type: 'object',
              additionalProperties: true,
            },
            diagnostics: {
              type: 'object',
              additionalProperties: true,
              // NOT required: only the diagnostics action returns it, and marking it
              // required would demand the property from every other action's result — which
              // is what the type checker refused, correctly.
            },
            /** Set by enable/disable/reset: whether the requested change took effect. */
            changed: { type: 'boolean' },
            /** Set by enable/disable/reset: what the call did to the tool surface. */
            action: { type: 'string' },
            /** Set by enable/disable/reset: whether the choice was written to the durable store. */
            persisted: { type: 'boolean' },
            /** Where choices are stored, so a caller can tell the user what to edit. */
            stateFile: { type: 'string' },
            /**
             * Set by the credentials action when generation was asked for on this
             * surface (SEC-01). It NEVER carries a secret: the model-visible surface
             * refuses generation outright, and this note is how the refusal guidance
             * reaches a caller without any secret ever entering the transcript.
             */
            credentialNote: { type: 'string' },
            /** Set by credentials list: live clients WITHOUT secrets. */
            credentials: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  clientId: { type: 'string', required: true },
                  scheme: { type: 'string', required: true },
                  createdAt: { type: 'string', required: true },
                },
              },
            },
            /** Set by extensions-pending: the staged updates awaiting a decision (EXT-30). */
            pending: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  extensionId: { type: 'string', required: true },
                  stagedVersion: { type: 'string', required: true },
                  currentVersion: { type: 'string', required: true },
                  stagedAt: { type: 'string', required: true },
                  licenseDelta: { type: 'string' },
                  permissionDeltas: { type: 'array', items: { type: 'string' } },
                  requiresApproval: { type: 'boolean', required: true },
                  approval: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      approved: { type: 'boolean', required: true },
                      reason: { type: 'string' },
                    },
                  },
                },
              },
            },
            /** Set by extensions-commit/extensions-rollback: the resulting pointer. */
            updateResult: {
              type: 'object',
              additionalProperties: false,
              properties: {
                extensionId: { type: 'string', required: true },
                activeVersion: { type: 'string', required: true },
                previousVersion: { type: 'string' },
                hookFailure: { type: 'string' },
              },
            },
            /** Set by extensions-prepare-plan: the RES-02 disclosure. */
            plan: {
              type: 'object',
              additionalProperties: false,
              properties: {
                extensionId: { type: 'string', required: true },
                modelId: { type: 'string', required: true },
                modelRevision: { type: 'string', required: true },
                assets: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      assetId: { type: 'string', required: true },
                      bytes: { type: 'number', required: true },
                      source: { type: 'string', required: true },
                      executable: { type: 'boolean', required: true },
                    },
                  },
                },
                totalBytes: { type: 'number', required: true },
                storageBytes: { type: 'number', required: true },
                requiresExecutableApproval: { type: 'boolean', required: true },
                license: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', required: true },
                    url: { type: 'string', required: true },
                  },
                },
              },
            },
            /** Set by extensions-prepare: the acquired groups. */
            prepared: { type: 'boolean' },
            /** Set by extensions-license-basis: the recorded permission basis (LIC-03). */
            licenseBasis: {
              type: 'object',
              additionalProperties: false,
              properties: {
                native: { type: 'boolean' },
                export: { type: 'boolean' },
                distribution: { type: 'boolean' },
                telemetry: { type: 'boolean' },
                principal: { type: 'string' },
                recordedAt: { type: 'string' },
              },
            },
            providerId: { type: 'string' },
            groups: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  groupId: { type: 'string', required: true },
                  path: { type: 'string', required: true },
                  digests: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (value.credentialNote !== undefined) {
            return [{ type: 'text', text: value.credentialNote }]
          }
          if (value.credentials !== undefined) {
            const lines = value.credentials.map(entry => `- ${entry.clientId} (${entry.scheme}, ${entry.createdAt})`)
            return [{ type: 'text', text: `${lines.length} live client credential(s):\n${lines.join('\n')}` }]
          }
          const headline = value.action !== undefined
            ? `${value.action}: ${value.changed === true ? 'done' : 'no change'}`
              + `${value.persisted === true ? ', remembered across restarts' : ''}. `
            : ''
          const lines = value.models.map(model =>
            `- [${model.installed ? 'installed' : model.runnable ? 'ready' : 'unavailable'}] `
            + `${model.id} (\`${model.tool}\`)${model.choice === 'none' ? '' : ` (${model.choice} by you)`}: `
            + `${model.summary}`
            + (model.runnable || model.installed ? '' : `\n  why not: ${model.reason}`),
          )
          return [{
            type: 'text',
            text: `${headline}${value.installed} of ${value.models.length} catalogued models are installed as tools; `
              + `${value.runnable} can run on this machine.\n\n${lines.join('\n')}`,
          }]
        },
      },
      async execute(args, exec) {
        void exec
        const action = args.action
        const modelId = args.model as string | undefined
        const sub = args.sub
        const clientId = args.clientId
        const stagedVersion = args.version

        /** The user's remembered choice for one model. */
        const choiceOf = (id: string): 'none' | 'enabled' | 'disabled' =>
          persisted.enabled.includes(id) ? 'enabled' : persisted.disabled.includes(id) ? 'disabled' : 'none'

        /**
         * The provenance and readiness a discovery surface must expose (EXT-32).
         *
         * ALWAYS returns the full shape, including for a model with no contract
         * binding: the fields are declared required in the output schema, so a
         * partial object would be refused — and a caller reading `readiness` should
         * get an answer for every model rather than having to handle its absence.
         */
        const provenanceOf = async (entry: ModelCatalogEntry) => {
          const surface = await surfaceFor(entry)
          const published = surface?.tools[0]
          const notice = surface?.readiness.find(item => item.modelId === entry.id)
          const withheld = surface === undefined
            ? undefined
            : surface.withheld.find(item => item.subject === published?.name) ?? surface.withheld[0]
          return {
            provenance: {
              contract: entry.contract,
              // Which PACKAGE implements this model, and which model inside it. Read
              // from the catalog binding, so it is reported even for a model that is
              // not the selected provider and therefore has no published tool.
              extension: entry.provider?.extension ?? null,
              modelId: entry.provider?.modelId ?? null,
              publishedTool: published?.name ?? null,
              // Copied into a mutable array: the surface's own list is readonly, and
              // a discovery result is a plain JSON value.
              alternatives: [...(published?.alternatives ?? [])],
            },
            readiness: notice?.readiness ?? 'unknown',
            callable: notice?.callable ?? false,
            ...withheld === undefined ? {} : {
              withheld: { code: withheld.code, message: withheld.message },
            },
          }
        }

        /**
         * The current snapshot, with per-model installed and remembered state.
         *
         * `tool` reports the name actually REGISTERED, not the catalog's per-model
         * name: under a contract two implementations share one tool, and reporting
         * the catalog name would tell a caller to call something that does not exist.
         */
        const snapshot = async (items: ResolvedModel[]) => Promise.all(items.map(async item => {
          const record = installed.get(item.entry.id)
          return {
            ...(describeModels([item])[0] as ModelDescriptor),
            ...record === undefined ? {} : { tool: record.toolName },
            ...await provenanceOf(item.entry),
            installed: record !== undefined,
            choice: choiceOf(item.entry.id),
          }
        }))
        /**
         * The most recent invocation receipts (EXT-35).
         *
         * Exposed through discovery so the provenance is observable rather than
         * merely recorded: a receipt nobody can read is indistinguishable from no
         * receipt at all.
         */
        const receipts = () => invocationReceipts.map(receipt => ({
          receiptId: receipt.receiptId,
          contract: receipt.contract,
          implementationId: receipt.implementationId,
          extension: receipt.extension,
          modelIdentity: receipt.modelIdentity,
          activationGeneration: receipt.activationGeneration,
          executionLocation: receipt.executionLocation,
        }))

        const counts = () => ({
          installed: installed.size,
          runnable: resolved.filter(item => item.verdict.runnable).length,
          ...persist ? { stateFile: config.stateFile ?? defaultStateFile() } : {},
        })

        if (action === 'mcp') {
          return { models: [], ...counts(), mcp: mcpHost.listTools().map(tool => ({
            name: tool.name,
            // Presence of the OUTPUT schema is the MCP-09 fact worth exposing: DSH
            // model-facing projection omits it, so this is the evidence that the
            // export is built from the contract instead.
            hasOutputSchema: tool.outputSchema !== undefined,
            title: tool.title ?? null,
          })) } as never
        }

        if (action === 'diagnostics') {
          /**
           * THE OBS-04 SURFACE, WIRED RATHER THAN MERELY BUILT.
           *
           * `buildDiagnostics` is only worth having if something calls it, and this repository
           * has produced fully-tested components with zero callers three times already
           * (`ptc-authority.ts`, `ptc-runtime.ts`, and the recipes broker). Reporting through
           * the control tool the agent already has keeps the surface reachable without adding a
           * second way in.
           */
          const registered = ctx.tools.schemas().map(schema => schema.name).sort()
          const exported = mcpHost.listTools().map(tool => tool.name).sort()
          const exportedSet = new Set(exported)
          return {
            models: [],
            ...counts(),
            diagnostics: buildDiagnostics({
              mcpMounted: true,
              /**
               * The endpoint is OMITTED rather than set to `undefined`, because the input type
               * is exact-optional. The host serves its own agent and the endpoint is a
               * deployment decision this plugin does not own, so it is reported as ABSENT —
               * which the surface distinguishes from "MCP is off".
               */
              exportedTools: exported,
              // The withheld half is the security-relevant half, and it is derivable: anything
              // registered that is NOT exported was withheld deliberately.
              withheldTools: registered.filter(name => !exportedSet.has(name)),
              platform: {
                os: process.platform,
                arch: process.arch,
                nodeVersion: process.version,
              },
            }),
            /**
             * THE CAPTURE PATH, on the surface an operator actually reads (OBS-03).
             *
             * Reported here rather than in a document because a reader asking "what is recorded"
             * must see the surfaces this plugin does NOT control — a sibling logging plugin and
             * the DSH LLM service — not only its own writes. A list of our own writes would be
             * taken as complete, which is the misreading OBS-03 exists to prevent.
             */
            capture: {
              profile: (config.captureProfile ?? 'standard') as string,
              surfaces: CAPTURE_PATH.map(surface => ({
                surface: surface.surface,
                writtenByThisPlugin: surface.writtenByThisPlugin,
                control: surface.control,
              })),
            },
          } as never
        }

        if (action === 'credentials') {
          /**
           * SEC-01 CREDENTIAL SURFACE, model-visible and therefore SECRET-FREE.
           *
           * `model_tools` is the operator's management surface. It was never
           * published over MCP, but it IS model-visible: a generated secret
           * returned here would land in the model's transcript. Generation is
           * therefore REFUSED on this surface with guidance to the human-only
           * CLI, which prints the secret exactly once to the operator's
           * terminal. The generation primitive itself lives in
           * credential-store.ts (`generateCredential`) for the CLI and tests.
           */
          if (credentialStore === undefined) {
            throw new Error(
              'credential generation requires persistence (SEC-01): this deployment runs with persistence disabled, '
              + 'and a credential a restart would forget must never be issued',
            )
          }
          if (sub === 'generate') {
            return {
              models: [],
              ...counts(),
              credentialNote:
                'Credential generation is refused on this model-visible surface (SEC-01): a generated secret must '
                + 'never enter a model transcript. Run the human-only CLI instead — `dsh-tool-mode-credentials '
                + 'generate --scheme static-token --client-id <id>` (or --scheme oauth-resource-server) — which '
                + 'prints the secret exactly once to the operator\'s terminal and persists it owner-only.',
            } as never
          }
          if (sub === 'list') {
            return {
              models: [],
              ...counts(),
              // SECRETS ARE NEVER RE-ECHOED: the list carries identity only.
              credentials: credentialStore.list().map(entry => ({
                clientId: entry.clientId,
                scheme: entry.scheme,
                createdAt: entry.createdAt,
              })),
            } as never
          }
          if (sub === 'revoke') {
            if (typeof clientId !== 'string' || clientId.length === 0) {
              throw new Error('credentials revoke requires a clientId')
            }
            const existed = credentialStore.get(clientId) !== undefined
            credentialStore.delete(clientId)
            return {
              models: [],
              ...counts(),
              changed: existed,
              action: `credentials revoke ${clientId}`,
              persisted: existed,
            } as never
          }
          throw new Error('credentials requires a sub: generate, list or revoke')
        }

        if (action === 'receipts') {
          return {
            models: [],
            ...counts(),
            receipts: receipts(),
            external: externalAccountings.map(accounting => ({
              receiptId: accounting.receiptId,
              failureClass: accounting.failureClass,
              reason: accounting.reason,
              totalMs: accounting.timings.totalMs,
              inputBytes: accounting.sizes.inputBytes,
              outputBytes: accounting.sizes.outputBytes,
              engineVersion: accounting.measuredOn.engineVersion,
              // SEC-04: the CLIENT's own identity, so the operator can tell who
              // called — identity only, never the payload.
              ...accounting.grantId === undefined ? {} : { grantId: accounting.grantId },
              ...accounting.clientId === undefined ? {} : { clientId: accounting.clientId },
            })),
          } as never
        }

        if (action === 'reset') {
          // Forgetting a choice is what makes the config authoritative again.
          if (modelId !== undefined) {
            if (!byId.has(modelId)) throw new Error(`unknown model "${modelId}"`)
            persisted = {
              enabled: persisted.enabled.filter(id => id !== modelId),
              disabled: persisted.disabled.filter(id => id !== modelId),
            }
          } else {
            persisted = { enabled: [], disabled: [] }
          }
          if (persist) stateStore.write(persisted)
          // Re-apply the config's own selection, so a reset takes effect now
          // rather than only at the next start.
          for (const item of resolved) {
            if (configuredIds.includes(item.entry.id)) await install(item)
            else uninstall(item.entry.id)
          }
          const models = modelId === undefined ? resolved : [byId.get(modelId) as ResolvedModel]
          return {
            models: await snapshot(models),
            ...counts(),
            changed: true,
            action,
            persisted: persist,
          }
        }

        if (action === 'describe' || action === 'enable' || action === 'disable') {
          if (modelId === undefined) throw new Error(`${action} requires a "model" id`)
          const item = byId.get(modelId)
          if (item === undefined) throw new Error(`unknown model "${modelId}"`)
          if (action === 'describe') {
            return { models: await snapshot([item]), ...counts() }
          }
          const changed = action === 'enable' ? await install(item) : uninstall(modelId)
          if (action === 'enable' && !changed) {
            // Say why rather than reporting a silent no-op: the caller asked for
            // a tool and did not get one.
            throw new Error(
              `${item.entry.name} cannot be installed here. ${item.verdict.reason}`,
            )
          }
          // Only remember a choice that actually took effect: persisting a
          // failed enable would install it silently on the next start.
          const remembered = remember(modelId, action === 'enable')
          return {
            models: await snapshot([item]),
            ...counts(),
            changed,
            action,
            persisted: remembered,
          }
        }

        /**
         * LIC-03: the human permission-basis recording surface. The basis
         * (native use, external export, distribution, telemetry) is recorded
         * per provider with the approving principal, durably, in the isolated
         * state dir. It is a RECORD — the export eligibility itself stays on
         * the existing publication gate (the operator's exportTools
         * selection); the basis is what a reviewer reads before flipping it.
         */
        if ((action as string) === 'extensions-license-basis') {
          if (modelId === undefined) throw new Error('extensions-license-basis requires the provider id in "model"')
          const basis = args.licenseBasis as { native?: boolean; export?: boolean; distribution?: boolean; telemetry?: boolean } | undefined
          const principal = typeof args.principal === 'string' && args.principal.length > 0 ? args.principal : 'unattributed'
          if (basis === undefined) throw new Error('extensions-license-basis requires the "licenseBasis" fields')
          const basisPath = join(dirname(resolve(config.stateFile ?? defaultStateFile())), 'license-bases.json')
          let bases: Record<string, unknown> = {}
          try {
            bases = JSON.parse(readFileSync(basisPath, 'utf8')) as Record<string, unknown>
          } catch {
            // No record yet: the first basis starts the file.
          }
          const record = {
            native: basis.native === true,
            export: basis.export === true,
            distribution: basis.distribution === true,
            telemetry: basis.telemetry === true,
            principal,
            recordedAt: new Date().toISOString(),
          }
          bases[modelId] = record
          mkdirSync(dirname(basisPath), { recursive: true })
          writeFileSync(basisPath, `${JSON.stringify(bases, null, 2)}\n`)
          return {
            models: [],
            ...counts(),
            action,
            changed: true,
            licenseBasis: record,
            providerId: modelId,
          } as never
        }

        if (action === 'extensions-pending' || action === 'extensions-approve' || action === 'extensions-deny'
          || action === 'extensions-commit' || action === 'extensions-rollback') {
          /**
           * EXT-30 slice 3: the MANAGEMENT channel is the ONLY update path (AT-39)
           * — these actions live inside model_tools, never on the model-callable
           * MCP surface. The surface is wired when the extension store exists.
           */
          const surface = updateSurface
          if (surface === undefined) {
            throw new Error('extension updates require the extension store (config.extensionStoreDir); it is not configured')
          }
          if (action === 'extensions-pending') {
            return {
              models: [],
              ...counts(),
              pending: surface.listPendingUpdates().map(entry => ({
                extensionId: entry.extensionId,
                stagedVersion: entry.stagedVersion,
                currentVersion: entry.currentVersion,
                stagedAt: entry.stagedAt,
                ...entry.report.licenseDelta === undefined ? {} : { licenseDelta: entry.report.licenseDelta },
                permissionDeltas: entry.report.permissionDeltas,
                requiresApproval: entry.report.requiresApproval,
                ...entry.approval === undefined ? {} : { approval: entry.approval },
              })),
            } as never
          }
          if (modelId === undefined) throw new Error(`${action} requires the extension id in "model"`)
          if (stagedVersion === undefined && action !== 'extensions-rollback') {
            throw new Error(`${action} requires a "version"`)
          }
          const version = stagedVersion as string // narrowed by the guard above for every action but rollback
          if (action === 'extensions-approve' || action === 'extensions-deny') {
            surface.decide(modelId, version, action === 'extensions-approve'
              ? { approved: true }
              : { approved: false, reason: 'denied through the management channel' })
            return {
              models: [],
              ...counts(),
              action,
              changed: true,
            } as never
          }
          const result = action === 'extensions-commit'
            ? await surface.commit(modelId, version)
            : await surface.rollback(modelId)
          // P26-09/MCP-07: a committed pointer or a rollback both REPUBLISH the
          // extension surface through the lifecycle — the catalog changed, and
          // every subscriber is notified.
          notifyCatalogChange()
          // The lossless-JSON contract: undefined fields are omitted, never present.
          return {
            models: [],
            ...counts(),
            action,
            updateResult: {
              extensionId: result.extensionId,
              activeVersion: result.activeVersion,
              ...result.previousVersion === undefined ? {} : { previousVersion: result.previousVersion },
              ...'hookFailure' in result && result.hookFailure !== undefined ? { hookFailure: result.hookFailure } : {},
            },
          } as never
        }

        if (action === 'extensions-prepare-plan' || action === 'extensions-prepare') {
          /**
           * RES-02: the preparation plan is DISCLOSED (bytes, storage, license,
           * executable gate) before the acquisition; the acquisition itself IS
           * the operator's consent, through the management channel only. A REAL
           * acquisition uses the ranged HTTP source (opt-in); the suite injects
           * a local source and never reaches the network.
           */
          const surface = prepareAssetsSurface
          if (surface === undefined) {
            throw new Error('asset preparation requires the extension store (config.extensionStoreDir); it is not configured')
          }
          if (modelId === undefined) throw new Error(`${action} requires the extension id in "model"`)
          if (action === 'extensions-prepare-plan') {
            const plan = surface.plan(modelId)
            return {
              models: [],
              ...counts(),
              action,
              plan: {
                extensionId: plan.identity.extensionId,
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
                license: plan.license,
              },
            } as never
          }
          const outcome = await surface.prepare(modelId, {
            source: config.assetSourceFactory?.() ?? createHttpSource(),
            allowExecutable: args.allowExecutable === true,
            signal: exec?.signal ?? new AbortController().signal,
          })
          if (!outcome.ok) throw new Error(`the preparation failed: ${outcome.reason}`)
          return {
            models: [],
            ...counts(),
            action,
            prepared: true,
            groups: outcome.groups.map(group => ({ groupId: group.groupId, path: group.path, digests: group.digests })),
          } as never
        }

        const models = action === 'installed'
          ? await snapshot(resolved.filter(item => installed.has(item.entry.id)))
          : await snapshot(resolved)
        return { models, ...counts() }
      },
      presentCall(args) {
        return { card: 'generic', title: `Model tools: ${args.action}`, kind: 'read', rawInput: args.model ?? args.action }
      },
    }))

    /**
     * DECL-07: the read-only discovery pair under the SPEC NAMES. Ordinary
     * tool-only clients get the permitted tools + readiness (list) and the
     * selected schemas/limits/locations (describe) without relying on skills
     * or server instructions. The existing model_tools actions stay as the
     * management aliases; these two are READ-ONLY and never mutate.
     */
    const catalogRevision = () => String(extensionLifecycle?.generation ?? host.activationGeneration)
    const describeOne = async (name: string) => {
      const registrySchema = ctx.tools.schemas().find(schema => schema.name === name)
      const modelItem = resolved.find(item => (installed.get(item.entry.id)?.toolName ?? item.entry.tool ?? '') === name)
      const descriptor = modelItem === undefined ? undefined : describeModels([modelItem])[0]
      const owner = undefined
      return {
        name,
        description: registrySchema?.description ?? descriptor?.summary ?? '',
        parameters: registrySchema?.parameters ?? {},
        ...descriptor === undefined ? {} : {
          model: {
            id: descriptor.id,
            capability: descriptor.capability,
            runnable: descriptor.runnable,
            reason: descriptor.reason,
            route: descriptor.route,
          },
        },
        ...owner === undefined ? {} : { ownerExtension: owner },
        executionLocation: 'device',
        catalogRevision: catalogRevision(),
      }
    }
    ctx.tools.register(defineTool({
      name: 'tool_mode_list',
      description:
        'List the tools this caller is permitted to use, with readiness summaries and the current catalog '
        + 'revision. Read-only discovery (DECL-07): it never installs, prepares, activates or changes anything.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            catalogRevision: { type: 'string' },
            tools: { type: 'array' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute() {
        const tools = []
        for (const item of resolved) {
          const record = installed.get(item.entry.id)
          const descriptor = describeModels([item])[0]!
          tools.push({
            name: record?.toolName ?? item.entry.tool ?? item.entry.id,
            description: descriptor.summary,
            readiness: item.verdict.runnable ? 'callable' : `unavailable: ${descriptor.reason}`,
            model: item.entry.id,
          })
        }
        return { catalogRevision: catalogRevision(), tools } as never
      },
      presentCall() {
        return { card: 'generic', title: 'Tool mode list', kind: 'read', rawInput: '' }
      },
    }))
    ctx.tools.register(defineTool({
      name: 'tool_mode_describe',
      description:
        'Describe one or more tools by name: the selected input/output schemas, the resolved model, limits and '
        + 'the catalog revision. Read-only discovery (DECL-07): it never installs, prepares, activates or changes anything.',
      parameters: {
        tools: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: 'The tool names to describe.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            catalogRevision: { type: 'string' },
            tools: { type: 'array' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const names = args.tools as string[]
        const entries = []
        for (const name of names) {
          const described = await describeOne(name)
          // describeOne returns an EMPTY description + empty parameters + no
          // model for an unknown name; a real tool always has at least one.
          if (described.description.length === 0
            && Object.keys(described.parameters).length === 0
            && described.model === undefined) {
            throw new Error(`unknown tool ${JSON.stringify(name)}`)
          }
          entries.push(described)
        }
        return { catalogRevision: catalogRevision(), tools: entries } as never
      },
      presentCall(args) {
        return { card: 'generic', title: 'Tool mode describe', kind: 'read', rawInput: String((args.tools as string[] | undefined)?.join(',') ?? '') }
      },
    }))
  }

  // The registry disposes each registration with the plugin fiber, but doing it
  // explicitly keeps model resources (a loaded ONNX session, a cached weight
  // file) bounded by the plugin's own lifetime rather than the process's.
  ctx.effect(() => () => {
    for (const record of installed.values()) {
      record.disposeSkill?.()
      record.disposeAlias?.()
      record.dispose()
    }
    installed.clear()
    void bridge.dispose('shutdown')
  }, 'model-tools teardown')

  /**
   * THE AUTHORIZED PROGRAM PIPELINE, wired so its controls have a CALLER (CODE-02/03/08).
   *
   * Adversarial review found `ptc-authority.ts` and `ptc-runtime.ts` with zero callers
   * outside tests: every control in them was correct, thoroughly covered, and never ran.
   * `tool_mode_run` did not exist, so the mount guard never executed and the exposure gate
   * guarded nothing — there was no caller to refuse. A control with no callers is a symbol.
   *
   * The runner reaches tools through `buildToolBindings`, the SAME pipeline an external
   * surface would use, so authorization cannot differ between the two doors.
   *
   * SEC-04 COMPOSITION: the grant is read PER RUN from {@link externalGrantContext}. An
   * external client's call runs inside that context (set by the surface's execute), so a
   * program the client composes authorizes its sub-calls against the CLIENT's grant —
   * a client granted only `tool_mode_run` cannot reach host-granted tools through a
   * program. The native/interactive path carries no context and keeps the host's grant.
   */
  const externalGrantContext = createExternalGrantContext()
  const programRunner = createProgramRunner({
    context: ctx as never,
    /**
     * Resolved lazily and may be ABSENT: a deployment without the Node PTC backend still
     * runs every other tool, and failing the plugin load because an optional capability is
     * missing would remove working functionality. `prepare()` reports the absence.
     */
    backend: async () => {
      try {
        // The backend is an optional deployment fact, imported only when a run needs it
        // (EXT-19: no heavyweight load at plugin startup). The dynamic import keeps it
        // out of the module graph for hosts that never run programs.
        const module = await import('@deepseek-ai/dsh-ptc-runtime-node') as {
          default?: unknown
          NodePtcRuntime?: unknown
        }
        return module.NodePtcRuntime ?? module.default
      } catch (error) {
        ctx.logger.warn(
          `model-tools: the Node PTC backend is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        )
        return undefined
      }
    },
    /**
     * THE GRANT A PROGRAM'S SUB-CALLS AUTHORIZE AGAINST, read per run:
     * the external caller's own grant when the run happens inside an external call,
     * the host's own grant otherwise. Never a caller's claim about what it may use.
     */
    grant: () => externalGrantContext.current() ?? grant.allowedTools,
    // Read at RUN time, not once: extension restore registers tools after this closure
    // is created, and a program must see the live registry, not a stale snapshot.
    visible: () => ctx.tools.schemas().map(schema => schema.name),
    resolve: name => async (args: Record<string, unknown>) => {
      // A binding dispatches through the SAME registry pipeline a native call uses
      // (ARCH-01), so a program cannot reach a tool the registry would refuse.
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: `ptc_${name}_${Date.now().toString(36)}` as never,
        name,
        arguments: args,
      })
      if (result.isError) throw new Error(result.error?.message ?? `${name} failed`)
      return result.value
    },
    runtime: () => ctx.get(PTC_SERVICE) as unknown as {
      resolve(request: Record<string, unknown>): unknown
      run(spec: unknown): Promise<{ value?: unknown; logs?: readonly string[]; error?: { kind?: string; message?: string } }>
    } | undefined,
    // CODE-10: the operator's separate consent for hosted code execution, read
    // at check time so a config change mid-session takes effect.
    operatorGranted: () => config.hostedCode === true,
  })

  if (config.registerControlTool ?? true) {
    ctx.tools.register(defineTool({
      name: 'tool_mode_run',
      description:
        'Run a program that calls Tool Mode tools (CODE-02). The requested `tools` list is '
        + 'a binding subset, not a grant: only names the host itself has granted are bound, '
        + 'and the whole request is refused when any name is unattainable.',
      parameters: {
        description: { type: 'string', required: true, description: 'What the program does.' },
        code: { type: 'string', required: true, description: 'Body of an async TypeScript function.' },
        input: { type: 'json', description: 'Program data, bound structurally — never interpolated into source.' },
        tools: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: 'The tool names the program will call.',
        },
        timeout_ms: { type: 'integer', description: 'A requested deadline; clamped to host policy.' },
      } as unknown as ParameterSchemaSpec,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            result: { type: 'json' },
            logs: { type: 'array', items: { type: 'string' } },
            meta: {
              type: 'object',
              additionalProperties: false,
              properties: {
                receiptId: { type: 'string', required: true },
                elapsedMs: { type: 'integer', required: true },
                toolCalls: { type: 'integer', required: true },
                catalogRevision: { type: 'string', required: true },
                warnings: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        } as unknown as ValueSchemaSpec,
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        /**
         * THE GATE, ENFORCED — the caller `mayExposeToClients()` never had, so the refusal
         * is now REACHABLE rather than a boolean nothing consults. This tool is only
         * served to callers when the confinement tests have passed; the in-process
         * pipeline below is the same one the external surface would use.
         */
        const refusal = externalRefusal(programRunner)
        if (refusal !== undefined) throw new Error(refusal.message)
        // The catalog revision is the LIVE extension-lifecycle generation when the
        // lifecycle is mounted (CODE-05 needs a revision that changes), falling
        // back to the host activation generation otherwise.
        const revision = String(extensionLifecycle?.generation ?? host.activationGeneration)
        const receiptId = host.nextReceiptId()
        const report = await serveProgram(args as Record<string, unknown>, programRunner, {
          receiptId,
          catalogRevision: revision,
        })
        // The program run's receipt is RECORDED like a contract invocation's, so
        // the receipts action can answer for it (EXT-35 symmetry the review named).
        host.recordReceipt?.(buildInvocationReceipt({
          receiptId,
          contract: 'tool_mode_run',
          contractVersion: HOST_VERSION,
          implementationId: 'hosted-composition',
          extension: host.extension,
          extensionVersion: host.extensionVersion,
          activationGeneration: Number(revision),
          executionLocation: 'host',
          modelIdentity: 'none',
        }))
        return report as never
      },
    }))
  }

  /**
   * Mount the EXTENSION LIFECYCLE, which is what lets an extension's tools reach the
   * registry at all.
   *
   * This was MISSING: the SDK could install, activate and publish contributions and was
   * fully tested doing so, but the host never mounted the lifecycle — so an extension
   * could report `observedActivation: 'active'` with its tool listed and a caller still
   * could not invoke it. The registrar is the other half of that bridge.
   *
   * Opt-in through `extensionStore`, so a deployment with no extensions behaves exactly
   * as before. RUN-05 governs what happens here: startup RESTORES extensions the operator
   * already approved and reads their declarations. It performs NO model preparation and
   * NO package resolution, so nothing downloads because a plugin loaded.
   */
  const extensionStoreDir = config.extensionStore ?? ''
  if (extensionStoreDir.length > 0) {
    const store = new ExtensionStore(extensionStoreDir)

    /**
     * How dispatch reaches an ACTIVATED extension.
     *
     * The module is imported and the instance created ONCE per extension and cached,
     * because `create()` is documented as lightweight and repeating it per call would
     * re-run an extension's activation on every invocation. PROVIDERS are created per call
     * inside `createDispatch`, so a deactivated extension is never served from a stale
     * provider handle.
     */
    const extensionInstances = new Map<string, Promise<{ createProvider(request: { modelId: string; configuration: Readonly<Record<string, unknown>> }): Promise<unknown> }>>()
    /** Per-instance storage. See the note on storage below. */
    const memoryStorage = new Map<string, JsonValue>()

    /**
     * The host-issued context an extension receives.
     *
     * It carries NO DSH context, no registry access, no global credentials and no
     * unfiltered environment (ARCH-06) — an extension gets identity, private storage, a
     * bounded logger and a teardown signal, and nothing else.
     */
    function contextForExtension(extensionId: string): ExtensionContextV1 {
      const installed = store.listInstalled().value.find(record => record.extensionId === extensionId)
      return {
        extensionId,
        extensionVersion: installed?.version ?? '0.0.0',
        activationGeneration: 1,
        /**
         * Storage is an IN-MEMORY map for the life of this instance, and that is stated
         * rather than implied: a full private on-disk store is separate work, and a stub
         * that LOOKS persistent while losing everything on restart would be worse than one
         * that visibly does not persist.
         */
        storage: {
          // The declared private directory, so an extension that writes files has a place
          // the HOST chose rather than one the extension invented for itself.
          directory: join(store.rootDir, 'extension-private', extensionId),
          async read(key: string) { return memoryStorage.get(`${extensionId}:${key}`) },
          async write(key: string, value: JsonValue) {
            memoryStorage.set(`${extensionId}:${key}`, value)
          },
        },
        logger: {
          log: (level, message) => {
            if (level === 'error') ctx.logger.error(`[${extensionId}] ${message}`)
            else if (level === 'warn') ctx.logger.warn(`[${extensionId}] ${message}`)
            else ctx.logger.info(`[${extensionId}] ${message}`)
          },
        },
        signal: new AbortController().signal,
        configuration: {},
      }
    }
    function environmentFor(extensionId: string): DispatchEnvironment {
      /**
       * The installed package ROOT for an extension, from the store.
       *
       * Deliberately NOT named installPathFor: the SDK exports a function of that name
       * which returns the path SEGMENT a package occupies, not a resolved store lookup. Two
       * different meanings under one name is how a caller ends up with the wrong one.
       */
      const installedRootFor = (id: string): string => {
        const installed = store.listInstalled().value.find(record => record.extensionId === id)
        if (installed === undefined) {
          throw new Error(`${id} is not installed, so its recipes cannot be resolved`)
        }
        return installed.installPath
      }
      const discoveryFor = () => {
        const installed = store.listInstalled().value.find(record => record.extensionId === extensionId)
        if (installed === undefined) {
          throw new Error(`${extensionId} is not installed, so its tools cannot be dispatched`)
        }
        return discoverExtension(installed.installPath)
      }
      return {
        getManifest: () => discoveryFor().manifest as unknown as DispatchManifest,
        /**
         * The host-verified prepared-asset map for THIS extension, built by the
         * extensions-prepare flow; undefined (the empty map) until then.
         */
        assetsFor: () => prepareAssetsSurface?.assetMapFor(extensionId),
        async providerFor(modelId) {
          const discovery = discoveryFor()
          /**
           * A DECLARATIVE PACKAGE HAS NO MODULE, so it never reaches the import path.
           *
           * This branch did not exist, and its absence is why `PTCAuthority`-style
           * disconnection went unnoticed here for so long: a declarative manifest was
           * schema-valid, its recipe convention was implemented, and its broker had 132
           * passing tests — and NOTHING joined them, because this function assumed every
           * package could be imported. Resolving an entry for a no-code package fails with
           * "the package declares no importable ./tool-mode export", which is true and
           * useless: the package was never supposed to declare one.
           *
           * Recipes are resolved through the published convention instead, and a package
           * whose recipes do not resolve is refused BY NAME rather than by import failure.
           */
          const kind = (discovery.manifest as unknown as { execution?: { kind?: string } })
            .execution?.kind
          if (kind === 'declarative') {
            const resolved = resolveDeclarativeImplementations(
              installedRootFor(extensionId),
              (discovery.manifest as unknown as {
                implementations: readonly { id: string; contractId: string; recipeVersion: string }[]
              }).implementations ?? [],
            )
            if (!resolved.ok) {
              throw new Error(
                `${extensionId} is declarative but its recipe could not be resolved: `
                + `${resolved.id} — ${resolved.detail}`,
              )
            }
            /**
             * The recipes RESOLVE, and execution is refused honestly rather than faked.
             *
             * THIS MESSAGE WAS CORRECTED, and the correction matters. It used to say "the link
             * from the host to @try-works/tool-mode-recipes is not wired" — which was true when
             * written and is NO LONGER: `scripts/link-dsh.mjs` listed only four of eight
             * workspace packages, so the broker could not be imported by anything, and
             * completing that map made the bare specifier resolve. Leaving the old text would
             * have pointed the next reader at a link that now exists.
             *
             * What is genuinely missing is narrower, and it is a COMPOSITION rather than a
             * connection: a declarative package's behaviour is executed by a harness broker
             * fed by an `LlmProvider`, and this deployment supplies none. The recipes are real,
             * the broker is importable, and nothing can call a model.
             */
            /**
             * SERVED WHEN THE DEPLOYMENT SUPPLIES A PROVIDER, refused when it does not.
             *
             * The joining lives in `prepareDeclarative` so the host holds no model-specific code:
             * this branch hands over the deployment's provider and a journal sink, and receives
             * callable tools or an honest refusal. The journal is required by the BROKER itself,
             * which will not construct one that reports nothing (HLM-09).
             */
            const served = prepareDeclarative({
              ...harnessProvider === undefined ? {} : { provider: harnessProvider },
              journal: record => ctx.logger?.debug?.('harness invocation', record as never),
            }, resolved.resolved)

            if (!served.ok) {
              throw new Error(
                `${extensionId} is declarative and its ${resolved.resolved.length} recipe(s) resolved, `
                + `but they cannot be served: ${served.detail}`,
              )
            }
            /**
             * THE DISPATCH PROVIDER SHAPE, and the previous version of this branch did not have it.
             *
             * It returned `{ async createProvider() { return { async invoke() {} } } }` — an
             * INSTANCE, where `createDispatch` requires a `DispatchProvider`. Adversarial review
             * reproduced the consequence exactly: `dispatch.ok = true` and then
             * `TypeError: provider.load is not a function`. The module branch below has the right
             * shape and this one did not, so the two differed in a way no test could see because
             * `harnessProvider` appeared in no test at all.
             *
             * The contract is:
             *   load({ assets, signal })                        -> Promise<void>
             *   invoke({ implementationId, input, context })    -> Promise<Record<string, unknown>>
             *
             * AND `implementationId` IS USED. The previous version called `served.served[0]`
             * unconditionally, so the SECOND recipe of a two-recipe package could never be served
             * — it would silently answer with the first one's output. A package declaring two
             * implementations is the normal case, not an edge case.
             */
            return {
              async load() {
                // Recipes are already parsed, validated and authorized by `prepareDeclarative`.
                // There is no module to import and no asset to fetch, so loading is complete.
              },
              async invoke(request: {
                readonly implementationId: string
                readonly input: Readonly<Record<string, unknown>>
              }): Promise<Record<string, unknown>> {
                const recipe = served.served.find(entry => entry.implementationId === request.implementationId)
                // An unknown id is REFUSED rather than defaulted to the first recipe, which is the
                // silent-wrong-answer failure the previous version would have produced.
                if (recipe === undefined) {
                  throw new Error(
                    `${extensionId} declares no implementation ${JSON.stringify(request.implementationId)}`
                    + `; it serves: ${served.served.map(entry => entry.implementationId).join(', ')}`,
                  )
                }
                const text = await recipe.invoke(request.input)
                // The dispatch contract returns a RECORD, not a bare value.
                return { text } as Record<string, unknown>
              },
            } as never
          }

          /**
           * EXT-20, THE MANAGED HALF: when the deployment opted in, the extension's
           * module entry runs OUT OF PROCESS — one scrubbed-environment worker per
           * extension per activation generation, disposed when the generation advances.
           *
           * The GRANT and the schemas stay host-side: this branch only runs after the
           * caller passed authorization and the input passed the declared schema, and
           * the returned value is validated by the same output-schema path as the
           * in-process result. The worker receives exactly `{implementationId, input}`.
           */
          if (managedWorkers) {
            const entry = resolveExtensionEntry(discovery)
            const generation = activationGenerations.get(extensionId)
              ?? extensionLifecycle?.generation
              ?? host.activationGeneration
            return await workerRegistry.providerFor({
              extensionId,
              entryPath: entry,
              generation,
              envPassthrough: workerEnvPassthrough,
            })
          }

          let pending = extensionInstances.get(extensionId)
          if (pending === undefined) {
            pending = (async () => {
              const module = await loadExtensionModule(resolveExtensionEntry(discovery))
              return module.create(contextForExtension(extensionId)) as never
            })()
            extensionInstances.set(extensionId, pending)
          }
          const instance = await pending
          return instance.createProvider({ modelId, configuration: {} }) as never
        },
        // The manifest is resolved per call: a deactivated+reactivated extension's
        // discovery must be fresh, not a startup snapshot.
        contextFor: (implementationId, signal) => ({ implementationId, signal }),
      }
    }

    /**
     * Stamp the reserved root `meta` envelope on an extension tool result (EXT-17, DECL-03).
     *
     * An extension's shipped output schema may REQUIRE `meta` — the Needle planning and
     * extraction contracts do, because the schema declares the field the HOST authors and
     * the provider must not (EXT-17 reserves it, `assertNoReservedMeta` rejects a provider
     * attempt). Without this stamp the host's own output validation would refuse every
     * successful call for such a tool. The stamp is only applied when the declared schema
     * requires it, so a tool whose schema has no envelope keeps returning exactly what its
     * provider produced.
     *
     * The receipt is recorded with the same envelope (EXT-35 symmetry with the
     * `tool_mode_run` path): a caller that wants provenance for a planning call can ask the
     * receipts action, and a receipt never appears only in the result object.
     * @param ownerExtension - the extension the tool belongs to.
     * @param toolName - the caller-facing name.
     * @param value - the provider's result.
     * @param warnings - non-fatal notes already free of caller content.
     * @returns the result with the host-authored `meta`.
     */
    const stampResultMeta = (
      ownerExtension: string,
      toolName: string,
      value: Record<string, unknown>,
      warnings: readonly string[] = [],
    ): Record<string, unknown> => {
      const resolved = resolveImplementation(environmentFor(ownerExtension).getManifest(), toolName)
      if (!resolved.ok) throw new Error(describeDispatchFailure(resolved.failure))
      const installed = store.listInstalled().value.find(candidate => candidate.extensionId === ownerExtension)
      const receiptId = host.nextReceiptId()
      const activationGeneration = extensionLifecycle?.generation ?? host.activationGeneration
      const meta = {
        contract: resolved.tool.contractId,
        contractVersion: resolved.tool.contractVersion,
        implementationId: resolved.implementation.id,
        extension: ownerExtension,
        extensionVersion: installed?.version ?? '0.0.0',
        activationGeneration,
        executionLocation: 'device' as const,
        receiptId,
        warnings: [...warnings],
      }
      host.recordReceipt?.(buildInvocationReceipt({
        receiptId,
        contract: resolved.tool.contractId,
        contractVersion: resolved.tool.contractVersion,
        implementationId: resolved.implementation.id,
        extension: ownerExtension,
        extensionVersion: meta.extensionVersion,
        modelIdentity: resolved.implementation.modelId,
        activationGeneration,
        executionLocation: meta.executionLocation,
        warnings,
      }))
      return { ...value, meta }
    }

    /**
     * Read the schemas an extension's manifest declares for one contributed tool.
     *
     * Bounded and confined: the manifest validator already proved the referenced files
     * exist inside the package, and the byte cap keeps a hostile package from making
     * registration read an unbounded file. A DECLARED schema the host cannot read or
     * compile REFUSES the tool (P26-13): publishing it unenforced would advertise
     * constraints that are enforced nowhere. The throw reaches the lifecycle, whose
     * narrow rollback withdraws only this extension's handles and quarantines it with
     * the reason named, so other extensions are untouched.
     * @param tool - the contributed tool whose schemas are wanted.
     * @returns the declared input/output schemas and description.
     */
    const readDeclaredToolSchemas = (tool: RegistrableTool): {
      inputSchema?: Readonly<Record<string, unknown>>
      outputSchema?: Readonly<Record<string, unknown>>
      description?: string
    } => {
      const record = store.listInstalled().value.find(candidate => candidate.extensionId === tool.ownerExtension)
      if (record === undefined) return {}
      let discovery: ReturnType<typeof discoverExtension>
      try {
        discovery = discoverExtension(record.installPath)
      } catch {
        return {}
      }
      const declared = discovery.manifest.tools.find(candidate => candidate.name === tool.name)
      if (declared === undefined) return {}
      const readSchema = (relative: string): Readonly<Record<string, unknown>> => {
        // A MANIFEST-DECLARED schema the host cannot read or compile is a broken
        // package, and the tool is REFUSED rather than published with the declared
        // constraints enforced nowhere (P26-13: reject unsupported constraints, do
        // not silently strip them). The throw reaches the lifecycle, whose narrow
        // rollback withdraws this extension's published handles and quarantines it
        // with the reason named.
        try {
          const path = join(record.installPath, relative)
          const size = statSync(path).size
          if (size > MAX_SCHEMA_BYTES) {
            throw new Error(`the declared schema is ${size} bytes, over the ${MAX_SCHEMA_BYTES} cap`)
          }
          const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('the declared schema is not a JSON object')
          }
          return parsed as Readonly<Record<string, unknown>>
        } catch (error) {
          throw new Error(
            `${tool.name} declares ${relative} which cannot be enforced: `
            + `${error instanceof Error ? error.message : String(error)}. `
            + 'Fix or replace the package; the tool is not published.',
          )
        }
      }
      const inputSchema = readSchema(declared.inputSchema)
      const outputSchema = readSchema(declared.outputSchema)
      return {
        ...inputSchema === undefined ? {} : { inputSchema },
        ...outputSchema === undefined ? {} : { outputSchema },
        description: declared.description,
      }
    }
    /**
     * The host's own name → owning-extension map for CONTRIBUTED tools.
     *
     * The registry's `schemas()` projection exposes names only, so the planning re-check
     * (NDL-03) cannot ask `lifecycle.admits(extensionId, toolName)` without knowing WHICH
     * extension owns a proposed tool. This map is that knowledge, maintained at the same
     * boundary that publishes and withdraws the tool — a tool present here but not
     * admitted is deactivated or quarantined, which is exactly the state a fresh policy
     * check must refuse.
     */
    const extensionToolOwners = new Map<string, string>()
    const registrar = createContributionRegistrar({
      activated: new Set(
        store.readProfileState('default').value
          .filter(entry => entry.desiredActivation === 'active')
          .map(entry => entry.extensionId),
      ),
      registry: {
        registerTool: tool => {
          /**
           * The tool is registered through the SAME DSH registry a native tool uses, so an
           * extension contribution is subject to the same pipeline rather than a parallel
           * one (ARCH-05).
           *
           * Its `execute` walks the REAL chain: the TMX runtime API has no
           * tool-invocation surface, so a tool is a name whose contract binds to an
           * implementation, and the implementation is a model provider. The provider is
           * created on first CALL, keeping activation lightweight (EXT-19).
           */
          // The manifest the contribution came from declares the tool's REAL schemas;
          // reading them here closes the exact-schema gap an empty `parameters: {}`
          // and open output would leave. Files are bounded and the manifest already
          // validated they exist inside the package.
          const declared = readDeclaredToolSchemas(tool)

          /**
           * THE PLANNING CONTRACT IS RECOGNIZED BY NAME PLUS SHAPE (NDL-02).
           *
           * `tools_plan` is the spec's normative caller-facing name for the read-only
           * proposal tool, so any contribution using the name is served through the
           * planning pipeline — the frozen host snapshot supplies the tool list, never
           * the caller's input. A contribution that takes the name WITHOUT the planning
           * input shape (a declared `tools` array) is refused outright: serving it as an
           * ordinary tool would put a non-planner behind the planner's name, and serving
           * it through the planning pipeline would fail in ways nobody could see.
           */
          const isPlanning = tool.name === PLANNING_TOOL_NAME
          if (isPlanning && !hasPlanningInputShape(declared.inputSchema)) {
            throw new Error(
              'tools_plan is the reserved planning contract (NDL-02): a contribution using the name '
              + 'must declare the planning input shape, an array-valued "tools" property in its '
              + 'input schema. Refused rather than published, so the name cannot be taken by a '
              + 'package that is not a planner.',
            )
          }

          // Compile the schemas ONCE, at registration. A declared schema
          // that cannot be compiled REFUSES the tool (P26-13): publishing it with
          // the projection but no full-schema enforcement would advertise
          // constraints that are enforced nowhere, and silently stripping them is
          // exactly what P26-13 forbids. The throw reaches the lifecycle, which
          // rolls back narrowly and quarantines the extension with the reason.
          // The planning tool's INPUT is the host's own schema: the caller names
          // tools as strings and the host supplies the snapshot entries, so the
          // extension's declared input shape is its provider contract, not the
          // caller-facing advertisement.
          const inputValidator = isPlanning
            ? compileSchema(PLANNING_TOOL_INPUT_SCHEMA as unknown as Readonly<Record<string, unknown>>)
            : declared.inputSchema === undefined
              ? undefined
              : compileSchema(declared.inputSchema)
          const outputValidator = declared.outputSchema === undefined
            ? undefined
            : compileSchema(declared.outputSchema)
          const inputProjection = isPlanning
            ? projectSchemaToDsh(PLANNING_TOOL_INPUT_SCHEMA as unknown as Readonly<Record<string, unknown>>).parameters
            : declared.inputSchema === undefined
              ? {}
              : projectSchemaToDsh(declared.inputSchema).parameters
          // Closedness comes from the DECLARED schema, not a hardcoded `false`: an
          // extension that declares an open output schema must not have legitimate
          // extra fields rejected by the registry as undeclared.
          const declaredClosed = declared.outputSchema?.additionalProperties === false
          const outputProjection = declared.outputSchema === undefined
            ? { type: 'object', additionalProperties: true }
            : {
                type: 'object',
                properties: projectSchemaToDsh(declared.outputSchema).parameters,
                additionalProperties: declaredClosed,
              }
          // The envelope is stamped only when the DECLARED schema requires it (EXT-17):
          // the needle contracts declare `meta` as host-authored, and output validation
          // must not be run against a result that is still missing it.
          const requiredMeta = Array.isArray(declared.outputSchema?.required)
            && (declared.outputSchema?.required as readonly unknown[]).includes('meta')

          /**
           * THE PLANNING PIPELINE STATE, closed over per registration (NDL-02/03).
           *
           * The snapshot is captured LAZILY on the first planning call rather than at
           * publication: restoration is asynchronous across extensions, so a
           * publication-time capture would freeze whatever subset had published so far
           * and make the plannable set depend on restore order. By the first call the
           * registry is settled, and the snapshot is then FROZEN for the tool's life — a
           * later registration does not enter it (that is the "frozen at capture"
           * property the tests pin). Freshness is handled by the per-call re-checks, not
           * by re-capturing.
           */
          let planningSnapshot: ToolSchemaSnapshot | undefined
          const planningLiveLeaf = (): ReadonlySet<string> => new Set(
            ctx.tools.schemas()
              .map(schema => schema.name)
              .filter(name => !PLANNING_EXCLUDED_TOOLS.includes(name)),
          )
          const capturePlanningSnapshot = (): ToolSchemaSnapshot => {
            planningSnapshot ??= captureToolSchemaSnapshot(
              ctx.tools.schemas() as unknown as readonly RegistryToolSchema[],
              {
                generation: extensionLifecycle?.generation ?? host.activationGeneration,
                excluded: PLANNING_EXCLUDED_TOOLS,
              },
            )
            return planningSnapshot
          }
          /**
           * The fresh NDL-03 authorization check, consulted at PROPOSAL time.
           *
           * Registry membership alone is not admission: a quarantined extension's tool can
           * still be registered (its withdrawal is what failed), and a proposal for it
           * must land in `rejected` rather than pass as valid. Tools the HOST registered
           * itself (model catalog tools) have no owner here and are authorized by their
           * registry presence; contributed tools are additionally admitted through the
           * lifecycle, the same signal the dispatch path itself enforces per call.
           */
          const planningAuthorized = (name: string): true | string => {
            if (!planningLiveLeaf().has(name)) {
              return 'it was withdrawn or deactivated after the snapshot was captured'
            }
            const owner = undefined
            const lifecycle = extensionLifecycle
            if (owner === undefined || lifecycle === undefined) return true
            return lifecycle.admits(owner, name)
              ? true
              : 'its extension no longer admits it (deactivated or quarantined)'
          }

          const dispose = ctx.tools.register(defineTool({
            name: tool.name,
            description: declared.description ?? `Provided by ${tool.ownerExtension}.`,
            parameters: inputProjection as unknown as ParameterSchemaSpec,
            output: {
              schema: outputProjection as unknown as ValueSchemaSpec,
              render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
            },
            async execute(args, exec) {
              /**
               * ADMISSION IS ENFORCED AT THE CALL PATH (EXT-04, EXT-24). A registered
               * definition is not enough: a tool whose extension was deactivated, whose
               * handle failed to withdraw, or whose toggle disabled it must refuse here,
               * not dispatch. The lifecycle's admission is the same signal publication
               * used, so a caller can never run a tool the host has stopped admitting.
               */
              const lifecycle = extensionLifecycle
              if (lifecycle !== undefined && !lifecycle.admits(tool.ownerExtension, tool.name)) {
                throw new Error(
                  `${tool.name} is not admitted: its extension is inactive, disabled, or no longer publishes it`,
                )
              }

              if (isPlanning) {
                return servePlanningCall(
                  (args ?? {}) as Record<string, unknown>,
                  exec?.signal ?? new AbortController().signal,
                ) as unknown as never
              }

              /**
               * FULL-SCHEMA enforcement against the DECLARED manifest schemas. The
               * projected advertisement the registry validates is deliberately LOOSER
               * (union members become `json`, unsupported keywords are dropped), so
               * without this the dropped keywords — maxLength, minimum, pattern — are
               * enforced nowhere for extension tools.
               */
              if (inputValidator !== undefined) {
                assertAgainstSchema(`${tool.name} input`, inputValidator, args ?? {})
              }
              const dispatch = await createDispatch(environmentFor(tool.ownerExtension), tool.name)
              if (!dispatch.ok) {
                // A declared-but-unserved contract is an ERROR naming which situation the
                // caller is in, never an empty success.
                throw new Error(describeDispatchFailure(dispatch.failure))
              }
              let value = await dispatch.execute(
                (args ?? {}) as Record<string, unknown>,
                exec?.signal ?? new AbortController().signal,
              )
              if (requiredMeta) {
                value = stampResultMeta(tool.ownerExtension, tool.name, value)
              }
              // The RESULT is checked against the declared output schema before it
              // reaches a caller: the projected advertisement is looser, so this is the
              // check that enforces the keywords the projection dropped.
              if (outputValidator !== undefined) {
                assertAgainstSchema(`${tool.name} output`, outputValidator, value)
              }
              return value as unknown as never
            },
          }))

          /**
           * Serve one `tools_plan` call through the frozen-snapshot pipeline (NDL-02/03).
           *
           * Kept INSIDE registration so it closes over the tool's validators, dispatch
           * environment and the snapshot state — and outside the registry definition so
           * the shared admission check above still runs first.
           * @param callArgs - the caller's arguments, already shape-checked by the registry.
           * @param signal - cancellation.
           * @returns the validated, meta-stamped plan.
           */
          async function servePlanningCall(
            callArgs: Record<string, unknown>,
            signal: AbortSignal,
          ): Promise<Record<string, unknown>> {
            // The host's own schema is the call contract; the extension's shipped input
            // schema is its provider contract, so the declared input validator is
            // deliberately not consulted here.
            if (inputValidator !== undefined) {
              assertAgainstSchema(`${tool.name} input`, inputValidator, callArgs)
            }
            const snapshot = capturePlanningSnapshot()
            const requested = Array.isArray(callArgs.tools)
              ? callArgs.tools.filter((name): name is string => typeof name === 'string')
              : []
            /**
             * THE REQUESTED-NAME GATE. The caller's names are intersected with the LIVE
             * registry and the FROZEN snapshot; anything unattainable refuses the WHOLE
             * call rather than shrinking the offer set silently.
             */
            const decision = offerToolsFromSnapshot(snapshot, requested, planningLiveLeaf())
            if (!decision.ok) throw new Error(describePlanningRejections(decision.rejections))

            const dispatch = await createDispatch(environmentFor(tool.ownerExtension), tool.name)
            if (!dispatch.ok) throw new Error(describeDispatchFailure(dispatch.failure))

            /**
             * The provider receives SNAPSHOT entries, never the caller's declared list and
             * never anything executable — names, descriptions and JSON Schema parameters,
             * which is exactly NDL-02's "narrow public broker".
             */
            const providerInput: Record<string, unknown> = {
              request: callArgs.request,
              tools: decision.offered.map(entry => ({
                name: entry.name,
                description: entry.description,
                parameters: entry.parameters,
              })),
            }
            if (typeof callArgs.system === 'string') providerInput.system = callArgs.system
            if (typeof callArgs.max_new_tokens === 'number') providerInput.max_new_tokens = callArgs.max_new_tokens
            const raw = await dispatch.execute(providerInput, signal)

            /**
             * HOST-SIDE RE-VALIDATION plus the NDL-03 fresh policy check: every proposal
             * is re-checked against the frozen snapshot, the per-call OFFERED set, and the
             * live authorization state (registry membership AND lifecycle admission for
             * contributed tools) — a proposal that is snapshotted, schema-valid but no
             * longer offered or no longer admitted is moved to `rejected` with the reason,
             * never returned as a valid plan step.
             */
            const { payload, warnings } = recheckProposals(
              snapshot,
              raw,
              new Set(decision.offered.map(entry => entry.name)),
              planningAuthorized,
            )
            const stamped = stampResultMeta(tool.ownerExtension, tool.name, payload, warnings)
            if (outputValidator !== undefined) {
              assertAgainstSchema(`${tool.name} output`, outputValidator, stamped)
            }
            return stamped
          }
          // The owner map is maintained at the same boundary that publishes and withdraws
          // the tool, so the planning admission check never consults a stale owner.
          extensionToolOwners.set(tool.name, tool.ownerExtension)
          return () => {
            extensionToolOwners.delete(tool.name)
            dispose()
          }
        },

        /**
         * REGISTER ONE DECLARATIVE IMPLEMENTATION'S CALLER-FACING TOOL (RCP-01, HLM-01).
         *
         * A declarative package's manifest declares implementations only — no `tools`
         * array — so the tool names and schemas can only come from the RESOLVED RECIPES,
         * and a recipe can only be SERVED when the deployment composes a harness
         * provider. The contribution arrives per implementation; this resolves the whole
         * package, prepares the broker, and registers the one tool this implementation
         * names, returning its disposer so the registrar withdraws it on deactivation
         * exactly like a module tool.
         *
         * The refusal without a provider is the SAME message the per-call declarative
         * branch raises, moved to publication: activating a declarative package on a
         * deployment with no harness composition fails loudly (the narrow rollback
         * quarantines it) instead of silently registering nothing.
         */
        registerDeclarative: (contribution): (() => void) => {
          const record = store.listInstalled().value.find(candidate => candidate.extensionId === contribution.extensionId)
          if (record === undefined) return () => {}
          const discovery = discoverExtension(record.installPath)
          const manifest = discovery.manifest as unknown as {
            execution?: { kind?: string }
            implementations?: readonly { id: string; contractId: string; recipeVersion: string }[]
          }
          if (manifest.execution?.kind !== 'declarative') {
            // A MODULE package's implementation is not a caller-facing tool; the model
            // catalogue binds it, and there is nothing to register.
            return () => {}
          }
          if (harnessProvider === undefined) {
            throw new Error(
              `${contribution.extensionId} is declarative and its recipes resolved, but they cannot be served: `
              + 'this deployment composes no harness LlmProvider, so a declarative package\'s recipes '
              + 'cannot be executed. Set config.harnessModel (or supply harnessProvider) to serve them.',
            )
          }
          const resolved = resolveDeclarativeImplementations(record.installPath, manifest.implementations ?? [])
          if (!resolved.ok) {
            throw new Error(
              `${contribution.extensionId} is declarative but its recipe could not be resolved: `
              + `${resolved.id} — ${resolved.detail}`,
            )
          }
          const served = prepareDeclarative({
            provider: harnessProvider,
            journal: journalRecord => ctx.logger?.debug?.('harness invocation', journalRecord as never),
          }, resolved.resolved)
          if (!served.ok) {
            throw new Error(
              `${contribution.extensionId} is declarative and its ${resolved.resolved.length} recipe(s) resolved, `
              + `but they cannot be served: ${served.detail}`,
            )
          }
          const rawEntry = resolved.resolved.find(entry => entry.id === contribution.name)
          if (rawEntry === undefined) return () => {}
          const parsed = parseRecipe(rawEntry.recipe)
          if (!parsed.ok) {
            throw new Error(`${contribution.extensionId} declares a recipe that did not validate: ${JSON.stringify(parsed).slice(0, 300)}`)
          }
          const recipe = parsed.recipe as RecipeManifest
          const servedRecipe = served.served.find(entry => entry.implementationId === contribution.name)
          if (servedRecipe === undefined) return () => {}
          // The ADVERTISEMENT comes from the RECIPE's declared inputs (AT-63: the built-in's
          // input schema comes from the recipe, never a host guess). The recipe format is
          // JSON-Schema-flavoured (per-property `required` flags, minLength/maxLength), which
          // the DSH value-schema DSL does not fully speak — so the host applies the same
          // dual discipline it applies to extension tools (P26-13): the registry advertises
          // the DSL subset, and the FULL schema is compiled and enforced at call time.
          const dsl: Record<string, unknown> = {}
          const properties: Record<string, unknown> = {}
          const requiredNames: string[] = []
          for (const [name, raw] of Object.entries(recipe.inputs)) {
            const record = raw as unknown as Record<string, unknown>
            const advertised: Record<string, unknown> = {}
            for (const [key, value] of Object.entries(record)) {
              // The DSH DSL admits `required` only as true; a false flag is simply omitted.
              if (key === 'required' && value !== true) continue
              if (key === 'type' && value === 'image') {
                // Typed media is not a DSH scalar type; the broker does its own media
                // typing (and refuses a path/URL that is not typed media), so the
                // advertisement is the permissive json while enforcement stays full.
                advertised.type = 'json'
                continue
              }
              if (DSH_PARAMETER_KEYWORDS.has(key)) advertised[key] = value
            }
            dsl[name] = advertised
            // The full-schema half: per-property `required` folds into the root array,
            // image-typed properties validate as permissive objects (the broker types
            // them), and everything else keeps its declared keywords.
            const full: Record<string, unknown> = { ...record }
            delete full.required
            if (record.required === true) requiredNames.push(name)
            if (record.type === 'image') {
              full.type = 'object'
              full.additionalProperties = true
              delete full.mediaTypes
              delete full.maxBytes
            }
            properties[name] = full
          }
          const inputValidator = compileSchema({
            type: 'object',
            additionalProperties: false,
            properties,
            required: requiredNames,
          })
          return ctx.tools.register(defineTool({
            name: recipe.tool.name,
            description: recipe.description,
            parameters: dsl as unknown as ParameterSchemaSpec,
            output: {
              schema: { type: 'string' },
              render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
            },
            async execute(args, exec) {
              // FULL-SCHEMA enforcement before the broker runs the recipe: the
              // advertised DSL subset is looser, so the dropped keywords are enforced
              // here, exactly as the extension-tool path does (P26-13).
              assertAgainstSchema(`${recipe.tool.name} input`, inputValidator, args ?? {})
              // Typed media crosses the tool boundary in the JSON-safe form
              // `{ mediaType, bytes: number[] }` (the harness requires losslessly
              // JSON-serializable arguments); the recipe wants the ACTUAL bytes, so the
              // conversion happens HERE, and only here — never a path and never a URL,
              // which the recipe binding refuses (AT-64).
              const converted: Record<string, unknown> = { ...(args ?? {}) }
              for (const [name, value] of Object.entries(converted)) {
                const candidate = value as { mediaType?: unknown; bytes?: unknown }
                if (
                  typeof candidate?.mediaType === 'string'
                  && Array.isArray(candidate.bytes)
                  && candidate.bytes.every(entry => typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry <= 255)
                ) {
                  converted[name] = {
                    mediaType: candidate.mediaType,
                    bytes: Uint8Array.from(candidate.bytes as number[]),
                  }
                }
              }
              // NO lifecycle.admits gate: declarative tools have no per-tool entries in the
              // lifecycle state (the SDK models manifest tools only). Deactivation
              // withdrawal — the registrar's handle for exactly this disposer — is the
              // enforcement, and it removes the tool from the registry before any call.
              return servedRecipe.invoke(converted, exec?.signal) as Promise<string>
            },
          }))
        },
      },
      onRefused: (contribution, error) => {
        ctx.logger.warn(`model-tools: refused ${contribution.name} from ${contribution.extensionId}: ${error.message}`)
      },
    })
    extensionLifecycle = new ExtensionLifecycle({
      store,
      profile: 'default',
      registrar,
      // EXT-20, task-29's hook: when the lifecycle finishes withdrawing an
      // extension's handles (deactivate or uninstall, success or failure), the host
      // disposes that extension's managed worker so the child process is joined
      // before the deactivation returns — no worker outlives its extension.
      onWithdrawal: (extensionId) => workerRegistry.dispose(extensionId),
    })

    /**
     * EXT-30 slice 3: the host update surface over the SDK's staged-update seams.
     *
     * quiesce = deactivate through the lifecycle (withdraws the handles, stops
     * admissions — the onWithdrawal hook disposes the worker). rebind = activate
     * the named version through the lifecycle (all-or-nothing: a failed
     * activation withdraws its own partial publications). The surface module
     * wraps the rebind all-or-nothing with the internal revert and bounds the
     * rollback's rebindRestored host-side.
     */
    updateSurface = createUpdateHostSurface({
      storeDir: extensionStoreDir,
      profile: 'default',
      hooks: {
        quiesce: async (extensionId) => {
          const lifecycle = extensionLifecycle
          if (lifecycle === undefined) return
          await lifecycle.deactivate(extensionId)
        },
        rebind: async (extensionId, version) => {
          const lifecycle = extensionLifecycle
          if (lifecycle === undefined) throw new Error(`the extension lifecycle is not mounted; ${extensionId}@${version} cannot rebind`)
          await lifecycle.activate(extensionId, version)
        },
      },
    })

    /**
     * RES-02/03/05, the LAST in-repo slice: the prepared-assets surface.
     *
     * The cache root is the ISOLATED STATE DIR the host already owns (the
     * directory of the state file), never the repository and never HOME. The
     * default source is the real ranged HTTP source — a real acquisition run
     * stays OPT-IN (an operator explicitly runs extensions-prepare); the test
     * suite injects a local file source and performs no network.
     */
    {
      const statePath = config.stateFile ?? defaultStateFile()
      const registry: PreparedAssetRegistry = createPreparedAssetRegistry({
        cacheRoot: join(dirname(resolve(statePath)), 'asset-cache'),
      })
      const planCache = new Map<string, { plan: ReturnType<typeof planPreparation>; groups: readonly LockGroup[]; modelId: string }>()
      prepareAssetsSurface = {
        plan(extensionId) {
          const cached = planCache.get(extensionId)
          if (cached !== undefined) return cached.plan
          const record = store.listInstalled().value.find(candidate => candidate.extensionId === extensionId)
          if (record === undefined) throw new Error(`${extensionId} is not installed, so its assets cannot be planned`)
          const discovery = discoverExtension(record.installPath)
          const model = discovery.manifest.models[0]
          if (model === undefined) throw new Error(`${extensionId} declares no model deployment to prepare`)
          const lockPath = join(dirname(discovery.manifestPath), model.assetLock)
          const lock = parseAssetLock(readFileSync(lockPath, 'utf8'))
          const groups = lockGroups(lock, model.assetSet)
          const plan = planPreparation(
            identityFor(extensionId, model.id, lock),
            plannedAssets(lock, model.assetSet),
            lock.license,
          )
          planCache.set(extensionId, { plan, groups, modelId: model.id })
          return plan
        },
        groupsForPlan(extensionId) {
          const cached = planCache.get(extensionId)
          if (cached === undefined) throw new Error(`no preparation plan for ${extensionId}; run the plan disclosure first`)
          return cached.groups
        },
        modelIdFor(extensionId) {
          const cached = planCache.get(extensionId)
          if (cached === undefined) throw new Error(`no preparation plan for ${extensionId}`)
          return cached.modelId
        },
        async prepare(extensionId, options) {
          const cached = planCache.get(extensionId)
          if (cached === undefined) throw new Error(`no preparation plan for ${extensionId}; run the plan disclosure first`)
          const outcome = await registry.prepare(extensionId, cached.plan, cached.groups, options)
          if (outcome.ok) {
            // The verified assets flip the deployment from needs-preparation to
            // PREPARED-COLD through the same readiness recorder the restore
            // chain uses — the prepared-cold-callable admission then admits the
            // tool's first call.
            const lifecycle = extensionLifecycle
            if (lifecycle !== undefined) {
              await lifecycle.recordReadiness(extensionId, { [cached.modelId]: 'prepared-cold' })
            }
          }
          return outcome
        },
        assetMapFor(extensionId) {
          return registry.assetMapFor(extensionId)
        },
        registry,
      }
    }

    /**
     * RESTORE what the operator already approved.
     *
     * RUN-05 permits exactly this much at startup: an approved activation may be restored
     * and its declarations read. It performs NO model preparation and NO package
     * resolution, so nothing downloads because the plugin loaded.
     *
     * A failure is LOGGED rather than thrown: one broken extension must not remove every
     * working tool (RUN-06).
     */

    /**
     * Inspect every provider-backed catalog entry belonging to an extension and record
     * the results into the lifecycle, so activation can publish callable tools instead
     * of leaving every deployment at the `needs-preparation` default.
     *
     * Inspection is read-only (EXT-18): it never loads model assets, so this does not
     * prepare anything at startup.
     * @param lifecycle - the lifecycle whose store receives the recorded readiness.
     * @param extensionId - the extension being restored.
     */
    const recordInspectedReadiness = async (
      lifecycle: ExtensionLifecycle,
      extensionId: string,
    ): Promise<void> => {
      /**
       * Every inspection is TIME-BOUNDED: the restore chain is sequential, and one
       * extension whose inspect() hangs would stall activation for every later
       * extension indefinitely. The timeout turns a hang into a recorded `failed`
       * deployment, which is honest and lets the rest of the chain proceed.
       */
      const inspectionSignal = () => AbortSignal.timeout(15_000)
      const inspected: Record<string, ModelReadiness> = {}
      const entries = resolved.filter(item => item.entry.provider?.extension === extensionId)
      for (const item of entries) {
        // Key by the MANIFEST model id, not the catalog entry id: the durable state is
        // keyed by what the manifest declares, and an alias row whose entry id differs
        // from its provider.modelId would otherwise be silently dropped.
        const modelId = item.entry.provider?.modelId ?? item.entry.id
        try {
          const inspection = await bridge.inspect(item.entry, inspectionSignal())
          if (inspection?.readiness !== undefined) inspected[modelId] = inspection.readiness
        } catch (error) {
          // A FAILED inspection is a failed deployment, not "keep the old answer": a
          // previously-recorded prepared-cold surviving an inspection error would
          // publish a tool whose prerequisites just went missing, and the first call
          // would fail. This matches the catalog-path readinessOf, which maps a thrown
          // or absent inspection to 'failed'. In managed mode the inspection ran in
          // the WORKER process, so this catch covers the worker's fault too.
          ctx.logger.warn(
            `model-tools: readiness inspection failed for ${item.entry.name}: `
            + `${error instanceof Error ? error.message : String(error)}`,
          )
          inspected[modelId] = 'failed'
        }
      }

      /**
       * Extensions WITHOUT catalog rows (EmbeddingGemma, Needle) declare models the
       * catalog never binds. Inspect them through their own manifest: the store record
       * gives the install path, discovery reads the declared model ids, and the
       * extension-level inspection route activates the public entry like dispatch does.
       */
      const record = installedRecords.find(candidate => candidate.extensionId === extensionId)
      if (record !== undefined) {
        let declaredIds: readonly string[] = []
        try {
          declaredIds = discoverExtension(record.installPath).manifest.models.map(model => model.id)
        } catch (error) {
          ctx.logger.warn(
            `model-tools: could not read ${extensionId} manifest for inspection: `
            + `${error instanceof Error ? error.message : String(error)}`,
          )
        }
        for (const modelId of declaredIds) {
          // Only a value the CATALOG path recorded wins; a catalog-path `failed` (a
          // stale or wrong catalog binding) must not suppress the manifest-path
          // inspection, which inspects the verified store copy this extension actually is.
          if (inspected[modelId] !== undefined) continue
          try {
            // Inspect the STORE COPY, not whatever the package name resolves to in
            // node_modules: the restore loop just verified these bytes, and running the
            // unverified dependency copy instead would invert the integrity gate.
            const inspection = await bridge.inspectExtension(record.installPath, modelId, inspectionSignal())
            if (inspection?.readiness !== undefined) inspected[modelId] = inspection.readiness
          } catch (error) {
            ctx.logger.warn(
              `model-tools: readiness inspection failed for ${extensionId} model ${modelId}: `
              + `${error instanceof Error ? error.message : String(error)}`,
            )
            inspected[modelId] = 'failed'
          }
        }
      }
      if (Object.keys(inspected).length > 0) await lifecycle.recordReadiness(extensionId, inspected)
    }

    const installedRecords = store.listInstalled().value
    /**
     * Extensions the operator switched OFF in Settings.
     *
     * Checked at the restore decision because this loop is the host's only
     * activation surface: filtering after activation would let the extension
     * register its tools and then be denied, which is the two-sources-of-truth
     * mistake the publication path already forbids.
     */
    const disabledExtensions = new Set(config.disabledExtensions ?? [])
    const toRestore = store.readProfileState('default').value
      .filter(entry => entry.desiredActivation === 'active' && !disabledExtensions.has(entry.extensionId))
      .map(entry => ({
        extensionId: entry.extensionId,
        version: installedRecords.find(candidate => candidate.extensionId === entry.extensionId)?.version,
      }))
      .filter((entry): entry is { extensionId: string; version: string } => entry.version !== undefined)

    /**
     * `apply` is SYNCHRONOUS, so restoration runs as a settled chain rather than blocking
     * plugin load. That is also the right behaviour: a host must not stall on each
     * extension's activation, and RUN-06 says one broken extension must not prevent the
     * rest from working — so every failure is logged and the chain continues.
     */
    const lifecycleForRestore = extensionLifecycle
    void (async () => {
      for (const entry of toRestore) {
        try {
          /**
           * INTEGRITY BEFORE ANY EXTENSION CODE RUNS. Inspection imports the extension
           * module and runs its `create()`, so it must come AFTER the same byte-integrity
           * gate activation applies — otherwise a tampered installed package executes
           * first and is only refused afterwards.
           */
          const record = installedRecords.find(candidate =>
            candidate.extensionId === entry.extensionId && candidate.version === entry.version)
          if (record !== undefined) {
            const integrity = store.verifyUnchanged(record)
            if (!integrity.unchanged) {
              ctx.logger.warn(
                `model-tools: not restoring ${entry.extensionId}: `
                + `${integrity.diagnostic ?? 'the installed content changed'}`,
              )
              continue
            }
          }
          /**
           * RECORD what inspection knows BEFORE activation publishes. The lifecycle
           * defaults every declared deployment to `needs-preparation`, so without this
           * a model-backed package can never publish a callable tool. Inspection is the
           * read-only EXT-18 surface — it may import the extension but loads no assets —
           * so this stays inside RUN-05's "read declarations, prepare nothing" boundary.
           */
          await recordInspectedReadiness(lifecycleForRestore, entry.extensionId)
          const activated = await lifecycleForRestore.activate(entry.extensionId, entry.version)
          // EXT-20: the activation generation is captured here so the managed-worker
          // registry can bind a process to exactly this activation and dispose it when
          // a later one is observed.
          activationGenerations.set(entry.extensionId, activated.generation)
        } catch (error) {
          ctx.logger.warn(
            `model-tools: could not restore ${entry.extensionId}: `
            + `${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    })()
    ctx.effect(() => () => {
      extensionLifecycle = undefined
      // EXT-20: host teardown disposes every managed worker process — no child
      // outlives the host that spawned it.
      void workerRegistry.disposeAll()
    }, 'model-tools extension teardown')
    ctx.logger.info(`model-tools: extension store mounted at ${config.extensionStore}`)
  }


  const runnable = resolved.filter(item => item.verdict.runnable).length
  ctx.logger.info(
    `model-tools: ${installed.size} model tool(s) registered from ${entries.length} catalogued models `
    + `(${runnable} runnable in this process)`,
  )
}

export { loadCatalog, CatalogError, DEFAULT_CATALOG_FILE } from './catalog.ts'
export { resolveCapability, resolveCatalog, canResolve, packageSpecifier, type ResolvedModel } from './capability.ts'
export { createAdapter, ADAPTER_FACTORIES } from './adapters/index.ts'
export {
  buildArgv,
  commandExists,
  createCliTransport,
  createRemoteTransport,
  parseBridgeResponse,
  parseCliOutcome,
  splitArguments,
  BRIDGE_PATH,
  DEFAULT_CLI_COMMAND,
  type CommandRunner,
  type CommandTransport,
  type HttpPost,
  type TransportOptions,
} from './transport.ts'
export { renderSkillBody } from './skills.ts'
export { loadPlaybooks, DEFAULT_PLAYBOOK_FILE, type ModelPlaybook } from './playbook.ts'
export {
  createFileStateStore,
  createMemoryStateStore,
  defaultStateFile,
  parseState,
  resolveSelection,
  withChoice,
  EMPTY_STATE,
  StateError,
  type PersistedState,
  type StateStore,
} from './state.ts'
export type {
  CapabilityVerdict,
  ModelCatalogEntry,
  ModelInput,
  ModelParam,
  ModelParamType,
  ModelRoute,
  ModelToolSpec,
  ModelSkillSpec,
  WindowsSupport,
} from './types.ts'