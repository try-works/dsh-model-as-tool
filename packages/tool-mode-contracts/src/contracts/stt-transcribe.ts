/**
 * `stt.transcribe` — the canonical transcription contract (TOOL-01).
 *
 * This contract is model-free on purpose. Any conforming implementation binds to
 * it, so a caller addresses `stt_transcribe` once and the host decides which
 * model runs (BASE-02). Adding a second transcription model must not add a
 * second tool.
 *
 * The semantics block is the part a schema cannot express and the part the spec
 * insists on (DECL-01, TOOL-01): whether this transcribes or translates, what
 * the timestamps mean, and what an empty result means.
 *
 * @module @try-works/tool-mode-contracts/contracts/stt-transcribe
 */

import { withMeta } from '../meta.ts'
import type { ToolContract } from '../registry.ts'

/** Accepted audio container/codec combinations for the bounded decoder. */
export const STT_ADMITTED_FORMATS = ['wav-pcm16'] as const

/** The `stt.transcribe` contract at version 1.0.0. */
export const sttTranscribe: ToolContract = {
  contract: 'stt.transcribe',
  version: '1.0.0',
  toolName: 'stt_transcribe',
  description:
    'Transcribe a local audio recording into text with optional word timestamps. '
    + 'Runs on device by default; the caller selects no model. Accepts 16 kHz mono PCM16 WAV '
    + 'directly, and other encodings only through a tested decoder. Reports partial coverage '
    + 'rather than presenting an incomplete clip as fully transcribed.',

  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['audio'],
    properties: {
      audio: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1, description: 'Absolute path to the recording.' },
          sampleRateHz: {
            type: 'integer',
            minimum: 8000,
            maximum: 48000,
            description: 'Declared sample rate; inspected against the file header, not trusted.',
          },
          channels: { type: 'integer', minimum: 1, maximum: 2 },
        },
      },
      language: {
        type: 'string',
        minLength: 2,
        description: 'Requested language as a BCP-47/ISO 639 code. An unsupported request is an error, never a silent fallback.',
      },
      timestamps: {
        type: 'string',
        enum: ['none', 'word'],
        default: 'none',
        description: 'Word timestamps when requested; an implementation that cannot supply them must error rather than omit them.',
      },
    },
  },

  outputSchema: withMeta(
    {
      text: { type: 'string' },
      coverage: {
        type: 'object',
        additionalProperties: false,
        required: ['complete', 'transcribedSeconds'],
        properties: {
          complete: { type: 'boolean' },
          transcribedSeconds: { type: 'number', minimum: 0 },
          totalSeconds: { type: ['number', 'null'], minimum: 0 },
          reason: { type: ['string', 'null'] },
        },
      },
      words: {
        type: ['array', 'null'],
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'start', 'end'],
          properties: {
            text: { type: 'string' },
            start: { type: 'number', minimum: 0, description: 'Seconds from the start of the audio.' },
            end: { type: 'number', minimum: 0 },
          },
        },
      },
      language: { type: ['string', 'null'], description: 'The language actually recognized, when the implementation reports it.' },
    },
    ['text', 'coverage'],
  ),

  semantics: {
    operation: 'transcription',
    translation: false,
    timestampUnit: 'seconds',
    timestampReference: 'start-of-audio',
    emptyResultMeaning: 'valid-empty-transcript',
    partialResultMeaning: 'coverage.complete is false; the transcript is incomplete, not wrong',
    languageMismatch: 'error',
    unsupportedTimestampRequest: 'error',
  },

  limits: {
    maxAudioSeconds: 3600,
    maxAudioBytes: 512 * 1024 * 1024,
    admittedSampleRateHz: 16000,
    admittedChannels: 1,
  },

  unsupported: [
    'Encoding without a tested decoder: only wav-pcm16 is admitted directly; assume nothing from the file extension.',
    'Translation: this contract transcribes, it does not translate.',
    'Diarization or speaker attribution: separate capability.',
    'Timestamps when the selected implementation cannot produce them: reported as an error.',
    'Live/streaming audio: the input is a completed local file.',
  ],
}
