/**
 * The pack format's regression guard.
 *
 * Runs in Node with no browser and no test framework, which is half the point: if
 * this ever stops running headlessly, something has pulled a DOM dependency into
 * core and the whole reason for the package has gone.
 *
 *   npm run check:core
 *
 * What it is actually protecting is the contract. A pack written by one version and
 * read by another has to survive the trip, and the failures that matter are quiet
 * ones — a transposed raster, a dropped inner ring, a coordinate convention flipped
 * north-for-south. Each of those is checked by something that would still look
 * plausible if it broke.
 */
import {
  boxToLonLat,
  buildPack,
  canCompress,
  lonLatToBox,
  packFromBytes,
  packToBytes,
  parseVectors,
  readHeightField,
  readRaster,
  serialiseVectors,
  validateManifest,
  type HeightField,
} from '../src/index'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// A ramp plus a spike. The ramp catches scale and offset errors; the spike catches a
// transposition, which a symmetric test field would hide completely.
const W = 64
const H = 48
const data = new Float32Array(W * H)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) data[y * W + x] = 100 + x * 3 + y * 7
}
data[10 * W + 20] = 4000

const hf: HeightField = {
  width: W,
  height: H,
  data,
  bounds: { south: 39.4807, north: 40.1306, west: -105.9631, east: -104.6887 },
  min: 100,
  max: 4000,
  demtype: 'TEST',
  voids: 0,
}

const vectors = {
  roads: [{ cls: 'primary' as const, pts: Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) }],
  areas: [
    {
      kind: 'water' as const,
      outer: [Float32Array.from([0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9, 0.1, 0.1])],
      inner: [Float32Array.from([0.4, 0.4, 0.6, 0.4, 0.6, 0.6, 0.4, 0.6, 0.4, 0.4])],
    },
  ],
  places: [{ kind: 'town' as const, name: 'Nederland', x: 0.25, y: 0.5 }],
}

const cover = new Uint8Array(W * H)
cover.fill(7)

console.log('pack round trip')
const files = buildPack({
  id: 'test-box',
  name: 'Test Box',
  heights: hf,
  layers: [{ id: 'cover', data: cover, channels: 1, description: 'class index' }],
  vectors,
  attribution: [{ source: 'OpenStreetMap contributors', licence: 'ODbL 1.0', covers: ['roads'] }],
  generator: 'roundtrip-check',
  createdAt: '2026-07-29T00:00:00.000Z',
})

const problems = validateManifest(files.manifest)
check('manifest validates', problems.length === 0, problems.join('; '))
check('elevation + extra layer written', files.rasters.size === 2)
check('vectors filename recorded', files.manifest.vectors === 'vectors.json')

const back = readHeightField(files)
check('width survives', back.width === W)
check('height survives', back.height === H)
check('bounds survive', back.bounds.north === hf.bounds.north && back.bounds.west === hf.bounds.west)

let worst = 0
for (let i = 0; i < data.length; i++) worst = Math.max(worst, Math.abs(back.data[i]! - data[i]!))
// 16 bits across a 3900 m range is about 0.06 m a step, so half a step bounds the error.
check(`heights within a quantisation step (worst ${worst.toFixed(4)} m)`, worst < 0.06)
check('spike stays at (20,10)', Math.abs(back.data[10 * W + 20]! - 4000) < 0.06)

const coverBack = readRaster(files, 'cover')
check('extra layer reads back', coverBack !== null && coverBack.data[0] === 7)

const elevLayer = files.manifest.layers.find((l) => l.id === 'elevation')!
check('elevation is filtered', elevLayer.filter === 'delta16-split')
// The filter reorders and predicts; it must not change the byte count.
check(
  'the filter is size-neutral',
  files.rasters.get('elevation')!.byteLength === W * H * 2,
)

// A derived field at its own resolution — the hydrology pass runs at a routing
// resolution of its own, and forcing it onto the elevation grid would resample twice.
const coarse = new Uint8Array(16 * 12 * 4)
coarse[0] = 42
const mixed = buildPack({
  id: 'mixed',
  name: 'Mixed resolutions',
  heights: hf,
  layers: [{ id: 'water', data: coarse, channels: 4, width: 16, height: 12 }],
  attribution: [{ source: 'derived', licence: 'n/a', covers: ['water'] }],
  generator: 'roundtrip-check',
  createdAt: '2026-07-29T00:00:00.000Z',
})
const waterBack = readRaster(mixed, 'water')
check('an off-grid layer keeps its own size', waterBack?.width === 16 && waterBack?.height === 12)
check('an off-grid layer reads back', waterBack?.data[0] === 42)
check('elevation is unaffected by it', readHeightField(mixed).width === W)

let threw = ''
try {
  readRaster({ ...files, rasters: new Map([['cover', new ArrayBuffer(8)]]) }, 'cover')
} catch (e) {
  threw = String(e)
}
check('a short raster is rejected rather than read as garbage', threw.includes('expected'))

console.log('vectors')
const v = parseVectors(serialiseVectors(vectors))
check('road class survives', v.roads[0]!.cls === 'primary')
check('road geometry survives', Math.abs(v.roads[0]!.pts[3]! - 0.4) < 1e-6)
check('inner ring survives', v.areas[0]!.inner.length === 1)
check('place name survives', v.places[0]!.name === 'Nederland')

console.log('coordinates')
const b = hf.bounds
const nw = lonLatToBox(b, b.west, b.north)
const se = lonLatToBox(b, b.east, b.south)
check('north-west is (0,0)', Math.abs(nw.x) < 1e-9 && Math.abs(nw.y) < 1e-9, `${nw.x},${nw.y}`)
check('south-east is (1,1)', Math.abs(se.x - 1) < 1e-9 && Math.abs(se.y - 1) < 1e-9, `${se.x},${se.y}`)
const rt = boxToLonLat(b, 0.25, 0.75)
const rt2 = lonLatToBox(b, rt.lon, rt.lat)
check('box → lonlat → box', Math.abs(rt2.x - 0.25) < 1e-9 && Math.abs(rt2.y - 0.75) < 1e-9)

console.log('container')
const bytes = await packToBytes(files)
check('starts with a local file header', bytes[0] === 0x50 && bytes[1] === 0x4b)
// Written twice from the same inputs, it must be byte-identical — that is the whole
// reason createdAt and the zip timestamp are passed in rather than read from a clock.
const again = await packToBytes(files)
check('two writes are byte-identical', bytes.length === again.length && bytes.every((b, i) => b === again[i]))
check('deflate is available on this runtime', canCompress)

// The elevation plane is a smooth ramp, so deflate should beat storing it by a mile.
// This is the check that would notice compression silently stopping.
const storedSize = W * H * 2
check(
  `elevation actually compressed (archive ${bytes.length} B vs ${storedSize} B stored elevation alone)`,
  bytes.length < storedSize,
)

const reopened = await packFromBytes(bytes.slice().buffer)
check('manifest survives the container', reopened.manifest.id === 'test-box')
check('layer count survives', reopened.manifest.layers.length === 2)
check('vectors survive the container', reopened.vectors === files.vectors)

const heightsBack = readHeightField(reopened)
let worstZip = 0
for (let i = 0; i < data.length; i++) {
  worstZip = Math.max(worstZip, Math.abs(heightsBack.data[i]! - data[i]!))
}
check(`heights survive the container (worst ${worstZip.toFixed(4)} m)`, worstZip < 0.06)
check('spike survives the container', Math.abs(heightsBack.data[10 * W + 20]! - 4000) < 0.06)

const coverZip = readRaster(reopened, 'cover')
check('extra layer survives the container', coverZip !== null && coverZip.data[0] === 7)

let badThrew = ''
try {
  await packFromBytes(new ArrayBuffer(64))
} catch (e) {
  badThrew = String(e)
}
check('a non-zip is rejected', badThrew.includes('not a zip'))

console.log(failures === 0 ? '\nall passed' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
