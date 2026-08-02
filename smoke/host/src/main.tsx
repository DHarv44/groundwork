/**
 * The foreign-host smoke test, installed from packed tarballs — not workspace links,
 * because links hide exactly the resolution bugs this exists to catch.
 *
 * What has to hold: one React 19 tree containing BOTH the host's own R3F canvas and
 * the builder's; the builder's CSS staying inside .gw; storage namespaced by
 * configureBuilder; and the pack coming out as bytes and reading back with core.
 */
import { useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import {
  Builder,
  configureBuilder,
  packBytesFrom,
  summarisePack,
  useStore,
} from '@dharv44/groundwork-builder'
import '@dharv44/groundwork-builder/styles.css'
import { packFromBytes, parseVectors, readHeightField } from '@dharv44/groundwork-core'

// Before mount, which is the contract. No proxies exist here, so the tile endpoints
// point straight at the providers — the exact position an embedding host is in.
configureBuilder({
  storagePrefix: 'smoke-host.terrain',
  endpoints: {
    terrarium: (z, x, y) =>
      `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    imagery: (z, y, x) =>
      `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  },
})

/** The host's own R3F content — proves two canvases share one React/three. */
function SpinningBox() {
  const ref = useRef<THREE.Mesh>(null)
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt
  })
  return (
    <mesh ref={ref}>
      <boxGeometry args={[1.6, 1.6, 1.6]} />
      <meshNormalMaterial />
    </mesh>
  )
}

createRoot(document.getElementById('own-canvas')!).render(
  <Canvas camera={{ position: [0, 0, 4] }}>
    <SpinningBox />
  </Canvas>,
)

createRoot(document.getElementById('slot')!).render(<Builder />)

// ---- the checks --------------------------------------------------------------

const out = document.getElementById('out')!
const log = (line: string) => {
  out.textContent += `\n${line}`
}

document.getElementById('run')!.addEventListener('click', () => {
  void (async () => {
    out.textContent = 'running'

    // 1. CSS containment, measured not eyeballed.
    const hostBtn = getComputedStyle(document.getElementById('host-btn')!)
    const gwBtn = document.querySelector<HTMLButtonElement>('.gw button')
    const gwStyle = gwBtn ? getComputedStyle(gwBtn) : null
    log(`css: host button ${hostBtn.fontFamily.split(',')[0]}/${hostBtn.boxSizing}`)
    log(`css: builder button ${gwStyle?.fontFamily.split(',')[0]}/${gwStyle?.boxSizing}`)
    log(
      `css: isolated = ${
        hostBtn.boxSizing === 'content-box' && gwStyle?.boxSizing === 'border-box'
      }`,
    )
    const rootAccent = getComputedStyle(document.documentElement).getPropertyValue('--accent')
    log(`css: builder --accent absent from :root = ${rootAccent.trim() === ''}`)

    // 2. Storage namespacing.
    const dbs = (await indexedDB.databases()).map((d) => d.name)
    log(`storage: databases = ${dbs.join(', ')}`)
    log(`storage: namespaced = ${dbs.includes('smoke-host.terrain')}`)
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('smoke-host.terrain'))
    log(`storage: ${keys.length} localStorage keys under the prefix`)

    // 3. Terrain. Demo terrain needs no network, so the core assertions cannot be
    //    hostage to a tile CDN; a real fetch is exercised separately by the user
    //    picking a box.
    if (!useStore.getState().heightField) {
      log('building demo terrain…')
      useStore.getState().generateDemo()
      for (let i = 0; i < 120 && !useStore.getState().build; i++) {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    const s = useStore.getState()
    if (!s.heightField) {
      log('FAIL: no terrain')
      return
    }

    // 4. Pack as bytes — no download — and straight back in through core.
    const input = {
      heightField: s.heightField,
      osm: s.roads,
      waterMask: s.waterMask,
      baseName: 'smoke',
      createdAt: new Date().toISOString(),
    }
    const summary = summarisePack(input)
    const bytes = await packBytesFrom(input)
    log(`pack: ${(bytes.length / 1024).toFixed(0)} KB as bytes, no download`)

    const files = await packFromBytes(bytes.slice().buffer)
    const hf = readHeightField(files)
    const v = files.vectors ? parseVectors(files.vectors) : null
    const worst = (() => {
      let w = 0
      for (let i = 0; i < hf.data.length; i += 97) {
        w = Math.max(w, Math.abs(hf.data[i]! - s.heightField!.data[i]!))
      }
      return w
    })()
    log(`roundtrip: ${hf.width}x${hf.height}, worst height error ${worst.toFixed(3)} m`)
    log(`roundtrip: roads ${v?.roads.length ?? 0} areas ${v?.areas.length ?? 0} places ${v?.places.length ?? 0} (${summary.samples.toLocaleString()} samples)`)
    log(`roundtrip: intact = ${worst < 0.1}`)

    log('done')
  })().catch((e) => log(`FAIL: ${e instanceof Error ? e.message : String(e)}`))
})
