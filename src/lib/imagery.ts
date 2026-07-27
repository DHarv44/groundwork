import type { Bounds } from './geo'
import { latToTileY, lonToTileX } from './geo'

const TILE = 256
const MAX_TILES = 144
const MAX_PIXELS = 4096

function tileUrl(z: number, x: number, y: number): string {
  // Esri World Imagery is served z/y/x. Proxied in dev so the canvas stays untainted.
  if (import.meta.env.DEV) return `/api/imagery/${z}/${y}/${x}`
  return `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
}

function loadTile(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/** Pick the highest zoom whose tile mosaic stays within our tile and pixel budgets. */
function chooseZoom(b: Bounds): number {
  for (let z = 19; z >= 1; z--) {
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

/**
 * Build a satellite texture for `bounds`, reprojected from Web Mercator into the
 * plate-carrée (linear lat/lon) grid the DEM uses, so imagery lines up with relief.
 */
export async function fetchImagery(
  bounds: Bounds,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ImageryResult> {
  const z = chooseZoom(bounds)
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
        loadTile(tileUrl(z, tx, ty)).then((img) => {
          if (signal?.aborted) return
          if (img) {
            mctx.drawImage(img, (tx - tx0) * TILE, (ty - ty0) * TILE, TILE, TILE)
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
