/**
 * A REAL DSH-backed {@link LlmProvider} for the harness broker (HLM-01).
 *
 * The broker has been tested only against fake providers; this adapter runs a
 * recipe through the DSH harness's ACTUAL LLM service — `ctx.llm`
 * (`@deepseek-ai/dsh-llm`'s `LlmRuntime`): `resolveModelInfo` for the model's
 * own capability descriptors and `stream` for the chunk stream, including the
 * `llm/stream` waterfall. The recipes package still ships NO import of the DSH
 * packages: the surface below is a STRUCTURAL MIRROR of the DSH vocabulary,
 * declared here so the published package stays dependency-free, and the
 * conformance is proven in tests/dsh-adapter.test.ts by running the adapter
 * through the REAL LlmRuntime with a registered LlmAdapter subclass.
 *
 * The mirrored DSH vocabulary (node_modules/@deepseek-ai/dsh-llm/src/types.ts):
 * - `DshModelDescriptor` mirrors `LlmResolvedModelInfo` (types.ts:410-421):
 *   `inputModalities`, `context.contextWindow`, `defaultMaxTokens`.
 * - `DshContentPart` mirrors `ContentBlock`'s text/image members (types.ts:62-89):
 *   text carries `{ type: 'text', text }`; images are `{ type: 'image',
 *   attachment }` — an ATTACHMENT REFERENCE owned by DSH's attachment service,
 *   which a recipes-only package cannot mint. Images therefore travel only
 *   through the deployment-supplied `images` hook (see below).
 * - `DshCompletionRequest` mirrors the consumed subset of `GenerateOptions`
 *   (types.ts:511-553): provider/model/messages/maxTokens/signal.
 * - `DshStreamChunk` mirrors `StreamChunk` (types.ts:452-464): text-delta,
 *   tool-call-delta, usage, finish; block-start/block-end/reasoning-delta are
 *   admitted as ignored passthroughs. `finish.reason.kind` mirrors
 *   `FinishReasonMap` (types.ts:156-162): stop, tool-calls, max-tokens,
 *   aborted{ failure }, error{ failure }.
 *
 * Mappings to the broker's vocabulary (RCP-11):
 * - text-delta accumulation + finish `stop`        -> { kind: 'text', text, usage }
 * - finish `max-tokens`                            -> { kind: 'truncated', text }
 * - finish `tool-calls` (or a tool-call-delta)     -> { kind: 'tool_call', toolName }
 *   — NEVER executed (HLM-06); the broker refuses it as UNEXPECTED_MODEL_TOOL_CALL
 * - finish `aborted`                               -> thrown; the broker reports CANCELLED
 *   when the caller's signal aborted, PROVIDER_FAILED otherwise
 * - finish `error` / an unknown finish             -> thrown with the failure facts; the
 *   broker reports PROVIDER_FAILED
 *
 * HLM-02: the provider carries a GENERATION. A deployment wires the generation
 * to its adapter registration (or reload count), so an authorization issued
 * against an old adapter cannot be satisfied by a new one.
 *
 * Capabilities are READ from the model descriptor, never hardcoded: an
 * explicit `inputModalities` omission is negative capability (`images:
 * 'unsupported'`), an absent descriptor field is the honest `unknown`, and a
 * declared `image` modality is `supported` ONLY when the deployment also
 * supplied the `images` transport hook — a model that can see images but has
 * no transport for them must not have them silently dropped.
 *
 * @module @try-works/tool-mode-recipes/dsh-adapter
 */

import type { ProviderDestination } from './broker.ts'
import { INITIAL_MAX_OUTPUT_TOKENS } from './recipe-format.ts'
import type { BrokerImage, BrokerRequest, CapabilityState, LlmCompletion, LlmProvider, LlmUsage, ProviderCapabilities } from './broker.ts'

/** The model descriptor this adapter reads capabilities from (mirrors `LlmResolvedModelInfo`). */
export interface DshModelDescriptor {
  /** The owning provider route; must equal the provider this adapter was built for. */
  readonly provider: string
  /** The exact model id. */
  readonly id: string
  /** Human-readable name. */
  readonly name: string
  /** Accepted input modalities; absent means unknown, an explicit omission is negative capability. */
  readonly inputModalities?: readonly ('text' | 'image')[]
  /** Provider-owned context capacity, when known. */
  readonly context?: { readonly contextWindow: number }
  /** Adapter-configured per-request output cap materialized when callers omit one. */
  readonly defaultMaxTokens?: number
}

/** A text part of a user message (mirrors `TextBlock`). */
export interface DshTextPart {
  readonly type: 'text'
  readonly text: string
}

/**
 * An image part of a user message (mirrors `ImageBlock`).
 *
 * The attachment reference is OPAQUE here: it is minted by DSH's attachment
 * service, which the recipes package cannot reach. The deployment supplies the
 * bytes-to-part transport (see {@link DshImageTransport}); this type merely
 * says what the transport must produce.
 */
export interface DshImagePart {
  readonly type: 'image'
  readonly attachment: unknown
}

/** One content part, text or image. */
export type DshContentPart = DshTextPart | DshImagePart

/** One user message in a completion request (mirrors `RequestUserInput`). */
export interface DshUserMessage {
  readonly role: 'user'
  readonly content: readonly DshContentPart[]
}

/** The completion request (mirrors the consumed subset of `GenerateOptions`). */
export interface DshCompletionRequest {
  readonly provider: string
  readonly model: string
  /** Exactly the messages the adapter sends: one user message per recipe call. */
  readonly messages: readonly DshUserMessage[]
  readonly maxTokens?: number
  readonly signal?: AbortSignal
}

/** The failure facts a terminal chunk carries (mirrors `LlmFailure`). */
export interface DshFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
}

/** The terminal finish reason (mirrors `FinishReasonMap`, with an unknown-kind catch-all). */
export type DshFinishReason =
  | { readonly kind: 'stop' }
  | { readonly kind: 'tool-calls' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'aborted'; readonly failure: DshFailure }
  | { readonly kind: 'error'; readonly failure: DshFailure }
  | { readonly kind: string }

/** The stream chunk vocabulary (mirrors `StreamChunk`; passthrough members are ignored). */
export type DshStreamChunk =
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'tool-call-delta'; readonly index: number; readonly name?: string; readonly argumentsDelta: string }
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: string }
  | { readonly type: 'block-end'; readonly index: number; readonly block: unknown }
  | { readonly type: 'usage'; readonly usage: { readonly inputTokens: number; readonly outputTokens: number } }
  | { readonly type: 'finish'; readonly reason: DshFinishReason }

/**
 * The DSH LLM surface this adapter consumes.
 *
 * `ctx.llm` (an `LlmRuntime`) satisfies this structurally; the conformance
 * test proves it by driving a REAL LlmRuntime through this interface. The
 * declared property-style functions keep the check contravariant, so an
 * incompatible DSH version fails to type, not fails at runtime.
 */
export interface DshLlmSurface {
  /** Resolve one exact model's descriptor (mirrors `LlmRuntime.resolveModelInfo`). */
  readonly resolveModelInfo: (
    provider: string,
    model: string,
    signal?: AbortSignal,
  ) => Promise<DshModelDescriptor>
  /** Stream one call (mirrors `LlmRuntime.stream`). */
  readonly stream: (request: DshCompletionRequest) => AsyncIterable<DshStreamChunk>
}

/**
 * The deployment-supplied image transport (HLM-11).
 *
 * A recipes-only package cannot mint DSH attachment references, so the
 * deployment supplies this hook (in the host: reach `ctx.get('attachments')`
 * and mint the reference there). Without the hook an image-capable model
 * reports `images: 'unknown'`, and the broker refuses image recipes with
 * EXECUTOR_CAPABILITY_UNKNOWN instead of dropping the image silently.
 */
export type DshImageTransport = (
  image: BrokerImage,
) => DshImagePart | Promise<DshImagePart>

/** Options for {@link DshLlmProvider.create}. */
export interface DshProviderOptions {
  /** The DSH LLM surface (the deployment's `ctx.llm`, or a test double). */
  readonly llm: DshLlmSurface
  /** The registered adapter route, e.g. `deepseek`. */
  readonly provider: string
  /** The exact model id the recipes run against. */
  readonly model: string
  /** Where this provider runs; defaults to `remote` (a harness model is not local). */
  readonly destination?: ProviderDestination
  /**
   * The adapter generation (HLM-02). The deployment should tie this to its DSH
   * adapter registration so an old authorization cannot ride a new adapter.
   * Defaults to 1.
   */
  readonly generation?: number
  /** The image transport hook; without it images are `unknown`, never dropped. */
  readonly images?: DshImageTransport
}

/**
 * A DSH-backed {@link LlmProvider}, built against a resolved model descriptor.
 */
export class DshLlmProvider implements LlmProvider {
  readonly id: string
  readonly generation: number
  readonly destination: ProviderDestination
  readonly #llm: DshLlmSurface
  readonly #provider: string
  readonly #model: string
  readonly #images: DshImageTransport | undefined
  /** The frozen capability facts, derived from the descriptor at creation. */
  readonly #capabilities: ProviderCapabilities

  private constructor(options: DshProviderOptions, descriptor: DshModelDescriptor) {
    this.id = `dsh:${options.provider}/${options.model}`
    this.generation = options.generation ?? 1
    this.destination = options.destination ?? 'remote'
    this.#llm = options.llm
    this.#provider = options.provider
    this.#model = options.model
    this.#images = options.images

    // Capabilities are READ from the model's own descriptor, never hardcoded
    // (HLM-02's capability half): an explicit modality omission is negative
    // capability, an absent descriptor field is the honest `unknown`, and an
    // image-capable model without a transport hook is `unknown` rather than a
    // promise the transport cannot keep.
    const declared = descriptor.inputModalities
    const images: CapabilityState = declared === undefined
      ? 'unknown'
      : declared.includes('image')
        ? this.#images === undefined ? 'unknown' : 'supported'
        : 'unsupported'
    this.#capabilities = Object.freeze({
      images,
      // The model's own per-request output default; the RES-10 ceiling is the
      // fallback for a descriptor that discloses none.
      maxOutputTokens: descriptor.defaultMaxTokens ?? INITIAL_MAX_OUTPUT_TOKENS,
    })
  }

  /**
   * Resolve the model descriptor and build the provider (HLM-02).
   *
   * The descriptor is resolved ONCE, at creation: capabilities are the model
   * facts as of this generation, not whatever the endpoint happens to report
   * mid-run.
   * @param options - the surface, route, model and transports.
   * @returns the provider.
   * @throws when the descriptor cannot be resolved or names another route.
   */
  static async create(options: DshProviderOptions): Promise<DshLlmProvider> {
    const descriptor = await options.llm.resolveModelInfo(options.provider, options.model)
    if (descriptor.provider !== options.provider || descriptor.id !== options.model) {
      throw new Error(
        `the DSH surface resolved ${descriptor.provider}/${descriptor.id}, not the requested `
        + `${options.provider}/${options.model}; capabilities would be read from the wrong model`,
      )
    }
    return new DshLlmProvider(options, descriptor)
  }

  /** The frozen descriptor-derived facts. */
  capabilities(): ProviderCapabilities {
    return this.#capabilities
  }

  /**
   * Perform one isolated call through the DSH stream.
   *
   * The request is one user message — the rendered prompt plus one attachment
   * part per bound image via the transport hook — with no system prompt, no
   * tools and no history, exactly as the broker's isolation invariant requires
   * (HLM-05). Chunks are assembled per block index; the terminal finish maps
   * to the broker's completion vocabulary.
   * @param request - the broker request.
   * @returns the completion.
   */
  async complete(request: BrokerRequest): Promise<LlmCompletion> {
    const content: DshContentPart[] = [{ type: 'text', text: request.prompt }]
    if (request.images !== undefined && request.images.length > 0) {
      if (this.#images === undefined) {
        // Unreachable through the broker (capabilities say 'unknown'), but a
        // caller bypassing the preflight must not silently drop the image.
        throw new Error('the DSH provider has no image transport; the image inputs were not sent')
      }
      for (const image of request.images) {
        content.push(await this.#images(image))
      }
    }

    const text = new Map<number, string>()
    let toolName: string | undefined
    let usage: LlmUsage | undefined
    for await (const chunk of this.#llm.stream({
      provider: this.#provider,
      model: this.#model,
      messages: [{ role: 'user', content }],
      maxTokens: request.maxOutputTokens,
      signal: request.signal,
    })) {
      switch (chunk.type) {
        case 'text-delta': {
          text.set(chunk.index, (text.get(chunk.index) ?? '') + chunk.text)
          break
        }
        case 'tool-call-delta': {
          toolName = chunk.name ?? toolName
          break
        }
        case 'usage': {
          usage = { known: true, inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens }
          break
        }
        case 'finish': {
          const assembled = [...text.entries()].sort((left, right) => left[0] - right[0]).map(([, value]) => value).join('')
          switch (chunk.reason.kind) {
            case 'stop': {
              return { kind: 'text', text: assembled, ...usage === undefined ? {} : { usage } }
            }
            case 'max-tokens': {
              // Generation was cut short: an error, never a short result.
              return { kind: 'truncated', text: assembled }
            }
            case 'tool-calls': {
              // HLM-06: a tool call from a recipe model is never executed.
              return { kind: 'tool_call', toolName: toolName ?? '(unnamed)' }
            }
            case 'aborted':
            case 'error': {
              // The catch-all union member (unknown adapter-specific kinds)
              // keeps TS from narrowing failure onto these literal cases, so
              // the fact is read defensively: the core DSH vocabulary always
              // carries it for aborted/error (types.ts:160-161).
              const failure = (chunk.reason as { readonly failure?: DshFailure }).failure
              const summary = `${failure?.message ?? 'no message'} (${failure?.code ?? 'UNKNOWN'})`
              throw new Error(`the DSH stream ${chunk.reason.kind === 'aborted' ? 'aborted' : 'failed'} the call: ${summary}`)
            }
            default: {
              throw new Error(`the DSH stream finished with an unknown reason ${JSON.stringify(chunk.reason.kind)}`)
            }
          }
        }
        default: {
          // block-start, block-end, reasoning-delta: assembly metadata, not content.
          break
        }
      }
    }
    // The stream ended without a finish chunk: a broken transport, not a result.
    throw new Error('the DSH stream ended without a finish chunk')
  }
}
