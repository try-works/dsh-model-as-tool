/**
 * Serving a declarative package's recipes through a deployment-supplied harness provider.
 *
 * THE LAST LINK OF SLICE 3, and the reason it is a module rather than a few lines in the host:
 * this is where a resolved RECIPE becomes a callable TOOL, and the pieces have to be joined in a
 * specific order for the authorization to mean anything.
 *
 * WHAT THIS DELIBERATELY IS NOT. It does not construct an `LlmProvider`. Which model answers a
 * harness call is a deployment's business, and this plugin holds no model-specific code — that
 * is an architectural rule the repository enforces with a gate. Instead a deployment SUPPLIES a
 * provider and this module does the joining: authorize the recipe's tool name, run through the
 * broker, and refuse honestly when no provider was supplied.
 *
 * WHY THE REFUSAL IS STILL THE DEFAULT. A declarative package resolves and its recipes parse,
 * and without a provider nothing can call a model. Serving the tool anyway would present a tool
 * that fails at invocation, so the refusal happens at RESOLUTION — where a reader can see why —
 * rather than at the first call.
 *
 * @module @try-works/dsh-model-as-tool/harness-serving
 */

import {
  HarnessBroker,
  type BrokerRecord,
  type LlmProvider,
  type RecipeManifest,
} from '@try-works/tool-mode-recipes'

/** A deployment's harness composition. */
export interface HarnessComposition {
  /**
   * The provider that answers harness calls, supplied by the DEPLOYMENT.
   *
   * Absent when a deployment composes none — which is the state this plugin ships in, and the
   * state the refusal exists for.
   */
  readonly provider?: LlmProvider
  /**
   * Where invocation records go.
   *
   * The broker REFUSES TO CONSTRUCT without one, because a broker that records nothing cannot be
   * audited. Making it required here means a caller cannot compose a harness path that silently
   * reports nothing — the failure is at construction rather than at audit time.
   */
  readonly journal: (record: BrokerRecord) => void
}

/** A recipe made callable. */
export interface ServedRecipe {
  readonly implementationId: string
  readonly contractId: string
  readonly toolName: string
  /** Run the recipe. Throws with the broker's own reason when it cannot. */
  readonly invoke: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
}

/** The outcome of preparing a declarative package's recipes. */
export type ServeOutcome =
  | { readonly ok: true; readonly served: readonly ServedRecipe[] }
  | { readonly ok: false; readonly code: 'no-provider' | 'recipe-rejected'; readonly detail: string }

/**
 * Prepare a declarative package's resolved recipes for serving.
 *
 * @param composition - the deployment's harness composition.
 * @param resolved - the recipes resolved through the convention.
 * @returns the served recipes, or the reason none can be served.
 */
export function prepareDeclarative(
  composition: HarnessComposition,
  resolved: readonly { readonly id: string; readonly contractId: string; readonly recipe: unknown }[],
): ServeOutcome {
  /**
   * NO PROVIDER MEANS NO SERVING, and the refusal names the composition rather than the package.
   * A reader who is told "the package is declarative" would look in the wrong place: the package
   * is complete and its recipes resolve.
   */
  if (composition.provider === undefined) {
    return {
      ok: false,
      code: 'no-provider',
      detail:
        'this deployment composes no harness LlmProvider, so a declarative package\'s recipes '
        + 'cannot be executed. The recipes resolved and the broker is available; what is absent '
        + 'is the provider that would answer a model call.',
    }
  }

  const broker = new HarnessBroker({ record: composition.journal })
  const served: ServedRecipe[] = []

  for (const entry of resolved) {
    const recipe = entry.recipe as RecipeManifest
    /**
     * AUTHORIZATION IS PER TOOL NAME, and it happens BEFORE anything is served. A recipe whose
     * name was never authorized must not become callable, or the broker would refuse at
     * invocation — a failure far from its cause.
     */
    const toolName = recipe.tool.name
    try {
      broker.authorize(toolName, composition.provider)
    } catch (error) {
      return {
        ok: false,
        code: 'recipe-rejected',
        detail: `${entry.id}: the broker refused to authorize ${toolName}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      }
    }

    served.push({
      implementationId: entry.id,
      contractId: entry.contractId,
      toolName,
      async invoke(args, signal) {
        const outcome = await broker.run(recipe, args, signal === undefined ? {} : { signal })
        if (outcome.kind === 'completed') return (outcome as { text?: unknown }).text
        /**
         * A non-completed outcome is THROWN rather than returned, because a refusal, a
         * truncation or a tool call is an ERROR — returning an empty value would look like a
         * successful empty result and reach a caller as one.
         */
        throw new Error(`the harness recipe ${toolName} did not complete: ${JSON.stringify(outcome).slice(0, 300)}`)
      },
    })
  }

  return { ok: true, served }
}
