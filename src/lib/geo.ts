export interface Bounds {
  south: number
  north: number
  west: number
  east: number
}

/**
 * Where a first run lands, before anything is in local storage.
 *
 * The Colorado Front Range, because it is the area the vegetation and hydrology were
 * calibrated against: a single box spans a mountain front, so it contains four Köppen
 * classes, timber, steppe, a real drainage network, and enough relief for the snow and
 * tree lines to mean something. A flat or single-climate box would show almost none of
 * what the renderer actually does.
 */
export const DEFAULT_BOUNDS: Bounds = {
  south: 39.4807,
  north: 40.1306,
  west: -105.9631,
  east: -104.6887,
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

/** Approximate bounding-box area in km². OpenTopography enforces per-dataset limits. */
export function boundsAreaKm2(b: Bounds): number {
  const { width, height } = boundsExtentMetres(b)
  return (width * height) / 1e6
}

/** Linear interpolation through a table sampled every 10° of latitude from 0 to 90. */
function byLatitude(table: number[], latDeg: number): number {
  const lat = Math.min(90, Math.abs(latDeg))
  const step = 90 / (table.length - 1)
  const i = Math.min(table.length - 2, Math.floor(lat / step))
  const t = (lat - i * step) / step
  return Math.max(0, table[i] + (table[i + 1] - table[i]) * t)
}

//                          0°    10°   20°   30°   40°   50°   60°   70°   80°  90°
const SNOW_LINE_BY_LAT = [4800, 4950, 5150, 4700, 3650, 2500, 1600, 900, 400, 0]
const TREE_LINE_BY_LAT = [3800, 3900, 3800, 3300, 2550, 1650, 900, 200, 0, 0]

/**
 * Approximate permanent snow line for a latitude, in metres.
 *
 * Snow and tree lines are set by climate, not by how much relief happens to fall inside
 * the requested box — deriving them from the box's own range puts snowfields on Texas
 * farmland. Note the curve peaks in the dry subtropics rather than at the equator, which
 * is why a straight line from pole to equator fits the Alps and Himalaya badly.
 */
export function climaticSnowLine(latDeg: number): number {
  return byLatitude(SNOW_LINE_BY_LAT, latDeg)
}

/** Approximate tree line for a latitude, in metres. */
export function climaticTreeLine(latDeg: number): number {
  return byLatitude(TREE_LINE_BY_LAT, latDeg)
}

export function formatBounds(b: Bounds, dp = 4): string {
  const f = (n: number) => n.toFixed(dp)
  return `S ${f(b.south)}  N ${f(b.north)}  W ${f(b.west)}  E ${f(b.east)}`
}

// ---- Web Mercator tile maths (for draping satellite imagery) ----

export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * Math.pow(2, z)
}

export function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z)
}
