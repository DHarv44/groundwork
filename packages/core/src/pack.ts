import type { Bounds } from './geo'
import type { PackArea, PackPlace, PackRoad, PackVectors } from './vector'

/**
 * The pack format — the contract between whatever writes terrain and whatever
 * renders it.
 *
 * Versioned from the first write. The lesson is already in this repo: the road cache
 * carries an `OSM_QUERY_VERSION` because an entry that cannot say what shape it is
 * has to be thrown away rather than migrated, and throwing away a cache entry costs
 * one refetch. A pack written by somebody else cannot be thrown away, so the version
 * has to be there before the first one exists rather than after the first one breaks.
 */
export const PACK_FORMAT_VERSION = 1

/** Canonical filenames inside a pack. */
export const PACK_MANIFEST_FILE = 'pack.json'
export const PACK_VECTORS_FILE = 'vectors.json'

/**
 * One raster plane.
 *
 * Self-describing so a reader can be generic: adding imagery, a biome field or a
 * soil layer later is a new entry, not a format change. `id` is deliberately an open
 * string rather than a union — a consumer looks up what it understands and ignores
 * the rest, which is what lets a pack carry more than any one renderer wants.
 */
export interface PackLayer {
  id: string
  /** Filename relative to the pack root. */
  file: string
  format: 'uint8' | 'uint16' | 'float32'
  channels: number
  /**
   * Plane dimensions, when they differ from the manifest's.
   *
   * Derived fields legitimately have their own native resolution — a hydrology pass
   * runs at a routing resolution chosen for the cost of the flood fill, not for the
   * DEM's sample spacing. Forcing every layer to the elevation grid would mean
   * resampling on the way in and again on the way out, which throws away detail in
   * one direction and invents it in the other. Absent means "same as the manifest",
   * which is the common case.
   */
  width?: number
  height?: number
  /**
   * A reversible transform applied to the bytes before they were compressed.
   *
   * `delta16-split` is for `uint16` planes. Quantised elevation resists deflate badly —
   * measured at 1.1× on real terrain — because each sample's low byte is essentially
   * noise while its high byte varies smoothly, and interleaving them buries the smooth
   * signal in the noisy one. The filter takes a running difference between samples and
   * then writes all the high bytes followed by all the low bytes, so the high plane
   * becomes long runs of 0x00 and 0xff. Entirely lossless: it reorders and predicts,
   * it does not discard.
   *
   * `delta8-planar` is the same idea for a multi-channel `uint8` plane: each channel is
   * gathered together and differenced on its own. Interleaved, a noisy channel sits
   * between every pair of smooth ones and deflate can find little; separated, each
   * compresses on its own terms. It also makes a *constant* channel free, which matters
   * because the hydrology field's alpha always is and its lake flag is wherever a box
   * has no lakes — and separating them beats dropping them, because which channels are
   * empty varies from one place to the next.
   *
   * Absent means the bytes are the samples, which is what every earlier pack has.
   */
  filter?: 'delta16-split' | 'delta8-planar'
  /**
   * For quantised integer planes: the real values that map to 0 and to the type's
   * maximum. Absent on `float32` planes and on integer planes that mean their own
   * value (a class index, a boolean).
   */
  min?: number
  max?: number
  /** What the plane holds, for anyone reading the pack without the writer's source. */
  description?: string
}

/**
 * Where the data came from and what that obliges a consumer to do.
 *
 * Structured rather than a prose string because the licences involved require the
 * credit to be *shown*, which means something downstream has to render it — and a
 * consumer cannot render what it cannot parse. OpenStreetMap is ODbL, which also
 * carries share-alike terms onto derived geometry; a pack that gets passed around
 * needs to say so on its own rather than relying on whoever made it to remember.
 */
export interface PackAttribution {
  source: string
  licence: string
  url?: string
  /** Which parts of the pack this covers — layer ids, or `roads` / `areas` / `places`. */
  covers: string[]
}

export interface PackManifest {
  formatVersion: number
  id: string
  name: string
  description?: string

  /** Geographic extent. Every normalised coordinate in the pack is relative to this. */
  bounds: Bounds
  /** Raster dimensions. Every plane in `layers` is exactly this size. */
  width: number
  height: number
  /** Ground size at the box centre latitude. */
  widthMetres: number
  heightMetres: number

  elevation: { min: number; max: number }

  layers: PackLayer[]
  /** Present when the pack ships `vectors.json`. */
  vectors?: string

  attribution: PackAttribution[]
  /** ISO 8601. */
  createdAt: string
  /** Tool and version that wrote this, for chasing down a bad bake. */
  generator: string
}

// ---- quantisation ----------------------------------------------------------

/**
 * Pack a float plane into `Uint16` across a known range.
 *
 * At 16 bits an entire Himalayan box resolves to about 13 cm and a typical one to
 * under 5 cm, which is far inside the noise of any elevation source worth packing —
 * so this is lossless in every way that matters and halves the file.
 */
export function quantise(data: Float32Array, min: number, max: number): Uint16Array {
  const out = new Uint16Array(data.length)
  const s = max > min ? 65535 / (max - min) : 0
  for (let i = 0; i < data.length; i++) {
    const v = Math.round((data[i]! - min) * s)
    out[i] = v < 0 ? 0 : v > 65535 ? 65535 : v
  }
  return out
}

export function dequantise(q: Uint16Array, min: number, max: number): Float32Array {
  const out = new Float32Array(q.length)
  const s = (max - min) / 65535
  for (let i = 0; i < q.length; i++) out[i] = min + q[i]! * s
  return out
}

// ---- vectors ---------------------------------------------------------------

/**
 * `vectors.json` on the wire.
 *
 * Plain number arrays rather than base64: they are readable, diffable, and parse in
 * any language without a decoding step, and against the raster planes the size
 * difference is noise. Coordinates are rounded on write — see `VECTOR_DP`.
 */
interface WireVectors {
  roads: Array<{ cls: PackRoad['cls']; pts: number[] }>
  areas: Array<{ kind: PackArea['kind']; outer: number[][]; inner: number[][] }>
  places: PackPlace[]
}

/**
 * Decimal places kept on normalised vector coordinates.
 *
 * Six places is 1e-6 of the box: about 2.5 cm across 25 km, and under a metre across
 * the widest box the elevation sources will serve. Well below the positional accuracy
 * of the survey data itself, and it keeps the file from filling with float noise.
 */
const VECTOR_DP = 6

function roundFlat(a: Float32Array): number[] {
  const f = 10 ** VECTOR_DP
  const out = new Array<number>(a.length)
  for (let i = 0; i < a.length; i++) out[i] = Math.round(a[i]! * f) / f
  return out
}

export function serialiseVectors(v: PackVectors): string {
  const wire: WireVectors = {
    roads: v.roads.map((r) => ({ cls: r.cls, pts: roundFlat(r.pts) })),
    areas: v.areas.map((a) => ({
      kind: a.kind,
      outer: a.outer.map(roundFlat),
      inner: a.inner.map(roundFlat),
    })),
    places: v.places,
  }
  return JSON.stringify(wire)
}

export function parseVectors(json: string): PackVectors {
  const wire = JSON.parse(json) as WireVectors
  return {
    roads: (wire.roads ?? []).map((r) => ({ cls: r.cls, pts: Float32Array.from(r.pts) })),
    areas: (wire.areas ?? []).map((a) => ({
      kind: a.kind,
      outer: (a.outer ?? []).map((r) => Float32Array.from(r)),
      inner: (a.inner ?? []).map((r) => Float32Array.from(r)),
    })),
    places: wire.places ?? [],
  }
}

// ---- validation ------------------------------------------------------------

/**
 * Check a manifest before anything trusts it.
 *
 * Returns every problem rather than throwing on the first, because the caller is
 * usually a person looking at a pack that somebody else made and the useful answer
 * is the whole list. An empty array means it is structurally sound — not that the
 * data in it is any good.
 */
export function validateManifest(m: unknown): string[] {
  const errs: string[] = []
  if (typeof m !== 'object' || m === null) return ['manifest is not an object']
  const p = m as Partial<PackManifest>

  if (p.formatVersion !== PACK_FORMAT_VERSION) {
    errs.push(
      `formatVersion ${String(p.formatVersion)} — this reader understands ${PACK_FORMAT_VERSION}`,
    )
  }
  if (!p.id) errs.push('missing id')
  if (!p.name) errs.push('missing name')

  const b = p.bounds
  if (!b) errs.push('missing bounds')
  else if (b.north <= b.south || b.east <= b.west) {
    errs.push('bounds are empty or inverted')
  }

  if (!(p.width! > 0) || !(p.height! > 0)) errs.push('width and height must be positive')

  if (!Array.isArray(p.layers) || p.layers.length === 0) {
    errs.push('no raster layers')
  } else {
    if (!p.layers.some((l) => l.id === 'elevation')) errs.push('no elevation layer')
    for (const l of p.layers) {
      if (!l.file) errs.push(`layer ${l.id}: missing file`)
      if (!(l.channels > 0)) errs.push(`layer ${l.id}: channels must be positive`)
      if (l.format !== 'float32' && l.min === undefined) {
        // Not fatal — a class index or a flag legitimately has no range — but a
        // quantised measurement without one is unreadable, and that is the common slip.
        if (l.id === 'elevation') errs.push('elevation layer has no min/max to dequantise with')
      }
    }
  }

  if (!Array.isArray(p.attribution) || p.attribution.length === 0) {
    errs.push('no attribution — every source this is derived from requires credit')
  }

  return errs
}

/** A layer's own dimensions, falling back to the manifest's. */
export function layerSize(
  layer: PackLayer,
  manifest: Pick<PackManifest, 'width' | 'height'>,
): { width: number; height: number } {
  return {
    width: layer.width ?? manifest.width,
    height: layer.height ?? manifest.height,
  }
}

/** Bytes one plane of a layer occupies, for sizing a read. */
export function layerByteLength(layer: PackLayer, width: number, height: number): number {
  const bytes = layer.format === 'uint8' ? 1 : layer.format === 'uint16' ? 2 : 4
  return width * height * layer.channels * bytes
}

export type { Bounds, PackVectors, PackRoad, PackArea, PackPlace }
