/**
 * search-comete - tree.js
 * The citation tree you grow, one expansion at a time, and keep.
 *
 * Layout: time is height. A paper's references (its past) grow *down* from
 * it like roots, papers citing it (its future) grow *up* like branches, and
 * older/newer papers sit further down/up. Siblings are spread on a sunflower
 * spiral (golden angle) so 40 references fan out evenly instead of piling
 * up, and every sub-branch leans away from the trunk so branches don't
 * cross. Expanding a node that's already in the tree only adds what's new,
 * so the tree keeps growing; it's saved in localStorage.
 */

import { traceReferences, traceCitedBy } from './graph.js';
import {
  getRemappedPos, hasStar, setVisitors, clearVisitors, setWebLinks, highlightStars, clearHighlights,
  flyToCluster, getClusterAnchors, getClock,
} from './galaxy.js';

const KEY = 'search-comete-tree';
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const COLORS = { ref: 0x9fb4ff, cite: 0xffd27a, cross: 0x8a8fb0 };

// id -> { id, paper, x, y, z, parent, role: 'root'|'ref'|'cite', depth, born, expanded: { ref, cite } }
const nodes = new Map();
// "from>to" -> { from, to, kind: 'ref'|'cite'|'cross', born }
const edges = new Map();
const listeners = new Set();

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
 * `depth` levels deep. New papers are placed and animated in; papers
 * already in the tree only get the new connection.
 */
export async function grow(paper, kind = 'ref', depth = 1, onStatus) {
  const rootId = String(paper.id);
  const t0 = getClock();
  let start = nodes.get(rootId);
  if (!start) {
    start = _addNode(_slim(paper), _startPos(paper), { parent: null, role: 'root', depth: 0, born: t0 });
  }

  const trace = await (kind === 'ref' ? traceReferences : traceCitedBy)(rootId, depth, onStatus);
  // The OpenAlex record can carry a canonical id that differs from the galaxy one
  const traceRoot = trace.root.id;
  const alias = (id) => (id === traceRoot ? rootId : id);

  // First parent of each new paper decides where it grows
  const firstParent = new Map();
  trace.edges.forEach(e => {
    const to = alias(e.to), from = alias(e.from);
    if (!e.cross && !firstParent.has(to) && to !== rootId) firstParent.set(to, from);
  });

  // Place level by level so parents exist before their children
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
      byParent.get(parent).push(n.paper);
    });
    byParent.forEach((papers, parentId) => {
      const parent = nodes.get(parentId) || start;
      papers.sort((a, b) => (kind === 'ref' ? b.year - a.year : a.year - b.year) || b.cite - a.cite);
      const existing = treeChildren(parent.id)[kind].length;
      papers.forEach((p, i) => {
        const pos = _place(parent, p, kind, existing + i, d);
        // Stagger: each level starts after the previous one, siblings ripple out
        _addNode(_slim(p), pos, { parent: parent.id, role: kind, depth: parent.depth + 1, born: t0 + 0.3 + (d - 1) * 0.9 + i * 0.025 });
        added++;
      });
    });
  });

  // Edges: every connection in the trace, including links back into the tree
  trace.edges.forEach(e => {
    const from = alias(e.from), to = alias(e.to);
    if (!nodes.has(from) || !nodes.has(to)) return;
    const key = `${from}>${to}`;
    if (edges.has(key)) return;
    const born = nodes.get(to).born;
    edges.set(key, { from, to, kind: e.cross || nodes.get(to).parent !== from ? 'cross' : kind, born: Math.max(born - 0.2, t0) });
  });

  start.expanded = { ...start.expanded, [kind]: true };
  _save();
  _render();
  flyToCluster(start);
  _emit();
  return { added, total: trace.nodes.size - 1, citedByTotal: trace.total };
}

/** Remove a node and everything that grew from it. */
export function prune(id) {
  const doomed = new Set([String(id)]);
  let grew = true;
  while (grew) {
    grew = false;
    nodes.forEach(n => { if (n.parent && doomed.has(n.parent) && !doomed.has(n.id)) { doomed.add(n.id); grew = true; } });
  }
  doomed.forEach(d => nodes.delete(d));
  edges.forEach((e, k) => { if (doomed.has(e.from) || doomed.has(e.to)) edges.delete(k); });
  _save();
  _render();
  _emit();
}

export function clearTree() {
  nodes.clear();
  edges.clear();
  _save();
  setWebLinks([]);
  clearVisitors('web');
  clearHighlights();
  _emit();
}

export function restoreTree() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!data) return;
    data.nodes.forEach(n => nodes.set(n.id, { ...n, born: -1e6 }));
    data.edges.forEach(e => edges.set(`${e.from}>${e.to}`, { ...e, born: -1e6 }));
  } catch { nodes.clear(); edges.clear(); }
  if (nodes.size) _render();
  _emit();
}

// ── Layout ────────────────────────────────────────────────────────────────────

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

/**
 * Where the i-th child of `parent` goes. Sunflower disc below (refs) or
 * above (citations) the parent, pushed outward from the tree's trunk.
 */
function _place(parent, paper, kind, i, level) {
  const dir = kind === 'ref' ? -1 : 1;
  const root = _rootOf(parent);
  // Lean away from the trunk so sub-branches don't cross each other
  let ox = parent.x - root.x, oz = parent.z - root.z;
  const len = Math.hypot(ox, oz);
  if (len > 1e-3) { ox /= len; oz /= len; } else { ox = 0; oz = 0; }
  const spacing = parent.depth === 0 ? 1.15 : 0.8;
  const lean = parent.depth === 0 ? 0 : 2.4 + Math.sqrt(i) * 0.25;

  const r = spacing * Math.sqrt(i + 0.6);
  const seed = ([...parent.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) % 628) / 100;
  const angle = i * GOLDEN + seed;
  // Time is height: the further apart in years, the further down/up
  const years = paper.year && parent.paper.year ? paper.year - parent.paper.year : dir * 3;
  const rise = dir * (3.2 + level * 0.4) + Math.max(-7, Math.min(7, years * 0.14));

  return {
    x: parent.x + Math.cos(angle) * r + ox * lean,
    y: parent.y + rise,
    z: parent.z + Math.sin(angle) * r + oz * lean,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function _render() {
  const list = [...nodes.values()];
  // Every paper in the tree is drawn as a tree node, even ones that also
  // live in the galaxy; those galaxy stars light up too, showing where the
  // tree's papers sit in the map of fields.
  setVisitors(list.filter(n => n.role !== 'root' || !hasStar(n.id)).map(n => ({ paper: n.paper, x: n.x, y: n.y, z: n.z, born: n.born })), 'web');
  setWebLinks([...edges.values()].map(e => {
    const a = nodes.get(e.from), b = nodes.get(e.to);
    return {
      from: a, to: b, born: e.born,
      year: Math.max(Number(a.paper.year) || 0, Number(b.paper.year) || 0),
      color: COLORS[e.kind] ?? COLORS.cross,
      strength: e.kind === 'cross' ? 0.3 : Math.max(0.45, 1 - (b.depth - 1) * 0.2),
    };
  }));
  const inGalaxy = list.filter(n => hasStar(n.id)).map(n => n.id);
  if (inGalaxy.length) highlightStars(inGalaxy);
}

function _addNode(paper, pos, meta) {
  const node = { id: String(paper.id), paper, x: pos.x, y: pos.y, z: pos.z, expanded: {}, ...meta };
  nodes.set(node.id, node);
  return node;
}

function _slim(p) {
  return { id: String(p.id), title: p.title, authors: p.authors, year: p.year, cite: p.cite ?? 0, cluster: p.cluster, live: p.live };
}

function _save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      nodes: [...nodes.values()].map(({ born, ...n }) => n),
      edges: [...edges.values()].map(({ born, ...e }) => e),
    }));
  } catch { /* storage full or private mode: the tree just won't persist */ }
}
