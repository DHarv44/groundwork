import { buildMasks, type MaskOptions } from '../lib/roadmask'
import type { OsmData } from '../lib/overpass'

/**
 * Rasterises the OpenStreetMap masks off the main thread.
 *
 * The feature data is sent once and kept here, not resent on every draw. Width and verge
 * are sliders that move no coordinates — they only change how thickly the same lines are
 * stroked — so shipping fifty thousand ways across the thread boundary for each tick of
 * a drag would cost more than the drawing does. Holding it worker-side also lets the
 * projected-geometry cache in roadmask.ts stay warm between draws, which is where most
 * of the saving actually comes from.
 */

interface DrawRequest {
  /** Identifies the feature set. A new box means a new token and a fresh `data`. */
  token: number
  /** Sent only on the first request for a token. */
  data?: OsmData
  opts: MaskOptions
}

let held: { token: number; data: OsmData } | null = null

self.onmessage = (e: MessageEvent<DrawRequest>) => {
  const { token, data, opts } = e.data
  try {
    if (data) held = { token, data }
    if (!held || held.token !== token) {
      throw new Error('mask worker: no feature data held for this token')
    }

    const masks = buildMasks(held.data, opts)
    ;(self as unknown as Worker).postMessage(masks, [masks.roads, masks.areas])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
