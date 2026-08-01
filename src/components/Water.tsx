import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { WaterPlane, type SkyModel, type TerrainBuild } from '@groundwork/engine'
import { useStore } from '../store'

/**
 * The builder's binding to the engine's water plane. Same shape as `Terrain.tsx`:
 * `Settings` stops here and the engine is handed final values.
 */

interface Props {
  build: TerrainBuild
  sky: SkyModel
  fogDensity: number
}

export default function Water({ build, sky, fogDensity }: Props) {
  const settings = useStore((s) => s.settings)

  // Built once. The plane holds a uniform object that must not be replaced.
  const water = useMemo(() => new WaterPlane(build), [])
  useEffect(() => () => water.dispose(), [water])

  useEffect(() => {
    water.setBuild(build)
  }, [water, build])

  useEffect(() => {
    water.setSky(sky)
    water.setConfig({
      exaggeration: settings.exaggeration,
      seaLevel: settings.seaLevel,
      shoreCutoff: settings.shoreCutoff,
      shoreFeather: settings.shoreFeather,
      depthFade: settings.depthFade,
      waveHeight: settings.waveHeight,
      foamWidth: settings.foamWidth,
      opacity: settings.waterOpacity,
      fogDensity,
    })
  })

  useFrame((_, delta) => water.update(delta))

  return <primitive object={water.mesh} />
}
