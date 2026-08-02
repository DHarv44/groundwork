import type { HeightField } from './opentopo'

/**
 * A synthetic massif, for when the OpenTopography allowance is spent.
 *
 * Built from ridged multifractal noise rather than plain fbm, because ridged noise
 * produces sharp divides and V-shaped valleys — which means the hydrology pass finds a
 * believable dendritic drainage network, exactly as it would on real ground.
 */

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  return s - Math.floor(s)
}

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = hash2(ix, iy)
  const b = hash2(ix + 1, iy)
  const c = hash2(ix, iy + 1)
  const d = hash2(ix + 1, iy + 1)
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy
}

function ridged(x: number, y: number, octaves: number): number {
  let sum = 0
  let amp = 0.5
  let freq = 1
  let weight = 1
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(valueNoise(x * freq, y * freq) * 2 - 1)
    n *= n * weight
    weight = Math.min(1, n * 2)
    sum += n * amp
    amp *= 0.52
    freq *= 2.04
  }
  return sum
}

export function makeDemoHeightField(): HeightField {
  const size = 640
  const data = new Float32Array(size * size)

  let min = Infinity
  let max = -Infinity

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * 6
      const v = (y / size) * 6

      // Domain warp keeps the ridges from looking like a regular lattice.
      const wx = u + valueNoise(u * 0.5 + 11.3, v * 0.5 + 4.1) * 1.1
      const wy = v + valueNoise(u * 0.5 + 2.7, v * 0.5 + 19.4) * 1.1

      const ridges = ridged(wx, wy, 7)
      const rolling = valueNoise(u * 0.35 + 5.5, v * 0.35 + 8.2)

      // Fall away toward the edges so drainage leaves the tile instead of pooling.
      const cx = x / size - 0.5
      const cy = y / size - 0.5
      const falloff = 1 - Math.min(1, Math.hypot(cx, cy) * 1.55)

      // Fine roughness matters more than it looks: a perfectly smooth slope drains in
      // dead-straight parallel lines, so without it the drainage network looks
      // synthetic. Real ground is never this clean.
      const grain =
        valueNoise(u * 7.3 + 31.2, v * 7.3 + 17.8) * 26 +
        valueNoise(u * 17.1 + 3.4, v * 17.1 + 25.9) * 11

      const h = 480 + ridges * 2650 * (0.35 + 0.65 * falloff) + rolling * 320 + grain
      data[y * size + x] = h
      if (h < min) min = h
      if (h > max) max = h
    }
  }

  // Roughly an 18 km square in the Alps, so the climatic snow and tree lines land
  // somewhere sensible for the terrain this generates.
  const midLat = 46.5
  const halfLat = 9000 / 111132
  const halfLon = 9000 / (111412 * Math.cos((midLat * Math.PI) / 180))

  return {
    width: size,
    height: size,
    data,
    bounds: {
      south: midLat - halfLat,
      north: midLat + halfLat,
      west: 8 - halfLon,
      east: 8 + halfLon,
    },
    min,
    max,
    demtype: 'DEMO',
    voids: 0,
  }
}
