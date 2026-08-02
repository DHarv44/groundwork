/**
 * The mesh builder is now `@dharv44/groundwork-engine`.
 *
 * Re-exported here so existing imports keep resolving while the split proceeds; call
 * sites move to the package as each area is touched, rather than in one sweep that
 * would put a rename on top of every other change in the branch.
 */
export type { TerrainBuild } from '@dharv44/groundwork-engine'
export { buildTerrain, sampleBilinear } from '@dharv44/groundwork-engine'
