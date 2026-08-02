/**
 * @dharv44/groundwork-builder — the authoring tool.
 *
 * Mounts as a component rather than owning a page. Everything the host controls —
 * storage namespace, service endpoints, asset base — goes through `configureBuilder`,
 * which must be called before the component mounts.
 *
 *   import { Builder, configureBuilder } from '@dharv44/groundwork-builder'
 *   import '@dharv44/groundwork-builder/styles.css'
 *
 *   configureBuilder({ storagePrefix: 'my-app.terrain' })
 *   <Builder />
 *
 * The stylesheet is a separate export rather than imported here, so a host that
 * bundles CSS its own way is not forced into ours. Every rule in it is scoped to
 * `.gw`, which the component puts on its own root — nothing reaches outside.
 *
 * Its output is a pack, and it does not know what consumes one.
 */

export { default as Builder } from './App'

export type { BuilderConfig, BuilderEndpoints } from './config'
export { builderConfig, configureBuilder, storageKey } from './config'

export type { PackExportInput, PackExportSummary } from './lib/packexport'
export {
  buildPackFrom,
  exportPack,
  packBytesFrom,
  packFileName,
  summarisePack,
} from './lib/packexport'

export { useStore } from './store'
export type { Settings } from './store'
