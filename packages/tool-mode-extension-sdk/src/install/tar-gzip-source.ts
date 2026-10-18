/**
 * A real, npm-tarball-backed {@link ArchiveSource} (gzip + POSIX tar).
 *
 * npm publishes `.tgz` files; the ZIP reader cannot serve them. This reader
 * applies the SAME defense discipline as the ZIP path, plus the inflate-time
 * bound that a zip bomb's metadata makes unnecessary there:
 *
 * - gzip inflation is STREAMED under a byte cap (the cap fires BEFORE the
 *   inflated payload is allocated), then the expansion ratio is checked;
 * - tar headers are parsed per block (regular/directory/symlink/hardlink, GNU
 *   longname 'L'/'K', pax 'x'/'g' path records); symlinks and hardlinks are
 *   reported as links so the entry-list validator REFUSES them — never resolved;
 * - the entry list then flows through the shared `validateArchiveEntries`
 *   defenses (traversal, absolute paths, Windows device names, duplicates,
 *   case collisions, count/byte/ratio caps) exactly like the ZIP reader;
 * - npm roots everything under `package/`: that one leading segment is
 *   stripped, the bare `package` directory entry is ignored, and a MIXED
 *   layout (entries both under and outside `package/`) is refused as
 *   ambiguous rather than guessed at;
 * - truncation and malformed headers refuse with named codes.
 *
 * Like the ZIP reader, it carries no fetcher of its own: a caller supplies
 * the tarball bytes (a host wraps its registry transport), and a test
 * supplies bytes directly.
 *
 * @module @try-works/tool-mode-extension-sdk/install/tar-gzip-source
 */

import { gunzipSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { ManagementError } from './../errors.ts'
import { DEFAULT_ARCHIVE_LIMITS, type ArchiveEntry, type ArchiveEntryKind } from './archive.ts'
import type { ArchiveSource, InstallSource } from './staged.ts'

/** The npm tarball wrapper directory. */
const NPM_ROOT = 'package'

/** One parsed tar header's metadata. */
interface TarHeader {
  readonly name: string
  readonly prefix: string
  readonly size: number
  readonly typeflag: string
  readonly linkname: string
}

/** Bounds for the inflate side of a tarball. */
export interface TarGzipLimits {
  /** Maximum inflated bytes, enforced DURING inflation before allocation. */
  readonly maxInflatedBytes: number
  /** Maximum inflated-to-compressed ratio, checked before the payload is kept. */
  readonly maxExpansionRatio: number
}

/** The inflate bounds, mirrored from the shared archive defaults. */
const DEFAULT_TAR_GZIP_LIMITS: TarGzipLimits = {
  maxInflatedBytes: DEFAULT_ARCHIVE_LIMITS.maxTotalBytes,
  maxExpansionRatio: DEFAULT_ARCHIVE_LIMITS.maxExpansionRatio,
}

/** Refuse a malformed or hostile tarball with one named, distinct message. */
function refuse(why: string): never {
  throw new ManagementError(
    'INVALID_EXTENSION',
    'install',
    `the npm tarball is refused: ${why}`,
    'Repack the package so its tarball is a plain gzip+tar with package-relative regular files only.',
  )
}

/**
 * Inflate a gzip payload under a byte cap enforced DURING inflation.
 *
 * `gunzipSync`'s `maxOutputLength` makes zlib refuse the moment the inflated
 * stream would pass the bound — inside the C++ inflate loop, BEFORE the full
 * payload is ever allocated — which is the bomb defense a post-hoc check
 * cannot provide. The expansion ratio is then checked against the compressed
 * size before the payload is kept.
 */
function gunzipBounded(bytes: Uint8Array, limits: TarGzipLimits): Buffer {
  let payload: Buffer
  try {
    payload = gunzipSync(bytes, { maxOutputLength: limits.maxInflatedBytes })
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ManagementError(
        'INVALID_EXTENSION',
        'install',
        `the npm tarball inflates past the ${limits.maxInflatedBytes}-byte bound (the cap fired BEFORE the payload was allocated)`,
        'A tarball this large is not a package; it is a bomb or a mistake.',
      )
    }
    refuse(`the gzip stream is malformed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (payload.byteLength / Math.max(1, bytes.byteLength) > limits.maxExpansionRatio) {
    refuse(
      `the tarball expands ${(payload.byteLength / bytes.byteLength).toFixed(1)}x, over the ${limits.maxExpansionRatio}x ratio limit`,
    )
  }
  return payload
}

/** Parse an octal field (size/mode), refusing malformed values. */
function parseOctal(buffer: Buffer, offset: number, length: number, what: string): number {
  const raw = buffer.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '').trim()
  if (raw.length === 0) return 0
  if (!/^[0-7]+$/.test(raw)) refuse(`the ${what} field is not octal: ${JSON.stringify(raw)}`)
  const value = parseInt(raw, 8)
  if (!Number.isFinite(value) || value < 0) refuse(`the ${what} field is invalid`)
  return value
}

/** Read a NUL- or length-terminated string field. */
function parseString(buffer: Buffer, offset: number, length: number): string {
  const end = buffer.indexOf(0, offset)
  const last = end === -1 || end > offset + length ? offset + length : end
  return buffer.subarray(offset, last).toString('utf8')
}

/** Parse one 512-byte tar header block. */
function parseHeader(block: Buffer): TarHeader {
  const name = parseString(block, 0, 100)
  const prefix = parseString(block, 345, 155)
  const size = parseOctal(block, 124, 12, 'size')
  const typeflag = parseString(block, 156, 1)
  const linkname = parseString(block, 157, 100)
  return { name, prefix, size, typeflag, linkname }
}

/** The header block at an offset, with the offset advancing past header+data. */
interface ParsedEntry {
  readonly path: string
  readonly size: number
  readonly kind: ArchiveEntryKind
  readonly linkname: string
  /** Byte offset of this entry's data payload (for pax/longname records). */
  readonly dataOffset: number
}

/** Parse every tar entry's header, walking the data blocks (bounded payload). */
function parseTar(payload: Buffer): ParsedEntry[] {
  const entries: ParsedEntry[] = []
  let offset = 0
  let pendingLongName: string | undefined
  const paxPathOverrides: string[] = []
  let globalPaxPath: string | undefined
  while (offset + 512 <= payload.byteLength) {
    const block = payload.subarray(offset, offset + 512)
    if (block.every(byte => byte === 0)) break
    const header = parseHeader(block)
    const dataOffset = offset + 512
    const padded = Math.ceil(header.size / 512) * 512
    if (dataOffset + padded > payload.byteLength) refuse(`the header for ${JSON.stringify(header.name)} claims ${header.size} bytes that the tarball does not contain (truncated)`)
    offset = dataOffset + padded
    if (offset > payload.byteLength) refuse('the tarball ends inside an entry (truncated)')

    const flag = header.typeflag === '' ? '0' : header.typeflag
    if (flag === 'L') {
      pendingLongName = payload.subarray(dataOffset, dataOffset + header.size).toString('utf8').replace(/\0.*$/, '')
      continue
    }
    if (flag === 'K') {
      // GNU longlink: the link target is replaced by the record's data.
      const target = payload.subarray(dataOffset, dataOffset + header.size).toString('utf8').replace(/\0.*$/, '')
      const last = entries[entries.length - 1]
      if (last !== undefined) entries[entries.length - 1] = { ...last, linkname: target }
      continue
    }
    if (flag === 'x' || flag === 'g') {
      const record = payload.subarray(dataOffset, dataOffset + header.size).toString('utf8')
      for (const line of record.split('\n')) {
        const match = line.match(/^\d+ path=(.*)$/)
        if (match !== null) {
          if (flag === 'g') globalPaxPath = match[1] as string
          else paxPathOverrides.push(match[1] as string)
        }
      }
      continue
    }
    if (flag === '0') {
      const name = pendingLongName ?? header.name
      const paxPath = flag === '0' ? paxPathOverrides.shift() ?? globalPaxPath : undefined
      pendingLongName = undefined
      entries.push({
        path: paxPath ?? `${header.prefix.length > 0 ? `${header.prefix}/` : ''}${name}`,
        size: header.size,
        kind: 'file',
        linkname: header.linkname,
        dataOffset,
      })
      continue
    }
    if (flag === '5') {
      const name = pendingLongName ?? header.name
      pendingLongName = undefined
      entries.push({ path: `${header.prefix.length > 0 ? `${header.prefix}/` : ''}${name}`, size: 0, kind: 'directory', linkname: '', dataOffset })
      continue
    }
    if (flag === '2') {
      entries.push({ path: `${header.prefix.length > 0 ? `${header.prefix}/` : ''}${header.name}`, size: 0, kind: 'symlink', linkname: header.linkname, dataOffset })
      continue
    }
    if (flag === '1') {
      entries.push({ path: `${header.prefix.length > 0 ? `${header.prefix}/` : ''}${header.name}`, size: 0, kind: 'hardlink', linkname: header.linkname, dataOffset })
      continue
    }
    refuse(`the typeflag ${JSON.stringify(flag)} is not supported (only regular files, directories and refused links are admitted)`)
  }
  return entries
}

/**
 * Strip the npm `package/` wrapper: allowed only when EVERY entry sits under
 * it (or is the wrapper directory itself); a mixed layout is refused.
 * @returns the stripped entries, or the entries unchanged when no wrapper exists.
 */
function stripNpmRoot(entries: readonly ParsedEntry[]): readonly ParsedEntry[] {
  const tops = new Set<string>()
  for (const entry of entries) {
    const segments = entry.path.split('/').filter(segment => segment.length > 0)
    const first = segments[0]
    if (first !== undefined) tops.add(first)
  }
  if (!tops.has(NPM_ROOT)) return entries
  if (tops.size > 1) {
    refuse(
      `the tarball mixes entries under ${JSON.stringify(NPM_ROOT + '/')} with entries outside it (${[...tops].map(entry => JSON.stringify(entry)).join(', ')}) — the layout is ambiguous`,
    )
  }
  return entries
    .map(entry => ({ ...entry, path: entry.path.slice(NPM_ROOT.length + 1) }))
    .filter(entry => entry.path.length > 0)
}

/** Read one file entry's payload from the parsed tar (bounded by the entry size). */
function readFileData(payload: Buffer, entry: ParsedEntry): Buffer {
  return payload.subarray(entry.dataOffset, entry.dataOffset + entry.size)
}

/**
 * Build an {@link ArchiveSource} over npm `.tgz` (gzip+tar) bytes.
 *
 * @param fetchBytes - the tarball transport; absent, `fetch` refuses (the SDK
 *   carries no network stack — a host supplies its registry fetch).
 * @param limits - inflate-time bounds, mirroring the shared archive defaults.
 */
export function createTarGzipArchiveSource(
  fetchBytes?: (source: InstallSource) => Promise<Uint8Array>,
  limits: TarGzipLimits = DEFAULT_TAR_GZIP_LIMITS,
): ArchiveSource {
  return {
    async fetch(source) {
      if (fetchBytes === undefined) {
        throw new Error(`no fetcher configured for source ${source.requested}`)
      }
      return fetchBytes(source)
    },
    list(bytes) {
      const payload = gunzipBounded(bytes, limits)
      const entries = stripNpmRoot(parseTar(payload))
      return entries.map((entry): ArchiveEntry => ({
        path: entry.path,
        size: entry.size,
        kind: entry.kind,
      }))
    },
    extract(bytes, destination, root) {
      const payload = gunzipBounded(bytes, limits)
      const entries = stripNpmRoot(parseTar(payload))
      const prefix = root.length > 0 ? `${root}/` : ''
      const target = resolve(destination)
      for (const entry of entries) {
        if (entry.kind !== 'file') continue
        const name = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path
        if (name.length === 0) continue
        // Confinement re-asserted at the write, exactly like the ZIP extractor.
        const out = resolve(join(target, name))
        if (out !== target && !out.startsWith(target + sep)) continue
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, readFileData(payload, entry))
      }
    },
  }
}
