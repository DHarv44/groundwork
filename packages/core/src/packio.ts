import type { Bounds } from './geo'
import { boundsExtentMetres } from './geo'
import type { HeightField } from './field'
import type { PackAttribution, PackLayer, PackManifest } from './pack'
import {
  PACK_FORMAT_VERSION,
  PACK_MANIFEST_FILE,
  PACK_VECTORS_FILE,
  dequantise,
  layerByteLength,
  layerSize,
  quantise,
  serialiseVectors,
  validateManifest,
} from './pack'
import type { PackVectors } from './vector'
import { unzip, zip, type ZipEntry } from './zip'

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

// ---- the delta16-split filter ----------------------------------------------

/**
 * Running difference, then byte-plane split.
 *
 * The two halves do different jobs. The difference makes neighbouring samples nearly
 * equal, so most deltas are small; the split then puts every high byte together, and
 * a small delta's high byte is 0x00 going up or 0xff going down. That plane turns into
 * long runs deflate eats, while the low plane stays noisy but is only half the data.
 *
 * Interleaved, the noisy byte sits between every pair of smooth ones and deflate can
 * find almost nothing — which is exactly the 1.1× measured on real quantised terrain.
 */
function applyDelta16Split(src: Uint16Array): Uint8Array {
  const n = src.length
  const out = new Uint8Array(n * 2)
  let prev = 0
  for (let i = 0; i < n; i++) {
    const v = src[i]!
    const d = (v - prev) & 0xffff
    prev = v
    out[i] = d >>> 8
    out[n + i] = d & 0xff
  }
  return out
}

function undoDelta16Split(src: Uint8Array): Uint16Array<ArrayBuffer> {
  const n = src.length >> 1
  const out = new Uint16Array(n)
  let prev = 0
  for (let i = 0; i < n; i++) {
    prev = (prev + ((src[i]! << 8) | src[n + i]!)) & 0xffff
    out[i] = prev
  }
  return out
}

/**
 * De-interleave a multi-channel `uint8` plane, differencing each channel on its own.
 *
 * Measured on a real hydrology field: 7.92 MB interleaved, 5.14 MB like this. Dropping
 * the unused alpha channel instead only reached 7.23 MB — because a constant channel
 * costs almost nothing once deflate can *see* it as a run, and interleaving is exactly
 * what stops it. That is also why this beats trimming channels outright: which ones are
 * empty depends on the place, and separating them lets each box pay only for what it
 * actually has.
 */
function applyDelta8Planar(src: Uint8Array, channels: number): Uint8Array {
  const n = src.length / channels
  const out = new Uint8Array(src.length)
  for (let c = 0; c < channels; c++) {
    const base = c * n
    let prev = 0
    for (let i = 0; i < n; i++) {
      const v = src[i * channels + c]!
      out[base + i] = (v - prev) & 0xff
      prev = v
    }
  }
  return out
}

function undoDelta8Planar(src: Uint8Array, channels: number): Uint8Array<ArrayBuffer> {
  const n = src.length / channels
  const out = new Uint8Array(src.length)
  for (let c = 0; c < channels; c++) {
    const base = c * n
    let prev = 0
    for (let i = 0; i < n; i++) {
      prev = (prev + src[base + i]!) & 0xff
      out[i * channels + c] = prev
    }
  }
  return out
}

/**
 * A raster plane's samples.
 *
 * The buffer parameter is pinned to `ArrayBuffer` rather than left as the default
 * `ArrayBufferLike`. It is always a real one — the views are constructed over a
 * sliced buffer a few lines below — and the loose form makes the result unusable
 * anywhere a `BufferSource` is wanted, which is to say anywhere a consumer would
 * actually put it, such as straight into a `THREE.DataTexture`.
 */
export type RasterData =
  | Uint8Array<ArrayBuffer>
  | Uint16Array<ArrayBuffer>
  | Float32Array<ArrayBuffer>

/** The typed view over a raster plane, without interpreting what it means. */
export function readRaster(
  files: PackFiles,
  id: string,
): {
  layer: PackLayer
  data: RasterData
  width: number
  height: number
} | null {
  const layer = files.manifest.layers.find((l) => l.id === id)
  if (!layer) return null
  const buf = files.rasters.get(id)
  if (!buf) return null

  const { width, height } = layerSize(layer, files.manifest)
  const expected = layerByteLength(layer, width, height)
  if (buf.byteLength !== expected) {
    throw new Error(
      `pack layer "${id}": ${buf.byteLength} bytes, expected ${expected} — ` +
        `${width}×${height}×${layer.channels} ${layer.format}`,
    )
  }

  if (layer.filter === 'delta16-split') {
    if (layer.format !== 'uint16') {
      throw new Error(`pack layer "${id}": delta16-split only applies to uint16, not ${layer.format}`)
    }
    return { layer, data: undoDelta16Split(new Uint8Array(buf)), width, height }
  }

  if (layer.filter === 'delta8-planar') {
    if (layer.format !== 'uint8') {
      throw new Error(`pack layer "${id}": delta8-planar only applies to uint8, not ${layer.format}`)
    }
    return { layer, data: undoDelta8Planar(new Uint8Array(buf), layer.channels), width, height }
  }

  return { layer, data: new TYPED[layer.format](buf), width, height }
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
  /** Own dimensions, when the plane is not on the elevation grid. */
  width?: number
  height?: number
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
  const filtered = applyDelta16Split(q)
  rasters.set('elevation', filtered.buffer as ArrayBuffer)
  layers.push({
    id: 'elevation',
    file: 'elevation.bin',
    format: 'uint16',
    channels: 1,
    filter: 'delta16-split',
    min: hf.min,
    max: hf.max,
    description: 'Metres above sea level, row-major, north row first.',
  })

  for (const l of input.layers ?? []) {
    const lw = l.width ?? hf.width
    const lh = l.height ?? hf.height
    const expected = lw * lh * l.channels
    if (l.data.length !== expected) {
      throw new Error(
        `pack layer "${l.id}": ${l.data.length} samples, expected ${expected} ` +
          `(${lw}×${lh}×${l.channels})`,
      )
    }
    // Interleaved multi-channel bytes are the case deflate handles worst, so they get
    // separated. A single channel is already planar and gains nothing from the pass.
    const format = formatOf(l.data)
    const planar = format === 'uint8' && l.channels > 1
    const body = planar
      ? applyDelta8Planar(l.data as Uint8Array, l.channels)
      : (l.data as Uint8Array | Uint16Array | Float32Array)

    rasters.set(l.id, body.buffer as ArrayBuffer)
    layers.push({
      id: l.id,
      file: `${l.id}.bin`,
      format,
      channels: l.channels,
      ...(planar ? { filter: 'delta8-planar' as const } : {}),
      ...(l.width !== undefined ? { width: l.width } : {}),
      ...(l.height !== undefined ? { height: l.height } : {}),
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

// ---- the single-file container ---------------------------------------------

/** Conventional extension. A pack is an ordinary ZIP; this is only a hint to a person. */
export const PACK_EXTENSION = '.gwpack'

/**
 * Flatten a pack to one file.
 *
 * A pack is several files, and a download is one — so the wire form is a ZIP. Nothing
 * about the container is bespoke: any unzip tool opens it, which matters for anyone
 * trying to work out what a pack of theirs actually contains without our code.
 *
 * The manifest goes in first so a reader that streams gets the index before the bulk.
 */
export async function packToBytes(files: PackFiles): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const entries: ZipEntry[] = [
    {
      name: PACK_MANIFEST_FILE,
      data: enc.encode(JSON.stringify(files.manifest, null, 2)),
    },
  ]

  for (const layer of files.manifest.layers) {
    const buf = files.rasters.get(layer.id)
    if (!buf) throw new Error(`pack layer "${layer.id}" is in the manifest but has no data`)
    entries.push({ name: layer.file, data: new Uint8Array(buf) })
  }

  if (files.vectors !== undefined) {
    entries.push({ name: PACK_VECTORS_FILE, data: enc.encode(files.vectors) })
  }

  return zip(entries, files.manifest.createdAt)
}

/**
 * Read a pack back out of its container.
 *
 * The manifest is validated before anything is indexed by it, because every read past
 * this point is sized and typed from what it claims — a manifest that disagrees with
 * the bytes produces terrain that renders as noise rather than an error, and that is
 * a long way to travel from the actual fault.
 */
export async function packFromBytes(buf: ArrayBuffer): Promise<PackFiles> {
  const files = await unzip(buf)

  const manifestBytes = files.get(PACK_MANIFEST_FILE)
  if (!manifestBytes) throw new Error(`pack has no ${PACK_MANIFEST_FILE}`)
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as PackManifest

  const problems = validateManifest(manifest)
  if (problems.length > 0) throw new Error(`pack manifest is invalid: ${problems.join('; ')}`)

  const rasters = new Map<string, ArrayBuffer>()
  for (const layer of manifest.layers) {
    const bytes = files.get(layer.file)
    if (!bytes) throw new Error(`pack is missing ${layer.file} for layer "${layer.id}"`)
    // sliced, so the returned buffer is exactly the layer rather than a window onto
    // the whole archive — a typed-array view over the latter would silently read past
    // the end of the plane.
    rasters.set(layer.id, bytes.slice().buffer)
  }

  const vectorBytes = manifest.vectors ? files.get(manifest.vectors) : undefined

  return {
    manifest,
    rasters,
    ...(vectorBytes ? { vectors: new TextDecoder().decode(vectorBytes) } : {}),
  }
}
