/**
 * The DSH-backed LlmProvider adapter (HLM-01's "real DSH LLM service" wiring).
 *
 * Two surfaces, and every test NAMES which one it ran against:
 *
 * - the DETERMINISTIC STUB surface (tests below the fold): a hand-built
 *   {@link DshLlmSurface} streaming scripted chunks — proves the adapter's own
 *   logic (capability derivation, chunk assembly, finish mapping) offline.
 * - the REAL DSH surface (guarded by a dynamic load): the actual
 *   `@deepseek-ai/dsh-llm` LlmRuntime with a scripted LlmAdapter subclass
 *   registered through `ctx.llm.registerAdapter`, so the adapter runs through
 *   the REAL stream machinery (`prepareCall`/`resolveModelInfo`/`llm/stream`
 *   waterfall) while the MODEL remains a deterministic script. When the DSH
 *   packages do not resolve (no link:dsh), those tests SKIP and say so — the
 *   same discipline as ptc-composition.test.ts.
 *
 * Requirement links: HLM-01, HLM-02, HLM-05, HLM-06, HLM-11, RCP-11.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { DshLlmProvider, type DshLlmSurface, type DshStreamChunk, type DshModelDescriptor } from '../src/dsh-adapter.ts'
import { HarnessBroker, TEXT_TITLE_RECIPE, TEXT_TITLE_TOOL } from '../src/index.ts'
import { parseTitleResponse } from '../src/titles.ts'
import { ACCEPTED_TITLE_JSON, SOURCE_TEXT, recordCollector, typedImage } from './fake-provider.ts'

// ---------------------------------------------------------------------------
// The deterministic stub surface.
// ---------------------------------------------------------------------------

/** Options for the scripted stub surface. */
interface StubSurfaceOptions {
  readonly descriptor: DshModelDescriptor
  /** Chunks streamed per call, in order. */
  readonly chunks?: readonly DshStreamChunk[]
  /** Thrown instead of streaming, to simulate a transport failure. */
  readonly fail?: string
  /** Records every completion request received. */
  readonly received?: { provider: string; model: string; messages: unknown; maxTokens?: number }[]
}

/** A hand-built DSH surface, streaming exactly the scripted chunks. */
function stubSurface(options: StubSurfaceOptions): DshLlmSurface {
  return {
    resolveModelInfo: async () => options.descriptor,
    stream: async function* (request) {
      options.received?.push({
        provider: request.provider,
        model: request.model,
        messages: request.messages,
        ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
      })
      if (options.fail !== undefined) throw new Error(options.fail)
      for (const chunk of options.chunks ?? []) yield chunk
    },
  }
}

const TEXT_MODEL: DshModelDescriptor = {
  provider: 'deepseek',
  id: 'deepseek-chat',
  name: 'DeepSeek Chat',
  inputModalities: ['text'],
  defaultMaxTokens: 4096,
}

const IMAGE_MODEL: DshModelDescriptor = {
  provider: 'deepseek',
  id: 'vision-model',
  name: 'Vision Model',
  inputModalities: ['text', 'image'],
  defaultMaxTokens: 2048,
}

/** A stop-finish stream producing one text block. */
function textStream(text: string, usage?: { inputTokens: number; outputTokens: number }): DshStreamChunk[] {
  return [
    { type: 'text-delta', index: 0, text },
    ...usage === undefined ? [] : [{ type: 'usage' as const, usage }],
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

describe('HLM-02 — capabilities are READ from the model descriptor, never hardcoded (stub DSH surface)', () => {
  it('a text-only descriptor reports images unsupported', async () => {
    const provider = await DshLlmProvider.create({ llm: stubSurface({ descriptor: TEXT_MODEL }), provider: 'deepseek', model: 'deepseek-chat' })
    assert.deepEqual(provider.capabilities(), { images: 'unsupported', maxOutputTokens: 4096 })
  })

  it('an image-capable descriptor WITHOUT a transport hook reports unknown, never a silent drop', async () => {
    const provider = await DshLlmProvider.create({ llm: stubSurface({ descriptor: IMAGE_MODEL }), provider: 'deepseek', model: 'vision-model' })
    assert.deepEqual(provider.capabilities(), { images: 'unknown', maxOutputTokens: 2048 })
  })

  it('an image-capable descriptor WITH a transport hook reports supported', async () => {
    const provider = await DshLlmProvider.create({
      llm: stubSurface({ descriptor: IMAGE_MODEL }),
      provider: 'deepseek',
      model: 'vision-model',
      images: image => ({ type: 'image', attachment: { mediaType: image.mediaType, byteLength: image.bytes.byteLength } }),
    })
    assert.deepEqual(provider.capabilities(), { images: 'supported', maxOutputTokens: 2048 })
  })

  it('a descriptor disclosing no modalities reports unknown, and the RES-10 ceiling fills a missing default', async () => {
    const provider = await DshLlmProvider.create({
      llm: stubSurface({ descriptor: { provider: 'deepseek', id: 'mystery', name: 'Mystery' } }),
      provider: 'deepseek',
      model: 'mystery',
    })
    assert.deepEqual(provider.capabilities(), { images: 'unknown', maxOutputTokens: 1024 })
  })

  it('refuses to build over a descriptor for another route/model', async () => {
    await assert.rejects(
      DshLlmProvider.create({
        llm: stubSurface({ descriptor: TEXT_MODEL }),
        provider: 'deepseek',
        model: 'a-different-model',
      }),
      /wrong model/,
    )
  })
})

describe('HLM-01 — the stub surface exercises every completion mapping', () => {
  it('assembles text deltas across blocks and carries usage through', async () => {
    const provider = await DshLlmProvider.create({ llm: stubSurface({
      descriptor: TEXT_MODEL,
      chunks: [
        { type: 'text-delta', index: 1, text: 'first ' },
        { type: 'text-delta', index: 0, text: 'second' },
        { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    }), provider: 'deepseek', model: 'deepseek-chat' })
    const completion = await provider.complete({ prompt: 'hi', maxOutputTokens: 100, signal: new AbortController().signal })
    assert.deepEqual(completion, { kind: 'text', text: 'secondfirst ', usage: { known: true, inputTokens: 12, outputTokens: 3 } })
  })

  it('maps a max-tokens finish to truncated, never a short result', async () => {
    const provider = await DshLlmProvider.create({ llm: stubSurface({
      descriptor: TEXT_MODEL,
      chunks: [
        { type: 'text-delta', index: 0, text: 'cut off' },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ],
    }), provider: 'deepseek', model: 'deepseek-chat' })
    const completion = await provider.complete({ prompt: 'hi', maxOutputTokens: 2, signal: new AbortController().signal })
    assert.deepEqual(completion, { kind: 'truncated', text: 'cut off' })
  })

  it('maps a tool-calls finish to a tool_call that is never executed (HLM-06)', async () => {
    const provider = await DshLlmProvider.create({ llm: stubSurface({
      descriptor: TEXT_MODEL,
      chunks: [
        { type: 'tool-call-delta', index: 0, name: 'other_tool', argumentsDelta: '{}' },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
    }), provider: 'deepseek', model: 'deepseek-chat' })
    const completion = await provider.complete({ prompt: 'hi', maxOutputTokens: 100, signal: new AbortController().signal })
    assert.deepEqual(completion, { kind: 'tool_call', toolName: 'other_tool' })
  })

  it('maps an error finish to a throw carrying the failure facts', async () => {
    const provider = await DshLlmProvider.create({ llm: stubSurface({
      descriptor: TEXT_MODEL,
      chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'provider down', code: 'RATE_LIMIT' } } }],
    }), provider: 'deepseek', model: 'deepseek-chat' })
    await assert.rejects(
      provider.complete({ prompt: 'hi', maxOutputTokens: 100, signal: new AbortController().signal }),
      /provider down \(RATE_LIMIT\)/,
    )
  })

  it('a stream that ends without a finish chunk is a broken transport, not a result', async () => {
    const provider = await DshLlmProvider.create({ llm: stubSurface({
      descriptor: TEXT_MODEL,
      chunks: [{ type: 'text-delta', index: 0, text: 'no finish' }],
    }), provider: 'deepseek', model: 'deepseek-chat' })
    await assert.rejects(
      provider.complete({ prompt: 'hi', maxOutputTokens: 100, signal: new AbortController().signal }),
      /without a finish chunk/,
    )
  })

  it('sends exactly one user message with the prompt and no system/tools (HLM-05)', async () => {
    const received: { provider: string; model: string; messages: unknown; maxTokens?: number }[] = []
    const provider = await DshLlmProvider.create({ llm: stubSurface({
      descriptor: TEXT_MODEL,
      chunks: textStream('ok'),
      received,
    }), provider: 'deepseek', model: 'deepseek-chat' })
    await provider.complete({ prompt: 'the prompt', maxOutputTokens: 100, signal: new AbortController().signal })
    assert.deepEqual(received[0]?.messages, [{ role: 'user', content: [{ type: 'text', text: 'the prompt' }] }])
  })

  it('sends bound images through the transport hook, and refuses without one', async () => {
    const received: { provider: string; model: string; messages: { role: string; content: { type: string }[] }[]; maxTokens?: number }[] = []
    const withHook = await DshLlmProvider.create({
      llm: stubSurface({ descriptor: IMAGE_MODEL, chunks: textStream('described'), received }),
      provider: 'deepseek',
      model: 'vision-model',
      images: image => ({ type: 'image', attachment: { mediaType: image.mediaType, byteLength: image.bytes.byteLength } }),
    })
    await withHook.complete({
      prompt: 'what is this?',
      images: [typedImage('MARKER')],
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    })
    assert.deepEqual(
      received[0]?.messages[0]?.content.map(part => part.type),
      ['text', 'image'],
    )
    const withoutHook = await DshLlmProvider.create({
      llm: stubSurface({ descriptor: IMAGE_MODEL, chunks: textStream('x'), received }),
      provider: 'deepseek',
      model: 'vision-model',
    })
    await assert.rejects(
      withoutHook.complete({ prompt: 'hi', images: [typedImage()], maxOutputTokens: 100, signal: new AbortController().signal }),
      /no image transport/,
    )
  })
})

describe('HLM-01 — the stub surface runs the title recipe end to end', () => {
  it('text_title completes through the broker with a scripted model answer (stub DSH surface)', async () => {
    const records = recordCollector()
    const provider = await DshLlmProvider.create({ llm: stubSurface({
      descriptor: TEXT_MODEL,
      chunks: textStream(ACCEPTED_TITLE_JSON, { inputTokens: 40, outputTokens: 12 }),
    }), provider: 'deepseek', model: 'deepseek-chat' })
    const broker = new HarnessBroker({ record: records.sink })
    broker.authorize(TEXT_TITLE_TOOL, provider)
    const outcome = await broker.run(TEXT_TITLE_RECIPE, { text: SOURCE_TEXT })
    assert.equal(outcome.kind, 'completed')
    const parsed = parseTitleResponse((outcome as { text: string }).text)
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.reason)
    if (parsed.ok) {
      assert.equal(parsed.response.title, 'Deployment pipeline configuration')
    }
  })
})

// ---------------------------------------------------------------------------
// The REAL DSH surface, when the checkout exposes it.
// ---------------------------------------------------------------------------

/** Load the real DSH packages, or report why this checkout cannot run them. */
async function loadRealDsh(): Promise<
  { Context: new () => object; LlmRuntime: new (ctx: object) => object; LlmAdapter: new () => object }
  | { unavailable: string }
> {
  try {
    // Variable-path imports: typecheck-safe without the packages, resolved at
    // runtime only when link:dsh has materialized them.
    const cordisPath = '@deepseek-ai/cordis'
    const llmPath = '@deepseek-ai/dsh-llm'
    const [{ Context }, llm] = await Promise.all([
      import(cordisPath),
      import(llmPath),
    ])
    return {
      Context,
      LlmRuntime: llm.LlmRuntime,
      LlmAdapter: llm.LlmAdapter,
    }
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) }
  }
}

const realDsh = await loadRealDsh()
const REAL_AVAILABLE = 'unavailable' in realDsh === false
const SKIP_REASON = REAL_AVAILABLE ? undefined : `the DSH packages do not resolve in this checkout (run link:dsh): ${realDsh.unavailable}`

describe('HLM-01 — the REAL DSH surface, driven with a scripted adapter', { skip: SKIP_REASON }, () => {
  if (!REAL_AVAILABLE) return
  const { Context, LlmRuntime, LlmAdapter } = realDsh as {
    Context: new () => { plugin: (plugin: object) => Promise<unknown>; llm: { registerAdapter: (providers: string[], adapter: object) => () => void } }
    LlmRuntime: new (ctx: object) => object
    LlmAdapter: new () => object
  }

  /** A scripted adapter registered on the REAL runtime: deterministic model, real machinery. */
  function scriptedRuntime(script: {
    readonly model: string
    readonly inputModalities?: string[]
    readonly defaultMaxTokens?: number
    readonly chunks: readonly { type: string; [key: string]: unknown }[]
  }) {
    const ctx = new Context()
    const Adapter = LlmAdapter as unknown as new () => {
      resolveModel(provider: string, model: string): Promise<Record<string, unknown>>
      stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>>
    }
    class ScriptedAdapter extends Adapter {
      override async resolveModel(provider: string, model: string): Promise<Record<string, unknown>> {
        return {
          provider,
          id: model,
          name: model,
          ...script.inputModalities === undefined ? {} : { inputModalities: script.inputModalities },
          ...script.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: script.defaultMaxTokens },
        }
      }

      override async *stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>> {
        const messages = options.messages as { role: string; content: unknown[] }[]
        for (const chunk of script.chunks) {
          if (chunk.type === 'RECORD') continue
          yield chunk
        }
        void messages
      }
    }
    // The runtime is provided by DSH's own plugin mount; a bare LlmRuntime
    // constructed over the context works for registration and streaming.
    const runtime = new (LlmRuntime as unknown as new (ctx: object) => { registerAdapter: (providers: string[], adapter: object) => () => void })(ctx)
    runtime.registerAdapter(['deepseek'], new ScriptedAdapter())
    void ctx
    return runtime
  }

  it('the adapter runs through the REAL LlmRuntime stream machinery (REAL DSH surface, scripted model)', async () => {
    const runtime = scriptedRuntime({
      model: 'deepseek-chat',
      inputModalities: ['text'],
      defaultMaxTokens: 4096,
      chunks: [
        { type: 'text-delta', index: 0, text: ACCEPTED_TITLE_JSON },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    })
    const provider = await DshLlmProvider.create({
      llm: runtime as unknown as DshLlmSurface,
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    const completion = await provider.complete({ prompt: 'title this', maxOutputTokens: 512, signal: new AbortController().signal })
    assert.equal(completion.kind, 'text')
  })

  it('capabilities are read through the REAL resolveModelInfo path (REAL DSH surface)', async () => {
    const runtime = scriptedRuntime({
      model: 'vision-model',
      inputModalities: ['text', 'image'],
      defaultMaxTokens: 2048,
      chunks: [],
    })
    const provider = await DshLlmProvider.create({
      llm: runtime as unknown as DshLlmSurface,
      provider: 'deepseek',
      model: 'vision-model',
    })
    assert.equal(provider.capabilities().images, 'unknown', 'no transport hook: honest unknown, never a silent drop')
    assert.equal(provider.capabilities().maxOutputTokens, 2048)
  })

  it('a refusal through the REAL surface maps to the broker failure vocabulary (REAL DSH surface)', async () => {
    const runtime = scriptedRuntime({
      model: 'deepseek-chat',
      inputModalities: ['text'],
      chunks: [
        { type: 'finish', reason: { kind: 'error', failure: { message: 'the model declined', code: 'CONTENT_FILTER' } } },
      ],
    })
    const provider = await DshLlmProvider.create({
      llm: runtime as unknown as DshLlmSurface,
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    await assert.rejects(
      provider.complete({ prompt: 'title this', maxOutputTokens: 512, signal: new AbortController().signal }),
      /the model declined \(CONTENT_FILTER\)/,
    )
  })
})
