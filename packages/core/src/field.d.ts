import type { Bounds } from './geo';
/**
 * A rectangle of elevation samples.
 *
 * Row-major with the **north** row first, matching how every raster source hands
 * them over and how the pack's raster planes are stored, so an index computed
 * against one is valid against the other.
 */
export interface HeightField {
    width: number;
    height: number;
    /** Elevation in metres, row-major, north row first. Voids already filled. */
    data: Float32Array;
    /** Actual raster bounds, which may differ slightly from what was requested. */
    bounds: Bounds;
    min: number;
    max: number;
    /** Identifier of the elevation source this came from. */
    demtype: string;
    /** Count of samples that were voids in the source raster. */
    voids: number;
}
/**
 * Bilinear sample of the height field in fractional grid coordinates.
 *
 * Anything that needs to know where the surface *is* — placing a mesh vertex,
 * standing an object on the ground, walking a camera over it — has to sample it
 * this way, half-cell offset and all. Reimplementing it elsewhere is how a mesh and
 * the things standing on it drift apart.
 */
export declare function sampleBilinear(hf: HeightField, fx: number, fy: number): number;
/**
 * Elevation in metres at a normalised box coordinate.
 *
 * The form an object registry wants: something is placed at a fraction across the
 * box and needs to sit on the ground, without knowing the raster's resolution.
 */
export declare function sampleBox(hf: HeightField, x: number, y: number): number;
//# sourceMappingURL=field.d.ts.map