/**
 * A real, zip-backed {@link ArchiveSource} over `adm-zip`.
 *
 * It lives here rather than in the SDK's public surface because it pulls in an
 * archive library; the SDK itself declares only the interface, so an author
 * embedding it does not inherit that dependency. Tests use this to exercise the
 * installer against genuine archives rather than fabricated entry lists, which
 * matters because the defenses are about how a real archive's metadata can lie.
 *
 * `adm-zip` is a devDependency for exactly this reason.
 *
 * @module @try-works/tool-mode-extension-sdk/install/zip-source
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import AdmZip from 'adm-zip'
import type { ArchiveEntry, ArchiveEntryKind } from './archive.ts'
import type { ArchiveSource, InstallSource } from './staged.ts'

/** The external-attributes bit that marks a POSIX symlink in a zip entry. */
const SYMLINK_MODE = 0xa000
/** The external-attributes bit that marks a POSIX directory. */
const DIRECTORY_MODE = 0x4000

/** Classify one zip entry from its recorded attributes. */
function kindOf(entry: AdmZip.IZipEntry): ArchiveEntryKind {
  const mode = (entry.attr >>> 16) & 0xffff
  if (entry.isDirectory) return 'directory'
  if ((mode & 0xf000) === SYMLINK_MODE) return 'symlink'
  if ((mode & 0xf000) === DIRECTORY_MODE) return 'directory'
  // Zip has no portable hardlink marker; `adm-zip` cannot report one, so a
  // hardlink-shaped entry appears as a file here. The entry-list validator still
  // refuses the shapes it can see, and the positive-list extractor below refuses
  // to write anything that is not a plain entry.
  return 'file'
}

/** Build an {@link ArchiveSource} backed by `adm-zip`. */
export function createZipArchiveSource(fetchBytes?: (source: InstallSource) => Promise<Uint8Array>): ArchiveSource {
  return {
    async fetch(source) {
      if (fetchBytes === undefined) {
        // No network stack in the SDK or its tests: a caller that wants a remote
        // archive supplies the fetcher, and a test supplies bytes directly.
        throw new Error(`no fetcher configured for source ${source.requested}`)
      }
      return fetchBytes(source)
    },
    list(bytes) {
      const zip = new AdmZip(Buffer.from(bytes))
      return zip.getEntries().map((entry): ArchiveEntry => ({
        path: entry.entryName,
        size: entry.header.size,
        kind: kindOf(entry),
        compressedSize: entry.header.compressedSize,
      }))
    },
    extract(bytes, destination, root) {
      const zip = new AdmZip(Buffer.from(bytes))
      const prefix = root.length > 0 ? `${root}/` : ''
      const target = resolve(destination)
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue
        if (kindOf(entry) !== 'file') continue
        const name = entry.entryName.startsWith(prefix) ? entry.entryName.slice(prefix.length) : entry.entryName
        if (name.length === 0) continue
        // Confinement is re-asserted at the write, not only in the validator: the
        // extraction is the step that touches the filesystem, so it is the step
        // that must not be able to escape even if validation were bypassed.
        const out = resolve(join(target, name))
        if (out !== target && !out.startsWith(target + sep)) continue
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, entry.getData())
      }
    },
  }
}
