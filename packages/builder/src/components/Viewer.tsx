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
  const controls = useThree((s) => s.controls)
  useEffect(() => {
    rendererRef.current = gl
    if (builderConfig().devHooks) {
      ;(window as unknown as Record<string, unknown>).__viewer = { gl, scene, camera, controls }
    }
    return () => {
      if (rendererRef.current === gl) rendererRef.current = null
    }
  }, [gl, scene, camera, controls])
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
 * Streams sharper satellite rings to wherever the camera is looking, while it moves.
 *
 * The base drape is one bounded texture over the whole box — over 24 m per pixel on a
 * big box — so zooming the camera in only magnifies it. This drives the close-up
 * clipmap that composites over it, and it deliberately never waits for the camera to
 * stop: ring keys are evaluated every frame, a fetch starts the moment a key changes,
 * and a superseded fetch is simply aborted. Detail chases the camera instead of
 * arriving after it. The store seeds every new ring with the imagery already on
 * screen, so a mid-gesture refetch costs nothing visually — the worst case is the
 * same picture, briefly not yet sharper. Per-ring cooldowns keep a continuous zoom
 * from starting more fetches than it can use.
 *
 * All the judgement lives here — how big the footprint is, when a ring must refetch,
 * when it stops being worth having — and none of the fetching: `loadSatRing` owns
 * the network, the abort, the seeding and the no-sharper-than-base skip.
 * Frame-driven rather than event-driven so it needs no knowledge of which controls
 * are moving the camera; walking with FirstPerson earns close-ups the same way
 * orbiting does.
 */
function SatRingWatcher() {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as OrbitLike | null
  const build = useStore((s) => s.build)
  const heightField = useStore((s) => s.heightField)
  const textureMode = useStore((s) => s.settings.textureMode)
  const boost = useStore((s) => s.settings.satPatchBoost)
  const imagery = useStore((s) => s.imagery)
  const loadSatRing = useStore((s) => s.loadSatRing)
  const clearSatRings = useStore((s) => s.clearSatRings)

  /** What each ring last fetched: centre and size step. Null = nothing yet. */
  const lastFetch = useRef<Array<{ lon: number; lat: number; step: number } | null>>([
    null,
    null,
    null,
    null,
  ])
  /** Seconds until each ring may start another fetch — the churn limiter that
   * replaced the settle gate. Restarts are visually free (seeded), so this only
   * exists to stop a long zoom gesture from opening dozens of doomed fetches. */
  const cooldown = useRef([0, 0, 0, 0])

  useFrame((_, dt) => {
    if (!build || !heightField) return

    const active = textureMode === 'satellite' && !!imagery && boost > 0
    if (!active) {
      if (lastFetch.current.some((f) => f !== null)) {
        lastFetch.current = [null, null, null, null]
        cooldown.current = [0, 0, 0, 0]
        clearSatRings()
      }
      return
    }

    for (let k = 0; k < 4; k++) {
      cooldown.current[k] = Math.max(0, cooldown.current[k]! - dt)
    }

    // The rings are nested squares centred where the camera looks, each 3x the width
    // and two zooms coarser than the one inside — four of them, reaching ~32x the
    // eye distance before the base drape takes over. Frustum coverage falls out of
    // the nesting: near ground lands in ring 0, the far field steps down through
    // rings 1-3, the horizon takes the base — a clipmap doing what one
    // frustum-fitted rectangle never could, because a tilted view needs several
    // resolutions at once, not one rectangle at one resolution.
    const target = controls?.target ?? camera.position
    const dist = Math.max(200, camera.position.distanceTo(target))
    const b = heightField.bounds
    const lonSpan = b.east - b.west
    const latSpan = b.north - b.south
    const u = target.x / build.widthMetres + 0.5
    const v = target.z / build.depthMetres + 0.5
    const cLon = b.west + u * lonSpan
    const cLat = b.north - v * latSpan

    const ceiling = Math.min(11 + 2 * boost, 19)
    for (let k = 0; k < 4; k++) {
      const half = Math.max(250, dist * 1.2) * Math.pow(3, k)
      const step = Math.round(Math.log2(half))

      // Refetch only when the camera demands SHARPER (footprint shrank a step) or
      // ELSEWHERE (centre left the fetched ring). Zooming out deliberately fetches
      // nothing: the ring already loaded stays rendered — geo-anchored imagery
      // minifies through its mipmaps for free, the outer rings and base already
      // cover the newly visible surround at the zoom a fetch would return anyway,
      // and replacing sharp with coarse would cost a download to look worse.
      // The drift threshold is deliberately small: re-centres are seeded and
      // incremental now, so tracking the camera closely costs a fetch, not a blink.
      const prev = lastFetch.current[k]
      if (prev) {
        const prevHalf = Math.pow(2, prev.step)
        const dxM = ((cLon - prev.lon) / lonSpan) * build.widthMetres
        const dzM = ((prev.lat - cLat) / latSpan) * build.depthMetres
        const drifted = Math.hypot(dxM, dzM) > prevHalf * 0.18
        if (step >= prev.step && !drifted) continue
      }
      // Wanted but cooling down — leave lastFetch untouched so the want survives
      // to a later frame instead of being recorded as satisfied. Outer rings wait
      // longer: their uploads are bigger and their keys barely move, so eagerness
      // buys nothing but churn out there.
      if (cooldown.current[k]! > 0) continue
      cooldown.current[k] = 0.25 + 0.1 * k
      lastFetch.current[k] = { lon: cLon, lat: cLat, step }

      const dLon = (half / build.widthMetres) * lonSpan
      const dLat = (half / build.depthMetres) * latSpan
      void loadSatRing(k, {
        west: cLon - dLon,
        east: cLon + dLon,
        south: cLat - dLat,
        north: cLat + dLat,
      }, ceiling - 2 * k)
    }
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
    // The near plane must not scale with the box: it used to, and on a 500 km box
    // that put it 200 m out — which is also why the zoom floor had to be high. The
    // renderer runs a logarithmic depth buffer, so a small constant near against a
    // box-scaled far costs nothing in precision.
    camera.near = Math.max(2, size * 0.00002)
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

    // The ceiling tracks the terrain, the floor does not: proportional flooring meant
    // a big box stopped the zoom kilometres up — 4 km on a 500 km box — exactly where
    // the imagery close-up makes descending worth doing. Sixty metres is close enough
    // to read a street; below that, walking (double-click) is the tool.
    controls.minDistance = 60
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
        <SatRingWatcher />
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
