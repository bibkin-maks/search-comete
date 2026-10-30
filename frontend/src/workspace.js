/**
 * search-comete - workspace.js
 * The left dock, where you actually work:
 *  - Fields: every field with its size, click to fly there, meteor of the day
 *  - Pinned: papers you collected, and ropes tied between them. A rope opens
 *    a comparison: map distance, shared references, co-citations, direct
 *    citation, shared topics, plus an optional on-device AI summary.
 *  - Web: the citation tree you grow (tree.js), as a foldable outline
 * Pins and ropes are saved in localStorage.
 */

import {
  filterCluster, clearHighlights, highlightStars, togglePinned, isPinned, getRemappedPos,
  hasStar, setRopes, setVisitors, clearVisitors, flyTo, flyToCluster, CLUSTER_COLORS,
} from './galaxy.js';
import { showDetail } from './panel.js';
import { compareFacts } from './graph.js';
import { grow, prune, clearTree, restoreTree, onTreeChange, treeNodes, treeChildren, treeHas, treeNode } from './tree.js';
import { explainPair, loadLLM, llmInfo } from './llm.js';
import { icon } from './icons.js';

const PIN_KEY  = 'search-comete-pins';
const ROPE_KEY = 'search-comete-ropes';

export const FIELD_META = {
  ml:    { label: 'Machine Learning',  group: 'AI & Computing'   },
  cs:    { label: 'Computer Science',  group: 'AI & Computing'   },
  math:  { label: 'Mathematics',       group: 'Formal Sciences'  },
  phys:  { label: 'Physics',           group: 'Natural Sciences' },
  astro: { label: 'Astronomy',         group: 'Natural Sciences' },
  chem:  { label: 'Chemistry',         group: 'Natural Sciences' },
  mat:   { label: 'Materials Science', group: 'Natural Sciences' },
  bio:   { label: 'Biology',           group: 'Life Sciences'    },
  neuro: { label: 'Neuroscience',      group: 'Life Sciences'    },
  med:   { label: 'Medicine',          group: 'Life Sciences'    },
  eng:   { label: 'Engineering',       group: 'Applied Sciences' },
  env:   { label: 'Environment',       group: 'Applied Sciences' },
  econ:  { label: 'Economics',         group: 'Social Sciences'  },
  psych: { label: 'Psychology',        group: 'Social Sciences'  },
  edu:   { label: 'Education',         group: 'Social Sciences'  },
};
const GROUP_ORDER = ['AI & Computing', 'Formal Sciences', 'Natural Sciences', 'Life Sciences', 'Applied Sciences', 'Social Sciences', 'Other'];

export function fieldLabel(id) {
  return FIELD_META[id]?.label || (id || 'Unmapped').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

let corpus = new Map();
let pins = new Map();     // id -> { id, title, authors, year, cite, cluster, x, y, z }
let ropes = [];           // [{ a, b }]
let ropeFrom = null;
const collapsed = new Set();   // tree outline rows that are folded
const growing = new Set();     // tree nodes currently being expanded
const factsCache = new Map();

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hex = (id) => '#' + (CLUSTER_COLORS[id] ?? 0xe3c27a).toString(16).padStart(6, '0');
const ropeKey = (a, b) => [a, b].sort().join('|');

// ── Init ──────────────────────────────────────────────────────────────────────

export function initWorkspace(stars) {
  corpus = new Map(stars.map(s => [String(s.id), s]));

  document.querySelectorAll('#dock .tab').forEach(tab => tab.addEventListener('click', () => setTab(tab.dataset.tab)));
  $('dock-toggle').addEventListener('click', () => $('dock').classList.toggle('open-mobile'));

  _buildFields(stars);
  _restore();
  _renderPinned();
  onTreeChange(_renderWeb);
  restoreTree();
  _renderWeb();
}

export function setTab(name) {
  document.querySelectorAll('#dock .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('#dock .tab-body').forEach(b => b.classList.toggle('active', b.id === `tab-${name}`));
  $('dock').classList.remove('collapsed');
}

// ── Fields ────────────────────────────────────────────────────────────────────

function _buildFields(stars) {
  const counts = {};
  stars.forEach(s => { counts[s.cluster] = (counts[s.cluster] || 0) + 1; });
  const max = Math.max(...Object.values(counts));
  const groups = {};
  Object.keys(counts).sort().forEach(id => {
    const g = FIELD_META[id]?.group || 'Other';
    (groups[g] ||= []).push(id);
  });

  const row = (id, label, n, color, active = false) => `
    <div class="field-row${active ? ' active' : ''}" data-cluster="${id}" role="button" tabindex="0">
      <span class="swatch" style="background:${color};color:${color}"></span>${esc(label)}
      <span class="n">${n.toLocaleString()}</span>
    </div>`;

  $('legend').innerHTML = row('all', 'All fields', stars.length, 'rgba(243,239,230,0.6)', true) +
    GROUP_ORDER.filter(g => groups[g]).map(g => `
      <div class="field-group">
        <div class="eyebrow">${g}</div>
        ${groups[g].map(id => row(id, fieldLabel(id), counts[id], hex(id)) +
          `<div class="field-bar"><span style="width:${(counts[id] / max * 100).toFixed(1)}%;background:${hex(id)}"></span></div>`).join('')}
      </div>`).join('');

  $('legend').querySelectorAll('.field-row').forEach(el => {
    const go = () => focusField(el.dataset.cluster);
    el.addEventListener('click', go);
    el.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  });
}

export function focusField(id) {
  document.querySelectorAll('#legend .field-row').forEach(r => r.classList.toggle('active', r.dataset.cluster === id));
  if (id === 'all') clearHighlights();
  filterCluster(id);
}

// ── Pins ──────────────────────────────────────────────────────────────────────

function _save() {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify([...pins.values()]));
    localStorage.setItem(ROPE_KEY, JSON.stringify(ropes));
  } catch { /* private mode: pins just won't persist */ }
}

function _restore() {
  try {
    JSON.parse(localStorage.getItem(PIN_KEY) || '[]').forEach(p => pins.set(p.id, p));
    ropes = JSON.parse(localStorage.getItem(ROPE_KEY) || '[]').filter(r => pins.has(r.a) && pins.has(r.b));
  } catch { pins = new Map(); ropes = []; }
  pins.forEach(p => { if (hasStar(p.id) && !isPinned(p.id)) togglePinned(p.id); });
  _syncPinVisitors();
  _syncRopes();
}

export function isPaperPinned(id) { return pins.has(String(id)); }
export function getPins() { return [...pins.values()]; }

export function togglePin(paper) {
  const id = String(paper.id);
  if (pins.has(id)) {
    pins.delete(id);
    ropes = ropes.filter(r => r.a !== id && r.b !== id);
    if (hasStar(id) && isPinned(id)) togglePinned(id);
  } else {
    const pos = getRemappedPos(id) || {};
    pins.set(id, {
      id, title: paper.title, authors: paper.authors, year: paper.year, cite: paper.cite ?? 0,
      cluster: paper.cluster, x: pos.x, y: pos.y, z: pos.z,
    });
    if (hasStar(id) && !isPinned(id)) togglePinned(id);
  }
  _save();
  _syncPinVisitors();
  _syncRopes();
  _renderPinned();
  return pins.has(id);
}

// Pinned live results aren't galaxy stars: keep them visible as visitors
function _syncPinVisitors() {
  const extra = [...pins.values()].filter(p => !hasStar(p.id) && p.x != null);
  if (extra.length) setVisitors(extra.map(p => ({ paper: p, x: p.x, y: p.y, z: p.z })), 'pins');
  else clearVisitors('pins');
}

function _pos(id) {
  return getRemappedPos(id) || (pins.get(id)?.x != null ? pins.get(id) : null);
}

function _syncRopes() {
  const year = (id) => Number((pins.get(id) || corpus.get(id))?.year) || 0;
  setRopes(ropes.map(r => ({ from: _pos(r.a), to: _pos(r.b), year: Math.max(year(r.a), year(r.b)) })).filter(l => l.from && l.to));
}

// ── Ropes ─────────────────────────────────────────────────────────────────────

/** Start tying a rope from `paper`: the next pin you pick is the other end. */
export function startRope(paper) {
  if (!pins.has(String(paper.id))) togglePin(paper);
  ropeFrom = String(paper.id);
  setTab('pinned');
  _renderPinned();
}

export function tieRope(aId, bId) {
  [aId, bId] = [String(aId), String(bId)];
  ropeFrom = null;
  if (aId === bId) { _renderPinned(); return; }
  if (!ropes.some(r => ropeKey(r.a, r.b) === ropeKey(aId, bId))) ropes.push({ a: aId, b: bId });
  _save();
  _syncRopes();
  _renderPinned();
  openCompare(aId, bId);
}

function _untie(aId, bId) {
  ropes = ropes.filter(r => ropeKey(r.a, r.b) !== ropeKey(aId, bId));
  _save();
  _syncRopes();
  _renderPinned();
  if ($('compare').dataset.key === ropeKey(aId, bId)) closeCompare();
}

function _renderPinned() {
  $('pin-count').textContent = pins.size || '';
  const body = $('tab-pinned');
  if (!pins.size) {
    body.innerHTML = `<div class="empty">${icon.pin}Pin papers from their dossier to collect them here.<br>Tie a rope between two pins to see how they relate.</div>`;
    return;
  }
  const hint = ropeFrom
    ? `<div class="hint">Pick the other end of the rope from <b>${esc(pins.get(ropeFrom)?.title?.slice(0, 60))}</b>… <a href="#" id="rope-cancel">cancel</a></div>`
    : '';
  const rows = [...pins.values()].map(p => `
    <div class="paper-row${ropeFrom === p.id ? ' selecting' : ''}" data-id="${esc(p.id)}">
      <span class="swatch" style="background:${hex(p.cluster)};color:${hex(p.cluster)}"></span>
      <div class="body">
        <div class="title">${esc(p.title)}</div>
        <div class="meta">${esc((p.authors || '').split(',')[0])} · ${p.year || '—'} · ${(p.cite || 0).toLocaleString()} cites</div>
      </div>
      <div class="row-actions">
        <button class="icon-btn" data-act="rope" title="Tie a rope to another pin">${icon.link}</button>
        <button class="icon-btn" data-act="unpin" title="Unpin">${icon.close}</button>
      </div>
    </div>`).join('');
  const ropeRows = ropes.map(r => {
    const a = pins.get(r.a), b = pins.get(r.b);
    const f = factsCache.get(ropeKey(r.a, r.b));
    return `
      <div class="rope-row" data-a="${esc(r.a)}" data-b="${esc(r.b)}">
        ${icon.link}<span class="ends">${esc(a?.title?.slice(0, 32))} ⟷ ${esc(b?.title?.slice(0, 32))}</span>
        <span class="score">${f ? f.score : ''}</span>
        <button class="icon-btn" data-act="untie" title="Remove rope">${icon.close}</button>
      </div>`;
  }).join('');

  body.innerHTML = hint + rows + (ropes.length ? `<div class="section-head"><span class="eyebrow">Ropes</span></div>${ropeRows}` : '');

  $('rope-cancel')?.addEventListener('click', e => { e.preventDefault(); ropeFrom = null; _renderPinned(); });
  body.querySelectorAll('.paper-row').forEach(el => {
    const id = el.dataset.id;
    el.addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'unpin') { togglePin(pins.get(id)); return; }
      if (act === 'rope') { if (ropeFrom && ropeFrom !== id) tieRope(ropeFrom, id); else { ropeFrom = id; _renderPinned(); } return; }
      if (ropeFrom && ropeFrom !== id) { tieRope(ropeFrom, id); return; }
      _open(id);
    });
  });
  body.querySelectorAll('.rope-row').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('[data-act="untie"]')) { _untie(el.dataset.a, el.dataset.b); return; }
      openCompare(el.dataset.a, el.dataset.b);
    });
  });
}

function _open(id) {
  const paper = corpus.get(id) || pins.get(id) || treeNode(id)?.paper;
  if (!paper) return;
  const pos = treeNode(id) || _pos(id);
  if (pos) flyTo(pos);
  showDetail(paper);
}

// ── Compare card ──────────────────────────────────────────────────────────────

export function closeCompare() {
  $('compare').classList.remove('open');
  $('compare').dataset.key = '';
}

export async function openCompare(aId, bId) {
  const card = $('compare');
  const key = ropeKey(aId, bId);
  const a = pins.get(aId) || corpus.get(aId), b = pins.get(bId) || corpus.get(bId);
  if (!a || !b) return;
  card.dataset.key = key;
  card.classList.add('open');

  const pa = _pos(aId), pb = _pos(bId);
  if (pa && pb) flyToCluster({ x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, z: (pa.z + pb.z) / 2 });

  const paperHtml = (p, id) => `
    <div class="cmp-paper" data-id="${esc(id)}">
      <div class="title">${esc(p.title)}</div>
      <div class="meta"><span style="color:${hex(p.cluster)}">●</span> ${esc(fieldLabel(p.cluster))} · ${p.year || '—'} · ${(p.cite || 0).toLocaleString()} cites</div>
    </div>`;
  card.innerHTML = `
    <div class="cmp-head"><span class="eyebrow">${icon.link} Rope analysis</span><button class="icon-btn" id="cmp-close" aria-label="Close">${icon.close}</button></div>
    <div class="cmp-pair">${paperHtml(a, aId)}<div class="cmp-knot">⟷</div>${paperHtml(b, bId)}</div>
    <div id="cmp-body"><div class="live-note">Measuring the rope… reading both papers' references on OpenAlex.</div></div>`;
  $('cmp-close').addEventListener('click', closeCompare);
  card.querySelectorAll('.cmp-paper').forEach(el => el.addEventListener('click', () => _open(el.dataset.id)));

  let facts = factsCache.get(key);
  if (!facts) {
    const distance = pa && pb ? Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z) : null;
    try {
      facts = await compareFacts({ id: aId }, { id: bId }, { distance, sameField: a.cluster && a.cluster === b.cluster });
      factsCache.set(key, facts);
      _renderPinned();
    } catch (e) {
      if (card.dataset.key === key) $('cmp-body').innerHTML = `<div class="live-note">Couldn't compare these (${esc(e.message)}).</div>`;
      return;
    }
  }
  if (card.dataset.key !== key) return;
  _renderFacts(facts, a, b);
}

function _renderFacts(f, a, b) {
  const fact = (k, v, s = '', meter = null) => `
    <div class="cmp-fact"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}
    ${meter != null ? `<div class="meter"><span style="width:${Math.round(meter * 100)}%"></span></div>` : ''}</div>`;
  const closeness = f.distance == null ? null : f.sameField ? Math.exp(-f.distance / 14) : 0.05;
  const direct = f.aCitesB ? 'A cites B' : f.bCitesA ? 'B cites A' : 'No';
  const verdict = f.score >= 60 ? 'closely related' : f.score >= 35 ? 'related' : f.score >= 15 ? 'loosely related' : 'barely related';

  $('cmp-body').innerHTML = `
    <div class="cmp-score"><div class="big">${f.score}</div>
      <div class="label"><b style="color:var(--paper)">${verdict}</b><br>relatedness out of 100, a blend of the signals below</div></div>
    <div class="cmp-grid">
      ${fact('Map distance', f.distance == null ? '—' : `${f.distance.toFixed(1)} units`, f.sameField ? 'Same field, closer = more similar meaning' : `Different fields: ${esc(fieldLabel(a.cluster))} vs ${esc(fieldLabel(b.cluster))}`, closeness)}
      ${fact('Shared references', `${f.sharedRefs}`, f.sharedPapers.length ? f.sharedPapers.slice(0, 2).map(p => esc(p.title.slice(0, 60))).join(' · ') : 'They build on different sources', Math.min(1, f.sharedRefs / 8))}
      ${fact('Cited together', f.coCited == null ? '—' : `${f.coCited.toLocaleString()} papers`, 'Later work that cites both', f.coCited ? Math.min(1, Math.log10(f.coCited + 1) / 3) : 0)}
      ${fact('Direct citation', direct, f.yearGap != null ? `${f.yearGap} years apart (${f.a.year} · ${f.b.year})` : '')}
      ${fact('Shared topics', f.sharedTopics.length ? esc(f.sharedTopics.join(', ')) : 'None', f.sharedKeywords.length ? `Keywords: ${esc(f.sharedKeywords.slice(0, 4).join(', '))}` : '')}
    </div>
    <div class="cmp-ai">
      <div class="eyebrow">${icon.sparkle} On-device AI take · small model, can be wrong</div>
      <p id="cmp-ai-text"></p>
      <button class="btn ice" id="cmp-ai-btn">${icon.sparkle} Explain this rope</button>
      <div class="progress" id="cmp-ai-progress" hidden><span></span></div>
    </div>`;

  $('cmp-ai-btn').addEventListener('click', async () => {
    const btn = $('cmp-ai-btn'), text = $('cmp-ai-text'), bar = $('cmp-ai-progress');
    btn.disabled = true;
    bar.hidden = false;
    try {
      await loadLLM((frac, mb, total) => {
        bar.firstElementChild.style.width = `${Math.round(frac * 100)}%`;
        btn.innerHTML = `${icon.sparkle} Downloading model ${Math.round(mb)} / ${Math.round(total)} MB`;
      });
      bar.hidden = true;
      btn.innerHTML = `${icon.sparkle} Thinking…`;
      const out = await explainPair(f, partial => { text.textContent = partial; });
      text.textContent = out;
      btn.closest('.cmp-ai').querySelector('.eyebrow').innerHTML = `${icon.sparkle} ${llmInfo().label} on your ${llmInfo().device} · small model, can be wrong`;
      btn.innerHTML = `${icon.sparkle} Explain again`;
    } catch (e) {
      text.textContent = `The on-device model couldn't run here (${e.message}).`;
      btn.innerHTML = `${icon.sparkle} Try again`;
    }
    btn.disabled = false;
  });
}

// ── Citation tree ─────────────────────────────────────────────────────────────

/** Grow the tree from `paper`: 'refs' (down, its past) or 'cited' (up, its future). */
export async function traceWeb(paper, direction = 'refs', depth = 1, onStatus) {
  const kind = direction === 'refs' || direction === 'ref' ? 'ref' : 'cite';
  const id = String(paper.id);
  setTab('web');
  growing.add(id);
  // Unfold the node and everything above it so the new branch is visible
  for (let n = treeNode(id); n; n = n.parent ? treeNode(n.parent) : null) collapsed.delete(n.id);
  _renderWeb(`${kind === 'ref' ? 'Growing roots (references)' : 'Growing branches (citations)'} of “${paper.title.slice(0, 60)}”…`);
  try {
    const res = await grow(paper, kind, depth, msg => { onStatus?.(msg); _renderWeb(msg); });
    _flashStatus(res.added ? `+${res.added} papers` : 'Nothing new to add here');
  } catch (e) {
    _flashStatus(`Couldn't grow the tree (${e.message})`);
  }
  growing.delete(id);
  _renderWeb();
}

let _status = '';
function _flashStatus(msg) {
  _status = msg;
  _renderWeb();
  setTimeout(() => { if (_status === msg) { _status = ''; _renderWeb(); } }, 3500);
}

function _renderWeb(progress) {
  const body = $('tab-web');
  const all = treeNodes();
  $('web-count').textContent = all.length || '';
  if (!all.length && !progress) {
    body.innerHTML = `<div class="empty">${icon.web}Grow a citation tree from any paper.<br><br>
      <b>↓ References</b> grow down as roots: the work it builds on.<br>
      <b>↑ Cited by</b> grow up as branches: the work built on it.<br><br>
      Height is time. Expand any paper in the tree to keep growing it; the whole tree is kept.</div>`;
    return;
  }

  const roots = all.filter(n => !n.parent || !treeHas(n.parent));
  const inGalaxy = all.filter(n => hasStar(n.id)).length;
  const row = (n, indent) => {
    const kids = treeChildren(n.id);
    const count = kids.ref.length + kids.cite.length;
    const open = !collapsed.has(n.id);
    const role = n.role === 'ref' ? '↓' : n.role === 'cite' ? '↑' : '◉';
    const busy = growing.has(n.id);
    const group = (list, label) => list.length
      ? `<div class="tree-group" style="--indent:${indent + 1}">${label} · ${list.length}</div>` +
        list.sort((a, b) => (b.paper.cite || 0) - (a.paper.cite || 0)).map(c => row(c, indent + 1)).join('')
      : '';
    return `
      <div class="paper-row tree-row${busy ? ' selecting' : ''}" data-id="${esc(n.id)}" style="--indent:${indent}">
        <button class="twisty" data-act="fold" ${count ? '' : 'disabled'} aria-label="Fold">${count ? (open ? '▾' : '▸') : ''}</button>
        <span class="swatch" style="background:${hex(n.paper.cluster)};color:${hex(n.paper.cluster)}"></span>
        <div class="body">
          <div class="title">${esc(n.paper.title)}</div>
          <div class="meta">${role} ${n.paper.year || '—'} · ${(n.paper.cite || 0).toLocaleString()} cites${hasStar(n.id) ? ' · in galaxy' : ''}${count ? ` · ${count} grown` : ''}</div>
        </div>
        <div class="row-actions">
          <button class="icon-btn" data-act="ref" title="Grow its references (down, the past)" ${busy ? 'disabled' : ''}>↓</button>
          <button class="icon-btn" data-act="cite" title="Grow papers citing it (up, the future)" ${busy ? 'disabled' : ''}>↑</button>
          <button class="icon-btn" data-act="prune" title="Remove this branch">${icon.close}</button>
        </div>
      </div>
      ${open ? group(kids.cite, '↑ Cited by') + group(kids.ref, '↓ References') : ''}`;
  };

  body.innerHTML = `
    <div class="web-source">
      <div class="eyebrow">Citation tree · height is time</div>
      <div class="web-stats" style="margin-top:8px"><span><b>${all.length}</b> papers</span><span><b>${inGalaxy}</b> in galaxy</span><span><b>${roots.length}</b> root${roots.length === 1 ? '' : 's'}</span></div>
      ${progress || _status ? `<div class="hint" style="margin:10px 0 0">${esc(progress || _status)}</div>` : ''}
      <div style="margin-top:10px;display:flex;gap:6px">
        <button class="btn" id="tree-fold">Fold all</button>
        <button class="btn" id="web-clear">${icon.close} Clear tree</button>
      </div>
    </div>
    ${roots.map(r => row(r, 0)).join('')}`;

  $('web-clear').addEventListener('click', () => { collapsed.clear(); clearTree(); });
  $('tree-fold').addEventListener('click', () => {
    treeNodes().forEach(n => { if (n.parent) collapsed.add(n.id); });
    _renderWeb();
  });
  body.querySelectorAll('.tree-row').forEach(el => el.addEventListener('click', e => {
    const id = el.dataset.id;
    const node = treeNode(id);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!node) return;
    if (act === 'fold') { collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); _renderWeb(); return; }
    if (act === 'prune') { prune(id); return; }
    if (act === 'ref' || act === 'cite') { traceWeb(node.paper, act, 1); return; }
    flyTo(node);
    showDetail(corpus.get(id) || node.paper);
  }));
}
