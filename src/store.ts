import { create } from 'zustand'
import * as THREE from 'three'
import HydrologyWorker from './workers/hydrology.worker?worker'
import { DEFAULT_TUNING, type HydrologyResult, type HydrologyTuning } from './lib/hydrology'
import type { Bounds } from './lib/geo'
import { boundsAreaKm2, climaticSnowLine, climaticTreeLine } from './lib/geo'
import type { HeightField } from './lib/opentopo'
import { DEM_SOURCES, fetchHeightField, validateRequest } from './lib/opentopo'
import { fetchImagery } from './lib/imagery'
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
  textureRange: number
  /** Master opacity for derived water. */
  rivers: number
  /** Minimum drainage area a channel needs before it is drawn, 0..1 log scale. */
  riverThreshold: number
  /** Each derived water class toggles independently. */
  showOcean: boolean
  showRivers: boolean
  showLakes: boolean
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
  aridity: 0.25,
  strata: 0.25,
  riparian: 0.6,
  riparianReach: 0.34,
  groundWarmth: 0,
  forest: 0.6,
  vegTint: 0,
  vegSat: 1,
  textureRange: 1,
  rivers: 1,
  // 0.30 on the log-drainage scale is about 1 km² of catchment — roughly where a
  // channel actually starts in humid country.
  riverThreshold: 0.175,
  showOcean: true,
  showRivers: true,
  showLakes: true,
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
export const BIOME_KEYS = [
  'snowLine',
  'treeLine',
  'aridity',
  'riparian',
  'riparianReach',
  'groundWarmth',
  'forest',
  'vegTint',
  'vegSat',
] as const

export type BiomeKey = (typeof BIOME_KEYS)[number]

/**
 * The subset that is genuinely per-class, and so follows whichever biome you have
 * selected to edit. The rest are properties of the tile as a whole: one mountain range
 * has one tree line and one snow line however many climates cross it, and corridor
 * reach barely varies between classes at all.
 */
export const PER_CLASS_KEYS = ['aridity', 'riparian', 'groundWarmth', 'forest'] as const

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
  settings: Settings
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
  /** Overwrite the live settings from a saved snapshot. */
  applySettings: (patch: Record<string, unknown>) => void
  /** The persistable slice, for saving as a preset. */
  settingsSnapshot: () => Record<string, unknown>
  generate: () => Promise<void>
  generateDemo: () => Promise<void>
  loadImagery: () => Promise<void>
}

let inflight: AbortController | null = null

let hydroWorker: Worker | null = null

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
  'textureRange',
  'rivers',
  'riverThreshold',
  'showOcean',
  'showRivers',
  'showLakes',
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

  /**
   * Turn a biome into concrete settings: its built-in profile, then whatever you have
   * tuned for that class on top.
   *
   * Snow and tree lines start from the latitude curve and are scaled by the class, so
   * the biome corrects the altitude rather than replacing it — two places on the same
   * parallel can be a wet oceanic coast and a high desert, and only the class knows
   * which. An override, being an absolute height you chose, wins outright.
   */
  /** The class the sliders currently act on: whichever you picked, else the dominant. */
  function editingCode(dominant: string): string {
    const { editingBiome, biomeComposition } = getState()
    // A selection only survives while that class is still in the box.
    if (editingBiome && biomeComposition.some((c) => c.code === editingBiome)) return editingBiome
    return dominant
  }

  function biomeSettings(code: string, midLat: number): Record<BiomeKey, number> {
    // The per-class values follow the selected class; the tile-wide ones do not.
    const edit = editingCode(code)
    const p = profileFor(edit)
    const tile = profileFor(code)

    // Snow and tree lines belong to the place, not the cell. One mountain range has one
    // tree line, so they come from the highest any class present implies rather than
    // from the majority class — otherwise a box that is mostly steppe puts its tree
    // line at the plains' altitude and strips the forest off the range beside it. The
    // classes that are genuinely treeless are treeless for moisture or exposure, which
    // the aridity and elevation terms already handle.
    let snowScale = tile.snowLineScale
    let treeScale = tile.treeLineScale
    for (const c of getState().biomeComposition) {
      const q = profileFor(c.code)
      snowScale = Math.max(snowScale, q.snowLineScale)
      treeScale = Math.max(treeScale, q.treeLineScale)
    }

    const tileMine = getState().biomeOverrides[code] ?? {}
    const editMine = getState().biomeOverrides[edit] ?? {}

    return {
      // Tile-wide: from the dominant class and the composition, never the selection.
      //
      // Vegetation colour is here rather than per-class because it is resolved once for
      // the whole tile — there are no spare channels in the field to vary it per texel.
      // A box spanning two very different greens gets one compromise; that is the price
      // of not carrying a second texture, and it is a rarer case than the elevation
      // mixing the field already handles properly.
      snowLine: tileMine.snowLine ?? Math.round(climaticSnowLine(midLat) * snowScale),
      treeLine: tileMine.treeLine ?? Math.round(climaticTreeLine(midLat) * treeScale),
      riparianReach: tileMine.riparianReach ?? tile.riparianReach,
      vegTint: tileMine.vegTint ?? tile.vegTint,
      vegSat: tileMine.vegSat ?? tile.vegSat,
      // Per-class: whichever class the sliders are pointed at.
      aridity: editMine.aridity ?? p.aridity,
      riparian: editMine.riparian ?? p.riparian,
      groundWarmth: editMine.groundWarmth ?? p.groundWarmth,
      forest: editMine.forest ?? p.forest,
    }
  }

  function applyBiome(biome: Biome, midLat: number): void {
    const next: Settings = { ...getState().settings, ...biomeSettings(biome.code, midLat) }
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
  bounds: restored.bounds ?? null,
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
  waterMask: null,
  waterStats: null,
  settings: { ...DEFAULT_SETTINGS, ...(restored.settings as Partial<Settings>) },
  biome: null,
  biomeMap: null,
  biomeComposition: [],
  editingBiome: null,
  biomeOverrides: (restored.biomeOverrides as BiomeOverrides) ?? {},
  biomeKeys: [],
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
    const target = biome
      ? (PER_CLASS_KEYS as readonly string[]).includes(key)
        ? editingCode(biome.code)
        : biome.code
      : null
    const overrides =
      target && (BIOME_KEYS as readonly string[]).includes(key)
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

    const area = Math.round(boundsAreaKm2(bounds))
    setState({
      phase: 'fetching',
      error: null,
      build: null,
      heightField: null,
      imagery: null,
      imageryZoom: 0,
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

    setState({
      phase: 'building',
      error: null,
      build: null,
      heightField: null,
      imagery: null,
      imageryZoom: 0,
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
    const { heightField, imagery } = getState()
    if (!heightField || imagery) return
    try {
      setState({ message: 'Fetching satellite imagery…' })
      const result = await fetchImagery(heightField.bounds, (done, total) => {
        setState({ message: `Satellite tiles ${done}/${total}…` })
      })
      setState({ imagery: result.canvas, imageryZoom: result.zoom, message: '' })
    } catch {
      setState({ message: '', error: 'Satellite imagery unavailable for this area.' })
    }
  },
  }
})

// Classify whatever area the last session left selected, so the panel and the overlay
// are right before anything is built.
useStore.getState().refreshBiome()

// Dev hook: drive the whole pipeline from the console without touching the UI.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__terrain = useStore
}
