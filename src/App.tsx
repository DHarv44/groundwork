import { useState } from 'react'
import MapPicker from './components/MapPicker'
import Controls from './components/Controls'
import Viewer from './components/Viewer'
import { useStore } from './store'

export default function App() {
  const build = useStore((s) => s.build)
  const phase = useStore((s) => s.phase)
  const message = useStore((s) => s.message)
  const [collapsed, setCollapsed] = useState(false)

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
        {!build && (
          <div className="empty">
            {phase === 'fetching' || phase === 'building' ? (
              <>
                <div className="spinner" />
                <p>{message || 'Working…'}</p>
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
