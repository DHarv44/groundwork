import * as THREE from 'three'

export interface SkyModel {
  sunDirection: THREE.Vector3
  sunColor: THREE.Color
  skyColor: THREE.Color
  horizonColor: THREE.Color
  groundTint: THREE.Color
}

// Authored as display (sRGB) colours, then converted once to the linear radiance the
// shaders actually work in. Skipping that conversion makes the horizon read as a
// blinding white and washes every distant surface out through the fog term.
const srgb = (r: number, g: number, b: number) => new THREE.Color(r, g, b).convertSRGBToLinear()

const NIGHT_ZENITH = srgb(0.016, 0.024, 0.055)
const DAY_ZENITH = srgb(0.156, 0.302, 0.56)
const NIGHT_HORIZON = srgb(0.03, 0.04, 0.075)
const DUSK_HORIZON = srgb(0.72, 0.36, 0.18)
const DAY_HORIZON = srgb(0.62, 0.72, 0.84)
const SUN_LOW = srgb(1.0, 0.4, 0.16)
const SUN_HIGH = srgb(1.0, 0.965, 0.91)

function lerpColor(a: THREE.Color, b: THREE.Color, t: number): THREE.Color {
  return a.clone().lerp(b, THREE.MathUtils.clamp(t, 0, 1))
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * Sky and sun colour as a function of solar altitude. Not a physical model — it is
 * tuned to land on believable golden-hour, midday and twilight looks.
 */
export function computeSky(azimuthDeg: number, elevationDeg: number): SkyModel {
  const az = THREE.MathUtils.degToRad(azimuthDeg)
  const el = THREE.MathUtils.degToRad(elevationDeg)

  // Azimuth measured clockwise from north; world −Z is north, +X is east.
  const sunDirection = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    -Math.cos(az) * Math.cos(el),
  ).normalize()

  const day = smoothstep(-4, 12, elevationDeg)
  const golden = smoothstep(-6, 8, elevationDeg) * (1 - smoothstep(6, 22, elevationDeg))

  const sunHue = lerpColor(SUN_LOW, SUN_HIGH, smoothstep(0, 22, elevationDeg))
  const sunPower = THREE.MathUtils.lerp(0.05, 1.25, smoothstep(-5, 16, elevationDeg))
  const sunColor = sunHue.clone().multiplyScalar(sunPower)

  const skyColor = lerpColor(NIGHT_ZENITH, DAY_ZENITH, day)
  let horizonColor = lerpColor(NIGHT_HORIZON, DAY_HORIZON, day)
  horizonColor = lerpColor(horizonColor, DUSK_HORIZON, golden * 0.85)

  // Bounce light off the ground, warmed by the sun and dulled at night.
  const groundTint = skyColor
    .clone()
    .lerp(srgb(0.16, 0.14, 0.11), 0.6)
    .multiplyScalar(0.35 + day * 0.5)

  return {
    sunDirection,
    sunColor,
    skyColor,
    horizonColor,
    groundTint,
  }
}
