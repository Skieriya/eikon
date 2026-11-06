// Hu Tao's own document. This is the demo page's bring-up and render loop, with
// the page-specific parts taken out (drag, press squash, recorded takes, the demo
// markup) and three extension-specific parts added:
//
//   - she is placed by her own model matrix instead of filling the frame, because
//     her canvas is the whole viewport: the gaze is a viewport-space map, so aiming
//     at clip -1..1 still points at the right place on the page wherever she
//     stands. The same canvas also carries the ring that marks the target, which
//     has to be able to light up anywhere.
//   - where she stands and how tall she is are yours (drag her, drag her corner),
//     and she reports that box to the page, which is what makes a press on her
//     hit her instead of the site underneath.
//   - the gaze is driven from messages instead of a local cursor.
//   - the element she looks at is a proxy that only knows a rect, because the real
//     element lives in another document. gazeController.js and live2dBridge.js are
//     used exactly as they are — no second implementation of the glide.

import { CubismFramework, Option, LogLevel } from './framework/dist/live2dcubismframework.js';
import { CubismWebGLOffscreenManager } from './framework/dist/rendering/cubismoffscreenmanager.js';
import { CubismMatrix44 } from './framework/dist/math/cubismmatrix44.js';
import { createLive2dGuideBridge } from './guide/live2dBridge.js';
import { createGazeController } from './guide/gazeController.js';
import { loadModel } from './live2d/loadModel.js';
import { prefetch } from './live2d/assets.js';
import { createPointRig } from './live2d/pointRig.js';
import { detectHeadAnchor } from './live2d/headAnchor.js';
import { loadCompanions } from './live2d/companions.js';
import { resolveModel } from './models/manifest.js';

const Q = new URLSearchParams(location.search);
// ?ghosts=0 drops the two companion models; ?rigcache=0 re-measures the pointing
// sweep instead of reusing the stored one.
const USE_GHOSTS = Q.get('ghosts') !== '0';

// Verification hook: a frame that is not painted never runs requestAnimationFrame
// (a hidden tab, or this app's in-app browser), so ?raf=manual swaps this
// document's rAF for a queue that __hutaoOverlay.pump() drains. Nothing else in
// this file can tell the difference — the tween still gets real timestamps.
let manualFrames = null;
if (Q.get('raf') === 'manual') {
  manualFrames = [];
  window.requestAnimationFrame = (cb) => { manualFrames.push(cb); return manualFrames.length; };
  window.cancelAnimationFrame = () => {};
}

const stage = document.getElementById('stage');
const ringCv = document.getElementById('ring');
const ringCtx = ringCv.getContext('2d');
const captionEl = document.getElementById('caption');

const glAttrs = { antialias: true, alpha: true, premultipliedAlpha: true };
const gl = stage.getContext('webgl', glAttrs) || stage.getContext('experimental-webgl', glAttrs);

// The DPR the demo can afford at full screen is too much for a layer that sits on
// top of someone else's page and must not slow it down.
const DPR_CAP = 1.5;
const dpr = () => Math.min(window.devicePixelRatio || 1, DPR_CAP);
let fit = null, model = null, renderer = null, hostMvp = null;
let pointRig = null, companions = null, headAnchor = null;
let eyeBlink = null, breath = null, physics = null, motionManager = null, motionGroups = null;
let expressionManager = null, expressionList = [], activeExpression = null, exprTimer = 2.0;
let lastTime = 0, ready = false;
let pulse = 0;

// What the page side told us to look at. `rect` is in this document's own CSS
// pixels, which is the same space the canvas is drawn in.
const aim = { held: false, rect: null, pending: false, id: 0, caption: 0 };

// The element she aims at, as far as a proxy can be one: gazeController only ever
// asks for a bounding box and whether it is still there.
const targetProxy = {
  get isConnected() { return !!aim.rect && aim.held; },
  getBoundingClientRect() {
    const r = aim.rect || { l: 0, t: 0, w: 0, h: 0 };
    return { left: r.l, top: r.t, width: r.w, height: r.h, right: r.l + r.w, bottom: r.t + r.h };
  },
};

function resize() {
  const d = dpr();
  const w = Math.max(1, Math.floor(window.innerWidth * d));
  const h = Math.max(1, Math.floor(window.innerHeight * d));
  if (stage.width !== w || stage.height !== h) { stage.width = w; stage.height = h; }
  if (ringCv.width !== w || ringCv.height !== h) { ringCv.width = w; ringCv.height = h; }
  // A narrower window can leave her half off screen; pull her back into it.
  if (fit) clampDock();
}
resize();
window.addEventListener('resize', resize);

// ---- where she stands --------------------------------------------------------
// She is docked by her own model matrix, not by the frame: the canvas is the whole
// viewport because the gaze is a viewport-space map and the ring has to be able to
// light up anywhere. So her place is a box in CSS pixels, and it is yours — press on
// her and drag to move her, pull her bottom-right corner (or spin the wheel over her)
// to resize. Both are stored in this document's own localStorage, which belongs to
// the add-on's origin, so she keeps the spot you left her in when you change site.
const DOCK_MIN_H = 130, DOCK_MAX_H = 640, DOCK_FRAC = 0.30, DOCK_DEFAULT_MAX = 420;
const DOCK_RIGHT = 16, DOCK_BOTTOM = 12;
// A little air between her art and the ring, so a target near the corner is not
// drawn through her.
const HEAD_TOP_DROP = 0.12;
const STORE_KEY = 'dock.v1';
// How many CSS pixels of her corner count as the resize grip. The page side hit-
// tests with it, so it has to travel in the report.
const GRIP = 26;

const dock = { bx: 0, by: 0, h: 0 };
let dockKey = '', saveAt = 0;

const vw = () => Math.max(1, window.innerWidth);
const vh = () => Math.max(1, window.innerHeight);

function defaultDock() {
  return { bx: vw() - DOCK_RIGHT, by: vh() - DOCK_BOTTOM,
    h: Math.min(DOCK_DEFAULT_MAX, Math.max(DOCK_MIN_H, vh() * DOCK_FRAC)) };
}

// Her art, in CSS pixels, at the current height. The declared canvas can under-size
// it (her hat spills past it in the demo), so it is measured from the model.
function artSize() {
  if (!fit) return { w: dock.h, h: dock.h };
  const sy = (dock.h / vh() * 2) / fit.bh;
  const sx = sy * (stage.height / Math.max(1, stage.width));
  return { w: (fit.bw * sx) / 2 * vw(), h: dock.h };
}

// Never more than three quarters of her off screen, so a drag can not lose her.
function clampDock() {
  dock.h = Math.min(Math.max(dock.h, DOCK_MIN_H), Math.min(DOCK_MAX_H, vh() - 24));
  const a = artSize();
  const mx = Math.max(8, a.w * 0.25), my = Math.max(8, dock.h * 0.25);
  const cx = Math.min(Math.max(dock.bx - a.w / 2, mx), vw() - mx);
  const cy = Math.min(Math.max(dock.by - dock.h / 2, my), vh() - my);
  dock.bx = cx + a.w / 2;
  dock.by = cy + dock.h / 2;
}

function artRectCss() {
  const a = artSize();
  return { l: dock.bx - a.w, t: dock.by - a.h, w: a.w, h: a.h };
}

function dockBase() {
  const sy = (dock.h / vh() * 2) / fit.bh;
  const sx = sy * (stage.height / Math.max(1, stage.width));
  const artW = (fit.bw * sx) / 2 * vw();
  const cx = ((dock.bx - artW / 2) / vw()) * 2 - 1;
  const cy = -((dock.by - dock.h / 2) / vh() * 2 - 1);
  return { sx, sy, ox: cx - fit.cx * sx, oy: cy };
}

function loadDock() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (d && [d.bx, d.by, d.h].every(Number.isFinite)) {
      dock.bx = d.bx; dock.by = d.by; dock.h = d.h;
      return true;
    }
  } catch (_) { /* private mode, or a schema change: the default is fine */ }
  return false;
}

function saveDock() {
  if (saveAt) return;
  saveAt = setTimeout(() => {
    saveAt = 0;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(dock)); } catch (_) {}
  }, 300);
}

// Tell the page her box, so it knows where a press counts as grabbing her, and hang
// her caption under whichever side of her has room.
function reportDock() {
  const r = artRectCss();
  const key = Math.round(r.l) + ',' + Math.round(r.t) + ',' + Math.round(r.w) + ',' + Math.round(r.h);
  if (key === dockKey) return;
  dockKey = key;
  tell({ t: 'dock', rect: { l: r.l, t: r.t, w: r.w, h: r.h }, grip: GRIP });
  const below = r.t + r.h + 34 < vh();
  captionEl.style.left = Math.min(Math.max(r.l + r.w / 2, 120), vw() - 120) + 'px';
  captionEl.style.top = (below ? r.t + r.h + 10 : Math.max(8, r.t - 38)) + 'px';
}

// The art's real bounds on both axes: the declared canvas can under-size it (her
// hat spills past it in the demo), and the dock needs the WIDTH to sit her flush
// against the right edge.
function measureBox(m) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0, n = m.getDrawableCount(); i < n; i++) {
    if (!m.getDrawableDynamicFlagIsVisible(i) || m.getDrawableOpacity(i) <= 0) continue;
    const ps = m.getDrawableVertexPositions(i);
    if (!ps) continue;
    for (let j = 0; j < ps.length; j += 2) {
      const x = ps[j], y = ps[j + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) {
    const h = m.getCanvasHeight(), w = m.getCanvasWidth();
    return { bw: w, bh: h, cx: 0, cy: 0 };
  }
  return { bw: maxX - minX, bh: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// ---- messages from the page --------------------------------------------------
// The nonce arrives in this frame's own URL, written by the page's content script
// and unreadable by the site's scripts (it lives in an isolated world). Requiring
// it on every message is what stops a page that guessed the message shape from
// driving her around, or from reading a reply as its own.
const NONCE = Q.get('n') || null;
function allowed(e) {
  const d = e && e.data;
  return !!d && typeof d === 'object' && e.source === window.parent
    && (NONCE === null || d.n === NONCE);
}

function onMessage(e) {
  if (!allowed(e)) return;
  const d = e.data;
  switch (d.t) {
    case 'hold':
      if (!d.on) {
        aim.held = false; aim.rect = null; aim.pending = false; aim.id = 0;
        glide.cancel();
        return;
      }
      aim.held = true;
      if (aim.rect) glideTo(); else aim.pending = true;
      break;
    case 'target':
      if (!d.rect) { aim.rect = null; aim.id = 0; return; }
      aim.rect = d.rect;
      // A new id is a different element, not the same one that moved: only the
      // first of these restarts the glide, the rest just keep the aim honest.
      if (aim.held && (aim.pending || d.id !== aim.id)) {
        aim.pending = false;
        aim.id = d.id;
        glideTo();
      }
      break;
    case 'mouse':
      if (ready) bridge.pointerMove(d.x, d.y);
      break;
    case 'gesture':
      pulse = 1;
      if (startRandomMotion('TapBody')) { /* rigs that ship a guiding clip use it */ }
      break;
    case 'caption':
      showCaption(String(d.text || ''), d.kind);
      break;
    case 'move':
      if (!fit) return;
      dock.bx += Number(d.dx) || 0;
      dock.by += Number(d.dy) || 0;
      clampDock(); saveDock();
      break;
    case 'size':
      // Feet stay put, so she grows up and to the left — the way the corner was
      // pulled. Horizontal pointer motion is ignored on purpose.
      if (!fit) return;
      dock.h -= Number(d.dy) || 0;
      clampDock(); saveDock();
      break;
    case 'dockreset':
      Object.assign(dock, defaultDock());
      clampDock(); saveDock();
      break;
  }
}

function showCaption(text, kind) {
  if (!text) { captionEl.classList.remove('show'); return; }
  captionEl.textContent = text;
  captionEl.classList.toggle('error', kind === 'error');
  captionEl.classList.add('show');
  aim.caption = performance.now() + (kind === 'error' ? 4200 : 2600);
}

// ---- the ring ----------------------------------------------------------------
function drawRing(now) {
  const d = dpr();
  ringCtx.setTransform(d, 0, 0, d, 0, 0);
  ringCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  if (!aim.held || !aim.rect) return;
  const r = aim.rect;
  if (!r.w || !r.h) return;
  const beat = 0.5 + 0.5 * Math.sin(now / 260);
  pulse = Math.max(0, pulse - 0.03);

  // The glow grows with the target and stops there. A fixed ~40px halo looks fine
  // on a wide card and, on a 40px button, paints across the sibling next to it —
  // which reads as her highlighting two things at once.
  const reach = Math.max(2, Math.min(7, Math.min(r.w, r.h) * 0.08)) * (1 + 0.5 * pulse);
  const pad = Math.max(2, Math.min(4, reach * 0.6));
  const x = r.l - pad, y = r.t - pad, w = r.w + pad * 2, h = r.h + pad * 2;
  const rad = Math.min(11, h / 2, w / 2);
  const grow = reach * 0.85 * (0.55 + 0.45 * beat);

  ringCtx.save();
  ringCtx.lineJoin = 'round';

  // Soft halo, then the outline, then a second outline breathing outward.
  ringCtx.strokeStyle = 'rgba(255, 138, 214, ' + (0.16 + 0.10 * beat).toFixed(3) + ')';
  ringCtx.lineWidth = reach * 2;
  roundRect(ringCtx, x, y, w, h, rad);
  ringCtx.stroke();

  ringCtx.strokeStyle = 'rgba(255, 190, 240, 0.95)';
  ringCtx.lineWidth = 2.5;
  roundRect(ringCtx, x, y, w, h, rad);
  ringCtx.stroke();

  ringCtx.strokeStyle = 'rgba(214, 170, 255, ' + (0.75 - 0.5 * beat).toFixed(3) + ')';
  ringCtx.lineWidth = 1.6;
  roundRect(ringCtx, x - grow, y - grow, w + grow * 2, h + grow * 2, rad + grow);
  ringCtx.stroke();
  ringCtx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ---- model bring-up ----------------------------------------------------------
function startRandomMotion(group) {
  const g = motionGroups && (motionGroups[group] || motionGroups[group.toLowerCase()]);
  if (!g || !g.length || !motionManager) return false;
  motionManager.startMotionPriority(g[Math.floor(Math.random() * g.length)], false, 0);
  return true;
}

function showExpression(name) {
  if (!expressionManager || !expressionList.length) return;
  if (!name || activeExpression === name) { activeExpression = null; expressionManager.stopAllMotions(); return; }
  const e = expressionList.find((x) => x.name === name);
  if (!e) return;
  activeExpression = name;
  expressionManager.startMotion(e.motion, false, 0);
}

function randomExpression() {
  if (!expressionList.length) return;
  let e = expressionList[Math.floor(Math.random() * expressionList.length)];
  if (expressionList.length > 1) {
    while (e.name === activeExpression) e = expressionList[Math.floor(Math.random() * expressionList.length)];
  }
  showExpression(e.name);
  exprTimer = 3.5 + Math.random() * 5.5;
}

// The bridge is the real one, over her own canvas: screen->clip is therefore the
// viewport map the page side assumes, and tick() eases the gaze exactly like the
// demo. look stays null so the point rig — not the SDK's 5-parameter look — is
// what moves her, which is what the calibration sweep is for.
const bridge = createLive2dGuideBridge({
  canvas: stage,
  sensitivity: 1 / 0.6,
  smoothing: 12,
  lookYSign: -1,
});
bridge.model = null;
const glide = createGazeController(
  Object.assign(Object.create(bridge), {
    // Held means "she is pointing at something", which is what both the rig boost
    // and the ghosts commit to; mirror it into `aim` so the ring can follow.
    holdGaze(on) { aim.held = !!on; bridge.holdGaze(on); },
    gesture() { pulse = 1; bridge.gesture(); },
  }),
  // The page owns the hold lifecycle — it owns the engine, and its timer is the one
  // that decides when she stops pointing. Letting her controller release on its own
  // clock too would desync the two: the next element would arrive while her aim
  // looked idle, and the ring would stay dark until the page happened to re-hold.
  { duration: 640, holdMs: 1500, holdAfter: 'keep' }
);

// One glide per element. The proxy always reads the freshest rect, so a `target`
// message for the SAME element only updates where she is pointing, while a new id
// re-aims her from the head — which is how back-to-back `next` commands each get
// their own turn instead of all pointing at the first one.
function glideTo() {
  glide.to({ id: 'remote-' + aim.id, el: targetProxy });
}

const nextFrame = () => new Promise((res) => {
  const id = setTimeout(res, 120);
  requestAnimationFrame(() => { clearTimeout(id); res(); });
});

async function boot() {
  if (!gl) { fail('WebGL is not available in this frame'); return; }
  const chosen = resolveModel('hutao');
  prefetch(chosen);

  const option = new Option();
  option.logFunction = (m) => console.log('[Cubism]', m);
  option.loggingLevel = LogLevel.LogLevel_Verbose;
  CubismFramework.startUp(option);
  CubismFramework.initialize();

  const handles = await loadModel({
    model3Url: chosen.model3,
    gl,
    expressions: chosen.expressions || [],
    onLog: (m) => console.log(m),
  });
  model = handles.model;
  renderer = handles.renderer;
  eyeBlink = handles.eyeBlink;
  breath = handles.breath;
  physics = handles.physics;
  motionManager = handles.motionManager;
  motionGroups = handles.motionGroups;
  expressionManager = handles.expressionManager;
  expressionList = handles.expressionList || [];

  model.update();
  fit = measureBox(model);
  if (!loadDock()) Object.assign(dock, defaultDock());
  clampDock();
  headAnchor = detectHeadAnchor(model)
    || { x: 0, y: fit.cy + fit.bh * (0.5 - HEAD_TOP_DROP) };

  ready = true;
  lastTime = performance.now();
  requestAnimationFrame(loop);
  parent.postMessage({ t: 'ready', n: NONCE }, replyTo());

  // The expensive extras land after she is already on screen.
  try {
    pointRig = await createPointRig(model, {
      idManager: handles.idManager, arms: chosen.arms, physics, pace: nextFrame,
      cacheKey: chosen.model3, cache: Q.get('rigcache') !== '0',
    });
    if (USE_GHOSTS && chosen.companions && chosen.companions.length) {
      companions = await loadCompanions(chosen.companions, {
        gl, hostModel: model, shadersPath: './framework/shaders/',
        onLog: (m) => console.log(m),
      });
    }
  } catch (err) {
    console.error('[HUTAO] setup extras failed:', err);
  }
}

// The page that embedded us. A site on a null origin still posts to us, so this
// only ever echoes where a reply could possibly go.
function replyTo() {
  try { return document.referrer ? new URL(document.referrer).origin : '*'; } catch (_) { return '*'; }
}

// Outbound, with the handshake the page side expects. She has nothing to ask the
// page for except this: where her box is, and that she is alive.
function tell(data) {
  try { parent.postMessage(Object.assign({ n: NONCE }, data), replyTo()); } catch (_) {}
}

// Where a ghost parks beside the element she is pointing at: just clear of its
// outward edge, level with its middle, so it frames the field instead of covering
// it. The outward side takes the other side when it would run off the viewport.
const GHOST_CLEAR = 0.045, GHOST_EDGE = 0.9;
function ghostSpot(point) {
  const base = { x: point.x, y: point.y, strength: 1 };
  const r = aim.rect;
  if (!aim.held || !r || !r.w || !r.h) return base;
  const cr = stage.getBoundingClientRect();
  if (!cr.width || !cr.height) return base;
  const cx = (r.l + r.w / 2 - cr.left) / cr.width * 2 - 1;
  const cy = -((r.t + r.h / 2 - cr.top) / cr.height * 2 - 1);
  const half = r.w / cr.width + GHOST_CLEAR;
  const out = cx >= 0 ? 1 : -1;
  const x = cx + out * half;
  return Math.abs(x) > GHOST_EDGE ? { x: cx - out * half, y: cy, strength: 1 } : { x, y: cy, strength: 1 };
}

function loop(now) {
  requestAnimationFrame(loop);
  if (!model || !renderer) return;
  try {
    const dt = Math.min((now - lastTime) / 1000, 1 / 30);
    lastTime = now;

    const { sx, sy, ox, oy } = dockBase();
    reportDock();
    const pan = bridge.offsetClip();
    const offsetX = ox + pan.x, offsetY = oy + pan.y;

    // The gaze pivots on her head, wherever the dock put it.
    bridge.setOrigin(headAnchor.x * sx + offsetX, headAnchor.y * sy + offsetY - fit.cy * sy);
    bridge.tick(dt);
    const { dragX, dragY } = bridge.gaze();

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const offscreen = CubismWebGLOffscreenManager.getInstance();
    offscreen.beginFrameProcess(gl);

    model.loadParameters();
    model.saveParameters();
    if (motionManager) {
      const idle = motionGroups && (motionGroups['Idle'] || motionGroups['idle']);
      if (idle && idle.length && motionManager.isFinished()) startRandomMotion('Idle');
      motionManager.updateMotion(model, dt);
    }
    if (eyeBlink) eyeBlink.updateParameters(model, dt);
    if (pointRig) {
      pointRig.setBoost(aim.held);
      pointRig.apply(dragX, -dragY);
    }
    if (breath) breath.updateParameters(model, dt);
    if (physics) physics.evaluate(model, dt);
    if (expressionManager) expressionManager.updateMotion(model, dt);
    if (expressionList.length) {
      exprTimer -= dt;
      if (exprTimer <= 0) randomExpression();
    }
    model.update();

    hostMvp = new Float32Array([
      sx, 0, 0, 0,
      0, sy, 0, 0,
      0, 0, 1, 0,
      offsetX, offsetY - fit.cy * sy, 0, 1,
    ]);
    const proj = new CubismMatrix44();
    proj.setMatrix(hostMvp);
    renderer.setMvpMatrix(proj);
    renderer.setRenderState(null, [0, 0, stage.width, stage.height]);
    renderer.drawModel('./framework/shaders/');

    const ghostAim = aim.held ? ghostSpot(bridge.curClip()) : null;
    if (companions) companions.updateAndDraw(dt, hostMvp, model, ghostAim);

    offscreen.endFrameProcess(gl);
    offscreen.releaseStaleRenderTextures(gl);

    drawRing(now);
    if (aim.caption && now > aim.caption) { aim.caption = 0; captionEl.classList.remove('show'); }
  } catch (err) {
    console.error('[HUTAO] loop error', err);
  }
}

function fail(msg) {
  showCaption(msg, 'error');
  console.error('[HUTAO]', msg);
}

window.addEventListener('message', onMessage);
boot().catch((err) => fail(String(err && err.message || err)));

// Test/support surface: one manual frame at a time (see ?raf=manual), and the
// state a diagnostic needs. Names mirror the demo page's __live2dDebug.
window.__hutaoOverlay = {
  frame: loop,
  pump(steps = 60) {
    let ran = 0;
    for (let i = 0; i < steps; i++) {
      if (manualFrames) {
        const q = manualFrames.splice(0);
        if (!q.length) break;
        const t = performance.now();
        for (const cb of q) { cb(t); ran++; }
      } else { loop(performance.now()); ran++; }
    }
    return ran;
  },
  get ready() { return ready; },
  get model() { return model; },
  get aim() { return { held: aim.held, rect: aim.rect, caption: captionEl.textContent }; },
  get gaze() { return bridge.gaze(); },
  get origin() { return bridge.originClip(); },
  get dock() { return ready ? dockBase() : null; },
  get box() { return ready ? artRectCss() : null; },
  get rig() { return pointRig; },
  get ghosts() { return !!companions; },
  post(data) { onMessage({ data: Object.assign({ n: NONCE }, data), source: window.parent }); },
};
