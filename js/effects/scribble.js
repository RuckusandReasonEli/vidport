import { BaseFX, FS_IO } from '../gl.js';

// Scribble: masks people with on-device body segmentation, builds a distance
// field around them, and draws hand-made marks that follow the silhouette.
// Three styles share this file: thick painted contours (GPU), random straight
// strokes and small swirls (vector strokes on a 2D canvas).

const GRID = 192;                 // long side of the analysis grid
const MAX_D = 0.5;                // distances stored up to half the frame height

/* ---------- Body field (cached per renderer and frame) ---------- */
const DOWN_FS = FS_IO + `uniform sampler2D uSrc; void main() { outColor = vec4(texture(uSrc, vUv).rgb, 1.0); }`;

function bodyField(r, tracker) {
  const key = r.frameIndex + '|' + r.time;
  if (r._body && r._body.key === key) return r._body;
  const gw = r.w >= r.h ? GRID : Math.max(16, Math.round(GRID * r.w / r.h));
  const gh = r.w >= r.h ? Math.max(16, Math.round(GRID * r.h / r.w)) : GRID;
  let B = r._body;
  if (!B || B.gw !== gw || B.gh !== gh) {
    if (B && B.small) B.small.dispose();
    B = r._body = {
      gw, gh, small: r.createTarget(gw, gh), down: r.fx(DOWN_FS),
      px: new Uint8Array(gw * gh * 4), img: new ImageData(gw, gh),
      mask: new Float32Array(gw * gh), dist: new Float32Array(gw * gh), tex: null, found: 0,
    };
    const gl = r.gl;
    B.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, B.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    B.texData = new Uint8Array(gw * gh * 4);
  }
  B.key = key;
  if (!tracker || !tracker.tasks || !tracker.tasks.seg) { B.found = Math.max(0, B.found - 0.1); return B; }

  // Small copy of the (graded) frame -> segmenter. GL rows run bottom-up; images run top-down.
  const gl = r.gl;
  r.pass(B.down, B.small, {}, { uSrc: r.cur });
  gl.bindFramebuffer(gl.FRAMEBUFFER, B.small.fbo);
  gl.readPixels(0, 0, gw, gh, gl.RGBA, gl.UNSIGNED_BYTE, B.px);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const rowB = gw * 4;
  for (let y = 0; y < gh; y++) B.img.data.set(B.px.subarray((gh - 1 - y) * rowB, (gh - y) * rowB), y * rowB);
  const seg = tracker.segment(B.img);
  if (!seg) return B;

  // Resample to the grid (bottom-up), smooth over time, measure coverage.
  let cover = 0;
  for (let y = 0; y < gh; y++) {
    const sy = Math.min(seg.h - 1, Math.floor((gh - 1 - y + 0.5) / gh * seg.h));
    for (let x = 0; x < gw; x++) {
      const sx = Math.min(seg.w - 1, Math.floor((x + 0.5) / gw * seg.w));
      const i = y * gw + x;
      const v = B.mask[i] * 0.4 + seg.data[sy * seg.w + sx] * 0.6;
      B.mask[i] = v;
      if (v > 0.5) cover++;
    }
  }
  // Drop specks: keep only connected regions of a reasonable size.
  if (!B.label || B.label.length !== gw * gh) { B.label = new Int32Array(gw * gh); B.stack = new Int32Array(gw * gh); }
  const lab = B.label, st = B.stack, minArea = gw * gh * 0.006;
  lab.fill(0);
  for (let i0 = 0, id = 0; i0 < lab.length; i0++) {
    if (lab[i0] || B.mask[i0] <= 0.5) continue;
    id++;
    let top = 0, area = 0;
    st[top++] = i0; lab[i0] = id;
    const cells = [];
    while (top) {
      const i = st[--top]; cells.push(i); area++;
      const x = i % gw;
      for (const j of [i - 1, i + 1, i - gw, i + gw]) {
        if (j < 0 || j >= lab.length || lab[j] || B.mask[j] <= 0.5) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === gw - 1)) continue;
        lab[j] = id; st[top++] = j;
      }
    }
    if (area < minArea) { for (const i of cells) B.mask[i] = 0; cover -= area; }
  }
  B.found = cover > gw * gh * 0.004 ? 1 : Math.max(0, B.found - 0.15);

  // Two-pass chamfer distance (outside the body), in grid cells.
  const D = B.dist, INF = 1e6;
  for (let i = 0; i < D.length; i++) D[i] = B.mask[i] > 0.5 ? 0 : INF;
  const a = 1, b = 1.414;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x; let d = D[i];
    if (x > 0) d = Math.min(d, D[i - 1] + a);
    if (y > 0) { d = Math.min(d, D[i - gw] + a); if (x > 0) d = Math.min(d, D[i - gw - 1] + b); if (x < gw - 1) d = Math.min(d, D[i - gw + 1] + b); }
    D[i] = d;
  }
  for (let y = gh - 1; y >= 0; y--) for (let x = gw - 1; x >= 0; x--) {
    const i = y * gw + x; let d = D[i];
    if (x < gw - 1) d = Math.min(d, D[i + 1] + a);
    if (y < gh - 1) { d = Math.min(d, D[i + gw] + a); if (x < gw - 1) d = Math.min(d, D[i + gw + 1] + b); if (x > 0) d = Math.min(d, D[i + gw - 1] + b); }
    D[i] = d;
  }
  for (let i = 0; i < D.length; i++) D[i] = Math.min(MAX_D, D[i] / gh);   // in frame heights
  // Soften the chamfer facets (two 3x3 box passes) so contours come out round.
  if (!B.tmp || B.tmp.length !== D.length) B.tmp = new Float32Array(D.length);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass ? B.tmp : D, dst = pass ? D : B.tmp;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let sum = 0, n = 0;
      for (let j = -1; j <= 1; j++) { const yy = y + j; if (yy < 0 || yy >= gh) continue; for (let k = -1; k <= 1; k++) { const xx = x + k; if (xx < 0 || xx >= gw) continue; sum += src[yy * gw + xx]; n++; } }
      dst[y * gw + x] = sum / n;
    }
  }
  for (let i = 0; i < D.length; i++) {
    if (B.mask[i] > 0.5) D[i] = 0;
    B.texData[i * 4] = Math.round(B.mask[i] * 255);
    const q = Math.round(D[i] / MAX_D * 65535);               // 16-bit distance split over G (high) and B (low)
    B.texData[i * 4 + 1] = q >> 8;
    B.texData[i * 4 + 2] = q & 255;
    B.texData[i * 4 + 3] = 255;
  }
  gl.bindTexture(gl.TEXTURE_2D, B.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gw, gh, 0, gl.RGBA, gl.UNSIGNED_BYTE, B.texData);
  return B;
}

/* ---------- Compositing shader (thick strokes drawn here) ---------- */
const FS = FS_IO + /* glsl */ `
uniform sampler2D uSrc, uField, uOv;
uniform vec3 uC0, uC1, uC2, uPaper;
uniform float uThick, uOvOn, uFound;
uniform float uRings, uOffset, uSpacing, uWidth, uWobble, uWobFreq, uSeed, uDry, uFill, uColorMode;
uniform float uBg, uBody, uOrder, uFeather;
uniform vec2 uFlow;
float dist(vec2 uv) { vec4 f = texture(uField, uv); return (f.g * 65280.0 + f.b * 255.0) / 65535.0 * ${MAX_D.toFixed(2)}; }
vec3 pal(float k) {
  if (uColorMode > 0.5 && uColorMode < 1.5) return uC0;
  float i = uColorMode > 1.5 ? floor(hash11(k * 3.7 + floor(uSeed)) * 3.0) : mod(k, 3.0);
  return i < 0.5 ? uC0 : (i < 1.5 ? uC1 : uC2);
}
void main() {
  vec3 src = texture(uSrc, vUv).rgb;
  vec4 f = texture(uField, vUv);
  float body = smoothstep(0.5 - uFeather, 0.5 + uFeather, f.r) * uFound;
  float d = dist(vUv);
  float aspect = uRes.x / uRes.y;
  vec2 p = vUv * vec2(aspect, 1.0);

  // Background
  vec3 bg = src;
  if (uBg > 0.5 && uBg < 1.5) bg = uPaper * (0.94 + 0.06 * noise(p * 260.0)) ;
  else if (uBg > 1.5 && uBg < 2.5) bg = src * 0.35;
  else if (uBg > 2.5) bg = vec3(0.0);
  bg = mix(src, bg, uFound);

  // Body look
  vec3 fig = src;
  if (uBody > 0.5 && uBody < 1.5) fig = floor(pow(src, vec3(0.9)) * 4.0 + 0.5) / 4.0;
  else if (uBody > 1.5 && uBody < 2.5) { float l = luma(src); fig = mix(vec3(l), src, 0.35); fig = clamp((fig - 0.45) * 1.7 + 0.5, 0.0, 1.0) * vec3(0.86, 0.97, 1.05); }
  else if (uBody > 2.5) { float l = smoothstep(0.25, 0.75, luma(src)); fig = mix(vec3(0.07, 0.08, 0.12), uPaper, l); }

  // Thick painted contours
  vec4 ink = vec4(0.0);
  if (uThick > 0.5 && uFound > 0.0) {
    float aa = 1.5 / uRes.y;
    for (int k = 5; k >= 0; k--) {
      float fk = float(k);
      if (fk >= uRings) continue;
      float c = uOffset + fk * uSpacing;
      vec2 q = p * uWobFreq + uFlow + vec2(uSeed * 1.31 + fk * 7.1, uSeed * 0.73 - fk * 3.3);
      float wob = (noise(q) - 0.5) * uWobble + (noise(q * 3.1) - 0.5) * uWobble * 0.35;
      float halfW = uWidth * 0.5 * (0.75 + 0.5 * noise(q * 0.7 + 11.0));
      float cov = 1.0 - smoothstep(halfW - aa, halfW + aa, abs(d - c + wob));
      float bristle = noise(vec2((d + wob) * 190.0 + fk * 13.0, fk * 4.1 + floor(uSeed)));   // lines parallel to the stroke
      float skip = noise(p * 7.0 + vec2(fk * 2.3, uSeed));                                        // where the brush runs dry
      cov *= mix(1.0, smoothstep(0.3, 0.5, bristle) * smoothstep(0.2, 0.55, skip + 0.25), uDry);
      if (fk < 0.5 && uFill > 0.0) cov = max(cov, uFill * (1.0 - smoothstep(c - aa, c + aa, d + wob)));   // solid fill, no dry gaps
      ink = mix(ink, vec4(pal(fk), 1.0), cov);
    }
  }
  if (uOvOn > 0.5) { vec4 o = texture(uOv, vUv); ink = vec4(mix(ink.rgb, o.rgb, o.a), max(ink.a, o.a)); }

  vec3 col = mix(bg, ink.rgb, ink.a);
  if (uOrder < 0.5) col = mix(col, fig, body);                 // marks behind the body
  else col = mix(mix(bg, fig, body), ink.rgb, ink.a);          // marks over everything
  outColor = vec4(col, 1.0);
}`;

function rnd(seed) { let t = (seed + 0x6d2b79f5) >>> 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const hex3 = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

class ScribbleFX extends BaseFX {
  constructor(r, style) {
    super(r);
    this.style = style;
    this.prog = r.fx(FS);
    if (style !== 'thick') {
      this.canvas = document.createElement('canvas');
      this.g = this.canvas.getContext('2d');
      const gl = r.gl;
      this.ovTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.ovTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    }
    this.band = [];
  }

  /** Cells of the grid that sit in the band around the body, with outward normals. */
  collectBand(B, p) {
    const { gw, gh, dist } = B;
    const lo = p.offset, hi = p.offset + p.spread;
    const band = [];
    for (let y = 1; y < gh - 1; y += 1) for (let x = 1; x < gw - 1; x += 1) {
      const d = dist[y * gw + x];
      if (d < lo || d > hi || d >= MAX_D) continue;
      const gx = dist[y * gw + x + 1] - dist[y * gw + x - 1], gy = dist[(y + 1) * gw + x] - dist[(y - 1) * gw + x];
      const L = Math.hypot(gx, gy) || 1;
      band.push([(x + 0.5) / gw, 1 - (y + 0.5) / gh, gx / L, -gy / L]);   // canvas space: y down
    }
    this.band = band;
  }

  drawMarks(p, time, tick) {
    const r = this.r, g = this.g, W = r.w, H = r.h, s = H / 720;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    g.clearRect(0, 0, W, H);
    const band = this.band;
    if (!band.length) return;
    const cols = [p.colorA, p.colorB, p.colorC];
    const mode = Math.round(p.colorMode);
    const colorFor = i => (mode === 1 ? cols[0] : mode === 2 ? cols[Math.floor(rnd(i * 31 + tick * 7) * 3)] : cols[i % 3]);
    const n = Math.round(p.density);
    const seedBase = tick * 7919;
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (let i = 0; i < n; i++) {
      const R = k => rnd(i * 977 + k * 131 + seedBase);
      const cell = band[Math.floor(rnd(i * 977 + 17 + (p.boil > 0 ? seedBase : 0)) * band.length)];
      const cx = cell[0] * W + (R(1) - 0.5) * p.wobble * 18 * s, cy = cell[1] * H + (R(2) - 0.5) * p.wobble * 18 * s;
      const nx = cell[2], ny = cell[3], tx = -ny, ty = nx;
      const pulse = p.pulse > 0 ? 1 - p.pulse * (0.5 + 0.5 * Math.sin(time * (1 + p.speed * 2) + i * 2.17)) : 1;
      g.strokeStyle = colorFor(i);
      g.lineWidth = Math.max(0.6, p.width * s * (0.6 + 0.8 * R(3)));
      if (this.style === 'lines') {
        const ang = R(4) * Math.PI + time * p.speed * (R(5) - 0.5) * 0.8;
        const len = p.length * H * (0.35 + 1.3 * R(6)) * pulse;
        const dx = Math.cos(ang) * len / 2, dy = Math.sin(ang) * len / 2;
        const strokes = R(7) < p.double ? 2 : 1;
        for (let k = 0; k < strokes; k++) {
          const o = k * (2 + 3 * R(8)) * s;
          g.beginPath();
          g.moveTo(cx - dx + o, cy - dy - o * 0.6);
          g.lineTo(cx + dx + o + (R(9) - 0.5) * p.wobble * 6 * s, cy + dy - o * 0.6 + (R(10) - 0.5) * p.wobble * 6 * s);
          g.stroke();
        }
      } else {
        const rr = p.loopSize * s * (0.6 + 0.8 * R(11));
        const shape = Math.round(p.shape) === 2 ? (R(12) < 0.5 ? 0 : 1) : Math.round(p.shape);
        const phase = time * p.speed * (1.5 + R(13) * 2) * (R(14) < 0.5 ? -1 : 1) + R(15) * 6.28;
        g.beginPath();
        if (shape === 0) {                                     // cursive loops travelling along the contour
          const len = p.length * H * (0.5 + R(16)) * pulse;
          const loops = Math.max(1.5, len / (rr * 1.6));
          const steps = Math.ceil(loops * 14);
          for (let k = 0; k <= steps; k++) {
            const u = k / steps, th = u * loops * Math.PI * 2 + phase;
            const along = (u - 0.5) * len + Math.cos(th) * rr * 1.15;
            const across = Math.sin(th) * rr + (rnd(i * 13 + k + seedBase) - 0.5) * p.wobble * 2 * s;
            const x = cx + tx * along + nx * across, y = cy + ty * along + ny * across;
            k ? g.lineTo(x, y) : g.moveTo(x, y);
          }
        } else {                                               // small spirals
          const turns = 1.5 + R(17) * 2.5 * pulse;
          const steps = Math.ceil(turns * 24);
          for (let k = 0; k <= steps; k++) {
            const u = k / steps, th = u * turns * Math.PI * 2 + phase;
            const rad = rr * 1.6 * u + (rnd(i * 29 + k + seedBase) - 0.5) * p.wobble * 1.5 * s;
            const x = cx + Math.cos(th) * rad, y = cy + Math.sin(th) * rad;
            k ? g.lineTo(x, y) : g.moveTo(x, y);
          }
        }
        g.stroke();
      }
    }
  }

  render(p, ctx, target) {
    const r = this.r;
    const B = bodyField(r, ctx.tracker);
    const tick = p.boil > 0 ? Math.floor(ctx.time * p.boil) : 0;
    const seed = p.boil > 0 ? (tick % 997) * 1.37 : 0;
    const flow = [ctx.time * p.speed * 0.35, ctx.time * p.speed * 0.21];
    if (this.style !== 'thick') {
      if (ctx.step) this.collectBand(B, p);
      this.drawMarks(p, ctx.time, tick);
      const gl = r.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.ovTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }
    const thick = this.style === 'thick';
    r.pass(this.prog, target, {
      uC0: hex3(p.colorA), uC1: hex3(p.colorB), uC2: hex3(p.colorC), uPaper: hex3(p.paper),
      uThick: thick ? 1 : 0, uOvOn: thick ? 0 : 1, uFound: B.found,
      uRings: thick ? p.rings : 0, uOffset: thick ? p.offset : 0, uSpacing: thick ? p.spacing : 0, uWidth: thick ? p.width / 720 : 0,
      uWobble: p.wobble * 0.05, uWobFreq: thick ? p.wobFreq : 1, uSeed: seed, uDry: thick ? p.dry : 0, uFill: thick ? p.fill : 0,
      uColorMode: p.colorMode, uBg: p.background, uBody: p.bodyLook, uOrder: p.order, uFeather: 0.12, uFlow: flow,
    }, { uSrc: r.cur, uField: B.tex, uOv: this.ovTex || B.tex });
  }
  dispose() { super.dispose(); if (this.ovTex) this.r.gl.deleteTexture(this.ovTex); }
}

/* ---------- Three cards ---------- */
const COMMON_HEAD = [
  { id: 'colorA', label: 'Color 1', type: 'color', value: '#c8312b' },
  { id: 'colorB', label: 'Color 2', type: 'color', value: '#f1f1ea' },
  { id: 'colorC', label: 'Color 3', type: 'color', value: '#dc9a2a' },
  { id: 'colorMode', label: 'Color Use', type: 'select', options: ['Cycle colors 1, 2, 3', 'Color 1 only', 'Random from 1, 2, 3'], value: 0 },
];
const COMMON_TAIL = [
  { id: 'boil', label: 'Boil (redraws / sec, 0 = smooth)', min: 0, max: 24, step: 1, value: 8 },
  { id: 'wobble', label: 'Hand Wobble', min: 0, max: 1, step: 0.01, value: 0.45, mod: { band: 'hit', depth: 0.3 } },
  { id: 'speed', label: 'Motion Speed', min: 0, max: 3, step: 0.01, value: 0.6, mod: { band: 'mid', depth: 0.2 } },
  { id: 'background', label: 'Background', type: 'select', options: ['Original', 'Paper', 'Dimmed', 'Black'], value: 1 },
  { id: 'paper', label: 'Paper Color', type: 'color', value: '#dfe3dc' },
  { id: 'bodyLook', label: 'Body Look', type: 'select', options: ['Original', 'Posterized', 'Cool contrast', 'Duotone'], value: 2 },
  { id: 'order', label: 'Marks', type: 'select', options: ['Behind the body', 'Over everything'], value: 0 },
];

const card = (id, name, description, swatch, style, params, defaults = {}) => ({
  id, name, description, swatch, needs: () => ['seg'],
  params: [...COMMON_HEAD, ...params, ...COMMON_TAIL].map(q => (q.id in defaults ? { ...q, value: defaults[q.id] } : q)),
  create: r => new ScribbleFX(r, style),
});

export const scribbleThick = card('scribble-thick', 'Scribble: Thick', 'Finds bodies and paints thick, brushy contour strokes around them.', ['#c8312b', '#dfe3dc'], 'thick', [
  { id: 'rings', label: 'Strokes', min: 1, max: 6, step: 1, value: 3 },
  { id: 'offset', label: 'Distance from Body', min: 0, max: 0.2, step: 0.002, value: 0.03 },
  { id: 'spacing', label: 'Stroke Spacing', min: 0.01, max: 0.15, step: 0.002, value: 0.07 },
  { id: 'width', label: 'Line Width', min: 4, max: 120, step: 1, value: 46, mod: { band: 'bass', depth: 0.25 } },
  { id: 'fill', label: 'Fill Behind Body', min: 0, max: 1, step: 0.01, value: 1 },
  { id: 'dry', label: 'Dry Brush', min: 0, max: 1, step: 0.01, value: 0.55 },
  { id: 'wobFreq', label: 'Wobble Scale', min: 1, max: 20, step: 0.1, value: 5 },
]);
export const scribbleLines = card('scribble-lines', 'Scribble: Lines', 'Finds bodies and scatters random, intersecting straight strokes around them.', ['#141414', '#f1f1ea'], 'lines', [
  { id: 'density', label: 'Number of Lines', min: 4, max: 300, step: 1, value: 70 },
  { id: 'offset', label: 'Distance from Body', min: 0, max: 0.2, step: 0.002, value: 0.01 },
  { id: 'spread', label: 'Spread', min: 0.02, max: 0.45, step: 0.005, value: 0.18 },
  { id: 'length', label: 'Line Length', min: 0.02, max: 0.8, step: 0.005, value: 0.22 },
  { id: 'width', label: 'Line Width', min: 0.5, max: 16, step: 0.1, value: 3, mod: { band: 'bass', depth: 0.25 } },
  { id: 'double', label: 'Double Strokes', min: 0, max: 1, step: 0.01, value: 0.35 },
  { id: 'pulse', label: 'Draw-On Pulse', min: 0, max: 1, step: 0.01, value: 0 },
], { colorA: '#151515', colorB: '#c8312b', colorC: '#2b4fd8', colorMode: 2 });
export const scribbleSwirl = card('scribble-swirl', 'Scribble: Swirls', 'Finds bodies and wraps them in small, swirly looping marks.', ['#1d2a5a', '#ffd36a'], 'swirl', [
  { id: 'shape', label: 'Swirl Shape', type: 'select', options: ['Loops', 'Spirals', 'Mixed'], value: 0 },
  { id: 'density', label: 'Number of Swirls', min: 4, max: 200, step: 1, value: 45 },
  { id: 'offset', label: 'Distance from Body', min: 0, max: 0.2, step: 0.002, value: 0.02 },
  { id: 'spread', label: 'Spread', min: 0.02, max: 0.45, step: 0.005, value: 0.14 },
  { id: 'loopSize', label: 'Loop Size', min: 2, max: 40, step: 0.5, value: 9 },
  { id: 'length', label: 'Swirl Length', min: 0.02, max: 0.5, step: 0.005, value: 0.12 },
  { id: 'width', label: 'Line Width', min: 0.5, max: 10, step: 0.1, value: 2.2, mod: { band: 'bass', depth: 0.25 } },
  { id: 'pulse', label: 'Draw-On Pulse', min: 0, max: 1, step: 0.01, value: 0 },
], { colorA: '#2340c8', colorB: '#e8481f', colorC: '#151515', paper: '#efe7d6', bodyLook: 0 });
