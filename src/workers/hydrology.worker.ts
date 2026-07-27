import { computeWaterMask, type HydrologyInput, type HydrologyResult } from '../lib/hydrology'

// The flood is O(n log n) over up to a million cells; off the main thread it costs the
// UI nothing, and the mask transfers back without a copy.
self.onmessage = (e: MessageEvent<HydrologyInput>) => {
  try {
    const result: HydrologyResult = computeWaterMask(e.data)
    ;(self as unknown as Worker).postMessage(result, [result.mask.buffer])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
