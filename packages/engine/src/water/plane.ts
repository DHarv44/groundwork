import * as THREE from 'three'
import type { TerrainBuild } from '../terrain/mesh'
import type { SkyModel } from '../atmosphere'
import { waterFragmentShader, waterVertexShader } from './shader'

/**
 * A single plane at sea level.
 *
 * The fragment shader discards anywhere the terrain sits above water, so coastlines
 * and lake basins fall out of the DEM for free rather than needing a traced shoreline.
 */

export interface WaterConfig {
  exaggeration: number
  /** Sea level in real metres — raise it to drown the box. */
  seaLevel: number
  shoreCutoff: number
  shoreFeather: number
  depthFade: number
  waveHeight: number
  foamWidth: number
  opacity: number
  fogDensity: number
}

export class WaterPlane {
  readonly mesh: THREE.Mesh
  readonly material: THREE.ShaderMaterial

  private readonly uniforms: Record<string, THREE.IUniform>
  private build: TerrainBuild
  private frames = 0
  private seaLevel = 0
  private exaggeration = 1

  constructor(build: TerrainBuild) {
    this.build = build

    // Built once and mutated in place. See the note in TerrainSurface — replacing this
    // object leaves three uploading stale values until something forces a recompile.
    this.uniforms = {
      uHeightMap: { value: build.heightTexture },
      uMinElev: { value: build.minElevation },
      uMaxElev: { value: build.maxElevation },
      uExag: { value: 1 },
      uWidthM: { value: build.widthMetres },
      uDepthM: { value: build.depthMetres },
      uSeaLevelY: { value: 0 },
      uShoreCutoff: { value: 0 },
      uShoreFeather: { value: 0 },
      uDepthFade: { value: 0 },
      uWaveHeight: { value: 0 },
      uFoamWidth: { value: 0 },
      uOpacity: { value: 1 },
      uTime: { value: 0 },
      uHasBathymetry: { value: build.minElevation < -2 ? 1 : 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSkyColor: { value: new THREE.Color(0, 0, 0) },
      uHorizonColor: { value: new THREE.Color(0, 0, 0) },
      uFogDensity: { value: 0 },
    }

    this.material = new THREE.ShaderMaterial({
      vertexShader: waterVertexShader,
      fragmentShader: waterFragmentShader,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Nudge the plane toward the camera in depth, to stop it z-fighting the sea
      // floor. Over flat coast the two are almost coplanar for tens of kilometres, and
      // the small vertical lift that separates them at a steep viewing angle is not
      // enough once you tilt toward grazing: their depths converge in screen space and
      // pixels start alternating between the two surfaces.
      //
      // The factor term scales the offset by the polygon's depth slope, which is
      // exactly the quantity that grows as you tilt — so this targets the failure where
      // it actually happens rather than shifting the plane everywhere.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
    })

    this.mesh = new THREE.Mesh(this.makeGeometry(), this.material)
    this.mesh.name = 'water'
    this.mesh.rotation.x = -Math.PI / 2
    this.mesh.renderOrder = 1
  }

  private makeGeometry(): THREE.PlaneGeometry {
    return new THREE.PlaneGeometry(this.build.widthMetres, this.build.depthMetres, 1, 1)
  }

  setBuild(build: TerrainBuild): void {
    const resize =
      build.widthMetres !== this.build.widthMetres || build.depthMetres !== this.build.depthMetres
    this.build = build

    const u = this.uniforms
    u.uHeightMap!.value = build.heightTexture
    u.uMinElev!.value = build.minElevation
    u.uMaxElev!.value = build.maxElevation
    u.uWidthM!.value = build.widthMetres
    u.uDepthM!.value = build.depthMetres
    u.uHasBathymetry!.value = build.minElevation < -2 ? 1 : 0

    if (resize) {
      this.mesh.geometry.dispose()
      this.mesh.geometry = this.makeGeometry()
    }
    this.place()
  }

  setSky(sky: SkyModel): void {
    const u = this.uniforms
    ;(u.uSunDir!.value as THREE.Vector3).copy(sky.sunDirection)
    ;(u.uSunColor!.value as THREE.Color).copy(sky.sunColor)
    ;(u.uSkyColor!.value as THREE.Color).copy(sky.skyColor)
    ;(u.uHorizonColor!.value as THREE.Color).copy(sky.horizonColor)
  }

  setConfig(c: WaterConfig): void {
    const u = this.uniforms
    u.uExag!.value = c.exaggeration
    u.uShoreCutoff!.value = c.shoreCutoff
    u.uShoreFeather!.value = c.shoreFeather
    u.uDepthFade!.value = c.depthFade
    u.uWaveHeight!.value = c.waveHeight
    u.uFoamWidth!.value = c.foamWidth
    u.uOpacity!.value = c.opacity
    u.uFogDensity!.value = c.fogDensity
    // Sea level is a real elevation, so it scales with exaggeration like the terrain.
    u.uSeaLevelY!.value = c.seaLevel * c.exaggeration

    this.seaLevel = c.seaLevel
    this.exaggeration = c.exaggeration
    this.place()
  }

  /**
   * Position the plane, and hide it for terrain that never reaches the sea.
   *
   * Hidden rather than removed so the host does not have to add and drop an object
   * from its scene as a slider crosses a threshold — raising sea level over a
   * mountain box is a normal thing to do and should not restructure the graph.
   */
  private place(): void {
    this.mesh.visible = this.build.minElevation <= this.seaLevel + 0.5

    // Land-only DEMs record the sea surface as exactly 0 m, which puts the water plane
    // coplanar with the terrain and sets off z-fighting. Float it just clear of the bed.
    const relief = this.build.maxElevation - this.build.minElevation
    const lift = Math.max(0.5, relief * 0.0015) * this.exaggeration
    this.mesh.position.y = this.seaLevel * this.exaggeration + lift
  }

  /** Advance the wave animation. Call once a frame, before the host renders. */
  update(dt: number): void {
    this.uniforms.uTime!.value = (this.uniforms.uTime!.value as number) + dt
    // One forced recompile after a frame has gone through — see TerrainSurface.
    if (++this.frames === 2) this.material.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
