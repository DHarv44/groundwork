# Roadmap

Working notes on what is outstanding. Items marked **(asked)** came from a direct
request; the rest are things measurement turned up along the way.

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

### 8. Observed sources beyond roads

Roads (OpenStreetMap via Overpass, `overpass.ts` → `roadmask.ts`) are the first layer here
that is *measured* rather than derived, and they establish the pattern: fetch on demand,
cache by box in IndexedDB, rasterise into an RGBA field, expose a three-state fetch status
so "nothing mapped here" stays distinguishable from "the request failed". The same shape
fits the rest of what was discussed:

- **Lakes from OSM** (`natural=water`). Depression-fill lakes are a guess; these are
  surveyed polygons. Small job, and it replaces a guess with a fact.
- **River gating.** Keep the MFD accumulation — it is what the riparian and tree work read,
  and it is continuous where real data is patchy — but use OSM or HydroRIVERS to decide
  which of those channels actually carry water. That kills the phantom rivers in dry
  country without giving up the field. Touches vegetation, so it needs re-tuning after.
- **ESA WorldCover** (10 m, CC BY): tree cover, grassland, cropland, built-up, bare,
  water. Essentially the whole field set currently derived from Köppen plus noise.
  **Not** a small decision — it changes Groundwork from simulating a landscape to
  rendering a measured one, and the cover sliders become corrections rather than a model.
  Discuss before building.

Two things the road work already proved out and the rest should reuse: the mask projects
exactly (checked against Esri imagery over Boulder at 2.3 km across — every street on its
line), and the class filter has to scale with box size, because below about one mask pixel
a road stops being a line and becomes a smear.

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
- **The mask is rasterised on the main thread**, around 280 ms for a city-sized network
  (57k ways over Denver). Fine behind the debounce, but it is a visible hitch when the
  width or verge slider settles, and it will get worse when buildings and landuse land.
  Belongs in a worker with `OffscreenCanvas` — the hydrology pass already sets the
  pattern. Worth doing *before* adding more vector layers, not after.

  Three things already took this down from 1.5 s, and they are the reason it is not
  worse: the projected geometry is cached against the network so slider drags never
  reproject; vertices closer together than one mask pixel are dropped, which OSM has a
  great many of; and the verge is one stroke through a blur rather than a stack of
  concentric strokes. The remaining cost is canvas stroke tessellation and there is no
  more to win on the main thread.

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
