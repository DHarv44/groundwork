import { create } from 'zustand'
import * as THREE from 'three'
import HydrologyWorker from './workers/hydrology.worker?worker'
import RoadMaskWorker from './workers/roadmask.worker?worker'
import { DEFAULT_TUNING, type HydrologyResult, type HydrologyTuning } from './lib/hydrology'
import type { Bounds } from './lib/geo'
import { DEFAULT_BOUNDS, boundsAreaKm2, climaticSnowLine, climaticTreeLine } from './lib/geo'
import type { HeightField } from './lib/opentopo'
import { DEM_SOURCES, fetchHeightField, validateRequest } from './lib/opentopo'
import { fetchImagery } from './lib/imagery'
import {
  NoRoadDataError,
  fetchOsm,
  type AreaKind,
  type OsmData,
  type RoadClass,
} from './lib/overpass'
import type { MaskOptions, Masks } from './lib/roadmask'
import { roadCacheGet, roadCachePut, roadCacheSweep, snapBounds } from './lib/demcache'
import { biomeOf, ensureKoppen, fetchNormals, profileFor, type Biome } from './lib/climate'
import { buildBiomeField, type BiomeShare } from './lib/biomeMap'
import { makeDemoHeightField } from './lib/demo'
import { loadSession, saveSession } from './lib/session'
import { buildTerrain, type TerrainBuild } from './lib/mesh'

export type TextureMode = 'procedural' | 'satellite' | 'drainage'
export type Phase = 'idle' | 'fetching' | 'building' | 'ready' | 'error'

export interface Settings {
  exaggeration: number
  detail: number
  textureMode: TextureMode
  sunAzimuth: number
  sunElevation: number
  haze: number
  snowLine: number
  treeLine: number
  aridity: number
  strata: number
  /** Ground cover. Shader-side, so these respond without re-deriving. */
  riparian: number
  riparianReach: number
  groundWarmth: number
  /** Share of the ground cover that is trees rather than grass. */
  forest: number
  /** Which green the vegetation is: −1 blue-shifted, +1 yellow-shifted. */
  vegTint: number
  /** How saturated that green is. */
  vegSat: number
  /**
   * How much catchment a piece of ground must gather before it holds timber — the tree
   * equivalent of `minChannelKm2` for rivers. Trees are placed from the drainage field,
   * so this is the threshold that decides where the forest ends and the grass begins.
   *
   * Not a biome value: the shader already scales it by per-texel aridity and tree cover,
   * so the climatic variation comes for free and one control is enough.
   */
  treeNeed: number
  /**
   * Catchment past which the channel is open water too wide for a canopy to close over.
   * Timber is a band on the drainage scale, not a threshold — it rises as a gully
   * gathers water and falls away again once the creek has become a river.
   */
  treeLimit: number
  /** How sharply timber gives way to grass across both edges of that band. */
  treeSpread: number
  /** How raggedly the timber fingers out of the drainage rather than ending on a contour. */
  treeFractal: number
  /** How strongly timber prefers dissected ground to flat. */
  treeRough: number
  /** Local relief, in metres, that counts as fully dissected. */
  treeRoughScale: number
  /** How broadleaf the valley-bottom timber is against the conifer above it. */
  corridorLeaf: number
  textureRange: number
  /** Master opacity for derived water. */
  rivers: number
  /** Minimum drainage area a channel needs before it is drawn, 0..1 log scale. */
  riverThreshold: number
  /** Aerial perspective. Off is a diagnostic view, not a weather setting. */
  showFog: boolean
  /** The ground-cover layers, switchable independently of each other. */
  showTrees: boolean
  showGrass: boolean
  showSnow: boolean
  /** Each derived water class toggles independently. */
  showOcean: boolean
  showRivers: boolean
  showLakes: boolean
  /**
   * Roads, from OpenStreetMap.
   *
   * Unlike every other layer here these are *observed* rather than derived, so the
   * toggle also decides whether the data is fetched at all — see `loadRoads`. Turning
   * it off keeps the network in memory; it does not throw the fetch away.
   */
  showRoads: boolean
  /**
   * Multiplies the true metric width of every road class.
   *
   * Needed because roads are narrower than the mask can resolve on any large box: at
   * 100 km across, a two-lane road is a fifth of a texel. The mask holds them at a
   * legibility floor regardless, and this is how you push them past it deliberately.
   */
  roadWidth: number
  /** Cleared corridor either side, as a multiple of the surface width. */
  roadVerge: number
  /** Longest side of the road mask, in pixels. */
  roadResolution: number
  /** How dark a metalled surface reads against the ground. */
  roadDarkness: number
  /** How strongly the corridor suppresses timber. Biome-owned. */
  roadClearing: number
  /** How far the surface takes the local ground colour rather than asphalt. Biome-owned. */
  roadTint: number
  /**
   * Mapped lakes and reservoirs, drawn over the derived water.
   *
   * These are surveyed shorelines. Depression-fill lakes are a guess about where water
   * would pond given the DEM, which is a reasonable guess in a closed basin and a poor
   * one anywhere a dam or a drain decides the answer instead — so where OSM has a real
   * lake, it wins.
   */
  showOsmWater: boolean
  /** How completely a mapped lake overrides the derived guess. */
  osmWaterStrength: number
  /**
   * Mapped woodland, used to correct the derived canopy rather than replace it.
   *
   * Deliberately a correction. The generated timber follows drainage and relief, so it
   * is continuous, responds to every slider and works at any resolution; OSM woodland is
   * a patchwork whose completeness varies enormously by country. Blending keeps the
   * generated structure and pins it to observed ground where observed ground exists.
   */
  showOsmWood: boolean
  /** How far the mapped woodland pulls the canopy toward it. */
  osmWoodStrength: number
  /** Mapped built-up land: where the town is, without the per-building cost. */
  showOsmBuilt: boolean
  /** How strongly built-up land greys the ground and clears the timber. */
  osmBuiltStrength: number
  /** Sea surface. All shader-side, so these respond without re-deriving anything. */
  seaLevel: number
  shoreCutoff: number
  shoreFeather: number
  depthFade: number
  waveHeight: number
  foamWidth: number
  waterOpacity: number
  /** Hydrology knobs. Changing one re-runs the water pass, not the DEM fetch. */
  flatTolerance: number
  bodyDrift: number
  maskResolution: number
  routingResolution: number
  seaLevelMargin: number
  edgeTolerance: number
  featherCells: number
  riverFeather: number
  minLakeArea: number
  minChannelKm2: number
  riverWidthScale: number
  riverWidthExponent: number
  riverSlopeNarrowing: number
  riverMinWidthScale: number
  riverConvergence: number
  shadows: boolean
  aoStrength: number
  microDetail: number
  wireframe: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  exaggeration: 1.6,
  detail: 768,
  textureMode: 'procedural',
  // The default camera sits to the south-east, so a north-east sun rakes across the
  // relief instead of flattening it from behind the viewer.
  sunAzimuth: 70,
  sunElevation: 22,
  haze: 0.3,
  snowLine: 2600,
  treeLine: 1900,
  // Every value from here down is biome-owned, and these copies exist only for the
  // moment before a class is known — an unclassified box, or the instant between the
  // mesh appearing and the raster resolving. They are kept identical to BASE in
  // climate.ts so that gap is invisible: once the biome lands the profile supplies the
  // same numbers, and a fresh load with cleared storage comes up exactly as configured.
  aridity: 0.12,
  strata: 0.25,
  riparian: 0.4,
  riparianReach: 0.32,
  groundWarmth: 0.05,
  forest: 0.6,
  vegTint: 0,
  vegSat: 1,
  // Calibrated on north-central Texas against Esri imagery. What settles these is the
  // drainage view: the channels you can actually see sit around 0.2 on the accumulation
  // scale, and anything below that is the broad hillslope background — put the threshold
  // there and the timber spreads over a quarter of the tile as a wash instead of
  // threading the valleys.
  // In km², directly comparable with minChannelKm2 — set near it and the timber traces
  // the same channels the rivers do.
  treeNeed: 1.2,
  treeLimit: 400,
  // A narrow edge is what makes the ribbons read as ribbons rather than as a gradient.
  treeSpread: 0.04,
  treeFractal: 0.45,
  treeRough: 0.5,
  treeRoughScale: 25,
  corridorLeaf: 0.6,
  textureRange: 1,
  rivers: 1,
  // 0.30 on the log-drainage scale is about 1 km² of catchment — roughly where a
  // channel actually starts in humid country.
  riverThreshold: 0.175,
  showFog: true,
  showTrees: true,
  showGrass: true,
  showSnow: true,
  showOcean: true,
  showRivers: true,
  showLakes: true,
  showRoads: true,
  roadWidth: 1,
  roadVerge: 3,
  roadResolution: 2048,
  roadDarkness: 0.55,
  // Kept identical to BASE in climate.ts, for the same reason as the block above: these
  // are the values in force for the moment before a class is known.
  roadClearing: 0.6,
  roadTint: 0.35,
  showOsmWater: true,
  osmWaterStrength: 1,
  showOsmWood: true,
  // A correction, not a replacement — so it starts at rather less than full weight.
  osmWoodStrength: 0.7,
  showOsmBuilt: true,
  osmBuiltStrength: 0.65,
  seaLevel: 0,
  shoreCutoff: 0.25,
  shoreFeather: 0,
  depthFade: 75,
  waveHeight: 0,
  foamWidth: 0,
  waterOpacity: 0.57,
  ...DEFAULT_TUNING,
  shadows: true,
  aoStrength: 0.85,
  microDetail: 0.6,
  wireframe: false,
}

/**
 * The surface settings a biome is allowed to set. Deliberately only the ones that are
 * genuinely climatic — rock strata, micro relief and texture range describe the geology
 * and the render, not the vegetation, so they stay yours.
 */
/**
 * Everything a biome owns.
 *
 * Snow and tree lines are deliberately absent. Those are altitude physics — lapse rate
 * and the oxygen and temperature that come with it — so they belong to the place rather
 * than to the vegetation, and they stay global.
 *
 * Everything else here is a property of the biome and is stored against it. The default
 * is that a surface setting belongs to the class; a setting only stays global if there
 * is a reason it cannot sensibly differ between one climate and another.
 */
export const BIOME_KEYS = [
  'aridity',
  'riparian',
  'riparianReach',
  'groundWarmth',
  'forest',
  'vegTint',
  'vegSat',
  'treeNeed',
  'treeLimit',
  'treeSpread',
  'treeFractal',
  'treeRough',
  'treeRoughScale',
  'corridorLeaf',
  'strata',
  // Roads are observed rather than derived, but how the ground *responds* to one is not.
  // Boreal forest is felled back many times the width of the road; a desert track has no
  // verge because there is nothing to clear, and its surface is simply the ground.
  'roadClearing',
  'roadTint',
] as const

export type BiomeKey = (typeof BIOME_KEYS)[number]

/**
 * The subset that is genuinely per-class, and so follows whichever biome you have
 * selected to edit. The rest are properties of the tile as a whole: one mountain range
 * has one tree line and one snow line however many climates cross it, and corridor
 * reach barely varies between classes at all.
 */
export const PER_CLASS_KEYS = BIOME_KEYS

interface State {
  bounds: Bounds | null
  demType: string
  phase: Phase
  message: string
  error: string | null
  heightField: HeightField | null
  build: TerrainBuild | null
  imagery: HTMLCanvasElement | null
  imageryZoom: number
  /** RGBA water mask from the hydrology pass: coverage, lake flag, log drainage. */
  waterMask: THREE.DataTexture | null
  waterStats: {
    rivers: number
    lakes: number
    maxDrainageKm2: number
  } | null
  /** Everything OSM knows about the box, kept so masks rebuild without a request. */
  roads: OsmData | null
  /** RGBA road mask: surface, class, cleared corridor. */
  roadMask: THREE.Texture | null
  /** RGBA area mask: water, woodland, built-up. */
  areaMask: THREE.Texture | null
  /**
   * Where the OSM fetch has got to.
   *
   * `empty` is deliberately its own state rather than an error. Open desert, ocean and
   * genuine wilderness have nothing mapped, and that is the correct answer — without
   * somewhere to say so, an empty box is indistinguishable from a fetch that fell over,
   * and you spend an hour debugging a map that simply has nothing on it.
   */
  roadPhase: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
  roadError: string | null
  roadInfo: {
    lengthKm: number
    byClass: Array<{ cls: RoadClass; km: number }>
    metresPerPixel: number
    /** Classes dropped from the request because the box is too large to resolve them. */
    filtered: boolean
    /** Classes drawn wider than life so they stay visible at this scale. */
    widened: RoadClass[]
    /** Rings drawn per kind. Zero is a fact about the place, not a failure. */
    areaCounts: Record<AreaKind, number>
    /** Worker-side rasterise time. Off the main thread, so this is cost, not stutter. */
    drawMs: number
  } | null
  settings: Settings
  /** True while satellite tiles are in flight, so the layer button can say so. */
  imageryLoading: boolean
  /** Köppen class of the selected area, read from the bundled raster. */
  biome: Biome | null
  /**
   * The biomes inside the box baked to a texture — aridity, riparian, ground warmth and
   * corridor reach per texel. A tile spanning a mountain front is several climates, and
   * this is what lets it render as several rather than as its majority.
   */
  biomeMap: THREE.DataTexture | null
  /** Every class present in the box with its share of the land, largest first. */
  biomeComposition: BiomeShare[]
  /**
   * Which class the surface sliders act on. Null means the dominant one. A tile is
   * often several climates, and without this only the majority is reachable — you
   * could not touch the plains of a box whose mountains happened to win on area.
   */
  editingBiome: string | null
  /**
   * Your own values for each biome, keyed by Köppen code. Editing a surface slider
   * while a biome is active records it here, so the next tile in that climate comes up
   * the way you tuned it. Saved with presets, so a preset carries your whole scheme
   * rather than a single place's numbers.
   */
  biomeOverrides: Record<string, Partial<Record<BiomeKey, number>>>
  /**
   * Which surface settings are currently the biome's doing rather than a preset's or a
   * hand edit made before the biome was known.
   */
  biomeKeys: BiomeKey[]
  /**
   * Viewport scrubs: how the place is being *looked at*, not what it is.
   *
   * Deliberately outside `settings`, which is the only thing persisted, snapshotted into
   * presets, or stored against a biome. Winter is not a property of Colorado, so putting
   * it there would mean a preset saved in January dragged snow onto every tile it was
   * later applied to. Keeping them here makes that impossible by construction rather
   * than by remembering to exclude them from three separate lists.
   *
   * Both reset on reload, which is the intent — you scrub, look, and let go.
   */
  /** 0 = the climatic snow line, 1 = snow to the valley floor. */
  winter: number
  /** Multiplier on aerial perspective. 1 = as the atmosphere model computes it. */
  hazeScrub: number
  /** True while standing on the ground in first person rather than orbiting. */
  walking: boolean

  /** Incremented whenever the viewer should re-frame the camera. */
  frameToken: number

  setBounds: (b: Bounds | null) => void
  setDemType: (id: string) => void
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  reset: () => void
  resetSettings: () => void
  /** Point the surface sliders at one of the classes present. Null returns to dominant. */
  setEditingBiome: (code: string | null) => void
  /** Discard your overrides for the selected biome and go back to its built-in profile. */
  resetBiome: () => void
  /** Classify the current selection. Called on start-up and whenever the box moves. */
  refreshBiome: () => void
  /** Drag winter in and out. Transient — never persisted, never saved to a preset. */
  setWinter: (v: number) => void
  /** Scale the aerial perspective. Transient, same reasoning. */
  setHazeScrub: (v: number) => void
  /** Entering and leaving first person. Transient. */
  setWalking: (v: boolean) => void
  /** Overwrite the live settings from a saved snapshot. */
  applySettings: (patch: Record<string, unknown>) => void
  /** The persistable slice, for saving as a preset. */
  settingsSnapshot: () => Record<string, unknown>
  generate: () => Promise<void>
  generateDemo: () => Promise<void>
  loadImagery: () => Promise<void>
  /** Fetch (or recall) the road network for the built area. Safe to call repeatedly. */
  loadRoads: () => Promise<void>
}

let inflight: AbortController | null = null

let hydroWorker: Worker | null = null

/**
 * The road-mask worker, and the bookkeeping that keeps the network on its side.
 *
 * `roadToken` names the current box; `roadSent` records which box the worker has
 * actually been given. They differ exactly once per box — on the first draw after a
 * fetch — and that is the only message that carries the ways.
 */
let roadWorker: Worker | null = null
let roadToken = 0
let roadSent = -1

const restored = loadSession()

/**
 * Settings worth carrying across a reload. Snow and tree lines are deliberately left
 * out — they are re-derived from the tile's latitude on every build, so persisting
 * them would just be overwritten.
 */
const PERSISTED_SETTINGS = [
  'exaggeration',
  'detail',
  'textureMode',
  'sunAzimuth',
  'sunElevation',
  'haze',
  'aridity',
  'strata',
  'riparian',
  'riparianReach',
  'groundWarmth',
  'forest',
  'vegTint',
  'vegSat',
  'treeNeed',
  'treeLimit',
  'treeSpread',
  'treeFractal',
  'treeRough',
  'treeRoughScale',
  'corridorLeaf',
  'textureRange',
  'rivers',
  'riverThreshold',
  'showFog',
  'showTrees',
  'showGrass',
  'showSnow',
  'showOcean',
  'showRivers',
  'showLakes',
  'showRoads',
  'roadWidth',
  'roadVerge',
  'roadResolution',
  'roadDarkness',
  'roadClearing',
  'roadTint',
  'showOsmWater',
  'osmWaterStrength',
  'showOsmWood',
  'osmWoodStrength',
  'showOsmBuilt',
  'osmBuiltStrength',
  'seaLevel',
  'shoreCutoff',
  'shoreFeather',
  'depthFade',
  'waveHeight',
  'foamWidth',
  'waterOpacity',
  'shadows',
  'aoStrength',
  'microDetail',
  'wireframe',
  'flatTolerance',
  'bodyDrift',
  'maskResolution',
  'routingResolution',
  'seaLevelMargin',
  'edgeTolerance',
  'featherCells',
  'riverFeather',
  'minLakeArea',
  'minChannelKm2',
  'riverWidthScale',
  'riverWidthExponent',
  'riverSlopeNarrowing',
  'riverMinWidthScale',
  'riverConvergence',
] as const

export type BiomeOverrides = Record<string, Partial<Record<BiomeKey, number>>>

function persistSettings(settings: Settings, biomeOverrides?: BiomeOverrides): void {
  const slice: Record<string, unknown> = {}
  for (const k of PERSISTED_SETTINGS) slice[k] = settings[k]
  saveSession(biomeOverrides ? { settings: slice, biomeOverrides } : { settings: slice })
}

/** Release the GPU resources a build owns. Nothing else references them. */
function disposeBuild(build: TerrainBuild | null): void {
  build?.geometry.dispose()
  build?.normalTexture.dispose()
  build?.heightTexture.dispose()
}

/**
 * Run the hydrology pass off the main thread. The height data is copied before being
 * handed over, because the mesh builder still needs the original.
 */
function runHydrology(
  hf: HeightField,
  widthMetres: number,
  depthMetres: number,
  tuning: HydrologyTuning,
): Promise<HydrologyResult> {
  return new Promise((resolve, reject) => {
    hydroWorker?.terminate()
    const worker = new HydrologyWorker()
    hydroWorker = worker

    worker.onmessage = (e: MessageEvent<HydrologyResult & { error?: string }>) => {
      worker.terminate()
      if (hydroWorker === worker) hydroWorker = null
      if (e.data.error) reject(new Error(e.data.error))
      else resolve(e.data)
    }
    worker.onerror = (e) => {
      worker.terminate()
      if (hydroWorker === worker) hydroWorker = null
      reject(new Error(e.message || 'hydrology worker failed'))
    }

    const copy = hf.data.slice()
    worker.postMessage(
      {
        data: copy,
        width: hf.width,
        height: hf.height,
        widthMetres,
        depthMetres,
        seaLevel: 0,
        tuning,
      },
      [copy.buffer],
    )
  })
}

function makeWaterTexture(result: HydrologyResult): THREE.DataTexture {
  const tex = new THREE.DataTexture(result.mask, result.width, result.height, THREE.RGBAFormat)
  tex.flipY = false
  // Mipmapped. Without them a screen pixel takes one texel out of ~1600, so which
  // texel it lands on flickers as the camera moves — the mask's hard edges and the
  // fine drainage filigree both alias badly. Anisotropy keeps it from smearing when
  // the terrain is viewed at a shallow angle.
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 8
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}

export const useStore = create<State>((setState, getState) => {
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null
  let waterTimer: ReturnType<typeof setTimeout> | null = null

  function tuningOf(s: Settings): HydrologyTuning {
    return {
      flatTolerance: s.flatTolerance,
      bodyDrift: s.bodyDrift,
      maskResolution: s.maskResolution,
      routingResolution: s.routingResolution,
      seaLevelMargin: s.seaLevelMargin,
      edgeTolerance: s.edgeTolerance,
      featherCells: s.featherCells,
      riverFeather: s.riverFeather,
      minLakeArea: s.minLakeArea,
      minChannelKm2: s.minChannelKm2,
      riverWidthScale: s.riverWidthScale,
      riverWidthExponent: s.riverWidthExponent,
      riverSlopeNarrowing: s.riverSlopeNarrowing,
      riverMinWidthScale: s.riverMinWidthScale,
      riverConvergence: s.riverConvergence,
    }
  }

  /** The class the sliders currently act on: whichever you picked, else the dominant. */
  function editingCode(dominant: string): string {
    const { editingBiome, biomeComposition } = getState()
    // A selection only survives while that class is still in the box.
    if (editingBiome && biomeComposition.some((c) => c.code === editingBiome)) return editingBiome
    return dominant
  }

  /**
   * Every biome-owned setting for the class the sliders are pointed at: its built-in
   * profile first, then whatever you have tuned for that class on top.
   *
   * There is no second tier here. Each of these belongs to the class and is stored
   * against it, so a value tuned in one steppe tile comes back in the next one.
   */
  function biomeSettings(code: string): Record<BiomeKey, number> {
    const edit = editingCode(code)
    const p = profileFor(edit) as unknown as Record<string, number>
    const mine = getState().biomeOverrides[edit] ?? {}

    const out = {} as Record<BiomeKey, number>
    for (const k of BIOME_KEYS) out[k] = mine[k] ?? p[k]
    return out
  }

  /**
   * Snow and tree lines, which are not biome settings.
   *
   * These are altitude physics rather than ecology, so they belong to the tile as a
   * whole. They still take a correction from the classes present — the latitude curve
   * is calibrated to maritime ranges and a continental interior runs a third higher on
   * the same parallel — but it comes from the highest any class present implies, not
   * from the majority. Otherwise a box that is mostly steppe puts its tree line at the
   * plains' altitude and strips the forest off the range beside it.
   */
  function altitudeLines(code: string, midLat: number): { snowLine: number; treeLine: number } {
    const tile = profileFor(code)
    let snowScale = tile.snowLineScale
    let treeScale = tile.treeLineScale
    for (const c of getState().biomeComposition) {
      const q = profileFor(c.code)
      snowScale = Math.max(snowScale, q.snowLineScale)
      treeScale = Math.max(treeScale, q.treeLineScale)
    }
    return {
      snowLine: Math.round(climaticSnowLine(midLat) * snowScale),
      treeLine: Math.round(climaticTreeLine(midLat) * treeScale),
    }
  }

  function applyBiome(biome: Biome, midLat: number): void {
    const next: Settings = {
      ...getState().settings,
      ...altitudeLines(biome.code, midLat),
      ...biomeSettings(biome.code),
    }
    setState({ settings: next, biome, biomeKeys: [...BIOME_KEYS] })
    persistSettings(next)
  }

  /**
   * Classify the selected area and dress the surface to match.
   *
   * The class comes from the bundled raster, so this is instant and can run on every
   * change of the box. The temperature and rainfall readout follows behind over the
   * network; it is only ever shown, never acted on, so it cannot hold anything up.
   */
  function deriveBiome(): void {
    const bounds = getState().bounds
    if (!bounds) return

    void ensureKoppen().then(() => {
      // The selection may have moved on while the raster was loading.
      if (getState().bounds !== bounds) return

      const biome = biomeOf(bounds)
      if (!biome) {
        getState().biomeMap?.dispose()
        setState({ biome: null, biomeKeys: [], biomeMap: null, biomeComposition: [] })
        return
      }

      const previous = getState().biome
      // Bake first: the field's composition is what the snow and tree lines are drawn
      // from, so it has to exist before the settings are worked out.
      bakeBiomeField()
      applyBiome(biome, (bounds.north + bounds.south) / 2)

      // One readout per class is enough to label the panel; re-fetching it for every
      // nudge of the box would burn the rate limit for a cosmetic line of text.
      if (previous?.code === biome.code && previous.normals) {
        setState({ biome: { ...biome, normals: previous.normals } })
        return
      }
      void fetchNormals(bounds).then((normals) => {
        if (!normals) return
        const live = getState().biome
        if (live?.code === biome.code) setState({ biome: { ...live, normals } })
      })
    })
  }

  /**
   * Rebake the biome field for the current box. Cheap — a quarter-megapixel of raster
   * lookups and a separable blur — but it runs on every slider tick while you drag, so
   * it is coalesced like the other derived passes.
   */
  function bakeBiomeField(): void {
    const { bounds, biomeOverrides, biomeMap } = getState()
    if (!bounds) return

    const field = buildBiomeField(bounds, biomeOverrides)
    if (!field) {
      biomeMap?.dispose()
      setState({ biomeMap: null, biomeComposition: [] })
      return
    }

    const tex = new THREE.DataTexture(field.data, field.width, field.height, THREE.RGBAFormat)
    // Row 0 is the north edge, as with the height field and the water mask.
    tex.flipY = false
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    tex.needsUpdate = true

    biomeMap?.dispose()
    setState({ biomeMap: tex, biomeComposition: field.composition })
  }

  let biomeTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleBiomeBake(): void {
    if (biomeTimer !== null) clearTimeout(biomeTimer)
    biomeTimer = setTimeout(() => {
      biomeTimer = null
      bakeBiomeField()
    }, 120)
  }

  function applyWater(result: HydrologyResult): void {
    getState().waterMask?.dispose()
    setState({
      waterMask: makeWaterTexture(result),
      waterStats: {
        rivers: result.riverCells,
        lakes: result.lakeCells,
        maxDrainageKm2: result.maxDrainageKm2,
      },
    })
  }

  /**
   * Re-derive water only. The DEM and the mesh are untouched, so tuning a knob costs
   * one worker pass rather than a rebuild — and never an API call.
   */
  function scheduleWater(): void {
    if (waterTimer !== null) clearTimeout(waterTimer)
    waterTimer = setTimeout(() => {
      waterTimer = null
      const { heightField, build, settings } = getState()
      if (!heightField || !build) return
      setState({ message: 'Re-deriving water…' })
      runHydrology(heightField, build.widthMetres, build.depthMetres, tuningOf(settings))
        .then((result) => {
          applyWater(result)
          setState({ message: '' })
        })
        .catch((e) => {
          setState({ message: '' })
          console.warn('hydrology failed', e)
        })
    }, 220)
  }

  /**
   * Redraw the masks from the feature data already in memory.
   *
   * Separate from the fetch on purpose: width, verge and resolution are all painting
   * decisions, so dragging any of them has to be free. Only moving the box costs a
   * request.
   *
   * The drawing happens in a worker. The data crosses the boundary once per box —
   * `roadToken` is what tells the worker whether it already holds this one — and every
   * subsequent redraw sends only the three numbers that changed.
   */
  function rebuildRoadMask(): void {
    const { roads, settings } = getState()
    if (!roads) return

    // Drawn for the terrain's box, not the data's. A cache hit can be any earlier fetch
    // that contains this one, so the two are often different.
    const renderBounds = getState().heightField?.bounds ?? roads.bounds
    const opts: MaskOptions = {
      renderBounds,
      resolution: settings.roadResolution,
      widthScale: settings.roadWidth,
      vergeScale: settings.roadVerge,
    }

    // One worker, reused. Replacing it would throw away the held data and the warm
    // geometry cache, which is the entire point of keeping it.
    if (!roadWorker) {
      roadWorker = new RoadMaskWorker()
      roadWorker.onmessage = (e: MessageEvent<Masks & { error?: string }>) => {
        if (e.data.error) {
          console.warn('mask rasterise failed', e.data.error)
          return
        }
        applyMasks(e.data)
      }
      roadWorker.onerror = (e) => console.warn('mask worker failed', e.message)
      // A fresh worker holds nothing, so the next post has to carry the data.
      roadSent = -1
    }

    const first = roadSent !== roadToken
    roadSent = roadToken
    roadWorker.postMessage(first ? { token: roadToken, data: roads, opts } : { token: roadToken, opts })
  }

  /**
   * Wrap a finished bitmap as a texture.
   *
   * Anisotropy is high because roads are thin, near-horizontal lines seen at a shallow
   * angle — the exact case that smears to nothing without it. The area mask inherits the
   * same settings; it costs nothing and shorelines are seen at the same angles.
   */
  function maskTexture(bitmap: ImageBitmap): THREE.Texture {
    const tex = new THREE.Texture(bitmap as unknown as HTMLImageElement)
    // Row 0 is the north edge, as with every other field over the tile.
    tex.flipY = false
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = true
    tex.anisotropy = 16
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    tex.needsUpdate = true
    return tex
  }

  /** Bind finished masks to textures and publish the stats that go with them. */
  function applyMasks(mask: Masks): void {
    const { roads, roadMask, areaMask } = getState()
    if (!roads) {
      // The box moved while the worker was drawing — these describe somewhere else now.
      mask.roads.close()
      mask.areas.close()
      return
    }

    const roadTex = maskTexture(mask.roads)
    const areaTex = maskTexture(mask.areas)

    roadMask?.dispose()
    areaMask?.dispose()
    setState({
      roadMask: roadTex,
      areaMask: areaTex,
      roadInfo: {
        lengthKm: roads.lengthKm,
        byClass: mask.byClass,
        metresPerPixel: mask.metresPerPixel,
        filtered: roads.filtered,
        widened: mask.widened,
        areaCounts: mask.areaCounts,
        drawMs: mask.drawMs,
      },
    })
  }

  let roadTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleRoadMask(): void {
    if (roadTimer !== null) clearTimeout(roadTimer)
    roadTimer = setTimeout(() => {
      roadTimer = null
      rebuildRoadMask()
    }, 160)
  }

  /** Drop the OSM data and its masks — called whenever the area changes under us. */
  function clearRoads(): void {
    getState().roadMask?.dispose()
    getState().areaMask?.dispose()
    // A new box means new data, so the worker's held copy and its projected geometry
    // are both stale. Bumping the token is what forces the next draw to resend.
    roadToken++
    setState({
      roads: null,
      roadMask: null,
      areaMask: null,
      roadInfo: null,
      roadPhase: 'idle',
      roadError: null,
    })
  }

  /** Coalesce rapid geometry changes into one rebuild once the slider settles. */
  function scheduleRebuild(): void {
    if (rebuildTimer !== null) clearTimeout(rebuildTimer)
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null
      const { heightField, settings, build: previous } = getState()
      if (!heightField) return

      const build = buildTerrain(heightField, {
        detail: settings.detail,
        exaggeration: settings.exaggeration,
      })
      setState({ build })

      // Release the old GPU resources only after the new ones are bound; disposing
      // them while the material still points at them frees textures mid-frame.
      requestAnimationFrame(() => disposeBuild(previous))
    }, 130)
  }

  /**
   * Shared tail of every terrain build: mesh, climatic tuning, then the hydrology pass
   * streaming in behind it. Used by both the API path and the offline demo.
   */
  async function finishBuild(
    heightField: HeightField,
    signal: AbortSignal,
    fromCache: boolean,
  ): Promise<void> {
    const settings = getState().settings
    setState({
      phase: 'building',
      heightField,
      message: `${fromCache ? 'From cache' : 'Decoded'} ${heightField.width}×${heightField.height} samples — building mesh…`,
    })

    // Yield so the status text paints before the synchronous mesh build blocks.
    await new Promise((r) => setTimeout(r, 16))

    const build = buildTerrain(heightField, {
      detail: settings.detail,
      exaggeration: settings.exaggeration,
    })

    // Snow and tree lines come from the latitude, so flat lowland stays green and
    // alpine terrain gets a snow line where one actually belongs.
    const midLat = (heightField.bounds.north + heightField.bounds.south) / 2
    setState((s) => ({
      phase: 'ready',
      build,
      message: '',
      settings: {
        ...s.settings,
        snowLine: Math.round(climaticSnowLine(midLat)),
        treeLine: Math.round(climaticTreeLine(midLat)),
      },
      frameToken: s.frameToken + 1,
    }))

    if (getState().settings.textureMode === 'satellite') void getState().loadImagery()
    // The demo's bounds are invented, so asking OSM about them would burn a request to
    // be told, correctly, that there is nothing there.
    if (getState().settings.showRoads && heightField.demtype !== 'DEMO') {
      void getState().loadRoads()
    }

    // The lines just set above are the bare latitude curve. Re-deriving puts the
    // biome's correction back on top — without this the build silently undoes it, and
    // a forested range whose class carries a high tree line gets stripped to bare rock.
    deriveBiome()

    // Terrain is already on screen; rivers and lakes stream in behind it.
    runHydrology(heightField, build.widthMetres, build.depthMetres, tuningOf(settings))
      .then((result) => {
        if (signal.aborted) return
        applyWater(result)
      })
      .catch((e) => {
        console.warn('hydrology failed', e)
        // Surfaced rather than swallowed: the loading screen waits on the derived
        // layers, so a silent failure would leave it spinning for ever.
        if (!signal.aborted) setState({ error: 'Water derivation failed for this area.' })
      })
  }

  return {
  // A first run lands on a real area rather than an empty map, so the app has something
  // to show without anyone having to draw a box first.
  bounds: restored.bounds ?? DEFAULT_BOUNDS,
  // Keyless and uncapped, so the app works out of the box and normal use never
  // eats into the OpenTopography allowance.
  demType: restored.demType ?? 'AWS_TERRARIUM',
  phase: 'idle',
  message: '',
  error: null,
  heightField: null,
  build: null,
  imagery: null,
  imageryZoom: 0,
  imageryLoading: false,
  waterMask: null,
  waterStats: null,
  roads: null,
  roadMask: null,
  areaMask: null,
  roadPhase: 'idle',
  roadError: null,
  roadInfo: null,
  settings: { ...DEFAULT_SETTINGS, ...(restored.settings as Partial<Settings>) },
  biome: null,
  biomeMap: null,
  biomeComposition: [],
  editingBiome: null,
  biomeOverrides: (restored.biomeOverrides as BiomeOverrides) ?? {},
  biomeKeys: [],
  // A touch of winter on the tops by default — it reads as a real place rather than a
  // rendering, and it makes the snow line visible without having to go looking for it.
  winter: 0.25,
  // Aerial perspective measured out at up to +35 luminance across the frame, flattening
  // the ground's warmth almost to neutral. A quarter of the atmospheric model keeps the
  // sense of depth without washing the colour off the terrain.
  hazeScrub: 0.25,
  walking: false,
  frameToken: 0,

  setBounds: (bounds) => {
    setState({ bounds, error: null })
    saveSession({ bounds })
    // Reclassify as the box moves — no request, so this is free on every drag.
    deriveBiome()
  },
  setDemType: (demType) => {
    setState({ demType, error: null })
    saveSession({ demType })
  },

  set: (key, value) => {
    const { settings, biomeKeys, biome, biomeOverrides } = getState()
    const next = { ...settings, [key]: value }

    // Editing a climatic slider while a biome is known records the value against that
    // biome, not against this one tile: dial the aridity down in a Cfa valley and every
    // Cfa tile you open afterwards comes up the same. Presets carry the whole table.
    //
    // Per-class values land on whichever class the sliders are pointed at; the tile-wide
    // ones always land on the dominant, since that is what they describe.
    const target =
      biome && (BIOME_KEYS as readonly string[]).includes(key) ? editingCode(biome.code) : null
    const overrides = target
      ? {
          ...biomeOverrides,
          [target]: { ...biomeOverrides[target], [key]: value as number },
        }
      : biomeOverrides

    setState({
      settings: next,
      biomeOverrides: overrides,
      biomeKeys: biomeKeys.filter((k) => k !== (key as BiomeKey)),
    })
    persistSettings(next, overrides)

    // An edit to a climatic slider changes that class's numbers, so the field has to be
    // rebaked — only the texels of that class move, which is what makes tuning the
    // plains leave the mountains alone.
    if (overrides !== biomeOverrides) scheduleBiomeBake()

    // Geometry-affecting settings need the mesh rebuilt from the cached DEM. Slider
    // drags fire on every pixel of travel, and a rebuild is hundreds of thousands of
    // vertices, so coalesce them instead of rebuilding per event.
    if (key === 'exaggeration' || key === 'detail') scheduleRebuild()
    if (key in DEFAULT_TUNING) scheduleWater()
    // Painting decisions, not data ones — redraw the mask, never re-request it.
    if (key === 'roadWidth' || key === 'roadVerge' || key === 'roadResolution') {
      scheduleRoadMask()
    }
    // Checking the layer is what asks for the data, the same way switching to satellite
    // is what fetches the imagery.
    if (key === 'showRoads' && value) void getState().loadRoads()
  },

  /**
   * Put every display and hydrology setting back to its default.
   *
   * Deliberately narrow: the area, the source, the 3D camera and the mini-map position
   * are all left alone, so this clears what you have been dialling without also
   * throwing away where you were looking.
   *
   * Snow and tree lines are carried over rather than reset, since they are derived
   * from the tile's latitude on each build and are not preferences.
   */
  settingsSnapshot: () => {
    const { settings, biomeOverrides } = getState()
    const slice: Record<string, unknown> = {}
    for (const k of PERSISTED_SETTINGS) slice[k] = settings[k]
    // Your per-biome tuning travels with the preset. That is what makes a preset a way
    // of working rather than one place's numbers — recall it anywhere and every climate
    // still comes up dressed the way you set it.
    slice.biomeOverrides = biomeOverrides
    return slice
  },

  applySettings: (patch) => {
    const { settings, biomeOverrides, biome, bounds } = getState()
    const { biomeOverrides: incoming, ...rest } = patch as Record<string, unknown> & {
      biomeOverrides?: BiomeOverrides
    }
    // Snow and tree lines stay put: they are re-derived from the tile's latitude on
    // every build, so a preset carrying them would just be overwritten.
    const next: Settings = {
      ...settings,
      ...(rest as Partial<Settings>),
      snowLine: settings.snowLine,
      treeLine: settings.treeLine,
    }
    const overrides = incoming ?? biomeOverrides
    setState({ settings: next, biomeOverrides: overrides, biomeKeys: [] })
    persistSettings(next, overrides)
    // The preset's per-biome table only shows itself once it is applied to the biome
    // actually on screen.
    if (biome && bounds) applyBiome(biome, (bounds.north + bounds.south) / 2)
    bakeBiomeField()
    scheduleWater()
    // A preset can carry geometry settings, which need the mesh rebuilt.
    if (next.exaggeration !== settings.exaggeration || next.detail !== settings.detail) {
      scheduleRebuild()
    }
  },

  resetSettings: () => {
    const { settings, biome, bounds } = getState()
    const next: Settings = {
      ...DEFAULT_SETTINGS,
      snowLine: settings.snowLine,
      treeLine: settings.treeLine,
    }
    // Defaults means defaults: the per-biome table goes too, otherwise the surface
    // sliders would spring straight back to your tuning.
    setState({ settings: next, biomeOverrides: {}, biomeKeys: [] })
    persistSettings(next, {})
    if (biome && bounds) applyBiome(biome, (bounds.north + bounds.south) / 2)
    bakeBiomeField()
    scheduleWater()
  },

  refreshBiome: () => deriveBiome(),

  setWinter: (winter) => setState({ winter: Math.min(1, Math.max(0, winter)) }),
  setHazeScrub: (hazeScrub) => setState({ hazeScrub: Math.max(0, hazeScrub) }),
  setWalking: (walking) => setState({ walking }),

  setEditingBiome: (code) => {
    const { biome, bounds } = getState()
    setState({ editingBiome: code })
    // Re-derive so the sliders jump to the selected class's values straight away.
    if (biome && bounds) applyBiome(biome, (bounds.north + bounds.south) / 2)
  },

  resetBiome: () => {
    const { biome, bounds, biomeOverrides } = getState()
    if (!biome || !bounds) return
    // Clears the class you are looking at, not the majority one.
    const target = editingCode(biome.code)
    const rest = { ...biomeOverrides }
    delete rest[target]
    setState({ biomeOverrides: rest })
    applyBiome(biome, (bounds.north + bounds.south) / 2)
    bakeBiomeField()
    persistSettings(getState().settings, rest)
  },

  reset: () => {
    inflight?.abort()
    hydroWorker?.terminate()
    hydroWorker = null
    disposeBuild(getState().build)
    getState().waterMask?.dispose()
    clearRoads()
    setState({
      waterMask: null,
      waterStats: null,
      phase: 'idle',
      message: '',
      error: null,
      heightField: null,
      build: null,
      imagery: null,
      imageryZoom: 0,
      imageryLoading: false,
    })
  },

  generate: async () => {
    const { bounds, demType } = getState()
    if (!bounds) return

    const source = DEM_SOURCES.find((s) => s.id === demType)!
    const problem = validateRequest(bounds, source)
    if (problem) {
      setState({ phase: 'error', error: problem })
      return
    }

    inflight?.abort()
    inflight = new AbortController()
    const signal = inflight.signal

    // Tear the old terrain down before the request goes out: the viewer falls back to
    // the loading screen instead of leaving the previous area on screen, and the stale
    // satellite imagery is dropped so the new area re-fetches its own tiles.
    hydroWorker?.terminate()
    hydroWorker = null
    disposeBuild(getState().build)
    getState().waterMask?.dispose()
    // The roads belong to the old box. Keeping them would drape another town's street
    // plan over this one until the new fetch landed.
    clearRoads()

    const area = Math.round(boundsAreaKm2(bounds))
    setState({
      phase: 'fetching',
      error: null,
      build: null,
      heightField: null,
      imagery: null,
      imageryZoom: 0,
      imageryLoading: false,
      waterMask: null,
      waterStats: null,
      message: `Requesting ${source.label} over ${area.toLocaleString()} km²…`,
    })

    try {
      let fromCache = false
      const heightField = await fetchHeightField(
        bounds,
        demType,
        signal,
        () => {
          fromCache = true
        },
        (done, total) => setState({ message: `Elevation tiles ${done}/${total}…` }),
      )
      if (signal.aborted) return
      await finishBuild(heightField, signal, fromCache)
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      setState({
        phase: 'error',
        error: err instanceof Error ? err.message : String(err),
        message: '',
      })
    }
  },

  generateDemo: async (): Promise<void> => {
    inflight?.abort()
    inflight = new AbortController()
    const signal = inflight.signal

    hydroWorker?.terminate()
    hydroWorker = null
    disposeBuild(getState().build)
    getState().waterMask?.dispose()
    clearRoads()

    setState({
      phase: 'building',
      error: null,
      build: null,
      heightField: null,
      imagery: null,
      imageryZoom: 0,
      imageryLoading: false,
      waterMask: null,
      waterStats: null,
      message: 'Generating synthetic massif…',
    })

    await new Promise((r) => setTimeout(r, 16))
    const hf = makeDemoHeightField()
    setState({ bounds: hf.bounds })
    deriveBiome()
    await finishBuild(hf, signal, false)
  },

  loadImagery: async (): Promise<void> => {
    const { heightField, imagery, imageryLoading } = getState()
    if (!heightField || imagery || imageryLoading) return
    try {
      setState({ imageryLoading: true, message: 'Fetching satellite imagery…' })
      const result = await fetchImagery(heightField.bounds, (done, total) => {
        setState({ message: `Satellite tiles ${done}/${total}…` })
      })
      setState({
        imagery: result.canvas,
        imageryZoom: result.zoom,
        imageryLoading: false,
        message: '',
      })
    } catch {
      setState({
        imageryLoading: false,
        message: '',
        error: 'Satellite imagery unavailable for this area.',
      })
    }
  },

  loadRoads: async (): Promise<void> => {
    const { heightField, roads, roadPhase } = getState()
    if (!heightField) return
    // Already have them, or already asking.
    if (roads || roadPhase === 'loading') return

    const bounds = heightField.bounds
    setState({ roadPhase: 'loading', roadError: null })

    // Cached answers cost nothing, and Overpass is free shared infrastructure — asking
    // it twice for the same box is the one thing that would actually be rude.
    const hit = await roadCacheGet(bounds)
    if (hit) {
      setState({ roads: hit, roadPhase: hit.roads.length || hit.areas.length ? 'ready' : 'empty' })
      rebuildRoadMask()
      return
    }

    try {
      // Fetch the snapped box rather than the exact one, so the next small adjustment of
      // the selection is answered from here instead of going back to Overpass.
      const network = await fetchOsm(snapBounds(bounds), bounds, undefined, (note) =>
        setState({ message: note }),
      )
      // The area may have been rebuilt while Overpass was thinking.
      if (getState().heightField?.bounds !== bounds) return

      void roadCachePut(network)
      setState({
        roads: network,
        roadPhase: network.roads.length || network.areas.length ? 'ready' : 'empty',
        message: '',
      })
      rebuildRoadMask()
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      setState({
        roadPhase: 'error',
        message: '',
        roadError:
          err instanceof NoRoadDataError
            ? err.message
            : `Could not reach OpenStreetMap: ${(err as Error).message}`,
      })
    }
  },
  }
})

// Classify whatever area the last session left selected, so the panel and the overlay
// are right before anything is built.
useStore.getState().refreshBiome()

// Clear out anything left by an older query schema. Version bumps orphan entries rather
// than removing them, and each one holds every way in its box, so without this the store
// grows by a full copy of the data every time the shape of the query changes.
void roadCacheSweep().then((n) => {
  if (n > 0) console.info(`[groundwork] dropped ${n} stale OSM cache ${n === 1 ? 'entry' : 'entries'}`)
})

// Dev hook: drive the whole pipeline from the console without touching the UI.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__terrain = useStore
}
