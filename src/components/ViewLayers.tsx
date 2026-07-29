import { useStore, type Settings, type TextureMode } from '../store'
import type { AreaKind } from '../lib/overpass'

interface BaseDef {
  id: TextureMode
  glyph: string
  label: string
  hint: string
}

const BASES: BaseDef[] = [
  { id: 'procedural', glyph: '▲', label: 'Terrain', hint: 'Procedural ground cover' },
  { id: 'satellite', glyph: '◉', label: 'Satellite', hint: 'Esri World Imagery draped on the DEM' },
  { id: 'drainage', glyph: '⑂', label: 'Drainage', hint: 'Catchment network' },
]

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

/** Layer switcher overlaid on the 3D view, where the layers actually are. */
export default function ViewLayers() {
  const settings = useStore((s) => s.settings)
  const build = useStore((s) => s.build)
  const waterStats = useStore((s) => s.waterStats)
  const roadPhase = useStore((s) => s.roadPhase)
  const roadInfo = useStore((s) => s.roadInfo)
  const imageryLoading = useStore((s) => s.imageryLoading)
  const set = useStore((s) => s.set)
  const loadImagery = useStore((s) => s.loadImagery)
  const winter = useStore((s) => s.winter)
  const hazeScrub = useStore((s) => s.hazeScrub)
  const setWinter = useStore((s) => s.setWinter)
  const setHazeScrub = useStore((s) => s.setHazeScrub)

  if (!build) return null

  const setFlag = (k: OverlayDef['key']) => () =>
    set(k, !settings[k] as Settings[typeof k])

  /**
   * A layer's glyph, or a spinner while the data behind it is still arriving.
   *
   * Every layer here sits on something that streams in after the terrain does — the
   * hydrology worker, a tile fetch, an Overpass query — and without this a layer that
   * was not ready simply looked switched off. The spinner is the difference between
   * "there is no water here" and "the water has not been worked out yet", which are the
   * two readings these buttons exist to keep apart.
   */
  const glyph = (mark: string, pending: boolean) =>
    pending ? <i className="tiny-spin" /> : mark

  // The hydrology pass is what rivers, lakes and the drainage view all read.
  const waterPending = !waterStats

  return (
    <div className="view-layers">
      {BASES.map((l) => {
        const pending =
          (l.id === 'drainage' && waterPending) || (l.id === 'satellite' && imageryLoading)
        return (
          <button
            key={l.id}
            className={settings.textureMode === l.id ? 'on' : ''}
            title={
              l.id === 'drainage' && waterPending
                ? 'Still tracing drainage…'
                : l.id === 'satellite' && imageryLoading
                  ? 'Fetching imagery…'
                  : l.hint
            }
            onClick={() => {
              set('textureMode', l.id)
              if (l.id === 'satellite') void loadImagery()
            }}
          >
            <span className="glyph">{glyph(l.glyph, pending)}</span>
            {l.label}
          </button>
        )
      })}

      {/* Aerial perspective. Its own group because it is not a layer of the world but a
          property of the air in front of it — and because turning it off is how you see
          the ground's true colour, which the haze otherwise washes out badly on a wide
          box. */}
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

      {/* The two ground-cover layers. Hiding grass leaves the timber network standing
          alone on bare ground, which is the quickest way to check it against the
          drainage view — the trees are derived from the same field the rivers are. */}
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

      {/* Scrubs, not settings. These say how the place is being looked at, not what it
          is, so they live here rather than in the panel and are never saved — a preset
          made in January should not drag winter onto every tile it is applied to. */}
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
      </div>

      {/* The observed layers sit apart from the derived ones because they are not
          derived: this is surveyed data off the network, so the buttons have to show
          three states, not two. "Nothing here" is a real answer — deserts and open moor
          have no mapped anything — and it has to stay distinguishable from a fetch that
          fell over. All four come from one query, so they share a phase. */}
      <div className="overlay-group">
        {OSM_LAYERS.map((l) => (
          <button
            key={l.key}
            className={`road ${settings[l.key] && roadPhase === 'ready' ? 'on' : ''} ${
              roadPhase === 'error' ? 'failed' : ''
            }`}
            // Never disabled, including mid-fetch. These say whether you want the layer
            // drawn, which is answerable before the data lands — and an Overpass query
            // over a city can run for half a minute, so disabling them meant four dead
            // buttons for most of the wait.
            title={roadPhase === 'ready' ? l.hint : ROAD_HINT[roadPhase]}
            onClick={() => set(l.key, !settings[l.key])}
          >
            <span className="glyph">{glyph(l.glyph, roadPhase === 'loading')}</span>
            {l.label}
            {roadPhase === 'empty' && <em>none</em>}
            {roadPhase === 'error' && <em>failed</em>}
            {/* Zero rings is a fact about the place, not a failure — a moor really has
                no woodland polygons — so it is stated rather than left ambiguous. */}
            {roadPhase === 'ready' && l.kind && roadInfo?.areaCounts[l.kind] === 0 && (
              <em>none</em>
            )}
          </button>
        ))}
      </div>

      {/* Overlays, each independent of the base and of each other. */}
      <div className="overlay-group">
        {OVERLAYS.map((o) => {
          // Ocean comes from the sea plane and needs no hydrology pass; the other two
          // are derived, so they wait for the worker.
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
