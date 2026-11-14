/**
 * A minimal ZIP writer (stored, no compression) for exporting notes from the browser.
 * Text compresses well, but an export is a one-off download and this keeps the app
 * free of a compression dependency. File names are UTF-8.
 */
export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string
  data: Uint8Array
  modifiedAt?: number
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS date and time, as ZIP stores them (local time, 2-second resolution). */
function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms)
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

export function makeZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder()
  const prepared = entries.map((e) => ({ ...e, nameBytes: enc.encode(e.name), crc: crc32(e.data), ...dosDateTime(e.modifiedAt ?? Date.now()) }))
  const localSize = prepared.reduce((n, e) => n + 30 + e.nameBytes.length + e.data.length, 0)
  const centralSize = prepared.reduce((n, e) => n + 46 + e.nameBytes.length, 0)
  const out = new Uint8Array(localSize + centralSize + 22)
  const view = new DataView(out.buffer)
  const UTF8_NAMES = 0x0800
  let offset = 0
  const offsets: number[] = []

  for (const e of prepared) {
    offsets.push(offset)
    view.setUint32(offset, 0x04034b50, true) // local file header
    view.setUint16(offset + 4, 20, true) // version needed
    view.setUint16(offset + 6, UTF8_NAMES, true)
    view.setUint16(offset + 8, 0, true) // method: stored
    view.setUint16(offset + 10, e.time, true)
    view.setUint16(offset + 12, e.date, true)
    view.setUint32(offset + 14, e.crc, true)
    view.setUint32(offset + 18, e.data.length, true)
    view.setUint32(offset + 22, e.data.length, true)
    view.setUint16(offset + 26, e.nameBytes.length, true)
    view.setUint16(offset + 28, 0, true)
    out.set(e.nameBytes, offset + 30)
    out.set(e.data, offset + 30 + e.nameBytes.length)
    offset += 30 + e.nameBytes.length + e.data.length
  }

  const centralStart = offset
  prepared.forEach((e, i) => {
    view.setUint32(offset, 0x02014b50, true) // central directory header
    view.setUint16(offset + 4, 20, true) // version made by
    view.setUint16(offset + 6, 20, true) // version needed
    view.setUint16(offset + 8, UTF8_NAMES, true)
    view.setUint16(offset + 10, 0, true)
    view.setUint16(offset + 12, e.time, true)
    view.setUint16(offset + 14, e.date, true)
    view.setUint32(offset + 16, e.crc, true)
    view.setUint32(offset + 20, e.data.length, true)
    view.setUint32(offset + 24, e.data.length, true)
    view.setUint16(offset + 28, e.nameBytes.length, true)
    // extra, comment, disk, internal attrs, external attrs: all zero
    view.setUint32(offset + 42, offsets[i], true)
    out.set(e.nameBytes, offset + 46)
    offset += 46 + e.nameBytes.length
  })

  view.setUint32(offset, 0x06054b50, true) // end of central directory
  view.setUint16(offset + 8, prepared.length, true)
  view.setUint16(offset + 10, prepared.length, true)
  view.setUint32(offset + 12, offset - centralStart, true)
  view.setUint32(offset + 16, centralStart, true)
  return out
}
