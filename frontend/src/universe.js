/**
 * search-comete - universe.js
 * "My universe": start from an empty sky and grow your own map by searching.
 *
 * The 54k-paper galaxy stays as faint dust and acts as a coordinate system:
 * every paper you find is placed where it belongs by meaning (meaning.js),
 * so related finds end up near each other even though you started empty.
 * Galaxy papers you find light up in place; new ones become stars of their
 * own. Saved in localStorage.
 */

import { hasStar, getRemappedPos, setGhost, setFound, setVisitors, clearVisitors, getClusterAnchors } from './galaxy.js';
import { belonging, loadMeaning } from './meaning.js';

const KEY = 'search-comete-universe';
const MODE_KEY = 'search-comete-mode';

let mode = 'galaxy';
const found = new Map();   // id -> { paper, x, y, z } (x/y/z only for papers not in the galaxy)
const listeners = new Set();

export const onUniverseChange = (fn) => listeners.add(fn);
const _emit = () => listeners.forEach(fn => fn());

export function getMode() { return mode; }
export function universeSize() { return found.size; }
export function inUniverse(id) { return found.has(String(id)); }

export function initUniverse() {
  try {
    mode = localStorage.getItem(MODE_KEY) === 'universe' ? 'universe' : 'galaxy';
    JSON.parse(localStorage.getItem(KEY) || '[]').forEach(f => found.set(f.paper.id, f));
  } catch { /* fresh start */ }
  if (new URLSearchParams(location.search).get('mode') === 'universe') mode = 'universe';
  _apply();
}

export function setMode(next) {
  mode = next === 'universe' ? 'universe' : 'galaxy';
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* private mode */ }
  if (mode === 'universe') loadMeaning().catch(() => {});
  _apply();
}

/**
 * Add papers to the universe. Papers outside the galaxy are placed by
 * meaning; `hint` positions (e.g. from live search) are used until then.
 */
export async function addToUniverse(papers, hints = new Map()) {
  const fresh = papers.filter(p => p && !found.has(String(p.id)));
  if (!fresh.length) return;
  fresh.forEach(p => {
    const id = String(p.id);
    const slim = { id, title: p.title, authors: p.authors, year: p.year, cite: p.cite ?? 0, cluster: p.cluster, live: p.live };
    found.set(id, hasStar(id) ? { paper: slim } : { paper: slim, ...(hints.get(id) || _fallbackPos(p)) });
  });
  _apply();

  // Refine positions of new stars by meaning (loads the small model once)
  const outside = fresh.filter(p => !hasStar(p.id));
  if (!outside.length) return;
  try {
    for (const p of outside) {
      const b = await belonging(p);
      const f = found.get(String(p.id));
      if (!b || !f) continue;
      const j = _jitter(p.id);
      Object.assign(f, { x: b.position.x + j[0], y: b.position.y + j[1], z: b.position.z + j[2] });
      f.paper.cluster = f.paper.cluster || b.cluster;
    }
    _apply();
  } catch (e) {
    console.warn('[universe] placing by meaning failed:', e.message);
  }
}

export function removeFromUniverse(id) {
  found.delete(String(id));
  _apply();
}

export function clearUniverse() {
  found.clear();
  _apply();
}

function _apply() {
  setGhost(mode === 'universe');
  setFound([...found.keys()].filter(id => hasStar(id)));
  const outside = [...found.values()].filter(f => !hasStar(f.paper.id) && f.x != null);
  if (mode === 'universe' && outside.length) setVisitors(outside.map(f => ({ paper: f.paper, x: f.x, y: f.y, z: f.z })), 'found');
  else clearVisitors('found');
  try { localStorage.setItem(KEY, JSON.stringify([...found.values()])); } catch { /* full */ }
  _emit();
}

function _fallbackPos(p) {
  const a = getRemappedPos(p.id) || getClusterAnchors()[p.cluster] || { x: 0, y: 0, z: 0 };
  const j = _jitter(p.id, 6);
  return { x: a.x + j[0], y: a.y + j[1], z: a.z + j[2] };
}

// Small deterministic offset so a new star doesn't sit exactly on a neighbour
function _jitter(id, r = 0.9) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) | 0;
  const a = (h % 1000) / 1000 * Math.PI * 2, b = ((h >> 10) % 1000) / 1000 * Math.PI;
  return [Math.sin(b) * Math.cos(a) * r, Math.cos(b) * r, Math.sin(b) * Math.sin(a) * r];
}
