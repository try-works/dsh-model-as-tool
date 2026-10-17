/**
 * The HTTP acquisition source, tested with an INJECTED fetch (no network).
 *
 * The real download against the pinned Needle URLs is a separate, opt-in
 * acceptance script; these tests pin the behaviors a network cannot be counted
 * on to produce on demand: range requests, redirect counting, short bodies and
 * error surfaces.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createHttpSource } from '../src/http-acquisition.ts'
import type { PlannedAsset } from '../src/deployment-coordinator.ts'

after(() => {})

const ASSET: PlannedAsset = {
  assetId: 'probe',
  bytes: 12,
  source: 'https://example.test/asset.bin',
  digest: '0'.repeat(64),
  executable: false,
}

const signal = () => new AbortController().signal

/** A fetch impl that records requests and serves scripted responses. */
function fakeFetch(script: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const requests: { url: string; range: string | null }[] = []
  const impl: typeof fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, range: (init?.headers as Record<string, string> | undefined)?.range ?? null })
    return script(url, init ?? {})
  }
  return { impl, requests }
}

describe('RES-03 — the HTTP acquisition source', () => {
  it('requests the exact byte range and returns it', async () => {
    const { impl, requests } = fakeFetch(() => new Response(new Uint8Array(4).fill(0xab), { status: 206 }))
    const source = createHttpSource({ fetchImpl: impl })
    const bytes = await source.fetchRange(ASSET, 2, 5, signal())
    assert.equal(bytes.byteLength, 4)
    assert.deepEqual(requests, [{ url: ASSET.source, range: 'bytes=2-5' }])
  })

  it('REJECTS a short body, which would corrupt resume offsets', async () => {
    const { impl } = fakeFetch(() => new Response(new Uint8Array(2), { status: 206 }))
    const source = createHttpSource({ fetchImpl: impl })
    await assert.rejects(source.fetchRange(ASSET, 2, 5, signal()), /received 2/)
  })

  it('HANDLES a 200 full body (a server that ignored Range), slicing the requested window', async () => {
    // RFC 9110 §14.2: a server MAY ignore Range. The source must serve the
    // requested window anyway, sliced at its absolute offset.
    const full = new Uint8Array(12).map((_, index) => index)
    const { impl } = fakeFetch(() => new Response(full, { status: 200 }))
    const source = createHttpSource({ fetchImpl: impl })
    const bytes = await source.fetchRange(ASSET, 2, 5, signal())
    assert.deepEqual([...bytes], [2, 3, 4, 5])
  })

  it('REJECTS a 200 full body too short to cover the requested window', async () => {
    const { impl } = fakeFetch(() => new Response(new Uint8Array(5), { status: 200 }))
    const source = createHttpSource({ fetchImpl: impl })
    await assert.rejects(source.fetchRange(ASSET, 6, 9, signal()), /fewer than the 10/)
  })

  it('REJECTS a 200 body beyond the operator-approved asset size', async () => {
    const { impl } = fakeFetch(() => new Response(new Uint8Array(13), { status: 200 }))
    const source = createHttpSource({ fetchImpl: impl })
    await assert.rejects(source.fetchRange(ASSET, 0, 3, signal()), /exceeded the 12 byte budget/)
  })

  it('REJECTS a 206 body that is not exactly the requested range', async () => {
    // A 206 must carry the range its Content-Range describes; a longer body trips
    // the memory budget first (the stronger guard), and both refusals are correct.
    const { impl } = fakeFetch(() => new Response(new Uint8Array(6), { status: 206 }))
    const source = createHttpSource({ fetchImpl: impl })
    await assert.rejects(source.fetchRange(ASSET, 0, 3, signal()), /exceeded the 4 byte budget/)
  })

  it('bounds MEMORY while streaming: an oversized 200 body is refused before full buffering', async () => {
    // A streamed body beyond the approved asset size must be cancelled mid-read,
    // not buffered to the end (the round-48 review's finding 2).
    let cancelled = false
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 64; i += 1) controller.enqueue(new Uint8Array(1024))
        controller.close()
      },
      cancel() {
        cancelled = true
      },
    })
    const { impl } = fakeFetch(() => new Response(oversized, { status: 200 }))
    const source = createHttpSource({ fetchImpl: impl })
    await assert.rejects(source.fetchRange(ASSET, 0, 3, signal()), /exceeded the 12 byte budget/)
    assert.equal(cancelled, true, 'the reader must be cancelled, not drained')
  })

  it('follows a redirect with the location resolved against the request URL', async () => {
    const { impl, requests } = fakeFetch((url) =>
      url.includes('r=1')
        ? new Response(new Uint8Array(4), { status: 200 })
        : new Response(null, { status: 302, headers: { location: '/asset.bin?r=1' } }))
    const source = createHttpSource({ fetchImpl: impl })
    const bytes = await source.fetchRange(ASSET, 0, 3, signal())
    assert.equal(bytes.byteLength, 4)
    assert.equal(requests.length, 2)
    assert.equal(requests[1]?.url, 'https://example.test/asset.bin?r=1')
  })

  it('rejects a redirect that carries no location', async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 302 }))
    const source = createHttpSource({ fetchImpl: impl })
    await assert.rejects(source.fetchRange(ASSET, 0, 3, signal()), /no location/)
  })

  it('stops after the redirect budget, refusing to loop forever', async () => {
    const { impl, requests } = fakeFetch(() => new Response(null, { status: 302, headers: { location: '/asset.bin' } }))
    const source = createHttpSource({ fetchImpl: impl, maxRedirects: 3 })
    await assert.rejects(source.fetchRange(ASSET, 0, 3, signal()), /more than 3 redirects/)
    assert.equal(requests.length, 4, 'one initial request plus maxRedirects follow-ups')
  })

  it('surfaces HTTP failures with the status and asset id', async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 404 }))
    const source = createHttpSource({ fetchImpl: impl })
    await assert.rejects(source.fetchRange(ASSET, 0, 3, signal()), /HTTP 404/)
  })
})
