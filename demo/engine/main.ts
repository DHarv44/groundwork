/**
 * The engine's portability test, in the form of something usable.
 *
 * It loads a pack and renders it with plain three.js — no React, no store, no builder.
 * The imports below are the whole point: `@dharv44/groundwork-engine` and `@dharv44/groundwork-core`
 * and nothing else. The moment this page needs a line from `src/`, the boundary has
 * leaked and the engine is not actually portable, whatever the folder layout says.
 *
 * It also demonstrates the other half of the contract: the engine does no network, so
 * fetching is this page's job. Here that is a file input; in a game it would be an
 * asset fetch, and in a baker a read from disk. None of that belongs in a renderer.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  boundsExtentMetres,
  packFromBytes,
  parseVectors,
  readHeightField,
  readRaster,
  sampleBox,
  type HeightField,
  type PackFiles,
  type PackVectors,
} from '@dharv44/groundwork-core'
import {
  DEFAULT_SURFACE_CONFIG,
  DEFAULT_WATER_CONFIG,
  SkyDome,
  TerrainSurface,
  WaterPlane,
  buildTerrain,
  computeSky,
  type TerrainBuild,
} from '@dharv44/groundwork-engine'

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const statusEl = el<HTMLDivElement>('status')
const infoEl = el<HTMLDListElement>('info')
const attribEl = el<HTMLDivElement>('attrib')
const roadsToggle = el<HTMLInputElement>('roads')

function say(text: string, isError = false): void {
  statusEl.textContent = text
  statusEl.className = isError ? 'err' : ''
}

// ---- scene: the host owns all of this, not the engine -----------------------

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 10, 4_000_000)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true

const sky = computeSky(70, 22)
const dome = new SkyDome(600_000)
dome.setSky(sky)
dome.setHaze(0.3)
scene.add(dome.mesh)

let surface: TerrainSurface | null = null
let water: WaterPlane | null = null
let roadLines: THREE.LineSegments | null = null

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

const clock = new THREE.Clock()
function frame(): void {
  const dt = clock.getDelta()
  controls.update()
  surface?.update(dt)
  water?.update(dt)
  dome.update(camera)
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}
frame()

// ---- loading ----------------------------------------------------------------

/**
 * The pack's field textures.
 *
 * Only the hydrology field is rebuilt here. The road and area masks are deliberately
 * *not* in a pack — they are rasterised at whatever mask resolution the builder was
 * set to, which is a display setting rather than a property of the place — so a
 * consumer that wants them draws them from the vectors itself, at its own resolution.
 * That is what the road lines below are standing in for.
 */
function waterTextureFrom(files: PackFiles): THREE.DataTexture | null {
  const found = readRaster(files, 'water')
  if (!found || !(found.data instanceof Uint8Array)) return null
  const tex = new THREE.DataTexture(found.data, found.width, found.height, THREE.RGBAFormat)
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

/**
 * Road centrelines as geometry, draped on the surface.
 *
 * Here to prove the vectors come out of a pack directly usable: this is a consumer
 * doing its own thing with them, using nothing but `sampleBox` to sit them on the
 * ground. A game would stamp a mobility raster from exactly this data instead.
 */
function buildRoadLines(vectors: PackVectors, hf: HeightField, exag: number): THREE.LineSegments {
  const { width: wM, height: dM } = boundsExtentMetres(hf.bounds)
  const pts: number[] = []

  for (const road of vectors.roads) {
    const n = road.pts.length / 2
    for (let i = 0; i < n - 1; i++) {
      for (const j of [i, i + 1]) {
        const bx = road.pts[j * 2]!
        const by = road.pts[j * 2 + 1]!
        // Box coordinates run x east and y south, and the mesh is centred on the
        // origin with X east and Z south — so this is a straight rescale, no flip.
        pts.push(
          (bx - 0.5) * wM,
          sampleBox(hf, bx, by) * exag + 12,
          (by - 0.5) * dM,
        )
      }
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ color: 0xe0a63a, transparent: true, opacity: 0.75 }),
  )
}

function frameCamera(build: TerrainBuild): void {
  const span = Math.max(build.widthMetres, build.depthMetres)
  camera.position.set(span * 0.42, span * 0.36, span * 0.66)
  controls.target.set(0, 0, 0)
  controls.update()
}

function disposeCurrent(): void {
  if (surface) {
    scene.remove(surface.mesh)
    surface.dispose()
    surface = null
  }
  if (water) {
    scene.remove(water.mesh)
    water.dispose()
    water = null
  }
  if (roadLines) {
    scene.remove(roadLines)
    roadLines.geometry.dispose()
    ;(roadLines.material as THREE.Material).dispose()
    roadLines = null
  }
}

function show(rows: Array<[string, string]>): void {
  infoEl.innerHTML = rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('')
}

async function load(source: File | string): Promise<void> {
  const label = typeof source === 'string' ? source : source.name
  say(`reading ${label}…`)
  try {
    // The engine does no network, so fetching is the host's job. A file input here; an
    // asset fetch in a game; a disk read in a baker. Same bytes either way.
    const bytes =
      typeof source === 'string'
        ? await (await fetch(source)).arrayBuffer()
        : await source.arrayBuffer()
    const files = await packFromBytes(bytes)
    const hf = readHeightField(files)
    const m = files.manifest

    disposeCurrent()

    const build = buildTerrain(hf, {
      detail: 1024,
      exaggeration: DEFAULT_SURFACE_CONFIG.exaggeration,
    })

    surface = new TerrainSurface(build)
    surface.setSky(sky)
    surface.setLayers({ water: waterTextureFrom(files) })
    surface.setConfig({ ...DEFAULT_SURFACE_CONFIG })
    scene.add(surface.mesh)

    water = new WaterPlane(build)
    water.setSky(sky)
    water.setConfig({ ...DEFAULT_WATER_CONFIG })
    scene.add(water.mesh)

    const vectors = files.vectors ? parseVectors(files.vectors) : null
    if (vectors && vectors.roads.length > 0) {
      roadLines = buildRoadLines(vectors, hf, DEFAULT_SURFACE_CONFIG.exaggeration)
      roadLines.visible = roadsToggle.checked
      scene.add(roadLines)
    }

    frameCamera(build)

    show([
      ['pack', m.name],
      ['format', `v${m.formatVersion}`],
      ['raster', `${m.width} × ${m.height}`],
      ['ground', `${(m.widthMetres / 1000).toFixed(1)} × ${(m.heightMetres / 1000).toFixed(1)} km`],
      ['elevation', `${Math.round(m.elevation.min)} – ${Math.round(m.elevation.max)} m`],
      ['layers', m.layers.map((l) => l.id).join(', ')],
      ['roads', vectors ? vectors.roads.length.toLocaleString() : '—'],
      ['areas', vectors ? vectors.areas.length.toLocaleString() : '—'],
      ['places', vectors ? vectors.places.length.toLocaleString() : '—'],
      ['triangles', build.triangles.toLocaleString()],
      ['written by', m.generator],
    ])

    attribEl.innerHTML = m.attribution
      .map((a) => `${a.source} — ${a.licence}`)
      .join('<br>')

    say(`loaded ${label}`)
  } catch (e) {
    say(String(e instanceof Error ? e.message : e), true)
    show([])
    attribEl.textContent = ''
  }
}

// ---- input ------------------------------------------------------------------

el<HTMLInputElement>('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) void load(f)
})

roadsToggle.addEventListener('change', () => {
  if (roadLines) roadLines.visible = roadsToggle.checked
})

const drop = el<HTMLDivElement>('drop')
for (const type of ['dragenter', 'dragover']) {
  addEventListener(type, (e) => {
    e.preventDefault()
    drop.classList.add('over')
  })
}
for (const type of ['dragleave', 'drop']) {
  addEventListener(type, (e) => {
    e.preventDefault()
    drop.classList.remove('over')
  })
}
addEventListener('drop', (e) => {
  const f = (e as DragEvent).dataTransfer?.files?.[0]
  if (f) void load(f)
})

// ?pack=/whatever.gwpack — the fetch path, which is what a real consumer uses.
const fromUrl = new URLSearchParams(location.search).get('pack')
if (fromUrl) void load(fromUrl)
else say('waiting for a pack')
