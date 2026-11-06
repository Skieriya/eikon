// recorder.html's brain: webcam -> MediaPipe -> canonical signals -> this model's
// own parameters, sampled at a fixed 30 fps and written out as an ordinary
// .motion3.json.
//
// Two rules shape everything below.
//
// 1. What you see is what you save. The take records the model's real parameter
//    values, not the camera's guesses, and preview plays the file back through the
//    SDK's own CubismMotion - so the preview IS the saved clip, fades included.
// 2. Nothing here is required to succeed, and nothing needs asking. Stopping a
//    take writes it into the model's own folder by itself; no camera, no
//    permission or no wasm only costs you the tracking, never the page.

import { CubismFramework, Option, LogLevel } from '../framework/dist/live2dcubismframework.js';
import { CubismWebGLOffscreenManager } from '../framework/dist/rendering/cubismoffscreenmanager.js';
import { CubismMatrix44 } from '../framework/dist/math/cubismmatrix44.js';
import { CubismMotion } from '../framework/dist/motion/cubismmotion.js';
import { loadModel } from '../live2d/loadModel.js';
import { createParamLookup } from '../live2d/paramNames.js';
import { asMotionRefs, downloadJson, listRecorded, saveRecorded } from '../live2d/recorded.js';
import { DEFAULT_MODEL, MODELS, resolveModel } from '../models/manifest.js';
import { createTracker, loadFaceModel, simulateSignals } from './tracker.js';
import { DEFAULT_TUNING, TUNE_KEYS, describe, pickPreset, targets } from './mapping.js';
import { FPS, encodeMotion, readMotion, safeName } from './motion3.js';

const MAX_TAKE_SECONDS = 60;   // a minute of curves is already a large JSON
const $ = (id) => document.getElementById(id);

const el = {
  canvas: $('glcanvas'), video: $('cam'), overlay: $('overlay'), camBox: $('camBox'),
  loader: $('loader'), loadText: $('loadText'), loadError: $('loadError'),
  status: $('status'), camState: $('camState'),
  name: $('takeName'), loopChk: $('loopChk'), mirrorChk: $('mirrorChk'),
  record: $('recordBtn'), preview: $('previewBtn'), down: $('downloadBtn'),
  takeTime: $('takeTime'), takeInfo: $('takeInfo'),
  meters: $('meters'), tuning: $('tuning'), clips: $('clips'), modelSelect: $('modelSelect'),
  simulate: $('simulateChk'),
};

// ---------------------------------------------------------------- model state
let gl, chosen, handles, model, renderer, physics, motionManager;
let ranges, preset, curves;
let motionCache = new Map();          // clip file -> { name, motion }
const tuning = loadTuning();

// Live per-frame state, all read by the loop and the debug hook.
const state = {
  signals: null, driven: [], fit: null, lastTime: 0, simTime: 0,
  simulate: false, tracking: false,
  recording: false, recStart: 0, sampleSlot: 0,
  paused: false,                     // a clip is playing; the camera is ignored
  pending: null,                     // { json, motion, info } of the last take
  loopErrors: 0,
  error: '',
};

function loadTuning() {
  try {
    const saved = JSON.parse(localStorage.getItem('eikon.recorder.tuning') || 'null');
    if (saved && saved.gain && saved.invert) return Object.assign(DEFAULT_TUNING(), saved);
  } catch (_) {}
  return DEFAULT_TUNING();
}
const saveTuning = () => localStorage.setItem('eikon.recorder.tuning', JSON.stringify(tuning));

// --------------------------------------------------------------- bring-up
async function boot() {
  const option = new Option();
  option.logFunction = (m) => console.log('[Cubism]', m);
  option.loggingLevel = LogLevel.LogLevel_Errors;
  CubismFramework.startUp(option);
  CubismFramework.initialize();

  const canvas = el.canvas;
  const attrs = { antialias: true, alpha: true, premultipliedAlpha: true };
  gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
  if (!gl) return fail('WebGL is not available in this browser.');

  buildModelSelect();
  await loadChosenModel();
  camera().catch((err) => console.warn('[REC] camera setup failed', err));
}

function buildModelSelect() {
  const wanted = new URLSearchParams(location.search).get('model') || DEFAULT_MODEL;
  for (const id of Object.keys(MODELS)) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = MODELS[id].label;
    el.modelSelect.appendChild(o);
  }
  el.modelSelect.value = resolveModel(wanted).id;
  el.modelSelect.addEventListener('change', async () => {
    el.modelSelect.disabled = true;
    await loadChosenModel();
    el.modelSelect.disabled = false;
  });
}

/**
 * Load the selected rig plus every take already saved for it, so the clip list and
 * the preview run on the same code path the demo page will use tomorrow.
 */
async function loadChosenModel() {
  chosen = resolveModel(el.modelSelect.value || DEFAULT_MODEL);
  setStatus('Loading ' + chosen.label + '...');
  // Stop the old take and the old camera-driven values before unloading anything.
  state.recording = false; state.pending = null; state.paused = false;
  el.record.textContent = 'Record'; el.record.classList.remove('stop');
  syncButtons();

  const clips = await listRecorded(chosen.model3);
  handles = await loadModel({
    model3Url: chosen.model3,
    gl,
    expressions: chosen.expressions || [],
    motions: asMotionRefs(clips),
    onProgress: (t) => setStatus(t),
    onLog: (m) => console.log(m),
  });
  ({ model, renderer, physics, motionManager } = handles);

  const lookup = createParamLookup(model);
  // Resolve the preset against this rig once, straight from the .moc3: every range
  // and parameter index a take can ever use comes from here, so a curve whose id
  // this rig does not have is dropped at load and reported - never half-written
  // into the clip.
  preset = pickPreset((name) => !!lookup.find(name));
  ranges = {};
  let skipped = 0;
  for (const c of preset.curves) {
    const l = lookup.find(c.id);
    if (!l) { skipped++; continue; }
    ranges[c.id] = {
      min: model.getParameterMinimumValue(l.index),
      max: model.getParameterMaximumValue(l.index),
      def: model.getParameterDefaultValue(l.index),
      index: l.index,
    };
  }
  curves = describe(preset, ranges);

  motionCache = new Map();
  for (const clip of handles.motionClips || []) motionCache.set(clip.file, clip);

  model.update();
  state.fit = measureFit(model);
  buildMeters();
  buildTuning();
  renderClips();
  el.simulate.checked = state.simulate || new URLSearchParams(location.search).has('simulate');

  el.loader.classList.add('hidden');
  state.lastTime = performance.now();
  requestAnimationFrame(loop);
  setStatus('Loaded ' + chosen.label + ' - ' + curves.length + ' parameters mapped from the camera, '
    + clips.length + ' saved take(s).' + (skipped ? ' ' + skipped + ' preset curve(s) are not on this rig.' : ''));
  // The face model is 14 MB of wasm and the rig is already on screen: warm it up
  // in the background so the first camera frame is not the slow one.
  if (!trackerPromise) trackerPromise = loadFaceModel({
    wasmPath: './recorder/vendor/mediapipe/wasm',
    modelPath: './recorder/vendor/models/face_landmarker.task',
  });
}

// Art bounds -> clip [-1,1], the same fit the demo page uses, measured once so the
// hat never gets cut off.
function measureFit(m) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0, n = m.getDrawableCount(); i < n; i++) {
    if (!m.getDrawableDynamicFlagIsVisible(i) || m.getDrawableOpacity(i) <= 0) continue;
    const ps = m.getDrawableVertexPositions(i);
    if (!ps) continue;
    for (let j = 0; j < ps.length; j += 2) {
      if (!Number.isFinite(ps[j]) || !Number.isFinite(ps[j + 1])) continue;
      if (ps[j] < minX) minX = ps[j];
      if (ps[j] > maxX) maxX = ps[j];
      if (ps[j + 1] < minY) minY = ps[j + 1];
      if (ps[j + 1] > maxY) maxY = ps[j + 1];
    }
  }
  if (!Number.isFinite(minY)) return { bh: m.getCanvasHeight(), cy: 0 };
  return { bh: maxY - minY, cy: (minY + maxY) / 2 };
}

function setStatus(msg) {
  el.loadText.textContent = msg;
  el.status.textContent = msg;
  console.log('[REC]', msg);
}
function fail(msg) {
  state.error = msg;
  el.loadError.textContent = msg;
  el.loadError.style.display = 'block';
  el.loader.classList.remove('hidden');
  console.error('[REC]', msg);
}

// ---------------------------------------------------------------- camera
let faceLandmarker = null, trackerPromise = null, tracker = null;

async function camera() {
  setCamState('Starting camera...');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setCamState('This browser cannot open a camera (needs HTTPS or localhost).');
    el.simulate.checked = true;
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
  } catch (err) {
    setCamState('No camera (' + (err && err.name) + '). Use simulate mode, or allow the camera and reload.');
    el.simulate.checked = true;
    return;
  }
  el.video.srcObject = stream;
  el.video.muted = true;
  await el.video.play().catch(() => {});

  if (!faceLandmarker) {
    setCamState('Camera on - loading the face model (14 MB, first time only)...');
    try {
      faceLandmarker = await trackerPromise;
    } catch (err) {
      setCamState('Face model failed to load: ' + (err && err.message));
      el.simulate.checked = true;
      return;
    }
  }
  tracker = createTracker(faceLandmarker);
  state.tracking = true;
  el.video.classList.add('live');
  setCamState('Tracking. Set your neutral pose before recording.');
}

el.simulate.addEventListener('change', () => {
  state.simulate = el.simulate.checked;
  setCamState(state.simulate
    ? 'Simulate mode: a scripted performance stands in for the camera.'
    : (state.tracking ? 'Tracking your face.' : 'Camera not ready yet.'));
});

el.mirrorChk.addEventListener('change', () => el.camBox.classList.toggle('mirror', el.mirrorChk.checked));

function setCamState(msg) { el.camState.textContent = msg; }

// ---------------------------------------------------------------- loop
// Without a live tracker the scripted performance keeps driving her, so the page is
// never a still image: it is what you use to try the mapping, and what CI can run.
function readSignals(dt) {
  if (state.simulate || !state.tracking) {
    state.simTime += dt;
    return simulateSignals(state.simTime);
  }
  if (!el.video.videoWidth) return state.signals || null;
  return tracker.detect(el.video, performance.now());
}

function loop(now) {
  requestAnimationFrame(loop);
  if (!model || !renderer) return;
  try {
    const dt = Math.min((now - state.lastTime) / 1000, 1 / 20);
    state.lastTime = now;

    const s = readSignals(dt);
    state.signals = s;
    state.driven = [];

    model.loadParameters();
    model.saveParameters();

    if (state.paused && !motionManager.isFinished()) {
      // A take is playing back: the file drives her, the camera does not.
      motionManager.updateMotion(model, dt);
    } else {
      if (state.paused) { state.paused = false; syncButtons(); }
      if (s) {
        state.driven = targets(s, preset, ranges, tuning);
        for (const t of state.driven) model.setParameterValueByIndex(ranges[t.id].index, t.value);
      }
    }
    if (physics) physics.evaluate(model, dt);
    if (state.recording) sampleTake();
    model.update();

    sizeCanvas();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const offscreen = CubismWebGLOffscreenManager.getInstance();
    offscreen.beginFrameProcess(gl);
    const { bh, cy } = state.fit;
    const sy = (2.0 / bh) * 0.92;
    const sx = sy * (canvasSize().h / canvasSize().w);
    const proj = new CubismMatrix44();
    proj.setMatrix(new Float32Array([
      sx, 0, 0, 0,
      0, sy, 0, 0,
      0, 0, 1, 0,
      0, -cy * sy, 0, 1,
    ]));
    renderer.setMvpMatrix(proj);
    renderer.setRenderState(null, [0, 0, el.canvas.width, el.canvas.height]);
    renderer.drawModel('./framework/shaders/');
    offscreen.endFrameProcess(gl);

    drawOverlay();
    updateMeters();
    if (state.recording) {
      const t = (performance.now() - state.recStart) / 1000;
      el.takeTime.textContent = t.toFixed(1) + 's / ' + MAX_TAKE_SECONDS + 's';
      if (t >= MAX_TAKE_SECONDS) { stopTake(); setStatus('Take hit the ' + MAX_TAKE_SECONDS + 's limit and stopped.'); }
    }
  } catch (err) {
    state.loopErrors++;
    // One console line per bad frame is how a frozen model goes unnoticed: say it
    // on the page, once, and keep the counter for the debug hook.
    if (state.loopErrors === 1) {
      setStatus('The render loop stopped updating: ' + (err && err.message) + ' (see console).');
      console.error('[REC] loop error', err);
    }
  }
}

function canvasSize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(el.canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(el.canvas.clientHeight * dpr));
  return { w, h };
}
function sizeCanvas() {
  const { w, h } = canvasSize();
  if (el.canvas.width !== w) el.canvas.width = w;
  if (el.canvas.height !== h) el.canvas.height = h;
}

// Landmarks on top of the preview, so a lost face is obvious instead of silent.
function drawOverlay() {
  const pts = (!state.simulate && state.tracking && tracker) ? tracker.landmarks() : null;
  const box = el.overlay.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(box.width * dpr));
  const h = Math.max(1, Math.floor(box.height * dpr));
  if (el.overlay.width !== w || el.overlay.height !== h) { el.overlay.width = w; el.overlay.height = h; }
  const ctx = el.overlay.getContext('2d');
  ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
  if (!pts) return;
  ctx.fillStyle = state.signals && state.signals.present ? 'rgba(74, 222, 128, 0.85)' : 'rgba(248, 113, 113, 0.85)';
  for (let i = 0; i < pts.length; i++) {
    ctx.fillRect(pts[i].x * el.overlay.width - 1, pts[i].y * el.overlay.height - 1, 2, 2);
  }
}

// ---------------------------------------------------------------- recording
let tracks = null;   // id -> number[]

function startTake() {
  tracks = {};
  for (const c of curves) tracks[c.id] = [];
  state.sampleSlot = 0;
  state.recStart = performance.now();
  state.recording = true;
  state.pending = null;
  state.paused = false;
  el.record.textContent = 'Stop';
  el.record.classList.add('stop');
  el.takeInfo.textContent = '';
  el.takeTime.classList.add('hot');
  setStatus('Recording at ' + FPS + ' fps - perform now.');
  syncButtons();
}

// Sampling is on a fixed grid rather than per animation frame: a clip's curve times
// only mean something at a known rate, and a dropped frame must widen a segment,
// not shift every segment after it.
function sampleTake() {
  const elapsed = (performance.now() - state.recStart) / 1000;
  while (state.sampleSlot / FPS <= elapsed && state.sampleSlot <= MAX_TAKE_SECONDS * FPS) {
    for (const id in tracks) {
      // The model's own value, so whatever she actually held is what is saved.
      tracks[id].push(round4(model.getParameterValueByIndex(ranges[id].index)));
    }
    state.sampleSlot++;
  }
}

const round4 = (v) => Math.round(v * 1e4) / 1e4;

async function stopTake() {
  state.recording = false;
  el.record.textContent = 'Record';
  el.record.classList.remove('stop');
  el.takeTime.classList.remove('hot');
  el.takeTime.textContent = '';
  const list = [];
  for (const c of curves) if (tracks && tracks[c.id] && tracks[c.id].length > 1) list.push({ id: c.id, values: tracks[c.id] });
  tracks = null;
  if (list.length < 1) {
    setStatus('Nothing was recorded - the face was never seen (or simulate mode was off).');
    syncButtons();
    return;
  }
  let json;
  try {
    json = encodeMotion(list, { fps: FPS, loop: !!el.loopChk.checked });
  } catch (err) {
    setStatus('Could not encode: ' + err.message);
    syncButtons();
    return;
  }
  // Read it back before trusting it: this is the number the demo page will see.
  const back = readMotion(json);
  let motion = null;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(json));
    motion = CubismMotion.create(bytes.buffer, bytes.byteLength);
    // A hand-made motion has no one else to initialise these, and the SDK reads
    // them unconditionally on the first frame - null throws inside updateMotion.
    motion.setEffectIds([], []);
    motion.setFadeInTime(0.35);
    motion.setFadeOutTime(0.35);
  } catch (err) {
    console.error('[REC] SDK rejected the encoded clip', err);
  }
  state.pending = {
    json,
    motion,
    info: back.duration.toFixed(2) + 's, ' + back.curves.length + ' curves'
      + (motion ? ' - SDK parsed it (' + motion.getDuration().toFixed(2) + 's)' : ' - SDK parse FAILED'),
  };
  el.takeInfo.textContent = state.pending.info;
  syncButtons();
  if (!motion) {
    setStatus('Take encoded, but the SDK could not play it - check the console.');
    return;
  }
  // Saving is not a step the user has to remember to ask for: stopping a take
  // writes it. The folder is the deliverable, not a save dialog.
  await saveTake();
}

function previewTake() {
  if (!state.pending || !state.pending.motion) return;
  motionManager.startMotionPriority(state.pending.motion, false, 2);
  state.paused = true;
  setStatus('Previewing the saved file exactly as the demo will play it.');
}

/** Play a clip from disk (or the one just saved) through the same manager. */
function playClip(file) {
  const clip = motionCache.get(file);
  if (!clip || !clip.motion) { setStatus('That take is not loaded - reload the page.'); return false; }
  motionManager.startMotionPriority(clip.motion, false, 2);
  state.paused = true;
  setStatus('Playing "' + clip.name + '".');
  return true;
}

// The take names itself: what is typed in the box, or take_01, take_02... over
// what is already loaded. A name that is already taken gains a suffix instead of
// quietly replacing someone's earlier performance.
function takeName() {
  const taken = new Set(motionListFromCache().map((c) => c.name));
  const typed = safeName(el.name.value, '');
  if (!typed) {
    let n = 1;
    while (taken.has('take_' + pad(n))) n++;
    return 'take_' + pad(n);
  }
  let name = typed;
  for (let n = 2; taken.has(name); n++) name = typed + '_' + n;
  return name;
}
const pad = (n) => String(n).padStart(2, '0');

async function saveTake() {
  if (!state.pending) return;
  const name = takeName();
  const r = await saveRecorded({ model3Url: chosen.model3, name, motion: state.pending.json, loop: !!el.loopChk.checked });
  if (!r.ok) {
    // A static server has no route that can write files. Say so and offer the
    // file, rather than pretending the take is lost.
    el.down.hidden = false;
    el.down.disabled = false;
    setStatus('Recorded, but nothing could write it automatically: ' + r.error
      + ' - start the project with "python serve.py" and record again, or use Download.');
    return;
  }
  motionCache.set(r.file, { file: r.file, name, motion: state.pending.motion });
  if (r.clips) renderClips(r.clips);
  const key = Array.from(motionCache.keys()).indexOf(r.file) + 1;
  setStatus('Saved automatically → ' + r.path + '. Play it here with ' + key
    + ', or in the demo (index.html?model=' + chosen.id + ') with p.');
}

el.record.addEventListener('click', () => { state.recording ? stopTake() : startTake(); });
el.preview.addEventListener('click', previewTake);
el.down.addEventListener('click', () => {
  if (!state.pending) return;
  downloadJson(state.pending.json, takeName() + '.motion3.json');
  setStatus('Downloaded. Drop it in models/<folder>/motions/recorded/ and reload.');
});
el.name.addEventListener('input', syncButtons);

function syncButtons() {
  const has = !!state.pending;
  el.preview.disabled = !has;
  el.down.hidden = true;
  el.down.disabled = true;
  el.record.disabled = !curves || !curves.length;
}

// ---------------------------------------------------------------- panels

// The camera's own numbers, not the model's: this is the panel that tells you
// whether the tracking is the problem or the mapping is.
const METERS = [
  { label: 'Head turn', get: (s) => (s.head.turn - tuning.neutral.turn) / 40, dir: 'both' },
  { label: 'Head nod', get: (s) => (s.head.nod - tuning.neutral.nod) / 30, dir: 'both' },
  { label: 'Head tilt', get: (s) => (s.head.tilt - tuning.neutral.tilt) / 30, dir: 'both' },
  { label: 'Gaze left/right', get: (s) => s.gaze.x, dir: 'both' },
  { label: 'Gaze up/down', get: (s) => s.gaze.y, dir: 'both' },
  { label: 'Blink', get: (s) => (s.eyes.blinkL + s.eyes.blinkR) / 2, dir: 'up' },
  { label: 'Brow up', get: (s) => (s.brows.upL + s.brows.upR) / 2, dir: 'up' },
  { label: 'Brow inner', get: (s) => s.brows.innerUp, dir: 'up' },
  { label: 'Smile', get: (s) => s.mouth.smile, dir: 'up' },
  { label: 'Mouth open', get: (s) => s.mouth.open, dir: 'up' },
  { label: 'Mouth wide', get: (s) => s.mouth.x, dir: 'both' },
  { label: 'Cheek/squint', get: (s) => (s.mouth.cheek + s.eyes.squintL + s.eyes.squintR) / 3, dir: 'up' },
];
const meterRows = [];

function buildMeters() {
  el.meters.textContent = '';
  meterRows.length = 0;
  for (const m of METERS) {
    const row = document.createElement('div');
    row.className = 'meter';
    const label = document.createElement('span');
    label.textContent = m.label;
    const bar = document.createElement('i');
    const num = document.createElement('b');
    row.append(label, bar, num);
    el.meters.appendChild(row);
    meterRows.push({ m, bar, num });
  }
}

function updateMeters() {
  const s = state.signals;
  for (const r of meterRows) {
    r.bar.dataset.dir = r.m.dir;
    if (!s || !s.present) {
      r.bar.style.setProperty('--a', '0%'); r.bar.style.setProperty('--w', '0%');
      r.num.textContent = s && s.present ? '' : 'no face';
      continue;
    }
    const v = r.m.get(s);
    if (r.m.dir === 'both') {
      const k = Math.max(-1, Math.min(1, v));
      r.bar.style.setProperty('--a', (k >= 0 ? 50 : 50 + k * 50) + '%');
      r.bar.style.setProperty('--w', (Math.abs(k) * 50) + '%');
    } else {
      const k = Math.max(0, Math.min(1, v));
      r.bar.style.setProperty('--a', '0%');
      r.bar.style.setProperty('--w', (k * 100) + '%');
    }
    r.num.textContent = v.toFixed(2);
  }
}

function buildTuning() {
  el.tuning.textContent = '';
  for (const t of TUNE_KEYS) {
    const row = document.createElement('div');
    row.className = 'tune';
    const label = document.createElement('label');
    label.textContent = t.label;
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '0.2'; slider.max = '2'; slider.step = '0.05';
    slider.value = String(tuning.gain[t.key] ?? 1);
    slider.addEventListener('input', () => { tuning.gain[t.key] = Number(slider.value); saveTuning(); });
    const flip = document.createElement('button');
    flip.type = 'button';
    flip.textContent = 'flip';
    flip.className = tuning.invert[t.key] ? 'on' : '';
    flip.addEventListener('click', () => {
      tuning.invert[t.key] = !tuning.invert[t.key];
      flip.className = tuning.invert[t.key] ? 'on' : '';
      saveTuning();
    });
    row.append(label, slider, flip);
    el.tuning.appendChild(row);
  }

  const neutral = document.createElement('button');
  neutral.type = 'button';
  neutral.className = 'wide';
  neutral.textContent = 'Set neutral pose (n)';
  neutral.title = 'Look straight at the camera, sit back, and press this: your resting head angle is subtracted from every take.';
  neutral.addEventListener('click', setNeutral);

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'wide ghost';
  reset.textContent = 'Reset tuning';
  reset.addEventListener('click', () => {
    Object.assign(tuning, DEFAULT_TUNING());
    saveTuning();
    buildTuning();
    setStatus('Tuning reset.');
  });
  el.tuning.append(neutral, reset);
}

function setNeutral() {
  const s = state.signals;
  if (!s || !s.present) { setStatus('No face to take a neutral from - get in frame first.'); return; }
  tuning.neutral.turn = s.head.turn;
  tuning.neutral.nod = s.head.nod;
  tuning.neutral.tilt = s.head.tilt;
  saveTuning();
  setStatus('Neutral set: turn ' + s.head.turn.toFixed(1) + '°, nod ' + s.head.nod.toFixed(1)
    + '°, tilt ' + s.head.tilt.toFixed(1) + '°.');
}

function renderClips(clips) {
  const list = clips || asMotionRefs(motionListFromCache());
  el.clips.textContent = '';
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No takes saved for this model yet.';
    el.clips.appendChild(p);
    return;
  }
  list.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = (i < 9 ? (i + 1) + '  ' : '') + c.name;
    b.title = c.file;
    b.disabled = !motionCache.has(c.file);
    b.addEventListener('click', () => playClip(c.file));
    el.clips.appendChild(b);
  });
}

// The playable set is what loadModel() built; keep the list in step with it.
function motionListFromCache() {
  return Array.from(motionCache.values()).map((c) => ({ name: c.name || c.file, file: c.file }));
}

// ---------------------------------------------------------------- keys
window.addEventListener('keydown', (e) => {
  if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'r') { state.recording ? stopTake() : startTake(); }
  else if (k === ' ') { if (state.pending) previewTake(); e.preventDefault(); }
  else if (k === 'n') setNeutral();
  else if (k >= '1' && k <= '9') {
    const file = Array.from(motionCache.keys())[Number(k) - 1];
    if (file) playClip(file);
  }
});

// Test hook: run the whole page without a webcam, frame by frame.
window.__recorderDebug = {
  get gl() { return gl; }, get model() { return model; }, frame: loop,
  get motionManager() { return motionManager; },
  get state() { return state; }, get signals() { return state.signals; },
  get driven() { return state.driven; }, get presetId() { return preset && preset.id; },
  get curves() { return curves; }, get ranges() { return ranges; },
  get tuning() { return tuning; }, get clips() { return Array.from(motionCache.keys()); },
  get pending() { return state.pending; }, get error() { return state.error; },
  setSimulate(on) { el.simulate.checked = !!on; state.simulate = !!on; },
  // Pump the loop from outside, as far past the 60s take limit as asked: a
  // wall-clock wait cannot advance a page whose frames are being driven by hand.
  async recordFor(seconds) {
    startTake();
    let now = performance.now();
    for (let f = 0; f < Math.ceil(seconds * 60); f++) { now += 1000 / 60; await loop(now); }
    await stopTake();
    return { slot: state.sampleSlot, status: el.status.textContent };
  },
  start: startTake, stop: stopTake, preview: previewTake, save: saveTake, playClip,
  setNeutral,
};

boot();
