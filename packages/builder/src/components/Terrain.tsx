import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { TerrainSurface, type SkyModel, type SurfaceConfig, type TerrainBuild } from '@dharv44/groundwork-engine'
import { useStore } from '../store'

/**
 * The builder's binding to the renderer.
 *
 * This is the only file that knows both `Settings` and the engine, and that is the
 * point of it: the engine takes final values in its own vocabulary, so everything
 * about how those values got chosen — sliders, presets, biome overrides, layer
 * toggles — stops here. Anything reached for below that the engine does not offer is
 * a sign the engine's config is missing something, not a reason to import the store
 * over there.
 */

interface Props {
  build: TerrainBuild
  sky: SkyModel
  fogDensity: number
  /** Already carries the winter scrub, so the shader never sees the raw setting. */
  snowLine: number
}

export default function Terrain({ build, sky, fogDensity, snowLine }: Props) {
  const settings = useStore((s) => s.settings)
  const imagery = useStore((s) => s.imagery)
  const waterMask = useStore((s) => s.waterMask)
  const biomeMap = useStore((s) => s.biomeMap)
  const roadMask = useStore((s) => s.roadMask)
  const areaMask = useStore((s) => s.areaMask)

  const satTexture = useMemo(() => {
    if (!imagery) return null
    const tex = new THREE.CanvasTexture(imagery)
    tex.flipY = false
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = true
    tex.anisotropy = 16
    tex.needsUpdate = true
    return tex
  }, [imagery])

  useEffect(() => () => satTexture?.dispose(), [satTexture])

  // The clipmap rings ride the same settings as the base drape — same row order,
  // same clamping — so the shader can treat the set as one image at four sharpnesses.
  //
  // Textures are cached per canvas, because texture identity is what the engine keys
  // its fades on: minting a fresh texture for an *unchanged* ring would restart its
  // fade every time a sibling re-centred, and the whole cascade would blink whenever
  // the inner ring moved. Evicted textures are disposed on a delay — the engine keeps
  // a withdrawn ring bound briefly while it eases out, and freeing GPU memory under a
  // bound sampler flashes.
  const satRings = useStore((s) => s.satRings)
  const ringTexCache = useRef(new Map<HTMLCanvasElement, THREE.Texture>())
  const ringLayers = useMemo(() => {
    const cache = ringTexCache.current
    const live = new Set<HTMLCanvasElement>()
    const layers = satRings.map((ring) => {
      if (!ring) return null
      live.add(ring.canvas)
      let tex = cache.get(ring.canvas)
      if (!tex) {
        tex = new THREE.CanvasTexture(ring.canvas)
        tex.flipY = false
        tex.wrapS = THREE.ClampToEdgeWrapping
        tex.wrapT = THREE.ClampToEdgeWrapping
        tex.minFilter = THREE.LinearMipmapLinearFilter
        tex.magFilter = THREE.LinearFilter
        tex.generateMipmaps = true
        tex.anisotropy = 16
        tex.needsUpdate = true
        cache.set(ring.canvas, tex)
      }
      return { texture: tex, rect: ring.rect }
    })
    for (const [canvas, tex] of cache) {
      if (!live.has(canvas)) {
        cache.delete(canvas)
        setTimeout(() => tex.dispose(), 400)
      }
    }
    return layers
  }, [satRings])

  useEffect(
    () => () => {
      for (const tex of ringTexCache.current.values()) tex.dispose()
      ringTexCache.current.clear()
    },
    [],
  )

  // Built once. The surface holds a uniform object that must not be replaced, so the
  // component may re-render freely but the material behind it never gets rebuilt.
  const surface = useMemo(() => new TerrainSurface(build), [])
  useEffect(() => () => surface.dispose(), [surface])

  useEffect(() => {
    surface.setBuild(build)
  }, [surface, build])

  // Pushed every render rather than recompiling the material.
  useEffect(() => {
    surface.setSky(sky)
    surface.setLayers({
      imagery: satTexture,
      imageryRings: ringLayers,
      water: waterMask,
      biome: biomeMap,
      road: roadMask,
      area: areaMask,
    })

    const config: SurfaceConfig = {
      exaggeration: settings.exaggeration,
      textureMode: settings.textureMode,
      wireframe: settings.wireframe,

      snowLine,
      treeLine: settings.treeLine,
      aridity: settings.aridity,
      strata: settings.strata,
      riparian: settings.riparian,
      riparianReach: settings.riparianReach,
      groundWarmth: settings.groundWarmth,

      forest: settings.forest,
      vegTint: settings.vegTint,
      vegSat: settings.vegSat,
      treeNeed: settings.treeNeed,
      treeLimit: settings.treeLimit,
      treeSpread: settings.treeSpread,
      treeFractal: settings.treeFractal,
      treeRough: settings.treeRough,
      treeRoughScale: settings.treeRoughScale,
      corridorLeaf: settings.corridorLeaf,
      showTrees: settings.showTrees,
      showGrass: settings.showGrass,
      showSnow: settings.showSnow,

      rivers: settings.rivers,
      riverThreshold: settings.riverThreshold,
      waveHeight: settings.waveHeight,
      showRivers: settings.showRivers,
      showLakes: settings.showLakes,

      showRoads: settings.showRoads,
      roadDarkness: settings.roadDarkness,
      roadClearing: settings.roadClearing,
      roadTint: settings.roadTint,
      roadShoulder: settings.roadShoulder,

      // Each kind switches independently, and the toggle simply zeroes its weight —
      // the mask is one texture, so there is nothing to rebuild when one goes off.
      osmWater: settings.showOsmWater ? settings.osmWaterStrength : 0,
      osmWood: settings.showOsmWood ? settings.osmWoodStrength : 0,
      osmBuilt: settings.showOsmBuilt ? settings.osmBuiltStrength : 0,

      textureRange: settings.textureRange,
      shadows: settings.shadows,
      aoStrength: settings.aoStrength,
      microDetail: settings.microDetail,
      fogDensity,
    }
    surface.setConfig(config)
  })

  useFrame((_, delta) => surface.update(delta))

  return <primitive object={surface.mesh} />
}
