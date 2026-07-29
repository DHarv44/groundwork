import type { Bounds } from './geo'
import { boundsExtentMetres } from './geo'
import {
  ROAD_ORDER,
  ROAD_CLASSES,
  type AreaKind,
  type OsmData,
  type RoadClass,
} from './overpass'

/**
 * OpenStreetMap features, rasterised into masks the shader can sample — the same shape
 * as the water mask, for the same reason: everything in this renderer is a field
 * evaluated per fragment, so a road or a lake has to become a field before it can be
 * drawn.
 *
 * Two textures, because they are read at different points in the shader and neither has
 * a spare channel:
 *
 *   roads   R surface · G class (order/4) · B cleared corridor
 *   areas   R water   · G woodland        · B built-up
 *
 * The road corridor earns its own channel because it is what makes a road read as a road.
 * A metalled road through timber has felled shoulders — somebody cut them and keeps
 * cutting them — so without it the canopy stands hard against the tarmac and the road
 * looks painted on rather than cut through. It suppresses trees; it paints nothing.
 *
 * Drawn with canvas strokes and fills rather than distance fields. Strokes give correct
 * joins and caps at junctions for free, fills handle self-intersecting rings, both
 * antialias their own edges, and the result goes to the GPU with no read-back.
 *
 * Runs in a worker on OffscreenCanvas, and deliberately has no DOM path at all. Stroke
 * tessellation of a city-sized network is a few hundred milliseconds however carefully
 * it is written, and width and verge are sliders — so the choice is between a hitch
 * every time one settles and doing it somewhere that cannot hitch. The results come back
 * as ImageBitmaps, which transfer rather than copy.
 */

export interface MaskOptions {
  /** Longest side of the masks in pixels. The short side follows the ground aspect. */
  resolution: number
  /** Multiplies the true metric width of every road class. */
  widthScale: number
  /** Cleared corridor width, as a multiple of the road surface width. */
  vergeScale: number
}

export interface MaskStats {
  width: number
  height: number
  /** Ground metres per mask pixel — what decides whether a class is resolvable at all. */
  metresPerPixel: number
  /** Road centreline km per class, largest class first. */
  byClass: Array<{ cls: RoadClass; km: number }>
  /** Road classes whose true width fell below the visibility floor and were widened. */
  widened: RoadClass[]
  /** How many rings of each kind were drawn. Zero is a fact, not a failure. */
  areaCounts: Record<AreaKind, number>
  /**
   * How long the rasterise took, in milliseconds.
   *
   * Reported rather than inferred. This is the number that decided the masks belong in a
   * worker, and it scales with the feature count rather than with the box, so a dense
   * city is an order of magnitude worse than open country of the same size — worth being
   * able to see rather than guess at as more layers land on top of it.
   */
  drawMs: number
}

export interface Masks extends MaskStats {
  roads: ImageBitmap
  areas: ImageBitmap
}

/**
 * Narrowest a road may be drawn, in mask pixels.
 *
 * A residential street is 6 m wide. On a 100 km box at 2048 px the mask has one texel
 * per 50 m, so drawn to scale the street is a twelfth of a pixel — antialiasing turns
 * it into a barely-there grey haze and the network vanishes. Every map ever printed has
 * the same problem and every one solves it the same way: below a certain size, roads
 * stop being drawn to scale and start being drawn legibly.
 *
 * Kept a shade above 1 so a road always lands on a whole pixel somewhere along its
 * length rather than dithering in and out between two.
 */
const MIN_PIXELS = 1.4

/** Longest side, clamped — these are two textures and they live on the GPU. */
const MAX_RESOLUTION = 4096

/** Closest two path vertices may sit, in mask pixels, before the second is dropped. */
const MIN_VERTEX_STEP = 0.7

interface Geometry {
  paths: Map<RoadClass, Path2D>
  lengths: Map<RoadClass, number>
  areas: Map<AreaKind, Path2D>
  areaCounts: Record<AreaKind, number>
}

/**
 * The projected geometry, cached against the data and the canvas size.
 *
 * One Path2D per road class and per area kind, rather than a fresh path per draw pass.
 * The obvious way to write the rasteriser — walk the feature list inside each pass,
 * skipping the wrong class — is five classes times four passes, so twenty full
 * traversals with the geometry rebuilt every time. Over Denver that is fifty-seven
 * thousand ways projected twenty times, and it locks the thread for over a second.
 *
 * Caching it matters just as much as building it once, because width and verge are
 * *sliders*. Neither moves a single coordinate — they only change how thickly the same
 * lines are stroked — so reprojecting a million points on every tick of a drag is pure
 * waste. Measured over Denver: 84 ms cold, 9 ms warm.
 *
 * Keyed on identity, not contents: a new data object always means a new box.
 */
let geoCache: { data: OsmData; w: number; h: number; geo: Geometry } | null = null

function geometryFor(
  data: OsmData,
  w: number,
  h: number,
  project: (lon: number, lat: number) => [number, number],
): Geometry {
  if (geoCache && geoCache.data === data && geoCache.w === w && geoCache.h === h) {
    return geoCache.geo
  }

  const paths = new Map<RoadClass, Path2D>()
  const lengths = new Map<RoadClass, number>()
  const areas = new Map<AreaKind, Path2D>()
  const areaCounts: Record<AreaKind, number> = { water: 0, wood: 0, built: 0 }
  // Squared, so the inner loops compare without a square root.
  const minStep = MIN_VERTEX_STEP * MIN_VERTEX_STEP

  /**
   * Append a polyline, dropping vertices the mask cannot resolve.
   *
   * OSM geometry is surveyed at metre precision — a motorway curve carries a vertex
   * every few metres, and a lake shore more still. On a wide box a mask pixel is fifty
   * metres, so most consecutive points project onto the same pixel and every one of them
   * still costs a segment to tessellate on each pass. Thinning to roughly one vertex per
   * pixel is invisible in the output and takes a large multiple off the cost.
   *
   * The final vertex is always kept, or ways would quietly shorten, junctions would stop
   * meeting and rings would not close.
   */
  const trace = (p: Path2D, pts: Float64Array, close: boolean) => {
    const [x0, y0] = project(pts[0]!, pts[1]!)
    let lx = x0
    let ly = y0
    const last = pts.length - 2

    if (!close) {
      p.moveTo(x0, y0)
      for (let i = 2; i < pts.length; i += 2) {
        const [x, y] = project(pts[i]!, pts[i + 1]!)
        const dx = x - lx
        const dy = y - ly
        if (i !== last && dx * dx + dy * dy < minStep) continue
        p.lineTo(x, y)
        lx = x
        ly = y
      }
      return
    }

    // Rings are collected before being emitted, so their winding can be normalised.
    //
    // Every ring of a kind goes into one Path2D and is filled `nonzero`, which unions
    // overlapping rings — but only when they wind the same way. OSM imposes no winding
    // convention, so a clockwise ring overlapping an anticlockwise one cancels to a
    // hole. On a reservoir mapped as a relation with many outer members, plus the
    // separate ways for its arms and the ponds beside it, that tore Lake Houston into
    // disconnected fragments with the middle missing.
    //
    // Forcing one direction makes the winding numbers add rather than subtract, so
    // overlap always unions. Holes are not lost by this because inner rings are already
    // dropped upstream — see fetchOsm.
    const xs: number[] = [x0]
    const ys: number[] = [y0]
    for (let i = 2; i < pts.length; i += 2) {
      const [x, y] = project(pts[i]!, pts[i + 1]!)
      const dx = x - lx
      const dy = y - ly
      if (i !== last && dx * dx + dy * dy < minStep) continue
      xs.push(x)
      ys.push(y)
      lx = x
      ly = y
    }
    if (xs.length < 3) return

    // Shoelace, in projected pixels. Sign alone matters, so the halving is skipped.
    let twiceArea = 0
    for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
      twiceArea += xs[j]! * ys[i]! - xs[i]! * ys[j]!
    }

    if (twiceArea >= 0) {
      p.moveTo(xs[0]!, ys[0]!)
      for (let i = 1; i < xs.length; i++) p.lineTo(xs[i]!, ys[i]!)
    } else {
      const n = xs.length - 1
      p.moveTo(xs[n]!, ys[n]!)
      for (let i = n - 1; i >= 0; i--) p.lineTo(xs[i]!, ys[i]!)
    }
    p.closePath()
  }

  for (const way of data.roads) {
    let p = paths.get(way.cls)
    if (!p) {
      p = new Path2D()
      paths.set(way.cls, p)
    }
    trace(p, way.pts, false)
    lengths.set(way.cls, (lengths.get(way.cls) ?? 0) + wayKm(way.pts))
  }

  for (const area of data.areas) {
    let p = areas.get(area.kind)
    if (!p) {
      p = new Path2D()
      areas.set(area.kind, p)
    }
    trace(p, area.ring, true)
    areaCounts[area.kind]++
  }

  const geo: Geometry = { paths, lengths, areas, areaCounts }
  geoCache = { data, w, h, geo }
  return geo
}

function projector(bounds: Bounds, w: number, h: number) {
  const lonSpan = bounds.east - bounds.west
  const latSpan = bounds.north - bounds.south
  // Row 0 is the north edge, matching the height field, the water mask and the biome
  // field. Every texture in this app agrees on that and the shader relies on it.
  return (lon: number, lat: number): [number, number] => [
    ((lon - bounds.west) / lonSpan) * w,
    ((bounds.north - lat) / latSpan) * h,
  ]
}

export function buildMasks(data: OsmData, opts: MaskOptions): Masks {
  const started = performance.now()
  const { width: groundW, height: groundH } = boundsExtentMetres(data.bounds)

  // Match the pixel aspect to the ground aspect so one metres-per-pixel figure is true
  // on both axes — otherwise a stroke width correct east-west is wrong north-south, and
  // canvas only gives you one lineWidth.
  const longest = Math.min(MAX_RESOLUTION, Math.max(256, Math.round(opts.resolution)))
  const landscape = groundW >= groundH
  const w = landscape ? longest : Math.max(1, Math.round((longest * groundW) / groundH))
  const h = landscape ? Math.max(1, Math.round((longest * groundH) / groundW)) : longest
  const pxPerMetre = w / groundW

  const project = projector(data.bounds, w, h)
  const geo = geometryFor(data, w, h, project)

  // Only classes that actually came back can honestly be reported as widened — otherwise
  // the readout claims to have drawn tracks in a box where tracks were never requested.
  const present = new Set(geo.paths.keys())
  const widened = new Set<RoadClass>()

  const strokeWidth = (cls: RoadClass, multiplier: number): number => {
    const metres = ROAD_CLASSES[cls].width * opts.widthScale * multiplier
    const px = metres * pxPerMetre
    if (px < MIN_PIXELS && multiplier === 1 && present.has(cls)) widened.add(cls)
    return Math.max(MIN_PIXELS * multiplier, px)
  }

  // ---- areas -------------------------------------------------------------------
  // Fills, one channel per kind, drawn before the roads because a road crosses a wood
  // and a bridge crosses a lake — the linear feature is the one on top.
  //
  // `nonzero` rather than `evenodd`: rings arrive independently, so overlapping ones
  // (a reservoir tagged twice, adjacent forest blocks sharing an edge) must union
  // rather than cancel each other out.
  const areaCanvas = new OffscreenCanvas(w, h)
  const actx = areaCanvas.getContext('2d')!
  actx.fillStyle = '#000'
  actx.fillRect(0, 0, w, h)
  const AREA_COLOR: Record<AreaKind, string> = {
    water: 'rgb(255,0,0)',
    wood: 'rgb(0,255,0)',
    built: 'rgb(0,0,255)',
  }
  actx.globalCompositeOperation = 'lighter'
  for (const kind of ['water', 'wood', 'built'] as AreaKind[]) {
    const p = geo.areas.get(kind)
    if (!p) continue
    actx.fillStyle = AREA_COLOR[kind]
    actx.fill(p, 'nonzero')
  }
  actx.globalCompositeOperation = 'source-over'

  // ---- roads -------------------------------------------------------------------
  const roadCanvas = new OffscreenCanvas(w, h)
  const ctx = roadCanvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (opts.vergeScale > 0.01) {
    // The verge, stroked once into its own canvas and blurred on the way back rather
    // than as a stack of concentric strokes.
    //
    // The corridor needs a soft outer edge — clearing thins outward through mown verge
    // and scrub rather than ending on a line — and the obvious way to get one is several
    // strokes of decreasing width. That costs a full tessellation of the whole network
    // per step, which on a city-sized box is most of the time this function spends. A
    // single stroke through a blur gives a smoother ramp for a third of the work.
    //
    // Blue alone, so the surface pass can overwrite red and green without touching it —
    // and blurring cannot bleed into them either, since they are zero here.
    const vergeCanvas = new OffscreenCanvas(w, h)
    const vctx = vergeCanvas.getContext('2d')!
    vctx.lineCap = 'round'
    vctx.lineJoin = 'round'
    vctx.strokeStyle = 'rgb(0,0,255)'

    let widest = 0
    for (const cls of ROAD_ORDER) {
      const p = geo.paths.get(cls)
      if (!p) continue
      const lw = strokeWidth(cls, opts.vergeScale)
      widest = Math.max(widest, lw)
      vctx.lineWidth = lw
      vctx.stroke(p)
    }

    ctx.filter = `blur(${(widest * 0.28).toFixed(2)}px)`
    ctx.drawImage(vergeCanvas, 0, 0)
    ctx.filter = 'none'
  }

  // The carriageway, smallest class first so that where a motorway crosses a track the
  // motorway is what the pixel ends up holding. Blue is written again because the
  // surface sits inside its own verge.
  for (const cls of ROAD_ORDER) {
    const p = geo.paths.get(cls)
    if (!p) continue
    const g = Math.round((ROAD_CLASSES[cls].order / 4) * 255)
    ctx.strokeStyle = `rgb(255,${g},255)`
    ctx.lineWidth = strokeWidth(cls, 1)
    ctx.stroke(p)
  }

  return {
    // Detaches each canvas — neither is reused, and this is what makes the results
    // transferable back to the main thread instead of copied.
    roads: roadCanvas.transferToImageBitmap(),
    areas: areaCanvas.transferToImageBitmap(),
    width: w,
    height: h,
    metresPerPixel: 1 / pxPerMetre,
    byClass: ROAD_ORDER.slice()
      .reverse()
      .filter((c) => (geo.lengths.get(c) ?? 0) > 0)
      .map((cls) => ({ cls, km: geo.lengths.get(cls)! })),
    widened: ROAD_ORDER.filter((c) => widened.has(c)),
    areaCounts: geo.areaCounts,
    drawMs: Math.round(performance.now() - started),
  }
}

function wayKm(pts: Float64Array): number {
  let total = 0
  for (let i = 2; i < pts.length; i += 2) {
    const lat = ((pts[i + 1]! + pts[i - 1]!) / 2) * (Math.PI / 180)
    const dx = (pts[i]! - pts[i - 2]!) * 111320 * Math.cos(lat)
    const dy = (pts[i + 1]! - pts[i - 1]!) * 110540
    total += Math.hypot(dx, dy)
  }
  return total / 1000
}
