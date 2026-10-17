/**
 * The Laya decision-family extension (H5): decision_choose, decision_test and
 * decision_score over the pinned multilingual Laya checkpoint, running through
 * the VENDORED laya-ts runtime (Apache-2.0, pinned upstream commit
 * c73908d96ff73c0062c340a11bf7c54ec7d8bc4d, tag v0.4.6 — see
 * vendor/laya-ts + README.md for the attribution).
 *
 * Honesty posture (DEC-08): every confidence returned is the runtime's
 * uncalibrated probability mass, marked `calibrated: false`. The upstream
 * model card ships uncalibrated logits with a clamping warning; this extension
 * never presents them as calibrated probabilities.
 */

import type {
  ExtensionContextV1,
  ExtensionInstanceV1,
  JsonObject,
  ModelProviderV1,
  PreparedAssetMapV1,
  ProviderInspectionV1,
} from '@try-works/tool-mode-extension-sdk'

import { Agent, createNodeProvider, decide } from '../vendor/laya-ts/index.js'
import { decideFromLogits, MAX_OPTIONS, MAX_SCORE_LEVELS, validateOptions } from './pure.js'

const MODEL_ID = 'laya'
const ALL_GROUPS = ['text-backbone', 'decision-head', 'tokenizer-config'] as const

/** The six pinned digests, mirrored from models.lock.json for the load-time check. */
const EXPECTED_SHA256: Record<string, string> = {
  'encoder.onnx': 'A774C5C634B99D1A4CED21ACBF11B9617A5CD55C7C7957BD52480B17D95A97F4',
  'encoder.onnx.data': 'F1E49A027352064D72831863456BE6160748854296BFF8332DF14130DBF79834',
  'head.onnx': '7F6B9AC15D5FDF9EEBB352E66BDD3CE799D32885F1446014D268D8C53207858B',
  'head.onnx.data': '0292A4EB478C2C3EC0B6555B4A4093BC802E965654D7AEB4AC22907A17F261D3',
  'tokenizer.json': '609D8F4C067CD3950F88594C5A802616CEA245823836EF5848EE4FC40AAB5B6F',
  'rl_agent_config.json': '25061739243B617AD88D1219BA6F8A9C86C5881CA28DF024FA2D9B3B2FCC30C6',
}

interface LayaSession {
  readonly agent: Agent
  readonly dispose: () => Promise<void>
}

function renderAnswer(raw: JsonObject): JsonObject {
  const answer = (raw.answers ?? {}) as Record<string, unknown>
  const one = Object.values(answer)[0] as Record<string, unknown> | undefined
  const probs = (one?.probabilities ?? {}) as Record<string, number>
  const act = one?.action as { act_probability?: number } | undefined
  return {
    ...(one?.type === 'choice' ? { chosen: (one.choice as string | null) ?? null } : {}),
    ...(one?.type === 'score' ? { score: (one.score as string | null) ?? null } : {}),
    confidence: Number(one?.confidence ?? one?.answer_confidence ?? 0),
    answer_confidence: Number(one?.answer_confidence ?? one?.confidence ?? 0),
    calibrated: false,
    probabilities: probs,
    abstained: one?.choice === null && one?.score === null,
    ...act === undefined ? {} : { action: { act_probability: Number(act.act_probability) } } as never,
  }
}

function createLayaProvider(context: ExtensionContextV1): ModelProviderV1 {
  let disposed = false
  let sessionPromise: Promise<LayaSession> | undefined

  return {
    async inspect(signal): Promise<ProviderInspectionV1> {
      if (signal.aborted) throw new Error('aborted')
      return {
        readiness: sessionPromise === undefined ? 'prepared-cold' : 'ready',
        features: ['decision-family'],
        missing: [],
        ...sessionPromise === undefined
          ? { reason: 'the Laya decision checkpoint is prepared but cold; it loads on first use with the host-verified asset groups' }
          : {},
      }
    },

    async load(request: { assets: Readonly<PreparedAssetMapV1>; signal: AbortSignal }) {
      if (request.signal.aborted) throw new Error('aborted')
      const group = request.assets.get('text-backbone')
      if (group === undefined) {
        throw new Error(
          'the "text-backbone" asset group was not prepared, so the decision family cannot run (MOD-02). '
          + 'The host prepares the six pinned artifacts and verifies every SHA-256 before load',
        )
      }
      void ALL_GROUPS
      sessionPromise ??= (async () => {
        const provider = await createNodeProvider(group.path, {
          expectedSha256: EXPECTED_SHA256,
          device: 'cpu',
        })
        const agent = new Agent({ provider } as never)
        return {
          agent,
          dispose: async () => {
            // The vendored provider owns the sessions; the extension's dispose
            // releases the reference — the runtime's sessions are GC'd with it.
            void provider
          },
        }
      })()
      await sessionPromise
    },

    async invoke({ implementationId, input, context: invocation }): Promise<JsonObject> {
      if (invocation.signal.aborted) throw new Error('aborted')
      if (disposed) throw new Error('the provider has been disposed')
      const session = await sessionPromise
      if (session === undefined) throw new Error('the Laya checkpoint is not prepared: load() must be called (MOD-02)')
      const prompt = input.prompt as string
      if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 4096) {
        throw new Error('"prompt" must be a non-empty string of at most 4096 characters')
      }
      const allowAbstain = input.allow_abstain !== false
      void allowAbstain // The runtime's act gate is reported honestly; no threshold is invented.

      let questionType: 'choice' | 'score'
      let criteria: Record<string, null> | string[]
      if (implementationId === 'laya-onnx-decision-test') {
        questionType = 'choice'
        criteria = { yes: null, no: null }
      } else if (implementationId === 'laya-onnx-decision-choose') {
        const options = validateOptions((input.options ?? []) as string[], MAX_OPTIONS)
        questionType = 'choice'
        criteria = Object.fromEntries(options.map(option => [option, null]))
      } else if (implementationId === 'laya-onnx-decision-score') {
        const levels = validateOptions((input.levels ?? []) as string[], MAX_SCORE_LEVELS)
        questionType = 'score'
        // The vendored runtime takes a score question's criteria as a LIST of
        // level descriptions, index 0 first.
        criteria = [...levels]
      } else {
        throw new Error(`this extension implements the decision family, not ${JSON.stringify(implementationId)}`)
      }

      const result = await decide(
        session.agent,
        prompt,
        null,
        { questions: { answer: { type: questionType, instructions: prompt, criteria } } },
      )
      const values = result as unknown as Record<string, unknown>
      // Without returnDetails, decide() returns the answers map itself: the
      // question's answer sits at result.answer (the question id).
      const answer = (values.answer ?? Object.values(values.answers ?? {})[0] ?? {}) as Record<string, unknown>
      if (answer === undefined || Object.keys(answer).length === 0) throw new Error('the checkpoint produced no decision')
      const probs = (answer.probabilities ?? {}) as Record<string, number>
      const act = answer.action as { act_probability?: number } | undefined
      if (implementationId === 'laya-onnx-decision-test') {
        const labels = ['yes', 'no']
        const logits = labels.map(label => Math.log(Math.max(Number(probs[label]) || 1e-9, 1e-12)))
        const boundary = decideFromLogits(labels, logits)
        return {
          decision: boundary.label,
          confidence: boundary.confidence,
          calibrated: false,
          probabilities: probs,
          abstained: false,
          ...act === undefined ? {} : { action: { act_probability: Number(act.act_probability) } } as never,
        }
      }
      return renderAnswer({ answers: { answer } } as unknown as JsonObject)
    },

    async unload(signal: AbortSignal) {
      void signal
      const session = await sessionPromise?.catch(() => undefined)
      sessionPromise = undefined
      await session?.dispose()
    },

    async dispose() {
      disposed = true
      await this.unload(new AbortController().signal)
      context.logger.log('debug', 'laya decision provider disposed')
    },
  }
}

export default {
  apiVersion: 1,
  async create(context: ExtensionContextV1): Promise<ExtensionInstanceV1> {
    return {
      async createProvider({ modelId }) {
        if (modelId !== MODEL_ID) {
          throw new Error(`this extension implements the "${MODEL_ID}" model, not "${modelId}"`)
        }
        return createLayaProvider(context)
      },
      async dispose(reason) {
        context.logger.log('debug', `laya extension disposed: ${reason}`)
      },
    }
  },
}
