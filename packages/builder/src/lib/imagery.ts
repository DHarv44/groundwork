import type { Bounds } from './geo'
import { latToTileY, lonToTileX } from './geo'
import { builderConfig } from '../config'
import { tileCacheGet, tileCachePut } from './demcache'

const TILE = 256
const MAX_TILES = 144
const MAX_PIXELS = 4096

/** Esri serves down to z19; past it there is nothing sharper to fetch. */
export const MAX_IMAGERY_ZOOM = 19

function tileUrl(z: number, x: number, y: number): string {
  // Esri World Imagery is served z/y/x — the swap happens here rather than in the
  // config, so a host overriding the endpoint is not handed an argument order that
  // disagrees with every other tile service it deals with.
  return builderConfig().endpoints.imagery(z, y, x)
}

/**
 * One imagery tile as bytes: cache, else network.
 *
 * Fetched rather than loaded through an Image element, for three things the element
 * cannot do: abort (the camera moves on, the request should too), caching (the bytes
 * go into the same IndexedDB store the vector tiles use, under an `i/` prefix), and
 * an error that says what happened. Zero-byte cache entries record a tile the server
 * does not have, so the nothing is remembered instead of refetched.
 */
async function fetchTileBytes(
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer | null> {
  const key = `i/${z}/${x}/${y}`
  try {
    const cached = await tileCacheGet(key)
    if (cached) return cached.byteLength > 0 ? cached : null
    const res = await fetch(tileUrl(z, x, y), { signal })
    if (!res.ok) {
      if (res.status === 404) void tileCachePut(key, new ArrayBuffer(0))
      return null
    }
    const buf = await res.arrayBuffer()
    void tileCachePut(key, buf)
    return buf
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    return null
  }
}

/** A tile decoded for drawing. Failures resolve null — one missing tile is a blemish. */
async function loadTile(
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<ImageBitmap | null> {
  const buf = await fetchTileBytes(z, x, y, signal)
  if (!buf) return null
  try {
    return await createImageBitmap(new Blob([buf]))
  } catch {
    return null
  }
}

/** Pick the highest zoom whose tile mosaic stays within our tile and pixel budgets. */
function chooseZoom(b: Bounds, maxZoom: number): number {
  for (let z = Math.min(maxZoom, MAX_IMAGERY_ZOOM); z >= 1; z--) {
    const nx = Math.floor(lonToTileX(b.east, z)) - Math.floor(lonToTileX(b.west, z)) + 1
    const ny = Math.floor(latToTileY(b.south, z)) - Math.floor(latToTileY(b.north, z)) + 1
    if (nx * ny <= MAX_TILES && nx * TILE <= MAX_PIXELS && ny * TILE <= MAX_PIXELS) return z
  }
  return 1
}

export interface ImageryResult {
  canvas: HTMLCanvasElement
  zoom: number
  tilesLoaded: number
  tilesTotal: number
}

/** Tile count for one zoom level over a box. */
function tilesAt(b: Bounds, z: number): number {
  const nx = Math.floor(lonToTileX(b.east, z)) - Math.floor(lonToTileX(b.west, z)) + 1
  const ny = Math.floor(latToTileY(b.south, z)) - Math.floor(latToTileY(b.north, z)) + 1
  return nx * ny
}

/** The zoom the base drape would use for this box — where a prefetch starts counting. */
export function baseImageryZoom(b: Bounds): number {
  return chooseZoom(b, MAX_IMAGERY_ZOOM)
}

/**
 * What prefetching a box down to `toZoom` would cost, before anyone commits to it.
 *
 * The honest bill is the point: tile pyramids quadruple per level, and the difference
 * between "two minutes" and "an afternoon" is invisible until it is computed. Sizes
 * use a measured ~25 KB average per imagery tile.
 */
export function estimateImageryPrefetch(
  b: Bounds,
  toZoom: number,
): { tiles: number; megabytes: number } {
  let tiles = 0
  for (let z = baseImageryZoom(b) + 1; z <= Math.min(toZoom, MAX_IMAGERY_ZOOM); z++) {
    tiles += tilesAt(b, z)
  }
  return { tiles, megabytes: (tiles * 25) / 1024 }
}

/**
 * Warm the tile cache for the whole box down to `toZoom`.
 *
 * Fetches bytes only — no decode, no mosaic — into the same IndexedDB store every
 * live fetch reads, so afterwards ring and base loads anywhere in the box run the
 * warm path. Already-cached tiles are skipped, which makes cancelling free: whatever
 * landed stays landed, and running the same prefetch again resumes where it stopped.
 *
 * Deliberately gentler than the live path (six concurrent, coarse zooms first): this
 * is a bulk pull from someone else's tile service, initiated by a person who was
 * shown the bill — the least we owe back is not arriving like a scraper.
 */
export async function prefetchImagery(
  b: Bounds,
  toZoom: number,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ fetched: number; total: number }> {
  const wanted: Array<{ z: number; x: number; y: number }> = []
  for (let z = baseImageryZoom(b) + 1; z <= Math.min(toZoom, MAX_IMAGERY_ZOOM); z++) {
    const x0 = Math.floor(lonToTileX(b.west, z))
    const x1 = Math.floor(lonToTileX(b.east, z))
    const y0 = Math.floor(latToTileY(b.north, z))
    const y1 = Math.floor(latToTileY(b.south, z))
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) wanted.push({ z, x, y })
  }

  let done = 0
  let fetched = 0
  let next = 0
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < wanted.length) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
        const t = wanted[next++]!
        const buf = await fetchTileBytes(t.z, t.x, t.y, signal)
        if (buf) fetched++
        onProgress?.(++done, wanted.length)
      }
    }),
  )
  return { fetched, total: wanted.length }
}

/**
 * Build a satellite texture for `bounds`, reprojected from Web Mercator into the
 * plate-carrée (linear lat/lon) grid the DEM uses, so imagery lines up with relief.
 */
export async function fetchImagery(
  bounds: Bounds,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
  /** Cap the zoom — the close-up patch bounds how far past the base it may reach. */
  maxZoom: number = MAX_IMAGERY_ZOOM,
): Promise<ImageryResult> {
  const z = chooseZoom(bounds, maxZoom)
  const tx0 = Math.floor(lonToTileX(bounds.west, z))
  const tx1 = Math.floor(lonToTileX(bounds.east, z))
  const ty0 = Math.floor(latToTileY(bounds.north, z))
  const ty1 = Math.floor(latToTileY(bounds.south, z))
  const nx = tx1 - tx0 + 1
  const ny = ty1 - ty0 + 1
  const total = nx * ny

  // 1. Stitch the raw Mercator mosaic.
  const mosaic = document.createElement('canvas')
  mosaic.width = nx * TILE
  mosaic.height = ny * TILE
  const mctx = mosaic.getContext('2d')!
  mctx.fillStyle = '#3c4a3a'
  mctx.fillRect(0, 0, mosaic.width, mosaic.height)

  let done = 0
  let loaded = 0
  const jobs: Promise<void>[] = []
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(
        loadTile(z, tx, ty, signal).then((img) => {
          if (signal?.aborted) return
          if (img) {
            mctx.drawImage(img, (tx - tx0) * TILE, (ty - ty0) * TILE, TILE, TILE)
            img.close()
            loaded++
          }
          onProgress?.(++done, total)
        }),
      )
    }
  }
  await Promise.all(jobs)
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

  // 2. Resample rows into linear-latitude space to match the DEM grid.
  const out = document.createElement('canvas')
  out.width = mosaic.width
  out.height = Math.min(MAX_PIXELS, Math.round(mosaic.height))
  const octx = out.getContext('2d')!
  octx.imageSmoothingQuality = 'high'

  // Horizontal crop: the mosaic starts at tile tx0, our box starts partway into it.
  const sx = (lonToTileX(bounds.west, z) - tx0) * TILE
  const sw = (lonToTileX(bounds.east, z) - lonToTileX(bounds.west, z)) * TILE

  for (let row = 0; row < out.height; row++) {
    const latTop = bounds.north - (row / out.height) * (bounds.north - bounds.south)
    const latBot = bounds.north - ((row + 1) / out.height) * (bounds.north - bounds.south)
    const syTop = (latToTileY(latTop, z) - ty0) * TILE
    const syBot = (latToTileY(latBot, z) - ty0) * TILE
    octx.drawImage(mosaic, sx, syTop, sw, Math.max(0.5, syBot - syTop), 0, row, out.width, 1)
  }
  return { canvas: out, zoom: z, tilesLoaded: loaded, tilesTotal: total }
}
