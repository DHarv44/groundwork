import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { TerrainBuild } from '../lib/mesh'
import type { SkyModel } from '../lib/atmosphere'
import { terrainFragmentShader, terrainVertexShader } from '../shaders/terrain'
import { useStore } from '../store'

interface Props {
  build: TerrainBuild
  sky: SkyModel
  fogDensity: number
}

const WHITE = new THREE.Texture()

export default function Terrain({ build, sky, fogDensity }: Props) {
  const settings = useStore((s) => s.settings)
  const imagery = useStore((s) => s.imagery)
  const waterMask = useStore((s) => s.waterMask)
  const biomeMap = useStore((s) => s.biomeMap)
  const materialRef = useRef<THREE.ShaderMaterial>(null)

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

  const uniforms = useMemo(
    () => ({
      uNormalMap: { value: build.normalTexture },
      uHeightMap: { value: build.heightTexture },
      uSatMap: { value: WHITE },
      uUseSat: { value: 0 },
      uSatDetail: { value: 1 },
      uWaterMap: { value: WHITE },
      uHasWater: { value: 0 },
      uRivers: { value: settings.rivers },
      uRiverThreshold: { value: settings.riverThreshold },
      uShowRivers: { value: 1 },
      uShowLakes: { value: 1 },
      uDrainageView: { value: 0 },
      uTime: { value: 0 },
      uWaveHeight: { value: settings.waveHeight },
      uMinElev: { value: build.minElevation },
      uMaxElev: { value: build.maxElevation },
      uExag: { value: settings.exaggeration },
      uWidthM: { value: build.widthMetres },
      uDepthM: { value: build.depthMetres },
      uSunDir: { value: sky.sunDirection.clone() },
      uSunColor: { value: sky.sunColor.clone() },
      uSkyColor: { value: sky.skyColor.clone() },
      uHorizonColor: { value: sky.horizonColor.clone() },
      uGroundTint: { value: sky.groundTint.clone() },
      uSnowLine: { value: settings.snowLine },
      uTreeLine: { value: settings.treeLine },
      uAridity: { value: settings.aridity },
      uStrata: { value: settings.strata },
      uRiparian: { value: settings.riparian },
      uRiparianReach: { value: settings.riparianReach },
      uGroundWarmth: { value: settings.groundWarmth },
      uForest: { value: settings.forest },
      uVegTint: { value: settings.vegTint },
      uVegSat: { value: settings.vegSat },
      uTreeNeed: { value: settings.treeNeed },
      uTreeLimit: { value: settings.treeLimit },
      uTreeSpread: { value: settings.treeSpread },
      uCorridorLeaf: { value: settings.corridorLeaf },
      uShowTrees: { value: 1 },
      uShowGrass: { value: 1 },
      uBiomeMap: { value: WHITE },
      uHasBiomeMap: { value: 0 },
      uTextureRange: { value: settings.textureRange },
      uShadows: { value: settings.shadows ? 1 : 0 },
      uAoStrength: { value: settings.aoStrength },
      uDetail: { value: settings.microDetail },
      uFogDensity: { value: fogDensity },
      uSeaLevel: { value: 0 },
    }),
    // Created exactly once and mutated in place from here on.
    //
    // This object must NEVER be replaced. three caches its uniform upload list against
    // the uniform objects present when the program was compiled, so assigning a new
    // `material.uniforms` leaves the renderer still uploading the old values until
    // something forces a recompile. That was the cause of shadows breaking whenever
    // vertical exaggeration changed — the shader kept sampling the previous height
    // texture and exaggeration until a recompile happened to catch up a frame later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // The very first program compiled for a fresh ShaderMaterial can still latch stale
  // uniform locations, so force one recompile after mount — but only at mount.
  useEffect(() => {
    const m = materialRef.current
    if (!m) return
    const id = requestAnimationFrame(() => {
      m.needsUpdate = true
    })
    return () => cancelAnimationFrame(id)
  }, [])

  // Push live values every render rather than recompiling the material.
  useEffect(() => {
    const u = uniforms
    u.uNormalMap.value = build.normalTexture
    u.uHeightMap.value = build.heightTexture
    u.uMinElev.value = build.minElevation
    u.uMaxElev.value = build.maxElevation
    u.uWidthM.value = build.widthMetres
    u.uDepthM.value = build.depthMetres
    u.uExag.value = settings.exaggeration
    u.uSunDir.value.copy(sky.sunDirection)
    u.uSunColor.value.copy(sky.sunColor)
    u.uSkyColor.value.copy(sky.skyColor)
    u.uHorizonColor.value.copy(sky.horizonColor)
    u.uGroundTint.value.copy(sky.groundTint)
    u.uSnowLine.value = settings.snowLine
    u.uTreeLine.value = settings.treeLine
    u.uAridity.value = settings.aridity
    u.uStrata.value = settings.strata
    u.uRiparian.value = settings.riparian
    u.uRiparianReach.value = settings.riparianReach
    u.uGroundWarmth.value = settings.groundWarmth
    u.uForest.value = settings.forest
    u.uVegTint.value = settings.vegTint
    u.uVegSat.value = settings.vegSat
    u.uTreeNeed.value = settings.treeNeed
    u.uTreeLimit.value = settings.treeLimit
    u.uTreeSpread.value = settings.treeSpread
    u.uCorridorLeaf.value = settings.corridorLeaf
    u.uShowTrees.value = settings.showTrees ? 1 : 0
    u.uShowGrass.value = settings.showGrass ? 1 : 0
    u.uBiomeMap.value = biomeMap ?? WHITE
    u.uHasBiomeMap.value = biomeMap ? 1 : 0
    u.uTextureRange.value = settings.textureRange
    u.uShadows.value = settings.shadows ? 1 : 0
    u.uAoStrength.value = settings.aoStrength
    u.uDetail.value = settings.microDetail
    u.uFogDensity.value = fogDensity
    u.uSatMap.value = satTexture ?? WHITE
    u.uUseSat.value = settings.textureMode === 'satellite' && satTexture ? 1 : 0
    u.uWaterMap.value = waterMask ?? WHITE
    u.uHasWater.value = waterMask ? 1 : 0
    u.uRivers.value = settings.rivers
    u.uRiverThreshold.value = settings.riverThreshold
    u.uWaveHeight.value = settings.waveHeight
    u.uShowRivers.value = settings.showRivers ? 1 : 0
    u.uShowLakes.value = settings.showLakes ? 1 : 0
    u.uDrainageView.value = settings.textureMode === 'drainage' && waterMask ? 1 : 0
  })

  useFrame((_, delta) => {
    uniforms.uTime.value += delta
  })

  return (
    <mesh geometry={build.geometry} frustumCulled={false}>
      <shaderMaterial
        ref={materialRef}
        vertexShader={terrainVertexShader}
        fragmentShader={terrainFragmentShader}
        uniforms={uniforms}
        wireframe={settings.wireframe}
      />
    </mesh>
  )
}
