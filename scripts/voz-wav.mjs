/**
 * A chunk-walking RIFF/WAVE reader for PCM files.
 *
 * Fixed-offset parsers (byteRate at 28, data length at 40) are only valid for a
 * canonical 44-byte header. Real writers vary: System.Speech emits an 18-byte
 * `fmt ` chunk (a 46-byte header) and other writers insert LIST/INFO chunks or
 * pad odd-sized chunks — the earlier qualification recorded 26330 "seconds" for
 * a 3.37-second WAV because offset 40 landed inside the `data` ASCII. This
 * parser walks the chunk list instead, so the duration is read from wherever
 * the chunks actually sit, and it refuses the inputs it cannot measure
 * honestly rather than returning a number.
 *
 * - `fmt `: PCM (audioFormat 1) only; 16- or 18-byte variants accepted.
 * - `data`: multiple data chunks are SUMMED (some writers split the payload).
 * - odd-sized chunks carry a pad byte; LIST/INFO chunks are skipped by their
 *   declared size.
 * - the RIFF size field must agree with the file length, and a chunk may not
 *   declare bytes past the end of the file — both are malformed inputs, and a
 *   duration computed from them would be a lie.
 *
 * @module scripts/voz-wav
 */

/**
 * Parse one WAV file's header.
 * @param {Buffer} bytes - the file's bytes (the qualification already holds them in memory).
 * @returns the measured format plus the summed data payload.
 * @throws Error with a named reason when the file is not a measurable PCM WAV.
 */
export function parseWave(bytes) {
  if (bytes.length < 12) throw new Error('not a RIFF/WAVE file: the header is truncated')
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(
      `not a RIFF/WAVE file: found ${JSON.stringify(bytes.toString('ascii', 0, 4))}/${JSON.stringify(bytes.toString('ascii', 8, 12))}`,
    )
  }
  const declared = bytes.readUInt32LE(4) + 8
  if (declared !== bytes.length) {
    throw new Error(`malformed RIFF: the size field declares ${declared} bytes but the file has ${bytes.length}`)
  }

  let offset = 12
  let format = null
  const dataRanges = []
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (body + size > bytes.length) {
      throw new Error(`malformed RIFF: the "${id}" chunk declares ${size} bytes past the end of the file`)
    }
    if (id === 'fmt ') {
      if (size < 16) throw new Error(`malformed RIFF: the fmt chunk is ${size} bytes; PCM needs at least 16`)
      format = {
        audioFormat: bytes.readUInt16LE(body),
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        byteRate: bytes.readUInt32LE(body + 8),
        blockAlign: bytes.readUInt16LE(body + 12),
        bitsPerSample: bytes.readUInt16LE(body + 14),
        fmtBytes: size,
      }
    } else if (id === 'data') {
      dataRanges.push({ offset: body, length: size })
    }
    // The pad byte after an odd-sized chunk is part of the RIFF layout.
    offset = body + size + (size & 1)
  }

  if (format === null) throw new Error('malformed RIFF: the WAV has no fmt chunk')
  if (format.audioFormat !== 1) {
    throw new Error(`audio format ${format.audioFormat} is not PCM; a duration over its payload would not be meaningful`)
  }
  if (format.byteRate === 0) throw new Error('malformed RIFF: the fmt chunk declares a zero byte rate')
  if (dataRanges.length === 0) throw new Error('malformed RIFF: the WAV has no data chunk')

  const dataBytes = dataRanges.reduce((sum, range) => sum + range.length, 0)
  return {
    audioFormat: format.audioFormat,
    channels: format.channels,
    sampleRate: format.sampleRate,
    byteRate: format.byteRate,
    blockAlign: format.blockAlign,
    bitsPerSample: format.bitsPerSample,
    fmtBytes: format.fmtBytes,
    dataRanges,
    dataBytes,
    /** The payload duration in seconds, from the measured byte rate. */
    durationSeconds: dataBytes / format.byteRate,
  }
}
