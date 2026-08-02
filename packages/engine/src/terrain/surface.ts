import * as THREE from 'three'
import type { TerrainBuild } from './mesh'
import type { SkyModel } from '../atmosphere'
import { terrainFragmentShader, terrainVertexShader } from './shader'

/**
 * The rendered terrain surface.
 *
 * Plain three.js on purpose. It builds a mesh and a material and lets you push values
 * at them; it does not create a renderer, does not own a frame loop, and does not know
 * what a slider is. The host calls `update()` once a frame from whatever loop it
 * already has, which is what lets this drop into a scene that is already running.
 */

export type SurfaceTextureMode = 'procedural' | 'satellite' | 'drainage'

/**
 * Everything the surface shades from.
 *
 * Deliberately its own type rather than a slice of the builder's `Settings`. The
 * builder maps into this, which is the whole point of the split: the engine takes
 * final values, and nothing here implies a UI control exists for any of them. Several
 * fields are pre-folded by the caller — `snowLine` arrives with any seasonal scrub
 * already applied, and the three `osm*` weights arrive at zero when their layer is
 * off — because the shader has one uniform for each and inventing a second "visible"
 * flag here would just be a switch with nothing behind it.
 */
export interface SurfaceConfig {
  exaggeration: number
  textureMode: SurfaceTextureMode
  wireframe: boolean

  snowLine: number
  treeLine: number
  aridity: number
  strata: number
  riparian: number
  riparianReach: number
  groundWarmth: number

  forest: number
  vegTint: number
  vegSat: number
  treeNeed: number
  treeLimit: number
  treeSpread: number
  treeFractal: number
  treeRough: number
  treeRoughScale: number
  corridorLeaf: number
  showTrees: boolean
  showGrass: boolean
  showSnow: boolean

  rivers: number
  riverThreshold: number
  waveHeight: number
  showRivers: boolean
  showLakes: boolean

  showRoads: boolean
  roadDarkness: number
  roadClearing: number
  roadTint: number
  /** How brightly the verge band lifts against the ground, so the dark surface reads. */
  roadShoulder: number

  /** Already zeroed by the caller when the layer is switched off. */
  osmWater: number
  osmWood: number
  osmBuilt: number

  textureRange: number
  shadows: boolean
  aoStrength: number
  microDetail: number
  fogDensity: number
}

/**
 * The optional field textures.
 *
 * All nullable: a box with nothing mapped in it is a normal outcome, not a failure,
 * and the shader is written to fall through to its procedural path for any of these
 * that is absent.
 */
export interface SurfaceLayers {
  /** Satellite or aerial imagery draped on the surface. */
  imagery?: THREE.Texture | null
  /**
   * A close-up refetch of the imagery covering just part of the box, with the part
   * it covers in terrain UV space (x0, y0 = north-west corner; x1, y1 = south-east).
   * The shader composites it over the base drape with a feathered seam. Both or
   * neither: a patch without its rectangle has no meaning.
   */
  imageryPatch?: THREE.Texture | null
  imageryPatchRect?: readonly [number, number, number, number] | null
  /** RGBA hydrology field: coverage, lake flag, log drainage. */
  water?: THREE.Texture | null
  /** RGBA climate field: aridity, riparian, ground warmth, tree cover. */
  biome?: THREE.Texture | null
  /** RGBA road field: surface, class, cleared corridor. */
  road?: THREE.Texture | null
  /** RGBA observed-area field: water, woodland, built-up. */
  area?: THREE.Texture | null
}

/** Stand-in bound to every optional sampler so the shader always has something to read. */
const BLANK = new THREE.Texture()

export class TerrainSurface {
  readonly mesh: THREE.Mesh
  readonly material: THREE.ShaderMaterial

  private readonly uniforms: Record<string, THREE.IUniform>
  private frames = 0

  constructor(build: TerrainBuild) {
    // Built once and mutated in place from here on. This object must NEVER be
    // replaced: three caches its uniform upload list against the uniform objects
    // present when the program was compiled, so assigning a new `material.uniforms`
    // leaves the renderer uploading the old values until something forces a
    // recompile. That was the cause of shadows breaking whenever vertical
    // exaggeration changed — the shader kept sampling the previous height texture
    // and exaggeration until a recompile happened to catch up a frame later.
    this.uniforms = {
      uNormalMap: { value: build.normalTexture },
      uHeightMap: { value: build.heightTexture },
      uSatMap: { value: BLANK },
      uUseSat: { value: 0 },
      uSatDetail: { value: 1 },
      uSatPatchMap: { value: BLANK },
      uSatPatchRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      uHasSatPatch: { value: 0 },
      uWaterMap: { value: BLANK },
      uHasWater: { value: 0 },
      uRivers: { value: 0 },
      uRiverThreshold: { value: 0 },
      uShowRivers: { value: 1 },
      uShowLakes: { value: 1 },
      uDrainageView: { value: 0 },
      uTime: { value: 0 },
      uWaveHeight: { value: 0 },
      uMinElev: { value: build.minElevation },
      uMaxElev: { value: build.maxElevation },
      uExag: { value: 1 },
      uWidthM: { value: build.widthMetres },
      uDepthM: { value: build.depthMetres },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSkyColor: { value: new THREE.Color(0, 0, 0) },
      uHorizonColor: { value: new THREE.Color(0, 0, 0) },
      uGroundTint: { value: new THREE.Color(0, 0, 0) },
      uSnowLine: { value: 0 },
      uTreeLine: { value: 0 },
      uAridity: { value: 0 },
      uStrata: { value: 0 },
      uRiparian: { value: 0 },
      uRiparianReach: { value: 0 },
      uGroundWarmth: { value: 0 },
      uForest: { value: 0 },
      uVegTint: { value: 0 },
      uVegSat: { value: 1 },
      uTreeNeed: { value: 0 },
      uTreeLimit: { value: 0 },
      uTreeSpread: { value: 0 },
      uTreeFractal: { value: 0 },
      uTreeRough: { value: 0 },
      uTreeRoughScale: { value: 1 },
      uCorridorLeaf: { value: 0 },
      uShowTrees: { value: 1 },
      uShowGrass: { value: 1 },
      uShowSnow: { value: 1 },
      uBiomeMap: { value: BLANK },
      uHasBiomeMap: { value: 0 },
      uRoadMap: { value: BLANK },
      uHasRoads: { value: 0 },
      uShowRoads: { value: 1 },
      uRoadDarkness: { value: 0 },
      uRoadClearing: { value: 0 },
      uRoadTint: { value: 0 },
      uRoadShoulder: { value: 0 },
      uAreaMap: { value: BLANK },
      uHasAreas: { value: 0 },
      uOsmWater: { value: 0 },
      uOsmWood: { value: 0 },
      uOsmBuilt: { value: 0 },
      uTextureRange: { value: 1 },
      uShadows: { value: 0 },
      uAoStrength: { value: 0 },
      uDetail: { value: 0 },
      uFogDensity: { value: 0 },
      uSeaLevel: { value: 0 },
    }

    this.material = new THREE.ShaderMaterial({
      vertexShader: terrainVertexShader,
      fragmentShader: terrainFragmentShader,
      uniforms: this.uniforms,
    })

    // Named so a host can find it by name to raycast against — walking a camera over
    // the ground, dropping an object onto it — without groping through the scene
    // graph for whatever happens to be carrying the terrain material.
    this.mesh = new THREE.Mesh(build.geometry, this.material)
    this.mesh.name = 'terrain'
    this.mesh.frustumCulled = false
  }

  /** Swap in a rebuilt mesh — a resolution or exaggeration change — keeping the material. */
  setBuild(build: TerrainBuild): void {
    this.mesh.geometry = build.geometry
    const u = this.uniforms
    u.uNormalMap!.value = build.normalTexture
    u.uHeightMap!.value = build.heightTexture
    u.uMinElev!.value = build.minElevation
    u.uMaxElev!.value = build.maxElevation
    u.uWidthM!.value = build.widthMetres
    u.uDepthM!.value = build.depthMetres
  }

  setSky(sky: SkyModel): void {
    const u = this.uniforms
    ;(u.uSunDir!.value as THREE.Vector3).copy(sky.sunDirection)
    ;(u.uSunColor!.value as THREE.Color).copy(sky.sunColor)
    ;(u.uSkyColor!.value as THREE.Color).copy(sky.skyColor)
    ;(u.uHorizonColor!.value as THREE.Color).copy(sky.horizonColor)
    ;(u.uGroundTint!.value as THREE.Color).copy(sky.groundTint)
  }

  setLayers(layers: SurfaceLayers): void {
    const u = this.uniforms
    u.uSatMap!.value = layers.imagery ?? BLANK
    const patchReady = !!layers.imageryPatch && !!layers.imageryPatchRect
    u.uSatPatchMap!.value = patchReady ? layers.imageryPatch! : BLANK
    if (patchReady) {
      const [x0, y0, x1, y1] = layers.imageryPatchRect!
      ;(u.uSatPatchRect!.value as THREE.Vector4).set(x0, y0, x1, y1)
    }
    u.uHasSatPatch!.value = patchReady ? 1 : 0
    u.uWaterMap!.value = layers.water ?? BLANK
    u.uHasWater!.value = layers.water ? 1 : 0
    u.uBiomeMap!.value = layers.biome ?? BLANK
    u.uHasBiomeMap!.value = layers.biome ? 1 : 0
    u.uRoadMap!.value = layers.road ?? BLANK
    u.uHasRoads!.value = layers.road ? 1 : 0
    u.uAreaMap!.value = layers.area ?? BLANK
    u.uHasAreas!.value = layers.area ? 1 : 0
    this.hasImagery = !!layers.imagery
    this.hasWater = !!layers.water
    this.applyTextureMode()
  }

  private hasImagery = false
  private hasWater = false
  private mode: SurfaceTextureMode = 'procedural'

  /**
   * Resolve the alternative views, which depend on both the mode and whether the
   * texture that view needs is actually present.
   *
   * Kept in one place called by both setters rather than computed in whichever ran
   * last: asking for satellite before the imagery arrives is the normal order of
   * events, and a caller should not have to know that `setLayers` has to come first.
   */
  private applyTextureMode(): void {
    const u = this.uniforms
    u.uUseSat!.value = this.mode === 'satellite' && this.hasImagery ? 1 : 0
    u.uDrainageView!.value = this.mode === 'drainage' && this.hasWater ? 1 : 0
  }

  setConfig(c: SurfaceConfig): void {
    const u = this.uniforms
    u.uExag!.value = c.exaggeration
    u.uSnowLine!.value = c.snowLine
    u.uTreeLine!.value = c.treeLine
    u.uAridity!.value = c.aridity
    u.uStrata!.value = c.strata
    u.uRiparian!.value = c.riparian
    u.uRiparianReach!.value = c.riparianReach
    u.uGroundWarmth!.value = c.groundWarmth
    u.uForest!.value = c.forest
    u.uVegTint!.value = c.vegTint
    u.uVegSat!.value = c.vegSat
    u.uTreeNeed!.value = c.treeNeed
    u.uTreeLimit!.value = c.treeLimit
    u.uTreeSpread!.value = c.treeSpread
    u.uTreeFractal!.value = c.treeFractal
    u.uTreeRough!.value = c.treeRough
    u.uTreeRoughScale!.value = c.treeRoughScale
    u.uCorridorLeaf!.value = c.corridorLeaf
    u.uShowTrees!.value = c.showTrees ? 1 : 0
    u.uShowGrass!.value = c.showGrass ? 1 : 0
    u.uShowSnow!.value = c.showSnow ? 1 : 0
    u.uRivers!.value = c.rivers
    u.uRiverThreshold!.value = c.riverThreshold
    u.uWaveHeight!.value = c.waveHeight
    u.uShowRivers!.value = c.showRivers ? 1 : 0
    u.uShowLakes!.value = c.showLakes ? 1 : 0
    u.uShowRoads!.value = c.showRoads ? 1 : 0
    u.uRoadDarkness!.value = c.roadDarkness
    u.uRoadClearing!.value = c.roadClearing
    u.uRoadTint!.value = c.roadTint
    u.uRoadShoulder!.value = c.roadShoulder
    u.uOsmWater!.value = c.osmWater
    u.uOsmWood!.value = c.osmWood
    u.uOsmBuilt!.value = c.osmBuilt
    u.uTextureRange!.value = c.textureRange
    u.uShadows!.value = c.shadows ? 1 : 0
    u.uAoStrength!.value = c.aoStrength
    u.uDetail!.value = c.microDetail
    u.uFogDensity!.value = c.fogDensity

    this.mode = c.textureMode
    this.applyTextureMode()

    this.material.wireframe = c.wireframe
  }

  /** Advance animated uniforms. Call once a frame, before the host renders. */
  update(dt: number): void {
    this.uniforms.uTime!.value = (this.uniforms.uTime!.value as number) + dt

    // The very first program compiled for a fresh ShaderMaterial can latch stale
    // uniform locations, freezing whatever was bound at compile time — so force one
    // recompile after a frame has actually gone through. Only once: `needsUpdate`
    // every frame would recompile the shader every frame.
    if (++this.frames === 2) this.material.needsUpdate = true
  }

  /**
   * Release GPU resources this object created.
   *
   * The geometry and the field textures belong to whoever built them and are left
   * alone — a build is routinely handed to a new surface, and disposing a texture out
   * from under its owner is the kind of fault that shows up two screens away.
   */
  dispose(): void {
    this.material.dispose()
  }
}
