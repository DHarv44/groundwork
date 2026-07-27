import { useEffect, useMemo, useState } from 'react'
import { useStore, type BiomeKey, type Settings } from '../store'
import { KOPPEN_CODES, colorFor } from '../lib/koppen'
import { GROUND_WARMTH_MAX } from '../lib/biomeMap'
import { DAILY_QUOTA, cacheClear, cacheStats, quotaUsed } from '../lib/demcache'
import { deletePreset, loadPresets, savePreset } from '../lib/presets'
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
  decimals,
  tag,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  /** Override the readout precision, for steps finer than two decimal places. */
  decimals?: number
  /** Small chip after the label, marking where the value came from. */
  tag?: string
  onChange: (v: number) => void
}) {
  // Nudge by exactly one step, clamped, and rounded onto the step grid so repeated
  // presses cannot drift off it through floating-point error.
  const nudge = (dir: -1 | 1) => {
    const raw = value + dir * step
    const snapped = Math.round((raw - min) / step) * step + min
    onChange(Math.min(max, Math.max(min, parseFloat(snapped.toPrecision(12)))))
  }

  return (
    <div className="slider">
      <span className="slider-head">
        <span>
          {label}
          {tag && <span className="tag">{tag}</span>}
        </span>
        <b>
          {decimals !== undefined
            ? value.toFixed(decimals)
            : Number.isInteger(step)
              ? Math.round(value).toLocaleString()
              : value.toFixed(2)}
          {suffix ?? ''}
        </b>
      </span>
      <span className="slider-row">
        <button
          type="button"
          className="nudge"
          onClick={() => nudge(-1)}
          disabled={value <= min}
          aria-label={`${label} down`}
        >
          ‹
        </button>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
        />
        <button
          type="button"
          className="nudge"
          onClick={() => nudge(1)}
          disabled={value >= max}
          aria-label={`${label} up`}
        >
          ›
        </button>
      </span>
    </div>
  )
}

/** A titled block of controls that can be folded away. Open by default. */
function Group({
  title,
  badge,
  children,
}: {
  title: string
  badge?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button
        className={`subhead group-head ${open ? '' : 'closed'}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>
          <span className="chev">{open ? '▾' : '▸'}</span>
          {title}
        </span>
        {badge}
      </button>
      {open && children}
    </>
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

/** The dataset's own colour for a class, matching the mini-map overlay. */
function swatch(code: string): string {
  const [r, g, b] = colorFor(KOPPEN_CODES.indexOf(code as (typeof KOPPEN_CODES)[number]))
  return `rgb(${r} ${g} ${b})`
}

const DETAIL_STEPS = [256, 384, 512, 768, 1024, 1536, 2048]

type TabId = 'terrain' | 'surface' | 'water' | 'light' | 'render' | 'export'

const TABS: { id: TabId; label: string }[] = [
  { id: 'terrain', label: 'Terrain' },
  { id: 'surface', label: 'Surface' },
  { id: 'water', label: 'Water' },
  { id: 'light', label: 'Light' },
  { id: 'render', label: 'Render' },
  { id: 'export', label: 'Export' },
]

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
    resetSettings,
    applySettings,
    settingsSnapshot,
    biome,
    biomeKeys,
    biomeOverrides,
    biomeComposition,
    editingBiome,
    setEditingBiome,
    resetBiome,
  } = useStore()

  // The class the sliders act on: your pick, falling back to the dominant one.
  const editing =
    editingBiome && biomeComposition.some((c) => c.code === editingBiome)
      ? editingBiome
      : (biome?.code ?? '')
  const myValues = biomeOverrides[editing]
  const tuned = !!myValues && Object.keys(myValues).length > 0

  // Chip every climatic slider with where its value came from: the biome's built-in
  // profile, or your own saved value for this climate.
  const biomeTag = (k: BiomeKey) =>
    myValues && k in myValues ? 'yours' : biomeKeys.includes(k) ? 'biome' : undefined

  const [presets, setPresets] = useState(loadPresets)
  const [presetName, setPresetName] = useState('')
  const [showPresets, setShowPresets] = useState(false)
  // Name of the preset that just took an update, so the button can confirm it.
  const [justSaved, setJustSaved] = useState<string | null>(null)

  // What is actually loaded, which is not necessarily what the dropdown says.
  const isDemo = heightField?.demtype === 'DEMO'

  const [tab, setTab] = useState<TabId>('terrain')
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
        {showPresets && (
          <div className="presets-panel">
            <form
              className="search"
              onSubmit={(e) => {
                e.preventDefault()
                if (!presetName.trim()) return
                setPresets(savePreset(presetName, settingsSnapshot()))
                setPresetName('')
              }}
            >
              <input
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="Name this set…"
                spellCheck={false}
              />
              <button type="submit" disabled={!presetName.trim()}>
                Save
              </button>
            </form>
            {presets.length === 0 ? (
              <p className="note">
                Saves every slider and toggle under a name. Area, source and camera are
                not included, so a set can be applied to any terrain.
              </p>
            ) : (
              <ul className="preset-list">
                {presets.map((p) => (
                  <li key={p.name}>
                    <button className="preset-load" onClick={() => applySettings(p.settings)}>
                      {p.name}
                    </button>
                    <button
                      className="preset-upd"
                      title={`Overwrite “${p.name}” with the current settings`}
                      onClick={() => {
                        setPresets(savePreset(p.name, settingsSnapshot()))
                        setJustSaved(p.name)
                        window.setTimeout(() => setJustSaved(null), 1200)
                      }}
                    >
                      {justSaved === p.name ? '✓' : '⟳'}
                    </button>
                    <button
                      className="preset-del"
                      title="Delete"
                      onClick={() => setPresets(deletePreset(p.name))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

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
          <button onClick={resetSettings} title="Defaults for every slider and toggle">
            Reset settings
          </button>
          <button onClick={() => setShowPresets((v) => !v)} title="Save and recall setting sets">
            Presets{presets.length > 0 ? ` (${presets.length})` : ''}
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
        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'on' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'terrain' && (
          <section>
            <h3>Terrain</h3>
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
        )}

        {tab === 'surface' && (
          <section>
            <h3>Surface</h3>
            {/* The layer switcher itself lives on the 3D view.
                The cover controls stay on screen whatever base is showing: the whole
                point of the satellite drape is to tune the procedural ground against a
                photograph of the same place, which you cannot do if switching to the
                photograph takes the sliders away. */}
            {settings.textureMode === 'satellite' && (
              <p className="note">
                {imagery
                  ? `Esri World Imagery, zoom ${imageryZoom}. Relief lighting still comes from the DEM — the cover settings below keep working, so you can flip between the two and match them.`
                  : 'Loading imagery…'}
              </p>
            )}
            {settings.textureMode === 'drainage' && (
              <p className="note">
                Every cell coloured by the catchment area draining through it, over a dim
                hillshade. Brightness follows stream order, so trunk rivers dominate. Use
                “smallest stream” below to set where the network fades out.
              </p>
            )}
            <>
                {/* Where this patch of ground sits climatically, and what that set. */}
                <div className="biome">
                  {biome ? (
                    <>
                      <span className="biome-head">
                        <b>{biome.code}</b> {biome.name}
                        {tuned && (
                          <button
                            className="ghost"
                            onClick={resetBiome}
                            title={`Discard your ${editing} values and go back to the built-in profile`}
                          >
                            Reset {editing}
                          </button>
                        )}
                      </span>
                      {/* Everything in the box, not just the winner — the ground is
                          rendered as all of these, blended across the tile. */}
                      {biomeComposition.length > 1 && (
                        <span className="biome-mix">
                          {biomeComposition.map((c) => (
                            <button
                              key={c.code}
                              className={c.code === editing ? 'on' : ''}
                              title={`Point the sliders below at ${c.code}`}
                              onClick={() =>
                                setEditingBiome(c.code === biome.code ? null : c.code)
                              }
                            >
                              <i style={{ background: swatch(c.code) }} />
                              {c.code} {Math.round(c.share * 100)}%
                              {biomeOverrides[c.code] && <em>•</em>}
                            </button>
                          ))}
                        </span>
                      )}
                      <span className="biome-sub">
                        {biome.normals && (
                          <>
                            {biome.normals.meanTemp.toFixed(1)} °C ·{' '}
                            {Math.round(biome.normals.annualPrecip).toLocaleString()} mm/yr ·{' '}
                          </>
                        )}
                        Köppen–Geiger, Beck et al. (2023).{' '}
                        {biomeComposition.length > 1
                          ? `Blended across the tile. Pick a class above to aim the sliders — currently ${editing}${editing === biome.code ? ', the largest share' : ''}.`
                          : tuned
                            ? `Chips marked YOURS are saved against ${editing} and travel with presets.`
                            : 'Move any chipped slider and the value is kept for this climate.'}
                      </span>
                    </>
                  ) : (
                    <span className="biome-sub">
                      No land in the selected box — surface settings left as they are.
                    </span>
                  )}
                </div>
                <Slider
                  label="Snow line"
                  value={settings.snowLine}
                  min={lineMin}
                  max={lineMax}
                  step={10}
                  suffix=" m"
                  tag={biomeTag('snowLine')}
                  onChange={setSetting('snowLine')}
                />
                <Slider
                  label="Tree line"
                  value={settings.treeLine}
                  min={lineMin}
                  max={lineMax}
                  step={10}
                  suffix=" m"
                  tag={biomeTag('treeLine')}
                  onChange={setSetting('treeLine')}
                />
                <Slider
                  label="Aridity"
                  value={settings.aridity}
                  min={0}
                  max={1}
                  step={0.01}
                  tag={biomeTag('aridity')}
                  onChange={setSetting('aridity')}
                />
                <Slider
                  label="Tree cover"
                  value={settings.forest}
                  min={0}
                  max={1}
                  step={0.01}
                  tag={biomeTag('forest')}
                  onChange={setSetting('forest')}
                />
                <Slider
                  label="Leaf colour"
                  value={settings.vegTint}
                  min={-1}
                  max={1}
                  step={0.01}
                  tag={biomeTag('vegTint')}
                  onChange={setSetting('vegTint')}
                />
                <Slider
                  label="Leaf saturation"
                  value={settings.vegSat}
                  min={0}
                  max={2}
                  step={0.01}
                  tag={biomeTag('vegSat')}
                  onChange={setSetting('vegSat')}
                />
                <Slider
                  label="Rock strata"
                  value={settings.strata}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={setSetting('strata')}
                />
                <Slider
                  label="Ground warmth"
                  value={settings.groundWarmth}
                  min={0}
                  max={GROUND_WARMTH_MAX}
                  step={0.01}
                  tag={biomeTag('groundWarmth')}
                  onChange={setSetting('groundWarmth')}
                />
                <Slider
                  label="Riparian growth"
                  value={settings.riparian}
                  min={0}
                  max={1}
                  step={0.01}
                  tag={biomeTag('riparian')}
                  onChange={setSetting('riparian')}
                />
                <Slider
                  label="Corridor reach"
                  value={settings.riparianReach}
                  min={0.15}
                  max={0.6}
                  step={0.005}
                  decimals={3}
                  tag={biomeTag('riparianReach')}
                  onChange={setSetting('riparianReach')}
                />
            </>
            <Slider
              label="Micro relief"
              value={settings.microDetail}
              min={0}
              max={1}
              step={0.01}
              onChange={setSetting('microDetail')}
            />
            <Slider
              label="Texture range"
              value={settings.textureRange}
              min={0.1}
              max={20}
              step={0.1}
              suffix="×"
              decimals={1}
              onChange={setSetting('textureRange')}
            />
          </section>
        )}

        {tab === 'water' && (
          <section>
            <h3>Water</h3>
            <Group
              title="Rivers &amp; lakes"
              badge={
                waterStats ? (
                  <b>
                    {waterStats.lakes > 0 ? `${waterStats.lakes} lake cells · ` : ''}
                    {waterStats.maxDrainageKm2 >= 1
                      ? `${Math.round(waterStats.maxDrainageKm2).toLocaleString()} km² basin`
                      : 'no basins'}
                  </b>
                ) : (
                  <b className="pending">tracing drainage…</b>
                )
              }
            >
              <Slider
                label="Water visibility"
                value={settings.rivers}
                min={0}
                max={1}
                step={0.01}
                onChange={setSetting('rivers')}
              />
            </Group>

            <Group title="Ocean surface" badge={<b className="pending">live</b>}>
            <Slider
              label="Sea level"
              value={settings.seaLevel}
              min={-100}
              max={100}
              step={0.1}
              suffix=" m"
              decimals={1}
              onChange={setSetting('seaLevel')}
            />
            <Slider
              label="Foam width"
              value={settings.foamWidth}
              min={0}
              max={200}
              step={1}
              suffix=" m"
              onChange={setSetting('foamWidth')}
            />
            <Slider
              label="Shore cutoff"
              value={settings.shoreCutoff}
              min={-5}
              max={20}
              step={0.05}
              suffix=" m"
              decimals={2}
              onChange={setSetting('shoreCutoff')}
            />
            <Slider
              label="Shore feather"
              value={settings.shoreFeather}
              min={0}
              max={10}
              step={0.05}
              suffix=" m"
              decimals={2}
              onChange={setSetting('shoreFeather')}
            />
            <Slider
              label="Depth fade"
              value={settings.depthFade}
              min={2}
              max={200}
              step={1}
              suffix=" m"
              onChange={setSetting('depthFade')}
            />
            <Slider
              label="Wave height"
              value={settings.waveHeight}
              min={0}
              max={3}
              step={0.05}
              suffix="×"
              onChange={setSetting('waveHeight')}
            />
            <Slider
              label="Opacity"
              value={settings.waterOpacity}
              min={0}
              max={1}
              step={0.01}
              onChange={setSetting('waterOpacity')}
            />

            </Group>

            {/* Both grids feed lakes and rivers alike, so they sit on their own. */}
            <Group title="Grids" badge={<b className="pending">costly to change</b>}>
              <Slider
                label="Detection grid"
                value={settings.maskResolution}
                min={512}
                max={4096}
                step={256}
                suffix=" px"
                onChange={setSetting('maskResolution')}
              />
              <Slider
                label="Routing grid"
                value={settings.routingResolution}
                min={256}
                max={3072}
                step={256}
                suffix=" px"
                onChange={setSetting('routingResolution')}
              />
            </Group>

            <Group
              title="Lake detection"
              badge={<b className="pending">re-derives water only</b>}
            >
            <Slider
              label="Body tolerance"
              value={settings.flatTolerance}
              min={0}
              max={0.05}
              step={0.0005}
              suffix=" m"
              decimals={4}
              onChange={setSetting('flatTolerance')}
            />
            <Slider
              label="Body drift"
              value={settings.bodyDrift}
              min={1}
              max={100}
              step={0.5}
              suffix="×"
              onChange={setSetting('bodyDrift')}
            />
            <Slider
              label="Bank reach"
              value={settings.edgeTolerance}
              min={0}
              max={1.5}
              step={0.01}
              decimals={2}
              suffix=" m"
              onChange={setSetting('edgeTolerance')}
            />
            <Slider
              label="Shore feather"
              value={settings.featherCells}
              min={0}
              max={4}
              step={1}
              suffix=" px"
              onChange={setSetting('featherCells')}
            />
            <Slider
              label="Smallest lake"
              value={settings.minLakeArea / 10_000}
              min={0.1}
              max={40}
              step={1}
              suffix=" ha"
              onChange={(v) => set('minLakeArea', v * 10_000)}
            />
            <Slider
              label="Sea level margin"
              value={settings.seaLevelMargin}
              min={0}
              max={5}
              step={0.1}
              suffix=" m"
              onChange={setSetting('seaLevelMargin')}
            />

            </Group>

            <Group title="River detection">
            <Slider
              label="Smallest stream"
              value={settings.riverThreshold}
              // Log scale: 0.3 is a 1 km² catchment, 0.4 is 10 km², 0.5 is 100 km².
              // The old 0.75 ceiling meant ~30,000 km², which no single tile reaches,
              // so the top third of the slider gated everything out.
              min={0.1}
              max={0.6}
              step={0.005}
              decimals={3}
              onChange={setSetting('riverThreshold')}
            />
            <Slider
              label="Channel starts at"
              value={settings.minChannelKm2}
              min={0.01}
              max={5}
              step={0.01}
              suffix=" km²"
              decimals={2}
              onChange={setSetting('minChannelKm2')}
            />
            <Slider
              label="Channel feather"
              value={settings.riverFeather}
              min={0}
              max={4}
              step={1}
              suffix=" px"
              onChange={setSetting('riverFeather')}
            />
            <Slider
              label="Channel width"
              value={settings.riverWidthScale}
              min={0.2}
              max={3}
              step={0.05}
              suffix="×"
              onChange={setSetting('riverWidthScale')}
            />
            <Slider
              label="Width exponent"
              value={settings.riverWidthExponent}
              min={0.1}
              max={0.9}
              step={0.01}
              onChange={setSetting('riverWidthExponent')}
            />
            <Slider
              label="Minimum width"
              value={settings.riverMinWidthScale}
              min={0}
              max={4}
              step={0.05}
              suffix="×"
              onChange={setSetting('riverMinWidthScale')}
            />
            <Slider
              label="Slope narrowing"
              value={settings.riverSlopeNarrowing}
              min={0}
              max={30}
              step={0.5}
              onChange={setSetting('riverSlopeNarrowing')}
            />
            <Slider
              label="Flow convergence"
              value={settings.riverConvergence}
              min={0}
              max={25}
              step={0.5}
              onChange={setSetting('riverConvergence')}
            />
            </Group>
          </section>
        )}

        {tab === 'light' && (
          <section>
            <h3>Light &amp; air</h3>
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
        )}

        {tab === 'render' && (
          <section>
            <h3>Render</h3>
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
        )}

        {tab === 'export' && (
          <section>
            <h3>Export</h3>
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
        )}
        </>
      )}
    </div>
  )
}
