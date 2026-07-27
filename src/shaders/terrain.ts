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
  // Fades out with distance so it never aliases into shimmer.
  vec2 wp = vWorldPos.xz;
  float detailFade = uDetail * (1.0 - smoothstep(400.0, 4000.0, dist));
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
  float rockFade = 1.0 - smoothstep(2500.0, 18000.0, dist);
  float grainFade = 1.0 - smoothstep(300.0, 3000.0, dist);
  float macro = fbm(wp * 0.0009, 5);
  float meso = fbm(wp * 0.011, 4);
  float rock = ridged(wp * 0.06, 4) * rockFade;
  float grain = fbm(wp * 0.6, 3) * grainFade;

  // Linear-space albedos in the range real ground actually occupies: rock sits around
  // 0.15–0.30, vegetation lower still, only snow gets close to 0.8.
  vec3 rockDark  = vec3(0.088, 0.079, 0.071);
  vec3 rockLight = vec3(0.255, 0.235, 0.212);
  vec3 scree     = vec3(0.205, 0.192, 0.176);
  vec3 soil      = vec3(0.115, 0.086, 0.055);
  vec3 grassCol  = mix(vec3(0.055, 0.082, 0.030), vec3(0.130, 0.145, 0.062), clamp(macro + 0.5, 0.0, 1.0));
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

  // Soil and vegetation collect on gentle ground below the tree line.
  float wetness = 1.0 - clamp(uAridity, 0.0, 1.0);
  float lowland = smoothstep(uTreeLine + 220.0, uTreeLine - 420.0, vElev);
  float veg = wetness * lowland * (1.0 - steep);
  veg *= smoothstep(-0.30, 0.30, macro * 1.5 + meso * 0.5 + 0.20);
  veg = clamp(veg, 0.0, 1.0);

  albedo = mix(albedo, soil, clamp(veg * 1.3, 0.0, 1.0) * 0.55);
  albedo = mix(albedo, grassCol, veg * 0.88);

  // Arid basins get sand in the flats.
  float aridFlat = clamp(uAridity, 0.0, 1.0) * (1.0 - steep) *
                   smoothstep(uTreeLine, uTreeLine - 900.0, vElev);
  albedo = mix(albedo, sandCol, aridFlat * 0.6);

  // Snow: accumulates with altitude, slides off anything steep, and does not linger
  // on sun-baked desert plateaus.
  float snow = smoothstep(uSnowLine - 260.0, uSnowLine + 190.0, vElev);
  snow *= 1.0 - smoothstep(0.30, 0.66, slope);
  snow *= smoothstep(-0.55, 0.35, macro * 1.4 + meso * 0.6);
  snow *= 1.0 - clamp(uAridity, 0.0, 1.0) * 0.85;
  snow = clamp(snow, 0.0, 1.0);
  albedo = mix(albedo, snowCol, snow);

  // Beaches where the land meets the sea.
  float shore = (1.0 - smoothstep(0.0, 14.0, vElev - uSeaLevel)) *
                smoothstep(-6.0, 1.0, vElev - uSeaLevel) * (1.0 - steep);
  albedo = mix(albedo, sandCol * 1.05, shore * 0.7);

  // ---- satellite drape ----------------------------------------------------
  if (uUseSat > 0.5) {
    vec3 sat = srgbToLinear(texture2D(uSatMap, vUv).rgb);
    // Keep a little procedural grain so close-ups don't turn to mush.
    float g = 0.90 + 0.20 * (grain * 0.5 + 0.5) * uSatDetail * (1.0 - smoothstep(600.0, 5000.0, dist));
    albedo = sat * g;
    snow *= 0.25;
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
    waterCov *= 1.0 - clamp(uAridity, 0.0, 1.0) * 0.55 * (1.0 - lakeness);
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
