/**
 * The REAL EmbeddingGemma 2 text inference path (MOD-01..MOD-04, text half).
 *
 * This module is what turns the deployment's honest "not wired" build into one that
 * computes vectors. It is deliberately narrow and structural:
 *
 * - The ONNX session is created DIRECTLY over the pinned `model.onnx` (native CPU
 *   execution provider, `onnxruntime-node`), because the conversion's custom
 *   `embedding_gemma2` architecture has no dedicated class in @huggingface/transformers
 *   — its generic base class loads it, but the driver's model wrapper cannot run it
 *   without the modality inputs a text-only call does not have.
 * - Tokenization reuses the conversion's SHIPPED tokenizer (`tokenizer.json`, a
 *   `GemmaTokenizer`) loaded through @huggingface/transformers' `AutoTokenizer`, which
 *   is the package the lock's engine note names.
 * - The graph's three modality inputs (`image_features`, `video_features`,
 *   `audio_features`) are fed EMPTY [0, 512] tensors: the model's own
 *   `sentence_embedding` output is the 768-dimensional, ALREADY L2-normalized
 *   embedding of the text sequence. No vision/audio file is ever read or fetched
 *   here, which is the MOD-02 group boundary pinned by test.
 *
 * Both optional packages are imported dynamically at load time and typed
 * STRUCTURALLY (the same discipline as the voz adapter): the extension ships no
 * static dependency on either.
 *
 * @module @try-works/extension-embeddinggemma/inference
 */

/** The ONNX session surface this module consumes. */
interface OrtTensor {
  readonly dims: number[]
  readonly data: unknown
}

/** The structural ORT binding surface. */
interface OrtRuntime {
  readonly Tensor: new (type: string, data: unknown, dims: readonly number[]) => unknown
  readonly InferenceSession: {
    create(path: string, options: { readonly executionProviders: readonly string[] }): Promise<{
      run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>
      release(): Promise<void>
      inputNames: readonly string[]
      inputMetadata: Readonly<Record<string, { readonly dimensions: readonly (number | string)[] }>>
    }>
  }
}

/** The structural tokenizer surface. */
interface TokenizerRuntime {
  readonly AutoTokenizer: {
    from_pretrained(
      directory: string,
      options: { readonly local_files_only: boolean },
    ): Promise<{
      (text: string): Promise<{ readonly input_ids: OrtTensor; readonly attention_mask: OrtTensor }>
    }>
  }
}

/** One ready-to-embed session, bound to a pinned model directory. */
export interface TextEmbedder {
  /** Embed one text into the 768-dimensional, L2-normalized space. */
  embed(text: string): Promise<Float32Array>
  /**
   * Tokenize a prompt into the model's int64 id sequence.
   *
   * The prompt may carry the pinned placeholder token strings (`<|image|>`,
   * `<|audio|>` and their delimiters), which the shipped tokenizer maps to the
   * soft-token ids the model's modality features align with. Bos/eos are added
   * exactly once, by the tokenizer, as for a plain text call.
   */
  tokenize(text: string): Promise<{ readonly ids: BigInt64Array; readonly length: number }>
  /**
   * Run the FUSED model: a token sequence plus the modality feature rows that
   * correspond, in order, to the soft-token positions in that sequence.
   * @param ids - the tokenized prompt.
   * @param imageFeatures - flattened [rows, 512] vision features.
   * @param audioFeatures - flattened [rows, 512] audio features.
   * @param videoFeatures - flattened [frames*maxPatches, 512] video features.
   * @returns the 768-dimensional sentence embedding.
   */
  runFused(
    ids: BigInt64Array,
    imageFeatures: Float32Array,
    audioFeatures: Float32Array,
    videoFeatures: Float32Array,
  ): Promise<Float32Array>
  /** Release the ONNX session. */
  dispose(): Promise<void>
}

/** The native ONNX session, shared across embeds. */
interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>
  release(): Promise<void>
}

/**
 * Create the text embedder over the pinned backbone directory.
 *
 * The directory is the host-verified `text-backbone` asset path: it contains
 * `tokenizer.json` (and its config) at the root plus `onnx/model.onnx` with its
 * `model.onnx_data` beside it — exactly the five pinned files; nothing else is read.
 * @param modelDir - the verified backbone directory.
 * @returns the embedder, loaded and ready.
 */
export async function createTextEmbedder(modelDir: string): Promise<TextEmbedder> {
  const ort = await import('onnxruntime-node') as unknown as OrtRuntime
  const transformers = await import('@huggingface/transformers') as unknown as TokenizerRuntime

  const tokenizer = await transformers.AutoTokenizer.from_pretrained(modelDir, { local_files_only: true })
  const session: OrtSession = await ort.InferenceSession.create(
    `${modelDir.replace(/[\\/]+$/, '')}/onnx/model.onnx`,
    { executionProviders: ['cpu'] },
  ) as OrtSession

  let disposed = false
  const runFused = async (
    ids: BigInt64Array,
    imageFeatures: Float32Array,
    audioFeatures: Float32Array,
    videoFeatures: Float32Array,
  ): Promise<Float32Array> => {
    if (disposed) throw new Error('the text embedder has been disposed')
    const sequence = ids.length
    const feeds = {
      input_ids: new ort.Tensor('int64', ids, [1, sequence]),
      attention_mask: new ort.Tensor('int64', new BigInt64Array(sequence).fill(1n), [1, sequence]),
      image_features: new ort.Tensor('float32', imageFeatures, [imageFeatures.length / MODALITY_FEATURE_DIM, MODALITY_FEATURE_DIM]),
      video_features: new ort.Tensor('float32', videoFeatures, [videoFeatures.length / MODALITY_FEATURE_DIM, MODALITY_FEATURE_DIM]),
      audio_features: new ort.Tensor('float32', audioFeatures, [audioFeatures.length / MODALITY_FEATURE_DIM, MODALITY_FEATURE_DIM]),
    }
    const outputs = await session.run(feeds)
    const embedding = outputs['sentence_embedding']
    if (embedding === undefined) {
      throw new Error('the model ran but produced no sentence_embedding output; the pinned graph changed')
    }
    return new Float32Array(embedding.data as ArrayBuffer)
  }

  const embed = async (text: string): Promise<Float32Array> => {
    // The text-only call: the three modality inputs are fed EMPTY (rank 2,
    // [0, 512]) — the sentence embedding then depends on the text sequence
    // alone, which is the MOD-02 group boundary made executable.
    const encoded = await tokenizer(text)
    return await runFused(
      new BigInt64Array(encoded.input_ids.data as unknown as BigInt64Array),
      new Float32Array(0),
      new Float32Array(0),
      new Float32Array(0),
    )
  }

  return {
    embed,
    async tokenize(text: string) {
      const encoded = await tokenizer(text)
      const ids = new BigInt64Array(encoded.input_ids.data as unknown as BigInt64Array)
      return { ids, length: ids.length }
    },
    runFused,
    async dispose() {
      if (disposed) return
      disposed = true
      await session.release()
    },
  }
}

/**
 * One ready-to-run vision encoder session, bound to the pinned group directory.
 *
 * The session is created from `onnx/vision_encoder.onnx` (+ its data) — nothing
 * else in the directory is read, which is the MOD-02 group boundary for vision.
 */
export interface VisionEncoder {
  /** Encode canonical-grid RGB pixels ([0,1], 3 x H x W row-major) into the model's feature rows. */
  encode(pixels: Float32Array): Promise<Float32Array>
  /** Release the ONNX session. */
  dispose(): Promise<void>
}

/**
 * One ready-to-run audio encoder session, bound to the pinned group directory.
 */
export interface AudioEncoder {
  /** Encode a [frames, melBins] spectrogram into the model's feature rows. */
  encode(mel: Float32Array, frames: number, melBins: number): Promise<Float32Array>
  /** Release the ONNX session. */
  dispose(): Promise<void>
}

/** The vision encoder's canonical input grid, per the pinned processor_config. */
export const VISION_GRID = { height: 672, width: 960 } as const

/** The vision patch geometry (processor_config: patch_size 16, pooling 3). */
export const VISION_PATCHES = {
  patchSize: 16,
  /** Patches per row: 960 / 16 = 60. */
  cols: 60,
  /** Patches per column: 672 / 16 = 42. */
  rows: 42,
  /** Total patches: 60 * 42 = 2520, which the 3x3 pooling reduces to 280 tokens. */
  count: 2520,
  /** Flattened patch values: 3 channels * 16 * 16 = 768. */
  valuesPerPatch: 768,
} as const

/** The model's shared feature width. */
export const MODALITY_FEATURE_DIM = 512

/**
 * The canonical audio window (processor_config.json): 40 ms per soft token,
 * 280 tokens, and the 160-sample hop at 16 kHz yields exactly 1120 mel frames
 * per window — the graph's subsampling maps those to the 280 feature rows the
 * fused prompt places.
 */
export const AUDIO_WINDOW = {
  msPerToken: 40,
  softTokens: 280,
  windowSeconds: 11.2,
  melBins: 128,
  canonicalFrames: 1120,
} as const

/**
 * Patchify the canonical-grid CHW pixels into the vision encoder's flattened
 * patch tensor — [1, 2520, 768] with each patch's RGB values row-major — and the
 * per-patch axial position ids ([row, col] integers over the 42x60 grid), which
 * is the reconstruction of the original processor's `pixel_position_ids` this
 * qualification pins (recorded as such in the qualification record).
 * @param pixels - CHW float pixels on the pinned 672x960 grid.
 * @returns the patch tensor and the position ids.
 */
export function patchifyGrid(pixels: Float32Array): { patches: Float32Array; positions: BigInt64Array } {
  const { height, width } = VISION_GRID
  const { patchSize, cols, rows, count, valuesPerPatch } = VISION_PATCHES
  const patches = new Float32Array(count * valuesPerPatch)
  const positions = new BigInt64Array(count * 2)
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const patch = row * cols + col
      let cursor = 0
      for (let channel = 0; channel < 3; channel += 1) {
        for (let py = 0; py < patchSize; py += 1) {
          for (let px = 0; px < patchSize; px += 1) {
            const y = row * patchSize + py
            const x = col * patchSize + px
            patches[patch * valuesPerPatch + cursor] = pixels[(channel * height + y) * width + x] as number
            cursor += 1
          }
        }
      }
      positions[patch * 2] = BigInt(row)
      positions[patch * 2 + 1] = BigInt(col)
    }
  }
  return { patches, positions }
}

/**
 * Create the vision encoder over the pinned vision group directory.
 *
 * The pinned graph consumes FLATTENED PATCHES (`pixel_values`, [1, 2520, 768])
 * plus the axial `pixel_position_ids` ([1, 2520, 2]), and outputs the 512-wide
 * feature rows the fused model consumes — the observed signature of the pinned
 * revision, read from the session's own metadata rather than assumed.
 * @param modelDir - the verified vision-encoder asset directory.
 * @returns the encoder, loaded and ready.
 */
export async function createVisionEncoder(modelDir: string): Promise<VisionEncoder> {
  const ort = await import('onnxruntime-node') as unknown as OrtRuntime
  const session: OrtSession = await ort.InferenceSession.create(
    `${modelDir.replace(/[\\/]+$/, '')}/onnx/vision_encoder.onnx`,
    { executionProviders: ['cpu'] },
  ) as OrtSession
  const { count, valuesPerPatch } = VISION_PATCHES

  let disposed = false
  const encode = async (pixels: Float32Array): Promise<Float32Array> => {
    if (disposed) throw new Error('the vision encoder has been disposed')
    const { patches, positions } = patchifyGrid(pixels)
    const outputs = await session.run({
      pixel_values: new ort.Tensor('float32', patches, [1, count, valuesPerPatch]),
      pixel_position_ids: new ort.Tensor('int64', positions, [1, count, 2]),
    })
    const feature = outputs['image_features']
    if (feature === undefined) throw new Error('the vision encoder ran but produced no image_features output; the pinned graph changed')
    return new Float32Array(feature.data as ArrayBuffer)
  }

  return {
    encode,
    async dispose() {
      if (disposed) return
      disposed = true
      await session.release()
    },
  }
}

/**
 * Create the audio encoder over the pinned audio group directory.
 *
 * The PINNED GRAPH'S OBSERVED SIGNATURE (read from the protobuf at the pinned
 * revision): `input_features` float32 [1, frames, 128] plus a boolean
 * `input_features_mask` [1, frames], and one output, `audio_features`
 * [rows, 512]. The canonical audio window is 1120 mel frames (11.2 s at the
 * pinned 40 ms-per-token), which the graph's subsampling reduces to exactly the
 * 280 soft tokens the fused prompt places — shorter audio is padded to the
 * window with the mask marking the real frames; longer audio was refused at
 * the decoder boundary (MOD-08, no silent truncation).
 * @param modelDir - the verified audio-encoder asset directory.
 * @returns the encoder, loaded and ready.
 */
export async function createAudioEncoder(modelDir: string): Promise<AudioEncoder> {
  const ort = await import('onnxruntime-node') as unknown as OrtRuntime
  const session: OrtSession = await ort.InferenceSession.create(
    `${modelDir.replace(/[\\/]+$/, '')}/onnx/audio_encoder.onnx`,
    { executionProviders: ['cpu'] },
  ) as OrtSession
  const { canonicalFrames, melBins } = AUDIO_WINDOW

  let disposed = false
  const encode = async (mel: Float32Array, frames: number, bins: number): Promise<Float32Array> => {
    if (disposed) throw new Error('the audio encoder has been disposed')
    if (bins !== melBins) throw new Error(`audio: the pinned encoder consumes ${melBins} mel bins; got ${bins}`)
    if (mel.length !== frames * melBins) throw new Error('audio: the spectrogram does not match its declared frame count')
    if (frames > canonicalFrames) {
      throw new Error(
        `audio: ${frames} frames is over the ${canonicalFrames}-frame model window (${AUDIO_WINDOW.windowSeconds.toFixed(1)} s); `
        + 'the decoder refuses this rather than truncating it (MOD-08)',
      )
    }
    // Pad short audio to the canonical window; the mask marks the real frames
    // so the encoder knows where the silence pad begins.
    const padded = new Float32Array(canonicalFrames * melBins)
    padded.set(mel)
    const mask = new Uint8Array(canonicalFrames)
    mask.fill(0)
    mask.fill(1, 0, frames)
    const outputs = await session.run({
      input_features: new ort.Tensor('float32', padded, [1, canonicalFrames, melBins]),
      input_features_mask: new ort.Tensor('bool', mask, [1, canonicalFrames]),
    })
    const feature = outputs['audio_features']
    if (feature === undefined) throw new Error('the audio encoder ran but produced no audio_features output; the pinned graph changed')
    return new Float32Array(feature.data as ArrayBuffer)
  }

  return {
    encode,
    async dispose() {
      if (disposed) return
      disposed = true
      await session.release()
    },
  }
}

/**
 * The pinned video grid (processor_config.json video_processor + the
 * transformers EmbeddingGemma2VideoProcessor the conversion was exported
 * from): per-frame aspect-ratio-preserving resize to at most
 * `max_soft_tokens(140) * pooling(3)^2 = 1260` patches of 16 px (dims
 * divisible by `pooling*16 = 48`), each frame's patches zero-padded to 1260
 * with positions padded to -1, and `num_soft_tokens_per_video` = real
 * patches // 9 per frame.
 */
export const VIDEO_PREPROCESSING = {
  patchSize: 16,
  pooling: 3,
  maxSoftTokens: 140,
  maxFrames: 32,
  fps: 1,
  maxPatches: 140 * 9,
  patchPixels: 16 * 16 * 3,
} as const

/** The video soft-token placeholder (the tokenizer's single video token). */
export const VIDEO_SOFT_TOKEN = '<|video|>'

/** One video frame's prepared encoder input, in the pinned grid. */
export interface VideoFrameInput {
  /** [maxPatches, patchPixels] float patches, zero-padded (1/255-rescaled). */
  readonly patches: Float32Array
  /** [maxPatches, 2] axial positions [col, row], -1 for padded patches. */
  readonly positions: BigInt64Array
  /** The REAL patch count before padding. */
  readonly realPatches: number
}

/**
 * The pinned aspect-ratio-preserving resize for one video frame (ported from
 * the transformers `get_aspect_ratio_preserving_size` the conversion exports
 * with). Returns the target grid dims, multiples of `pooling * patchSize`.
 * @param height - the decoded frame height.
 * @param width - the decoded frame width.
 * @returns the target [height, width] grid.
 */
export function videoGridFor(height: number, width: number): { height: number; width: number } {
  const { patchSize, pooling, maxPatches } = VIDEO_PREPROCESSING
  const totalPx = height * width
  const targetPx = maxPatches * patchSize ** 2
  const factor = Math.sqrt(targetPx / totalPx)
  const sideMult = pooling * patchSize
  let targetHeight = Math.floor((factor * height) / sideMult) * sideMult
  let targetWidth = Math.floor((factor * width) / sideMult) * sideMult
  if (targetHeight === 0 && targetWidth === 0) {
    throw new Error(`video: a ${width}x${height} frame cannot be resized to the pinned video grid`)
  }
  const maxSide = Math.floor(maxPatches / pooling ** 2) * sideMult
  if (targetHeight === 0) {
    targetHeight = sideMult
    targetWidth = Math.min(Math.floor(width / height) * sideMult, maxSide)
  } else if (targetWidth === 0) {
    targetWidth = sideMult
    targetHeight = Math.min(Math.floor(height / width) * sideMult, maxSide)
  }
  if (targetHeight * targetWidth > targetPx) {
    throw new Error(`video: resizing to ${targetWidth}x${targetHeight} would exceed the ${maxPatches}-patch budget`)
  }
  return { height: targetHeight, width: targetWidth }
}

/**
 * Patchify one video frame onto the pinned video grid (the transformers
 * `convert_video_to_patches` + the axial positions + zero-padding to the
 * budget, ported faithfully).
 * @param pixels - CHW float pixels in [0, 1] on the RESIZED grid.
 * @param height - the resized grid height.
 * @param width - the resized grid width.
 * @returns the prepared frame input.
 */
export function patchifyVideoFrame(pixels: Float32Array, height: number, width: number): VideoFrameInput {
  const { patchSize, pooling, maxPatches, patchPixels } = VIDEO_PREPROCESSING
  const patchHeight = height / patchSize
  const patchWidth = width / patchSize
  const realPatches = patchHeight * patchWidth
  const patches = new Float32Array(maxPatches * patchPixels)
  const positions = new BigInt64Array(maxPatches * 2)
  // Real patches first: row-major over the patch grid; positions are the
  // meshgrid [x(col), y(row)] ordering the pinned processor emits.
  for (let row = 0; row < patchHeight; row += 1) {
    for (let col = 0; col < patchWidth; col += 1) {
      const patch = row * patchWidth + col
      let cursor = 0
      for (let channel = 0; channel < 3; channel += 1) {
        for (let py = 0; py < patchSize; py += 1) {
          for (let px = 0; px < patchSize; px += 1) {
            const y = row * patchSize + py
            const x = col * patchSize + px
            patches[patch * patchPixels + cursor] = pixels[(channel * height + y) * width + x] as number
            cursor += 1
          }
        }
      }
      positions[patch * 2] = BigInt(col)
      positions[patch * 2 + 1] = BigInt(row)
    }
  }
  // Padded patches: zero features with -1 positions (the graph's padding mask).
  for (let patch = realPatches; patch < maxPatches; patch += 1) {
    positions[patch * 2] = -1n
    positions[patch * 2 + 1] = -1n
  }
  const softTokens = realPatches / pooling ** 2
  if (!Number.isInteger(softTokens)) {
    throw new Error(`video: the ${patchWidth}x${patchHeight} patch grid does not divide by the ${pooling}x${pooling} pooling`)
  }
  return { patches, positions, realPatches }
}

/** One ready-to-run video encoder, over the pinned vision group directory. */
export interface VideoEncoder {
  /**
   * Encode one prepared frame into the per-frame feature block: exactly
   * `maxPatches` rows of width 512 (the padded patches contribute rows the
   * fused model's scatter masks through the -1 positions).
   * @param frame - the prepared frame.
   * @returns [maxPatches, 512] floats.
   */
  encode(frame: VideoFrameInput): Promise<Float32Array>
  dispose(): Promise<void>
}

/**
 * Create the video encoder over the pinned vision group directory.
 *
 * The SAME exported vision-encoder graph serves both grids: the image path
 * feeds the pinned 2520-patch image grid, and the video path feeds the pinned
 * 1260-patch video grid (the graph's output rows equal the input patch count,
 * so one frame yields 1260 rows; the fused model scatters the per-frame soft
 * tokens over them and masks the -1-position padding).
 */
export async function createVideoEncoder(modelDir: string): Promise<VideoEncoder> {
  const ort = await import('onnxruntime-node') as unknown as OrtRuntime
  const session: OrtSession = await ort.InferenceSession.create(
    `${modelDir.replace(/[\\/]+$/, '')}/onnx/vision_encoder.onnx`,
    { executionProviders: ['cpu'] },
  ) as OrtSession
  const { maxPatches, patchPixels } = VIDEO_PREPROCESSING
  let disposed = false

  return {
    async encode(frame) {
      if (disposed) throw new Error('the video encoder has been disposed')
      const outputs = await session.run({
        pixel_values: new ort.Tensor('float32', frame.patches, [1, maxPatches, patchPixels]),
        pixel_position_ids: new ort.Tensor('int64', frame.positions, [1, maxPatches, 2]),
      })
      const feature = outputs['image_features']
      if (feature === undefined) throw new Error('the video encoder ran but produced no image_features output; the pinned graph changed')
      return new Float32Array(feature.data as ArrayBuffer)
    },
    async dispose() {
      if (disposed) return
      disposed = true
      await session.release()
    },
  }
}
