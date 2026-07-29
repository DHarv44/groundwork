/**
 * Geodesy.
 *
 * Everything here is arithmetic on numbers. No DOM, no three.js, no fetch — the
 * package's tsconfig omits the DOM lib so that stays true by construction rather
 * than by discipline.
 */

export interface Bounds {
  south: number
  north: number
  west: number
  east: number
}

/** Metres per degree of latitude at a given latitude (WGS84 series expansion). */
export function metresPerDegLat(latDeg: number): number {
  const p = (latDeg * Math.PI) / 180
  return (
    111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p)
  )
}

/** Metres per degree of longitude at a given latitude. */
export function metresPerDegLon(latDeg: number): number {
  const p = (latDeg * Math.PI) / 180
  return 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p)
}

/** Ground size of a bounding box in metres, measured at its centre latitude. */
export function boundsExtentMetres(b: Bounds): { width: number; height: number } {
  const midLat = (b.north + b.south) / 2
  return {
    width: Math.abs(b.east - b.west) * metresPerDegLon(midLat),
    height: Math.abs(b.north - b.south) * metresPerDegLat(midLat),
  }
}

/** Approximate bounding-box area in km². */
export function boundsAreaKm2(b: Bounds): number {
  const { width, height } = boundsExtentMetres(b)
  return (width * height) / 1e6
}

// ---- normalised box coordinates --------------------------------------------

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
  x: number
  y: number
}

/** Longitude/latitude → normalised box coordinates. */
export function lonLatToBox(b: Bounds, lon: number, lat: number): BoxPoint {
  return {
    x: (lon - b.west) / (b.east - b.west),
    y: (b.north - lat) / (b.north - b.south),
  }
}

/** Normalised box coordinates → longitude/latitude. */
export function boxToLonLat(b: Bounds, x: number, y: number): { lon: number; lat: number } {
  return {
    lon: b.west + x * (b.east - b.west),
    lat: b.north - y * (b.north - b.south),
  }
}

// ---- Web Mercator tiles ----------------------------------------------------

export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * Math.pow(2, z)
}

export function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z)
}
