/**
 * A minimal ZIP reader and writer, store-only (no compression).
 *
 * Written rather than pulled in because core has no dependencies and is not going to
 * start now: it has to run in a browser, in a Node baker, and anywhere else a pack
 * needs opening, and a zero-dependency decoder is the only version of that which
 * cannot rot. Store-only keeps it to about a hundred lines and costs less than it
 * sounds — the bulk of a pack is quantised elevation and vector JSON, and the whole
 * thing is usually served over an already-compressed transport anyway.
 *
 * The output is an ordinary ZIP. Anything can open it; there is nothing bespoke about
 * the container, only about what is inside.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  name: string
  data: Uint8Array
}

/**
 * MS-DOS date/time, which is what ZIP stores.
 *
 * Derived from the caller's timestamp rather than a clock so the same inputs produce
 * the same bytes — the whole archive stays diffable, which is what lets a rebuild be
 * checked rather than merely re-run.
 */
function dosTime(iso: string): { time: number; date: number } {
  const d = new Date(iso)
  const year = Math.max(1980, d.getUTCFullYear())
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  }
}

export function zip(entries: ZipEntry[], isoTimestamp: string): Uint8Array {
  const enc = new TextEncoder()
  const { time, date } = dosTime(isoTimestamp)

  const parts = entries.map((e) => {
    const name = enc.encode(e.name)
    return { name, data: e.data, crc: crc32(e.data) }
  })

  let localSize = 0
  let centralSize = 0
  for (const p of parts) {
    localSize += 30 + p.name.length + p.data.length
    centralSize += 46 + p.name.length
  }

  const out = new Uint8Array(localSize + centralSize + 22)
  const view = new DataView(out.buffer)
  let off = 0
  const offsets: number[] = []

  for (const p of parts) {
    offsets.push(off)
    view.setUint32(off, 0x04034b50, true) // local file header
    view.setUint16(off + 4, 20, true) // version needed
    view.setUint16(off + 6, 0, true) // flags
    view.setUint16(off + 8, 0, true) // method: store
    view.setUint16(off + 10, time, true)
    view.setUint16(off + 12, date, true)
    view.setUint32(off + 14, p.crc, true)
    view.setUint32(off + 18, p.data.length, true) // compressed size
    view.setUint32(off + 22, p.data.length, true) // uncompressed size
    view.setUint16(off + 26, p.name.length, true)
    view.setUint16(off + 28, 0, true) // extra length
    off += 30
    out.set(p.name, off)
    off += p.name.length
    out.set(p.data, off)
    off += p.data.length
  }

  const centralStart = off
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    view.setUint32(off, 0x02014b50, true) // central directory header
    view.setUint16(off + 4, 20, true) // version made by
    view.setUint16(off + 6, 20, true) // version needed
    view.setUint16(off + 8, 0, true)
    view.setUint16(off + 10, 0, true) // method: store
    view.setUint16(off + 12, time, true)
    view.setUint16(off + 14, date, true)
    view.setUint32(off + 16, p.crc, true)
    view.setUint32(off + 20, p.data.length, true)
    view.setUint32(off + 24, p.data.length, true)
    view.setUint16(off + 28, p.name.length, true)
    view.setUint16(off + 30, 0, true) // extra
    view.setUint16(off + 32, 0, true) // comment
    view.setUint16(off + 34, 0, true) // disk
    view.setUint16(off + 36, 0, true) // internal attrs
    view.setUint32(off + 38, 0, true) // external attrs
    view.setUint32(off + 42, offsets[i]!, true)
    off += 46
    out.set(p.name, off)
    off += p.name.length
  }

  view.setUint32(off, 0x06054b50, true) // end of central directory
  view.setUint16(off + 4, 0, true)
  view.setUint16(off + 6, 0, true)
  view.setUint16(off + 8, parts.length, true)
  view.setUint16(off + 10, parts.length, true)
  view.setUint32(off + 12, centralSize, true)
  view.setUint32(off + 16, centralStart, true)
  view.setUint16(off + 20, 0, true) // comment length

  return out
}

/**
 * Read a store-only ZIP.
 *
 * Walks the central directory rather than scanning for local headers, because the
 * central directory is the archive's own index and a local-header scan will happily
 * mistake file *contents* for a header when the contents happen to be binary — which
 * a pack's contents always are.
 *
 * Throws on a compressed entry rather than returning something plausible. Anything
 * this writes is stored, so a deflated member means the archive came from elsewhere,
 * and silently handing back compressed bytes as if they were heights would surface
 * hundreds of lines away as terrain that looks like noise.
 */
export function unzip(buf: ArrayBuffer): Map<string, Uint8Array> {
  const bytes = new Uint8Array(buf)
  const view = new DataView(buf)

  // The end-of-central-directory record is last, but a trailing comment can push it
  // back, so scan from the end for its signature.
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 65536; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record')

  const count = view.getUint16(eocd + 10, true)
  let off = view.getUint32(eocd + 16, true)

  const dec = new TextDecoder()
  const files = new Map<string, Uint8Array>()

  for (let i = 0; i < count; i++) {
    if (view.getUint32(off, true) !== 0x02014b50) {
      throw new Error(`zip central directory entry ${i} has a bad signature`)
    }
    const method = view.getUint16(off + 10, true)
    const size = view.getUint32(off + 24, true)
    const nameLen = view.getUint16(off + 28, true)
    const extraLen = view.getUint16(off + 30, true)
    const commentLen = view.getUint16(off + 32, true)
    const localOff = view.getUint32(off + 42, true)
    const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen))

    if (method !== 0) {
      throw new Error(`zip entry "${name}" is compressed (method ${method}); only store is read`)
    }

    // The local header repeats the name and may carry different extra-field padding,
    // so the data offset has to come from the local header, not the central one.
    const localNameLen = view.getUint16(localOff + 26, true)
    const localExtraLen = view.getUint16(localOff + 28, true)
    const dataAt = localOff + 30 + localNameLen + localExtraLen
    files.set(name, bytes.subarray(dataAt, dataAt + size))

    off += 46 + nameLen + extraLen + commentLen
  }

  return files
}
