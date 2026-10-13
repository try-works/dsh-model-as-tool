/**
 * The DSH LLM broker: one provider-neutral harness executor for declarative recipes
 * (HLM-01, HLM-02, HLM-05, HLM-06, HLM-07, HLM-09, HLM-10, HLM-11).
 *
 * The broker's whole job is to build ONE request that contains nothing but the recipe's
 * instructions and the validated bound inputs, and then to report honestly what came
 * back. Every invariant here is a way the request could stop being that request, or the
 * result stop being the result:
 *
 * - **The request is isolated by construction.** It is built from the recipe and the
 *   bound values alone. There is no parameter through which parent history, a parent
 *   system prompt, a tool catalog, skills, attachments or memory could arrive, and the
 *   shape is frozen so nothing can be added to it after validation (HLM-05, AT-68).
 * - **Images are typed media, or the call is refused.** An image recipe on a provider
 *   whose capabilities do not cover images fails with `IMAGE_INPUT_UNAVAILABLE`. It does
 *   not quietly degrade to a text-only call that "describes" an image the model never
 *   received — that fallback produces a fluent invention, which is worse than an error
 *   (HLM-11).
 * - **An unknown capability is not permission.** A provider that has not reported its
 *   image support fails with `EXECUTOR_CAPABILITY_UNKNOWN` rather than being assumed
 *   capable (MODEL-06's three-state rule, reused here).
 * - **Remote is a policy decision, not an implementation detail.** `permitsDestination`
 *   is mirrored from RES-10 so a local-only profile refuses a remote provider however
 *   the tool was built.
 * - **Cancellation is reported as cancellation.** An aborted signal can never produce a
 *   success, and never an empty one: an empty success is exactly what a caller writes
 *   into a document (HLM-10).
 * - **Refusal, truncation, an empty completion and a stray tool call are errors, each
 *   with its own code.** HLM-07 requires them to be distinct failures, because a caller
 *   that cannot tell "the model refused" from "the model was cut off" cannot respond
 *   correctly to either (RCP-11).
 * - **Recording is a precondition, not a side effect.** A recipe that declines recording
 *   under a host that requires it is refused with `CAPTURE_POLICY_CONFLICT` BEFORE the
 *   provider is called, because refusing after the call would report a refusal for work
 *   that has already been billed (HLM-09).
 *
 * @module @try-works/tool-mode-recipes/broker
 */

import {
  errorCodeOf,
  INITIAL_MAX_IMAGE_INPUTS,
  INITIAL_MAX_OUTPUT_TOKENS,
  renderPrompt,
  validateRecipeInputs,
  type RecipeImageValue,
  type RecipeManifest,
  type RecipeValue,
} from './recipe-format.ts'

/** Where a provider runs. RES-10's destination rule is stated in these terms. */
export type ProviderDestination = 'local' | 'remote'

/**
 * What a provider knows about a capability (MODEL-06).
 *
 * Three states, not two. `unsupported` is a fact the provider reported; `unknown` is the
 * ABSENCE of a fact, and treating it as `unsupported` reports an unevaluated capability
 * as a known absence while treating it as `supported` dispatches work that may fail
 * silently. Both collapse a state the requirement says to keep separate.
 */
export type CapabilityState = 'supported' | 'unsupported' | 'unknown'

/** What a provider reports about itself. */
export interface ProviderCapabilities {
  /**
   * Whether images are accepted. A plain boolean is accepted for convenience and
   * normalised to `supported`/`unsupported`; `unknown` is the honest third state.
   */
  readonly images: CapabilityState | boolean
  /** The provider's own output-token ceiling for one call. */
  readonly maxOutputTokens: number
}

/** One typed image, as the transport carries it. */
export interface BrokerImage {
  /** The image's media type, e.g. `image/png`. */
  readonly mediaType: string
  /** The image's actual bytes. */
  readonly bytes: Uint8Array
}

/**
 * The ONLY request a recipe execution can produce.
 *
 * The optional `system` member exists in the transport shape and is never populated by
 * this broker: this slice's recipe format has no system field, and inheriting the parent
 * agent's system prompt is forbidden (HLM-05). The tests assert its absence rather than
 * trusting this comment.
 */
export interface BrokerRequest {
  /** Never set by this broker. Present so a future authorized context input has a home. */
  readonly system?: string
  /** The rendered recipe instructions plus the bound inputs. */
  readonly prompt: string
  /** The typed image inputs, when the recipe declares them and the caller supplied them. */
  readonly images?: readonly BrokerImage[]
  /** The effective ceiling after the recipe, host and provider limits are intersected. */
  readonly maxOutputTokens: number
  /** The caller's cancellation channel, passed through unchanged. */
  readonly signal: AbortSignal
}

/** What a provider reported about consumption. */
export type LlmUsage =
  | { readonly known: true; readonly inputTokens: number; readonly outputTokens: number }
  /**
   * The provider reported no usage.
   *
   * Distinct from zero, for the same reason RES-10 keeps an unknown cost distinct from a
   * free one: recording "0 tokens" for an unreported call invents a measurement.
   */
  | { readonly known: false; readonly reason: string }

/** How one provider call ended. */
export type LlmCompletion =
  /** Text was produced. */
  | { readonly kind: 'text'; readonly text: string; readonly usage?: LlmUsage }
  /** The provider declined. An error, never an empty result. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** Generation was cut short. An error, never a short result. */
  | { readonly kind: 'truncated'; readonly text: string }
  /** The provider emitted a tool call, which must not be executed (HLM-06). */
  | { readonly kind: 'tool_call'; readonly toolName: string }

/**
 * A provider of harness model calls.
 *
 * Deliberately tiny and vendor-free: no HTTP, no credentials, no vendor types. A
 * recipe cannot reach any of the things this interface does not express (HLM-01).
 */
export interface LlmProvider {
  /** Stable provider identity, for receipts and the journal. */
  readonly id: string
  /**
   * The adapter generation.
   *
   * An authorization is issued for a generation, not for a name: a provider that has
   * reloaded is a different endpoint, and combining the old capabilities with the new
   * endpoint is what HLM-02 forbids.
   */
  readonly generation: number
  /** Where this provider runs. Checked against RES-10's destination rule. */
  readonly destination: ProviderDestination
  /** What it can do, read ONCE per invocation. */
  capabilities(): ProviderCapabilities
  /** Perform one isolated call. */
  complete(request: BrokerRequest): Promise<LlmCompletion>
}

/** Codes carried by a failed invocation. RCP-11's vocabulary plus three local additions. */
export type BrokerErrorCode =
  /** No authorized executor, or the authorization is for another generation. */
  | 'EXECUTOR_NOT_CONFIGURED'
  /** The provider has not reported whether it accepts images. */
  | 'EXECUTOR_CAPABILITY_UNKNOWN'
  /** A binding used a modality the recipe does not admit. */
  | 'UNSUPPORTED_MODALITY'
  /** The recipe needs images and the provider cannot accept them (HLM-11). */
  | 'IMAGE_INPUT_UNAVAILABLE'
  /** Mandatory recording conflicts with policy, so the call is refused (HLM-09). */
  | 'CAPTURE_POLICY_CONFLICT'
  /** The provider declined. */
  | 'MODEL_REFUSED'
  /** Generation was truncated. */
  | 'MODEL_OUTPUT_TRUNCATED'
  /** The output could not be used as a result, an empty one included. */
  | 'INVALID_MODEL_OUTPUT'
  /** The provider emitted a tool call, which is never executed (HLM-06). */
  | 'UNEXPECTED_MODEL_TOOL_CALL'
  /** A budget RES-10 states was exceeded. */
  | 'MODEL_BUDGET_EXCEEDED'
  /** The supplied arguments do not satisfy the recipe. */
  | 'RECIPE_BINDING_ERROR'
  /*
   * The three below are NOT in RCP-11's list, and they are named rather than folded into
   * a code that means something else. Reporting a cancelled call as MODEL_REFUSED would
   * say the model declined when the caller walked away; reporting a transport failure as
   * INVALID_MODEL_OUTPUT would blame the model for the network.
   */
  /** The invocation was cancelled, by the caller or by its deadline. */
  | 'CANCELLED'
  /** The provider failed to complete. */
  | 'PROVIDER_FAILED'
  /** The mandatory recording could not be written, so the call did not run. */
  | 'RECORDING_FAILED'

/** The host's invocation policy. Mirrors the parts of RES-10 this broker enforces. */
export interface BrokerHostPolicy {
  /**
   * Whether the host requires the prepared request to be journaled (HLM-09).
   *
   * When true, a recipe declaring `record: false` is refused rather than run unrecorded,
   * and the broker refuses to be constructed without a journal sink.
   */
  readonly requireRecording: boolean
  /** Whether a remote destination may be reached at all (RES-10). */
  readonly remoteDestinations: boolean
  /** The host's output-token ceiling. */
  readonly outputTokens: number
  /** The host's image-input ceiling. */
  readonly imageInputs: number
}

/**
 * The initial policy: RES-10's initial per-leaf maxima, with recording required.
 *
 * Recording defaults to REQUIRED because HLM-09 makes reconstructability a DSH
 * requirement, and a default of "off" is how a harness call ends up unrecorded without
 * anyone deciding that.
 */
export const INITIAL_HOST_POLICY: BrokerHostPolicy = {
  requireRecording: true,
  remoteDestinations: true,
  outputTokens: INITIAL_MAX_OUTPUT_TOKENS,
  imageInputs: INITIAL_MAX_IMAGE_INPUTS,
}

/** A local-only policy, which forbids remote destinations however the tool was built. */
export const LOCAL_ONLY_HOST_POLICY: BrokerHostPolicy = {
  ...INITIAL_HOST_POLICY,
  remoteDestinations: false,
}

/**
 * Whether a policy permits reaching a destination (RES-10).
 *
 * Mirrored from the host's `harness-budgets.permitsDestination`: a local-only profile
 * prohibits remote destinations INDEPENDENTLY of how the tool was implemented, so this
 * asks the policy rather than the implementation. `local` is always permitted.
 * @param policy - the policy in force.
 * @param destination - the destination being considered.
 * @returns whether it is permitted.
 */
export function permitsDestination(policy: BrokerHostPolicy, destination: ProviderDestination): boolean {
  return destination === 'local' ? true : policy.remoteDestinations
}

/**
 * Narrow a policy by a requested reduction (RES-10, HLM-07).
 *
 * Every figure takes the MINIMUM, so a request can only lower a limit; that direction is
 * the point, since a caller asking for more than the profile permits must get the
 * profile's figure. `requireRecording` is an OR: a request can demand recording where
 * the base was silent, and can never switch it off.
 * @param base - the policy in force.
 * @param requested - what the caller asked for.
 * @returns the effective policy.
 */
export function narrowBrokerPolicy(
  base: BrokerHostPolicy,
  requested: Partial<BrokerHostPolicy>,
): BrokerHostPolicy {
  const lower = (a: number, b: number | undefined): number => (b === undefined ? a : Math.min(a, b))
  return {
    requireRecording: base.requireRecording || (requested.requireRecording ?? false),
    // A reduction can never ENABLE remote destinations, so this is an AND.
    remoteDestinations: base.remoteDestinations && (requested.remoteDestinations ?? true),
    outputTokens: lower(base.outputTokens, requested.outputTokens),
    imageInputs: lower(base.imageInputs, requested.imageInputs),
  }
}

/** The journal entry for one auxiliary call (HLM-09). */
export interface BrokerRecord {
  /** The record kind, so a journal can hold more than one thing. */
  readonly kind: 'harness-model-auxiliary-call'
  /** The tool invocation this call belongs to. */
  readonly toolName: string
  /** The contract identity, so the record ties to a versioned contract. */
  readonly contractId: string
  /** The recipe identity and version, pinned for reconstructability. */
  readonly recipeId: string
  /** The recipe version. */
  readonly recipeVersion: string
  /** The provider that will run the call. */
  readonly providerId: string
  /** The provider generation that was authorized. */
  readonly providerGeneration: number
  /** Where the call goes. */
  readonly destination: ProviderDestination
  /** The effective token ceiling. */
  readonly maxOutputTokens: number
  /** How many image inputs the request carries. */
  readonly imageCount: number
  /** The EXACT prepared prompt (HLM-09: the model-visible input must be reconstructable). */
  readonly prompt: string
  /**
   * What context the request carries.
   *
   * Recorded as a value rather than left implicit, so a journal entry states that the
   * request was recipe-only instead of leaving a reader to infer it from the absence of
   * fields.
   */
  readonly context: 'recipe-only'
}

/**
 * Where journal entries go.
 *
 * The broker never writes a file itself: retention, access control and the operator's
 * policy are the host's, and a broker that decided them would be deciding them outside
 * the policy that governs them (HLM-09).
 */
export type BrokerRecordSink = (record: BrokerRecord) => void | Promise<void>

/** Identity attached to a completed invocation. */
export interface ProviderIdentity {
  /** The provider id. */
  readonly id: string
  /** The generation the broker RESOLVED for this invocation. */
  readonly generation: number
  /** Where it ran. */
  readonly destination: ProviderDestination
}

/** The recipe identity a completed invocation ran. */
export interface RecipeIdentity {
  /** The recipe id. */
  readonly id: string
  /** The recipe version. */
  readonly version: string
  /** The tool the recipe implements. */
  readonly toolName: string
  /** The contract the tool implements. */
  readonly contractId: string
}

/** What one recipe invocation produced. */
export type BrokerOutcome =
  | {
    readonly kind: 'completed'
    /** The model's text. Never empty: an empty completion fails instead. */
    readonly text: string
    /** What the provider reported, or an honest unknown. */
    readonly usage: LlmUsage
    /** Whether the prepared request was journaled. */
    readonly recorded: boolean
    /** Which provider generation served the call. */
    readonly provider: ProviderIdentity
    /** Which recipe was run. */
    readonly recipe: RecipeIdentity
  }
  | { readonly kind: 'failed'; readonly code: BrokerErrorCode; readonly reason: string }
  | { readonly kind: 'cancelled'; readonly reason: string }

/** A completed invocation. */
export type BrokerCompletion = Extract<BrokerOutcome, { kind: 'completed' }>

/** Raised by {@link HarnessBroker.runOrThrow}. */
export class BrokerError extends Error {
  override readonly name = 'BrokerError'
  /** The failure code. */
  readonly code: BrokerErrorCode
  constructor(code: BrokerErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.code = code
  }
}

/** An authorization for one tool, captured with the provider's generation. */
export interface ProviderGrant {
  /** The tool the authorization covers. */
  readonly toolName: string
  /** The authorized provider. */
  readonly provider: LlmProvider
  /** The generation observed when the authorization was issued. */
  readonly generation: number
}

/** Options for a broker. */
export interface BrokerOptions {
  /** The host policy. Defaults to {@link INITIAL_HOST_POLICY}. */
  readonly policy?: BrokerHostPolicy
  /** The journal sink. Required when the policy requires recording (HLM-09). */
  readonly record?: BrokerRecordSink
}

/** Options for one invocation. */
export interface RunOptions {
  /** The caller's cancellation channel. */
  readonly signal?: AbortSignal
  /**
   * A wall-clock deadline for this invocation, in milliseconds (RES-10's 60 s figure is
   * the caller's to pass).
   *
   * Implemented by aborting the same internal controller the caller's signal aborts, so
   * there is exactly one cancellation path and a deadline cannot report itself as a
   * success.
   */
  readonly deadlineMs?: number
}

/** How one provider dispatch settled. */
type Dispatch =
  | { readonly kind: 'completion'; readonly completion: LlmCompletion }
  | { readonly kind: 'cancelled'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }

/** Normalise the two-state shorthand into the three-state capability. */
function imageCapability(value: CapabilityState | boolean): CapabilityState {
  if (value === true) return 'supported'
  if (value === false) return 'unsupported'
  return value
}

/** Name a thrown value for a failure reason. */
function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return '<unrenderable>'
  }
}

/** The codes a binding error may carry, most specific first in the report. */
const BINDING_CODES: readonly BrokerErrorCode[] = ['RECIPE_BINDING_ERROR', 'MODEL_BUDGET_EXCEEDED', 'UNSUPPORTED_MODALITY']

/**
 * The code a binding failure reports.
 *
 * The individual errors carry their own codes, and collapsing a specific one into a
 * blanket `RECIPE_BINDING_ERROR` would destroy the distinction RCP-11 exists to keep: a
 * caller that cannot tell "you sent a PDF where an image belongs" from "you misspelled a
 * field" cannot respond correctly to either. The first error is used, because that is the
 * one the caller has to fix first.
 * @param errors - the rendered binding errors.
 * @returns the code to report.
 */
function bindingCode(errors: readonly string[]): BrokerErrorCode {
  const code = errorCodeOf(errors[0] ?? '')
  return BINDING_CODES.find(candidate => candidate === code) ?? 'RECIPE_BINDING_ERROR'
}

/**
 * Build the ONE request a recipe can produce (HLM-05).
 *
 * Exported because the isolation property deserves to be checkable without a provider:
 * the request object's key set IS the claim that nothing else is sent.
 * @param recipe - the recipe being run.
 * @param values - validated bindings.
 * @param maxOutputTokens - the effective ceiling.
 * @param signal - the cancellation channel.
 * @returns the frozen request.
 */
export function buildIsolatedRequest(
  recipe: RecipeManifest,
  values: Readonly<Record<string, RecipeValue>>,
  maxOutputTokens: number,
  signal: AbortSignal,
): BrokerRequest {
  const images = imagesOf(recipe, values)
  return Object.freeze({
    prompt: renderPrompt(recipe, values),
    ...(images.length === 0
      ? {}
      : { images: Object.freeze(images.map(image => Object.freeze({ mediaType: image.mediaType, bytes: image.bytes }))) }),
    maxOutputTokens,
    signal,
    /*
     * `system` is absent, and that is the assertion: a recipe in this format cannot
     * supply a system prompt, and the parent's must not be inherited (HLM-05). A request
     * with a system member would be one built from something other than the recipe.
     */
  })
}

/** The bound images of a recipe, in declaration order. */
function imagesOf(
  recipe: RecipeManifest,
  values: Readonly<Record<string, RecipeValue>>,
): readonly RecipeImageValue[] {
  const images: RecipeImageValue[] = []
  for (const [name, declaration] of Object.entries(recipe.inputs)) {
    if (declaration.type !== 'image') continue
    const value = values[name]
    if (value !== undefined) images.push(value as RecipeImageValue)
  }
  return images
}

/**
 * The harness broker.
 *
 * One instance holds the authorizations (which tool may use which provider generation)
 * and the host policy. It is deliberately not a registry of tools: nothing here switches
 * on a tool name, which is what RCP-12 forbids and what the tests assert by running two
 * different recipes through the same code path.
 */
export class HarnessBroker {
  readonly #grants = new Map<string, ProviderGrant>()
  readonly #policy: BrokerHostPolicy
  readonly #record: BrokerRecordSink | undefined

  constructor(options: BrokerOptions = {}) {
    this.#policy = options.policy ?? INITIAL_HOST_POLICY
    this.#record = options.record
    /**
     * Refuse to exist in a state where recording would be claimed and not performed.
     *
     * The alternative — accepting the policy and journaling nothing — is the failure
     * mode HLM-09 names: a request that must be reconstructable and is not, with nothing
     * in the pipeline looking wrong.
     */
    if (this.#policy.requireRecording && this.#record === undefined) {
      throw new Error(
        'the host policy requires recording (HLM-09) but no journal sink was provided. Refusing to construct a broker '
        + 'that would report recorded requests it never recorded; pass a sink or set requireRecording to false',
      )
    }
  }

  /** The host policy in force. */
  get policy(): BrokerHostPolicy {
    return this.#policy
  }

  /**
   * Authorize a provider generation for one tool (HLM-02).
   *
   * The generation is CAPTURED here rather than read at dispatch time, so a provider that
   * reloads between authorization and dispatch stops being authorized instead of being
   * silently used under the old decision.
   * @param toolName - the tool this authorization covers.
   * @param provider - the provider.
   */
  authorize(toolName: string, provider: LlmProvider): ProviderGrant {
    const grant: ProviderGrant = { toolName, provider, generation: provider.generation }
    this.#grants.set(toolName, grant)
    return grant
  }

  /**
   * Revoke a tool's authorization.
   * @param toolName - the tool to revoke.
   * @returns whether an authorization existed.
   */
  revoke(toolName: string): boolean {
    return this.#grants.delete(toolName)
  }

  /**
   * The live authorization for a tool, or `undefined`.
   *
   * `undefined` covers both "never authorized" and "authorized for a generation this
   * provider no longer is", because from a caller's point of view both mean the same
   * thing: this invocation has no authorized executor. {@link resolveGrant} keeps the
   * two apart for the error message.
   * @param toolName - the tool to look up.
   * @returns the grant, when it is still valid.
   */
  grantFor(toolName: string): ProviderGrant | undefined {
    const resolved = this.#resolveGrant(toolName)
    return resolved.kind === 'ok' ? this.#grants.get(toolName) : undefined
  }

  /** Resolve, keeping "missing" and "stale" distinct for the refusal reason. */
  #resolveGrant(
    toolName: string,
  ):
    | { readonly kind: 'ok'; readonly provider: LlmProvider; readonly generation: number }
    | { readonly kind: 'missing' }
    | { readonly kind: 'stale'; readonly authorized: number; readonly current: number } {
    const grant = this.#grants.get(toolName)
    if (grant === undefined) return { kind: 'missing' }
    const current = grant.provider.generation
    if (current !== grant.generation) {
      return { kind: 'stale', authorized: grant.generation, current }
    }
    return { kind: 'ok', provider: grant.provider, generation: grant.generation }
  }

  /**
   * Run one recipe invocation.
   *
   * Cancellation, policy refusals and provider failures all come back as outcomes rather
   * than exceptions, so a caller that must report a result cannot lose one to an
   * unhandled rejection. Use {@link runOrThrow} where an exception is the right shape.
   * @param recipe - the recipe to run.
   * @param args - the caller's arguments, validated against the recipe's inputs.
   * @param options - the cancellation channel and deadline.
   * @returns the outcome: never a success that carries no text.
   */
  async run(recipe: RecipeManifest, args: unknown, options: RunOptions = {}): Promise<BrokerOutcome> {
    const controller = new AbortController()
    let cancelReason = 'the caller aborted the invocation'
    const caller = options.signal
    const onCallerAbort = (): void => {
      cancelReason = 'the caller aborted the invocation'
      controller.abort()
    }
    if (caller !== undefined) {
      if (caller.aborted) {
        cancelReason = 'the caller aborted the invocation before it started'
        controller.abort()
      } else {
        caller.addEventListener('abort', onCallerAbort, { once: true })
      }
    }
    const deadlineMs = options.deadlineMs
    const timer = deadlineMs === undefined
      ? undefined
      : setTimeout(() => {
        cancelReason = `the invocation deadline of ${deadlineMs}ms expired`
        controller.abort()
      }, deadlineMs)
    try {
      return await this.#invoke(recipe, args, controller.signal, () => cancelReason)
    } finally {
      // Cleaning up here is not tidiness: a listener left on a long-lived signal is a
      // leak per invocation, and a timer left running keeps the process alive.
      if (timer !== undefined) clearTimeout(timer)
      if (caller !== undefined) caller.removeEventListener('abort', onCallerAbort)
    }
  }

  /**
   * Run one recipe invocation, throwing on failure or cancellation.
   * @param recipe - the recipe to run.
   * @param args - the caller's arguments.
   * @param options - the cancellation channel and deadline.
   * @returns the completed outcome.
   * @throws BrokerError on any failure, including cancellation.
   */
  async runOrThrow(recipe: RecipeManifest, args: unknown, options: RunOptions = {}): Promise<BrokerCompletion> {
    const outcome = await this.run(recipe, args, options)
    if (outcome.kind === 'completed') return outcome
    if (outcome.kind === 'cancelled') throw new BrokerError('CANCELLED', outcome.reason)
    throw new BrokerError(outcome.code, outcome.reason)
  }

  /** The invocation itself: checks in the order they must happen, then one dispatch. */
  async #invoke(
    recipe: RecipeManifest,
    args: unknown,
    signal: AbortSignal,
    reason: () => string,
  ): Promise<BrokerOutcome> {
    // Cancellation first: a cancelled call must not do any of the work below, and the
    // provider must not be called at all.
    if (signal.aborted) return { kind: 'cancelled', reason: reason() }

    const binding = validateRecipeInputs(recipe, args)
    if (!binding.ok) {
      return { kind: 'failed', code: bindingCode(binding.errors), reason: binding.errors.join('; ') }
    }

    const resolved = this.#resolveGrant(recipe.tool.name)
    if (resolved.kind === 'missing') {
      return {
        kind: 'failed',
        code: 'EXECUTOR_NOT_CONFIGURED',
        reason: `no executor is authorized for ${recipe.tool.name}. A recipe is a request for a host-approved harness `
          + 'model, not an authorization to reach one (RCP-05)',
      }
    }
    if (resolved.kind === 'stale') {
      return {
        kind: 'failed',
        code: 'EXECUTOR_NOT_CONFIGURED',
        reason: `the authorization for ${recipe.tool.name} covers provider generation ${resolved.authorized}, but the `
          + `provider now reports generation ${resolved.current}. An authorization is for a generation, not for a `
          + 'name: re-authorize it rather than running new endpoint code under the old decision (HLM-02)',
      }
    }

    const provider = resolved.provider
    /**
     * ONE capability snapshot per invocation.
     *
     * Reading capabilities again after the call, or per check, is how one model's facts
     * end up combined with another endpoint's after a concurrent switch (HLM-02).
     */
    const capabilities = provider.capabilities()
    const values = binding.values
    const images = imagesOf(recipe, values)

    if (images.length > 0) {
      const imagesCapability = imageCapability(capabilities.images)
      if (imagesCapability === 'unsupported') {
        return {
          kind: 'failed',
          code: 'IMAGE_INPUT_UNAVAILABLE',
          reason: `${recipe.tool.name} binds ${images.length} image input(s) but provider "${provider.id}" reports no `
            + 'image support. Refusing rather than sending the text alone: a model asked to describe an image it never '
            + 'received produces a fluent invention, and that is worse than an error (HLM-11)',
        }
      }
      if (imagesCapability === 'unknown') {
        return {
          kind: 'failed',
          code: 'EXECUTOR_CAPABILITY_UNKNOWN',
          reason: `provider "${provider.id}" has not reported whether it accepts images, and ${recipe.tool.name} binds `
            + 'an image input. An unevaluated capability is not a capability: refusing rather than assuming it '
            + '(MODEL-06)',
        }
      }
    }

    /**
     * The image ceiling is the INTERSECTION of every limit (HLM-07, RES-10).
     *
     * A narrowed host policy must be able to refuse images a recipe permits, which is
     * the only direction a limit may move.
     */
    const imageCeiling = Math.min(recipe.imageInputs.max, this.#policy.imageInputs, INITIAL_MAX_IMAGE_INPUTS)
    if (images.length > imageCeiling) {
      return {
        kind: 'failed',
        code: 'MODEL_BUDGET_EXCEEDED',
        reason: `${images.length} image input(s) supplied against an effective ceiling of ${imageCeiling} (recipe `
          + `${recipe.imageInputs.max}, host ${this.#policy.imageInputs}, RES-10 ${INITIAL_MAX_IMAGE_INPUTS})`,
      }
    }

    if (!permitsDestination(this.#policy, provider.destination)) {
      return {
        kind: 'failed',
        code: 'EXECUTOR_NOT_CONFIGURED',
        reason: `provider "${provider.id}" is a ${provider.destination} destination and the policy in force permits `
          + 'local destinations only. A local-only profile prohibits remote destinations however the tool was built, '
          + 'so this is refused rather than routed (RES-10)',
      }
    }

    const maxOutputTokens = Math.min(recipe.maxOutputTokens, this.#policy.outputTokens, capabilities.maxOutputTokens)
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
      return {
        kind: 'failed',
        code: 'MODEL_BUDGET_EXCEEDED',
        reason: `the effective output-token ceiling is ${maxOutputTokens} (recipe ${recipe.maxOutputTokens}, host `
          + `${this.#policy.outputTokens}, provider ${capabilities.maxOutputTokens}). A call permitted to produce `
          + 'nothing cannot produce a result (RES-10)',
      }
    }

    /**
     * Recording is settled BEFORE dispatch.
     *
     * HLM-09: if mandatory recording conflicts with policy, refuse rather than silently
     * drop it. Refusing here means no provider is called, so a refused invocation is not
     * a billed one.
     */
    if (!recipe.policy.record && this.#policy.requireRecording) {
      return {
        kind: 'failed',
        code: 'CAPTURE_POLICY_CONFLICT',
        reason: `${recipe.tool.name} declares record: false while the host requires the prepared request to be `
          + 'journaled. Refusing rather than running unrecorded: a request that must be reconstructable and is not is '
          + 'the failure HLM-09 names, and it leaves nothing in the pipeline looking wrong',
      }
    }

    let recorded = false
    /**
     * The request is built BEFORE the journal entry, and the entry quotes THAT request.
     *
     * HLM-09 asks the journal to record the exact prepared request. Rendering the prompt
     * separately for the entry would make the record a second rendering that merely ought
     * to agree with the one that was sent; quoting the request's own prompt makes the two
     * the same string by construction.
     */
    const request = buildIsolatedRequest(recipe, values, maxOutputTokens, signal)
    if (recipe.policy.record) {
      const sink = this.#record
      if (sink === undefined) {
        return {
          kind: 'failed',
          code: 'CAPTURE_POLICY_CONFLICT',
          reason: 'recording is required but no journal sink is configured, so the prepared request would be lost',
        }
      }
      const entry: BrokerRecord = {
        kind: 'harness-model-auxiliary-call',
        toolName: recipe.tool.name,
        contractId: recipe.tool.contractId,
        recipeId: recipe.id,
        recipeVersion: recipe.version,
        providerId: provider.id,
        providerGeneration: resolved.generation,
        destination: provider.destination,
        maxOutputTokens,
        imageCount: images.length,
        prompt: request.prompt,
        context: 'recipe-only',
      }
      try {
        await sink(entry)
        recorded = true
      } catch (error) {
        return {
          kind: 'failed',
          code: 'RECORDING_FAILED',
          reason: `the auxiliary-call journal rejected the entry (${messageOf(error)}), so the call did not run. A call `
            + 'whose record cannot be written is not one this broker will make',
        }
      }
    }

    const dispatched = await dispatch(provider, request, signal, reason)

    if (dispatched.kind === 'cancelled') return { kind: 'cancelled', reason: dispatched.reason }
    if (dispatched.kind === 'failed') {
      return { kind: 'failed', code: 'PROVIDER_FAILED', reason: dispatched.reason }
    }

    /**
     * A signal aborted while the provider was working is a cancellation, whatever came
     * back.
     *
     * Checking after the await is the difference between "we stopped asking" and "we
     * stopped caring": the caller cancelled, so a result that arrived afterwards is not
     * one it asked for, and reporting it as a success would attach an answer to a
     * cancelled invocation (HLM-10).
     */
    if (signal.aborted) {
      return { kind: 'cancelled', reason: `${reason()}; the provider's result was discarded rather than reported` }
    }

    /**
     * The generation is rechecked when the call returns, and a change makes the result
     * UNATTRIBUTABLE.
     *
     * HLM-02 forbids combining one model's capability facts with another endpoint, and a
     * provider that reloads while the call is in flight leaves the broker holding a result
     * it cannot honestly attribute to either generation. Reporting it under the resolved
     * generation would be a receipt claiming provenance the broker does not have.
     */
    if (provider.generation !== resolved.generation) {
      return {
        kind: 'failed',
        code: 'PROVIDER_FAILED',
        reason: `provider "${provider.id}" changed generation from ${resolved.generation} to ${provider.generation} `
          + 'while the call was in flight, so the result cannot be attributed to the endpoint this invocation '
          + 'resolved. Refusing rather than reporting it under either generation (HLM-02)',
      }
    }

    const completion = dispatched.completion
    const identity = {
      provider: { id: provider.id, generation: resolved.generation, destination: provider.destination },
      recipe: {
        id: recipe.id,
        version: recipe.version,
        toolName: recipe.tool.name,
        contractId: recipe.tool.contractId,
      },
    }

    switch (completion.kind) {
      case 'refused':
        return {
          kind: 'failed',
          code: 'MODEL_REFUSED',
          reason: `the model declined: ${completion.reason}. A refusal is an error and never an empty result, because a `
            + 'caller writing an empty result into a document sees a blank field rather than a failure',
        }
      case 'truncated':
        return {
          kind: 'failed',
          code: 'MODEL_OUTPUT_TRUNCATED',
          reason: 'the generation was cut short, so no complete result was produced. Partial prose is not a successful '
            + 'result (HLM-07)',
        }
      case 'tool_call':
        return {
          kind: 'failed',
          code: 'UNEXPECTED_MODEL_TOOL_CALL',
          reason: `the provider emitted a tool call for "${completion.toolName}". No tool catalog was supplied, so a `
            + 'tool call is not executed and no agent loop continues from it (HLM-06)',
        }
      case 'text': {
        if (completion.text.trim().length === 0) {
          return {
            kind: 'failed',
            code: 'INVALID_MODEL_OUTPUT',
            reason: 'the provider returned empty text. An empty completion is not a result: reporting it as one '
              + 'produces an empty title, an empty description and no error anywhere',
          }
        }
        return {
          kind: 'completed',
          text: completion.text,
          usage: completion.usage ?? {
            known: false,
            reason: 'the provider reported no usage for this call',
          },
          recorded,
          ...identity,
        }
      }
    }
  }
}

/**
 * Dispatch one call, honouring cancellation and turning a provider throw into a failure.
 * @param provider - the provider.
 * @param request - the isolated request.
 * @param signal - the cancellation channel.
 * @param reason - reads the current cancellation reason.
 * @returns how the dispatch settled.
 */
async function dispatch(
  provider: LlmProvider,
  request: BrokerRequest,
  signal: AbortSignal,
  reason: () => string,
): Promise<Dispatch> {
  if (signal.aborted) return { kind: 'cancelled', reason: reason() }
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<Dispatch>((resolve) => {
    onAbort = () => resolve({ kind: 'cancelled', reason: reason() })
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([
      provider.complete(request).then(
        (completion): Dispatch => ({ kind: 'completion', completion }),
        // The provider's own rejection is handled here rather than escaping as an
        // unhandled rejection after a cancellation already won the race.
        (error: unknown): Dispatch => ({ kind: 'failed', reason: `provider "${provider.id}" failed: ${messageOf(error)}` }),
      ),
      cancelled,
    ])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}
