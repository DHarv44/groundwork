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
 * Keyed on the box alone.
 *
 * What an entry contains follows from its bounds, so there is one answer per box rather
 * than one per combination of checkboxes — the Roads tab decides what is drawn out of
 * this, not what is in it.
 */
function roadKey(bounds: Bounds): string {
  const f = (n: number) => n.toFixed(5)
  return `v${OSM_QUERY_VERSION}|${f(bounds.south)}|${f(bounds.north)}|${f(bounds.west)}|${f(bounds.east)}`
}

export async function roadCacheGet(bounds: Bounds): Promise<OsmData | null> {
  try {
    const db = await openDb()
    const entry = await new Promise<CachedRoads | undefined>((resolve, reject) => {
      const tx = db.transaction(ROAD_STORE, 'readonly')
      const req = tx.objectStore(ROAD_STORE).get(roadKey(bounds))
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
