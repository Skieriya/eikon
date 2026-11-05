// Discover every UI element on the page and turn it into a labelled, searchable
// tree. Landmarks (nav / section / header / footer) hold their controls as
// subcontents, but each subcontent is also its own addressable node, so the
// guide can route to a whole panel ("FAQ") or to a single field ("email") and
// look at exactly the right spot.

// Anything the guide may target. Canvas + loader are never targets (the loader is
// a transient overlay and the canvas is the character himself).
const LANDMARK_SELECTOR = 'nav, header, footer, [role=navigation], [role=main], [role=contentinfo], section[id]';
const CONTROL_SELECTOR = 'a[href], button, input:not([type=hidden]), select, textarea, form, [role=button], [role=link], [role=menuitem]';
const EXTRA_SELECTOR = '[data-guide], [data-guide-alias], [data-guide-label]';
const SELECTOR = `${LANDMARK_SELECTOR}, ${CONTROL_SELECTOR}, ${EXTRA_SELECTOR}`;

const EXCLUDE_TAGS = new Set(['CANVAS']);

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'or', 'my', 'me', 'i',
  'please', 'can', 'you', 'show', 'where', 'go', 'get', 'open', 'find', 'click',
]);

// Common vocabulary the demo uses, mapped to alternate words so natural inputs
// like "help" or "support" still resolve to the FAQ.
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
};

function makeIsVisible(exclude) {
  const excluded = new Set(exclude || []);
  return function isVisible(el) {
    if (EXCLUDE_TAGS.has(el.tagName)) return false;
    if (el.hasAttribute('hidden')) return false;
    if (excluded.has(el)) return false;                       // host-supplied (e.g. the canvas)
    for (const ex of excluded) { if (ex.contains && ex.contains(el)) return false; }
    if (el.closest('[data-guide-exclude]')) return false;     // the guide's own controls
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
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

function labelFor(el) {
  if (el.dataset.guideLabel) return el.dataset.guideLabel;
  const aria = el.getAttribute('aria-label');
  if (aria) return cleanText(aria);

  const tag = el.tagName.toLowerCase();

  if (tag === 'input') {
    if (el.placeholder) return cleanText(el.placeholder);
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
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

  // Only fall back to textContent when the element has no interactive children.
  // A nav/header holding links must NOT be labelled with all its links' text, or it
  // would swallow every child's words and win matches that belong to the subcontent.
  if (!el.querySelector('a[href], button, input, select, textarea, [role=button]')) {
    const text = cleanText(el.textContent);
    if (text) return text.slice(0, 40);
  }
  if (el.id) return el.id;
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
  if (/^(nav|header|footer|section)$/.test(tag) || /^(navigation|main|contentinfo)$/.test(el.getAttribute('role') || '')) {
    return 'landmark';
  }
  return 'control';
}

// Build a containment tree: walk candidate elements in document order and attach
// each to its nearest candidate ancestor. Result is a forest of roots with
// nested `children` (the subcontents), each node independently addressable.
function buildTree(candidates) {
  const byEl = new Map(candidates.map((el, i) => [el, i]));
  const nodes = candidates.map((el, i) => {
    const label = labelFor(el);
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
    let ancestorEl = node.el.parentElement;
    while (ancestorEl && !byEl.has(ancestorEl)) ancestorEl = ancestorEl.parentElement;
    if (ancestorEl) {
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

export function discoverUIElements(root = document, { selector = SELECTOR, exclude = [] } = {}) {
  const isVisible = makeIsVisible(exclude);
  const seen = new Set();
  const candidates = [];
  for (const el of root.querySelectorAll(selector)) {
    if (seen.has(el) || !isVisible(el)) continue;
    seen.add(el);
    candidates.push(el);
  }
  // Stable document order before tree assembly.
  candidates.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
  return buildTree(candidates);
}

export { STOPWORDS, SYNONYMS, tokenWords };
