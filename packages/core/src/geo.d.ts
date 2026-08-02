/**
 * Geodesy.
 *
 * Everything here is arithmetic on numbers. No DOM, no three.js, no fetch — the
 * package's tsconfig omits the DOM lib so that stays true by construction rather
 * than by discipline.
 */
export interface Bounds {
    south: number;
    north: number;
    west: number;
    east: number;
}
/** Metres per degree of latitude at a given latitude (WGS84 series expansion). */
export declare function metresPerDegLat(latDeg: number): number;
/** Metres per degree of longitude at a given latitude. */
export declare function metresPerDegLon(latDeg: number): number;
/** Ground size of a bounding box in metres, measured at its centre latitude. */
export declare function boundsExtentMetres(b: Bounds): {
    width: number;
    height: number;
};
/** Approximate bounding-box area in km². */
export declare function boundsAreaKm2(b: Bounds): number;
/**
 * The coordinate system every vector in a pack is stored in.
 *
 * `x` runs 0→1 west→east, `y` runs 0→1 **north→south**. South-down rather than the
 * usual north-up because it makes a vector coordinate index the raster planes
 * directly — row 0 of a north-up row-major raster is the north edge, and having the
 * two disagree is the kind of flip that costs an afternoon every time somebody new
 * reads the format.
 *
 * Normalised rather than metres so the geometry does not have to be rewritten if a
 * pack is ever re-baked at a different resolution, and normalised rather than
 * lon/lat so a consumer that only wants to draw does not have to carry a projection.
 * The bounds are in the manifest, so georeferencing is never lost — see `boxToLonLat`.
 */
export interface BoxPoint {
    x: number;
    y: number;
}
/** Longitude/latitude → normalised box coordinates. */
export declare function lonLatToBox(b: Bounds, lon: number, lat: number): BoxPoint;
/** Normalised box coordinates → longitude/latitude. */
export declare function boxToLonLat(b: Bounds, x: number, y: number): {
    lon: number;
    lat: number;
};
export declare function lonToTileX(lon: number, z: number): number;
export declare function latToTileY(lat: number, z: number): number;
//# sourceMappingURL=geo.d.ts.map