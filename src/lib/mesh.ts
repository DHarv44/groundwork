import * as THREE from 'three'
import type { HeightField } from './opentopo'
import { boundsExtentMetres } from './geo'

export interface TerrainBuild {
  geometry: THREE.BufferGeometry
  /** High-resolution surface normals, RGB-encoded, at (up to) native DEM resolution. */
  normalTexture: THREE.DataTexture
  /** Normalised elevation (0..1 across min..max), single channel float. */
  heightTexture: THREE.DataTexture
  widthMetres: number
  depthMetres: number
  minElevation: number
  maxElevation: number
  /** World-space Y of mean sea level, given the current exaggeration. */
  seaLevelY: number
  /** World-space Y of the underside of the plinth. */
  baseY: number
  vertices: number
  triangles: number
  gridX: number
  gridY: number
}

const MAX_NORMAL_TEX = 4096

/** Bilinear sample of the height field in fractional grid coordinates. */
function sampleBilinear(hf: HeightField, fx: number, fy: number): number {
  const { width, height, data } = hf
  const x = Math.max(0, Math.min(width - 1, fx))
  const y = Math.max(0, Math.min(height - 1, fy))
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const tx = x - x0
  const ty = y - y0
  const a = data[y0 * width + x0]
  const b = data[y0 * width + x1]
  const c = data[y1 * width + x0]
  const d = data[y1 * width + x1]
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
}

/**
 * Turn a height field into a renderable mesh.
 *
 * The grid is laid out in real metres (X = east, Z = south, Y = up) so horizontal and
 * vertical scales are directly comparable — exaggeration of 1.0 is the true shape of
 * the ground. Normals are derived analytically from the DEM rather than from the mesh,
 * so shading stays crisp even when the mesh is decimated.
 */
export function buildTerrain(
  hf: HeightField,
  opts: { detail: number; exaggeration: number },
): TerrainBuild {
  const { width: demW, height: demH } = hf
  const extent = boundsExtentMetres(hf.bounds)
  const widthMetres = extent.width
  const depthMetres = extent.height

  // Keep the mesh grid proportional to the ground so triangles stay near-equilateral.
  const aspect = widthMetres / depthMetres
  const target = Math.max(32, Math.min(opts.detail, Math.max(demW, demH)))
  let gridX: number
  let gridY: number
  if (aspect >= 1) {
    gridX = Math.min(target, demW)
    gridY = Math.max(32, Math.round(gridX / aspect))
  } else {
    gridY = Math.min(target, demH)
    gridX = Math.max(32, Math.round(gridY * aspect))
  }

  // Skirt walls plus a bottom cap turn the surface into a closed solid: no void to see
  // under the tile when the camera drops low, and a watertight (printable) STL export.
  const perimeter = 2 * (gridX + gridY) - 4
  const topCount = gridX * gridY
  const vertCount = topCount + perimeter + 1
  const positions = new Float32Array(vertCount * 3)
  const uvs = new Float32Array(vertCount * 2)
  const normals = new Float32Array(vertCount * 3)
  // 0 = terrain surface, 1 = plinth. The shader shades the two differently.
  const sides = new Float32Array(vertCount)

  const exag = opts.exaggeration
  // DEM tiles are area-based: sample (i,j) is the value *for the cell* spanning
  // [i, i+1), so its centre sits at i + 0.5 and adjacent centres are one full cell
  // apart. Treating samples as sitting on the bbox edges instead — spacing them
  // widthMetres/(demW-1) and reading position i at parameter i/(demW-1) — shifts the
  // whole surface half a cell west and stretches it by demW/(demW-1). That is why
  // derived water sat off its banks: the mask is placed correctly in the bbox, and it
  // was the terrain underneath that was displaced.
  const dxMetres = widthMetres / demW
  const dyMetres = depthMetres / demH

  for (let j = 0; j < gridY; j++) {
    const v = j / (gridY - 1)
    // u and v span the bounding box; convert to sample coordinates on the same
    // area convention the mask and imagery use.
    const fy = v * demH - 0.5
    for (let i = 0; i < gridX; i++) {
      const u = i / (gridX - 1)
      const fx = u * demW - 0.5
      const idx = j * gridX + i
      const h = sampleBilinear(hf, fx, fy)

      positions[idx * 3 + 0] = (u - 0.5) * widthMetres
      positions[idx * 3 + 1] = h * exag
      positions[idx * 3 + 2] = (v - 0.5) * depthMetres

      uvs[idx * 2 + 0] = u
      uvs[idx * 2 + 1] = v

      // Central differences on the source DEM, in metres.
      const hL = sampleBilinear(hf, fx - 1, fy)
      const hR = sampleBilinear(hf, fx + 1, fy)
      const hU = sampleBilinear(hf, fx, fy - 1)
      const hD = sampleBilinear(hf, fx, fy + 1)
      const dhdx = ((hR - hL) / (2 * dxMetres)) * exag
      const dhdz = ((hD - hU) / (2 * dyMetres)) * exag
      const nx = -dhdx
      const ny = 1
      const nz = -dhdz
      const len = Math.hypot(nx, ny, nz) || 1
      normals[idx * 3 + 0] = nx / len
      normals[idx * 3 + 1] = ny / len
      normals[idx * 3 + 2] = nz / len
    }
  }

  // Walk the outer ring clockwise so the skirt quads wind consistently outward.
  const ring: number[] = []
  for (let i = 0; i < gridX; i++) ring.push(i) // north edge, west to east
  for (let j = 1; j < gridY; j++) ring.push(j * gridX + (gridX - 1)) // east edge
  for (let i = gridX - 2; i >= 0; i--) ring.push((gridY - 1) * gridX + i) // south edge
  for (let j = gridY - 2; j >= 1; j--) ring.push(j * gridX) // west edge

  // Sit the base a little below the lowest ground so the plinth is always visible.
  const relief = Math.max(1, hf.max - hf.min)
  const baseY = (hf.min - relief * 0.06 - 1) * exag

  for (let k = 0; k < ring.length; k++) {
    const src = ring[k]
    const dst = topCount + k
    positions[dst * 3 + 0] = positions[src * 3 + 0]
    positions[dst * 3 + 1] = baseY
    positions[dst * 3 + 2] = positions[src * 3 + 2]
    uvs[dst * 2 + 0] = uvs[src * 2 + 0]
    uvs[dst * 2 + 1] = uvs[src * 2 + 1]
    // Outward horizontal normal, away from the tile centre.
    const nx = positions[dst * 3 + 0]
    const nz = positions[dst * 3 + 2]
    const len = Math.hypot(nx, nz) || 1
    normals[dst * 3 + 0] = nx / len
    normals[dst * 3 + 1] = 0
    normals[dst * 3 + 2] = nz / len
    sides[dst] = 1
  }

  const centreIdx = topCount + perimeter
  positions[centreIdx * 3 + 0] = 0
  positions[centreIdx * 3 + 1] = baseY
  positions[centreIdx * 3 + 2] = 0
  uvs[centreIdx * 2 + 0] = 0.5
  uvs[centreIdx * 2 + 1] = 0.5
  normals[centreIdx * 3 + 1] = -1
  sides[centreIdx] = 1

  const quads = (gridX - 1) * (gridY - 1)
  const IndexArray = vertCount > 65535 ? Uint32Array : Uint16Array
  const indices = new IndexArray(quads * 6 + perimeter * 6 + perimeter * 3)
  let p = 0
  for (let j = 0; j < gridY - 1; j++) {
    for (let i = 0; i < gridX - 1; i++) {
      const a = j * gridX + i
      const b = a + 1
      const c = a + gridX
      const d = c + 1
      indices[p++] = a
      indices[p++] = c
      indices[p++] = b
      indices[p++] = b
      indices[p++] = c
      indices[p++] = d
    }
  }

  for (let k = 0; k < perimeter; k++) {
    const k2 = (k + 1) % perimeter
    const topA = ring[k]
    const topB = ring[k2]
    const botA = topCount + k
    const botB = topCount + k2
    indices[p++] = topA
    indices[p++] = botA
    indices[p++] = topB
    indices[p++] = topB
    indices[p++] = botA
    indices[p++] = botB
    // Bottom cap, fanned from the centre and wound to face downward.
    indices[p++] = centreIdx
    indices[p++] = botA
    indices[p++] = botB
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setAttribute('side', new THREE.BufferAttribute(sides, 1))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  geometry.computeBoundingSphere()

  return {
    geometry,
    normalTexture: buildNormalTexture(hf, exag, dxMetres, dyMetres),
    heightTexture: buildHeightTexture(hf),
    widthMetres,
    depthMetres,
    minElevation: hf.min,
    maxElevation: hf.max,
    seaLevelY: 0,
    baseY,
    vertices: vertCount,
    triangles: quads * 2 + perimeter * 3,
    gridX,
    gridY,
  }
}

/** RGB-encoded surface normals at DEM resolution (downsampled if the DEM is huge). */
function buildNormalTexture(
  hf: HeightField,
  exag: number,
  dxMetres: number,
  dyMetres: number,
): THREE.DataTexture {
  const scale = Math.min(1, MAX_NORMAL_TEX / Math.max(hf.width, hf.height))
  const w = Math.max(2, Math.round(hf.width * scale))
  const h = Math.max(2, Math.round(hf.height * scale))
  const px = new Uint8Array(w * h * 4)
  // Texel x is sampled at UV (x+0.5)/w, so it must read the DEM at the matching
  // position — same area convention as the mesh above.
  const sx = hf.width / w
  const sy = hf.height / h
  // Spacing between the samples we actually take, in metres.
  const stepX = dxMetres * sx
  const stepY = dyMetres * sy

  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) * sy - 0.5
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) * sx - 0.5
      const hL = sampleBilinear(hf, fx - sx, fy)
      const hR = sampleBilinear(hf, fx + sx, fy)
      const hU = sampleBilinear(hf, fx, fy - sy)
      const hD = sampleBilinear(hf, fx, fy + sy)
      const dhdx = ((hR - hL) / (2 * stepX)) * exag
      const dhdz = ((hD - hU) / (2 * stepY)) * exag
      let nx = -dhdx
      let ny = 1
      let nz = -dhdz
      const len = Math.hypot(nx, ny, nz) || 1
      nx /= len
      ny /= len
      nz /= len
      const o = (y * w + x) * 4
      px[o + 0] = Math.round((nx * 0.5 + 0.5) * 255)
      px[o + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      px[o + 2] = Math.round((nz * 0.5 + 0.5) * 255)
      px[o + 3] = 255
    }
  }

  const tex = new THREE.DataTexture(px, w, h, THREE.RGBAFormat)
  tex.flipY = false
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.generateMipmaps = true
  tex.anisotropy = 8
  tex.needsUpdate = true
  return tex
}

let floatLinearSupported: boolean | null = null

/**
 * R32F textures only filter smoothly where OES_texture_float_linear exists. It does on
 * essentially every desktop GPU, but fall back to half-float rather than render blocky.
 */
function supportsFloatLinear(): boolean {
  if (floatLinearSupported !== null) return floatLinearSupported
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    floatLinearSupported = !!gl && !!gl.getExtension('OES_texture_float_linear')
  } catch {
    floatLinearSupported = false
  }
  return floatLinearSupported
}

const f32 = new Float32Array(1)
const i32 = new Int32Array(f32.buffer)

/** IEEE-754 single to half precision. */
function toHalf(value: number): number {
  f32[0] = value
  const x = i32[0]
  let bits = (x >> 16) & 0x8000
  let m = (x >> 12) & 0x07ff
  const e = (x >> 23) & 0xff
  if (e < 103) return bits
  if (e > 142) return bits | 0x7c00
  if (e < 113) {
    m |= 0x0800
    return bits + ((m >> (114 - e)) + ((m >> (113 - e)) & 1))
  }
  bits |= ((e - 112) << 10) | (m >> 1)
  return bits + (m & 1)
}

/** Elevation normalised to 0..1, used for altitude-driven material blending. */
function buildHeightTexture(hf: HeightField): THREE.DataTexture {
  const scale = Math.min(1, MAX_NORMAL_TEX / Math.max(hf.width, hf.height))
  const w = Math.max(2, Math.round(hf.width * scale))
  const h = Math.max(2, Math.round(hf.height * scale))
  const range = Math.max(1e-3, hf.max - hf.min)
  // Same texel-centre convention as the normal map.
  const sx = hf.width / w
  const sy = hf.height / h
  const useFloat = supportsFloatLinear()
  const px = useFloat ? new Float32Array(w * h) : new Uint16Array(w * h)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t =
        (sampleBilinear(hf, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5) - hf.min) / range
      px[y * w + x] = useFloat ? t : toHalf(t)
    }
  }

  const tex = new THREE.DataTexture(
    px,
    w,
    h,
    THREE.RedFormat,
    useFloat ? THREE.FloatType : THREE.HalfFloatType,
  )
  tex.flipY = false
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}
