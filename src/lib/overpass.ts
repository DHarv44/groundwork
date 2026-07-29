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

/**
 * Tertiary is its own class, not folded in with secondary.
 *
 * It was bundled to begin with, and that turned out to be where the weight is. Over
 * Denver the combined class came to 5,688 km against 1,936 of primary and 2,116 of
 * motorway — and by way count far more again, because tertiary is the whole arterial
 * street grid rather than a handful of long routes. Measured: 54 MB for that box, most
 * of it tertiary geometry.
 *
 * Bundled, dropping the street grid meant dropping genuine secondary arterials with it,
 * so the choice was all-or-nothing at exactly the wrong boundary. Separated, a wide box
 * can keep the routes that carry traffic between towns and leave out the streets inside
 * them — which at fifty metres a pixel are drawn nine times wider than life anyway.
 */
export type RoadClass = 'motorway' | 'primary' | 'secondary' | 'tertiary' | 'minor' | 'track'

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
  minor: { width: 6, order: 1, label: 'Residential' },
  tertiary: { width: 7.5, order: 2, label: 'Tertiary' },
  secondary: { width: 9, order: 3, label: 'Secondary' },
  primary: { width: 12, order: 4, label: 'Primary' },
  motorway: { width: 24, order: 5, label: 'Motorway' },
}

export const ROAD_ORDER: RoadClass[] = [
  'track',
  'minor',
  'tertiary',
  'secondary',
  'primary',
  'motorway',
]

/** Highest `order` value, so the mask can normalise class into a 0..1 channel. */
export const ROAD_ORDER_MAX = ROAD_ORDER.length - 1

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
  tertiary: 'tertiary',
  tertiary_link: 'tertiary',
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

/**
 * Everything that can be fetched, each on its own request, status and cache entry.
 *
 * One per road class rather than one for "roads". A motorway query and a residential
 * query differ by orders of magnitude in cost — over a metro the residential streets are
 * most of the payload and the motorways are a handful of long lines — so bundling them
 * meant the cheap ones could never be had without the dear ones. Separately, each is
 * asked for only when it is wanted, and a box can carry motorways in seconds while
 * residential streets are still arriving or never requested at all.
 */
export type OsmKind = RoadClass | AreaKind

export const AREA_KINDS: AreaKind[] = ['water', 'wood', 'built']
export const OSM_KINDS: OsmKind[] = [...ROAD_ORDER, ...AREA_KINDS]

export function isAreaKind(k: OsmKind): k is AreaKind {
  return k === 'water' || k === 'wood' || k === 'built'
}

/**
 * What was asked for, which is part of the cache identity as much as where.
 *
 * `detail` only means anything for roads; an entry of lakes is the same lakes whatever
 * the road setting was at the time. Carrying it regardless keeps one key format for all
 * four, and costs a redundant refetch of areas only if the road detail changes — which
 * `detailOf` avoids by pinning it for the area kinds.
 */
export interface OsmRequest {
  kind: OsmKind
}

export interface OsmData {
  bounds: Bounds
  roads: RoadWay[]
  areas: OsmArea[]
  /** Road centreline length in km — the readout, and how you tell a city from a moor. */
  lengthKm: number
  fetchedAt: number
}

/**
 * Which classes a freshly-drawn box starts with.
 *
 * Only a starting point now that each class is its own checkbox — nothing is inferred
 * once you have chosen. The default is the trunk network at every size, because the road
 * network here is context for the terrain rather than the subject, and because that is
 * the one setting that is quick everywhere.
 */
export const DEFAULT_ROAD_CLASSES: Record<RoadClass, boolean> = {
  motorway: true,
  primary: true,
  secondary: false,
  tertiary: false,
  minor: false,
  track: false,
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
 * The bar is that an instance is documented on the OpenStreetMap wiki, or is verifiably
 * run by an operator that is. Adding hosts from memory failed that twice: overpass.osm.jp
 * serves a certificate for the wrong hostname, and overpass.kumi.systems is absent from
 * the wiki — though checking rather than assuming showed it is run by Private.coffee,
 * the same Austrian non-profit as the listed instance, so it stays.
 *
 * Which brings up the thing the list does not show on its face: the last two share an
 * operator. They are two hostnames, not two organisations, so an outage or a policy
 * decision at Private.coffee removes both at once. Real redundancy here is exactly one
 * deep — FOSSGIS or them — and that is worth knowing before relying on the fallback.
 *
 * What crosses to them is a bounding box and a query; what comes back is JSON, parsed
 * and never evaluated. No credentials go with it — a cross-origin fetch carries no
 * cookies by default. So the exposure is that an operator learns which areas are being
 * looked at, and that a hostile instance could return invented geometry. Private.coffee
 * states it keeps only the first three bytes of the IPv4 address, for 48 hours.
 *
 * NOTE ON TERMS: Private.coffee's terms of use prohibit applications supporting warfare
 * or military purposes. That is not a hypothetical restriction for this project — the
 * exports are aimed partly at a military simulation — so anything built on that path
 * should take its data from FOSSGIS, or bake it once from a source whose terms allow it,
 * rather than quietly falling back to a mirror that forbids the use.
 */
const ENDPOINTS = [
  // FOSSGIS, the official instance. 10,000 queries/day, 1 GB/day.
  'https://overpass-api.de/api/interpreter',
  // Private.coffee, listed on the wiki. No rate limit, asks for fair sharing.
  'https://overpass.private.coffee/api/interpreter',
  // The same operator under its older hostname — kept because it is the one instance
  // reachable on some networks where the other two are not.
  'https://overpass.kumi.systems/api/interpreter',
]

/**
 * The endpoint that last answered, tried first next time.
 *
 * Which instances are reachable is a property of the network, not of the code. On one
 * machine overpass-api.de and overpass.osm.jp both time out at the TCP level — dropped
 * packets, not refusals — while kumi and private.coffee answer immediately; on another
 * the main instance is the only one that works. A fixed order makes every request on the
 * first kind of network pay a full connect timeout before getting anywhere.
 *
 * Remembering the last success costs one localStorage read and turns that into a single
 * lucky first try. The full list is still walked afterwards, so this is only an ordering
 * hint and a host coming back to life is picked up on the next failure.
 */
const LAST_GOOD_KEY = 'terrain-builder.overpass'

function orderedEndpoints(): string[] {
  let last: string | null = null
  try {
    last = localStorage.getItem(LAST_GOOD_KEY)
  } catch {
    /* private mode, or storage disabled — the default order is fine */
  }
  if (!last || !ENDPOINTS.includes(last)) return ENDPOINTS
  return [last, ...ENDPOINTS.filter((e) => e !== last)]
}

function rememberEndpoint(endpoint: string): void {
  try {
    localStorage.setItem(LAST_GOOD_KEY, endpoint)
  } catch {
    /* best effort */
  }
}

/** How long to give the cheap reachability probe on each instance. */
const PROBE_TIMEOUT_MS = 5000

/**
 * Tracing for the fetch path, on by default.
 *
 * This is the one part of the app whose failures live entirely outside it — an instance
 * dropping packets, a mirror out of slots, a certificate for the wrong name, a response
 * too large to parse — and none of those are visible from the rendered result. Every one
 * of them cost a round of guesswork to identify, so the evidence is printed rather than
 * reconstructed.
 *
 * Silence it with `localStorage['terrain-builder.osmlog'] = 'off'`.
 */
function osmLog(message: string, detail?: unknown): void {
  try {
    if (localStorage.getItem('terrain-builder.osmlog') === 'off') return
  } catch {
    /* storage unavailable — log anyway */
  }
  if (detail === undefined) console.info(`%c[osm]%c ${message}`, 'color:#7dd3fc', '')
  else console.info(`%c[osm]%c ${message}`, 'color:#7dd3fc', '', detail)
}

const ms = (t0: number) => `${Math.round(performance.now() - t0)}ms`

/**
 * Find instances that will actually talk to us, before sending a real query.
 *
 * Reachability and load are different questions and they deserve different timeouts. A
 * healthy Overpass opens a connection in well under a second even when the query itself
 * then takes a minute — so the long timeout a real query needs is exactly the wrong
 * thing to spend discovering that a host is dropping packets.
 *
 * Without this the failover works but costs a full timeout per dead host before it gets
 * anywhere: measured at 47 seconds of nothing on a network where the main instance is
 * unreachable. Probing `/api/status` — a few bytes, no query slot consumed — in parallel
 * turns that into about five.
 *
 * Returns every instance that answered, in preference order, so the caller still has
 * somewhere to fail over to. If none answer the full list is returned anyway: a probe
 * failing is evidence, not proof, and it would be worse to refuse to try at all.
 */
/**
 * The last probe result, reused briefly.
 *
 * Four layers are fetched side by side and each would otherwise probe every instance for
 * itself — four rounds of the same question, and on a network where one host is dead
 * that is four five-second waits rather than one. Reachability does not change on that
 * timescale, so the answer is shared.
 *
 * The promise is cached rather than the value, so requests that start together share the
 * one in flight instead of racing to each make their own.
 */
let probeCache: { at: number; result: Promise<string[]> } | null = null
const PROBE_CACHE_MS = 60000

async function reachableEndpoints(signal?: AbortSignal): Promise<string[]> {
  const now = performance.now()
  if (probeCache && now - probeCache.at < PROBE_CACHE_MS) return probeCache.result
  const result = probeEndpoints(signal)
  probeCache = { at: now, result }
  // A probe that throws must not be remembered as the answer for the next minute.
  result.catch(() => {
    if (probeCache?.result === result) probeCache = null
  })
  return result
}

async function probeEndpoints(signal?: AbortSignal): Promise<string[]> {
  const ordered = orderedEndpoints()

  const probe = async (endpoint: string): Promise<string | null> => {
    // `no-cors`, because the only readable endpoint is the one we are trying to avoid
    // spending a long timeout on.
    //
    // Two blind alleys got here. /api/status looks like the obvious health check and
    // hangs past twenty seconds on the mirrors — it queues behind the same slots a real
    // query does. The site root answers in under a second, but only /api/interpreter
    // sends Access-Control-Allow-Origin, so a normal fetch to the root is blocked by
    // CORS despite the server answering perfectly well. (Both of those measure as fine
    // under curl, which enforces no CORS at all — a browser feature has to be checked
    // in a browser.)
    //
    // An opaque response cannot be read, and does not need to be: it resolves when the
    // connection opened and rejects when it did not, which is the entire question.
    const origin = new URL(endpoint).origin
    const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
    const t0 = performance.now()
    try {
      await fetch(origin, {
        mode: 'no-cors',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      osmLog(`probe ok    ${origin} (${ms(t0)})`)
      return endpoint
    } catch (err) {
      osmLog(`probe DEAD  ${origin} (${ms(t0)}, ${(err as Error).name})`)
      return null
    }
  }

  // Fast path: if the instance that served last time still answers, go straight there
  // rather than waiting on the rest. That is the steady state after one success, and it
  // takes the check from the slowest probe — a dead host burning the full timeout — down
  // to a single round trip.
  if (await probe(ordered[0]!)) return ordered

  const rest = ordered.slice(1)
  const results = await Promise.all(rest.map(probe))
  const live = rest.filter((_, i) => results[i] !== null)
  if (live.length === 0) {
    // None answered: try everything anyway. A probe failing is evidence, not proof, and
    // refusing to attempt the real request would be worse than attempting it in vain.
    osmLog('no instance answered a probe — trying all of them regardless')
    return ordered
  }
  return live
}

/**
 * How long Overpass is allowed to spend on the query, and how long we wait for it.
 *
 * These have to be set together, and the client's has to be the larger of the two. A
 * fixed 50 s ceiling against a query that asked the server for 90 s meant aborting work
 * the server would have finished — a big box failed with "signal timed out" while the
 * far end was still perfectly happily assembling the answer.
 *
 * The server budget scales with the box because the work does. The client then allows
 * that plus a margin for transferring what can be a hundred megabytes of JSON, which is
 * not part of the server's own timeout at all.
 *
 * Being generous is only safe because reachability is settled separately: the probe has
 * already established that something is listening, so this is spent on a host that is
 * working rather than on one that is dropping packets.
 */
function timeoutsFor(areaKm2: number): { server: number; client: number } {
  const server = Math.round(Math.min(180, Math.max(60, areaKm2 / 120)))
  return { server, client: (server + 45) * 1000 }
}

function tagsFor(classes: RoadClass[]): string[] {
  const want = new Set(classes)
  return Object.keys(TAG_CLASS).filter((t) => want.has(TAG_CLASS[t]!))
}

/**
 * Roads and areas are asked for separately, on purpose.
 *
 * They were one query to begin with — one request is politer than two, and both come
 * from the same box. That was a mistake, and an expensive one: a road query is a single
 * clause over an indexed tag and comes back in seconds, while the area query is six
 * clauses including two on relations and `landuse=residential`, which over a metro is
 * among the largest things in OpenStreetMap. Bundling them meant the cheap half waited
 * on the dear half, and a box that used to draw roads in fifteen seconds stopped
 * answering at all.
 *
 * Split, the roads come back as fast as they ever did and draw immediately; the areas
 * arrive behind them, the way the hydrology pass already streams in behind the terrain.
 * If the area query is slow, or fails, the roads are untouched by it.
 */
function roadSelection(b: Bounds, classes: RoadClass[]): string {
  // Overpass bbox order is (south, west, north, east).
  const bbox = `${b.south},${b.west},${b.north},${b.east}`
  return `(way["highway"~"^(${tagsFor(classes).join('|')})$"](${bbox});)`
}

/**
 * One selection per layer, so each can be asked for on its own.
 *
 * Four small queries rather than one large one. Each is a couple of clauses over an
 * indexed tag and comes back quickly; bundled, they were six clauses including
 * `landuse=residential`, which over a metro is among the largest things in
 * OpenStreetMap and dragged everything else down with it.
 *
 * Separately, they also fail separately. A built-up query that times out no longer
 * takes the lakes with it, and each layer can be retried on its own rather than the set
 * being all-or-nothing.
 *
 * Relations are asked for on the area tags only. A big lake with islands, or a forest
 * wrapping a village, is a multipolygon rather than a closed way, and leaving them out
 * would silently drop exactly the largest features in the box. Route relations on roads
 * carry no geometry of their own and are not wanted.
 */
const AREA_SELECTION: Record<AreaKind, (bbox: string) => string> = {
  water: (bbox) =>
    `(` +
    `way["natural"="water"](${bbox});` +
    `way["landuse"~"^(reservoir|basin)$"](${bbox});` +
    `way["waterway"~"^(riverbank|dock)$"](${bbox});` +
    `relation["natural"="water"](${bbox});` +
    `relation["landuse"~"^(reservoir|basin)$"](${bbox});` +
    `)`,
  wood: (bbox) =>
    `(` +
    `way["natural"="wood"](${bbox});` +
    `way["landuse"="forest"](${bbox});` +
    `relation["natural"="wood"](${bbox});` +
    `relation["landuse"="forest"](${bbox});` +
    `)`,
  built: (bbox) =>
    `(` +
    `way["landuse"~"^(residential|industrial|commercial|retail)$"](${bbox});` +
    `relation["landuse"~"^(residential|industrial|commercial|retail)$"](${bbox});` +
    `)`,
}

/** No trailing semicolon — `wrap` adds the one that terminates the statement. */
function areaSelection(b: Bounds, kind: AreaKind): string {
  return AREA_SELECTION[kind](`${b.south},${b.west},${b.north},${b.east}`)
}

/** `out geom` inlines coordinates, so one request needs no second pass for node ids. */
function wrap(sel: string, serverTimeout: number): string {
  return `[out:json][timeout:${serverTimeout}];${sel};out geom;`
}

/**
 * Ground area one query should cover, in km².
 *
 * Overpass cost tracks the area scanned as much as the features returned, and public
 * instances have their own timeout well before ours. Measured on a free mirror: a
 * 10,800 km² box over Dallas–Fort Worth is refused with a 504 after 106 seconds, while
 * boxes of a couple of thousand come back in tens of seconds. This is set below where
 * that wall was found, with room for somewhere denser than DFW.
 */
const TILE_TARGET_KM2 = 2200

/** Never split further than this. 16 sequential requests is already a lot to ask. */
const MAX_TILES_PER_AXIS = 4

/** Divide a box into an n×n grid, row-major from the north-west. */
function tileBounds(b: Bounds, n: number): Bounds[] {
  if (n <= 1) return [b]
  const dLat = (b.north - b.south) / n
  const dLon = (b.east - b.west) / n
  const out: Bounds[] = []
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      out.push({
        north: b.north - row * dLat,
        south: b.north - (row + 1) * dLat,
        west: b.west + col * dLon,
        east: b.west + (col + 1) * dLon,
      })
    }
  }
  return out
}

interface OverpassGeom {
  lat: number
  lon: number
}

interface OverpassElement {
  type: 'way' | 'relation' | string
  id?: number
  tags?: Record<string, string>
  geometry?: OverpassGeom[]
  members?: Array<{ type: string; role?: string; geometry?: OverpassGeom[] }>
}

/** What one tile's response contributes, before it is merged with the others. */
interface Harvest {
  roads: RoadWay[]
  areas: OsmArea[]
  metres: number
  /** `type/id` of everything taken, so a feature spanning a tile edge is taken once. */
  seen: Set<string>
}

/**
 * Fold one response into the running result.
 *
 * Overpass returns any feature *intersecting* the bounding box, complete — which is what
 * makes tiling work at all, because a road crossing a tile edge arrives whole rather
 * than clipped. It also means it arrives whole in both tiles, so identity has to be
 * tracked: without it a motorway through a 4×4 grid is drawn several times over, and
 * every duplicate is another full path to stroke.
 */
function harvest(elements: OverpassElement[], into: Harvest): void {
  for (const el of elements) {
    const tags = el.tags
    if (!tags) continue

    // `type/id` rather than id alone: way 42 and relation 42 are different things.
    const key = el.id !== undefined ? `${el.type}/${el.id}` : null
    if (key !== null) {
      if (into.seen.has(key)) continue
      into.seen.add(key)
    }

    const highway = tags.highway
    if (highway) {
      const cls = TAG_CLASS[highway]
      if (!cls || !el.geometry || el.geometry.length < 2) continue
      const pts = toFlat(el.geometry)
      into.metres += wayLength(pts)
      into.roads.push({ cls, pts })
      continue
    }

    const kind = areaKindOf(tags)
    if (!kind) continue

    if (el.type === 'way' && el.geometry && el.geometry.length >= 4) {
      into.areas.push({ kind, outer: [toFlat(el.geometry)], inner: [] })
    } else if (el.type === 'relation' && el.members) {
      // Members are stitched into rings rather than taken one at a time: a relation's
      // boundary is split across many ways and only becomes a polygon once they are
      // joined.
      //
      // Inner members are kept and travel with their outer ones, so an island stays an
      // island. A member with no role at all is treated as outer, which is what the
      // tagging convention means by omitting it.
      const outerParts: Float64Array[] = []
      const innerParts: Float64Array[] = []
      for (const m of el.members) {
        if (m.type !== 'way' || !m.geometry || m.geometry.length < 2) continue
        if (m.role === 'inner') innerParts.push(toFlat(m.geometry))
        else if (!m.role || m.role === 'outer') outerParts.push(toFlat(m.geometry))
      }
      const outer = assembleRings(outerParts)
      if (outer.length) into.areas.push({ kind, outer, inner: assembleRings(innerParts) })
    }
  }
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

/** Length of one way in km — for splitting a batched response back out by class. */
export function wayLengthKm(pts: Float64Array): number {
  return wayLength(pts) / 1000
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
 * Connectivity report, for running by hand from the console.
 *
 * Deliberately separate from the app's own path: it takes no state, changes nothing, and
 * answers the two questions that actually distinguish the failure modes — can the
 * browser open a connection to each instance, and will each one answer a real (tiny)
 * query. A host can pass the first and fail the second, which is what "reachable but out
 * of slots" looks like, and the remedies are different.
 *
 * The test query asks for the count of one node in a metre-wide box: valid, CORS-checked
 * on the same path a real request uses, and about as close to free as Overpass allows.
 */
export async function diagnose(): Promise<
  Array<{ host: string; reachable: string; query: string }>
> {
  const probeOne = async (endpoint: string) => {
    /* one instance, start to finish — see the note on serialisation below */
    const host = new URL(endpoint).host
    const origin = new URL(endpoint).origin

    let reachable: string
    const t0 = performance.now()
    try {
      await fetch(origin, { mode: 'no-cors', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      reachable = `yes (${ms(t0)})`
    } catch (err) {
      reachable = `NO — ${(err as Error).name} (${ms(t0)})`
    }

    let query: string
    const t1 = performance.now()
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent('[out:json];node(0,0,0.0001,0.0001);out count;')}`,
        signal: AbortSignal.timeout(15000),
      })
      query = `${res.status} (${ms(t1)})`
    } catch (err) {
      query = `NO — ${(err as Error).name} (${ms(t1)})`
    }

    return { host, reachable, query }
  }

  // One at a time, not in parallel.
  //
  // Overpass counts concurrent query slots per client IP — a couple at most — so firing
  // a test query at every instance at once means they queue behind each other and time
  // out, which reads as "every mirror is dead" when the truth is "we asked too much at
  // once". A diagnostic that creates the condition it is testing for is worse than none.
  //
  // For the same reason this is worth running only when the app is idle: a real fetch in
  // flight holds a slot, and anything asked alongside it queues.
  const rows = []
  for (const endpoint of ENDPOINTS) rows.push(await probeOne(endpoint))
  console.table(rows)
  let remembered: string | null = null
  try {
    remembered = localStorage.getItem(LAST_GOOD_KEY)
  } catch {
    /* ignore */
  }
  console.info(`[osm] last good endpoint: ${remembered ?? '(none recorded)'}`)
  return rows
}

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
  clientTimeoutMs: number,
  signal: AbortSignal | undefined,
  onProgress?: (note: string) => void,
): Promise<Response> {
  const send = () => {
    // The caller's abort still wins; this only adds a ceiling so an endpoint that never
    // answers cannot hold up the ones after it.
    const timeout = AbortSignal.timeout(clientTimeoutMs)
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  }

  const host = new URL(endpoint).host
  const t0 = performance.now()
  const first = await send()
  if (first.status !== 429 && first.status !== 504) {
    osmLog(`POST ${host} -> ${first.status} (${ms(t0)})`)
    return first
  }

  osmLog(`POST ${host} -> ${first.status} busy (${ms(t0)}), waiting 4s`)
  onProgress?.('OpenStreetMap is busy — waiting for a slot…')
  await new Promise((r) => setTimeout(r, 4000))
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  const t1 = performance.now()
  const second = await send()
  osmLog(`POST ${host} retry -> ${second.status} (${ms(t1)})`)
  return second
}


/**
 * Run one selection over one box, tiling only if the whole box will not come back.
 *
 * Tiling is a fallback rather than the default. Splitting up front made nine sequential
 * requests out of a box that one request would have answered, which is both slower and a
 * great deal ruder to a free service. So the whole box is attempted first, and the split
 * happens only when the server says it could not manage it — a busy or timed-out
 * response, which is exactly the signal that the query was too large.
 *
 * Every tile of a retry goes to the same instance, in sequence. Overpass counts
 * concurrent slots per client IP, so firing them at once would have them queue behind
 * each other and time out — the same mistake the diagnostic made.
 */
async function runSelection(
  endpoint: string,
  bounds: Bounds,
  select: (b: Bounds) => string,
  label: string,
  signal: AbortSignal | undefined,
  onProgress?: (note: string) => void,
): Promise<Harvest> {
  const attempt = async (tiles: Bounds[]): Promise<Harvest> => {
    const into: Harvest = { roads: [], areas: [], metres: 0, seen: new Set() }

    for (let t = 0; t < tiles.length; t++) {
      const tile = tiles[t]!
      const { server, client } = timeoutsFor(boundsAreaKm2(tile))
      const body = `data=${encodeURIComponent(wrap(select(tile), server))}`

      if (tiles.length > 1) onProgress?.(`Fetching ${label} ${t + 1}/${tiles.length}…`)
      const res = await postWithBackoff(endpoint, body, client, signal, onProgress)
      if (!res.ok) {
        if (res.status === 429 || res.status === 504) {
          throw new Error(`Overpass busy (HTTP ${res.status})`)
        }
        throw new Error(`Overpass HTTP ${res.status}`)
      }

      // Read as text and check the size before parsing. `out geom` inlines every
      // coordinate, so a dense box produces a very large body, and JSON.parse on
      // hundreds of megabytes takes the tab down rather than throwing something
      // catchable. Checking first turns an out-of-memory crash into a message.
      const tRead = performance.now()
      const text = await res.text()
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new NoRoadDataError(
          `OpenStreetMap returned ${(text.length / 1e6).toFixed(0)} MB of ${label}, which is ` +
            `more than can be drawn. Try a smaller box.`,
        )
      }

      const json = JSON.parse(text) as { elements?: OverpassElement[]; remark?: string }
      if (json.remark) osmLog(`server remark: ${json.remark}`)
      if (json.remark && !json.elements?.length) throw new Error(json.remark)

      const before = into.seen.size
      harvest(json.elements ?? [], into)
      osmLog(
        `${label} ${tiles.length > 1 ? `tile ${t + 1}/${tiles.length}` : 'whole box'}: ` +
          `${(json.elements?.length ?? 0).toLocaleString()} elements, ` +
          `${(into.seen.size - before).toLocaleString()} new, ` +
          `${(text.length / 1e6).toFixed(1)} MB in ${ms(tRead)}`,
      )
    }
    return into
  }

  try {
    return await attempt([bounds])
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    // Only size-related refusals are worth splitting for. A certificate error or an
    // unreachable host will fail identically nine more times.
    const message = (err as Error).message
    const worthSplitting = /busy|timed out|TimeoutError/i.test(message)
    if (!worthSplitting || err instanceof NoRoadDataError) throw err

    const n = Math.min(MAX_TILES_PER_AXIS, Math.max(2, Math.ceil(Math.sqrt(boundsAreaKm2(bounds) / TILE_TARGET_KM2))))
    const tiles = tileBounds(bounds, n)
    osmLog(`${label}: whole box refused (${message}) — retrying as ${tiles.length} tiles`)
    return attempt(tiles)
  }
}

/** Walk the reachable instances until one answers, then hand back what it gave. */
async function withEndpoints<T>(
  signal: AbortSignal | undefined,
  onProgress: ((note: string) => void) | undefined,
  run: (endpoint: string) => Promise<T>,
): Promise<T> {
  onProgress?.('Finding an OpenStreetMap server…')
  const endpoints = await reachableEndpoints(signal)
  osmLog(`will try ${endpoints.length}: ${endpoints.map((e) => new URL(e).host).join(' → ')}`)

  let lastError: Error | null = null
  let busy = 0

  for (const endpoint of endpoints) {
    try {
      const out = await run(endpoint)
      rememberEndpoint(endpoint)
      return out
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err
      osmLog(`FAILED on ${new URL(endpoint).host}: ${(err as Error).message}`)
      if (err instanceof NoRoadDataError) throw err
      if (/busy/.test((err as Error).message)) busy++
      lastError = err as Error
    }
  }

  // Every instance refused. Which kind of refusal decides what to tell the user, because
  // the two have completely different remedies.
  if (busy === endpoints.length) {
    throw new NoRoadDataError(
      'Every OpenStreetMap mirror is busy right now. Query slots are counted per IP, ' +
        'so another tab or app querying Overpass from this machine competes for the ' +
        'same allowance. Wait a minute and try again.',
    )
  }
  throw new NoRoadDataError(
    `Could not reach any OpenStreetMap mirror (${endpoints.length} tried). The last error ` +
      `was: ${lastError?.message ?? 'unknown'}. If this persists, the network is blocking ` +
      `outbound connections to these hosts rather than the request being rejected.`,
  )
}

export interface RoadResult {
  bounds: Bounds
  roads: RoadWay[]
  lengthKm: number
}

/**
 * The roads in the box, and nothing else.
 *
 * One clause over an indexed tag, which is why this is fast. Detail comes from the box
 * the *user* selected rather than the one being fetched: the fetch box is grown outward
 * to a cache grid, and letting that growth cross a class threshold would drop
 * residential streets because of an internal caching choice, at a size where they are
 * perfectly resolvable.
 */
export async function fetchRoads(
  bounds: Bounds,
  classes: RoadClass[],
  signal?: AbortSignal,
  onProgress?: (note: string) => void,
): Promise<RoadResult> {
  const boxKm2 = boundsAreaKm2(bounds)
  if (boxKm2 > MAX_ROAD_AREA_KM2) {
    throw new NoRoadDataError(
      `Area is ${Math.round(boxKm2).toLocaleString()} km² — map features are only fetched ` +
        `up to ${MAX_ROAD_AREA_KM2.toLocaleString()} km².`,
    )
  }
  if (classes.length === 0) return { bounds, roads: [], lengthKm: 0 }

  const label = classes.length === 1 ? ROAD_CLASSES[classes[0]!].label.toLowerCase() : 'roads'
  const started = performance.now()
  osmLog(`roads: ${Math.round(boxKm2).toLocaleString()} km²`, { classes: classes.join(', ') })

  const got = await withEndpoints(signal, onProgress, (endpoint) =>
    runSelection(endpoint, bounds, (b) => roadSelection(b, classes), label, signal, onProgress),
  )

  osmLog(`roads done in ${ms(started)}`, {
    ways: got.roads.length,
    km: Math.round(got.metres / 1000),
  })

  return { bounds, roads: got.roads, lengthKm: got.metres / 1000 }
}

/**
 * Water, woodland and land use.
 *
 * The expensive half, fetched on its own so it cannot hold the roads up. Six clauses,
 * two of them on relations, and `landuse=residential` — over a metro that one tag is
 * among the biggest things in OpenStreetMap.
 */
export async function fetchAreas(
  bounds: Bounds,
  kind: AreaKind,
  signal?: AbortSignal,
  onProgress?: (note: string) => void,
): Promise<OsmArea[]> {
  const started = performance.now()
  const label = AREA_LABEL[kind].toLowerCase()
  osmLog(`${kind}: ${Math.round(boundsAreaKm2(bounds)).toLocaleString()} km²`)

  const got = await withEndpoints(signal, onProgress, (endpoint) =>
    runSelection(endpoint, bounds, (b) => areaSelection(b, kind), label, signal, onProgress),
  )

  // Everything from this query is of the kind that was asked for, so the tag-sniffing
  // in `harvest` cannot mislabel it — but it also cannot tell `landuse=reservoir` from
  // `natural=water` and does not need to. Stamping the kind here keeps the two in step.
  const areas = got.areas.map((a) => ({ ...a, kind }))
  const holes = areas.reduce((n, a) => n + a.inner.length, 0)
  osmLog(`${kind} done in ${ms(started)}`, { areas: areas.length, holes })
  return areas
}
