import type { Bounds } from './geo'
import { latToTileY, lonToTileX } from './geo'
import type { HeightField } from './opentopo'

/**
 * Elevation from AWS Terrain Tiles ("Terrarium"), the open dataset formerly published
 * by Mapzen.
 *
 * No API key and no request quota, which makes it the fallback when OpenTopography's
 * 50-per-day allowance is spent. Elevation is packed into the RGB channels of ordinary
 * PNG map tiles:
 *
 *     metres = (R * 256 + G + B / 256) - 32768
 *
 * The B channel carries fractional metres, so the decode is exact rather than
 * quantised. Tiles are Web Mercator, so as with the satellite drape the mosaic has to
 * be resampled into the plate-carrée grid the rest of the pipeline uses.
 */

const TILE = 256
// Budgets for the tile mosaic. Both are fixed pixel counts, so metres-per-sample
// scales with how large an area you draw: at 256/2400 a 110 km box fell back to z11
// (~76 m/px) while a 27 km box reached ~13 m/px. Raised to buy back roughly one zoom
// level on large areas. The ceiling past this is the source itself — Terrarium is
// SRTM-derived at ~30 m, so beyond z13 it is upsampling, not new detail.
const MAX_TILES = 600
const MAX_SAMPLES = 4096
/** Source data is SRTM-derived, so past ~z13 there is no more real detail to gain. */
const MAX_ZOOM = 13

function tileUrl(z: number, x: number, y: number): string {
  if (import.meta.env.DEV) return `/api/terrarium/${z}/${x}/${y}.png`
  return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`
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

function chooseZoom(b: Bounds): number {
  for (let z = MAX_ZOOM; z >= 1; z--) {
    const nx = Math.floor(lonToTileX(b.east, z)) - Math.floor(lonToTileX(b.west, z)) + 1
    const ny = Math.floor(latToTileY(b.south, z)) - Math.floor(latToTileY(b.north, z)) + 1
    if (nx * ny <= MAX_TILES && nx * TILE <= MAX_SAMPLES && ny * TILE <= MAX_SAMPLES) return z
  }
  return 1
}

export async function fetchTerrariumHeightField(
  bounds: Bounds,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<HeightField> {
  const z = chooseZoom(bounds)
  const tx0 = Math.floor(lonToTileX(bounds.west, z))
  const tx1 = Math.floor(lonToTileX(bounds.east, z))
  const ty0 = Math.floor(latToTileY(bounds.north, z))
  const ty1 = Math.floor(latToTileY(bounds.south, z))
  const nx = tx1 - tx0 + 1
  const ny = ty1 - ty0 + 1
  const total = nx * ny

  const mosaic = document.createElement('canvas')
  mosaic.width = nx * TILE
  mosaic.height = ny * TILE
  // willReadFrequently: every pixel is read back to decode elevation.
  const mctx = mosaic.getContext('2d', { willReadFrequently: true })!
  // Terrarium's zero point, so any tile that fails to load reads as sea level.
  mctx.fillStyle = 'rgb(128,0,0)'
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
  if (loaded === 0) throw new Error('AWS Terrain Tiles returned no data for that area.')

  const pixels = mctx.getImageData(0, 0, mosaic.width, mosaic.height).data

  // Decode the whole mosaic first, then resample rows into linear latitude. Sampling
  // must happen on decoded metres — interpolating the packed RGB would be meaningless,
  // since a one-step change in R is a 256 m jump.
  const mw = mosaic.width
  const mh = mosaic.height
  const merc = new Float32Array(mw * mh)
  for (let i = 0; i < merc.length; i++) {
    const o = i * 4
    merc[i] = pixels[o] * 256 + pixels[o + 1] + pixels[o + 2] / 256 - 32768
  }

  // Output grid: crop to the requested box, keeping roughly the mosaic's resolution.
  // Rows are chosen so ground cells come out near-square — the grid is linear in
  // lat/lon, so the ratio has to be divided by cos(latitude).
  const uSpan = lonToTileX(bounds.east, z) - lonToTileX(bounds.west, z)
  const width = Math.max(16, Math.min(MAX_SAMPLES, Math.round(uSpan * TILE)))
  const midLat = ((bounds.north + bounds.south) / 2) * (Math.PI / 180)
  const groundAspect =
    (bounds.north - bounds.south) /
    Math.max(1e-9, (bounds.east - bounds.west) * Math.cos(midLat))
  const rows = Math.max(16, Math.min(MAX_SAMPLES, Math.round(width * groundAspect)))

  const data = new Float32Array(width * rows)
  const x0 = (lonToTileX(bounds.west, z) - tx0) * TILE
  const xStep = (uSpan * TILE) / width

  let min = Infinity
  let max = -Infinity

  for (let row = 0; row < rows; row++) {
    const lat = bounds.north - ((row + 0.5) / rows) * (bounds.north - bounds.south)
    const my = (latToTileY(lat, z) - ty0) * TILE - 0.5
    const my0 = Math.max(0, Math.min(mh - 1, Math.floor(my)))
    const my1 = Math.min(mh - 1, my0 + 1)
    const fy = Math.max(0, Math.min(1, my - my0))

    for (let col = 0; col < width; col++) {
      const mx = x0 + (col + 0.5) * xStep - 0.5
      const mx0 = Math.max(0, Math.min(mw - 1, Math.floor(mx)))
      const mx1 = Math.min(mw - 1, mx0 + 1)
      const fx = Math.max(0, Math.min(1, mx - mx0))

      const a = merc[my0 * mw + mx0]
      const b = merc[my0 * mw + mx1]
      const c = merc[my1 * mw + mx0]
      const d = merc[my1 * mw + mx1]
      const v = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy

      data[row * width + col] = v
      if (v < min) min = v
      if (v > max) max = v
    }
  }

  return {
    width,
    height: rows,
    data,
    bounds,
    min,
    max,
    demtype: 'AWS_TERRARIUM',
    voids: 0,
  }
}
