import type { Bounds } from './geo'
import { latToTileY, lonToTileX } from './geo'
import { builderConfig } from '../config'
import { tileCacheGet, tileCachePut } from './demcache'

const TILE = 256
const MAX_TILES = 144
const MAX_PIXELS = 4096

// Clipmap rings run on a smaller budget than the one-shot base drape. A ring
// refreshes continuously while the camera moves, and every refresh ends in a
// full-canvas GPU upload — 2048² is ~17 MB a flush, 4096² would be ~67 MB and a
// dropped frame every time. The inner ring is small enough on the ground that
// 2048 pixels still lands at Esri's sharpest zoom where it matters, up close.
const RING_MAX_TILES = 64
const RING_MAX_PIXELS = 2048

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
 * go into the same IndexedDB store the vector tiles use, under an `i2/` prefix), and
 * an error that says what happened.
 *
 * Absence is NEVER cached. An earlier version wrote a zero-byte marker on 404 so a
 * genuinely missing tile would not be refetched — but a transient 404 (a rate-limit
 * hiccup, a CDN blip) then poisoned that tile's key permanently: every later ring
 * covering it silently skipped the tile forever, leaving a soft base-resolution band
 * in an otherwise sharp view at every revisit. The key prefix is bumped from `i/` to
 * `i2/` so entries poisoned under the old rule are orphaned rather than trusted.
 * Transient network failures get one retry before giving up on this pass.
 */
async function fetchTileBytes(
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer | null> {
  const key = `i2/${z}/${x}/${y}`
  try {
    const cached = await tileCacheGet(key)
    if (cached && cached.byteLength > 0) return cached
  } catch {
    /* a cache read failure is not a fetch failure */
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(tileUrl(z, x, y), { signal })
      if (res.ok) {
        const buf = await res.arrayBuffer()
        if (buf.byteLength > 0) {
          void tileCachePut(key, buf)
          return buf
        }
        return null
      }
      // Server errors may pass on retry; a 4xx will not — don't hammer it.
      if (res.status < 500) return null
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err
    }
  }
  return null
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

/** Pick the highest zoom whose tile mosaic stays within the given budgets. */
function chooseZoom(
  b: Bounds,
  maxZoom: number,
  maxTiles: number = MAX_TILES,
  maxPixels: number = MAX_PIXELS,
): number {
  for (let z = Math.min(maxZoom, MAX_IMAGERY_ZOOM); z >= 1; z--) {
    const nx = Math.floor(lonToTileX(b.east, z)) - Math.floor(lonToTileX(b.west, z)) + 1
    const ny = Math.floor(latToTileY(b.south, z)) - Math.floor(latToTileY(b.north, z)) + 1
    if (nx * ny <= maxTiles && nx * TILE <= maxPixels && ny * TILE <= maxPixels) return z
  }
  return 1
}

/** The zoom a clipmap ring over this box would fetch at — so callers can skip a
 * ring that would land no sharper than what is already underneath it. */
export function ringZoomFor(b: Bounds, maxZoom: number): number {
  return chooseZoom(b, maxZoom, RING_MAX_TILES, RING_MAX_PIXELS)
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

export interface ProgressiveImageryOptions {
  maxZoom?: number
  signal?: AbortSignal
  /**
   * Called once with the empty output canvas before any tile lands. The caller
   * paints a plausible stand-in here — typically the imagery already on screen,
   * resampled — so the canvas is publishable immediately and tiles only ever
   * sharpen it, never replace something with nothing.
   */
  seed?: (canvas: HTMLCanvasElement, zoom: number) => void
  /** Fires after each tile is drawn into the canvas — the caller decides when
   * the accumulated sharpness is worth a GPU re-upload. */
  onTile?: (loaded: number, total: number) => void
  /**
   * Reuse this canvas as the output, resized only when the tile layout demands
   * different dimensions. Streaming rings pass their slot's persistent canvas, so
   * a refetch allocates nothing — no fresh canvas, no fresh GPU texture, no
   * disposal churn. Continuous camera motion triggers refetches several times a
   * second; allocating a multi-megabyte canvas and texture for each one is what
   * grinds the driver down mid-gesture.
   */
  canvas?: HTMLCanvasElement
}

/**
 * The streaming counterpart to `fetchImagery`, built for clipmap rings.
 *
 * Where `fetchImagery` is stitch-everything-then-reproject-then-return — fine
 * for a one-shot base drape, a guaranteed hitch when run four times per camera
 * move — this draws each tile straight into the final plate-carrée canvas the
 * moment it decodes, centre-out so sharpness appears where the viewer is
 * looking first. There is no intermediate Mercator mosaic and no monolithic
 * row-resample pass: each tile reprojects only the output rows it covers, a
 * cost that amortises to well under a millisecond per tile.
 *
 * Rows are assigned to whichever tile contains the row's vertical centre, so
 * every output row has exactly one writer and tile seams cannot flicker as
 * neighbours land in arbitrary order.
 */
export async function fetchImageryProgressive(
  bounds: Bounds,
  opts: ProgressiveImageryOptions = {},
): Promise<ImageryResult> {
  const { signal } = opts
  const z = chooseZoom(bounds, opts.maxZoom ?? MAX_IMAGERY_ZOOM, RING_MAX_TILES, RING_MAX_PIXELS)
  const tx0 = Math.floor(lonToTileX(bounds.west, z))
  const tx1 = Math.floor(lonToTileX(bounds.east, z))
  const ty0 = Math.floor(latToTileY(bounds.north, z))
  const ty1 = Math.floor(latToTileY(bounds.south, z))

  const out = opts.canvas ?? document.createElement('canvas')
  const w = (tx1 - tx0 + 1) * TILE
  const h = Math.min(RING_MAX_PIXELS, (ty1 - ty0 + 1) * TILE)
  // Assigning width/height clears a canvas even when the value is unchanged, so
  // only touch them on a real dimension change — reuse depends on it.
  if (out.width !== w) out.width = w
  if (out.height !== h) out.height = h
  const octx = out.getContext('2d')!
  octx.imageSmoothingQuality = 'high'
  opts.seed?.(out, z)

  // Horizontal is linear in longitude, so it is one scale and offset for the
  // whole run; vertical is the Mercator stretch, precomputed per output row.
  const sx = (lonToTileX(bounds.west, z) - tx0) * TILE
  const sw = (lonToTileX(bounds.east, z) - lonToTileX(bounds.west, z)) * TILE
  const kx = out.width / sw
  const rowSy = new Float64Array(out.height + 1)
  for (let r = 0; r <= out.height; r++) {
    const lat = bounds.north - (r / out.height) * (bounds.north - bounds.south)
    rowSy[r] = (latToTileY(lat, z) - ty0) * TILE
  }

  const wanted: Array<{ x: number; y: number; d: number }> = []
  const cx = (tx0 + tx1) / 2
  const cy = (ty0 + ty1) / 2
  for (let y = ty0; y <= ty1; y++)
    for (let x = tx0; x <= tx1; x++)
      wanted.push({ x, y, d: (x - cx) * (x - cx) + (y - cy) * (y - cy) })
  wanted.sort((a, b) => a.d - b.d)

  const total = wanted.length
  let done = 0
  let loaded = 0
  let next = 0
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < wanted.length) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
        const t = wanted[next++]!
        const img = await loadTile(z, t.x, t.y, signal)
        // Cache hits resolve even after an abort — and the canvas may already be
        // hosting the ring's NEXT fetch, so drawing with this run's geometry
        // would smear stale tiles across it. Check again now, not just up top.
        if (signal?.aborted) {
          img?.close()
          throw new DOMException('aborted', 'AbortError')
        }
        if (img) {
          const myTop = (t.y - ty0) * TILE
          const myBot = myTop + TILE
          const dx = ((t.x - tx0) * TILE - sx) * kx
          const dw = TILE * kx
          // First row whose centre falls inside this tile's Mercator span.
          let lo = 0
          let hi = out.height
          while (lo < hi) {
            const mid = (lo + hi) >> 1
            if ((rowSy[mid]! + rowSy[mid + 1]!) / 2 < myTop) lo = mid + 1
            else hi = mid
          }
          for (let r = lo; r < out.height; r++) {
            if ((rowSy[r]! + rowSy[r + 1]!) / 2 >= myBot) break
            const syTop = Math.max(rowSy[r]!, myTop)
            const syBot = Math.min(rowSy[r + 1]!, myBot)
            octx.drawImage(img, 0, syTop - myTop, TILE, Math.max(0.5, syBot - syTop), dx, r, dw, 1)
          }
          img.close()
          loaded++
        }
        opts.onTile?.(++done, total)
      }
    }),
  )
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  return { canvas: out, zoom: z, tilesLoaded: loaded, tilesTotal: total }
}
