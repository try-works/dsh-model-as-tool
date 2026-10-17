/**
 * The MiniLM text_embed extension (TOOL-04, BASE-12).
 *
 * This is the COMPATIBILITY 384-dimensional space: the MiniLM-L6 recipe
 * (tokenize → mean pooling over the real tokens → L2 normalization, input
 * order preserved). The weights are the pinned ONNX conversion recorded in
 * models.lock.json (measured digests, no placeholders); the tokenizer is the
 * pure-TS WordPiece over the pinned `vocab.txt`, matching the HF reference ids
 * exactly (pinned by golden fixtures), so the extension needs no second
 * runtime: the same ORT build that runs the graph feeds it.
 *
 * The deterministic maths (pooling, normalization, space identity) are pure
 * and tested without weights; the adapter itself is the real path and runs
 * once the host supplies the verified group.
 */

import { readFileSync } from 'node:fs'

import type {
  ExtensionContextV1,
  ExtensionInstanceV1,
  JsonObject,
  ModelProviderV1,
  PreparedAssetMapV1,
  ProviderInspectionV1,
} from '@try-works/tool-mode-extension-sdk'

import { meanPool, normalize } from './pure.js'
import { encodeText, parseVocab, type Vocabulary } from './tokenizer.js'

const MODEL_ID = 'minilm-l6'
const TEXT_BACKBONE_ASSET = 'text-backbone'
export const EMBEDDING_DIMENSIONS = 384

/** The ort surface this adapter consumes. */
interface OrtRuntime {
  InferenceSession: {
    create(path: string, options: { executionProviders: string[] }): Promise<OrtSession>
  }
  Tensor: new (type: string, data: unknown, dims: number[]) => { data: unknown }
}
interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayBuffer }>>
  release(): Promise<void>
}

/** Create the provider over the verified group directory. */
function createMiniLmProvider(context: ExtensionContextV1): ModelProviderV1 {
  let disposed = false
  let sessionPromise: Promise<{ embed(texts: readonly string[]): Promise<number[][]>; dispose(): Promise<void> }> | undefined

  const ensureSession = async (): Promise<{ embed(texts: readonly string[]): Promise<number[][]>; dispose(): Promise<void> }> => {
    if (sessionPromise !== undefined) return await sessionPromise
    throw new Error('the MiniLM deployment is not prepared: load() must be called with the verified text-backbone group (MOD-02)')
  }

  return {
    async inspect(signal): Promise<ProviderInspectionV1> {
      if (signal.aborted) throw new Error('aborted')
      return {
        readiness: sessionPromise === undefined ? 'prepared-cold' : 'ready',
        features: ['text-embeddings'],
        missing: [],
        ...sessionPromise === undefined
          ? { reason: 'the model is prepared but cold; it loads on first use with the host-verified asset group' }
          : {},
      }
    },

    async load(request: { assets: Readonly<PreparedAssetMapV1>; signal: AbortSignal }) {
      if (request.signal.aborted) throw new Error('aborted')
      const group = request.assets.get(TEXT_BACKBONE_ASSET)
      if (group === undefined) {
        throw new Error(
          `the "${TEXT_BACKBONE_ASSET}" asset group was not prepared, so text_embed cannot run (MOD-02). `
          + 'The lock records the acquisition status; a blocked acquisition is reported, never faked',
        )
      }
      sessionPromise ??= (async () => {
        const base = group.path.replace(/[\\/]+$/, '')
        const vocab: Vocabulary = parseVocab(readFileSync(`${base}/vocab.txt`, 'utf8'))
        const ort = await import('onnxruntime-node') as unknown as OrtRuntime
        const session: OrtSession = await ort.InferenceSession.create(
          `${base}/onnx/model.onnx`,
          { executionProviders: ['cpu'] },
        ) as OrtSession
        return {
          async embed(texts) {
            if (disposed) throw new Error('the provider has been disposed')
            const vectors: number[][] = []
            for (const text of texts) {
              const encoded = encodeText(text, vocab)
              const ids = BigInt64Array.from(encoded.inputIds, v => BigInt(v))
              const mask = BigInt64Array.from(encoded.attentionMask, v => BigInt(v))
              const outputs = await session.run({
                input_ids: new ort.Tensor('int64', ids, [1, ids.length]),
                attention_mask: new ort.Tensor('int64', mask, [1, ids.length]),
                token_type_ids: new ort.Tensor('int64', new BigInt64Array(ids.length), [1, ids.length]),
              })
              const lastHidden = outputs['last_hidden_state']
              if (lastHidden === undefined) throw new Error('the pinned graph produced no last_hidden_state')
              // The MiniLM recipe: mean-pool over the real tokens, then L2-normalize.
              const pooled = meanPool(new Float32Array(lastHidden.data), ids.length)
              vectors.push(Array.from(normalize(pooled)))
            }
            return vectors
          },
          async dispose() {
            await session.release()
          },
        }
      })()
      await sessionPromise
    },

    async invoke({ implementationId, input, context: invocation }): Promise<JsonObject> {
      if (invocation.signal.aborted) throw new Error('aborted')
      if (disposed) throw new Error('the provider has been disposed')
      if (implementationId !== 'minilm-l6-onnx') {
        throw new Error(`this extension implements "minilm-l6-onnx", not ${JSON.stringify(implementationId)}`)
      }
      const texts = input.texts as readonly string[]
      if (!Array.isArray(texts) || texts.length === 0 || texts.length > 32) {
        throw new Error('"texts" must carry 1..32 non-empty strings')
      }
      const session = await ensureSession()
      const embeddings = await session.embed(texts)
      return {
        embeddings,
        dimensions: EMBEDDING_DIMENSIONS,
        normalized: true,
      }
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
      context.logger.log('debug', 'minilm-embed provider disposed')
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
        return createMiniLmProvider(context)
      },
      async dispose(reason) {
        context.logger.log('debug', `minilm-embed extension disposed: ${reason}`)
      },
    }
  },
}
