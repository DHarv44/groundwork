import type { Bounds } from './geo'
import type { HeightField } from './opentopo'
import type { OsmData } from './overpass'

/**
 * Persistent cache of decoded DEMs.
 *
 * OpenTopography's free tier allows 50 requests per 24 hours, which is easy to burn
 * through while tuning a render. Every area you have already fetched is kept here, so
 * rebuilding, reloading, or coming back tomorrow costs nothing. Decoded height fields
 * are stored rather than the raw GeoTIFF, which also skips re-decoding.
 */

// Kept at the old name through the rename to Groundwork. Changing it would orphan every
// cached area rather than migrate it, and those cost API calls to fetch — a cosmetic
// tidy is not worth spending someone's daily allowance twice. The same goes for the
// localStorage keys elsewhere: they are internal, and nothing reads them but us.
const DB_NAME = 'terrain-builder'
// v2 added the road store. Bumping the version runs the upgrade, which only *creates*
// the missing store — the cached DEMs are left untouched, which matters because they
// cost API allowance to refetch and this app is opened with a nearly-full cache.
const DB_VERSION = 2
const STORE = 'dem'
const ROAD_STORE = 'roads'

interface CachedEntry {
  key: string
  demtype: string
  bounds: Bounds
  width: number
  height: number
  data: Float32Array
  min: number
  max: number
  voids: number
  storedAt: number
}

export function cacheKey(bounds: Bounds, demtype: string): string {
  const f = (n: number) => n.toFixed(5)
  return `${demtype}|${f(bounds.south)}|${f(bounds.north)}|${f(bounds.west)}|${f(bounds.east)}`
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'key' })
      }
      if (!req.result.objectStoreNames.contains(ROAD_STORE)) {
        req.result.createObjectStore(ROAD_STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function cacheGet(
  bounds: Bounds,
  demtype: string,
): Promise<HeightField | null> {
  try {
    const db = await openDb()
    const entry = await new Promise<CachedEntry | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(cacheKey(bounds, demtype))
      req.onsuccess = () => resolve(req.result as CachedEntry | undefined)
      req.onerror = () => reject(req.error)
    })
    db.close()
    if (!entry) return null
    return {
      width: entry.width,
      height: entry.height,
      data: entry.data,
      bounds: entry.bounds,
      min: entry.min,
      max: entry.max,
      demtype: entry.demtype,
      voids: entry.voids,
    }
  } catch {
    // A missing or blocked IndexedDB must never break a fetch.
    return null
  }
}

export async function cachePut(hf: HeightField, requested: Bounds): Promise<void> {
  try {
    const db = await openDb()
    const entry: CachedEntry = {
      key: cacheKey(requested, hf.demtype),
      demtype: hf.demtype,
      bounds: hf.bounds,
      width: hf.width,
      height: hf.height,
      data: hf.data,
      min: hf.min,
      max: hf.max,
      voids: hf.voids,
      storedAt: Date.now(),
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(entry)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch {
    /* cache writes are best-effort */
  }
}

export async function cacheStats(): Promise<{ count: number; megabytes: number }> {
  try {
    const db = await openDb()
    const entries = await new Promise<CachedEntry[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).getAll()
      req.onsuccess = () => resolve(req.result as CachedEntry[])
      req.onerror = () => reject(req.error)
    })
    db.close()
    const bytes = entries.reduce((sum, e) => sum + e.width * e.height * 4, 0)
    return { count: entries.length, megabytes: bytes / 1048576 }
  } catch {
    return { count: 0, megabytes: 0 }
  }
}

export async function cacheClear(): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, ROAD_STORE], 'readwrite')
      tx.objectStore(STORE).clear()
      tx.objectStore(ROAD_STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch {
    /* ignore */
  }
}

// ---- road cache -----------------------------------------------------------

/**
 * Roads are cached for the same reason DEMs are, with a different pressure behind it:
 * Overpass is free, unauthenticated, shared infrastructure, and the polite way to use
 * it is to ask once. Keyed on the box alone — unlike elevation there is no choice of
 * source to disambiguate.
 *
 * `Float64Array` survives the structured clone, so the ways go in and come out as they
 * are with no serialisation step.
 */
interface CachedRoads {
  key: string
  network: OsmData
}

/**
 * Versioned, because the query has changed shape once already.
 *
 * v1 asked for roads alone. An entry written then would come back with no `areas` and
 * be indistinguishable from a box that genuinely has no lakes or woodland — so the
 * version is part of the key, and old entries are simply never matched rather than
 * being migrated or trusted.
 *
 * v2 added areas but stored each relation member as its own ring, which is not what a
 * multipolygon means — the geometry in those entries is wrong rather than merely
 * incomplete, so they have to be re-fetched rather than reinterpreted.
 *
 * v3 stitched them into rings correctly but still dropped inner ones, so an island was
 * flooded and a clearing filled in. Those entries hold no hole information at all, which
 * cannot be recovered without asking again.
 */
const OSM_QUERY_VERSION = 4

/**
 * Grid steps the fetch box snaps to, in degrees.
 *
 * Keying on the exact box means a cache that almost never hits. Nudge the selection by
 * a hair and every coordinate changes, so a box overlapping the last one by 99% counts
 * as somewhere new and refetches the lot. Snapping the *fetch* outward to a grid makes
 * small adjustments land on the same key, which is the common case while framing a shot.
 *
 * The step scales with the box because a fixed one is wrong at both ends: 0.05° is a
 * rounding error on a 100 km box and nearly doubles a 7 km one.
 */
const SNAP_STEPS = [0.005, 0.01, 0.02, 0.05, 0.1, 0.25]

function snapStepFor(bounds: Bounds): number {
  const span = Math.max(bounds.north - bounds.south, bounds.east - bounds.west)
  // A twelfth of the box, so snapping costs at most ~8% extra ground on a side.
  const target = span / 12
  for (let i = SNAP_STEPS.length - 1; i >= 0; i--) {
    if (SNAP_STEPS[i]! <= target) return SNAP_STEPS[i]!
  }
  return SNAP_STEPS[0]!
}

/** The box actually fetched: the requested one grown out to the nearest grid lines. */
export function snapBounds(bounds: Bounds): Bounds {
  const s = snapStepFor(bounds)
  return {
    south: Math.floor(bounds.south / s) * s,
    north: Math.ceil(bounds.north / s) * s,
    west: Math.floor(bounds.west / s) * s,
    east: Math.ceil(bounds.east / s) * s,
  }
}

function roadKey(bounds: Bounds): string {
  const f = (n: number) => n.toFixed(5)
  return `v${OSM_QUERY_VERSION}|${f(bounds.south)}|${f(bounds.north)}|${f(bounds.west)}|${f(bounds.east)}`
}

const KEY_PREFIX = `v${OSM_QUERY_VERSION}|`

/** Recover the bounds a key was written for, or null if it is from an older schema. */
function boundsFromKey(key: string): Bounds | null {
  if (!key.startsWith(KEY_PREFIX)) return null
  const p = key.slice(KEY_PREFIX.length).split('|').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return null
  return { south: p[0]!, north: p[1]!, west: p[2]!, east: p[3]! }
}

function contains(outer: Bounds, inner: Bounds): boolean {
  // A hair of tolerance, because these round-trip through five decimal places.
  const e = 1e-6
  return (
    outer.south <= inner.south + e &&
    outer.north >= inner.north - e &&
    outer.west <= inner.west + e &&
    outer.east >= inner.east - e
  )
}

function boundsArea(b: Bounds): number {
  return (b.north - b.south) * (b.east - b.west)
}

/**
 * Any cached fetch that covers this box.
 *
 * Not an exact-key lookup. Keys carry the bounds they were written for, so the smallest
 * cached box *containing* the wanted one is a valid answer — zooming in, nudging an edge
 * inward, or re-selecting inside somewhere already fetched all become hits instead of
 * full refetches. The extra features outside the box cost nothing: the rasteriser
 * projects against the box being rendered, so they simply fall off the canvas.
 *
 * Keys are read first and only the chosen entry is loaded. Each holds every way in its
 * box, so pulling them all in to compare bounds would mean deserialising tens of
 * megabytes to answer a question the key already contains.
 */
export async function roadCacheGet(bounds: Bounds): Promise<OsmData | null> {
  try {
    const db = await openDb()

    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const tx = db.transaction(ROAD_STORE, 'readonly')
      const req = tx.objectStore(ROAD_STORE).getAllKeys()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })

    let best: { key: string; area: number } | null = null
    for (const raw of keys) {
      const key = String(raw)
      const b = boundsFromKey(key)
      if (!b || !contains(b, bounds)) continue
      const area = boundsArea(b)
      // Smallest containing box, so a tight fetch is preferred over a sprawling one and
      // the mask keeps as much of its resolution as possible on the ground being drawn.
      if (!best || area < best.area) best = { key, area }
    }
    if (!best) {
      db.close()
      return null
    }

    const entry = await new Promise<CachedRoads | undefined>((resolve, reject) => {
      const tx = db.transaction(ROAD_STORE, 'readonly')
      const req = tx.objectStore(ROAD_STORE).get(best!.key)
      req.onsuccess = () => resolve(req.result as CachedRoads | undefined)
      req.onerror = () => reject(req.error)
    })
    db.close()
    return entry?.network ?? null
  } catch {
    return null
  }
}

export async function roadCachePut(network: OsmData): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ROAD_STORE, 'readwrite')
      tx.objectStore(ROAD_STORE).put({ key: roadKey(network.bounds), network })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch {
    /* cache writes are best-effort */
  }
}

/**
 * Drop entries written by an older query schema.
 *
 * Version bumps orphan rather than evict: the old keys stop matching but the data stays,
 * and each entry holds every way in its box. Four schema fixes in one afternoon left
 * seven entries for three places, none of them reachable. Nothing else ever removes
 * them, so the sweep runs once at start-up.
 */
export async function roadCacheSweep(): Promise<number> {
  try {
    const db = await openDb()
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const tx = db.transaction(ROAD_STORE, 'readonly')
      const req = tx.objectStore(ROAD_STORE).getAllKeys()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })

    const stale = keys.filter((k) => !String(k).startsWith(KEY_PREFIX))
    if (stale.length === 0) {
      db.close()
      return 0
    }

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ROAD_STORE, 'readwrite')
      const store = tx.objectStore(ROAD_STORE)
      for (const k of stale) store.delete(k)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
    return stale.length
  } catch {
    return 0
  }
}

// ---- local request budget -------------------------------------------------

const QUOTA_KEY = 'terrain-builder.requests'
export const DAILY_QUOTA = 50

/** Timestamps of requests that actually hit the network, within the last 24 h. */
function recentRequests(): number[] {
  try {
    const raw = localStorage.getItem(QUOTA_KEY)
    const list: number[] = raw ? JSON.parse(raw) : []
    const cutoff = Date.now() - 24 * 3600 * 1000
    return list.filter((t) => t > cutoff)
  } catch {
    return []
  }
}

export function noteRequest(): void {
  try {
    const list = recentRequests()
    list.push(Date.now())
    localStorage.setItem(QUOTA_KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

/** Best-effort local view of the 24 h allowance — the server is the real authority. */
export function quotaUsed(): number {
  return recentRequests().length
}

/** When the oldest request in the window ages out, or null if nothing is pending. */
export function quotaResetsAt(): Date | null {
  const list = recentRequests()
  if (list.length === 0) return null
  return new Date(Math.min(...list) + 24 * 3600 * 1000)
}
