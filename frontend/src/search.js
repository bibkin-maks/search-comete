/**
 * search-comete - search.js
 *
 * Search over the loaded galaxy, in the browser:
 *  - inverted index over titles (+ abstracts when present), TF-IDF weighted so
 *    rare words count more than common ones
 *  - prefix matching ("transform" finds "transformer") via binary search on a
 *    sorted term list instead of scanning every term
 *  - small boosts for whole-phrase title matches and citation count
 * The FastAPI/Elasticsearch backend is used instead only when USE_BACKEND is on.
 */

import { FALLBACK_PAPERS } from './data.js';
import { USE_BACKEND, API_BASE } from './config.js';

let _usingBackend = USE_BACKEND ? null : false;
let _backendCheckPromise = null;

// All loaded stars - set by main.js after load
let _allStars = [];
const _index = new Map();   // term -> [[docIdx, weight], ...]
let _sortedTerms = [];

export function setSearchCorpus(stars) {
  _allStars = stars;
  _buildIndex();
}

// ── AI Lore ───────────────────────────────────────────────────────────────────
const LORE = {
  ml:    'A dense neural collective, pulsing with the weight of trillion-parameter optimization. Here, logic is not written, but grown.',
  cs:    'The digital foundation. Architectures of pure reason where abstract algorithms manifest as the physics of our reality.',
  math:  'The realm of absolute truth. Geometric symmetries and axiomatic structures that exist independent of time, space, or observer.',
  phys:  'Where the abstract meets the iron laws of nature. A high-energy dance of particles and fields probing the limits of the measurable.',
  bio:   'The code of life. Swirling helices of carbon and information, mapping the blueprints of organic vitality.',
  chem:  'Molecular alchemy. The study of bonds and breaks, where the rearrangement of atoms defines what matter can become.',
  astro: 'The cosmic scale. Infinite voids and stellar nurseries, tracking the history of the universe through the light of ancient stars.',
  med:   'The study of the fragile vessel. Clinical insights and interventions aimed at preserving the flicker of consciousness.',
  econ:  'The flows of value and incentive. Modeling collective behavior in a world of finite resources and infinite desire.',
  psych: 'The interior landscape. Mapping the architecture of thought, emotion, and the emergent mystery of the self.',
  neuro: 'Eighty-six billion sparks in the dark. Charting how wet tissue turns electricity into memory, motion and mind.',
  mat:   'Matter by design. Lattices, alloys and polymers engineered atom by atom until they bend, conduct or heal on command.',
  eng:   'Theory welded into the world. Bridges, engines and circuits where every equation has to survive contact with reality.',
  env:   'The living planet as one system. Carbon, water and climate in a slow feedback loop we are only beginning to read.',
  edu:   'How minds are shaped by other minds. The science of learning, teaching and the institutions that carry knowledge forward.',
};
const LORE_DEFAULT = 'A dense cluster of human knowledge, emitting the faint heat of collective intellectual labor.';

export async function getLore(clusterId) {
  return LORE[(clusterId || '').toLowerCase()] || LORE_DEFAULT;
}

// ── Index ─────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'a','an','the','and','or','of','in','to','for','is','are','was','were',
  'be','been','being','have','has','had','do','does','did','with','at',
  'by','from','as','this','that','it','its','on','not','but','we','our',
  'their','they','can','also','using','based','paper','study','show',
  'propose','present','method','approach','model','result','novel','new',
  'via','into','than','how','what','why','when','vs',
]);

function _tokenise(text) {
  return (text || '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

function _buildIndex() {
  _index.clear();
  const t0 = performance.now();
  _allStars.forEach((star, doc) => {
    const termScores = new Map();
    _tokenise(star.title).forEach(t => termScores.set(t, (termScores.get(t) || 0) + 3));
    _tokenise(star.abstract).forEach(t => termScores.set(t, (termScores.get(t) || 0) + 0.5));
    termScores.forEach((score, term) => {
      let postings = _index.get(term);
      if (!postings) _index.set(term, postings = []);
      postings.push([doc, score]);
    });
  });
  // Fold IDF into the weights once, so queries are just sums
  const N = _allStars.length || 1;
  _index.forEach(postings => {
    const idf = Math.log(1 + N / postings.length);
    postings.forEach(p => { p[1] *= idf; });
  });
  _sortedTerms = [..._index.keys()].sort();
  console.log(`[search] Index built - ${_index.size} terms, ${N} documents in ${Math.round(performance.now() - t0)}ms`);
}

// Terms that start with `prefix` (excluding the exact term), capped
function _prefixTerms(prefix, cap = 40) {
  let lo = 0, hi = _sortedTerms.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (_sortedTerms[mid] < prefix) lo = mid + 1; else hi = mid;
  }
  const out = [];
  for (let i = lo; i < _sortedTerms.length && out.length < cap; i++) {
    const term = _sortedTerms[i];
    if (!term.startsWith(prefix)) break;
    if (term !== prefix) out.push(term);
  }
  return out;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function doSearch(query) {
  if (_usingBackend === null) {
    if (!_backendCheckPromise) _backendCheckPromise = _checkBackend();
    _usingBackend = await _backendCheckPromise;
  }
  if (_usingBackend) {
    try { return await _remoteSearch(query); }
    catch (e) {
      console.warn('[search] Backend failed, using local index:', e.message);
      _usingBackend = false;
    }
  }
  return localSearch(query);
}

/** Galaxy stars most related to a piece of text (used to place live results). */
export function localMatches(text, k = 6) {
  return localSearch(text, k);
}

export function localSearch(query, limit = 30) {
  const corpus = _allStars.length ? _allStars : FALLBACK_PAPERS;
  const tokens = _tokenise(query);
  if (!tokens.length) return [];

  const scores = new Map();
  const add = (doc, s) => scores.set(doc, (scores.get(doc) || 0) + s);

  if (_allStars.length) {
    tokens.forEach(tok => {
      (_index.get(tok) || []).forEach(([doc, w]) => add(doc, w));
      if (tok.length >= 3) {
        _prefixTerms(tok).forEach(term => {
          const credit = 0.6 * tok.length / term.length;
          _index.get(term).forEach(([doc, w]) => add(doc, w * credit));
        });
      }
    });
  } else {
    corpus.forEach((p, doc) => {
      tokens.forEach(tok => {
        if ((p.title || '').toLowerCase().includes(tok))    add(doc, 3);
        if ((p.abstract || '').toLowerCase().includes(tok)) add(doc, 0.5);
      });
    });
  }
  if (!scores.size) return [];

  // Reward docs that match more of the query words, whole phrases, and citations
  const phrase = query.toLowerCase().trim();
  const ranked = [...scores.entries()].map(([doc, s]) => {
    const star = corpus[doc];
    const title = (star.title || '').toLowerCase();
    const covered = tokens.filter(t => title.includes(t)).length / tokens.length;
    let score = s * (0.5 + covered);
    if (tokens.length > 1 && title.includes(phrase)) score *= 1.5;
    score *= 1 + 0.04 * Math.log10((star.cite ?? 0) + 1);
    return [star, score];
  }).sort((a, b) => b[1] - a[1]).slice(0, limit);

  const max = ranked[0][1];
  return ranked.map(([star, score]) => ({
    ...star,
    cite:  star.cite ?? star.citations ?? 0,
    score: Math.min(0.99, score / max),
  }));
}

// ── Remote search (FastAPI → Elasticsearch), only with USE_BACKEND ───────────

async function _remoteSearch(query) {
  const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(query)}&size=20`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map(r => ({
    ...r,
    cite:    r.cite    ?? r.citations ?? 0,
    cluster: r.cluster ?? r.cluster_id ?? '',
    color:   r.color   ?? r.cluster_color ?? '#ffffff',
    score:   r.score   ?? 0.5,
  }));
}

async function _checkBackend() {
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok && (await res.json()).status === 'ok';
  } catch { return false; }
}
