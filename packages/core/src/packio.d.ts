import type { HeightField } from './field';
import type { PackAttribution, PackLayer, PackManifest } from './pack';
import type { PackVectors } from './vector';
/**
 * Reading and writing pack bytes.
 *
 * Bytes in, bytes out — no fetch, no filesystem. Core has no DOM lib, so it could not
 * reach a network even if someone wanted it to, and that is deliberate: a pack might
 * arrive over HTTP, out of a zip, from disk in a Node baker, or from an
 * `<input type="file">`, and none of those belong in the decoder. The host gets the
 * bytes however it likes and hands them over.
 */
/** A pack's contents, however the host obtained them. */
export interface PackFiles {
    manifest: PackManifest;
    /** Raster planes, keyed by layer id — not by filename. */
    rasters: Map<string, ArrayBuffer>;
    /** The raw text of `vectors.json`, if the pack has one. */
    vectors?: string;
}
/**
 * A raster plane's samples.
 *
 * The buffer parameter is pinned to `ArrayBuffer` rather than left as the default
 * `ArrayBufferLike`. It is always a real one — the views are constructed over a
 * sliced buffer a few lines below — and the loose form makes the result unusable
 * anywhere a `BufferSource` is wanted, which is to say anywhere a consumer would
 * actually put it, such as straight into a `THREE.DataTexture`.
 */
export type RasterData = Uint8Array<ArrayBuffer> | Uint16Array<ArrayBuffer> | Float32Array<ArrayBuffer>;
/** The typed view over a raster plane, without interpreting what it means. */
export declare function readRaster(files: PackFiles, id: string): {
    layer: PackLayer;
    data: RasterData;
    width: number;
    height: number;
} | null;
/**
 * The elevation plane as a `HeightField`, ready for the mesh builder.
 *
 * This is what closes the loop: a renderer handed a pack produces the same structure
 * it would have got from a live DEM fetch, so nothing downstream of here knows or
 * cares which one it was.
 */
export declare function readHeightField(files: PackFiles): HeightField;
/** An extra plane to ship alongside the elevation. */
export interface PackInputLayer {
    id: string;
    data: Uint8Array | Uint16Array | Float32Array;
    channels: number;
    description?: string;
    /** Required for a quantised plane that means a measurement rather than an index. */
    min?: number;
    max?: number;
    /** Own dimensions, when the plane is not on the elevation grid. */
    width?: number;
    height?: number;
}
export interface PackInput {
    id: string;
    name: string;
    description?: string;
    heights: HeightField;
    layers?: PackInputLayer[];
    vectors?: PackVectors;
    attribution: PackAttribution[];
    /** Tool and version doing the writing, for chasing down a bad bake. */
    generator: string;
    /**
     * ISO 8601, supplied by the caller rather than read from a clock here.
     *
     * Injected so a baker can produce byte-identical output twice — which is what makes
     * a rebuild diffable and a regression test possible at all.
     */
    createdAt: string;
}
/**
 * Assemble a pack from data already in hand.
 *
 * Nothing here fetches or derives — every input is expected to be resident. That is
 * the rule the export side is built around: if a pack needs something, it is loaded
 * long before this is called, never during.
 */
export declare function buildPack(input: PackInput): PackFiles;
/** Conventional extension. A pack is an ordinary ZIP; this is only a hint to a person. */
export declare const PACK_EXTENSION = ".gwpack";
/**
 * Flatten a pack to one file.
 *
 * A pack is several files, and a download is one — so the wire form is a ZIP. Nothing
 * about the container is bespoke: any unzip tool opens it, which matters for anyone
 * trying to work out what a pack of theirs actually contains without our code.
 *
 * The manifest goes in first so a reader that streams gets the index before the bulk.
 */
export declare function packToBytes(files: PackFiles): Promise<Uint8Array>;
/**
 * Read a pack back out of its container.
 *
 * The manifest is validated before anything is indexed by it, because every read past
 * this point is sized and typed from what it claims — a manifest that disagrees with
 * the bytes produces terrain that renders as noise rather than an error, and that is
 * a long way to travel from the actual fault.
 */
export declare function packFromBytes(buf: ArrayBuffer): Promise<PackFiles>;
//# sourceMappingURL=packio.d.ts.map