/**
 * A minimal raw ZIP writer.
 *
 * `adm-zip` sanitizes entry names when writing — it collapses `../`, converts
 * backslashes and drops a leading `//` — so it CANNOT produce the hostile archives
 * the entry-list defenses exist to refuse. Its reader, however, reports whatever
 * another tool wrote. Testing the refusal paths therefore needs bytes written
 * without that safety net.
 *
 * This writes stored (uncompressed) entries with arbitrary names, which is all a
 * defense test needs: the attacks are in the metadata, not the payload.
 */

import { crc32 } from 'node:zlib'

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL = 0x06054b50

/** One entry to write, with its name exactly as given. */
export interface RawEntry {
  /** The name written verbatim into the archive. May be hostile. */
  readonly name: string
  readonly data: Buffer
}

/**
 * Build a ZIP archive whose entry names are preserved byte for byte.
 * @param entries - the entries to write.
 * @returns the archive bytes.
 */
export function buildRawZip(entries: readonly RawEntry[]): Uint8Array {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_HEADER, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: stored
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0x21, 12) // mod date (1980-01-01)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    localParts.push(local, nameBytes, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_HEADER, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBytes)

    offset += local.length + nameBytes.length + entry.data.length
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_OF_CENTRAL, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return new Uint8Array(Buffer.concat([...localParts, ...centralParts, end]))
}
