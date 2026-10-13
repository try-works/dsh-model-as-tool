/**
 * The pinned Needle engine and weights (MOD-01, MOD-19).
 *
 * Every value here was MEASURED on this host on 2026-10-14, not copied from a README. The
 * URLs are the exact `resolve` URLs that answered HTTP 200, the byte sizes are what the
 * files actually are, and the SHA-256 values were computed from the downloaded bytes.
 *
 * There is no GitHub release and no npm package. `GET
 * https://api.github.com/repos/cactus-compute/needle/releases` answers `[]`, the git tree
 * contains no `.exe`, and the `windows-x86_64/` folder the directive names lives in the
 * HuggingFace MODEL repository `Cactus-Compute/needle3`. Pin the HuggingFace revision,
 * because that is where the bytes are and a revision is what makes them immutable.
 *
 * The engine version `3.3.1` comes from `needle/agent/fetch.py` `ENGINE_VERSIONS[3]` at
 * the pinned commit; the revision's own `config.json` declares `engine_version` `3.1.0`,
 * and both are recorded because they disagree. The disagreement is a finding, not a
 * mistake in this file: see PINNING.md.
 *
 * @module @try-works/extension-needle/artifacts
 */

/** What one pinned artifact is and where it came from. */
export interface ArtifactPin {
  /** The manifest asset id this pin is prepared under. */
  readonly assetId: string
  /** The file name the host stores it as. */
  readonly fileName: string
  /** The exact URL that answered, at the pinned revision. */
  readonly url: string
  /** Size in bytes, as observed. */
  readonly bytes: number
  /** Lower-case hex SHA-256 of the bytes, as computed. */
  readonly sha256: string
  /** What the artifact is for. */
  readonly role: string
}

/**
 * The engine revision in the HuggingFace repository `Cactus-Compute/needle3`.
 *
 * This is the repository's `sha` at the time the artifacts were fetched — the value the
 * Hub itself reports as the current commit of `main` — so every `resolve` URL below is
 * immutable. A `main` URL would silently track upstream and make the digests meaningless.
 */
export const NEEDLE_REPO_REVISION = '93e88ede867e4311c39151285e74df513e4b835b'

/** The HuggingFace repository holding the engine and the base weights. */
export const NEEDLE_REPO = 'Cactus-Compute/needle3'

/** The upstream source repository, for the licence and the fetch logic. */
export const NEEDLE_SOURCE_REPO = 'https://github.com/cactus-compute/needle'

/** The upstream commit whose `needle/agent/fetch.py` names engine version 3.3.1. */
export const NEEDLE_SOURCE_COMMIT = '3da4261073199444f2e070800854436fbc31fb6a'

/** The engine version declared by `fetch.py ENGINE_VERSIONS[3]` at that commit. */
export const NEEDLE_ENGINE_VERSION = '3.3.1'

/** The engine version the pinned revision's own `config.json` declares. */
export const NEEDLE_CONFIG_ENGINE_VERSION = '3.1.0'

/** The `resolve` URL prefix every artifact shares at the pinned revision. */
export const NEEDLE_RESOLVE_BASE =
  `https://huggingface.co/${NEEDLE_REPO}/resolve/${NEEDLE_REPO_REVISION}`

/**
 * The pinned artifacts.
 *
 * `needle.exe` is the native route the directive selects. `needle3.cact` is the 2-bit
 * archive carrying the weights AND the vocabulary: the engine needs both files and
 * nothing else, which is why there is no separate tokenizer entry here — unlike the
 * EmbeddingGemma package, whose tokenizer ships with a third-party conversion.
 */
export const NEEDLE_ARTIFACTS: readonly ArtifactPin[] = [
  {
    assetId: 'needle-engine-win-x64',
    fileName: 'needle.exe',
    url: `${NEEDLE_RESOLVE_BASE}/windows-x86_64/needle.exe`,
    bytes: 1_569_280,
    sha256: '47cd411a022d22e393d87ce091848fd446e6d25df2ce31b12a7328337557c85b',
    role: 'the native inference engine for Windows x86_64 (one-shot CLI)',
  },
  {
    assetId: 'needle3-weights',
    fileName: 'needle3.cact',
    url: `${NEEDLE_RESOLVE_BASE}/needle3.cact`,
    bytes: 35_335_380,
    sha256: 'c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38',
    role: 'the 2-bit Needle 3 archive: weights, vocabulary and metadata',
  },
]

/**
 * The artifacts that were inspected but are NOT part of this deployment.
 *
 * Recorded so a later reader can tell "we chose not to pin this" from "we never looked".
 * `needle.h` is the C ABI header — it documents `needle_load`/`needle_complete`/
 * `needle_reset` and is what an in-process or WASM binding would be built against; the
 * native CLI route does not use it. The WASM pair is the directive's ADDITIONAL
 * qualification route, not a prerequisite.
 */
export const NEEDLE_INSPECTED_NOT_PINNED: readonly ArtifactPin[] = [
  {
    assetId: 'needle-header-win-x64',
    fileName: 'needle.h',
    url: `${NEEDLE_RESOLVE_BASE}/windows-x86_64/needle.h`,
    bytes: 4_528,
    sha256: 'a27dac4b3239eead91d124b7f7dbce5495c13019903fd817b68c16d39b055a99',
    role: 'the C ABI header; read for the engine contract, not loaded by this build',
  },
  {
    assetId: 'needle-wasm-js',
    fileName: 'wasm/needle.js',
    url: `${NEEDLE_RESOLVE_BASE}/wasm/needle.js`,
    bytes: 63_072,
    sha256: '964681b2a5ec3c4db2f06e45a5b60c8981a7d4ab4cac16ef6bf5b1988657a5f1',
    role: 'the WASM loader (qualification route two; not used by this build)',
  },
]

/** Look one pinned artifact up by asset id. */
export function artifactById(assetId: string): ArtifactPin | undefined {
  return NEEDLE_ARTIFACTS.find(artifact => artifact.assetId === assetId)
}

/** The engine pin, which the bridge must execute. */
export const NEEDLE_ENGINE_PIN: ArtifactPin = NEEDLE_ARTIFACTS[0] as ArtifactPin

/** The weights pin, which the engine must load. */
export const NEEDLE_WEIGHTS_PIN: ArtifactPin = NEEDLE_ARTIFACTS[1] as ArtifactPin
