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

/** The attachment-minting surface `ctx.attachments` satisfies structurally. */
interface DshAttachmentsSurface {
  saveImage(input: { readonly data: Uint8Array; readonly mediaType: string }): Promise<unknown>
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
