/**
 * What biome a tile sits in, and what the ground should therefore look like.
 *
 * The class itself comes from the bundled Köppen–Geiger raster (see koppen.ts) — a
 * published, peer-reviewed map at 1 km native resolution, which is far better than
 * anything derivable from a single point sample, and free to read as often as we like.
 *
 * The temperature and rainfall figures shown alongside it are a separate, optional
 * garnish: ERA5 reanalysis normals for 1991–2020 from Open-Meteo (keyless, CORS open).
 * They are never load-bearing — if that request fails the biome is still known.
 */

import type { Bounds } from './geo'
import { KOPPEN_CODES, dominantClass, loadKoppen } from './koppen'

export interface ClimateNormals {
  /** Mean temperature for each calendar month, °C. */
  temp: number[]
  /** Mean total precipitation for each calendar month, mm. */
  precip: number[]
  /** Mean annual temperature, °C. */
  meanTemp: number
  /** Mean annual precipitation, mm. */
  annualPrecip: number
}

export interface Biome {
  /** Köppen code, e.g. "BSk". */
  code: string
  /** Plain-English name for the code. */
  name: string
  /** Filled in later, if the normals request succeeds. */
  normals: ClimateNormals | null
}

/** The normals period. 1991–2020 is the current WMO standard 30-year window, and it
 *  matches the period the bundled Köppen map was built for. */
const START = '1991-01-01'
const END = '2020-12-31'

const CACHE_KEY = 'terrain-builder.climate'

function cacheRead(key: string): ClimateNormals | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    const hit = all[key] as ClimateNormals | undefined
    // Shape-checked rather than trusted: this cache has already outlived one change of
    // format, and a stale entry would otherwise render as "undefined °C".
    return hit && Number.isFinite(hit.meanTemp) && Array.isArray(hit.temp) ? hit : null
  } catch {
    return null
  }
}

function cacheWrite(key: string, normals: ClimateNormals): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    const all = raw ? (JSON.parse(raw) as Record<string, ClimateNormals>) : {}
    all[key] = normals
    localStorage.setItem(CACHE_KEY, JSON.stringify(all))
  } catch {
    /* storage disabled — the lookup just repeats next time */
  }
}

/**
 * Reduce a daily series to per-month climatological means. Temperature averages over
 * every day of that month across all years; precipitation totals each month and then
 * averages those totals.
 */
function monthlyNormals(
  dates: string[],
  temp: (number | null)[],
  precip: (number | null)[],
): ClimateNormals {
  const tSum = new Float64Array(12)
  const tCount = new Float64Array(12)
  // Precipitation is accumulated per (month, year) first, so a partial year cannot drag
  // a month's total down.
  const perMonthYear = new Map<string, number>()
  const pMonths = new Float64Array(12)
  const pTotals = new Float64Array(12)

  for (let i = 0; i < dates.length; i++) {
    const m = Number(dates[i].slice(5, 7)) - 1
    const t = temp[i]
    if (t !== null && Number.isFinite(t)) {
      tSum[m] += t
      tCount[m]++
    }
    const p = precip[i]
    if (p !== null && Number.isFinite(p)) {
      const k = dates[i].slice(0, 7)
      perMonthYear.set(k, (perMonthYear.get(k) ?? 0) + p)
    }
  }

  for (const [k, total] of perMonthYear) {
    const m = Number(k.slice(5, 7)) - 1
    pTotals[m] += total
    pMonths[m]++
  }

  const tMonthly: number[] = []
  const pMonthly: number[] = []
  for (let m = 0; m < 12; m++) {
    tMonthly.push(tCount[m] > 0 ? tSum[m] / tCount[m] : 0)
    pMonthly.push(pMonths[m] > 0 ? pTotals[m] / pMonths[m] : 0)
  }

  return {
    temp: tMonthly,
    precip: pMonthly,
    meanTemp: tMonthly.reduce((a, b) => a + b, 0) / 12,
    annualPrecip: pMonthly.reduce((a, b) => a + b, 0),
  }
}

const NAMES: Record<string, string> = {
  Af: 'Tropical rainforest',
  Am: 'Tropical monsoon',
  Aw: 'Tropical savanna',
  BWh: 'Hot desert',
  BWk: 'Cold desert',
  BSh: 'Hot semi-arid steppe',
  BSk: 'Cold semi-arid steppe',
  Csa: 'Mediterranean, hot summer',
  Csb: 'Mediterranean, warm summer',
  Csc: 'Mediterranean, cold summer',
  Cwa: 'Humid subtropical, dry winter',
  Cwb: 'Subtropical highland',
  Cwc: 'Cold subtropical highland',
  Cfa: 'Humid subtropical',
  Cfb: 'Oceanic',
  Cfc: 'Subpolar oceanic',
  Dsa: 'Continental, dry hot summer',
  Dsb: 'Continental, dry warm summer',
  Dsc: 'Subarctic, dry summer',
  Dsd: 'Subarctic, dry summer, severe winter',
  Dwa: 'Continental, dry winter',
  Dwb: 'Continental, dry winter, warm summer',
  Dwc: 'Subarctic, dry winter',
  Dwd: 'Subarctic, dry winter, severe winter',
  Dfa: 'Humid continental, hot summer',
  Dfb: 'Humid continental, warm summer',
  Dfc: 'Subarctic',
  Dfd: 'Subarctic, severe winter',
  ET: 'Tundra',
  EF: 'Ice cap',
}

export function biomeName(code: string): string {
  return NAMES[code] ?? code
}

/**
 * The surface look a biome implies.
 *
 * Snow and tree lines are multipliers rather than absolute heights, because the
 * latitude curve in geo.ts already gets the broad altitude right; what the biome adds
 * is the correction latitude alone cannot know — that the dry subtropics carry their
 * snow line far higher than a maritime climate on the same parallel, and that a savanna
 * keeps trees several hundred metres above a steppe.
 */
export interface BiomeProfile {
  aridity: number
  riparian: number
  riparianReach: number
  groundWarmth: number
  snowLineScale: number
  treeLineScale: number
}

function prof(
  aridity: number,
  riparian: number,
  riparianReach: number,
  groundWarmth: number,
  snowLineScale: number,
  treeLineScale: number,
): BiomeProfile {
  return { aridity, riparian, riparianReach, groundWarmth, snowLineScale, treeLineScale }
}

/**
 * Riparian growth is deliberately highest in the arid classes. That is not a stylistic
 * choice — in a desert the only green is the ribbon along the wadi, whereas in a
 * rainforest the corridor is invisible because everything either side is already green.
 */
const PROFILES: Record<string, BiomeProfile> = {
  //         aridity  riparian  reach  warmth  snow×  tree×
  Af: prof(0.02, 0.20, 0.28, 0.00, 1.05, 1.14),
  Am: prof(0.08, 0.32, 0.30, 0.03, 1.05, 1.12),
  Aw: prof(0.44, 0.76, 0.38, 0.24, 1.08, 1.06),
  BWh: prof(0.97, 0.95, 0.44, 0.72, 1.18, 0.52),
  BWk: prof(0.92, 0.88, 0.42, 0.44, 1.10, 0.58),
  BSh: prof(0.80, 0.90, 0.40, 0.52, 1.12, 0.78),
  BSk: prof(0.66, 0.82, 0.38, 0.30, 1.05, 0.86),
  Csa: prof(0.52, 0.72, 0.36, 0.30, 1.04, 0.94),
  Csb: prof(0.38, 0.62, 0.34, 0.18, 1.00, 0.98),
  Csc: prof(0.30, 0.52, 0.32, 0.10, 0.92, 0.90),
  Cwa: prof(0.26, 0.56, 0.34, 0.14, 1.02, 1.04),
  Cwb: prof(0.22, 0.50, 0.33, 0.10, 1.00, 1.02),
  Cwc: prof(0.22, 0.44, 0.32, 0.08, 0.94, 0.92),
  Cfa: prof(0.12, 0.40, 0.32, 0.05, 1.02, 1.05),
  Cfb: prof(0.08, 0.34, 0.30, 0.02, 0.88, 1.00),
  Cfc: prof(0.08, 0.30, 0.30, 0.02, 0.80, 0.90),
  Dsa: prof(0.48, 0.68, 0.36, 0.24, 1.02, 0.92),
  Dsb: prof(0.42, 0.62, 0.35, 0.18, 0.98, 0.90),
  Dsc: prof(0.34, 0.52, 0.34, 0.10, 0.90, 0.84),
  Dsd: prof(0.30, 0.46, 0.33, 0.06, 0.84, 0.76),
  Dwa: prof(0.30, 0.54, 0.34, 0.12, 1.00, 0.96),
  Dwb: prof(0.26, 0.48, 0.33, 0.08, 0.96, 0.92),
  Dwc: prof(0.22, 0.42, 0.32, 0.05, 0.90, 0.84),
  Dwd: prof(0.20, 0.38, 0.31, 0.03, 0.84, 0.74),
  Dfa: prof(0.14, 0.42, 0.32, 0.05, 1.00, 0.98),
  Dfb: prof(0.12, 0.38, 0.31, 0.03, 0.96, 0.94),
  Dfc: prof(0.14, 0.34, 0.30, 0.02, 0.88, 0.84),
  Dfd: prof(0.14, 0.30, 0.30, 0.02, 0.82, 0.74),
  ET: prof(0.36, 0.26, 0.28, 0.06, 0.70, 0.28),
  EF: prof(0.24, 0.00, 0.25, 0.00, 0.12, 0.00),
}

/** Every class the raster can return, in legend order — the panel lists these. */
export const BIOME_CODES = KOPPEN_CODES.filter(Boolean) as readonly string[]

export function profileFor(code: string): BiomeProfile {
  return PROFILES[code] ?? PROFILES.Cfb
}

/**
 * Identify the biome of an area from the bundled raster. Synchronous once the raster is
 * resident, which it is within a moment of start-up — so this can run on every drag of
 * the selection box.
 */
export function biomeOf(bounds: Bounds): Biome | null {
  const index = dominantClass(bounds.south, bounds.north, bounds.west, bounds.east)
  if (!index) return null
  const code = KOPPEN_CODES[index]
  return { code, name: biomeName(code), normals: null }
}

/** Make sure the raster is resident. Cheap after the first call. */
export const ensureKoppen = loadKoppen

/**
 * Fetch the temperature and rainfall readout for an area's centre. Purely cosmetic —
 * resolves to null rather than throwing if the service is unreachable.
 */
export async function fetchNormals(
  bounds: Bounds,
  signal?: AbortSignal,
): Promise<ClimateNormals | null> {
  const lat = (bounds.north + bounds.south) / 2
  const lon = (bounds.east + bounds.west) / 2
  // Quarter-degree cells: finer than the reanalysis grid itself, so rounding costs no
  // accuracy but makes nearby areas share one lookup.
  const key = `${(Math.round(lat * 4) / 4).toFixed(2)},${(Math.round(lon * 4) / 4).toFixed(2)}`

  const hit = cacheRead(key)
  if (hit) return hit

  const url =
    'https://archive-api.open-meteo.com/v1/archive' +
    `?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    `&start_date=${START}&end_date=${END}` +
    '&daily=temperature_2m_mean,precipitation_sum&timezone=UTC'

  try {
    let res = await fetch(url, { signal })
    // Open-Meteo rate-limits per minute. Building several areas in quick succession
    // trips it, and this runs in the background, so one patient retry is worth more
    // than dropping the readout.
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 8000))
      if (signal?.aborted) return null
      res = await fetch(url, { signal })
    }
    if (!res.ok) throw new Error(`climate ${res.status}`)
    const json = (await res.json()) as {
      daily?: {
        time: string[]
        temperature_2m_mean: (number | null)[]
        precipitation_sum: (number | null)[]
      }
    }
    const d = json.daily
    if (!d?.time?.length) throw new Error('climate: empty series')

    const normals = monthlyNormals(d.time, d.temperature_2m_mean, d.precipitation_sum)
    cacheWrite(key, normals)
    return normals
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError') console.warn('climate readout failed', e)
    return null
  }
}
