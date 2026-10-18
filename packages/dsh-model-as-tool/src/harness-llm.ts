/**
 * The HOST-side injection seam for the DSH-backed harness provider (HLM-01/02/03).
 *
 * The recipes package ships {@link DshLlmProvider} — a REAL `LlmProvider` over the DSH
 * harness's own LLM surface (`ctx.llm`), with capabilities read from the model's own
 * descriptor and images transported through a deployment-supplied hook. What the host
 * adds here is the COMPOSITION, and it is deliberately narrow:
 *
 * - the surface is reached STRUCTURALLY, so the host never imports the DSH packages at
 *   this boundary (they are the deployment's peers, and this module reads exactly the
 *   two members the adapter consumes);
 * - the image transport is minted ONLY when the deployment can actually reach the DSH
 *   attachment service (`ctx.attachments.saveImage`): without it the provider is built
 *   WITHOUT the hook, so an image-capable model honestly reports `images: 'unknown'`
 *   and the broker refuses image recipes with EXECUTOR_CAPABILITY_UNKNOWN — never a
 *   silent drop (HLM-11);
 * - every failure fails CLOSED: an unreachable surface, a descriptor that cannot be
 *   resolved, or a descriptor naming another route yields `undefined` plus a diagnostic,
 *   so the deployment runs as if the option were absent rather than half-wired.
 *
 * @module @try-works/dsh-model-as-tool/harness-llm
 */

import { DshLlmProvider, type DshImageTransport, type DshLlmSurface, type LlmProvider } from '@try-works/tool-mode-recipes'

/** The opt-in configuration naming one DSH provider route and model. */
export interface HarnessModelConfig {
  /** The registered adapter route, e.g. `deepseek`. */
  readonly provider: string
  /** The exact model id, e.g. `deepseek-chat`. */
  readonly model: string
}

/** One discovered default route/model (the AUTO step's product). */
export interface HarnessModelDiscovery {
  readonly provider: string
  readonly model: string
}

/**
 * Discover the deployment's default/selected model for the AUTO composition
 * (task-93 + task-97). DEFAULT-SAFE: any ambiguity or malformed entry yields
 * `undefined` — never a guessed route.
 *
 * Probes, in order:
 * 1. the settings service's `describe()` descriptor list: the descriptor whose
 *    `ns` is `agent-default-model` (the live web profile's settings namespace),
 *    with the resolved `{provider, model}` read from its `value` — the actual
 *    SettingsForms API (there is no synchronous `get(ns)`, which was live bug
 *    #2);
 * 2. the root config's `model.default` as the `provider/model` string.
 * @param ctx - the surfaces to probe, read structurally.
 * @returns the discovered route/model, or undefined when none is unambiguous.
 */
export function discoverDefaultHarnessModel(ctx: {
  readonly settings?: unknown
  readonly config?: { readonly model?: { readonly default?: unknown } }
}): HarnessModelDiscovery | undefined {
  // 1. The agent-default-model settings descriptor (what the Web composer
  //    writes into the profile patch; its ns is 'agent-default-model').
  const settings = ctx.settings as { describe?: () => unknown } | undefined
  const described = settings?.describe?.()
  if (Array.isArray(described)) {
    for (const descriptor of described) {
      if (descriptor === null || typeof descriptor !== 'object') continue
      const entry = descriptor as { ns?: unknown; value?: unknown }
      if (entry.ns !== 'agent-default-model') continue
      const value = entry.value
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const resolved = value as Record<string, unknown>
        const provider = resolved['provider']
        const model = resolved['model']
        if (typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0) {
          return { provider, model }
        }
      }
      // The matching descriptor carries no unambiguous pair: refuse rather
      // than continue probing a malformed entry.
      return undefined
    }
  }
  // 2. The root config's model.default, the `provider/model` string.
  const declared = ctx.config?.model?.default
  if (typeof declared === 'string') {
    const slash = declared.indexOf('/')
    if (slash > 0 && slash < declared.length - 1) {
      return { provider: declared.slice(0, slash), model: declared.slice(slash + 1) }
    }
  }
  return undefined
}

/** The attachment-minting surface `ctx.attachments` satisfies structurally. */
interface DshAttachmentsSurface {
  saveImage(input: { readonly data: Uint8Array; readonly mediaType: string }): Promise<unknown>
}

/**
 * The LlmRuntime contract the AUTO composition resolves through (read from
 * D:\deepseek-harness\packages\llm\llm\lib\types\index.d.ts):
 * - `resolveModelInfo(provider, model)` keys on the REGISTERED ROUTE id
 *   (LlmRuntime.resolveModelInfo → registration(provider) → the adapter),
 * - `listProviders(): LlmProviderInfo[]` (sync) — the registered routes,
 * - `listConfigurableProviders(): LlmConfigurableProvider[]` (sync) — the
 *   directory mapping a settings namespace to the route it activates
 *   (`{provider, displayName, settingsNs, settingsPath}`),
 * - `listModels(provider): Promise<LlmModelInfo[]>` — the per-route catalog.
 */
export interface HarnessLlmRuntimeSurface {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
  listProviders?(): readonly { id: string; name: string }[]
  listConfigurableProviders?(): readonly { provider: string; displayName: string; settingsNs?: string; settingsPath?: readonly string[] }[]
  listModels?(provider: string): Promise<readonly { provider?: string; id: string; name: string }[]>
}

/** One resolution outcome (task-98): the runnable pair, or the exact refusal. */
export type HarnessModelResolution =
  | { readonly ok: true; readonly route: string; readonly model: string }
  | { readonly ok: false; readonly kind: 'not-ready-yet' | 'not-configured'; readonly reason: string }

/**
 * Resolve a RUNNABLE (route, model) pair the way the runtime does (task-98):
 * the configured provider may be a settings namespace or display name rather
 * than the registered ROUTE id, so a direct resolveModelInfo failure is not
 * 'not configured' — the runtime's own listings map the configured provider to
 * its route and confirm the model through the route's catalog. An EMPTY route
 * registry is 'not ready yet' (the adapter plugins register after this plugin
 * in the composition order), which is retryable — never locked in as 'none'.
 * @param llm - the LLM surface, read structurally (the listings are optional).
 * @param desired - the configured provider/model (the agent-default-model pair).
 * @param log - the diagnostic sink.
 * @returns the runnable pair, or the exact not-ready-yet/not-configured reason.
 */
export async function resolveRunnableHarnessModel(
  llm: HarnessLlmRuntimeSurface,
  desired: { readonly provider: string; readonly model: string },
  log: (message: string) => void = () => {},
): Promise<HarnessModelResolution> {
  // 1. The direct pair: the config's provider IS the route.
  try {
    await llm.resolveModelInfo(desired.provider, desired.model)
    return { ok: true, route: desired.provider, model: desired.model }
  } catch (error) {
    log(`direct ${desired.provider}/${desired.model} does not resolve: ${error instanceof Error ? error.message : String(error)}`)
  }
  // 2. Map the configured provider to a registered route.
  const providers = llm.listProviders?.() ?? []
  if (providers.length === 0) {
    return {
      ok: false,
      kind: 'not-ready-yet',
      reason:
        'the deployment\'s LLM surface has not registered its provider routes yet; retry once the deployment '
        + 'finishes starting (this is not a configuration error)',
    }
  }
  const byId = providers.find(entry => entry.id === desired.provider)
  const byName = providers.find(entry => entry.name === desired.provider)
  let route = byId?.id ?? byName?.id
  if (route === undefined) {
    const directory = llm.listConfigurableProviders?.() ?? []
    const entry = directory.find(candidate => (
      candidate.provider === desired.provider
      || candidate.settingsNs === desired.provider
      || candidate.displayName === desired.provider
    ))
    route = entry?.provider
  }
  if (route === undefined) {
    return {
      ok: false,
      kind: 'not-configured',
      reason:
        `the configured provider ${JSON.stringify(desired.provider)} is not a registered LLM route in this `
        + 'deployment; set config.harnessModel to a runnable route',
    }
  }
  // 3. Confirm the model through the route's own catalog, then a direct probe.
  if (llm.listModels !== undefined) {
    try {
      const catalog = await llm.listModels(route)
      if (catalog.some(entry => entry.id === desired.model)) {
        return { ok: true, route, model: desired.model }
      }
      if (catalog.length > 0) {
        return {
          ok: false,
          kind: 'not-configured',
          reason:
            `the model ${JSON.stringify(desired.model)} is not served by the ${route} route (its catalog lists `
            + `${catalog.map(entry => entry.id).join(', ')}); set config.harnessModel to a served model`,
        }
      }
    } catch (error) {
      log(`the ${route} catalog could not be listed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    await llm.resolveModelInfo(route, desired.model)
    return { ok: true, route, model: desired.model }
  } catch {
    return {
      ok: false,
      kind: 'not-configured',
      reason:
        `the ${route} route does not serve the model ${JSON.stringify(desired.model)}; set config.harnessModel `
        + 'to a served model',
    }
  }
}

/**
 * Build the DSH-backed harness provider for one opt-in route/model.
 *
 * DEFAULT OFF: this runs only when the operator set {@link HarnessModelConfig}, and it
 * returns `undefined` (with a diagnostic) whenever the DSH surface cannot actually
 * serve the named model.
 * @param ctx - the host context, read structurally.
 * @param config - the operator's provider/model selection.
 * @param log - a diagnostic sink for the fail-closed reasons.
 * @returns the provider, or undefined when the deployment cannot build one.
 */
export async function buildHarnessLlmProvider(
  ctx: {
    readonly llm?: unknown
    readonly attachments?: DshAttachmentsSurface
  },
  config: HarnessModelConfig,
  log: (message: string) => void = () => {},
): Promise<LlmProvider | undefined> {
  if (ctx.llm === undefined) {
    log('the DSH LLM surface is not mounted in this deployment, so the harness provider is not wired')
    return undefined
  }
  // HLM-11: the image transport exists only when the attachment service does. Without
  // it the adapter reports images 'unknown' and the broker refuses rather than drops.
  const attachments = ctx.attachments
  let images: DshImageTransport | undefined
  if (attachments !== undefined) {
    images = async (image) => ({
      type: 'image',
      attachment: await attachments.saveImage({ data: image.bytes, mediaType: image.mediaType }),
    })
  } else {
    log('the DSH attachment service is not mounted, so image recipes will refuse with EXECUTOR_CAPABILITY_UNKNOWN')
  }
  try {
    return await DshLlmProvider.create({
      llm: ctx.llm as DshLlmSurface,
      provider: config.provider,
      model: config.model,
      ...images === undefined ? {} : { images },
    })
  } catch (error) {
    // Fail closed: a descriptor that cannot be resolved (route not registered) or one
    // naming another model leaves the deployment as if the option were absent.
    log(
      `could not build the harness provider for ${config.provider}/${config.model}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}
