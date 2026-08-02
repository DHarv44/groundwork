export const terrainVertexShader = /* glsl */ `
uniform float uExag;

attribute float side;

varying vec2 vUv;
varying vec3 vWorldPos;
varying float vElev;
varying vec3 vBaseNormal;
varying float vSide;

void main() {
  vUv = uv;
  vBaseNormal = normal;
  vSide = side;
  vElev = position.y / max(uExag, 1e-5);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

export const terrainFragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D uNormalMap;
uniform sampler2D uHeightMap;
uniform sampler2D uSatMap;
uniform sampler2D uWaterMap;  // R = coverage, G = lake flag, B = log drainage area

uniform float uHasWater;
uniform float uRivers;        // master opacity for derived water
uniform float uRiverThreshold;
uniform float uShowRivers;
uniform float uShowLakes;
uniform float uDrainageView;  // 1 = render the catchment network instead of ground
uniform float uTime;
uniform float uWaveHeight;

uniform float uUseSat;        // 0 = procedural, 1 = satellite drape
uniform float uSatDetail;     // how much procedural micro-detail survives under imagery
uniform float uSatOpacity;    // how solidly imagery covers the procedural ground, 0-1
// The imagery clipmap: up to three nested rings centred under the camera, each
// roughly 4x the area and a step coarser than the one inside it, with the base
// drape as the outermost fallback. Sampled coarse to fine, so every fragment takes
// the sharpest ring that covers it — which is how texels-per-screen-pixel stays
// near constant from your feet to the horizon, the same law the big map renderers
// enforce with tile quadtrees. Fade ramps each ring in as it (re)arrives.
uniform sampler2D uSatRing0Map;
uniform vec4 uSatRing0Rect;   // terrain UV: xy = NW corner, zw = SE
uniform float uSatRing0Fade;  // 0 absent, ramping to 1 as the ring lands
uniform sampler2D uSatRing1Map;
uniform vec4 uSatRing1Rect;
uniform float uSatRing1Fade;
uniform sampler2D uSatRing2Map;
uniform vec4 uSatRing2Rect;
uniform float uSatRing2Fade;
uniform sampler2D uSatRing3Map;
uniform vec4 uSatRing3Rect;
uniform float uSatRing3Fade;

uniform float uMinElev;
uniform float uMaxElev;
uniform float uExag;
uniform float uWidthM;
uniform float uDepthM;

uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform vec3  uHorizonColor;
uniform vec3  uGroundTint;

uniform float uSnowLine;
uniform float uTreeLine;
uniform float uAridity;
uniform float uStrata;
uniform float uRiparian;       // how strongly vegetation follows the drainage
uniform float uRiparianReach;  // how far up the drainage scale corridors extend
uniform float uGroundWarmth;   // shift bare ground toward oxidised rust
uniform float uForest;         // how much of the cover is trees rather than grass
uniform float uVegTint;        // which green: -1 blue-shifted, +1 yellow-shifted
uniform float uVegSat;         // how saturated that green is
uniform float uTreeNeed;       // catchment a slope must gather before it holds timber, km²
uniform float uTreeLimit;      // catchment past which the channel is too wide for trees, km²
uniform float uTreeSpread;     // how sharply timber gives way to grass across both edges
uniform float uTreeFractal;    // how raggedly the timber fingers out of the drainage
uniform float uTreeRough;      // how strongly timber prefers dissected ground to flat
uniform float uTreeRoughScale; // local relief, in metres, that counts as fully broken
uniform float uCorridorLeaf;   // how broadleaf the valley-bottom timber is
uniform float uShowTrees;      // 0 hides the canopy, leaving grass on the same ground
uniform float uShowGrass;      // 0 hides the grass, leaving only the timber
uniform float uShowSnow;       // 0 hides the snow entirely
uniform float uTextureRange;   // scales how far surface detail survives
// Biomes baked over the tile: aridity, riparian, ground warmth and corridor reach, one
// per channel. Sampling it replaces the four scalars above wherever it is present —
// linear filtering blends between neighbouring classes for free.
uniform sampler2D uBiomeMap;
uniform float uHasBiomeMap;
// Roads: R surface, G class (order/4), B cleared corridor. Observed data, not derived —
// see lib/overpass.ts.
uniform sampler2D uRoadMap;
uniform float uHasRoads;
uniform float uShowRoads;
uniform float uRoadDarkness;
uniform float uRoadClearing;   // how strongly the corridor takes the timber back
uniform float uRoadTint;       // 0 metalled grey, 1 the local ground scraped bare
uniform float uRoadShoulder;   // corridor band brightened so the dark surface reads
// Mapped areas: R water, G woodland, B built-up. Surveyed ground, so where it disagrees
// with what was derived from the DEM it is generally the derivation that is wrong.
uniform sampler2D uAreaMap;
uniform float uHasAreas;
uniform float uOsmWater;       // how completely a mapped lake overrides the guess
uniform float uOsmWood;        // how far mapped woodland pulls the canopy toward it
uniform float uOsmBuilt;       // how strongly built-up land greys and clears the ground
uniform float uShadows;
uniform float uAoStrength;
uniform float uDetail;
uniform float uFogDensity;
uniform float uSeaLevel;

varying vec2 vUv;
varying vec3 vWorldPos;
varying float vElev;
varying vec3 vBaseNormal;
varying float vSide;

// ---------- noise ----------

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
}

float gnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(dot(hash2(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)),
        dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
    mix(dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
        dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x),
    u.y);
}

float fbm(vec2 p, const int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * gnoise(p);
    p = rot * p * 2.03;
    amp *= 0.5;
  }
  return sum;
}

// Ridged variant — reads as eroded rock rather than soft hills.
float ridged(vec2 p, const int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * (1.0 - abs(gnoise(p)) * 2.0);
    p = rot * p * 2.11;
    amp *= 0.5;
  }
  return sum;
}

// ---------- terrain field sampling ----------

vec2 worldToUv(vec3 p) {
  return vec2(p.x / uWidthM + 0.5, p.z / uDepthM + 0.5);
}

float terrainY(vec2 uvp) {
  float t = texture2D(uHeightMap, uvp).r;
  return (uMinElev + t * (uMaxElev - uMinElev)) * uExag;
}

/**
 * Ray-march the height field toward the sun. This is what sells the relief: real
 * cast shadows from ridges onto valleys, with a penumbra that widens with distance.
 */
float sunShadow(vec3 origin, vec3 L) {
  if (uShadows < 0.5) return 1.0;
  if (L.y <= 0.015) return 0.0;

  const int STEPS = 40;
  float span = max(uWidthM, uDepthM) * 0.55;
  float bias = max(uWidthM, uDepthM) * 0.0012 + 1.5;
  float shadow = 1.0;
  float t = span * 0.004;

  for (int i = 0; i < STEPS; i++) {
    vec3 p = origin + L * t;
    vec2 suv = worldToUv(p);
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
    float h = terrainY(suv);
    float above = (p.y + bias) - h;
    if (above < 0.0) return 0.0;
    shadow = min(shadow, above * 14.0 / t);
    // Geometric step growth: dense near the surface, coarse far away.
    t += span * 0.006 + t * 0.14;
    if (t > span) break;
  }
  return clamp(shadow, 0.0, 1.0);
}

/**
 * Local relief: how far the ground rises and falls within a short distance, in metres.
 *
 * This is the difference between flat country and dissected country, and catchment
 * cannot see it — a ploughed field and an eroded block of breaks can carry identical
 * drainage. What separates them is that one is smooth and the other is cut to pieces.
 *
 * Measured against the true height field rather than the exaggerated one, so a display
 * setting cannot change where the trees grow.
 */
float localRelief(vec2 uvp) {
  float lo = 1e9;
  float hi = -1e9;
  // A ring at roughly half a kilometre — the scale at which breaks read as broken.
  float radius = 500.0 / max(uWidthM, uDepthM);
  for (int d = 0; d < 6; d++) {
    float a = float(d) * 1.0471976;
    vec2 suv = clamp(uvp + vec2(cos(a), sin(a)) * radius, vec2(0.0), vec2(1.0));
    float h = terrainY(suv) / max(uExag, 1e-5);
    lo = min(lo, h);
    hi = max(hi, h);
  }
  return hi - lo;
}

/** Cheap horizon-based occlusion — valleys and gullies darken, ridges stay bright. */
float terrainAO(vec2 uvp, float y) {
  float occ = 0.0;
  float total = 0.0;
  for (int r = 0; r < 3; r++) {
    float radius = 0.006 * pow(3.2, float(r));
    float metres = radius * max(uWidthM, uDepthM);
    for (int d = 0; d < 6; d++) {
      float a = float(d) * 1.0471976 + float(r) * 0.4;
      vec2 off = vec2(cos(a), sin(a)) * radius;
      vec2 suv = clamp(uvp + off, vec2(0.0), vec2(1.0));
      float dh = terrainY(suv) - y;
      occ += clamp(dh / max(metres, 1.0), 0.0, 1.0);
      total += 1.0;
    }
  }
  return clamp(1.0 - (occ / total) * 1.7 * uAoStrength, 0.0, 1.0);
}

/**
 * Push a vegetation colour toward the green this biome actually is.
 *
 * Green is held fixed and the red and blue ends are swung against each other, which
 * moves the hue between blue-green and yellow-green without touching how bright the
 * cover reads — brightness is already the job of tree cover and aridity, and folding it
 * in here would make the two controls fight.
 */
vec3 vegTone(vec3 c, float tint, float sat) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, sat);
  c.r *= 1.0 + 0.55 * tint;
  c.b *= 1.0 - 0.45 * tint;
  return max(c, vec3(0.0));
}

vec3 srgbToLinear(vec3 c) {
  return pow(c, vec3(2.2));
}

void main() {
  vec3 n = texture2D(uNormalMap, vUv).rgb * 2.0 - 1.0;
  n = normalize(length(n) > 0.1 ? n : vBaseNormal);

  vec3 viewVec = cameraPosition - vWorldPos;
  float dist = length(viewVec);
  vec3 V = viewVec / max(dist, 1e-4);

  // ---- micro relief -------------------------------------------------------
  // Fades out with distance so it never aliases into shimmer. Fades out with
  // imagery opacity too: this bump lights BOTH ground modes, and over a solid
  // satellite drape it read as identical speckle in Terrain and Satellite —
  // the photograph already carries its own micro-shading, so relighting it
  // with procedural bumps double-shades. It returns as the drape thins.
  vec2 wp = vWorldPos.xz;
  float detailFade = uDetail * (1.0 - smoothstep(400.0, 4000.0, dist)) * (1.0 - uUseSat * uSatOpacity);
  float e = 1.2;
  float nA = fbm(wp * 0.35, 4);
  float nX = fbm((wp + vec2(e, 0.0)) * 0.35, 4);
  float nZ = fbm((wp + vec2(0.0, e)) * 0.35, 4);
  vec3 microN = normalize(vec3(-(nX - nA) * 14.0, 1.0, -(nZ - nA) * 14.0));
  vec3 N = normalize(mix(n, normalize(n + microN * 0.9), detailFade));

  float slope = 1.0 - clamp(n.y, 0.0, 1.0);
  float steep = smoothstep(0.10, 0.42, slope);
  float cliff = smoothstep(0.34, 0.72, slope);

  // ---- procedural ground cover -------------------------------------------
  // Each octave is faded out once a pixel covers more ground than its wavelength,
  // otherwise the fine detail turns to static on wide, low-relief areas.
  // Detail fades out once a pixel covers more ground than the feature is wide, which
  // is what stops it aliasing. On a wide box the camera sits tens of kilometres back
  // and every term reaches zero, leaving a flat sheet — so the range is scalable
  // rather than fixed. Pushing it out trades shimmer for texture.
  float texRange = max(0.05, uTextureRange);
  float rockFade = 1.0 - smoothstep(2500.0 * texRange, 18000.0 * texRange, dist);
  float grainFade = 1.0 - smoothstep(300.0 * texRange, 3000.0 * texRange, dist);
  float macro = fbm(wp * 0.0009, 5);
  float meso = fbm(wp * 0.011, 4);
  float rock = ridged(wp * 0.06, 4) * rockFade;
  float grain = fbm(wp * 0.6, 3) * grainFade;

  // Resolve the biome parameters for this point. One tile can span several climates —
  // a box across a mountain front is steppe on the plains and forest a thousand metres
  // up — so these are a field over the tile, not four constants. The sliders stand for
  // the dominant class; editing one rebakes the field for that class alone.
  //
  // Resolved before the palette because the palette depends on it: how green the ground
  // is, not just how much of it is covered, is a function of how dry the place is.
  float aridity = clamp(uAridity, 0.0, 1.0);
  float riparianAmt = uRiparian;
  float groundWarmth = uGroundWarmth;
  float forest = clamp(uForest, 0.0, 2.0);
  // Corridor reach stays tile-wide: it barely varies between classes, so it does not
  // earn one of the four channels.
  float riparianReach = uRiparianReach;
  if (uHasBiomeMap > 0.5) {
    vec4 bio = texture2D(uBiomeMap, vUv);
    aridity = bio.r;
    riparianAmt = bio.g;
    // Warmth runs past 1, so the channel holds it scaled — see GROUND_WARMTH_MAX.
    groundWarmth = bio.b * 2.0;
    // Likewise scaled — see FOREST_MAX.
    forest = bio.a * 2.0;
  }
  // Used two ways below: as a fraction where a share of the ground is meant, and raw
  // where it shifts the threshold, which is what lets it run past 1.
  float forestFrac = clamp(forest, 0.0, 1.0);

  // Roads are resolved here, well before anything is painted, because the corridor has
  // to reach the vegetation: what makes a road read as cut through the country rather
  // than drawn on top of it is the timber standing back from it.
  float roadSurface = 0.0;
  float roadCorridor = 0.0;
  float roadVerge = 0.0;
  float roadClass = 0.0;
  if (uHasRoads > 0.5 && uShowRoads > 0.5 && vSide < 0.5) {
    vec4 rm = texture2D(uRoadMap, vUv);
    roadSurface = rm.r;
    roadClass = rm.g;
    // The mask ramps the corridor outward in steps; this feathers across them so the
    // clearing thins into the woods instead of ending on a line. The raw band is kept
    // separately from the timber-clearing strength: the shoulder brightening below
    // wants the band itself, not the band scaled by how hard it fells trees.
    roadVerge = smoothstep(0.04, 0.75, rm.b);
    roadCorridor = roadVerge * uRoadClearing;
  }

  // Mapped ground, resolved alongside the roads and for the same reason — woodland and
  // built-up land both have to reach the vegetation, which is computed further down.
  float osmWater = 0.0;
  float osmWood = 0.0;
  float osmBuilt = 0.0;
  if (uHasAreas > 0.5 && vSide < 0.5) {
    vec4 am = texture2D(uAreaMap, vUv);
    osmWater = am.r * uOsmWater;
    osmWood = am.g * uOsmWood;
    osmBuilt = am.b * uOsmBuilt;
  }

  // Linear-space albedos in the range real ground actually occupies: rock sits around
  // 0.15–0.30, vegetation lower still, only snow gets close to 0.8.
  vec3 rockDark  = vec3(0.088, 0.079, 0.071);
  vec3 rockLight = vec3(0.255, 0.235, 0.212);
  vec3 scree     = vec3(0.205, 0.192, 0.176);
  vec3 soil      = vec3(0.115, 0.086, 0.055);
  // Grass is not one colour. It is green where there is water and straw where there is
  // not — a dry grassland is dead for most of the year, so drought is a change of hue,
  // not merely less cover. Rendering steppe as sparse green is why the plains only read
  // as dry once ground warmth is cranked up to compensate, which is a hue problem being
  // papered over by a brightness control.
  //
  // Aridity already carries the signal, per texel, so this costs nothing.
  // Not "patch" — that is a reserved word in GLSL and the whole shader fails to build.
  float mottle = clamp(macro + 0.5, 0.0, 1.0);
  float parch = smoothstep(0.18, 0.82, aridity);
  // The ends of this ramp were both overshot, in opposite directions — measured against
  // Esri imagery with haze off, arid rangeland rendered about 15 too bright and humid
  // grassland about 13 too dark. Green country is not dark; a watered pasture reflects
  // a good deal more than a parched one absorbs. So the wet end comes up and the dry end
  // comes down, which narrows the range without touching the hue shift between them.
  vec3 grassWet = mix(vec3(0.068, 0.108, 0.038), vec3(0.170, 0.198, 0.082), mottle);
  vec3 grassDry = mix(vec3(0.112, 0.093, 0.043), vec3(0.188, 0.164, 0.084), mottle);
  vec3 grassCol = vegTone(mix(grassWet, grassDry, parch), uVegTint, uVegSat);

  // Closed conifer canopy. Far darker than grass and barely green — a spruce stand
  // reflects only a few per cent of what hits it. Dry-country woodland is greyer and
  // more olive than boreal forest, but nothing like as bleached as the grass beneath
  // it: a tree reaches water the turf cannot, so it stays in leaf through the drought.
  vec3 coniferWet = mix(vec3(0.016, 0.022, 0.015), vec3(0.031, 0.040, 0.024), mottle);
  vec3 coniferDry = mix(vec3(0.026, 0.028, 0.018), vec3(0.050, 0.052, 0.032), mottle);
  vec3 conifer = vegTone(mix(coniferWet, coniferDry, parch), uVegTint, uVegSat);
  vec3 sandCol   = vec3(0.340, 0.288, 0.196);
  vec3 snowCol   = vec3(0.760, 0.795, 0.850);

  vec3 albedo = mix(rockDark, rockLight, clamp(rock * 0.6 + meso * 0.5 + 0.5, 0.0, 1.0));
  albedo = mix(albedo, scree, cliff * 0.35);
  albedo *= mix(1.0, 0.86 + 0.28 * (grain * 0.5 + 0.5), grainFade);

  // Sedimentary strata. Bands follow absolute elevation — warped a little so they do
  // not read as perfect contours — and show most strongly on exposed rock faces.
  if (uStrata > 0.01) {
    float bandCoord = vElev * 0.035 + fbm(wp * 0.0018, 3) * 1.6;
    float bandId = floor(bandCoord);
    float pick = fract(sin(bandId * 12.9898) * 43758.5453);
    vec3 ironRed  = vec3(0.128, 0.058, 0.032);
    vec3 sandBuff = vec3(0.196, 0.145, 0.090);
    vec3 grayShale = vec3(0.105, 0.098, 0.090);
    vec3 strataCol = mix(ironRed, sandBuff, smoothstep(0.30, 0.55, pick));
    strataCol = mix(strataCol, grayShale, smoothstep(0.72, 0.88, pick));
    // Soften the seam between one bed and the next.
    float seam = abs(fract(bandCoord) - 0.5) * 2.0;
    strataCol *= 0.88 + 0.24 * seam;
    albedo = mix(albedo, strataCol, uStrata * (0.35 + 0.65 * cliff));
  }

  // Soil and vegetation collect below the tree line.
  //
  // How much the ground has to level off before cover takes hold depends on what the
  // cover is. Meadow needs gentle ground and gives way to scree early; forest does not
  // — a conifer slope stays closed well past the angle at which grass has gone. Using
  // one slope limit for both treats every mountainside as bare rock, which is precisely
  // backwards for a forested range and was leaving the Rockies rendered as scree.
  float wetness = 1.0 - aridity;

  // ---- where the trees are ------------------------------------------------
  //
  // Trees are placed from the drainage field — the same flow accumulation the rivers
  // come from — rather than scattered by noise and then nudged toward water. That is
  // the actual pattern on the ground: satellite imagery of anywhere short of rainforest
  // shows timber threading the valleys while the interfluves stay open, because trees
  // grow where water collects. Noise can only ever approximate that by accident, and it
  // reads as static rather than landscape.
  //
  // Everything that is not tree is grass.
  //
  // Tree cover moves the threshold; it is not a floor added underneath. Every tree in
  // the tile follows the drainage, at every setting — what the biome changes is how
  // little catchment a piece of ground needs before it qualifies. A rainforest asks for
  // almost none, so the network fills out until it closes over; a steppe asks for a lot,
  // so only the valley floors hold timber. The pattern is always the catchment.
  //
  // Adding a floor instead washes the whole thing out: at a temperate 0.7 it puts timber
  // on seven tenths of the ground before the water is consulted at all, and the network
  // disappears into it. That is the difference between this and scattering trees.
  //
  // And it is a band, not a threshold. Timber rises as a gully gathers water and falls
  // away again once the creek has widened into a river: a canopy closes over a small
  // watercourse — which is exactly how it looks from the air, and why a wooded creek is
  // still drawn as woodland on a real map — but no tree spans a trunk channel. Without
  // the upper edge the biggest rivers come out as the most heavily timbered ground in
  // the tile, which is backwards.
  //
  // Both edges of that band are catchment areas in km², exactly as minChannelKm2 is for
  // the rivers, so the two are directly comparable: set the tree threshold near the
  // river threshold and the timber traces the same channels the water does.
  //
  // The B channel holds log10(km²) remapped to 0..1 by (log10(a) + 3) / 10, so it
  // inverts exactly and the comparison can be done in real units rather than in a
  // number whose meaning changes with the tile. Working on the raw 0..1 instead was the
  // whole problem: the same setting meant a different catchment on every box, and the
  // biome and aridity shifts stacked on top of it silently moved a 1.26 km² threshold
  // to 0.003 km² — four hundred times finer, which is every gully on the hillside and
  // exactly why the timber washed out while the rivers stayed sparse.
  float rawTrees = forestFrac;
  if (uHasWater > 0.5) {
    float treeAccum = texture2D(uWaterMap, vUv).b;
    float edge = max(0.01, uTreeSpread);
    // Denser cover means timber holds on smaller catchments. This is the only thing
    // that moves the threshold, and it moves it in the open.
    float km2 = uTreeNeed / max(0.05, forestFrac);
    float need = clamp((log(km2) / 2.302585 + 3.0) / 10.0, 0.0, 1.0);

    // Fray the edge fractally.
    //
    // A single threshold on catchment draws the timber to a clean contour, which is
    // wrong in the same way a coastline drawn with a compass is wrong. Real woodland
    // grows *out* of the channel: it runs up every side gully, spills onto the shoulders
    // where the ground stays damp, and leaves ragged clearings on the drier spurs
    // between — self-similar, because the drainage it is following is self-similar.
    //
    // Perturbing the threshold rather than the finished coverage is what keeps it
    // anchored to the network. The noise decides how much catchment this particular
    // patch of ground demands, so the fingers grow along the tributaries that already
    // exist instead of being sprayed across them. Multi-octave, so the fraying repeats
    // at every scale down to the limit of the grid.
    //
    // Measured in the units of the channel: 0.1 here is one decade of catchment, so the
    // full setting swings the requirement by about half an order of magnitude either
    // way — enough to reach well up the small tributaries without detaching from them.
    if (uTreeFractal > 0.001) {
      need += fbm(wp * 0.0016, 5) * uTreeFractal * 0.16;
    }

    // Dissected ground holds timber; flat ground does not.
    //
    // This is the part catchment cannot see. A ploughed field and an eroded block of
    // breaks can carry identical drainage — what separates them is that one is smooth
    // and the other is cut to pieces. And the reason is not subtle: broken ground is too
    // steep and stony to plough, so it keeps its trees, while the flat ground beside it
    // was cleared. On imagery of farmed country that is the single strongest signal
    // there is, and it is why the woods sit in blocks rather than tracing every gully.
    //
    // It moves the threshold rather than multiplying the result, for the same reason the
    // fraying does: the timber has to stay anchored to the drainage. Flat ground is asked
    // for more catchment than it will ever have, so it stays clear; broken ground is
    // asked for less, so the network fills out across it.
    if (uTreeRough > 0.001) {
      float relief = localRelief(vUv);
      float broken = smoothstep(0.0, max(1.0, uTreeRoughScale), relief);
      need += uTreeRough * (0.5 - broken) * 0.34;
    }

    float stop = clamp((log(max(uTreeLimit, 1e-4)) / 2.302585 + 3.0) / 10.0, 0.0, 1.0);
    rawTrees = smoothstep(need, need + edge, treeAccum) *
               (1.0 - smoothstep(stop, stop + edge, treeAccum));
  }

  // A closed forest ends abruptly: the last stretch goes timber to krummholz to tundra
  // inside a couple of hundred metres. Only open scrub thins out over a kilometre, so
  // the width of the fade follows the cover rather than being fixed — at a fixed 420 m
  // better than a third of a range like the Front Range sits half-stripped.
  float treeFade = mix(420.0, 140.0, rawTrees);
  float lowland = smoothstep(uTreeLine + 220.0, uTreeLine - treeFade, vElev);
  rawTrees *= lowland;

  // Slope tolerance follows what is actually growing here, not the biome average:
  // timber holds ground that meadow gives up to scree.
  float steepVeg = smoothstep(0.10 + 0.20 * rawTrees, 0.44 + 0.82 * rawTrees, slope);

  float veg = wetness * lowland * (1.0 - steepVeg);
  // Dense-canopy ground is continuous, not patchy: bias the break-up noise by cover.
  veg *= smoothstep(-0.30, 0.30, macro * 1.5 + meso * 0.5 + 0.20 + rawTrees * 0.72);
  veg = clamp(veg, 0.0, 1.0);

  // Vegetation follows the water.
  //
  // Patchiness from noise alone varies, but it varies at random — uncorrelated with
  // anything on the ground, so it reads as static rather than landscape. The flow
  // accumulation already computed for the rivers is the real signal: in dry country
  // the green threads along the drainage while the uplands stay bare, which is
  // exactly what satellite imagery of somewhere like West Texas shows.
  //
  // Deliberately scaled by aridity — in wet country the hillsides are green too, so
  // riparian corridors barely stand out. It is dryness that makes them visible.
  float riparian = 0.0;
  if (uHasWater > 0.5) {
    vec4 wm = texture2D(uWaterMap, vUv);

    if (riparianAmt > 0.001) {
      riparian = smoothstep(riparianReach - 0.10, riparianReach + 0.14, wm.b);
      riparian *= riparianAmt * (1.0 - steep) * lowland;
      riparian *= 0.35 + 0.65 * aridity;
      veg = clamp(veg + riparian, 0.0, 1.0);
    }
  }

  // A surveyed wood is closed ground, not just ground with a higher tree ratio.
  //
  // Raising the canopy alone left mapped woodland looking washed out, because canopy
  // decides *which* cover gets painted while veg decides how much of the ground is
  // covered at all — and on dry, thin or broken ground veg is low, so the conifer had
  // almost nothing to land on. Both have to move together.
  //
  // Raised rather than replaced, so this can only ever add cover: where the model
  // already has closed forest the polygon changes nothing, and where it has bare rock
  // on a slope too steep to hold trees, steepVeg still takes it back below.
  veg = clamp(max(veg, osmWood * 0.92), 0.0, 1.0);

  albedo = mix(albedo, soil, clamp(veg * 1.3, 0.0, 1.0) * 0.55);

  // Grass or trees. Closed conifer is one of the darkest surfaces there is — the
  // canopy traps almost everything that lands on it — so this is as much a change of
  // brightness as of hue, and it is what separates a forested range from a meadow one.
  // Trees give out on steep rock and thin toward the tree line, where the belt breaks
  // up into scattered krummholz rather than ending at a hard edge.
  // Timber gives out on bare rock. Nothing here excludes the channel itself: a canopy
  // genuinely does close over a creek, and the upper edge of the band already takes the
  // trees off anything wide enough to be open water.
  float canopy = clamp(rawTrees * (1.0 - steepVeg * 0.45), 0.0, 1.0);

  // Timber stands back from a road. Somebody felled that corridor to lay it and somebody
  // keeps felling it — verge, firebreak, sightline — so a road through woodland is a
  // clearing with a surface down the middle of it, not a line drawn across the canopy.
  // Only the trees go: a verge is mown, so the grass below stays and the ground does not
  // turn bare.
  canopy *= 1.0 - roadCorridor;

  // Mapped woodland corrects the derived canopy rather than replacing it.
  //
  // Pulling toward the observed value instead of overwriting with it is the whole point.
  // The generated timber knows things the polygon does not — it thins on steep rock,
  // fingers up the gullies, stops at the tree line — and the polygon knows the one thing
  // the model cannot: whether there are actually trees there. A blend keeps both, and
  // degrades gracefully where OSM's coverage is thin, which in most of the world it is.
  //
  // Outside a mapped wood nothing is asserted: absence of a polygon is absence of a
  // survey, not evidence of bare ground.
  canopy = mix(canopy, max(canopy, 1.0), osmWood * 0.85);

  // Nobody keeps a closed canopy in a housing estate. Street trees and gardens are real,
  // so this thins rather than clears.
  canopy *= 1.0 - osmBuilt * 0.72;

  // The two cover layers switch independently, which is what makes the pattern legible:
  // with grass hidden, the timber network stands alone against bare ground and can be
  // compared straight against the drainage view.
  canopy *= uShowTrees;
  // Cover survives only where there are trees, so hiding grass strips the ground back
  // rather than turning the whole tile into meadow.
  veg *= mix(canopy, 1.0, uShowGrass);

  vec3 coverCol = mix(grassCol, conifer, canopy);

  // The wettest ground carries a different species. Valley-bottom timber is broadleaf —
  // cottonwood and willow — lighter, yellower and far more saturated than the conifer on
  // the slopes above, so a creek in boreal country reads as a bright ribbon *against*
  // the dark forest rather than more of it. Carries only a fraction of the biome's
  // blue-shift for the same reason.
  vec3 broadleaf = mix(vec3(0.050, 0.076, 0.024), vec3(0.106, 0.134, 0.046), mottle);
  broadleaf = vegTone(broadleaf, uVegTint * 0.30, uVegSat);
  coverCol = mix(coverCol, broadleaf, clamp(canopy * riparian * 2.0 * uCorridorLeaf, 0.0, 1.0));
  albedo = mix(albedo, coverCol, veg * 0.88);
  // Corridor growth is greener and denser than the scrub around it.
  albedo = mix(albedo, coverCol * 0.72, riparian * 0.5);

  // Arid basins get sand in the flats — but not where the drainage keeps them wet.
  float aridFlat = aridity * (1.0 - steep) *
                   smoothstep(uTreeLine, uTreeLine - 900.0, vElev);
  albedo = mix(albedo, sandCol, aridFlat * 0.6 * (1.0 - riparian));

  // Oxidised ground. The base palette runs grey through rock and scree, which suits
  // alpine terrain but leaves semi-arid rangeland looking like slate instead of the
  // rust it actually is. Kept off the vegetation so only bare ground shifts.
  //
  // Applied as a multiplicative hue shift rather than a mix toward a rust colour.
  // Ambient here is sky light, which is markedly blue — blending toward a dark warm
  // tone loses to it and comes back out grey. Scaling the channels shifts hue without
  // dropping luminance, so it survives the lighting.
  if (groundWarmth > 0.001) {
    float w = groundWarmth * (1.0 - veg);
    // Clamped at zero: past w = 1.9 the blue term would go negative and the channel
    // would wrap back up as a false cyan cast instead of simply bottoming out.
    albedo *= max(vec3(0.0), vec3(1.0 + 1.10 * w, 1.0 - 0.06 * w, 1.0 - 0.52 * w));
  }

  // Snow: accumulates with altitude, slides off anything steep, and does not linger
  // on sun-baked desert plateaus.
  float snow = smoothstep(uSnowLine - 260.0, uSnowLine + 190.0, vElev);
  snow *= 1.0 - smoothstep(0.30, 0.66, slope);
  snow *= smoothstep(-0.55, 0.35, macro * 1.4 + meso * 0.6);
  snow *= 1.0 - aridity * 0.85;
  snow = clamp(snow, 0.0, 1.0) * uShowSnow;
  albedo = mix(albedo, snowCol, snow);

  // Beaches where the land meets the sea.
  float shore = (1.0 - smoothstep(0.0, 14.0, vElev - uSeaLevel)) *
                smoothstep(-6.0, 1.0, vElev - uSeaLevel) * (1.0 - steep);
  albedo = mix(albedo, sandCol * 1.05, shore * 0.7);

  // ---- satellite drape ----------------------------------------------------
  if (uUseSat > 0.5) {
    vec3 sat = srgbToLinear(texture2D(uSatMap, vUv).rgb);

    // The clipmap cascade, coarse ring first so finer rings paint over it. Each
    // ring feathers at its own boundary — the resolution steps must not draw their
    // rectangles onto the ground — and multiplies in its fade so a ring that is
    // still arriving eases in over the one beneath instead of popping. The feather
    // is wide (15% of the ring) because it blends more than resolution: Esri's
    // captures differ between zoom levels — date, season, colour — and a narrow
    // feather draws that difference as a rectangle onto the ground.
    {
      vec2 span3 = max(uSatRing3Rect.zw - uSatRing3Rect.xy, vec2(1e-6));
      vec2 rUv3 = (vUv - uSatRing3Rect.xy) / span3;
      vec2 edge3 = min(rUv3, 1.0 - rUv3);
      float in3 = smoothstep(0.0, 0.15, min(edge3.x, edge3.y)) * uSatRing3Fade;
      if (in3 > 0.0) sat = mix(sat, srgbToLinear(texture2D(uSatRing3Map, rUv3).rgb), in3);

      vec2 span2 = max(uSatRing2Rect.zw - uSatRing2Rect.xy, vec2(1e-6));
      vec2 rUv2 = (vUv - uSatRing2Rect.xy) / span2;
      vec2 edge2 = min(rUv2, 1.0 - rUv2);
      float in2 = smoothstep(0.0, 0.15, min(edge2.x, edge2.y)) * uSatRing2Fade;
      if (in2 > 0.0) sat = mix(sat, srgbToLinear(texture2D(uSatRing2Map, rUv2).rgb), in2);

      vec2 span1 = max(uSatRing1Rect.zw - uSatRing1Rect.xy, vec2(1e-6));
      vec2 rUv1 = (vUv - uSatRing1Rect.xy) / span1;
      vec2 edge1 = min(rUv1, 1.0 - rUv1);
      float in1 = smoothstep(0.0, 0.15, min(edge1.x, edge1.y)) * uSatRing1Fade;
      if (in1 > 0.0) sat = mix(sat, srgbToLinear(texture2D(uSatRing1Map, rUv1).rgb), in1);

      vec2 span0 = max(uSatRing0Rect.zw - uSatRing0Rect.xy, vec2(1e-6));
      vec2 rUv0 = (vUv - uSatRing0Rect.xy) / span0;
      vec2 edge0 = min(rUv0, 1.0 - rUv0);
      float in0 = smoothstep(0.0, 0.15, min(edge0.x, edge0.y)) * uSatRing0Fade;
      if (in0 > 0.0) sat = mix(sat, srgbToLinear(texture2D(uSatRing0Map, rUv0).rgb), in0);
    }

    // At full opacity the photograph IS the ground: no procedural grain, no
    // procedural snow — nothing of the modelled terrain shows through. Both
    // leaks return only as the drape is made translucent, where the procedural
    // ground is deliberately part of the picture. (The close-up grain was meant
    // to hide upscaled-imagery mush, but it read as terrain bleeding through
    // the photo — the wrong trade at 100%.)
    float g = 0.90 + 0.20 * (grain * 0.5 + 0.5) * uSatDetail * (1.0 - smoothstep(600.0, 5000.0, dist));
    g = mix(g, 1.0, uSatOpacity);
    albedo = mix(albedo, sat * g, uSatOpacity);
    snow *= 1.0 - uSatOpacity;

    // Mapped overlays composite OVER the imagery — the photograph is the ground
    // layer, surveyed data reads on top of it, and roads (drawn further down)
    // top everything. In procedural mode these signals steer the ground colours
    // themselves; over a photograph a recolour would fight real pixels, so they
    // render as frank translucent overlays instead. Water wins over the land
    // uses, as it does on any chart.
    if (osmWood > 0.001) albedo = mix(albedo, vec3(0.035, 0.085, 0.030), min(osmWood, 1.0) * 0.45);
    if (osmBuilt > 0.001) albedo = mix(albedo, vec3(0.28, 0.26, 0.23), min(osmBuilt, 1.0) * 0.35);
    if (osmWater > 0.001) albedo = mix(albedo, vec3(0.030, 0.095, 0.160), min(osmWater, 1.0) * 0.60);
  }

  // ---- built-up ground ----------------------------------------------------
  // Where the town is, without paying for every building in it.
  //
  // Land-use polygons are the cheap half of "towns look empty": they say a place is
  // residential or industrial without the hundreds of thousands of footprints that
  // saying which buildings would cost, and unlike a footprint they stay legible when a
  // mask pixel is fifty metres across. What they cannot do is give the town height, so
  // this reads correctly from above and stays flat from the ground.
  //
  // Under the roads on purpose — the streets run through the estate, not beside it.
  if (osmBuilt > 0.003) {
    // Grey, but not concrete-grey. Suburban ground from the air is mostly roofs, tarmac
    // and gardens averaged together, which lands warmer and darker than bare pavement.
    vec3 builtCol = mix(vec3(0.105, 0.100, 0.094), vec3(0.150, 0.142, 0.130), mottle);
    // The mottle is what stops it reading as a painted polygon: real built-up land is a
    // patchwork of blocks and green space at a scale the noise already has.
    float cover = osmBuilt * (0.55 + 0.45 * mottle) * (1.0 - steep * 0.6);
    albedo = mix(albedo, builtCol, clamp(cover, 0.0, 1.0));
  }

  // ---- roads --------------------------------------------------------------
  // Painted after the imagery deliberately, and at reduced strength over it. The whole
  // point of the satellite view is to check the derived ground against what is actually
  // there, and roads are the one layer where that check is exact — these are surveyed
  // lines, so if they do not sit on the roads in the photograph then the projection is
  // wrong and everything else drawn from the same box is wrong with it.
  // The shoulder: the verge band lightened, the way a real roadside reads — mown
  // grass, gravel, dust thrown off the surface. It is what makes the dark carriageway
  // legible from altitude: asphalt on dark ground is a line nobody can see, asphalt
  // inside a pale band is a road. Kept off the surface itself, and OFF over imagery
  // entirely — by the time roads paint, albedo over satellite IS the photograph, which
  // already contains its real shoulders; brightening a blurred band on top of it just
  // draws pale worms along every road. (Learned by doing exactly that.)
  if (roadVerge > 0.003) {
    float shoulderBand = roadVerge * (1.0 - roadSurface) * uRoadShoulder * (1.0 - uUseSat);
    albedo = mix(albedo, albedo * 1.45 + soil * 0.10 + vec3(0.008), clamp(shoulderBand, 0.0, 1.0));
  }

  if (roadSurface > 0.003) {
    float cov = roadSurface * mix(1.0, 0.5, uUseSat);

    // Metalled surfaces are among the darkest things outdoors: fresh asphalt returns
    // under a tenth of what lands on it, and even bleached by years of sun it stays
    // well below bare rock.
    vec3 metalled = mix(vec3(0.075, 0.073, 0.070), vec3(0.020, 0.019, 0.019), uRoadDarkness);

    // An unsealed road is not a material at all — it is this ground with the cover
    // scraped off and the dust packed down, so it takes its colour from the place and
    // sits a little lighter than what is beside it. That is why a dirt road is red in
    // the tropics and pale in the desert without anything here knowing where it is.
    vec3 graded = mix(albedo, soil, 0.4) * 1.3 + sandCol * 0.06;

    // What gets surfaced is a question of traffic, not climate: a farm track is metalled
    // almost nowhere, and anything above one is metalled almost anywhere there is enough
    // traffic to have named it. The break sits between track and everything else rather
    // than partway up the hierarchy — OSM's minor class is mostly residential streets,
    // and a residential street in a town is tarmac whatever the climate. Above the break
    // the biome decides, which is where the real variation is: a secondary road is
    // sealed in Colorado and graded laterite in the Congo.
    // (No backticks anywhere in here — this GLSL is a JS template literal and one would
    // end it, which fails as a syntax error a long way from the cause.)
    float tint = mix(max(uRoadTint, 0.9), uRoadTint, smoothstep(0.02, 0.2, roadClass));
    albedo = mix(albedo, mix(metalled, graded, tint), cov);

    // Roads are the first thing cleared and the last thing to hold snow.
    snow *= 1.0 - cov * 0.85;
  }

  // ---- inland water -------------------------------------------------------
  // The DEM already records the water *surface*, so no geometry moves here: the mask
  // only says "shade this as water". Lakes ignore the size threshold; rivers appear
  // once their upstream drainage area is large enough.
  float waterCov = 0.0;
  float lakeness = 0.0;
  if (uHasWater > 0.5 && vSide < 0.5) {
    vec4 wm = texture2D(uWaterMap, vUv);
    lakeness = wm.g;
    float sizeGate = smoothstep(uRiverThreshold - 0.05, uRiverThreshold + 0.05, wm.b);
    // The mask tags each cell as river or lake, so the two classes gate separately.
    float classGate = mix(uShowRivers, uShowLakes, lakeness);
    waterCov = clamp(wm.r * mix(sizeGate, 1.0, lakeness) * uRivers * classGate, 0.0, 1.0);
    // Watercourses dry up in arid country — what is left is a wadi, not a river.
    waterCov *= 1.0 - aridity * 0.55 * (1.0 - lakeness);
    // Water cannot hold a broad flat surface on a steep face. Anything that steep is
    // a cascade — narrow, broken and mostly white water — so fade the sheet out
    // rather than painting a mirror down the mountainside.
    //
    // Measured against the true ground gradient, not the exaggerated one: the normal
    // map bakes in uExag, so at 1.6x a gentle valley floor reads as steep and would
    // lose its river purely because of a display setting.
    float ny = max(n.y, 1e-4);
    vec3 trueN = normalize(vec3(n.x / ny / uExag, 1.0, n.z / ny / uExag));
    float trueSlope = 1.0 - clamp(trueN.y, 0.0, 1.0);
    waterCov *= mix(1.0 - smoothstep(0.14, 0.40, trueSlope), 1.0, lakeness);
    // Over imagery the point is to compare the derived water against what is actually
    // there, so let the picture read through rather than painting over it. The water
    // visibility slider still scales on top of this.
    waterCov *= mix(1.0, 0.55, uUseSat);
  }

  // A mapped lake beats a derived one.
  //
  // Depression filling asks where water would pond given the DEM alone. In a closed
  // basin that is a good question; almost anywhere else the answer is settled by a dam,
  // a drain or a century of drilling, none of which are in the elevation. Where somebody
  // has actually walked the shoreline, that is the shoreline.
  //
  // Outside its own guard so this still works with no hydrology pass at all — a mapped
  // lake does not depend on the drainage having been traced.
  // Not gated on uShowLakes or uRivers: those switch the *derived* water, and mapped
  // water is its own layer with its own toggle. Riding on them meant turning off the
  // depression-fill lakes silently took the surveyed ones with it.
  if (osmWater > 0.003 && vSide < 0.5) {
    float mapped = clamp(osmWater, 0.0, 1.0) * mix(1.0, 0.55, uUseSat);
    // Standing water, so it reads as a lake rather than a channel.
    lakeness = max(lakeness, mapped);
    waterCov = max(waterCov, mapped);
  }

  if (waterCov > 0.002) {
    // Flatten toward horizontal and darken; standing water is a poor diffuse reflector.
    N = normalize(mix(N, vec3(0.0, 1.0, 0.0), waterCov * 0.75));
    vec3 riverBed = vec3(0.028, 0.045, 0.042);
    vec3 lakeBody = vec3(0.012, 0.030, 0.052);
    albedo = mix(albedo, mix(riverBed, lakeBody, lakeness), waterCov);
    snow *= 1.0 - waterCov;
  }

  // ---- plinth -------------------------------------------------------------
  // The cut sides and base are not ground, so they get flat vertex normals and a
  // banded stone look rather than snow, grass or satellite imagery.
  if (vSide > 0.5) {
    N = normalize(vBaseNormal);
    float strata = fbm(vec2(vWorldPos.y * 0.02, (vWorldPos.x + vWorldPos.z) * 0.0015), 4);
    albedo = mix(vec3(0.072, 0.064, 0.058), vec3(0.145, 0.130, 0.116), strata * 0.5 + 0.5);
    snow = 0.0;
  }

  // ---- lighting -----------------------------------------------------------
  vec3 L = normalize(uSunDir);
  float ndl = dot(N, L);
  // A little wrap softens the terminator without flattening the whole slope range.
  float diffuse = clamp((ndl + 0.06) / 1.06, 0.0, 1.0);

  float shadow = sunShadow(vWorldPos, L);
  float ao = terrainAO(vUv, vWorldPos.y);
  if (vSide > 0.5) {
    // The plinth sits below the whole height field, so the terrain-based shadow and
    // occlusion tests would bury it in black. Light it as a plain cut face instead.
    shadow = 1.0;
    ao = 0.5;
  }

  vec3 direct = uSunColor * diffuse * shadow;

  // Hemispheric ambient: sky above, bounced ground light below.
  float up = N.y * 0.5 + 0.5;
  vec3 ambient = mix(uGroundTint, uSkyColor, up) * ao;
  // Sunlit ground throws warm light back into the shadows; without it, shaded slopes
  // go an unnaturally cold blue.
  ambient += uSunColor * 0.14 * ao * max(L.y, 0.0);

  // Snow and wet rock get a broad specular sheen.
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), mix(24.0, 90.0, snow)) * mix(0.03, 0.35, snow);
  vec3 specular = uSunColor * spec * shadow;

  vec3 color = albedo * (direct + ambient) + specular;

  // Snow scatters light internally — a hint of translucency at grazing sun angles.
  color += snowCol * snow * 0.06 * uSunColor * shadow * pow(1.0 - abs(dot(N, V)), 2.0);

  // ---- water surface ------------------------------------------------------
  if (waterCov > 0.002) {
    // Ripples fade with distance for the same reason the ground detail does.
    float rippleFade = 1.0 - smoothstep(700.0, 5000.0, dist);
    float e2 = 0.8;
    float t = uTime;
    vec2 drift = vec2(t * 0.15, t * 0.09);
    float r0 = fbm(wp * 0.09 + drift, 3);
    float rx = fbm((wp + vec2(e2, 0.0)) * 0.09 + drift, 3);
    float rz = fbm((wp + vec2(0.0, e2)) * 0.09 + drift, 3);
    // Rivers ripple harder than lakes. Scaled by the same wave-height control as the
    // sea, so zero really is a still surface — an 11 m ripple is far under a screen
    // pixel once you pull back, and driving a pow(...,260) specular with it makes the
    // water crawl and flicker as the camera moves.
    float amp = mix(5.0, 2.0, lakeness) * rippleFade * uWaveHeight;
    vec3 Nw = normalize(vec3(-(rx - r0) * amp, 1.0, -(rz - r0) * amp));
    Nw = normalize(mix(N, Nw, waterCov));

    float fres = pow(1.0 - clamp(dot(Nw, V), 0.0, 1.0), 4.0);
    vec3 skyRefl = mix(uHorizonColor, uSkyColor, clamp(reflect(-V, Nw).y * 1.6, 0.0, 1.0));

    vec3 Hw = normalize(L + V);
    vec3 wet = mix(color, skyRefl, mix(0.05, 0.80, fres));
    wet += uSunColor * pow(max(dot(Nw, Hw), 0.0), 260.0) * 1.4 * shadow;

    color = mix(color, wet, waterCov);
  }

  // ---- drainage network view ----------------------------------------------
  // Every cell carries the area draining through it, so the whole dendritic network
  // is already there — not just the reaches that pass the river threshold. Painting
  // it over a dim hillshade reads as a catchment map.
  if (uDrainageView > 0.5 && uHasWater > 0.5 && vSide < 0.5) {
    float accum = texture2D(uWaterMap, vUv).b;

    // No threshold here on purpose. Every cell carries the area draining through it,
    // so mapping the whole field — hillslopes included — puts a faint blue filigree
    // over the entire surface and lets the trunk rivers burn through it. Cutting at
    // the river threshold instead would throw away the part that makes it readable.
    float t = clamp((accum - (uRiverThreshold - 0.26)) / 0.34, 0.0, 1.0);

    // No hillshade and no broad fill — an ambient wash drowns the fine branches.
    // The first band is close to linear on purpose: that is what keeps every hollow
    // on the hillside visible instead of only the channels that survive a threshold.
    // The higher powers stack on top so trunks still burn out to white.
    vec3 drain = vec3(0.005, 0.014, 0.055);
    drain += vec3(0.06, 0.30, 0.95) * pow(t, 1.15) * 0.95;
    drain += vec3(0.35, 0.76, 1.00) * pow(t, 3.5) * 1.50;
    drain += vec3(0.95, 1.00, 1.00) * pow(t, 11.0) * 2.60;

    // Standing water reads as a solid body, not a line.
    drain = mix(drain, vec3(0.26, 0.66, 0.95), lakeness * texture2D(uWaterMap, vUv).r * 0.9);

    color = drain;
  }

  // ---- aerial perspective -------------------------------------------------
  // Matches the sky dome's gradient exactly, so distant ridges dissolve into the sky.
  float fog = 1.0 - exp(-dist * uFogDensity);
  // Air thins with altitude, so high ground stays clearer.
  fog *= mix(1.0, 0.55, clamp((vWorldPos.y / max(uExag, 1e-5) - uMinElev) / 4000.0, 0.0, 1.0));
  // The drainage view is a diagram, not a landscape — keep haze off the network.
  fog *= mix(1.0, 0.25, uDrainageView);

  vec3 toFrag = -V;
  vec3 fogColor = mix(uHorizonColor, uSkyColor, pow(clamp(toFrag.y, 0.0, 1.0), 0.4));
  float sunAmount = max(dot(toFrag, L), 0.0);
  fogColor += uSunColor * pow(sunAmount, 5.0) * 0.12;
  color = mix(color, fogColor, clamp(fog, 0.0, 1.0));

  gl_FragColor = vec4(color, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
