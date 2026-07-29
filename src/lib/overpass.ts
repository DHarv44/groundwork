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
  // Secondary roads are still worth having across a county. Across a small country they
  // are neither resolvable nor answerable: a 30,000 km² box asking for every tertiary
  // road in it is a query no public instance will finish, and the result would be a
  // grey wash at one texel per two hundred metres even if it did.
  if (areaKm2 <= 12000) return ['secondary', 'primary', 'motorway']
  return ['primary', 'motorway']
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
async function reachableEndpoints(signal?: AbortSignal): Promise<string[]> {
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

function buildQuery(b: Bounds, classes: RoadClass[], serverTimeout: number): string {
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
    `[out:json][timeout:${serverTimeout}];(` +
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
  const { server, client } = timeoutsFor(boxKm2)
  const body = `data=${encodeURIComponent(buildQuery(bounds, requested, server))}`

  const started = performance.now()
  osmLog(
    `fetch ${Math.round(boxKm2).toLocaleString()} km²` +
      (detailFor ? ` (detail for ${Math.round(boundsAreaKm2(detailFor)).toLocaleString()} km²)` : ''),
    {
      box: `S${bounds.south.toFixed(4)} N${bounds.north.toFixed(4)} W${bounds.west.toFixed(4)} E${bounds.east.toFixed(4)}`,
      roadClasses: requested.join(', '),
      classFilterApplied: filtered,
      serverTimeout: `${server}s`,
      clientTimeout: `${Math.round(client / 1000)}s`,
    },
  )

  onProgress?.('Finding an OpenStreetMap server…')
  const endpoints = await reachableEndpoints(signal)
  osmLog(`will try ${endpoints.length}: ${endpoints.map((e) => new URL(e).host).join(' → ')}`)
  let lastError: Error | null = null
  let busy = 0

  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i]!
    try {
      onProgress?.(i === 0 ? 'Querying OpenStreetMap…' : 'Trying another mirror…')
      const res = await postWithBackoff(endpoint, body, client, signal, onProgress)
      if (!res.ok) {
        // 429 and 504 mean the instance is busy rather than broken, so move to the next
        // one instead of giving up — but remember that it happened, because if *every*
        // instance says busy the answer to give the user is quite different from a host
        // being unreachable.
        if (res.status === 429 || res.status === 504) {
          busy++
          throw new Error(`Overpass busy (HTTP ${res.status})`)
        }
        throw new Error(`Overpass HTTP ${res.status}`)
      }

      // Read as text and check the size before parsing.
      //
      // `out geom` inlines every coordinate, so a dense box produces a very large body,
      // and JSON.parse on hundreds of megabytes takes the tab down rather than throwing
      // something catchable. Checking first turns an out-of-memory crash into a message.
      const tRead = performance.now()
      const text = await res.text()
      osmLog(`body ${(text.length / 1e6).toFixed(1)} MB read in ${ms(tRead)}`)
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new NoRoadDataError(
          `OpenStreetMap returned ${(text.length / 1e6).toFixed(0)} MB for this area, which ` +
            `is more than can be drawn. Try a smaller box.`,
        )
      }

      const tParse = performance.now()
      const json = JSON.parse(text) as { elements?: OverpassElement[]; remark?: string }
      osmLog(`parsed ${(json.elements?.length ?? 0).toLocaleString()} elements in ${ms(tParse)}`)
      // Overpass reports its own failures inside a 200 response. A remark alongside real
      // elements is usually a truncation warning, which is worth seeing either way.
      if (json.remark) osmLog(`server remark: ${json.remark}`)
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

      rememberEndpoint(endpoint)
      const holes = areas.reduce((n, a) => n + a.inner.length, 0)
      osmLog(
        `done in ${ms(started)} via ${new URL(endpoint).host}`,
        {
          roads: roads.length,
          roadKm: Math.round(metres / 1000),
          areas: areas.length,
          holes,
        },
      )
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
      osmLog(`FAILED on ${new URL(endpoint).host}: ${(err as Error).message}`)
      // A body too large for this box will be too large from every mirror, so there is
      // nothing to gain by asking three more servers the same impossible question.
      if (err instanceof NoRoadDataError) throw err
      lastError = err as Error
    }
  }
  osmLog(`all ${endpoints.length} instances failed after ${ms(started)} (busy: ${busy})`)

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
