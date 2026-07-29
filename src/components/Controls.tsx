import { useEffect, useMemo, useState } from 'react'
import { DEFAULT_SETTINGS, useStore, type BiomeKey, type Settings } from '../store'
import { KOPPEN_CODES, colorFor } from '../lib/koppen'
import { FOREST_MAX, GROUND_WARMTH_MAX } from '../lib/biomeMap'
import { DAILY_QUOTA, cacheClear, cacheStats, quotaUsed } from '../lib/demcache'
import { decodePreset, deletePreset, encodePreset, loadPresets, savePreset } from '../lib/presets'
import { DEM_SOURCES } from '../lib/opentopo'
import { AREA_LABEL, ROAD_CLASSES, ROAD_DETAIL_LABEL } from '../lib/overpass'
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

/** Road mask sizes. Above 4096 the texture costs more than the roads are worth. */
const ROAD_RES_STEPS = [1024, 1536, 2048, 3072, 4096]

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
    roadPhase,
    roadError,
    roadInfo,
    loadRoads,
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
  const [pasteText, setPasteText] = useState('')
  const [pasteNote, setPasteNote] = useState('')
  // Name of the preset just copied, so its button can confirm it.
  const [justCopied, setJustCopied] = useState<string | null>(null)

  const copyPreset = (name: string, settings: Record<string, unknown>) => {
    void navigator.clipboard
      .writeText(encodePreset(name, settings))
      .then(() => {
        setJustCopied(name)
        window.setTimeout(() => setJustCopied(null), 1200)
      })
      .catch(() => setPasteNote('Clipboard blocked by the browser.'))
  }

  const applyPasted = () => {
    const result = decodePreset(pasteText, DEFAULT_SETTINGS as unknown as Record<string, unknown>)
    if (result.error || !result.preset) {
      setPasteNote(result.error ?? 'Could not read that.')
      return
    }
    applySettings(result.preset.settings)
    setPresets(savePreset(result.preset.name, result.preset.settings))
    setPasteText('')
    const n = Object.keys(result.preset.settings).length
    setPasteNote(
      `Applied and saved as “${result.preset.name}” — ${n} setting${n === 1 ? '' : 's'}` +
        (result.ignored ? `, ${result.ignored.length} unrecognised and ignored.` : '.'),
    )
  }

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
                      className="preset-upd"
                      title={`Copy “${p.name}” to the clipboard as text`}
                      onClick={() => copyPreset(p.name, p.settings)}
                    >
                      {justCopied === p.name ? '✓' : '⧉'}
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

            {/* Copy and paste, so a set can leave this browser: into a message, a file,
                or another machine. Pasted text is untrusted and gets filtered against
                the known settings before anything is applied. */}
            <div className="preset-io">
              <button
                className="preset-copy"
                onClick={() => copyPreset(presetName.trim() || 'Current', settingsSnapshot())}
              >
                {justCopied === (presetName.trim() || 'Current') ? '✓ Copied' : '⧉ Copy current'}
              </button>
              <textarea
                value={pasteText}
                onChange={(e) => {
                  setPasteText(e.target.value)
                  setPasteNote('')
                }}
                placeholder="…or paste a set here"
                spellCheck={false}
                rows={2}
              />
              <button className="preset-paste" disabled={!pasteText.trim()} onClick={applyPasted}>
                Apply pasted
              </button>
              {pasteNote && <p className="note">{pasteNote}</p>}
            </div>
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
                {/* Altitude, not ecology. Where the air runs out is set by lapse rate and
                    the thinning of the atmosphere, so these belong to the tile rather
                    than to any biome in it — kept above the biome block, and outside it,
                    so it is obvious they are not part of the per-class table. */}
                <Group title="Altitude limits">
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
                  <p className="note">
                    Global for the tile. Derived from latitude, corrected for how
                    continental the classes present are, then yours to override.
                  </p>
                </Group>

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
                {/* Where the timber is. Both thresholds are catchment areas in km², the
                    same units as the rivers' own minChannelKm2, so the two can be set
                    against each other directly. */}
                <Group
                  title="Trees"
                  badge={<span className="grp-note">km² of catchment</span>}
                >
                  {/* Down to a thousandth of a km² — a hectare of catchment. The dissected
                      ground beside a channel is fed by gullies that small, and that is
                      where the timber actually is, so a floor of 0.02 put the whole
                      useful range off the bottom of the slider. */}
                  <Slider
                    label="Smallest wooded catchment"
                    value={settings.treeNeed}
                    min={0.001}
                    max={5}
                    step={0.001}
                    suffix=" km²"
                    decimals={3}
                    tag={biomeTag('treeNeed')}
                    onChange={setSetting('treeNeed')}
                  />
                  <Slider
                    label="Largest wooded catchment"
                    value={settings.treeLimit}
                    min={1}
                    max={5000}
                    step={5}
                    suffix=" km²"
                    tag={biomeTag('treeLimit')}
                    onChange={setSetting('treeLimit')}
                  />
                  <Slider
                    label="Prefers broken ground"
                    value={settings.treeRough}
                    min={0}
                    max={1}
                    step={0.01}
                    tag={biomeTag('treeRough')}
                    onChange={setSetting('treeRough')}
                  />
                  <Slider
                    label="Broken at"
                    value={settings.treeRoughScale}
                    min={5}
                    max={400}
                    step={5}
                    suffix=" m"
                    tag={biomeTag('treeRoughScale')}
                    onChange={setSetting('treeRoughScale')}
                  />
                  <Slider
                    label="Fractal spread"
                    value={settings.treeFractal}
                    min={0}
                    max={1}
                    step={0.01}
                    tag={biomeTag('treeFractal')}
                    onChange={setSetting('treeFractal')}
                  />
                  <Slider
                    label="Tree edge"
                    value={settings.treeSpread}
                    min={0.01}
                    max={0.6}
                    step={0.005}
                    decimals={3}
                    tag={biomeTag('treeSpread')}
                    onChange={setSetting('treeSpread')}
                  />
                  <Slider
                    label="Tree cover"
                    value={settings.forest}
                    min={0}
                    max={FOREST_MAX}
                    step={0.005}
                    decimals={3}
                    tag={biomeTag('forest')}
                    onChange={setSetting('forest')}
                  />
                </Group>

                {/* The ribbon of growth along the drainage, and what species it is. */}
                <Group title="Riparian">
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
                  <Slider
                    label="Corridor leaf"
                    value={settings.corridorLeaf}
                    min={0}
                    max={1}
                    step={0.01}
                    tag={biomeTag('corridorLeaf')}
                    onChange={setSetting('corridorLeaf')}
                  />
                </Group>

                {/* What colour the cover is, as opposed to where it is. */}
                <Group title="Cover colour">
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
                </Group>

                {/* Bare ground: what shows where nothing is growing. */}
                <Group title="Bare ground">
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
                    label="Rock strata"
                    value={settings.strata}
                    min={0}
                    max={1}
                    step={0.01}
                    tag={biomeTag('strata')}
                    onChange={setSetting('strata')}
                  />
                </Group>
            </>

            {/* Neither climate nor place: how much detail survives at distance. These are
                the only two on this tab that are not biome-owned. */}
            <Group title="Detail">
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
            </Group>

            {/* The measured layers. The badge reports what came back rather than what
                was computed, because with observed data those are different questions. */}
            <Group
              title="From OpenStreetMap"
              badge={
                roadPhase === 'loading' ? (
                  <b className="pending">querying OSM…</b>
                ) : roadInfo && roadPhase === 'ready' ? (
                  <b>{Math.round(roadInfo.lengthKm).toLocaleString()} km</b>
                ) : roadPhase === 'empty' ? (
                  <b className="pending">none mapped</b>
                ) : roadPhase === 'error' ? (
                  <b className="pending">unavailable</b>
                ) : (
                  <b className="pending">not fetched</b>
                )
              }
            >
              {/* What to ask for, above what to do with it. Both of these decide how
                  long the fetch takes and whether it succeeds at all, which makes them
                  the first thing worth reaching for on a wide box. */}
              <label className="field">
                <span>Road detail</span>
                <select
                  value={settings.roadDetail}
                  onChange={(e) => set('roadDetail', e.target.value as Settings['roadDetail'])}
                >
                  {(Object.keys(ROAD_DETAIL_LABEL) as Array<keyof typeof ROAD_DETAIL_LABEL>).map(
                    (k) => (
                      <option key={k} value={k}>
                        {ROAD_DETAIL_LABEL[k]}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <Toggle
                label="Fetch water, woodland and land use"
                value={settings.fetchAreas}
                onChange={(v) => set('fetchAreas', v)}
              />

              {roadPhase === 'idle' && (
                <button className="wide" onClick={() => void loadRoads()}>
                  Fetch map features for this area
                </button>
              )}
              {roadPhase === 'error' && (
                <>
                  <div className="error">{roadError}</div>
                  <button className="wide" onClick={() => void loadRoads()}>
                    Try again
                  </button>
                </>
              )}

              {roadInfo && roadPhase === 'ready' && (
                <>
                  <div className="metrics wide">
                    {roadInfo.byClass.map((c) => (
                      <span key={c.cls} title={ROAD_CLASSES[c.cls].label}>
                        {ROAD_CLASSES[c.cls].label} {Math.round(c.km).toLocaleString()} km
                      </span>
                    ))}
                    <span title="Ground metres per pixel of the road mask">
                      {roadInfo.metresPerPixel.toFixed(1)} m/px
                    </span>
                    <span title="Rasterised in a worker, so this is cost rather than stutter">
                      {roadInfo.drawMs} ms draw
                    </span>
                    {(['water', 'wood', 'built'] as const).map((k) => (
                      <span key={k} title={`${AREA_LABEL[k]} polygons found`}>
                        {AREA_LABEL[k]} {roadInfo.areaCounts[k].toLocaleString()}
                      </span>
                    ))}
                  </div>
                  {/* Both of these are places the render is knowingly not telling the
                      truth, so they are stated rather than left to be discovered. */}
                  {roadInfo.filtered && (
                    <div className="status">
                      Minor roads and tracks were not requested — at this size they are
                      narrower than one mask pixel.
                    </div>
                  )}
                  {roadInfo.widened.length > 0 && (
                    <div className="status">
                      Drawn wider than life to stay visible:{' '}
                      {roadInfo.widened.map((c) => ROAD_CLASSES[c].label.toLowerCase()).join(', ')}.
                    </div>
                  )}
                </>
              )}

              {/* Goes below 1 now that the visibility floor scales with it, so this can
                  thin the network down as well as fatten it. */}
              <Slider
                label="Road width"
                value={settings.roadWidth}
                min={0.1}
                max={12}
                step={0.05}
                suffix="×"
                decimals={2}
                onChange={setSetting('roadWidth')}
              />
              <Slider
                label="Cleared verge"
                value={settings.roadVerge}
                min={0}
                max={12}
                step={0.1}
                suffix="× width"
                decimals={1}
                onChange={setSetting('roadVerge')}
              />
              <Slider
                label="Clearing strength"
                value={settings.roadClearing}
                min={0}
                max={1}
                step={0.01}
                tag={biomeTag('roadClearing')}
                onChange={setSetting('roadClearing')}
              />
              <Slider
                label="Unsealed"
                value={settings.roadTint}
                min={0}
                max={1}
                step={0.01}
                tag={biomeTag('roadTint')}
                onChange={setSetting('roadTint')}
              />
              <Slider
                label="Surface darkness"
                value={settings.roadDarkness}
                min={0}
                max={1}
                step={0.01}
                onChange={setSetting('roadDarkness')}
              />
              <label className="slider">
                <span className="slider-head">
                  <span>Mask resolution</span>
                  <b>{settings.roadResolution}</b>
                </span>
                <input
                  type="range"
                  min={0}
                  max={ROAD_RES_STEPS.length - 1}
                  step={1}
                  value={Math.max(0, ROAD_RES_STEPS.indexOf(settings.roadResolution))}
                  onChange={(e) =>
                    set('roadResolution', ROAD_RES_STEPS[parseInt(e.target.value, 10)])
                  }
                />
              </label>

              {/* How much each observed layer is allowed to override what was derived.
                  Water at full strength because a surveyed shoreline is simply better
                  evidence than a depression fill; woodland lower, because it is a
                  correction to a model that knows things the polygon does not. */}
              <Slider
                label="Mapped water"
                value={settings.osmWaterStrength}
                min={0}
                max={1}
                step={0.01}
                onChange={setSetting('osmWaterStrength')}
              />
              <Slider
                label="Mapped woodland"
                value={settings.osmWoodStrength}
                min={0}
                max={1}
                step={0.01}
                onChange={setSetting('osmWoodStrength')}
              />
              <Slider
                label="Built-up ground"
                value={settings.osmBuiltStrength}
                min={0}
                max={1}
                step={0.01}
                onChange={setSetting('osmBuiltStrength')}
              />
            </Group>
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
