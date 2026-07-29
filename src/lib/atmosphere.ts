/**
 * The sky model is now `@groundwork/engine` — it feeds the terrain shader's lighting,
 * so it has to travel with the renderer rather than with the application around it.
 * Re-exported here because that is where call sites already import it from.
 */
export type { SkyModel } from '@groundwork/engine'
export { computeSky } from '@groundwork/engine'
