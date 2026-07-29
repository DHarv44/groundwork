import type { Bounds } from './geo'
import { boundsAreaKm2 } from './geo'

/**
 * What OpenStreetMap knows about a box: roads, water, woodland and where the town is.
 *
 * Unlike the elevation and the climate raster, this is *vector* data — which is the
 * whole reason it is worth pulling in rather than inventing. A road is a line somebody
 * surveyed and a lake is a shore somebody walked; there is no resampling to argue about
 * and nothing to reproject beyond lat/lon into the box. What gets decided here is only
 * which of them are worth asking for.
 *
 * One query for all of it, because Overpass is free, unauthenticated, shared
 * infrastructure and the polite way to use it is to ask once. No key, permissive CORS.
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

/**
 * The three kinds of ground OSM can tell us about that the renderer has an opinion on.
 *
 * Deliberately only three. OSM's tagging vocabulary is enormous and most of it says
 * nothing a terrain renderer can act on — what matters here is standing water, tree
 * cover, and whether people live on it.
 */
export type AreaKind = 'water' | 'wood' | 'built'

export const AREA_LABEL: Record<AreaKind, string> = {
  water: 'Water',
  wood: 'Woodland',
  built: 'Built-up',
}

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

/** Which tag combinations mean which kind of ground. */
function areaKindOf(tags: Record<string, string>): AreaKind | null {
  if (tags.natural === 'water' || tags.water) return 'water'
  if (tags.landuse === 'reservoir' || tags.landuse === 'basin') return 'water'
  if (tags.waterway === 'riverbank' || tags.waterway === 'dock') return 'water'
  if (tags.natural === 'wood' || tags.landuse === 'forest') return 'wood'
  if (
    tags.landuse === 'residential' ||
    tags.landuse === 'industrial' ||
    tags.landuse === 'commercial' ||
    tags.landuse === 'retail'
  ) {
    return 'built'
  }
  return null
}

export interface RoadWay {
  cls: RoadClass
  /** Flat [lon, lat, lon, lat, …]. Flat because this is what gets cached and cloned. */
  pts: Float64Array
}

/**
 * One mapped area: its outline, and anything cut out of it.
 *
 * A feature rather than a ring, because holes only mean anything relative to the outline
 * they belong to. A lake with an island is one area with one outer ring and one inner;
 * keeping them together is what lets the rasteriser fill the pair with an even-odd rule
 * and get the island back, instead of flooding it.
 */
export interface OsmArea {
  kind: AreaKind
  /** Closed rings, flat [lon, lat, …]. Usually one; a relation may have several. */
  outer: Float64Array[]
  /** Rings cut out of the outer ones — islands, clearings, courtyards. */
  inner: Float64Array[]
}

export interface OsmData {
  bounds: Bounds
  roads: RoadWay[]
  areas: OsmArea[]
  /** Road centreline length in km — the readout, and how you tell a city from a moor. */
  lengthKm: number
  /** Which road classes were actually requested. See `classesFor`. */
  requested: RoadClass[]
  /** True when the class filter dropped detail the box was too big to resolve. */
  filtered: boolean
  fetchedAt: number
}

/**
 * Which road classes to ask for, by how much ground the box covers.
 *
 * Not a bandwidth optimisation — a resolution one. A residential street is 6 m wide; on
 * a 100 km box the mask has one texel per 50 m, so every street in Denver would land in
 * the same handful of pixels and paint the whole city solid. Asking for them would cost
 * tens of megabytes to produce a grey smear.
 *
 * The cutoffs are where each class stops being separable at a plausible mask resolution.
 * Whatever is dropped is reported rather than quietly omitted — see `filtered`.
 *
 * Areas are not filtered this way. A lake or a forest block stays legible at any scale
 * precisely because it is an area — shrinking the box does not make it thinner.
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

/**
 * Public Overpass instances, tried in order.
 *
 * More than two because the failures are not interchangeable. The main instance can be
 * unreachable from a given network entirely — a connection that never opens rather than
 * a request that is refused — while a mirror answers fine, and vice versa. One dead host
 * should cost a few seconds, not the whole feature.
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
]

/**
 * How long to wait on one endpoint before moving to the next.
 *
 * Without this a host that accepts nothing takes the operating system's connect timeout
 * to fail — well over a minute on some networks — and the mirrors never get tried at
 * all. Generous enough for a real query over a city, short enough that an unreachable
 * host is not the end of it.
 */
const ATTEMPT_TIMEOUT_MS = 50000

function tagsFor(classes: RoadClass[]): string[] {
  const want = new Set(classes)
  return Object.keys(TAG_CLASS).filter((t) => want.has(TAG_CLASS[t]!))
}

function buildQuery(b: Bounds, classes: RoadClass[]): string {
  // Overpass bbox order is (south, west, north, east).
  const bbox = `${b.south},${b.west},${b.north},${b.east}`
  const roads = tagsFor(classes).join('|')
  const landuse = 'forest|reservoir|basin|residential|industrial|commercial|retail'

  // `out geom` inlines every way's coordinates, and for relations it inlines each
  // member's — so there is no second pass to resolve node ids. One request, one parse.
  //
  // Relations are asked for on the area tags only. A big lake with islands, or a forest
  // that wraps a village, is a multipolygon rather than a closed way, and leaving them
  // out would silently drop exactly the largest features in the box. Route relations on
  // roads carry no geometry of their own and are not wanted.
  return (
    `[out:json][timeout:90];(` +
    `way["highway"~"^(${roads})$"](${bbox});` +
    `way["natural"~"^(water|wood)$"](${bbox});` +
    `way["landuse"~"^(${landuse})$"](${bbox});` +
    `way["waterway"~"^(riverbank|dock)$"](${bbox});` +
    `relation["natural"~"^(water|wood)$"](${bbox});` +
    `relation["landuse"~"^(${landuse})$"](${bbox});` +
    `);out geom;`
  )
}

interface OverpassGeom {
  lat: number
  lon: number
}

interface OverpassElement {
  type: 'way' | 'relation' | string
  tags?: Record<string, string>
  geometry?: OverpassGeom[]
  members?: Array<{ type: string; role?: string; geometry?: OverpassGeom[] }>
}

function toFlat(geom: OverpassGeom[]): Float64Array {
  const out = new Float64Array(geom.length * 2)
  for (let i = 0; i < geom.length; i++) {
    out[i * 2] = geom[i]!.lon
    out[i * 2 + 1] = geom[i]!.lat
  }
  return out
}

/** Endpoints come from the same shared node, so this only guards float printing. */
const JOIN_EPS = 1e-9

function samePoint(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.abs(ax - bx) < JOIN_EPS && Math.abs(ay - by) < JOIN_EPS
}

/**
 * Stitch a multipolygon's member ways into closed rings.
 *
 * A relation's outer boundary is almost never one way. Mappers split a big shoreline
 * into dozens of segments — so they can be edited independently, and because ways have
 * a node limit — and the ring only exists once they are joined end to end. The segments
 * arrive in no particular order and in no particular direction.
 *
 * Treating each member as a ring in its own right is what tore Lake Houston into a
 * scatter of disconnected blobs: every fragment got closed back on itself, so instead of
 * one reservoir there were forty slivers with the water between them missing. Small
 * ponds looked perfect throughout, because a pond is a single closed way and never went
 * through this path at all.
 *
 * Quadratic in the member count, which is fine — relations have tens of members, not
 * thousands. Fragments that never close are still kept: an unclosed shoreline is better
 * filled as an implicit polygon than dropped, and canvas closes it for us.
 */
function assembleRings(segments: Float64Array[]): Float64Array[] {
  const rings: Float64Array[] = []
  const used = new Array<boolean>(segments.length).fill(false)

  const isClosed = (r: number[]): boolean =>
    r.length >= 6 && samePoint(r[0]!, r[1]!, r[r.length - 2]!, r[r.length - 1]!)

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue
    used[i] = true
    const ring: number[] = Array.from(segments[i]!)

    // Keep extending the open end until it meets itself or nothing else fits.
    while (!isClosed(ring)) {
      const ex = ring[ring.length - 2]!
      const ey = ring[ring.length - 1]!
      let joined = false

      for (let j = 0; j < segments.length; j++) {
        if (used[j]) continue
        const s = segments[j]!
        const n = s.length
        if (samePoint(ex, ey, s[0]!, s[1]!)) {
          for (let k = 2; k < n; k += 2) ring.push(s[k]!, s[k + 1]!)
        } else if (samePoint(ex, ey, s[n - 2]!, s[n - 1]!)) {
          // Runs the other way round; walk it backwards from its own end.
          for (let k = n - 4; k >= 0; k -= 2) ring.push(s[k]!, s[k + 1]!)
        } else {
          continue
        }
        used[j] = true
        joined = true
        break
      }

      if (!joined) break
    }

    if (ring.length >= 8) rings.push(new Float64Array(ring))
  }

  return rings
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
 * POST, retrying once through a short wait when the server says it is busy.
 *
 * A public Overpass instance answers 429 when every query slot for your IP is taken and
 * 504 when one timed out under load. Both clear on their own within seconds, and both
 * are far more likely than an outage — so a single patient retry converts most of them
 * into a successful request instead of an error the user has to act on.
 *
 * Only one retry, and only for those two codes: anything else is a real failure and
 * should surface immediately rather than being sat on.
 */
async function postWithBackoff(
  endpoint: string,
  body: string,
  signal: AbortSignal | undefined,
  onProgress?: (note: string) => void,
): Promise<Response> {
  const send = () => {
    // The caller's abort still wins; this only adds a ceiling so an endpoint that never
    // answers cannot hold up the ones after it.
    const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  }

  const first = await send()
  if (first.status !== 429 && first.status !== 504) return first

  onProgress?.('OpenStreetMap is busy — waiting for a slot…')
  await new Promise((r) => setTimeout(r, 4000))
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  return send()
}

/**
 * Fetch everything mapped in the box.
 *
 * Returns empty lists rather than throwing when the area genuinely has nothing — open
 * desert, ocean and wilderness are correct answers, not failures, and the caller needs
 * to be able to tell them apart from a fetch that fell over.
 */
export async function fetchOsm(
  bounds: Bounds,
  detailFor?: Bounds,
  signal?: AbortSignal,
  onProgress?: (note: string) => void,
): Promise<OsmData> {
  const boxKm2 = boundsAreaKm2(bounds)
  if (boxKm2 > MAX_ROAD_AREA_KM2) {
    throw new NoRoadDataError(
      `Area is ${Math.round(boxKm2).toLocaleString()} km² — map features are only fetched ` +
        `up to ${MAX_ROAD_AREA_KM2.toLocaleString()} km².`,
    )
  }

  // Detail is decided by the box the *user* asked for, not the one being fetched.
  //
  // The fetch box is grown outward to a cache grid, and that growth can push it across
  // one of the class thresholds — a 3,770 km² selection qualifies for minor roads, and
  // the 4,480 km² box it snaps to does not. Deciding from the snapped box meant the
  // residential streets silently disappeared because of an internal caching choice, at
  // a size where they are perfectly resolvable. Snapping may cost bandwidth; it must
  // never cost detail.
  const requested = classesFor(boundsAreaKm2(detailFor ?? bounds))
  const filtered = requested.length < ROAD_ORDER.length
  const body = `data=${encodeURIComponent(buildQuery(bounds, requested))}`

  let lastError: Error | null = null
  for (const endpoint of ENDPOINTS) {
    try {
      onProgress?.(
        endpoint === ENDPOINTS[0] ? 'Querying OpenStreetMap…' : 'Retrying on a mirror…',
      )
      const res = await postWithBackoff(endpoint, body, signal, onProgress)
      if (!res.ok) {
        // 429 and 504 are what a public Overpass instance says when it is busy, and they
        // are worth naming rather than reporting as a generic failure: the request was
        // fine, the server simply has no slot free. Slots are counted per client IP, so
        // two tabs on the same machine compete with each other — which is exactly the
        // shape of "it works over there and not over here".
        if (res.status === 429 || res.status === 504) {
          throw new NoRoadDataError(
            'OpenStreetMap is rate-limiting this connection (all query slots busy). ' +
              'Wait a minute and try again — the limit is per IP, so another tab or app ' +
              'querying Overpass from this machine counts against the same allowance.',
          )
        }
        throw new Error(`Overpass HTTP ${res.status}`)
      }

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

      const json = JSON.parse(text) as { elements?: OverpassElement[]; remark?: string }
      // Overpass reports its own failures inside a 200 response.
      if (json.remark && !json.elements?.length) throw new Error(json.remark)

      const roads: RoadWay[] = []
      const areas: OsmArea[] = []
      let metres = 0

      for (const el of json.elements ?? []) {
        const tags = el.tags
        if (!tags) continue

        const highway = tags.highway
        if (highway) {
          const cls = TAG_CLASS[highway]
          if (!cls || !el.geometry || el.geometry.length < 2) continue
          const pts = toFlat(el.geometry)
          metres += wayLength(pts)
          roads.push({ cls, pts })
          continue
        }

        const kind = areaKindOf(tags)
        if (!kind) continue

        if (el.type === 'way' && el.geometry && el.geometry.length >= 4) {
          areas.push({ kind, outer: [toFlat(el.geometry)], inner: [] })
        } else if (el.type === 'relation' && el.members) {
          // Members are stitched into rings rather than taken one at a time: a
          // relation's boundary is split across many ways and only becomes a polygon
          // once they are joined.
          //
          // Inner members are kept and travel with their outer ones, so an island stays
          // an island. A member with no role at all is treated as outer, which is what
          // the tagging convention means by omitting it.
          const outerParts: Float64Array[] = []
          const innerParts: Float64Array[] = []
          for (const m of el.members) {
            if (m.type !== 'way' || !m.geometry || m.geometry.length < 2) continue
            if (m.role === 'inner') innerParts.push(toFlat(m.geometry))
            else if (!m.role || m.role === 'outer') outerParts.push(toFlat(m.geometry))
          }
          const outer = assembleRings(outerParts)
          if (outer.length) areas.push({ kind, outer, inner: assembleRings(innerParts) })
        }
      }

      return {
        bounds,
        roads,
        areas,
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
