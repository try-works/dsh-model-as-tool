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
  parseRecipe,
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

/**
 * A harness call the caller CANCELLED.
 *
 * Distinct from `HarnessFailedError` on purpose: a caller who walked away is not a malfunction,
 * and conflating the two makes every cancellation look like a fault. The same discipline the
 * invocation accounting applies to `cancelled`.
 */
export class HarnessCancelledError extends Error {
  override readonly name = 'HarnessCancelledError'
  constructor(readonly toolName: string, readonly reason: string) {
    super(`the harness recipe ${toolName} was cancelled: ${reason}`)
  }
}

/**
 * A harness call that FAILED, carrying the broker's machine-readable code.
 *
 * The code is preserved rather than flattened into a message, so a caller branches on the CAUSE
 * instead of matching prose.
 */
export class HarnessFailedError extends Error {
  override readonly name = 'HarnessFailedError'
  constructor(readonly toolName: string, readonly code: string, readonly reason: string) {
    super(`the harness recipe ${toolName} failed (${code}): ${reason}`)
  }
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
    /**
     * THE RECIPE IS VALIDATED HERE, and it previously was not — a HIGH-severity gap found by
     * adversarial review.
     *
     * This line used to be a bare cast: `entry.recipe as RecipeManifest`. The production resolver
     * hands over raw `JSON.parse` output, so NOTHING validated the file between disk and
     * execution. The review took `text-title.json` and applied one mutation at a time — an
     * unexpected `tools` array, a `systemPrompt`, a `${process.env.SECRET_KEY}` interpolation, an
     * uppercase or path-like tool name, `__proto__`, an absurd `maxOutputTokens`, a missing
     * `policy`, a missing `inputs`. `parseRecipe` REFUSED ALL TEN; `prepareDeclarative` SERVED ALL
     * TEN, and they executed. The validator was available and imported by the test that was
     * supposed to cover this path — and bypassed by the only path that runs a recipe.
     *
     * A cast is a claim about a value the compiler cannot check, and here the claim was false for
     * exactly the inputs an untrusted package would supply.
     */
    const parsed = parseRecipe(entry.recipe)
    if (!parsed.ok) {
      return {
        ok: false,
        code: 'recipe-rejected',
        detail: `${entry.id}: the recipe did not validate: ${JSON.stringify(parsed).slice(0, 300)}`,
      }
    }
    const recipe = parsed.recipe as RecipeManifest
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
        if (outcome.kind === 'completed') return outcome.text
        /**
         * THE BROKER'S NON-COMPLETED VARIANTS ARE `failed` AND `cancelled` — and an earlier
         * version of this comment named `refused`, `truncated` and `tool_call` instead.
         *
         * Those are variants of `LlmCompletion`, the PROVIDER's reply, not of `BrokerOutcome`,
         * what `run` returns. They were plausible and wrong, and the difference is not academic:
         * a reader trusting the comment would handle cases that cannot occur here and miss the
         * one that can.
         *
         * CANCELLATION IS NOT A FAILURE, and it used to be thrown as an indistinguishable Error.
         * The same discipline applies here as in the invocation accounting: a caller who walked
         * away must be able to tell that from a malfunction, or every cancellation inflates the
         * error rate. `HarnessCancelledError` exists so it can.
         */
        if (outcome.kind === 'cancelled') {
          throw new HarnessCancelledError(toolName, outcome.reason)
        }
        // `failed` carries the broker's own machine-readable code, so a caller can branch on the
        // CAUSE rather than matching on a message.
        throw new HarnessFailedError(toolName, outcome.code, outcome.reason)
      },
    })
  }

  return { ok: true, served }
}
