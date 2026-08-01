import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { SkyDome as SkyDomeObject, type SkyModel } from '@groundwork/engine'

export default function SkyDome({
  sky,
  radius,
  haze,
}: {
  sky: SkyModel
  radius: number
  haze: number
}) {
  const dome = useMemo(() => new SkyDomeObject(radius), [])
  useEffect(() => () => dome.dispose(), [dome])

  useEffect(() => {
    dome.setRadius(radius)
  }, [dome, radius])

  useFrame(({ camera }) => {
    dome.setSky(sky)
    dome.setHaze(haze)
    dome.update(camera)
  })

  return <primitive object={dome.mesh} />
}
