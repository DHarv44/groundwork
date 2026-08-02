import { useStore, type Settings } from '../store'
import type { AreaKind } from '../lib/overpass'

interface OverlayDef {
  key: 'showOcean' | 'showRivers' | 'showLakes'
  glyph: string
  label: string
  hint: string
}

const OVERLAYS: OverlayDef[] = [
  { key: 'showOcean', glyph: '≈', label: 'Ocean', hint: 'Sea surface, from the connected-ocean mask' },
  { key: 'showRivers', glyph: '⑂', label: 'Rivers', hint: 'Channels derived from flow accumulation' },
  { key: 'showLakes', glyph: '◍', label: 'Lakes', hint: 'Enclosed standing water' },
]

const ROAD_HINT: Record<string, string> = {
  idle: 'From OpenStreetMap — click to fetch',
  loading: 'Querying OpenStreetMap…',
  ready: 'From OpenStreetMap © contributors',
  empty: 'Nothing is mapped in this area',
  error: 'Could not reach OpenStreetMap — click to retry',
}

interface OsmLayerDef {
  key: 'showRoads' | 'showOsmWater' | 'showOsmWood' | 'showOsmBuilt'
  /** Which ring count reports on this layer. Roads are ways, so they have none. */
  kind?: AreaKind
  glyph: string
  label: string
  hint: string
}

const OSM_LAYERS: OsmLayerDef[] = [
  { key: 'showRoads', glyph: '╪', label: 'Roads', hint: 'Surveyed road network' },
  {
    key: 'showOsmWater',
    kind: 'water',
    glyph: '◉',
    label: 'Mapped water',
    hint: 'Surveyed lakes and reservoirs, over the derived guess',
  },
  {
    key: 'showOsmWood',
    kind: 'wood',
    glyph: '♠',
    label: 'Mapped wood',
    hint: 'Surveyed woodland, correcting the derived canopy',
  },
  {
    key: 'showOsmBuilt',
    kind: 'built',
    glyph: '▦',
    label: 'Built-up',
    hint: 'Residential, industrial and commercial land',
  },
]

/**
 * Everything about the view that is not the base ground: covers, scrubs,
 * observed layers, water overlays. Docked as a right-hand panel — the map
 * itself keeps only the three base buttons, so the ground stays visible
 * instead of hiding behind its own controls.
 */
export default function LayersPanel() {
  const settings = useStore((s) => s.settings)
  const build = useStore((s) => s.build)
  const waterStats = useStore((s) => s.waterStats)
  const roadPhase = useStore((s) => s.roadPhase)
  const roadInfo = useStore((s) => s.roadInfo)
  const set = useStore((s) => s.set)
  const winter = useStore((s) => s.winter)
  const hazeScrub = useStore((s) => s.hazeScrub)
  const setWinter = useStore((s) => s.setWinter)
  const setHazeScrub = useStore((s) => s.setHazeScrub)

  if (!build) return null

  const setFlag = (k: OverlayDef['key']) => () =>
    set(k, !settings[k] as Settings[typeof k])

  const glyph = (mark: string, pending: boolean) =>
    pending ? <i className="tiny-spin" /> : mark

  const waterPending = !waterStats

  return (
    <div className="view-layers docked">
      {/* Aerial perspective: a property of the air, not a layer of the world. */}
      <div className="overlay-group">
        <button
          className={`air ${settings.showFog ? 'on' : ''}`}
          title={
            settings.showFog
              ? 'Aerial perspective on — distance washes the ground toward the sky'
              : 'Aerial perspective off — ground shown at its true colour'
          }
          onClick={() => set('showFog', !settings.showFog)}
        >
          <span className="glyph">☁</span>
          Haze
        </button>
      </div>

      {/* Ground cover. Hiding grass leaves the timber network standing alone on
          bare ground — the quickest check against the drainage view. */}
      <div className="overlay-group">
        <button
          className={`cover ${settings.showTrees ? 'on' : ''}`}
          title="Timber, placed from the drainage field"
          onClick={() => set('showTrees', !settings.showTrees)}
        >
          <span className="glyph">♣</span>
          Trees
        </button>
        <button
          className={`cover ${settings.showGrass ? 'on' : ''}`}
          title="Everything the trees do not cover"
          onClick={() => set('showGrass', !settings.showGrass)}
        >
          <span className="glyph">▓</span>
          Grass
        </button>
        <button
          className={`cover ${settings.showSnow ? 'on' : ''}`}
          title="Snow above the snow line"
          onClick={() => set('showSnow', !settings.showSnow)}
        >
          <span className="glyph">❄</span>
          Snow
        </button>
      </div>

      {/* Winter and haze are scrubs — how the place is looked at, never saved.
          Satellite opacity IS a setting (it also lives in the Render tab) but
          is tuned while looking at the ground, so it sits with them. */}
      <div className="scrub-group">
        <label className="scrub">
          <span>
            Winter
            <b>{winter === 0 ? 'off' : `${Math.round(winter * 100)}%`}</b>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={winter}
            onChange={(e) => setWinter(parseFloat(e.target.value))}
          />
        </label>
        <label className="scrub">
          <span>
            Haze
            <b>{hazeScrub.toFixed(2)}×</b>
          </span>
          <input
            type="range"
            min={0}
            max={3}
            step={0.05}
            value={hazeScrub}
            onChange={(e) => setHazeScrub(parseFloat(e.target.value))}
            disabled={!settings.showFog}
          />
        </label>
        {settings.textureMode === 'satellite' && (
          <label className="scrub">
            <span>
              Satellite
              <b>{Math.round(settings.satOpacity * 100)}%</b>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={settings.satOpacity}
              onChange={(e) => set('satOpacity', parseFloat(e.target.value))}
            />
          </label>
        )}
      </div>

      {/* Observed layers: surveyed data off the network, so three states, not
          two — "nothing here" is a real answer and must stay distinguishable
          from a fetch that fell over. All four share one query's phase. */}
      <div className="overlay-group">
        {OSM_LAYERS.map((l) => (
          <button
            key={l.key}
            className={`road ${settings[l.key] && roadPhase === 'ready' ? 'on' : ''} ${
              roadPhase === 'error' ? 'failed' : ''
            }`}
            title={roadPhase === 'ready' ? l.hint : ROAD_HINT[roadPhase]}
            onClick={() => set(l.key, !settings[l.key])}
          >
            <span className="glyph">{glyph(l.glyph, roadPhase === 'loading')}</span>
            {l.label}
            {roadPhase === 'empty' && <em>none</em>}
            {roadPhase === 'error' && <em>failed</em>}
            {roadPhase === 'ready' && l.kind && roadInfo?.areaCounts[l.kind] === 0 && (
              <em>none</em>
            )}
          </button>
        ))}
      </div>

      {/* Water overlays, each independent of the base and of each other. */}
      <div className="overlay-group">
        {OVERLAYS.map((o) => {
          const pending = o.key !== 'showOcean' && waterPending
          return (
            <button
              key={o.key}
              className={`water ${settings[o.key] ? 'on' : ''}`}
              title={pending ? 'Still tracing drainage…' : o.hint}
              onClick={setFlag(o.key)}
            >
              <span className="glyph">{glyph(o.glyph, pending)}</span>
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
