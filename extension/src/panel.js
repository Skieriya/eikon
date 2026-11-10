// The ask bar's brain. It knows nothing about the page, about Live2D, or about
// elements: it turns clicks and keystrokes into commands for the content script
// and paints whatever state that script reports back. That is the whole contract,
// which is why this file can stay this small.

(function () {
  'use strict';

  const Q = new URLSearchParams(location.search);
  const NONCE = Q.get('n') || null;
  const guide = { count: 0, current: null, cycling: false, open: false, path: null, teaching: null, known: 0 };
  let items = [];

  const el = {
    q: document.getElementById('q'),
    count: document.getElementById('count'),
    prev: document.getElementById('prev'),
    next: document.getElementById('next'),
    cycle: document.getElementById('cycle'),
    more: document.getElementById('more'),
    sheet: document.getElementById('sheet'),
    status: document.getElementById('status'),
    list: document.getElementById('list'),
    steps: document.getElementById('steps'),
    pathName: document.getElementById('pathName'),
    pathNote: document.getElementById('pathNote'),
    pathSteps: document.getElementById('pathSteps'),
    pathRow: document.getElementById('pathRow'),
    skip: document.getElementById('skip'),
    pback: document.getElementById('pback'),
    pstop: document.getElementById('pstop'),
    teach: document.getElementById('teach'),
    known: document.getElementById('known'),
  };

  function send(data) {
    data.n = NONCE;
    try { parent.postMessage(data, replyTo()); } catch (_) {}
  }

  // Where a reply may go. As an embedded frame the referrer is the page we are
  // sitting on; loaded straight as a tab (the harness opens it both ways) there is
  // no parent to talk to at all, and every send is a no-op.
  function replyTo() {
    try { return document.referrer ? new URL(document.referrer).origin : '*'; } catch (_) { return '*'; }
  }

  // The container in the page is sized to exactly this document's content height,
  // so a collapsed bar covers a pill and never a strip of the site's buttons.
  function reportHeight() {
    const h = Math.ceil(document.body.getBoundingClientRect().height);
    send({ t: 'height', h: Math.max(36, h) });
  }

  function setOpen(on) {
    guide.open = !!on;
    document.body.classList.toggle('open', guide.open);
    el.more.setAttribute('aria-expanded', String(guide.open));
    if (guide.open) requestAnimationFrame(reportHeight);
    else reportHeight();
  }

  function status(text, kind) {
    el.status.textContent = text || '';
    el.status.className = kind || '';
    if (text && !guide.open) setOpen(true);
  }

  function paintCount() {
    el.count.textContent = guide.count ? guide.count + ' here' : '';
    el.prev.disabled = el.next.disabled = guide.count < 1;
    el.cycle.classList.toggle('on', !!guide.cycling);
    el.cycle.textContent = guide.cycling ? 'Stop' : 'Cycle';
  }

  function paintList() {
    el.list.textContent = '';
    if (!items.length) {
      const none = document.createElement('span');
      none.textContent = 'Nothing she can point at yet.';
      el.list.appendChild(none);
      return;
    }
    // In queue order, which is document order with each panel followed by its own
    // controls — the same walk Alt+Shift+N takes, so the list teaches the ring.
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = (it.depth ? '· '.repeat(it.depth) : '') + it.label;
      b.title = it.label + '  (' + it.kind + ')';
      b.classList.toggle('here', !!guide.current && guide.current === it.label);
      b.addEventListener('click', () => send({ t: 'jump', label: it.label }));
      el.list.appendChild(b);
    }
  }

  function ask() {
    const text = el.q.value.trim();
    if (!text) return;
    el.q.value = '';
    send({ t: 'say', text });
  }

  // ---- the route she is walking, or learning ---------------------------------
  // This frame is told nothing about elements or pages: it draws the step list the
  // content script reports, and every control here is just one of the same little
  // sentences you could have typed ("next", "previous", "stop", "done").
  function paintSteps(rows, placeholder) {
    el.pathSteps.textContent = '';
    for (const r of rows) {
      const li = document.createElement('li');
      li.textContent = r.label;
      if (r.cls) li.className = r.cls;
      el.pathSteps.appendChild(li);
    }
    if (!rows.length && placeholder) {
      const li = document.createElement('li');
      li.textContent = placeholder;
      el.pathSteps.appendChild(li);
    }
  }

  function paintRoute() {
    const t = guide.teaching, p = guide.path;
    el.steps.classList.toggle('show', !!(t || p));
    el.known.textContent = guide.known
      ? guide.known + ' route' + (guide.known === 1 ? '' : 's') + ' remembered'
      : '';
    el.teach.textContent = t ? 'Done — remember it' : 'Teach her a route';
    if (t) {
      el.pathName.textContent = 'Watching — do it the way you would';
      el.pathNote.textContent = t.goal
        ? 'Saving this as “' + t.goal + '”.'
        : 'Click each control in turn, then say done. Ask her about it by name afterwards.';
      paintSteps((t.steps || []).map((s, i) => ({ label: s, cls: i === t.steps.length - 1 ? 'now' : 'done' })), 'nothing yet');
      el.pathRow.style.display = 'none';
      if (!guide.open) setOpen(true);
      return;
    }
    if (!p) {
      el.pathRow.style.display = 'none';
      el.pathName.textContent = '';
      el.pathNote.textContent = '';
      paintSteps([]);
      return;
    }
    el.pathRow.style.display = '';
    el.pathName.textContent = p.name;
    el.pback.disabled = !(p.i > 0);
    const now = p.label || p.find || '…';
    const act = p.via === 'hover' ? 'hover over' : p.via === 'either' ? 'hover over' : 'click';
    const alt = p.via === 'either' ? ' (click it if nothing opens)' : '';
    el.pathNote.textContent = p.awaiting === 'settle'
      ? 'Waiting for the page to catch up…'
      : p.awaiting === 'missing'
        ? '“' + now + '” is not on this page yet. Open it and she will pick it up.'
        : p.awaiting === 'reveal'
          ? '“' + now + '” is not out yet — ' + act + ' “' + (p.reveal || 'the menu') + '” to open it, then she takes over.'
          : 'Step ' + (p.i + 1) + ' of ' + p.n + ' — ' + act + ' “' + now + '”' + alt + '. She waits for you.';
    paintSteps((p.steps || []).map((s, i) => ({
      label: s,
      cls: i < p.i ? 'done' : i === p.i ? ((p.awaiting === 'missing' || p.awaiting === 'reveal') ? 'stuck now' : 'now') : '',
    })));
  }

  el.q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); ask(); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); send({ t: 'close' }); }
  });
  el.q.addEventListener('focus', () => setOpen(true));
  el.next.addEventListener('click', () => send({ t: 'step', delta: 1 }));
  el.prev.addEventListener('click', () => send({ t: 'step', delta: -1 }));
  el.cycle.addEventListener('click', () => send({ t: guide.cycling ? 'stop' : 'cycle' }));
  el.more.addEventListener('click', () => {
    if (guide.open) setOpen(false);
    else { setOpen(true); send({ t: 'list' }); }
  });
  el.skip.addEventListener('click', () => send({ t: 'say', text: 'next' }));
  el.pback.addEventListener('click', () => send({ t: 'say', text: 'previous' }));
  el.pstop.addEventListener('click', () => send({ t: 'say', text: 'stop' }));
  // Typing a name first makes the lesson findable later; bare Teach still works,
  // she just names it after the controls she saw.
  el.teach.addEventListener('click', () => {
    const named = el.q.value.trim();
    if (guide.teaching || !named) send({ t: 'say', text: guide.teaching ? 'done' : 'teach' });
    else { el.q.value = ''; send({ t: 'say', text: 'teach ' + named }); }
    el.q.blur();
  });

  window.addEventListener('message', (e) => {
    const d = e && e.data;
    if (!d || typeof d !== 'object') return;
    if (NONCE !== null && d.n !== NONCE) return;
    if (e.source !== window.parent) return;

    switch (d.t) {
      case 'state':
        guide.count = Number(d.count) || 0;
        guide.current = d.current || null;
        guide.cycling = !!d.cycling;
        guide.path = d.path || null;
        guide.teaching = d.teaching || null;
        guide.known = Number(d.known) || 0;
        paintCount();
        paintList();
        paintRoute();
        reportHeight();
        break;
      case 'list':
        items = Array.isArray(d.items) ? d.items : [];
        paintList();
        reportHeight();
        break;
      case 'status':
        status(String(d.text || ''), d.kind);
        break;
      case 'open':
        setOpen(true);
        el.q.focus();
        el.q.select();
        break;
      case 'visible':
        if (d.on === false) setOpen(false);
        break;
    }
  });

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(reportHeight).observe(document.body);
  }
  window.addEventListener('blur', () => { if (guide.open) setOpen(false); });

  paintCount();
  paintRoute();
  reportHeight();
  send({ t: 'ready', n: NONCE });
})();
