// Multi-level guidance. A path is an ordered handful of places she has to show
// you, one at a time: she points at the first, waits until you actually click it,
// lets the page settle, then resolves the next step against whatever the page has
// become. That ordering is the whole point — the control you are looking for
// usually does not exist in the DOM until you open the panel holding it, so a
// single search can never reach it.
//
// Paths come from two places: a small bundled table (things like "turn ChatGPT's
// memory off") and what she learned herself by watching you do it. Both are plain
// data, and resolving a step is fuzzy text matching with a saved-selector
// fallback, so a path degrades to "I can't find it here, say next to skip"
// instead of pointing at something wrong when a site redesigns.

const STOP = new Set(['first', 'then', 'next', 'after', 'that', 'this', 'and', 'the', 'to', 'click', 'open', 'in']);

function words(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

// "settings → personalization → memory", "open settings then memory then the
// toggle", and, as a last resort, a comma list of three or more places.
export function parseChain(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const bits = raw
    .split(/\s*(?:→|->|=>|»|>|\|)\s*|\s+then\s+|\s+after\s+(?:that|this)[,\s]+|\s*[,;]\s*/i)
    .map((s) => s.replace(/^\s*(?:first(?:ly)?|now|and|please)\b[:,]?\s*/i, '').trim())
    .filter((s) => s.length > 1);
  // One separator in the text means the commas belong to a step, not between them.
  if (bits.length > 2 || (bits.length > 1 && !/[,;]/.test(raw))) return bits;
  return bits.length > 1 ? bits.slice(0, 8) : [];
}

// A step is text plus an optional last-resort selector she recorded while learning
// the path. Accept bare strings so the bundled table stays readable.
export function normalizeSteps(list) {
  return (list || []).map((s) => (typeof s === 'string' ? { find: s } : { find: String(s.find || s.label || ''), sel: s.sel || null, wait: s.wait || null }));
}

// Goals are kept as plain tokens so a plan can be matched by words no matter
// whether the goal was a phrase, a sentence, or a list of labels.
function goalTokens(goal) {
  const arr = Array.isArray(goal) ? goal : (goal ? [goal] : []);
  const out = [];
  for (const g of arr) for (const w of words(g)) if (out.indexOf(w) < 0) out.push(w);
  return out;
}

export function makePlan(input) {
  const steps = normalizeSteps(input.steps || []);
  if (!steps.length) return null;
  return {
    id: input.id || pathSlug(input.name || steps[0].find),
    name: input.name || steps.map((s) => s.find).join(' → '),
    host: input.host || null,
    goal: goalTokens(input.goal),
    steps,
    learned: !!input.learned,
    at: input.at || 0,
  };
}

function pathSlug(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function sameHost(a, b) {
  if (Array.isArray(a)) return a.some((x) => sameHost(x, b));
  if (Array.isArray(b)) return b.some((x) => sameHost(a, x));
  if (!a || !b) return true;
  const x = String(a).toLowerCase(), y = String(b).toLowerCase();
  return x === y || x.endsWith('.' + y) || y.endsWith('.' + x);
}

// Score every candidate by how much of the question it answers, then by how well
// it fits the site. Steps count as evidence too: "turn off memory" has to at least
// mention memory somewhere for that path to be the answer.
export function planFor(query, { recipes = [], learned = [], host = '' } = {}) {
  const q = words(query);
  if (!q.length) return null;
  let best = null, bestScore = 0;
  for (const plan of recipes.concat(learned)) {
    if (plan.host && !sameHost(host, plan.host)) continue;
    const goal = Array.isArray(plan.goal) ? plan.goal.join(' ') : String(plan.goal || '');
    const hay = new Set(words((plan.name || '') + ' ' + goal + ' ' + (plan.steps || []).map((s) => (typeof s === 'string' ? s : s.find)).join(' ')));
    let score = 0;
    for (const w of q) if (hay.has(w)) score += 2;
    // A path nobody asked for is noise; require a real overlap.
    if (score < 2) continue;
    if (plan.learned) score += 0.5;                    // what you showed her beats a guess
    if (score > bestScore) { bestScore = score; best = plan; }
  }
  return best || null;
}

// The state machine. It knows nothing about the DOM: the host resolves each step,
// moves her gaze, and tells her when a click has landed.
export function createPathRunner({ resolve, goTo, onStep, onMiss, onDone, onEvent } = {}) {
  const st = { plan: null, i: -1, node: null, awaiting: null };

  function status() {
    if (!st.plan) return null;
    const step = st.plan.steps[st.i];
    return {
      name: st.plan.name,
      i: st.i,
      n: st.plan.steps.length,
      steps: st.plan.steps.map((s) => s.find),
      find: step ? step.find : null,
      label: st.node ? st.node.label : step ? step.find : null,
      awaiting: st.awaiting,
    };
  }

  function show(i) {
    const step = st.plan.steps[i];
    if (!step) return Promise.resolve({ ok: false, reason: 'past-the-end' });
    st.i = i;
    const node = resolve(step, i);
    if (!node) {
      st.node = null;
      st.awaiting = 'missing';
      if (onMiss) onMiss(step, i, st.plan);
      return Promise.resolve({ ok: false, reason: 'step-not-found' });
    }
    st.node = node;
    st.awaiting = 'click';
    // Announced, and the click is already live, before her eyes finish travelling:
    // someone who presses while she is still turning around is not ignored, and a
    // frame that never paints cannot stall the chain. The glide is fire-and-forget
    // on purpose — it is presentation, not a step.
    if (onStep) onStep({ step, node, i, plan: st.plan });
    if (goTo) {
      try { Promise.resolve(goTo(node)).then(() => {}, () => {}); } catch (_) {}
    }
    return Promise.resolve({ ok: true, node });
  }

  return {
    get active() { return !!st.plan; },
    get awaiting() { return st.awaiting; },
    get node() { return st.node; },
    get plan() { return st.plan; },
    status,

    async start(plan) {
      if (!plan || !plan.steps || !plan.steps.length) return null;
      st.plan = plan;
      st.i = -1;
      st.node = null;
      if (onEvent) onEvent('start', status());
      return show(0);
    },

    async advance() {
      if (!st.plan) return null;
      if (st.i + 1 >= st.plan.steps.length) {
        const done = st.plan;
        st.plan = null; st.i = -1; st.node = null; st.awaiting = null;
        if (onDone) onDone(done);
        return { done: true };
      }
      return show(st.i + 1);
    },

    async back() {
      if (!st.plan || st.i <= 0) return null;
      return show(st.i - 1);
    },

    // The page changed underneath a step she could not find: try it again.
    async retry() {
      if (!st.plan || st.awaiting !== 'missing') return null;
      return show(st.i);
    },

    stop() {
      const plan = st.plan;
      st.plan = null; st.i = -1; st.node = null; st.awaiting = null;
      if (plan && onEvent) onEvent('stop', { name: plan.name });
      return plan;
    },

    // Did this click complete the step she is holding?
    clicked(el) {
      if (!st.plan || st.awaiting !== 'click' || !st.node || !st.node.el) return false;
      const target = st.node.el;
      if (!(target === el || target.contains(el) || el.contains(target))) return false;
      st.awaiting = 'settle';
      if (onEvent) onEvent('clicked', status());
      return true;
    },
  };
}

// Things worth knowing without being taught. Deliberately worded the way a person
// would name them, since every step is resolved by fuzzy text matching: if a site
// renames "Personalization" she still lands on it, and if it renames it beyond
// recognition she says so rather than pointing at a random button.
export const RECIPES = [
  {
    id: 'chatgpt-memory-off',
    host: ['chatgpt.com', 'chat.openai.com'],
    name: 'Turn ChatGPT’s chat memory off',
    goal: ['memory', 'remember', 'forget', 'personalize', 'history'],
    steps: [
      { find: 'settings' },
      { find: 'personalization' },
      { find: 'memory' },
      { find: 'chat history' },
    ],
  },
  {
    id: 'chatgpt-account-delete',
    host: ['chatgpt.com', 'chat.openai.com'],
    name: 'Find your ChatGPT account settings',
    goal: ['account', 'profile', 'delete', 'data', 'export'],
    steps: [{ find: 'settings' }, { find: 'account' }],
  },
  {
    id: 'github-notifications',
    host: 'github.com',
    name: 'Change your GitHub notification settings',
    goal: ['notification', 'notifications', 'email', 'watching'],
    steps: [{ find: 'settings' }, { find: 'notifications' }],
  },
  {
    id: 'youtube-autoplay',
    host: 'youtube.com',
    name: 'Turn YouTube autoplay off',
    goal: ['autoplay', 'aut play', 'play', 'next', 'video'],
    steps: [{ find: 'settings' }, { find: 'autoplay' }],
  },
  {
    id: 'google-activity',
    host: 'myactivity.google.com',
    name: 'Open your Google activity history',
    goal: ['activity', 'history', 'searches', 'delete'],
    steps: [{ find: 'history' }],
  },
];
