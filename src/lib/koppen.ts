/**
 * Global Köppen–Geiger climate map, held locally.
 *
 * public/koppen_0p1.png is the 1991–2020 present-day map from Beck et al. (2023),
 * resampled to 0.1° (~11 km) and stored as an 8-bit greyscale PNG in which the pixel
 * value *is* the class index — 1..30 per the dataset's own legend, 0 for water and
 * no-data. No palette lookup, no colour management to get wrong: the byte is the class.
 *
 *   Beck, H. E., T. R. McVicar, N. Vergopolan, A. Berg, N. J. Lutsko, A. Dufour,
 *   Z. Zeng, X. Jiang, A. I. J. M. van Dijk, and D. G. Miralles. High-resolution
 *   (1 km) Köppen-Geiger maps for 1901–2099 based on constrained CMIP6 projections,
 *   Scientific Data 10, 724 (2023).  CC BY 4.0.
 *
 * Having it local is what makes the biome free: the class can be read on every drag of
 * the box, and the whole visible map can be painted, without a single request.
 */

const RASTER_URL = `${import.meta.env.BASE_URL}koppen_0p1.png`

/** Equirectangular, whole globe, 0.1° cells. Origin is the north-west corner. */
const WIDTH = 3600
const HEIGHT = 1800

/** Class index → Köppen code. Index 0 is water/no-data; the rest follow legend.txt. */
export const KOPPEN_CODES = [
  '', // 0 — ocean or no data
  'Af', 'Am', 'Aw',
  'BWh', 'BWk', 'BSh', 'BSk',
  'Csa', 'Csb', 'Csc',
  'Cwa', 'Cwb', 'Cwc',
  'Cfa', 'Cfb', 'Cfc',
  'Dsa', 'Dsb', 'Dsc', 'Dsd',
  'Dwa', 'Dwb', 'Dwc', 'Dwd',
  'Dfa', 'Dfb', 'Dfc', 'Dfd',
  'ET', 'EF',
] as const

/** The dataset's own colour scheme, so the overlay matches every published map. */
export const KOPPEN_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [0, 0, 255], [0, 120, 255], [70, 170, 250],
  [255, 0, 0], [255, 150, 150], [245, 165, 0], [255, 220, 100],
  [255, 255, 0], [200, 200, 0], [150, 150, 0],
  [150, 255, 150], [100, 200, 100], [50, 150, 50],
  [200, 255, 80], [100, 255, 80], [50, 200, 0],
  [255, 0, 255], [200, 0, 200], [150, 50, 150], [150, 100, 150],
  [170, 175, 255], [90, 120, 220], [75, 80, 180], [50, 0, 135],
  [0, 255, 255], [55, 200, 255], [0, 125, 125], [0, 70, 95],
  [178, 178, 178], [102, 102, 102],
]

let classes: Uint8Array | null = null
let loading: Promise<Uint8Array | null> | null = null

/**
 * Decode the raster once and keep the class bytes.
 *
 * `colorSpaceConversion: 'none'` matters: these bytes are data, not a picture, and a
 * browser that decides to colour-manage a greyscale PNG would quietly renumber every
 * climate class.
 */
export function loadKoppen(): Promise<Uint8Array | null> {
  if (classes) return Promise.resolve(classes)
  if (loading) return loading

  loading = (async () => {
    try {
      const res = await fetch(RASTER_URL)
      if (!res.ok) throw new Error(`koppen ${res.status}`)
      const bitmap = await createImageBitmap(await res.blob(), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      })
      const canvas = document.createElement('canvas')
      canvas.width = WIDTH
      canvas.height = HEIGHT
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('koppen: no 2d context')
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()

      const rgba = ctx.getImageData(0, 0, WIDTH, HEIGHT).data
      const out = new Uint8Array(WIDTH * HEIGHT)
      for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4]
      classes = out
      return out
    } catch (e) {
      console.warn('Köppen raster unavailable', e)
      return null
    } finally {
      loading = null
    }
  })()

  return loading
}

/** True once the raster is resident and the synchronous lookups below will work. */
export function koppenReady(): boolean {
  return classes !== null
}

/** Class index at a point, or 0 for ocean, no data, or a raster that has not loaded. */
export function classAt(lat: number, lon: number): number {
  if (!classes) return 0
  // Longitude wraps; latitude clamps at the poles.
  const x = Math.floor((((lon + 180) % 360) + 360) % 360 / 0.1)
  const y = Math.floor((90 - lat) / 0.1)
  if (y < 0 || y >= HEIGHT) return 0
  return classes[y * WIDTH + Math.min(WIDTH - 1, x)]
}

export function codeAt(lat: number, lon: number): string {
  return KOPPEN_CODES[classAt(lat, lon)] ?? ''
}

/**
 * The dominant class over a box.
 *
 * A single centre sample is wrong for exactly the tiles that matter — a box straddling
 * a coast or a mountain front can have its centre in a class that covers a tenth of the
 * ground. Water is not counted, so a coastal box classifies by its land; a box that is
 * all sea returns 0.
 */
export function dominantClass(
  south: number,
  north: number,
  west: number,
  east: number,
): number {
  if (!classes) return 0

  const tally = new Uint32Array(KOPPEN_CODES.length)
  // Cap the sampling so a whole-continent box is no more work than a valley.
  const steps = 48
  const dLat = (north - south) / steps
  const dLon = (east - west) / steps

  for (let i = 0; i <= steps; i++) {
    const lat = south + dLat * i
    for (let j = 0; j <= steps; j++) {
      const c = classAt(lat, west + dLon * j)
      if (c > 0) tally[c]++
    }
  }

  let best = 0
  let bestCount = 0
  for (let c = 1; c < tally.length; c++) {
    if (tally[c] > bestCount) {
      bestCount = tally[c]
      best = c
    }
  }
  return best
}

export function colorFor(index: number): readonly [number, number, number] {
  return KOPPEN_COLORS[index] ?? KOPPEN_COLORS[0]
}
