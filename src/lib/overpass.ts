import type { Bounds } from './geo'
import { boundsAreaKm2 } from './geo'

/**
 * Roads, from OpenStreetMap via the Overpass API.
 *
 * Unlike the elevation and the climate raster, this is *vector* data — which is the
 * whole reason it is worth pulling in rather than inventing. A road is a line somebody
 * surveyed, with a class attached; there is no resampling to argue about and nothing to
 * reproject beyond lat/lon into the box. What gets decided here is only which of them
 * are worth asking for.
 *
 * No key, no account, permissive CORS. The public endpoints are shared infrastructure
 * and are rate-limited accordingly, so every answer is cached — see roadcache.ts.
 *
 * Data © OpenStreetMap contributors, ODbL. Attribution travels with anything exported.
 */

export type RoadClass = 'motorway' | 'primary' | 'secondary' | 'minor' | 'track'

/**
 * Real surface widths in metres, kerb to kerb.
 *
 * Motorways are wide because the figure covers both carriageways and the median — at
 * the resolution any of this is drawn at, a dual carriageway is one ribbon.
 *
 * `order` is paint order: a motorway crossing a track is drawn last and wins the pixel.
 */
export const ROAD_CLASSES: Record<RoadClass, { width: number; order: number; label: string }> = {
  track: { width: 3.5, order: 0, label: 'Track' },
  minor: { width: 6, order: 1, label: 'Minor road' },
  secondary: { width: 8.5, order: 2, label: 'Secondary' },
  primary: { width: 12, order: 3, label: 'Primary' },
  motorway: { width: 24, order: 4, label: 'Motorway' },
}

export const ROAD_ORDER: RoadClass[] = ['track', 'minor', 'secondary', 'primary', 'motorway']

/** OSM `highway=*` values, grouped into the five classes we draw. */
const TAG_CLASS: Record<string, RoadClass> = {
  motorway: 'motorway',
  motorway_link: 'motorway',
  trunk: 'motorway',
  trunk_link: 'motorway',
  primary: 'primary',
  primary_link: 'primary',
  secondary: 'secondary',
  secondary_link: 'secondary',
  tertiary: 'secondary',
  tertiary_link: 'secondary',
  unclassified: 'minor',
  residential: 'minor',
  living_street: 'minor',
  service: 'minor',
  track: 'track',
}

export interface RoadWay {
  cls: RoadClass
  /** Flat [lon, lat, lon, lat, …]. Flat because this is what gets cached and cloned. */
  pts: Float64Array
}

export interface RoadNetwork {
  bounds: Bounds
  ways: RoadWay[]
  /** Centreline length in km, by class — the readout, and how you tell a city from a moor. */
  lengthKm: number
  /** Which OSM classes were actually requested. See `classesFor`. */
  requested: RoadClass[]
  /** True when the class filter dropped detail the box was too big to resolve. */
  filtered: boolean
  fetchedAt: number
}

/**
 * Which classes to ask for, by how much ground the box covers.
 *
 * Not a bandwidth optimisation — a resolution one. A residential street is 6 m wide; on
 * a 100 km box the mask has one texel per 50 m, so every street in Denver would land in
 * the same handful of pixels and paint the whole city solid. Asking for them would cost
 * tens of megabytes to produce a grey smear.
 *
 * The cutoffs are where each class stops being separable at a plausible mask resolution.
 * Whatever is dropped is reported rather than quietly omitted — see `filtered`.
 */
export function classesFor(areaKm2: number): RoadClass[] {
  if (areaKm2 <= 400) return ['track', 'minor', 'secondary', 'primary', 'motorway']
  if (areaKm2 <= 4000) return ['minor', 'secondary', 'primary', 'motorway']
  return ['secondary', 'primary', 'motorway']
}

/** Past this there is no sensible answer to give, so say so rather than hanging. */
export const MAX_ROAD_AREA_KM2 = 40000

/**
 * Largest response we will try to parse, in characters.
 *
 * The area cap alone is not enough of a guard: the same box is a few hundred kilobytes
 * over the Sahara and hundreds of megabytes over the Ruhr, and it is the byte count
 * rather than the ground area that decides whether the tab survives parsing it.
 */
const MAX_RESPONSE_BYTES = 120e6

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

function tagsFor(classes: RoadClass[]): string[] {
  const want = new Set(classes)
  return Object.keys(TAG_CLASS).filter((t) => want.has(TAG_CLASS[t]!))
}

function buildQuery(b: Bounds, classes: RoadClass[]): string {
  // Overpass bbox order is (south, west, north, east).
  const bbox = `${b.south},${b.west},${b.north},${b.east}`
  const filter = tagsFor(classes).join('|')
  // `out geom` inlines each way's coordinates, so there is no second pass to resolve
  // node ids — one request, one parse.
  return `[out:json][timeout:60];way["highway"~"^(${filter})$"](${bbox});out geom;`
}

interface OverpassWay {
  type: string
  tags?: Record<string, string>
  geometry?: Array<{ lat: number; lon: number }>
}

/** Great-circle length of a way in metres, for the readout only. */
function wayLength(pts: Float64Array): number {
  let total = 0
  for (let i = 2; i < pts.length; i += 2) {
    const lat = ((pts[i + 1]! + pts[i - 1]!) / 2) * (Math.PI / 180)
    const dx = (pts[i]! - pts[i - 2]!) * 111320 * Math.cos(lat)
    const dy = (pts[i + 1]! - pts[i - 1]!) * 110540
    total += Math.hypot(dx, dy)
  }
  return total
}

export class NoRoadDataError extends Error {}

/**
 * Fetch every mapped road in the box.
 *
 * Returns an empty network rather than throwing when the area genuinely has no roads —
 * open desert, ocean, and wilderness are correct answers, not failures, and the caller
 * needs to be able to tell them apart from a fetch that fell over.
 */
export async function fetchRoads(
  bounds: Bounds,
  signal?: AbortSignal,
  onProgress?: (note: string) => void,
): Promise<RoadNetwork> {
  const area = boundsAreaKm2(bounds)
  if (area > MAX_ROAD_AREA_KM2) {
    throw new NoRoadDataError(
      `Area is ${Math.round(area).toLocaleString()} km² — roads are only fetched up to ` +
        `${MAX_ROAD_AREA_KM2.toLocaleString()} km².`,
    )
  }

  const requested = classesFor(area)
  const filtered = requested.length < ROAD_ORDER.length
  const body = `data=${encodeURIComponent(buildQuery(bounds, requested))}`

  let lastError: Error | null = null
  for (const endpoint of ENDPOINTS) {
    try {
      onProgress?.(
        endpoint === ENDPOINTS[0] ? 'Querying OpenStreetMap…' : 'Retrying on a mirror…',
      )
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal,
      })
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`)

      // Read as text and check the size before parsing.
      //
      // `out geom` inlines every coordinate, so a dense box produces a very large body,
      // and JSON.parse on hundreds of megabytes takes the tab down rather than throwing
      // something catchable. Checking first turns an out-of-memory crash into a message.
      const text = await res.text()
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new NoRoadDataError(
          `OpenStreetMap returned ${(text.length / 1e6).toFixed(0)} MB for this area, which ` +
            `is more than can be drawn. Try a smaller box.`,
        )
      }

      const json = JSON.parse(text) as { elements?: OverpassWay[]; remark?: string }
      // Overpass reports its own failures inside a 200 response.
      if (json.remark && !json.elements?.length) throw new Error(json.remark)

      const ways: RoadWay[] = []
      let metres = 0
      for (const el of json.elements ?? []) {
        const tag = el.tags?.highway
        const cls = tag ? TAG_CLASS[tag] : undefined
        if (!cls || !el.geometry || el.geometry.length < 2) continue
        const pts = new Float64Array(el.geometry.length * 2)
        for (let i = 0; i < el.geometry.length; i++) {
          pts[i * 2] = el.geometry[i]!.lon
          pts[i * 2 + 1] = el.geometry[i]!.lat
        }
        metres += wayLength(pts)
        ways.push({ cls, pts })
      }

      return {
        bounds,
        ways,
        lengthKm: metres / 1000,
        requested,
        filtered,
        fetchedAt: Date.now(),
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err
      lastError = err as Error
    }
  }
  throw lastError ?? new Error('Overpass unreachable')
}
