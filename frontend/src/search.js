/**
 * search-comete — search.js
 * Handles search queries. Tries the FastAPI backend first;
 * falls back to local keyword matching against bundled data.
 *
 * Fixes applied:
 *  1. _remoteSearch(): normalises the `citations` field from the API to `cite`
 *     so the rest of the frontend (which expects `cite`) works correctly.
 *  2. _localSearch(): scores against both `cite` and `citations` fields.
 *  3. Added a simple cache to avoid re-checking backend health on every search.
 */

import { FALLBACK_PAPERS, KEYWORD_MAP } from './data.js';

const API_BASE = '/api';

// Health-check cache with 30 s TTL so the app auto-recovers after backend restarts.
let _usingBackend = null;          // null = unknown, true/false after first check
let _backendCheckedAt = 0;         // performance.now() timestamp of last check
const BACKEND_TTL_MS = 30_000;     // re-check after 30 seconds

/**
 * Main search entry point.
 * Returns an array of paper objects with a `score` field added.
 * All returned papers are guaranteed to have a numeric `cite` field.
 */
export async function doSearch(query) {
  // Re-check health if cache is stale (first load, or TTL expired)
  const cacheStale = _usingBackend === null ||
    (performance.now() - _backendCheckedAt > BACKEND_TTL_MS);

  if (cacheStale) {
    _usingBackend = await _checkBackend();
    _backendCheckedAt = performance.now();
  }

  if (_usingBackend) {
    try {
      return await _remoteSearch(query);
    } catch (e) {
      console.warn('[search] Backend failed, falling back to local search:', e.message);
      // Invalidate cache immediately so next search re-checks
      _usingBackend = false;
      _backendCheckedAt = 0;
    }
  }
  return _localSearch(query);
}

// ── Remote search (FastAPI → Elasticsearch) ────────────────────────────────

async function _remoteSearch(query) {
  const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(query)}&size=20`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  // FIX 1: API returns `citations` but the frontend expects `cite`.
  // Also copy `cluster_id` → `cluster` and `cluster_color` → `color` for
  // compatibility with galaxy.js / panel.js.
  return (data.results || []).map(r => ({
    ...r,
    cite: r.cite ?? r.citations ?? 0,
    cluster: r.cluster ?? r.cluster_id ?? '',
    color: r.color ?? r.cluster_color ?? '#ffffff',
    score: r.score ?? 0.5,
  }));
}

async function _checkBackend() {
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Local keyword search (works with no backend) ───────────────────────────

function _localSearch(query) {
  const q = query.toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  const scores = {};

  FALLBACK_PAPERS.forEach(p => { scores[p.id] = 0; });

  // Score via keyword map
  Object.entries(KEYWORD_MAP).forEach(([kw, ids]) => {
    if (tokens.some(tok => kw.includes(tok) || tok.includes(kw))) {
      ids.forEach(id => { scores[id] = (scores[id] || 0) + 2; });
    }
  });

  // Score via paper fields
  FALLBACK_PAPERS.forEach(p => {
    tokens.forEach(tok => {
      if ((p.title || '').toLowerCase().includes(tok)) scores[p.id] += 2;
      if ((p.abstract || '').toLowerCase().includes(tok)) scores[p.id] += 0.5;
      (p.keywords || []).forEach(kw => {
        if (kw.includes(tok) || tok.includes(kw)) scores[p.id] += 1;
      });
    });
  });

  const results = FALLBACK_PAPERS
    .filter(p => scores[p.id] > 0)
    .sort((a, b) => scores[b.id] - scores[a.id])
    .map(p => ({
      ...p,
      cite: p.cite ?? p.citations ?? 0, // FIX 2: unify field
      score: Math.min(0.99, scores[p.id] / 6),
    }));

  // If nothing matched, return a small random selection
  if (!results.length) {
    return FALLBACK_PAPERS
      .slice(0, 5)
      .map(p => ({ ...p, cite: p.cite ?? p.citations ?? 0, score: Math.random() * 0.2 + 0.1 }));
  }
  return results;
}