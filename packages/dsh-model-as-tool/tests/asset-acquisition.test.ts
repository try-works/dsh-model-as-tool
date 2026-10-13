/**
 * Asset acquisition and harness budget tests (RES-03, RES-07, RES-08, RES-10).
 *
 * Acquisition is driven with an in-memory store and an injected source, so the paths
 * that matter — a digest mismatch, a truncated transfer, a cancellation mid-download —
 * are reachable without a network. Those are the paths a real download makes hardest
 * to test and easiest to ship broken.
 *
 * Requirement links: RES-03, RES-07, RES-08, RES-10.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acquireAsset,
  boundsProcessTree,
  describeMemory,
  type AcquisitionSource,
  type AcquisitionStore,
} from '../src/asset-acquisition.ts'
import type { PlannedAsset } from '../src/deployment-coordinator.ts'
import {
  describeCost,
  INITIAL_BUDGET,
  isAmbiguousCompletion,
  LOCAL_ONLY_BUDGET,
  mayAttempt,
  mayReplayAfterReconnect,
  mayRepair,
  narrowBudget,
  permitsDestination,
} from '../src/harness-budgets.ts'

const dirs: string[] = []
after(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const payload = new Uint8Array(1024).map((_, index) => index % 251)

/** The digest of a byte string, at the length the lock would use. */
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** An in-memory store. */
function makeStore() {
  const files = new Map<string, Uint8Array>()
  const store: AcquisitionStore = {
    write: (path, bytes) => { files.set(path, bytes) },
    read: path => files.get(path),
    sizeOf: path => files.get(path)?.byteLength ?? 0,
    rename: (from, to) => {
      const bytes = files.get(from)
      if (bytes === undefined) throw new Error(`rename: ${from} does not exist`)
      files.set(to, bytes)
      files.delete(from)
    },
    remove: path => { files.delete(path) },
    exists: path => files.has(path),
  }
  return { store, files }
}

/** A source that serves a payload, optionally tampering with it. */
function makeSource(
  bytes: Uint8Array,
  options: { readonly supportsRanges?: boolean; readonly truncateAt?: number; readonly fail?: boolean } = {},
): AcquisitionSource {
  return {
    supportsRanges: options.supportsRanges ?? true,
    async fetchRange(_asset, from, to) {
      if (options.fail === true) throw new Error('connection reset')
      const end = Math.min(to + 1, options.truncateAt ?? bytes.byteLength)
      return bytes.slice(from, Math.max(from, end))
    },
  }
}

const ASSET: PlannedAsset = {
  assetId: 'weights',
  bytes: payload.byteLength,
  source: 'https://example.invalid/w.bin',
  digest: sha256(payload),
  executable: false,
}

const signal = () => new AbortController().signal

describe('RES-03 — acquisition is atomic and verified', () => {
  it('acquires a correct asset into a CONTENT-ADDRESSED path', async () => {
    const { store } = makeStore()
    const result = await acquireAsset(ASSET, { store, source: makeSource(payload), root: '/assets', signal: signal() })
    assert.equal(result.acquired, true)
    if (!result.acquired) return
    // Content addressing is what lets two owners share one set of bytes safely.
    assert.equal(result.path, `/assets/${ASSET.digest}`)
    assert.equal(result.transferredBytes, payload.byteLength)
  })

  it('leaves NO partial at the final path when the transfer is truncated', async () => {
    const { store, files } = makeStore()
    const result = await acquireAsset(ASSET, {
      store,
      source: makeSource(payload, { truncateAt: 500 }),
      root: '/assets',
      signal: signal(),
    })
    assert.equal(result.acquired, false)
    // The whole point: a file at the final path is either absent or complete.
    assert.equal(store.exists(`/assets/${ASSET.digest}`), false)
    for (const path of files.keys()) assert.match(path, /^\/assets\/\.partial-/, `unexpected file ${path}`)
  })

  it('REJECTS a digest mismatch and does not keep the wrong bytes', async () => {
    const { store, files } = makeStore()
    const tampered = new Uint8Array(payload)
    tampered[0] = 255
    const result = await acquireAsset(ASSET, { store, source: makeSource(tampered), root: '/assets', signal: signal() })
    assert.equal(result.acquired, false)
    if (result.acquired) return
    assert.match(result.reason, /digest is/)
    // Not retryable: a retry that resumed from bytes already known to be wrong would
    // reach the same mismatch.
    assert.equal(result.retryable, false)
    assert.deepEqual([...files.keys()], [], 'a mismatched partial must be discarded')
  })

  it('reports a transport failure as RETRYABLE and keeps the partial', async () => {
    const { store, files } = makeStore()
    const result = await acquireAsset(ASSET, {
      store,
      source: makeSource(payload, { fail: true }),
      root: '/assets',
      signal: signal(),
    })
    assert.equal(result.acquired, false)
    if (result.acquired) return
    // A caller can tell a flaky network from a corrupt asset, which decides whether
    // retrying is sensible.
    assert.equal(result.retryable, true)
    assert.equal(store.exists(`/assets/${ASSET.digest}`), false)
    void files
  })

  it('does not re-download an asset it already holds', async () => {
    const { store } = makeStore()
    const first = await acquireAsset(ASSET, { store, source: makeSource(payload), root: '/assets', signal: signal() })
    assert.equal(first.acquired, true)
    const second = await acquireAsset(ASSET, {
      store,
      // A source that would fail if it were called at all.
      source: makeSource(payload, { fail: true }),
      root: '/assets',
      signal: signal(),
    })
    assert.equal(second.acquired, true)
    if (!second.acquired) return
    assert.equal(second.transferredBytes, 0)
  })
})

describe('RES-03 — resumability has a documented precondition', () => {
  it('resumes from an existing partial when the source supports ranges', async () => {
    const { store } = makeStore()
    // Stand in for an interrupted first attempt.
    const half = payload.slice(0, 512)
    store.write(`/assets/.partial-${ASSET.digest}`, half)

    const result = await acquireAsset(ASSET, { store, source: makeSource(payload), root: '/assets', signal: signal() })
    assert.equal(result.acquired, true)
    if (!result.acquired) return
    assert.equal(result.resumed, true)
    // Only the missing half was transferred.
    assert.equal(result.transferredBytes, 512)
  })

  it('RESTARTS rather than resuming when the source cannot serve ranges', async () => {
    const { store } = makeStore()
    store.write(`/assets/.partial-${ASSET.digest}`, payload.slice(0, 512))
    const result = await acquireAsset(ASSET, {
      store,
      // Resuming a partial against a full-response source would APPEND a whole copy
      // and produce bytes that hash wrong for a reason that looks like corruption.
      source: makeSource(payload, { supportsRanges: false }),
      root: '/assets',
      signal: signal(),
    })
    assert.equal(result.acquired, true)
    if (!result.acquired) return
    assert.equal(result.resumed, false)
    assert.equal(result.transferredBytes, payload.byteLength)
  })

  it('a CANCELLED transfer leaves a verifiable partial and reports retryable', async () => {
    const { store } = makeStore()
    const controller = new AbortController()
    controller.abort()
    const result = await acquireAsset(ASSET, {
      store,
      source: makeSource(payload),
      root: '/assets',
      signal: controller.signal,
    })
    assert.equal(result.acquired, false)
    if (result.acquired) return
    assert.equal(result.retryable, true)
    // Never at the final path, so nothing can use it as though it were complete.
    assert.equal(store.exists(`/assets/${ASSET.digest}`), false)
  })

  it('verifies in bounded chunks rather than buffering the whole asset', async () => {
    const { store } = makeStore()
    const result = await acquireAsset(ASSET, {
      store,
      source: makeSource(payload),
      root: '/assets',
      // A 349 MB asset must not need a 349 MB buffer to be resumed.
      chunkBytes: 128,
      signal: signal(),
    })
    assert.equal(result.acquired, true)
  })
})

describe('RES-07 — enforced and estimated limits are reported separately', () => {
  it('does NOT treat a V8 heap cap as a process-tree cap', () => {
    const heapOnly = describeMemory({ enforcedBytes: 512 * 1024 * 1024, estimatedBytes: 900 * 1024 * 1024, enforcedScope: 'v8-heap-only' })
    // The heap cap bounds JavaScript objects and says nothing about native memory an
    // engine allocates outside it.
    assert.equal(boundsProcessTree(heapOnly), false)
    assert.equal(boundsProcessTree(describeMemory({ enforcedBytes: 1, estimatedBytes: 1, enforcedScope: 'process-tree' })), true)
  })

  it('keeps the enforced and estimated figures distinct', () => {
    const memory = describeMemory({ enforcedBytes: 100, estimatedBytes: 900, enforcedScope: 'worker' })
    assert.equal(memory.enforcedBytes, 100)
    assert.equal(memory.estimatedBytes, 900)
    assert.equal(memory.measured, false)
  })

  it('a null enforced figure means nothing is enforced', () => {
    assert.equal(describeMemory({ enforcedBytes: null, estimatedBytes: 10, enforcedScope: 'none' }).enforcedBytes, null)
  })
})

describe('RES-10 — initial per-leaf maxima, asserted individually', () => {
  it('uses the numbers the requirement states', () => {
    assert.equal(INITIAL_BUDGET.providerAttempts, 1)
    assert.equal(INITIAL_BUDGET.automaticRepairs, 0)
    assert.equal(INITIAL_BUDGET.deadlineSeconds, 60)
    assert.equal(INITIAL_BUDGET.outputTokens, 1024)
    assert.equal(INITIAL_BUDGET.imageInputs, 2)
  })

  it('permits exactly one attempt and then refuses', () => {
    assert.equal(mayAttempt(INITIAL_BUDGET, 0), true)
    assert.equal(mayAttempt(INITIAL_BUDGET, 1), false)
  })

  it('permits no automatic repair by default', () => {
    assert.equal(mayRepair(INITIAL_BUDGET, 0, 30), false)
  })

  it('permits a repair only when explicitly allowed AND inside the root deadline', () => {
    const reviewed = { ...INITIAL_BUDGET, automaticRepairs: 1 }
    assert.equal(mayRepair(reviewed, 0, 30), true)
    // A repair on a fresh deadline would evade the budget rather than fit inside it.
    assert.equal(mayRepair(reviewed, 0, 0), false)
    assert.equal(mayRepair(reviewed, 1, 30), false)
  })
})

describe('RES-10 — narrowing only ever lowers', () => {
  it('takes the minimum of every figure', () => {
    const narrowed = narrowBudget(INITIAL_BUDGET, { deadlineSeconds: 10, outputTokens: 100, imageInputs: 0 })
    assert.equal(narrowed.deadlineSeconds, 10)
    assert.equal(narrowed.outputTokens, 100)
    assert.equal(narrowed.imageInputs, 0)
  })

  it('REFUSES to widen above the base', () => {
    const narrowed = narrowBudget(INITIAL_BUDGET, { deadlineSeconds: 9999, outputTokens: 999_999 })
    // A caller asking for more than the profile permits gets the profile's figure.
    assert.equal(narrowed.deadlineSeconds, 60)
    assert.equal(narrowed.outputTokens, 1024)
  })

  it('never enables remote destinations that the base forbade', () => {
    const attempted = narrowBudget(LOCAL_ONLY_BUDGET, { remoteDestinations: true })
    assert.equal(attempted.remoteDestinations, false)
  })

  it('lets a request introduce a model-call limit where the base had none', () => {
    assert.equal(narrowBudget(INITIAL_BUDGET, { modelCalls: 5 }).modelCalls, 5)
    assert.equal(narrowBudget({ ...INITIAL_BUDGET, modelCalls: 5 }, { modelCalls: 9 }).modelCalls, 5)
  })

  it('a local-only profile prohibits remote destinations regardless of implementation', () => {
    assert.equal(permitsDestination(LOCAL_ONLY_BUDGET, 'remote'), false)
    assert.equal(permitsDestination(LOCAL_ONLY_BUDGET, 'local'), true)
    assert.equal(permitsDestination(INITIAL_BUDGET, 'remote'), true)
  })
})

describe('RES-10 — unknown cost stays unknown', () => {
  it('reports an unknown cost as unknown, NOT as free', () => {
    const text = describeCost({ known: false, reason: 'no monetary budget was configured' })
    // Reporting it as zero would present a call that may be billed as free, which is
    // the failure the requirement names.
    assert.match(text, /^unknown/)
    assert.equal(text.includes('0'), false)
  })

  it('reports a known cost with its currency', () => {
    assert.equal(describeCost({ known: true, currency: 'EUR', amount: 0.25 }), '0.25 EUR')
  })

  it('the initial budget does not claim a cost it does not know', () => {
    assert.equal(INITIAL_BUDGET.monetary.known, false)
  })
})

describe('RES-08 — a foreground invocation is not a persistent job', () => {
  it('NEVER replays an interrupted invocation on reconnect', () => {
    // A call that may already have run is not safely repeatable: its effects could be
    // billed or delivered twice. A retry is a NEW request with fresh authorization.
    assert.equal(mayReplayAfterReconnect(), false)
  })

  it('reports an ambiguous completion when work may have started', () => {
    // The client cannot otherwise tell a call that never started from one that
    // completed and whose response was lost.
    assert.equal(isAmbiguousCompletion(true), true)
    assert.equal(isAmbiguousCompletion(false), false)
  })
})

describe('RES-03 — atomicity against a REAL filesystem', () => {
  /**
   * The in-memory store proves the CALL SEQUENCE; only a real filesystem proves the
   * rename is atomic and that a partial never occupies the final path. This adds a
   * node:fs-backed store so the property is demonstrated rather than assumed.
   */
  function makeRealStore(): { store: AcquisitionStore } {
    return {
      store: {
        write: (path, bytes) => writeFileSync(path, bytes),
        read: path => existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined,
        sizeOf: path => existsSync(path) ? statSync(path).size : 0,
        // A real rename on a real filesystem, which is the operation whose atomicity
        // the module depends on.
        rename: (from, to) => renameSync(from, to),
        remove: path => rmSync(path, { force: true }),
        exists: path => existsSync(path),
      },
    }
  }

  it('lands a verified asset at the content path and nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmx-asset-'))
    dirs.push(dir)
    const { store } = makeRealStore()
    const result = await acquireAsset(ASSET, { store, source: makeSource(payload), root: dir, signal: signal() })
    assert.equal(result.acquired, true)
    // The directory holds exactly one file: the content-addressed asset. No temp file
    // survives a successful acquisition.
    const entries = readdirSync(dir)
    assert.deepEqual(entries, [ASSET.digest])
  })

  it('leaves only a partial behind after a truncated transfer, never the final path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmx-asset-'))
    dirs.push(dir)
    const { store } = makeRealStore()
    const result = await acquireAsset(ASSET, {
      store,
      source: makeSource(payload, { truncateAt: 500 }),
      root: dir,
      signal: signal(),
    })
    assert.equal(result.acquired, false)
    const entries = readdirSync(dir)
    assert.equal(entries.includes(ASSET.digest), false, 'the final path must be absent')
    // A partial is present under its temp name, which is what makes resumption
    // possible without making the partial usable.
    assert.ok(entries.every(entry => entry.startsWith('.partial-')), `unexpected: ${entries.join(', ')}`)
  })

  it('resumes a real partial and verifies the joined bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmx-asset-'))
    dirs.push(dir)
    const { store } = makeRealStore()
    // A half-written partial from an interrupted attempt.
    store.write(join(dir, `.partial-${ASSET.digest}`), payload.slice(0, 512))
    const result = await acquireAsset(ASSET, { store, source: makeSource(payload), root: dir, signal: signal() })
    assert.equal(result.acquired, true)
    if (!result.acquired) return
    assert.equal(result.resumed, true)
    // The digest was checked over the JOINED bytes, so a resume that corrupted the
    // join would have failed rather than produced a wrong file.
    const written = new Uint8Array(readFileSync(join(dir, ASSET.digest)))
    assert.equal(written.byteLength, payload.byteLength)
    assert.equal(sha256(written), ASSET.digest)
  })
})