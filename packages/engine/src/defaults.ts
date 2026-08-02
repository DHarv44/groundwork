import type { SurfaceConfig } from './terrain/surface'
import type { WaterConfig } from './water/plane'

/**
 * Starting values, so a consumer does not have to invent forty numbers to get a
 * picture.
 *
 * These are the builder's own defaults for a box whose climate is not yet known — a
 * temperate, moderately vegetated look that reads plausibly almost anywhere. They are
 * a starting point, not a recommendation: anything driving this seriously will
 * override most of them, and the builder does exactly that per Köppen class.
 *
 * Spread into an object rather than passed by reference; `SurfaceConfig` is mutable
 * and shared defaults that a caller can edit in place are a trap.
 */
export const DEFAULT_SURFACE_CONFIG: Readonly<SurfaceConfig> = Object.freeze({
  exaggeration: 1.6,
  textureMode: 'procedural' as const,
  wireframe: false,

  snowLine: 2600,
  treeLine: 1900,
  aridity: 0.12,
  strata: 0.25,
  riparian: 0.4,
  riparianReach: 0.32,
  groundWarmth: 0.05,

  forest: 0.6,
  vegTint: 0,
  vegSat: 1,
  treeNeed: 1.2,
  treeLimit: 400,
  treeSpread: 0.04,
  treeFractal: 0.45,
  treeRough: 0.5,
  treeRoughScale: 25,
  corridorLeaf: 0.6,
  showTrees: true,
  showGrass: true,
  showSnow: true,

  rivers: 1,
  riverThreshold: 0.175,
  waveHeight: 0,
  showRivers: true,
  showLakes: true,

  showRoads: true,
  roadDarkness: 0.55,
  roadClearing: 0.6,
  roadTint: 0.35,

  osmWater: 1,
  osmWood: 0.7,
  osmBuilt: 0.65,

  textureRange: 1,
  shadows: true,
  aoStrength: 0.85,
  microDetail: 0.6,
  fogDensity: 0,
})

export const DEFAULT_WATER_CONFIG: Readonly<WaterConfig> = Object.freeze({
  exaggeration: 1.6,
  seaLevel: 0,
  shoreCutoff: 0.25,
  shoreFeather: 0,
  depthFade: 75,
  waveHeight: 0,
  foamWidth: 0,
  opacity: 0.57,
  fogDensity: 0,
})
