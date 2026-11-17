# Ruckus & Reason Video Portal

Live at https://ruckusandreasoneli.github.io/moshpit/

In-browser video effects. Upload a clip, watch every effect preview live on a 3 second loop of your footage, link any parameter to the soundtrack's EQ, then render the full video and it downloads automatically. Nothing is uploaded to a server: decoding, effects (WebGL2 shaders) and encoding (MediaRecorder) all happen on the user's machine.

Two tools, switchable from the header:

- **Effects** (`index.html`): one clip through glitch, mosh and feedback effects, with audio-reactive EQ linking.
- **Layers** (`layers.html`): three tracks of video with split, trim and a separate effect on every clip.
- **Beat Cut** (`cut.html`): up to 5 clips edited together on the beat.
- **Slice Pause** (`slice.html`): cut one clip into strips and freeze chosen strips on the beat.

## Beat Cut

1. Add up to 5 clips and choose the **Audio**:
   - **No audio**: silent render.
   - **Mix all clips (follows the cuts)**: you hear whichever clip is on screen; with Overlap on, lingering clips stay audible as they fade.
   - **Mix all clips (all at once)**: every clip in rotation plays together, level-balanced.
   - **Clip N audio**: one clip's soundtrack runs uninterrupted under the whole edit.
   - **Song file**: a separate MP3, WAV, M4A (or a video's audio).

   In the mix modes each clip gets a **Volume** slider. Beat detection listens to the chosen soundtrack (clip 1 in the mix modes).
2. Set the tempo: type a BPM, tap along, or press **Detect beat from soundtrack** (finds the BPM and where the first beat lands). Use ÷2 / ×2 for half or double time and **Beat offset** to nudge the grid. Turn on **Click track** to hear the grid while previewing.
3. **Switch every** 1/4, 1/2, 1, 2, 4 or 8 beats. **Randomize timing** varies individual cut lengths (half, double, dotted and so on) while staying on the quarter-beat grid; **Reshuffle** rolls a new pattern.
4. **Clip order**: in order, random (never the same clip twice in a row) or ping-pong. **On each cut**: keep each clip rolling, or jump to a random spot in it.
5. **Overlap** keeps previous clips bleeding through the new one for up to 4 beats, using the **Overlap blend** mode (Screen, Add, Difference and Multiply get aggressive). Each clip has its own **Opacity**. Optional **Punch zoom** and **Flash** hit on every cut.
6. **Frame**: match the first clip, 16:9, 9:16 for Reels, 1:1 or 4:5. Clips are cropped to fill.
7. Set the **Start / End** section (cuts stay locked to the song's beat grid), then **Process & download**.

## Slice Pause

1. Upload a clip. Choose **Vertical (columns)** or **Horizontal (rows)** and **2 to 10 slices**, with an optional divider width and color.
2. Pick the timing:
   - **On the beat:** type a BPM, tap it, or detect it from the clip's audio; nudge **Beat offset**. Choose **Pause every** (1 to 16 beats) and **For** (1/4 to 4 beats), and a pattern for which strips freeze: Alternate, Sweep, Build up, Halves, Random or All.
   - **Free form:** move the playhead and tap **+ Add pause at playhead**, then set its start and length in seconds. Each new pause starts with the opposite strips of the one before it.
3. Edit any pause: tap its block on the timeline (or use Prev / Next) and toggle the strips that freeze. In beat mode your edits are kept when you change the pattern or tempo; **Use pattern** reverts one.
4. During a pause the chosen strips hold the frame from the moment the pause began while the others keep playing. When the pause ends every strip jumps back to the live picture, so they are in sync again. **Frozen strips look** can dim, desaturate, tint or invert the held strips.
5. Set the Start / End section and **Process & download**. The clip's audio plays straight through.

## Effects

| Effect | What it does |
| --- | --- |
| Luma Mesh | Brightness becomes depth on a 3D line/grid/point mesh with tilt motion and RGB split |
| Optical Flow | Lucas-Kanade motion estimation drives a liquid displacement field with trails |
| Data Mosh | Codec simulation: each frame is rebuilt from the previous output using block motion vectors, with residuals scaled down so keyframes "drop" |
| Feedback | Temporal feedback with scale, rotation, warp, drift, hue shift and 4 blend modes |
| Soft Glitch | Spectral (rainbow gradient) chromatic aberration, soft tearing and lens fringe |
| Hard Glitch | Multi-scale random block displacement, color split, block corruption |
| Stretch | Smears everything past a line, with wave and jaggies, in 4 directions |
| 8-Bit | Pixelation, Bayer dithering and 3 CGA palettes |
| Multi-Eye Multi-Mouth | Finds eyes and/or mouths with face tracking and scatters feathered copies around the frame. Set how many of each, size, drift, spin, and how many jump to new spots on each bass hit (or on a timer for silent clips) |
| Scribble: Thick | Body segmentation masks each person; brushy contour strokes follow the silhouette at set distances, with a solid fill behind the body, dry-brush texture and wobble |
| Scribble: Lines | Random, intersecting straight strokes scattered in a band around the body, with optional double strokes and a draw-on pulse |
| Scribble: Swirls | Small cursive loops or spirals that travel along the body's outline |
| Lines & Measurements | Motion-tracking overlay: eyes, nose, mouth, chin, fingertips, knuckles, shoulders, elbows, wrists, hips, knees and ankles, plus high-contrast "sharp points", linked by skeleton / nearest / web / chain lines with pixel distances, coordinates, random codes or a mix, tracker brackets and a HUD |

## Global Effects

A standard grading suite applied to every frame **before** the chosen effect (so motion effects like Data Mosh and Optical Flow work on the graded image). It affects the gallery previews, the main preview and the render.

- **Light:** Exposure, Contrast, Brightness, Highlights, Shadows, Gamma, Fade (matte blacks)
- **Color:** Saturation, Vibrance, Temperature, Tint, Hue Rotate
- **Detail:** Blur, Softness (diffusion glow), Sharpen, Film Grain
- **Color Overlay:** color, amount and blend mode (Normal, Multiply, Screen, Overlay, Soft Light, Color, Add)
- **Lens & Frame:** Vignette, Vignette Size, Zoom (crop), Flip

Every slider supports **+EQ** audio linking, and double-clicking a slider resets it. The switch on the effect panel turns the effect off so you can render with Global Effects only; clicking any effect card turns it back on. The Global Effects switch toggles the whole suite for quick before/after comparisons.

## Layers

The multi-clip version of Effects.

- **Media:** add up to 8 videos. The first three land on layers 1, 2 and 3; later ones extend layer 1. Each media card can add the video to any layer at the playhead.
- **Timeline:** 3 layers (layer 3 on top). Drag clips to move them, including onto another layer; drag their edges to trim. Clips on a layer can't overlap. Snap lines clips up with each other and the playhead. **Split** (S) cuts the selected clip at the playhead, **Duplicate** (D), **Delete**. Each layer can be hidden or muted.
- **Per clip:** opacity, blend mode (Normal, Screen, Add, Multiply, Difference, Overlay, Lighten, Darken), fill or fit, scale, position, rotation, fade in and out, volume; any effect from the gallery with its full controls; and the Global Effects adjustments. Splitting keeps all settings, so you can split a clip and give each half a different effect.
- **Audio:** every clip's sound is mixed; audio reactivity listens to the mix, and every slider has +EQ.
- **Render:** the whole timeline in real time with the mixed audio, at 480p to 1080p in the chosen frame (match first video, 16:9, 9:16, 1:1, 4:5).

Browser limits it is designed around: at most 3 videos decode at once (one per layer; a split clip keeps using the same decoder, so cuts within one file are seamless), 8 source files and 40 clips per project. Previews run at 640 px (480 px on phones) while renders use the chosen size. Face, hand and body tracking on several layers takes turns, one layer per frame. Video Circuit stages are available on the Effects page only. Projects are not saved between visits, because browsers can't keep the video files.

## Analog video effects

Three effect cards model the hardware instead of imitating the look:

- **NTSC:** each scanline becomes a real composite signal sampled at four times the 3.58 MHz colour subcarrier. Colour is quadrature-modulated onto it, noise and ghosts are added to the signal, and a decoder (notch filter, comb filter, no filter, or S-Video) pulls luma and chroma apart again. Dot crawl, rainbow cross-colour and colour bleed come out of that math. Controls: luma and chroma bandwidth in MHz, colour, tint (phase error), cross-colour, ringing, dot crawl, snow, ghosting and ghost delay in microseconds, hue jitter, hum bar, 480 or 240 lines.
- **VHS:** 3 MHz luma and 0.4 MHz colour-under chroma (both adjustable), chroma delay and vertical smear, the sharpness circuit's edge halos, luma and chroma noise, time-base jitter, wobble, top flagging, a tracking-error band you can position and roll, head-switching noise at the bottom, dropouts, tape speed (SP / LP / EP), copy generations, and a PLAY or REC on-screen display.
- **CRT:** works in linear light. A Gaussian beam that widens with brightness draws the scanlines; aperture grille, slot mask or shadow mask phosphors; curvature, corner radius, overscan, convergence error, halation, phosphor persistence, flicker, interlace, V-hold roll, hum bar, glass glare and colour temperature.

For the full chain, grade with Global Effects, run NTSC or VHS, render, then run the result through CRT.

## Video Circuit (in Global Effects)

A patchable chain of up to 6 analog stages, applied along every scanline after the global adjustments and before the effect. Time is real: one visible line is 52.6 µs, so component values set real time constants, and results do not change with render resolution. Each stage shows a readout (cutoff, resonant frequency and Q, diode forward voltage, and so on), can be patched into luma, RGB or chroma, has a wet/dry mix, and every slider supports +EQ.

| Stage | Model |
| --- | --- |
| RC low-pass | R and C set the cutoff; exponential impulse response (smear to the right) |
| CR high-pass | AC coupling capacitor; flat areas sag to the bias level |
| RLC resonator | L, C, R set resonant frequency and Q; damped-sinusoid ringing, or two exponentials when overdamped |
| Delay line + feedback | Echo train; negative feedback gives a comb filter |
| Diode clipper | Shockley diode equation solved with Newton's method; 1N4148, 1N34A or red LED; symmetric or single diode |
| Transistor pair | tanh transfer of a differential pair, optional inversion |
| Rectifier / wavefolder | Folds signal that passes the rails |
| Comparator | Hard key at a threshold |
| Oscillator + multiplier | Free-running oscillator (in multiples of the 15.734 kHz line rate) ring-modulating, amplitude-modulating or mixing with the signal |

Presets: Worn coax run, Ringing edges, Crispener, Overdriven amp, Video synth, Chroma comb, Hard key.

## Scribble controls

All three share: three colors and how they're used (cycle, first only, random); **Boil**, how many times a second the marks are redrawn (8 to 12 gives a hand-animated stop-motion look, 0 is smooth); **Hand Wobble**; **Motion Speed** (flowing, rotating or crawling marks); background (original, paper color, dimmed, black); body look (original, posterized, cool contrast, duotone); and whether the marks sit behind the body or over everything. Each style adds its own: stroke count, spacing, width, fill and dry brush for Thick; number, spread, length, width and double strokes for Lines; shape, number, loop size and length for Swirls.

Body masks come from MediaPipe's selfie segmenter (about 250 KB, downloaded the first time a Scribble effect is opened).

## Tracking effects

Multi-Eye Multi-Mouth and Lines & Measurements use [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/guide) (face, hand and pose landmarkers). The library lives in `vendor/mediapipe`; the models (about 17 MB total) download from Google's model host the first time you open one of these effects, then the browser caches them. Tracking runs on the device, and your video is never uploaded. Per Google's privacy notice, the library does send anonymous performance metrics to Google; the app tells users this next to those effects.

Tracking is budgeted per frame: on a fast GPU all models run every frame; on slower machines they take turns, so points update a little less often instead of the render dropping frames. Global Effects flip and zoom are applied to the tracked points so overlays stay aligned.

## Audio reactivity

If the video has an audio track, flip on **Audio reactivity**. The soundtrack is split into 8 sources:

Sub (20-60 Hz), Bass (60-250 Hz), Low Mid (250-500 Hz), Mid (500 Hz-2 kHz), High Mid (2-4 kHz), Presence (4-6 kHz), Air (6-16 kHz), and Bass Hit (a kick/transient trigger).

Every slider has a **+EQ** button: pick a band and a depth (negative depth inverts it). A cyan tick on the slider shows the live modulated value. Auto gain adapts each band to the song's loudness; Range and Smoothing tune how jumpy it feels. Each effect ships with sensible default links so it reacts as soon as you turn audio on.

## Rendering

Rendering plays the video once in real time while recording the canvas plus the original audio. A 2 minute video takes about 2 minutes. Keep the tab visible while it renders (browsers throttle background tabs). You can move sliders during a render and the changes are recorded, which works well for "performing" a take.

Output is MP4 where the browser can record it (Chrome 126+, Edge, Safari) and WebM otherwise (Firefox). Choose resolution, quality and whether to render the full video or just the preview window.

## Host it on GitHub Pages

1. Create a new repository on GitHub (for example `moshpit`).
2. Upload the contents of this folder to the repository root (`index.html` must be at the top level).
3. In the repository go to **Settings > Pages**, set **Source** to "Deploy from a branch", branch `main`, folder `/ (root)`, and save.
4. After a minute the site is live at `https://YOUR-USERNAME.github.io/moshpit/`.

Or from a terminal:

```bash
cd moshpit
git init && git add . && git commit -m "Ruckus & Reason Video Portal"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/moshpit.git
git push -u origin main
```

## Run locally

The app uses ES modules, so open it through a local server rather than double-clicking the file:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Project layout

```
index.html          Effects tool
cut.html            Beat Cut tool
css/cut.css         Beat Cut styles
js/cut/main.js      Beat Cut: clips, clock, compositing, timeline, export
js/cut/beat.js      Tempo and beat-phase detection, tap tempo
js/cut/schedule.js  Seeded cut-list generator
slice.html          Slice Pause tool
js/slice/main.js    Slice Pause: pauses, freeze shader, timeline, export
css/slice.css       Slice Pause styles
css/style.css       Styles
js/global.js        Global Effects grading stage
js/circuit.js       Video Circuit stages (component math, shader, presets)
js/detect.js        Shared MediaPipe face/hand/pose tracker and body segmenter
layers.html         Layers tool
js/layers/main.js   Layers: media, players, timeline editing, per-layer views, compositing, export
css/layers.css      Layers styles
js/mobile.js        Phone helpers (iOS playback rules, wake lock, audio session)
vendor/mediapipe/   MediaPipe Tasks Vision 1.2.2 (Apache-2.0)
js/main.js          App wiring: upload, playback loop, gallery, params, export
js/gl.js            WebGL2 core: shaders, render targets, ping-pong buffers, shared GLSL
js/audio.js         Web Audio analysis, EQ bands, transient detection
js/export.js        MediaRecorder format picking, bitrates, download
js/effects/*.js     One file per effect
js/effects/index.js Effect registry
```

## Adding an effect

Create `js/effects/myEffect.js`:

```js
import { BaseFX, FS_IO } from '../gl.js';

const FS = FS_IO + `
uniform sampler2D uSrc;
uniform float uAmount;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  outColor = vec4(mix(c, 1.0 - c, uAmount), 1.0);
}`;

class MyFX extends BaseFX {
  constructor(r) { super(r); this.prog = r.fx(FS); }
  render(p, ctx, target) {
    this.r.pass(this.prog, target, { uAmount: p.amount }, { uSrc: this.r.cur });
  }
}

export default {
  id: 'invert',
  name: 'Invert',
  description: 'Flips the colors.',
  swatch: ['#111111', '#ffffff'],
  params: [
    { id: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, value: 1, mod: { band: 'bass', depth: 0.5 } },
  ],
  create: r => new MyFX(r),
};
```

Then add it to the array in `js/effects/index.js`. It appears in the gallery with sliders, EQ linking and export automatically.

Useful pieces available to every shader: `uRes`, `uTime` (video time), `uFrame`, `uScale` (render height / 720, for resolution-independent pixel sizes), and helpers `luma`, `hash11`, `hash12`, `hash22`, `noise`, `hueShift`, `rgb2hsv`, `hsv2rgb`. For effects that need the previous frame, use `r.prev`, and use `this.pp(...)` plus `this.present(...)` for feedback buffers (see `feedback.js`). Optical flow is available via `FLOW_GLSL`.

## On phones (iPhone and Android)

- iPhone only allows sound when playback starts from a tap, so a clip may start muted with a **Tap for sound** button; any tap turns sound on. Renders always include the audio.
- When a render finishes on iPhone, tap **Save video** to open the share sheet (Save Video puts it in Photos), or **Download** to save it to Files. Desktop browsers still download automatically.
- The screen is kept awake while rendering (where the browser supports it). Keep Safari in the foreground until it finishes.
- Previews run at lower resolution on phones to stay smooth; renders use the resolution you pick. 720p is the safest choice on older phones.
- Beat detection on a phone is limited to files up to about 250 MB (it decodes the whole soundtrack into memory). For bigger clips, tap the tempo or use a song file.
- Audio plays even with the silent switch on (iOS 16.4 and later).

## Browser support

Recent Chrome, Edge, Firefox and Safari (WebGL2 and MediaRecorder required). Very large source files (4K) work but preview more smoothly on a dedicated GPU. Formats the browser cannot decode (some HEVC iPhone clips in Chrome or Firefox) will show an error; re-export those as H.264 first.
