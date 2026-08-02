import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useStore } from '../store'
import SkyDome from './SkyDome'
import HeadingTape from './HeadingTape'
import ViewLayers from './ViewLayers'
import { computeSky } from '../lib/atmosphere'
import { rendererRef } from '../lib/capture'
import { builderConfig } from '../config'
import { loadSession, saveSession } from '../lib/session'
import Terrain from './Terrain'
import Water from './Water'
import FirstPerson from './FirstPerson'

function RendererBridge() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    rendererRef.current = gl
    if (builderConfig().devHooks) {
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
  enableDamping: boolean
  update: () => void
  addEventListener: (type: string, fn: () => void) => void
  removeEventListener: (type: string, fn: () => void) => void
}

/**
 * Watches where the camera settles and asks for a sharper satellite patch there.
 *
 * The base drape is one bounded texture over the whole box — over 24 m per pixel on a
 * big box — so zooming the camera in only magnifies it. This drives the close-up:
 * when the camera has been still for a beat over a small enough footprint, the store
 * refetches that sub-box at a higher zoom and the shader composites it over the base.
 *
 * All the judgement lives here — when the camera counts as settled, how big the
 * footprint is, when the patch stops being worth having — and none of the fetching:
 * `loadSatPatch` owns the network, the abort, and the no-sharper-than-base skip.
 * Frame-driven rather than event-driven so it needs no knowledge of which controls
 * are moving the camera; walking with FirstPerson earns close-ups the same way
 * orbiting does.
 */
function SatPatchWatcher() {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as OrbitLike | null
  const build = useStore((s) => s.build)
  const heightField = useStore((s) => s.heightField)
  const textureMode = useStore((s) => s.settings.textureMode)
  const boost = useStore((s) => s.settings.satPatchBoost)
  const imagery = useStore((s) => s.imagery)
  const loadSatPatch = useStore((s) => s.loadSatPatch)

  const lastPos = useRef(new THREE.Vector3(Infinity, Infinity, Infinity))
  const lastQuat = useRef(new THREE.Quaternion())
  const stillFor = useRef(0)
  const lastKey = useRef('')
  const ndc = useRef(new THREE.Vector3())
  const dir = useRef(new THREE.Vector3())

  useFrame((_, dt) => {
    if (!build || !heightField) return

    const active = textureMode === 'satellite' && !!imagery && boost > 0
    if (!active) {
      if (lastKey.current !== '') {
        lastKey.current = ''
        void loadSatPatch(null)
      }
      return
    }

    // Settled = neither position nor orientation has meaningfully changed for a
    // beat. Orientation matters on its own because tilting in place moves no metres
    // yet completely changes which ground is on screen.
    const moved =
      camera.position.distanceToSquared(lastPos.current) > 1 ||
      Math.abs(1 - Math.abs(camera.quaternion.dot(lastQuat.current))) > 1e-6
    lastPos.current.copy(camera.position)
    lastQuat.current.copy(camera.quaternion)
    if (moved) {
      stillFor.current = 0
      return
    }
    stillFor.current += dt
    if (stillFor.current < 0.35) return

    // The footprint is what the camera actually SEES: the four frustum corner rays
    // dropped onto the ground plane, not a square guessed around the orbit target.
    // That is the difference between "sharp near the middle" and "sharp viewport" —
    // a tilted view reaches ground far beyond any target-centred square.
    //
    // Rays that miss the ground (looking at sky) or land absurdly far away are
    // clamped to a horizon distance: past a few times the eye distance the fog owns
    // the pixels anyway, and chasing the mathematical horizon would balloon the
    // footprint until no zoom gain survived the tile budget.
    const target = controls?.target ?? camera.position
    const dist = Math.max(200, camera.position.distanceTo(target))
    const planeY = controls ? controls.target.y : 0
    const maxDist = dist * 5

    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const [cx, cy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      dir.current.copy(ndc.current.set(cx, cy, 0.5).unproject(camera)).sub(camera.position).normalize()
      const t = dir.current.y < -1e-4 ? (planeY - camera.position.y) / dir.current.y : Infinity
      const reach = Math.min(t > 0 ? t : Infinity, maxDist)
      const x = camera.position.x + dir.current.x * reach
      const z = camera.position.z + dir.current.z * reach
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
    }

    // A little margin so panning has somewhere sharp to arrive in, then clamp to the
    // terrain — the patch cannot cover ground the box does not have.
    const marginX = (maxX - minX) * 0.1
    const marginZ = (maxZ - minZ) * 0.1
    const halfW = build.widthMetres / 2
    const halfD = build.depthMetres / 2
    minX = Math.max(minX - marginX, -halfW)
    maxX = Math.min(maxX + marginX, halfW)
    minZ = Math.max(minZ - marginZ, -halfD)
    maxZ = Math.min(maxZ + marginZ, halfD)
    if (maxX <= minX || maxZ <= minZ) return

    // World metres → the box's lon/lat. The mesh runs x west→east and z north→south,
    // both centred on the origin — the same convention every mask projector uses.
    const b = heightField.bounds
    const lonSpan = b.east - b.west
    const latSpan = b.north - b.south
    const west = b.west + (minX / build.widthMetres + 0.5) * lonSpan
    const east = b.west + (maxX / build.widthMetres + 0.5) * lonSpan
    const north = b.north - (minZ / build.depthMetres + 0.5) * latSpan
    const south = b.north - (maxZ / build.depthMetres + 0.5) * latSpan

    // Quantised, so metres of drift or a wheel nudge do not refetch: corners snap to
    // a tenth of the footprint, size to powers of two. When the view IS wider than
    // any useful patch, the store's no-gain guard skips the fetch and — deliberately
    // — leaves the previous patch standing. Stale-but-sharp beats popping to blur.
    const sizeStep = Math.round(Math.log2(maxX - minX))
    const grid = (maxX - minX) * 0.1
    const key = [
      Math.round(minX / grid),
      Math.round(minZ / grid),
      sizeStep,
    ].join('|')
    if (key === lastKey.current) return
    lastKey.current = key

    void loadSatPatch({ west, east, south, north })
  })

  return null
}

/** Positions the camera to frame a freshly built terrain and sets sane clip planes. */
function CameraRig({
  size,
  midY,
  topY,
  ready,
}: {
  size: number
  midY: number
  topY: number
  ready: boolean
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const controls = useThree((s) => s.controls) as OrbitLike | null
  const frameToken = useStore((s) => s.frameToken)

  useEffect(() => {
    camera.near = Math.max(0.1, size * 0.0004)
    camera.far = size * 200
    camera.updateProjectionMatrix()
  }, [camera, size])

  const framedToken = useRef(-1)
  const framedSize = useRef(-1)
  // Consumed once, by the first build after a reload.
  const restoredCamera = useRef(loadSession().camera ?? null)

  // Persist the view whenever a drag or zoom settles.
  useEffect(() => {
    if (!controls) return
    const save = () => {
      saveSession({
        camera: {
          pos: camera.position.toArray() as [number, number, number],
          quat: camera.quaternion.toArray() as [number, number, number, number],
          target: controls.target.toArray() as [number, number, number],
        },
      })
    }
    controls.addEventListener('end', save)
    return () => controls.removeEventListener('end', save)
  }, [controls, camera])

  useEffect(() => {
    if (!controls) return

    // Wait for a real terrain.
    //
    // OrbitControls attach before the first build lands, so this effect used to run
    // once against the placeholder extent — consuming the restored camera, then
    // re-framing to defaults the moment the actual terrain arrived. A saved view was
    // therefore always thrown away on reload.
    if (!ready) return

    // Distance limits track the terrain size and are safe to apply at any time.
    controls.minDistance = size * 0.008
    controls.maxDistance = size * 6

    // Re-frame when a new terrain is built, or when the terrain's extent changes.
    //
    // Both conditions are needed. OrbitControls attaches a frame or two after mount,
    // so with a cached DEM the build can land first and the initial framing runs
    // against the placeholder size — the token alone would then consider it done and
    // leave the camera parked for a 10 km tile in front of a 27 km one. Extent is safe
    // to key on because it comes from the ground footprint; only midY and topY move
    // with exaggeration, so dragging that slider still will not yank the camera.
    if (framedToken.current === frameToken && framedSize.current === size) return
    framedToken.current = frameToken
    framedSize.current = size

    // On the first build after a reload, drop the camera back where it was rather
    // than re-framing — otherwise restoring a session still throws away your view.
    const saved = restoredCamera.current
    if (saved) {
      restoredCamera.current = null
      camera.position.fromArray(saved.pos)
      camera.quaternion.fromArray(saved.quat)
      controls.target.fromArray(saved.target)
    } else {
      camera.position.set(size * 0.62, topY + size * 0.38, size * 0.86)
      controls.target.set(0, midY, 0)
    }

    // Damping keeps residual rotation/pan velocity in the controls, and update() only
    // decays it rather than clearing it — so a fresh camera placement would visibly
    // drift as the leftover motion played out. Updating once with damping off zeroes
    // the accumulated deltas instead.
    const damping = controls.enableDamping
    controls.enableDamping = false
    controls.update()
    controls.enableDamping = damping
  }, [frameToken, controls, camera, size, midY, topY, ready])

  return null
}

export default function Viewer() {
  const build = useStore((s) => s.build)
  const settings = useStore((s) => s.settings)
  const winter = useStore((s) => s.winter)
  const hazeScrub = useStore((s) => s.hazeScrub)
  const walking = useStore((s) => s.walking)
  const isDemo = useStore((s) => s.heightField?.demtype === 'DEMO')
  const tapeRef = useRef<HTMLCanvasElement>(null)

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
  // Killing the fog is not the same as setting haze to zero: haze also tints the sky
  // dome, so this switch has to bypass the density rather than zero the setting. The
  // scrub scales it for the same reason — you can clear the air to read the ground's
  // true colour without the sky changing underneath you and moving the goalposts.
  const fogDensity = settings.showFog ? (settings.haze * 0.55 * hazeScrub) / size : 0

  // Winter drags the snow line down from wherever the climate put it, rather than
  // replacing it, so the relationship between the classes present is preserved as it
  // falls — the range whitens before the plains do, which is what actually happens.
  // At full winter it goes below the lowest ground in the box so nothing is left bare.
  const snowLine =
    build && winter > 0
      ? settings.snowLine + (build.minElevation - 60 - settings.snowLine) * winter
      : settings.snowLine

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
            <Terrain build={build} sky={sky} fogDensity={fogDensity} snowLine={snowLine} />
            {settings.showOcean && <Water build={build} sky={sky} fogDensity={fogDensity} />}
          </>
        )}
        <CameraRig size={size} midY={midY} topY={topY} ready={!!build} />
        <SatPatchWatcher />
        <FirstPerson />
        <HeadingTape target={tapeRef} />
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          rotateSpeed={0.6}
          zoomSpeed={0.9}
          maxPolarAngle={Math.PI * 0.495}
        />
      </Canvas>

      {isDemo && (
        <div className="demo-badge" title="Not real elevation data">
          synthetic terrain — not a real location
        </div>
      )}

      {/* On foot, the layer stack and the heading tape are just clutter across the view,
          and none of it can be clicked while the pointer is locked anyway. */}
      {walking ? (
        <div className="walk-hint">
          <b>W A S D</b> walk · <b>shift</b> run · <b>mouse</b> look · <b>esc</b> back to orbit
        </div>
      ) : (
        <>
          <canvas className="heading-tape" ref={tapeRef} />
          <ViewLayers />
          {build && <div className="walk-tip">double-click the ground to stand on it</div>}
        </>
      )}
    </div>
  )
}
