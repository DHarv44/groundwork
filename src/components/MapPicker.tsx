import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import { MapContainer, Rectangle, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import type { Bounds } from '../lib/geo'
import { useStore } from '../store'

export interface Preset {
  name: string
  bounds: Bounds
}

export const PRESETS: Preset[] = [
  { name: 'Everest & Khumbu', bounds: { south: 27.85, north: 28.05, west: 86.85, east: 87.05 } },
  { name: 'Grand Canyon', bounds: { south: 36.0, north: 36.3, west: -112.3, east: -111.9 } },
  { name: 'Yosemite Valley', bounds: { south: 37.68, north: 37.79, west: -119.68, east: -119.5 } },
  { name: 'Matterhorn', bounds: { south: 45.95, north: 46.05, west: 7.6, east: 7.72 } },
  { name: 'Jungfrau & Eiger', bounds: { south: 46.5, north: 46.63, west: 7.9, east: 8.05 } },
  { name: 'Torres del Paine', bounds: { south: -51.1, north: -50.9, west: -73.15, east: -72.85 } },
  { name: 'Landmannalaugar', bounds: { south: 63.9, north: 64.05, west: -19.2, east: -18.9 } },
  { name: 'Geirangerfjord', bounds: { south: 62.05, north: 62.2, west: 6.95, east: 7.3 } },
  { name: 'Mount Fuji', bounds: { south: 35.3, north: 35.45, west: 138.65, east: 138.83 } },
  { name: 'Death Valley', bounds: { south: 36.2, north: 36.55, west: -117.2, east: -116.75 } },
  { name: 'Monument Valley', bounds: { south: 36.94, north: 37.06, west: -110.16, east: -110.0 } },
  { name: 'Bryce Canyon', bounds: { south: 37.55, north: 37.68, west: -112.25, east: -112.1 } },
  { name: 'Cuillin, Skye', bounds: { south: 57.15, north: 57.3, west: -6.3, east: -6.05 } },
  { name: 'Table Mountain', bounds: { south: -34.03, north: -33.9, west: 18.33, east: 18.48 } },
  { name: 'Mauna Kea & Hilo', bounds: { south: 19.6, north: 19.95, west: -155.6, east: -155.0 } },
]

interface BaseLayer {
  id: string
  label: string
  url: string
  attribution: string
  maxZoom: number
}

const BASE_LAYERS: BaseLayer[] = [
  {
    id: 'map',
    label: 'Map',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19,
  },
  {
    id: 'satellite',
    label: 'Satellite',
    // Esri serves z/y/x; Leaflet substitutes the placeholders wherever they appear.
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery &copy; Esri',
    maxZoom: 19,
  },
  {
    id: 'terrain',
    label: 'Relief',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenTopoMap (CC-BY-SA)',
    maxZoom: 17,
  },
]

/** Transparent overlays, independent of the base layer. */
const HYDRO_OVERLAY =
  'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Hydro_Reference_Overlay/MapServer/tile/{z}/{y}/{x}'

function toLatLngBounds(b: Bounds): L.LatLngBoundsExpression {
  return [
    [b.south, b.west],
    [b.north, b.east],
  ]
}

/** Drag-to-draw a rectangle; map panning is suspended while the tool is armed. */
function BoxDrawer({ armed, onFinish }: { armed: boolean; onFinish: (b: Bounds) => void }) {
  const map = useMap()
  const [preview, setPreview] = useState<Bounds | null>(null)
  const startRef = useRef<L.LatLng | null>(null)

  useEffect(() => {
    const container = map.getContainer()
    if (!armed) {
      container.style.cursor = ''
      return
    }
    map.dragging.disable()
    container.style.cursor = 'crosshair'

    const rectFrom = (a: L.LatLng, b: L.LatLng): Bounds => ({
      south: Math.min(a.lat, b.lat),
      north: Math.max(a.lat, b.lat),
      west: Math.min(a.lng, b.lng),
      east: Math.max(a.lng, b.lng),
    })

    const onDown = (e: L.LeafletMouseEvent) => {
      startRef.current = e.latlng
      setPreview(rectFrom(e.latlng, e.latlng))
    }
    const onMove = (e: L.LeafletMouseEvent) => {
      if (!startRef.current) return
      setPreview(rectFrom(startRef.current, e.latlng))
    }
    const onUp = (e: L.LeafletMouseEvent) => {
      if (!startRef.current) return
      const box = rectFrom(startRef.current, e.latlng)
      startRef.current = null
      setPreview(null)
      if (box.north - box.south > 1e-4 && box.east - box.west > 1e-4) onFinish(box)
    }

    map.on('mousedown', onDown)
    map.on('mousemove', onMove)
    map.on('mouseup', onUp)
    return () => {
      map.off('mousedown', onDown)
      map.off('mousemove', onMove)
      map.off('mouseup', onUp)
      map.dragging.enable()
      container.style.cursor = ''
      startRef.current = null
      setPreview(null)
    }
  }, [armed, map, onFinish])

  if (!preview) return null
  return (
    <Rectangle
      bounds={toLatLngBounds(preview)}
      pathOptions={{ color: '#7dd3fc', weight: 1, dashArray: '4 3', fillOpacity: 0.12 }}
    />
  )
}

/** Keeps the map viewport in sync when bounds are set from outside (presets, search). */
function FitTo({ bounds, token }: { bounds: Bounds | null; token: number }) {
  const map = useMap()
  useEffect(() => {
    if (!bounds) return
    map.fitBounds(toLatLngBounds(bounds), { padding: [24, 24], animate: true })
  }, [token, bounds, map])
  return null
}

export default function MapPicker() {
  const bounds = useStore((s) => s.bounds)
  const setBounds = useStore((s) => s.setBounds)
  const [armed, setArmed] = useState(true)
  const [baseId, setBaseId] = useState('map')
  const [water, setWater] = useState(false)
  const [fitToken, setFitToken] = useState(0)
  const base = BASE_LAYERS.find((l) => l.id === baseId)!
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchNote, setSearchNote] = useState('')

  const applyBounds = (b: Bounds, refit: boolean) => {
    setBounds(b)
    if (refit) setFitToken((t) => t + 1)
  }

  const search = async (e: React.FormEvent) => {
    e.preventDefault()
    const q = query.trim()
    if (!q) return
    setSearching(true)
    setSearchNote('')
    try {
      const url =
        'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
        encodeURIComponent(q)
      const res = await fetch(url, { headers: { Accept: 'application/json' } })
      const hits = (await res.json()) as Array<{ boundingbox: string[]; display_name: string }>
      if (!hits.length) {
        setSearchNote('No match.')
        return
      }
      const [s, n, w, e2] = hits[0].boundingbox.map(Number)
      // Nominatim boxes can be a single point or an entire country; keep them sane.
      const padLat = Math.max(0.02, (n - s) * 0.1)
      const padLon = Math.max(0.02, (e2 - w) * 0.1)
      applyBounds(
        {
          south: s - padLat,
          north: n + padLat,
          west: w - padLon,
          east: e2 + padLon,
        },
        true,
      )
      setSearchNote(hits[0].display_name.split(',').slice(0, 2).join(','))
    } catch {
      setSearchNote('Search unavailable.')
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="picker">
      <form className="search" onSubmit={search}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a place…"
          spellCheck={false}
        />
        <button type="submit" disabled={searching}>
          {searching ? '…' : 'Go'}
        </button>
      </form>

      <div className="map-wrap">
        <MapContainer
          center={[46.0, 7.66]}
          zoom={10}
          scrollWheelZoom
          style={{ height: '100%', width: '100%' }}
          worldCopyJump
        >
          {/* Keyed so switching base layers swaps the tiles rather than stacking. */}
          <TileLayer
            key={base.id}
            url={base.url}
            attribution={base.attribution}
            maxZoom={base.maxZoom}
          />
          {water && (
            <TileLayer
              url={HYDRO_OVERLAY}
              attribution="Hydrography &copy; Esri"
              maxZoom={19}
              opacity={0.9}
              zIndex={400}
            />
          )}
          {bounds && (
            <Rectangle
              bounds={toLatLngBounds(bounds)}
              pathOptions={{ color: '#fbbf24', weight: 2, fillOpacity: 0.1 }}
            />
          )}
          <BoxDrawer
            armed={armed}
            onFinish={(b) => {
              applyBounds(b, false)
              setArmed(false)
            }}
          />
          <FitTo bounds={bounds} token={fitToken} />
        </MapContainer>

        <button
          className={`draw-toggle ${armed ? 'on' : ''}`}
          onClick={() => setArmed((a) => !a)}
          title={armed ? 'Drawing armed — drag on the map' : 'Click to draw a new box'}
        >
          {armed ? '◻ drag to draw' : '✎ draw box'}
        </button>

        <div className="layers">
          {BASE_LAYERS.map((l) => (
            <button
              key={l.id}
              className={baseId === l.id ? 'on' : ''}
              onClick={() => setBaseId(l.id)}
              title={l.attribution.replace(/&copy;/g, '©')}
            >
              {l.label}
            </button>
          ))}
          <button
            className={`overlay ${water ? 'on' : ''}`}
            onClick={() => setWater((v) => !v)}
            title="Rivers, lakes and coastlines — useful for checking where water really is before you build"
          >
            Water
          </button>
        </div>
      </div>

      {searchNote && <div className="search-note">{searchNote}</div>}

      <div className="presets">
        {PRESETS.map((p) => (
          <button key={p.name} onClick={() => applyBounds(p.bounds, true)}>
            {p.name}
          </button>
        ))}
      </div>
    </div>
  )
}
