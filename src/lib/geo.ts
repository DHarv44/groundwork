/**
 * Geodesy is now `@groundwork/core`.
 *
 * Re-exported here so existing imports keep resolving while the split proceeds — the
 * call sites move to the package as each area is touched, rather than in one sweep
 * that would put a rename on top of every other change in the branch.
 *
 * What stays in this file is what is genuinely *this application's*: where a first run
 * lands, how a box is worded for a person, and the climate curves that set the
 * viewer's defaults. None of those belong in a data-model package.
 */
export type { Bounds } from '@groundwork/core'
export {
  boundsAreaKm2,
  boundsExtentMetres,
  boxToLonLat,
  latToTileY,
  lonLatToBox,
  lonToTileX,
  metresPerDegLat,
  metresPerDegLon,
} from '@groundwork/core'

import type { Bounds } from '@groundwork/core'

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
