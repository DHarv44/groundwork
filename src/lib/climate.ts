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
 * is the correction latitude alone cannot know.
 *
 * The largest part of that correction is continentality, and Köppen's letters encode it
 * directly. The latitude curve is calibrated to maritime ranges — it puts the Alps at
 * about 2,190 m, which is correct — but a continental interior runs far higher on the
 * same parallel: the Colorado Rockies at 40°N carry trees to roughly 3,500 m against
 * the curve's 2,550. So the D classes, which are the cold continental interiors, scale
 * their tree line up by a third or more, while the oceanic C classes sit near 1.
 */
export interface BiomeProfile {
  aridity: number
  riparian: number
  riparianReach: number
  groundWarmth: number
  snowLineScale: number
  treeLineScale: number
  /**
   * How much of the ground cover is trees rather than grass, 0..1.
   *
   * Aridity cannot stand in for this. It conflates how dry a place looks with how
   * vegetated it is, which leaves no way to say wet-but-treeless — tundra, moorland,
   * puna — or dry-but-wooded, like pinyon-juniper on a desert range. It also gets the
   * tone badly wrong: dense conifer is far darker than any grass, so a forested range
   * painted as meadow comes out about half as dark as it should be.
   */
  forest: number
  /**
   * Which green, from −1 (blue-shifted) to +1 (yellow-shifted).
   *
   * Aridity says how parched the cover is. This says what colour it is when it is not.
   * The two are independent: boreal spruce and lowland rainforest are both thoroughly
   * watered and nothing like the same green — one is dark and blue, the other vivid and
   * faintly yellow — and no amount of dryness will turn one into the other.
   */
  vegTint: number
  /** How saturated that green is. Maquis and tundra are grey; rainforest is not. */
  vegSat: number
  /** Catchment a piece of ground must gather before it holds timber. */
  treeNeed: number
  /** Catchment past which the channel is open water too wide for a canopy. */
  treeLimit: number
  /** How sharply timber gives way to grass across both edges of that band. */
  treeSpread: number
  /**
   * How raggedly the timber fingers out of the drainage, 0..1.
   *
   * Zero draws it to a clean contour. Turning it up lets the woodland run up the side
   * gullies and spill onto damp shoulders while leaving clearings on the dry spurs
   * between — which is what makes a wood look grown rather than stencilled.
   */
  treeFractal: number
  /**
   * How strongly timber prefers dissected ground to flat, 0..1.
   *
   * Catchment cannot tell a ploughed field from a block of breaks — both can carry the
   * same drainage. Local relief can, and it is the physical reason: broken ground is too
   * steep and stony to clear, so it keeps its trees while the flat ground beside it was
   * ploughed. Zero disables it entirely.
   */
  treeRough: number
  /** Local relief, in metres, that counts as fully dissected. */
  treeRoughScale: number
  /** How broadleaf the valley-bottom timber is against the canopy above it. */
  corridorLeaf: number
  /** How strongly bedrock banding shows. Soil and cover bury it in wet country. */
  strata: number
}

/**
 * Every profile starts here and states only what it does differently.
 *
 * Written this way round on purpose. A flat table of thirty classes times a dozen
 * fields is three hundred and sixty numbers, and the honest truth is that most of them
 * do not vary by climate — inventing a distinct value for each would be dressing up
 * guesswork as data. What a class overrides below is what genuinely differs about it;
 * everything else is shared, and can be split out later when there is a reason to.
 */
const BASE: BiomeProfile = {
  aridity: 0.12,
  riparian: 0.4,
  riparianReach: 0.32,
  groundWarmth: 0.05,
  snowLineScale: 1,
  treeLineScale: 1,
  forest: 0.6,
  vegTint: 0,
  vegSat: 1,
  // Catchment areas in km², directly comparable with minChannelKm2 for the rivers.
  treeNeed: 1.2,
  treeLimit: 400,
  treeSpread: 0.04,
  treeFractal: 0.45,
  treeRough: 0.5,
  // Measured over half a kilometre. On farmed plains the median comes out near 12 m and
  // the ninetieth percentile near 30, so this sits where the split between ploughed and
  // unploughable actually falls. Setting it at the very top of the range instead means
  // nothing qualifies as broken and the term simply deletes the timber.
  treeRoughScale: 25,
  corridorLeaf: 0.6,
  strata: 0.25,
}

function prof(o: Partial<BiomeProfile>): BiomeProfile {
  return { ...BASE, ...o }
}

/**
 * Riparian growth is deliberately highest in the arid classes. That is not a stylistic
 * choice — in a desert the only green is the ribbon along the wadi, whereas in a
 * rainforest the corridor is invisible because everything either side is already green.
 */
const PROFILES: Record<string, BiomeProfile> = {
  // Rainforest is the most saturated green there is, faintly cool with it, and closed
  // enough that the drainage barely shows — so timber asks almost nothing of catchment.
  // No contrast along the creeks either: the corridor is invisible against the canopy.
  Af: prof({ aridity: 0.02, riparian: 0.2, riparianReach: 0.28, groundWarmth: 0, snowLineScale: 1.05, treeLineScale: 1.14, forest: 1, vegTint: -0.1, vegSat: 1.28, treeNeed: 0.02, corridorLeaf: 0.1, strata: 0.06 }),
  Am: prof({ aridity: 0.08, riparian: 0.32, riparianReach: 0.3, groundWarmth: 0.03, snowLineScale: 1.05, treeLineScale: 1.12, forest: 0.95, vegTint: -0.05, vegSat: 1.2, treeNeed: 0.04, corridorLeaf: 0.15, strata: 0.08 }),
  // Savanna is the definition of scattered: trees over grass, not woodland, and the
  // gallery forest along the watercourses is the whole story.
  Aw: prof({ aridity: 0.44, riparian: 0.76, riparianReach: 0.38, groundWarmth: 0.24, snowLineScale: 1.08, treeLineScale: 1.06, forest: 0.35, vegTint: 0.45, vegSat: 0.85, treeNeed: 2, treeSpread: 0.07, corridorLeaf: 0.85, strata: 0.3 }),
  // Arid classes are treeless for moisture, not altitude — aridity does that work, so
  // their tree line stays near the curve rather than being dragged down and stripping
  // the forested range that so often stands beside a dry basin. Bedrock is bare here,
  // so the banding shows more strongly than anywhere else.
  BWh: prof({ aridity: 0.97, riparian: 0.95, riparianReach: 0.44, groundWarmth: 0.72, snowLineScale: 1.18, forest: 0.02, vegTint: 0.55, vegSat: 0.55, treeNeed: 60, corridorLeaf: 0.95, strata: 0.62 }),
  BWk: prof({ aridity: 0.92, riparian: 0.88, riparianReach: 0.42, groundWarmth: 0.44, snowLineScale: 1.14, treeLineScale: 1.05, forest: 0.05, vegTint: 0.45, vegSat: 0.6, treeNeed: 40, corridorLeaf: 0.92, strata: 0.58 }),
  BSh: prof({ aridity: 0.8, riparian: 0.9, riparianReach: 0.4, groundWarmth: 0.52, snowLineScale: 1.14, treeLineScale: 1.05, forest: 0.07, vegTint: 0.5, vegSat: 0.7, treeNeed: 20, corridorLeaf: 0.9, strata: 0.46 }),
  BSk: prof({ aridity: 0.66, riparian: 0.82, riparianReach: 0.38, groundWarmth: 0.54, snowLineScale: 1.15, treeLineScale: 1.12, forest: 0.1, vegTint: 0.4, vegSat: 0.75, treeNeed: 12, corridorLeaf: 0.88, strata: 0.4 }),
  // Maquis and garrigue are grey-olive, not green — the leaves are waxed against the
  // summer drought and reflect far less colour than a temperate leaf.
  Csa: prof({ aridity: 0.52, riparian: 0.72, riparianReach: 0.36, groundWarmth: 0.3, snowLineScale: 1.04, treeLineScale: 0.94, forest: 0.42, vegTint: 0.2, vegSat: 0.62, treeNeed: 6, corridorLeaf: 0.72, strata: 0.42 }),
  Csb: prof({ aridity: 0.38, riparian: 0.62, riparianReach: 0.34, groundWarmth: 0.18, treeLineScale: 0.98, forest: 0.55, vegTint: 0.12, vegSat: 0.7, treeNeed: 3, corridorLeaf: 0.62, strata: 0.34 }),
  Csc: prof({ aridity: 0.3, riparian: 0.52, snowLineScale: 0.92, treeLineScale: 0.9, forest: 0.45, vegTint: 0.05, vegSat: 0.74, groundWarmth: 0.1, treeNeed: 2.5, corridorLeaf: 0.55, strata: 0.3 }),
  Cwa: prof({ aridity: 0.26, riparian: 0.56, riparianReach: 0.34, groundWarmth: 0.14, snowLineScale: 1.02, treeLineScale: 1.04, forest: 0.6, vegTint: 0.1, vegSat: 1.05, treeNeed: 1.2, corridorLeaf: 0.45, strata: 0.24 }),
  Cwb: prof({ aridity: 0.22, riparian: 0.5, riparianReach: 0.33, groundWarmth: 0.1, treeLineScale: 1.02, forest: 0.58, vegTint: 0.05, vegSat: 1.02, treeNeed: 1, corridorLeaf: 0.45, strata: 0.24 }),
  Cwc: prof({ aridity: 0.22, riparian: 0.44, groundWarmth: 0.08, snowLineScale: 0.94, treeLineScale: 0.92, forest: 0.45, vegSat: 0.95, treeNeed: 1, corridorLeaf: 0.45, strata: 0.26 }),
  Cfa: prof({ aridity: 0.12, riparian: 0.4, riparianReach: 0.32, groundWarmth: 0.05, snowLineScale: 1.02, treeLineScale: 1.05, forest: 0.7, vegTint: 0.05, vegSat: 1.12, treeNeed: 1.2, corridorLeaf: 0.35, strata: 0.2 }),
  // Oceanic country is as much pasture and moor as it is woodland — and the pasture is
  // the greenest thing in the temperate world.
  Cfb: prof({ aridity: 0.08, riparian: 0.34, riparianReach: 0.3, groundWarmth: 0.02, snowLineScale: 0.88, forest: 0.55, vegTint: -0.02, vegSat: 1.15, treeNeed: 0.8, corridorLeaf: 0.35, strata: 0.16 }),
  Cfc: prof({ aridity: 0.08, riparian: 0.3, riparianReach: 0.3, groundWarmth: 0.02, snowLineScale: 0.8, treeLineScale: 0.9, forest: 0.32, vegTint: -0.1, vegSat: 0.92, treeNeed: 1.5, corridorLeaf: 0.4, strata: 0.2 }),
  Dsa: prof({ aridity: 0.48, riparian: 0.68, riparianReach: 0.36, groundWarmth: 0.24, snowLineScale: 1.2, treeLineScale: 1.28, forest: 0.55, vegTint: 0.22, vegSat: 0.78, treeNeed: 4, corridorLeaf: 0.7, strata: 0.4 }),
  Dsb: prof({ aridity: 0.42, riparian: 0.62, riparianReach: 0.35, groundWarmth: 0.18, snowLineScale: 1.18, treeLineScale: 1.26, forest: 0.62, vegTint: 0.15, vegSat: 0.82, treeNeed: 3, corridorLeaf: 0.68, strata: 0.36 }),
  Dsc: prof({ aridity: 0.34, riparian: 0.52, riparianReach: 0.34, groundWarmth: 0.1, snowLineScale: 1.1, treeLineScale: 1.2, forest: 0.68, vegTint: 0.05, vegSat: 0.85, treeNeed: 2, corridorLeaf: 0.66, strata: 0.32 }),
  Dsd: prof({ aridity: 0.3, riparian: 0.46, riparianReach: 0.33, groundWarmth: 0.06, treeLineScale: 1.1, forest: 0.6, vegSat: 0.8, treeNeed: 2, corridorLeaf: 0.64, strata: 0.32 }),
  Dwa: prof({ aridity: 0.3, riparian: 0.54, riparianReach: 0.34, groundWarmth: 0.12, snowLineScale: 1.18, treeLineScale: 1.32, forest: 0.68, vegTint: 0.08, vegSat: 0.95, treeNeed: 1.5, corridorLeaf: 0.6, strata: 0.28 }),
  Dwb: prof({ aridity: 0.26, riparian: 0.48, riparianReach: 0.33, groundWarmth: 0.08, snowLineScale: 1.15, treeLineScale: 1.3, forest: 0.78, vegSat: 0.95, treeNeed: 1, corridorLeaf: 0.62, strata: 0.24 }),
  Dwc: prof({ aridity: 0.22, riparian: 0.42, groundWarmth: 0.05, snowLineScale: 1.1, treeLineScale: 1.26, forest: 0.85, vegTint: -0.15, vegSat: 0.88, treeNeed: 0.6, corridorLeaf: 0.7, strata: 0.22 }),
  Dwd: prof({ aridity: 0.2, riparian: 0.38, riparianReach: 0.31, groundWarmth: 0.03, treeLineScale: 1.14, forest: 0.78, vegTint: -0.2, vegSat: 0.82, treeNeed: 0.6, corridorLeaf: 0.72, strata: 0.22 }),
  // The montane belt is forest broken by park and meadow, not closed canopy, so it
  // keeps enough warm open ground to read brown rather than blue-green.
  Dfa: prof({ aridity: 0.14, riparian: 0.42, riparianReach: 0.32, groundWarmth: 0.16, snowLineScale: 1.12, treeLineScale: 1.3, forest: 0.7, vegTint: 0.02, treeNeed: 1.2, corridorLeaf: 0.5, strata: 0.22 }),
  Dfb: prof({ aridity: 0.12, riparian: 0.38, riparianReach: 0.31, groundWarmth: 0.13, snowLineScale: 1.16, treeLineScale: 1.35, forest: 0.8, vegTint: -0.1, vegSat: 0.95, treeNeed: 0.8, corridorLeaf: 0.6, strata: 0.2 }),
  // The boreal and subalpine conifer belt — the darkest ground cover on the planet, and
  // decidedly blue: spruce and fir read closer to slate than to leaf green. A creek here
  // is a bright broadleaf ribbon against all that, so the contrast is at its highest.
  Dfc: prof({ aridity: 0.14, riparian: 0.34, riparianReach: 0.3, groundWarmth: 0.98, snowLineScale: 1.2, treeLineScale: 1.4, forest: 0.92, vegTint: -0.28, vegSat: 0.8, treeNeed: 0.5, corridorLeaf: 0.85, strata: 0.22 }),
  Dfd: prof({ aridity: 0.14, riparian: 0.3, riparianReach: 0.3, groundWarmth: 0.07, snowLineScale: 1.05, treeLineScale: 1.18, forest: 0.82, vegTint: -0.32, vegSat: 0.75, treeNeed: 0.7, corridorLeaf: 0.85, strata: 0.24 }),
  // Tundra sits above the tree line by definition, so its own scale is near zero. It
  // never suppresses a neighbour's — the tile takes the highest line any class implies.
  // Its colour is lichen and dwarf birch: olive-brown, barely saturated at all.
  ET: prof({ aridity: 0.36, riparian: 0.26, riparianReach: 0.28, groundWarmth: 0.06, snowLineScale: 0.95, treeLineScale: 0.3, forest: 0, vegTint: 0.18, vegSat: 0.55, treeNeed: 2000, corridorLeaf: 0.3, strata: 0.5 }),
  EF: prof({ aridity: 0.24, riparian: 0, riparianReach: 0.25, groundWarmth: 0, snowLineScale: 0.12, treeLineScale: 0, forest: 0, vegSat: 0.5, treeNeed: 20000, corridorLeaf: 0, strata: 0.35 }),
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
