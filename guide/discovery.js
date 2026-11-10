// Discover every UI element on the page and turn it into a labelled, searchable
// tree. Landmarks (nav / section / header / footer) hold their controls as
// subcontents, but each subcontent is also its own addressable node, so the
// guide can route to a whole panel ("FAQ") or to a single field ("email") and
// look at exactly the right spot.
//
// Three things have to be reached, not one:
//
//   1. markup that announces itself — a link, a button, a field, a role;
//   2. markup that announces nothing — a <div> that takes focus, has a click
//      handler, or shows a pointer cursor. Most modern menus and settings lists
//      are built out of exactly these, and a guide that reads only semantics
//      cannot see the row holding the setting you asked about;
//   3. the rest of the page — open shadow roots and same-origin frames. A
//      document-level querySelectorAll sees neither, so a portal menu mounted in
//      a shadow root is invisible while it is on screen, and a settings panel
//      that is really another document does not exist at all. Both are walked
//      here, and every node remembers the frames it lives behind so its rect can
//      still be expressed in the top viewport — the only space she can aim in.

const LANDMARK_SELECTOR = 'nav, header, footer, [role=navigation], [role=main], [role=contentinfo], [role=tablist], section[id]';
const ROLE_CONTROL = '[role=button], [role=link], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=switch], [role=tab], [role=checkbox], [role=radio], [role=option], [role=combobox], [role=treeitem]';
const INTERACTIVE = `a[href], button, input:not([type=hidden]), select, textarea, ${ROLE_CONTROL}`;
const SEMANTIC_CONTROL = `${INTERACTIVE}, form`;
const EXTRA_SELECTOR = '[data-guide], [data-guide-alias], [data-guide-label]';
const SELECTOR = `${LANDMARK_SELECTOR}, ${SEMANTIC_CONTROL}, ${EXTRA_SELECTOR}`;

// A form is addressable but is never the thing you press, so it is deliberately
// not in this list.
const PRESSABLE_SELECTOR = INTERACTIVE;

const EXCLUDE_TAGS = new Set(['CANVAS', 'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT']);

// How deep the page is allowed to hide things. Deeper than this is a frame inside
// a frame inside a shadow root, and walking it costs more than it can return.
const MAX_NESTING = 4;
const MAX_ROOTS = 10;
const SCAN_BUDGET = 12000;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'or', 'my', 'me', 'i',
  'please', 'can', 'you', 'show', 'where', 'go', 'get', 'open', 'find', 'click',
]);

// Alternate words for the same place, so "preferences" finds Settings and
// "personalisation" finds Personalization on either side of the Atlantic.
const SYNONYMS = {
  faq: ['question', 'questions', 'answer', 'answers', 'help', 'support'],
  help: ['faq', 'support', 'assist', 'questions'],
  signup: ['sign', 'account', 'register', 'registration', 'join', 'create', 'subscribe'],
  account: ['signup', 'sign', 'register', 'profile', 'user'],
  register: ['signup', 'sign', 'account', 'join'],
  email: ['mail', 'e-mail', 'address'],
  password: ['pass', 'pwd', 'secret'],
  name: ['fullname', 'username', 'user'],
  contact: ['reach', 'getintouch', 'support'],
  pricing: ['price', 'plans', 'cost', 'tier', 'billing', 'buy'],
  about: ['story', 'company', 'team'],
  home: ['main', 'top', 'start', 'dashboard'],
  features: ['feature', 'capabilities', 'capability'],
  settings: ['setting', 'preferences', 'options', 'configuration', 'config'],
  personalization: ['personalisation', 'personalize', 'personalise', 'customization'],
  memory: ['memories', 'remember', 'recall'],
};

// ---- where an element actually lives -----------------------------------------
// An element inside a frame reports a rect in ITS viewport. She aims in the top
// viewport, so the frames between here and there have to be added back on, live:
// the page scrolls, the frame moves, and a rect cached at discovery time would be
// wrong by the time she finished turning around.
const frameChain = new WeakMap();
const NO_CHAIN = [];

function viewOf(el) {
  return (el && el.ownerDocument && el.ownerDocument.defaultView) || window;
}

function rootOf(el) {
  try { return el.getRootNode ? el.getRootNode() : el.ownerDocument; } catch (_) { return el.ownerDocument; }
}

function chainOf(el) {
  return (el && frameChain.get(el)) || NO_CHAIN;
}

function rectOf(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  let r;
  try { r = el.getBoundingClientRect(); } catch (_) { return null; }
  const chain = chainOf(el);
  if (!chain.length) return r;
  let left = r.left, top = r.top;
  for (let i = chain.length - 1; i >= 0; i--) {
    const f = chain[i];
    if (!f.isConnected) return null;
    const fr = f.getBoundingClientRect();
    left += fr.left + (f.clientLeft || 0);
    top += fr.top + (f.clientTop || 0);
  }
  return { left, top, width: r.width, height: r.height, right: left + r.width, bottom: top + r.height };
}

// Connected in its own document is not enough: the frame holding it may have been
// thrown away by a re-render, which is exactly when a guide must look again.
function isLive(el) {
  if (!el || !el.isConnected) return false;
  for (const f of chainOf(el)) if (!f.isConnected) return false;
  return true;
}

// One step up the real tree: out of a shadow root through its host, out of a
// frame document through the frame element. parentElement alone stops at both.
function parentEl(el) {
  if (!el) return null;
  if (el.parentElement) return el.parentElement;
  const root = rootOf(el);
  if (root && root.host) return root.host;
  const doc = el.ownerDocument;
  const view = doc && doc.defaultView;
  return (view && view.frameElement) || null;
}

function closestDeep(el, selector) {
  let n = el;
  let hops = 0;
  while (n && n.nodeType === 1 && hops++ < 200) {
    try { if (n.matches(selector)) return n; } catch (_) { return null; }
    n = parentEl(n);
  }
  return null;
}

// Scrolling happens in the document that owns the element, and then again in
// every document above it if the frame itself is the thing off screen.
function scrollIntoViewDeep(el) {
  const r = rectOf(el);
  if (!r || !r.width || !r.height) return false;
  const vw = window.innerWidth, vh = window.innerHeight;
  const opts = { block: 'center', inline: 'nearest', behavior: 'smooth' };
  if (r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw) return false;
  try { el.scrollIntoView(opts); } catch (_) { return false; }
  const chain = chainOf(el);
  for (let i = chain.length - 1; i >= 0; i--) {
    const f = chain[i];
    const fr = f.getBoundingClientRect();
    if (fr.top >= 0 && fr.left >= 0 && fr.bottom <= vh && fr.right <= vw) continue;
    try { f.scrollIntoView(opts); } catch (_) { /* the frame is gone; nothing to scroll */ }
  }
  return true;
}

// The native closest() answers for anything in the top document, which is nearly
// everything; only an element behind a shadow root or inside a frame needs the
// climb, and there are few of those.
function guideExcluded(el) {
  if (el.closest('[data-guide-exclude]')) return true;
  if (rootOf(el) === el.ownerDocument && el.ownerDocument === document) return false;
  return !!closestDeep(el, '[data-guide-exclude]');
}

function makeIsVisible(exclude) {
  const excluded = new Set(exclude || []);
  return function isVisible(el) {
    if (EXCLUDE_TAGS.has(el.tagName)) return false;
    if (el.hasAttribute('hidden')) return false;
    if (excluded.has(el)) return false;                       // host-supplied (e.g. the canvas)
    for (const ex of excluded) { if (ex.contains && ex.contains(el)) return false; }
    if (guideExcluded(el)) return false;                      // the guide's own controls
    const style = viewOf(el).getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
}

function slug(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function cleanText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

// A caret, a chevron or an icon is decoration, not part of a name: reading
// "Platform▾" out loud is reading the furniture. Anything the page itself marks
// as hidden, and the usual names for a glyph, is left out of the label.
const DECORATIVE = 'svg, small, [aria-hidden="true"], .caret, .chevron, .arrow, .icon, .glyph, .indicator, .sr-only, .visually-hidden';
function textOf(el) {
  let bad = null;
  try { bad = el.querySelectorAll(DECORATIVE); } catch (_) { bad = null; }
  if (!bad || !bad.length) return cleanText(el.textContent);
  let out = '';
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { out += c.nodeValue; continue; }
      if (c.nodeType !== 1) continue;
      try { if (c.matches(DECORATIVE)) continue; } catch (_) { continue; }
      walk(c);
    }
  };
  walk(el);
  return cleanText(out);
}

function labelFor(el, holdsControl) {
  if (el.dataset.guideLabel) return el.dataset.guideLabel;
  const aria = el.getAttribute('aria-label');
  if (aria) return cleanText(aria);
  // An icon-only control is still named by the picture inside it.
  if (!cleanText(el.textContent)) {
    const img = el.querySelector('img[alt], svg title');
    const alt = img && (img.getAttribute('alt') || img.textContent);
    if (alt && cleanText(alt)) return cleanText(alt);
  }
  const title = el.getAttribute('title');
  if (title) return cleanText(title);

  const tag = el.tagName.toLowerCase();
  const root = rootOf(el) || el.ownerDocument;

  if (tag === 'input') {
    if (el.placeholder) return cleanText(el.placeholder);
    if (el.id) {
      const lab = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return cleanText(lab.textContent);
    }
    if (el.name) return cleanText(el.name);
    return 'field';
  }

  if (tag === 'form') {
    const h = el.querySelector('h1,h2,h3,legend,[aria-label]');
    if (h) return cleanText(h.textContent || h.getAttribute('aria-label'));
    return 'form';
  }

  // Landmarks / sections: take their heading if present, else the id.
  const heading = el.querySelector(':scope > h1, :scope > h2, :scope > h3');
  if (heading) return cleanText(heading.textContent);

  // Only fall back to textContent when the element holds no control of its own.
  // A nav/header holding rows must NOT be labelled with all those rows' text,
  // or it would swallow every child's words and win matches that belong to the
  // row itself.
  if (!holdsControl && !el.querySelector(INTERACTIVE)) {
    const text = textOf(el);
    // A lone initial or glyph is not a name — an avatar button reading "S" is
    // better called by its id or test id than by the letter on it.
    if (text.length > 1) return text.slice(0, 40);
    if (text && !el.id && !el.getAttribute('data-testid')) return text;
    // Stripping the decoration can leave nothing at all: an icon-only button
    // whose only words were inside the svg still has a name in its title.
    if (!text) {
      const img = el.querySelector('img[alt], svg title');
      const alt = img && (img.getAttribute('alt') || img.textContent);
      if (alt && cleanText(alt)) return cleanText(alt);
    }
  }
  if (el.id) return el.id;
  const testid = el.getAttribute('data-testid');
  if (testid) return cleanText(testid);
  return el.tagName.toLowerCase();
}

function tokenWords(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function aliasesFor(el, label) {
  const set = new Set();
  tokenWords(label).forEach((w) => set.add(w));
  // Compact forms ("sign up" -> "signup") so both spellings match.
  label.toLowerCase().replace(/\s+/g, '').split(/[^a-z0-9]+/).forEach((w) => { if (w.length >= 3) set.add(w); });

  // Form controls: their semantic field name beats the placeholder text, so
  // "email" / "password" / "name" route to the individual field, not the form.
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    if (el.name) tokenWords(el.name).forEach((w) => set.add(w));
    if (el.type && el.type !== 'text' && el.type !== 'submit') tokenWords(el.type).forEach((w) => set.add(w));
    if (el.id) slug(el.id).split('-').forEach((w) => { if (w.length >= 3) set.add(w); });
  }

  // A row the app marks with a test id or a tooltip is still that row, whatever
  // the words on it happen to be.
  const testid = el.getAttribute('data-testid');
  if (testid) tokenWords(testid.replace(/[-_]+/g, ' ')).forEach((w) => set.add(w));
  const title = el.getAttribute('title');
  if (title) tokenWords(title).forEach((w) => set.add(w));

  const dataAliases = (el.dataset.guideAlias || '').split(/[,\s]+/).filter(Boolean);
  dataAliases.forEach((a) => set.add(a.toLowerCase()));
  // Expand synonyms for every alias token already present.
  Array.from(set).forEach((w) => {
    (SYNONYMS[w] || []).forEach((s) => set.add(s));
  });
  return Array.from(set);
}

function idFor(el, label, index) {
  if (el.dataset.guideId) return el.dataset.guideId;
  if (el.id) return el.id;
  const s = slug(label);
  return s ? `${s}-${index}` : `el-${index}`;
}

function kindOf(el) {
  const tag = el.tagName.toLowerCase();
  if (/^(nav|header|footer|section)$/.test(tag) || /^(navigation|main|contentinfo|tablist)$/.test(el.getAttribute('role') || '')) {
    return 'landmark';
  }
  return 'control';
}

// ---- controls that only behave like controls --------------------------------
function hasClickHandler(el) {
  try {
    if (typeof el.onclick === 'function') return true;
    if (el.hasAttribute('onclick')) return true;
  } catch (_) { /* a property read on a cross-origin frame throws */ }
  return false;
}

function isFocusable(el) {
  try {
    if (el.isContentEditable) return true;
    if (!el.hasAttribute('tabindex')) return false;
    return el.tabIndex >= 0;
  } catch (_) { return false; }
}

function pointerCursor(el) {
  let v = cursorCache.get(el);
  if (v === undefined) {
    try { v = viewOf(el).getComputedStyle(el).cursor === 'pointer'; }
    catch (_) { v = false; }
    cursorCache.set(el, v);
  }
  return v;
}

// A class or style change can turn any element into a pointer, so the answers
// are thrown away when the page's styles move.
let cursorCache = new WeakMap();
let hoverCache = new WeakMap();
function invalidateStyleCache() { cursorCache = new WeakMap(); hoverCache = new WeakMap(); }

// ---- levels that open under the pointer --------------------------------------
// A dropdown does not have to be clicked. Nav bars, flyouts and mega-menus reveal
// their next level on :hover, and nothing ever lands on them as a press — so the
// evidence has to come from the stylesheet that hides the submenu and from the
// handlers the element carries, not from waiting for a click that never comes.
const HOVER_ATTRS = ['onmouseover', 'onmouseenter', 'onpointerover', 'onpointerenter'];
const MENUISH = 'ul, [role=menu], [role=group], .dropdown-menu, .dropdown, .submenu, .sub-menu, .flyout, .popover, .menu';
const HOVER_HINT = /dropdown|drop-down|submenu|sub-menu|flyout|has-children|has-popup|menu-item|nav-item|navbar|megamenu/i;
const MAX_BASES = 200;
const BASES_TTL_MS = 10000;
const hoverBases = new WeakMap();

// The part of a ":hover" selector before the pseudo-class is the thing you have
// to rest on: ".nav-item:hover .submenu" opens on .nav-item. Only rules that
// actually reveal something count — ".btn:hover { background: … }" is a colour
// change, not a level, and treating it as one would make every button a menu.
// A bare tag ("li") is too common to mean anything on its own, so it is kept but
// marked generic and has to be hiding a menu to be believed.
function cssHoverBases(doc) {
  const hit = hoverBases.get(doc);
  const sheets = doc ? doc.styleSheets : null;
  const count = sheets ? sheets.length : 0;
  if (hit && hit.count === count && Date.now() - hit.at < BASES_TTL_MS) return hit.list;
  const list = [];
  const visit = (rules) => {
    for (const rule of rules) {
      if (list.length >= MAX_BASES) return;
      // A style rule now carries an empty cssRules list of its own (CSS nesting),
      // so the selector is what tells the two apart — not the presence of a list.
      if (!rule.selectorText) { if (rule.cssRules) visit(rule.cssRules); continue; }
      const sel = rule.selectorText;
      if (sel.indexOf(':hover') < 0) continue;
      const d = rule.style;
      const reveals = d && (d.display || d.visibility || d.opacity || d.pointerEvents || d.maxHeight || d.transform || d.clipPath);
      if (!reveals) continue;
      for (const part of sel.split(',')) {
        const at = part.indexOf(':hover');
        if (at < 0) continue;
        const base = part.slice(0, at).trim().replace(/[>+~]\s*$/, '').trim();
        if (!base || base === '*' || list.some((b) => b.sel === base)) continue;
        list.push({ sel: base, generic: !/[.#\[]/.test(base) });
      }
    }
  };
  for (const sheet of Array.from(sheets || [])) {
    let rules = null;
    try { rules = sheet.cssRules; } catch (_) { continue; }         // a sheet from another origin
    if (rules) visit(rules);
  }
  hoverBases.set(doc, { list, count, at: Date.now() });
  return list;
}

// A submenu that is in the markup but not on screen is the other half of the
// evidence: the element is hiding the very thing the route is looking for.
function hidesMenu(el) {
  let m = null;
  try { m = el.querySelector(MENUISH); } catch (_) { return false; }
  if (!m || m === el) return false;
  try {
    const s = viewOf(m).getComputedStyle(m);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return true;
    const r = m.getBoundingClientRect();
    return !r.width || !r.height;
  } catch (_) { return false; }
}

// A caret is a promise that a level opens under this control. It does not say
// whether the pointer or the click does it, so it counts as evidence and not as
// a verdict: the guide offers the hover first and falls back to the click.
const CARET_GLYPH = /[\u25be\u25b8\u25bc\u25b6\u2304\u203a]/;
const CARET_CLASS = '.caret, .chevron, .arrow, .chevron-down, .caret-down, [class*="caret"], [class*="chevron"], [class*="triangle"]';

function hasCaret(el) {
  try {
    if (el.querySelector(CARET_CLASS)) return true;
    return CARET_GLYPH.test(el.textContent || '');
  } catch (_) { return false; }
}

// 0 = no evidence, 1 = looks like one, 2 = an ancestor opens on hover,
// 3 = this element demonstrably opens a level under the pointer.
function hoverEvidence(el) {
  if (!el || el.nodeType !== 1) return 0;
  const cached = hoverCache.get(el);
  if (cached !== undefined) return cached;
  let v = 0;
  try {
    for (const a of HOVER_ATTRS) if (el.hasAttribute(a)) { v = 3; break; }
    if (!v) {
      for (const b of cssHoverBases(el.ownerDocument)) {
        if (!el.matches(b.sel)) continue;
        v = b.generic ? (hidesMenu(el) ? 3 : 0) : 3;
        if (v) break;
      }
    }
    if (!v) {
      let p = parentEl(el);
      for (let hops = 0; p && hops < 2 && !v; hops++, p = parentEl(p)) {
        // An ancestor's flyout counts only while it is still shut. Once it is
        // open, everything inside it is a destination, not another level — the
        // leaf of a menu must not inherit its parent's hover.
        if (!hidesMenu(p)) continue;
        for (const b of cssHoverBases(el.ownerDocument)) {
          if (!b.generic && p.matches(b.sel)) { v = 2; break; }
        }
      }
    }
    if (!v) {
      const hint = [el.id, el.getAttribute('class'), el.getAttribute('data-testid')].filter(Boolean).join(' ');
      if (HOVER_HINT.test(hint)) v = hidesMenu(el) ? 2 : 1;
    }
    if (!v && hasCaret(el)) v = 1;
  } catch (_) { v = 0; }
  hoverCache.set(el, v);
  return v;
}

// The cursor is inherited, so the element that owns the press is the outermost
// ancestor that still shows a pointer. Three levels is enough to climb out of
// the usual <div><span><b> nesting without swallowing a whole page. A leaf that
// does not show a pointer owns nothing.
function pointerOwner(el) {
  if (!pointerCursor(el)) return null;
  let owner = el;
  let p = parentEl(el);
  let hops = 0;
  while (p && hops < 3) {
    if (!pointerCursor(p)) break;
    owner = p;
    p = parentEl(p);
    hops++;
  }
  return owner;
}

// A shadow root can be closed, and a closed root is invisible to the page's own
// code. The browser gives extensions the closed root anyway: Firefox exposes it
// as a property on the element (Element.openOrClosedShadowRoot), Chrome hands
// it over through the dom API. Both are extension-only, so every use is guarded
// and an ordinary page simply has neither.
function shadowOf(el) {
  if (!el) return null;
  try { if (el.shadowRoot) return el.shadowRoot; } catch (_) {}
  try {
    const r = el.openOrClosedShadowRoot;
    if (r && r.nodeType === 11) return r;
  } catch (_) {}
  try {
    const api = (typeof browser !== 'undefined' && browser.dom) || (typeof chrome !== 'undefined' && chrome.dom);
    if (api && typeof api.openOrClosedShadowRoot === 'function') {
      const r = api.openOrClosedShadowRoot(el);
      if (r && r.nodeType === 11) return r;
    }
  } catch (_) {}
  return null;
}

// One walk per root does three jobs: it finds the controls that only behave like
// controls, and it collects the shadow roots and frames worth walking next.
function walkRoot(root, isVisible, seen, state) {
  const out = [];
  const doc = root.ownerDocument || root;
  if (!doc.createTreeWalker) return out;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let el;
  while ((el = walker.nextNode())) {
    if (++state.scanned > state.budget) break;

    const shadow = shadowOf(el);
    if (shadow && state.depth < MAX_NESTING && !guideExcluded(el)) {
      state.pending.push({ root: shadow, chain: state.chain, depth: state.depth + 1 });
    }
    if ((el.tagName === 'IFRAME' || el.tagName === 'FRAME') && state.depth < MAX_NESTING) {
      let sub = null;
      try { sub = el.contentDocument; } catch (_) { sub = null; }   // cross-origin: not ours to read
      if (sub && sub.body && isVisible(el) && !guideExcluded(el)) {
        state.pending.push({ root: sub, chain: state.chain.concat([el]), depth: state.depth + 1 });
      }
    }

    if (seen.has(el)) continue;
    if (hasClickHandler(el) || isFocusable(el)) {
      if (isVisible(el)) out.push(el);
      continue;
    }
    if (el.firstElementChild) continue;              // only leaves carry the cursor
    const owner = pointerOwner(el);
    if (!owner || seen.has(owner) || out.indexOf(owner) >= 0) continue;
    if (isVisible(owner)) out.push(owner);
  }
  return out;
}

// Build a containment tree: walk candidate elements in document order and attach
// each to its nearest candidate ancestor. Result is a forest of roots with
// nested `children` (the subcontents), each node independently addressable.
function buildTree(candidates) {
  const byEl = new Map(candidates.map((el, i) => [el, i]));
  // A container must not swallow its children's words: if a candidate holds a
  // control, its own label comes from its heading, id or tag — never from all
  // the text inside it.
  const holdsControl = new Set();
  for (const el of candidates) {
    if (kindOf(el) !== 'control') continue;
    let p = parentEl(el);
    let hops = 0;
    while (p && hops++ < 200) {
      if (byEl.has(p)) holdsControl.add(p);
      p = parentEl(p);
    }
  }
  const nodes = candidates.map((el, i) => {
    const label = labelFor(el, holdsControl.has(el));
    return {
      el,
      id: idFor(el, label, i),
      label,
      aliases: aliasesFor(el, label),
      kind: kindOf(el),
      parent: null,
      children: [],
      depth: 0,
    };
  });

  const roots = [];
  for (const node of nodes) {
    let ancestorEl = parentEl(node.el);
    let hops = 0;
    while (ancestorEl && !byEl.has(ancestorEl) && hops++ < 200) ancestorEl = parentEl(ancestorEl);
    if (ancestorEl && byEl.has(ancestorEl)) {
      const parentNode = nodes[byEl.get(ancestorEl)];
      parentNode.children.push(node);
      node.parent = parentNode;
    } else {
      roots.push(node);
    }
  }

  const setDepth = (list, d) => list.forEach((n) => { n.depth = d; setDepth(n.children, d + 1); });
  setDepth(roots, 0);
  return roots;
}

// Something the user can press. A form is addressable but is never the thing
// you press, so it is deliberately not in this list.
function isPressable(el) {
  try {
    if (!el || el.nodeType !== 1) return false;
    if (el.matches(PRESSABLE_SELECTOR)) return true;
    return hasClickHandler(el) || isFocusable(el) || pointerCursor(el);
  } catch (_) { return false; }
}

function discoverUIElements(root = document, { selector = SELECTOR, exclude = [], budget = SCAN_BUDGET } = {}) {
  const isVisible = makeIsVisible(exclude);
  const seen = new Set();
  const candidates = [];
  const state = { scanned: 0, budget, pending: [{ root, chain: NO_CHAIN, depth: 0 }], chain: NO_CHAIN, depth: 0 };
  let rootsWalked = 0;

  while (state.pending.length && rootsWalked < MAX_ROOTS) {
    const job = state.pending.shift();
    rootsWalked++;
    state.chain = job.chain;
    state.depth = job.depth;
    const r = job.root;
    const mine = [];

    let semantic = [];
    try { semantic = r.querySelectorAll(selector); } catch (_) { semantic = []; }
    for (const el of semantic) {
      if (seen.has(el) || !isVisible(el)) continue;
      seen.add(el);
      mine.push(el);
    }
    for (const el of walkRoot(r, isVisible, seen, state)) {
      if (seen.has(el)) continue;
      seen.add(el);
      mine.push(el);
    }

    // Document order within this root; roots stay in the order they were reached,
    // because compareDocumentPosition means nothing across two documents.
    mine.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
    for (const el of mine) {
      if (job.chain.length) frameChain.set(el, job.chain);
      candidates.push(el);
    }
    if (state.scanned > state.budget) break;
  }
  return buildTree(candidates);
}

export { STOPWORDS, SYNONYMS, tokenWords, pointerCursor, discoverUIElements, isPressable, hoverEvidence, invalidateStyleCache, rectOf, isLive, chainOf, viewOf, rootOf, parentEl, closestDeep, scrollIntoViewDeep };