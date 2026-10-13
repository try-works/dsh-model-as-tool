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
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: resolves the required ctx.skills service declaration. The skill
// service is read opportunistically via ctx.get(), so it stays optional.
import type {} from '@deepseek-ai/dsh-skill'
import { loadCatalog } from './catalog.ts'
import { resolveCapability, type ResolvedModel } from './capability.ts'
import { createAdapter } from './adapters/index.ts'
import { registerModelTool } from './registrar.ts'
import { registerContractTool, type ContractBinding, type HostIdentity } from './bindings.ts'
import { createGrant } from './authority.ts'
import { ProviderBridge } from './provider-bridge.ts'
import { buildSurface } from './publication.ts'
import { STANDARD_CONTRACTS, type ToolContract } from '@try-works/tool-mode-contracts'
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

export const name = 'model-tools'
export const inject = ['tools']

/**
 * This package's version, stamped into every result as `extensionVersion`.
 * Kept as a literal so the runtime does not depend on reading its own manifest.
 */
export const HOST_VERSION = '0.1.1'

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
  /** Hard resource limits overriding the conservative defaults. */
  limits?: { maxInputBytes?: number; maxAudioSeconds?: number; maxResultBytes?: number }
}

/** Validate and default the plugin configuration. */
export const Config: z<Config> = z.object({
  catalogFile: z.string(),
  playbookFile: z.string(),
  stateFile: z.string(),
  persist: z.boolean().default(true),
  providers: z.dict(z.string()).default({}),
  legacyAliases: z.boolean().default(false),
  approvedRoots: z.array(z.string()).default([]),
  grantId: z.string().default('local-interactive'),
  recordReceipts: z.boolean().default(true),
  limits: z.object({
    maxInputBytes: z.number(),
    maxAudioSeconds: z.number(),
    maxResultBytes: z.number(),
  }),
  models: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  exposeUnavailable: z.boolean().default(false),
  registerSkills: z.boolean().default(true),
  registerControlTool: z.boolean().default(true),
  cli: z.object({
    enabled: z.boolean().default(true),
    command: z.string().default(DEFAULT_CLI_COMMAND),
  }),
  remote: z.object({
    endpoint: z.string(),
    token: z.string(),
  }),
  allowNpm: z.boolean().default(true),
})

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
function describeModels(resolved: readonly ResolvedModel[]): ModelDescriptor[] {
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
export function apply(ctx: Context, config: Config = {}): void {
  const entries = loadCatalog(config.catalogFile)
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
  const grant = createGrant({
    grantId: config.grantId ?? 'local-interactive',
    // Every registered tool is granted to the interactive operator; an external
    // caller gets a narrower grant of its own rather than reusing this one.
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
   * The publication decision for one catalog entry (EXT-24, EXT-32).
   *
   * ONE function decides what may be published, used by the installer and by the
   * discovery surface. Two call sites computing this separately is how a tool ends
   * up registered while discovery reports it withheld, or the reverse.
   */
  const surfaceFor = (entry: ModelCatalogEntry) => {
    const binding = entry.contract === null ? undefined : bindings.get(entry.contract)
    if (binding === undefined) return undefined
    return buildSurface({
      generation: host.activationGeneration,
      tools: [{
        name: binding.contract.toolName,
        contractId: binding.contract.contract,
        selectedModelId: binding.implementation.id,
        implementations: [
          {
            extensionId: binding.implementation.provider?.extension
              ?? binding.implementation.npmPackage
              ?? 'unknown',
            modelId: binding.implementation.id,
            // There is no preparation lifecycle yet, so a model the capability
            // resolver proved runnable is treated as ready. When preparation exists
            // this reads the deployment's real readiness instead, and the surface
            // already withholds the tool when it is not ready.
            readiness: 'ready' as const,
            runnable: true,
          },
          ...binding.alternatives.map(alternativeId => {
            // The alternative's own extension, looked up rather than assumed: an
            // alternative served by a different package is exactly the case a
            // second implementation exists for (EXT-22).
            const alternative = resolved.find(item => item.entry.id === alternativeId)
            return {
              extensionId: alternative?.entry.provider?.extension
                ?? alternative?.entry.npmPackage
                ?? 'unknown',
              modelId: alternativeId,
              readiness: 'ready' as const,
              runnable: true,
            }
          }),
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
  const install = (item: ResolvedModel): boolean => {
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
      const surface = surfaceFor(entry)
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
    install(item)
  }

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
          enum: ['list', 'installed', 'describe', 'enable', 'disable', 'reset'],
          description:
            'list: every catalogued model and whether it runs here. installed: only the models whose tools are '
            + 'registered. describe: full detail for one model. enable: install a model\'s tool and remember it. '
            + 'disable: remove a model\'s tool and remember it. reset: forget the remembered choice for one model, '
            + 'or for every model when no id is given.',
        },
        model: {
          type: 'string',
          description:
            'Model id, required for describe, enable and disable, and optional for reset (for example "tongue" or "title").',
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
            /** Set by enable/disable/reset: whether the requested change took effect. */
            changed: { type: 'boolean' },
            /** Set by enable/disable/reset: what the call did to the tool surface. */
            action: { type: 'string' },
            /** Set by enable/disable/reset: whether the choice was written to the durable store. */
            persisted: { type: 'boolean' },
            /** Where choices are stored, so a caller can tell the user what to edit. */
            stateFile: { type: 'string' },
          },
        },
        render: (_args, value) => {
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
      execute(args, exec) {
        void exec
        const action = args.action
        const modelId = args.model

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
        const provenanceOf = (entry: ModelCatalogEntry) => {
          const surface = surfaceFor(entry)
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
        const snapshot = (items: ResolvedModel[]) => items.map(item => {
          const record = installed.get(item.entry.id)
          return {
            ...(describeModels([item])[0] as ModelDescriptor),
            ...record === undefined ? {} : { tool: record.toolName },
            ...provenanceOf(item.entry),
            installed: record !== undefined,
            choice: choiceOf(item.entry.id),
          }
        })
        const counts = () => ({
          installed: installed.size,
          runnable: resolved.filter(item => item.verdict.runnable).length,
          ...persist ? { stateFile: config.stateFile ?? defaultStateFile() } : {},
        })

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
            if (configuredIds.includes(item.entry.id)) install(item)
            else uninstall(item.entry.id)
          }
          const models = modelId === undefined ? resolved : [byId.get(modelId) as ResolvedModel]
          return Promise.resolve({
            models: snapshot(models),
            ...counts(),
            changed: true,
            action,
            persisted: persist,
          })
        }

        if (action === 'describe' || action === 'enable' || action === 'disable') {
          if (modelId === undefined) throw new Error(`${action} requires a "model" id`)
          const item = byId.get(modelId)
          if (item === undefined) throw new Error(`unknown model "${modelId}"`)
          if (action === 'describe') {
            return Promise.resolve({ models: snapshot([item]), ...counts() })
          }
          const changed = action === 'enable' ? install(item) : uninstall(modelId)
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
          return Promise.resolve({
            models: snapshot([item]),
            ...counts(),
            changed,
            action,
            persisted: remembered,
          })
        }

        const models = action === 'installed'
          ? snapshot(resolved.filter(item => installed.has(item.entry.id)))
          : snapshot(resolved)
        return Promise.resolve({ models, ...counts() })
      },
      presentCall(args) {
        return { card: 'generic', title: `Model tools: ${args.action}`, kind: 'read', rawInput: args.model ?? args.action }
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
  }, 'model-tools teardown')

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