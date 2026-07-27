import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { TerrainBuild } from '../lib/mesh'
import type { SkyModel } from '../lib/atmosphere'
import { waterFragmentShader, waterVertexShader } from '../shaders/water'
import { useStore } from '../store'

interface Props {
  build: TerrainBuild
  sky: SkyModel
  fogDensity: number
}

/**
 * A single plane at sea level. The fragment shader discards anywhere the terrain sits
 * above water, so coastlines and lake basins fall out of the DEM for free.
 */
export default function Water({ build, sky, fogDensity }: Props) {
  const settings = useStore((s) => s.settings)
  const materialRef = useRef<THREE.ShaderMaterial>(null)

  const uniforms = useMemo(
    () => ({
      uHeightMap: { value: build.heightTexture },
      uMinElev: { value: build.minElevation },
      uMaxElev: { value: build.maxElevation },
      uExag: { value: settings.exaggeration },
      uWidthM: { value: build.widthMetres },
      uDepthM: { value: build.depthMetres },
      uSeaLevelY: { value: 0 },
      uShoreCutoff: { value: settings.shoreCutoff },
      uDepthFade: { value: settings.depthFade },
      uWaveHeight: { value: settings.waveHeight },
      uFoamWidth: { value: settings.foamWidth },
      uOpacity: { value: settings.waterOpacity },
      uTime: { value: 0 },
      uHasBathymetry: { value: build.minElevation < -2 ? 1 : 0 },
      uSunDir: { value: sky.sunDirection.clone() },
      uSunColor: { value: sky.sunColor.clone() },
      uSkyColor: { value: sky.skyColor.clone() },
      uHorizonColor: { value: sky.horizonColor.clone() },
      uFogDensity: { value: fogDensity },
    }),
    // Created once and mutated in place — replacing this object would leave three
    // uploading stale values until a recompile. See the note in Terrain.tsx.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  useEffect(() => {
    const m = materialRef.current
    if (!m) return
    const id = requestAnimationFrame(() => {
      m.needsUpdate = true
    })
    return () => cancelAnimationFrame(id)
  }, [])

  useFrame((_, delta) => {
    const u = uniforms
    u.uTime.value += delta
    u.uHeightMap.value = build.heightTexture
    u.uMinElev.value = build.minElevation
    u.uMaxElev.value = build.maxElevation
    u.uExag.value = settings.exaggeration
    u.uWidthM.value = build.widthMetres
    u.uDepthM.value = build.depthMetres
    u.uSunDir.value.copy(sky.sunDirection)
    u.uSunColor.value.copy(sky.sunColor)
    u.uSkyColor.value.copy(sky.skyColor)
    u.uHorizonColor.value.copy(sky.horizonColor)
    u.uFogDensity.value = fogDensity
    u.uHasBathymetry.value = build.minElevation < -2 ? 1 : 0
    // Sea level is a real elevation, so it scales with exaggeration like the terrain.
    u.uSeaLevelY.value = settings.seaLevel * settings.exaggeration
    u.uShoreCutoff.value = settings.shoreCutoff
    u.uDepthFade.value = settings.depthFade
    u.uWaveHeight.value = settings.waveHeight
    u.uFoamWidth.value = settings.foamWidth
    u.uOpacity.value = settings.waterOpacity
  })

  // Skip entirely for terrain that never reaches the raised sea.
  if (build.minElevation > settings.seaLevel + 0.5) return null

  // Land-only DEMs record the sea surface as exactly 0 m, which puts the water plane
  // coplanar with the terrain and sets off z-fighting. Float it just clear of the bed.
  const lift =
    Math.max(0.5, (build.maxElevation - build.minElevation) * 0.0015) * settings.exaggeration
  const planeY = settings.seaLevel * settings.exaggeration + lift

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, planeY, 0]} renderOrder={1}>
      <planeGeometry args={[build.widthMetres, build.depthMetres, 1, 1]} />
      <shaderMaterial
        ref={materialRef}
        vertexShader={waterVertexShader}
        fragmentShader={waterFragmentShader}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        side={THREE.DoubleSide}
        // Nudge the plane toward the camera in depth, to stop it z-fighting the sea
        // floor. Over flat coast the two are almost coplanar for tens of kilometres,
        // and the small vertical lift that separates them at a steep viewing angle is
        // not enough once you tilt toward grazing: their depths converge in screen
        // space and pixels start alternating between the two surfaces.
        //
        // The factor term scales the offset by the polygon's depth slope, which is
        // exactly the quantity that grows as you tilt — so this targets the failure
        // where it actually happens rather than shifting the plane everywhere.
        polygonOffset
        polygonOffsetFactor={-4}
        polygonOffsetUnits={-8}
      />
    </mesh>
  )
}
