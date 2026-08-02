/**
 * A minimal ZIP reader and writer.
 *
 * Written rather than pulled in because core has no dependencies and is not going to
 * start now: it has to run in a browser, in a Node baker, and anywhere else a pack
 * needs opening, and a zero-dependency decoder is the only version of that which
 * cannot rot.
 *
 * Compression comes from the platform. `CompressionStream('deflate-raw')` is in every
 * current browser and in Node 18 and later, and it is a *global* rather than an
 * import — so this stays dependency-free while getting a real, correct deflate rather
 * than a hand-rolled one, which is not somewhere to be inventive. Where it is missing
 * the writer falls back to storing, which still produces a valid archive.
 *
 * This matters more than it might sound. A derived field like the hydrology raster is
 * mostly zeroes, and storing it uncompressed was the difference between a pack of a
 * few megabytes and one of nearly fifty.
 *
 * The output is an ordinary ZIP. Anything can open it; there is nothing bespoke about
 * the container, only about what is inside.
 */
const globals = globalThis;
/** True when the platform can deflate. Absent only on very old runtimes. */
export const canCompress = typeof globals.CompressionStream === 'function';
async function pump(stream, input) {
    const writer = stream.writable.getWriter();
    // Deliberately not awaited before reading starts: a large chunk can fill the
    // transform's internal queue, and the write only settles once the reader has drained
    // it — awaiting first would deadlock on exactly the payloads that matter here.
    const written = writer.write(input).then(() => writer.close());
    const reader = stream.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        if (value) {
            chunks.push(value);
            total += value.length;
        }
    }
    await written;
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.length;
    }
    return out;
}
async function deflateRaw(bytes) {
    const Ctor = globals.CompressionStream;
    if (!Ctor)
        throw new Error('CompressionStream is unavailable');
    return pump(new Ctor('deflate-raw'), bytes);
}
async function inflateRaw(bytes) {
    const Ctor = globals.DecompressionStream;
    if (!Ctor)
        throw new Error('DecompressionStream is unavailable — cannot read a deflated pack');
    return pump(new Ctor('deflate-raw'), bytes);
}
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[i] = c >>> 0;
    }
    return t;
})();
function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++)
        c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
/**
 * MS-DOS date/time, which is what ZIP stores.
 *
 * Derived from the caller's timestamp rather than a clock so the same inputs produce
 * the same bytes — the whole archive stays diffable, which is what lets a rebuild be
 * checked rather than merely re-run.
 */
function dosTime(iso) {
    const d = new Date(iso);
    const year = Math.max(1980, d.getUTCFullYear());
    return {
        time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
        date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    };
}
/**
 * Smallest entry worth deflating.
 *
 * Below roughly this the deflate header costs more than the coding saves, and every
 * entry that stays stored is one a reader can take without a decompressor. The
 * manifest sits under it, which is a small convenience worth keeping: `pack.json` is
 * readable straight out of the archive with any tool.
 */
const DEFLATE_MIN_BYTES = 4096;
export async function zip(entries, isoTimestamp) {
    const enc = new TextEncoder();
    const { time, date } = dosTime(isoTimestamp);
    const parts = await Promise.all(entries.map(async (e) => {
        const name = enc.encode(e.name);
        const crc = crc32(e.data);
        let body = e.data;
        let method = 0;
        if (canCompress && e.data.length >= DEFLATE_MIN_BYTES) {
            const packed = await deflateRaw(e.data);
            // Incompressible data comes back larger. Store it rather than pay for the
            // attempt — which is the case for anything already compressed going in.
            if (packed.length < e.data.length) {
                body = packed;
                method = 8;
            }
        }
        return { name, data: body, size: e.data.length, crc, method };
    }));
    let localSize = 0;
    let centralSize = 0;
    for (const p of parts) {
        localSize += 30 + p.name.length + p.data.length;
        centralSize += 46 + p.name.length;
    }
    const out = new Uint8Array(localSize + centralSize + 22);
    const view = new DataView(out.buffer);
    let off = 0;
    const offsets = [];
    for (const p of parts) {
        offsets.push(off);
        view.setUint32(off, 0x04034b50, true); // local file header
        view.setUint16(off + 4, 20, true); // version needed
        view.setUint16(off + 6, 0, true); // flags
        view.setUint16(off + 8, p.method, true); // 0 store, 8 deflate
        view.setUint16(off + 10, time, true);
        view.setUint16(off + 12, date, true);
        view.setUint32(off + 14, p.crc, true);
        view.setUint32(off + 18, p.data.length, true); // compressed size
        view.setUint32(off + 22, p.size, true); // uncompressed size
        view.setUint16(off + 26, p.name.length, true);
        view.setUint16(off + 28, 0, true); // extra length
        off += 30;
        out.set(p.name, off);
        off += p.name.length;
        out.set(p.data, off);
        off += p.data.length;
    }
    const centralStart = off;
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        view.setUint32(off, 0x02014b50, true); // central directory header
        view.setUint16(off + 4, 20, true); // version made by
        view.setUint16(off + 6, 20, true); // version needed
        view.setUint16(off + 8, 0, true);
        view.setUint16(off + 10, p.method, true); // 0 store, 8 deflate
        view.setUint16(off + 12, time, true);
        view.setUint16(off + 14, date, true);
        view.setUint32(off + 16, p.crc, true);
        view.setUint32(off + 20, p.data.length, true);
        view.setUint32(off + 24, p.size, true);
        view.setUint16(off + 28, p.name.length, true);
        view.setUint16(off + 30, 0, true); // extra
        view.setUint16(off + 32, 0, true); // comment
        view.setUint16(off + 34, 0, true); // disk
        view.setUint16(off + 36, 0, true); // internal attrs
        view.setUint32(off + 38, 0, true); // external attrs
        view.setUint32(off + 42, offsets[i], true);
        off += 46;
        out.set(p.name, off);
        off += p.name.length;
    }
    view.setUint32(off, 0x06054b50, true); // end of central directory
    view.setUint16(off + 4, 0, true);
    view.setUint16(off + 6, 0, true);
    view.setUint16(off + 8, parts.length, true);
    view.setUint16(off + 10, parts.length, true);
    view.setUint32(off + 12, centralSize, true);
    view.setUint32(off + 16, centralStart, true);
    view.setUint16(off + 20, 0, true); // comment length
    return out;
}
/**
 * Read a ZIP, stored or deflated.
 *
 * Walks the central directory rather than scanning for local headers, because the
 * central directory is the archive's own index and a local-header scan will happily
 * mistake file *contents* for a header when the contents happen to be binary — which
 * a pack's contents always are.
 *
 * Throws on a method it does not know rather than returning something plausible.
 * Handing back compressed bytes as if they were heights would surface hundreds of
 * lines away as terrain that looks like noise, which is a long way from the fault.
 */
export async function unzip(buf) {
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    // The end-of-central-directory record is last, but a trailing comment can push it
    // back, so scan from the end for its signature.
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 65536; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0)
        throw new Error('not a zip: no end-of-central-directory record');
    const count = view.getUint16(eocd + 10, true);
    let off = view.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const files = new Map();
    for (let i = 0; i < count; i++) {
        if (view.getUint32(off, true) !== 0x02014b50) {
            throw new Error(`zip central directory entry ${i} has a bad signature`);
        }
        const method = view.getUint16(off + 10, true);
        const packedSize = view.getUint32(off + 20, true);
        const size = view.getUint32(off + 24, true);
        const nameLen = view.getUint16(off + 28, true);
        const extraLen = view.getUint16(off + 30, true);
        const commentLen = view.getUint16(off + 32, true);
        const localOff = view.getUint32(off + 42, true);
        const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen));
        if (method !== 0 && method !== 8) {
            throw new Error(`zip entry "${name}" uses method ${method}; only store and deflate are read`);
        }
        // The local header repeats the name and may carry different extra-field padding,
        // so the data offset has to come from the local header, not the central one.
        const localNameLen = view.getUint16(localOff + 26, true);
        const localExtraLen = view.getUint16(localOff + 28, true);
        const dataAt = localOff + 30 + localNameLen + localExtraLen;
        const raw = bytes.subarray(dataAt, dataAt + (method === 8 ? packedSize : size));
        const data = method === 8 ? await inflateRaw(raw) : raw;
        if (data.length !== size) {
            throw new Error(`zip entry "${name}": ${data.length} bytes after inflating, expected ${size}`);
        }
        files.set(name, data);
        off += 46 + nameLen + extraLen + commentLen;
    }
    return files;
}
//# sourceMappingURL=zip.js.map