import { Renderer, FS_IO } from '../gl.js';
import { EFFECTS } from '../effects/index.js';
import { GLOBAL, Grader } from '../global.js';
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
const duration = () => Math.max(0, ...clips.map(c => c.start + (c.out - c.in)));
const clipEnd = c => c.start + (c.out - c.in);
const selected = () => clips.find(c => c.id === selectedId) || null;

/* Layer look controls (per clip) */
const LOOK = { id: 'look', params: [
  { id: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, value: 1 },
  { id: 'blend', label: 'Blend Mode', type: 'select', options: BLENDS, value: 0 },
  { id: 'fit', label: 'Fit', type: 'select', options: ['Fill frame (crop)', 'Fit inside'], value: 0 },
  { id: 'scale', label: 'Scale', min: 0.1, max: 3, step: 0.01, value: 1 },
  { id: 'x', label: 'Position X', min: -1, max: 1, step: 0.005, value: 0 },
  { id: 'y', label: 'Position Y', min: -1, max: 1, step: 0.005, value: 0 },
  { id: 'rotate', label: 'Rotation', min: -180, max: 180, step: 1, value: 0 },
  { id: 'fadeIn', label: 'Fade In (s)', min: 0, max: 5, step: 0.05, value: 0 },
  { id: 'fadeOut', label: 'Fade Out (s)', min: 0, max: 5, step: 0.05, value: 0 },
  { id: 'volume', label: 'Clip Volume', min: 0, max: 1.5, step: 0.01, value: 1 },
] };
const defaults = def => {
  const values = {}, mods = {};
  for (const p of def.params) { values[p.id] = p.value; if (isRange(p)) mods[p.id] = p.mod ? { ...p.mod } : { band: 'none', depth: 0.5 }; }
  return { values, mods };
};
function newClip(m, track, start) {
  return { id: nextId++, mediaId: m.id, track, start, in: 0, out: m.duration, effect: 'none', fx: {}, look: defaults(LOOK), global: defaults(GLOBAL) };
}
const fxState = (c, id) => (c.fx[id] = c.fx[id] || defaults(getFx(id)));

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
  const p = { key, track, mediaId, video: v, fresh: false, gain: null, lastGain: 0 };
  if ('requestVideoFrameCallback' in v) { const cb = () => { p.fresh = true; v.requestVideoFrameCallback(cb); }; v.requestVideoFrameCallback(cb); }
  else p.lastT = -1;
  v.addEventListener('seeked', () => { p.fresh = true; dirty = true; });
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
const canvas = $('#layers-canvas');
const R = new Renderer(canvas, { preserve: IS_IOS });
const COMP_FS = FS_IO + /* glsl */ `
uniform sampler2D uAccum, uLayer;
uniform vec2 uCenter, uSize;
uniform float uOpacity, uBlend, uRot;
void main() {
  vec3 a = texture(uAccum, vUv).rgb;
  float asp = uRes.x / uRes.y;
  vec2 q = vUv - uCenter; q.x *= asp;
  float c = cos(uRot), s = sin(uRot);
  q = mat2(c, -s, s, c) * q; q.x /= asp;
  vec2 luv = q / uSize + 0.5;
  if (luv.x < 0.0 || luv.x > 1.0 || luv.y < 0.0 || luv.y > 1.0) { outColor = vec4(a, 1.0); return; }
  vec3 l = texture(uLayer, luv).rgb, b;
  if (uBlend < 0.5) b = l;
  else if (uBlend < 1.5) b = 1.0 - (1.0 - a) * (1.0 - l);
  else if (uBlend < 2.5) b = min(a + l, 1.0);
  else if (uBlend < 3.5) b = a * l;
  else if (uBlend < 4.5) b = abs(a - l);
  else if (uBlend < 5.5) b = mix(2.0 * a * l, 1.0 - 2.0 * (1.0 - a) * (1.0 - l), step(0.5, a));
  else if (uBlend < 6.5) b = max(a, l);
  else b = min(a, l);
  outColor = vec4(mix(a, b, uOpacity), 1.0);
}`;
const compProg = R.fx(COMP_FS);
let accum = null;
const views = tracks.map(() => { const v = R.view(); v.grader = new Grader(v); return v; });
const trackState = tracks.map(() => ({ clipId: null, tex: null, track: { faces: [], hands: [], poses: [], fresh: false }, frame: 0 }));
const instances = new Map();   // `${clipId}|${track}|${fxId}` -> effect instance
const tracker = new Tracker();
tracker.onChange = () => { updateTrackStatus(); dirty = true; };
window.videoPortalTracker = tracker;

function projectAspect() {
  if (aspectSetting !== 'auto') return +aspectSetting;
  const c = [...clips].sort((a, b) => a.track - b.track || a.start - b.start)[0];
  const m = c ? media.find(x => x.id === c.mediaId) : media[0];
  return m ? m.w / m.h : 16 / 9;
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

function neededKinds(c) { const fx = c && c.effect !== 'none' ? getFx(c.effect) : null; return fx && fx.needs ? fx.needs(resolve(fx, fxState(c, fx.id))) : []; }
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
    const inst = c.effect !== 'none' ? instances.get(`${c.id}|${k}|${c.effect}`) : null;
    if (inst) inst.reset();
    ts.clipId = c.id;
    step = true;
  }
  if (p.fresh || (p.lastT !== undefined && v.currentTime !== p.lastT)) { step = true; p.fresh = false; p.lastT = v.currentTime; }
  if (!step && !force && ts.tex) return;
  const mt = c.in + (time - c.start);
  const gp = resolve(GLOBAL, c.global);
  gp.circuit = [];
  view.time = mt; view.frameIndex = ++ts.frame; view.gradeParams = gp;
  if (step || !view.hasFrame) view.upload(v, v.videoWidth, v.videoHeight); else view.regrade();
  if (c.effect === 'none') { ts.tex = view.cur; return; }
  const fx = getFx(c.effect);
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
    srcW: v.videoWidth / gp.zoom, srcH: v.videoHeight / gp.zoom,
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
    const la = views[k].w / views[k].h;
    let sw = 1, sh = 1;
    const cover = Math.round(look.fit) === 0;
    if ((la > oa) === cover) sh = cover ? 1 : oa / la, sw = cover ? la / oa : 1;
    else sw = cover ? 1 : la / oa, sh = cover ? oa / la : 1;
    R.pass(compProg, accum.write, {
      uCenter: [0.5 + look.x * 0.5, 0.5 + look.y * 0.5], uSize: [sw * look.scale, sh * look.scale],
      uOpacity: look.opacity * fadeAt(c, look, time), uBlend: look.blend, uRot: -look.rotate * Math.PI / 180,
    }, { uAccum: accum.read, uLayer: ts.tex });
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
  if (t >= duration() - 0.05) setTime(0);
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
    const d = duration();
    if (t >= d) {
      if (exportJob) { finishExport(false); return; }
      setTime(0); t = 0;
    }
  } else t = base;
  syncPlayers(t);
  frameNo++;
  // Layers that need face/hand/body tracking take turns (one detection per frame).
  const needT = [0, 1, 2].filter(k => { const c = activeClip(k, t); return c && neededKinds(c).some(x => x !== 'seg'); });
  trackTurnK = needT.length ? needT[frameNo % needT.length] : -1;
  for (let k = 0; k < TRACKS; k++) renderTrack(k, t, dirty);
  composite(t);
  dirty = false;
  updateMeters();
  $('#timecode').textContent = `${fmt(t)} / ${fmt(duration())}`;
  $('#tl-playhead').style.left = t * pxPerSec + 'px';
  if (frameNo % 6 === 0) updateToolButtons();
  if (exportJob && !exportJob.finishing) exportTick(t);
}
requestAnimationFrame(tick);

/* ---------- Media ---------- */
$('#media-input').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
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
  if (media.length && !playing) {
    // Muted-safe start so previews show immediately; sound unlocks on the first tap.
    $('#play-overlay').hidden = false;
  }
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
  renderMedia(); renderTimeline(); renderInspector();
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
      el.innerHTML = `<span class="h l"></span><span class="cn">${m ? m.name : '?'}</span><span class="cf">${c.effect === 'none' ? 'No effect' : getFx(c.effect).name}${resolve(LOOK, c.look).blend ? ' · ' + BLENDS[c.look.values.blend] : ''}</span><span class="h r"></span>`;
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
  if (def === LOOK) { const c = selected(); if (c) renderTimeline(); }
  if (def !== LOOK && def !== GLOBAL) updateTrackStatus();
}
const fxSel = $('#clip-effect');
fxSel.innerHTML = '<option value="none">No effect (clean layer)</option>' + EFFECTS.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
fxSel.onchange = () => {
  const c = selected();
  if (!c) return;
  c.effect = fxSel.value;
  trackState.forEach(ts => { if (ts.clipId === c.id) ts.clipId = null; });
  renderInspector(); renderTimeline();
};
function select(id, rerender = true) {
  selectedId = id;
  if (rerender) renderTimeline();
  else { document.querySelectorAll('.clip').forEach(el => el.classList.toggle('selected', +el.dataset.id === id)); updateToolButtons(); }
  renderInspector();
}
function renderInspector() {
  const c = selected();
  $('#clip-body').hidden = !c;
  $('#clip-block').classList.toggle('empty', !c);
  if (!c) { $('#clip-title').textContent = 'No clip selected'; $('#clip-sub').textContent = clips.length ? 'Tap a clip on the timeline to edit it.' : 'Add videos to get started.'; return; }
  const m = media.find(x => x.id === c.mediaId);
  $('#clip-title').textContent = `Layer ${c.track + 1}: ${m.name}`;
  $('#clip-sub').textContent = `${fmt(c.start)} to ${fmt(clipEnd(c))} on the timeline, using ${fmt(c.in)} to ${fmt(c.out)} of the source.`;
  buildControls($('#clip-look'), LOOK, c.look, false);
  fxSel.value = c.effect;
  const fx = c.effect === 'none' ? null : getFx(c.effect);
  if (fx) buildControls($('#clip-fx'), fx, fxState(c, fx.id), false); else $('#clip-fx').innerHTML = '';
  buildControls($('#clip-global'), GLOBAL, c.global, true);
  updateTrackStatus();
}
function updateTrackStatus() {
  const c = selected();
  const kinds = neededKinds(c);
  const el = $('#track-status');
  el.hidden = !kinds.length;
  el.textContent = kinds.length ? tracker.statusText(kinds) : '';
}

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
$('#aspect').onchange = e => { aspectSetting = e.target.value; if (!exportJob) sizeOutput(...sizeFor(PREVIEW_LONG)); };

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
  const short = +$('#ex-res').value, a = projectAspect();
  const [w, h] = a >= 1 ? [Math.round(short * a / 2) * 2, short] : [short, Math.round(short / a / 2) * 2];
  sizeOutput(w, h);
  for (const [, inst] of instances) inst.reset();
  setTime(0);
  syncPlayers(0);
  await new Promise(res => setTimeout(res, 600));   // let every layer land on its first frame
  let stream = canvas.captureStream(0);
  let vtrack = stream.getVideoTracks()[0];
  const manual = typeof vtrack.requestFrame === 'function';
  if (!manual) { vtrack.stop(); stream = canvas.captureStream(30); vtrack = stream.getVideoTracks()[0]; }
  const rec = new MediaRecorder(new MediaStream([vtrack, recordDest.stream.getAudioTracks()[0]]), { mimeType: mime, videoBitsPerSecond: bitrateFor(w, h, $('#ex-quality').value), audioBitsPerSecond: 192000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(res => { rec.onstop = res; });
  exportJob = { rec, chunks, stopped, vtrack, manual, w, h, mime, end: duration(), lastFrame: -1, finishing: false };
  keepAwake().then(lock => { if (exportJob) exportJob.wake = lock; else if (lock) lock.release(); });
  document.body.classList.add('exporting');
  exportBtn.hidden = true; cancelBtn.hidden = false;
  $('#render-overlay').hidden = false; $('#result').hidden = true;
  note.textContent = `${w}x${h}, ${mime.split(';')[0].replace('video/', '').toUpperCase()}, ${clips.length} clip${clips.length === 1 ? '' : 's'} on ${new Set(clips.map(c => c.track)).size} layer(s).`;
  rec.start(1000);
  play();
}
function exportTick(time) {
  const job = exportJob;
  if (job.manual && time - job.lastFrame >= 1 / 30 - 0.004) { job.vtrack.requestFrame(); job.lastFrame = time; }
  const pct = clamp(time / Math.max(0.01, job.end), 0, 1);
  $('#render-fill').style.width = (pct * 100).toFixed(1) + '%';
  $('#render-pct').textContent = Math.round(pct * 100) + '%';
  $('#render-sub').textContent = `${fmt(job.end - time)} left. Keep this tab visible while it renders.`;
  exportBtn.textContent = `Rendering ${Math.round(pct * 100)}%`;
  if (time >= job.end - 0.02) finishExport(false);
}
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
    const name = `layers_${job.w}x${job.h}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
    if (lastDownload) URL.revokeObjectURL(lastDownload);
    lastDownload = presentResult(new Blob(job.chunks, { type }), name, $('#result'));
    note.textContent = IS_IOS ? `Ready: ${name}. Tap ${$('#result button') ? 'Save video' : 'Download'} to keep it.` : `Saved ${name}.`;
  } else note.textContent = cancelled ? 'Render cancelled.' : 'Nothing was recorded. Try again with the tab in the foreground.';
  sizeOutput(...sizeFor(PREVIEW_LONG));
  setTime(0);
}

/* ---------- Boot ---------- */
renderLabels();
renderTimeline();
renderInspector();
