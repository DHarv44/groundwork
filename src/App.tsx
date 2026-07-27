import { useEffect, useState } from 'react'
import MapPicker from './components/MapPicker'
import Controls from './components/Controls'
import Viewer from './components/Viewer'
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

  return (
    <div className={`app ${collapsed ? 'collapsed' : ''}`}>
      <aside className="sidebar">
        <header>
          <h1>Terrain Builder</h1>
          <p>Real elevation data from OpenTopography, rendered in three.js.</p>
        </header>
        <MapPicker />
        <Controls />
        <footer>
          DEM © OpenTopography · basemap © OpenStreetMap · imagery © Esri
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
    </div>
  )
}
