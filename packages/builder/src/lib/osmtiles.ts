import { latToTileY, lonToTileX, type Bounds } from './geo'
import { builderConfig } from '../config'
import { tileCacheGet, tileCachePut } from './demcache'
import {
  NoRoadDataError,
  ROAD_ORDER,
  type OsmArea,
  type OsmData,
  type OsmPlace,
  type RoadClass,
  type RoadWay,
} from './overpass'
import OsmTileWorker from '../workers/osmtiles.worker?worker'

/**
 * OpenStreetMap intake, from vector tiles.
 *
 * The previous intake asked Overpass — a shared query engine that computes each
 * answer live, priced in per-IP queue slots, with latency proportional to feature
 * density. This one fetches pre-cut OpenMapTiles-schema tiles off a CDN: static
 * files, flat latency, per-tile caching, and generalisation done upstream by the
 * tile pyramid instead of by our own class-tier guesswork. The output is the same
 * `OsmData` the Overpass path produced, so everything downstream — masks, shader,
 * pack export — is unaware the source changed.
 *
 * The zoom pick is the whole tiering story now: small boxes get z14 (every street,
 * track and footpath-adjacent class the schema carries), huge boxes get a zoom whose
 * tiles only contain the roads a cartographer kept at that scale. The "different box
 * size shows different roads" behaviour is still real, but it is now the map
 * pyramid's judgement rather than a hand-rolled area cutoff.
 */

/** Fetch no more than this many tiles per box — the zoom drops until it fits. */
const MAX_TILES = 64

/** Parallel tile fetches. CDNs are happy with this; it is not a queue we can jam. */
const CONCURRENCY = 8

/**
 * Bump when the tile→OsmData mapping changes meaning (new kinds, changed class
 * folding), so cached raw tiles are not reinterpreted by code they predate. Raw
 * protobuf ages well; what changes is what we read out of it — but the *decoded*
 * result is cached one level up (see `OSM_QUERY_VERSION`), so this version only
 * guards the bytes themselves against a schema change at the source.
 */
const TILE_CACHE_VERSION = 1

/**
 * Zoom at which each class first appears in the OpenMapTiles pyramid, so the UI can
 * keep reporting "not requested at this size" honestly. Approximate by design — the
 * schema's per-class appearance zooms — and only feeds the readout, never the draw.
 */
const CLASS_APPEARS_AT: Record<RoadClass, number> = {
  motorway: 5,
  primary: 8,
  secondary: 9,
  minor: 12,
  track: 13,
}

interface TileSource {
  template: string
  maxzoom: number
}

/** TileJSON resolved once per session per endpoint. */
let source: { url: string; value: TileSource } | null = null

async function resolveSource(signal?: AbortSignal): Promise<TileSource> {
  const url = builderConfig().endpoints.osmTiles
  if (source?.url === url) return source.value

  let json: { tiles?: string[]; maxzoom?: number }
  try {
    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    json = (await res.json()) as typeof json
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    throw new NoRoadDataError(
      `The map tile service is unreachable (${(err as Error).message}). ` +
        'Roads and mapped areas need it; everything else works without.',
    )
  }

  const template = json.tiles?.[0]
  if (!template) {
    throw new NoRoadDataError('The map tile service answered without a tile URL template.')
  }
  const value = { template, maxzoom: json.maxzoom ?? 14 }
  source = { url, value }
  return value
}

/**
 * Finest zoom whose tile count fits the budget.
 *
 * Not a resolution heuristic: the budget is about being a polite, fast client (64
 * parallel-fetchable files), and the pyramid itself decides what detail survives at
 * the zoom that fits. z3 floors it — below that a "tile" is a continent and the box
 * has left the realm of roads mattering.
 */
function pickZoom(bounds: Bounds, maxzoom: number): number {
  for (let z = Math.min(14, maxzoom); z > 3; z--) {
    const x0 = Math.floor(lonToTileX(bounds.west, z))
    const x1 = Math.floor(lonToTileX(bounds.east, z))
    const y0 = Math.floor(latToTileY(bounds.north, z))
    const y1 = Math.floor(latToTileY(bounds.south, z))
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES) return z
  }
  return 3
}

interface FetchedTile {
  x: number
  y: number
  z: number
  buf: ArrayBuffer
}

/**
 * One tile: cache, else network.
 *
 * Empty answers (204, 404 — the sea, the poles) are cached as zero bytes so an ocean
 * box never refetches its nothing. A server error gets one retry and then fails the
 * whole load: a silently missing tile would render as a hole in the data, which reads
 * as "this corner of the world has no roads" — a lie with no visible seam.
 */
async function fetchTile(
  template: string,
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer | null> {
  const key = `t${TILE_CACHE_VERSION}/${z}/${x}/${y}`
  const cached = await tileCacheGet(key)
  if (cached) return cached.byteLength > 0 ? cached : null

  const url = template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal })
    if (res.status === 204 || res.status === 404) {
      void tileCachePut(key, new ArrayBuffer(0))
      return null
    }
    if (res.ok) {
      const buf = await res.arrayBuffer()
      void tileCachePut(key, buf)
      return buf.byteLength > 0 ? buf : null
    }
    if (attempt >= 1) throw new Error(`tile ${z}/${x}/${y}: HTTP ${res.status}`)
  }
}

// ---- the decode worker -----------------------------------------------------

interface DecodeResult {
  token: number
  roads: RoadWay[]
  areas: OsmArea[]
  places: OsmPlace[]
  metres: number
}

let worker: Worker | null = null
let workerToken = 0
const pending = new Map<number, (r: DecodeResult) => void>()

function decodeInWorker(tiles: FetchedTile[]): Promise<DecodeResult> {
  if (!worker) {
    worker = new OsmTileWorker()
    worker.onmessage = (e: MessageEvent<DecodeResult>) => {
      const resolve = pending.get(e.data.token)
      pending.delete(e.data.token)
      resolve?.(e.data)
    }
  }
  const token = ++workerToken
  return new Promise((resolve) => {
    pending.set(token, resolve)
    worker!.postMessage(
      { token, tiles },
      tiles.map((t) => t.buf),
    )
  })
}

// ---- the public entry ------------------------------------------------------

export async function fetchOsmTiles(
  bounds: Bounds,
  signal?: AbortSignal,
  onProgress?: (note: string) => void,
): Promise<OsmData> {
  const { template, maxzoom } = await resolveSource(signal)
  const z = pickZoom(bounds, maxzoom)

  const x0 = Math.floor(lonToTileX(bounds.west, z))
  const x1 = Math.floor(lonToTileX(bounds.east, z))
  const y0 = Math.floor(latToTileY(bounds.north, z))
  const y1 = Math.floor(latToTileY(bounds.south, z))

  const wanted: Array<{ x: number; y: number }> = []
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) wanted.push({ x, y })

  onProgress?.(`Map tiles 0/${wanted.length}…`)

  const tiles: FetchedTile[] = []
  let done = 0
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, async () => {
      while (next < wanted.length) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
        const { x, y } = wanted[next++]!
        const buf = await fetchTile(template, z, x, y, signal)
        if (buf) tiles.push({ x, y, z, buf })
        onProgress?.(`Map tiles ${++done}/${wanted.length}…`)
      }
    }),
  )

  onProgress?.('Reading map data…')
  const decoded = await decodeInWorker(tiles)

  const requested = ROAD_ORDER.filter((cls) => CLASS_APPEARS_AT[cls] <= z)

  return {
    bounds,
    roads: decoded.roads,
    areas: decoded.areas,
    places: decoded.places,
    lengthKm: decoded.metres / 1000,
    requested,
    filtered: requested.length < ROAD_ORDER.length,
    fetchedAt: Date.now(),
  }
}
