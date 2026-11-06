// Entry point for the UI guide. Waits for the host to publish its Live2D bridge,
// discovers the page's UI, builds the circular queue, and installs a thin control
// surface: a natural-language `say()`, queue stepping, jump-to, multi-step paths,
// and an auto-cycle. It also re-discovers on DOM mutations (with a guard) so
// late-rendered panels or newly typed fields stay navigable — that same re-discovery
// is what lets a path keep going after you open the panel holding the next step.

import { discoverUIElements, isPressable } from './discovery.js';
import { CircularQueue, flattenTree } from './circularQueue.js';
import { parseIntent, matchQuery } from './commandRouter.js';
import { createGazeController } from './gazeController.js';
import { createLive2dGuideBridge } from './live2dBridge.js';
import { RECIPES, createPathRunner, makePlan, parseChain, planFor } from './paths.js';

let bridge, queue, gaze, roots;
let excludes = [];
let cycleTimer = null;
let requeue = Promise.resolve();
let observing = false, observerPaused = false;
let clicking = false;
const listeners = new Set();

// Path state: what she knows, what she is walking, what she is recording.
let learned = [];
let hooks = {};
let teaching = null;
let settleTimer = null, settleUntil = 0;
const SETTLE_QUIET_MS = 550, SETTLE_MAX_MS = 3000;

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
    onDomChange();
  });
}

// The page just moved. Two things a path cares about: a step that was waiting for
// the page to settle can now be taken, and a step she could not find may exist now
// that whatever was hiding it has opened.
function onDomChange() {
  if (!path.active) return;
  if (path.awaiting === 'settle') { armSettle(); return; }
  if (path.awaiting === 'missing') path.retry();
}

function armSettle() {
  const now = Date.now();
  if (!settleUntil) settleUntil = now + SETTLE_MAX_MS;
  clearTimeout(settleTimer);
  const left = Math.max(0, settleUntil - now);
  settleTimer = setTimeout(takeSettledStep, Math.min(SETTLE_QUIET_MS, left));
}

function takeSettledStep() {
  settleTimer = null; settleUntil = 0;
  path.advance();
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
    path: path.status(),
    teaching: teaching ? { goal: teaching.goal, host: teaching.host, steps: teaching.steps.map((s) => s.find) } : null,
    known: learned.length,
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

// ---- multi-step paths --------------------------------------------------------
// Her chain of steps lives in paths.js; this side is the part that has to touch
// the DOM: resolving a step's words to a real element, and noticing the click.
function announce(text, kind) {
  if (hooks.caption) hooks.caption(text, kind || 'ok');
  else console.log('[GUIDE] ' + text);
}

function hostName() {
  try { return location.hostname || ''; } catch (_) { return ''; }
}

function flatNodes() {
  const out = [];
  const walk = (list) => list.forEach((n) => { out.push(n); walk(n.children); });
  walk(roots || []);
  return out;
}

// A saved selector is a last resort, tried only when the words she remembers no
// longer name anything — a redesign renames things far more often than it moves
// them, and a wrong-but-confident point is worse than "I can't find it".
function resolveStep(step) {
  if (!step) return null;
  const m = matchQuery(step.find, roots || []);
  if (m) return m.node;
  if (step.sel) {
    try {
      const el = document.querySelector(step.sel);
      if (el && el.getBoundingClientRect().width > 0) return nodeFromEl(el);
    } catch (_) { /* a selector from an older page — let the words stand */ }
  }
  return null;
}

function nodeFromEl(el) {
  const text = (el.getAttribute && el.getAttribute('aria-label')) || el.textContent || el.id || el.tagName;
  return {
    el,
    id: el.id || 'el-' + slugOf(text) + '-' + flatNodes().length,
    label: String(text).replace(/\s+/g, ' ').trim().slice(0, 40) || el.tagName.toLowerCase(),
    aliases: [], kind: 'control', parent: null, children: [], depth: 0,
  };
}

function slugOf(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

// The tightest honest handle for a recorded click: an id or a testing hook, never
// a nth-child path, which breaks the moment the site adds a wrapper div.
function hintFor(el) {
  try {
    if (el.id) return '#' + CSS.escape(el.id);
    for (const attr of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'name']) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) return `[${attr}="${CSS.escape(v)}"]`;
    }
  } catch (_) { /* no CSS.escape on this page — the words alone will do */ }
  return null;
}

function nodeForClick(el) {
  if (!el || el.nodeType !== 1 || el.closest('[data-guide-exclude]')) return null;
  const flat = flatNodes();
  for (const n of flat) if (n.el === el) return n;
  // A control she has not discovered — because it was hidden when the page was
  // last read, or because it appeared a moment ago — is still the thing you
  // pressed: its own words beat the section it happens to sit in.
  if (isPressable(el)) return nodeFromEl(el);
  // Otherwise the nearest element she knows that holds the press.
  let best = null;
  for (const n of flat) {
    if (!n.el || !n.el.contains || !n.el.contains(el)) continue;
    if (!best || best.el.contains(n.el)) best = n;
  }
  return best || nodeFromEl(el);
}

function stepText(label, i, n, moved) {
  let body;
  if (n <= 1) body = `Click “${label}”`;
  else if (i === 0) body = `First, click “${label}” — I'll wait for you`;
  else if (i === n - 1) body = `Last one: “${label}”`;
  else body = `Now “${label}” — step ${i + 1} of ${n}`;
  return body + (moved ? ', and it is below the fold — following it down' : '') + '.';
}

// A step below the fold is a step you cannot press. Scrolling is the only thing
// she does to a page besides looking at it, and the pump keeps re-sampling the
// live rect, so she tracks the control the whole way down.
function bringIntoView(node) {
  const el = node && node.el;
  if (!el || typeof el.scrollIntoView !== 'function') return false;
  const b = el.getBoundingClientRect();
  if (b.top >= 0 && b.left >= 0 && b.bottom <= window.innerHeight && b.right <= window.innerWidth) return false;
  try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); }
  catch (_) { return false; }
  return true;
}

const path = createPathRunner({
  resolve: resolveStep,
  goTo: (node) => goto(node, { instant: false }),
  onStep: ({ node, i, plan }) => {
    stopCycle();
    const moved = bringIntoView(node);
    announce(stepText(node.label, i, plan.steps.length, moved), 'ok');
    emit();
  },
  onMiss: (step) => {
    announce(`I can't find “${step.find}” here. Open it and I'll follow — or say next to skip it.`, 'error');
    emit();
  },
  onDone: (plan) => {
    announce(`That's the place — ${plan.name}. Say so if it wasn't what you meant.`, 'ok');
    emit();
  },
  onEvent: () => emit(),
});

function chainPlan(text) {
  const steps = parseChain(text);
  if (steps.length < 2) return null;
  return makePlan({ name: steps.join(' → '), steps });
}

// A goal is answered from what she knows: the bundled table first, then whatever
// you taught her on this site, then a path spelled out in the sentence itself.
async function walk(goal) {
  const plan = planFor(goal, { recipes: RECIPES, learned, host: hostName() }) || chainPlan(goal);
  if (!plan) return null;
  return path.start(plan);
}

// ---- teaching ----------------------------------------------------------------
// Watching you do it is the only way she can learn a flow no table predicted.
// What is stored is the words of each control, so the path survives a redesign.
function teachStart(goal) {
  if (teaching) return teaching;
  teaching = { goal: goal || '', host: hostName(), steps: [] };
  stopCycle();
  path.stop();
  announce('Watching. Do it the way you would — say done when you are through.', 'ok');
  emit();
  return teaching;
}

function teachNote(node, el) {
  if (!teaching) return;
  const last = teaching.steps[teaching.steps.length - 1];
  if (last && last.find === node.label) return;
  if (teaching.steps.length >= 8) { teachStop(); return; }
  teaching.steps.push({ find: node.label, sel: hintFor(el) });
  emit();
}

function teachStop() {
  const rec = teaching;
  teaching = null;
  if (!rec) return null;
  if (!rec.steps.length) {
    announce('Nothing to remember — I did not see a click.', 'error');
    emit();
    return null;
  }
  const name = rec.goal || rec.steps.map((s) => s.find).join(' → ');
  const plan = makePlan({
    name,
    goal: rec.goal + ' ' + rec.steps.map((s) => s.find).join(' '),
    host: rec.host,
    steps: rec.steps,
    learned: true,
    at: Date.now(),
  });
  learned = learned.filter((p) => p.id !== plan.id).slice(-40);
  learned.push(plan);
  if (hooks.remember) { try { hooks.remember(plan); } catch (_) {} }
  announce(`Got it — ${plan.steps.length} step${plan.steps.length > 1 ? 's' : ''}: ${plan.steps.map((s) => `“${s.find}”`).join(', ')}. Ask me how and I'll walk you there.`, 'ok');
  emit();
  return plan;
}

function onUserClick(e) {
  const el = e && e.target;
  if (!el) return;
  const node = nodeForClick(el);
  if (teaching) { if (node) teachNote(node, el); return; }
  if (!path.active || !node) return;
  // Her click test is containment, so a press on anything inside the control
  // counts — real buttons put their label in a span, and links wrap icons.
  if (path.clicked(node.el)) armSettle();
}

function setPaths(list) {
  learned = (list || []).map((p) => makePlan(Object.assign({ learned: true }, p))).filter(Boolean);
  emit();
  return learned.length;
}

async function say(raw, opts) {
  const intent = parseIntent(raw);
  // The same little words steer a path, a lesson and the queue, in that order of
  // precedence: while she is watching you or walking you somewhere, "next" means
  // that, and only the queue gets it when nothing else is going on.
  if (intent.type === 'stop' && teaching) {
    const plan = teachStop();
    return { spoken: 'taught', result: { ok: !!plan, path: plan } };
  }
  switch (intent.type) {
    case 'empty':
      return { spoken: '', result: { ok: false, reason: 'empty' } };
    case 'teach': {
      const goal = String(raw || '')
        .replace(/^\s*(?:teach|learn|watch\s+me|remember\s+(?:this|this\s+way|how|i)|note\s+(?:this|how))\b[:,]?\s*/i, '')
        .replace(/^\s*me\s+/i, '')
        .trim();
      teachStart(goal);
      return { spoken: 'teaching', result: { ok: true, teaching: true } };
    }
    case 'done': {
      if (teaching) {
        const plan = teachStop();
        return { spoken: 'taught', result: { ok: !!plan, path: plan } };
      }
      if (path.active) {
        clearTimeout(settleTimer); settleTimer = null; settleUntil = 0;
        const r = await path.advance();
        return { spoken: path.active ? 'onward' : 'finished', result: r || { ok: true }, path: path.status(), announced: true };
      }
      return { spoken: '', result: { ok: false, reason: 'nothing-in-progress' } };
    }
    case 'goal': {
      const started = await walk(intent.query);
      if (started) return { spoken: intent.query, result: started, path: path.status(), announced: true };
      // No path for it: fall back to pointing at the thing they named, which is
      // what "how do I get to the pricing page" has always meant. If even that
      // misses, `noPath` is what turns "I can't find it" into "teach me and I'll
      // know it next time".
      const r = await gotoNamed(intent.query, opts, intent.query);
      if (r && r.result && r.result.reason === 'not-found') r.noPath = true;
      return r;
    }
    case 'next': {
      if (path.active) {
        clearTimeout(settleTimer); settleTimer = null; settleUntil = 0;
        const r = await path.advance();
        return { spoken: path.active ? 'onward' : 'finished', result: r || { ok: true }, path: path.status(), announced: true };
      }
      const n = queue.next(); const r = await goto(n, opts); return { spoken: n && n.label, result: r };
    }
    case 'prev': {
      if (path.active) {
        const r = await path.back();
        return { spoken: 'back', result: r || { ok: false, reason: 'at-the-start' }, path: path.status(), announced: true };
      }
      const n = queue.prev(); const r = await goto(n, opts); return { spoken: n && n.label, result: r };
    }
    case 'cycle': return { spoken: 'cycling', result: startCycle() };
    case 'stop': {
      if (path.active) {
        const plan = path.stop();
        announce(`Done with “${plan.name}”, then.`, 'ok');
        return { spoken: 'stopped', result: { ok: true, path: null } };
      }
      return { spoken: 'stopped', result: stopCycle() };
    }
    case 'list': return { spoken: 'options', result: { ok: true, list: queue.list() } };
    case 'goto': {
      // "settings → personalization → memory" is a route spelled out, which is
      // worth more than pointing at the first of them.
      const plan = chainPlan(intent.query);
      if (plan) {
        const started = await path.start(plan);
        return { spoken: intent.query, result: started, path: path.status(), announced: true };
      }
      return gotoNamed(intent.query, opts, intent.query);
    }
    default:
      return { spoken: intent.query || raw, result: { ok: false, reason: 'unsupported' } };
  }
}

async function gotoNamed(query, opts, spoken) {
  if (path.active) path.stop();               // a fresh question ends the old errand
  const match = matchQuery(query, roots);
  if (!match) {
    return { spoken, result: { ok: false, reason: 'not-found', query } };
  }
  const r = await goto(match.node, opts);
  return { spoken, result: r, matched: match.node.label, candidates: match.candidates.map((c) => c.node.label) };
}

function startCycle(intervalMs = 2200) {
  stopCycle();
  path.stop();                                 // cycling the whole page ends an errand
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
  if (path.active) path.stop();
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
      if (!statusEl) return;
      if (out && out.path) {
        statusEl.textContent = out.path.i < out.path.n
          ? `Step ${out.path.i + 1} of ${out.path.n}: ${out.path.label}`
          : `Done — ${out.path.name}`;
      } else if (out && out.result && out.result.teaching) {
        statusEl.textContent = 'Watching — do it the way you would, then say done.';
      } else if (out.result.ok) {
        statusEl.textContent = `Looking at: ${out.matched || out.spoken || 'target'}`;
      } else if (out.result.reason === 'not-found') {
        statusEl.textContent = `I couldn't find "${out.query || out.spoken}".`;
      } else {
        statusEl.textContent = out.result.reason || 'done';
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

  hooks = { caption: typeof opts.caption === 'function' ? opts.caption : null,
            remember: typeof opts.remember === 'function' ? opts.remember : null };

  excludes = [];
  const canvasEl = typeof bridge.canvasEl === 'function' ? bridge.canvasEl() : null;
  if (canvasEl) excludes.push(canvasEl);
  if (opts.exclude) for (const el of (Array.isArray(opts.exclude) ? opts.exclude : [opts.exclude])) if (el) excludes.push(el);

  queue = new CircularQueue([]);
  gaze = createGazeController(bridge, opts.gaze || {});
  rebuild();
  wireWidgets();

  // Capture, so a site that stops propagation on its own buttons still cannot hide
  // a click from her: she is watching whether you did the step, not who heard it.
  if (!clicking) {
    document.addEventListener('click', onUserClick, true);
    clicking = true;
  }

  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(scheduleRebuild);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    observing = true;
  }

  window.UIGuide = {
    say, next: () => say('next'), prev: () => say('previous'),
    startCycle, stopCycle, jumpTo,
    walk, stopPath: () => path.stop(), pathStatus: () => path.status(),
    setPaths, teach: teachStart, teachStop,
    get elements() { return roots; },
    get queue() { return queue; },
    get knownPaths() { return learned.slice(); },
    get RECIPES() { return RECIPES; },
    status, subscribe, rebuild, mount: mountGuide,
    bridge,
  };
  console.log('[GUIDE] ready —', queue.size, 'elements in queue,', learned.length, 'path(s) she knows');
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
