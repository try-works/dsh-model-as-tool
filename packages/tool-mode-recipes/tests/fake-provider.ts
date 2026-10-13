/**
 * A deterministic FAKE provider, and the small fixtures the tests share.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT.
 *
 * These tests are the ones the directive asks for: "fake-provider tests prove request
 * shape, image transport and policy". A fake provider can prove exactly that — what the
 * broker sent, what it did NOT send, which refusals happened before any call, and what
 * the broker reported back. It CANNOT prove anything about model quality, and no test in
 * this package claims to: a scripted completion is a fixture, not a model result. Any
 * statement about real titles, real descriptions or real images needs a real provider
 * with recorded evidence, which is a different exercise.
 *
 * The provider records the request it received AND a faithful translation of that request
 * into the wire shape a vendor adapter would build (`messages`, one per call), because the
 * isolation invariant (HLM-05) is a claim about the REQUEST: one user message, no tool
 * list, no history, no parent system prompt.
 */

import type {
  BrokerRecord,
  BrokerRequest,
  CapabilityState,
  LlmCompletion,
  LlmProvider,
  ProviderDestination,
} from '../src/broker.ts'
import { parseRecipe, type ParseRecipeOptions, type RecipeManifest } from '../src/recipe-format.ts'

/** One part of a wire message. */
export type WirePart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: string; readonly bytes: Uint8Array }

/** One wire message. */
export interface WireMessage {
  /** Always `user`: a recipe request has no other role, and no assistant history. */
  readonly role: 'user'
  /** The text part, plus one part per typed image. */
  readonly content: readonly WirePart[]
}

/** What a vendor adapter would build from the broker request. */
export interface WireRequest {
  /** Exactly one message. */
  readonly messages: readonly WireMessage[]
  /** The effective token ceiling. */
  readonly maxTokens: number
}

/**
 * Translate a broker request into the wire shape (fake-provider side).
 *
 * The translation is deliberately written the way an adapter would write it — prompt
 * first, then the typed images — so that "one message, no tools" is a statement about the
 * request rather than about this function's opinion.
 * @param request - the broker request.
 * @returns the wire request.
 */
export function toWire(request: BrokerRequest): WireRequest {
  const content: WirePart[] = [{ type: 'text', text: request.prompt }]
  for (const image of request.images ?? []) {
    content.push({ type: 'image', mediaType: image.mediaType, bytes: image.bytes })
  }
  return { messages: [{ role: 'user', content }], maxTokens: request.maxOutputTokens }
}

/** Options for {@link FakeProvider}. */
export interface FakeProviderOptions {
  /** The provider id. Defaults to `fake-provider`. */
  readonly id?: string
  /** Where the provider runs. Defaults to `local`. */
  readonly destination?: ProviderDestination
  /** The adapter generation. Defaults to 1. */
  readonly generation?: number
  /** The image capability. Defaults to `unsupported`. */
  readonly images?: CapabilityState | boolean
  /** The provider's own output-token ceiling. Defaults to 1024. */
  readonly maxOutputTokens?: number
  /** Completions returned in call order; the last one repeats. */
  readonly completions?: readonly LlmCompletion[]
  /**
   * Runs inside `complete()`, before the scripted completion is returned.
   *
   * This is how a test schedules the things that happen DURING a call: an abort, a second
   * call, a capability change, or a look at what was journaled before dispatch.
   */
  readonly onComplete?: (request: BrokerRequest, provider: FakeProvider) => void | Promise<void>
  /** Reject instead of returning a completion, to simulate a transport failure. */
  readonly fail?: string
}

/**
 * A provider that records what it received.
 *
 * It is not a mock of a vendor: it has no vendor. That is the point of the broker's
 * provider interface, and this class is the smallest thing that satisfies it.
 */
export class FakeProvider implements LlmProvider {
  readonly id: string
  readonly destination: ProviderDestination
  /** Mutable so a test can simulate an adapter reload between authorization and dispatch. */
  generation: number
  /** Every request received, in order. */
  readonly requests: BrokerRequest[] = []
  /** Every request, as the wire shape. */
  readonly wire: WireRequest[] = []
  /** The signal each request carried, for cancellation assertions. */
  readonly signals: AbortSignal[] = []
  readonly #options: FakeProviderOptions

  constructor(options: FakeProviderOptions = {}) {
    this.#options = options
    this.id = options.id ?? 'fake-provider'
    this.destination = options.destination ?? 'local'
    this.generation = options.generation ?? 1
  }

  /** What the provider reports about itself. */
  capabilities(): { readonly images: CapabilityState | boolean; readonly maxOutputTokens: number } {
    return {
      images: this.#options.images ?? 'unsupported',
      maxOutputTokens: this.#options.maxOutputTokens ?? 1024,
    }
  }

  /** How many times `complete` was entered. */
  get calls(): number {
    return this.requests.length
  }

  /** Perform one call, recording it first so a test can see a call that was cancelled. */
  async complete(request: BrokerRequest): Promise<LlmCompletion> {
    this.requests.push(request)
    this.wire.push(toWire(request))
    this.signals.push(request.signal)
    await this.#options.onComplete?.(request, this)
    if (this.#options.fail !== undefined) throw new Error(this.#options.fail)
    const script = this.#options.completions ?? [{ kind: 'text', text: 'ok' }]
    const index = Math.min(this.calls - 1, script.length - 1)
    const completion = script[index]
    if (completion === undefined) throw new Error('the fake provider has no scripted completion')
    return completion
  }
}

/** A journal sink plus the entries it received. */
export interface RecordCollector {
  /** The entries written, in order. */
  readonly entries: BrokerRecord[]
  /** The sink to hand to the broker. */
  readonly sink: (entry: BrokerRecord) => void
}

/**
 * Collect journal entries.
 * @returns the collector.
 */
export function recordCollector(): RecordCollector {
  const entries: BrokerRecord[] = []
  return { entries, sink: entry => { entries.push(entry) } }
}

/**
 * Parse a test recipe, failing loudly: a fixture that does not validate would make every
 * assertion about it meaningless.
 * @param raw - the raw recipe.
 * @param options - the expected tool identity.
 * @returns the parsed recipe.
 */
export function mustRecipe(raw: Record<string, unknown>, options?: ParseRecipeOptions): RecipeManifest {
  const parsed = parseRecipe(raw, options ?? {})
  if (!parsed.ok) throw new Error(`the test recipe does not validate: ${parsed.errors.join('; ')}`)
  return parsed.recipe
}

/** Source text with no numbers in it, so the invented-number rule is testable both ways. */
export const SOURCE_TEXT =
  'This section explains how to configure the deployment pipeline for staging and production.'

/** A response the TOOL-06 rules accept, as the model would return it. */
export const ACCEPTED_TITLE_JSON = JSON.stringify({
  title: 'Deployment pipeline configuration',
  description: 'How to configure the deployment pipeline for staging and production.',
})

/**
 * Image bytes with a recognizable ASCII marker.
 *
 * The marker is what makes "the bytes were transported, and the bytes were NOT pasted into
 * the prompt" checkable: the prompt is searched for the marker and must not contain it.
 * @param marker - the ASCII marker to embed.
 * @returns the bytes.
 */
export function imageBytes(marker = 'FAKE-IMAGE-BYTES'): Uint8Array {
  return new TextEncoder().encode(`\x89PNG\r\n\x1a\n${marker}`)
}

/** A typed image binding for a test. */
export function typedImage(marker = 'FAKE-IMAGE-BYTES'): { mediaType: string; bytes: Uint8Array } {
  return { mediaType: 'image/png', bytes: imageBytes(marker) }
}
