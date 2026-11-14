import { BaseFX, FS_IO } from '../gl.js';

// VHS, modeled on how the format stores a picture: FM luma limited to about
// 3 MHz, "colour-under" chroma limited to about 0.4 MHz and delayed, a
// mechanical tape path (time-base jitter, flagging, tracking errors, the
// head-switching band at the bottom) and oxide dropouts.
const T_LINE = 52.6;            // visible line time in microseconds
const SPEED = [1, 0.8, 0.62];   // SP, LP, EP bandwidth factors

const YIQ = /* glsl */ `
const mat3 RGB2YIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
const mat3 YIQ2RGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
`;

// Pass 1: what ends up on the tape (line displacement + band-limited Y and C).
const TAPE_FS = FS_IO + YIQ + /* glsl */ `
uniform sampler2D uSrc;
uniform float uLumaS, uChromaS, uChromaShift, uJitter, uWave, uSkew, uTrack, uTrackPos, uTrackH, uHead;
void main() {
  vec2 px = 1.0 / uRes;
  float line = floor((1.0 - vUv.y) * uRes.y);
  float fl = line / uRes.y;
  float sc = uRes.x / 640.0;
  float off = (hash12(vec2(line, uFrame)) - 0.5) * uJitter * 3.0;
  off += (sin(fl * 9.0 + uTime * 2.3) * 3.0 + sin(fl * 31.0 - uTime * 5.1)) * uWave;
  float band = smoothstep(uTrackH, 0.0, abs(fl - uTrackPos)) * uTrack;
  off += band * 36.0 * (hash12(vec2(line * 1.3, uFrame)) - 0.3);
  float inHead = step(uRes.y - uHead, line);
  off += inHead * (14.0 + 30.0 * hash11(uFrame * 0.37)) * (0.4 + (line - (uRes.y - uHead)) / max(uHead, 1.0));
  off += uSkew * 46.0 * exp(-fl * 14.0) * (0.6 + 0.4 * sin(uTime * 3.0));
  vec2 uv = vec2(vUv.x + off * sc * px.x, vUv.y);
  float Y = 0.0, wy = 0.0, wc = 0.0;
  vec2 C = vec2(0.0);
  float sy = max(uLumaS, 0.3), scs = max(uChromaS, 0.5);
  float stepY = max(1.0, sy / 3.0), stepC = max(1.0, scs / 3.0);
  for (int k = -8; k <= 8; k++) {
    float fk = float(k);
    float dy = fk * stepY, dc = fk * stepC;
    float a = exp(-dy * dy / (2.0 * sy * sy)), b = exp(-dc * dc / (2.0 * scs * scs));
    Y += dot(texture(uSrc, uv + vec2(dy * px.x, 0.0)).rgb, vec3(0.299, 0.587, 0.114)) * a; wy += a;
    C += (RGB2YIQ * texture(uSrc, uv + vec2((dc - uChromaShift) * px.x, px.y)).rgb).yz * b; wc += b;
  }
  outColor = vec4(Y / wy, C / wc * 0.5 + 0.5, 1.0);
}`;

// Pass 2: playback (chroma delay-line smear, sharpness circuit, noise, dropouts, OSD).
const PLAY_FS = FS_IO + YIQ + /* glsl */ `
uniform sampler2D uTape, uOsd;
uniform vec2 uTapeRes;
uniform float uSharp, uVSmear, uLNoise, uCNoise, uDrop, uTrack, uTrackPos, uTrackH, uHead, uSat, uOsdOn;
void main() {
  vec2 tp = 1.0 / uTapeRes;
  float line = floor((1.0 - vUv.y) * uTapeRes.y);
  float fl = line / uTapeRes.y;
  float tx = vUv.x * uTapeRes.x;
  vec3 t = texture(uTape, vUv).rgb;
  float Y = t.r;
  float side = texture(uTape, vUv - vec2(2.0 * tp.x, 0.0)).r + texture(uTape, vUv + vec2(2.0 * tp.x, 0.0)).r;
  Y += uSharp * (Y - 0.5 * side);                       // peaking: overshoot halos on edges
  vec2 C = t.gb; float w = 1.0;
  for (int i = 1; i <= 4; i++) {
    float wi = uVSmear * (1.0 - float(i) / 5.0);
    C += texture(uTape, vUv + vec2(0.0, float(i) * tp.y)).gb * wi; w += wi;
  }
  C = C / w * 2.0 - 1.0;
  float seed = fract(uTime * 13.7) * 311.0;
  Y += uLNoise * (0.16 * (hash12(vec2(floor(tx), line) + seed) - 0.5) + 0.14 * (noise(vec2(tx * 0.08, line + uFrame * 7.3)) - 0.5));
  C += uCNoise * 0.45 * (vec2(noise(vec2(tx * 0.03, line + uFrame * 3.1)), noise(vec2(tx * 0.03 + 50.0, line - uFrame * 5.7))) - 0.5);
  float band = smoothstep(uTrackH, 0.0, abs(fl - uTrackPos)) * uTrack;
  float snow = step(1.0 - band * 0.6, hash12(vec2(floor(tx * 0.5), line) + uFrame));
  Y = mix(Y, 0.92, snow * band); C *= 1.0 - band * 0.8;
  float inHead = step(uTapeRes.y - uHead, line);
  Y = mix(Y, Y * 0.6 + 0.5 * hash12(vec2(floor(tx * 0.25), line + uFrame)), inHead * 0.55); C *= 1.0 - inHead * 0.7;
  if (hash12(vec2(line, uFrame)) < uDrop * 0.035) {      // oxide dropout: white streak with a comet tail
    float x0 = hash12(vec2(line + 7.0, uFrame));
    float d = (vUv.x - x0) / (0.05 + 0.25 * hash12(vec2(line + 3.0, uFrame)));
    if (d > 0.0 && d < 1.0) { Y = mix(Y, 1.0, (1.0 - d) * 0.9); C *= d; }
  }
  vec3 rgb = YIQ2RGB * vec3(Y, C * uSat);
  vec4 o = texture(uOsd, vUv);
  rgb = mix(rgb, o.rgb, o.a * uOsdOn);
  outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

class VhsFX extends BaseFX {
  constructor(r) {
    super(r);
    this.tape = r.fx(TAPE_FS);
    this.play = r.fx(PLAY_FS);
    const gl = r.gl;
    this.osd = document.createElement('canvas');
    this.osdTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.osdTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.osdKey = '';
  }

  drawOsd(mode, speed, time, w, h) {
    const secs = Math.floor(time);
    const blink = mode === 2 ? Math.floor(time * 2) % 2 : 1;
    const key = `${mode}|${speed}|${secs}|${blink}|${w}x${h}`;
    if (key === this.osdKey) return;
    this.osdKey = key;
    const c = this.osd, g = c.getContext('2d');
    c.width = w; c.height = h;
    g.clearRect(0, 0, w, h);
    const fs = Math.round(h * 0.075);
    g.font = `bold ${fs}px "Courier New", ui-monospace, monospace`;
    g.textBaseline = 'top';
    const text = (s, x, y, align = 'left') => {
      g.textAlign = align;
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillText(s, x + fs * 0.06, y + fs * 0.06);
      g.fillStyle = '#f4f4f4'; g.fillText(s, x, y);
    };
    const m = h * 0.07;
    if (mode === 1) text('PLAY ▶', m, m);
    else if (blink) { text('REC', m + fs * 0.9, m); g.fillStyle = '#ff2a2a'; g.beginPath(); g.arc(m + fs * 0.35, m + fs * 0.45, fs * 0.28, 0, Math.PI * 2); g.fill(); }
    text(['SP', 'LP', 'EP'][speed], w - m, m, 'right');
    const t = `${Math.floor(secs / 3600)}:${String(Math.floor(secs / 60) % 60).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
    text(t, m, h - m - fs);
    const gl = this.r.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.osdTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  render(p, ctx, target) {
    const r = this.r;
    const th = Math.max(16, Math.min(r.h, 480));
    const tw = Math.max(32, Math.min(r.w, Math.round(th * r.w / r.h), 720));
    const tape = this.target('tape', tw, th);
    const speed = Math.round(p.speed), gen = Math.sqrt(p.generations);
    const k = SPEED[speed] / gen;
    const sigma = mhz => (0.1325 / Math.max(0.05, mhz * k)) / T_LINE * tw;   // Gaussian with -3 dB at that bandwidth
    const trackPos = ((p.trackPos + ctx.time * p.trackSpeed * 0.15) % 1 + 1) % 1;
    const trackH = 0.03 + p.tracking * 0.09;
    const head = p.head * th / 480;
    r.pass(this.tape, tape, {
      uLumaS: sigma(p.luma), uChromaS: sigma(p.chroma), uChromaShift: p.bleed * tw / 640,
      uJitter: p.jitter * gen, uWave: p.wave, uSkew: p.skew, uTrack: p.tracking, uTrackPos: trackPos, uTrackH: trackH, uHead: head,
    }, { uSrc: r.cur });
    const osd = Math.round(p.osd);
    if (osd) this.drawOsd(osd, speed, ctx.time, 320, Math.round(320 * r.h / r.w));
    r.pass(this.play, target, {
      uTapeRes: [tw, th], uSharp: p.sharp, uVSmear: p.vsmear, uLNoise: p.lnoise * gen / SPEED[speed], uCNoise: p.cnoise * gen / SPEED[speed],
      uDrop: p.dropouts, uTrack: p.tracking, uTrackPos: trackPos, uTrackH: trackH, uHead: head,
      uSat: p.saturation / Math.pow(gen, 0.5), uOsdOn: osd ? 1 : 0,
    }, { uTape: tape, uOsd: this.osdTex });
  }
  dispose() { super.dispose(); this.r.gl.deleteTexture(this.osdTex); }
}

export default {
  id: 'vhs',
  name: 'VHS',
  description: 'Tape-path emulation: 3 MHz luma, smeared colour-under chroma, tracking errors, head-switching noise, dropouts.',
  swatch: ['#101a3a', '#e0e6ff'],
  params: [
    { id: 'speed', label: 'Tape Speed', type: 'select', options: ['SP (best)', 'LP', 'EP / SLP (worst)'], value: 0 },
    { id: 'generations', label: 'Copy Generations', min: 1, max: 6, step: 1, value: 1 },
    { id: 'luma', label: 'Luma Bandwidth (MHz)', min: 0.8, max: 4.5, step: 0.05, value: 3 },
    { id: 'chroma', label: 'Chroma Bandwidth (MHz)', min: 0.1, max: 1.5, step: 0.01, value: 0.4 },
    { id: 'bleed', label: 'Chroma Delay (bleed)', min: 0, max: 14, step: 0.1, value: 3.5 },
    { id: 'vsmear', label: 'Chroma Vertical Smear', min: 0, max: 1, step: 0.01, value: 0.5 },
    { id: 'sharp', label: 'Sharpness Circuit', min: 0, max: 2.5, step: 0.01, value: 0.9 },
    { id: 'lnoise', label: 'Luma Noise', min: 0, max: 1.5, step: 0.01, value: 0.4, mod: { band: 'highmid', depth: 0.2 } },
    { id: 'cnoise', label: 'Chroma Noise', min: 0, max: 1.5, step: 0.01, value: 0.45 },
    { id: 'jitter', label: 'Time-Base Jitter', min: 0, max: 1, step: 0.01, value: 0.25, mod: { band: 'mid', depth: 0.2 } },
    { id: 'wave', label: 'Tape Wobble', min: 0, max: 1, step: 0.01, value: 0.15 },
    { id: 'skew', label: 'Top Flagging (skew)', min: 0, max: 1, step: 0.01, value: 0 },
    { id: 'tracking', label: 'Tracking Error', min: 0, max: 1, step: 0.01, value: 0.2, mod: { band: 'hit', depth: 0.5 } },
    { id: 'trackPos', label: 'Tracking Position', min: 0, max: 1, step: 0.01, value: 0.82 },
    { id: 'trackSpeed', label: 'Tracking Roll', min: -2, max: 2, step: 0.01, value: 0.3 },
    { id: 'head', label: 'Head-Switch Noise (lines)', min: 0, max: 30, step: 1, value: 9 },
    { id: 'dropouts', label: 'Dropouts', min: 0, max: 1, step: 0.01, value: 0.25 },
    { id: 'saturation', label: 'Color', min: 0, max: 2, step: 0.01, value: 0.95 },
    { id: 'osd', label: 'On-Screen Display', type: 'select', options: ['Off', 'PLAY', 'REC'], value: 0 },
  ],
  create: r => new VhsFX(r),
};
