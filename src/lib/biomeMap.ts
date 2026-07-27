/**
 * Bakes the biomes inside a bounding box into a texture the terrain shader can sample.
 *
 * The trick is not to store *which* biome each texel is and look its profile up in the
 * shader, but to store the profile numbers themselves — aridity, riparian strength,
 * ground warmth and corridor reach, one per channel. Two things fall out of that:
 * blending between neighbouring classes is free, because the GPU's linear filtering
 * already does it, and the shader needs no lookup table and no branching.
 *
 * The Köppen raster is 0.1° (~11 km), so a tile is only a few tens of cells across.
 * That is coarse, and it would read as blocks if written straight out — so the field is
 * feathered by about one raster cell. This is not a fudge to hide the resolution: real
 * biome boundaries are tens of kilometres wide, and a soft transition from steppe to
 * montane forest is the more truthful picture. What the coarseness does cost is
 * *placement* — a boundary is in the right general area, not surveyed.
 */

import { profileFor, type BiomeProfile } from './climate'
import type { Bounds } from './geo'
import { KOPPEN_CODES, classAt } from './koppen'

/** Resolution of the baked field. Far finer than the raster; the blur does the rest. */
const SIZE = 256

/** Cell size of the source raster, degrees. */
const RASTER_DEG = 0.1

/** Classes below this share of the box are raster edge noise, not a biome present. */
const MIN_SHARE = 0.02

/**
 * Ground warmth runs past 1, so it cannot go into a byte channel raw. It is stored
 * divided by this and multiplied back out in the shader — the slider and the encoding
 * have to agree, so both read it from here.
 */
export const GROUND_WARMTH_MAX = 2

export interface BiomeShare {
  code: string
  /** Fraction of the box's land this class covers, 0..1. */
  share: number
}

export interface BiomeField {
  /**
   * RGBA8: aridity, riparian, groundWarmth, tree cover. Row 0 is the north edge.
   *
   * Corridor reach is deliberately not here. There are only four channels and tree
   * cover earns one far more: reach spans 0.28–0.44 across all thirty classes, so it
   * barely varies in space, while cover runs the whole way from bare tundra to closed
   * rainforest and drives the tone of the ground.
   *
   * Pinned to ArrayBuffer, not ArrayBufferLike, so it stays a valid texture source.
   */
  data: Uint8Array<ArrayBuffer>
  width: number
  height: number
  /** Every class present, largest first. Drives the panel's readout. */
  composition: BiomeShare[]
  /** The class covering most of the box — the one the sliders speak for. */
  dominant: string
}

/** Per-class values you have tuned, keyed by Köppen code. */
export type ProfileOverrides = Record<string, Partial<Record<string, number>>>

function resolve(code: string, overrides: ProfileOverrides): BiomeProfile {
  const base = profileFor(code)
  const mine = overrides[code]
  if (!mine) return base
  return {
    ...base,
    aridity: mine.aridity ?? base.aridity,
    riparian: mine.riparian ?? base.riparian,
    riparianReach: mine.riparianReach ?? base.riparianReach,
    groundWarmth: mine.groundWarmth ?? base.groundWarmth,
    forest: mine.forest ?? base.forest,
  }
}

/** Separable box blur over one channel of an RGBA buffer, radius in texels. */
function blurChannel(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius < 1) return src
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const span = radius * 2 + 1

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let k = -radius; k <= radius; k++) {
        sum += src[y * w + Math.min(w - 1, Math.max(0, x + k))]
      }
      tmp[y * w + x] = sum / span
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let sum = 0
      for (let k = -radius; k <= radius; k++) {
        sum += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]
      }
      out[y * w + x] = sum / span
    }
  }
  return out
}

/**
 * Build the field for a box. Returns null if the box has no land in it at all, in which
 * case there is no biome to render and the caller should leave the sliders alone.
 */
export function buildBiomeField(bounds: Bounds, overrides: ProfileOverrides = {}): BiomeField | null {
  const { north, south, east, west } = bounds
  const w = SIZE
  const h = SIZE

  // Class index per texel, and the tally that becomes the composition readout.
  const index = new Uint8Array(w * h)
  const tally = new Uint32Array(KOPPEN_CODES.length)
  let land = 0

  for (let y = 0; y < h; y++) {
    // Row 0 is the north edge, matching the DEM and the water mask.
    const lat = north - ((y + 0.5) / h) * (north - south)
    for (let x = 0; x < w; x++) {
      const lon = west + ((x + 0.5) / w) * (east - west)
      const c = classAt(lat, lon)
      index[y * w + x] = c
      if (c > 0) {
        tally[c]++
        land++
      }
    }
  }

  if (!land) return null

  const composition: BiomeShare[] = []
  for (let c = 1; c < tally.length; c++) {
    if (tally[c] > 0) composition.push({ code: KOPPEN_CODES[c], share: tally[c] / land })
  }
  composition.sort((a, b) => b.share - a.share)
  const dominant = composition[0].code

  // Sea and no-data texels take the dominant profile. Anything else — leaving them
  // black, or transparent — would pull a dark seam along every coastline once blurred.
  const fallback = resolve(dominant, overrides)
  const cache = new Map<number, BiomeProfile>()
  const profileAt = (c: number): BiomeProfile => {
    if (!c) return fallback
    let p = cache.get(c)
    if (!p) {
      p = resolve(KOPPEN_CODES[c], overrides)
      cache.set(c, p)
    }
    return p
  }

  const ar = new Float32Array(w * h)
  const rip = new Float32Array(w * h)
  const warm = new Float32Array(w * h)
  const trees = new Float32Array(w * h)

  for (let i = 0; i < w * h; i++) {
    const p = profileAt(index[i])
    ar[i] = p.aridity
    rip[i] = p.riparian
    warm[i] = p.groundWarmth
    trees[i] = p.forest
  }

  // Feather by about one raster cell, measured in texels of this field. A box that
  // spans many raster cells gets a proportionally tighter blur, so the transition is
  // always ~11 km on the ground rather than a fixed fraction of the tile.
  const texelsPerDegLat = h / Math.max(1e-6, north - south)
  const radius = Math.max(1, Math.min(48, Math.round(RASTER_DEG * texelsPerDegLat * 0.6)))

  const arB = blurChannel(ar, w, h, radius)
  const ripB = blurChannel(rip, w, h, radius)
  const warmB = blurChannel(warm, w, h, radius)
  const treesB = blurChannel(trees, w, h, radius)

  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = Math.round(Math.min(1, Math.max(0, arB[i])) * 255)
    data[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, ripB[i])) * 255)
    // Scaled into the channel; the shader multiplies it back out.
    data[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, warmB[i] / GROUND_WARMTH_MAX)) * 255)
    data[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, treesB[i])) * 255)
  }

  return {
    data,
    width: w,
    height: h,
    composition: composition.filter((c) => c.share >= MIN_SHARE),
    dominant,
  }
}
