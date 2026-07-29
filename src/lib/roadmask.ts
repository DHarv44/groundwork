import type { Bounds } from './geo'
import { boundsExtentMetres } from './geo'
import { ROAD_ORDER, ROAD_CLASSES, type RoadClass, type RoadNetwork } from './overpass'

/**
 * Roads, rasterised into a mask the shader can sample — the same shape as the water
 * mask, for the same reason: everything in this renderer is a field evaluated per
 * fragment, so a road has to become a field before it can be drawn.
 *
 *   R  road surface — 1 on the carriageway, feathering out across its edge
 *   G  class, as `order / 4`; only meaningful where R is high
 *   B  cleared corridor — the verge, wider than the surface
 *   A  unused
 *
 * The verge earns its own channel because it is what makes a road read as a road. A
 * metalled road through timber has felled shoulders — somebody cut them and keeps
 * cutting them — so without it the canopy stands hard against the tarmac and the road
 * looks painted on rather than cut through. It suppresses trees; it does not paint
 * anything.
 *
 * Drawn with canvas strokes rather than a distance field. Strokes give correct joins
 * and caps at junctions for free, antialias their own edges, and the result goes
 * straight to the GPU as a CanvasTexture with no read-back.
 */

export interface RoadMaskOptions {
  /** Longest side of the mask in pixels. The short side follows the ground aspect. */
  resolution: number
  /** Multiplies the true metric width of every class. */
  widthScale: number
  /** Verge width, as a multiple of the surface width. */
  vergeScale: number
}

export interface RoadMask {
  canvas: HTMLCanvasElement
  width: number
  height: number
  /** Ground metres per mask pixel — what decides whether a class is resolvable at all. */
  metresPerPixel: number
  /** Centreline km per class, largest class first. */
  byClass: Array<{ cls: RoadClass; km: number }>
  /** Classes whose true width came out below the visibility floor and were widened. */
  widened: RoadClass[]
}

/**
 * Narrowest a road may be drawn, in mask pixels.
 *
 * A residential street is 6 m wide. On a 100 km box at 2048 px the mask has one texel
 * per 50 m, so drawn to scale the street is a twelfth of a pixel — antialiasing turns
 * it into a barely-there grey haze and the network vanishes. Every map ever printed
 * has the same problem and every one solves it the same way: below a certain size,
 * roads stop being drawn to scale and start being drawn legibly.
 *
 * Kept a shade above 1 so a road always lands on a whole pixel somewhere along its
 * length rather than dithering in and out between two.
 */
const MIN_PIXELS = 1.4

/** Longest side, clamped — the mask is one texture and it lives on the GPU. */
const MAX_RESOLUTION = 4096

/** Closest two path vertices may sit, in mask pixels, before the second is dropped. */
const MIN_VERTEX_STEP = 0.7

interface Geometry {
  paths: Map<RoadClass, Path2D>
  lengths: Map<RoadClass, number>
}

/**
 * The projected geometry, cached against the network and the canvas size.
 *
 * One Path2D per class rather than a fresh path per stroke pass. The obvious way to
 * write the rasteriser — walk the way list inside each pass, skipping the wrong class —
 * is five classes times four passes, so twenty full traversals with the geometry rebuilt
 * every time. Over Denver that is fifty-seven thousand ways projected twenty times, and
 * it locks the main thread long enough to be indistinguishable from a crash.
 *
 * Caching it matters just as much as building it once, because width and verge are
 * *sliders*. Neither changes a single coordinate — they only change how thickly the same
 * lines are stroked — so rebuilding a million projected points on every tick of a drag
 * is pure waste, and it is the difference between a control that responds and one that
 * hangs for over a second each time you let go of it.
 *
 * Keyed on identity, not contents: a new network object always means a new box.
 */
let geoCache: { network: RoadNetwork; w: number; h: number; geo: Geometry } | null = null

function geometryFor(
  network: RoadNetwork,
  w: number,
  h: number,
  project: (lon: number, lat: number) => [number, number],
): Geometry {
  if (geoCache && geoCache.network === network && geoCache.w === w && geoCache.h === h) {
    return geoCache.geo
  }

  const paths = new Map<RoadClass, Path2D>()
  const lengths = new Map<RoadClass, number>()
  // Squared, so the inner loop compares without a square root.
  const minStep = MIN_VERTEX_STEP * MIN_VERTEX_STEP

  for (const way of network.ways) {
    let p = paths.get(way.cls)
    if (!p) {
      p = new Path2D()
      paths.set(way.cls, p)
    }
    const [x0, y0] = project(way.pts[0]!, way.pts[1]!)
    p.moveTo(x0, y0)

    // Drop vertices the mask cannot resolve.
    //
    // OSM geometry is surveyed at metre precision — a motorway curve carries a vertex
    // every few metres. On a wide box a mask pixel is fifty metres, so most consecutive
    // points project onto the same pixel and every one of them still costs a segment to
    // tessellate on each of the four stroke passes. Thinning to roughly one vertex per
    // pixel is invisible in the output and takes a large multiple off the cost.
    //
    // The final vertex is always kept, or ways would quietly shorten and junctions
    // would stop meeting.
    let lx = x0
    let ly = y0
    const last = way.pts.length - 2
    for (let i = 2; i < way.pts.length; i += 2) {
      const [x, y] = project(way.pts[i]!, way.pts[i + 1]!)
      const dx = x - lx
      const dy = y - ly
      if (i !== last && dx * dx + dy * dy < minStep) continue
      p.lineTo(x, y)
      lx = x
      ly = y
    }
    lengths.set(way.cls, (lengths.get(way.cls) ?? 0) + wayKm(way.pts))
  }

  const geo: Geometry = { paths, lengths }
  geoCache = { network, w, h, geo }
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

export function buildRoadMask(network: RoadNetwork, opts: RoadMaskOptions): RoadMask {
  const { width: groundW, height: groundH } = boundsExtentMetres(network.bounds)

  // Match the pixel aspect to the ground aspect so one metres-per-pixel figure is true
  // on both axes — otherwise a stroke width correct east-west is wrong north-south, and
  // canvas only gives you one lineWidth.
  const longest = Math.min(MAX_RESOLUTION, Math.max(256, Math.round(opts.resolution)))
  const landscape = groundW >= groundH
  const w = landscape ? longest : Math.max(1, Math.round((longest * groundW) / groundH))
  const h = landscape ? Math.max(1, Math.round((longest * groundH) / groundW)) : longest
  const pxPerMetre = w / groundW

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const project = projector(network.bounds, w, h)

  const byClass = new Map<RoadClass, number>()
  const widened = new Set<RoadClass>()

  const { paths, lengths } = geometryFor(network, w, h, project)
  for (const [cls, km] of lengths) byClass.set(cls, km)

  // Only classes that actually came back can honestly be reported as widened — otherwise
  // the readout claims to have drawn tracks in a box where tracks were never requested.
  const present = new Set(paths.keys())

  const strokeWidth = (cls: RoadClass, multiplier: number): number => {
    const metres = ROAD_CLASSES[cls].width * opts.widthScale * multiplier
    const px = metres * pxPerMetre
    if (px < MIN_PIXELS && multiplier === 1 && present.has(cls)) widened.add(cls)
    return Math.max(MIN_PIXELS * multiplier, px)
  }

  // Pass 1 — the verge, into blue alone so the surface pass can overwrite red and green
  // without disturbing it.
  //
  // Drawn as three concentric strokes that add, rather than one flat band. A single
  // stroke would give the corridor a hard outer edge — a felled rectangle stamped
  // through the timber — whereas clearing actually thins outward: mown verge, then
  // scrub, then whatever the woods do at their own pace. Three steps plus the texture's
  // own linear filtering is enough of a ramp for the shader to feather against, and it
  // costs two extra strokes.
  if (opts.vergeScale > 0.01) {
    // Stroked once into its own canvas and blurred on the way back, rather than as a
    // stack of concentric strokes.
    //
    // The corridor needs a soft outer edge — clearing thins outward through mown verge
    // and scrub rather than ending on a line — and the obvious way to get one is to lay
    // down several strokes of decreasing width. That costs a full tessellation of the
    // whole network per step, which on a city-sized box is most of the time this
    // function spends. A single stroke through a blur gives a smoother ramp than the
    // stepped version did for one pass instead of three.
    //
    // Blue alone, so the surface pass can overwrite red and green without touching it —
    // and blurring cannot bleed into them either, since they are zero here.
    const vergeCanvas = document.createElement('canvas')
    vergeCanvas.width = w
    vergeCanvas.height = h
    const vctx = vergeCanvas.getContext('2d')!
    vctx.lineCap = 'round'
    vctx.lineJoin = 'round'
    vctx.strokeStyle = 'rgb(0,0,255)'

    let widest = 0
    for (const cls of ROAD_ORDER) {
      const p = paths.get(cls)
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

  // Pass 2 — the carriageway, smallest class first so that where a motorway crosses a
  // track the motorway is what the pixel ends up holding. Blue is written again because
  // the surface sits inside its own verge.
  for (const cls of ROAD_ORDER) {
    const p = paths.get(cls)
    if (!p) continue
    const g = Math.round((ROAD_CLASSES[cls].order / 4) * 255)
    ctx.strokeStyle = `rgb(255,${g},255)`
    ctx.lineWidth = strokeWidth(cls, 1)
    ctx.stroke(p)
  }

  return {
    canvas,
    width: w,
    height: h,
    metresPerPixel: 1 / pxPerMetre,
    byClass: ROAD_ORDER.slice()
      .reverse()
      .filter((c) => (byClass.get(c) ?? 0) > 0)
      .map((cls) => ({ cls, km: byClass.get(cls)! })),
    widened: ROAD_ORDER.filter((c) => widened.has(c)),
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
