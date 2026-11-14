// Video Circuit: a patchable chain of analog stages applied along each
// scanline, as if the video signal ran through real components. Time is real:
// one visible line lasts 52.6 microseconds, so a filter's time constant
// (R x C, an LC resonance, a delay line) becomes a distance in pixels.
import { FS_IO } from './gl.js';

export const T_ACTIVE = 52.6e-6;      // seconds of visible picture per scanline
export const LINE_HZ = 15734;         // NTSC horizontal rate
export const MAX_STAGES = 6;

const fmtHz = f => (f >= 1e6 ? (f / 1e6).toFixed(2) + ' MHz' : f >= 1e3 ? (f / 1e3).toFixed(1) + ' kHz' : f.toFixed(0) + ' Hz');
const DIODES = [
  { name: '1N4148 silicon', is: 2.52e-9, nvt: 1.752 * 0.02585, vf: 0.6 },
  { name: '1N34A germanium', is: 2.0e-7, nvt: 1.3 * 0.02585, vf: 0.3 },
  { name: 'Red LED', is: 1.0e-17, nvt: 1.9 * 0.02585, vf: 1.8 },
];

const PATCH = { id: 'patch', label: 'Patch Into', type: 'select', options: ['Luma (Y)', 'RGB', 'Chroma (I/Q)'], value: 0 };
const MIX = { id: 'mix', label: 'Mix (wet / dry)', min: 0, max: 1, step: 0.01, value: 1 };

// Each type: component-value controls plus derive(), which turns them into
// shader numbers (in pixels for a frame W pixels wide) and a readout.
export const CIRCUIT_TYPES = [
  {
    id: 'rc-lp', code: 0, name: 'RC low-pass', chip: 'RC LPF',
    about: 'Series resistor, capacitor to ground. Smears detail to the right like a long or cheap cable.',
    params: [
      { id: 'r', label: 'R (Ω)', min: 75, max: 10000, step: 25, value: 1000 },
      { id: 'c', label: 'C (pF)', min: 10, max: 3000, step: 10, value: 330 },
    ],
    derive(p, W) {
      const tau = p.r * p.c * 1e-12;
      return { P: [tau / T_ACTIVE * W, 0, 0, 0], info: `fc ${fmtHz(1 / (2 * Math.PI * tau))}, τ ${(tau * 1e9).toFixed(0)} ns` };
    },
  },
  {
    id: 'rc-hp', code: 1, name: 'CR high-pass (AC coupling)', chip: 'CR HPF',
    about: 'Coupling capacitor into a resistor. Blocks DC so flat areas sag to the bias level and edges stand out.',
    params: [
      { id: 'r', label: 'R (Ω)', min: 75, max: 10000, step: 25, value: 1000 },
      { id: 'c', label: 'C (pF)', min: 10, max: 20000, step: 10, value: 1500 },
      { id: 'bias', label: 'DC Bias', min: 0, max: 1, step: 0.01, value: 0.5 },
    ],
    derive(p, W) {
      const tau = p.r * p.c * 1e-12;
      return { P: [tau / T_ACTIVE * W, p.bias, 0, 0], info: `fc ${fmtHz(1 / (2 * Math.PI * tau))}, τ ${(tau * 1e9).toFixed(0)} ns` };
    },
  },
  {
    id: 'rlc', code: 2, name: 'RLC resonator', chip: 'RLC',
    about: 'Series inductor and resistor into a capacitor. Rings after every edge at its resonant frequency; lower R means higher Q.',
    params: [
      { id: 'l', label: 'L (µH)', min: 1, max: 500, step: 1, value: 47 },
      { id: 'c', label: 'C (pF)', min: 10, max: 2000, step: 10, value: 220 },
      { id: 'r', label: 'R (Ω)', min: 5, max: 2000, step: 5, value: 120 },
    ],
    derive(p, W) {
      const L = p.l * 1e-6, C = p.c * 1e-12;
      const pxPerSec = W / T_ACTIVE;
      const w0 = 1 / Math.sqrt(L * C), alpha = p.r / (2 * L);
      const disc = w0 * w0 - alpha * alpha;
      const K = 64;
      let wd, span;
      if (disc > 0) { wd = Math.sqrt(disc); span = 5 / alpha; }
      else { wd = -Math.sqrt(-disc); span = 5 / Math.max(1, alpha + wd); }   // overdamped: slow pole sets the length
      let step = span / K;
      if (wd > 0) step = Math.min(step, (2 * Math.PI / wd) / 8);
      const a = alpha / pxPerSec, w = wd / pxPerSec;
      return {
        P: [a, w, Math.max(0.2, step * pxPerSec), 0],
        info: `f0 ${fmtHz(w0 / (2 * Math.PI))}, Q ${(Math.sqrt(L / C) / p.r).toFixed(1)}${disc > 0 ? '' : ' (overdamped)'}`,
      };
    },
  },
  {
    id: 'delay', code: 3, name: 'Delay line + feedback', chip: 'DELAY',
    about: 'A length of coax (or an LC delay line) with some signal fed back. Positive feedback makes echoes, negative makes a comb filter.',
    params: [
      { id: 'ns', label: 'Delay (ns)', min: 50, max: 8000, step: 10, value: 700 },
      { id: 'fb', label: 'Feedback', min: -0.9, max: 0.9, step: 0.01, value: 0.5 },
    ],
    derive(p, W) {
      return { P: [p.ns * 1e-9 / T_ACTIVE * W, p.fb, 0, 0], info: `≈ ${(p.ns * 0.198).toFixed(0)} m of coax, notches every ${fmtHz(1e9 / p.ns)}` };
    },
  },
  {
    id: 'diode', code: 4, name: 'Diode clipper', chip: 'DIODE',
    about: 'Series resistor into diodes to ground, solved with the Shockley diode equation. Squashes whites and blacks softly.',
    params: [
      { id: 'diode', label: 'Diode', type: 'select', options: DIODES.map(d => d.name), value: 0 },
      { id: 'topology', label: 'Topology', type: 'select', options: ['Symmetric (back to back)', 'Asymmetric (single diode)'], value: 0 },
      { id: 'drive', label: 'Drive (gain)', min: 1, max: 30, step: 0.1, value: 4 },
      { id: 'r', label: 'Series R (Ω)', min: 100, max: 10000, step: 50, value: 2200 },
      { id: 'level', label: 'Output Level', min: 0.2, max: 4, step: 0.01, value: 1 },
    ],
    derive(p) {
      const d = DIODES[Math.round(p.diode)];
      return { P: [d.is, d.nvt, p.r, p.drive], Q: [Math.round(p.topology), p.level, 0, 0], info: `Vf ≈ ${d.vf} V, clips at ±${(d.vf / p.drive * 100).toFixed(0)}% of signal` };
    },
  },
  {
    id: 'bjt', code: 5, name: 'Transistor pair (tanh)', chip: 'BJT',
    about: 'A differential pair of transistors. Its transfer curve is exactly tanh: gentle compression, then hard saturation.',
    params: [
      { id: 'gain', label: 'Gain', min: 0.5, max: 40, step: 0.1, value: 6 },
      { id: 'bias', label: 'Bias', min: -0.5, max: 0.5, step: 0.01, value: 0 },
      { id: 'invert', label: 'Output', type: 'select', options: ['Non-inverting', 'Inverting (common emitter)'], value: 0 },
    ],
    derive(p) {
      return { P: [p.gain, p.bias, Math.round(p.invert), 0], info: `×${p.gain.toFixed(1)} (${(20 * Math.log10(p.gain)).toFixed(0)} dB)` };
    },
  },
  {
    id: 'fold', code: 6, name: 'Rectifier / wavefolder', chip: 'FOLD',
    about: 'Precision rectifier stages. Signal that passes the rails folds back, giving solarized bands.',
    params: [
      { id: 'mode', label: 'Mode', type: 'select', options: ['Wavefolder', 'Full-wave rectifier'], value: 0 },
      { id: 'drive', label: 'Drive', min: 1, max: 10, step: 0.05, value: 2.5 },
      { id: 'bias', label: 'Bias', min: -0.5, max: 0.5, step: 0.01, value: 0 },
    ],
    derive(p) {
      return { P: [p.drive, p.bias, Math.round(p.mode), 0], info: `${Math.max(0, Math.ceil(p.drive) - 1)} fold${Math.ceil(p.drive) - 1 === 1 ? '' : 's'}` };
    },
  },
  {
    id: 'comp', code: 7, name: 'Comparator', chip: 'COMP',
    about: 'An op-amp with no feedback. Output slams to a rail when the signal crosses the threshold: a hard key.',
    params: [
      { id: 'thr', label: 'Threshold', min: 0, max: 1, step: 0.005, value: 0.5 },
      { id: 'gain', label: 'Open-Loop Gain', min: 2, max: 400, step: 1, value: 80 },
    ],
    derive(p) {
      return { P: [p.thr, p.gain, 0, 0], info: `trips at ${(p.thr * 0.7).toFixed(2)} V` };
    },
  },
  {
    id: 'osc', code: 8, name: 'Oscillator + multiplier', chip: 'OSC ×',
    about: 'A free-running oscillator into a four-quadrant multiplier, as in video synthesizers. Whole multiples of the line rate give still bars.',
    params: [
      { id: 'freq', label: 'Frequency (× line rate)', min: 0.02, max: 400, step: 0.01, value: 24 },
      { id: 'drift', label: 'Drift (Hz)', min: -4, max: 4, step: 0.01, value: 0.3 },
      { id: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, value: 0.7 },
      { id: 'wave', label: 'Waveform', type: 'select', options: ['Sine', 'Triangle', 'Square'], value: 0 },
      { id: 'mode', label: 'Mode', type: 'select', options: ['Ring modulator', 'Amplitude modulation', 'Mix (add)'], value: 0 },
    ],
    derive(p) {
      return { P: [p.freq, p.drift, p.depth, 0], Q: [Math.round(p.wave), Math.round(p.mode), 0, 0], info: fmtHz(p.freq * LINE_HZ) };
    },
  },
].map(t => ({ ...t, params: [...t.params, PATCH, MIX] }));

export const CIRCUIT_PRESETS = [
  { name: 'Worn coax run', stages: [['delay', { ns: 900, fb: 0.35 }], ['rc-lp', { r: 1500, c: 470 }]] },
  { name: 'Ringing edges', stages: [['rlc', { l: 68, c: 220, r: 60 }]] },
  { name: 'Crispener', stages: [['rc-hp', { r: 470, c: 330, bias: 0.5, mix: 0.45 }], ['bjt', { gain: 2.5 }]] },
  { name: 'Overdriven amp', stages: [['bjt', { gain: 9 }], ['diode', { diode: 1, drive: 6, level: 1.6 }]] },
  { name: 'Video synth', stages: [['osc', { freq: 12, drift: 0.6, depth: 0.8 }], ['fold', { drive: 3.2 }], ['rc-lp', { r: 1000, c: 150 }]] },
  { name: 'Chroma comb', stages: [['delay', { ns: 1400, fb: -0.6, patch: 2 }], ['rlc', { l: 100, c: 330, r: 90, patch: 2 }]] },
  { name: 'Hard key', stages: [['rc-lp', { r: 1000, c: 220 }], ['comp', { thr: 0.45 }]] },
];

const CIRCUIT_FS = FS_IO + /* glsl */ `
uniform sampler2D uTex;
uniform float uType, uDomain, uMix;
uniform vec4 uP, uQ;
const mat3 RGB2YIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
const mat3 YIQ2RGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);

vec3 S(vec2 uv) {                        // the signal on the wire this stage is patched into
  vec3 c = texture(uTex, uv).rgb;
  if (uDomain < 0.5) return vec3(luma(c));
  if (uDomain < 1.5) return c;
  vec3 q = RGB2YIQ * c;
  return vec3(q.y + 0.5, q.z + 0.5, 0.5);
}
vec3 asinh3(vec3 x) { return sign(x) * log(abs(x) + sqrt(x * x + 1.0)); }

// Resistor into diodes to ground: solve (Vin - V)/R = I_diode(V) with Newton's method.
vec3 diodeClip(vec3 vin) {
  float Is = uP.x, nVt = uP.y, R = uP.z;
  vec3 v;
  if (uQ.x < 0.5) {
    v = nVt * asinh3(vin / (2.0 * Is * R));
    for (int i = 0; i < 4; i++) {
      vec3 e = v / nVt;
      vec3 f = (vin - v) / R - 2.0 * Is * sinh(e);
      vec3 df = -1.0 / R - 2.0 * Is / nVt * cosh(e);
      v = clamp(v - f / df, -abs(vin), abs(vin));
    }
  } else {
    v = mix(vin, nVt * log(1.0 + max(vin, 0.0) / (Is * R)), step(0.0, vin));
    for (int i = 0; i < 4; i++) {
      vec3 e = exp(min(v / nVt, 60.0));
      vec3 f = (vin - v) / R - Is * (e - 1.0);
      vec3 df = -1.0 / R - Is / nVt * e;
      v = v - f / df;
      v = mix(max(v, vin), min(v, vin), step(0.0, vin));
    }
  }
  return v;
}

void main() {
  float px = 1.0 / uRes.x;
  vec3 s0 = S(vUv);
  vec3 y = s0;
  if (uType < 1.5) {                                   // RC: causal exponential impulse response
    float tau = max(uP.x, 0.05);
    float stp = max(0.5, tau * 5.0 / 32.0);
    vec3 acc = vec3(0.0); float ws = 0.0;
    for (int k = 0; k < 32; k++) {
      float d = float(k) * stp, w = exp(-d / tau);
      acc += S(vUv - vec2(d * px, 0.0)) * w; ws += w;
    }
    vec3 lp = acc / ws;
    y = uType < 0.5 ? lp : s0 - lp + uP.y;
  } else if (uType < 2.5) {                            // RLC: damped sinusoid (or two exponentials if overdamped)
    vec3 acc = vec3(0.0); float ws = 0.0;
    for (int k = 0; k < 64; k++) {
      float t = (float(k) + 0.5) * uP.z;
      float h = uP.y > 0.0 ? exp(-uP.x * t) * sin(uP.y * t) : exp(-(uP.x + uP.y) * t) - exp(-(uP.x - uP.y) * t);
      acc += S(vUv - vec2(t * px, 0.0)) * h; ws += h;
    }
    if (abs(ws) > 1e-4) y = acc / ws;
  } else if (uType < 3.5) {                            // delay line with feedback: a train of echoes
    vec3 acc = vec3(0.0); float ws = 0.0, g = 1.0;
    for (int k = 0; k < 10; k++) {
      acc += S(vUv - vec2(float(k) * uP.x * px, 0.0)) * g; ws += g;
      g *= uP.y;
    }
    y = acc / ws;
  } else if (uType < 4.5) {
    y = diodeClip((s0 - 0.5) * uP.w) * uQ.y + 0.5;
  } else if (uType < 5.5) {
    y = 0.5 + 0.5 * tanh(uP.x * (s0 - 0.5 + uP.y)) * (uP.z > 0.5 ? -1.0 : 1.0);
  } else if (uType < 6.5) {
    vec3 x = (s0 - 0.5 + uP.y) * uP.x;
    y = uP.z < 0.5 ? 1.0 - abs(mod(x + 0.5, 2.0) - 1.0) : abs(x) * 2.0;
  } else if (uType < 7.5) {
    y = 0.5 + 0.5 * tanh(uP.y * (s0 - uP.x));
  } else {                                             // oscillator phase runs continuously across lines
    float line = floor((1.0 - vUv.y) * 480.0);
    float ph = fract(uP.x * (line + vUv.x * 0.826) + uP.y * uTime);
    float o = uQ.x < 0.5 ? sin(ph * 6.2831853) : (uQ.x < 1.5 ? 1.0 - 4.0 * abs(ph - 0.5) : (ph < 0.5 ? 1.0 : -1.0));
    if (uQ.y < 0.5) y = 0.5 + (s0 - 0.5) * mix(1.0, o, uP.z);
    else if (uQ.y < 1.5) y = s0 * (1.0 - uP.z * (0.5 - 0.5 * o));
    else y = s0 + uP.z * 0.5 * o;
  }
  y = mix(s0, y, uMix);
  vec3 c = texture(uTex, vUv).rgb, o3;
  if (uDomain < 0.5) { vec3 q = RGB2YIQ * c; q.x = y.x; o3 = YIQ2RGB * q; }
  else if (uDomain < 1.5) o3 = y;
  else { vec3 q = RGB2YIQ * c; q.yz = y.xy - 0.5; o3 = YIQ2RGB * q; }
  outColor = vec4(clamp(o3, 0.0, 1.0), 1.0);
}`;

const BY_ID = Object.fromEntries(CIRCUIT_TYPES.map(t => [t.id, t]));
export const circuitType = id => BY_ID[id];

export class CircuitRunner {
  constructor(r) { this.r = r; this.prog = r.fx(CIRCUIT_FS); this.targets = {}; }
  t(key) {
    const r = this.r, t = this.targets[key];
    if (t && t.w === r.w && t.h === r.h) return t;
    if (t) t.dispose();
    return (this.targets[key] = r.createTarget(r.w, r.h));
  }
  /** stages: [{ type: 'rc-lp', p: {...resolved values} }]. Reads src, writes out. */
  run(src, out, stages) {
    const r = this.r;
    let input = src;
    stages.forEach((st, i) => {
      const type = BY_ID[st.type];
      const d = type.derive(st.p, r.w);
      const dest = i === stages.length - 1 ? out : this.t(i % 2 ? 'b' : 'a');
      r.pass(this.prog, dest, { uType: type.code, uDomain: Math.round(st.p.patch), uMix: st.p.mix, uP: d.P, uQ: d.Q || [0, 0, 0, 0] }, { uTex: input });
      input = dest;
    });
  }
}
