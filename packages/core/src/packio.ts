import type { Bounds } from './geo'
import { boundsExtentMetres } from './geo'
import type { HeightField } from './field'
import type { PackAttribution, PackLayer, PackManifest } from './pack'
import {
  PACK_FORMAT_VERSION,
  PACK_VECTORS_FILE,
  dequantise,
  layerByteLength,
  quantise,
  serialiseVectors,
} from './pack'
import type { PackVectors } from './vector'

/**
 * Reading and writing pack bytes.
 *
 * Bytes in, bytes out — no fetch, no filesystem. Core has no DOM lib, so it could not
 * reach a network even if someone wanted it to, and that is deliberate: a pack might
 * arrive over HTTP, out of a zip, from disk in a Node baker, or from an
 * `<input type="file">`, and none of those belong in the decoder. The host gets the
 * bytes however it likes and hands them over.
 */

/** A pack's contents, however the host obtained them. */
export interface PackFiles {
  manifest: PackManifest
  /** Raster planes, keyed by layer id — not by filename. */
  rasters: Map<string, ArrayBuffer>
  /** The raw text of `vectors.json`, if the pack has one. */
  vectors?: string
}

const TYPED = {
  uint8: Uint8Array,
  uint16: Uint16Array,
  float32: Float32Array,
} as const

/** The typed view over a raster plane, without interpreting what it means. */
export function readRaster(
  files: PackFiles,
  id: string,
): { layer: PackLayer; data: Uint8Array | Uint16Array | Float32Array } | null {
  const layer = files.manifest.layers.find((l) => l.id === id)
  if (!layer) return null
  const buf = files.rasters.get(id)
  if (!buf) return null

  const expected = layerByteLength(layer, files.manifest.width, files.manifest.height)
  if (buf.byteLength !== expected) {
    throw new Error(
      `pack layer "${id}": ${buf.byteLength} bytes, expected ${expected} — ` +
        `${files.manifest.width}×${files.manifest.height}×${layer.channels} ${layer.format}`,
    )
  }
  return { layer, data: new TYPED[layer.format](buf) }
}

/**
 * The elevation plane as a `HeightField`, ready for the mesh builder.
 *
 * This is what closes the loop: a renderer handed a pack produces the same structure
 * it would have got from a live DEM fetch, so nothing downstream of here knows or
 * cares which one it was.
 */
export function readHeightField(files: PackFiles): HeightField {
  const found = readRaster(files, 'elevation')
  if (!found) throw new Error('pack has no elevation layer')
  const { layer, data } = found
  const m = files.manifest

  let heights: Float32Array
  if (data instanceof Float32Array) {
    heights = data
  } else if (data instanceof Uint16Array) {
    if (layer.min === undefined || layer.max === undefined) {
      throw new Error('quantised elevation layer has no min/max to dequantise with')
    }
    heights = dequantise(data, layer.min, layer.max)
  } else {
    throw new Error(`elevation layer is ${layer.format}, which is too coarse to be heights`)
  }

  return {
    width: m.width,
    height: m.height,
    data: heights,
    bounds: m.bounds,
    min: m.elevation.min,
    max: m.elevation.max,
    demtype: m.id,
    // A pack records filled heights; whatever voids the source had were resolved
    // before it was written, and the count is not recoverable from the result.
    voids: 0,
  }
}

// ---- writing ---------------------------------------------------------------

/** An extra plane to ship alongside the elevation. */
export interface PackInputLayer {
  id: string
  data: Uint8Array | Uint16Array | Float32Array
  channels: number
  description?: string
  /** Required for a quantised plane that means a measurement rather than an index. */
  min?: number
  max?: number
}

export interface PackInput {
  id: string
  name: string
  description?: string
  heights: HeightField
  layers?: PackInputLayer[]
  vectors?: PackVectors
  attribution: PackAttribution[]
  /** Tool and version doing the writing, for chasing down a bad bake. */
  generator: string
  /**
   * ISO 8601, supplied by the caller rather than read from a clock here.
   *
   * Injected so a baker can produce byte-identical output twice — which is what makes
   * a rebuild diffable and a regression test possible at all.
   */
  createdAt: string
}

function formatOf(a: Uint8Array | Uint16Array | Float32Array): PackLayer['format'] {
  if (a instanceof Uint8Array) return 'uint8'
  if (a instanceof Uint16Array) return 'uint16'
  return 'float32'
}

/**
 * Assemble a pack from data already in hand.
 *
 * Nothing here fetches or derives — every input is expected to be resident. That is
 * the rule the export side is built around: if a pack needs something, it is loaded
 * long before this is called, never during.
 */
export function buildPack(input: PackInput): PackFiles {
  const hf = input.heights
  const extent = boundsExtentMetres(hf.bounds)

  const rasters = new Map<string, ArrayBuffer>()
  const layers: PackLayer[] = []

  const q = quantise(hf.data, hf.min, hf.max)
  rasters.set('elevation', q.buffer as ArrayBuffer)
  layers.push({
    id: 'elevation',
    file: 'elevation.bin',
    format: 'uint16',
    channels: 1,
    min: hf.min,
    max: hf.max,
    description: 'Metres above sea level, row-major, north row first.',
  })

  for (const l of input.layers ?? []) {
    const expected = hf.width * hf.height * l.channels
    if (l.data.length !== expected) {
      throw new Error(
        `pack layer "${l.id}": ${l.data.length} samples, expected ${expected} ` +
          `(${hf.width}×${hf.height}×${l.channels})`,
      )
    }
    rasters.set(l.id, l.data.buffer as ArrayBuffer)
    layers.push({
      id: l.id,
      file: `${l.id}.bin`,
      format: formatOf(l.data),
      channels: l.channels,
      ...(l.min !== undefined ? { min: l.min } : {}),
      ...(l.max !== undefined ? { max: l.max } : {}),
      ...(l.description ? { description: l.description } : {}),
    })
  }

  const manifest: PackManifest = {
    formatVersion: PACK_FORMAT_VERSION,
    id: input.id,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    bounds: hf.bounds as Bounds,
    width: hf.width,
    height: hf.height,
    widthMetres: extent.width,
    heightMetres: extent.height,
    elevation: { min: hf.min, max: hf.max },
    layers,
    ...(input.vectors ? { vectors: PACK_VECTORS_FILE } : {}),
    attribution: input.attribution,
    createdAt: input.createdAt,
    generator: input.generator,
  }

  return {
    manifest,
    rasters,
    ...(input.vectors ? { vectors: serialiseVectors(input.vectors) } : {}),
  }
}
