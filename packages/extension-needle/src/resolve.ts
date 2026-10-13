/**
 * Resolving and verifying the pinned artifacts on the local machine (EXT-18, MOD-01).
 *
 * The host prepares and verifies assets and hands the extension a `PreparedAssetMapV1`.
 * That is the normal route, and it is tried first. The routes below it exist because a
 * developer or an operator needs to point this package at bytes outside a host profile —
 * during qualification, in a test, or on an air-gapped device — and because `inspect()`
 * must be able to answer honestly about a machine the host has not prepared anything on.
 *
 * Every route ends in the SAME verification. A path is not evidence that a file is the
 * pinned file, so nothing is executed or loaded until its size and SHA-256 match the pin.
 * Skipping verification for an "operator-supplied" path would be exactly backwards: that
 * is the path most likely to be wrong.
 *
 * @module @try-works/extension-needle/artifacts
 */

import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  NEEDLE_ARTIFACTS,
  NEEDLE_ENGINE_PIN,
  NEEDLE_WEIGHTS_PIN,
  artifactById,
  type ArtifactPin,
} from './artifacts.ts'

/** Where a resolved path came from, so an inspection can say so. */
export type ArtifactSource = 'prepared' | 'configuration' | 'environment' | 'storage'

/** One artifact, resolved to a local path and verified against its pin. */
export interface ResolvedArtifact {
  readonly assetId: string
  readonly path: string
  readonly source: ArtifactSource
  /** The digest that was MEASURED, which is why this is a verification and not a claim. */
  readonly observedSha256: string
  readonly observedBytes: number
  readonly pin: ArtifactPin
}

/** Why one artifact could not be resolved or verified. */
export interface ArtifactProblem {
  readonly assetId: string
  /** Every route that was tried, so the message can say where it looked. */
  readonly searched: readonly string[]
  readonly reason: string
}

/** The result of resolving every pinned artifact. */
export interface Resolution {
  readonly resolved: readonly ResolvedArtifact[]
  readonly problems: readonly ArtifactProblem[]
}

/** Overrides a caller may supply instead of a host-prepared asset map. */
export interface ResolutionHints {
  /** A local path per asset id. */
  readonly paths?: Readonly<Record<string, string>>
  /** A directory holding the artifacts under their pinned file names. */
  readonly directory?: string
}

/** Environment variables an operator may set, one per asset id, to point at local bytes. */
const ENV_NAMES: Readonly<Record<string, string>> = {
  'needle-engine-win-x64': 'NEEDLE_EXTENSION_ENGINE',
  'needle3-weights': 'NEEDLE_EXTENSION_WEIGHTS',
}

/** Digest results already confirmed for an unchanged file, so a 35 MB hash is not
 * recomputed on every call within one process. */
const digestCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>()

/**
 * Compute a file's SHA-256 by streaming it.
 *
 * Streamed rather than read into memory: the weights are 35 MB and a host that prepared
 * several deployments would otherwise hold each one in a buffer purely to hash it.
 * @param path - the file.
 * @returns the lower-case hex digest.
 */
export async function sha256File(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/** Verify one candidate path against its pin. Never throws: a failure is a problem value. */
async function verify(
  assetId: string,
  path: string,
  source: ArtifactSource,
  searched: string[],
): Promise<ResolvedArtifact | ArtifactProblem> {
  const pin = artifactById(assetId)
  if (pin === undefined) {
    return { assetId, searched, reason: `no pin is declared for asset ${JSON.stringify(assetId)}` }
  }
  let info: { size: number; mtimeMs: number }
  try {
    const stats = await stat(path)
    if (!stats.isFile()) {
      return { assetId, searched, reason: `${path} is not a regular file` }
    }
    info = { size: stats.size, mtimeMs: stats.mtimeMs }
  } catch (error) {
    return {
      assetId,
      searched,
      reason: `${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  // Size first. It is free, and a wrong-size file is wrong whatever its digest is.
  if (info.size !== pin.bytes) {
    return {
      assetId,
      searched,
      reason: `${path} is ${info.size} bytes, but ${pin.fileName} at revision `
        + `${pin.url.split('/resolve/')[1]?.split('/')[0] ?? '?'} is ${pin.bytes} bytes`,
    }
  }
  const cached = digestCache.get(path)
  const sha256 = cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs
    ? cached.sha256
    : await sha256File(path)
  digestCache.set(path, { size: info.size, mtimeMs: info.mtimeMs, sha256 })
  if (sha256 !== pin.sha256) {
    return {
      assetId,
      searched,
      reason: `${path} has SHA-256 ${sha256}, but the pin for ${pin.fileName} is ${pin.sha256}. `
        + 'The bytes are not the pinned artifact and will not be executed or loaded.',
    }
  }
  return { assetId, path, source, observedSha256: sha256, observedBytes: info.size, pin }
}

/** Narrow a resolution entry to the success case. */
function isResolved(value: ResolvedArtifact | ArtifactProblem): value is ResolvedArtifact {
  return 'path' in value
}

/**
 * Resolve and verify every pinned artifact.
 *
 * Routes are tried in order of authority: the host's verified map, then an explicit hint,
 * then the environment, then the extension-private directory. The FIRST path that
 * verifies wins; a path that exists but does not verify does NOT stop the search, because
 * a stale copy in one location should not shadow a correct one in the next.
 * @param options - the host map, hints, storage directory and the environment to read.
 * @returns what verified, and what did not with the routes that were searched.
 */
export async function resolveArtifacts(options: {
  readonly assets?: { get(assetId: string): { readonly path: string; readonly digest: string } | undefined }
  readonly hints?: ResolutionHints
  readonly storageDirectory?: string
  readonly env?: Readonly<Record<string, string | undefined>>
} = {}): Promise<Resolution> {
  const env = options.env ?? process.env
  const resolved: ResolvedArtifact[] = []
  const problems: ArtifactProblem[] = []

  for (const pin of NEEDLE_ARTIFACTS) {
    const candidates: { path: string; source: ArtifactSource }[] = []
    const searched: string[] = []

    const prepared = options.assets?.get(pin.assetId)
    if (prepared !== undefined) {
      candidates.push({ path: prepared.path, source: 'prepared' })
      searched.push(`host-prepared asset ${pin.assetId} at ${prepared.path}`)
    }
    const configured = options.hints?.paths?.[pin.assetId]
    if (configured !== undefined) {
      candidates.push({ path: configured, source: 'configuration' })
      searched.push(`configured path ${configured}`)
    }
    if (options.hints?.directory !== undefined) {
      const candidate = join(options.hints.directory, pin.fileName)
      candidates.push({ path: candidate, source: 'configuration' })
      searched.push(`configured directory ${candidate}`)
    }
    const fromEnv = env[ENV_NAMES[pin.assetId] ?? '']
    if (fromEnv !== undefined && fromEnv.length > 0) {
      candidates.push({ path: fromEnv, source: 'environment' })
      searched.push(`${ENV_NAMES[pin.assetId]} = ${fromEnv}`)
    }
    if (options.storageDirectory !== undefined && options.storageDirectory.length > 0) {
      const candidate = join(options.storageDirectory, pin.fileName)
      candidates.push({ path: candidate, source: 'storage' })
      searched.push(`extension storage ${candidate}`)
    }

    if (candidates.length === 0) {
      problems.push({
        assetId: pin.assetId,
        searched,
        reason: `nothing was prepared, configured or found in the environment for ${pin.fileName}`,
      })
      continue
    }

    let found: ResolvedArtifact | undefined
    const failures: string[] = []
    for (const candidate of candidates) {
      const outcome = await verify(pin.assetId, candidate.path, candidate.source, searched)
      if (isResolved(outcome)) {
        found = outcome
        break
      }
      failures.push(outcome.reason)
    }
    if (found !== undefined) {
      resolved.push(found)
    } else {
      problems.push({
        assetId: pin.assetId,
        searched,
        reason: failures.join('; ') || `${pin.fileName} was not found`,
      })
    }
  }

  return { resolved, problems }
}

/** Fetch one verified artifact out of a resolution. */
export function resolvedById(resolution: Resolution, assetId: string): ResolvedArtifact | undefined {
  return resolution.resolved.find(entry => entry.assetId === assetId)
}

/** The engine, when it verified. */
export function resolvedEngine(resolution: Resolution): ResolvedArtifact | undefined {
  return resolvedById(resolution, NEEDLE_ENGINE_PIN.assetId)
}

/** The weights, when they verified. */
export function resolvedWeights(resolution: Resolution): ResolvedArtifact | undefined {
  return resolvedById(resolution, NEEDLE_WEIGHTS_PIN.assetId)
}

/** Clear the in-process digest cache. Exported so a test can prove a changed file is
 * re-hashed rather than served from a stale entry. */
export function clearDigestCache(): void {
  digestCache.clear()
}
