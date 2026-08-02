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
/** True when the platform can deflate. Absent only on very old runtimes. */
export declare const canCompress: boolean;
export interface ZipEntry {
    name: string;
    data: Uint8Array;
}
export declare function zip(entries: ZipEntry[], isoTimestamp: string): Promise<Uint8Array>;
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
export declare function unzip(buf: ArrayBuffer): Promise<Map<string, Uint8Array>>;
//# sourceMappingURL=zip.d.ts.map