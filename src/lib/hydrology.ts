/**
 * Derives a water mask from a bare height field — no external data required.
 *
 * The pipeline is the standard hydrological one:
 *   1. Priority-flood depression filling (with an epsilon tilt, so there are no flats
 *      left and every cell has a strictly descending path to the edge of the tile).
 *   2. D8 flow directions on the filled surface.
 *   3. Flow accumulation, walking the flood's pop order in reverse — that order is
 *      already a valid topological sort, so no separate sort is needed.
 *   4. Channels wherever accumulated drainage area crosses a threshold, widened by
 *      hydraulic geometry (width scales with about the 0.45 power of drainage area).
 *
 * Lakes are found separately: DEMs record the water *surface*, and products like
 * Copernicus GLO-30 hydro-flatten inland water to an exactly constant value. A
 * connected flat region is therefore a very specific signal for standing water — real
 * ground almost never has eight neighbours agreeing to within 2 cm.
 */

export interface HydrologyInput {
  data: Float32Array
  width: number
  height: number
  widthMetres: number
  depthMetres: number
  seaLevel: number
}

export interface HydrologyResult {
  /**
   * RGBA8: R = water coverage, G = lake flag, B = normalised log drainage area.
   * Pinned to ArrayBuffer (not ArrayBufferLike) so it stays a valid texture source
   * after the structured-clone round trip out of the worker.
   */
  mask: Uint8Array<ArrayBuffer>
  width: number
  height: number
  riverCells: number
  lakeCells: number
  /** Largest drainage area found, km² — useful for labelling the UI. */
  maxDrainageKm2: number
}

const MAX_HYDRO = 1024
/** Below this drainage area a cell is hillslope, not channel. */
const MIN_CHANNEL_KM2 = 0.25
/** Standing water smaller than this is noise at DEM resolution. */
const MIN_LAKE_M2 = 20_000
/** Hydro-flattened water is exactly constant; real ground is not. */
const FLAT_TOLERANCE = 0.02
/**
 * Base tilt applied while filling, so no true flats survive. Jittered per cell — see
 * the flood loop. Kept far below any real elevation signal.
 */
const FILL_EPSILON = 1e-3

/** Binary min-heap over (priority, cellIndex), backed by typed arrays. */
class MinHeap {
  private pri: Float64Array
  private idx: Int32Array
  private n = 0

  constructor(capacity: number) {
    this.pri = new Float64Array(capacity)
    this.idx = new Int32Array(capacity)
  }

  get size(): number {
    return this.n
  }

  push(priority: number, cell: number): void {
    let c = this.n++
    this.pri[c] = priority
    this.idx[c] = cell
    while (c > 0) {
      const parent = (c - 1) >> 1
      if (this.pri[parent] <= this.pri[c]) break
      this.swap(parent, c)
      c = parent
    }
  }

  pop(): number {
    const top = this.idx[0]
    this.n--
    if (this.n > 0) {
      this.pri[0] = this.pri[this.n]
      this.idx[0] = this.idx[this.n]
      let c = 0
      for (;;) {
        const l = 2 * c + 1
        const r = l + 1
        let small = c
        if (l < this.n && this.pri[l] < this.pri[small]) small = l
        if (r < this.n && this.pri[r] < this.pri[small]) small = r
        if (small === c) break
        this.swap(small, c)
        c = small
      }
    }
    return top
  }

  private swap(a: number, b: number): void {
    const p = this.pri[a]
    this.pri[a] = this.pri[b]
    this.pri[b] = p
    const i = this.idx[a]
    this.idx[a] = this.idx[b]
    this.idx[b] = i
  }
}

/** Box-average the DEM down to a size the flood can chew through interactively. */
function downsample(
  src: Float32Array,
  sw: number,
  sh: number,
): { data: Float32Array; width: number; height: number } {
  const scale = Math.min(1, MAX_HYDRO / Math.max(sw, sh))
  if (scale >= 1) return { data: src, width: sw, height: sh }

  const w = Math.max(16, Math.round(sw * scale))
  const h = Math.max(16, Math.round(sh * scale))
  const out = new Float32Array(w * h)
  const bx = sw / w
  const by = sh / h

  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * by)
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.floor((y + 1) * by)))
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * bx)
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.floor((x + 1) * bx)))
      let sum = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          sum += src[yy * sw + xx]
          n++
        }
      }
      out[y * w + x] = sum / n
    }
  }
  return { data: out, width: w, height: h }
}

const NX = [1, 1, 0, -1, -1, -1, 0, 1]
const NY = [0, 1, 1, 1, 0, -1, -1, -1]

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  return s - Math.floor(s)
}

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = hash2(ix, iy)
  const b = hash2(ix + 1, iy)
  const c = hash2(ix, iy + 1)
  const d = hash2(ix + 1, iy + 1)
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy
}

/**
 * Add a little coherent micro-relief before routing.
 *
 * Perfectly flat ground is the enemy here. Any flat — a filled pit, a lake, a smooth
 * planar slope — leaves the fill with no real gradient to work with, so every cell
 * drains along the flood's own sweep order and the network comes out as dead-straight
 * lines on the 8 grid directions. Real ground has roughness that a 30 m posting
 * averages away; putting a trace of it back removes the flats and the artefact with
 * them.
 *
 * The amplitude is tied to the terrain's own mean cell-to-cell relief. A fixed value
 * would be swamped in the Alps and would completely randomise drainage across
 * somewhere like the Gulf coastal plain, where the true gradient is centimetres
 * per cell.
 */
function addMicroRelief(elev: Float32Array, w: number, h: number): void {
  let sum = 0
  let count = 0
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w; x++) {
      sum += Math.abs(elev[y * w + x] - elev[y * w + x - 1])
      count++
    }
  }
  for (let y = 1; y < h; y++) {
    for (let x = 0; x < w; x++) {
      sum += Math.abs(elev[y * w + x] - elev[(y - 1) * w + x])
      count++
    }
  }
  const meanRelief = count > 0 ? sum / count : 0
  const amp = meanRelief * 0.22
  if (amp <= 0) return

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n =
        (valueNoise(x * 0.31, y * 0.31) - 0.5) * 1.0 +
        (valueNoise(x * 0.83 + 19.7, y * 0.83 + 5.3) - 0.5) * 0.5
      elev[y * w + x] += n * amp
    }
  }
}

export function computeWaterMask(input: HydrologyInput): HydrologyResult {
  const { data: srcData, width: srcW, height: srcH, seaLevel } = input
  const sampled = downsample(srcData, srcW, srcH)
  const w = sampled.width
  const h = sampled.height
  const n = w * h

  // Routing runs on its own perturbed copy; lake detection below needs the pristine
  // elevations, since it keys off water being *exactly* flat.
  const elev = sampled.data === srcData ? srcData.slice() : sampled.data
  const clean = elev.slice()
  addMicroRelief(elev, w, h)

  const cellX = input.widthMetres / w
  const cellY = input.depthMetres / h
  const cellArea = cellX * cellY
  const cellSize = Math.sqrt(cellArea)
  // Diagonal steps are longer, so slope must be distance-weighted.
  const stepLen = [cellX, Math.hypot(cellX, cellY), cellY, Math.hypot(cellX, cellY)]

  // ---- 1. priority-flood depression filling -------------------------------
  const filled = new Float32Array(n)
  const closed = new Uint8Array(n)
  const order = new Int32Array(n)
  const heap = new MinHeap(n)

  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const i = y * w + x
      if (!closed[i]) {
        closed[i] = 1
        filled[i] = elev[i]
        heap.push(elev[i], i)
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) {
      const i = y * w + x
      if (!closed[i]) {
        closed[i] = 1
        filled[i] = elev[i]
        heap.push(elev[i], i)
      }
    }
  }

  let popped = 0
  while (heap.size > 0) {
    const c = heap.pop()
    order[popped++] = c
    const cx = c % w
    const cy = (c / w) | 0
    for (let d = 0; d < 8; d++) {
      const nx = cx + NX[d]
      const ny = cy + NY[d]
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
      const nb = ny * w + nx
      if (closed[nb]) continue
      closed[nb] = 1
      // Jitter the epsilon rather than using a constant one.
      //
      // Inside a filled depression the fill level sits well above the ground, so any
      // micro-relief in the source elevations is erased and the only gradient left is
      // this increment. A constant increment makes the surface tilt purely along the
      // flood's own advance, so flow across every flat converges on where the fronts
      // meet — for a rectangular tile that is its straight skeleton, and you get 45°
      // bisectors from the corners. Varying the step with coherent noise keeps the
      // strict descent that guarantees no new pits, while giving neighbouring cells
      // different heights so the fronts meet along irregular curves instead.
      const j = 0.25 + 2.25 * valueNoise(nx * 0.37, ny * 0.37)
      filled[nb] = Math.max(elev[nb], filled[c] + FILL_EPSILON * j)
      heap.push(filled[nb], nb)
    }
  }

  // ---- 2/3. flow accumulation, reverse of the flood's pop order -------------
  //
  // Routing is multiple-flow-direction rather than D8. Sending every cell's water to
  // just its single steepest neighbour quantises flow onto eight headings, which on
  // any smooth slope collapses whole hillsides onto a few identical directions and
  // draws long, unnaturally straight parallel lines. MFD instead splits the flow
  // across all downslope neighbours weighted by slope, so divergent hillslopes stay
  // diffuse and the network keeps its fine texture.
  //
  // Pure MFD would never let trunk rivers tighten up, so the slope exponent rises with
  // how much water a cell already carries: dispersive on hillslopes, strongly
  // convergent in channels. Raising the exponent rather than switching to single-
  // direction routing keeps the concentration continuous — a hard switch snaps trunks
  // back onto the 8 grid headings and the straight lines return in the valley floors.
  const acc = new Float32Array(n).fill(1)
  const weights = new Float64Array(8)

  for (let k = n - 1; k >= 0; k--) {
    const c = order[k]
    const cx = c % w
    const cy = (c / w) | 0
    // Border cells drain off the tile.
    if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) continue

    const a = acc[c]
    const p = 1.1 + 9.0 * Math.min(1, Math.log10(1 + a) / 3)

    let total = 0
    for (let d = 0; d < 8; d++) {
      const nb = (cy + NY[d]) * w + (cx + NX[d])
      const drop = filled[c] - filled[nb]
      if (drop <= 0) {
        weights[d] = 0
        continue
      }
      const wgt = Math.pow(drop / stepLen[d & 3], p)
      weights[d] = wgt
      total += wgt
    }
    if (total <= 0) continue

    for (let d = 0; d < 8; d++) {
      if (weights[d] === 0) continue
      acc[(cy + NY[d]) * w + (cx + NX[d])] += (a * weights[d]) / total
    }
  }

  // ---- 4. standing water: connected, exactly-flat regions ------------------
  const isLake = new Uint8Array(n)
  const visited = new Uint8Array(n)
  const stack = new Int32Array(n)
  const component = new Int32Array(n)

  const flat = new Uint8Array(n)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const c = y * w + x
      let level = 1
      for (let d = 0; d < 8; d++) {
        const nb = (y + NY[d]) * w + (x + NX[d])
        if (Math.abs(clean[nb] - clean[c]) > FLAT_TOLERANCE) {
          level = 0
          break
        }
      }
      flat[c] = level
    }
  }

  let lakeCells = 0
  for (let start = 0; start < n; start++) {
    if (!flat[start] || visited[start]) continue
    let sp = 0
    let count = 0
    stack[sp++] = start
    visited[start] = 1
    while (sp > 0) {
      const c = stack[--sp]
      component[count++] = c
      const cx = c % w
      const cy = (c / w) | 0
      for (let d = 0; d < 8; d++) {
        const nx = cx + NX[d]
        const ny = cy + NY[d]
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
        const nb = ny * w + nx
        if (visited[nb] || !flat[nb]) continue
        if (Math.abs(clean[nb] - clean[start]) > FLAT_TOLERANCE * 4) continue
        visited[nb] = 1
        stack[sp++] = nb
      }
    }
    // The sea is already drawn by the sea-level plane; only inland water here.
    if (count * cellArea < MIN_LAKE_M2) continue
    if (clean[start] <= seaLevel + 0.5) continue
    for (let k = 0; k < count; k++) {
      isLake[component[k]] = 1
      lakeCells++
    }
  }

  // ---- 5. rasterise into the mask -----------------------------------------
  const mask = new Uint8Array(n * 4)
  const minWidthM = Math.max(cellSize * 0.6, input.widthMetres / 800)
  let riverCells = 0
  let maxDrainageKm2 = 0

  for (let c = 0; c < n; c++) {
    const areaKm2 = (acc[c] * cellArea) / 1e6
    if (areaKm2 > maxDrainageKm2) maxDrainageKm2 = areaKm2
    // Drainage area spans many orders of magnitude, so store it logarithmically.
    const logA = Math.log10(Math.max(areaKm2, 1e-3))
    mask[c * 4 + 2] = Math.round(Math.min(1, Math.max(0, (logA + 3) / 10)) * 255)
    mask[c * 4 + 3] = 255
  }

  for (let c = 0; c < n; c++) {
    if (clean[c] <= seaLevel + 0.5) continue
    const areaKm2 = (acc[c] * cellArea) / 1e6
    if (areaKm2 < MIN_CHANNEL_KM2) continue
    riverCells++

    // Hydraulic geometry: channel width against upstream drainage area.
    const hydraulicWidth = 2.5 * Math.pow(areaKm2, 0.45)

    // Steep ground carries the same discharge in a narrow, confined, fast channel;
    // broad water only forms where the gradient slackens. Without this a mountainside
    // gets a wide river painted straight down it, which reads completely wrong.
    const cx0 = c % w
    const cy0 = (c / w) | 0
    const gx =
      (clean[cy0 * w + Math.min(w - 1, cx0 + 1)] - clean[cy0 * w + Math.max(0, cx0 - 1)]) /
      (2 * cellX)
    const gy =
      (clean[Math.min(h - 1, cy0 + 1) * w + cx0] - clean[Math.max(0, cy0 - 1) * w + cx0]) /
      (2 * cellY)
    const gradient = Math.hypot(gx, gy)
    const slopeNarrowing = 1 / (1 + gradient * 5)

    // At these viewing scales a true-to-life river is under a pixel wide — a 35 m
    // channel across a 27 km tile is invisible. Maps have always drawn rivers wider
    // than scale for exactly that reason, so keep a floor, but a modest one.
    const widthM = Math.max(hydraulicWidth, minWidthM) * slopeNarrowing
    const rCells = (widthM * 0.5) / cellSize

    const R = Math.ceil(rCells + 0.5)
    const cx = c % w
    const cy = (c / w) | 0
    for (let dy = -R; dy <= R; dy++) {
      const py = cy + dy
      if (py < 0 || py >= h) continue
      for (let dx = -R; dx <= R; dx++) {
        const px = cx + dx
        if (px < 0 || px >= w) continue
        const cov = Math.min(1, Math.max(0, rCells + 0.5 - Math.hypot(dx, dy)))
        if (cov <= 0) continue
        const o = (py * w + px) * 4
        if (cov * 255 > mask[o]) mask[o] = Math.round(cov * 255)
      }
    }
  }

  for (let c = 0; c < n; c++) {
    if (!isLake[c]) continue
    mask[c * 4] = 255
    mask[c * 4 + 1] = 255
  }

  return { mask, width: w, height: h, riverCells, lakeCells, maxDrainageKm2 }
}
