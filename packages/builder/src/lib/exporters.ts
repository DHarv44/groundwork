import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { downloadBlob } from './capture'
import type { HeightField } from './opentopo'
import type { TerrainBuild } from './mesh'

function tempMesh(build: TerrainBuild): THREE.Mesh {
  return new THREE.Mesh(build.geometry, new THREE.MeshStandardMaterial({ color: 0x9a9a9a }))
}

export function exportSTL(build: TerrainBuild, name: string): void {
  const mesh = tempMesh(build)
  const result = new STLExporter().parse(mesh, { binary: true }) as unknown as DataView
  downloadBlob(new Blob([result.buffer as ArrayBuffer], { type: 'model/stl' }), `${name}.stl`)
  ;(mesh.material as THREE.Material).dispose()
}

export function exportGLB(build: TerrainBuild, name: string): void {
  const mesh = tempMesh(build)
  const scene = new THREE.Scene()
  scene.add(mesh)
  new GLTFExporter().parse(
    scene,
    (result) => {
      downloadBlob(new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' }), `${name}.glb`)
      ;(mesh.material as THREE.Material).dispose()
    },
    (err) => console.error('glTF export failed', err),
    { binary: true },
  )
}

/**
 * 16-bit heightmap, split across the red (high byte) and green (low byte) channels.
 * Decode as: elevation = min + (R * 256 + G) / 65535 * (max - min).
 */
export function exportHeightmapPNG(hf: HeightField, name: string): void {
  const canvas = document.createElement('canvas')
  canvas.width = hf.width
  canvas.height = hf.height
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(hf.width, hf.height)
  const range = Math.max(1e-6, hf.max - hf.min)

  for (let i = 0; i < hf.data.length; i++) {
    const v = Math.round(((hf.data[i] - hf.min) / range) * 65535)
    const o = i * 4
    img.data[o + 0] = (v >> 8) & 0xff
    img.data[o + 1] = v & 0xff
    img.data[o + 2] = 0
    img.data[o + 3] = 255
  }
  ctx.putImageData(img, 0, 0)

  const suffix = `_h16_min${Math.round(hf.min)}_max${Math.round(hf.max)}`
  canvas.toBlob((blob) => {
    if (blob) downloadBlob(blob, `${name}${suffix}.png`)
  }, 'image/png')
}
