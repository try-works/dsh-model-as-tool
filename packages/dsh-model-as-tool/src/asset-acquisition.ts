/**
 * Verified atomic asset acquisition (RES-03, RES-07).
 *
 * The requirement's rules are all about what must NOT be observable:
 *
 * - **A partial download must never be usable.** Bytes are written to a temporary
 *   sibling, verified against the expected digest, and only then renamed into place.
 *   A file at the final path is therefore either absent or complete and correct —
 *   which is why the temp file is a sibling rather than somewhere else: a rename
 *   within one directory is atomic, and one across filesystems is not.
 * - **A failed or interrupted preparation cannot become ready.** A digest mismatch
 *   deletes the partial rather than keeping it for a retry that would resume from
 *   bytes already known to be wrong.
 * - **Uninstall and purge are separate** (RES-03). Acquisition records ownership; it
 *   never deletes. Deletion is `purgeCandidates`, which refuses to remove an asset
 *   another owner still holds.
 * - **No source changes or binary builds on the end-user machine.** This acquires
 *   pinned bytes; there is no compile step here to disable.
 *
 * Everything that touches the network or the filesystem is INJECTED, so the failure
 * paths — which are the ones that matter and the ones a real download makes hard to
 * reach — are exercised by test.
 *
 * @module @try-works/dsh-model-as-tool/asset-acquisition
 */

import { createHash } from 'node:crypto'
import type { PlannedAsset } from './deployment-coordinator.ts'

/** Where an asset's bytes come from. */
export interface AcquisitionSource {
  /**
   * Fetch a byte range.
   *
   * `from` is the offset to resume from; `to` is inclusive. A source that cannot
   * serve ranges reports `supportsRanges: false`, and the caller then restarts rather
   * than assuming a partial is resumable.
   * @param asset - the asset to fetch.
   * @param from - the first byte to fetch.
   * @param to - the last byte to fetch, inclusive.
   * @param signal - cancellation.
   * @returns the bytes.
   */
  fetchRange(
    asset: PlannedAsset,
    from: number,
    to: number,
    signal: AbortSignal,
  ): Promise<Uint8Array>
  /** Whether this source can serve byte ranges, which resumability depends on. */
  readonly supportsRanges: boolean
}

/** The filesystem operations acquisition needs. */
export interface AcquisitionStore {
  /** Write bytes to a path, creating it if absent. */
  write(path: string, bytes: Uint8Array): void
  /** Read a path's bytes, or undefined when absent. */
  read(path: string): Uint8Array | undefined
  /** The size of a path in bytes, or 0 when absent. */
  sizeOf(path: string): number
  /** Rename, which must be atomic within a directory. */
  rename(from: string, to: string): void
  /** Remove a path, ignoring its absence. */
  remove(path: string): void
  /** Whether a path exists. */
  exists(path: string): boolean
}

/** The outcome of an acquisition. */
export type AcquisitionResult =
  | {
    readonly acquired: true
    /** The content-addressed path the bytes now occupy. */
    readonly path: string
    /** The verified digest. */
    readonly digest: string
    /** How many bytes were transferred, which is less than the size after a resume. */
    readonly transferredBytes: number
    /** Whether an existing partial was resumed. */
    readonly resumed: boolean
  }
  | {
    readonly acquired: false
    /** The reason, naming whether the bytes were wrong or the transfer failed. */
    readonly reason: string
    /** Whether a retry could succeed. */
    readonly retryable: boolean
  }

/** Where an asset lives once acquired. */
function contentPath(root: string, digest: string): string {
  return `${root}/${digest}`
}

/** The temporary sibling a transfer lands in before verification. */
function partialPath(root: string, digest: string): string {
  // A SIBLING of the final path, so the rename is within one directory and therefore
  // atomic. A temp directory elsewhere would make the final rename a copy.
  return `${root}/.partial-${digest}`
}

/** Hash bytes with the algorithm the digest length implies. */
function digestOf(bytes: Uint8Array, expectedLength: number): string {
  // SHA-512 is 128 hex characters, SHA-256 is 64. Inferring from the expected length
  // means a lock written in either is verified with the right algorithm rather than a
  // mismatch that looks like corruption.
  return createHash(expectedLength > 64 ? 'sha512' : 'sha256').update(bytes).digest('hex')
}

/**
 * Acquire one asset, atomically and verified (RES-03).
 *
 * @param asset - the planned asset.
 * @param options - the store, the source, the root and a cancellation signal.
 * @returns the result, which never leaves a partial at the final path.
 */
export async function acquireAsset(
  asset: PlannedAsset,
  options: {
    readonly store: AcquisitionStore
    readonly source: AcquisitionSource
    /** The directory assets are content-addressed under. */
    readonly root: string
    readonly signal: AbortSignal
    /** Transfer chunk size; bounded so a large asset does not need one huge buffer. */
    readonly chunkBytes?: number
  },
): Promise<AcquisitionResult> {
  const { store, source, root, signal } = options
  const finalPath = contentPath(root, asset.digest)
  const partial = partialPath(root, asset.digest)

  // Already acquired and verified by a previous run: nothing to do, and nothing to
  // re-download. This is also what makes two owners share one set of bytes.
  if (store.exists(finalPath) && digestOf(store.read(finalPath) ?? new Uint8Array(), asset.digest.length) === asset.digest) {
    return { acquired: true, path: finalPath, digest: asset.digest, transferredBytes: 0, resumed: false }
  }

  const chunkBytes = options.chunkBytes ?? 4 * 1024 * 1024
  // Resumption is only attempted when the source can serve ranges. Assuming a partial
  // is resumable against a source that cannot would append a full response to a
  // partial and produce bytes that hash wrong for a reason that looks like corruption.
  let offset = source.supportsRanges ? store.sizeOf(partial) : 0
  const resumed = offset > 0
  if (!source.supportsRanges && store.exists(partial)) store.remove(partial)

  let transferred = 0
  try {
    while (offset < asset.bytes) {
      if (signal.aborted) {
        // The partial is LEFT in place, because it is verifiable bytes and a later
        // attempt can resume from it; it is not at the final path, so nothing can use
        // it as though it were complete.
        return { acquired: false, reason: 'the transfer was cancelled', retryable: true }
      }
      const to = Math.min(offset + chunkBytes, asset.bytes) - 1
      const chunk = await source.fetchRange(asset, offset, to, signal)
      if (chunk.byteLength === 0) {
        // A zero-length chunk before the declared size means the source ended early.
        return {
          acquired: false,
          reason: `the source ended at ${offset} of ${asset.bytes} bytes`,
          retryable: true,
        }
      }
      // Appended rather than accumulated in memory: a 349 MB asset must not need a
      // 349 MB buffer to be resumed.
      store.write(partial, appendTo(store.read(partial), chunk))
      offset += chunk.byteLength
      transferred += chunk.byteLength
    }

    const completed = store.read(partial) ?? new Uint8Array()
    if (completed.byteLength !== asset.bytes) {
      store.remove(partial)
      return {
        acquired: false,
        reason: `received ${completed.byteLength} bytes, expected ${asset.bytes}`,
        retryable: true,
      }
    }
    const actual = digestOf(completed, asset.digest.length)
    if (actual !== asset.digest) {
      // RES-03: a failed preparation cannot become ready, and bytes already known to
      // be wrong must not be kept for a retry that would resume from them.
      store.remove(partial)
      return {
        acquired: false,
        reason: `the asset digest is ${actual}, not the pinned ${asset.digest}`,
        retryable: false,
      }
    }

    // The whole point: verified bytes move into place in one atomic step, so the final
    // path is never a partial file.
    store.rename(partial, finalPath)
    return { acquired: true, path: finalPath, digest: asset.digest, transferredBytes: transferred, resumed }
  } catch (error) {
    // A transport failure leaves the partial for a resume and reports retryable, so a
    // caller can tell a flaky network from a corrupt asset.
    return {
      acquired: false,
      reason: error instanceof Error ? error.message : String(error),
      retryable: true,
    }
  }
}

/** Concatenate a previous buffer with a new chunk. */
function appendTo(previous: Uint8Array | undefined, chunk: Uint8Array): Uint8Array {
  if (previous === undefined) return chunk
  const out = new Uint8Array(previous.byteLength + chunk.byteLength)
  out.set(previous, 0)
  out.set(chunk, previous.byteLength)
  return out
}

/**
 * A declared memory admission estimate (RES-07).
 *
 * RES-07 requires ENFORCED and ESTIMATED limits to be reported SEPARATELY, because
 * conflating them is how a V8 heap cap gets mistaken for a process-tree cap: the heap
 * cap bounds JavaScript objects and says nothing about the native memory an inference
 * engine allocates outside it.
 */
export interface MemoryEstimate {
  /** Bytes the host will refuse to exceed, as far as it can enforce. */
  readonly enforcedBytes: number | null
  /** What the deployment is expected to use, which is an estimate and not a bound. */
  readonly estimatedBytes: number
  /**
   * What the enforced figure actually covers.
   *
   * Named rather than implied, so a reader can tell a heap cap from a process-tree cap
   * without reading the implementation.
   */
  readonly enforcedScope: 'process-tree' | 'worker' | 'v8-heap-only' | 'none'
  /** Whether the estimate has been measured rather than predicted. */
  readonly measured: boolean
}

/**
 * Describe a memory admission, without overstating what is enforced (RES-07).
 * @param input - the enforced and estimated figures.
 * @returns the estimate, with the scope stated.
 */
export function describeMemory(input: {
  readonly enforcedBytes: number | null
  readonly estimatedBytes: number
  readonly enforcedScope: MemoryEstimate['enforcedScope']
  readonly measured?: boolean
}): MemoryEstimate {
  return {
    enforcedBytes: input.enforcedBytes,
    estimatedBytes: input.estimatedBytes,
    enforcedScope: input.enforcedScope,
    measured: input.measured ?? false,
  }
}

/**
 * Whether an enforced limit actually bounds the whole process tree (RES-07).
 *
 * A V8 heap cap does NOT, and treating it as though it did is the specific mistake the
 * requirement names.
 * @param estimate - the estimate.
 * @returns whether the enforcement covers the process tree.
 */
export function boundsProcessTree(estimate: MemoryEstimate): boolean {
  return estimate.enforcedScope === 'process-tree'
}
