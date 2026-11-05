// Turns a natural-language input into an intent, then resolves the target element
// from the queue. Understands navigation verbs ("where is FAQ", "show me the
// signup", "go to contact"), queue stepping ("next", "previous", "cycle"), and
// listing. Matching is fuzzy: exact alias, substring, prefix, or close spelling
// (Levenshtein), and it descends into subcontents so "email" routes to the field
// even though it lives inside the signup form.

import { STOPWORDS } from './discovery.js';

const VERB_PATTERNS = [
  { type: 'next', re: /^\s*(next|forward|down|step)\b/i },
  { type: 'prev', re: /^\s*(prev|previous|back|up|last)\b/i },
  { type: 'cycle', re: /^\s*(cycle|loop|auto|autoplay|start\s+cycling)\b/i },
  { type: 'stop', re: /^\s*(stop|pause|hold)\b/i },
  { type: 'list', re: /^\s*(list|options|available|everything|show\s+all|what\s+can\s+you)\b/i },
  { type: 'goto', re: /^\s*(?:where\s+(?:is|are|can\s+i\s+find|do\s+i\s+find)?|where's|what'?s|what\s+(?:is|are|about)|show\s+me|show|go\s+to|navigate\s+to|take\s+me\s+to|get\s+me\s+to|guide\s+me\s+to|find|open|click|point\s+(?:at|to)|look\s+at|jump\s+to)\b\s*(.*)$/i },
];

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
  for (const p of VERB_PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      const query = p.type === 'goto' ? (m[1] || '').trim() : '';
      if (p.type !== 'goto' || query) return { type: p.type, query };
    }
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

function scoreNode(qTokens, compactQuery, node) {
  const hay = nodeHaystack(node);
  const hayCompact = hay.compact;
  let score = 0;

  // Whole condensed query embedded in the label is the strongest signal.
  if (compactQuery && hayCompact && (hayCompact.includes(compactQuery) || compactQuery.includes(hayCompact))) {
    score += 6 + compactQuery.length;
  }

  for (const t of qTokens) {
    if (hay.tokens.has(t)) score += 4;                       // exact alias/label word
    else if (hayCompact.includes(t)) score += 2.5;           // word appears inside label
    else {
      // A shared prefix ("emai" -> "email", "pass" -> "password") is a strong hit.
      let prefix = false;
      for (const h of hay.tokens) { if (h.startsWith(t) || t.startsWith(h)) { prefix = true; break; } }
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

  let best = null, bestScore = 0;
  for (const node of flat) {
    const s = scoreNode(qTokens, compactQuery, node);
    if (s > bestScore) { bestScore = s; best = node; }
  }
  // A real match needs at least one strong signal; weak fuzzy overlap is treated
  // as "not found" so nonsense inputs (e.g. "stock ticker") don't misguide.
  const MIN_FOUND = 2;
  if (!best || bestScore < MIN_FOUND) return null;
  return { node: best, score: bestScore, candidates: flat
    .map((n) => ({ node: n, score: scoreNode(qTokens, compactQuery, n) }))
    .sort((a, b) => b.score - a.score).slice(0, 3) };
}
