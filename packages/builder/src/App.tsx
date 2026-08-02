import { useEffect, useState } from 'react'
import MapPicker from './components/MapPicker'
import Controls from './components/Controls'
import Viewer from './components/Viewer'
import LayersPanel from './components/LayersPanel'
import { useStore } from './store'

export default function App() {
  const build = useStore((s) => s.build)
  const phase = useStore((s) => s.phase)
  const message = useStore((s) => s.message)
  const error = useStore((s) => s.error)
  const imagery = useStore((s) => s.imagery)
  const waterStats = useStore((s) => s.waterStats)
  const settings = useStore((s) => s.settings)
  const [collapsed, setCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)

  // The mesh lands first and the derived layers stream in behind it. A terrain with
  // its rivers still missing reads as a finished render that is simply wrong, so the
  // loading screen stays up until every layer the user has ticked has its data.
  // Ocean is not listed: it is a shader-side sea plane with nothing to fetch.
  const pending: string[] = []
  if (build && !error) {
    const needsWater =
      settings.showRivers || settings.showLakes || settings.textureMode === 'drainage'
    if (needsWater && !waterStats) pending.push('rivers and lakes')
    if (settings.textureMode === 'satellite' && !imagery) pending.push('satellite imagery')
  }
  const working = phase === 'fetching' || phase === 'building' || pending.length > 0

  // Rebuild whatever was on screen before the reload. The DEM is already in the
  // IndexedDB cache, so this costs no API call — and if it is not cached, generate()
  // falls back to fetching it exactly as a manual build would.
  useEffect(() => {
    const s = useStore.getState()
    if (s.bounds && !s.build && s.phase === 'idle') void s.generate()
    // Intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // `gw` is the scope every rule in styles.css hangs off. It has to be an element the
  // builder owns rather than the host's container, so that dropping this into another
  // app cannot restyle anything outside it.
  return (
    <div className="gw">
    <div
      className={`app ${collapsed ? 'collapsed' : ''} ${
        // rcollapsed also stands in for "no terrain yet" — the layers panel has
        // nothing to say before a build, so its column stays at zero.
        !build || rightCollapsed ? 'rcollapsed' : ''
      }`}
    >
      <aside className="sidebar">
        <header>
          <h1>Groundwork</h1>
          <p>Pick a place on Earth. Everything you see is derived from its ground.</p>
        </header>
        <MapPicker />
        <Controls />
        {/* Roads are listed separately from the basemap on purpose. The basemap is a
            picture we display; the roads are OSM *data* we redistribute in derived form,
            which is what ODbL actually attaches to. */}
        <footer>
          DEM © OpenTopography · imagery © Esri · basemap and roads ©{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            OpenStreetMap
          </a>{' '}
          contributors, ODbL
        </footer>
      </aside>

      <button
        className="collapse"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? 'Show panel' : 'Hide panel'}
      >
        {collapsed ? '›' : '‹'}
      </button>

      <main>
        <Viewer />
        {(!build || pending.length > 0) && (
          <div className={`empty ${build ? 'veil' : ''}`}>
            {working ? (
              <>
                <div className="spinner" />
                <p>{message || (pending.length ? `Loading ${pending.join(' and ')}…` : 'Working…')}</p>
              </>
            ) : (
              <>
                <h2>Pick a patch of the planet</h2>
                <p>
                  Drag a box on the map — or hit a preset — then build. The mesh is real ground
                  in real metres.
                </p>
              </>
            )}
          </div>
        )}
      </main>

      {/* The view's layer switchboard, docked opposite the build panel. */}
      {build && (
        <>
          <button
            className="rcollapse"
            onClick={() => setRightCollapsed((c) => !c)}
            title={rightCollapsed ? 'Show layers' : 'Hide layers'}
          >
            {rightCollapsed ? '‹' : '›'}
          </button>
          <aside className="layers-panel">
            <LayersPanel />
          </aside>
        </>
      )}
    </div>
    </div>
  )
}
