/**
 * Named setting snapshots.
 *
 * Stored separately from the live session so that saving a preset, loading one, or
 * hitting Reset never disturbs the others. A preset holds only the settings — not the
 * area, source or camera — so it can be applied to any terrain.
 */

const KEY = 'terrain-builder.presets'

export interface Preset {
  name: string
  savedAt: number
  settings: Record<string, unknown>
}

export function loadPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(KEY)
    const list = raw ? (JSON.parse(raw) as Preset[]) : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function write(list: Preset[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* storage disabled or full — not worth failing over */
  }
}

/** Saving under an existing name replaces it, so re-saving is how you update. */
export function savePreset(name: string, settings: Record<string, unknown>): Preset[] {
  const trimmed = name.trim()
  if (!trimmed) return loadPresets()
  const list = loadPresets().filter((p) => p.name !== trimmed)
  list.push({ name: trimmed, savedAt: Date.now(), settings })
  list.sort((a, b) => a.name.localeCompare(b.name))
  write(list)
  return list
}

export function deletePreset(name: string): Preset[] {
  const list = loadPresets().filter((p) => p.name !== name)
  write(list)
  return list
}
