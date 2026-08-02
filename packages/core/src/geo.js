/**
 * Geodesy.
 *
 * Everything here is arithmetic on numbers. No DOM, no three.js, no fetch — the
 * package's tsconfig omits the DOM lib so that stays true by construction rather
 * than by discipline.
 */
/** Metres per degree of latitude at a given latitude (WGS84 series expansion). */
export function metresPerDegLat(latDeg) {
    const p = (latDeg * Math.PI) / 180;
    return (111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p));
}
/** Metres per degree of longitude at a given latitude. */
export function metresPerDegLon(latDeg) {
    const p = (latDeg * Math.PI) / 180;
    return 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);
}
/** Ground size of a bounding box in metres, measured at its centre latitude. */
export function boundsExtentMetres(b) {
    const midLat = (b.north + b.south) / 2;
    return {
        width: Math.abs(b.east - b.west) * metresPerDegLon(midLat),
        height: Math.abs(b.north - b.south) * metresPerDegLat(midLat),
    };
}
/** Approximate bounding-box area in km². */
export function boundsAreaKm2(b) {
    const { width, height } = boundsExtentMetres(b);
    return (width * height) / 1e6;
}
/** Longitude/latitude → normalised box coordinates. */
export function lonLatToBox(b, lon, lat) {
    return {
        x: (lon - b.west) / (b.east - b.west),
        y: (b.north - lat) / (b.north - b.south),
    };
}
/** Normalised box coordinates → longitude/latitude. */
export function boxToLonLat(b, x, y) {
    return {
        lon: b.west + x * (b.east - b.west),
        lat: b.north - y * (b.north - b.south),
    };
}
// ---- Web Mercator tiles ----------------------------------------------------
export function lonToTileX(lon, z) {
    return ((lon + 180) / 360) * Math.pow(2, z);
}
export function latToTileY(lat, z) {
    const r = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
}
//# sourceMappingURL=geo.js.map