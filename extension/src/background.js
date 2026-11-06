// Her memory, which is nothing more than a list of paths you taught her.
//
// It lives here rather than in the page's localStorage on purpose: a path is a
// record of which buttons a site has and where they sit, and a site that could
// read or write that record could study the add-on or poison it. Nothing leaves
// the browser, and nothing but control names is kept at all.

'use strict';

const KEY = 'paths.v1';
const CAP = 80;                       // remembered routes, newest wins

function sameHost(a, b) {
  if (!a || !b) return true;
  const x = String(a).toLowerCase(), y = String(b).toLowerCase();
  return x === y || x.endsWith('.' + y) || y.endsWith('.' + x);
}

function stored(res) {
  return Array.isArray(res && res[KEY]) ? res[KEY] : [];
}

browser.runtime.onMessage.addListener((m) => {
  if (!m || typeof m.t !== 'string') return undefined;
  if (m.t.indexOf('paths:') !== 0) return undefined;

  return browser.storage.local.get(KEY).then((res) => {
    const list = stored(res);
    switch (m.t) {
      case 'paths:get':
        return { paths: list.filter((p) => sameHost(m.host, p.host)) };
      case 'paths:all':
        return { paths: list };
      case 'paths:put': {
        if (!m.path || !Array.isArray(m.path.steps) || !m.path.steps.length) {
          return { ok: false, reason: 'bad-path' };
        }
        const next = list.filter((p) => p.id !== m.path.id);
        next.push(m.path);
        return browser.storage.local.set({ [KEY]: next.slice(-CAP) })
          .then(() => ({ ok: true, count: Math.min(next.length, CAP) }));
      }
      case 'paths:del': {
        const next = list.filter((p) => p.id !== m.id);
        return browser.storage.local.set({ [KEY]: next }).then(() => ({ ok: true, count: next.length }));
      }
      case 'paths:clear':
        return browser.storage.local.set({ [KEY]: [] }).then(() => ({ ok: true, count: 0 }));
      default:
        return { ok: false, reason: 'unknown' };
    }
  });
});
