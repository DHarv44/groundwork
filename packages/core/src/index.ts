/**
 * @groundwork/core — the terrain data model.
 *
 * Imports nothing: no three.js, no React, no DOM. The package tsconfig omits the DOM
 * lib so that holds by construction. What it buys is that a headless baker, a pack
 * validator, or a consumer doing routing or mobility over the terrain arrays can read
 * a pack without dragging a renderer in behind it.
 */

export type { Bounds, BoxPoint } from './geo'
export {
  boundsAreaKm2,
  boundsExtentMetres,
  boxToLonLat,
  latToTileY,
  lonLatToBox,
  lonToTileX,
  metresPerDegLat,
  metresPerDegLon,
} from './geo'

export type { HeightField } from './field'
export { sampleBilinear, sampleBox } from './field'

export type {
  AreaKind,
  PackArea,
  PackPlace,
  PackRoad,
  PackVectors,
  RoadClass,
} from './vector'
export { ROAD_CLASSES, ROAD_WIDTH_METRES } from './vector'

export type { PackFiles, PackInput, PackInputLayer } from './packio'
export {
  PACK_EXTENSION,
  buildPack,
  packFromBytes,
  packToBytes,
  readHeightField,
  readRaster,
} from './packio'

export type { ZipEntry } from './zip'
export { unzip, zip } from './zip'

export type { PackAttribution, PackLayer, PackManifest } from './pack'
export {
  PACK_FORMAT_VERSION,
  PACK_MANIFEST_FILE,
  PACK_VECTORS_FILE,
  dequantise,
  layerByteLength,
  layerSize,
  parseVectors,
  quantise,
  serialiseVectors,
  validateManifest,
} from './pack'
