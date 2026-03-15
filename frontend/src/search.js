/**
 * search-comete - search.js
 *
 * Search against stars.json data directly (no backend needed).
 * Uses a proper TF-IDF style scorer with title/abstract/cluster weighting.
 * Camera navigation uses getRemappedPos() which returns actual scene coords.
 */

import { FALLBACK_PAPERS } from './data.js';

const API_BASE = '/api';
// Cache the backend check as a promise so concurrent calls don't fire multiple requests
let _backendCheckPromise = null;
let _usingBackend = null;

// All loaded stars (from stars.json or fallback) - set by main.js after load
let _allStars = [];
export function setSearchCorpus(stars) {
  _allStars = stars;
  _buildIndex();
}

// ── Inverted index built from the full corpus ────────────────────────────────
// Maps lowercase token → array of { id, score } sorted by score desc
const _index = {};

function _tokenise(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

const STOPWORDS = new Set([
  'a','an','the','and','or','of','in','to','for','is','are','was','were',
  'be','been','being','have','has','had','do','does','did','with','at',
  'by','from','as','this','that','it','its','on','not','but','we','our',
  'their','they','can','also','using','based','paper','study','show',
  'propose','present','method','approach','model','result','novel','new',
]);

function _buildIndex() {
  Object.keys(_index).forEach(k => delete _index[k]);
  _allStars.forEach(star => {
    const titleTokens   = _tokenise(star.title);
    const abstractTokens = _tokenise(star.abstract || '');
    const clusterTokens = _tokenise(star.cluster || '');

    const termScores = {};
    titleTokens.forEach(t   => { termScores[t] = (termScores[t] || 0) + 3.0; });
    abstractTokens.forEach(t => { termScores[t] = (termScores[t] || 0) + 0.5; });
    clusterTokens.forEach(t  => { termScores[t] = (termScores[t] || 0) + 1.0; });

    Object.entries(termScores).forEach(([term, score]) => {
      if (!_index[term]) _index[term] = [];
      _index[term].push({ id: String(star.id), score });
    });
  });
  console.log(`[search] Index built - ${Object.keys(_index).length} terms, ${_allStars.length} documents`);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function doSearch(query) {
  // Try backend first - use promise cache so concurrent calls don't fire multiple health checks
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
  return _localSearch(query);
}

// ── Remote search (FastAPI → Elasticsearch) ──────────────────────────────────

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
    return res.ok;
  } catch { return false; }
}

// ── Local TF-IDF search against full corpus ───────────────────────────────────

function _localSearch(query) {
  const corpus = _allStars.length > 0 ? _allStars : FALLBACK_PAPERS;
  const tokens = _tokenise(query);
  if (!tokens.length) return [];

  // Score each document
  const scores = {};

  // 1. Index lookup (fast path - pre-built inverted index)
  if (_allStars.length > 0) {
    tokens.forEach(tok => {
      // Exact match
      const exact = _index[tok] || [];
      exact.forEach(({ id, score }) => {
        scores[id] = (scores[id] || 0) + score;
      });
      // Prefix match for partial terms (e.g. "transform" matches "transformer")
      Object.keys(_index).forEach(term => {
        if (term !== tok && (term.startsWith(tok) || tok.startsWith(term))) {
          const boost = tok.length / Math.max(term.length, tok.length); // partial credit
          _index[term].forEach(({ id, score }) => {
            scores[id] = (scores[id] || 0) + score * boost * 0.6;
          });
        }
      });
    });
  } else {
    // Fallback: scan FALLBACK_PAPERS directly
    corpus.forEach(p => {
      tokens.forEach(tok => {
        if ((p.title || '').toLowerCase().includes(tok))    scores[String(p.id)] = (scores[String(p.id)] || 0) + 3;
        if ((p.abstract || '').toLowerCase().includes(tok)) scores[String(p.id)] = (scores[String(p.id)] || 0) + 0.5;
      });
    });
  }

  // 2. Build star map for fast lookup
  const starMap = {};
  corpus.forEach(s => { starMap[String(s.id)] = s; });

  // 3. Sort and normalise scores
  const maxScore = Math.max(...Object.values(scores), 1);
  const results = Object.entries(scores)
    .filter(([, s]) => s > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 30)
    .map(([id, rawScore]) => {
      const star = starMap[id];
      if (!star) return null;
      return {
        ...star,
        cite:  star.cite ?? star.citations ?? 0,
        score: Math.min(0.99, rawScore / maxScore),
      };
    })
    .filter(Boolean);

  if (!results.length) {
    // Return a small random selection so the galaxy still responds
    return corpus.slice(0, 5).map(p => ({
      ...p, cite: p.cite ?? 0, score: 0.1,
    }));
  }
  return results;
}