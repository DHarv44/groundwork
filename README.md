# Terrain Builder

Draw a box on a world map, pull the real elevation data for it from
[OpenTopography](https://opentopography.org), and render it as 3D terrain in three.js.

```bash
npm install
npm run dev      # http://localhost:5190
```

## How it works

1. **Pick an area** — drag a box on the Leaflet map, use a preset, or search for a place.
2. **Pick a DEM** — Copernicus GLO-30, NASADEM, SRTM, ALOS World 3D, EU DTM, or the
   bathymetry-carrying SRTM15+ / GEBCO sets.
3. **Build** — a GeoTIFF comes back from OpenTopography's `globaldem` API, is decoded
   with `geotiff.js`, void-filled, and turned into a mesh.

The mesh is laid out in **real metres** — X east, Z south, Y up — so at exaggeration
1.0× the geometry is the true shape of the ground.

## Rendering

The terrain uses a custom shader rather than a stock material:

- **Analytic normals** derived from the DEM at source resolution, so shading stays sharp
  even when the mesh is decimated.
- **Ray-marched sun shadows** against the height field — real cast shadows from ridges
  into valleys, with a penumbra that widens with distance.
- **Height-field ambient occlusion** so gullies and valleys darken correctly.
- **Procedural ground cover** blended by altitude, slope and noise: rock, scree, soil,
  vegetation, sand, snow and shoreline, plus sedimentary strata banding. Snow and tree
  lines default to climatic values for the box's latitude — not to its elevation range,
  which would put snowfields on lowland farmland.
- **Satellite drape** as an alternative to procedural — Esri World Imagery, reprojected
  from Web Mercator into the DEM's lat/lon grid so it lines up with the relief.
- **Aerial perspective** sharing one colour model with the sky dome, so distant ridges
  dissolve into the sky instead of sitting on top of it.
- **Water** at sea level, with depth-graded colour and a shoreline surf line. Land-only
  DEMs record the sea as exactly 0 m, so depth there is inferred from how much dry land
  surrounds each point.

All colours are authored in sRGB and converted once to linear; the scene is ACES
tone-mapped.

## Exports

| Format | Notes |
| --- | --- |
| Screenshot | PNG of the current view |
| Heightmap | 16-bit elevation packed across the red and green channels — decode as `min + (R*256 + G)/65535 * (max-min)`, range in the filename |
| STL | Watertight solid, metres, ready to 3D print |
| glTF | Binary `.glb`, metres |

The mesh is closed into a solid: skirt walls drop from the terrain edge to a plinth with
a capped base. That is what makes the STL printable, and it stops you seeing the void
under the tile when the camera drops low.

## API key

The OpenTopography key lives in `.env` as `VITE_OPENTOPO_KEY`. In dev, the Vite proxy in
`vite.config.ts` appends it server-side, so the key never reaches the browser. Satellite
tiles are proxied too, which keeps the composited canvas untainted.

## Notes

- Each DEM has a per-request area cap (450,000 km² for the 30 m sets, 4,050,000 km² for
  the 90 m ones) and a latitude range; both are checked before the request goes out.
- SRTM-derived sets only cover 56°S – 60°N. Copernicus and ALOS are global.
- In dev, `window.__terrain` exposes the zustand store and `window.__viewer` exposes
  `{ gl, scene, camera }`.

Elevation data © OpenTopography · basemap © OpenStreetMap · imagery © Esri
