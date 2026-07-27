import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { SkyModel } from '../lib/atmosphere'
import { skyFragmentShader, skyVertexShader } from '../shaders/sky'

export default function SkyDome({
  sky,
  radius,
  haze,
}: {
  sky: SkyModel
  radius: number
  haze: number
}) {
  const meshRef = useRef<THREE.Mesh>(null)

  const uniforms = useMemo(
    () => ({
      uSkyColor: { value: sky.skyColor.clone() },
      uHorizonColor: { value: sky.horizonColor.clone() },
      uGroundTint: { value: sky.groundTint.clone() },
      uSunDir: { value: sky.sunDirection.clone() },
      uSunColor: { value: sky.sunColor.clone() },
      uHaze: { value: haze },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // Keep the dome centred on the camera so it never clips as you fly around.
  useFrame(({ camera }) => {
    meshRef.current?.position.copy(camera.position)
    uniforms.uSkyColor.value.copy(sky.skyColor)
    uniforms.uHorizonColor.value.copy(sky.horizonColor)
    uniforms.uGroundTint.value.copy(sky.groundTint)
    uniforms.uSunDir.value.copy(sky.sunDirection)
    uniforms.uSunColor.value.copy(sky.sunColor)
    uniforms.uHaze.value = haze
  })

  return (
    <mesh ref={meshRef} frustumCulled={false} renderOrder={-1}>
      <sphereGeometry args={[radius, 48, 32]} />
      <shaderMaterial
        vertexShader={skyVertexShader}
        fragmentShader={skyFragmentShader}
        uniforms={uniforms}
        side={THREE.BackSide}
        depthWrite={false}
      />
    </mesh>
  )
}
