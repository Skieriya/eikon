// Entry point for the UI guide. Waits for the host to publish its Live2D bridge,
// discovers the page's UI, builds the circular queue, and installs a thin control
// surface: a natural-language `say()`, queue stepping, jump-to, and an auto-cycle.
// It also re-discovers on DOM mutations (with a guard) so late-rendered panels or
// newly typed fields stay navigable.

import { discoverUIElements } from './discovery.js';
import { CircularQueue, flattenTree } from './circularQueue.js';
import { parseIntent, matchQuery } from './commandRouter.js';
import { createGazeController } from './gazeController.js';
import { createLive2dGuideBridge } from './live2dBridge.js';

let bridge, queue, gaze, roots;
let excludes = [];
let cycleTimer = null;
let requeue = Promise.resolve();
let observing = false, observerPaused = false;
const listeners = new Set();

function rebuild() {
  roots = discoverUIElements(document, { exclude: excludes });
  queue.setItems(flattenTree(roots));
  return roots;
}

function scheduleRebuild() {
  if (observerPaused) return;
  observerPaused = true;                 // suppress our own DOM writes
  observer && observer.disconnect();
  requeue = Promise.resolve().then(() => {
    rebuild();
    emit();
    if (observing && observer) observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    observerPaused = false;
  });
}

function emit() {
  const snap = status();
  listeners.forEach((cb) => { try { cb(snap); } catch (_) {} });
}

function status() {
  return {
    count: queue.size,
    current: queue.current ? { id: queue.current.id, label: queue.current.label } : null,
    cycling: !!cycleTimer,
    items: queue.list(),
  };
}

function subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); }

async function goto(node, opts) {
  if (!node) return { ok: false, reason: 'nothing to go to' };
  queue.jumpTo(node.id);
  const res = await gaze.to(node, opts);
  emit();
  return res;
}

async function say(raw, opts) {
  const intent = parseIntent(raw);
  switch (intent.type) {
    case 'empty':
      return { spoken: '', result: { ok: false, reason: 'empty' } };
    case 'next': { const n = queue.next(); const r = await goto(n, opts); return { spoken: n && n.label, result: r }; }
    case 'prev': { const n = queue.prev(); const r = await goto(n, opts); return { spoken: n && n.label, result: r }; }
    case 'cycle': return { spoken: 'cycling', result: startCycle() };
    case 'stop': return { spoken: 'stopped', result: stopCycle() };
    case 'list': return { spoken: 'options', result: { ok: true, list: queue.list() } };
    case 'goto': {
      const match = matchQuery(intent.query, roots);
      if (!match) {
        return { spoken: intent.query, result: { ok: false, reason: 'not-found', query: intent.query } };
      }
      const r = await goto(match.node, opts);
      return { spoken: intent.query, result: r, matched: match.node.label, candidates: match.candidates.map((c) => c.node.label) };
    }
    default:
      return { spoken: intent.query || raw, result: { ok: false, reason: 'unsupported' } };
  }
}

function startCycle(intervalMs = 2200) {
  stopCycle();
  cycleTimer = setInterval(() => {
    const n = queue.next();
    if (n) gaze.to(n, { instant: false }).then(emit);
  }, intervalMs);
  emit();
  return { ok: true, cycling: true };
}

function stopCycle() {
  if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
  emit();
  return { ok: true, cycling: false };
}

function jumpTo(id, opts) {
  const node = queue.find(id);
  return node ? goto(node, opts) : Promise.resolve({ ok: false, reason: 'unknown-id' });
}

// ---- optional DOM widgets (only if the host has provisioned the slots) ----
function wireWidgets() {
  const box = document.getElementById('guideBox');
  const go = document.getElementById('guideGo');
  const statusEl = document.getElementById('guideStatus');
  const nextBtn = document.getElementById('guideNext');
  const prevBtn = document.getElementById('guidePrev');
  const autoBtn = document.getElementById('guideAuto');

  const submit = () => {
    if (!box || !box.value.trim()) return;
    say(box.value).then((out) => {
      if (statusEl) {
        if (out.result.ok) statusEl.textContent = `Looking at: ${out.matched || out.spoken || 'target'}`;
        else if (out.result.reason === 'not-found') statusEl.textContent = `I couldn't find "${out.query || out.spoken}".`;
        else statusEl.textContent = out.result.reason || 'done';
      }
    });
    box.value = '';
  };

  if (box) box.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  if (go) go.addEventListener('click', submit);
  if (nextBtn) nextBtn.addEventListener('click', () => say('next'));
  if (prevBtn) prevBtn.addEventListener('click', () => say('previous'));
  if (autoBtn) autoBtn.addEventListener('click', () => {
    if (cycleTimer) { stopCycle(); autoBtn.textContent = 'Auto-cycle'; }
    else { startCycle(); autoBtn.textContent = 'Stop cycling'; }
  });

  subscribe((snap) => {
    if (autoBtn && cycleTimer) autoBtn.textContent = 'Stop cycling';
    else if (autoBtn) autoBtn.textContent = 'Auto-cycle';
  });
}

// Core bootstrap once we have a bridge. Safe to call again (replaces state).
function init(theBridge, opts = {}) {
  if (!theBridge) throw new Error('guide: a bridge is required');
  bridge = theBridge;
  if (typeof bridge.curClip !== 'function') bridge.curClip = () => ({ x: 0, y: 0 });

  excludes = [];
  const canvasEl = typeof bridge.canvasEl === 'function' ? bridge.canvasEl() : null;
  if (canvasEl) excludes.push(canvasEl);
  if (opts.exclude) for (const el of (Array.isArray(opts.exclude) ? opts.exclude : [opts.exclude])) if (el) excludes.push(el);

  queue = new CircularQueue([]);
  gaze = createGazeController(bridge, opts.gaze || {});
  rebuild();
  wireWidgets();

  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(scheduleRebuild);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    observing = true;
  }

  window.UIGuide = {
    say, next: () => say('next'), prev: () => say('previous'),
    startCycle, stopCycle, jumpTo,
    get elements() { return roots; },
    get queue() { return queue; },
    status, subscribe, rebuild, mount: mountGuide,
    bridge,
  };
  console.log('[GUIDE] ready —', queue.size, 'elements in queue');
  return bridge;
}

// Drop-in entry for ANY site. Pass the model handles you already have and the
// guide wires itself up: a generic bridge from createLive2dGuideBridge (built from
// `canvas`, optionally `model`/`look`/`onGesture`) plus discovery + commands.
//   mountGuide({ canvas, model, look, onGesture })
// Then call `window.__live2dGuide.tick(dt)` where you used to drive the look.
export function mountGuide(config = {}) {
  mounted = true;
  let b = config.bridge;
  if (!b) {
    if (!config.canvas) throw new Error('mountGuide: provide `canvas` (or a ready `bridge`)');
    b = createLive2dGuideBridge(config);
  }
  window.__live2dGuide = b;
  return init(b, config);
}

// Auto mode: attach to a bridge the host already published on the window.
function boot() {
  if (mounted) return;                                          // explicit mountGuide took over
  if (!window.__live2dGuide) { setTimeout(boot, 150); return; }
  init(window.__live2dGuide);
}

let observer = null;
let mounted = false;
if (typeof window !== 'undefined') { window.mountGuide = mountGuide; boot(); }
