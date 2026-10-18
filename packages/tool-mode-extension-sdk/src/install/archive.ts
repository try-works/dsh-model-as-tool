/**
 * Archive defenses (EXT-11).
 *
 * An extension archive is attacker-controlled input. This module validates its
 * ENTRY LIST before a single byte is extracted, because every defense here is
 * cheaper and safer to apply to a list than to a filesystem: a traversal entry
 * rejected here never reaches a path-join, and a symlink never exists to be
 * followed.
 *
 * The rules are deliberately blunt where ambiguity helps an attacker:
 *
 * - Symlinks and hardlinks are REFUSED, not resolved. A link is the mechanism by
 *   which an in-package path reaches out of the package, and no legitimate
 *   extension needs one to ship code and schemas.
 * - Duplicate and case-colliding entries are refused rather than last-write-wins.
 *   On a case-insensitive filesystem `A.js` and `a.js` are the same file, so an
 *   archive containing both extracts differently depending on the host — a
 *   discrepancy an attacker can use to make the validated bytes differ from the
 *   executed ones.
 *
 * @module @try-works/tool-mode-extension-sdk/install/archive
 */

import { createHash } from 'node:crypto'
import { ManagementError } from './../errors.ts'

/** What one archive entry is. */
export type ArchiveEntryKind = 'file' | 'directory' | 'symlink' | 'hardlink'

/** One entry as reported by an archive reader, before extraction. */
export interface ArchiveEntry {
  /** The path exactly as recorded in the archive, using `/` separators. */
  readonly path: string
  /** Uncompressed size in bytes; 0 for directories and links. */
  readonly size: number
  /** The entry type. Readers that cannot tell must report `file`. */
  readonly kind: ArchiveEntryKind
  /** Compressed size when the reader knows it, for expansion-ratio checks. */
  readonly compressedSize?: number
}

/** Bounds applied to an archive before extraction (EXT-11). */
export interface ArchiveLimits {
  /** Maximum number of entries. */
  readonly maxEntries: number
  /** Maximum total uncompressed bytes. */
  readonly maxTotalBytes: number
  /** Maximum uncompressed bytes for a single entry. */
  readonly maxEntryBytes: number
  /**
   * Maximum ratio of uncompressed to compressed across the archive.
   *
   * A compression bomb is small on the wire and enormous on disk, so the byte
   * cap alone does not catch it before allocation.
   */
  readonly maxExpansionRatio: number
}

/** Conservative defaults: generous for real extensions, hostile to bombs. */
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 4096,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntryBytes: 128 * 1024 * 1024,
  maxExpansionRatio: 200,
}

/** Windows device names, which resolve to hardware rather than to a file. */
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i

/** A path segment that would escape its parent. */
function isTraversalSegment(segment: string): boolean {
  return segment === '..'
}

/**
 * Normalize an archive entry path for comparison and containment, or reject it.
 *
 * @param entryPath - the path as recorded.
 * @returns the normalized segments.
 * @throws ManagementError when the path is inadmissible.
 */
function normalizeEntryPath(entryPath: string): string[] {
  const fail = (why: string): never => {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'install',
      `the archive entry ${JSON.stringify(entryPath)} is refused: ${why}`,
      'Repack the extension so every entry is a package-relative path with no links.',
    )
  }
  if (entryPath.length === 0) fail('the path is empty')
  if (entryPath.includes('\0')) fail('the path contains a NUL byte')
  // Checked before the absolute-path case: a UNC path also begins with a
  // separator, and reporting it as merely "absolute" would understate what it is.
  if (entryPath.startsWith('//')) fail('the path is a UNC path')
  // A backslash is a separator on Windows and a filename character elsewhere, so
  // the same archive would extract to different trees. Refuse rather than guess.
  if (entryPath.includes('\\')) fail('the path contains a backslash, which extracts differently per platform')
  if (entryPath.startsWith('/')) fail('the path is absolute')
  if (/^[A-Za-z]:/.test(entryPath)) fail('the path carries a drive letter')

  const segments = entryPath.split('/').filter(segment => segment.length > 0 && segment !== '.')
  for (const segment of segments) {
    if (isTraversalSegment(segment)) fail('the path traverses out of the package')
    if (WINDOWS_RESERVED.test(segment)) fail(`the segment ${JSON.stringify(segment)} is a reserved Windows device name`)
    // A trailing dot or space is silently stripped by Windows, so `evil.` and
    // `evil` collide there while remaining distinct elsewhere.
    if (/[ .]$/.test(segment)) fail(`the segment ${JSON.stringify(segment)} ends in a dot or space`)
  }
  if (segments.length === 0) fail('the path names nothing')
  return segments
}

/**
 * Validate an archive's entry list before extraction (EXT-11).
 *
 * @param entries - the entries as reported by the reader.
 * @param limits - the bounds to apply.
 * @returns the normalized entry paths, in archive order.
 * @throws ManagementError when any entry, or the archive as a whole, is inadmissible.
 */
export function validateArchiveEntries(
  entries: readonly ArchiveEntry[],
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): string[] {
  if (entries.length > limits.maxEntries) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'install',
      `the archive holds ${entries.length} entries, over the ${limits.maxEntries} limit`,
      'Reduce the number of files, or raise the operator limit deliberately.',
    )
  }

  const normalized: string[] = []
  // Two collision keys: exact, and case/separator-folded for Windows.
  const exact = new Set<string>()
  const folded = new Map<string, string>()
  let totalBytes = 0
  let totalCompressed = 0

  for (const entry of entries) {
    const segments = normalizeEntryPath(entry.path)

    if (entry.kind === 'symlink' || entry.kind === 'hardlink') {
      throw new ManagementError(
        'INVALID_EXTENSION',
        'install',
        `the archive entry ${JSON.stringify(entry.path)} is a ${entry.kind}; links are refused`,
        'Ship real files. An extension does not need links to deliver code, schemas or assets.',
      )
    }
    if (!Number.isFinite(entry.size) || entry.size < 0) {
      throw new ManagementError(
        'INVALID_EXTENSION',
        'install',
        `the archive entry ${JSON.stringify(entry.path)} declares an invalid size`,
        'Repack the archive.',
      )
    }
    if (entry.size > limits.maxEntryBytes) {
      throw new ManagementError(
        'INVALID_EXTENSION',
        'install',
        `the archive entry ${JSON.stringify(entry.path)} is ${entry.size} bytes, over the per-entry limit`,
        'Split the asset, or raise the operator limit deliberately.',
      )
    }

    const key = segments.join('/')
    if (exact.has(key)) {
      throw new ManagementError(
        'INVALID_EXTENSION',
        'install',
        `the archive declares ${JSON.stringify(key)} more than once`,
        'Repack the archive with unique entries; last-write-wins is not admitted.',
      )
    }
    exact.add(key)

    const caseKey = key.toLowerCase()
    const prior = folded.get(caseKey)
    if (prior !== undefined && prior !== key) {
      throw new ManagementError(
        'INVALID_EXTENSION',
        'install',
        `the archive entries ${JSON.stringify(prior)} and ${JSON.stringify(key)} collide on a case-insensitive filesystem`,
        'Rename one of them; the archive would otherwise extract differently per host.',
      )
    }
    folded.set(caseKey, key)
    normalized.push(key)

    totalBytes += entry.size
    totalCompressed += entry.compressedSize ?? 0
  }

  if (totalBytes > limits.maxTotalBytes) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'install',
      `the archive expands to ${totalBytes} bytes, over the ${limits.maxTotalBytes} limit`,
      'Reduce the package contents, or raise the operator limit deliberately.',
    )
  }
  // Only meaningful when the reader reports compressed sizes; without them the
  // byte caps above still apply, so this cannot be used to bypass them.
  if (totalCompressed > 0 && totalBytes / totalCompressed > limits.maxExpansionRatio) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'install',
      `the archive expands ${(totalBytes / totalCompressed).toFixed(1)}x, over the ${limits.maxExpansionRatio}x ratio limit`,
      'Repack without extreme compression; a high ratio is the signature of an expansion bomb.',
    )
  }
  return normalized
}

/**
 * Locate the package root inside an archive.
 *
 * An archive may wrap everything in a single directory, which is normal for
 * source archives. Anything else — zero roots, or files at the root alongside
 * several directories — has no unambiguous package root and is refused.
 * @param paths - the normalized entry paths.
 * @returns the package root prefix, or '' when the package is at the archive root.
 * @throws ManagementError when the root is ambiguous or the package.json is missing.
 */
export function findPackageRoot(paths: readonly string[]): string {
  const topLevel = new Set<string>()
  for (const path of paths) {
    const [first] = path.split('/')
    if (first !== undefined) topLevel.add(first)
  }
  const hasRootPackageJson = paths.includes('package.json')
  if (hasRootPackageJson) return ''

  const roots = [...topLevel].filter(candidate => paths.includes(`${candidate}/package.json`))
  if (roots.length === 1) return roots[0] as string

  throw new ManagementError(
    'INVALID_EXTENSION',
    'install',
    roots.length === 0
      ? 'the archive contains no package.json at its root or in a single top-level directory'
      : `the archive contains ${roots.length} candidate package roots, which is ambiguous`,
    'Pack the extension so package.json sits at the archive root or inside exactly one top-level directory.',
  )
}

/**
 * Verify an archive against its declared integrity (EXT-08, EXT-12).
 *
 * Integrity is not trust: a matching digest says the bytes are the ones the
 * operator approved, not that they are safe. It is still checked first, because a
 * mismatch means nothing downstream is worth doing.
 * @param bytes - the fetched archive bytes.
 * @param expectedSha512 - the declared digest, lowercase hex or base64.
 * @returns the computed digest, lowercase hex.
 * @throws ManagementError with `INTEGRITY_MISMATCH`.
 */
export function verifyIntegrity(bytes: Uint8Array, expectedSha512: string): string {
  const digest = createHash('sha512').update(bytes).digest('hex')
  // Strip the optional SRI prefix and trim, but do NOT lowercase before the
  // format decision: base64 is CASE-SENSITIVE (npm's dist.integrity is base64
  // SRI), so lowercasing first corrupts a correct digest. npm's base64 SRI for
  // a SHA-512 always carries '=' padding, which hex never does — that is the
  // deterministic discriminator, and the hex arm is lowercased only after it
  // is recognized as hex.
  const stripped = expectedSha512.trim().replace(/^sha512-/, '')
  const expectedHex = stripped.includes('=')
    ? Buffer.from(stripped, 'base64').toString('hex')
    : /^[0-9a-f]+$/i.test(stripped)
      ? stripped.toLowerCase()
      : Buffer.from(stripped, 'base64').toString('hex')

  if (digest !== expectedHex) {
    throw new ManagementError(
      'INTEGRITY_MISMATCH',
      'install',
      'the fetched archive does not match its declared SHA-512',
      'Do not retry blindly: re-fetch from the declared source and confirm the expected digest with the publisher.',
    )
  }
  return digest
}
