import { useEffect, useMemo, useState } from 'react'
import { useStore, type Settings } from '../store'
import { DAILY_QUOTA, cacheClear, cacheStats, quotaUsed } from '../lib/demcache'
import { DEM_SOURCES } from '../lib/opentopo'
import { boundsAreaKm2, boundsExtentMetres, formatBounds } from '../lib/geo'
import { captureScreenshot } from '../lib/capture'
import { exportGLB, exportHeightmapPNG, exportSTL } from '../lib/exporters'

function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  onChange: (v: number) => void
}) {
  return (
    <label className="slider">
      <span className="slider-head">
        <span>{label}</span>
        <b>
          {Number.isInteger(step) ? Math.round(value).toLocaleString() : value.toFixed(2)}
          {suffix ?? ''}
        </b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  )
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

const DETAIL_STEPS = [256, 384, 512, 768, 1024, 1536]

export default function Controls() {
  const {
    bounds,
    demType,
    setDemType,
    phase,
    message,
    error,
    settings,
    set,
    generate,
    reset,
    build,
    heightField,
    imagery,
    imageryZoom,
    waterStats,
    generateDemo,
  } = useStore()

  // What is actually loaded, which is not necessarily what the dropdown says.
  const isDemo = heightField?.demtype === 'DEMO'

  const [cache, setCache] = useState({ count: 0, megabytes: 0 })
  const [used, setUsed] = useState(0)

  // Refresh the budget readout whenever a build settles.
  useEffect(() => {
    setUsed(quotaUsed())
    void cacheStats().then(setCache)
  }, [phase])

  const source = DEM_SOURCES.find((s) => s.id === demType)!
  const busy = phase === 'fetching' || phase === 'building'

  const areaInfo = useMemo(() => {
    if (!bounds) return null
    const area = boundsAreaKm2(bounds)
    const extent = boundsExtentMetres(bounds)
    return {
      area,
      km: `${(extent.width / 1000).toFixed(1)} × ${(extent.height / 1000).toFixed(1)} km`,
      overLimit: area > source.maxAreaKm2,
      estSamples: Math.round((extent.width / source.resolution) * (extent.height / source.resolution)),
    }
  }, [bounds, source])

  const setSetting = <K extends keyof Settings>(k: K) => (v: Settings[K]) => set(k, v)

  const elevRange = build
    ? { min: Math.floor(build.minElevation), max: Math.ceil(build.maxElevation) }
    : { min: 0, max: 4000 }
  // The climatic snow/tree lines often sit well above a low-relief box, so widen the
  // sliders to include them — otherwise the thumb pins at the end and cannot be moved.
  const lineMin = Math.min(elevRange.min, settings.treeLine, settings.snowLine)
  const lineMax = Math.max(
    elevRange.max,
    settings.snowLine,
    settings.treeLine,
    elevRange.min + 100,
  )

  const baseName = bounds
    ? `terrain_${bounds.south.toFixed(3)}_${bounds.west.toFixed(3)}_${demType}`
    : 'terrain'

  return (
    <div className="controls">
      <section>
        <h3>1 · Elevation source</h3>
        <select value={demType} onChange={(e) => setDemType(e.target.value)}>
          {DEM_SOURCES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label} — {s.resolution} m
            </option>
          ))}
        </select>
        {/* The dropdown shows what the next build will request, which is not what is
            on screen while synthetic terrain is loaded. Say so explicitly. */}
        <p className="note">
          {isDemo ? 'Not in use — the terrain on screen is synthetic.' : source.note}
        </p>
      </section>

      <section>
        <h3>2 · Area</h3>
        {isDemo ? (
          <div className="synthetic">
            <b>Synthetic terrain</b>
            <span>
              Procedurally generated, not a real place — the coordinates below are only
              a stand-in so the latitude-driven snow and tree lines behave. Note it has
              never been eroded, so it has no incised river beds for drainage to follow.
            </span>
          </div>
        ) : null}
        {bounds && !isDemo ? (
          <>
            <div className="coords">{formatBounds(bounds)}</div>
            {areaInfo && (
              <div className="metrics">
                <span>{areaInfo.km}</span>
                <span className={areaInfo.overLimit ? 'bad' : ''}>
                  {Math.round(areaInfo.area).toLocaleString()} km²
                </span>
                <span>~{(areaInfo.estSamples / 1e6).toFixed(1)} M samples</span>
              </div>
            )}
          </>
        ) : (
          <p className="note">Drag a box on the map, pick a preset, or search for a place.</p>
        )}
        <div className="row">
          <button className="primary" disabled={!bounds || busy} onClick={() => void generate()}>
            {busy ? 'Working…' : build ? 'Rebuild terrain' : 'Build terrain'}
          </button>
          {build && (
            <button onClick={reset} disabled={busy}>
              Clear
            </button>
          )}
        </div>
        <div className="quota">
          <span className={used >= DAILY_QUOTA ? 'bad' : ''}>
            {used}/{DAILY_QUOTA} API calls today
          </span>
          <span>
            {cache.count} area{cache.count === 1 ? '' : 's'} cached
            {cache.count > 0 ? ` · ${cache.megabytes.toFixed(1)} MB` : ''}
          </span>
        </div>
        <div className="row">
          <button disabled={busy} onClick={() => void generateDemo()} title="No API call">
            Demo terrain
          </button>
          {cache.count > 0 && (
            <button
              onClick={() => void cacheClear().then(() => setCache({ count: 0, megabytes: 0 }))}
            >
              Clear cache
            </button>
          )}
        </div>
        {message && <div className="status">{message}</div>}
        {error && <div className="error">{error}</div>}
      </section>

      {build && (
        <>
          <section>
            <h3>3 · Terrain</h3>
            <div className="metrics wide">
              <span>
                {Math.round(build.minElevation).toLocaleString()} –{' '}
                {Math.round(build.maxElevation).toLocaleString()} m
              </span>
              <span>{(build.triangles / 1000).toFixed(0)}k tris</span>
              <span>
                {build.gridX}×{build.gridY} grid
              </span>
              {heightField && heightField.voids > 0 && (
                <span title="Nodata cells filled by interpolation">
                  {heightField.voids.toLocaleString()} voids filled
                </span>
              )}
            </div>
            <Slider
              label="Vertical exaggeration"
              value={settings.exaggeration}
              min={0.5}
              max={5}
              step={0.05}
              suffix="×"
              onChange={setSetting('exaggeration')}
            />
            <label className="slider">
              <span className="slider-head">
                <span>Mesh detail</span>
                <b>{settings.detail}</b>
              </span>
              <input
                type="range"
                min={0}
                max={DETAIL_STEPS.length - 1}
                step={1}
                value={Math.max(0, DETAIL_STEPS.indexOf(settings.detail))}
                onChange={(e) => set('detail', DETAIL_STEPS[parseInt(e.target.value, 10)])}
              />
            </label>
          </section>

          <section>
            <h3>4 · Surface</h3>
            {/* The layer switcher itself lives on the 3D view. */}
            {settings.textureMode === 'satellite' ? (
              <p className="note">
                {imagery
                  ? `Esri World Imagery, zoom ${imageryZoom}. Relief lighting still comes from the DEM.`
                  : 'Loading imagery…'}
              </p>
            ) : settings.textureMode === 'drainage' ? (
              <p className="note">
                Every cell coloured by the catchment area draining through it, over a dim
                hillshade. Brightness follows stream order, so trunk rivers dominate. Use
                “smallest stream” below to set where the network fades out.
              </p>
            ) : (
              <>
                <Slider
                  label="Snow line"
                  value={settings.snowLine}
                  min={lineMin}
                  max={lineMax}
                  step={10}
                  suffix=" m"
                  onChange={setSetting('snowLine')}
                />
                <Slider
                  label="Tree line"
                  value={settings.treeLine}
                  min={lineMin}
                  max={lineMax}
                  step={10}
                  suffix=" m"
                  onChange={setSetting('treeLine')}
                />
                <Slider
                  label="Aridity"
                  value={settings.aridity}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={setSetting('aridity')}
                />
                <Slider
                  label="Rock strata"
                  value={settings.strata}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={setSetting('strata')}
                />
              </>
            )}
            <div className="subhead">
              <span>Rivers &amp; lakes</span>
              {waterStats ? (
                <b>
                  {waterStats.lakes > 0 ? `${waterStats.lakes} lake cells · ` : ''}
                  {waterStats.maxDrainageKm2 >= 1
                    ? `${Math.round(waterStats.maxDrainageKm2).toLocaleString()} km² basin`
                    : 'no basins'}
                </b>
              ) : (
                <b className="pending">tracing drainage…</b>
              )}
            </div>
            <Slider
              label="Water visibility"
              value={settings.rivers}
              min={0}
              max={1}
              step={0.01}
              onChange={setSetting('rivers')}
            />
            <Slider
              label="Smallest stream"
              value={settings.riverThreshold}
              min={0.2}
              max={0.75}
              step={0.005}
              onChange={setSetting('riverThreshold')}
            />
            <Slider
              label="Micro relief"
              value={settings.microDetail}
              min={0}
              max={1}
              step={0.01}
              onChange={setSetting('microDetail')}
            />
          </section>

          <section>
            <h3>5 · Light & air</h3>
            <Slider
              label="Sun azimuth"
              value={settings.sunAzimuth}
              min={0}
              max={360}
              step={1}
              suffix="°"
              onChange={setSetting('sunAzimuth')}
            />
            <Slider
              label="Sun elevation"
              value={settings.sunElevation}
              min={-4}
              max={85}
              step={0.5}
              suffix="°"
              onChange={setSetting('sunElevation')}
            />
            <Slider
              label="Haze"
              value={settings.haze}
              min={0}
              max={1}
              step={0.01}
              onChange={setSetting('haze')}
            />
          </section>

          <section>
            <h3>6 · Render</h3>
            <Slider
              label="Ambient occlusion"
              value={settings.aoStrength}
              min={0}
              max={1.5}
              step={0.01}
              onChange={setSetting('aoStrength')}
            />
            <div className="toggles">
              <Toggle
                label="Cast shadows"
                value={settings.shadows}
                onChange={setSetting('shadows')}
              />
              {/* Ocean, rivers and lakes toggle from the layer panel on the view. */}
              <Toggle label="Wireframe" value={settings.wireframe} onChange={setSetting('wireframe')} />
            </div>
          </section>

          <section>
            <h3>7 · Export</h3>
            <div className="grid2">
              <button onClick={() => captureScreenshot(`${baseName}.png`)}>Screenshot</button>
              <button onClick={() => heightField && exportHeightmapPNG(heightField, baseName)}>
                Heightmap
              </button>
              <button onClick={() => exportSTL(build, baseName)}>STL mesh</button>
              <button onClick={() => exportGLB(build, baseName)}>glTF mesh</button>
            </div>
            <p className="note">
              Meshes are in metres, 1 : 1 with the ground at exaggeration 1×. Heightmap PNG packs
              16-bit elevation across the red and green channels.
            </p>
          </section>
        </>
      )}
    </div>
  )
}
