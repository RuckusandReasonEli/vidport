import { Renderer, FS_IO } from '../gl.js';
import { EFFECTS } from '../effects/index.js';
import { GLOBAL, Grader, isNeutral } from '../global.js';
import { bodyField } from '../effects/scribble.js';
import { CIRCUIT_TYPES, CIRCUIT_PRESETS, MAX_STAGES, circuitType } from '../circuit.js';
import { AudioEngine, BANDS } from '../audio.js';
import { Tracker } from '../detect.js';
import { pickMime, bitrateFor, presentResult } from '../export.js';
import { IS_IOS, IS_MOBILE, keepAwake, waitForMetadata, usePlaybackAudioSession } from '../mobile.js';

/* Browser budget: 3 layers decoding at once, 8 source files, 40 clips.
   Clips on the same layer never overlap, so one <video> per (layer, file)
   is enough, and a split clip keeps playing from the same decoder. */
const TRACKS = 3, MAX_MEDIA = 8, MAX_CLIPS = 40;
const LAYER_COLORS = ['#53f0ff', '#ff4fa3', '#ffb14f'];
const PREVIEW_LONG = IS_MOBILE ? 480 : 640;
const GALLERY_LONG = IS_MOBILE ? 240 : 400;
const WINDOW = 3;
const BLENDS = ['Normal', 'Screen', 'Add', 'Multiply', 'Difference', 'Overlay', 'Lighten', 'Darken'];

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); return `${m}:${(t % 60).toFixed(1).padStart(4, '0')}`; };
const setFill = el => el.style.setProperty('--fill', ((el.value - el.min) / (el.max - el.min)) * 100 + '%');
const clone = o => JSON.parse(JSON.stringify(o));
const getFx = id => EFFECTS.find(f => f.id === id);
const isRange = p => p.type !== 'select' && p.type !== 'color';

/* ---------- State ---------- */
const media = [];          // { id, file, url, name, duration, w, h, thumb }
const clips = [];          // see newClip()
const tracks = Array.from({ length: TRACKS }, (_, i) => ({ i, hidden: false, muted: false }));
let selectedId = null, nextId = 1;
let t = 0, playing = false, t0 = 0, base = 0, wantPlay = false;
let pxPerSec = 60, exportJob = null, lastDownload = null, audioOn = false, dirty = true;
let aspectSetting = 'auto';
let loopMode = 'full', loopA = 0;
const loopRange = () => (loopMode === 'window' ? [loopA, Math.min(duration(), loopA + WINDOW)] : [0, duration()]);
const duration = () => Math.max(0, ...clips.map(c => c.start + (c.out - c.in)));
const clipEnd = c => c.start + (c.out - c.in);
const selected = () => clips.find(c => c.id === selectedId) || null;

/* Layer look controls (per clip) */
const LOOK = { id: 'look', params: [
  { group: 'Layer look', id: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, value: 1 },
  { group: 'Layer look', id: 'blend', label: 'Blend Mode', type: 'select', options: BLENDS, value: 0 },
  { group: 'Layer look', id: 'fit', label: 'Fit', type: 'select', options: ['Fill frame (crop)', 'Fit inside'], value: 0 },
  { group: 'Layer look', id: 'scale', label: 'Scale', min: 0.1, max: 3, step: 0.01, value: 1 },
  { group: 'Layer look', id: 'x', label: 'Position X', min: -1, max: 1, step: 0.005, value: 0 },
  { group: 'Layer look', id: 'y', label: 'Position Y', min: -1, max: 1, step: 0.005, value: 0 },
  { group: 'Layer look', id: 'rotate', label: 'Rotation', min: -180, max: 180, step: 1, value: 0 },
  { group: 'Layer look', id: 'fadeIn', label: 'Fade In (s)', min: 0, max: 5, step: 0.05, value: 0 },
  { group: 'Layer look', id: 'fadeOut', label: 'Fade Out (s)', min: 0, max: 5, step: 0.05, value: 0 },
  { group: 'Layer look', id: 'volume', label: 'Clip Volume', min: 0, max: 1.5, step: 0.01, value: 1 },
  { group: 'Zoom & crop', id: 'zoom', label: 'Zoom', min: 1, max: 6, step: 0.01, value: 1 },
  { group: 'Zoom & crop', id: 'panX', label: 'Zoom Pan X', min: -1, max: 1, step: 0.005, value: 0 },
  { group: 'Zoom & crop', id: 'panY', label: 'Zoom Pan Y', min: -1, max: 1, step: 0.005, value: 0 },
  { group: 'Zoom & crop', id: 'cropL', label: 'Crop Left', min: 0, max: 0.45, step: 0.005, value: 0 },
  { group: 'Zoom & crop', id: 'cropR', label: 'Crop Right', min: 0, max: 0.45, step: 0.005, value: 0 },
  { group: 'Zoom & crop', id: 'cropT', label: 'Crop Top', min: 0, max: 0.45, step: 0.005, value: 0 },
  { group: 'Zoom & crop', id: 'cropB', label: 'Crop Bottom', min: 0, max: 0.45, step: 0.005, value: 0 },
  { group: 'Mask', id: 'mask', label: 'Mask', type: 'select', options: ['Off', 'Keep people (remove background)', 'Remove people (keep background)'], value: 0 },
  { group: 'Mask', id: 'maskEdge', label: 'Edge (shrink / grow)', min: -0.4, max: 0.4, step: 0.01, value: 0.05 },
  { group: 'Mask', id: 'maskFeather', label: 'Edge Softness', min: 0.01, max: 0.4, step: 0.01, value: 0.08 },
] };
const maskOn = c => c && Math.round(c.look.values.mask) > 0;
const defaults = def => {
  const values = {}, mods = {};
  for (const p of def.params) { values[p.id] = p.value; if (isRange(p)) mods[p.id] = p.mod ? { ...p.mod } : { band: 'none', depth: 0.5 }; }
  return { values, mods };
};
function newClip(m, track, start) {
  return { id: nextId++, mediaId: m.id, track, start, in: 0, out: m.duration, effect: 'none', fxOn: true, fx: {}, look: defaults(LOOK), global: defaults(GLOBAL), globalOn: true, circuit: [] };
}
const fxState = (c, id) => (c.fx[id] = c.fx[id] || defaults(getFx(id)));
/** The effect that actually runs on a clip (null when none is chosen or it's switched off). */
const fxOf = c => (c && c.fxOn && c.effect !== 'none' ? getFx(c.effect) : null);
/** Video Circuit stages are stored per clip as { uid, typeId, st, bypass } so clips can be copied. */
const stageDef = s => { const ty = circuitType(s.typeId); return { id: 'circ' + s.uid, name: ty.name, params: ty.params }; };
function clipGlobal(c) {
  if (!c.globalOn) return null;
  const gp = resolve(GLOBAL, c.global);
  gp.circuit = c.circuit.filter(s => !s.bypass).map(s => ({ type: s.typeId, p: resolve(stageDef(s), s.st) }));
  return gp;
}

/* ---------- Audio ---------- */
const audio = new AudioEngine();
let actx = null, bus = null, monitor = null, recordDest = null;
function ensureAudio() {
  if (actx) return;
  usePlaybackAudioSession();
  actx = new (window.AudioContext || window.webkitAudioContext)();
  bus = actx.createGain();
  monitor = actx.createGain();
  recordDest = actx.createMediaStreamDestination();
  bus.connect(monitor); monitor.connect(actx.destination); bus.connect(recordDest);
  audio.attachNode(actx, bus);
  players.forEach(attachPlayerAudio);
  applyVolume();
}
const resumeAudio = () => { if (actx && actx.state !== 'running') actx.resume().catch(() => {}); };
function attachPlayerAudio(p) {
  if (!actx || p.gain) return;
  p.gain = actx.createGain();
  p.gain.gain.value = 0;
  try { actx.createMediaElementSource(p.video).connect(p.gain); } catch (e) { /* already attached */ }
  p.gain.connect(bus);
}

/* ---------- Players: one <video> per (layer, file) ---------- */
const players = new Map();
const videoBox = document.createElement('div');
videoBox.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0;pointer-events:none;overflow:hidden';
document.body.appendChild(videoBox);
function player(track, mediaId) {
  const key = track + '|' + mediaId;
  if (players.has(key)) return players.get(key);
  const m = media.find(x => x.id === mediaId);
  const v = document.createElement('video');
  Object.assign(v, { playsInline: true, preload: 'auto', src: m.url });
  v.setAttribute('playsinline', '');
  videoBox.appendChild(v);
  const p = { key, track, mediaId, video: v, fresh: false, galFresh: false, gain: null, lastGain: 0 };
  if ('requestVideoFrameCallback' in v) { const cb = () => { p.fresh = p.galFresh = true; v.requestVideoFrameCallback(cb); }; v.requestVideoFrameCallback(cb); }
  else { p.lastT = -1; p.galLastT = -1; }
  v.addEventListener('seeked', () => { p.fresh = p.galFresh = true; dirty = true; });
  attachPlayerAudio(p);
  players.set(key, p);
  return p;
}
function setGain(p, g) {
  if (!p.gain || Math.abs(g - p.lastGain) < 0.002) return;
  p.gain.gain.setTargetAtTime(g, actx.currentTime, 0.01);
  p.lastGain = g;
}

/* ---------- GL: composite canvas + one view per layer ---------- */
const canvas = $('#main-canvas');
const R = new Renderer(canvas, { preserve: IS_IOS });
const COMP_FS = FS_IO + /* glsl */ `
uniform sampler2D uAccum, uLayer, uMask;
uniform vec2 uCenter, uSize;
uniform float uOpacity, uBlend, uRot;
uniform vec4 uCrop;    // crop window in source UV: x0, y0, width, height
uniform vec3 uZoom;    // zoom, pan x, pan y (inside the crop window)
uniform vec3 uMaskP;   // mode (0 off, 1 keep people, 2 remove people), edge, softness
void main() {
  vec3 a = texture(uAccum, vUv).rgb;
  float asp = uRes.x / uRes.y;
  vec2 q = vUv - uCenter; q.x *= asp;
  float c = cos(uRot), s = sin(uRot);
  q = mat2(c, -s, s, c) * q; q.x /= asp;
  vec2 luv = q / uSize + 0.5;
  if (luv.x < 0.0 || luv.x > 1.0 || luv.y < 0.0 || luv.y > 1.0) { outColor = vec4(a, 1.0); return; }
  vec2 zc = vec2(0.5) + uZoom.yz * 0.5 * (1.0 - 1.0 / uZoom.x);
  vec2 suv = uCrop.xy + (zc + (luv - 0.5) / uZoom.x) * uCrop.zw;
  vec3 l = texture(uLayer, suv).rgb, b;
  float alpha = 1.0;
  if (uMaskP.x > 0.5) {
    float m = smoothstep(0.5 - uMaskP.y - uMaskP.z, 0.5 - uMaskP.y + uMaskP.z, texture(uMask, suv).r);
    alpha = uMaskP.x < 1.5 ? m : 1.0 - m;
  }
  if (uBlend < 0.5) b = l;
  else if (uBlend < 1.5) b = 1.0 - (1.0 - a) * (1.0 - l);
  else if (uBlend < 2.5) b = min(a + l, 1.0);
  else if (uBlend < 3.5) b = a * l;
  else if (uBlend < 4.5) b = abs(a - l);
  else if (uBlend < 5.5) b = mix(2.0 * a * l, 1.0 - 2.0 * (1.0 - a) * (1.0 - l), step(0.5, a));
  else if (uBlend < 6.5) b = max(a, l);
  else b = min(a, l);
  outColor = vec4(mix(a, b, uOpacity * alpha), 1.0);
}`;
const compProg = R.fx(COMP_FS);
const blankMask = (() => { const gl = R.gl, tx = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tx); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255])); return tx; })();
let accum = null;
const views = tracks.map(() => { const v = R.view(); v.grader = new Grader(v); return v; });
const trackState = tracks.map(() => ({ clipId: null, tex: null, mask: null, track: { faces: [], hands: [], poses: [], fresh: false }, frame: 0 }));
const instances = new Map();   // `${clipId}|${track}|${fxId}` -> effect instance
const tracker = new Tracker();
tracker.onChange = () => { updateTrackStatus(); updateMaskStatus(); dirty = true; };
window.videoPortalTracker = tracker;

/** Project frame in pixels: from the first imported video unless overridden. */
let customW = 1080, customH = 1920;
function projectFrame() {
  if (aspectSetting === 'custom') return [customW, customH];
  if (aspectSetting === 'auto') return media[0] ? [media[0].w, media[0].h] : [1920, 1080];
  const a = +aspectSetting;
  return a >= 1 ? [1920, Math.round(1920 / a)] : [Math.round(1920 * a), 1920];
}
function projectAspect() { const [w, h] = projectFrame(); return w / h; }
const RATIOS = [[16, 9], [9, 16], [1, 1], [4, 5], [5, 4], [4, 3], [3, 4], [21, 9], [2, 1], [3, 2], [2, 3]];
function ratioName(w, h) {
  const r = RATIOS.find(([a, b]) => Math.abs(w / h - a / b) < 0.012);
  return r ? `${r[0]}:${r[1]}` : (w / h).toFixed(2) + ':1';
}
function updateFrameUI() {
  const m = media[0];
  const opt = $('#aspect option[value="auto"]');
  opt.textContent = m ? `From video: ${m.w}x${m.h} (${ratioName(m.w, m.h)})` : 'From first video';
  $('#custom-size').hidden = aspectSetting !== 'custom';
  $('#ex-res').disabled = aspectSetting === 'custom';
  const [w, h] = exportSize();
  $('#frame-note').textContent = media.length ? `Output: ${w}x${h} (${ratioName(w, h)})${aspectSetting === 'auto' && m ? `, detected from ${m.name}` : ''}.` : '';
}
function exportSize() {
  if (aspectSetting === 'custom') return [Math.round(customW / 2) * 2, Math.round(customH / 2) * 2];
  const [fw, fh] = projectFrame(), a = fw / fh, res = $('#ex-res').value;
  let w, h;
  if (res === 'source') { const s = Math.min(1, 1920 / Math.max(fw, fh)); [w, h] = [fw * s, fh * s]; }
  else { const short = +res; [w, h] = a >= 1 ? [short * a, short] : [short, short / a]; }
  return [Math.max(2, Math.round(w / 2) * 2), Math.max(2, Math.round(h / 2) * 2)];
}
function sizeFor(longSide) {
  const a = projectAspect();
  const [w, h] = a >= 1 ? [longSide, longSide / a] : [longSide * a, longSide];
  return [Math.max(2, Math.round(w / 2) * 2), Math.max(2, Math.round(h / 2) * 2)];
}
function sizeOutput(w, h) {
  R.resize(w, h);
  if (!accum || accum.w !== w || accum.h !== h) { if (accum) accum.dispose(); accum = R.pingpong(w, h); }
  trackState.forEach(ts => { ts.clipId = null; });
  dirty = true;
}
sizeOutput(...sizeFor(PREVIEW_LONG));

/* ---------- Param resolution (audio links) ---------- */
function resolve(def, st) {
  const out = {};
  for (const p of def.params) {
    let v = st.values[p.id];
    if (isRange(p)) {
      const m = st.mods[p.id];
      if (audioOn && m && m.band !== 'none') v = clamp(v + m.depth * (p.max - p.min) * (audio.levels[m.band] || 0), p.min, p.max);
    }
    out[p.id] = v;
  }
  return out;
}

/* ---------- Per-frame engine ---------- */
function activeClip(track, time) { return clips.find(c => c.track === track && time >= c.start && time < clipEnd(c)) || null; }
function nextClip(track, time) { return clips.filter(c => c.track === track && c.start > time).sort((a, b) => a.start - b.start)[0] || null; }

function syncPlayers(time, scrubbing) {
  const live = new Set();
  for (let k = 0; k < TRACKS; k++) {
    const c = activeClip(k, time);
    if (c) {
      const p = player(k, c.mediaId);
      live.add(p.key);
      const mt = c.in + (time - c.start);
      const v = p.video;
      const drift = Math.abs(v.currentTime - mt);
      if ((playing && drift > 0.25) || (!playing && drift > 0.03 && !v.seeking)) { v.currentTime = mt; }
      if (playing && v.paused) v.play().catch(onBlocked);
      if (!playing && !v.paused) v.pause();
      const look = resolve(LOOK, c.look);
      const fade = fadeAt(c, look, time);
      setGain(p, tracks[k].muted ? 0 : look.volume * fade);
    }
    // Get the next clip's decoder in position before it starts.
    const n = nextClip(k, time);
    if (n && n.start - time < 0.6) {
      const p = player(k, n.mediaId);
      if (!live.has(p.key)) { live.add(p.key); if (Math.abs(p.video.currentTime - n.in) > 0.05 && !p.video.seeking) p.video.currentTime = n.in; if (!p.video.paused) p.video.pause(); setGain(p, 0); }
    }
  }
  for (const p of players.values()) if (!live.has(p.key)) { if (!p.video.paused) p.video.pause(); setGain(p, 0); }
}
function fadeAt(c, look, time) {
  const local = time - c.start, len = clipEnd(c) - c.start;
  let f = 1;
  if (look.fadeIn > 0) f = Math.min(f, local / look.fadeIn);
  if (look.fadeOut > 0) f = Math.min(f, (len - local) / look.fadeOut);
  return clamp(f, 0, 1);
}

function neededKinds(c) { const fx = fxOf(c); return fx && fx.needs ? fx.needs(resolve(fx, fxState(c, fx.id))) : []; }
function updateMaskStatus() { const c = selected(); const el = $('#mask-status'); el.hidden = !maskOn(c); if (maskOn(c)) el.textContent = tracker.statusText(['seg']); }
function mapTrack(raw, gp) {
  const flip = gp ? Math.round(gp.flip) : 0, z = gp ? gp.zoom : 1;
  const map = (l, vis) => { let x = (l.x - 0.5) * z + 0.5, y = (1 - l.y - 0.5) * z + 0.5; if (flip === 1 || flip === 3) x = 1 - x; if (flip === 2 || flip === 3) y = 1 - y; return { x, y, v: vis ? l.visibility : 1 }; };
  const conv = (list, vis) => list.map(lms => lms.map(l => map(l, vis)));
  return { faces: conv(raw.faces, false), hands: conv(raw.hands, false), poses: conv(raw.poses, true), fresh: true };
}

let frameNo = 0, trackTurnK = -1;
function renderTrack(k, time, force) {
  const ts = trackState[k];
  const c = activeClip(k, time);
  if (!c || tracks[k].hidden) { ts.tex = null; ts.clipId = null; return; }
  const p = player(k, c.mediaId), v = p.video, view = views[k];
  if (v.readyState < 2) { ts.tex = ts.clipId === c.id ? ts.tex : null; return; }
  let step = false;
  if (ts.clipId !== c.id) {                                   // entering a clip: fresh history
    const m = media.find(x => x.id === c.mediaId);
    const s = Math.min(1, Math.max(R.w, R.h) / Math.max(m.w, m.h));
    view.resize(Math.max(2, Math.round(m.w * s / 2) * 2), Math.max(2, Math.round(m.h * s / 2) * 2));
    view.hasFrame = false;
    const inst = fxOf(c) ? instances.get(`${c.id}|${k}|${c.effect}`) : null;
    if (inst) inst.reset();
    ts.clipId = c.id;
    step = true;
  }
  if (p.fresh || (p.lastT !== undefined && v.currentTime !== p.lastT)) { step = true; p.fresh = false; p.lastT = v.currentTime; }
  if (!step && !force && ts.tex) return;
  const mt = c.in + (time - c.start);
  const gp = clipGlobal(c);
  view.time = mt; view.frameIndex = ++ts.frame; view.gradeParams = gp;
  if (step || !view.hasFrame) view.upload(v, v.videoWidth, v.videoHeight); else view.regrade();
  ts.mask = null;
  if (maskOn(c)) {
    tracker.ensure(['seg']);
    if (tracker.tasks.seg) ts.mask = bodyField(view, tracker).tex;
  }
  const fx = fxOf(c);
  if (!fx) { ts.tex = view.cur; return; }
  const key = `${c.id}|${k}|${fx.id}`;
  if (!instances.has(key)) instances.set(key, fx.create(view));
  const kinds = neededKinds(c);
  ts.track.fresh = false;
  if (kinds.length && step) {
    tracker.ensure(kinds);
    // Several layers may need tracking: they take turns, one layer per frame.
    if (tracker.ready(kinds) && trackTurnK === k) ts.track = mapTrack(tracker.detect(v, kinds.filter(x => x !== 'seg')), gp);
  }
  instances.get(key).render(resolve(fx, fxState(c, fx.id)), {
    step, time: mt, frame: ts.frame, dt: 1 / 30, tracker, track: ts.track, hit: audioOn ? audio.levels.hit : 0,
    srcW: v.videoWidth / (gp ? gp.zoom : 1), srcH: v.videoHeight / (gp ? gp.zoom : 1),
  }, null);
  ts.tex = view.out;
}

function composite(time) {
  accum.read.clear();
  const oa = R.w / R.h;
  for (let k = 0; k < TRACKS; k++) {
    const ts = trackState[k];
    const c = activeClip(k, time);
    if (!ts.tex || !c || ts.clipId !== c.id || tracks[k].hidden) continue;
    const look = resolve(LOOK, c.look);
    const cw = Math.max(0.05, 1 - look.cropL - look.cropR), ch = Math.max(0.05, 1 - look.cropT - look.cropB);
    const la = (views[k].w * cw) / (views[k].h * ch);
    let sw = 1, sh = 1;
    const cover = Math.round(look.fit) === 0;
    if ((la > oa) === cover) sh = cover ? 1 : oa / la, sw = cover ? la / oa : 1;
    else sw = cover ? 1 : la / oa, sh = cover ? oa / la : 1;
    R.pass(compProg, accum.write, {
      uCenter: [0.5 + look.x * 0.5, 0.5 + look.y * 0.5], uSize: [sw * look.scale, sh * look.scale],
      uOpacity: look.opacity * fadeAt(c, look, time), uBlend: look.blend, uRot: -look.rotate * Math.PI / 180,
      uCrop: [look.cropL, look.cropB, cw, ch], uZoom: [look.zoom, look.panX, look.panY],
      uMaskP: [ts.mask ? Math.round(look.mask) : 0, look.maskEdge, look.maskFeather],
    }, { uAccum: accum.read, uLayer: ts.tex, uMask: ts.mask || blankMask });
    accum.swap();
  }
  R.blit(accum.read, null);
}

/* ---------- Clock & loop ---------- */
const now = () => (playing ? base + (performance.now() - t0) / 1000 : base);
function setTime(x) { base = clamp(x, 0, Math.max(0, duration() - 0.01)); t0 = performance.now(); t = base; dirty = true; updateToolButtons(); }
function onBlocked(e) {
  if (!e || e.name !== 'NotAllowedError') return;
  for (const p of players.values()) p.video.muted = true;   // run muted until the user taps
  $('#sound-btn').hidden = false;
  for (const p of players.values()) if (playing && p.video.paused && activeClipFor(p)) p.video.play().catch(() => {});
}
// iOS: every decoder must be started once inside a tap before it may play with sound later.
function unlockPlayers() {
  for (const p of players.values()) {
    if (p.unlocked) continue;
    p.video.muted = false;
    const pr = p.video.play();
    if (pr) pr.then(() => { if (!playing || !activeClipFor(p)) p.video.pause(); }).catch(() => {});
    p.unlocked = true;
  }
  resumeAudio();
}
const activeClipFor = p => { const c = activeClip(p.track, now()); return c && c.mediaId === p.mediaId; };
function play() {
  if (!clips.length) return;
  ensureAudio();
  unlockPlayers();
  { const [a, b] = loopRange(); if (!exportJob && (t >= b - 0.05 || t < a)) setTime(a); }
  base = t; t0 = performance.now(); playing = true; wantPlay = true;
  syncPlayers(t);
  syncPlayBtn();
}
function pause() { base = now(); playing = false; wantPlay = false; syncPlayers(base); syncPlayBtn(); }
const syncPlayBtn = () => $('#play-btn').classList.toggle('paused', !playing);
$('#play-btn').onclick = () => (playing ? pause() : play());
$('#play-overlay').onclick = () => { $('#play-overlay').hidden = true; play(); };
$('#sound-btn').onclick = e => { e.stopPropagation(); for (const p of players.values()) { p.video.muted = false; p.unlocked = false; } unlockPlayers(); $('#sound-btn').hidden = true; };
document.addEventListener('pointerdown', () => { ensureAudio(); resumeAudio(); }, { passive: true });

function tick() {
  requestAnimationFrame(tick);
  if (!media.length) return;
  if (!exportJob) audio.update(1 / 60);
  if (playing) {
    t = now();
    const [a, b] = exportJob ? [exportJob.start, exportJob.end] : loopRange();
    if (t >= b) {
      if (exportJob) { finishExport(false); return; }
      setTime(a); t = a;
    }
  } else t = base;
  syncPlayers(t);
  frameNo++;
  // Layers that need face/hand/body tracking take turns (one detection per frame).
  const needT = [0, 1, 2].filter(k => { const c = activeClip(k, t); return c && neededKinds(c).some(x => x !== 'seg'); });
  trackTurnK = needT.length ? needT[frameNo % needT.length] : -1;
  for (let k = 0; k < TRACKS; k++) renderTrack(k, t, dirty);
  composite(t);
  renderGallery();
  dirty = false;
  updateMeters();
  $('#timecode').textContent = `${fmt(t)} / ${fmt(duration())}`;
  $('#tl-playhead').style.left = t * pxPerSec + 'px';
  if (frameNo % 6 === 0) updateToolButtons();
  if (exportJob && !exportJob.finishing) exportTick(t);
}
requestAnimationFrame(tick);

/* ---------- Media ---------- */
$('#file-input').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
['dragenter', 'dragover'].forEach(x => document.addEventListener(x, e => { e.preventDefault(); $('#dropzone').classList.add('drag'); }));
['dragleave', 'drop'].forEach(x => document.addEventListener(x, e => { e.preventDefault(); $('#dropzone').classList.remove('drag'); }));
document.addEventListener('drop', e => { if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });

async function addFiles(files) {
  if (exportJob) return;
  ensureAudio();
  const vids = [...files].filter(f => f.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|mkv)$/i.test(f.name));
  const room = MAX_MEDIA - media.length;
  if (vids.length > room) alert(`Layers holds ${MAX_MEDIA} videos, so only the first ${Math.max(0, room)} were added.`);
  for (const f of vids.slice(0, Math.max(0, room))) {
    const url = URL.createObjectURL(f);
    const probe = document.createElement('video');
    Object.assign(probe, { muted: true, playsInline: true, preload: 'auto', src: url });
    try { await waitForMetadata(probe); } catch (e) { alert(`This browser can't decode ${f.name}. Try an H.264 MP4 or WebM.`); URL.revokeObjectURL(url); continue; }
    const m = { id: nextId++, file: f, url, name: f.name, duration: probe.duration || 1, w: probe.videoWidth || 1280, h: probe.videoHeight || 720, thumb: null };
    if (!media.length) { aspectSetting = 'auto'; $('#aspect').value = 'auto'; $('#ex-res').value = 'source'; }
    media.push(m);
    makeThumb(m, probe);
    // Auto-place: first three files go to layers 1, 2, 3; later ones extend layer 1.
    const emptyTrack = tracks.findIndex((_, k) => !clips.some(c => c.track === k));
    if (clips.length < MAX_CLIPS) {
      const k = emptyTrack >= 0 ? emptyTrack : 0;
      const start = emptyTrack >= 0 ? 0 : Math.max(0, ...clips.filter(c => c.track === 0).map(clipEnd));
      const c = newClip(m, k, start);
      clips.push(c);
      if (!selectedId) selectedId = c.id;
    }
  }
  afterMediaChange();
  if (clips.length && !playing) play();   // falls back to muted playback (Tap for sound) if the browser blocks sound
}
function makeThumb(m, probe) {
  const draw = () => {
    const c = document.createElement('canvas');
    c.width = 192; c.height = 120;
    const g = c.getContext('2d');
    const a = probe.videoWidth / probe.videoHeight || 16 / 9;
    let w = 192, h = 192 / a;
    if (h < 120) { h = 120; w = 120 * a; }
    try { g.drawImage(probe, (192 - w) / 2, (120 - h) / 2, w, h); } catch (e) { /* not ready */ }
    m.thumb = c; renderMedia();
    probe.removeAttribute('src'); probe.load();
  };
  probe.addEventListener('seeked', draw, { once: true });
  probe.currentTime = Math.min(0.5, (probe.duration || 1) / 3);
  setTimeout(() => { if (!m.thumb) draw(); }, 2500);
}
function afterMediaChange() {
  const has = media.length > 0;
  $('#viewer').classList.toggle('has-video', has);
  $('#play-btn').disabled = !clips.length;
  $('#export-btn').disabled = !clips.length;
  $('#render-jump').hidden = !clips.length;
  if (!exportJob) sizeOutput(...sizeFor(PREVIEW_LONG));
  updateFrameUI();
  renderMedia(); renderTimeline(); renderInspector();
  galKey = '';
  $('#media-count').textContent = `${media.length} of ${MAX_MEDIA} videos. Add one to a layer at the playhead.`;
}
function renderMedia() {
  const box = $('#media');
  box.innerHTML = '';
  for (const m of media) {
    const el = document.createElement('div');
    el.className = 'mitem';
    el.innerHTML = `<div class="mb"><div class="mn" title="${m.name}">${m.name}</div><div class="muted small">${fmt(m.duration)} · ${m.w}x${m.h}</div>
      <div class="ma">Add to ${[1, 2, 3].map(n => `<button data-k="${n - 1}" style="--lc:${LAYER_COLORS[n - 1]}" title="Add to layer ${n} at the playhead">L${n}</button>`).join('')}</div></div>`;
    if (m.thumb) el.prepend(m.thumb);
    el.querySelectorAll('button').forEach(b => b.onclick = () => addToLayer(m, +b.dataset.k));
    box.appendChild(el);
  }
}
function addToLayer(m, k) {
  if (exportJob || clips.length >= MAX_CLIPS) { if (clips.length >= MAX_CLIPS) alert(`Layers holds ${MAX_CLIPS} clips.`); return; }
  const c = newClip(m, k, t);
  // Fit into the gap at the playhead, or append to the end of the layer.
  const gap = freeGap(k, t, null);
  if (gap) { c.start = t; c.out = Math.min(m.duration, gap[1] - t); }
  else c.start = Math.max(0, ...clips.filter(x => x.track === k).map(clipEnd));
  if (c.out - c.in < 0.1) c.start = Math.max(0, ...clips.filter(x => x.track === k).map(clipEnd)), c.out = m.duration;
  clips.push(c);
  select(c.id);
  afterMediaChange();
}
function freeGap(k, time, ignoreId) {
  const others = clips.filter(c => c.track === k && c.id !== ignoreId);
  if (others.some(c => time >= c.start && time < clipEnd(c))) return null;
  const before = Math.max(0, ...others.filter(c => clipEnd(c) <= time).map(clipEnd));
  const after = Math.min(Infinity, ...others.filter(c => c.start >= time).map(c => c.start));
  return [before, after];
}

/* ---------- Timeline ---------- */
const lanesEl = $('#tl-lanes'), inner = $('#tl-inner'), scrollEl = $('#tl-scroll'), ruler = $('#tl-ruler');
function renderLabels() {
  const box = $('#tl-labels');
  box.innerHTML = '<div></div>';
  for (let k = TRACKS - 1; k >= 0; k--) {
    const tr = tracks[k];
    const el = document.createElement('div');
    el.className = 'tl-label';
    el.style.setProperty('--lc', LAYER_COLORS[k]);
    el.innerHTML = `<span class="dot"></span><span class="lname">Layer ${k + 1}</span><span><button class="${tr.hidden ? 'off' : ''}" title="Show / hide layer" data-a="hide">👁</button><button class="${tr.muted ? 'off' : ''}" title="Mute / unmute layer" data-a="mute">♪</button></span>`;
    el.querySelector('[data-a=hide]').onclick = () => { tr.hidden = !tr.hidden; renderLabels(); dirty = true; };
    el.querySelector('[data-a=mute]').onclick = () => { tr.muted = !tr.muted; renderLabels(); };
    box.appendChild(el);
  }
}
function renderTimeline() {
  const width = Math.max(scrollEl.clientWidth, (duration() + 10) * pxPerSec);
  updateLoopLabel();
  inner.style.width = width + 'px';
  lanesEl.innerHTML = '';
  for (let k = TRACKS - 1; k >= 0; k--) {
    const lane = document.createElement('div');
    lane.className = 'tl-lane';
    lane.dataset.k = k;
    for (const c of clips.filter(x => x.track === k)) {
      const m = media.find(x => x.id === c.mediaId);
      const el = document.createElement('div');
      el.className = 'clip' + (c.id === selectedId ? ' selected' : '');
      el.dataset.id = c.id;
      el.style.setProperty('--lc', LAYER_COLORS[k]);
      el.style.left = c.start * pxPerSec + 'px';
      el.style.width = Math.max(6, (c.out - c.in) * pxPerSec) + 'px';
      el.innerHTML = `<span class="h l"></span><span class="cn">${m ? m.name : '?'}</span><span class="cf">${fxOf(c) ? fxOf(c).name : c.effect !== 'none' ? getFx(c.effect).name + ' (off)' : 'No effect'}${resolve(LOOK, c.look).blend ? ' · ' + BLENDS[c.look.values.blend] : ''}</span><span class="h r"></span>`;
      el.addEventListener('pointerdown', e => startDrag(e, c, el));
      lane.appendChild(el);
    }
    lanesEl.appendChild(lane);
  }
  drawRuler(width);
  $('#tl-playhead').style.left = t * pxPerSec + 'px';
  updateToolButtons();
}
function drawRuler(width) {
  const dpr = window.devicePixelRatio || 1;
  ruler.width = Math.round(width * dpr); ruler.height = Math.round(26 * dpr);
  ruler.style.width = width + 'px';
  const g = ruler.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = '#141110'; g.fillRect(0, 0, width, 26);
  const step = pxPerSec >= 80 ? 1 : pxPerSec >= 30 ? 2 : pxPerSec >= 15 ? 5 : 10;
  g.fillStyle = '#a39a94'; g.font = '10px ui-monospace, Menlo, monospace';
  for (let s = 0; s * pxPerSec < width; s += step) {
    const x = s * pxPerSec;
    g.fillRect(x, 16, 1, 10);
    g.fillText(fmt(s).replace(/\.\d$/, ''), x + 3, 12);
  }
}
function seekFromEvent(e) {
  const rect = inner.getBoundingClientRect();
  setTime((e.clientX - rect.left) / pxPerSec);
  if (loopMode === 'window') { loopA = t; updateLoopLabel(); }
}
ruler.addEventListener('pointerdown', e => {
  if (exportJob) return;
  seekFromEvent(e);
  const move = ev => seekFromEvent(ev);
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
});
lanesEl.addEventListener('pointerdown', e => { if (e.target.classList.contains('tl-lane') && !exportJob) seekFromEvent(e); });

function snapPoints(ignoreId) {
  const pts = [0, t];
  for (const c of clips) if (c.id !== ignoreId) pts.push(c.start, clipEnd(c));
  return pts;
}
function snap(x, ignoreId) {
  if (!$('#snap').checked) return x;
  const tol = 8 / pxPerSec;
  let best = x, bd = tol;
  for (const p of snapPoints(ignoreId)) { const d = Math.abs(p - x); if (d < bd) { bd = d; best = p; } }
  return best;
}
const overlaps = (k, s, e, id) => clips.some(c => c.track === k && c.id !== id && s < clipEnd(c) - 1e-4 && e > c.start + 1e-4);

function startDrag(e, c, el) {
  if (exportJob) return;
  e.preventDefault();
  select(c.id, false);
  const mode = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'move';
  const x0 = e.clientX, orig = { start: c.start, in: c.in, out: c.out, track: c.track };
  const m = media.find(x => x.id === c.mediaId);
  el.setPointerCapture(e.pointerId);
  el.classList.add('dragging');
  let moved = false;
  const onMove = ev => {
    const d = (ev.clientX - x0) / pxPerSec;
    if (Math.abs(ev.clientX - x0) > 3) moved = true;
    if (!moved) return;
    const len = orig.out - orig.in;
    if (mode === 'move') {
      let s = Math.max(0, orig.start + d);
      const sEnd = snap(s + len, c.id); const sStart = snap(s, c.id);
      s = Math.abs(sStart - s) <= Math.abs(sEnd - (s + len)) ? sStart : sEnd - len;
      const lane = document.elementsFromPoint(ev.clientX, ev.clientY).find(n => n.classList && n.classList.contains('tl-lane'));
      const k = lane ? +lane.dataset.k : c.track;
      if (!overlaps(k, s, s + len, c.id)) { c.start = Math.max(0, s); c.track = k; }
      else if (!overlaps(c.track, s, s + len, c.id)) c.start = Math.max(0, s);
    } else if (mode === 'l') {
      let s = snap(orig.start + d, c.id);
      s = clamp(s, Math.max(0, orig.start - orig.in), orig.start + len - 0.1);
      const delta = s - orig.start;
      if (!overlaps(c.track, s, orig.start + len, c.id)) { c.start = s; c.in = orig.in + delta; }
    } else {
      let e2 = snap(orig.start + len + d, c.id);
      e2 = clamp(e2, orig.start + 0.1, orig.start + (m.duration - orig.in));
      if (!overlaps(c.track, orig.start, e2, c.id)) c.out = orig.in + (e2 - orig.start);
    }
    el.style.left = c.start * pxPerSec + 'px';
    el.style.width = Math.max(6, (c.out - c.in) * pxPerSec) + 'px';
    dirty = true;
  };
  const onUp = () => {
    el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onUp);
    el.classList.remove('dragging');
    if (moved) { trackState.forEach(ts => { ts.clipId = null; }); renderTimeline(); renderInspector(); }
  };
  el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onUp);
}
const zoomIn = $('#zoom');
zoomIn.oninput = () => { pxPerSec = +zoomIn.value; setFill(zoomIn); renderTimeline(); };
setFill(zoomIn);
window.addEventListener('resize', renderTimeline);

/* ---------- Edit tools ---------- */
function updateToolButtons() {
  const c = selected();
  $('#split-btn').disabled = !(c && t > c.start + 0.05 && t < clipEnd(c) - 0.05) || clips.length >= MAX_CLIPS;
  $('#dup-btn').disabled = !c || clips.length >= MAX_CLIPS;
  $('#del-btn').disabled = !c;
}
function split() {
  const c = selected();
  if (!c || exportJob || clips.length >= MAX_CLIPS || !(t > c.start + 0.05 && t < clipEnd(c) - 0.05)) return;
  const b = clone(c);
  b.id = nextId++;
  const cut = c.in + (t - c.start);
  b.start = t; b.in = cut;
  c.out = cut;
  clips.push(b);
  select(b.id);
  renderTimeline();
}
function duplicate() {
  const c = selected();
  if (!c || exportJob || clips.length >= MAX_CLIPS) return;
  const b = clone(c);
  b.id = nextId++;
  const len = c.out - c.in;
  // Right after the original if there's room, else stacked on a free layer, else at the end.
  const tries = [[c.track, clipEnd(c)], ...[0, 1, 2].filter(k => k !== c.track).map(k => [k, c.start])];
  const spot = tries.find(([k, s]) => !overlaps(k, s, s + len, -1));
  if (spot) [b.track, b.start] = spot;
  else b.start = Math.max(...clips.filter(x => x.track === c.track).map(clipEnd));
  clips.push(b);
  trackState.forEach(ts => { ts.clipId = null; });
  select(b.id);
}
function remove() {
  const c = selected();
  if (!c || exportJob) return;
  clips.splice(clips.indexOf(c), 1);
  for (const [key, inst] of instances) if (key.startsWith(c.id + '|')) { inst.dispose(); instances.delete(key); }
  selectedId = null;
  trackState.forEach(ts => { ts.clipId = null; });
  afterMediaChange();
}
$('#split-btn').onclick = split;
$('#dup-btn').onclick = duplicate;
$('#del-btn').onclick = remove;
document.addEventListener('keydown', e => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || exportJob) return;
  if (e.code === 'Space' && clips.length) { e.preventDefault(); playing ? pause() : play(); }
  else if (e.key === 's' || e.key === 'S') split();
  else if (e.key === 'd' || e.key === 'D') duplicate();
  else if (e.key === 'Delete' || e.key === 'Backspace') remove();
});

/* ---------- Inspector ---------- */
const openGroups = new Set();   // keep sections open while switching clips
const bandOptions = `<option value="none">Off</option>` + BANDS.map(b => `<option value="${b.id}">${b.label} (${b.range})</option>`).join('');
const fmtVal = (p, v) => (p.step >= 1 ? Math.round(v) : (+v).toFixed(p.step < 0.01 ? 3 : 2));
function buildControls(container, def, st, grouped) {
  container.innerHTML = '';
  let parent = container, group = null;
  for (const p of def.params) {
    if (grouped && p.group !== group) {
      group = p.group;
      const det = document.createElement('details');
      det.className = 'group';
      det.open = group === 'Light' || openGroups.has(def.id + '|' + group);
      det.addEventListener('toggle', () => { const k = def.id + '|' + group; if (det.open) openGroups.add(k); else openGroups.delete(k); });
      det.innerHTML = `<summary>${group}</summary><div class="params"></div>`;
      container.appendChild(det);
      parent = det.querySelector('.params');
    }
    const row = document.createElement('div');
    row.className = 'param';
    if (p.type === 'select') {
      row.classList.add('select-param');
      row.innerHTML = `<div class="param-head"><span class="param-label">${p.label}</span></div><select>${p.options.map((o, i) => `<option value="${i}">${o}</option>`).join('')}</select>`;
      const sel = row.querySelector('select');
      sel.value = st.values[p.id];
      sel.onchange = () => { st.values[p.id] = +sel.value; changed(def); };
    } else if (p.type === 'color') {
      row.classList.add('color-param');
      row.innerHTML = `<div class="param-head"><span class="param-label">${p.label}</span><input type="color"></div>`;
      const inp = row.querySelector('input');
      inp.value = st.values[p.id];
      inp.oninput = () => { st.values[p.id] = inp.value; changed(def); };
    } else {
      row.innerHTML = `
        <div class="param-head"><span class="param-label">${p.label}</span><span class="param-val"></span><button class="mod-btn" title="Link to an audio band">+EQ</button></div>
        <div class="slider-wrap"><input type="range" min="${p.min}" max="${p.max}" step="${p.step}"></div>
        <div class="mod-row" hidden>
          <label>Band<select class="band">${bandOptions}</select></label>
          <label>Depth <span class="depth-val"></span><input class="depth" type="range" min="-1" max="1" step="0.01"></label>
        </div>`;
      const input = row.querySelector('input[type=range]'), val = row.querySelector('.param-val'), modBtn = row.querySelector('.mod-btn');
      const band = row.querySelector('.band'), depth = row.querySelector('.depth'), depthVal = row.querySelector('.depth-val');
      const m = st.mods[p.id] = st.mods[p.id] || { band: 'none', depth: 0.5 };
      input.value = st.values[p.id]; band.value = m.band; depth.value = m.depth;
      const sync = () => {
        val.textContent = fmtVal(p, st.values[p.id]);
        depthVal.textContent = (m.depth > 0 ? '+' : '') + Math.round(m.depth * 100) + '%';
        const linked = m.band !== 'none';
        modBtn.classList.toggle('linked', linked);
        modBtn.textContent = linked ? BANDS.find(b => b.id === m.band).short : '+EQ';
        setFill(input); setFill(depth);
      };
      input.oninput = () => { st.values[p.id] = +input.value; sync(); changed(def); };
      input.ondblclick = () => { st.values[p.id] = p.value; input.value = p.value; sync(); changed(def); };
      band.onchange = () => { m.band = band.value; sync(); };
      depth.oninput = () => { m.depth = +depth.value; sync(); };
      modBtn.onclick = () => { row.querySelector('.mod-row').hidden = !row.querySelector('.mod-row').hidden; };
      sync();
    }
    parent.appendChild(row);
  }
}
function changed(def) {
  dirty = true;
  if (def === LOOK) { renderTimeline(); updateMaskStatus(); }
  else if (def === GLOBAL) updateBadge();
  else if (def.id && def.id.startsWith('circ')) updateCircuitReadouts();
  else updateTrackStatus();
}
function select(id, rerender = true) {
  selectedId = id;
  const c = selected();
  if (c && (t < c.start || t >= clipEnd(c)) && !exportJob) { setTime(c.start); if (loopMode === 'window') loopA = c.start; }
  if (rerender) renderTimeline();
  else { document.querySelectorAll('.clip').forEach(el => el.classList.toggle('selected', +el.dataset.id === id)); updateToolButtons(); }
  renderInspector();
}
function renderInspector() {
  const c = selected();
  const m = c ? media.find(x => x.id === c.mediaId) : null;
  $('#clip-title').textContent = c ? (clips.length > 1 ? `Layer ${c.track + 1}: ${m.name}` : m.name) : 'No clip selected';
  $('#clip-sub').textContent = c ? `${fmt(c.start)} to ${fmt(clipEnd(c))} on the timeline, using ${fmt(c.in)} to ${fmt(c.out)} of the source.`
    : clips.length ? 'Tap a clip on the timeline to edit it.' : 'Add a video to get started.';
  if (c) buildControls($('#clip-look'), LOOK, c.look, true); else $('#clip-look').innerHTML = '';
  updateMaskStatus();
  const fx = c && c.effect !== 'none' ? getFx(c.effect) : null;
  $('#fx-name').textContent = fx ? fx.name : 'Effect';
  $('#fx-desc').textContent = fx ? fx.description : c ? 'No effect on this clip yet. Choose a card in the gallery to apply one.' : 'Select a clip, then choose an effect card.';
  $('#fx-toggle').checked = !!(c && fx && c.fxOn);
  $('#fx-toggle').disabled = !fx;
  $('#fx-block').classList.toggle('is-off', !!(fx && !c.fxOn));
  $('#randomize-btn').disabled = $('#reset-btn').disabled = !fx;
  if (fx) buildControls($('#params'), fx, fxState(c, fx.id), false); else $('#params').innerHTML = '';
  $('#global-toggle').checked = !c || c.globalOn;
  $('#global-toggle').disabled = !c;
  $('#global-block').classList.toggle('is-off', !!(c && !c.globalOn));
  if (c) buildControls($('#global-params'), GLOBAL, c.global, true); else $('#global-params').innerHTML = '';
  renderCircuit();
  refreshCards();
  updateTrackStatus();
  updateBadge();
}
function updateTrackStatus() {
  const c = selected();
  const kinds = neededKinds(c);
  $('#track-status').hidden = $('#track-note').hidden = !kinds.length;
  $('#track-status').textContent = kinds.length ? tracker.statusText(kinds) : '';
}
function updateBadge() {
  const c = selected();
  const layers = new Set(clips.map(x => x.track)).size;
  const g = c && c.globalOn && !isNeutral(clipGlobal(c));
  $('#effect-badge').textContent = !c ? (clips.length ? `${layers} layer${layers === 1 ? '' : 's'}` : '')
    : `${fxOf(c) ? fxOf(c).name : g ? 'Global Effects' : 'Original'}${fxOf(c) && g ? ' + Global' : ''}${layers > 1 ? ` · layer ${c.track + 1} of ${layers}` : ''}`;
}
function resetClipInstances(c) { trackState.forEach(ts => { if (ts.clipId === c.id) ts.clipId = null; }); dirty = true; }

/* Effect switch, shuffle, reset */
$('#fx-toggle').onchange = e => { const c = selected(); if (!c) return; c.fxOn = e.target.checked; resetClipInstances(c); renderInspector(); renderTimeline(); };
$('#global-toggle').onchange = e => { const c = selected(); if (!c) return; c.globalOn = e.target.checked; dirty = true; renderInspector(); };
$('#reset-btn').onclick = () => { const c = selected(); if (!c || c.effect === 'none') return; c.fx[c.effect] = defaults(getFx(c.effect)); renderInspector(); dirty = true; };
$('#randomize-btn').onclick = () => {
  const c = selected(); if (!c || c.effect === 'none') return;
  const fx = getFx(c.effect), st = fxState(c, fx.id);
  for (const q of fx.params) {
    if (q.type === 'color') continue;
    if (!isRange(q)) { st.values[q.id] = Math.floor(Math.random() * q.options.length); continue; }
    const v = q.value + (Math.random() * 2 - 1) * (q.max - q.min) * 0.5;
    st.values[q.id] = +(Math.round(clamp(v, q.min, q.max) / q.step) * q.step).toFixed(4);
  }
  renderInspector(); dirty = true;
};
$('#global-reset').onclick = () => { const c = selected(); if (!c) return; c.global = defaults(GLOBAL); c.circuit = []; renderInspector(); dirty = true; };

/* ---------- Gallery: live previews of the selected clip ---------- */
const gallery = $('#gallery');
const galR = new Renderer(document.createElement('canvas'));
galR.grader = new Grader(galR);
const galInst = new Map(), cards = new Map();
let galleryVisible = true, galKey = '';
for (const fx of EFFECTS) {
  const el = document.createElement('button');
  el.className = 'fx-card';
  el.dataset.id = fx.id;
  el.style.setProperty('--c1', fx.swatch[0]);
  el.style.setProperty('--c2', fx.swatch[1]);
  el.innerHTML = `<canvas></canvas><div class="fx-meta"><h3>${fx.name}</h3><p>${fx.description}</p></div>`;
  el.onclick = () => applyEffect(fx.id);
  gallery.appendChild(el);
  const cv = el.querySelector('canvas');
  cards.set(fx.id, { el, canvas: cv, ctx2d: cv.getContext('2d') });
}
new IntersectionObserver(es => { galleryVisible = es[0].isIntersecting; }, { threshold: 0.01 }).observe(gallery);
// Only cards on screen render (16+ live effects is a lot of GPU work).
const cardIO = new IntersectionObserver(es => { for (const e of es) e.target.dataset.onscreen = e.isIntersecting ? '1' : ''; }, { rootMargin: '120px' });
for (const c of cards.values()) { c.el.dataset.onscreen = '1'; cardIO.observe(c.el); }
function galleryClip() {
  const c = selected();
  if (c) return c;
  for (let k = TRACKS - 1; k >= 0; k--) { const a = activeClip(k, t); if (a) return a; }
  return null;
}
function refreshCards() {
  const c = selected();
  for (const [id, card] of cards) card.el.classList.toggle('is-selected', !!(c && c.fxOn && c.effect === id));
  const g = galleryClip();
  $('#gallery-sub').textContent = g ? `Live previews of ${clips.length > 1 ? `layer ${g.track + 1} (${media.find(x => x.id === g.mediaId).name})` : 'your clip'}. Choose one to apply it.` : 'Live previews of the selected clip. Choose one to apply it.';
}
function applyEffect(id) {
  if (exportJob) return;
  const c = selected() || galleryClip();
  if (!c) return;
  c.effect = id; c.fxOn = true;
  resetClipInstances(c);
  selectedId = c.id;
  renderTimeline(); renderInspector();
}
function renderGallery() {
  if (!galleryVisible || exportJob) return;
  const c = galleryClip();
  if (!c) return;
  const p = player(c.track, c.mediaId), v = p.video;
  if (v.readyState < 2) return;
  const key = c.id + '|' + c.track;
  let step = false;
  if (key !== galKey) {
    const m = media.find(x => x.id === c.mediaId);
    const sc = Math.min(1, GALLERY_LONG / Math.max(m.w, m.h));
    galR.resize(Math.max(2, Math.round(m.w * sc / 2) * 2), Math.max(2, Math.round(m.h * sc / 2) * 2));
    for (const card of cards.values()) { card.canvas.width = galR.w; card.canvas.height = galR.h; card.el.classList.add('live'); }
    for (const inst of galInst.values()) inst.reset();
    galKey = key; step = true;
  }
  const fresh = p.galFresh || (p.galLastT !== undefined && v.currentTime !== p.galLastT);
  if (fresh && IS_MOBILE && frameNo % 2 && galR.hasFrame) return;   // phones: half rate
  if (fresh) { step = true; p.galFresh = false; p.galLastT = v.currentTime; }
  if (!step && !dirty) return;
  const mt = clamp(c.in + (t - c.start), c.in, c.out);
  galR.time = mt; galR.frameIndex = frameNo; galR.gradeParams = clipGlobal(c);
  if (step || !galR.hasFrame) galR.upload(v, v.videoWidth, v.videoHeight); else galR.regrade();
  const ts = trackState[c.track];
  const track = ts.clipId === c.id ? ts.track : { faces: [], hands: [], poses: [], fresh: false };
  const gp = galR.gradeParams;
  for (const fx of EFFECTS) {
    const card = cards.get(fx.id);
    if (!card.el.dataset.onscreen) continue;
    if (!galInst.has(fx.id)) galInst.set(fx.id, fx.create(galR));
    galInst.get(fx.id).render(resolve(fx, fxState(c, fx.id)), {
      step, time: mt, frame: frameNo, dt: 1 / 30, tracker, track, hit: audioOn ? audio.levels.hit : 0,
      srcW: v.videoWidth / (gp ? gp.zoom : 1), srcH: v.videoHeight / (gp ? gp.zoom : 1),
    }, null);
    card.ctx2d.drawImage(galR.canvas, 0, 0);
  }
}

/* ---------- Video Circuit (per clip, inside Global Effects) ---------- */
let circUid = 1;
function addStage(c, typeId, overrides = {}) {
  if (c.circuit.length >= MAX_STAGES) return;
  const st = { uid: circUid++, typeId, st: null, bypass: false };
  st.st = defaults(stageDef(st));
  Object.assign(st.st.values, overrides);
  c.circuit.push(st);
}
function updateCircuitReadouts() {
  const c = selected();
  if (!c) return;
  for (const st of c.circuit) {
    const el = document.querySelector(`[data-stage="${st.uid}"] .readout`);
    if (el) el.textContent = circuitType(st.typeId).derive(st.st.values, 960).info;
  }
}
function renderCircuit() {
  const c = selected();
  const box = $('#circuit-stages'), chain = $('#circuit-chain');
  box.innerHTML = '';
  $('#circuit-group').hidden = !c;
  if (!c) return;
  c.circuit.forEach((st, i) => {
    const ty = circuitType(st.typeId);
    const card = document.createElement('div');
    card.className = 'stage' + (st.bypass ? ' bypassed' : '');
    card.dataset.stage = st.uid;
    card.innerHTML = `
      <div class="stage-head">
        <div><b>${i + 1}. ${ty.name}</b><span class="readout"></span></div>
        <div class="stage-btns">
          <button data-a="up" title="Move earlier" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button data-a="down" title="Move later" ${i === c.circuit.length - 1 ? 'disabled' : ''}>↓</button>
          <button data-a="bypass" title="Bypass this stage">${st.bypass ? 'Off' : 'On'}</button>
          <button data-a="remove" title="Remove this stage">✕</button>
        </div>
      </div>
      <p class="stage-about">${ty.about}</p>
      <div class="params"></div>`;
    card.querySelector('.stage-btns').addEventListener('click', e => {
      const a = e.target.dataset.a;
      if (!a) return;
      if (a === 'remove') c.circuit.splice(i, 1);
      else if (a === 'bypass') st.bypass = !st.bypass;
      else { const j = a === 'up' ? i - 1 : i + 1; [c.circuit[i], c.circuit[j]] = [c.circuit[j], c.circuit[i]]; }
      renderCircuit(); updateBadge(); dirty = true;
    });
    buildControls(card.querySelector('.params'), stageDef(st), st.st, false);
    box.appendChild(card);
  });
  chain.innerHTML = ['<span class="node io">IN</span>', ...c.circuit.map(st => `<span class="node${st.bypass ? ' off' : ''}">${circuitType(st.typeId).chip}</span>`), '<span class="node io">OUT</span>'].join('<span class="wire"></span>');
  $('#circuit-count').textContent = c.circuit.length ? `${c.circuit.length} stage${c.circuit.length === 1 ? '' : 's'}` : '';
  $('#circuit-add').disabled = c.circuit.length >= MAX_STAGES;
  updateCircuitReadouts();
}
$('#circuit-add-type').innerHTML = CIRCUIT_TYPES.map(ty => `<option value="${ty.id}">${ty.name}</option>`).join('');
$('#circuit-add').onclick = () => { const c = selected(); if (!c) return; addStage(c, $('#circuit-add-type').value); renderCircuit(); updateBadge(); dirty = true; };
$('#circuit-preset').innerHTML = '<option value="">Load a preset circuit...</option>' + CIRCUIT_PRESETS.map((pr, i) => `<option value="${i}">${pr.name}</option>`).join('');
$('#circuit-preset').onchange = e => {
  const c = selected(), pr = CIRCUIT_PRESETS[e.target.value];
  e.target.value = '';
  if (!c || !pr) return;
  c.circuit = [];
  pr.stages.forEach(([id, o]) => addStage(c, id, o));
  renderCircuit(); updateBadge(); dirty = true;
};
$('#circuit-clear').onclick = () => { const c = selected(); if (!c) return; c.circuit = []; renderCircuit(); updateBadge(); dirty = true; };

/* ---------- Loop ---------- */
function updateLoopLabel() {
  const [a, b] = loopRange();
  $('#loop-label').textContent = loopMode === 'window' && clips.length ? `${fmt(a)} to ${fmt(b)}` : '';
}
document.querySelectorAll('#transport .seg-btn').forEach(b => b.onclick = () => {
  loopMode = b.dataset.loop;
  if (loopMode === 'window') loopA = clamp(t, 0, Math.max(0, duration() - WINDOW));
  document.querySelectorAll('#transport .seg-btn').forEach(x => x.classList.toggle('is-on', x === b));
  updateLoopLabel();
  if (loopMode === 'window' && (t < loopA || t > loopA + WINDOW)) setTime(loopA);
});

/* ---------- Audio UI ---------- */
const eqEl = $('#eq'), eqFills = {};
for (const b of BANDS) {
  const el = document.createElement('div');
  el.className = 'eq-band';
  el.title = `${b.label}: ${b.range}`;
  el.innerHTML = `<div class="eq-bar"><div class="eq-fill"></div></div><span>${b.short}</span>`;
  eqEl.appendChild(el);
  eqFills[b.id] = el.querySelector('.eq-fill');
}
function updateMeters() { for (const b of BANDS) eqFills[b.id].style.transform = `scaleY(${(audio.levels[b.id] || 0).toFixed(3)})`; }
$('#audio-toggle').onchange = e => { audioOn = e.target.checked; document.body.classList.toggle('audio-on', audioOn); document.body.classList.toggle('audio-off', !audioOn); dirty = true; };
document.body.classList.add('audio-off');
const volIn = $('#volume'), muteBtn = $('#mute-btn');
let muted = false;
function applyVolume() { if (monitor) monitor.gain.value = muted ? 0 : +volIn.value; muteBtn.classList.toggle('muted', muted || +volIn.value === 0); setFill(volIn); }
volIn.oninput = () => { muted = false; applyVolume(); };
muteBtn.onclick = () => { muted = !muted; applyVolume(); };
setFill(volIn);
const rangeIn = $('#audio-range'), smoothIn = $('#audio-smooth');
rangeIn.oninput = () => { audio.range = +rangeIn.value; $('#audio-range-val').textContent = rangeIn.value + ' dB'; setFill(rangeIn); };
smoothIn.oninput = () => { audio.smoothing = +smoothIn.value; $('#audio-smooth-val').textContent = Math.round(smoothIn.value * 100) + '%'; setFill(smoothIn); };
$('#audio-agc').onchange = e => { audio.autoGain = e.target.checked; audio.peak = {}; };
setFill(rangeIn); setFill(smoothIn);
$('#aspect').onchange = e => { aspectSetting = e.target.value; if (!exportJob) sizeOutput(...sizeFor(PREVIEW_LONG)); updateFrameUI(); };
$('#ex-res').addEventListener('change', updateFrameUI);
for (const id of ['custom-w', 'custom-h']) $('#' + id).onchange = () => {
  customW = clamp(Math.round((+$('#custom-w').value || 1080) / 2) * 2, 16, 3840);
  customH = clamp(Math.round((+$('#custom-h').value || 1920) / 2) * 2, 16, 3840);
  $('#custom-w').value = customW; $('#custom-h').value = customH;
  if (!exportJob) sizeOutput(...sizeFor(PREVIEW_LONG));
  updateFrameUI();
};

/* ---------- Export ---------- */
const exportBtn = $('#export-btn'), cancelBtn = $('#cancel-btn'), note = $('#export-note');
exportBtn.onclick = startExport;
cancelBtn.onclick = () => finishExport(true);
async function startExport() {
  if (!clips.length || exportJob) return;
  ensureAudio();
  unlockPlayers();                       // inside this tap, so every layer may play with sound
  for (const p of players.values()) p.video.muted = false;
  if (typeof MediaRecorder === 'undefined') { alert('This browser does not support MediaRecorder, which is needed to render video.'); return; }
  const mime = pickMime($('#ex-format').value);
  if (!mime) { alert('No supported recording format found in this browser.'); return; }
  pause();
  const [w, h] = exportSize();
  const [rs, re] = $('#ex-range').value === 'window' ? loopRange() : [0, duration()];
  sizeOutput(w, h);
  for (const [, inst] of instances) inst.reset();
  setTime(rs);
  syncPlayers(rs);
  await new Promise(res => setTimeout(res, 600));   // let every layer land on its first frame
  let stream = canvas.captureStream(0);
  let vtrack = stream.getVideoTracks()[0];
  const manual = typeof vtrack.requestFrame === 'function';
  if (!manual) { vtrack.stop(); stream = canvas.captureStream(30); vtrack = stream.getVideoTracks()[0]; }
  const rec = new MediaRecorder(new MediaStream([vtrack, recordDest.stream.getAudioTracks()[0]]), { mimeType: mime, videoBitsPerSecond: bitrateFor(w, h, $('#ex-quality').value), audioBitsPerSecond: 192000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(res => { rec.onstop = res; });
  exportJob = { rec, chunks, stopped, vtrack, manual, w, h, mime, start: rs, end: re, lastFrame: -1, finishing: false };
  keepAwake().then(lock => { if (exportJob) exportJob.wake = lock; else if (lock) lock.release(); });
  document.body.classList.add('exporting');
  exportBtn.hidden = true; cancelBtn.hidden = false;
  $('#render-overlay').hidden = false; $('#result').hidden = true;
  wantPlayAfter = true;
  note.textContent = `${w}x${h}, ${mime.split(';')[0].replace('video/', '').toUpperCase()}, ${clips.length} clip${clips.length === 1 ? '' : 's'} on ${new Set(clips.map(c => c.track)).size} layer(s).`;
  rec.start(1000);
  play();
}
function exportTick(time) {
  const job = exportJob;
  if (job.manual && time - job.lastFrame >= 1 / 30 - 0.004) { job.vtrack.requestFrame(); job.lastFrame = time; }
  const pct = clamp((time - job.start) / Math.max(0.01, job.end - job.start), 0, 1);
  $('#render-fill').style.width = (pct * 100).toFixed(1) + '%';
  $('#render-pct').textContent = Math.round(pct * 100) + '%';
  $('#render-sub').textContent = `${fmt(job.end - time)} left. Keep this tab visible while it renders.`;
  exportBtn.textContent = `Rendering ${Math.round(pct * 100)}%`;
  if (time >= job.end - 0.02) finishExport(false);
}
let wantPlayAfter = false;
async function finishExport(cancelled) {
  const job = exportJob;
  if (!job || job.finishing) return;
  job.finishing = true;
  pause();
  if (job.manual) job.vtrack.requestFrame();
  await new Promise(res => setTimeout(res, 150));
  if (job.rec.state !== 'inactive') job.rec.stop();
  await job.stopped;
  job.vtrack.stop();
  if (job.wake) job.wake.release().catch(() => {});
  exportJob = null;
  document.body.classList.remove('exporting');
  exportBtn.hidden = false; cancelBtn.hidden = true;
  exportBtn.textContent = 'Process & download';
  $('#render-overlay').hidden = true;
  if (!cancelled && job.chunks.length) {
    const type = job.mime.split(';')[0];
    const one = clips.length === 1 ? clips[0] : null;
    const stem = one ? media.find(x => x.id === one.mediaId).name.replace(/\.[^.]+$/, '') + '_' + (fxOf(one) ? one.effect : 'global') : 'vidport';
    const name = `${stem}_${job.w}x${job.h}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
    if (lastDownload) URL.revokeObjectURL(lastDownload);
    lastDownload = presentResult(new Blob(job.chunks, { type }), name, $('#result'));
    note.textContent = IS_IOS ? `Ready: ${name}. Tap ${$('#result button') ? 'Save video' : 'Download'} to keep it.` : `Saved ${name}.`;
  } else note.textContent = cancelled ? 'Render cancelled.' : 'Nothing was recorded. Try again with the tab in the foreground.';
  sizeOutput(...sizeFor(PREVIEW_LONG));
  setTime(loopRange()[0]);
  if (wantPlayAfter) play();
}

/* ---------- Boot ---------- */
renderLabels();
renderTimeline();
renderInspector();
