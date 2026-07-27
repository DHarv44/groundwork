import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useStore } from '../store'
import SkyDome from './SkyDome'
import { computeSky } from '../lib/atmosphere'
import { rendererRef } from '../lib/capture'
import Terrain from './Terrain'
import Water from './Water'

function RendererBridge() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    rendererRef.current = gl
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__viewer = { gl, scene, camera }
    }
    return () => {
      if (rendererRef.current === gl) rendererRef.current = null
    }
  }, [gl, scene, camera])
  return null
}

/** The slice of OrbitControls the rig needs, without importing three-stdlib's types. */
interface OrbitLike {
  target: THREE.Vector3
  minDistance: number
  maxDistance: number
  update: () => void
}

/** Positions the camera to frame a freshly built terrain and sets sane clip planes. */
function CameraRig({ size, midY, topY }: { size: number; midY: number; topY: number }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const controls = useThree((s) => s.controls) as OrbitLike | null
  const frameToken = useStore((s) => s.frameToken)

  useEffect(() => {
    camera.near = Math.max(0.1, size * 0.0004)
    camera.far = size * 200
    camera.updateProjectionMatrix()
  }, [camera, size])

  useEffect(() => {
    if (!controls) return
    camera.position.set(size * 0.62, topY + size * 0.38, size * 0.86)
    controls.target.set(0, midY, 0)
    controls.minDistance = size * 0.008
    controls.maxDistance = size * 6
    controls.update()
  }, [frameToken, controls, camera, size, midY, topY])

  return null
}

/** Rotates the on-screen compass to match where the camera is looking. */
function CompassLink({ target }: { target: React.RefObject<HTMLDivElement> }) {
  const camera = useThree((s) => s.camera)
  const dir = useRef(new THREE.Vector3())
  useFrame(() => {
    if (!target.current) return
    camera.getWorldDirection(dir.current)
    // World −Z is north; heading grows clockwise.
    const heading = Math.atan2(dir.current.x, -dir.current.z)
    target.current.style.transform = `rotate(${-heading}rad)`
  })
  return null
}

export default function Viewer() {
  const build = useStore((s) => s.build)
  const settings = useStore((s) => s.settings)
  const compassRef = useRef<HTMLDivElement>(null)

  const sky = useMemo(
    () => computeSky(settings.sunAzimuth, settings.sunElevation),
    [settings.sunAzimuth, settings.sunElevation],
  )

  const size = build ? Math.max(build.widthMetres, build.depthMetres) : 10000
  const midY = build ? ((build.minElevation + build.maxElevation) / 2) * settings.exaggeration : 0
  const topY = build ? build.maxElevation * settings.exaggeration : 0
  // Haze is expressed relative to terrain size so it reads the same at every scale.
  // Calibrated so the default lays ~15% of atmosphere over the far edge of the box,
  // which is about right for clear mountain air.
  const fogDensity = (settings.haze * 0.55) / size

  return (
    <div className="viewer">
      <Canvas
        dpr={[1, 2]}
        gl={{
          antialias: true,
          preserveDrawingBuffer: true,
          logarithmicDepthBuffer: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          outputColorSpace: THREE.SRGBColorSpace,
        }}
        camera={{ fov: 50, position: [6000, 4000, 8000] }}
      >
        <RendererBridge />
        <SkyDome sky={sky} radius={size * 30} haze={settings.haze} />
        {build && (
          <>
            <Terrain build={build} sky={sky} fogDensity={fogDensity} />
            {settings.water && <Water build={build} sky={sky} fogDensity={fogDensity} />}
          </>
        )}
        <CameraRig size={size} midY={midY} topY={topY} />
        <CompassLink target={compassRef} />
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          rotateSpeed={0.6}
          zoomSpeed={0.9}
          maxPolarAngle={Math.PI * 0.495}
        />
      </Canvas>

      <div className="compass" title="North">
        <div className="compass-dial" ref={compassRef}>
          <span className="n">N</span>
          <span className="needle" />
        </div>
      </div>
    </div>
  )
}
