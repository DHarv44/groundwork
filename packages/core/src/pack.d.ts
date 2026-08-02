import type { Bounds } from './geo';
import type { PackArea, PackPlace, PackRoad, PackVectors } from './vector';
/**
 * The pack format — the contract between whatever writes terrain and whatever
 * renders it.
 *
 * Versioned from the first write. The lesson is already in this repo: the road cache
 * carries an `OSM_QUERY_VERSION` because an entry that cannot say what shape it is
 * has to be thrown away rather than migrated, and throwing away a cache entry costs
 * one refetch. A pack written by somebody else cannot be thrown away, so the version
 * has to be there before the first one exists rather than after the first one breaks.
 */
export declare const PACK_FORMAT_VERSION = 1;
/** Canonical filenames inside a pack. */
export declare const PACK_MANIFEST_FILE = "pack.json";
export declare const PACK_VECTORS_FILE = "vectors.json";
/**
 * One raster plane.
 *
 * Self-describing so a reader can be generic: adding imagery, a biome field or a
 * soil layer later is a new entry, not a format change. `id` is deliberately an open
 * string rather than a union — a consumer looks up what it understands and ignores
 * the rest, which is what lets a pack carry more than any one renderer wants.
 */
export interface PackLayer {
    id: string;
    /** Filename relative to the pack root. */
    file: string;
    format: 'uint8' | 'uint16' | 'float32';
    channels: number;
    /**
     * Plane dimensions, when they differ from the manifest's.
     *
     * Derived fields legitimately have their own native resolution — a hydrology pass
     * runs at a routing resolution chosen for the cost of the flood fill, not for the
     * DEM's sample spacing. Forcing every layer to the elevation grid would mean
     * resampling on the way in and again on the way out, which throws away detail in
     * one direction and invents it in the other. Absent means "same as the manifest",
     * which is the common case.
     */
    width?: number;
    height?: number;
    /**
     * A reversible transform applied to the bytes before they were compressed.
     *
     * `delta16-split` is for `uint16` planes. Quantised elevation resists deflate badly —
     * measured at 1.1× on real terrain — because each sample's low byte is essentially
     * noise while its high byte varies smoothly, and interleaving them buries the smooth
     * signal in the noisy one. The filter takes a running difference between samples and
     * then writes all the high bytes followed by all the low bytes, so the high plane
     * becomes long runs of 0x00 and 0xff. Entirely lossless: it reorders and predicts,
     * it does not discard.
     *
     * `delta8-planar` is the same idea for a multi-channel `uint8` plane: each channel is
     * gathered together and differenced on its own. Interleaved, a noisy channel sits
     * between every pair of smooth ones and deflate can find little; separated, each
     * compresses on its own terms. It also makes a *constant* channel free, which matters
     * because the hydrology field's alpha always is and its lake flag is wherever a box
     * has no lakes — and separating them beats dropping them, because which channels are
     * empty varies from one place to the next.
     *
     * Absent means the bytes are the samples, which is what every earlier pack has.
     */
    filter?: 'delta16-split' | 'delta8-planar';
    /**
     * For quantised integer planes: the real values that map to 0 and to the type's
     * maximum. Absent on `float32` planes and on integer planes that mean their own
     * value (a class index, a boolean).
     */
    min?: number;
    max?: number;
    /** What the plane holds, for anyone reading the pack without the writer's source. */
    description?: string;
}
/**
 * Where the data came from and what that obliges a consumer to do.
 *
 * Structured rather than a prose string because the licences involved require the
 * credit to be *shown*, which means something downstream has to render it — and a
 * consumer cannot render what it cannot parse. OpenStreetMap is ODbL, which also
 * carries share-alike terms onto derived geometry; a pack that gets passed around
 * needs to say so on its own rather than relying on whoever made it to remember.
 */
export interface PackAttribution {
    source: string;
    licence: string;
    url?: string;
    /** Which parts of the pack this covers — layer ids, or `roads` / `areas` / `places`. */
    covers: string[];
}
export interface PackManifest {
    formatVersion: number;
    id: string;
    name: string;
    description?: string;
    /** Geographic extent. Every normalised coordinate in the pack is relative to this. */
    bounds: Bounds;
    /** Raster dimensions. Every plane in `layers` is exactly this size. */
    width: number;
    height: number;
    /** Ground size at the box centre latitude. */
    widthMetres: number;
    heightMetres: number;
    elevation: {
        min: number;
        max: number;
    };
    layers: PackLayer[];
    /** Present when the pack ships `vectors.json`. */
    vectors?: string;
    attribution: PackAttribution[];
    /** ISO 8601. */
    createdAt: string;
    /** Tool and version that wrote this, for chasing down a bad bake. */
    generator: string;
}
/**
 * Pack a float plane into `Uint16` across a known range.
 *
 * At 16 bits an entire Himalayan box resolves to about 13 cm and a typical one to
 * under 5 cm, which is far inside the noise of any elevation source worth packing —
 * so this is lossless in every way that matters and halves the file.
 */
export declare function quantise(data: Float32Array, min: number, max: number): Uint16Array;
export declare function dequantise(q: Uint16Array, min: number, max: number): Float32Array;
export declare function serialiseVectors(v: PackVectors): string;
export declare function parseVectors(json: string): PackVectors;
/**
 * Check a manifest before anything trusts it.
 *
 * Returns every problem rather than throwing on the first, because the caller is
 * usually a person looking at a pack that somebody else made and the useful answer
 * is the whole list. An empty array means it is structurally sound — not that the
 * data in it is any good.
 */
export declare function validateManifest(m: unknown): string[];
/** A layer's own dimensions, falling back to the manifest's. */
export declare function layerSize(layer: PackLayer, manifest: Pick<PackManifest, 'width' | 'height'>): {
    width: number;
    height: number;
};
/** Bytes one plane of a layer occupies, for sizing a read. */
export declare function layerByteLength(layer: PackLayer, width: number, height: number): number;
export type { Bounds, PackVectors, PackRoad, PackArea, PackPlace };
//# sourceMappingURL=pack.d.ts.map