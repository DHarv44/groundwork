/**
 * Named setting snapshots.
 *
 * Stored separately from the live session so that saving a preset, loading one, or
 * hitting Reset never disturbs the others. A preset holds only the settings — not the
 * area, source or camera — so it can be applied to any terrain.
 */

import { storageKey } from '../config'

const KEY = () => storageKey('presets')

export interface Preset {
  name: string
  savedAt: number
  settings: Record<string, unknown>
}

export function loadPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(KEY())
    const list = raw ? (JSON.parse(raw) as Preset[]) : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function write(list: Preset[]): void {
  try {
    localStorage.setItem(KEY(), JSON.stringify(list))
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

// ---- copy and paste ------------------------------------------------------

/** Marks the text as ours, so a paste of something else fails with a clear reason. */
/**
 * Deliberately *not* namespaced by the storage prefix.
 *
 * This is the identifier inside exported preset files, not a storage key. A host
 * changing its prefix must not stop being able to read presets somebody else exported
 * — the format is shared across every deployment, which is the whole point of it
 * having a name.
 */
const FORMAT = 'terrain-builder/preset'

/** Human-readable on purpose: this is meant to be pasted into a message or a file. */
export function encodePreset(name: string, settings: Record<string, unknown>): string {
  return JSON.stringify({ format: FORMAT, version: 1, name, settings }, null, 2)
}

export interface DecodeResult {
  preset?: { name: string; settings: Record<string, unknown> }
  /** Set when the text could not be used, phrased for showing to the user. */
  error?: string
  /** Keys that were dropped because this build does not know them. */
  ignored?: string[]
}

/**
 * Parse pasted text back into a preset.
 *
 * Everything here is untrusted — it arrives from the clipboard, so it may be any text
 * at all, an older export, or a newer one from a build with settings this one lacks.
 * Keys are therefore checked against `known` and anything unrecognised is dropped
 * rather than written into the settings object, and each value has to match the type of
 * the default it is replacing. Without that a single bad paste could put a string where
 * the shader expects a float and the terrain would simply vanish.
 */
export function decodePreset(
  text: string,
  known: Record<string, unknown>,
): DecodeResult {
  let raw: unknown
  try {
    raw = JSON.parse(text.trim())
  } catch {
    return { error: 'That is not valid JSON.' }
  }
  if (!raw || typeof raw !== 'object') return { error: 'That is not a preset.' }

  const obj = raw as Record<string, unknown>
  // Accept a bare settings object too, so a snippet copied out of the middle still works.
  const body = (obj.settings && typeof obj.settings === 'object' ? obj.settings : obj) as Record<
    string,
    unknown
  >
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : 'Pasted'

  const settings: Record<string, unknown> = {}
  const ignored: string[] = []
  for (const [k, v] of Object.entries(body)) {
    if (k === 'biomeOverrides') {
      // Per-class table: an object of objects of numbers, checked one level down.
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const table: Record<string, Record<string, number>> = {}
        for (const [code, vals] of Object.entries(v as Record<string, unknown>)) {
          if (!vals || typeof vals !== 'object') continue
          const clean: Record<string, number> = {}
          for (const [vk, vv] of Object.entries(vals as Record<string, unknown>)) {
            if (typeof vv === 'number' && Number.isFinite(vv) && vk in known) clean[vk] = vv
          }
          if (Object.keys(clean).length) table[code] = clean
        }
        settings.biomeOverrides = table
      }
      continue
    }
    if (!(k in known)) {
      ignored.push(k)
      continue
    }
    const want = typeof known[k]
    if (typeof v !== want) {
      ignored.push(k)
      continue
    }
    if (want === 'number' && !Number.isFinite(v as number)) {
      ignored.push(k)
      continue
    }
    settings[k] = v
  }

  if (!Object.keys(settings).length) {
    return { error: 'No settings this build recognises.' }
  }
  return { preset: { name, settings }, ignored: ignored.length ? ignored : undefined }
}
