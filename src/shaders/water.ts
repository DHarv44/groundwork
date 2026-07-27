export const waterVertexShader = /* glsl */ `
varying vec3 vWorldPos;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

export const waterFragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D uHeightMap;
uniform float uMinElev;
uniform float uMaxElev;
uniform float uExag;
uniform float uWidthM;
uniform float uDepthM;
uniform float uSeaLevelY;
uniform float uShoreCutoff;   // how far above the surface still counts as dry
uniform float uDepthFade;     // depth at which the water reads fully deep, metres
uniform float uWaveHeight;
uniform float uFoamWidth;     // distance from dry ground that surf reaches, metres
uniform float uOpacity;
uniform float uTime;
uniform float uHasBathymetry;   // 1 when the DEM actually carries sea-floor depths

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uHorizonColor;
uniform float uFogDensity;

varying vec3 vWorldPos;

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

float waves(vec2 p, float t) {
  float s = 0.0;
  s += gnoise(p * 0.08 + vec2(t * 0.12, t * 0.05)) * 0.55;
  s += gnoise(p * 0.21 - vec2(t * 0.17, t * 0.09)) * 0.28;
  s += gnoise(p * 0.55 + vec2(t * 0.31, -t * 0.22)) * 0.14;
  return s;
}

float terrainY(vec2 uvp) {
  float h = texture2D(uHeightMap, uvp).r;
  return (uMinElev + h * (uMaxElev - uMinElev)) * uExag;
}

void main() {
  vec2 uvp = vec2(vWorldPos.x / uWidthM + 0.5, vWorldPos.z / uDepthM + 0.5);
  if (uvp.x < 0.0 || uvp.x > 1.0 || uvp.y < 0.0 || uvp.y > 1.0) discard;

  float bed = terrainY(uvp);
  if (bed > uSeaLevelY + uShoreCutoff) discard;   // dry land — no water here

  float depth;
  if (uHasBathymetry > 0.5) {
    depth = max(uSeaLevelY - bed, 0.0);
  } else {
    // Land-only DEMs flatten the sea to exactly 0 m, so there is no depth to read.
    // Approximate it from how much dry land surrounds us: open water reads deep,
    // cells hemmed in by shoreline read shallow.
    float land = 0.0;
    for (int r = 1; r <= 3; r++) {
      float radius = 0.004 * float(r);
      for (int d = 0; d < 8; d++) {
        float a = float(d) * 0.7853982;
        vec2 suv = clamp(uvp + vec2(cos(a), sin(a)) * radius, vec2(0.0), vec2(1.0));
        land += step(uSeaLevelY + uShoreCutoff, terrainY(suv));
      }
    }
    depth = mix(38.0, 0.0, clamp((land / 24.0) * 1.6, 0.0, 1.0));
  }

  vec3 viewVec = cameraPosition - vWorldPos;
  float dist = length(viewVec);
  vec3 V = viewVec / max(dist, 1e-4);

  // Ripples are metre-scale. Once a pixel covers more ground than a wave is wide the
  // detail can only alias, so fade it out with distance and let the sky reflection
  // carry the surface instead.
  float rippleFade = 1.0 - smoothstep(1200.0, 6000.0, dist);
  vec2 wp = vWorldPos.xz;
  float t = uTime;
  float amp = (0.55 * smoothstep(0.0, 12.0, depth) + 0.06) * rippleFade * uWaveHeight;
  float e = 0.9;
  float w0 = waves(wp, t);
  float wx = waves(wp + vec2(e, 0.0), t);
  float wz = waves(wp + vec2(0.0, e), t);
  vec3 N = normalize(vec3(-(wx - w0) * amp * 9.0, 1.0, -(wz - w0) * amp * 9.0));

  vec3 L = normalize(uSunDir);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
  fres = mix(0.02, 1.0, fres);

  // Deep ocean blue grading to green-cyan over shallow bed.
  vec3 deepCol = vec3(0.008, 0.045, 0.082);
  vec3 shallowCol = vec3(0.055, 0.216, 0.235);
  vec3 body = mix(shallowCol, deepCol, smoothstep(1.0, max(2.0, uDepthFade), depth));

  vec3 skyRefl = mix(uHorizonColor, uSkyColor, clamp(reflect(-V, N).y * 1.6, 0.0, 1.0));

  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 220.0) * 1.6;

  vec3 color = mix(body, skyRefl, fres) + uSunColor * spec;

  // Foam rides the actual shoreline, not the depth estimate: look for dry ground a
  // fixed distance away rather than relying on how deep we think we are.
  float shoreM = uFoamWidth;
  vec2 rUv = vec2(shoreM / uWidthM, shoreM / uDepthM);
  float nearLand = 0.0;
  for (int d = 0; d < 8; d++) {
    float a = float(d) * 0.7853982;
    vec2 suv = clamp(uvp + vec2(cos(a), sin(a)) * rUv, vec2(0.0), vec2(1.0));
    nearLand = max(nearLand, step(uSeaLevelY + uShoreCutoff, terrainY(suv)));
  }
  // Surf modulation stays low-frequency so it survives minification.
  float surf = 0.6 + 0.4 * waves(wp * 0.25, t * 1.2) * rippleFade;
  float foam = nearLand * surf * (0.35 + 0.65 * smoothstep(6.0, 0.0, depth));
  color = mix(color, vec3(0.82, 0.87, 0.90), clamp(foam, 0.0, 1.0) * 0.55);

  // Shallow water reads through to the bed; deep water does not.
  float alpha = clamp(uOpacity + smoothstep(0.0, 8.0, depth) * 0.35 + fres * 0.25 + foam * 0.3, 0.0, 1.0);

  float fog = 1.0 - exp(-dist * uFogDensity);
  vec3 fogColor = mix(uHorizonColor, uSkyColor, pow(clamp(-V.y, 0.0, 1.0), 0.4));
  color = mix(color, fogColor, clamp(fog, 0.0, 1.0));

  gl_FragColor = vec4(color, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
