/**
 * The MiniLM text_rerank extension (TOOL-05).
 *
 * The cross-encoder path: encode each query/document pair as one BERT sequence
 * (`[CLS] query [SEP] passage [SEP]`, segment ids 0/1), run the pinned ONNX
 * graph, take the relevance logit, and return the caller's ids in descending
 * ranking_logit order with exact ties broken by input order. The scores are
 * cross-encoder LOGITS — never embedding cosines (the semantic_rank tool's
 * quantity is different and not interchangeable).
 *
 * The tokenizer is the pure-TS WordPiece over the pinned `vocab.txt` (matching
 * the HF reference ids exactly, pinned by golden fixtures), so the extension
 * needs no second runtime: the same ORT build that runs the graph feeds it.
 */

import { readFileSync } from 'node:fs'

import type {
  ExtensionContextV1,
  JsonValue,
  ExtensionInstanceV1,
  JsonObject,
  ModelProviderV1,
  PreparedAssetMapV1,
  ProviderInspectionV1,
} from '@try-works/tool-mode-extension-sdk'

import { rankByLogit } from './pure.js'
import { encodePair, parseVocab, type Vocabulary } from './tokenizer.js'

const MODEL_ID = 'minilm-rerank'
const TEXT_BACKBONE_ASSET = 'text-backbone'

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

function createMiniLmRerankProvider(context: ExtensionContextV1): ModelProviderV1 {
  let disposed = false
  let sessionPromise: Promise<{ score(query: string, document: string): Promise<number>; dispose(): Promise<void> }> | undefined

  return {
    async inspect(signal): Promise<ProviderInspectionV1> {
      if (signal.aborted) throw new Error('aborted')
      return {
        readiness: sessionPromise === undefined ? 'prepared-cold' : 'ready',
        features: ['text-reranking'],
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
          `the "${TEXT_BACKBONE_ASSET}" asset group was not prepared, so text_rerank cannot run (MOD-02). `
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
          async score(query, document) {
            if (disposed) throw new Error('the provider has been disposed')
            const encoded = encodePair(query, document, vocab)
            const ids = BigInt64Array.from(encoded.inputIds, v => BigInt(v))
            const mask = BigInt64Array.from(encoded.attentionMask, v => BigInt(v))
            const types = BigInt64Array.from(encoded.tokenTypeIds, v => BigInt(v))
            const outputs = await session.run({
              input_ids: new ort.Tensor('int64', ids, [1, ids.length]),
              attention_mask: new ort.Tensor('int64', mask, [1, ids.length]),
              token_type_ids: new ort.Tensor('int64', types, [1, ids.length]),
            })
            const logits = outputs['logits']
            if (logits === undefined) throw new Error('the pinned graph produced no logits')
            return new Float32Array(logits.data)[0] as number
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
      if (implementationId !== 'minilm-rerank-onnx') {
        throw new Error(`this extension implements "minilm-rerank-onnx", not ${JSON.stringify(implementationId)}`)
      }
      const query = input.query as string
      const documents = input.documents as unknown as readonly { id: string; text: string }[]
      if (typeof query !== 'string' || query.length === 0 || query.length > 32768) {
        throw new Error('"query" must be a non-empty string')
      }
      if (!Array.isArray(documents) || documents.length === 0 || documents.length > 256) {
        throw new Error('"documents" must carry 1..256 entries')
      }
      const topK = typeof input.top_k === 'number' ? input.top_k : documents.length
      const session = await sessionPromise
      if (session === undefined) throw new Error('the MiniLM reranker is not prepared: load() must be called (MOD-02)')
      const scored: { id: string; score: number }[] = []
      for (const document of documents) {
        scored.push({ id: document.id, score: await session.score(query, document.text) })
      }
      const ranked = rankByLogit(scored).slice(0, topK)
      return {
        results: ranked as unknown as JsonValue[],
        scoreKind: 'ranking_logit',
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
      context.logger.log('debug', 'minilm-rerank provider disposed')
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
        return createMiniLmRerankProvider(context)
      },
      async dispose(reason) {
        context.logger.log('debug', `minilm-rerank extension disposed: ${reason}`)
      },
    }
  },
}
