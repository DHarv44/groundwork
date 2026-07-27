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

### 3. Concentrate trees around water **(asked)**

Riparian corridors currently add *cover*, not *trees*. In the shader, `riparian` raises
`veg` along the drainage, but `canopy` — the share of that cover which is trees — is a
function of `forest`, slope and the tree line only. Drainage never enters it. So a
corridor comes out as more of whatever mix the biome already had, at the same
grass-to-tree ratio as the dry ground either side.

That is backwards for the case that matters most. A prairie creek is a line of
cottonwoods through grassland; a savanna watercourse is gallery forest through open
country. In dry places the water is very often the *only* thing holding trees, and the
contrast between the ribbon and its surroundings is almost entirely a difference in tree
cover, not in how much green there is.

The fix is to let accumulated drainage raise `canopy` directly, not just `veg`, and to
scale that by aridity the way the existing riparian term already is — strongest where it
is dry, vanishing in a rainforest where the corridor is invisible because everything
either side is already closed canopy.

Two things to watch. Trees should thin out approaching the channel itself rather than
growing in it, so the profile wants to peak *beside* the water rather than on it — which
overlaps with the water-layering item below and is probably worth doing in the same pass.
And the corridor must still respect the tree line: a drainage above it should stay
treeless however much water runs down it.

### 4. Darker green for trees **(asked)**

The conifer colour is still not dark enough. It currently runs
`(0.016, 0.022, 0.015)` to `(0.031, 0.040, 0.024)` in linear space, mottled by the macro
noise, and was already darkened once during the Front Range calibration — it needs to go
further.

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

Worth confirming from a close camera first, then adjusting the constants, rather than
tuning against a washed-out wide shot.

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
