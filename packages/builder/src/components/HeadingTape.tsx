import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'

const WIDTH = 560
const HEIGHT = 46
/** Degrees visible either side of the centre index. */
const HALF_SPAN = 55

function labelFor(deg: number): string {
  if (deg === 0) return 'N'
  if (deg === 90) return 'E'
  if (deg === 180) return 'S'
  if (deg === 270) return 'W'
  return String(deg).padStart(3, '0')
}

/**
 * Aircraft-style heading tape. Drawn to a 2D canvas rather than DOM nodes so the tick
 * marks stay crisp and there is nothing to reflow — it repaints every frame while the
 * camera moves.
 */
export default function HeadingTape({
  target,
}: {
  // React 19: useRef<T>(null) is RefObject<T | null>, and the code already guards
  // against the null anyway — the old annotation was stricter than the caller.
  target: React.RefObject<HTMLCanvasElement | null>
}) {
  const camera = useThree((s) => s.camera)
  const dir = useRef(new THREE.Vector3())
  const lastHeading = useRef(-999)

  // Size the backing store for the display's pixel ratio once.
  useEffect(() => {
    const canvas = target.current
    if (!canvas) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = WIDTH * dpr
    canvas.height = HEIGHT * dpr
    canvas.style.width = `${WIDTH}px`
    canvas.style.height = `${HEIGHT}px`
    canvas.getContext('2d')?.scale(dpr, dpr)
    lastHeading.current = -999
  }, [target])

  useFrame(() => {
    const canvas = target.current
    if (!canvas) return

    camera.getWorldDirection(dir.current)
    // World −Z is north; heading grows clockwise.
    let heading = (Math.atan2(dir.current.x, -dir.current.z) * 180) / Math.PI
    if (heading < 0) heading += 360

    // Skip the repaint when nothing moved enough to change a pixel.
    if (Math.abs(heading - lastHeading.current) < 0.05) return
    lastHeading.current = heading

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, WIDTH, HEIGHT)

    const cx = WIDTH / 2
    const pxPerDeg = cx / HALF_SPAN
    const baseline = HEIGHT - 12

    ctx.font = '10px ui-monospace, Consolas, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'

    const first = Math.ceil((heading - HALF_SPAN) / 5) * 5
    for (let a = first; a <= heading + HALF_SPAN; a += 5) {
      // Shortest signed offset from the centre, so the tape wraps through 360.
      let delta = a - heading
      if (delta > 180) delta -= 360
      if (delta < -180) delta += 360

      const x = cx + delta * pxPerDeg
      if (x < 4 || x > WIDTH - 4) continue

      const deg = ((a % 360) + 360) % 360
      const major = deg % 30 === 0
      const medium = deg % 10 === 0

      // Fade toward the ends so the tape reads as continuous.
      const fade = 1 - Math.min(1, Math.abs(delta) / HALF_SPAN) ** 2
      const cardinal = deg % 90 === 0

      ctx.globalAlpha = fade
      ctx.strokeStyle = cardinal ? '#fbbf24' : '#9aa7b8'
      ctx.lineWidth = major ? 1.5 : 1
      const len = major ? 11 : medium ? 7 : 4
      ctx.beginPath()
      ctx.moveTo(x, baseline)
      ctx.lineTo(x, baseline - len)
      ctx.stroke()

      if (major) {
        ctx.fillStyle = cardinal ? '#fbbf24' : '#c3ccd9'
        ctx.fillText(labelFor(deg), x, baseline - 15)
      }
    }

    ctx.globalAlpha = 1

    // Centre index and numeric readout.
    ctx.strokeStyle = '#7dd3fc'
    ctx.fillStyle = '#7dd3fc'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(cx, baseline + 3)
    ctx.lineTo(cx - 5, baseline + 10)
    ctx.lineTo(cx + 5, baseline + 10)
    ctx.closePath()
    ctx.fill()

    ctx.beginPath()
    ctx.moveTo(cx, baseline)
    ctx.lineTo(cx, baseline - 14)
    ctx.stroke()

    ctx.font = '600 11px ui-monospace, Consolas, monospace'
    ctx.fillText(`${Math.round(heading).toString().padStart(3, '0')}°`, cx, 12)
  })

  return null
}
