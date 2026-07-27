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
