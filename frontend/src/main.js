/**
 * search-comete - main.js
 * Entry point. Injects the UI shell, loads the galaxy data, then wires up the
 * galaxy, search (local + live OpenAlex), detail panel, comets and sound.
 *
 * Features:
 *  - Local search over the 54k mapped papers, highlighted in the galaxy
 *  - Live search across all of OpenAlex; results already in the galaxy light
 *    up, new ones appear as visitor orbs next to their closest neighbours
 *  - Shareable URLs (?q=…&paper=W…), "/" to search, Esc to close
 *  - Time Travel year slider, Meteor of the Day, pinned stars, comets
 */

import './styles.css';
import {
  initGalaxy,
  highlightStars,
  clearHighlights,
  flyTo,
  flyToCluster,
  getRemappedPos,
  hasStar,
  setPivotTarget,
  setVisitors,
  clearVisitors,
  setTheme,
  setViewShift,
  getScene,
  getCamera,
  getRaycaster,
  registerFrameHook,
  getRenderer,
} from './galaxy.js';
import { doSearch, setSearchCorpus, localMatches } from './search.js';
import { showDetail, closeDetail, setCorpus, initPanel } from './panel.js';
import { searchLive, scholarUrl, getWork } from './live.js';
import { USE_BACKEND, API_BASE } from './config.js';
import { FALLBACK_PAPERS } from './data.js';
import { initComets, tickComets, raycastComets, updateCorpus as updateCometCorpus, cleanTitle, stopCometTracking } from './comet.js';
import { initSound, playWarp, playStarClick, playCometAppear, playCometClick, setMuted } from './sound.js';
import { initWormhole } from './wormhole.js';
import { initLabels, updateLabels, updateSector, initTimeline } from './hud.js';
import { initWorkspace, focusField, fieldLabel, closeCompare } from './workspace.js';
import { icon, brandMark } from './icons.js';
import { setMeaningCorpus, loadMeaning, meaningReady, semanticSearch, belonging } from './meaning.js';
import { initUniverse, getMode, setMode, addToUniverse, onUniverseChange, universeSize, clearUniverse } from './universe.js';

// ── Inject UI HTML ────────────────────────────────────────────────────────────
document.getElementById('app').innerHTML = `
<canvas id="canvas"></canvas>
<div id="labels"></div>

<header id="topbar">
  <div class="brand">
    ${brandMark}
    <div>
      <div class="wordmark">search<em>·comète</em></div>
      <div id="sector"><span class="dot"></span><span>Charting…</span></div>
    </div>
  </div>
  <div id="search-area">
    <div id="search-wrap" class="glass">
      ${icon.search}
      <input id="search-input" type="text" placeholder="Search the galaxy, or all of science…" autocomplete="off" aria-label="Search papers" />
      <span class="kbd" aria-hidden="true">/</span>
      <button id="live-toggle" class="on" title="Also search all 250M+ papers on OpenAlex">LIVE</button>
      <button id="search-btn" aria-label="Search">${icon.arrow}</button>
    </div>
    <div id="live-results" class="glass" hidden>
      <div id="live-head">
        <span id="live-summary"></span>
        <button id="live-collapse" class="icon-btn" aria-label="Hide live results">–</button>
      </div>
      <div id="live-list"></div>
    </div>
    <div id="query-chips">
      <button class="chip" data-q="attention mechanisms transformers">attention mechanisms</button>
      <button class="chip" data-q="CRISPR gene editing">CRISPR</button>
      <button class="chip" data-q="black holes gravitational waves">black holes</button>
      <button class="chip" data-q="reinforcement learning reward">reinforcement learning</button>
      <button class="chip" data-q="protein folding structure">protein folding</button>
      <button class="chip" data-q="quantum computing algorithms">quantum computing</button>
    </div>
  </div>
  <div class="top-actions">
    <div class="seg glass" id="mode-switch" role="group" aria-label="View">
      <button data-mode="galaxy" class="on" title="All 54k mapped papers">Galaxy</button>
      <button data-mode="universe" title="Start empty and grow your own map by searching">My universe <span id="universe-count"></span></button>
    </div>
    <div id="live-pill" class="glass" title="Live search across all of OpenAlex"><span class="es-dot"></span><span id="live-pill-text">OPENALEX</span></div>
    <button id="home-btn" class="icon-btn" title="Back to the whole galaxy (H)" aria-label="Back to the whole galaxy">${icon.home}</button>
    <button id="sound-btn" class="icon-btn" title="Sound on/off" aria-label="Sound on/off">${icon.sound}</button>
    <span id="wormhole-slot"></span>
    <button id="help-btn" class="icon-btn" title="What is this? (?)" aria-label="Help">${icon.help}</button>
    <button id="settings-trigger" class="icon-btn" aria-label="Settings">${icon.settings}</button>
  </div>
</header>

<aside id="dock" class="glass" aria-label="Workspace">
  <nav class="tabs">
    <button class="tab active" data-tab="fields">${icon.layers} Fields</button>
    <button class="tab" data-tab="pinned">${icon.pin} Pinned <span class="count" id="pin-count"></span></button>
    <button class="tab" data-tab="web">${icon.web} Tree <span class="count" id="web-count"></span></button>
  </nav>
  <div class="tab-body active" id="tab-fields"><div id="legend"></div><div id="meteor-fact"></div></div>
  <div class="tab-body" id="tab-pinned"></div>
  <div class="tab-body" id="tab-web"></div>
</aside>
<button id="dock-toggle" class="btn glass">${icon.layers} Workspace</button>

<section id="detail-panel" class="glass" aria-label="Paper details">
  <button id="detail-close" class="icon-btn" aria-label="Close">${icon.close}</button>
  <div id="detail-category"></div>
  <div id="detail-title"></div>
  <div id="detail-authors"></div>
  <div id="detail-year"></div>
  <div id="detail-venue"></div>
  <div id="detail-links"></div>
  <div id="detail-actions">
    <button id="pin-btn" class="btn" title="Keep it in your reading list">${icon.pin} Pin</button>
    <button id="rope-btn" class="btn" title="Tie a rope to another pinned paper to compare them">${icon.link} Compare with…</button>
  </div>
  <div id="rope-menu" class="rope-menu" hidden></div>
  <div class="detail-field-label">Citation tree</div>
  <div class="web-controls">
    <button class="btn gold" id="grow-btn" title="Let the tree grow by itself: references, citing papers, then the most important of those">${icon.sparkle} Grow tree</button>
    <button class="btn ice" id="trace-refs" title="Add its references below it (the past)">↓ References</button>
    <button class="btn" id="trace-cited" title="Add the papers citing it above it (the future)">↑ Cited by</button>
    <div class="seg" id="web-depth" title="How many levels to add at once"><button data-d="1">1</button><button data-d="2" class="on">2</button><button data-d="3">3</button></div>
  </div>
  <div id="detail-belongs-wrap">
    <div class="detail-field-label">Where it belongs</div>
    <div id="detail-belongs"></div>
  </div>
  <div class="detail-field-label">Abstract</div>
  <div id="detail-abstract"></div>
  <div class="detail-field-label">Topics</div>
  <div id="detail-topics"></div>
  <div id="detail-ai">
    <button id="ai-topics-btn" class="btn ice">${icon.sparkle} Related topics by meaning</button>
    <div class="progress" id="ai-progress" hidden><span></span></div>
    <div class="ai-note" id="ai-note"></div>
  </div>
  <div class="detail-field-label">Nearby in the galaxy</div>
  <div id="detail-similar"></div>
  <div class="detail-field-label">About this field</div>
  <div id="detail-lore"></div>
  <div id="detail-es-wrap">
    <div class="detail-field-label">Elasticsearch kNN query</div>
    <div class="elastic-query-box" id="elastic-query"></div>
  </div>
</section>

<section id="compare" class="glass" aria-label="Rope analysis"></section>

<footer id="timeline" class="glass">
  <button id="play-btn" aria-label="Play through history"></button>
  <div class="tl-track" id="tl-track">
    <canvas id="tl-hist"></canvas>
    <div id="tl-cursor"></div>
    <div class="tl-axis"><span id="tl-min"></span><span id="tl-mid"></span><span id="tl-max"></span></div>
  </div>
  <div class="tl-readout"><div id="year-readout">All years</div><div id="year-count"></div></div>
  <input id="year-slider" type="range" tabindex="-1" aria-hidden="true" />
</footer>

<div id="welcome" class="glass" hidden role="dialog" aria-labelledby="welcome-title">
  <div class="eyebrow" style="color:var(--gold)">Welcome to search·comète</div>
  <div class="wl-title" id="welcome-title">A map of 54,190 research papers</div>
  <div class="wl-lead">Every star is a paper. Inside each field, papers about similar things sit close together; bigger stars are cited more. Search it, or reach all 250M+ papers on OpenAlex.</div>
  <div class="wl-uses">
    <div><b>Get your bearings</b> in a new field: what's big, what's recent, what sits next to what.</div>
    <div><b>Grow a citation tree</b> from any paper: what it builds on, and what built on it.</div>
    <div><b>Compare two papers</b>: tie a rope between them and see what they share.</div>
    <div><b>Build a reading list</b>: pin papers and export them as BibTeX or Markdown.</div>
  </div>
  <div class="wl-start">
    <button class="btn gold" data-start="search">${icon.search} Search a topic</button>
    <button class="btn" data-start="field">${icon.layers} Fly into Machine Learning</button>
    <button class="btn" data-start="universe">${icon.sparkle} Start from an empty sky</button>
  </div>
  <div class="wl-keys"><span>Drag to orbit</span><span>Scroll to zoom</span><span>Click a star</span><span><span class="kbd">/</span> search</span><span><span class="kbd">H</span> home</span></div>
  <button class="icon-btn" id="welcome-close" aria-label="Close">${icon.close}</button>
</div>
<div id="universe-hint" class="glass" hidden>
  <div class="eyebrow" style="color:var(--gold)">My universe</div>
  <div class="uh-title">Your universe is empty.</div>
  <div class="uh-body">Search for anything to light up your first stars. Every paper you find, pin or grow a tree from stays here, placed by meaning; the faint dust is the full 54k-paper galaxy, used as the map underneath.</div>
  <div class="uh-actions"><button class="btn gold" data-q="protein folding">Try “protein folding”</button><button class="btn" data-q="black holes">Try “black holes”</button></div>
</div>
<div id="results-label"></div>
<div id="tooltip"><div id="tt-title"></div><div id="tt-meta"></div></div>
<div id="toast" class="glass" role="status"></div>
<div id="warp-overlay"></div>

<div id="galaxy-loader">
  <div class="loader-inner">
    ${brandMark}
    <div class="loader-title">search<em>·comète</em></div>
    <div class="loader-bar-wrap"><div class="loader-bar" id="loader-bar-fill"></div></div>
    <div class="loader-label" id="loader-status">Mapping the universe…</div>
  </div>
</div>

<div id="settings-panel" class="glass">
  <div class="eyebrow" style="color:var(--gold)">System controls</div>
  <div class="settings-group">
    <div class="eyebrow">Visual quality</div>
    <select id="quality-select">
      <option value="high">High · full shaders</option>
      <option value="medium">Medium</option>
      <option value="low">Low · laptops on battery</option>
    </select>
  </div>
  <div class="settings-group">
    <div class="eyebrow">Accessibility</div>
    <label class="switch-wrap"><input type="checkbox" id="reduced-motion-toggle"> Reduced motion</label>
    <label class="switch-wrap"><input type="checkbox" id="high-contrast-toggle"> High contrast</label>
  </div>
  <div class="settings-group">
    <div class="eyebrow">My universe</div>
    <button class="btn" id="universe-clear">Clear my universe</button>
  </div>
  <div class="settings-group"><div id="fps-counter">FPS: --</div></div>
  <div class="ai-note">Drag to orbit · scroll to zoom · click a star · <span class="kbd">/</span> search · <span class="kbd">Esc</span> close</div>
</div>
`;

// ── Wire up interactions ──────────────────────────────────────────────────────

document.getElementById('search-btn').addEventListener('click', triggerSearch);
document.getElementById('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') triggerSearch(); });

document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.getElementById('search-input').value = chip.dataset.q;
    triggerSearch();
  });
});

document.getElementById('detail-close').addEventListener('click', closeDetail);

// ── Search (local galaxy + live OpenAlex) ─────────────────────────────────────

const LIVE_KEY = 'search-comete-live';
let liveEnabled = (() => { try { return localStorage.getItem(LIVE_KEY) !== '0'; } catch { return true; } })();
let searchSeq = 0;          // ignore results from searches that were superseded
let localHits = [];
let lastLive = [];

// Reciprocal-rank fusion of word matches and meaning matches
async function _blendMeaning(q, wordHits) {
  const sem = await semanticSearch(q, 30);
  const score = new Map(), byId = new Map();
  wordHits.forEach((h, r) => { score.set(String(h.id), 1 / (60 + r)); byId.set(String(h.id), h); });
  sem.forEach(({ star, score: sim }, r) => {
    if (sim < 0.35) return;
    const id = String(star.id);
    score.set(id, (score.get(id) || 0) + 1 / (60 + r));
    if (!byId.has(id)) byId.set(id, { ...star, cite: star.cite ?? 0 });
  });
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  const top = ranked[0]?.[1] || 1;
  return ranked.map(([id, s]) => ({ ...byId.get(id), score: Math.min(0.99, s / top) }));
}

// Model finished loading during a search: upgrade that search in place
async function _refineWithMeaning(q, seq) {
  const blended = await _blendMeaning(q, localHits);
  if (seq !== searchSeq || !blended.length) return;
  localHits = blended;
  highlightStars(localHits.map(r => r.id));
  if (getMode() === 'universe') addToUniverse(localHits.slice(0, 12));
  else if (lastLive.length) _placeByMeaning(lastLive, seq);
}

// Move live-result stars to where they belong by meaning
async function _placeByMeaning(visitors, seq) {
  const placed = [];
  for (const v of visitors) {
    const b = await belonging(v.paper).catch(() => null);
    if (seq !== searchSeq) return;
    if (!b) { placed.push(v); continue; }
    v.paper.cluster = v.paper.cluster || b.cluster;
    v.paper.belongs = b;
    placed.push({ ...v, x: b.position.x + (Math.random() - 0.5) * 1.6, y: b.position.y + (Math.random() - 0.5) * 1.6, z: b.position.z + (Math.random() - 0.5) * 1.6 });
  }
  setVisitors(placed);
}

const liveToggle = document.getElementById('live-toggle');
const liveBox    = document.getElementById('live-results');
const liveList   = document.getElementById('live-list');
const livePill   = document.getElementById('live-pill');

function _syncLiveToggle() {
  liveToggle.classList.toggle('on', liveEnabled);
  liveToggle.setAttribute('aria-pressed', String(liveEnabled));
  livePill.classList.toggle('off', !liveEnabled);
  document.getElementById('live-pill-text').textContent = liveEnabled ? 'OPENALEX' : 'OFFLINE';
}
_syncLiveToggle();

liveToggle.addEventListener('click', () => {
  liveEnabled = !liveEnabled;
  try { localStorage.setItem(LIVE_KEY, liveEnabled ? '1' : '0'); } catch { /* private mode */ }
  _syncLiveToggle();
  if (!liveEnabled) { liveBox.hidden = true; clearVisitors(); }
});

document.getElementById('live-collapse').addEventListener('click', () => {
  liveBox.classList.toggle('collapsed');
  document.getElementById('live-collapse').textContent = liveBox.classList.contains('collapsed') ? '+' : '–';
});

function _flashLabel(text, ms = 2500) {
  const label = document.getElementById('results-label');
  label.textContent = text;
  label.classList.add('show');
  clearTimeout(_flashLabel.timer);
  _flashLabel.timer = setTimeout(() => label.classList.remove('show'), ms);
}

async function triggerSearch() {
  const q = document.getElementById('search-input').value.trim();
  const seq = ++searchSeq;
  _setUrlParam('q', q || null);

  if (!q) {
    clearHighlights();
    clearVisitors();
    liveBox.hidden = true;
    document.getElementById('results-label').classList.remove('show');
    return;
  }

  // 1. Instant: search the galaxy itself (words, plus meaning once the small
  // embedding model is loaded - the first search starts loading it)
  localHits = await doSearch(q);
  if (seq !== searchSeq) return;
  if (meaningReady()) localHits = await _blendMeaning(q, localHits);
  else loadMeaning().then(() => { if (seq === searchSeq) _refineWithMeaning(q, seq); }).catch(() => {});
  if (seq !== searchSeq) return;
  if (getMode() === 'universe') addToUniverse(localHits.slice(0, 12));

  results = { q, seq, live: null, liveError: null, loadingLive: liveEnabled };
  _renderResults();
  if (localHits.length) {
    highlightStars(localHits.map(r => r.id));
    // getRemappedPos() returns scene coordinates; r.x/y/z are raw UMAP coords
    const pos = getRemappedPos(localHits[0].id);
    if (pos) flyToCluster(pos);
    // Only jump straight into a paper when the query clearly names it
    const exact = _titleMatch(q, localHits);
    if (exact) setTimeout(() => { if (seq === searchSeq) showDetail(exact); }, 600);
  } else {
    clearHighlights();
  }

  // 2. Live: search all of OpenAlex in the background
  if (liveEnabled) _runLiveSearch(q, seq);
}

let results = null;

// A result whose title is (almost) exactly what was typed
function _titleMatch(q, papers) {
  const norm = (t) => String(t || '').toLowerCase().replace(/<[^>]*>/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const nq = norm(q);
  if (nq.length < 10) return null;
  return papers.find(p => {
    const nt = norm(p.title);
    // the query is the title, or nearly all of it (a subtitle may be missing)
    return nt === nq || (nt.startsWith(nq) && nq.length / nt.length > 0.85);
  }) || null;
}

async function _runLiveSearch(q, seq) {
  let live;
  try {
    live = await searchLive(q);
  } catch (e) {
    if (seq !== searchSeq) return;
    livePill.classList.toggle('limited', !!e.rateLimited);
    results = { ...results, loadingLive: false, liveError: e };
    _renderResults();
    return;
  }
  if (seq !== searchSeq) return;
  livePill.classList.remove('limited');

  // Results already in the galaxy light up; the rest become new stars
  // parked where they belong (by meaning once the model is loaded)
  const visitors = [];
  const inGalaxy = [];
  live.results.forEach(p => {
    if (hasStar(p.id)) { inGalaxy.push(p.id); return; }
    const spot = _placeVisitor(p);
    if (spot) { p.cluster = p.cluster || spot.cluster; visitors.push({ paper: p, ...spot.pos }); }
  });
  if (getMode() === 'universe') {
    addToUniverse(live.results, new Map(visitors.map(v => [String(v.paper.id), { x: v.x, y: v.y, z: v.z }])));
  } else {
    setVisitors(visitors);
    if (meaningReady()) _placeByMeaning(visitors, seq);
  }
  lastLive = visitors;
  if (inGalaxy.length) highlightStars([...localHits.map(r => r.id), ...inGalaxy]);

  results = { ...results, loadingLive: false, live, inGalaxy: inGalaxy.length, added: visitors.length };
  _renderResults();
  // The exact paper might only be on OpenAlex (e.g. it isn't one of the 54k)
  if (!document.getElementById('detail-panel').classList.contains('open')) {
    const exact = _titleMatch(q, live.results);
    if (exact) {
      const pos = getRemappedPos(exact.id);
      if (pos) flyTo(pos);
      showDetail(exact);
    }
  }
}

function _renderResults() {
  if (!results) return;
  const { q, live, liveError, loadingLive } = results;
  liveBox.hidden = false;
  liveBox.classList.remove('collapsed');
  document.getElementById('live-collapse').textContent = '–';

  const row = (p, i, src, badge = '') => `
    <div class="live-item" tabindex="0" data-src="${src}" data-i="${i}">
      <div class="live-title">${_esc(cleanTitle(p.title))}</div>
      <div class="live-meta">
        ${badge}
        <span>${_esc((p.authors || '').split(',')[0] || 'Unknown')} · ${p.year || '—'} · ${(p.cite || 0).toLocaleString()} citations</span>
        ${src === 'live' ? [
          `<a href="${_esc(scholarUrl(p.title))}" target="_blank" rel="noopener noreferrer">Scholar ↗</a>`,
          p.pdfUrl && /^https?:\/\//.test(p.pdfUrl) && `<a href="${_esc(p.pdfUrl)}" target="_blank" rel="noopener noreferrer">PDF ↗</a>`,
        ].filter(Boolean).join('') : ''}
      </div>
    </div>`;

  const local = localHits.slice(0, 6);
  let html = `<div class="res-section"><span>In the galaxy</span><span>${localHits.length ? `${localHits.length} lit up` : 'none'}</span></div>`;
  html += local.length
    ? local.map((p, i) => row(p, i, 'local')).join('')
    : `<div class="live-note">None of the 54,190 mapped papers match${liveEnabled ? ' - see all of science below.' : '. Turn on LIVE to search all of OpenAlex.'}</div>`;

  if (liveEnabled) {
    html += `<div class="res-section"><span>All of science · OpenAlex</span><span>${live ? `${live.total.toLocaleString()} found` : ''}</span></div>`;
    if (loadingLive) html += '<div class="live-note">Searching 250M+ papers…</div>';
    else if (liveError) html += `<div class="live-note">${_esc(liveError.message)}. You can still <a href="https://scholar.google.com/scholar?q=${encodeURIComponent(q)}" target="_blank" rel="noopener noreferrer">search Google Scholar ↗</a>.</div>`;
    else if (!live.results.length) html += '<div class="live-note">No papers found on OpenAlex either.</div>';
    else html += live.results.map((p, i) => row(p, i, 'live', hasStar(p.id)
      ? '<span class="badge in" title="This paper is one of the mapped stars">in galaxy</span>'
      : '<span class="badge new" title="Added to the map as a new star, next to the papers it is most like">new star</span>')).join('');
  }
  liveList.innerHTML = html;
  document.getElementById('live-summary').textContent = `Results for “${q.length > 34 ? q.slice(0, 33) + '…' : q}”`;

  liveList.querySelectorAll('.live-item').forEach(el => {
    const open = (e) => {
      if (e.target.closest('a')) return;
      const p = el.dataset.src === 'local' ? localHits[Number(el.dataset.i)] : live.results[Number(el.dataset.i)];
      const pos = getRemappedPos(p.id);
      if (pos) flyTo(pos);
      showDetail(p);
      // fold the list away so it doesn't cover what you just picked
      liveBox.classList.add('collapsed');
      document.getElementById('live-collapse').textContent = '+';
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => { if (e.key === 'Enter') open(e); });
  });
}

// Place a live paper at the centroid of its closest galaxy matches (+ jitter)
function _placeVisitor(paper) {
  const matches = localMatches(`${paper.title} ${paper.topic || ''}`, 6)
    .filter(m => !paper.cluster || m.cluster === paper.cluster || m.score > 0.5);
  const pool = matches.length ? matches : [];
  let x = 0, y = 0, z = 0, n = 0;
  const votes = {};
  pool.forEach(m => {
    const p = getRemappedPos(m.id);
    if (!p) return;
    x += p.x; y += p.y; z += p.z; n++;
    votes[m.cluster] = (votes[m.cluster] || 0) + 1;
  });
  if (!n) return null;
  const jitter = () => (Math.random() - 0.5) * 2.2;
  const cluster = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
  return { pos: { x: x/n + jitter(), y: y/n + jitter(), z: z/n + jitter() }, cluster };
}

function _esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Shareable URLs + keyboard ─────────────────────────────────────────────────

function _setUrlParam(key, value) {
  const url = new URL(location.href);
  if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
  history.replaceState(null, '', url);
}

window.addEventListener('detail:opened', e => {
  const id = String(e.detail.id || '');
  _setUrlParam('paper', id.startsWith('https://openalex.org/') ? id.split('/').pop() : null);
});
window.addEventListener('detail:closed', () => _setUrlParam('paper', null));

// Keep the galaxy centred in the space the dock and dossier leave free
function _syncViewShift() {
  if (innerWidth <= 900) return setViewShift(0);
  const dock = document.getElementById('dock');
  const left = dock.classList.contains('collapsed') ? 0 : dock.offsetWidth + 16;
  const right = document.getElementById('detail-panel').classList.contains('open') ? document.getElementById('detail-panel').offsetWidth + 16 : 0;
  setViewShift((left - right) / 2);
}
['detail:opened', 'detail:closed', 'resize'].forEach(ev => window.addEventListener(ev, _syncViewShift));

// Topic chips in the dossier run a search
window.addEventListener('search:run', e => {
  document.getElementById('search-input').value = e.detail;
  triggerSearch();
});

window.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing) {
    e.preventDefault();
    document.getElementById('search-input').focus();
  } else if ((e.key === 'h' || e.key === 'H') && !typing) {
    focusField('all');
  } else if (e.key === '?' && !typing) {
    _showWelcome(true);
  } else if (e.key === 'Escape') {
    // Dismiss the topmost thing: welcome, comparison, paper, results list, then the search box
    if (!document.getElementById('welcome').hidden) _closeWelcome();
    else if (document.getElementById('compare').classList.contains('open')) closeCompare();
    else if (document.getElementById('detail-panel').classList.contains('open')) closeDetail();
    else if (!liveBox.hidden && !liveBox.classList.contains('collapsed')) {
      liveBox.classList.add('collapsed');
      document.getElementById('live-collapse').textContent = '+';
    } else if (typing) document.activeElement.blur();
  }
});

// ── Welcome, home, sound ──────────────────────────────────────────────────────

const WELCOME_KEY = 'search-comete-welcomed';
function _showWelcome(force = false) {
  let seen = false;
  try { seen = !!localStorage.getItem(WELCOME_KEY); } catch { /* private mode */ }
  // A shared link goes straight to its content
  const deepLink = ['q', 'paper', 'mode'].some(k => new URLSearchParams(location.search).has(k));
  if ((seen || deepLink) && !force) return;
  document.getElementById('welcome').hidden = false;
  document.getElementById('universe-hint').hidden = true;
}
function _closeWelcome() {
  document.getElementById('welcome').hidden = true;
  try { localStorage.setItem(WELCOME_KEY, '1'); } catch { /* private mode */ }
  if (getMode() === 'universe' && !universeSize()) document.getElementById('universe-hint').hidden = false;
}

function _initChrome() {
  const welcome = document.getElementById('welcome');
  document.getElementById('welcome-close').addEventListener('click', _closeWelcome);
  welcome.querySelectorAll('[data-start]').forEach(b => b.addEventListener('click', () => {
    _closeWelcome();
    if (b.dataset.start === 'search') document.getElementById('search-input').focus();
    if (b.dataset.start === 'field') focusField('ml');
    if (b.dataset.start === 'universe') setMode('universe');
  }));
  document.getElementById('help-btn').addEventListener('click', () => _showWelcome(true));
  document.getElementById('home-btn').addEventListener('click', () => focusField('all'));

  const SOUND_KEY = 'search-comete-muted';
  const btn = document.getElementById('sound-btn');
  let muted = false;
  try { muted = localStorage.getItem(SOUND_KEY) === '1'; } catch { /* default on */ }
  const sync = () => { btn.innerHTML = muted ? icon.mute : icon.sound; btn.title = muted ? 'Sound off' : 'Sound on'; setMuted(muted); };
  btn.addEventListener('click', () => { muted = !muted; try { localStorage.setItem(SOUND_KEY, muted ? '1' : '0'); } catch {} sync(); });
  sync();
  _showWelcome();
}

// ── Galaxy / My universe ──────────────────────────────────────────────────────

function _initModeSwitch() {
  const sw = document.getElementById('mode-switch');
  const hint = document.getElementById('universe-hint');
  const sync = () => {
    const m = getMode(), n = universeSize();
    sw.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    document.getElementById('universe-count').textContent = n ? `· ${n}` : '';
    hint.hidden = !(m === 'universe' && n === 0) || !document.getElementById('welcome').hidden;
    document.body.classList.toggle('universe-mode', m === 'universe');
  };
  sw.addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    setMode(b.dataset.mode);
    _flashLabel(b.dataset.mode === 'universe' ? 'MY UNIVERSE · EVERYTHING YOU FIND STAYS' : 'FULL GALAXY · 54k PAPERS', 2200);
  });
  document.getElementById('universe-clear').addEventListener('click', () => clearUniverse());
  hint.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () =>
    window.dispatchEvent(new CustomEvent('search:run', { detail: b.dataset.q }))));
  onUniverseChange(sync);
  sync();
}

// ── Load stars ────────────────────────────────────────────────────────────────

// Normalise field names (cluster_id, pos_x, citations...) to what the
// frontend uses (cluster, x, y, z, cite).
function _normaliseStars(stars) {
  return stars.map(s => ({
    ...s,
    cluster: s.cluster || s.cluster_id || '',
    color:   s.color   || s.cluster_color || '#ffffff',
    x:       s.x       ?? s.pos_x ?? 0,
    y:       s.y       ?? s.pos_y ?? 0,
    z:       s.z       ?? s.pos_z ?? 0,
    cite:    s.cite    ?? s.citations ?? 0,
  }));
}

// galaxy.json is columnar (see pipeline/compact_stars.py) - expand to objects
function _expandCompact(d) {
  const out = new Array(d.n);
  const k = d.coordScale || 1;
  for (let i = 0; i < d.n; i++) {
    const cluster = d.clusters[d.cluster[i]];
    out[i] = {
      id:      d.idPrefix + d.id[i],
      title:   d.title[i].replace(/<[^>]*>/g, ''),   // some titles carry <i>/<sub> markup
      authors: d.authors[i],
      year:    d.year[i] || null,
      cite:    d.cite[i],
      cluster,
      color:   d.colors[cluster],
      x: d.xyz[i*3] / k, y: d.xyz[i*3+1] / k, z: d.xyz[i*3+2] / k,
      crowd: d.crowd?.[i],
    };
  }
  // Positions are final scene coordinates (pipeline/layout.py)
  if (d.layout === 'scene') out.sceneAnchors = d.anchors;
  return out;
}

// Download with a progress readout on the loader bar
async function _fetchJsonWithProgress(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const status = document.getElementById('loader-status');
  const bar = document.getElementById('loader-bar-fill');
  if (!res.body) return res.json();

  // Content-Length is the compressed size when gzipped, so treat it as a hint
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (status) status.textContent = `Charting stars… ${(received / 1048576).toFixed(1)} MB`;
    if (bar && total) bar.style.width = `${Math.min(60, (received / total) * 60)}%`;
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  chunks.forEach(c => { bytes.set(c, offset); offset += c.length; });
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function loadStars() {
  // 1. Live index from the backend, when it's deployed
  if (USE_BACKEND) {
    try {
      const res = await fetch(`${API_BASE}/stars`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const raw = await res.json();
        if (Array.isArray(raw) && raw.length) {
          console.info(`[load] Using API: ${raw.length} stars`);
          return _normaliseStars(raw);
        }
      }
    } catch (e) {
      console.warn('[load] /api/stars failed:', e.message);
    }
  }

  // 2. Static galaxy.json built by the pipeline (cached by the browser)
  try {
    const data = await _fetchJsonWithProgress('/galaxy.json');
    const stars = data.v === 2 ? _expandCompact(data) : _normaliseStars(data);
    if (stars.length) {
      console.info(`[load] Using galaxy.json: ${stars.length} stars`);
      return stars;
    }
  } catch (e) {
    console.warn('[load] galaxy.json failed:', e.message);
  }

  // 3. Bundled fallback
  console.info('[load] Using bundled FALLBACK_PAPERS');
  return FALLBACK_PAPERS;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function buildMeteorFact(stars) {
  const meteor = document.getElementById('meteor-fact');
  if (!meteor || !stars.length) return;

  let mostCited = stars[0], newest = stars[0];
  stars.forEach(s => {
    if ((s.cite ?? 0) > (mostCited.cite ?? 0)) mostCited = s;
    if ((s.year || 0) > (newest.year || 0)) newest = s;
  });

  const picks = [
    { star: mostCited, meta: `Most cited object in this universe · ${(mostCited.cite ?? 0).toLocaleString()} citations` },
    { star: newest,    meta: `Newest signal detected · ${newest.year || 'Unknown year'}` },
    { star: stars[Math.floor(Math.random() * stars.length)], meta: 'Meteor of the day · Random jump target' },
  ];

  const pick = picks[Math.floor(Math.random() * picks.length)];
  meteor.innerHTML = `
    <div class="meteor-label">METEOR OF THE DAY</div>
    <div class="meteor-title">${_esc(cleanTitle(pick.star.title))}</div>
    <div class="meteor-meta">${_esc(pick.meta)} · click to fly there</div>
  `;
  meteor.style.cursor = 'pointer';
  meteor.onclick = () => {
    const pos = getRemappedPos(pick.star.id);
    if (pos) flyTo(pos);
    showDetail(pick.star);
  };
}

// ── COMET ADDITION: click handler ─────────────────────────────────────────────

// comet:flyto - initial jump when user clicks the toast.
// Use flyToCluster (tgtR=28) not flyTo (tgtR=6) - we need to stay far enough
// back that the full comet tail is visible in the camera frustum.
// setPivotTarget then takes over every frame and holds tgtR=45.
window.addEventListener('comet:flyto', e => {
  flyToCluster(e.detail);
});

function _onCometClick(comet) {
  if (!comet.paper) {
    const toast = document.getElementById('comet-toast');
    if (toast) {
      toast.textContent = '⟳ ANALYSING COMET TRAJECTORY…';
      toast.classList.add('show');
    }
    setTimeout(() => { if (comet.paper) _onCometClick(comet); }, 800);
    return;
  }
  // Shallow-copy so we don't mutate the corpus entry
  const paper = { ...comet.paper };
  // Strip MathML/HTML from the title so the detail panel never shows raw XML
  paper.title = cleanTitle(paper.title);
  console.log(`[comets] Clicked - opening: "${paper.title}"`);
  // Open the detail panel - no highlightStars call, it's not needed when
  // tracking a moving comet and the redraw can interfere with the tail
  setTimeout(() => showDetail(paper), 500);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

// ── Settings & Performance ────────────────────────────────────────────────────

function initSettings() {
  const trigger = document.getElementById('settings-trigger');
  const panel = document.getElementById('settings-panel');
  const quality = document.getElementById('quality-select');
  const motion = document.getElementById('reduced-motion-toggle');
  const contrast = document.getElementById('high-contrast-toggle');

  trigger.onclick = () => panel.classList.toggle('open');

  // Load saved settings
  const saved = JSON.parse(localStorage.getItem('search-comete-settings') || '{}');
  if (saved.quality) quality.value = saved.quality;
  if (saved.reducedMotion) motion.checked = saved.reducedMotion;
  if (saved.highContrast) contrast.checked = saved.highContrast;
  
  const applySettings = () => {
    document.body.classList.toggle('high-contrast', contrast.checked);
    const settings = {
      quality: quality.value,
      reducedMotion: motion.checked,
      highContrast: contrast.checked
    };
    localStorage.setItem('search-comete-settings', JSON.stringify(settings));
    window.dispatchEvent(new CustomEvent('settings:changed', { detail: settings }));
  };

  [quality, motion, contrast].forEach(el => el.onchange = applySettings);
  applySettings();
}

function _toast(msg, ms = 4000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toast.timer);
  _toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

// Steps quality down if the machine can't keep up (a few slow seconds in a
// row), and says so. ?quality=high|medium|low pins it and turns this off.
function initFPSMonitor() {
  let frameCount = 0, slow = 0;
  let lastTime = performance.now();
  const counter = document.getElementById('fps-counter');
  const select = document.getElementById('quality-select');
  const pinned = new URLSearchParams(location.search).get('quality');
  if (['high', 'medium', 'low'].includes(pinned)) { select.value = pinned; select.dispatchEvent(new Event('change')); }

  registerFrameHook(() => {
    frameCount++;
    const now = performance.now();
    if (now - lastTime < 1000) return;
    const fps = Math.round((frameCount * 1000) / (now - lastTime));
    counter.textContent = `FPS: ${fps}`;
    frameCount = 0;
    lastTime = now;
    if (pinned || document.hidden) return;
    slow = fps < 26 ? slow + 1 : 0;
    if (slow >= 4 && select.value !== 'low') {
      select.value = select.value === 'high' ? 'medium' : 'low';
      select.dispatchEvent(new Event('change'));
      slow = 0;
      _toast(`Switched to ${select.value} quality to keep things smooth. You can change it in settings.`);
    }
  });
}

async function shaderWarmup() {
  const status = document.getElementById('loader-status');
  const bar = document.getElementById('loader-bar-fill');
  
  status.textContent = 'Heating up anomalies…';
  bar.style.width = '70%';

  // Re-run animation loop once with a huge delta to force-compile everything
  const scene = getScene();
  const camera = getCamera();
  const renderer = getRenderer();
  
  if (renderer && scene && camera) {
    renderer.compile(scene, camera);
  }
  
  await new Promise(r => setTimeout(r, 500));
  bar.style.width = '100%';
  status.textContent = 'Universe Stabilized.';
}

loadStars().then(async stars => {
  initSettings();
  initGalaxy(document.getElementById('canvas'), stars);

  const scene = getScene();
  const camera = getCamera();

  initFPSMonitor();
  await shaderWarmup();
  document.getElementById('galaxy-loader').style.transition = 'opacity 0.8s ease';
  document.getElementById('galaxy-loader').style.opacity = '0';
  setTimeout(() => { document.getElementById('galaxy-loader').style.display = 'none'; }, 800);
  buildMeteorFact(stars);

  // Give the corpus to search, the dossier and the workspace
  setSearchCorpus(stars);
  setCorpus(stars);
  initPanel();
  setMeaningCorpus(stars);
  initWorkspace(stars);
  initUniverse();
  _initModeSwitch();
  _initChrome();
  initTimeline(stars);
  initLabels(stars, fieldLabel, id => focusField(id));
  _syncViewShift();
  let sectorClock = 0;
  registerFrameHook(delta => {
    updateLabels();
    sectorClock += delta;
    if (sectorClock > 0.25) { sectorClock = 0; updateSector(); }
  });

  // ── COMET ADDITION: initialise comet system ───────────────────────────────
  const canvas  = document.getElementById('canvas');

  if (scene && camera) {
    initComets(scene, camera, stars, _onCometClick, setPivotTarget);

    // Tick comets every frame via galaxy's frame hook
    registerFrameHook(delta => tickComets(delta));

    // Comet click detection - runs after galaxy's own click handler
    canvas.addEventListener('click', () => {
      const raycaster = getRaycaster();
      if (!raycaster) return;
      const hit = raycastComets(raycaster);
      if (hit) _onCometClick(hit);
    });

    // Stop tracking only when user drags the canvas (mousedown THEN mousemove)
    // Plain hover or toast click must never kill tracking
    {
      let _canvasDragArmed = false;
      const cvs = document.getElementById('canvas');
      cvs.addEventListener('mousedown', () => {
        _canvasDragArmed = true; // armed - if mouse moves now it's a drag
      });
      window.addEventListener('mouseup', () => {
        _canvasDragArmed = false; // released without dragging = just a click
      });
      cvs.addEventListener('mousemove', () => {
        if (_canvasDragArmed) {
          // mousedown is held and mouse moved = real drag
          stopCometTracking();
          _canvasDragArmed = false;
        }
      });
      cvs.addEventListener('touchmove', () => {
        stopCometTracking();
      }, { passive: true });
    }

    updateCometCorpus(stars);
    console.log('[main] Comet system active ✓');
  } else {
    console.warn(
      '[main] Comet system disabled - add these exports to galaxy.js:\n' +
      '  export function getScene()     { return scene; }\n' +
      '  export function getCamera()    { return camera; }\n' +
      '  export function getRaycaster() { return raycaster; }\n' +
      '  export function registerFrameHook(fn) { _frameHooks.push(fn); }\n' +
      'And in _animate(): _frameHooks.forEach(fn => fn(delta)); (where delta = clock.getDelta())'
    );
  }
  // ── END COMET ADDITION ────────────────────────────────────────────────────

  // ── SOUND + WORMHOLE ADDITIONS ────────────────────────────────────────────

  // Sound - init on first user interaction (browsers require gesture to start AudioContext)
  const _startSound = () => {
    initSound();
    window.removeEventListener('click', _startSound);
    window.removeEventListener('keydown', _startSound);
  };
  window.addEventListener('click', _startSound);
  window.addEventListener('keydown', _startSound);

  // Wire warp sound - only fires when camera actually travels (not every click)
  // galaxy.js dispatches 'galaxy:travel' whenever flyTo/flyToCluster/filterCluster runs
  window.addEventListener('galaxy:travel', () => playWarp());

  // Wire star click sound - listen for detail panel opening
  const _detailObserver = new MutationObserver(() => {
    const panel = document.getElementById('detail-panel');
    if (panel && panel.classList.contains('open')) {
      const cat = document.getElementById('detail-category');
      const cluster = cat ? cat.textContent.toLowerCase().trim() : '';
      playStarClick(cluster);
    }
  });
  const detailPanel = document.getElementById('detail-panel');
  if (detailPanel) {
    _detailObserver.observe(detailPanel, { attributes: true, attributeFilter: ['class'] });
  }

  // Wire comet sounds via custom events from comet.js
  window.addEventListener('comet:appeared', () => playCometAppear());
  window.addEventListener('comet:clicked',  () => playCometClick());

  // Wormhole - pass galaxy renderer so it can flip the canvas bg color
  initWormhole((newMode) => setTheme(newMode), getRenderer());
  const wormBtn = document.getElementById('wormhole-btn');
  if (wormBtn) { wormBtn.classList.add('icon-btn'); document.getElementById('wormhole-slot').replaceWith(wormBtn); }

  // ── END SOUND + WORMHOLE ADDITIONS ───────────────────────────────────────

  _openFromUrl(stars);
});

// ?q=… runs a search, ?paper=W… opens that paper (in the galaxy or from OpenAlex)
async function _openFromUrl(stars) {
  const params = new URLSearchParams(location.search);
  const q = params.get('q');
  const paperId = params.get('paper');

  if (q) {
    document.getElementById('search-input').value = q;
    await triggerSearch();
  }
  if (paperId && /^W\d+$/.test(paperId)) {
    const id = `https://openalex.org/${paperId}`;
    const star = stars.find(s => s.id === id);
    if (star) {
      const pos = getRemappedPos(id);
      if (pos) flyTo(pos);
      setTimeout(() => showDetail(star), q ? 900 : 0);
    } else {
      try {
        showDetail(await getWork(id));
      } catch (e) {
        console.warn('[url] could not open paper', paperId, e.message);
      }
    }
  }
}