import { storageKey } from '../config'
import type { Bounds } from './geo'

/**
 * Remembers what you were looking at across a reload — the area, the source, the
 * display settings and the camera. Rebuilding costs nothing because the DEM itself is
 * already cached in IndexedDB, so restoring a session never spends an API call.
 */

const KEY = () => storageKey('session')

export interface SessionCamera {
  pos: [number, number, number]
  quat: [number, number, number, number]
  target: [number, number, number]
}

export interface SessionState {
  bounds?: Bounds | null
  demType?: string
  /** Only the display-side settings; anything derived from the DEM is recomputed. */
  settings?: Record<string, unknown>
  /** Per-Köppen-class surface tuning, keyed by code. */
  biomeOverrides?: Record<string, Record<string, number>>
  camera?: SessionCamera
}

export function loadSession(): SessionState {
  try {
    const raw = localStorage.getItem(KEY())
    return raw ? (JSON.parse(raw) as SessionState) : {}
  } catch {
    return {}
  }
}

/** Merge-on-write, so each part of the app can persist its own slice independently. */
export function saveSession(patch: SessionState): void {
  try {
    localStorage.setItem(KEY(), JSON.stringify({ ...loadSession(), ...patch }))
  } catch {
    /* storage disabled — not worth failing over */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY())
  } catch {
    /* ignore */
  }
}
