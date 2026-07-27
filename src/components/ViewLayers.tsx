import { useStore, type Settings, type TextureMode } from '../store'

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

/** Layer switcher overlaid on the 3D view, where the layers actually are. */
export default function ViewLayers() {
  const settings = useStore((s) => s.settings)
  const build = useStore((s) => s.build)
  const waterStats = useStore((s) => s.waterStats)
  const set = useStore((s) => s.set)
  const loadImagery = useStore((s) => s.loadImagery)

  if (!build) return null

  const setFlag = (k: OverlayDef['key']) => () =>
    set(k, !settings[k] as Settings[typeof k])

  return (
    <div className="view-layers">
      {BASES.map((l) => (
        <button
          key={l.id}
          className={settings.textureMode === l.id ? 'on' : ''}
          disabled={l.id === 'drainage' && !waterStats}
          title={l.id === 'drainage' && !waterStats ? 'Still tracing drainage…' : l.hint}
          onClick={() => {
            set('textureMode', l.id)
            if (l.id === 'satellite') void loadImagery()
          }}
        >
          <span className="glyph">{l.glyph}</span>
          {l.label}
        </button>
      ))}

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
      </div>

      {/* Overlays, each independent of the base and of each other. */}
      <div className="overlay-group">
        {OVERLAYS.map((o) => (
          <button
            key={o.key}
            className={`water ${settings[o.key] ? 'on' : ''}`}
            // Ocean comes from the sea plane and needs no hydrology pass; the other
            // two are derived, so they wait for the worker.
            disabled={o.key !== 'showOcean' && !waterStats}
            title={o.key !== 'showOcean' && !waterStats ? 'Still tracing drainage…' : o.hint}
            onClick={setFlag(o.key)}
          >
            <span className="glyph">{o.glyph}</span>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
