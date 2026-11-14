import { BaseFX, FS_IO } from '../gl.js';

// CRT display emulation, working in linear light like a real tube: an electron
// beam with a Gaussian spot that widens with brightness draws scanlines onto a
// phosphor mask, phosphors decay over time, and the glass scatters a halo.

const PERSIST_FS = FS_IO + /* glsl */ `
uniform sampler2D uSrc, uPrev; uniform float uDecay;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  vec3 p = texture(uPrev, vUv).rgb * uDecay * vec3(1.0, 0.92, 0.78);   // blue phosphor fades fastest
  outColor = vec4(max(c, p), 1.0);
}`;

const BLUR_FS = FS_IO + /* glsl */ `
uniform sampler2D uTex; uniform vec2 uDir;
void main() {
  vec3 c = vec3(0.0); float ws = 0.0;
  for (int i = -5; i <= 5; i++) {
    float f = float(i) / 5.0, w = exp(-f * f * 3.0);
    c += texture(uTex, vUv + uDir * f).rgb * w; ws += w;
  }
  outColor = vec4(c / ws, 1.0);
}`;

const CRT_FS = FS_IO + /* glsl */ `
uniform sampler2D uImg, uGlow;
uniform float uCurve, uOverscan, uCorner, uLines, uBeamMin, uBeamMax, uFocus, uMask, uMaskStr, uPitch, uConv;
uniform float uHal, uVig, uBright, uContrast, uField, uFlicker, uRoll, uHum, uGlare, uTemp;
const float GAMMA = 2.4;

vec3 tube(vec2 uv) {                     // one beam sample with convergence error and spot focus
  vec2 px = 1.0 / uRes;
  vec2 conv = uConv * px * (vec2(0.6, 0.0) + (uv - 0.5) * 2.0);
  float f = uFocus * px.x;
  vec3 c = vec3(0.0);
  for (int i = -1; i <= 1; i++) {
    float w = i == 0 ? 0.5 : 0.25;
    vec2 o = vec2(float(i) * f, 0.0);
    c.r += texture(uImg, uv + o - conv).r * w;
    c.g += texture(uImg, uv + o).g * w;
    c.b += texture(uImg, uv + o + conv).b * w;
  }
  return pow(c, vec3(GAMMA));
}

vec3 mask(vec2 fp) {
  float p = max(3.0, uPitch * uScale);
  float x = fp.x / p;
  if (uMask > 2.5) return vec3(1.0);
  if (uMask > 1.5) {                     // shadow mask: staggered dot triads
    float row = floor(fp.y / (p * 0.866));
    x += 0.5 * mod(row, 2.0);
    float fy = fract(fp.y / (p * 0.866)) - 0.5;
    vec3 fx = fract(x + vec3(0.0, -1.0 / 3.0, -2.0 / 3.0)) - 0.5;
    vec3 d = sqrt(fx * fx * 9.0 + fy * fy * 0.75 * 2.2);
    return smoothstep(0.62, 0.36, d);
  }
  vec3 ph = fract(x + vec3(0.0, -1.0 / 3.0, -2.0 / 3.0));
  vec3 d = abs(fract(ph - 1.0 / 6.0 + 0.5) - 0.5);
  vec3 m = smoothstep(0.27, 0.12, d);    // aperture grille: vertical RGB stripes
  if (uMask > 0.5) {                     // slot mask: stripes broken by staggered gaps
    float fy = fract(fp.y / (p * 1.5) + 0.5 * mod(floor(x), 2.0));
    m *= smoothstep(0.0, 0.12, fy) * smoothstep(1.0, 0.88, fy);
  }
  return m;
}

void main() {
  vec2 c = vUv * 2.0 - 1.0;
  c *= 1.0 + uCurve * 0.22 * vec2(c.y * c.y, c.x * c.x);      // tube curvature
  vec2 edge = abs(c);
  vec2 q = max(edge - (1.0 - uCorner), 0.0);
  float inside = 1.0 - smoothstep(uCorner - 0.012, uCorner + 0.004, length(q));
  if (uCorner < 0.001) inside = step(edge.x, 1.0) * step(edge.y, 1.0);
  vec2 uv = c / (1.0 + uOverscan) * 0.5 + 0.5;

  float blank = 1.0;
  if (abs(uRoll) > 0.001) {              // vertical hold slipping: picture rolls, blanking bar passes through
    float ry = fract(uv.y + uRoll * uTime * 0.35);
    blank = smoothstep(0.0, 0.012, ry) * smoothstep(1.0, 0.955, ry);
    uv.y = ry;
  }

  float L = min(uLines, uRes.y / 2.5);  // keep scanlines resolvable at this output size
  float y = uv.y * L + uField;
  float l0 = floor(y);
  vec3 col = vec3(0.0);
  for (int i = -1; i <= 1; i++) {
    float ly = l0 + float(i);
    float d = y - (ly + 0.5);
    vec3 s = tube(vec2(uv.x, (ly + 0.5 - uField) / L));
    vec3 sigma = mix(vec3(uBeamMin), vec3(uBeamMax), clamp(s, 0.0, 1.0));   // brighter beam, fatter spot
    col += s * exp(-d * d / (2.0 * sigma * sigma));
  }
  col /= 1.12;
  col += pow(texture(uGlow, uv).rgb, vec3(GAMMA)) * uHal;     // halation in the faceplate glass
  col *= mix(vec3(1.0), mask(gl_FragCoord.xy) * 2.1, uMaskStr);
  vec2 v = vUv - 0.5;
  col *= 1.0 - uVig * dot(v, v) * 2.2;
  col *= 1.0 - uHum * 0.3 * (0.5 + 0.5 * sin((vUv.y * 1.3 + uTime * 0.31) * 6.2831853));
  col *= 1.0 - uFlicker * 0.12 * mod(uFrame, 2.0);
  col *= uTemp < 0.5 ? vec3(1.0) : (uTemp < 1.5 ? vec3(0.9, 0.97, 1.1) : vec3(1.08, 1.0, 0.86));
  col = (col * uBright - 0.18) * uContrast + 0.18;
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  col *= blank * inside;
  vec2 g = vUv - vec2(0.24, 0.8);
  col += uGlare * 0.16 * inside * exp(-dot(g, g) * 9.0);      // room light on the glass
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

class CrtFX extends BaseFX {
  constructor(r) {
    super(r);
    this.persist = r.fx(PERSIST_FS);
    this.blur = r.fx(BLUR_FS);
    this.crt = r.fx(CRT_FS);
  }
  render(p, ctx, target) {
    const r = this.r;
    const pp = this.pp('ph', r.w, r.h);
    r.pass(this.persist, pp.write, { uDecay: this.first ? 0 : p.persist }, { uSrc: r.cur, uPrev: pp.read });
    if (ctx.step) { pp.swap(); this.first = false; }
    const img = ctx.step ? pp.read : pp.write;
    const gw = Math.max(8, Math.round(r.w / 4)), gh = Math.max(8, Math.round(r.h / 4));
    const ga = this.target('ga', gw, gh), gb = this.target('gb', gw, gh);
    r.pass(this.blur, ga, { uDir: [0.035, 0] }, { uTex: img });
    r.pass(this.blur, gb, { uDir: [0, 0.035 * r.w / r.h] }, { uTex: ga });
    const beamMin = 0.62 - 0.42 * p.scan;
    r.pass(this.crt, target, {
      uCurve: p.curve, uOverscan: p.overscan, uCorner: p.corner, uLines: p.lines, uBeamMin: beamMin, uBeamMax: beamMin + 0.34 * p.bloom,
      uFocus: p.focus * r.h / 720, uMask: p.mask, uMaskStr: p.maskStr, uPitch: p.pitch, uConv: p.convergence * r.h / 720,
      uHal: p.halation, uVig: p.vignette, uBright: p.brightness, uContrast: p.contrast,
      uField: Math.round(p.interlace) ? 0.5 * (ctx.frame % 2) : 0, uFlicker: p.flicker, uRoll: p.roll, uHum: p.hum, uGlare: p.glare, uTemp: p.temp,
    }, { uImg: img, uGlow: gb });
  }
}

export default {
  id: 'crt',
  name: 'CRT',
  description: 'Tube display: beam scanlines that bloom with brightness, phosphor masks, curvature, halation and persistence.',
  swatch: ['#06110a', '#7dffb0'],
  params: [
    { id: 'lines', label: 'Scan Lines', min: 100, max: 480, step: 1, value: 240 },
    { id: 'scan', label: 'Scanline Depth', min: 0, max: 1, step: 0.01, value: 0.7 },
    { id: 'bloom', label: 'Beam Bloom', min: 0, max: 1, step: 0.01, value: 0.6, mod: { band: 'bass', depth: 0.25 } },
    { id: 'focus', label: 'Spot Focus (softness)', min: 0, max: 4, step: 0.01, value: 0.7 },
    { id: 'mask', label: 'Phosphor Mask', type: 'select', options: ['Aperture grille (Trinitron)', 'Slot mask', 'Shadow mask (dots)', 'None'], value: 0 },
    { id: 'maskStr', label: 'Mask Strength', min: 0, max: 1, step: 0.01, value: 0.5 },
    { id: 'pitch', label: 'Mask Pitch', min: 3, max: 14, step: 0.1, value: 3.6 },
    { id: 'curve', label: 'Curvature', min: 0, max: 1, step: 0.01, value: 0.35 },
    { id: 'corner', label: 'Corner Radius', min: 0, max: 0.25, step: 0.005, value: 0.06 },
    { id: 'overscan', label: 'Overscan', min: 0, max: 0.3, step: 0.005, value: 0.03 },
    { id: 'convergence', label: 'Convergence Error', min: 0, max: 5, step: 0.01, value: 0.6, mod: { band: 'hit', depth: 0.3 } },
    { id: 'halation', label: 'Halation', min: 0, max: 1, step: 0.01, value: 0.35 },
    { id: 'persist', label: 'Phosphor Persistence', min: 0, max: 0.96, step: 0.01, value: 0.35 },
    { id: 'brightness', label: 'Brightness', min: 0.4, max: 2.5, step: 0.01, value: 1.25 },
    { id: 'contrast', label: 'Contrast', min: 0.5, max: 2, step: 0.01, value: 1.05 },
    { id: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01, value: 0.35 },
    { id: 'flicker', label: 'Flicker', min: 0, max: 1, step: 0.01, value: 0.1 },
    { id: 'roll', label: 'V-Hold Roll', min: -2, max: 2, step: 0.01, value: 0 },
    { id: 'hum', label: 'Hum Bar', min: 0, max: 1, step: 0.01, value: 0 },
    { id: 'glare', label: 'Glass Glare', min: 0, max: 1, step: 0.01, value: 0.25 },
    { id: 'interlace', label: 'Interlace', type: 'select', options: ['Off', 'On'], value: 0 },
    { id: 'temp', label: 'Color Temperature', type: 'select', options: ['6500 K (neutral)', '9300 K (cool)', 'Warm'], value: 0 },
  ],
  create: r => new CrtFX(r),
};
