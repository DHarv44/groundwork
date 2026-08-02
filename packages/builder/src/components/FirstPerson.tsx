import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useStore } from '../store'
import { sampleBilinear } from '../lib/mesh'

/**
 * Stand on the ground and walk about.
 *
 * Double-click anywhere on the terrain to drop to eye height at that spot; Escape puts
 * you back exactly where you were looking from. The orbit view is the one you work in,
 * so this is deliberately a detour rather than a mode you can get stranded in — nothing
 * about the scene changes while you are down there, and leaving restores the camera
 * rather than reframing it.
 *
 * Escape needs no key handler. Requesting pointer lock hands Escape to the browser,
 * which releases the lock itself, so listening for the release is both simpler and
 * impossible to get out of step with — there is no state where the pointer is free but
 * the app still thinks you are walking.
 */

/** Eye height above the ground, metres. */
const EYE = 2

/** Metres per second on foot, and with the shift key down. */
const WALK = 6
const RUN = 45

/** Radians of look per pixel of mouse travel. */
const LOOK = 0.0022

/** How far the camera can pitch before it would flip over. */
const MAX_PITCH = Math.PI / 2 - 0.02

interface OrbitLike {
  enabled: boolean
  target: THREE.Vector3
  update: () => void
}

interface Saved {
  pos: THREE.Vector3
  quat: THREE.Quaternion
  target: THREE.Vector3
  near: number
  far: number
}

export default function FirstPerson() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const controls = useThree((s) => s.controls) as OrbitLike | null
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)

  const build = useStore((s) => s.build)
  const heightField = useStore((s) => s.heightField)
  const exaggeration = useStore((s) => s.settings.exaggeration)
  const walking = useStore((s) => s.walking)
  const setWalking = useStore((s) => s.setWalking)

  const saved = useRef<Saved | null>(null)
  const yaw = useRef(0)
  const pitch = useRef(0)
  const keys = useRef<Record<string, boolean>>({})

  /**
   * Ground height under a world position — sampled on the *mesh's* lattice, not the
   * DEM's.
   *
   * These are different surfaces and the difference is not small. The DEM here is 30 m,
   * the mesh is built by taking roughly every fifth sample of it, so what you stand on
   * is a 142 m lattice. Measured across this tile the two disagree by 5 m on average and
   * up to 100 m in broken ground, and the drawn surface is the higher one 51% of the
   * time — so sampling the DEM put the camera inside the hillside more often than not,
   * and no eye height fixes that because the error has no bound.
   *
   * Reading the same lattice the mesh was built from means walking on exactly what is
   * being drawn, and it costs the same four lookups. Bilinear rather than nearest, so
   * the walk does not stair-step from quad to quad.
   *
   * Two residuals are left on purpose. The mesh is triangles and this is a curved patch,
   * so they agree at the corners and differ slightly between them — well under a metre
   * at this spacing, which the clearance absorbs. And at 30 m the ground is an average
   * over a 30 m cell to begin with: boulders, ditches and stream banks are not in the
   * data at all, so this glides over a smoothed landscape however it is sampled.
   */
  const groundAt = useRef<(x: number, z: number) => number>(() => 0)
  useEffect(() => {
    if (!build || !heightField) return
    const hf = heightField
    const gw = build.gridX
    const gh = build.gridY
    const dw = hf.width
    const dh = hf.height

    // A lattice vertex sits exactly where buildTerrain put it: the DEM sampled
    // bilinearly at a half-cell offset, because DEM samples are area-based and their
    // centres sit at i + 0.5. Using nearest, or dropping the offset, shifts this
    // surface half a cell away from the one being drawn.
    const vertex = (i: number, j: number) =>
      sampleBilinear(hf, (i / (gw - 1)) * dw - 0.5, (j / (gh - 1)) * dh - 0.5)

    const halfW = build.widthMetres / 2
    const halfD = build.depthMetres / 2

    groundAt.current = (x: number, z: number) => {
      // Row 0 is the north edge, which is -Z.
      const u = THREE.MathUtils.clamp((x + halfW) / build.widthMetres, 0, 1) * (gw - 1)
      const v = THREE.MathUtils.clamp((z + halfD) / build.depthMetres, 0, 1) * (gh - 1)
      const i0 = Math.min(gw - 2, Math.floor(u))
      const j0 = Math.min(gh - 2, Math.floor(v))
      const fx = u - i0
      const fy = v - j0

      const a = vertex(i0, j0)
      const b = vertex(i0 + 1, j0)
      const c = vertex(i0, j0 + 1)
      const d = vertex(i0 + 1, j0 + 1)

      // Inside a quad the drawn surface is two flat triangles, not the curved patch a
      // bilinear blend describes, and across 142 m of ground the two can differ by
      // metres rather than centimetres. Which way the quad is split decides which is
      // higher, so both splits are evaluated and the higher taken: standing a little
      // proud of the surface is invisible, standing inside it is not.
      const adSplit = fx >= fy ? a + (b - a) * fx + (d - b) * fy : a + (c - a) * fy + (d - c) * fx
      const bcSplit =
        fx + fy <= 1
          ? a + (b - a) * fx + (c - a) * fy
          : d + (c - d) * (1 - fx) + (b - d) * (1 - fy)

      return Math.max(adSplit, bcSplit) * exaggeration
    }
  }, [build, heightField, exaggeration])

  // Drop in on a double-click, landing where the click actually hit the ground.
  useEffect(() => {
    const el = gl.domElement
    if (!build) return

    const onDouble = (e: MouseEvent) => {
      const mesh = scene.getObjectByName('terrain') as THREE.Mesh | undefined
      if (!mesh || !controls) return

      const rect = el.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
      const ray = new THREE.Raycaster()
      ray.setFromCamera(ndc, camera)
      const hit = ray.intersectObject(mesh, false)[0]
      if (!hit) return

      saved.current = {
        pos: camera.position.clone(),
        quat: camera.quaternion.clone(),
        target: controls.target.clone(),
        near: camera.near,
        far: camera.far,
      }

      // Face the way the camera was already looking, so the transition does not spin you
      // round on arrival.
      const dir = new THREE.Vector3()
      camera.getWorldDirection(dir)
      yaw.current = Math.atan2(-dir.x, -dir.z)
      pitch.current = 0

      camera.position.set(hit.point.x, groundAt.current(hit.point.x, hit.point.z) + EYE, hit.point.z)
      // The orbit view sets near to a fraction of the tile — tens of metres on a large
      // box — which from head height would clip away everything in front of you.
      camera.near = 0.1
      camera.far = Math.max(build.widthMetres, build.depthMetres) * 4
      camera.updateProjectionMatrix()

      controls.enabled = false
      setWalking(true)
      void el.requestPointerLock()
    }

    el.addEventListener('dblclick', onDouble)
    return () => el.removeEventListener('dblclick', onDouble)
  }, [gl, scene, camera, controls, build, setWalking])

  // Mouse look, and the exit. Escape releases the lock via the browser, so the release
  // is the single signal that we are done — nothing else needs to listen for the key.
  useEffect(() => {
    const el = gl.domElement

    const onMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== el) return
      yaw.current -= e.movementX * LOOK
      pitch.current = THREE.MathUtils.clamp(
        pitch.current - e.movementY * LOOK,
        -MAX_PITCH,
        MAX_PITCH,
      )
    }

    const onLockChange = () => {
      if (document.pointerLockElement === el) return
      // Left the ground: put the camera back exactly as it was.
      const s = saved.current
      if (s && controls) {
        camera.position.copy(s.pos)
        camera.quaternion.copy(s.quat)
        controls.target.copy(s.target)
        camera.near = s.near
        camera.far = s.far
        camera.updateProjectionMatrix()
        controls.enabled = true
        controls.update()
      }
      saved.current = null
      keys.current = {}
      setWalking(false)
    }

    const onKey = (e: KeyboardEvent) => {
      if (document.pointerLockElement !== el) return
      keys.current[e.code] = e.type === 'keydown'
      // Stop the page scrolling under us while walking.
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault()
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('pointerlockchange', onLockChange)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('pointerlockchange', onLockChange)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
    }
  }, [gl, camera, controls, setWalking])

  const forward = useRef(new THREE.Vector3())
  const right = useRef(new THREE.Vector3())

  useFrame((_, delta) => {
    if (!walking) return

    camera.quaternion.setFromEuler(new THREE.Euler(pitch.current, yaw.current, 0, 'YXZ'))

    const k = keys.current
    let fwd = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0)
    let str = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0)
    if (fwd || str) {
      // Movement stays level: looking up should not walk you into the sky.
      forward.current.set(-Math.sin(yaw.current), 0, -Math.cos(yaw.current))
      right.current.set(Math.cos(yaw.current), 0, -Math.sin(yaw.current))
      const speed = (k.ShiftLeft || k.ShiftRight ? RUN : WALK) * delta
      // Normalised so walking diagonally is not faster than walking straight.
      const len = Math.hypot(fwd, str)
      fwd /= len
      str /= len
      camera.position.addScaledVector(forward.current, fwd * speed)
      camera.position.addScaledVector(right.current, str * speed)
    }

    // Follow the ground, whether or not anything moved — the terrain can rebuild under
    // you when a slider changes.
    camera.position.y = groundAt.current(camera.position.x, camera.position.z) + EYE
  })

  return null
}
