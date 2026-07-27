/**
 * A gradient sky dome driven by the same colour model as the terrain's aerial
 * perspective. Using one palette for both is what makes distant ridges dissolve
 * into the sky instead of sitting on top of it.
 */
export const skyVertexShader = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const skyFragmentShader = /* glsl */ `
precision highp float;

uniform vec3 uSkyColor;
uniform vec3 uHorizonColor;
uniform vec3 uGroundTint;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uHaze;

varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;

  // Zenith to horizon. Hazier air pushes the horizon band further up the dome.
  float band = mix(0.55, 0.28, clamp(uHaze, 0.0, 1.0));
  vec3 col = mix(uHorizonColor, uSkyColor, pow(clamp(h, 0.0, 1.0), band));

  // Below the horizon, fade to bounced ground light so the dome closes cleanly.
  col = mix(uGroundTint * 0.8, col, smoothstep(-0.12, 0.015, h));

  float s = max(dot(d, normalize(uSunDir)), 0.0);
  // Disc, tight glow, then the broad forward-scattering halo.
  col += uSunColor * pow(s, 3000.0) * 14.0;
  col += uSunColor * pow(s, 40.0) * 0.30;
  col += uSunColor * pow(s, 5.0) * 0.14 * (0.4 + uHaze);
  // Scattering piles up near the horizon.
  col += uHorizonColor * pow(s, 2.0) * 0.10 * smoothstep(0.5, 0.0, abs(h));

  gl_FragColor = vec4(col, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
