import { fromArrayBuffer } from 'geotiff'
import type { Bounds } from './geo'
import { boundsAreaKm2 } from './geo'
import {
  DAILY_QUOTA,
  cacheGet,
  cachePut,
  noteRequest,
  quotaResetsAt,
  quotaUsed,
} from './demcache'
import { fetchTerrariumHeightField } from './terrarium'

export interface DemSource {
  id: string
  label: string
  /** Nominal ground sample distance, metres. */
  resolution: number
  /** OpenTopography's per-request area cap, km². */
  maxAreaKm2: number
  /** Latitude coverage limits, degrees. */
  latRange: [number, number]
  note: string
}

/** Sources that need no key and have no request cap. */
export const KEYLESS_SOURCES = new Set(['AWS_TERRARIUM'])

/** OpenTopography global raster catalogue, plus keyless alternatives. */
export const DEM_SOURCES: DemSource[] = [
  {
    id: 'AWS_TERRARIUM',
    label: 'AWS Terrain Tiles',
    resolution: 30,
    maxAreaKm2: 250_000,
    latRange: [-85, 85],
    note: 'No API key and no daily limit. SRTM/NED-derived, served as map tiles — use this when the OpenTopography allowance is spent.',
  },
  {
    id: 'COP30',
    label: 'Copernicus GLO-30',
    resolution: 30,
    maxAreaKm2: 450_000,
    latRange: [-90, 90],
    note: 'Best all-round 30 m DEM. Global, void-filled, clean coastlines.',
  },
  {
    id: 'NASADEM',
    label: 'NASADEM',
    resolution: 30,
    maxAreaKm2: 450_000,
    latRange: [-56, 60],
    note: 'Reprocessed SRTM with improved voids. Sharp in high relief.',
  },
  {
    id: 'SRTMGL1',
    label: 'SRTM GL1',
    resolution: 30,
    maxAreaKm2: 450_000,
    latRange: [-56, 60],
    note: 'The classic 1 arc-second SRTM. Some voids in steep terrain.',
  },
  {
    id: 'AW3D30',
    label: 'ALOS World 3D',
    resolution: 30,
    maxAreaKm2: 450_000,
    latRange: [-90, 90],
    note: 'JAXA optical stereo DEM. Excellent in glaciated / polar terrain.',
  },
  {
    id: 'COP90',
    label: 'Copernicus GLO-90',
    resolution: 90,
    maxAreaKm2: 4_050_000,
    latRange: [-90, 90],
    note: 'Coarser but covers a much larger area per request.',
  },
  {
    id: 'SRTMGL3',
    label: 'SRTM GL3',
    resolution: 90,
    maxAreaKm2: 4_050_000,
    latRange: [-56, 60],
    note: '3 arc-second SRTM. Good for whole mountain ranges.',
  },
  {
    id: 'EU_DTM',
    label: 'EU DTM (Europe)',
    resolution: 30,
    maxAreaKm2: 450_000,
    latRange: [34, 72],
    note: 'Continental Europe only. Bare-earth, very high quality.',
  },
  {
    id: 'SRTM15Plus',
    label: 'SRTM15+ (land & seabed)',
    resolution: 450,
    maxAreaKm2: 4_050_000,
    latRange: [-90, 90],
    note: 'Includes bathymetry — use it for ocean trenches and seamounts.',
  },
  {
    id: 'GEBCOIceTopo',
    label: 'GEBCO 2023 (ice surface)',
    resolution: 500,
    maxAreaKm2: 4_050_000,
    latRange: [-90, 90],
    note: 'Global relief including ocean floor, ice-sheet surface.',
  },
]

export interface HeightField {
  width: number
  height: number
  /** Elevation in metres, row-major, north row first. Voids already filled. */
  data: Float32Array
  /** Actual raster bounds returned by the server (may differ slightly from the request). */
  bounds: Bounds
  min: number
  max: number
  demtype: string
  /** Count of samples that were voids in the source raster. */
  voids: number
}

export class OpenTopoError extends Error {}

/** Raised when the daily allowance is gone, so the UI can say something useful. */
export class QuotaError extends OpenTopoError {}

/**
 * OpenTopography reports failures as XML bodies, often behind a 401 even when the key
 * is fine and it is really the rate limit. Turn that into something readable.
 */
function describeFailure(status: number, body: string): string {
  const text = body
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (/rate limit/i.test(text)) {
    const resets = quotaResetsAt()
    const when = resets
      ? ` Oldest request ages out around ${resets.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
      : ''
    throw new QuotaError(
      `OpenTopography daily limit reached (${DAILY_QUOTA} requests / 24 h).` +
        ` Areas you have already built are cached and still work.${when}`,
    )
  }
  if (status === 401) return `API key rejected — ${text || 'unauthorised'}`
  if (status === 204) return 'No data available for that area.'
  return text || `HTTP ${status}`
}

function endpoint(params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString()
  // In dev the Vite proxy appends API_Key server-side; in a static build we must send it.
  if (import.meta.env.DEV) return `/api/opentopo/globaldem?${qs}`
  const key = import.meta.env.VITE_OPENTOPO_KEY ?? ''
  return `https://portal.opentopography.org/API/globaldem?${qs}&API_Key=${key}`
}

export function validateRequest(bounds: Bounds, source: DemSource): string | null {
  if (bounds.north <= bounds.south || bounds.east <= bounds.west) {
    return 'Draw a box with some area in it.'
  }
  const area = boundsAreaKm2(bounds)
  if (area > source.maxAreaKm2) {
    return `Box is ${Math.round(area).toLocaleString()} km² — ${source.label} caps out at ${source.maxAreaKm2.toLocaleString()} km².`
  }
  const [lo, hi] = source.latRange
  if (bounds.south < lo || bounds.north > hi) {
    return `${source.label} only covers ${lo}° to ${hi}° latitude.`
  }
  if (!KEYLESS_SOURCES.has(source.id) && quotaUsed() >= DAILY_QUOTA) {
    return `Daily OpenTopography allowance is spent (${DAILY_QUOTA}/24 h). Switch the source to AWS Terrain Tiles — no key, no limit — or pick an area you have already cached.`
  }
  return null
}

/**
 * Fetch a GeoTIFF DEM for the given bounds and decode it into a height field.
 * Voids (nodata) are filled by iterative neighbour averaging so the mesh has no spikes.
 */
export async function fetchHeightField(
  bounds: Bounds,
  demtype: string,
  signal?: AbortSignal,
  onCacheHit?: () => void,
  onTileProgress?: (done: number, total: number) => void,
): Promise<HeightField> {
  // Never spend an API call on an area we already hold.
  const cached = await cacheGet(bounds, demtype)
  if (cached) {
    onCacheHit?.()
    return cached
  }

  if (demtype === 'AWS_TERRARIUM') {
    const result = await fetchTerrariumHeightField(bounds, onTileProgress, signal)
    void cachePut(result, bounds)
    return result
  }

  const url = endpoint({
    demtype,
    south: bounds.south.toFixed(6),
    north: bounds.north.toFixed(6),
    west: bounds.west.toFixed(6),
    east: bounds.east.toFixed(6),
    outputFormat: 'GTiff',
  })

  noteRequest()
  const res = await fetch(url, { signal })
  const contentType = res.headers.get('content-type') ?? ''

  if (!res.ok || !/tiff|octet-stream/i.test(contentType)) {
    throw new OpenTopoError(describeFailure(res.status, await res.text()))
  }

  const buffer = await res.arrayBuffer()
  const tiff = await fromArrayBuffer(buffer)
  const image = await tiff.getImage()
  const width = image.getWidth()
  const height = image.getHeight()
  const [minX, minY, maxX, maxY] = image.getBoundingBox()
  const rasters = await image.readRasters({ interleave: false })
  const raw = rasters[0] as ArrayLike<number>

  let noData = image.getGDALNoData()
  if (noData === null || noData === undefined) noData = -32768

  const data = new Float32Array(width * height)
  const valid = new Uint8Array(width * height)
  let min = Infinity
  let max = -Infinity
  let voids = 0

  for (let i = 0; i < data.length; i++) {
    const v = raw[i]
    // Treat the declared nodata value and absurd elevations as voids.
    if (v === noData || !Number.isFinite(v) || v < -12000 || v > 9500) {
      voids++
      data[i] = 0
      continue
    }
    valid[i] = 1
    data[i] = v
    if (v < min) min = v
    if (v > max) max = v
  }

  if (!Number.isFinite(min)) throw new OpenTopoError('Tile contains no valid elevation samples.')
  if (voids > 0) fillVoids(data, valid, width, height, min)

  const result: HeightField = {
    width,
    height,
    data,
    bounds: { west: minX, south: minY, east: maxX, north: maxY },
    min,
    max,
    demtype,
    voids,
  }

  // Keyed on the requested bounds, which is what the next lookup will ask for.
  void cachePut(result, bounds)
  return result
}

/**
 * Fill nodata cells by repeatedly averaging valid 4-neighbours, so holes grow inward
 * from their edges. Anything still unreached after the sweep falls back to the minimum.
 */
function fillVoids(
  data: Float32Array,
  valid: Uint8Array,
  width: number,
  height: number,
  fallback: number,
): void {
  const maxPasses = 64
  for (let pass = 0; pass < maxPasses; pass++) {
    let filled = 0
    const next = valid.slice()
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        if (valid[i]) continue
        let sum = 0
        let n = 0
        if (x > 0 && valid[i - 1]) (sum += data[i - 1]), n++
        if (x < width - 1 && valid[i + 1]) (sum += data[i + 1]), n++
        if (y > 0 && valid[i - width]) (sum += data[i - width]), n++
        if (y < height - 1 && valid[i + width]) (sum += data[i + width]), n++
        if (n > 0) {
          data[i] = sum / n
          next[i] = 1
          filled++
        }
      }
    }
    valid.set(next)
    if (filled === 0) break
  }
  for (let i = 0; i < data.length; i++) if (!valid[i]) data[i] = fallback
}
