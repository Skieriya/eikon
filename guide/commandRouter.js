// Turns a natural-language input into an intent, then resolves the target element
// from the queue. Understands navigation verbs ("where is FAQ", "show me the
// signup", "go to contact"), queue stepping ("next", "previous", "cycle"), and
// listing. Matching is fuzzy: exact alias, substring, prefix, or close spelling
// (Levenshtein), and it descends into subcontents so "email" routes to the field
// even though it lives inside the signup form.
//
// A goal ("how do I turn off memory") is its own intent: it names an outcome, not
// an element, so it needs a path of steps rather than one match. Goals are only
// recognised when the wording really asks for a route — otherwise the same text is
// a plain goto.

import { STOPWORDS } from './discovery.js';
import { semMatch } from './semantics.js';

// People talk to her like a person: "I want to edit images", "how do I turn
// memory off". The words at the front are not the name of anything.
const LEAD_FILLER = /^\s*(?:please\s+)?(?:i\s+(?:want|need|would\s+like|'?d\s+like)\s+to|i\s+'?m\s+trying\s+to|how\s+do\s+i|how\s+can\s+i|how\s+to|help\s+me|let\s+me|lets)\s+/i;

const NAV_PATTERNS = [
  { type: 'next', re: /^\s*(next|forward|down|step)\b/i },
  { type: 'prev', re: /^\s*(prev|previous|back|up|last)\b/i },
  { type: 'cycle', re: /^\s*(cycle|loop|auto|autoplay|start\s+cycling)\b/i },
  { type: 'stop', re: /^\s*(stop|pause|hold)\b/i },
  { type: 'list', re: /^\s*(list|options|available|everything|show\s+all|what\s+can\s+you)\b/i },
  { type: 'teach', re: /^\s*(teach|learn|watch\s+me|remember\s+(?:this|this\s+way|how|i)|note\s+(?:this|how))\b/i },
  { type: 'done', re: /^\s*(done|finished|i\s+click(?:ed)?\s*it|i\s+did\s+(?:it|that)|save|finish)\b/i },
];

const GOTO_PATTERNS = [
  { type: 'goto', re: /^\s*i\s+(?:want|need|would\s+like|'?d\s+like)\s+to\s+(.*)$/i },
  { type: 'goto', re: /^\s*(?:where\s+(?:is|are|can\s+i\s+find|do\s+i\s+find)?|where's|what'?s|what\s+(?:is|are|about)|show\s+me|show|go\s+to|navigate\s+to|take\s+me\s+to|get\s+me\s+to|guide\s+me\s+to|find|open|click|point\s+(?:at|to)|look\s+at|jump\s+to)\b\s*(.*)$/i },
];

// Changing a setting is phrased as a verb on your own thing, not as a place.
const CHANGE_VERB = /^\s*(turn|switch|disable|enable|delete|remove|change|hide|mute|unmute|update|manage|set|stop|start|activate|deactivate|cancel|allow|block)\b/i;

// The request with the pleasantries taken off, so the rest of the engine only
// ever sees the part that names something.
export function cleanQuery(raw) {
  return String(raw || '').replace(LEAD_FILLER, '').trim();
}

export function looksLikeGoal(raw) {
  const t = normalize(raw);
  if (!t) return false;
  const said = normalize(cleanQuery(raw));
  if (/\bhow\s+(?:do|can|to|should|would|one)\b/.test(t)) return true;
  if (/^\s*where\b/.test(t) && /\b(turn|switch|disable|enable|delete|remove|change|hide|set|update|manage|stop|start)\b/.test(t)) return true;
  if (CHANGE_VERB.test(said) && /\b(my|the|it|them|off|on|up|to|all)\b/.test(said)) return true;
  return false;
}

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function queryTokens(text) {
  return normalize(text)
    .split(' ')
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// Pull the "what am I looking for" phrase out of a goto sentence.
function stripFillers(raw) {
  return normalize(raw).replace(/\b(the|a|an|please|for|my|to|on|in)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseIntent(raw) {
  const text = (raw || '').trim();
  if (!text) return { type: 'empty' };
  for (const p of NAV_PATTERNS) if (p.re.test(text)) return { type: p.type, query: text };
  if (looksLikeGoal(text)) return { type: 'goal', query: text };
  for (const p of GOTO_PATTERNS) {
    const m = text.match(p.re);
    if (m && (m[1] || '').trim()) return { type: 'goto', query: m[1].trim() };
  }
  // No verb: assume the whole string is a target name.
  return { type: 'goto', query: text };
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

function nodeHaystack(node) {
  const parts = [node.label, ...(node.aliases || [])].map(normalize);
  return { compact: stripFillers(node.label), tokens: new Set(parts.join(' ').split(' ').filter(Boolean)) };
}

// A phrase has to be long enough to mean something, and it has to sit on word
// boundaries: "email" is a word of "email field", "s" is not a word of anything.
const MIN_PHRASE = 3;

function phraseWithin(text, phrase) {
  if (!text || !phrase || phrase.length < MIN_PHRASE || text.length < MIN_PHRASE) return false;
  return (' ' + text + ' ').indexOf(' ' + phrase + ' ') >= 0;
}

function scoreNode(qTokens, compactQuery, node) {
  const hay = nodeHaystack(node);
  const hayCompact = hay.compact;
  let score = 0;

  // Whole condensed query embedded in the label is the strongest signal. The
  // reverse — the label embedded in the query — only counts when the label is a
  // real word: "S" on an avatar is contained by "settings", "personalization" and
  // nearly everything else, and scoring that is how a guide ends up pointing at
  // the same button for every step of a route.
  if (compactQuery.length >= MIN_PHRASE && hayCompact.includes(compactQuery)) {
    score += 6 + compactQuery.length;
  } else if (phraseWithin(compactQuery, hayCompact)) {
    score += 4 + hayCompact.length;                          // "email field" -> the field named "email"
  }
  // A control actually NAMED what you asked for beats one that merely contains it:
  // "settings" means the Settings button, not the "Cookie settings" link in a
  // banner that happens to be shallower in the tree.
  if (compactQuery.length >= MIN_PHRASE && hayCompact === compactQuery) score += 5;

  for (const t of qTokens) {
    if (hay.tokens.has(t)) score += 4;                       // exact alias/label word
    else if (hayCompact.includes(t)) score += 2.5;           // word appears inside label
    else {
      // A shared prefix ("emai" -> "email", "pass" -> "password") is a strong hit,
      // but only between words: an initial is a prefix of half the dictionary.
      let prefix = false;
      for (const h of hay.tokens) {
        if (h.length < MIN_PHRASE) continue;
        if (h.startsWith(t) || t.startsWith(h)) { prefix = true; break; }
      }
      if (prefix) score += 2.5;
      else {
        let best = 99;
        for (const h of hay.tokens) { const d = levenshtein(t, h); if (d < best) best = d; }
        if (best <= 1 && t.length >= 4) score += 1.5;         // one-character typo
      }
    }
  }
  // Flatten ties toward shallower / clearer nodes.
  if (score > 0) score -= node.depth * 0.2;
  return score;
}

// Walk every node including subcontents; return the best match (or null).
export function matchQuery(query, nodes) {
  const qTokens = queryTokens(query);
  const compactQuery = stripFillers(query);
  if (!qTokens.length && !compactQuery) return null;

  const flat = [];
  const walk = (list) => list.forEach((n) => { flat.push(n); walk(n.children); });
  walk(nodes);

  const plain = flat
    .map((n) => ({ node: n, score: scoreNode(qTokens, compactQuery, n) }))
    .sort((a, b) => b.score - a.score);
  let best = plain[0] && plain[0].score > 0 ? plain[0] : null;
  let bestScore = best ? best.score : 0;

  // Sometimes they are not naming a thing at all, they are describing a job:
  // "i want to edit images" is a request for whatever this page calls the
  // thing that edits an image. A literal match on the word "image" would point
  // at the gallery instead, so the job is scored too — and it wins when the
  // literal match answered only the object of the request and left the verb
  // alone, because the verb is the part that says what they want done.
  const sem = semMatch(query, nodes);
  if (sem) {
    const said = sem.verbs || [];
    const usedVerb = !!(best && said.some((w) => nodeHaystack(best.node).tokens.has(w)));
    if (sem.score > bestScore || (said.length && !usedVerb && (sem.verb || sem.ctrl))) {
      return { node: sem.node, score: sem.score, candidates: sem.candidates, semantic: true };
    }
  }

  // A real match needs at least one strong signal; weak fuzzy overlap is treated
  // as "not found" so nonsense inputs (e.g. "stock ticker") don't misguide.
  const MIN_FOUND = 2;
  if (!best || bestScore < MIN_FOUND) return null;
  return { node: best.node, score: bestScore, candidates: plain.slice(0, 3) };
}
