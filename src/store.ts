import { create } from 'zustand'
import * as THREE from 'three'
import HydrologyWorker from './workers/hydrology.worker?worker'
import { DEFAULT_TUNING, type HydrologyResult, type HydrologyTuning } from './lib/hydrology'
import type { Bounds } from './lib/geo'
import { boundsAreaKm2, climaticSnowLine, climaticTreeLine } from './lib/geo'
import type { HeightField } from './lib/opentopo'
import { DEM_SOURCES, fetchHeightField, validateRequest } from './lib/opentopo'
import { fetchImagery } from './lib/imagery'
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
  depthFade: number
  waveHeight: number
  foamWidth: number
  waterOpacity: number
  /** Hydrology knobs. Changing one re-runs the water pass, not the DEM fetch. */
  flatTolerance: number
  bodyDrift: number
  maskResolution: number
  seaLevelMargin: number
  edgeTolerance: number
  featherCells: number
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
  rivers: 1,
  // 0.30 on the log-drainage scale is about 1 km² of catchment — roughly where a
  // channel actually starts in humid country.
  riverThreshold: 0.41,
  showOcean: true,
  showRivers: true,
  showLakes: true,
  seaLevel: 0,
  shoreCutoff: 0.25,
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
  /** Incremented whenever the viewer should re-frame the camera. */
  frameToken: number

  setBounds: (b: Bounds | null) => void
  setDemType: (id: string) => void
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  reset: () => void
  resetSettings: () => void
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
  'rivers',
  'riverThreshold',
  'showOcean',
  'showRivers',
  'showLakes',
  'seaLevel',
  'shoreCutoff',
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
  'seaLevelMargin',
  'edgeTolerance',
  'featherCells',
  'minLakeArea',
  'minChannelKm2',
  'riverWidthScale',
  'riverWidthExponent',
  'riverSlopeNarrowing',
  'riverMinWidthScale',
  'riverConvergence',
] as const

function persistSettings(settings: Settings): void {
  const slice: Record<string, unknown> = {}
  for (const k of PERSISTED_SETTINGS) slice[k] = settings[k]
  saveSession({ settings: slice })
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
      seaLevelMargin: s.seaLevelMargin,
      edgeTolerance: s.edgeTolerance,
      featherCells: s.featherCells,
      minLakeArea: s.minLakeArea,
      minChannelKm2: s.minChannelKm2,
      riverWidthScale: s.riverWidthScale,
      riverWidthExponent: s.riverWidthExponent,
      riverSlopeNarrowing: s.riverSlopeNarrowing,
      riverMinWidthScale: s.riverMinWidthScale,
      riverConvergence: s.riverConvergence,
    }
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

    // Terrain is already on screen; rivers and lakes stream in behind it.
    runHydrology(heightField, build.widthMetres, build.depthMetres, tuningOf(settings))
      .then((result) => {
        if (signal.aborted) return
        applyWater(result)
      })
      .catch((e) => console.warn('hydrology failed', e))
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
  frameToken: 0,

  setBounds: (bounds) => {
    setState({ bounds, error: null })
    saveSession({ bounds })
  },
  setDemType: (demType) => {
    setState({ demType, error: null })
    saveSession({ demType })
  },

  set: (key, value) => {
    const { settings } = getState()
    const next = { ...settings, [key]: value }
    setState({ settings: next })
    persistSettings(next)

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
  resetSettings: () => {
    const { settings } = getState()
    const next: Settings = {
      ...DEFAULT_SETTINGS,
      snowLine: settings.snowLine,
      treeLine: settings.treeLine,
    }
    setState({ settings: next })
    persistSettings(next)
    scheduleWater()
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

// Dev hook: drive the whole pipeline from the console without touching the UI.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__terrain = useStore
}
