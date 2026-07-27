import type { Bounds } from './geo'
import type { HeightField } from './opentopo'

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
const DB_VERSION = 1
const STORE = 'dem'

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
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch {
    /* ignore */
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
