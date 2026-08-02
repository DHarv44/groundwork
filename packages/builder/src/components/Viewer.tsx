import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { sampleBox } from '@dharv44/groundwork-core'
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
  dispatchEvent?: (event: { type: string }) => void
}

/**
 * Ground-anchored wheel zoom, replacing OrbitControls' dolly entirely.
 *
 * OrbitControls' zoomToCursor dollies toward a point at the orbit target's DEPTH,
 * not toward the ground under the cursor. Over 3D terrain those are different
 * points, so every notch slid the feature under the pointer a little sideways —
 * felt as the map jumping around while zooming. The cure is what real map
 * renderers do: intersect the cursor ray with the terrain itself and scale the
 * camera about that fixed point. Scaling about the hit keeps it exactly under the
 * cursor by construction — zero drift, in or out — and dragging the orbit target
 * along the same scale makes it converge onto the ground being dived at, which is
 * where subsequent orbiting wants it anyway.
 */
function ZoomToGround() {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const controls = useThree((s) => s.controls) as OrbitLike | null
  const build = useStore((s) => s.build)
  const heightField = useStore((s) => s.heightField)
  const exaggeration = useStore((s) => s.settings.exaggeration)
  const zoomSpeed = useStore((s) => s.settings.zoomSpeed)
  const walking = useStore((s) => s.walking)

  // The wheel handler reads through this ref so the listener binds once.
  const live = useRef({ controls, build, heightField, exaggeration, zoomSpeed, walking })
  live.current = { controls, build, heightField, exaggeration, zoomSpeed, walking }

  useEffect(() => {
    const el = gl.domElement
    const dir = new THREE.Vector3()
    const probe = new THREE.Vector3()
    const hit = new THREE.Vector3()
    let saveTimer: ReturnType<typeof setTimeout> | undefined

    /** Terrain height (world Y) under a point, or -Infinity outside the box. */
    const groundAt = (x: number, z: number): number => {
      const s = live.current
      const u = x / s.build!.widthMetres + 0.5
      const v = z / s.build!.depthMetres + 0.5
      if (u < 0 || u > 1 || v < 0 || v > 1) return -Infinity
      return sampleBox(s.heightField!, u, v) * s.exaggeration
    }

    /** March the cursor ray to the terrain surface. Quadratic step spacing keeps
     * samples dense near the camera where a close hit needs precision; a bracket
     * is then bisected so the anchor lands on the surface, not a step past it. */
    const marchToGround = (origin: THREE.Vector3): boolean => {
      const s = live.current
      const far = Math.max(s.build!.widthMetres, s.build!.depthMetres) * 4
      let lo = 0
      for (let i = 1; i <= 96; i++) {
        const t = far * Math.pow(i / 96, 2)
        probe.copy(dir).multiplyScalar(t).add(origin)
        if (probe.y <= groundAt(probe.x, probe.z)) {
          let a = lo
          let b = t
          for (let j = 0; j < 16; j++) {
            const m = (a + b) / 2
            probe.copy(dir).multiplyScalar(m).add(origin)
            if (probe.y <= groundAt(probe.x, probe.z)) b = m
            else a = m
          }
          hit.copy(dir).multiplyScalar((a + b) / 2).add(origin)
          return true
        }
        lo = t
      }
      return false
    }

    const onWheel = (e: WheelEvent) => {
      const s = live.current
      if (!s.controls || !s.build || !s.heightField || s.walking) return
      e.preventDefault()

      const rect = el.getBoundingClientRect()
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1
      const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1
      dir.set(nx, ny, 0.5).unproject(camera).sub(camera.position).normalize()

      // Anchor: terrain under the cursor; failing that (sky, off the box), the
      // cursor ray's crossing of the target's horizontal plane; failing that,
      // the target itself. Everything below works the same on any of them.
      if (!marchToGround(camera.position)) {
        const t = (s.controls.target.y - camera.position.y) / dir.y
        if (Number.isFinite(t) && t > 0) hit.copy(dir).multiplyScalar(t).add(camera.position)
        else hit.copy(s.controls.target)
      }

      // One notch scales the camera-to-anchor distance by 0.95^speed, the same
      // constant-ratio-per-notch law every slippy map uses. Trackpads deliver
      // many small deltas; normalising by 100 keeps them proportional.
      const notches = Math.min(4, Math.max(0.2, Math.abs(e.deltaY) / 100))
      let factor = Math.pow(0.95, s.zoomSpeed * notches)
      if (e.deltaY > 0) factor = 1 / factor

      // Floors and ceilings measured against the anchor: never closer than a
      // hover, never farther than the frame limit. The per-frame terrain clamp
      // in CameraRig still backstops anything this arithmetic misses.
      const d = camera.position.distanceTo(hit)
      if (factor < 1) factor = Math.max(factor, Math.min(1, 65 / Math.max(d, 1e-6)))
      else {
        const maxD = (live.current.build!.widthMetres + live.current.build!.depthMetres) * 3
        factor = Math.min(factor, Math.max(1, maxD / Math.max(d, 1e-6)))
      }

      camera.position.sub(hit).multiplyScalar(factor).add(hit)
      s.controls.target.sub(hit).multiplyScalar(factor).add(hit)

      // The controls never see this gesture, so fire their 'end' ourselves —
      // it is what persists the camera to the session.
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => live.current.controls?.dispatchEvent?.({ type: 'end' }), 350)
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      clearTimeout(saveTimer)
    }
  }, [gl, camera])

  return null
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
  const exaggeration = useStore((s) => s.settings.exaggeration)
  const imagery = useStore((s) => s.imagery)
  const loadSatRing = useStore((s) => s.loadSatRing)
  const clearSatRings = useStore((s) => s.clearSatRings)

  /** Frame-loop scratch — allocated once, reused every frame. */
  const groundPoint = useRef(new THREE.Vector3()).current
  const cornerRay = useRef(new THREE.Vector3()).current

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

    // Ring 0 is sized to the ground the SCREEN can see, not to the eye distance.
    // The whole point of the close-up is that a top-down view is one resolution
    // edge to edge — a viewport with a sharp square in the middle is a bug, not a
    // level of detail. Two things make the footprint the only trustworthy input:
    // corner rays measure what is actually in frame regardless of tilt, and the
    // orbit target cannot be trusted for height — walking mode and low passes
    // leave it floating near the camera, which is how ring sizing shrank to a
    // postage stamp while the camera was kilometres up. So the ground plane comes
    // from the height field under the look point, and the viewing distance is
    // measured to that ground, never to the target.
    const target = controls?.target ?? camera.position
    const b = heightField.bounds
    const lonSpan = b.east - b.west
    const latSpan = b.north - b.south
    const u = target.x / build.widthMetres + 0.5
    const v = target.z / build.depthMetres + 0.5
    const cLon = b.west + u * lonSpan
    const cLat = b.north - v * latSpan

    const groundY = sampleBox(heightField, u, v) * exaggeration
    groundPoint.set(target.x, groundY, target.z)
    const dist = Math.max(200, camera.position.distanceTo(groundPoint))

    // Where the four screen corners land on the ground plane. A corner looking
    // at sky (tilted views) is capped rather than infinite: past ~4x the viewing
    // distance perspective has compressed the ground so hard that the outer
    // rings and base cover it at the zoom a fetch would return anyway.
    let footprint = 0
    for (let i = 0; i < 4; i++) {
      const ray = cornerRay
        .set(i & 1 ? 1 : -1, i & 2 ? 1 : -1, 0.5)
        .unproject(camera)
        .sub(camera.position)
      const t = ray.y < -1e-9 ? (groundY - camera.position.y) / ray.y : -1
      const hit =
        t > 0
          ? Math.hypot(
              camera.position.x + ray.x * t - target.x,
              camera.position.z + ray.z * t - target.z,
            )
          : Infinity
      footprint = Math.max(footprint, Math.min(hit, dist * 4))
    }
    // Every corner missed (camera under the terrain, or some degenerate pose):
    // fall back to eye distance rather than collapsing the rings.
    if (footprint === 0) footprint = dist * 1.2

    const ceiling = Math.min(11 + 2 * boost, 19)
    for (let k = 0; k < 4; k++) {
      // Classic clipmap geometry outward from the footprint: each ring doubles in
      // extent and drops exactly one zoom, which is what perspective needs per
      // doubling of distance. Top-down, rings 1-3 sit entirely off-screen as
      // pre-loaded pan margin; tilted, they carry the compressed far field.
      const half = Math.max(250, footprint * 1.1) * Math.pow(2, k)
      const step = Math.round(Math.log2(half))

      // Refetch when the ring's key changes in EITHER direction — sharper, coarser
      // or elsewhere. Keeping a sharper ring on zoom-out sounds free (geo-anchored
      // imagery minifies through its mipmaps), but Esri's captures differ between
      // zoom levels — different dates, different seasons, different colour — so a
      // retained patch reads as a mismatched square floating in the view. A
      // uniform viewport at one zoom beats a patchwork of sharper leftovers, and
      // the refetch is cheap anyway: the coarser tiles were cached on the way
      // down, and the seed makes the swap invisible.
      // The drift threshold is deliberately small: re-centres are seeded and
      // incremental now, so tracking the camera closely costs a fetch, not a blink.
      const prev = lastFetch.current[k]
      if (prev) {
        const prevHalf = Math.pow(2, prev.step)
        const dxM = ((cLon - prev.lon) / lonSpan) * build.widthMetres
        const dzM = ((prev.lat - cLat) / latSpan) * build.depthMetres
        const drifted = Math.hypot(dxM, dzM) > prevHalf * 0.18
        if (step === prev.step && !drifted) continue
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
      }, ceiling - k)
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
  const heightField = useStore((s) => s.heightField)
  const build = useStore((s) => s.build)
  const exaggeration = useStore((s) => s.settings.exaggeration)
  const walking = useStore((s) => s.walking)

  useEffect(() => {
    // The near plane must not scale with the box: it used to, and on a 500 km box
    // that put it 200 m out — which is also why the zoom floor had to be high. The
    // renderer runs a logarithmic depth buffer, so a small constant near against a
    // box-scaled far costs nothing in precision.
    camera.near = Math.max(2, size * 0.00002)
    camera.far = size * 200
    camera.updateProjectionMatrix()
  }, [camera, size])

  // Terrain collision. OrbitControls' zoom floor measures distance to the orbit
  // target, and the target lives on an abstract horizontal plane — not on the
  // ground. Over high terrain a descent can therefore carry the camera straight
  // through the surface into empty sky-dome blue. The terrain itself is the only
  // honest floor: sample the height field under the camera every frame and keep
  // the eye a hover above it. Walking mode manages its own camera and is exempt.
  useFrame(() => {
    if (!build || !heightField || walking) return
    const u = camera.position.x / build.widthMetres + 0.5
    const v = camera.position.z / build.depthMetres + 0.5
    if (u < 0 || u > 1 || v < 0 || v > 1) return
    const floor = sampleBox(heightField, u, v) * exaggeration + 25
    if (camera.position.y < floor) camera.position.y = floor
  })

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
        {/* Zoom is NOT OrbitControls' job here — ZoomToGround owns the wheel,
            anchoring every notch to the terrain under the cursor (OrbitControls'
            own dolly, zoomToCursor included, aims at the orbit target's depth
            instead of the ground, which slides the world sideways while zooming).
            screenSpacePanning stays off so drag-panning moves along the ground
            plane rather than the screen plane — the mapping-app pan. */}
        <ZoomToGround />
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          rotateSpeed={0.6}
          enableZoom={false}
          screenSpacePanning={false}
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
