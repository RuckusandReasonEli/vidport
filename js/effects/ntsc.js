import { BaseFX, FS_IO } from '../gl.js';

// NTSC composite video, modeled as a signal: each scanline is sampled at four
// times the colour subcarrier (14.318 MHz, 754 samples across the visible
// line). RGB is encoded to Y + I/Q quadrature-modulated on a 3.58 MHz
// subcarrier whose phase flips every line, the signal picks up noise and
// ghosts, and a decoder separates luma from chroma again. The artifacts
// (dot crawl, rainbow cross-colour, colour bleed) fall out of that math.
const SIG_W = 754;
const FS_MHZ = 14.318;
const N = 20;

const COMMON = /* glsl */ `
#if FLOAT_TARGETS
vec3 encS(vec3 v) { return v; }
vec3 decS(vec3 v) { return v; }
#else
vec3 encS(vec3 v) { return clamp(v * 0.5 + 0.25, 0.0, 1.0); }
vec3 decS(vec3 v) { return (v - 0.25) * 2.0; }
#endif
const mat3 RGB2YIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
const mat3 YIQ2RGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
uniform float uCrawl;
// 4 samples per subcarrier cycle; 227.5 cycles per line means the phase flips each line.
float scPhase(float x, float line) { return 1.5707963 * x + 3.14159265 * line + uCrawl; }
`;

const ENCODE_FS = FS_IO + COMMON + /* glsl */ `
uniform sampler2D uSrc;
uniform float uPreY, uPreC;
void main() {
  vec2 px = 1.0 / uRes;
  vec2 fc = floor(vUv * uRes);
  float line = uRes.y - 1.0 - fc.y;
  float Y = 0.0, wy = 0.0, wc = 0.0;
  vec2 C = vec2(0.0);
  for (int k = -6; k <= 6; k++) {
    float fk = float(k);
    vec3 q = RGB2YIQ * texture(uSrc, vUv + vec2(fk * px.x, 0.0)).rgb;
    float a = exp(-fk * fk / (2.0 * uPreY * uPreY));
    float b = exp(-fk * fk / (2.0 * uPreC * uPreC));
    Y += q.x * a; wy += a;
    C += q.yz * b; wc += b;
  }
  Y /= wy; C /= wc;
  float ph = scPhase(fc.x, line);
  float chroma = C.x * cos(ph) + C.y * sin(ph);
  outColor = vec4(encS(vec3(Y + chroma, Y, chroma)), 1.0);   // composite, plus separate Y and C for S-Video
}`;

const IMPAIR_FS = FS_IO + COMMON + /* glsl */ `
uniform sampler2D uSig;
uniform float uNoise, uGhost, uGhostD, uHum;
void main() {
  vec2 px = 1.0 / uRes;
  vec3 s = decS(texture(uSig, vUv).rgb);
  if (uGhost > 0.001) {
    s += uGhost * decS(texture(uSig, vUv - vec2(uGhostD * px.x, 0.0)).rgb);
    s -= uGhost * 0.4 * decS(texture(uSig, vUv - vec2(uGhostD * 2.3 * px.x, 0.0)).rgb);  // second, inverted reflection
  }
  vec2 cell = floor(vUv * uRes);
  float seed = fract(uTime * 9.73) * 431.0;
  s += uNoise * 0.6 * (vec3(hash12(cell + seed), hash12(cell + seed), hash12(cell.yx + seed + 17.0)) - 0.5);
  s.xy += uHum * 0.12 * sin((vUv.y + uTime * 0.19) * 6.2831853);
  outColor = vec4(encS(s), 1.0);
}`;

const DECODE_FS = FS_IO + COMMON + /* glsl */ `
uniform sampler2D uSig;
uniform float uMode, uFl, uFc, uRing, uTint, uColor, uPhaseNoise;
float lp(float x, float fc, float ring) {
  float g = exp(-28.5 * x * x * fc * fc);
  float a = 6.2831853 * fc * x;
  float sinc = abs(a) < 1e-4 ? 1.0 : sin(a) / a;
  float win = 0.5 + 0.5 * cos(3.14159265 * x / ${N + 1}.0);
  return mix(g, sinc * win, ring);
}
void main() {
  vec2 px = 1.0 / uRes;
  vec2 fc = floor(vUv * uRes);
  float line = uRes.y - 1.0 - fc.y;
  vec2 base = (fc + 0.5) * px;
  float jit = (hash12(vec2(line, uFrame)) - 0.5) * uPhaseNoise;
  float A = 0.0, B = 0.0, D = 0.0, I = 0.0, Q = 0.0, wl = 0.0, wc = 0.0;
  for (int k = -${N}; k <= ${N}; k++) {
    float fk = float(k);
    vec2 p = base + vec2(fk * px.x, 0.0);
    vec3 s = decS(texture(uSig, p).rgb);
    float comp = s.x, chr = s.x;
    if (uMode > 0.5 && uMode < 1.5) {            // 2-line comb: the line above has opposite subcarrier phase
      float s2 = decS(texture(uSig, p + vec2(0.0, px.y)).rgb).x;
      comp = 0.5 * (s.x + s2); chr = 0.5 * (s.x - s2);
    } else if (uMode > 2.5) { comp = s.y; chr = s.z; }   // S-Video: luma and chroma on separate wires
    float ph = scPhase(fc.x + fk, line) + uTint + jit;
    float a = lp(fk, uFl, uRing), b = lp(fk, uFc, 0.0);
    A += a * comp; B += a * cos(ph); D += a * sin(ph); wl += a;
    I += b * chr * 2.0 * cos(ph); Q += b * chr * 2.0 * sin(ph); wc += b;
  }
  I /= wc; Q /= wc;
  float Y = uMode < 0.5 ? (A - I * B - Q * D) / wl : A / wl;   // notch: subtract the re-modulated chroma
  outColor = vec4(clamp(YIQ2RGB * vec3(Y, I * uColor, Q * uColor), 0.0, 1.0), 1.0);
}`;

class NtscFX extends BaseFX {
  constructor(r) {
    super(r);
    this.enc = r.fx(ENCODE_FS);
    this.imp = r.fx(IMPAIR_FS);
    this.dec = r.fx(DECODE_FS);
  }
  render(p, ctx, target) {
    const r = this.r;
    const lines = Math.round(p.lines) === 0 ? 480 : 240;
    const h = Math.max(16, Math.min(r.h, lines));
    const sig = this.target('sig', SIG_W, h, { float: true, filter: 'nearest' });
    const sig2 = this.target('sig2', SIG_W, h, { float: true, filter: 'nearest' });
    const out = this.target('out', SIG_W, h);
    const crawl = Math.PI * ctx.frame * p.crawl;
    r.pass(this.enc, sig, { uCrawl: crawl, uPreY: 2.2 - 1.7 * p.rainbow, uPreC: 3.0 }, { uSrc: r.cur });
    r.pass(this.imp, sig2, { uCrawl: crawl, uNoise: p.noise, uGhost: p.ghost, uGhostD: p.ghostDelay * FS_MHZ, uHum: p.hum }, { uSig: sig });
    r.pass(this.dec, out, {
      uCrawl: crawl, uMode: p.connection, uFl: p.lumaBw / FS_MHZ, uFc: p.chromaBw / FS_MHZ, uRing: p.ringing,
      uTint: p.tint * Math.PI / 180, uColor: p.color, uPhaseNoise: p.phaseNoise * 1.2,
    }, { uSig: sig2 });
    r.blit(out, target);
  }
}

export default {
  id: 'ntsc',
  name: 'NTSC',
  description: 'Real composite video math: 3.58 MHz colour subcarrier, dot crawl, rainbow cross-colour, ghosts and snow.',
  swatch: ['#1b2a4a', '#f2c14e'],
  params: [
    { id: 'connection', label: 'Connection / Decoder', type: 'select', options: ['Composite, notch filter', 'Composite, comb filter', 'Composite, no filter', 'S-Video'], value: 0 },
    { id: 'lumaBw', label: 'Luma Bandwidth (MHz)', min: 0.8, max: 6, step: 0.05, value: 4.2 },
    { id: 'chromaBw', label: 'Chroma Bandwidth (MHz)', min: 0.15, max: 2, step: 0.01, value: 0.6 },
    { id: 'color', label: 'Color', min: 0, max: 2.5, step: 0.01, value: 1.1, mod: { band: 'mid', depth: 0.15 } },
    { id: 'tint', label: 'Tint (phase error, deg)', min: -180, max: 180, step: 1, value: 0 },
    { id: 'rainbow', label: 'Cross-Color (rainbows)', min: 0, max: 1, step: 0.01, value: 0.7 },
    { id: 'ringing', label: 'Ringing', min: 0, max: 1, step: 0.01, value: 0.5 },
    { id: 'crawl', label: 'Dot Crawl', min: 0, max: 1, step: 0.01, value: 0.5 },
    { id: 'noise', label: 'Snow', min: 0, max: 1, step: 0.01, value: 0.1, mod: { band: 'highmid', depth: 0.25 } },
    { id: 'ghost', label: 'Ghosting', min: 0, max: 0.8, step: 0.01, value: 0.12, mod: { band: 'hit', depth: 0.3 } },
    { id: 'ghostDelay', label: 'Ghost Delay (µs)', min: 0.2, max: 8, step: 0.05, value: 1.6 },
    { id: 'phaseNoise', label: 'Hue Jitter', min: 0, max: 1, step: 0.01, value: 0.05 },
    { id: 'hum', label: 'Hum Bar', min: 0, max: 1, step: 0.01, value: 0 },
    { id: 'lines', label: 'Scan Lines', type: 'select', options: ['480 (interlaced TV)', '240 (old consoles)'], value: 0 },
  ],
  create: r => new NtscFX(r),
};
