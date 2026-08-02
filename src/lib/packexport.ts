import {
  PACK_EXTENSION,
  buildPack,
  lonLatToBox,
  packToBytes,
  type Bounds,
  type HeightField,
  type PackAttribution,
  type PackArea,
  type PackInputLayer,
  type PackPlace,
  type PackRoad,
  type PackVectors,
} from '@groundwork/core'
import type * as THREE from 'three'
import type { OsmData } from './overpass'
import { DEM_SOURCES } from './opentopo'
import { downloadBlob } from './capture'

/**
 * Writing a pack out of what the builder already has.
 *
 * The rule this is built around: **nothing here fetches**. Every input is expected to
 * be resident by the time the button is pressed — the height field, the OpenStreetMap
 * response (kept in the store precisely so masks rebuild without a request), the
 * hydrology result. If an export needs something, it is loaded long beforehand, never
 * during. That is what makes the button honest: what comes out is what is on screen.
 *
 * The other rule: **vectors, not masks**. `roadMask` and `areaMask` are rasterised at
 * whatever `maskResolution` happens to be set to, which is a display control. Baking
 * one into a pack would freeze a slider position into somebody else's data. The
 * geometry is resolution-independent, far smaller, and is what a consumer doing
 * anything other than drawing actually needs. Derived fields with no vector form —
 * the hydrology water field — do ship as rasters, at their own native resolution.
 */

/** Flat `[lon, lat, …]` in degrees → flat `[x, y, …]` normalised to the box. */
function toBox(b: Bounds, pts: Float64Array): Float32Array {
  const out = new Float32Array(pts.length)
  for (let i = 0; i < pts.length; i += 2) {
    const p = lonLatToBox(b, pts[i]!, pts[i + 1]!)
    out[i] = p.x
    out[i + 1] = p.y
  }
  return out
}

function vectorsFrom(osm: OsmData, bounds: Bounds): PackVectors {
  const roads: PackRoad[] = osm.roads.map((r) => ({ cls: r.cls, pts: toBox(bounds, r.pts) }))
  const areas: PackArea[] = osm.areas.map((a) => ({
    kind: a.kind,
    outer: a.outer.map((ring) => toBox(bounds, ring)),
    inner: a.inner.map((ring) => toBox(bounds, ring)),
  }))
  const places: PackPlace[] = (osm.places ?? []).map((p) => {
    const at = lonLatToBox(bounds, p.lon, p.lat)
    return {
      kind: p.kind,
      name: p.name,
      x: at.x,
      y: at.y,
      ...(p.elevation !== undefined ? { elevation: p.elevation } : {}),
      ...(p.population !== undefined ? { population: p.population } : {}),
    }
  })
  return { roads, areas, places }
}

/** The RGBA hydrology field, at whatever resolution the routing pass ran at. */
function waterLayerFrom(tex: THREE.DataTexture): PackInputLayer | null {
  const img = tex.image as { data?: ArrayBufferView; width?: number; height?: number }
  if (!img?.data || !img.width || !img.height) return null
  const data = img.data
  if (!(data instanceof Uint8Array)) return null
  return {
    id: 'water',
    data,
    channels: 4,
    width: img.width,
    height: img.height,
    description: 'Derived hydrology: coverage, lake flag, log drainage.',
  }
}

function attributionFor(hf: HeightField, hasOsm: boolean): PackAttribution[] {
  // Each elevation source carries its own required credit — see DEM_SOURCES. Copernicus
  // in particular specifies its notice verbatim for adapted data, which is what a pack
  // is, so the string travels rather than being summarised.
  const source = DEM_SOURCES.find((d) => d.id === hf.demtype)
  const out: PackAttribution[] = [
    {
      // The notices already name their dataset, so they stand alone — prefixing the
      // label as well reads as a stutter, and Copernicus's has to appear verbatim.
      source: source?.attribution.notice ?? `Elevation: ${hf.demtype}`,
      licence: source?.attribution.licence ?? 'See the dataset terms at the provider',
      url: source?.attribution.url ?? 'https://opentopography.org/',
      covers: ['elevation'],
    },
  ]
  if (hasOsm) {
    out.push({
      source: 'OpenStreetMap contributors',
      licence: 'ODbL 1.0',
      url: 'https://www.openstreetmap.org/copyright',
      covers: ['roads', 'areas', 'places'],
    })
  }
  return out
}

export interface PackExportInput {
  heightField: HeightField
  osm: OsmData | null
  waterMask: THREE.DataTexture | null
  /** Used for the pack id and the filename; the display name is derived from it. */
  baseName: string
  /** ISO 8601, passed in so two exports of the same state produce the same bytes. */
  createdAt: string
}

/** What an export will contain, for showing before it is written. */
export interface PackExportSummary {
  samples: number
  roads: number
  areas: number
  places: number
  hasWater: boolean
}

export function summarisePack(input: PackExportInput): PackExportSummary {
  return {
    samples: input.heightField.width * input.heightField.height,
    roads: input.osm?.roads.length ?? 0,
    areas: input.osm?.areas.length ?? 0,
    places: input.osm?.places?.length ?? 0,
    hasWater: !!input.waterMask,
  }
}

export async function exportPack(input: PackExportInput): Promise<void> {
  const { heightField: hf, osm, waterMask, baseName } = input

  const layers: PackInputLayer[] = []
  if (waterMask) {
    const water = waterLayerFrom(waterMask)
    if (water) layers.push(water)
  }

  const files = buildPack({
    id: baseName,
    name: baseName.replace(/[_-]+/g, ' ').trim() || baseName,
    heights: hf,
    layers,
    ...(osm ? { vectors: vectorsFrom(osm, hf.bounds) } : {}),
    attribution: attributionFor(hf, !!osm),
    generator: 'groundwork',
    createdAt: input.createdAt,
  })

  const bytes = await packToBytes(files)
  downloadBlob(
    new Blob([bytes.buffer as ArrayBuffer], { type: 'application/zip' }),
    `${baseName}${PACK_EXTENSION}`,
  )
}
