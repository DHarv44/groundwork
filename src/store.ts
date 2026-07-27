import { create } from 'zustand'
import * as THREE from 'three'
import HydrologyWorker from './workers/hydrology.worker?worker'
import type { HydrologyResult } from './lib/hydrology'
import type { Bounds } from './lib/geo'
import { boundsAreaKm2, climaticSnowLine, climaticTreeLine } from './lib/geo'
import type { HeightField } from './lib/opentopo'
import { DEM_SOURCES, fetchHeightField, validateRequest } from './lib/opentopo'
import { fetchImagery } from './lib/imagery'
import { makeDemoHeightField } from './lib/demo'
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
  /** Overall visibility of inland water. */
  rivers: number
  /** Minimum drainage area a channel needs before it is drawn, 0..1 log scale. */
  riverThreshold: number
  shadows: boolean
  aoStrength: number
  microDetail: number
  water: boolean
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
  riverThreshold: 0.3,
  shadows: true,
  aoStrength: 0.85,
  microDetail: 0.6,
  water: true,
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
  waterStats: { rivers: number; lakes: number; maxDrainageKm2: number } | null
  settings: Settings
  /** Incremented whenever the viewer should re-frame the camera. */
  frameToken: number

  setBounds: (b: Bounds | null) => void
  setDemType: (id: string) => void
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  reset: () => void
  generate: () => Promise<void>
  generateDemo: () => Promise<void>
  loadImagery: () => Promise<void>
}

let inflight: AbortController | null = null

let hydroWorker: Worker | null = null

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
      },
      [copy.buffer],
    )
  })
}

function makeWaterTexture(result: HydrologyResult): THREE.DataTexture {
  const tex = new THREE.DataTexture(result.mask, result.width, result.height, THREE.RGBAFormat)
  tex.flipY = false
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}

export const useStore = create<State>((setState, getState) => {
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null

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
    runHydrology(heightField, build.widthMetres, build.depthMetres)
      .then((result) => {
        if (signal.aborted) return
        getState().waterMask?.dispose()
        setState({
          waterMask: makeWaterTexture(result),
          waterStats: {
            rivers: result.riverCells,
            lakes: result.lakeCells,
            maxDrainageKm2: result.maxDrainageKm2,
          },
        })
      })
      .catch((e) => console.warn('hydrology failed', e))
  }

  return {
  bounds: null,
  // Keyless and uncapped, so the app works out of the box and normal use never
  // eats into the OpenTopography allowance.
  demType: 'AWS_TERRARIUM',
  phase: 'idle',
  message: '',
  error: null,
  heightField: null,
  build: null,
  imagery: null,
  imageryZoom: 0,
  waterMask: null,
  waterStats: null,
  settings: { ...DEFAULT_SETTINGS },
  frameToken: 0,

  setBounds: (bounds) => setState({ bounds, error: null }),
  setDemType: (demType) => setState({ demType, error: null }),

  set: (key, value) => {
    const { settings } = getState()
    setState({ settings: { ...settings, [key]: value } })

    // Geometry-affecting settings need the mesh rebuilt from the cached DEM. Slider
    // drags fire on every pixel of travel, and a rebuild is hundreds of thousands of
    // vertices, so coalesce them instead of rebuilding per event.
    if (key === 'exaggeration' || key === 'detail') scheduleRebuild()
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
