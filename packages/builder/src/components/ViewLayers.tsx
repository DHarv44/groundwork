import { useStore, type TextureMode } from '../store'

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

/**
 * The base-ground switcher, floating on the 3D view. Only the three bases live
 * here — every other control moved to the docked layers panel on the right, so
 * the ground is not hidden behind its own switchboard.
 */
export default function ViewLayers() {
  const settings = useStore((s) => s.settings)
  const build = useStore((s) => s.build)
  const waterStats = useStore((s) => s.waterStats)
  const imageryLoading = useStore((s) => s.imageryLoading)
  const set = useStore((s) => s.set)
  const loadImagery = useStore((s) => s.loadImagery)

  if (!build) return null

  const glyph = (mark: string, pending: boolean) =>
    pending ? <i className="tiny-spin" /> : mark

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
    </div>
  )
}
