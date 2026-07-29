/**
 * @groundwork/engine — the terrain renderer.
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

export type { SkyModel } from './sky'
export { computeSky } from './sky'

export { terrainFragmentShader, terrainVertexShader } from './terrain/shader'

export type { SurfaceConfig, SurfaceLayers, SurfaceTextureMode } from './terrain/surface'
export { TerrainSurface } from './terrain/surface'
