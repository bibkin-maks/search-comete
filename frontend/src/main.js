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

import {
  initGalaxy,
  highlightStars,
  clearHighlights,
  flyTo,
  flyToCluster,
  getRemappedPos,
  hasStar,
  CLUSTER_COLORS,
  setActiveYear,
  setPivotTarget,
  setVisitors,
  clearVisitors,
  setTheme,
  getScene,
  getCamera,
  getRaycaster,
  registerFrameHook,
  getRenderer,
} from './galaxy.js';
import { doSearch, setSearchCorpus, localMatches } from './search.js';
import { showDetail, closeDetail, setCorpus } from './panel.js';
import { searchLive, scholarUrl } from './live.js';
import { USE_BACKEND, API_BASE } from './config.js';
import { FALLBACK_PAPERS } from './data.js';
import { initComets, tickComets, raycastComets, updateCorpus as updateCometCorpus, cleanTitle, stopCometTracking } from './comet.js';
import { initSound, playWarp, playStarClick, playCometAppear, playCometClick } from './sound.js';
import { initWormhole } from './wormhole.js';

// ── Inject UI HTML ────────────────────────────────────────────────────────────
document.getElementById('app').innerHTML = `
<canvas id="canvas"></canvas>

<div id="hud-top">
  <div>
    <div class="wordmark">search<em>·comète</em></div>
    <div class="tagline" id="tagline">Every paper is a star · closeness = similar meaning</div>
  </div>
  <div class="elastic-pill" id="live-pill" title="Live search across all of OpenAlex"><div class="es-dot"></div><span id="live-pill-text">OPENALEX · LIVE</span></div>
</div>

<div id="search-area">
  <div id="search-wrap">
    <input id="search-input" type="text" placeholder="Search the universe of ideas…  ( / )" autocomplete="off" />
    <button id="live-toggle" class="on" title="Also search all 250M+ papers on OpenAlex">LIVE</button>
    <button id="search-btn" aria-label="Search">→</button>
  </div>
  <div id="live-results" hidden>
    <div id="live-head">
      <span id="live-summary"></span>
      <button id="live-collapse" aria-label="Hide live results">–</button>
    </div>
    <div id="live-list"></div>
  </div>
  <div id="query-chips">
    <button class="chip" data-q="attention mechanisms transformers">attention mechanisms</button>
    <button class="chip" data-q="CRISPR gene editing">CRISPR gene editing</button>
    <button class="chip" data-q="black holes gravitational waves">black holes</button>
    <button class="chip" data-q="reinforcement learning reward">reinforcement learning</button>
    <button class="chip" data-q="protein folding structure">protein folding</button>
    <button class="chip" data-q="quantum computing algorithms">quantum computing</button>
  </div>
</div>

<div id="results-label"></div>

<div id="time-travel">
  <div class="tt-heading">TIME TRAVEL</div>
  <input id="year-slider" type="range" />
  <div id="year-readout">ALL YEARS</div>
</div>

<div id="meteor-fact"></div>

<div id="legend">
  <div class="legend-row active" data-cluster="all">
    <div class="legend-dot" style="background:rgba(245,242,235,0.4)"></div>ALL FIELDS
  </div>
</div>

<div id="star-count"></div>
<div id="instructions">drag to orbit · scroll to zoom · click a star</div>

<div id="detail-panel">
  <button id="detail-close">✕</button>
  <div id="detail-category"></div>
  <div id="detail-lore"></div>
  <div id="detail-title"></div>
  <div id="detail-authors"></div>
  <div id="detail-year"></div>
  <div id="detail-venue"></div>
  <div id="detail-links"></div>
  <div id="detail-actions">
    <button id="pin-btn" class="detail-action-btn">☆ PIN AS STAR</button>
  </div>
  <div class="detail-field-label">Abstract</div>
  <div id="detail-abstract"></div>
  <div id="detail-score-wrap">
    <div class="detail-field-label">Search relevance</div>
    <div id="detail-score">
      <div class="score-bar-wrap"><div class="score-bar" id="score-bar"></div></div>
      <div class="score-val" id="score-val"></div>
    </div>
  </div>
  <div class="detail-field-label">Nearby in the galaxy</div>
  <div id="detail-similar"></div>
  <div id="detail-es-wrap">
    <div class="detail-field-label">Elasticsearch kNN query</div>
    <div class="elastic-query-box" id="elastic-query"></div>
  </div>
</div>

<div id="tooltip">
  <div id="tt-title"></div>
  <div id="tt-meta"></div>
</div>

<div id="warp-overlay"></div>

<div id="galaxy-loader">
  <div class="loader-inner">
    <div class="loader-title">search<em>·comète</em></div>
    <div class="loader-bar-wrap"><div class="loader-bar" id="loader-bar-fill"></div></div>
    <div class="loader-label" id="loader-status">Mapping the universe…</div>
  </div>
</div>

<div id="settings-trigger">⚙</div>
<div id="settings-panel">
  <div class="settings-header">SYSTEM CONTROLS</div>
  <div class="settings-group">
    <div class="settings-label">Visual Quality</div>
    <select id="quality-select">
      <option value="high">High (Full Shaders)</option>
      <option value="medium">Medium (No Morph)</option>
      <option value="low">Low (Mobile/Static)</option>
    </select>
  </div>
  <div class="settings-group">
    <div class="settings-label">Accessibility</div>
    <label class="switch-wrap">
      <input type="checkbox" id="reduced-motion-toggle">
      <span class="switch-label">Reduced Motion</span>
    </label>
    <label class="switch-wrap">
      <input type="checkbox" id="high-contrast-toggle">
      <span class="switch-label">High Contrast</span>
    </label>
  </div>
  <div class="settings-group">
    <div id="fps-counter">FPS: --</div>
  </div>
</div>
`;

// ── Inject global styles ──────────────────────────────────────────────────────
const style = document.createElement('style');
style.textContent = `
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --ink: #0a0a12; --paper: #f5f2eb; --dim: rgba(245,242,235,0.45);
  --dimmer: rgba(245,242,235,0.15); --gold: #c9a84c;
  --glow-ml: #7c6dfa; --glow-bio: #3dd9a4; --glow-phys: #fa8c4f;
  --glow-cs: #5ab4f5; --glow-math: #f06ba8;
  --mono: 'IBM Plex Mono', monospace;
  --display: 'Syne', sans-serif;
  --serif: 'Newsreader', serif;
}
html, body { width: 100%; height: 100%; background: var(--ink); color: var(--paper); overflow: hidden; cursor: crosshair; }
#canvas { position: fixed; inset: 0; z-index: 0; }

/* HUD */
#hud-top { position:fixed; top:0; left:0; right:0; z-index:10; padding:18px 28px; display:flex; align-items:center; gap:20px; background:linear-gradient(180deg,rgba(10,10,18,0.95) 0%,transparent 100%); pointer-events:none; }
.wordmark { font-family:var(--display); font-size:18px; font-weight:800; letter-spacing:-0.02em; color:var(--paper); }
.wordmark em { font-style:normal; color:var(--gold); }
.tagline { font-family:var(--mono); font-size:9px; letter-spacing:0.18em; color:var(--dimmer); text-transform:uppercase; margin-top:2px; }
.elastic-pill { margin-left:auto; margin-right:40px; display:flex; align-items:center; gap:6px; font-family:var(--mono); font-size:9px; letter-spacing:0.1em; color:rgba(245,242,235,0.35); border:0.5px solid rgba(245,242,235,0.1); border-radius:2px; padding:5px 10px; }
.es-dot { width:5px; height:5px; border-radius:50%; background:var(--glow-bio); animation:breathe 3s ease-in-out infinite; }
@keyframes breathe { 0%,100%{opacity:1} 50%{opacity:0.3} }

/* Search */
#search-area { position:fixed; top:68px; left:50%; transform:translateX(-50%); z-index:10; width:520px; max-width: calc(100vw - 48px); }
#search-wrap { position:relative; display:flex; align-items:center; }
#search-input { width:100%; background:rgba(245,242,235,0.04); border:0.5px solid rgba(245,242,235,0.18); border-radius:2px; padding:12px 52px 12px 18px; font-family:var(--mono); font-size:13px; color:var(--paper); outline:none; letter-spacing:0.03em; transition:border-color 0.2s,background 0.2s; }
#search-input::placeholder { color:rgba(245,242,235,0.22); }
#search-input:focus { border-color:rgba(201,168,76,0.5); background:rgba(201,168,76,0.03); }
#search-btn { position:absolute; right:0; height:100%; width:48px; background:none; border:none; border-left:0.5px solid rgba(245,242,235,0.1); color:var(--gold); font-size:16px; cursor:pointer; transition:background 0.15s; display:flex; align-items:center; justify-content:center; }
#search-btn:hover { background:rgba(201,168,76,0.08); }
#query-chips { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; padding:0 2px; }
.chip { font-family:var(--mono); font-size:9px; letter-spacing:0.08em; padding:4px 10px; border:0.5px solid rgba(245,242,235,0.1); border-radius:1px; cursor:pointer; transition:all 0.15s; color:rgba(245,242,235,0.4); background:transparent; }
.chip:hover { border-color:var(--gold); color:var(--gold); }

/* Legend */
#legend { position:fixed; left:24px; bottom:80px; z-index:10; display:flex; flex-direction:column; gap:8px; }
.legend-row { display:flex; align-items:center; gap:8px; font-family:var(--mono); font-size:9px; letter-spacing:0.1em; color:rgba(245,242,235,0.35); cursor:pointer; transition:color 0.15s; }
.legend-row:hover, .legend-row.active { color:var(--paper); }
.legend-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }

/* Misc HUD */
#star-count { position:fixed; left:24px; bottom:24px; font-family:var(--mono); font-size:9px; letter-spacing:0.12em; color:rgba(245,242,235,0.2); z-index:10; }
#instructions { position:fixed; bottom:24px; right:24px; font-family:var(--mono); font-size:9px; letter-spacing:0.1em; color:rgba(245,242,235,0.18); text-align:right; line-height:1.8; z-index:10; }
#results-label { position:fixed; top:140px; left:50%; transform:translateX(-50%); font-family:var(--mono); font-size:10px; letter-spacing:0.12em; color:var(--gold); z-index:10; opacity:0; transition:opacity 0.4s; pointer-events:none; white-space:nowrap; }
#results-label.show { opacity:1; }
#warp-overlay { position:fixed; inset:0; z-index:15; pointer-events:none; opacity:0; background:radial-gradient(ellipse at center,rgba(201,168,76,0.04) 0%,transparent 70%); transition:opacity 0.3s; }
#warp-overlay.active { opacity:1; }

/* Time Travel */
#time-travel {
  position: fixed;
  right: 24px;
  top: 170px;
  z-index: 10;
  width: 220px;
  background: rgba(10,10,18,0.78);
  border: 0.5px solid rgba(245,242,235,0.1);
  padding: 12px 14px;
  border-radius: 2px;
  backdrop-filter: blur(8px);
}
.tt-heading {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.14em;
  color: var(--gold);
  margin-bottom: 10px;
}
#year-slider {
  width: 100%;
  accent-color: var(--gold);
  cursor: pointer;
}
#year-readout {
  margin-top: 8px;
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.1em;
  color: rgba(245,242,235,0.45);
}

/* Meteor of the Day */
#meteor-fact {
  position: fixed;
  right: 24px;
  bottom: 80px;
  width: 280px;
  z-index: 10;
  background: rgba(10,10,18,0.78);
  border: 0.5px solid rgba(245,242,235,0.1);
  padding: 14px 16px;
  border-radius: 2px;
  backdrop-filter: blur(8px);
  font-family: var(--mono);
}
#meteor-fact .meteor-label {
  font-size: 9px;
  letter-spacing: 0.14em;
  color: var(--gold);
  margin-bottom: 8px;
}
#meteor-fact .meteor-title {
  font-family: var(--serif);
  font-size: 14px;
  line-height: 1.5;
  color: var(--paper);
  margin-bottom: 6px;
}
#meteor-fact .meteor-meta {
  font-size: 9px;
  letter-spacing: 0.08em;
  color: rgba(245,242,235,0.38);
  line-height: 1.6;
}

/* Detail panel */
#detail-panel { position:fixed; right:0; top:0; bottom:0; width:360px; background:rgba(10,10,18,0.97); border-left:0.5px solid rgba(245,242,235,0.08); z-index:20; transform:translateX(100%); transition:transform 0.4s cubic-bezier(0.16,1,0.3,1); overflow-y:auto; padding:28px 28px 40px; display:flex; flex-direction:column; gap:0; cursor:default; }
#detail-panel.open { transform:translateX(0); }
#detail-close { position:absolute; top:18px; right:20px; background:none; border:none; color:rgba(245,242,235,0.3); font-size:18px; cursor:pointer; font-family:var(--mono); line-height:1; transition:color 0.15s; }
#detail-close:hover { color:var(--paper); }
.detail-field-label { font-family:var(--mono); font-size:9px; letter-spacing:0.15em; text-transform:uppercase; color:rgba(245,242,235,0.3); margin-bottom:4px; margin-top:20px; }
#detail-category { font-family:var(--mono); font-size:9px; letter-spacing:0.12em; padding:3px 8px; border-radius:1px; display:inline-block; margin-bottom:14px; }
#detail-title { font-family:var(--serif); font-size:20px; font-weight:300; line-height:1.45; color:var(--paper); margin-bottom:8px; }
#detail-authors { font-family:var(--mono); font-size:10px; color:rgba(245,242,235,0.4); letter-spacing:0.04em; line-height:1.6; margin-bottom:6px; }
#detail-year { font-family:var(--mono); font-size:10px; color:var(--gold); letter-spacing:0.08em; }
#detail-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}
.detail-action-btn {
  background: rgba(245,242,235,0.04);
  border: 0.5px solid rgba(245,242,235,0.12);
  color: var(--gold);
  padding: 8px 10px;
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  cursor: pointer;
  border-radius: 2px;
  transition: background 0.15s, border-color 0.15s;
}
.detail-action-btn:hover {
  background: rgba(201,168,76,0.08);
  border-color: rgba(201,168,76,0.35);
}
#detail-lore { font-family:var(--mono); font-size:9px; font-style:italic; border-bottom:0.5px solid rgba(245,242,235,0.05); padding-bottom:12px; margin-bottom:14px; color:rgba(245,242,235,0.4); line-height:1.6; }
#detail-abstract { font-family:var(--serif); font-size:13px; font-style:italic; line-height:1.75; color:rgba(245,242,235,0.65); border-left:1.5px solid rgba(201,168,76,0.25); padding-left:14px; margin-top:4px; }
#detail-score { display:flex; align-items:center; gap:10px; margin-top:4px; }
.score-bar-wrap { flex:1; height:3px; background:rgba(245,242,235,0.08); border-radius:2px; overflow:hidden; }
.score-bar { height:100%; border-radius:2px; background:var(--gold); transition:width 0.6s ease; }
.score-val { font-family:var(--mono); font-size:11px; color:var(--gold); min-width:36px; text-align:right; }
#detail-similar { display:flex; flex-direction:column; gap:6px; margin-top:4px; }
.similar-item { padding:8px 10px; border:0.5px solid rgba(245,242,235,0.07); border-radius:2px; cursor:pointer; transition:background 0.15s,border-color 0.15s; }
.similar-item:hover { background:rgba(245,242,235,0.04); border-color:rgba(245,242,235,0.15); }
.similar-title { font-family:var(--serif); font-size:12px; color:var(--paper); line-height:1.4; margin-bottom:3px; }
.similar-meta { font-family:var(--mono); font-size:9px; color:rgba(245,242,235,0.3); letter-spacing:0.06em; }
.elastic-query-box { margin-top:4px; background:rgba(245,242,235,0.03); border:0.5px solid rgba(245,242,235,0.07); border-radius:2px; padding:10px 12px; font-family:var(--mono); font-size:9px; color:rgba(245,242,235,0.35); line-height:1.7; white-space:pre; overflow-x:auto; letter-spacing:0.03em; }

/* Tooltip */
#tooltip { position:fixed; pointer-events:none; z-index:30; display:none; background:rgba(10,10,18,0.92); border:0.5px solid rgba(245,242,235,0.12); border-radius:2px; padding:8px 12px; max-width:240px; }
#tt-title { font-family:var(--serif); font-size:12px; color:var(--paper); line-height:1.4; margin-bottom:3px; }
#tt-meta { font-family:var(--mono); font-size:9px; color:rgba(245,242,235,0.35); letter-spacing:0.06em; }

/* Loader */
#galaxy-loader { position:fixed; inset:0; z-index:100; background:var(--ink); display:flex; align-items:center; justify-content:center; }
.loader-inner { display:flex; flex-direction:column; align-items:center; gap:20px; }
.loader-title { font-family:var(--display); font-size:28px; font-weight:800; letter-spacing:-0.02em; color:var(--paper); }
.loader-title em { font-style:normal; color:var(--gold); }
.loader-bar-wrap { width:240px; height:2px; background:rgba(245,242,235,0.08); border-radius:2px; overflow:hidden; }
.loader-bar { height:100%; width:0%; background:var(--gold); border-radius:2px; transition: width 0.3s ease; }
.loader-label { font-family:var(--mono); font-size:10px; letter-spacing:0.15em; color:rgba(245,242,235,0.3); text-transform:uppercase; }

/* Settings */
#settings-trigger { position:fixed; top:24px; right:24px; z-index:35; font-size:20px; cursor:pointer; opacity:0.5; transition:opacity 0.2s, transform 0.3s; pointer-events: auto; }
#settings-trigger:hover { opacity:1; transform:rotate(90deg); }
#settings-panel { position:fixed; top:64px; right:24px; width:220px; background:rgba(10,10,18,0.95); border:0.5px solid rgba(245,242,235,0.15); border-radius:4px; padding:16px; z-index:35; display:none; flex-direction:column; gap:16px; backdrop-filter:blur(10px); pointer-events: auto; }
#settings-panel.open { display:flex; }
.settings-header { font-family:var(--mono); font-size:9px; letter-spacing:0.15em; color:var(--gold); border-bottom:0.5px solid rgba(245,242,235,0.1); padding-bottom:8px; }
.settings-group { display:flex; flex-direction:column; gap:8px; }
.settings-label { font-family:var(--mono); font-size:8px; color:rgba(245,242,235,0.4); text-transform:uppercase; }
#quality-select { background:rgba(245,242,235,0.05); border:0.5px solid rgba(245,242,235,0.2); color:var(--paper); font-family:var(--mono); font-size:10px; padding:6px; outline:none; }
.switch-wrap { display:flex; align-items:center; gap:8px; cursor:pointer; }
.switch-label { font-family:var(--mono); font-size:10px; color:var(--paper); }
#fps-counter { font-family:var(--mono); font-size:9px; color:rgba(245,242,235,0.3); }

/* Live search */
#search-input { padding-right:112px; }
#live-toggle { position:absolute; right:56px; top:50%; transform:translateY(-50%); font-family:var(--mono); font-size:9px; letter-spacing:0.14em; padding:4px 8px; border-radius:2px; cursor:pointer; background:transparent; border:0.5px solid rgba(245,242,235,0.18); color:rgba(245,242,235,0.35); transition:all 0.15s; }
#live-toggle.on { color:var(--gold); border-color:rgba(201,168,76,0.55); background:rgba(201,168,76,0.08); }
#live-results { margin-top:8px; background:rgba(10,10,18,0.9); border:0.5px solid rgba(245,242,235,0.12); border-radius:2px; backdrop-filter:blur(10px); max-height:min(30vh, 280px); display:flex; flex-direction:column; }
#live-results[hidden] { display:none; }
#live-results.collapsed #live-list { display:none; }
#live-head { display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border-bottom:0.5px solid rgba(245,242,235,0.08); font-family:var(--mono); font-size:9px; letter-spacing:0.12em; color:var(--gold); }
#live-collapse { background:none; border:none; color:rgba(245,242,235,0.4); font-family:var(--mono); font-size:14px; cursor:pointer; line-height:1; padding:0 4px; }
#live-list { overflow-y:auto; padding:4px 0; }
.live-item { padding:7px 12px; cursor:pointer; border-left:2px solid transparent; transition:background 0.15s, border-color 0.15s; }
.live-item:hover, .live-item:focus-visible { background:rgba(245,242,235,0.04); border-left-color:var(--gold); outline:none; }
.live-title { font-family:var(--serif); font-size:13px; line-height:1.35; color:var(--paper); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.live-meta { font-family:var(--mono); font-size:9px; letter-spacing:0.05em; color:rgba(245,242,235,0.38); margin-top:3px; display:flex; flex-wrap:wrap; gap:4px 10px; align-items:center; }
.live-badge { font-size:8px; letter-spacing:0.12em; padding:1px 5px; border-radius:1px; border:0.5px solid currentColor; }
.live-badge.in { color:#3dd9a4; }
.live-badge.new { color:var(--gold); }
.live-meta a { color:rgba(245,242,235,0.55); text-decoration:none; border-bottom:0.5px dotted rgba(245,242,235,0.3); }
.live-meta a:hover { color:var(--gold); }
.live-note { padding:10px 12px; font-family:var(--mono); font-size:10px; line-height:1.6; color:rgba(245,242,235,0.45); }
.live-note a { color:var(--gold); }
#live-pill.off .es-dot { background:rgba(245,242,235,0.25); animation:none; }
#live-pill.limited .es-dot { background:#f9c74f; animation:none; }

#detail-panel.open ~ #settings-trigger, #detail-panel.open ~ #settings-panel { display:none; }

/* Detail extras */
#detail-venue { font-family:var(--mono); font-size:9px; letter-spacing:0.06em; color:rgba(245,242,235,0.35); margin-top:4px; }
#detail-venue:empty { display:none; }
#detail-links { display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; }
.detail-link { font-family:var(--mono); font-size:9px; letter-spacing:0.1em; text-transform:uppercase; color:var(--paper); text-decoration:none; padding:5px 9px; border:0.5px solid rgba(245,242,235,0.15); border-radius:2px; transition:border-color 0.15s, color 0.15s; }
.detail-link:hover { border-color:var(--gold); color:var(--gold); }
.detail-empty { font-family:var(--mono); font-size:9px; color:rgba(245,242,235,0.3); padding:4px 0; }

@media (max-width: 720px) {
  #time-travel, #meteor-fact, #instructions, #star-count, .tagline, .elastic-pill { display:none; }
  #hud-top { padding:16px; }
  body #wormhole-btn { right:56px; top:12px; }
  #search-area { top:58px; }
  .chip:nth-child(n+4) { display:none; }
  /* Legend becomes one scrollable row along the bottom */
  #legend { left:0; right:0; bottom:12px; flex-direction:row; gap:14px; overflow-x:auto; padding:0 16px 4px; scrollbar-width:none; }
  #legend::-webkit-scrollbar { display:none; }
  .legend-group-header { display:none; }
  .legend-row { white-space:nowrap; flex-shrink:0; }
  #detail-panel { width:100%; }
}

/* High Contrast mode */
body.high-contrast .wordmark, body.high-contrast #detail-title { color:#fff !important; text-shadow: 0 0 10px rgba(255,255,255,0.5); }
body.high-contrast #canvas { filter: saturate(1.5) contrast(1.2); }
`;
document.head.appendChild(style);

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

// Legend: delegate - rows added dynamically after galaxy loads
document.getElementById('legend').addEventListener('click', e => {
  const row = e.target.closest('.legend-row');
  if (!row) return;
  document.querySelectorAll('.legend-row').forEach(r => r.classList.remove('active'));
  row.classList.add('active');
  const cluster = row.dataset.cluster;
  import('./galaxy.js').then(({ filterCluster }) => {
    if (cluster === 'all') clearHighlights();
    filterCluster(cluster);
  });
});

// ── Search (local galaxy + live OpenAlex) ─────────────────────────────────────

const LIVE_KEY = 'search-comete-live';
let liveEnabled = (() => { try { return localStorage.getItem(LIVE_KEY) !== '0'; } catch { return true; } })();
let searchSeq = 0;          // ignore results from searches that were superseded
let localHits = [];

const liveToggle = document.getElementById('live-toggle');
const liveBox    = document.getElementById('live-results');
const liveList   = document.getElementById('live-list');
const livePill   = document.getElementById('live-pill');

function _syncLiveToggle() {
  liveToggle.classList.toggle('on', liveEnabled);
  liveToggle.setAttribute('aria-pressed', String(liveEnabled));
  livePill.classList.toggle('off', !liveEnabled);
  document.getElementById('live-pill-text').textContent = liveEnabled ? 'OPENALEX · LIVE' : 'OFFLINE INDEX';
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

  // 1. Instant: search the galaxy itself
  localHits = await doSearch(q);
  if (seq !== searchSeq) return;

  if (localHits.length) {
    _flashLabel(`${localHits.length} PAPERS IN THIS GALAXY`);
    highlightStars(localHits.map(r => r.id));
    // getRemappedPos() returns scene coordinates; r.x/y/z are raw UMAP coords
    const pos = getRemappedPos(localHits[0].id);
    if (pos) flyToCluster(pos);
    setTimeout(() => { if (seq === searchSeq) showDetail(localHits[0]); }, 600);
  } else {
    _flashLabel(liveEnabled ? 'NOTHING HERE YET · SEARCHING ALL OF SCIENCE…' : 'NO RESULTS FOUND', 2000);
    clearHighlights();
  }

  // 2. Live: search all of OpenAlex in the background
  if (liveEnabled) _runLiveSearch(q, seq);
}

async function _runLiveSearch(q, seq) {
  liveBox.hidden = false;
  liveBox.classList.remove('collapsed');
  document.getElementById('live-collapse').textContent = '–';
  document.getElementById('live-summary').textContent = 'SEARCHING OPENALEX…';
  liveList.innerHTML = '';

  let live;
  try {
    live = await searchLive(q);
  } catch (e) {
    if (seq !== searchSeq) return;
    livePill.classList.toggle('limited', !!e.rateLimited);
    document.getElementById('live-summary').textContent = 'LIVE SEARCH UNAVAILABLE';
    liveList.innerHTML = `<div class="live-note">${_esc(e.message)}. You can still
      <a href="https://scholar.google.com/scholar?q=${encodeURIComponent(q)}" target="_blank" rel="noopener noreferrer">search Google Scholar ↗</a>.</div>`;
    return;
  }
  if (seq !== searchSeq) return;
  livePill.classList.remove('limited');

  // Results already in the galaxy light up; the rest become visitor orbs
  // parked next to the galaxy papers their titles most resemble.
  const visitors = [];
  const inGalaxy = [];
  live.results.forEach(p => {
    if (hasStar(p.id)) { inGalaxy.push(p.id); return; }
    const spot = _placeVisitor(p);
    if (spot) { p.cluster = p.cluster || spot.cluster; visitors.push({ paper: p, ...spot.pos }); }
  });
  setVisitors(visitors);
  if (inGalaxy.length) highlightStars([...localHits.map(r => r.id), ...inGalaxy]);

  document.getElementById('live-summary').textContent =
    `${live.total.toLocaleString()} RESULTS ON OPENALEX · ${inGalaxy.length} MAPPED · ${visitors.length} NEW`;

  if (!live.results.length) {
    liveList.innerHTML = '<div class="live-note">No papers found on OpenAlex either.</div>';
    return;
  }

  liveList.innerHTML = live.results.map((p, i) => {
    const mapped = hasStar(p.id);
    const links = [
      `<a href="${_esc(scholarUrl(p.title))}" target="_blank" rel="noopener noreferrer">Scholar ↗</a>`,
      p.pdfUrl && /^https?:\/\//.test(p.pdfUrl) && `<a href="${_esc(p.pdfUrl)}" target="_blank" rel="noopener noreferrer">PDF ↗</a>`,
      p.doi && `<a href="${_esc(p.doi)}" target="_blank" rel="noopener noreferrer">DOI ↗</a>`,
    ].filter(Boolean).join('');
    return `
      <div class="live-item" tabindex="0" data-i="${i}">
        <div class="live-title">${_esc(p.title)}</div>
        <div class="live-meta">
          <span class="live-badge ${mapped ? 'in' : 'new'}">${mapped ? 'IN GALAXY' : 'NEW STAR'}</span>
          <span>${_esc((p.authors || '').split(',')[0] || 'Unknown')} · ${p.year || '—'} · ${(p.cite || 0).toLocaleString()} cites</span>
          ${links}
        </div>
      </div>`;
  }).join('');

  liveList.querySelectorAll('.live-item').forEach(el => {
    const open = (e) => {
      if (e.target.closest('a')) return;
      const p = live.results[Number(el.dataset.i)];
      const pos = getRemappedPos(p.id);
      if (pos) flyTo(pos);
      showDetail(p);
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

window.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing) {
    e.preventDefault();
    document.getElementById('search-input').focus();
  } else if (e.key === 'Escape') {
    if (document.getElementById('detail-panel').classList.contains('open')) closeDetail();
    else if (typing) document.activeElement.blur();
  }
});

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
    };
  }
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

// Full label map for all 15 clusters + all pipeline variants
const CLUSTER_META = {
  // id          label                    group
  ml:    { label: 'Machine Learning',  group: 'AI & Computing'   },
  cs:    { label: 'Computer Science',  group: 'AI & Computing'   },
  math:  { label: 'Mathematics',       group: 'Formal Sciences'  },
  phys:  { label: 'Physics',           group: 'Natural Sciences' },
  astro: { label: 'Astronomy',         group: 'Natural Sciences' },
  chem:  { label: 'Chemistry',         group: 'Natural Sciences' },
  bio:   { label: 'Biology',           group: 'Life Sciences'    },
  neuro: { label: 'Neuroscience',      group: 'Life Sciences'    },
  med:   { label: 'Medicine',          group: 'Life Sciences'    },
  mat:   { label: 'Materials Science', group: 'Natural Sciences' },
  eng:   { label: 'Engineering',       group: 'Applied Sciences' },
  env:   { label: 'Environment',       group: 'Applied Sciences' },
  econ:  { label: 'Economics',         group: 'Social Sciences'  },
  psych: { label: 'Psychology',        group: 'Social Sciences'  },
  edu:   { label: 'Education',         group: 'Social Sciences'  },
  // pipeline full-name variants
  machine_learning:  { label: 'Machine Learning',  group: 'AI & Computing'   },
  computer_science:  { label: 'Computer Science',  group: 'AI & Computing'   },
  mathematics:       { label: 'Mathematics',       group: 'Formal Sciences'  },
  physics:           { label: 'Physics',           group: 'Natural Sciences' },
  astronomy:         { label: 'Astronomy',         group: 'Natural Sciences' },
  chemistry:         { label: 'Chemistry',         group: 'Natural Sciences' },
  biology:           { label: 'Biology',           group: 'Life Sciences'    },
  neuroscience:      { label: 'Neuroscience',      group: 'Life Sciences'    },
  medicine:          { label: 'Medicine',          group: 'Life Sciences'    },
  materials_science: { label: 'Materials Science', group: 'Natural Sciences' },
  engineering:       { label: 'Engineering',       group: 'Applied Sciences' },
  environment:       { label: 'Environment',       group: 'Applied Sciences' },
  economics:         { label: 'Economics',         group: 'Social Sciences'  },
  psychology:        { label: 'Psychology',        group: 'Social Sciences'  },
  education:         { label: 'Education',         group: 'Social Sciences'  },
};

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

function _getClusterMeta(id) {
  return CLUSTER_META[id] || CLUSTER_META[id?.toLowerCase()] || {
    label: (id || 'Unknown').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    group: 'Other',
  };
}

function _buildLegend(stars) {
  const clusterIds = [...new Set(stars.map(s => s.cluster).filter(Boolean))].sort();
  const legend = document.getElementById('legend');

  const groups = {};
  clusterIds.forEach(id => {
    const meta = _getClusterMeta(id);
    if (!groups[meta.group]) groups[meta.group] = [];
    groups[meta.group].push(id);
  });

  const allRow = legend.querySelector('[data-cluster="all"]');
  legend.innerHTML = '';
  if (allRow) legend.appendChild(allRow);

  if (!document.getElementById('legend-subgroup-style')) {
    const s = document.createElement('style');
    s.id = 'legend-subgroup-style';
    s.textContent = `
      .legend-group-header {
        font-family: var(--mono);
        font-size: 8px;
        letter-spacing: 0.18em;
        color: rgba(245,242,235,0.2);
        text-transform: uppercase;
        margin-top: 10px;
        margin-bottom: 2px;
        padding-left: 15px;
        pointer-events: none;
        user-select: none;
      }
      .legend-group-header:first-of-type { margin-top: 6px; }
    `;
    document.head.appendChild(s);
  }

  const groupOrder = [
    'AI & Computing',
    'Formal Sciences',
    'Natural Sciences',
    'Life Sciences',
    'Applied Sciences',
    'Social Sciences',
    'Other'
  ];

  groupOrder.forEach(groupName => {
    const ids = groups[groupName];
    if (!ids || !ids.length) return;

    const header = document.createElement('div');
    header.className = 'legend-group-header';
    header.textContent = groupName;
    legend.appendChild(header);

    ids.forEach(id => {
      const meta = _getClusterMeta(id);
      const colorHex = CLUSTER_COLORS[id];
      const hex = colorHex ? '#' + colorHex.toString(16).padStart(6, '0') : '#888888';

      const row = document.createElement('div');
      row.className = 'legend-row';
      row.dataset.cluster = id;
      row.innerHTML = `<div class="legend-dot" style="background:${hex}"></div>${meta.label.toUpperCase()}`;
      legend.appendChild(row);
    });
  });

  console.log(
    '[main] Legend built -',
    Object.keys(groups).map(g => `${g}: ${groups[g].join(',')}`).join(' | ')
  );
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

function initFPSMonitor() {
  let frameCount = 0;
  let lastTime = performance.now();
  const counter = document.getElementById('fps-counter');

  registerFrameHook(() => {
    frameCount++;
    const now = performance.now();
    if (now - lastTime >= 1000) {
      const fps = Math.round((frameCount * 1000) / (now - lastTime));
      counter.textContent = `FPS: ${fps}`;
      
      // Auto-quality adjustment if FPS is consistently low
      if (fps < 40 && document.getElementById('quality-select').value === 'high') {
         console.warn('[main] Low performance detected, suggesting quality reduction');
      }

      frameCount = 0;
      lastTime = now;
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
  document.getElementById('star-count').textContent = `${stars.length.toLocaleString()} PAPERS MAPPED`;
  document.getElementById('tagline').textContent =
    `${stars.length.toLocaleString()} papers · closeness = similar meaning · live search across 250M+ works`;

  buildMeteorFact(stars);

  let minYear = Infinity, maxYear = -Infinity;
  stars.forEach(s => {
    const y = Number(s.year);
    if (y > 0) { minYear = Math.min(minYear, y); maxYear = Math.max(maxYear, y); }
  });

  const slider = document.getElementById('year-slider');
  const readout = document.getElementById('year-readout');

  slider.min = minYear;
  slider.max = maxYear;
  slider.step = 1;
  slider.value = maxYear;

  const syncYear = () => {
    const y = Number(slider.value);
    if (y >= maxYear) {
      setActiveYear(Infinity);
      readout.textContent = 'ALL YEARS';
    } else {
      setActiveYear(y);
      readout.textContent = `VISIBLE THROUGH ${y}`;
    }
  };

  slider.addEventListener('input', syncYear);
  syncYear();

  // Give the corpus to both search.js and panel.js
  setSearchCorpus(stars);
  setCorpus(stars);

  // Rebuild legend after initGalaxy so CLUSTER_COLORS is populated
  requestAnimationFrame(() => _buildLegend(stars));

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
        const { getWork } = await import('./live.js');
        showDetail(await getWork(id));
      } catch (e) {
        console.warn('[url] could not open paper', paperId, e.message);
      }
    }
  }
}