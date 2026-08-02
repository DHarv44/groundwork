/**
 * The builder's portability test.
 *
 * The standalone app at the repo root does not prove much: same repo, same Vite
 * config, same dev proxies, same `public/`, and it owns the whole page. This pretends
 * to be somebody else's application — hostile global CSS, its own chrome, its own
 * storage namespace, and the builder confined to a box it does not control.
 *
 * The stub consumer takes the pack as **bytes**, not as a download. That is the shape
 * a real host needs, and it is what `packBytesFrom` exists for.
 */
import { createRoot } from 'react-dom/client'
import {
  Builder,
  configureBuilder,
  packBytesFrom,
  packFileName,
  summarisePack,
  useStore,
} from '@dharv44/groundwork-builder'
import '@dharv44/groundwork-builder/styles.css'
import { packFromBytes, readHeightField } from '@dharv44/groundwork-core'

/**
 * Configured before mounting, which is the contract.
 *
 * The storage prefix is the interesting one: with it set, this page's sessions,
 * presets and DEM cache are entirely separate from the standalone app's, and the two
 * can be open side by side without fighting over one IndexedDB database.
 */
configureBuilder({
  storagePrefix: 'host-demo.terrain',
  // Everything else is left alone deliberately, to check a partial override does not
  // wipe the endpoints the host did not mention.
})

createRoot(document.getElementById('slot')!).render(<Builder />)

// ---- the stub consumer -------------------------------------------------------

const out = document.getElementById('out')!
const say = (text: string) => {
  out.textContent = text
}

document.getElementById('take')!.addEventListener('click', () => {
  void (async () => {
    const s = useStore.getState()
    if (!s.heightField) {
      say('No terrain built yet — pick a box and build one first.')
      return
    }

    const input = {
      heightField: s.heightField,
      osm: s.roads,
      waterMask: s.waterMask,
      baseName: 'host-demo-pack',
      createdAt: new Date().toISOString(),
    }

    say('building…')
    const summary = summarisePack(input)
    const bytes = await packBytesFrom(input)

    // Read it straight back, because a consumer that cannot open what it was handed
    // has not really been handed anything.
    const files = await packFromBytes(bytes.slice().buffer)
    const hf = readHeightField(files)

    say(
      [
        `name       ${packFileName(input.baseName)}`,
        `size       ${(bytes.length / 1048576).toFixed(2)} MB`,
        '',
        `raster     ${files.manifest.width} × ${files.manifest.height}`,
        `ground     ${(files.manifest.widthMetres / 1000).toFixed(1)} × ${(files.manifest.heightMetres / 1000).toFixed(1)} km`,
        `elevation  ${Math.round(hf.min)} – ${Math.round(hf.max)} m`,
        `layers     ${files.manifest.layers.map((l) => `${l.id}${l.filter ? ` (${l.filter})` : ''}`).join(', ')}`,
        '',
        `roads      ${summary.roads.toLocaleString()}`,
        `areas      ${summary.areas.toLocaleString()}`,
        `places     ${summary.places.toLocaleString()}`,
        '',
        'attribution',
        ...files.manifest.attribution.map((a) => `  ${a.source}\n    ${a.licence}`),
      ].join('\n'),
    )
  })().catch((e) => say(`failed: ${e instanceof Error ? e.message : String(e)}`))
})

// The host's own button, to show it keeps its own styling with the builder mounted.
document.getElementById('hostBtn')!.addEventListener('click', () => {
  const gw = document.querySelector('.gw')
  say(
    gw
      ? 'The builder is mounted, and this button is still the host\'s own pink dashed one.\n' +
        'Nothing in styles.css reaches outside .gw.'
      : 'Builder not mounted.',
  )
})
