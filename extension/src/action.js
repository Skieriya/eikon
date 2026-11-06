// The toolbar popup. It owns no state: it asks the tab's content script what is
// going on and tells it what to do. A page where content scripts cannot run (a
// browser page, a webstore page, a PDF viewer) answers nothing, and says so.

(function () {
  'use strict';

  const api = (typeof browser !== 'undefined' && browser.tabs) ? browser : chrome;
  const stateEl = document.getElementById('state');
  const hideBtn = document.getElementById('hide');
  const routesEl = document.getElementById('routes');
  const routeList = document.getElementById('routelist');
  let tabId = null;
  let remembered = [];

  // ---- what she remembers about this site ------------------------------------
  // Stored per host in the add-on's own storage; this is the place to look at it
  // and the only place to take it away again.
  function showRoutes(list) {
    remembered = Array.isArray(list) ? list : [];
    routesEl.hidden = !remembered.length;
    routeList.textContent = '';
    for (const p of remembered) {
      const li = document.createElement('li');
      const steps = (p.steps || []).map((s) => s.find || String(s)).join(' → ');
      li.textContent = p.name + (steps ? ' — ' + steps : '');
      routeList.appendChild(li);
    }
  }

  function loadRoutes(host) {
    if (!host || !api.runtime || !api.runtime.sendMessage) return showRoutes([]);
    try {
      Promise.resolve(api.runtime.sendMessage({ t: 'paths:get', host }))
        .then((r) => showRoutes(r && r.paths))
        .catch(() => showRoutes([]));
    } catch (_) { showRoutes([]); }
  }

  document.getElementById('forget').addEventListener('click', () => {
    const kill = remembered.map((p) => () => api.runtime.sendMessage({ t: 'paths:del', id: p.id }));
    remembered = [];
    Promise.all(kill.map((f) => { try { return Promise.resolve(f()).catch(() => null); } catch (_) { return Promise.resolve(null); } }))
      .then(() => showRoutes([]));
  });

  function say(text, off) {
    stateEl.textContent = text;
    stateEl.classList.toggle('off', !!off);
  }

  function askTab(message) {
    return new Promise((resolve) => {
      if (!api || tabId === null) return resolve(null);
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      // A page with no content script rejects; a page with one that never
      // answers (an old frame) would otherwise leave the popup saying
      // "Checking…" forever, so the timeout is the other half of the contract.
      const timer = setTimeout(() => done(null), 1200);
      try {
        Promise.resolve(api.tabs.sendMessage(tabId, message))
          .then((r) => { clearTimeout(timer); done(r || null); })
          .catch(() => { clearTimeout(timer); done(null); });
      } catch (_) { clearTimeout(timer); done(null); }
    });
  }

  function paint(r) {
    if (!r) { say('She cannot run on this page.', true); hideBtn.disabled = true; return; }
    hideBtn.disabled = false;
    hideBtn.textContent = r.on ? 'Hide her' : 'Bring her back';
    if (!r.on) return say('Hidden on this page.', true);
    if (!r.count) return say('Nothing here she can point at.');
    say(r.current
      ? r.count + ' elements · looking at ' + r.current
      : r.count + ' elements · ' + (r.cycling ? 'walking the page' : 'ready'));
  }

  function command(t) {
    // Run it, then re-read the tab's state — the state is the only thing worth
    // painting, and asking for it after means it already reflects the command.
    askTab({ t }).then(() => askTab({ t: 'state' })).then(paint);
  }

  document.getElementById('ask').addEventListener('click', () => command('ask'));
  document.getElementById('hide').addEventListener('click', () => command('toggle'));
  document.getElementById('next').addEventListener('click', () => command('next'));
  document.getElementById('prev').addEventListener('click', () => command('previous'));
  document.getElementById('cycle').addEventListener('click', () => command('cycle'));

  if (api && api.tabs && api.tabs.query) {
    api.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      tabId = tabs && tabs[0] ? tabs[0].id : null;
      let host = '';
      try { host = new URL(tabs[0].url).hostname; } catch (_) {}
      loadRoutes(host);
      return askTab({ t: 'state' });
    }).then(paint).catch(() => paint(null));
  } else {
    say('No tab API here.', true);
  }
})();
