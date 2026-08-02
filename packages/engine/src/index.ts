/**
 * @dharv44/groundwork-engine — the terrain renderer.
 *
 * Plain three.js, not R3F: React Three Fiber would pin a React version and a
 * reconciler onto every consumer, and this has to drop into whatever is already
 * running. It owns neither the `WebGLRenderer` nor the frame loop — you get objects
 * and an update call, and the host drives them from the loop it already has.
 *
 * It also does no network and bundles no assets. Everything it needs arrives as data.
 */

export type { TerrainBuild } from './terrain/mesh'
export { buildTerrain, sampleBilinear } from './terrain/mesh'

export type { SkyModel } from './atmosphere'
export { computeSky } from './atmosphere'

export { terrainFragmentShader, terrainVertexShader } from './terrain/shader'
export type { SurfaceConfig, SurfaceLayers, SurfaceTextureMode } from './terrain/surface'
export { TerrainSurface } from './terrain/surface'

export { DEFAULT_SURFACE_CONFIG, DEFAULT_WATER_CONFIG } from './defaults'

export { waterFragmentShader, waterVertexShader } from './water/shader'
export type { WaterConfig } from './water/plane'
export { WaterPlane } from './water/plane'

export { skyFragmentShader, skyVertexShader } from './sky/shader'
export { SkyDome } from './sky/dome'
