import type { Bounds } from './geo.js'

/**
 * A rectangle of elevation samples.
 *
 * Row-major with the **north** row first, matching how every raster source hands
 * them over and how the pack's raster planes are stored, so an index computed
 * against one is valid against the other.
 */
export interface HeightField {
  width: number
  height: number
  /** Elevation in metres, row-major, north row first. Voids already filled. */
  data: Float32Array
  /** Actual raster bounds, which may differ slightly from what was requested. */
  bounds: Bounds
  min: number
  max: number
  /** Identifier of the elevation source this came from. */
  demtype: string
  /** Count of samples that were voids in the source raster. */
  voids: number
}

/**
 * Bilinear sample of the height field in fractional grid coordinates.
 *
 * Anything that needs to know where the surface *is* — placing a mesh vertex,
 * standing an object on the ground, walking a camera over it — has to sample it
 * this way, half-cell offset and all. Reimplementing it elsewhere is how a mesh and
 * the things standing on it drift apart.
 */
export function sampleBilinear(hf: HeightField, fx: number, fy: number): number {
  const { width, height, data } = hf
  const x = Math.max(0, Math.min(width - 1, fx))
  const y = Math.max(0, Math.min(height - 1, fy))
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const tx = x - x0
  const ty = y - y0
  const a = data[y0 * width + x0]!
  const b = data[y0 * width + x1]!
  const c = data[y1 * width + x0]!
  const d = data[y1 * width + x1]!
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
}

/**
 * Elevation in metres at a normalised box coordinate.
 *
 * The form an object registry wants: something is placed at a fraction across the
 * box and needs to sit on the ground, without knowing the raster's resolution.
 */
export function sampleBox(hf: HeightField, x: number, y: number): number {
  return sampleBilinear(hf, x * (hf.width - 1), y * (hf.height - 1))
}
