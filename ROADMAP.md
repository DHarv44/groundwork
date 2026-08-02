# Roadmap

Working notes on what is outstanding. Items marked **(asked)** came from a direct
request; the rest are things measurement turned up along the way.

---

## In progress: the engine / builder split **(asked)**

Branch `engine-split`. Groundwork is being separated into three packages so the renderer
and the authoring tool can each be wired into a future project independently, without
dragging the other along.

The thing that makes them independently usable is not the folder layout — it is that
**the pack format is the contract**. The builder writes packs; the engine reads packs;
neither imports the other. Get that right and a different builder, or a different
renderer, would interoperate.

```
packages/core      data model, pack I/O, geodesy, sampling   deps: —
packages/engine    renderer, materials, object registry      deps: three, core
packages/builder   authoring UI, export                      deps: react, three, engine, core
```

Strictly one-directional. Rules that keep it that way:

- **`core` imports nothing.** Not three, not react. Its `tsconfig` omits the DOM lib
  entirely, so a browser API cannot be reached for by accident. This is what lets a
  headless baker, a pack validator, or a consumer doing pathfinding over the terrain
  arrays read pack data without pulling in a renderer.
- **The engine bundles no assets.** Everything it needs arrives in the pack. If it needs
  a file that is not in the pack, the split is wrong.
- **The engine does no network and owns no workers.** Deriving data — hydrology, mask
  rasterisation — is authoring work and stays in the builder. The engine consumes
  finished layers.
- **The engine owns neither the renderer nor the frame loop.** It hands back a
  `THREE.Group` and an update function; the host owns `WebGLRenderer`, camera and rAF.
  A `standalone()` wrapper covers the "just put it on screen" case without costing the
  embeddable shape. For the same reason the engine is plain three.js, not R3F — R3F
  would pin a React version onto every future consumer.
- **The builder's only output is a pack**, and it must not know what consumes it.

### Stages

- [x] **1. `core`** — done. `packages/core` holds the pack format and `formatVersion`,
      the geodesy, `HeightField` and its sampling, and the road/area/place vector model.
      Wired into the app and verified rendering: `geo.ts`, `opentopo.ts` and `mesh.ts`
      now re-export from the package rather than defining their own, so no call site had
      to move. It imports nothing, and its tsconfig omits the DOM lib so it cannot start.

      Two decisions worth knowing before building on it:

      - **Vector coordinates are normalised to the box, `x` east and `y` south.**
        South-down so a vector coordinate indexes the north-up row-major raster planes
        directly; having the two disagree is a flip that costs an afternoon every time
        somebody new reads the format. Normalised rather than metres so geometry
        survives a re-bake at another resolution, and rather than lon/lat so a consumer
        that only draws does not need a projection. `bounds` is in the manifest, so
        georeferencing is never lost.
      - **`attribution` is required and structured.** The licences involved (ODbL for
        OpenStreetMap, CC BY for Köppen) require the credit to be *shown*, which means
        something downstream has to render it — and it cannot render what it cannot
        parse. `validateManifest` fails a pack that has none.

- [~] **2. `engine`** — the terrain surface is across. `packages/engine` now holds the
      terrain shader, the mesh builder and the sky model, and exposes `TerrainSurface`:
      plain three.js, no React, no store. Groundwork's `Terrain.tsx` is now a thin
      binding that maps `Settings` into `SurfaceConfig` and drives it — verified by
      toggling a layer and watching the canopy come off, so the config genuinely
      reaches the GPU rather than merely compiling.

      `SurfaceConfig` is its own type rather than a slice of `Settings`, which is the
      whole point: the engine takes final values in its own vocabulary and knows
      nothing about sliders, presets or biome overrides. `Terrain.tsx` is the only file
      that knows both sides. Anything reached for there that the engine does not offer
      means the engine's config is missing something — not that the store should be
      imported over there.

      Two things carried across deliberately, both previously hard-won:

      - The uniform object is built once and mutated in place, never replaced. three
        caches its upload list against the objects present at compile time, so
        replacing it leaves the renderer uploading stale values.
      - The first program compiled for a fresh `ShaderMaterial` can latch stale uniform
        locations, so one recompile is forced after a frame has actually gone through.
        In the component this was a `requestAnimationFrame`; in the class it is a frame
        counter in `update()`, which does the same thing without needing a DOM timer.

- [x] **2b. Water and sky** — done. `WaterPlane` and `SkyDome` join `TerrainSurface`,
      same shape: plain three.js objects the host configures and updates. The old
      `sky.ts` is now `atmosphere.ts`, so the model (`computeSky`) and the thing that
      draws it (`sky/dome.ts`) are no longer competing for the name.

      `WaterPlane` absorbed two behaviours that were loose in the component: it hides
      itself rather than unmounting when the terrain never reaches sea level, so a
      slider crossing a threshold does not restructure the host's scene graph; and it
      rebuilds its geometry only when the box actually changes size.

      Verified by dropping the sun to 1° and watching the whole scene go to twilight —
      terrain, water and sky all took the new lighting, which is all three `setSky`
      paths at once.
- [~] **2c. Pack loading** — the byte-level half is done. `packio.ts` in core has
      `buildPack` and `readHeightField`, and a pack's elevation plane comes back out as
      an ordinary `HeightField` — the same structure a live DEM fetch produces, so
      nothing downstream knows or cares which it was.

      Reading and writing take and return bytes; nothing in there fetches. A pack might
      arrive over HTTP, out of a zip, from disk in a Node baker or from a file input,
      and none of that belongs in a decoder. `createdAt` is passed in rather than read
      from a clock, so a baker can produce byte-identical output twice — which is what
      makes a rebuild diffable and a regression test possible at all.

      `npm run check:core` runs 17 checks in Node with no browser, which also proves
      the headless claim rather than asserting it. The test field is a ramp plus an
      off-centre spike: the ramp catches scale and offset errors, the spike catches a
      transposition that a symmetric field would hide. Quantisation comes back inside
      0.03 m over a 3900 m range. It has its own tsconfig, because core's has no DOM
      lib and no node types and pulling those in for the test would quietly remove the
      guarantee that config exists to enforce.

      What is left is the host side: a loader that fetches the files and hands them
      over, and the demo page that proves the engine can render a pack the builder did
      not just produce in memory.

- [x] **5. Export** — done, ahead of stages 3 and 4 because it is what makes packs real
      enough to test anything else against. **Export → Pack → Write pack.**

      A pack is several files and a download is one, so the wire form is a ZIP —
      written by hand in `core/src/zip.ts` rather than pulled in, because core has no
      dependencies and is not going to start now: it has to open packs in a browser, in
      a Node baker, and anywhere else, and a zero-dependency decoder is the only
      version of that which cannot rot. Store-only, about a hundred lines, and the
      output is an ordinary ZIP — verified by extracting one with Windows'
      `Expand-Archive`, not only with our own reader.

      Verified end to end in the browser by intercepting the download and reading the
      bytes back: a Hawaii box came out as 3495×2167 at 62877×38746 m, −407.2 to
      4199.5 m, matching the UI's own readouts; 5368 roads, 464 mapped areas of which
      10 carry inner rings, so the island-and-clearing fix survives into the format.

- [x] **5b. Deflate** — done. That Hawaii box went from **46.9 MB to 21.3 MB**, with
      every value identical on the way back out.

      Compression comes from the platform: `CompressionStream('deflate-raw')` is in
      every current browser and in Node 18 and later, and it is a *global* rather than
      an import — so core stays dependency-free while getting a real deflate instead of
      a hand-rolled one, which is not somewhere to be inventive. Where it is missing the
      writer falls back to storing, which still produces a valid archive.

      Core's tsconfig still has no DOM lib. The streams API is declared structurally in
      `zip.ts` — just the four shapes needed — because pulling the whole DOM in for two
      constructors would have traded away the guarantee that keeps `document` and
      `fetch` out by construction.

      Two things worth knowing:

      - `zip`, `unzip`, `packToBytes` and `packFromBytes` are now **async**. Unavoidable
        with a streams-based codec, and harmless in practice since every caller was
        already in an async path.
      - Entries under 4 KB stay stored. Below that the deflate header costs more than
        the coding saves, and it keeps `pack.json` readable straight out of the archive
        with any tool.

      Verified by extracting a deflated pack with Windows' `Expand-Archive` — right
      uncompressed sizes — and by re-rendering it in the demo unchanged.

- [x] **5b-ii. Filter the elevation plane.** **21.3 MB → 13.7 MB.**

      Measuring first was the whole value here, because the obvious target was wrong.
      The water field *looked* like the problem at 30 MB raw, but it deflates 3.6× and
      was only 37% of the pack. Elevation was **61% and compressed 1.1×** — quantised
      heights resist deflate badly, because each sample's low byte is essentially noise
      while its high byte varies smoothly, and interleaving them buries the smooth
      signal in the noisy one.

      `delta16-split` takes a running difference between samples, then writes all the
      high bytes followed by all the low bytes. Small deltas have a high byte of 0x00
      going up or 0xff going down, so that plane becomes long runs — measured at 99.9%
      of the first million bytes. Elevation went from 1.1× to 2.7×. Entirely lossless:
      it reorders and predicts, it does not discard. Declared per layer as
      `filter`, so a pack without the field is still read correctly.

      Verified at full scale: 0 bad samples in 7,573,665, worst error 0.0352 m — inside
      one quantisation step.

      **A trap worth knowing about, which nearly caused a correct change to be
      reverted.** Verifying from the browser console by dynamically importing
      `/node_modules/@dharv44/groundwork-core/src/index.ts` can get a *stale* copy: Vite treats
      that path as a dependency rather than source, so it kept serving the pre-filter
      transform while the app itself — importing the bare specifier — had the new one.
      The result was two copies of core in one page, the export filtering correctly and
      the probe failing to unfilter, which read as catastrophic corruption of every
      sample. The code was right the whole time and the instrument was lying. Add a
      cache-busting query, or verify in Node where the problem does not exist.

- [x] **5b-iii. De-interleave the hydrology field.** **13.7 MB → 10.9 MB**, and the
      whole journey is **46.9 MB → 10.9 MB**.

      Measured the options before writing any of it, having just been caught assuming.
      The intuitive fix — drop the unused alpha channel — reached only 7.23 MB from
      7.92. Planar with a per-channel delta reached **5.14 MB**.

      The reason is worth keeping: in that box the lake flag and the alpha channel each
      hold exactly **one distinct value**. A constant channel costs almost nothing once
      deflate can see it as a run, and interleaving is precisely what stops it seeing
      that. So separating channels beats trimming them — and it adapts, because which
      channels are empty depends on the place. A box with lakes populates the flag; this
      one has none, correctly.

      Byte-exact on the way back: 0 wrong bytes in 30,294,660.

- [ ] **5b-iv. Where the remaining 10.9 MB sits.** Elevation 5.30, water 5.14, vectors
      0.44. Both rasters are now near what lossless will give at this resolution, so
      further gains mean either dropping precision — the quantisation is far finer than
      the source data's real vertical accuracy, so there is honest room — or not
      shipping the hydrology field at all and having the consumer derive it. Neither is
      obviously right; both change what a pack *is* rather than how it is packed.
- [x] **5c. Named places** — done. Settlements and named summits are folded into the
      **existing** union query, so it is still one request. That placement is the whole
      point: Overpass charges by the request rather than the byte — an IP gets very few
      query slots and acquiring one means queueing — so a second query for names would
      have cost as much as everything else put together, while adding two node clauses
      costs a coordinate pair each against the hundreds in a way.

      A Hawaii box returns 104 places: `city: Hilo (59 m) pop 44186`, villages and
      hamlets, and 92 peaks up to 4173 m. Names come back correctly encoded, ʻokina and
      macrons intact.

      Cross-checked rather than eyeballed: Hilo lands at x 0.864, y 0.693, which
      back-projects to 19.71°N 155.08°W — Hilo's actual position. That confirms the
      lon/lat → normalised-box transform independently of the format's own round trip.

      `population` and `ele` are parsed defensively. Both are free-text tags and
      notorious for it — thousands separators, units appended, commas for decimal
      points — and a bad parse would put a summit at NaN metres and carry it into a
      pack, so anything that does not read cleanly is dropped rather than guessed at.

      The road cache version went to v5. A v4 entry has no places, which is
      indistinguishable from a box that genuinely has none — open ocean and empty desert
      being common, correct answers — so there is nothing in the data to tell the two
      apart. Exactly what the version is for. It cost three refetches.
- [x] **5d. Per-dataset elevation attribution.** Every entry in `DEM_SOURCES` now
      carries the credit its provider requires, and the export puts the right one in the
      pack.

      The design decision worth recording: this is a **citation**, not a licence
      classification. That is what these providers actually require — OpenTopography's
      whole distribution model is built on citing the dataset, and several state no
      licence at all while still mandating a specific credit. Copernicus is the case
      where the exact words matter: its terms specify the notice verbatim for adapted or
      modified data, and a pack is by definition adapted, so the string is quoted rather
      than paraphrased.

      Checked against the providers rather than written from memory. Confirmed:
      NASADEM, SRTM GL1 and GL3 are public domain (CC0) via LP DAAC, no restriction on
      redistribution; Copernicus GLO-30/90 free with mandatory attribution; ALOS World
      3D has **no licence recorded** by OpenTopography but a required DOI citation,
      which is what travels.

      **Three are still unconfirmed** — EU DTM, SRTM15+ and GEBCO — and say so in their
      own `licence` field rather than guessing. A wrong licence inside something meant
      to be shared is worse than an honest pointer at the source. Anyone finishing this
      only needs to confirm those three.
- [x] **3. `builder`** — done. `packages/builder` is the authoring tool; the repo root
      keeps a four-line standalone shell that mounts it.

      Extracting the files was the easy part. What actually made it portable:

      - **`config.ts` owns everything the host owns** — storage namespace, service
        endpoints, asset base, dev hooks — and is the only place `import.meta.env` is
        read. Keys and endpoints are resolved per call, not captured at module load,
        because a host configures before mounting and that is after these modules have
        been imported.
      - **Styles are scoped to `.gw`.** The stylesheet used to style `button`,
        `select`, `input` and `main` globally, which would have silently restyled a
        host's own controls. The palette moved off `:root` for the same reason —
        `--bg` and `--line` are generic enough to collide.
      - **Page-level rules are not scoped, they are gone.** There is no correct way to
        scope a rule about `body`, so `*`, `html`, `body` and `#root` live in
        `page.css`, loaded only by the standalone entry.

      Checked rather than assumed: a `<button>` injected outside `.gw` keeps default
      browser styling while identical markup inside gets the builder's; `--accent`
      resolves on `.gw` and is absent from `:root`; changing `storagePrefix` moves
      every key; and a partial `endpoints` override leaves the others at their
      defaults.

      Two deliberate exceptions, both documented where they live: the preset `FORMAT`
      string stays unnamespaced because it identifies exported files rather than
      storage, and Leaflet's stylesheet is still global because it is Leaflet's, though
      it namespaces itself under `.leaflet-`.

      `npm run check:types` now covers the root program plus each package against its
      own config — which is what keeps `core`'s DOM-less guarantee enforced, since the
      root config cannot express it.
- [~] **4. Demos** — the engine one is done: `demo/engine/`, at
      `/demo/engine/?pack=/sample.gwpack`. Plain three.js, no React, no store, no
      builder. Drop a `.gwpack` on it or point it at one with `?pack=`.

      `npm run sample:pack` writes a synthetic island — two peaks, a saddle, ridged
      noise, bathymetry, a coarser hydrology plane and a road over the saddle —
      **produced by core alone**: no DEM fetch, no Overpass, no browser. That is the
      point of it being synthetic. A pack cut from real data would prove the builder
      works, which was never in question; this proves the engine renders a pack made by
      something that is not the builder.

      **The boundary is verified from build output, not by reading imports.** Both
      entries build together, and the demo's HTML pulls only its own 23 kB chunk plus
      the shared three.js one. React and zustand are entirely inside the builder's
      chunk, which the demo never loads. If the split ever leaks, that shows up as
      React appearing in the demo's chunk graph — mechanical, and it does not depend on
      anyone remembering to check.

      The demo also stands in for the missing road renderer: masks are deliberately not
      in a pack, so it builds `LineSegments` from the vectors and drapes them with
      `sampleBox`. That is a consumer using pack geometry for its own purpose with no
      Groundwork drawing code, which is exactly the case a game would be.

      Worth noting against the earlier plan: a `standalone()` wrapper now looks
      unnecessary. The host-owns-renderer-and-loop path is about thirty lines in the
      demo, and wrapping it would be speculative until something actually wants it.

- [x] **4b. The builder demo** — done. `demo/builder/`, a pretend host application.

      Worth being clear why this was not redundant, having first written it off as such.
      The standalone app proves very little: same repo, same Vite config, same dev
      proxies, same `public/`, and it owns the whole page. The demo host is deliberately
      hostile — `* { box-sizing: content-box }`, a serif body font, pink dashed buttons,
      and its own `--bg`, `--line`, `--accent` variables holding *different values under
      the same names*. The builder is confined to a flex child it does not control.

      Results, measured rather than eyeballed: the host's button stays pink, dashed,
      Georgia and `content-box`; the builder's stays dark, solid, `ui-sans-serif` and
      `border-box`. The `box-sizing` one matters most — it is the rule most likely to
      break a layout silently, and it lands on the right side of the boundary.

      Storage isolation is real: with `storagePrefix` set, `indexedDB.databases()`
      shows `host-demo.terrain` and `terrain-builder` side by side, and the two sets of
      localStorage keys coexist. Both apps can be open at once without fighting.

      The stub consumer takes the pack as **bytes** and reads it straight back, which
      is what a real host wants — POST it, store it, hand it to a renderer. That drove
      a genuine API addition: `buildPackFrom` and `packBytesFrom` split the assembly
      from the download, because intercepting a browser download to get at your own
      data is not an interface.
- [ ] **5. Export** — the builder writes a pack from what is already in the store.

### Rules for the export

**No network at export time.** Everything is already resident: `heightField`, the OSM
payload (kept precisely so masks rebuild without a request — `store.ts`), the hydrology
result, the biome field, settings. Both the DEM and the OSM response are also cached in
IndexedDB keyed on bounds, so even a reload before exporting costs nothing. If the export
needs something, it gets fetched at *load* time into the store, never at export.

**Ship vectors, not masks.** `roadMask` and `areaMask` are rasterised at the builder's
`maskResolution` — a display setting. Baking them into a pack would freeze a slider
position into somebody else's data. The raw OSM geometry is resolution-independent and is
what a consumer actually wants. Derived rasters that have no vector form — the hydrology
water field — do ship as rasters, resampled to the target grid.

**Version the format from the first write.** `formatVersion` in the manifest, day one.
The lesson is already in this repo: `OSM_QUERY_VERSION` in `demcache.ts` exists because a
cached entry that cannot say what shape it is has to be thrown away rather than migrated.
A pack shipped by someone else cannot be thrown away.

### Not yet

- **npm publishing.** Structure as packages now — that is the part that is expensive to
  retrofit — but consume locally. Publishing is a short job once the boundary is real,
  and with two consumers on one machine a registry is pure friction. Revisit when a third
  consumer appears, or one we do not control.
- **A CI check for the `core` zero-import rule.** A grep over `packages/core/src` for
  `from 'three'` / `from 'react'`. Not because we would do it by accident today, but
  because in six months something will *almost* fit and the rule should be what says no.

---

## Next

### 1. Snow slider on the viewport **(asked)**

A control on the 3D view itself, next to the layer buttons — drag it and watch winter
arrive.

Deliberately **not** a `Settings` field, **not** persisted, and **not** carried in
presets. It is a transient scrub for looking at a place under snow, not a property of
the place. That distinction matters for where the state lives: it should sit in the
viewer, or in the store as a plainly non-persisted field, and must be kept out of
`PERSISTED_SETTINGS`, `settingsSnapshot()` and the preset payload.

Mechanically it wants to drive the snow line down from its climatic value rather than
replace it, so the relationship between the classes present is preserved as it falls.
Note that `snow` is already suppressed by `aridity` in the shader, which is right — the
dry plains hold less snow than the range — so a full-winter setting should still show
the mountains whitening first.

### 2. Push the steppe up against the mountain front, around Denver **(asked)**

The plains immediately east of the Front Range render as continental forest when they
should be steppe — the yellow needs to reach the mountains rather than stopping short
of them, leaving a green band on ground that is grassland.

Worth diagnosing before editing any data. Two candidates, and they call for very
different fixes:

- **The feather is smearing the boundary.** The raster is 0.1° (~9 km at this
  latitude) and `buildBiomeField` blurs by about 0.6 of a cell, so the transition
  spreads over roughly 15 km. The mountain front is far sharper than that in reality.
  If this is the cause, the fix is to modulate the feather by terrain gradient so the
  blur collapses where elevation changes fast — which would fix every mountain front in
  the world, not just this one.
- **The source data genuinely puts the boundary further east.** Then it is a correction
  layer applied at bake time, not an edit to `koppen_0p1.png` itself: the bundled raster
  should stay byte-identical to Beck et al. so it can be re-derived and audited.

Check the raster values along an east–west transect at Denver's latitude against the
elevation profile first. That answers it in one measurement.

### 3. Finish the tree calibration on north-central Texas

The placement is right and the remaining work is tuning. Trees now come off the drainage
field in km² of catchment, frayed fractally, and biased toward dissected ground — and
compared against Esri on the same camera the wooded blocks land in the same places as
the real ones, because both key off the terrain rather than off noise.

Three gaps, in the order worth attacking:

- **Too much of it.** Roughly 45–55% timber against the photograph's 25–30%. The tell is
  the flat ground: the imagery has broad pale fields, and we scatter woodland across
  them. Push **Prefers broken ground** from 0.50 toward 0.7–0.8, and raise **Smallest
  wooded catchment** a little. Both are sliders; no code needed.
- **Too dark.** The woodland reads nearly black where the photograph is a mid grey-green
  sitting close to the fields around it. The conifer constants were darkened for boreal
  spruce during the Front Range calibration and this is broadleaf oak scrub — see the
  colour-space warning in the note below before touching them, and try **Leaf
  saturation**, **Leaf colour** and **Corridor leaf** first.
- **The open ground is too brown**, but that comparison was made with the Grass layer
  switched off, so it was bare ground against pasture. Turn Grass on before judging it.

A caution for whoever picks this up: three separate controls in this area turned out to
have ranges that excluded the values that mattered — the tree threshold's floor, its
ceiling, and tree cover's maximum. When a slider appears to do nothing, check what it can
actually reach before concluding the mechanism is broken. Twice that cost a long detour.

Related, and probably the same root cause as the Denver item above: `Cfa`'s built-in tree
cover of 0.70 is calibrated for the forested US southeast and is wrong for the rangeland
in the same climate class. Köppen classifies climate, not land cover, and cannot separate
them. A per-biome override is the workaround; the real fix is land cover data.

### 4. Darker green for trees **(asked)**

The conifer colour is still not dark enough for boreal forest — and, per the item above,
simultaneously too dark for temperate broadleaf. One constant is being asked to do both,
which suggests the answer is a per-biome pair of endpoints rather than a single palette
pushed one way or the other.

It currently runs `(0.016, 0.022, 0.015)` to `(0.031, 0.040, 0.024)` in linear space,
mottled by the macro noise, already darkened once during the Front Range calibration.

Real closed conifer is about as dark as any natural surface gets: a spruce stand traps
almost everything that lands on it and reflects only a few per cent. So there is room to
push down without becoming unphysical.

Three things to check before simply scaling the numbers, because any of them could be
the actual reason it reads light:

- **The values are linear, not sRGB.** `0.016` linear is roughly `#22` on screen, not
  `#04`. Anything picked from a swatch has to go through `convertSRGBToLinear()` on the
  way in or it will land far lighter than intended — the mistake that cost a long detour
  on the sky palette.
- **`vegSat` and `vegTint` are applied after the mix**, and saturation below 1 pulls the
  colour toward its own luminance, which can lighten as well as flatten. `Dfc` sits at
  `0.80`.
- **Aerial perspective adds +29 to +43 luminance at distance** — see below. If the
  colour is being judged from a wide view, most of what looks too light is fog rather
  than the canopy, and darkening the albedo to compensate will make close-ups too dark.
  The **Haze** layer button switches it off; judge colour with it off, from a close
  camera.

### 5. Fog slider on the viewport **(asked)**

There is now a **Haze** button in the layer stack that switches aerial perspective off
outright. The next step is a continuous control in the same place — drag to set how much
atmosphere sits between you and the ground, without going to the Light tab.

Same shape as the snow scrub: it belongs on the view, next to the layer buttons, where
you can work it while looking at the result. The two will probably want to share a small
"viewport controls" strip rather than each inventing its own placement.

Note it should drive `fogDensity` in `Viewer.tsx` and not the `haze` setting, because
`haze` also tints the sky dome — which is why the on/off switch bypasses the density
rather than zeroing the setting. Whether the slider should move the sky with it is a real
question: physically the two go together, but for judging ground colour you want the air
cleared without the sky changing underneath you.

### 6. Caching **(asked)**

Worth a proper look rather than incremental patching. What exists today:

- **DEM tiles** in IndexedDB (`demcache.ts`), keyed by area and source. This is the one
  that matters most — it is what keeps normal use off the OpenTopography allowance — and
  it appears to be working: the panel reports tens of areas cached and hundreds of MB.
- **Climate normals** in localStorage, keyed to quarter-degree cells.
- **The Köppen raster**, decoded once per session and held in memory.
- **Nothing else.** The hydrology pass, the mesh build and the biome field are all
  recomputed from scratch every time, including on a reload that changes nothing.

The hydrology pass is the expensive one — a priority flood and a flow accumulation over
several million cells — and it re-runs on every rebuild even when the DEM, the routing
resolution and every tuning value are identical. Caching its result against a hash of
(DEM identity + hydrology tuning) would make revisiting an area effectively instant, and
would make the water sliders far less punishing to explore, since returning to a previous
value would be free.

Also worth reviewing: nothing evicts. `cacheClear` is manual, so the store grows without
bound, and there is no check that the browser's storage quota is close to being hit
before a write. A failed write is currently swallowed.

### 7. Mini-map box picking is awkward **(asked)**

Drawing and adjusting the selection needs work. Known rough edges:

- The draw tool is armed by default at start-up, so the first drag on the map draws a
  box instead of panning, which is rarely what is wanted once an area is already loaded.
- A box can only be drawn, never adjusted. There are no edge or corner handles, so
  nudging one side means redrawing the whole thing and losing the framing.
- Panning is disabled outright while armed, so reaching ground off-screen means
  disarming, panning, and re-arming.
- A drag that starts outside the map or ends outside it leaves the tool in a half state.
- There is no way to type or paste a bounding box, which is the fastest way to return to
  an exact area — and the coordinates are already displayed just below, read-only.

Worth doing together rather than piecemeal, since they all touch the same drag handling
in `BoxDrawer`.

### 8. Observed sources — what is left

Roads, mapped water, woodland and built-up land all come from one OpenStreetMap query
(`overpass.ts` → `roadmask.ts`, rasterised in a worker). The pattern is settled: fetch on
demand, cache by box in IndexedDB behind a query version, rasterise into RGBA fields, and
expose a three-state status so "nothing mapped here" stays distinguishable from "the
request failed". What remains:

- **River gating.** Keep the MFD accumulation — it is what the riparian and tree work read,
  and it is continuous where real data is patchy — but use OSM waterways or HydroRIVERS to
  decide which of those channels actually carry water. That kills the phantom rivers in dry
  country without giving up the field. Touches vegetation, so it needs re-tuning after.
  The area pipeline already fetches `waterway=riverbank`; what is missing is the
  centreline query and the gating itself.
- **ESA WorldCover calibration** (10 m, CC BY). *Not* to draw the trees — to calibrate the
  model that draws them. Read the observed tree-cover fraction for the box and solve for
  the `treeNeed` that reproduces it, per biome. The timber stays generated, so it remains
  continuous, drainage-anchored and slider-driven; it is simply pinned to reality instead
  of to a guess. Needs only a coarse histogram, not a full-resolution raster, and
  `geotiff` is already a dependency so a windowed COG range read costs no new packages.

  This is what fixes the thing that showed up in testing: Köppen puts the Oregon Coast
  Range in `Csb`, the same class as Mediterranean maquis, so it renders bare until the
  timber is dialled in by hand. Observed cover would separate them without touching the
  classification.
- **Holes in area polygons.** Inner rings are dropped, so a lake with an island is solid
  water and a forest with a clearing is unbroken forest. Needs even-odd fill across a
  ring *set* rather than one ring at a time.

Two things the road work proved and the rest should reuse: the masks project exactly
(checked against Esri imagery over Boulder at 2.3 km across — every street on its line),
and the road class filter has to scale with box size, because below about one mask pixel a
road stops being a line and becomes a smear. Areas do not need that filter — a lake stays
legible at any scale precisely because shrinking the box does not make it thinner.

### 9. Roads: what is not done yet

- **Roads do not affect the mesh.** A real road is cut and graded — a bench on a hillside,
  a causeway across a flat. Ours drapes over whatever the DEM says, so on steep ground it
  rides the contours instead of cutting them. Would need the mask fed back into the mesh
  builder, which is where TOC's carved-channel problem also lands.
- **No bridges or tunnels.** OSM tags both (`bridge=yes`, `tunnel=yes`) and we ignore
  them, so a road crosses a river by being painted onto the water, and a tunnel is drawn
  across the top of the ridge it goes through. The tags are already in the response.
- **Junctions bloom.** Overlapping strokes accumulate in the verge channel because the
  pass composites additively, so a dense interchange clears more ground than it should.
- **No settlement layer.** OSM has building footprints and `landuse` from the same query.
  Towns currently show only as a mesh of minor roads with nothing between them.
- **No individual buildings.** Land-use polygons say where the town is; they cannot give
  it height, so a town reads correctly from above and stays flat from the ground.
  Footprints would need extrusion into instanced geometry — the first thing here that is
  not a field — and OSM carries a usable `height` or `building:levels` on only a minority
  of them. Worth it only once there is a reason to be standing in the street.

---

## Known issues

### Montane/plains transition reads as closed forest

Measured against Esri imagery on a Front Range tile, the transition band comes out at
`warm −16` where reality is `−5` — the one band that neither the aridity hue shift nor
the per-biome colour moved. It is rendering as continuous forest where the ground is
actually a mosaic of forest, park and grassland.

This is a cover-*mix* problem, not a colour one. Likely wants tree cover to break up
with slope aspect or a second noise octave rather than sitting near-constant across the
belt. Probably the same underlying cause as item 2 above.

### Aerial perspective dominates at distance

At a 200 km viewing distance the fog term contributes **+29 to +43 luminance**, roughly
45% of every pixel. It compresses the difference between everything and made ground
cover look ~17 too bright when the albedo was in fact slightly too dark.

Two consequences: wide tiles look washed out, and any future colour calibration must be
done from a close camera or the signal is swamped. Fixing it is a lighting change, not a
biome one.

### Vegetation colour is tile-wide, not per-texel

`vegTint` and `vegSat` resolve once from the dominant class, because the biome field's
four channels are full (aridity, riparian, ground warmth, tree cover). A box spanning
two very different greens — boreal beside steppe — gets one compromise.

The upgrade is a second RGBA field texture, which is cheap (~256 KB per tile, and the
bake already exists). Worth doing only if the tile-wide approximation proves visibly
wrong in use.

### Water layering against the biome cover

Raised and then set aside. Rivers wash out where riparian growth is painted *in* the
channel rather than beside it, and the dark forest colour now goes down underneath the
water. Water composites last so draw order is fine; the fix is to compute coverage
before the ground cover and exclude its footprint from vegetation.

### Rivers do not follow their paths exactly

Long-standing, deferred. Separate from the biome work.

---

## Before this is deployed anywhere

- **Attribution.** `public/koppen_0p1.png` is derived from Beck et al. (2023) under
  CC BY 4.0. The citation currently lives only in a comment at the top of
  `src/lib/koppen.ts`. The licence requires it to be visible to users, so it needs to
  reach the UI — the footer alongside the OpenTopography and Esri credits is the
  obvious place.
- **`public/` must ship.** The Köppen raster is a runtime asset; without it the biome
  system silently degrades to no classification at all.
- **`.env`** holds `VITE_OPENTOPO_KEY` and is gitignored. The dev proxy appends it
  server-side so it never reaches the browser. Any deployment needs its own equivalent.

---

## Unexplained

- `riverThreshold` has been observed at `0.75` with no code path that writes it. Never
  chased down. Low priority, but it means something is setting it that we have not
  found.
