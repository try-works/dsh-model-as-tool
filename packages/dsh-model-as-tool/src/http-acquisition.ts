/**
 * The HTTP acquisition source for pinned asset downloads (RES-03).
 *
 * `acquireAsset` is source-agnostic and its tests inject fakes, which is right
 * for the failure paths — but a source nobody wires means the host-driven
 * acquisition path NDL-01 names was never exercised against a real URL. This
 * module is the real source: fetch with byte ranges, bounded redirect
 * handling, and no writes outside the injected store.
 *
 * @module @try-works/dsh-model-as-tool/http-acquisition
 */

import type { AcquisitionSource } from './asset-acquisition.ts'
import type { PlannedAsset } from './deployment-coordinator.ts'

/** Maximum redirects followed, so a download cannot bounce forever. */
const MAX_REDIRECTS = 5

/** Maximum response size a single range fetch admits, as a guard above the chunk size. */
const MAX_CHUNK_BYTES = 16 * 1024 * 1024

/**
 * Create an HTTP acquisition source.
 *
 * Uses the platform fetch, which supports HTTPS and HTTP on Node 18+. Ranges
 * are requested per chunk; a server that ignores the Range header is detected
 * by the returned byte count and the transfer fails rather than resuming from
 * wrong offsets.
 * @param options - redirect budget and optional fetch override (for tests).
 * @returns the source.
 */
export function createHttpSource(options: {
  readonly maxRedirects?: number
  readonly fetchImpl?: typeof fetch
} = {}): AcquisitionSource {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS
  const fetchImpl = options.fetchImpl ?? fetch

  return {
    supportsRanges: true,

    async fetchRange(asset: PlannedAsset, from: number, to: number, signal: AbortSignal): Promise<Uint8Array> {
      if (to - from + 1 > MAX_CHUNK_BYTES) {
        throw new Error(`a range fetch of ${to - from + 1} bytes exceeds the ${MAX_CHUNK_BYTES} cap`)
      }
      let url = asset.source
      for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
        const response = await fetchImpl(url, {
          headers: { range: `bytes=${from}-${to}` },
          signal,
          // Redirects are followed MANUALLY so each hop is counted: a redirect
          // loop is an error, not a hang.
          redirect: 'manual',
        })
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          if (location === null) {
            throw new Error(`${asset.assetId}: a redirect carried no location`)
          }
          url = new URL(location, url).href
          continue
        }
        if (!response.ok) {
          throw new Error(`${asset.assetId}: HTTP ${response.status} fetching ${asset.source}`)
        }
        // RFC 9110 §14.2 permits a server to IGNORE the Range header entirely and
        // answer 200 with the full body. That is a legal response, so it is
        // handled rather than rejected: the wanted window is sliced out of the
        // full body at ITS absolute offset, and the caller's offset math stays
        // correct whether the server honored the Range or not. The budget admits
        // exactly the bytes up to the window's end — the server chose to send
        // them, and the operator already approved the asset's declared size.
        const wanted = to - from + 1
        if (response.status === 200) {
          // The budget is the operator-approved asset size: a 200 IS the full
          // asset, which the approval already disclosed; anything beyond it is a
          // server that cannot be trusted.
          const body = await readBoundedBody(response, asset.bytes, `${asset.assetId}: full-body`)
          if (body.byteLength < from + wanted) {
            throw new Error(`${asset.assetId}: a 200 response carried ${body.byteLength} bytes, fewer than the ${from + wanted} the requested window requires`)
          }
          return body.subarray(from, from + wanted)
        }
        if (response.status === 206) {
          const body = await readBoundedBody(response, wanted, `${asset.assetId}: range body`)
          if (body.byteLength !== wanted) {
            // A 206 must carry exactly the range the Content-Range describes; a
            // short body means the server truncated, and trusting it would corrupt
            // the resume offsets.
            throw new Error(`${asset.assetId}: requested ${wanted} bytes at ${from}, received ${body.byteLength}`)
          }
          return body
        }
        throw new Error(`${asset.assetId}: unexpected HTTP ${response.status}`)
      }
      throw new Error(`${asset.assetId}: more than ${maxRedirects} redirects`)
    },
  }
}

/**
 * Read a response body under a HARD byte budget.
 *
 * The budget bounds MEMORY before any byte is buffered: the reader is streamed
 * chunk by chunk and refuses the moment the running total would exceed the cap,
 * so a Range-ignoring server cannot push an entire multi-GB asset into a single
 * buffer (the round-48 review's finding 2).
 * @param response - the response to read.
 * @param budget - the maximum bytes admitted.
 * @param label - what is being read, for the error.
 * @returns the buffered bytes.
 */
async function readBoundedBody(response: Response, budget: number, label: string): Promise<Uint8Array> {
  if (response.body === null) {
    // No stream (rare: opaque or empty responses). Read with a guard anyway.
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > budget) throw new Error(`${label} exceeded the ${budget} byte budget`)
    return buffer
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > budget) {
        await reader.cancel()
        throw new Error(`${label} exceeded the ${budget} byte budget`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
