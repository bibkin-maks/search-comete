/**
 * search-comete - tree.js
 * The citation tree you grow, and that arranges itself.
 *
 * Growing: expand any paper by its references ('ref', its past) or the
 * papers citing it ('cite', its future), or let autoGrow() do it: both
 * directions from the seed, then the most important new papers, round after
 * round, until a size budget. Everything is kept (localStorage).
 *
 * Arranging: a small physics simulation over the tree's papers.
 *  - every citation link is a spring, so connected papers stay together;
 *    links between branches (cross-citations) are weaker springs that pull
 *    related branches towards each other
 *  - every paper pushes the others away, so nothing piles up
 *  - time is height: each paper is pulled to a height set by its year
 *    relative to the root, so the past hangs below and the future rises
 *  - roots stay pinned where they are in the galaxy
 * New papers are born at their parent and spring outward, so the tree
 * visibly grows. The simulation cools down and stops when it settles.
 */

import { traceReferences, traceCitedBy } from './graph.js';
import {
  getRemappedPos, hasStar, setVisitors, clearVisitors, setWebLinks, moveWebLinks, highlightStars,
  clearHighlights, flyToCluster, getClusterAnchors, getClock, registerFrameHook,
} from './galaxy.js';

const KEY = 'search-comete-tree';
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const COLORS = { ref: 0x9fb4ff, cite: 0xffd27a, cross: 0x8a8fb0 };

// id -> { id, paper, x, y, z, vx, vy, vz, parent, role: 'root'|'ref'|'cite', depth, born, expanded }
const nodes = new Map();
// "from>to" -> { from, to, kind: 'ref'|'cite'|'cross', born }
const edges = new Map();
const listeners = new Set();

let heat = 0;                 // simulation temperature: 1 = just grown, 0 = settled
let linkList = [];            // edges as an array, in the order the link layer holds them
let saveTimer = null;

export const onTreeChange = (fn) => listeners.add(fn);
const _emit = () => listeners.forEach(fn => fn());

export function treeHas(id) { return nodes.has(String(id)); }
export function treeNode(id) { return nodes.get(String(id)); }
export function treeNodes() { return [...nodes.values()]; }
export function treeSize() { return nodes.size; }

/** Children of a node in the tree (the papers it brought in), split by role. */
export function treeChildren(id) {
  const out = { ref: [], cite: [] };
  nodes.forEach(n => { if (n.parent === id) out[n.role]?.push(n); });
  return out;
}

// ── Growing ───────────────────────────────────────────────────────────────────

/**
 * Expand `paper` by its references ('ref') or citing papers ('cite'),
 * `depth` levels deep, keeping at most `limit` papers per level.
 */
export async function grow(paper, kind = 'ref', depth = 1, onStatus, { limit, fly = true } = {}) {
  _ensureHook();
  const rootId = String(paper.id);
  const t0 = getClock();
  let start = nodes.get(rootId);
  if (!start) start = _addNode(_slim(paper), _startPos(paper), { parent: null, role: 'root', depth: 0, born: t0 });

  const trace = await (kind === 'ref' ? traceReferences : traceCitedBy)(rootId, depth, onStatus, { limit });
  const traceRoot = trace.root.id;
  const alias = (id) => (id === traceRoot ? rootId : id);

  const firstParent = new Map();
  trace.edges.forEach(e => {
    const to = alias(e.to), from = alias(e.from);
    if (!e.cross && !firstParent.has(to) && to !== rootId) firstParent.set(to, from);
  });

  // Level by level so parents exist before their children
  const levels = [];
  trace.nodes.forEach(n => { if (n.depth > 0) (levels[n.depth] ||= []).push(n); });
  let added = 0;
  levels.forEach((level, d) => {
    const byParent = new Map();
    level.forEach(n => {
      const id = alias(n.paper.id);
      if (nodes.has(id)) return;
      const parent = firstParent.get(id) || rootId;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push({ paper: n.paper, votes: n.votes });
    });
    byParent.forEach((items, parentId) => {
      const parent = nodes.get(parentId) || start;
      items.sort((a, b) => (b.votes - a.votes) || (b.paper.cite - a.paper.cite));
      const existing = treeChildren(parent.id)[kind].length;
      items.forEach(({ paper: p, votes }, i) => {
        // Born just next to the parent; the simulation springs it out
        const pos = _place(parent, p, kind, existing + i, d);
        const node = _addNode(_slim(p), {
          x: parent.x + (pos.x - parent.x) * 0.25, y: parent.y + (pos.y - parent.y) * 0.25, z: parent.z + (pos.z - parent.z) * 0.25,
        }, { parent: parent.id, role: kind, depth: parent.depth + 1, votes, born: t0 + 0.2 + (d - 1) * 0.6 + i * 0.02 });
        node.vx = (pos.x - parent.x) * 0.05; node.vy = (pos.y - parent.y) * 0.05; node.vz = (pos.z - parent.z) * 0.05;
        added++;
      });
    });
  });

  trace.edges.forEach(e => {
    const from = alias(e.from), to = alias(e.to);
    if (!nodes.has(from) || !nodes.has(to)) return;
    const key = `${from}>${to}`;
    if (edges.has(key)) return;
    edges.set(key, { from, to, kind: e.cross || nodes.get(to).parent !== from ? 'cross' : kind, born: Math.max(nodes.get(to).born - 0.2, t0) });
  });

  start.expanded = { ...start.expanded, [kind]: true };
  _rebuild();
  heat = 1;
  if (fly) flyToCluster(start);
  _emit();
  return { added, total: trace.nodes.size - 1, citedByTotal: trace.total };
}

/**
 * Let the tree grow by itself from `paper`: its references and citing
 * papers, then the most important new papers on each side, round by
 * round, until about `budget` papers. `signal.stop` ends it early.
 */
export async function autoGrow(paper, { budget = 140, rounds = 3, onStatus, signal = {} } = {}) {
  const say = (m) => onStatus?.(m);
  const seed = String(paper.id);
  say('Rooting: what it builds on');
  await grow(paper, 'ref', 1, null, { limit: 24 });
  if (signal.stop) return;
  say('Branching: what built on it');
  await grow(paper, 'cite', 1, null, { limit: 18, fly: false });

  let frontier = { ref: treeChildren(seed).ref, cite: treeChildren(seed).cite };
  for (let r = 0; r < rounds && !signal.stop && nodes.size < budget; r++) {
    const next = { ref: [], cite: [] };
    for (const kind of ['ref', 'cite']) {
      // Most important = shared by several of the previous papers, then most cited
      const pick = [...frontier[kind]]
        .filter(n => !n.expanded?.[kind])
        .sort((a, b) => (b.votes || 1) - (a.votes || 1) || (b.paper.cite || 0) - (a.paper.cite || 0))
        .slice(0, r === 0 ? 3 : 2);
      for (const n of pick) {
        if (signal.stop || nodes.size >= budget) break;
        say(`${kind === 'ref' ? 'Deeper roots' : 'Higher branches'}: ${n.paper.title.slice(0, 48)}…`);
        try {
          await grow(n.paper, kind, 1, null, { limit: kind === 'ref' ? 10 : 8, fly: false });
          next[kind].push(...treeChildren(n.id)[kind]);
        } catch { /* one paper failing shouldn't stop the tree */ }
      }
    }
    frontier = next;
  }
  say(`Grown: ${nodes.size} papers`);
}

/** Remove a node and everything that grew from it. */
export function prune(id) {
  const doomed = new Set([String(id)]);
  let more = true;
  while (more) {
    more = false;
    nodes.forEach(n => { if (n.parent && doomed.has(n.parent) && !doomed.has(n.id)) { doomed.add(n.id); more = true; } });
  }
  doomed.forEach(d => nodes.delete(d));
  edges.forEach((e, k) => { if (doomed.has(e.from) || doomed.has(e.to)) edges.delete(k); });
  _rebuild();
  heat = Math.max(heat, 0.5);
  _emit();
}

export function clearTree() {
  nodes.clear();
  edges.clear();
  linkList = [];
  _save();
  setWebLinks([]);
  clearVisitors('web');
  clearHighlights();
  _emit();
}

export function restoreTree() {
  _ensureHook();
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (data) {
      data.nodes.forEach(n => nodes.set(n.id, { vx: 0, vy: 0, vz: 0, ...n, born: -1e6 }));
      data.edges.forEach(e => edges.set(`${e.from}>${e.to}`, { ...e, born: -1e6 }));
    }
  } catch { nodes.clear(); edges.clear(); }
  if (nodes.size) _rebuild();
  _emit();
}

// ── Layout: initial guess + physics ───────────────────────────────────────────

function _startPos(paper) {
  const p = getRemappedPos(paper.id);
  if (p) return p;
  const a = getClusterAnchors()[paper.cluster];
  return a ? { x: a.x, y: a.y + 40, z: a.z } : { x: 0, y: 60, z: 0 };
}

function _rootOf(node) {
  let n = node;
  while (n.parent && nodes.has(n.parent)) n = nodes.get(n.parent);
  return n;
}

// Initial guess: sunflower disc below (refs) or above (citations) the parent,
// leaning away from the trunk. The simulation takes it from there.
function _place(parent, paper, kind, i, level) {
  const dir = kind === 'ref' ? -1 : 1;
  const root = _rootOf(parent);
  let ox = parent.x - root.x, oz = parent.z - root.z;
  const len = Math.hypot(ox, oz);
  if (len > 1e-3) { ox /= len; oz /= len; } else { ox = 0; oz = 0; }
  const r = (parent.depth === 0 ? 1.15 : 0.8) * Math.sqrt(i + 0.6);
  const lean = parent.depth === 0 ? 0 : 2.4 + Math.sqrt(i) * 0.25;
  const angle = i * GOLDEN + ([...parent.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) % 628) / 100;
  return {
    x: parent.x + Math.cos(angle) * r + ox * lean,
    y: parent.y + _heightFor(paper, parent.paper, dir, level),
    z: parent.z + Math.sin(angle) * r + oz * lean,
  };
}

function _heightFor(paper, rel, dir, level = 1) {
  const years = paper.year && rel.year ? paper.year - rel.year : dir * 3;
  return dir * (3.2 + level * 0.4) + Math.max(-7, Math.min(7, years * 0.14));
}

// One simulation step. dt-independent enough at 30-144 fps because the
// forces are applied with the frame time and velocities are damped per step.
function _tick(delta) {
  if (heat < 0.01 || nodes.size < 2) return;
  const list = [...nodes.values()];
  const n = list.length;
  const k = Math.min(delta, 0.05) * 60 * heat;

  // Repulsion (n is at most a few hundred, so all pairs is fine)
  for (let i = 0; i < n; i++) {
    const a = list[i];
    for (let j = i + 1; j < n; j++) {
      const b = list[j];
      let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      let d2 = dx*dx + dy*dy + dz*dz;
      if (d2 > 64) continue;
      if (d2 < 1e-4) { dx = Math.random() - 0.5; dz = Math.random() - 0.5; d2 = 0.01; }
      const f = Math.min(0.6, 0.9 / d2) * k;
      const d = Math.sqrt(d2);
      dx /= d; dy /= d; dz /= d;
      a.vx += dx * f; a.vy += dy * f * 0.5; a.vz += dz * f;
      b.vx -= dx * f; b.vy -= dy * f * 0.5; b.vz -= dz * f;
    }
  }
  // Springs along citations; cross-links are weaker and a bit longer
  edges.forEach(e => {
    const a = nodes.get(e.from), b = nodes.get(e.to);
    if (!a || !b) return;
    const cross = e.kind === 'cross';
    const rest = cross ? 5.5 : 3.4;
    const s = (cross ? 0.012 : 0.035) * k;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const d = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1e-3;
    const f = (d - rest) * s / d;
    a.vx += dx * f; a.vy += dy * f; a.vz += dz * f;
    b.vx -= dx * f; b.vy -= dy * f; b.vz -= dz * f;
  });
  // Time is height, relative to each paper's root
  list.forEach(node => {
    if (node.role === 'root') return;
    const root = _rootOf(node);
    const dir = node.role === 'ref' ? -1 : 1;
    const ty = root.y + _heightFor(node.paper, root.paper, dir, node.depth) * (0.8 + node.depth * 0.35);
    node.vy += (ty - node.y) * 0.02 * k;
  });
  // Integrate; roots stay pinned to their place in the galaxy
  list.forEach(node => {
    if (node.role === 'root') { node.vx = node.vy = node.vz = 0; return; }
    node.vx *= 0.82; node.vy *= 0.82; node.vz *= 0.82;
    node.x += node.vx; node.y += node.vy; node.z += node.vz;
  });

  heat *= Math.pow(0.992, delta * 60);
  _draw(false);
  if (heat < 0.01) _save();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function _rebuild() {
  linkList = [...edges.values()];
  _draw(true);
  const inGalaxy = [...nodes.values()].filter(n => hasStar(n.id)).map(n => n.id);
  if (inGalaxy.length) highlightStars(inGalaxy);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(_save, 1500);
}

function _draw(structural) {
  const list = [...nodes.values()];
  // Every paper in the tree is drawn as a tree node, even ones that also
  // live in the galaxy; those galaxy stars light up too.
  setVisitors(list.filter(n => n.role !== 'root' || !hasStar(n.id)).map(n => ({ paper: n.paper, x: n.x, y: n.y, z: n.z, born: n.born })), 'web');
  const links = linkList.map(e => {
    const a = nodes.get(e.from), b = nodes.get(e.to);
    return {
      from: a, to: b, born: e.born,
      year: Math.max(Number(a.paper.year) || 0, Number(b.paper.year) || 0),
      color: COLORS[e.kind] ?? COLORS.cross,
      strength: e.kind === 'cross' ? 0.3 : Math.max(0.45, 1 - (b.depth - 1) * 0.2),
    };
  });
  if (structural) setWebLinks(links);
  else moveWebLinks(links);
}

// Registered on first use, not at import: tree.js is part of an import cycle
// with galaxy.js (galaxy -> panel -> workspace -> tree), so galaxy's state
// isn't initialised yet while this module is first evaluated.
let _hooked = false;
function _ensureHook() {
  if (_hooked) return;
  _hooked = true;
  registerFrameHook(_tick);
}

function _addNode(paper, pos, meta) {
  const node = { id: String(paper.id), paper, x: pos.x, y: pos.y, z: pos.z, vx: 0, vy: 0, vz: 0, expanded: {}, ...meta };
  nodes.set(node.id, node);
  return node;
}

function _slim(p) {
  return { id: String(p.id), title: p.title, authors: p.authors, year: p.year, cite: p.cite ?? 0, cluster: p.cluster, live: p.live };
}

function _save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      nodes: [...nodes.values()].map(({ born, vx, vy, vz, ...n }) => n),
      edges: [...edges.values()].map(({ born, ...e }) => e),
    }));
  } catch { /* storage full or private mode: the tree just won't persist */ }
}
