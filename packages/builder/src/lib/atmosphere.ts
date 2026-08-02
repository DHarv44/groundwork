/**
 * The sky model is now `@dharv44/groundwork-engine` — it feeds the terrain shader's lighting,
 * so it has to travel with the renderer rather than with the application around it.
 * Re-exported here because that is where call sites already import it from.
 */
export type { SkyModel } from '@dharv44/groundwork-engine'
export { computeSky } from '@dharv44/groundwork-engine'
