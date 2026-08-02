/**
 * @dharv44/groundwork-core — the terrain data model.
 *
 * Imports nothing: no three.js, no React, no DOM. The package tsconfig omits the DOM
 * lib so that holds by construction. What it buys is that a headless baker, a pack
 * validator, or a consumer doing routing or mobility over the terrain arrays can read
 * a pack without dragging a renderer in behind it.
 */
export { boundsAreaKm2, boundsExtentMetres, boxToLonLat, latToTileY, lonLatToBox, lonToTileX, metresPerDegLat, metresPerDegLon, } from './geo';
export { sampleBilinear, sampleBox } from './field';
export { ROAD_CLASSES, ROAD_WIDTH_METRES } from './vector';
export { PACK_EXTENSION, buildPack, packFromBytes, packToBytes, readHeightField, readRaster, } from './packio';
export { canCompress, unzip, zip } from './zip';
export { PACK_FORMAT_VERSION, PACK_MANIFEST_FILE, PACK_VECTORS_FILE, dequantise, layerByteLength, layerSize, parseVectors, quantise, serialiseVectors, validateManifest, } from './pack';
//# sourceMappingURL=index.js.map