import { useEffect } from 'react'
import L from 'leaflet'
import { useMap } from 'react-leaflet'
import { classAt, colorFor, loadKoppen } from '../lib/koppen'

/**
 * Paints the Köppen map over the mini-map.
 *
 * Drawn per tile rather than loaded as image tiles: the raster is already resident, so
 * for each of the 256×256 pixels we invert the Web Mercator projection to a latitude
 * and read the class directly. No requests, no tile server, and it stays sharp under
 * the box-drawing rectangle at any zoom.
 */
/**
 * Its own pane, sitting between the basemap (200) and the vector overlays (400), so the
 * climate colours cover the map tiles but never the selection rectangle you are drawing.
 */
const PANE = 'koppen'
const PANE_Z = 250

function makeLayer(opacity: number): L.GridLayer {
  const Layer = L.GridLayer.extend({
    createTile(coords: L.Coords) {
      const size = this.getTileSize()
      const tile = L.DomUtil.create('canvas') as HTMLCanvasElement
      tile.width = size.x
      tile.height = size.y
      const ctx = tile.getContext('2d')
      if (!ctx) return tile

      const scale = Math.pow(2, coords.z)
      const image = ctx.createImageData(size.x, size.y)
      const px = image.data

      for (let y = 0; y < size.y; y++) {
        // Inverse Web Mercator for this row: every pixel in it shares a latitude.
        const worldY = (coords.y * size.y + y + 0.5) / (size.y * scale)
        const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) * 180) / Math.PI
        for (let x = 0; x < size.x; x++) {
          const worldX = (coords.x * size.x + x + 0.5) / (size.x * scale)
          const lon = worldX * 360 - 180
          const cls = classAt(lat, lon)
          const o = (y * size.x + x) * 4
          if (!cls) continue // ocean and no-data stay transparent
          const [r, g, b] = colorFor(cls)
          px[o] = r
          px[o + 1] = g
          px[o + 2] = b
          px[o + 3] = 255
        }
      }

      ctx.putImageData(image, 0, 0)
      return tile
    },
  })
  return new (Layer as unknown as new (o: L.GridLayerOptions) => L.GridLayer)({
    opacity,
    pane: PANE,
  })
}

export default function KoppenLayer({ show, opacity = 0.5 }: { show: boolean; opacity?: number }) {
  const map = useMap()

  useEffect(() => {
    if (!show) return
    let layer: L.GridLayer | null = null
    let cancelled = false

    // The raster has to be resident before a single tile can be painted.
    void loadKoppen().then((data) => {
      if (cancelled || !data) return
      if (!map.getPane(PANE)) {
        const pane = map.createPane(PANE)
        pane.style.zIndex = String(PANE_Z)
        // Purely decorative — clicks and drags belong to the box drawer beneath.
        pane.style.pointerEvents = 'none'
      }
      layer = makeLayer(opacity)
      layer.addTo(map)
    })

    return () => {
      cancelled = true
      if (layer) map.removeLayer(layer)
    }
  }, [show, opacity, map])

  return null
}
