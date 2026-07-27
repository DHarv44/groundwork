import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import { MapContainer, Rectangle, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import type { Bounds } from '../lib/geo'
import { DEFAULT_BOUNDS } from '../lib/geo'
import { useStore } from '../store'
import KoppenLayer from './KoppenLayer'

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

const VIEW_KEY = 'terrain-builder.mapView'

interface SavedView {
  lat: number
  lng: number
  zoom: number
}

function loadSavedView(): SavedView | null {
  try {
    const raw = localStorage.getItem(VIEW_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as SavedView
    return Number.isFinite(v.lat) && Number.isFinite(v.lng) && Number.isFinite(v.zoom)
      ? v
      : null
  } catch {
    return null
  }
}

/** Remembers where the map was left, so a refresh does not throw away your position. */
function RememberView() {
  const map = useMap()
  useEffect(() => {
    const save = () => {
      const c = map.getCenter()
      try {
        localStorage.setItem(
          VIEW_KEY,
          JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }),
        )
      } catch {
        /* storage disabled — not worth failing over */
      }
    }
    map.on('moveend', save)
    map.on('zoomend', save)
    return () => {
      map.off('moveend', save)
      map.off('zoomend', save)
    }
  }, [map])
  return null
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

const BIOME_KEY = 'terrain-builder.showBiome'

export default function MapPicker() {
  const bounds = useStore((s) => s.bounds)
  const setBounds = useStore((s) => s.setBounds)
  const biome = useStore((s) => s.biome)
  const [showBiome, setShowBiome] = useState(() => localStorage.getItem(BIOME_KEY) === '1')
  const [armed, setArmed] = useState(true)
  const [fitToken, setFitToken] = useState(0)
  // Read once at mount; MapContainer ignores later changes to center/zoom anyway.
  const [saved] = useState(loadSavedView)
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
          center={
            saved
              ? [saved.lat, saved.lng]
              : [
                  (DEFAULT_BOUNDS.north + DEFAULT_BOUNDS.south) / 2,
                  (DEFAULT_BOUNDS.east + DEFAULT_BOUNDS.west) / 2,
                ]
          }
          zoom={saved ? saved.zoom : 9}
          scrollWheelZoom
          style={{ height: '100%', width: '100%' }}
          worldCopyJump
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap"
            maxZoom={19}
          />
          {bounds && (
            <Rectangle
              bounds={toLatLngBounds(bounds)}
              pathOptions={{ color: '#fbbf24', weight: 2, fillOpacity: 0.1 }}
            />
          )}
          <KoppenLayer show={showBiome} />
          <BoxDrawer
            armed={armed}
            onFinish={(b) => {
              applyBounds(b, false)
              setArmed(false)
            }}
          />
          <FitTo bounds={bounds} token={fitToken} />
          <RememberView />
        </MapContainer>

        <button
          className={`draw-toggle ${armed ? 'on' : ''}`}
          onClick={() => setArmed((a) => !a)}
          title={armed ? 'Drawing armed — drag on the map' : 'Click to draw a new box'}
        >
          {armed ? '◻ drag to draw' : '✎ draw box'}
        </button>

        <button
          className={`biome-toggle ${showBiome ? 'on' : ''}`}
          onClick={() =>
            setShowBiome((v) => {
              localStorage.setItem(BIOME_KEY, v ? '0' : '1')
              return !v
            })
          }
          title="Köppen–Geiger climate classes, Beck et al. (2023)"
        >
          ◐ biomes
        </button>

        {/* What the box currently sits in, named on the map itself. */}
        {biome && (
          <div className="biome-badge" title={biome.name}>
            <b>{biome.code}</b> {biome.name}
          </div>
        )}
      </div>

      {searchNote && <div className="search-note">{searchNote}</div>}

      {/* Value is deliberately not bound to anything: picking a place moves the box, but
          the box is then yours to redraw, so leaving the name selected would claim a
          match that no longer holds. It resets to the prompt after each pick. */}
      <select
        className="poi-select"
        value=""
        onChange={(e) => {
          const p = PRESETS.find((x) => x.name === e.target.value)
          if (p) applyBounds(p.bounds, true)
        }}
      >
        <option value="">Jump to a place…</option>
        {PRESETS.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  )
}
