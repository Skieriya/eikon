// Knowing what a person means, not what the page calls it.
//
// Nobody asks for "the element labelled rect-crop". They say "edit images" and
// expect to be shown whatever the page happens to call that: a pencil icon, a
// "Crop" tool, a slider called "Adjust". A literal search cannot do that, and
// literal is all the guide had.
//
// So a request is read as the two things it really names — a VERB (edit) and a
// NOUN (images) — and every control the guide found is scored by how well it
// fits that job. The page has to say something that belongs to the job: on the
// control itself, or on the panel it sits in. A control that says nothing about
// it is never offered, so a wrong-but-confident point stays impossible.

const SEM_FILLER = new Set([
  'how', 'do', 'does', 'did', 'i', 'to', 'want', 'need', 'would', 'like', 'lets',
  'let', 'us', 'can', 'could', 'should', 'will', 'may', 'might', 'must', 'you',
  'please', 'the', 'and', 'or', 'but', 'my', 'me', 'of', 'for', 'in', 'on', 'at',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'im', 'it', 'its',
  'that', 'this', 'these', 'those', 'with', 'from', 'into', 'about', 'some',
  'any', 'thing', 'things', 'stuff', 'there', 'here', 'then', 'so', 'just',
  'really', 'very', 'much', 'also', 'too', 'again', 'now', 'ever', 'never',
]);

// What the object of the request might be called. A request for "the picture"
// is a request for whatever the page calls a photo, an image or an asset.
const SEM_NOUNS = {
  image: ['image', 'images', 'photo', 'photos', 'picture', 'pictures', 'media', 'graphic', 'graphics', 'artwork', 'illustration', 'shot', 'snapshot', 'thumbnail', 'editor', 'editors'],
  file: ['file', 'files', 'document', 'documents', 'doc', 'docs', 'attachment', 'attachments'],
  video: ['video', 'videos', 'clip', 'clips', 'movie', 'film'],
  audio: ['audio', 'sound', 'sounds', 'music', 'voice', 'track', 'song'],
  text: ['text', 'copy', 'words', 'lettering', 'caption', 'title', 'heading', 'label', 'font'],
  message: ['message', 'messages', 'comment', 'comments', 'chat', 'thread', 'conversation', 'note', 'notes', 'reply'],
  mail: ['email', 'emails', 'mail', 'inbox'],
  person: ['user', 'users', 'account', 'accounts', 'profile', 'member', 'members', 'people', 'contact', 'author'],
  setting: ['setting', 'settings', 'preference', 'preferences', 'option', 'options', 'config', 'configuration', 'switch', 'toggle'],
  money: ['payment', 'payments', 'billing', 'invoice', 'invoices', 'card', 'subscription', 'plan', 'plans', 'price', 'pricing', 'order', 'orders', 'checkout'],
  project: ['project', 'projects', 'workspace', 'workspaces', 'repo', 'repository', 'board', 'boards', 'task', 'tasks'],
  page: ['page', 'pages', 'screen', 'view', 'tab', 'tabs', 'section', 'panel'],
  collection: ['album', 'gallery', 'library', 'collection', 'collections', 'timeline'],
  data: ['chart', 'charts', 'graph', 'graphs', 'plot', 'plots', 'dashboard', 'report', 'reports', 'analytics', 'stats', 'statistics', 'metric', 'metrics', 'table', 'tables'],
  password: ['password', 'passcode', 'pin', 'secret'],
  memory: ['memory', 'memories', 'remember', 'recall', 'history'],
};

// The job, and the words a control doing that job tends to carry.
const SEM_VERBS = {
  edit: {
    words: ['edit', 'change', 'modify', 'adjust', 'tweak', 'customize', 'customise', 'rename', 'retouch', 'redesign'],
    controls: ['crop', 'resize', 'rotate', 'flip', 'filter', 'filters', 'effects', 'brush', 'pencil', 'eraser', 'paint', 'draw', 'annotate', 'transform', 'enhance', 'canvas', 'brightness', 'contrast', 'saturation', 'opacity', 'sharpen', 'background', 'overlay', 'straighten', 'trim'],
  },
  delete: {
    words: ['delete', 'remove', 'erase', 'discard', 'destroy', 'clear', 'uninstall', 'empty'],
    controls: ['delete', 'remove', 'trash', 'bin', 'discard', 'erase', 'wipe', 'purge'],
  },
  download: {
    words: ['download', 'save', 'export', 'grab', 'fetch'],
    controls: ['download', 'save', 'export', 'install'],
  },
  upload: {
    words: ['upload', 'import', 'attach', 'browse'],
    controls: ['upload', 'import', 'attach', 'browse', 'choose', 'device'],
  },
  share: {
    words: ['share', 'publish', 'post', 'invite', 'collaborate'],
    controls: ['share', 'publish', 'post', 'send', 'invite', 'collaborate', 'link'],
  },
  print: { words: ['print', 'printer'], controls: ['print', 'printer'] },
  copy: { words: ['copy', 'duplicate', 'clone'], controls: ['copy', 'duplicate', 'clone'] },
  paste: { words: ['paste'], controls: ['paste'] },
  undo: { words: ['undo', 'revert'], controls: ['undo', 'revert', 'history', 'restore'] },
  redo: { words: ['redo'], controls: ['redo'] },
  close: { words: ['close', 'dismiss', 'exit', 'quit'], controls: ['close', 'dismiss', 'exit', 'cancel'] },
  open: { words: ['open', 'expand', 'browse', 'view'], controls: ['open', 'expand', 'details', 'more'] },
  search: { words: ['search', 'find', 'query', 'filter'], controls: ['search', 'find', 'filter', 'query', 'lookup', 'refine'] },
  zoom: { words: ['zoom', 'magnify', 'scale', 'resize'], controls: ['zoom', 'magnify', 'scale', 'resize'] },
  play: { words: ['play', 'start', 'run', 'resume'], controls: ['play', 'start', 'run', 'resume', 'go'] },
  pause: { words: ['pause', 'stop', 'halt', 'suspend'], controls: ['pause', 'stop', 'halt', 'suspend', 'end'] },
  mute: { words: ['mute', 'silence', 'unmute'], controls: ['mute', 'unmute', 'silence', 'volume'] },
  hide: { words: ['hide', 'conceal'], controls: ['hide', 'conceal', 'collapse'] },
  show: { words: ['show', 'reveal', 'display'], controls: ['show', 'reveal', 'display', 'visibility'] },
  signin: { words: ['login', 'log', 'authenticate'], controls: ['login', 'signin', 'authenticate', 'password'] },
  signup: { words: ['signup', 'register', 'join', 'subscribe'], controls: ['signup', 'register', 'join', 'subscribe', 'trial'] },
  logout: { words: ['logout', 'signout'], controls: ['logout', 'signout'] },
  settings: { words: ['settings', 'configure', 'manage'], controls: ['settings', 'preferences', 'options', 'configuration', 'manage'] },
  enable: { words: ['enable', 'activate'], controls: ['enable', 'activate', 'allow'] },
  disable: { words: ['disable', 'deactivate'], controls: ['disable', 'deactivate', 'block'] },
  translate: { words: ['translate'], controls: ['translate', 'language', 'locale'] },
  lock: { words: ['lock', 'secure'], controls: ['lock', 'secure', 'pin'] },
  comment: { words: ['comment', 'reply', 'annotate'], controls: ['comment', 'reply', 'note', 'annotation'] },
  sort: { words: ['sort', 'order', 'arrange', 'group'], controls: ['sort', 'order', 'arrange', 'group', 'date', 'name'] },
  select: { words: ['select', 'choose', 'pick', 'mark'], controls: ['select', 'choose', 'pick', 'mark'] },
  refresh: { words: ['refresh', 'reload', 'sync', 'update'], controls: ['refresh', 'reload', 'sync', 'update', 'retry'] },
  star: { words: ['pin', 'favorite', 'favourite', 'bookmark', 'star', 'like'], controls: ['pin', 'favorite', 'favourite', 'bookmark', 'star', 'like'] },
  report: { words: ['report', 'flag', 'block', 'complain'], controls: ['report', 'flag', 'block', 'complain', 'abuse'] },
};

// How much each kind of evidence is worth. The verb the person actually used is
// worth the most; a synonym of it nearly as much; a word that only names the
// job ("crop") less; the object a little less again; the panel a control sits
// in counts for less than the control's own words.
const W_VERB = 3.0, W_VERB_SYN = 2.0, W_CTRL = 1.8, W_NOUN = 2.5, W_CTX_NOUN = 1.2, W_CTX_CTRL = 0.8;
const SEM_FLOOR = 2.4;

function semWords(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((w) => w.length >= 3);
}

function semCount(set, list) {
  let n = 0;
  for (const w of list) if (set.has(w)) n++;
  return n;
}

// What the request is: the verb groups it names, the object it names, and —
// for each group — the exact word the person used, which counts for more than
// any of its synonyms.
function semIntents(query) {
  const words = semWords(query).filter((w) => !SEM_FILLER.has(w));
  if (!words.length) return [];
  const groups = [];
  for (const key in SEM_VERBS) {
    const g = SEM_VERBS[key];
    // The word the person used counts whether it is the plain verb ("edit") or
    // the name of the job itself ("crop") — they said what they want done.
    const used = g.words.concat(g.controls).filter((w) => words.indexOf(w) >= 0);
    if (!used.length) continue;
    groups.push({ used, words: g.words, controls: g.controls });
  }
  if (!groups.length) return [];

  const nouns = new Set();
  for (const key in SEM_NOUNS) {
    if (SEM_NOUNS[key].some((n) => words.indexOf(n) >= 0)) SEM_NOUNS[key].forEach((n) => nouns.add(n));
  }
  // Whatever the sentence named that is not a known word is still the object.
  const said = new Set(groups.reduce((a, g) => a.concat(g.used), []));
  for (const w of words) if (!said.has(w)) nouns.add(w);
  return groups.map((g) => ({ used: g.used, verbs: g.words, controls: g.controls, nouns: Array.from(nouns) }));
}

// What the page says about a control: its own words, plus the words of the
// panel it sits in (which is how "Crop" inside a "Photo editor" panel can be
// understood as something that edits a photo).
function semHaystack(node) {
  const self = new Set();
  const ctx = new Set();
  const add = (set, text) => { semWords(text).forEach((w) => set.add(w)); };
  add(self, node.label);
  (node.aliases || []).forEach((a) => add(self, a));
  const el = node.el;
  if (el && el.getAttribute) {
    add(self, el.getAttribute('aria-label'));
    add(self, el.getAttribute('title'));
    add(self, el.getAttribute('data-testid'));
    add(self, el.getAttribute('role'));
    add(self, el.getAttribute('type'));
  }
  if (el && el.tagName) {
    const tag = el.tagName.toLowerCase();
    add(self, tag);
    // A file field is the upload, whatever the page calls it.
    if (tag === 'input' && el.type === 'file') { add(self, 'upload'); add(self, 'file'); }
    if (tag === 'input' && el.type === 'search') add(self, 'search');
    if (tag === 'input' && el.type === 'password') add(self, 'password');
    if (tag === 'input' && el.type === 'email') add(self, 'email');
    if (tag === 'img') { add(self, 'image'); add(self, 'picture'); }
    if (tag === 'a' && el.hasAttribute && el.hasAttribute('download')) add(self, 'download');
  }
  // The panel it sits in, as the page itself names it: an aria-label, a
  // tooltip, or the heading above it. A toolbar marked "Photo editor" is what
  // tells her that the "Crop" button in it edits a photo.
  let box = el && el.parentElement, hops = 0;
  while (box && hops++ < 4) {
    if (box.getAttribute) {
      add(ctx, box.getAttribute('aria-label'));
      add(ctx, box.getAttribute('title'));
    }
    try {
      const h = box.querySelector && box.querySelector(':scope > h1, :scope > h2, :scope > h3');
      if (h) add(ctx, h.textContent);
    } catch (_) { /* a document without :scope */ }
    box = box.parentElement;
  }
  // And the panels she knows about, which is where the headings live.
  let p = node.parent, up = 0;
  while (p && up++ < 3) { add(ctx, p.label); p = p.parent; }
  return { self, ctx };
}

function semScore(hay, intents) {
  let best = 0, verb = false, ctrl = false;
  for (const it of intents) {
    const exact = semCount(hay.self, it.used);
    const syn = semCount(hay.self, it.verbs) - exact;
    const hits = semCount(hay.self, it.controls);
    const noun = semCount(hay.self, it.nouns);
    const ctxNoun = semCount(hay.ctx, it.nouns);
    const ctxCtrl = semCount(hay.ctx, it.controls);
    const s = Math.min(6, exact * W_VERB) + Math.min(4, syn * W_VERB_SYN)
            + Math.min(3.6, hits * W_CTRL) + Math.min(5, noun * W_NOUN)
            + Math.min(2.4, ctxNoun * W_CTX_NOUN) + Math.min(1.6, ctxCtrl * W_CTX_CTRL);
    if (s > best) { best = s; verb = (exact + syn) > 0; ctrl = hits > 0; }
  }
  return { score: best, verb, ctrl };
}

// Find the control that does the job the request describes. Same shape as
// matchQuery's answer, so the caller cannot tell which of the two found it.
export function semMatch(query, nodes) {
  const intents = semIntents(query);
  if (!intents.length) return null;
  const flat = [];
  const walk = (list) => list.forEach((n) => { flat.push(n); walk(n.children); });
  walk(nodes || []);
  if (!flat.length) return null;

  const scored = [];
  let best = null, bestScore = 0, bestVerb = false, bestCtrl = false;
  for (const node of flat) {
    const s = semScore(semHaystack(node), intents);
    let score = s.score;
    if (!score) continue;
    // A panel that merely mentions the job is not the thing you press.
    if (node.kind === 'landmark') score -= 1.0;
    score -= node.depth * 0.2;
    if (score < SEM_FLOOR) continue;
    scored.push({ node, score });
    if (score > bestScore) {
      bestScore = score; best = node; bestVerb = s.verb; bestCtrl = s.ctrl;
    }
  }
  if (!best) return null;
  scored.sort((a, b) => b.score - a.score);
  // The words the request used to name the job: the caller needs to know
  // whether a literal match answered the whole request or only its object.
  const verbs = [];
  for (const it of intents) for (const w of it.used) if (verbs.indexOf(w) < 0) verbs.push(w);
  return { node: best, score: bestScore, candidates: scored.slice(0, 3),
           verbs, verb: bestVerb, ctrl: bestCtrl };
}
