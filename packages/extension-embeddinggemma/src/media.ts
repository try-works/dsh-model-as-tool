/**
 * Bounded Node media decoders for the EmbeddingGemma 2 media path (MOD-07).
 *
 * The ONNX conversion's own `load_audio`/`load_video` helpers call browser
 * APIs, so this module owns the Node side of the boundary: a WAV decoder with
 * resampling and the Gemma4 mel preprocessing, and an image decoder over the
 * conversion's SHIPPED image preprocessing (resize to the vision encoder's
 * canonical grid, RGB, 1/255 rescale). Every decoder is bounded and local:
 *
 * - source files are SIZE-CAPPED before any parse (and a caller-supplied
 *   `range` is applied to audio before the spectrogram);
 * - decoded buffers are CAPPED by duration (audio) and by pixel count (image);
 * - nothing is truncated silently: an over-limit input is REFUSED with the
 *   limit named (MOD-08);
 * - no decoder shells out, imports a browser API, or fetches anything — all
 *   bytes come from the host-authorized local path.
 *
 * The image decoder reuses @huggingface/transformers' `RawImage` (sharp-backed
 * in Node), which is the same optional runtime surface the text path already
 * declares; the WAV/mel pipeline is implemented here so its arithmetic is
 * reviewable and golden-tested like the rest of this package's deterministic
 * maths.
 *
 * @module @try-works/extension-embeddinggemma/media
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

/** The Gemma4 audio preprocessing constants, from the pinned preprocessor_config.json. */
export const AUDIO_PREPROCESSING = {
  /** Samples per second the model consumes (preprocessor_config.json). */
  samplingRate: 16000,
  /** Mel bins (feature_size). */
  melBins: 128,
  /** FFT length the spectrogram uses. */
  fftLength: 512,
  /** Analysis window in samples (frame_length). */
  frameLength: 320,
  /** Window stride in samples (hop_length). */
  hopLength: 160,
  /** Highest mel frequency in Hz (max_frequency). */
  maxFrequency: 8000,
  /** Log floor (mel_floor). */
  melFloor: 0.001,
  /** The model's audio token window (processor_config.json audio_seq_length). */
  audioSeqLength: 280,
  /** The canonical window in mel frames: 280 tokens x 40 ms at the 10 ms hop. */
  canonicalFrames: 1120,
  /** The canonical window in seconds (the model's audio context). */
  windowSeconds: 11.2,
} as const

/** The image preprocessing constants, from the pinned processor_config.json. */
export const IMAGE_PREPROCESSING = {
  /** The vision encoder's canonical input grid (patch 16, pooling 3, 280 tokens). */
  height: 672,
  width: 960,
  /** Soft tokens one image occupies in the text sequence. */
  softTokensPerImage: 280,
  /** The 1/255 rescale the processor applies. */
  rescaleFactor: 0.00392156862745098,
} as const

/** Decoder bounds (MOD-08, RES-09's initial source/decoded figures). */
export const MEDIA_LIMITS = {
  /** Largest image source admitted, in bytes. */
  maxImageBytes: 8 * 1024 * 1024,
  /** Largest decoded pixel count admitted (16 megapixels). */
  maxImagePixels: 16 * 1024 * 1024,
  /** Largest audio source admitted, in bytes. */
  maxAudioBytes: 64 * 1024 * 1024,
  /** Longest audio admitted, in seconds — the model's own 11.2 s window (MOD-08). */
  maxAudioSeconds: 11.2,
  /** Largest video source admitted, in bytes. */
  maxVideoBytes: 64 * 1024 * 1024,
  /** Most frames a video container may declare (refused before any allocation). */
  maxVideoFrames: 8192,
  /** Largest video frame dimension admitted, in pixels. */
  maxVideoDimension: 4096,
  /** Most frames the model's video processor samples (processor_config.json). */
  maxVideoSamples: 32,
} as const

/** The pinned video sampling constants (processor_config.json video_processor). */
export const VIDEO_PREPROCESSING = {
  /** Frames per second the processor samples at. */
  fps: 1,
  /** Soft-token budget the model's video path has per part. */
  maxSoftTokens: 140,
  /** The processor's max_frames. */
  maxFrames: 32,
} as const

/** A decoded, resampled mono audio buffer. */
export interface DecodedAudio {
  /** Mono samples at {@link AUDIO_PREPROCESSING.samplingRate}. */
  readonly samples: Float32Array
  /** The duration in seconds, after any caller range. */
  readonly seconds: number
  /** The source file's own sample rate, before resampling. */
  readonly sourceRate: number
}

/** A decoded RGB image. */
export interface DecodedImage {
  /** RGB pixel data, row-major, values in [0, 1]. */
  readonly pixels: Float32Array
  readonly width: number
  readonly height: number
}

/** One sampled, decoded video frame. */
export interface SampledVideoFrame {
  /** The frame's index in the container (0-based). */
  readonly index: number
  /** The frame's timestamp in seconds (index / declared frame rate). */
  readonly timestampSeconds: number
  /** BGR24 row data, bottom-up, each row padded to a 4-byte boundary (DIB layout). */
  readonly bytes: Buffer
}

/** The bounded parse of one AVI container (uncompressed DIB frames only). */
export interface ParsedVideo {
  readonly width: number
  readonly height: number
  readonly frames: number
  /** The declared playback rate, frames per second (0 = undeclared). */
  readonly declaredFps: number
  /** The sampled frames, at the pinned 1 fps (uniform when the budget overflows). */
  readonly samples: readonly SampledVideoFrame[]
  /** Timestamps of every sample, in seconds. */
  readonly sampleTimestamps: readonly number[]
}

/**
 * Parse an AVI RIFF container holding UNCOMPRESSED DIB frames and sample the
 * pinned 1 fps window.
 *
 * THE SUPPORTED CONTAINER+CODEC IS ONE AND WELL-DEFINED: a RIFF/AVI file whose
 * video stream is raw uncompressed DIB (`biCompression === 0`, fourcc 'DIB ').
 * Raw DIB frames are spec-level byte layouts (BITMAPINFOHEADER + bottom-up
 * BGR24 rows padded to 4-byte boundaries) with NO codec — this module reads
 * them directly, which is what makes the decode honest and bounded. Anything
 * compressed (any non-zero biCompression) is REFUSED BY NAME: a codec this
 * build does not implement must not be half-read (MOD-07).
 *
 * Every bound is enforced BEFORE the proportional allocation: the declared
 * frame count and dimensions gate the per-frame buffers, the source is
 * size-capped, and every chunk read is bounded by the chunk's declared size,
 * so a malformed size cannot drive an out-of-bounds read.
 *
 * Provenance: the RIFF/AVI container layout (the 'hdrl'/'avih', 'strl'/'strh'/
 * 'strf' and 'movi'/'00db' chunk structure) and the BITMAPINFOHEADER/DIB frame
 * layout are public format specifications; no codec dependency is introduced.
 * @param path - the host-authorized file.
 * @param range - optional time window; the 1 fps samples outside it are dropped
 *   (the container parse stays whole, so `frames`/`declaredFps` keep naming the
 *   FULL source for the window planner — MOD-13).
 * @returns the container metadata and the sampled frames.
 */
export async function sampleVideoFrames(
  path: string,
  range?: { readonly startSeconds: number; readonly endSeconds: number },
): Promise<ParsedVideo> {
  const bytes = await readBounded(path, MEDIA_LIMITS.maxVideoBytes, 'video')
  if (bytes.byteLength < 16 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'AVI ') {
    throw new Error('video: not a RIFF/AVI file (the only supported container)')
  }
  // Walk the LIST chunks: 'hdrl' carries avih + strl/strh/strf, 'movi' carries
  // the frame chunks. Indexes (idx1) are ignored — movi chunk sizes are the
  // bound, and trusting an index would open a second source of lengths.
  let width = 0
  let height = 0
  let frames = 0
  let microsecondsPerFrame = 0
  let bitsPerPixel = 0
  let biCompression = -1
  const frameChunks: { offset: number; size: number }[] = []
  const walk = (start: number, end: number, inside: string): void => {
    let offset = start
    while (offset + 8 <= end) {
      const id = bytes.toString('ascii', offset, offset + 4)
      const size = u32(bytes, offset + 4)
      const body = offset + 8
      const next = body + size + (size & 1)
      if (body < 0 || next > end) throw new Error('video: a chunk extends past the container; refused (MOD-07)')
      if (id === 'LIST') {
        const listType = bytes.toString('ascii', body, body + 4)
        walk(body + 4, next, listType)
      } else if (inside === 'hdrl' && id === 'avih') {
        if (size < 40) throw new Error('video: a truncated avih header; refused')
        microsecondsPerFrame = u32(bytes, body + 4)
        frames = u32(bytes, body + 16)
        width = u32(bytes, body + 32)
        height = u32(bytes, body + 36)
      } else if (inside === 'strl' && id === 'strh') {
        if (size < 56) throw new Error('video: a truncated strh header; refused')
        // bytes 0-3: fourcc; bytes 20-23: frame count; bytes 24-27: sample rate.
        frames = Math.max(frames, u32(bytes, body + 20))
        microsecondsPerFrame = Math.max(microsecondsPerFrame, u32(bytes, body + 24))
      } else if (inside === 'strl' && id === 'strf') {
        if (size < 40) throw new Error('video: a truncated strf header; refused')
        const headerSize = u32(bytes, body)
        const biWidth = u32(bytes, body + 4)
        const biHeight = u32(bytes, body + 8)
        const planes = u16(bytes, body + 12)
        bitsPerPixel = u16(bytes, body + 14)
        biCompression = u32(bytes, body + 16)
        if (headerSize < 40 || planes !== 1) throw new Error('video: an unsupported BITMAPINFOHEADER variant; refused (MOD-07)')
        if (biWidth !== width || biHeight !== height) {
          throw new Error(`video: the frame header declares ${biWidth}x${biHeight}, disagreeing with the container's ${width}x${height}; refused (MOD-07)`)
        }
      } else if (inside === 'movi' && (id === '00db' || id === '00dc')) {
        frameChunks.push({ offset: body, size })
      }
      offset = next
    }
  }
  walk(12, bytes.byteLength, 'root')

  if (biCompression !== 0) {
    throw new Error(
      `video: the stream is ${biCompression === -1 ? 'undeclared' : `compressed (biCompression ${biCompression})`}; `
      + 'only uncompressed DIB frames are implemented, and a codec this build does not ship is refused by name (MOD-07)',
    )
  }
  if (width === 0 || height === 0) throw new Error('video: the container declares no frame dimensions; refused')
  if (width > MEDIA_LIMITS.maxVideoDimension || height > MEDIA_LIMITS.maxVideoDimension) {
    throw new Error(`video: ${width}x${height} exceeds the ${MEDIA_LIMITS.maxVideoDimension}-pixel dimension cap; refused (MOD-08)`)
  }
  if (frameChunks.length === 0) throw new Error('video: the container has no DIB frames; refused (MOD-18)')
  if (frameChunks.length > MEDIA_LIMITS.maxVideoFrames) {
    throw new Error(`video: ${frameChunks.length} frames exceeds the ${MEDIA_LIMITS.maxVideoFrames}-frame cap; refused (MOD-08)`)
  }
  // The declared frames may disagree with the movi content; the CONTENT is the
  // truth, and an over-declared count was already capped. (frames is kept for
  // the metadata report; sampling walks the actual chunks.)

  // The DIB row stride: BGR24 rows padded to 4-byte boundaries; the declared
  // bitsPerPixel must match what the stride promises.
  const rowBytes = width * (bitsPerPixel / 8)
  if (bitsPerPixel !== 24 || rowBytes <= 0) {
    throw new Error(`video: ${bitsPerPixel}-bit frames are not BGR24; refused by name (MOD-07)`)
  }
  const stride = Math.ceil((width * 3) / 4) * 4
  const frameBytes = stride * height

  // The pinned sampling: 1 fps, at most maxVideoSamples frames, UNIFORM over
  // the container when the frame count overflows the budget (the processor's
  // overflow_strategy 'uniform'). Sampling indices are derived from the
  // declared frame rate so timestamps name real time.
  const declaredFps = microsecondsPerFrame > 0 ? 1_000_000 / microsecondsPerFrame : 0
  const secondsPerSample = VIDEO_PREPROCESSING.fps > 0 ? 1 / VIDEO_PREPROCESSING.fps : 1
  const frameStep = Math.max(1, Math.round(secondsPerSample * (declaredFps > 0 ? declaredFps : 1)))
  const indices = new Set<number>()
  for (let cursor = 0; cursor < frameChunks.length && indices.size < MEDIA_LIMITS.maxVideoSamples; cursor += frameStep) {
    indices.add(cursor)
  }
  // When the fps-based selection overflows (fewer candidates than the budget
  // allows are reachable), keep what the uniform walk selected; a short
  // container simply yields its reachable samples — never a duplicate fill.
  const samples: SampledVideoFrame[] = []
  for (const index of [...indices].sort((a, b) => a - b)) {
    const chunk = frameChunks[index]!
    if (chunk.size !== frameBytes) {
      throw new Error(
        `video: frame ${index} carries ${chunk.size} bytes, not the ${frameBytes} its ${width}x${height} BGR24 layout requires; refused (MOD-07)`,
      )
    }
    const frame = bytes.subarray(chunk.offset, chunk.offset + chunk.size)
    samples.push({
      index,
      timestampSeconds: declaredFps > 0 ? index / declaredFps : index,
      // The buffer is COPIED so the sample owns its bytes independent of the source.
      bytes: Buffer.from(frame),
    })
  }
  const ranged = range === undefined
    ? samples
    : samples.filter(sample => (
      sample.timestampSeconds >= range.startSeconds
      && sample.timestampSeconds < range.endSeconds
    ))
  return {
    width,
    height,
    frames: frameChunks.length,
    declaredFps,
    samples: ranged,
    sampleTimestamps: ranged.map(sample => sample.timestampSeconds),
  }
}

/** Read a bounded file fully. */
async function readBounded(path: string, cap: number, label: string): Promise<Buffer> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`${label}: the path is not a regular file`)
  if (info.size > cap) {
    throw new Error(`${label}: the source is ${info.size} bytes, over the ${cap}-byte limit; refused rather than partially read (MOD-08)`)
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of createReadStream(path)) {
    const piece = chunk as Buffer
    received += piece.byteLength
    if (received > cap) {
      throw new Error(`${label}: the source grew past the ${cap}-byte limit while reading; refused (MOD-08)`)
    }
    chunks.push(piece)
  }
  return Buffer.concat(chunks)
}

/** Read a little-endian unsigned integer from a WAV header. */
function u16(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset)
}

/** Read a little-endian unsigned 32-bit integer from a WAV header. */
function u32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset)
}

/** Read a little-endian IEEE-754 float from a WAV header. */
function f32(buffer: Buffer, offset: number): number {
  return buffer.readFloatLE(offset)
}

/**
 * Decode a WAV file into mono float samples at the model's 16 kHz rate.
 *
 * Supported containers: PCM16 (mono/stereo) and float32 (mono/stereo). Anything
 * else is refused by name — a codec the decoder does not implement must not be
 * half-read (MOD-07). Stereo is merged by averaging; the source rate is
 * resampled to 16 kHz by linear interpolation; the caller's `range` selects a
 * bounded window AFTER resampling so the slice indices name real time.
 * @param path - the host-authorized file.
 * @param range - optional [startSeconds, endSeconds] window.
 * @returns the decoded samples and honest measurements.
 */
export async function decodeWav(
  path: string,
  range?: { readonly startSeconds: number; readonly endSeconds: number },
): Promise<DecodedAudio> {
  const bytes = await readBounded(path, MEDIA_LIMITS.maxAudioBytes, 'audio')
  if (bytes.byteLength < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('audio: not a RIFF/WAVE file')
  }
  let offset = 12
  let format = 0
  let channels = 0
  let rate = 0
  let dataOffset = -1
  let dataBytes = 0
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = bytes.toString('ascii', offset, offset + 4)
    const size = u32(bytes, offset + 4)
    if (chunkId === 'fmt ') {
      format = u16(bytes, offset + 8)
      channels = u16(bytes, offset + 10)
      rate = u32(bytes, offset + 12)
    } else if (chunkId === 'data') {
      dataOffset = offset + 8
      dataBytes = size
      break
    }
    offset += 8 + size + (size & 1)
  }
  if (dataOffset === -1) throw new Error('audio: the WAV has no data chunk')
  if (format !== 1 && format !== 3) {
    throw new Error(`audio: WAV format ${format} is not PCM16 or float32; refused by name (MOD-07)`)
  }
  if (channels !== 1 && channels !== 2) throw new Error(`audio: ${channels} channels is not mono or stereo; refused (MOD-07)`)
  if (rate < 8000 || rate > 96000) throw new Error(`audio: sample rate ${rate} is outside the accepted 8-96 kHz range (MOD-07)`)

  const frames = Math.floor(dataBytes / (channels * (format === 3 ? 4 : 2)))
  const mono = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      const index = offsetOf(frame, channel, channels, format === 3 ? 4 : 2)
      const value = format === 3
        ? f32(bytes, dataOffset + index)
        : u16(bytes, dataOffset + index) / 32768
      sum += value
    }
    mono[frame] = sum / channels
  }

  const sourceSeconds = frames / rate
  const startSample = Math.max(0, Math.floor((range?.startSeconds ?? 0) * AUDIO_PREPROCESSING.samplingRate))
  const endSample = Math.min(
    frames,
    Math.ceil((range?.endSeconds ?? sourceSeconds) * AUDIO_PREPROCESSING.samplingRate),
  )
  const count = Math.max(0, endSample - startSample)
  if (count === 0) throw new Error('audio: the requested range selects no samples; an empty window is refused (MOD-18)')

  // Linear resample to 16 kHz.
  const resampled = new Float32Array(Math.ceil(count * (AUDIO_PREPROCESSING.samplingRate / rate)) || 1)
  for (let out = 0; out < resampled.length; out += 1) {
    const position = (out * rate) / AUDIO_PREPROCESSING.samplingRate + startSample
    const base = Math.min(frames - 1, Math.floor(position))
    const next = Math.min(frames - 1, base + 1)
    const fraction = position - base
    resampled[out] = mono[base]! * (1 - fraction) + mono[next]! * fraction
  }
  const seconds = resampled.length / AUDIO_PREPROCESSING.samplingRate
  if (seconds > MEDIA_LIMITS.maxAudioSeconds) {
    throw new Error(`audio: ${seconds.toFixed(2)} s is over the ${MEDIA_LIMITS.maxAudioSeconds} s limit; refused, never truncated (MOD-08)`)
  }
  return { samples: resampled, seconds, sourceRate: rate }
}

/** Byte offset of one frame/channel sample in the data chunk. */
function offsetOf(frame: number, channel: number, channels: number, bytesPerSample: number): number {
  return (frame * channels + channel) * bytesPerSample
}

/** Radix-2 real FFT (in-place complex), magnitude-squared spectrum returned. */
function magnitudeSpectrum(windowed: Float32Array): Float32Array {
  const n = windowed.length
  const real = new Float32Array(n)
  const imag = new Float32Array(n)
  real.set(windowed)
  // Bit-reversal permutation.
  for (let i = 0, j = 0; i < n; i += 1) {
    if (j > i) {
      const tr = real[i]!
      real[i] = real[j]!
      real[j] = tr
    }
    let m = n >> 1
    while (m >= 1 && j >= m) {
      j -= m
      m >>= 1
    }
    j += m
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1
    const step = (2 * Math.PI) / size
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k += 1) {
        const cos = Math.cos(step * k)
        const sin = -Math.sin(step * k)
        const evenReal = real[i + k]!
        const evenImag = imag[i + k]!
        const oddReal = real[i + half + k]!
        const oddImag = imag[i + half + k]!
        const tReal = oddReal * cos - oddImag * sin
        const tImag = oddReal * sin + oddImag * cos
        real[i + k] = evenReal + tReal
        imag[i + k] = evenImag + tImag
        real[i + half + k] = evenReal - tReal
        imag[i + half + k] = evenImag - tImag
      }
    }
  }
  const magnitude = new Float32Array(n / 2 + 1)
  for (let k = 0; k < magnitude.length; k += 1) {
    magnitude[k] = real[k]! * real[k]! + imag[k]! * imag[k]!
  }
  return magnitude
}

/** The Hz of FFT bin k. */
function binHz(k: number): number {
  return (k * AUDIO_PREPROCESSING.samplingRate) / AUDIO_PREPROCESSING.fftLength
}

/** Mel-scale Hz. */
function melOf(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700)
}

/** Hz from mel scale. */
function hzOf(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1)
}

/**
 * The Gemma4 mel spectrogram: hann windows, power spectrum, 128 mel bins over
 * 0-8 kHz, log with the pinned mel floor (preprocessor_config.json).
 * @param samples - 16 kHz mono samples.
 * @returns [frames, 128] float rows, ready for the audio encoder.
 */
export function melSpectrogram(samples: Float32Array): Float32Array {
  const { fftLength, frameLength, hopLength, melBins, maxFrequency, melFloor } = AUDIO_PREPROCESSING
  const frames = Math.max(1, Math.floor((samples.length - frameLength) / hopLength) + 1)
  const hann = new Float32Array(frameLength)
  for (let i = 0; i < frameLength; i += 1) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frameLength - 1)))
  // The mel filterbank, computed from the pinned constants.
  const maxMel = melOf(maxFrequency)
  const points: number[] = []
  for (let m = 0; m < melBins + 2; m += 1) points.push(hzOf((m * maxMel) / (melBins + 1)))
  const banks: { start: number; center: number; end: number }[] = []
  for (let m = 0; m < melBins; m += 1) {
    banks.push({ start: points[m]!, center: points[m + 1]!, end: points[m + 2]! })
  }
  const rows = new Float32Array(frames * melBins)
  for (let frame = 0; frame < frames; frame += 1) {
    const windowed = new Float32Array(fftLength)
    for (let i = 0; i < frameLength; i += 1) {
      windowed[i] = (samples[frame * hopLength + i] ?? 0) * hann[i]!
    }
    const spectrum = magnitudeSpectrum(windowed)
    for (let m = 0; m < melBins; m += 1) {
      const { start, center, end } = banks[m]!
      let sum = 0
      for (let k = 0; k < spectrum.length; k += 1) {
        const hz = binHz(k)
        if (hz < start || hz > end) continue
        const weight = hz <= center ? (hz - start) / (center - start) : (end - hz) / (end - center)
        sum += spectrum[k]! * weight
      }
      rows[frame * melBins + m] = Math.log(Math.max(sum + 1, melFloor))
    }
  }
  return rows
}

/** The transformers RawImage surface this module consumes (sharp-backed in Node). */
interface RawImageSurface {
  readonly width: number
  readonly height: number
  resize(width: number, height: number, options?: { readonly resample?: number }): Promise<RawImageSurface>
  /** transformers 3.x: a uint8 tensor in CHW layout; normalization is the CALLER's job. */
  toTensor(format: 'CHW'): { readonly data: Uint8Array; readonly dims: readonly number[] }
}

/**
 * Decode an image into the vision encoder's canonical grid.
 *
 * Reuses @huggingface/transformers' `RawImage` (the same optional runtime the
 * text path declares), then bounds the DECODED pixel count and resizes to the
 * pinned 960x672 grid with the pinned bicubic resample (resample 3). The 1/255
 * rescale (processor_config.json rescale_factor) is applied HERE over the
 * decoder's uint8 CHW tensor — no normalization beyond the pinned parameters,
 * so the bytes a caller supplies meet exactly the preprocessing the model was
 * converted with.
 * @param path - the host-authorized image file (PNG/JPEG/WebP via sharp).
 * @returns RGB pixels in [0, 1], CHW on the canonical grid.
 */
export async function decodeImage(path: string): Promise<DecodedImage> {
  const bytes = await readBounded(path, MEDIA_LIMITS.maxImageBytes, 'image')
  if (bytes.byteLength < 8) throw new Error('image: the source is too small to be an image')
  const transformers = await import('@huggingface/transformers') as unknown as { RawImage: { read(path: string): Promise<RawImageSurface> } }
  let raw: RawImageSurface
  try {
    raw = await transformers.RawImage.read(path)
  } catch (error) {
    throw new Error(`image: the decoder could not read the file: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (raw.width * raw.height > MEDIA_LIMITS.maxImagePixels) {
    throw new Error(
      `image: ${raw.width}x${raw.height} decodes to ${raw.width * raw.height} pixels, over the `
      + `${MEDIA_LIMITS.maxImagePixels}-pixel limit; refused rather than downscaled silently (MOD-08)`,
    )
  }
  // The pinned preprocessing: resize to the canonical grid with bicubic
  // resampling, then the 1/255 rescale over the decoder's CHW uint8 tensor.
  // The sharp-backed resize returns a NEW RawImage; the returned value is the
  // resized image.
  raw = await raw.resize(IMAGE_PREPROCESSING.width, IMAGE_PREPROCESSING.height, { resample: 3 }) as unknown as RawImageSurface
  const tensor = raw.toTensor('CHW')
  const channels = tensor.dims[0] as number
  const height = tensor.dims[1] as number
  const width = tensor.dims[2] as number
  if (channels !== 3 || height !== IMAGE_PREPROCESSING.height || width !== IMAGE_PREPROCESSING.width) {
    throw new Error(`image: the decoder produced ${channels}x${height}x${width}, not the pinned 3x${IMAGE_PREPROCESSING.height}x${IMAGE_PREPROCESSING.width} grid`)
  }
  const pixels = new Float32Array(tensor.data.length)
  for (let i = 0; i < tensor.data.length; i += 1) {
    pixels[i] = (tensor.data[i] as number) * IMAGE_PREPROCESSING.rescaleFactor
  }
  return { pixels, width: IMAGE_PREPROCESSING.width, height: IMAGE_PREPROCESSING.height }
}

/**
 * Decode one sampled DIB video frame into CHW float pixels in [0, 1].
 *
 * The AVI sampler's frames are BOTTOM-UP BGR24 rows padded to 4-byte
 * boundaries (the pinned DIB layout); this flips them to top-down RGB CHW
 * with the pinned 1/255 rescale — exactly what the video processor's
 * `rescale_and_normalize` produces before the aspect-ratio-preserving resize.
 * @param frame - one sampled frame's bytes.
 * @param width - the declared frame width.
 * @param height - the declared frame height.
 * @returns CHW pixels in [0, 1].
 */
export function decodeVideoFrameToPixels(frame: Buffer, width: number, height: number): Float32Array {
  const stride = Math.ceil((width * 3) / 4) * 4
  if (frame.byteLength !== stride * height) {
    throw new Error(`video: a frame carries ${frame.byteLength} bytes, not the ${stride * height} its ${width}x${height} layout requires`)
  }
  const pixels = new Float32Array(3 * height * width)
  for (let y = 0; y < height; y += 1) {
    // DIB rows are bottom-up: buffer row y is the image row (height-1-y).
    const sourceRow = y * stride
    const targetRow = (height - 1 - y) * width
    for (let x = 0; x < width; x += 1) {
      const blue = frame.readUInt8(sourceRow + x * 3) as number
      const green = frame.readUInt8(sourceRow + x * 3 + 1) as number
      const red = frame.readUInt8(sourceRow + x * 3 + 2) as number
      pixels[targetRow + x] = red * IMAGE_PREPROCESSING.rescaleFactor
      pixels[height * width + targetRow + x] = green * IMAGE_PREPROCESSING.rescaleFactor
      pixels[2 * height * width + targetRow + x] = blue * IMAGE_PREPROCESSING.rescaleFactor
    }
  }
  return pixels
}

/** The Catmull-Rom cubic kernel weight (bounded bicubic resize). */
function cubicWeight(t: number): number {
  const a = -0.5
  const at = Math.abs(t)
  if (at <= 1) return (a + 2) * at ** 3 - (a + 3) * at ** 2 + 1
  if (at < 2) return a * at ** 3 - 5 * a * at ** 2 + 8 * a * at - 4 * a
  return 0
}

/**
 * A bounded bicubic resize of one CHW image (the video processor's pinned
 * BICUBIC resample, implemented in reviewable Node maths — no decoder
 * process, no sharp dependency for the frame path).
 * @param pixels - CHW source pixels.
 * @param srcHeight - source height.
 * @param srcWidth - source width.
 * @param dstHeight - target height (a multiple of the pinned side multiple).
 * @param dstWidth - target width.
 * @returns the resized CHW pixels.
 */
export function bicubicResizeChw(
  pixels: Float32Array,
  srcHeight: number,
  srcWidth: number,
  dstHeight: number,
  dstWidth: number,
): Float32Array {
  if (srcHeight === dstHeight && srcWidth === dstWidth) return pixels
  const out = new Float32Array(3 * dstHeight * dstWidth)
  const scaleY = srcHeight / dstHeight
  const scaleX = srcWidth / dstWidth
  for (let channel = 0; channel < 3; channel += 1) {
    const src = pixels.subarray(channel * srcHeight * srcWidth, (channel + 1) * srcHeight * srcWidth)
    const dst = out.subarray(channel * dstHeight * dstWidth, (channel + 1) * dstHeight * dstWidth)
    for (let y = 0; y < dstHeight; y += 1) {
      const sy = (y + 0.5) * scaleY - 0.5
      const y0 = Math.floor(sy)
      for (let x = 0; x < dstWidth; x += 1) {
        const sx = (x + 0.5) * scaleX - 0.5
        const x0 = Math.floor(sx)
        let sum = 0
        for (let dy = -1; dy <= 2; dy += 1) {
          const wy = cubicWeight(sy - (y0 + dy))
          for (let dx = -1; dx <= 2; dx += 1) {
            const sampleX = Math.min(srcWidth - 1, Math.max(0, x0 + dx))
            const sampleY = Math.min(srcHeight - 1, Math.max(0, y0 + dy))
            sum += (src[sampleY * srcWidth + sampleX] as number) * wy * cubicWeight(sx - (x0 + dx))
          }
        }
        dst[y * dstWidth + x] = sum
      }
    }
  }
  return out
}
