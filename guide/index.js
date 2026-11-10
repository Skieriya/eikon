// Entry point for the UI guide. Waits for the host to publish its Live2D bridge,
// discovers the page's UI, builds the circular queue, and installs a thin control
// surface: a natural-language `say()`, queue stepping, jump-to, multi-step paths,
// and an auto-cycle. It also re-discovers on DOM mutations (with a guard) so
// late-rendered panels or newly typed fields stay navigable — that same re-discovery
// is what lets a path keep going after you open the panel holding the next step.

import { discoverUIElements, invalidateStyleCache, isPressable, hoverEvidence, rectOf, isLive, closestDeep, parentEl, scrollIntoViewDeep } from './discovery.js';
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
const wiredDocs = new WeakSet();
const listeners = new Set();

// Path state: what she knows, what she is walking, what she is recording.
let learned = [];
let hooks = {};
let teaching = null;
let revealTried = new Set();      // openers already offered for this step
let revealStep = -1;
let lastMissKey = '';
let watchTimer = null;
let pressDown = null, lastClickAt = 0;
let hoverTimer = null;
// Whether the step AFTER the one she is pointing at was already on screen when
// she pointed. Measured then, not when the pointer arrives: a :hover flyout is
// open by the time the pointerover handler runs, so asking at that moment would
// always answer "it was already there" and no hover could ever count.
let nextPresent = false;
let settleTimer = null, settleUntil = 0;
const SETTLE_QUIET_MS = 550, SETTLE_MAX_MS = 3000;
// Long enough for a flyout to animate in, short enough to feel like an answer.
const HOVER_DWELL_MS = 260, HOVER_WINDOW_MS = 6000, HOVER_RETRY_MS = 160;

function rebuild() {
  return adopt(discoverUIElements(document, { exclude: excludes }));
}

function adopt(tree) {
  roots = tree;
  const flat = flattenTree(roots);
  queue.setItems(flat);
  // A press inside a frame never reaches this document's listeners, so every
  // document she can see has to be watched in its own right.
  for (const n of flat) wirePress(n.el.ownerDocument);
  return roots;
}

// Capture, so a site that stops propagation on its own buttons still cannot hide
// a press from her: she is watching whether you did the step, not who heard it.
function wirePress(doc) {
  if (!doc || wiredDocs.has(doc)) return;
  wiredDocs.add(doc);
  doc.addEventListener('click', onUserClick, true);
  doc.addEventListener('keydown', onUserKey, true);
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('pointerup', onPointerUp, true);
  doc.addEventListener('pointerover', onUserHover, true);
  doc.addEventListener('mouseover', onUserHover, true);
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

// The page just moved. Three things a path cares about: a step waiting for the
// page to settle can now be taken, the control she is holding may have been
// replaced by a re-render, and a step she could not find may exist now that
// whatever was hiding it has opened.
function onDomChange() {
  if (!path.active) return;
  if (path.awaiting === 'settle') { armSettle(); return; }
  if (refreshHeld()) return;
  if (path.awaiting === 'missing') path.retry();
}

// A mutation observer on the body cannot see inside a shadow root or a frame, and
// a frame finishing its load mutates nothing in the parent at all. While she is
// walking or watching, look again on a clock instead: it costs nothing when no
// route is running, because it clears itself.
function startWatch() {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    if (!path.active && !teaching) { stopWatch(); return; }
    if (!path.active || path.awaiting === 'settle') return;
    if (refreshHeld()) return;
    if (path.awaiting === 'missing') path.retry();
  }, 900);
}

function stopWatch() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
}

// The element she is holding may have been thrown away and rebuilt while she was
// pointing at it. Same step, same words, new object: move her onto the live one
// without making a fuss, because nothing about the route has changed.
function refreshHeld() {
  if (!path.active) return false;
  const st = path.status();
  if (!st || (st.awaiting !== 'click' && st.awaiting !== 'reveal')) return false;
  const held = path.node;
  if (st.awaiting === 'click' && held && isLive(held.el)) {
    const r = rectOf(held.el);
    if (r && r.width && r.height) return false;
  }
  const step = path.plan && path.plan.steps[st.i];
  const node = resolveStep(step);
  if (!node || (held && node.el === held.el)) return false;
  path.retarget(node);
  goto(node, { instant: true });
  return true;
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
  path.settled();
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
  const node = findStep(step);
  // How this control is worked is a fact about the page, not about the plan: a
  // nav row with a flyout under it is hovered even if the route said "click".
  if (node) {
    const v = hoverEvidence(node.el);
    node.via = v >= 2 ? 'hover' : (v === 1 ? 'either' : null);
  }
  return node;
}

// A step is something you press. A section that merely mentions the word is not
// the control, so a pressable candidate beats a higher-scoring landmark.
function pickStep(step, tree) {
  if (!step) return null;
  const m = matchQuery(step.find, tree);
  if (!m) return null;
  const live = (n) => n && n.el && isLive(n.el);
  const pressable = (m.candidates || []).find((c) => c.score >= 2 && live(c.node) && isPressable(c.node.el));
  const node = pressable ? pressable.node : m.node;
  return live(node) ? node : null;
}

function findStep(step) {
  if (!step) return null;
  const known = pickStep(step, roots || []);
  if (known) return known;
  if (step.sel) {
    try {
      const el = document.querySelector(step.sel);
      if (el && isLive(el) && rectOf(el).width > 0) return nodeFromEl(el);
    } catch (_) { /* a selector from an older page — let the words stand */ }
  }
  // The tree she holds is rebuilt whenever the page changes, but a control that
  // appeared a moment ago — or one inside a shadow root the body observer cannot
  // see — may not be in it yet. Look again, fresh, before calling the step missing.
  const fresh = discoverUIElements(document, { exclude: excludes });
  const found = pickStep(step, fresh);
  if (found) {
    adopt(fresh);
    return found;
  }
  return null;
}

// The control you are after is not on the page — but something on it may open a
// menu that holds it. An avatar button, a dropdown, a collapsed section: she
// points at that instead of giving up, and the route starts from there.
function revealHint(el) {
  const cls = el.className && typeof el.className === 'string' ? el.className : '';
  return [el.id, el.getAttribute('data-testid'), el.getAttribute('aria-label'),
          el.getAttribute('title'), el.getAttribute('aria-controls'), cls].filter(Boolean).join(' ');
}

function revealScore(el) {
  // An opener that is already open is not the answer: pressing it again closes
  // the very panel the route needs, which is how a guide gets stuck pointing at
  // one button while the user clicks it over and over.
  if (el.getAttribute('aria-expanded') === 'true') return 0;
  let score = 0;
  if (el.hasAttribute('aria-haspopup')) score += 3;
  if (el.getAttribute('aria-expanded') === 'false') score += 2;
  if (el.hasAttribute('aria-controls')) score += 2;
  const hover = hoverEvidence(el);
  if (hover >= 2) score += 3;             // a level that opens under the pointer
  else if (hover === 1) score += 1;
  const hint = revealHint(el);
  if (/menu|dropdown|popup|popover/i.test(hint)) score += 4;
  if (/profile|account|avatar|user|switcher/i.test(hint)) score += 4;
  if (/options|more|ellipsis|kebab|hamburger/i.test(hint)) score += 2;
  if (!String(el.textContent || '').trim()) score += 1;    // an icon-only control
  return score;
}

function findReveal(step, i) {
  if (i !== revealStep) { revealStep = i; revealTried = new Set(); }
  const fresh = discoverUIElements(document, { exclude: excludes });
  const flat = [];
  const walk = (list) => list.forEach((n) => { flat.push(n); walk(n.children); });
  walk(fresh);
  let best = null, bestScore = 0;
  for (const node of flat) {
    const el = node.el;
    if (!el || revealTried.has(el)) continue;   // a tried opener failed
    const hover = hoverEvidence(el);
    // A plain link leaves the page, and a plain div is nothing to press — but a
    // link with a flyout under it and a div that opens on hover are both levels.
    if (el.tagName === 'A' && hover < 2) continue;
    if (!isPressable(el) && hover < 2) continue;
    const s = revealScore(el);
    if (s <= bestScore) continue;
    best = node; bestScore = s;
  }
  if (!best || bestScore < 4) return null;
  revealTried.add(best.el);
  const el = best.el;
  const pressed = el.tagName === 'BUTTON' || el.hasAttribute('aria-haspopup') || el.getAttribute('aria-expanded') === 'false';
  // Anything that announces a popup is worked by clicking; the rest of the
  // hover-opened world is worked by resting on it, and saying "click" there
  // would send you after a press that does nothing.
  if (!pressed && hoverEvidence(el) >= 2) return Object.assign({}, best, { via: 'hover' });
  return best;
}

// "profile-button" reads badly in a sentence; "profile" reads fine.
function readable(label) {
  const s = String(label || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const short = s.replace(/\s*button$/i, '').trim();
  return short || s || 'the menu';
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

// What the press actually travelled through, innermost first. e.target on its own
// is retargeted to the shadow host when the control lives in a shadow root, which
// is never the thing you pressed; composedPath is the only honest answer.
function pressPath(e) {
  let list = null;
  try { list = typeof e.composedPath === 'function' ? e.composedPath() : null; } catch (_) { list = null; }
  if (!list || !list.length) list = e.target ? [e.target] : [];
  return list.filter((n) => n && n.nodeType === 1);
}

function nodeForPress(composed) {
  if (!composed.length) return null;
  if (closestDeep(composed[0], '[data-guide-exclude]')) return null;
  const flat = flatNodes();
  // The deepest control she knows that the press went through: a button's label
  // is a span, a link wraps an icon, and neither is the control itself.
  for (const el of composed) {
    for (const n of flat) if (n.el === el) return n;
  }
  const el = composed[0];
  if (isPressable(el)) return nodeFromEl(el);
  let best = null;
  for (const n of flat) {
    if (composed.indexOf(n.el) < 0) continue;
    if (!best || (best.el.contains && best.el.contains(n.el))) best = n;
  }
  return best || nodeFromEl(el);
}

// A framework that re-renders throws the node away and puts an identical one in
// its place. The words, the role and the spot on screen are the same control;
// only the object is new, and refusing it would strand the route on a step you
// already did. While the old node is still live, only the same spot counts —
// two buttons with one name are still two buttons.
function controlKey(el) {
  if (!el || !el.getAttribute) return '';
  const name = el.getAttribute('aria-label') || el.getAttribute('data-testid') || el.id || '';
  const text = String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  return [el.getAttribute('role') || el.tagName, name, text].join('|').toLowerCase();
}

function sameControl(a, b) {
  if (!a || !b || a === b) return false;
  const key = controlKey(a);
  if (!key || key !== controlKey(b)) return false;
  if (!isLive(a) || !isLive(b)) return true;
  const ra = rectOf(a), rb = rectOf(b);
  if (!ra || !rb || !ra.width || !rb.width) return false;
  return Math.abs(ra.left - rb.left) < 12 && Math.abs(ra.top - rb.top) < 12
    && Math.abs(ra.width - rb.width) < 8 && Math.abs(ra.height - rb.height) < 8;
}

function handlePress(el, composed) {
  if (!el) return;
  clearTimeout(hoverTimer); hoverTimer = null;
  if (teaching) { const n = nodeForPress(composed); if (n) teachNote(n, el); return; }
  if (!path.active) return;
  refreshHeld();                       // the page may have rebuilt the control
  const node = nodeForPress(composed); // resolve against the tree refreshHeld adopted
  if (!node) return;
  if (path.clicked(node.el, composed)) { armSettle(); return; }
  const held = path.node;
  if (held && sameControl(held.el, node.el) && path.pressed()) armSettle();
}

// ---- levels that open under the pointer --------------------------------------
// A flyout never emits a click: the pointer arrives, the next level appears, and
// that is the whole action. So a hover on what she is holding is followed by a
// short dwell and then a look at what the page became. Nothing is assumed — the
// route only moves when the control it was waiting for is actually there.
function onUserHover(e) {
  if (!path.active && !teaching) return;
  const composed = pressPath(e);
  if (!composed.length) return;
  const el = composed[0];
  if (closestDeep(el, '[data-guide-exclude]')) return;
  if (teaching) { armHoverProbe(composed, true); return; }
  const st = path.status();
  if (!st) return;
  if (st.awaiting === 'missing') {
    // No opener was worth pointing at, but the pointer may have found one.
    if (isPressable(el) || hoverEvidence(el)) armHoverProbe(composed, false);
    return;
  }
  if (path.holds(el, composed)) armHoverProbe(composed, false);
}

// Is the pointer still resting on the thing she is holding? The control itself
// may no longer be under it — the flyout that just opened is a sibling — but the
// row that owns it still is.
function stillHovered(el) {
  let n = el, hops = 0;
  while (n && n.nodeType === 1 && hops++ < 8) {
    try { if (n.matches(':hover')) return true; } catch (_) { return false; }
    n = parentEl(n);
  }
  return false;
}

function armHoverProbe(composed, teach) {
  clearTimeout(hoverTimer);
  const st = path.status();
  const armedFor = st ? st.awaiting : null;
  const sizeBefore = queue.size;
  const started = Date.now();
  const tick = () => {
    hoverTimer = null;
    if (teach) { noteHover(composed, sizeBefore); return; }
    if (takeHoverStep(composed, armedFor)) return;
    // A flyout that fades in is not there at 260ms, and a stylesheet transition
    // only advances when the page paints. Keep looking while the pointer is
    // still resting on it, rather than deciding the hover did nothing.
    const now = path.status();
    const held = path.held;
    const resting = held ? stillHovered(held) : false;
    if (Date.now() - started < HOVER_WINDOW_MS && now && now.awaiting === armedFor && resting) {
      hoverTimer = setTimeout(tick, HOVER_RETRY_MS);
    }
  };
  hoverTimer = setTimeout(tick, HOVER_DWELL_MS);
}

function takeHoverStep(composed, armedFor) {
  if (!path.active) return false;
  const st = path.status();
  // The route moved on while the pointer rested — a press landed, or a reveal
  // became the step itself. Either way this hover is no longer the action.
  if (!st || st.awaiting !== armedFor) return true;
  if (st.awaiting === 'missing') { path.retry(); return true; }
  if (st.awaiting !== 'click' && st.awaiting !== 'reveal') return true;
  if (!path.holds(composed[0], composed)) return true;
  const step = path.plan.steps[st.i];
  if (st.awaiting === 'reveal') {
    if (resolveStep(step) && path.opened()) { armSettle(); return true; }
    return false;
  }
  // A step she learned as a hover is worked by hovering, full stop.
  if (step && step.via === 'hover') { if (path.pressed()) armSettle(); return true; }
  const next = path.plan.steps[st.i + 1];
  const opensUnderPointer = !!(path.node && path.node.via === 'hover');
  // The last level of a route that opens under the pointer is arrived at by
  // resting on it; there is nothing after it to wait for.
  if (!next) { if (opensUnderPointer && path.pressed()) armSettle(); return true; }
  if (nextPresent) return true;
  if (resolveStep(next) && path.pressed()) { armSettle(); return true; }
  return false;
}

// While she is watching you do it, a hover that opens a level is a step too —
// otherwise a route through a nav bar would be recorded with its middle missing.
function noteHover(composed, sizeBefore) {
  if (!teaching) return;
  const node = nodeForPress(composed);
  if (!node || !hoverEvidence(node.el)) return;
  rebuild();
  if (queue.size <= sizeBefore) return;      // nothing opened; the pointer was passing through
  teachNote(node, node.el, 'hover');
}

function onUserClick(e) {
  lastClickAt = Date.now();
  const composed = pressPath(e);
  handlePress(composed[0], composed);
}

// Enter or Space on the control she is holding is the same press, and half the
// web drives its menus that way. Enter in a text field is typing, not a press.
function onUserKey(e) {
  if (!e || (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar')) return;
  const el = e.target;
  if (!el || el.nodeType !== 1) return;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || el.isContentEditable) return;
  if (tag === 'INPUT' && !/^(button|submit|checkbox|radio)$/i.test(el.type || 'text')) return;
  if (!path.active && !teaching) return;
  const composed = pressPath(e);
  handlePress(el, composed.length ? composed : [el]);
}

// Some controls act on pointerdown and never emit a click at all — and a menu
// that unmounts its own item on press takes the click event with it. Watch the
// press itself, and only use it when no click followed.
function onPointerDown(e) {
  if (!e || (!path.active && !teaching)) return;
  pressDown = { x: e.clientX, y: e.clientY, t: Date.now(), composed: pressPath(e) };
}

function onPointerUp(e) {
  const d = pressDown;
  pressDown = null;
  if (!d || !d.composed.length) return;
  if (Math.abs(e.clientX - d.x) > 8 || Math.abs(e.clientY - d.y) > 8) return;   // a drag
  if (Date.now() - d.t > 1500) return;                                        // a long press
  setTimeout(() => {
    if (lastClickAt >= d.t) return;              // the click arrived; it already counted
    handlePress(d.composed[0], d.composed);
  }, 0);
}

function stepText(label, i, n, moved, via) {
  const hover = via === 'hover' || via === 'either';
  const act = hover ? 'hover over' : 'click';
  const Act = hover ? 'Hover over' : 'Click';
  let body;
  if (n <= 1) body = `${Act} “${label}”`;
  else if (i === 0) body = `First, ${act} “${label}” — I'll wait for you`;
  else if (i === n - 1) body = `Last one: ${act} “${label}”`;
  else body = `Now ${act} “${label}” — step ${i + 1} of ${n}`;
  if (moved) body += ', and it is below the fold — following it down';
  // A caret says a level opens here, but not whether the pointer or the click
  // does it: offer the hover and leave the click standing by.
  return body + (via === 'either' ? '. If nothing opens, click it.' : '.');
}

// A step below the fold is a step you cannot press. Scrolling is the only thing
// she does to a page besides looking at it, and the pump keeps re-sampling the
// live rect, so she tracks the control the whole way down — including a control
// that lives in a frame, where the frame itself may be the thing off screen.
function bringIntoView(node) {
  return !!(node && node.el) && scrollIntoViewDeep(node.el);
}

const path = createPathRunner({
  resolve: resolveStep,
  goTo: (node) => goto(node, { instant: false }),
  findReveal,
  onStep: ({ step, node, i, plan }) => {
    stopCycle();
    lastMissKey = '';
    startWatch();
    nextPresent = !!pickStep(plan.steps[i + 1], roots || []);
    const moved = bringIntoView(node);
    const via = (step && step.via) || node.via;
    announce(stepText(node.label, i, plan.steps.length, moved, via), 'ok');
    emit();
  },
  onMiss: (step, i, plan, info) => {
    // Two kinds of missing: the control is nowhere, or it is inside something
    // that is not open yet. The second one has an answer — open it. The tried-set
    // guarantees it is a different opener each time, so this is never the same
    // sentence twice, and never a silent re-point at the button you just pressed.
    const reveal = info && info.reveal;
    const key = (reveal ? 'r' : 'm') + '|' + i + '|' + step.find + '|' + (reveal ? reveal.label : '');
    if (key === lastMissKey) { emit(); return; }
    lastMissKey = key;
    startWatch();
    if (reveal) {
      bringIntoView(reveal);
      const act = reveal.via === 'hover'
        ? `rest your pointer on ${readable(reveal.label)} — the next level opens under it`
        : `click ${readable(reveal.label)} to open it`;
      announce(`“${step.find}” is not out yet — ${act}, and I will take you from there.`, 'ok');
      emit();
      return;
    }
    announce(`I can't find “${step.find}” here. Open the panel holding it and I'll pick it up — or say next to skip it, or teach me the way.`, 'error');
    emit();
  },
  onDone: (plan) => {
    stopWatch();
    lastMissKey = '';
    announce(`That's the place — ${plan.name}. Say so if it wasn't what you meant.`, 'ok');
    emit();
  },
  onEvent: (kind) => { if (kind === 'start') { lastMissKey = ''; startWatch(); } emit(); },
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
  startWatch();
  announce('Watching. Do it the way you would — say done when you are through.', 'ok');
  emit();
  return teaching;
}

function teachNote(node, el, via) {
  if (!teaching) return;
  const last = teaching.steps[teaching.steps.length - 1];
  if (last && last.find === node.label) return;
  if (teaching.steps.length >= 8) { teachStop(); return; }
  teaching.steps.push({ find: node.label, sel: hintFor(el), via: via || null });
  emit();
}

function teachStop() {
  const rec = teaching;
  teaching = null;
  if (!path.active) stopWatch();
  if (!rec) return null;
  if (!rec.steps.length) {
    announce('Nothing to remember — I did not see you open or press anything.', 'error');
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
        clearTimeout(settleTimer); settleTimer = null; settleUntil = 0;
        const plan = path.stop();
        stopWatch();
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
  wirePress(document);

  if (typeof MutationObserver !== 'undefined') {
    // A class or style change can turn any element into something clickable, so
    // the page's styles are re-read when it happens.
    observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && (r.attributeName === 'class' || r.attributeName === 'style')) {
          invalidateStyleCache();
          break;
        }
      }
      scheduleRebuild();
    });
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
