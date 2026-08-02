/// <reference lib="webworker" />
import { PbfReader } from 'pbf'
import { VectorTile } from '@mapbox/vector-tile'
import type { OsmArea, OsmPlace, RoadClass, RoadWay } from '../lib/overpass'

/**
 * Decodes OpenMapTiles-schema vector tiles into the app's road/area/place model.
 *
 * In a worker because a dense urban tile is a few hundred KB of protobuf and a box is
 * dozens of tiles — decoding on the main thread would jam the UI at exactly the moment
 * the user is watching a spinner. The main thread fetches (so caching and abort stay
 * with the store) and hands the raw buffers over; everything CPU-bound happens here.
 *
 * `toGeoJSON(x, y, z)` does the tile-grid → lon/lat projection, so what leaves this
 * worker is in the same coordinates the Overpass pipeline produced — nothing
 * downstream (masks, shader, pack export) knows the source changed.
 */

interface TileIn {
  x: number
  y: number
  z: number
  buf: ArrayBuffer
}

interface DecodeRequest {
  token: number
  tiles: TileIn[]
}

/**
 * OpenMapTiles `transportation.class` → our five road classes.
 *
 * Anything not listed is deliberately dropped: rail, ferries, aerialways, piers,
 * footpaths — the Overpass pipeline never fetched them either, and the mask has no
 * lane for them. `trunk` folds into motorway and `tertiary` into secondary, matching
 * how the old query's regex grouped the highway tags.
 */
const ROAD_OF: Record<string, RoadClass> = {
  motorway: 'motorway',
  trunk: 'motorway',
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'secondary',
  minor: 'minor',
  service: 'minor',
  track: 'track',
}

/** `landuse.class` values that count as built-up — same set the old query asked for. */
const BUILT = new Set(['residential', 'commercial', 'industrial', 'retail'])

const PLACE_KINDS = new Set(['city', 'town', 'village', 'hamlet'])

/** Equirectangular segment length — same approximation the Overpass path used. */
function segmentMetres(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const midLat = ((lat1 + lat2) / 2) * (Math.PI / 180)
  const dx = (lon2 - lon1) * 111320 * Math.cos(midLat)
  const dy = (lat2 - lat1) * 110540
  return Math.hypot(dx, dy)
}

function flatten(ring: number[][]): Float64Array {
  const out = new Float64Array(ring.length * 2)
  for (let i = 0; i < ring.length; i++) {
    out[i * 2] = ring[i]![0]!
    out[i * 2 + 1] = ring[i]![1]!
  }
  return out
}

function lineLength(pts: Float64Array): number {
  let m = 0
  for (let i = 2; i < pts.length; i += 2) {
    m += segmentMetres(pts[i - 2]!, pts[i - 1]!, pts[i]!, pts[i + 1]!)
  }
  return m
}

self.onmessage = (e: MessageEvent<DecodeRequest>) => {
  const { token, tiles } = e.data

  const roads: RoadWay[] = []
  const areas: OsmArea[] = []
  const places: OsmPlace[] = []
  let metres = 0

  // A point sitting in a tile's buffer zone is emitted by both neighbouring tiles.
  // Lines and polygons want that duplication (the pieces abut and the mask saturates),
  // but a duplicated town would double its label downstream, so places dedupe.
  const seenPlaces = new Set<string>()

  const pushLines = (cls: RoadClass, coords: number[][] | number[][][]) => {
    const lines = (Array.isArray(coords[0]![0]) ? coords : [coords]) as number[][][]
    for (const line of lines) {
      if (line.length < 2) continue
      const pts = flatten(line)
      metres += lineLength(pts)
      roads.push({ cls, pts })
    }
  }

  const pushPolygons = (
    kind: OsmArea['kind'],
    geomType: string,
    coords: number[][][] | number[][][][],
  ) => {
    // GeoJSON: a Polygon is [outer, ...holes]; a MultiPolygon is a list of those.
    const polys = (geomType === 'Polygon' ? [coords] : coords) as number[][][][]
    const outer: Float64Array[] = []
    const inner: Float64Array[] = []
    for (const poly of polys) {
      for (let r = 0; r < poly.length; r++) {
        const ring = poly[r]!
        if (ring.length < 4) continue
        ;(r === 0 ? outer : inner).push(flatten(ring))
      }
    }
    if (outer.length) areas.push({ kind, outer, inner })
  }

  for (const tile of tiles) {
    const vt = new VectorTile(new PbfReader(new Uint8Array(tile.buf)))

    const transportation = vt.layers['transportation']
    if (transportation) {
      for (let i = 0; i < transportation.length; i++) {
        const f = transportation.feature(i)
        const cls = ROAD_OF[String(f.properties['class'])]
        if (!cls) continue
        const geom = f.toGeoJSON(tile.x, tile.y, tile.z).geometry
        if (geom.type === 'LineString') pushLines(cls, geom.coordinates)
        else if (geom.type === 'MultiLineString') pushLines(cls, geom.coordinates)
      }
    }

    const water = vt.layers['water']
    if (water) {
      for (let i = 0; i < water.length; i++) {
        const f = water.feature(i)
        // The sea is deliberately excluded: the app derives its ocean from the DEM and
        // sea level, and a tile-painted ocean would fight that (and drown the slider).
        if (String(f.properties['class']) === 'ocean') continue
        const geom = f.toGeoJSON(tile.x, tile.y, tile.z).geometry
        if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
          pushPolygons('water', geom.type, geom.coordinates)
        }
      }
    }

    const landcover = vt.layers['landcover']
    if (landcover) {
      for (let i = 0; i < landcover.length; i++) {
        const f = landcover.feature(i)
        if (String(f.properties['class']) !== 'wood') continue
        const geom = f.toGeoJSON(tile.x, tile.y, tile.z).geometry
        if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
          pushPolygons('wood', geom.type, geom.coordinates)
        }
      }
    }

    const landuse = vt.layers['landuse']
    if (landuse) {
      for (let i = 0; i < landuse.length; i++) {
        const f = landuse.feature(i)
        if (!BUILT.has(String(f.properties['class']))) continue
        const geom = f.toGeoJSON(tile.x, tile.y, tile.z).geometry
        if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
          pushPolygons('built', geom.type, geom.coordinates)
        }
      }
    }

    const place = vt.layers['place']
    if (place) {
      for (let i = 0; i < place.length; i++) {
        const f = place.feature(i)
        const kind = String(f.properties['class'])
        const name = f.properties['name']
        if (!PLACE_KINDS.has(kind) || typeof name !== 'string' || !name) continue
        const geom = f.toGeoJSON(tile.x, tile.y, tile.z).geometry
        if (geom.type !== 'Point') continue
        const [lon, lat] = geom.coordinates as [number, number]
        const key = `${kind}|${name}|${lon.toFixed(4)},${lat.toFixed(4)}`
        if (seenPlaces.has(key)) continue
        seenPlaces.add(key)
        places.push({ kind: kind as OsmPlace['kind'], name, lon, lat })
      }
    }

    const peaks = vt.layers['mountain_peak']
    if (peaks) {
      for (let i = 0; i < peaks.length; i++) {
        const f = peaks.feature(i)
        const name = f.properties['name']
        if (typeof name !== 'string' || !name) continue
        const geom = f.toGeoJSON(tile.x, tile.y, tile.z).geometry
        if (geom.type !== 'Point') continue
        const [lon, lat] = geom.coordinates as [number, number]
        const key = `peak|${name}|${lon.toFixed(4)},${lat.toFixed(4)}`
        if (seenPlaces.has(key)) continue
        seenPlaces.add(key)
        const ele = f.properties['ele']
        places.push({
          kind: 'peak',
          name,
          lon,
          lat,
          ...(typeof ele === 'number' && Number.isFinite(ele) ? { elevation: ele } : {}),
        })
      }
    }
  }

  const transfers: ArrayBuffer[] = []
  for (const r of roads) transfers.push(r.pts.buffer as ArrayBuffer)
  for (const a of areas) {
    for (const ring of a.outer) transfers.push(ring.buffer as ArrayBuffer)
    for (const ring of a.inner) transfers.push(ring.buffer as ArrayBuffer)
  }

  ;(self as unknown as Worker).postMessage({ token, roads, areas, places, metres }, transfers)
}
