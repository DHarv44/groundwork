import * as THREE from 'three'
import type { SkyModel } from '../atmosphere'
import { skyFragmentShader, skyVertexShader } from './shader'

/**
 * The sky dome — an inside-out sphere carrying the atmosphere model's gradient.
 *
 * Kept centred on the camera by `update()`, so it never clips however far you fly.
 * That is also why it is drawn first and writes no depth: it is a backdrop, not
 * geometry, and nothing should ever be occluded by it.
 */
export class SkyDome {
  readonly mesh: THREE.Mesh
  readonly material: THREE.ShaderMaterial

  private readonly uniforms: Record<string, THREE.IUniform>
  private radius: number

  constructor(radius: number) {
    this.radius = radius

    this.uniforms = {
      uSkyColor: { value: new THREE.Color(0, 0, 0) },
      uHorizonColor: { value: new THREE.Color(0, 0, 0) },
      uGroundTint: { value: new THREE.Color(0, 0, 0) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uHaze: { value: 0 },
    }

    this.material = new THREE.ShaderMaterial({
      vertexShader: skyVertexShader,
      fragmentShader: skyFragmentShader,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
    })

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), this.material)
    this.mesh.name = 'sky'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -1
  }

  setSky(sky: SkyModel): void {
    const u = this.uniforms
    ;(u.uSkyColor!.value as THREE.Color).copy(sky.skyColor)
    ;(u.uHorizonColor!.value as THREE.Color).copy(sky.horizonColor)
    ;(u.uGroundTint!.value as THREE.Color).copy(sky.groundTint)
    ;(u.uSunDir!.value as THREE.Vector3).copy(sky.sunDirection)
    ;(u.uSunColor!.value as THREE.Color).copy(sky.sunColor)
  }

  setHaze(haze: number): void {
    this.uniforms.uHaze!.value = haze
  }

  setRadius(radius: number): void {
    if (radius === this.radius) return
    this.radius = radius
    this.mesh.geometry.dispose()
    this.mesh.geometry = new THREE.SphereGeometry(radius, 48, 32)
  }

  /** Keep the dome on the camera. Call once a frame, before the host renders. */
  update(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position)
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
