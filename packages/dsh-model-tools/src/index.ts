/**
 * dsh-model-tools — install on-device models as DSH tools and skills.
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
 * @module @dsh-plugins/dsh-model-tools
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
import { renderSkillBody } from './skills.ts'
import { loadPlaybooks } from './playbook.ts'
import type { ModelCatalogEntry } from './types.ts'

export const name = 'model-tools'
export const inject = ['tools']

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
}

/** Validate and default the plugin configuration. */
export const Config: z<Config> = z.object({
  catalogFile: z.string(),
  playbookFile: z.string(),
  models: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  exposeUnavailable: z.boolean().default(false),
  registerSkills: z.boolean().default(true),
  registerControlTool: z.boolean().default(true),
})

/** One registered model, as reported by `model_tools`. */
interface InstalledModel {
  readonly entry: ModelCatalogEntry
  readonly toolName: string
  readonly dispose: () => void
  disposeSkill?: () => void
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

  const resolved: ResolvedModel[] = entries.map(entry => ({
    entry,
    verdict: resolveCapability(entry),
  }))

  for (const { entry, verdict } of resolved) {
    if (wanted !== undefined && !wanted.has(entry.id)) continue
    if (excluded.has(entry.id)) continue
    if (!verdict.runnable && !exposeUnavailable) continue

    const adapter = createAdapter(entry)
    if (adapter === undefined) {
      // Runnable but no adapter yet: report rather than register a dead tool.
      ctx.logger.info(
        `model-tools: ${entry.name} can run here (${verdict.route}) but no adapter ships yet; skipping ${entry.tool.name}`,
      )
      continue
    }

    const registration = registerModelTool(
      ctx as unknown as { tools: { register(definition: unknown): () => void } },
      entry,
      adapter,
    )
    const record: InstalledModel = { ...registration, entry }

    if ((config.registerSkills ?? true)) {
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

    installed.set(entry.id, record)
    ctx.logger.info(
      `model-tools: registered ${entry.tool.name} for ${entry.name} (${verdict.route})`,
    )
  }

  if (config.registerControlTool ?? true) {
    ctx.tools.register(defineTool({
      name: 'model_tools',
      description:
        'List the on-device models available to this agent, what each one does, and whether it can run on this '
        + 'machine. Use it before calling a model tool when unsure which one fits, or to explain to the user why a '
        + 'model is unavailable here. Models that cannot run in this process report the exact reason.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'installed', 'describe'],
          description: 'list: every catalogued model and whether it runs here. installed: only the models whose tools are registered. describe: full detail for one model.',
        },
        model: {
          type: 'string',
          description: 'Model id, required for describe (for example "tongue" or "voz").',
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
                },
              },
            },
            installed: { type: 'integer', required: true },
            runnable: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => {
          const lines = value.models.map(model =>
            `- ${model.runnable ? '[ready]' : '[unavailable]'} ${model.id} (\`${model.tool}\`): ${model.summary}`
            + (model.runnable ? '' : `\n  why not: ${model.reason}`),
          )
          return [{
            type: 'text',
            text: `${value.installed} of ${value.models.length} catalogued models are installed as tools; `
              + `${value.runnable} can run on this machine.\n\n${lines.join('\n')}`,
          }]
        },
      },
      execute(args, exec) {
        void exec
        const action = args.action
        const all = describeModels(resolved)
        if (action === 'describe') {
          const modelId = args.model
          if (modelId === undefined) throw new Error('describe requires a "model" id')
          const found = all.find(entry => entry.id === modelId)
          if (found === undefined) throw new Error(`unknown model "${modelId}"`)
          return Promise.resolve({
            models: [found],
            installed: installed.size,
            runnable: resolved.filter(item => item.verdict.runnable).length,
          })
        }
        const models = action === 'installed'
          ? all.filter(entry => installed.has(entry.id as string))
          : all
        return Promise.resolve({
          models,
          installed: installed.size,
          runnable: resolved.filter(item => item.verdict.runnable).length,
        })
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
export { renderSkillBody } from './skills.ts'
export { loadPlaybooks, DEFAULT_PLAYBOOK_FILE, type ModelPlaybook } from './playbook.ts'
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
