// The page-side half of the add-on: it owns nothing about Live2D and nothing about
// rendering. It does four jobs, in the site's own document:
//
//   1. compose the two extension frames over the page (her layer + the ask bar),
//   2. run the guide engine in this world so discovery reads the REAL DOM,
//   3. forward aim/hold/target geometry to her frame, and commands from the bar,
//   4. hold the keyboard shortcuts.
//
// The site never receives a message from her, and never hears from the bar: all
// three parties speak through here, and every message is checked against the
// extension origin plus a per-load nonce, so a page that guesses the message
// shape still cannot impersonate the panel or read a result.

(function () {
  'use strict';

  // A page can be re-injected (soft navigation, a second registration), and two
  // guides on one page would double every message.
  if (window.__hutaoGuideMounted) return;
  window.__hutaoGuideMounted = true;

  const EXT =
    (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getURL) ? browser :
    (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) ? chrome : null;

  // Messages from a frame back to here must carry this, or they came from the page.
  const NONCE = Math.random().toString(36).slice(2) + Date.now().toString(36);

  // Inside the add-on this is a moz-extension:// URL. Under tools/serve.py it is
  // the built folder's root, one level up from the _test/ fixture — which is how
  // the whole page-side stack gets verified without loading an add-on at all.
  function url(name, params) {
    const base = EXT ? EXT.runtime.getURL(name) : '../' + name;
    const u = new URL(base, document.baseURI);
    // The nonce rides in the frame's URL, so the handshake needs no message of
    // its own to be worth anything: only code that can read this world builds it.
    u.searchParams.set('n', NONCE);
    for (const k in params || {}) u.searchParams.set(k, params[k]);
    return u.href;
  }
  const ORIGIN = new URL(url('hutao.html'), document.baseURI).origin;

  // Harness hook: a fixture page may set window.__hutaoRaf = 'manual' before this
  // script runs, to put her frame on a clock it can advance by hand — a frame that
  // is never painted does not run requestAnimationFrame, and that is what makes
  // the page stack testable at all. Nothing sets it in normal use.
  const RAF = window.__hutaoRaf ? { raf: String(window.__hutaoRaf) } : null;

  const guide = { on: true, held: false, target: null, lastRect: '', sentSeq: 0, seq: 0, askOpen: false };
  let her = null, herFrame = null, bar = null, barFrame = null;
  let bridge = null, pump = 0;

  function frame(src, css) {
    const f = document.createElement('iframe');
    f.src = src;
    f.setAttribute('frameborder', '0');
    f.setAttribute('scrolling', 'no');
    f.setAttribute('aria-hidden', 'true');
    f.setAttribute('data-guide-exclude', '');
    f.setAttribute('title', 'Hu Tao guide');
    Object.assign(f.style, css);
    return f;
  }

  // A container per frame, so the frame itself never needs a style the site could
  // reach: only these few inline properties are written, through CSSOM (never a
  // style attribute, never a stylesheet, so a strict page CSP cannot veto them).
  function mount(name, css, frameCss, params) {
    const box = document.createElement('div');
    Object.assign(box.style, css);
    box.setAttribute('data-guide-exclude', '');
    const f = frame(url(name, params), frameCss);
    box.appendChild(f);
    (document.body || document.documentElement).appendChild(box);
    return [box, f];
  }

  function compose() {
    // Her layer: the whole viewport, because the gaze geometry is a viewport-space
    // map (aim at clip -1..1 across the page) and because the ring that marks the
    // target has to be able to light up anywhere on it. She herself is drawn in a
    // corner by her own model matrix; this frame only passes light through.
    [her, herFrame] = mount('hutao.html', {
      position: 'fixed', inset: '0', zIndex: '2147483646',
      pointerEvents: 'none', background: 'transparent', border: '0',
      margin: '0', padding: '0', width: '100%', height: '100%',
      overflow: 'hidden', colorScheme: 'normal',
    }, {
      width: '100%', height: '100%', border: '0', margin: '0', padding: '0',
      background: 'transparent', pointerEvents: 'none', display: 'block',
    }, RAF);

    // The ask bar: a small, real, interactive frame. The container stays click-
    // transparent and is resized to whatever height the bar reports, so an
    // collapsed bar never sits on top of a button it does not show.
    [bar, barFrame] = mount('panel.html', {
      position: 'fixed', left: '14px', bottom: '12px', width: '330px', height: '40px',
      zIndex: '2147483647', pointerEvents: 'none',
    }, {
      width: '100%', height: '100%', border: '0', margin: '0', padding: '0',
      background: 'transparent', pointerEvents: 'auto', display: 'block',
      overflow: 'hidden', colorScheme: 'light',
    });
  }

  // postMessage is the only channel to a frame, and it must not be a megaphone.
  function send(which, data) {
    const f = which === 'her' ? herFrame : barFrame;
    if (f && f.contentWindow) {
      data.n = NONCE;
      try { f.contentWindow.postMessage(data, ORIGIN); } catch (_) {}
    }
  }

  // ---- what she needs to know, and when -------------------------------------
  // The glide itself happens in her frame (see overlay.js): this side sends the
  // target once, then only keeps its box fresh while she holds it. `seq` is what
  // tells her frame that a NEW element took the place of the old one — back to
  // back commands never drop the hold, so a hold transition alone cannot say
  // "look at this other thing now", and she would keep aiming at the first box.
  function forwardHold() {
    const held = !!(bridge && bridge.isHeld && bridge.isHeld());
    const el = held && bridge.targetElement ? bridge.targetElement() : null;
    if (el !== guide.target) {
      guide.target = el;
      guide.lastRect = '';
      guide.seq++;
    }
    if (held !== guide.held) {
      guide.held = held;
      send('her', { t: 'hold', on: held });
      if (!held) { guide.lastRect = ''; send('her', { t: 'target', rect: null }); }
    }
  }

  function forwardRect() {
    if (!guide.held || !guide.target || !isLive(guide.target)) return;
    // rectOf, not getBoundingClientRect: the target may live inside a frame, and
    // its own rect is in that frame's viewport, not the one she is drawn over.
    const b = rectOf(guide.target);
    if (!b || !b.width || !b.height) return;
    // Viewport CSS pixels, which is her canvas's own space: no conversion here.
    const key = (b.left | 0) + ',' + (b.top | 0) + ',' + (b.width | 0) + ',' + (b.height | 0);
    if (key === guide.lastRect && guide.sentSeq === guide.seq) return;
    guide.lastRect = key;
    guide.sentSeq = guide.seq;
    send('her', { t: 'target', id: guide.seq, rect: { l: b.left, t: b.top, w: b.width, h: b.height } });
  }

  // A frame is only worth pumping while she is holding something: idle pages must
  // not pay for a rAF that has nothing to say.
  function startPump() {
    if (pump || typeof requestAnimationFrame !== 'function') return;
    const step = () => {
      pump = 0;
      if (!guide.on) return;
      forwardHold();
      forwardRect();
      if (guide.held) pump = requestAnimationFrame(step);
    };
    pump = requestAnimationFrame(step);
  }

  // ---- commands --------------------------------------------------------------
  function caption(text, kind) {
    send('her', { t: 'caption', text, kind });
    send('bar', { t: 'status', text, kind });
  }

  // A target below the fold is a target she would point at empty air. Bring it
  // into view and say nothing else: the pump already re-samples the live rect
  // every frame, so she tracks it the whole way down instead of aiming at where
  // it used to be. This is the only thing the add-on ever does to a page, and it
  // is a scroll — no clicks, no typing, no hidden elements.
  function reveal(el) {
    return !!el && scrollIntoViewDeep(el);
  }

  function run(text) {
    if (!window.UIGuide) return;
    return window.UIGuide.say(text, { instant: false }).then((out) => {
      startPump();
      const r = out && out.result || {};
      // A path speaks for itself: the engine captions each step as it takes it, so
      // this side must not paste a second line over hers.
      if (out && out.announced) { report(); return out; }
      if (r.ok) {
        const moved = reveal(bridge && bridge.targetElement ? bridge.targetElement() : null);
        if (moved) caption('Here it is — following it down', 'ok');
        else if (out.matched) caption('Looking at ' + out.matched, 'ok');
        else if (out.spoken && !NAVLIKE.has(out.spoken))
          caption(out.spoken, 'ok');
      } else if (out && out.noPath) {
        caption('I do not know that route yet — do it once and say “teach”, or type the way: settings → memory → chat history', 'error');
      } else if (r.reason === 'not-found') {
        caption('I cannot find “' + r.query + '” on this page', 'error');
      } else if (r.reason === 'element not visible') {
        caption('That is not on screen — try scrolling to it', 'error');
      } else if (r.reason && r.reason !== 'cancelled') {
        caption(String(r.reason), 'error');
      }
      report();
      return out;
    });
  }

  // Replies that mean "something else is talking now", not a result to read out.
  const NAVLIKE = new Set(['cycling', 'stopped', 'options', 'teaching', 'taught', 'onward', 'back', 'finished']);

  // The count, the current name and where she is in a path: what the bar paints.
  // A signature decides whether anything actually changed, because the engine
  // emits on every re-discovery and a busy site would otherwise pay for a
  // postMessage per mutation. `force` is for a frame that just loaded and knows
  // nothing yet.
  let lastSig = '', lastRoute = '', reportQueued = 0;
  function routeSig(s) {
    const p = s.path, t = s.teaching;
    return (p ? [p.i, p.n, p.awaiting, p.via, p.label].join('|') : '') + '#' + (t ? (t.steps || []).length : '');
  }
  function sig(s) {
    const p = s.path;
    return [s.count, s.cycling ? 1 : 0, s.current ? s.current.label : '',
      p ? [p.name, p.i, p.n, p.awaiting, p.via, p.label].join('|') : '',
      s.teaching ? 'T' + (s.teaching.steps || []).length : '', s.known || 0].join('~');
  }

  function report(force) {
    if (!window.UIGuide) return;
    const s = window.UIGuide.status();
    const key = sig(s);
    if (!force && key === lastSig) return;
    lastSig = key;
    lastRoute = routeSig(s);
    send('bar', {
      t: 'state',
      count: s.count,
      cycling: s.cycling,
      current: s.current ? s.current.label : null,
      path: s.path || null,
      teaching: s.teaching || null,
      known: s.known || 0,
    });
  }

  // ---- what she remembers ----------------------------------------------------
  // Learned paths live in the add-on's own storage, not the page's: they name
  // buttons on someone else's site, and a site must not be able to read or poison
  // what she keeps about it. Fetched once per page, for this host only.
  function sameHost(a, b) {
    if (!a || !b) return true;
    const x = String(a).toLowerCase(), y = String(b).toLowerCase();
    return x === y || x.endsWith('.' + y) || y.endsWith('.' + x);
  }

  // Only ever the routes for the site being looked at: the store holds every
  // site's routes, and a page must not learn how another site works.
  function applyPaths(list) {
    if (!window.UIGuide) return;
    const mine = (Array.isArray(list) ? list : []).filter((p) => sameHost(p.host, location.hostname));
    window.UIGuide.setPaths(mine);
    report();
  }

  function loadPaths() {
    if (!EXT || !EXT.runtime || !EXT.runtime.sendMessage || !window.UIGuide) return;
    try {
      Promise.resolve(EXT.runtime.sendMessage({ t: 'paths:get', host: location.hostname }))
        .then((res) => { if (res && Array.isArray(res.paths)) applyPaths(res.paths); })
        .catch(() => {});
    } catch (_) { /* no runtime here (the harness) — the bundled table still works */ }
  }

  function rememberPath(plan) {
    if (!EXT || !EXT.runtime || !EXT.runtime.sendMessage) return;
    try { EXT.runtime.sendMessage({ t: 'paths:put', path: plan }).catch(() => {}); } catch (_) {}
  }

  function setVisible(on) {
    guide.on = on;
    if (her) her.style.display = on ? '' : 'none';
    if (bar) bar.style.display = on ? '' : 'none';
    if (!on) dragEnd();
    send('bar', { t: 'visible', on });
    if (on) { report(); if (guide.held) startPump(); }
  }

  // ---- input plumbing --------------------------------------------------------
  // Alt+Shift+letter: no site layout produces a character with it, and it is out
  // of the way of both browser and OS chords. Escape is only claimed while she is
  // holding a target, so a modal that wants it first can have it.
  const KEYS = {
    A: () => ask(),
    N: () => run('next'),
    P: () => run('previous'),
    C: () => run(window.UIGuide && window.UIGuide.status().cycling ? 'stop' : 'cycle'),
  };

  function ask() {
    setVisible(true);
    send('bar', { t: 'open', on: true });
    guide.askOpen = true;
    try { barFrame.focus(); } catch (_) {}
  }

  function onKey(e) {
    if (!e || !e.isTrusted) return;
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const fn = KEYS[String(e.code || '').replace(/^Key/, '')];
      if (fn) { e.preventDefault(); e.stopPropagation(); fn(); return; }
    }
    if (e.key === 'Escape' && guide.held) {
      e.preventDefault();
      run('stop');
    }
  }

  function onPointer(e) {
    // Her frame swallows nothing, so the cursor's position has to be told to her.
    // Aim is viewport-space, which is what her own canvas rect measures.
    if (!guide.on || !window.UIGuide) return;
    send('her', { t: 'mouse', x: e.clientX, y: e.clientY });
    if (drag) return;
    const hit = herHit(e.clientX, e.clientY);
    cursor(hit === 'grip' ? 'nwse-resize' : hit ? 'grab' : '');
  }

  // ---- moving her ------------------------------------------------------------
  // Her layer is click-through by design, so the page has to be the one that
  // decides when a press was meant for her: she reports the box her own art fills,
  // and a press starting inside it is hers. Everywhere else the site behaves
  // exactly as it did before she arrived.
  let box = null, gripPx = 26, drag = null;
  const CUR = document.createElement('style');
  CUR.setAttribute('data-guide-exclude', '');

  function cursor(kind) {
    if (!CUR.parentNode && document.head) document.head.appendChild(CUR);
    const css = kind ? 'html{cursor:' + kind + '!important}' : '';
    if (CUR.textContent !== css) CUR.textContent = css;
  }

  // 'body' grabs her, 'grip' resizes her, null leaves the page alone.
  function herHit(x, y) {
    if (!box || !box.w || !box.h) return null;
    if (x < box.l || y < box.t || x > box.l + box.w || y > box.t + box.h) return null;
    return (x >= box.l + box.w - gripPx && y >= box.t + box.h - gripPx) ? 'grip' : 'body';
  }

  function dragMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.kind === 'grip') send('her', { t: 'size', dy });      // pull up = bigger
    else send('her', { t: 'move', dx, dy });
  }

  function dragEnd() {
    if (drag) { drag = null; cursor(''); }
    window.removeEventListener('pointermove', dragMove, true);
    window.removeEventListener('pointerup', dragEnd, true);
    window.removeEventListener('pointercancel', dragEnd, true);
  }

  // Both entry points go through here, so the harness can drive a real grab by
  // coordinates and exercise the same hit-testing a pointer event would.
  function grab(x, y, kind) {
    if (drag || !guide.on) return false;
    drag = { x, y, kind: kind || 'body' };
    cursor(drag.kind === 'grip' ? 'nwse-resize' : 'grabbing');
    window.addEventListener('pointermove', dragMove, true);
    window.addEventListener('pointerup', dragEnd, true);
    window.addEventListener('pointercancel', dragEnd, true);
    return true;
  }

  function onDown(e) {
    if (!e || !e.isTrusted || drag || !guide.on) return;
    const hit = herHit(e.clientX, e.clientY);
    if (!hit) return;
    // Capture phase, and the site under her never learns the press happened.
    e.preventDefault(); e.stopPropagation();
    grab(e.clientX, e.clientY, hit);
  }

  function onWheel(e) {
    if (!e || !e.isTrusted || drag || !guide.on) return;
    if (!herHit(e.clientX, e.clientY)) return;
    e.preventDefault(); e.stopPropagation();
    send('her', { t: 'size', dy: Math.max(-60, Math.min(60, e.deltaY)) * 0.5 });
  }

  // The escape hatch: she is small, and a corner is easy to lose behind a banner.
  function onDouble(e) {
    if (!e || !e.isTrusted || !guide.on) return;
    if (herHit(e.clientX, e.clientY) === 'body') {
      e.preventDefault(); e.stopPropagation();
      send('her', { t: 'dockreset' });
    }
  }

  function onMessage(e) {
    if (!e || e.origin !== ORIGIN) return;
    const d = e.data;
    if (!d || d.n !== NONCE) return;
    switch (d.t) {
      case 'ready':                       // she asked for a page: hand over the state
        send('bar', { t: 'visible', on: guide.on });
        report(true);
        break;
      case 'say': run(String(d.text || '').slice(0, 300)); break;
      case 'step': run(d.delta && d.delta < 0 ? 'previous' : 'next'); break;
      case 'cycle': run('cycle'); break;
      case 'stop': run('stop'); break;
      case 'list': send('bar', { t: 'list', items: window.UIGuide ? window.UIGuide.status().items : [] }); break;
      case 'jump': run(window.UIGuide ? 'go ' + (d.label || '') : ''); break;
      case 'height':
        if (bar) bar.style.height = Math.max(36, Math.min(420, Number(d.h) || 40)) + 'px';
        break;
      case 'dock':                          // where her art now is, for hit-testing
        if (d.rect) { box = d.rect; gripPx = Number(d.grip) || gripPx; }
        break;
      case 'close': guide.askOpen = false; break;
      case 'hide': setVisible(false); break;
      case 'ping': send('bar', { t: 'pong' }); break;
    }
  }

  function onRuntime(m, sender) {
    // Only the tab this script is actually running in, if the runtime tells us.
    if (sender && sender.tab && document.URL !== sender.tab.url) return;
    const t = m && m.t;
    if (t === 'toggle') setVisible(!guide.on);
    else if (t === 'show') setVisible(true);
    else if (t === 'ask') { setVisible(true); ask(); }
    else if (t === 'next' || t === 'previous' || t === 'cycle' || t === 'stop') { setVisible(true); run(t); }
    else if (t === 'state') {
      const s = window.UIGuide ? window.UIGuide.status() : { count: 0, current: null, cycling: false };
      return Promise.resolve({ on: guide.on, count: s.count, cycling: s.cycling, current: s.current && s.current.label });
    }
    return undefined;
  }

  function start() {
    compose();
    // The real bridge, over a fake canvas: its rect() is her container, which IS
    // the viewport, so its screen->clip map is the one her canvas uses. That buys
    // the identical geometry the demo page has, with no second implementation.
    bridge = createLive2dGuideBridge({
      canvas: herFrame,
      sensitivity: 1 / 0.6,          // same reach as the demo page
      smoothing: 12,
      onGesture: () => send('her', { t: 'gesture' }),
    });
    // mountGuide is guide/index.js's drop-in entry; it takes the bridge as given
    // and never tries to drive a canvas in this document. `caption` and `remember`
    // are the two things only this side can do: put words on her, and keep what
    // she learns between pages.
    window.mountGuide({ bridge, gaze: { duration: 640, holdMs: 1500 }, caption, remember: rememberPath });
    loadPaths();

    // A click that advances a step is not a command this side sent, so the bar
    // learns about it from the engine — debounced, because the engine emits on
    // every re-discovery and a chatty site would otherwise buy a postMessage each.
    if (window.UIGuide && window.UIGuide.subscribe) {
      window.UIGuide.subscribe(() => {
        // A step that moved must reach the bar in the same breath; a page merely
        // reshuffling its DOM can wait for the debounce.
        const s = window.UIGuide.status();
        if (routeSig(s) !== lastRoute) { report(); return; }
        if (reportQueued) return;
        reportQueued = setTimeout(() => { reportQueued = 0; report(); }, 90);
      });
    }

    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('dblclick', onDouble, true);
    // Default-passive at document level in both browsers, and resizing her needs
    // preventDefault so the page under her does not scroll at the same time.
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    window.addEventListener('message', onMessage);
    if (EXT && EXT.runtime && EXT.runtime.onMessage) EXT.runtime.onMessage.addListener(onRuntime);
    // The popup can make her forget a route while this page is still open, and
    // a route the user has just deleted is one she must not go on walking.
    if (EXT && EXT.storage && EXT.storage.onChanged && EXT.storage.onChanged.addListener) {
      EXT.storage.onChanged.addListener((changes, area) => {
        if (area && area !== 'local') return;
        for (const k in changes) {
          const next = changes[k] && changes[k].newValue;
          if (Array.isArray(next)) { applyPaths(next); return; }
        }
      });
    }

    report();
    // Diagnostics, and the hook a harness drives when the frame it is in never
    // paints: pump() does in one call what the rAF pump does per frame.
    window.__hutaoGlue = {
      run, report, startPump, setVisible, grab, dragEnd, hit: herHit,
      pump() { forwardHold(); forwardRect(); },
      send,
      get state() { return { on: guide.on, held: guide.held, askOpen: guide.askOpen, rect: guide.lastRect }; },
      get box() { return box; },
      get count() { return window.UIGuide ? window.UIGuide.status().count : 0; },
      queue() { return window.UIGuide ? window.UIGuide.status().items : []; },
      get path() { return window.UIGuide ? window.UIGuide.pathStatus() : null; },
      get paths() { return window.UIGuide ? window.UIGuide.knownPaths : []; },
    };
    console.log('[HUTAO] guide on this page —', window.UIGuide.status().count, 'element(s)');
  }

  // document_idle already lands after body; keep a poll for the odd frame that
  // does not (and for a body a script replaces outright).
  if (document.body) start();
  else {
    const wait = setInterval(() => {
      if (document.body) { clearInterval(wait); start(); }
    }, 50);
    setTimeout(() => clearInterval(wait), 8000);
  }
})();
