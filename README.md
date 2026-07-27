# Groundwork

Pick a box on a world map and see what is actually there.

Real elevation comes from [OpenTopography](https://opentopography.org) or AWS Terrain
Tiles. Everything else on screen — the rivers, the lakes, the climate, the trees — is
**derived from that elevation and from published data**, not painted on. Nothing is
hand-authored per location, so any box anywhere on Earth renders from the same rules.

```bash
npm install
npm run dev      # http://localhost:5190
```

## How it works

1. **Pick an area** — drag a box on the map, choose a place from the dropdown, or search.
2. **Pick a DEM** — AWS Terrain Tiles (keyless, uncapped) or, through OpenTopography,
   Copernicus GLO-30/90, NASADEM, SRTM, ALOS World 3D, EU DTM, or the bathymetry-carrying
   SRTM15+ / GEBCO sets.
3. **Build** — the tiles are decoded, void-filled and turned into a mesh laid out in
   **real metres** — X east, Z south, Y up — so at 1.0× exaggeration the geometry is the
   true shape of the ground.

## What gets derived

**Hydrology.** A priority-flood depression fill, multiple-flow-direction accumulation,
then channels wherever drainage area crosses a threshold, widened by hydraulic geometry.
Lakes are found separately: DEMs record the water *surface*, and products like Copernicus
GLO-30 hydro-flatten inland water to an exactly constant value, so a connected flat region
is a very specific signal for standing water.

**Climate.** A bundled Köppen–Geiger raster classifies the box instantly and offline.
Temperature and rainfall normals come from ERA5 via Open-Meteo, but only to label the
panel — the classification never waits on the network.

**Biomes.** A box that spans a mountain front is several climates at once, so the classes
present are baked into a field over the tile and blended. Twelve surface settings belong
to the biome and are stored against its Köppen code, so a value tuned in one steppe tile
comes back in the next one. Presets carry the whole table.

**Trees.** Placed from the drainage field in km² of catchment, the same units the rivers
use, as a band that rises as a gully gathers water and falls away once the channel is too
wide for a canopy to close over. Frayed fractally so woodland runs up the side gullies,
and biased toward dissected ground — because broken country is too steep to plough, so it
kept its trees while the flat ground beside it was cleared.

Snow and tree lines stay global: they are altitude physics rather than ecology. They come
from a latitude curve corrected for how continental the classes present are, since that
curve is calibrated to maritime ranges and a continental interior runs a third higher on
the same parallel.

## Rendering

A custom shader rather than a stock material:

- **Analytic normals** from the DEM at source resolution, so shading stays sharp even
  when the mesh is decimated.
- **Ray-marched sun shadows** against the height field, with a penumbra that widens with
  distance.
- **Height-field ambient occlusion** so gullies darken correctly.
- **Procedural ground cover** — rock, scree, soil, grass, timber, sand, snow, shoreline
  and sedimentary strata banding, blended by altitude, slope, drainage and biome.
- **Satellite drape** as an alternative — Esri World Imagery reprojected from Web
  Mercator into the DEM's grid. The cover controls keep working underneath it, so you can
  flip between the two and match them.
- **Aerial perspective** sharing one colour model with the sky dome. It contributes a lot
  at distance, so the **Haze** layer button switches it off when you need to judge the
  ground's true colour.

All colours are authored in **linear** space and the scene is ACES tone-mapped. Anything
picked from a swatch must be converted with `convertSRGBToLinear()` on the way in.

## Exports

| Format | Notes |
| --- | --- |
| Screenshot | PNG of the current view |
| Heightmap | 16-bit elevation packed across red and green — decode as `min + (R*256 + G)/65535 * (max-min)`, range in the filename |
| STL | Watertight solid, metres, ready to 3D print |
| glTF | Binary `.glb`, metres |

The mesh is closed into a solid: skirt walls drop from the terrain edge to a capped
plinth. That is what makes the STL printable, and it stops you seeing under the tile when
the camera drops low.

## API key

The OpenTopography key lives in `.env` as `VITE_OPENTOPO_KEY`. The Vite proxy appends it
server-side, so it never reaches the browser. Satellite tiles are proxied too, which keeps
the composited canvas untainted.

AWS Terrain Tiles need no key and have no daily cap, which is why they are the default.

## Notes

- Each OpenTopography set has a per-request area cap and a latitude range; both are
  checked before the request goes out. SRTM-derived sets only cover 56°S – 60°N.
- DEM tiles are cached in IndexedDB, so revisiting an area costs no API call.
- In dev, `window.__terrain` exposes the store and `window.__viewer` exposes
  `{ gl, scene, camera }`.

See [ROADMAP.md](ROADMAP.md) for what is unfinished.

## Attribution

- Elevation © [OpenTopography](https://opentopography.org) and AWS Terrain Tiles
- Basemap © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
- Imagery © Esri
- Climate normals from [Open-Meteo](https://open-meteo.com) (ERA5)
- `public/koppen_0p1.png` is derived from Beck, H. E., T. R. McVicar, N. Vergopolan,
  A. Berg, N. J. Lutsko, A. Dufour, Z. Zeng, X. Jiang, A. I. J. M. van Dijk, and
  D. G. Miralles, *High-resolution (1 km) Köppen-Geiger maps for 1901–2099 based on
  constrained CMIP6 projections*, **Scientific Data 10, 724 (2023)** — used under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), resampled to 0.1°.
