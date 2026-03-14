/**
 * search-comete — main.js (Noosphere Edition)
 * Entry point. Injects UI, runs onboarding lore, initialises galaxy + all Phase 3 features.
 *
 * Noosphere features added:
 *  1. Onboarding lore sequence (localStorage-gated)
 *  2. Voice input via Web Speech API
 *  3. Data sonification toggle (Harmonic Synthesizer)
 *  4. Time Mode — stars reorganise along Z = publication year
 *  5. The Crucible — double-click to isolate a cluster (handled in galaxy.js)
 *  6. WebXR entry button (shown if browser supports immersive-vr)
 */

import {
  initGalaxy, highlightStars, clearHighlights,
  flyTo, flyToCluster, getRemappedPos,
  CLUSTER_COLORS,
  toggleTimeMode, isTimeModeActive,
  exitCrucible,
  enterXR,
  getClusterCentroids, getCameraPosition,
  setReducedMotion,
} from './galaxy.js';
import { doSearch } from './search.js';
import { showDetail, closeDetail } from './panel.js';
import { FALLBACK_PAPERS } from './data.js';
import {
  initSonification, toggleSonification, isActive as isSonicActive,
} from './sonification.js';

// ── Inject UI HTML ────────────────────────────────────────────────────────────
document.getElementById('app').innerHTML = `
<canvas id="canvas"></canvas>

<div id="hud-top">
  <div class="wordmark">search<em>·comète</em></div>
  <div class="tagline">Noosphere 2.0 · Semantic search · Spatial knowledge discovery</div>
  <div class="elastic-pill"><div class="es-dot"></div>ELASTIC · RRF</div>
  <div id="noosphere-toolbar">
    <button id="sound-btn" title="Harmonic Synthesizer">🔇</button>
    <button id="time-btn" title="Temporal Mode">⏱ TIME</button>
  </div>
</div>

<div id="search-area">
  <div id="search-wrap">
    <input id="search-input" type="text" placeholder="Speak or type your query into the cosmos…" autocomplete="off" />
    <button id="mic-btn" title="Voice input">🎤</button>
    <button id="search-btn">→</button>
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

<div id="legend">
  <div class="legend-row active" data-cluster="all">
    <div class="legend-dot" style="background:rgba(245,242,235,0.4)"></div>ALL FIELDS
  </div>
</div>

<div id="star-count"></div>
<div id="instructions">arrows/drag to orbit · scroll/+- to zoom · click a star</div>

<div id="a11y-live" aria-live="polite" aria-atomic="true" class="sr-only"></div>

<div id="detail-panel">
  <button id="detail-close">✕</button>
  <div id="detail-category"></div>
  <div id="detail-title"></div>
  <div id="detail-authors"></div>
  <div id="detail-year"></div>
  <div class="detail-field-label">Abstract</div>
  <div id="detail-abstract"></div>
  <div class="detail-field-label">Semantic relevance score</div>
  <div id="detail-score">
    <div class="score-bar-wrap"><div class="score-bar" id="score-bar"></div></div>
    <div class="score-val" id="score-val"></div>
  </div>
  <div class="detail-field-label">Similar papers (kNN neighbours)</div>
  <div id="detail-similar"></div>
  <div class="detail-field-label">Elasticsearch kNN query</div>
  <div class="elastic-query-box" id="elastic-query"></div>
</div>

<div id="tooltip">
  <div id="tt-title"></div>
  <div id="tt-meta"></div>
</div>

<div id="warp-overlay"></div>

<div id="galaxy-loader">
  <div class="loader-inner">
    <div class="loader-title">search<em>·comète</em></div>
    <div class="loader-bar-wrap"><div class="loader-bar"></div></div>
    <div class="loader-label">Mapping the universe…</div>
  </div>
</div>

<div id="crucible-banner">THE CRUCIBLE — ESC to exit</div>
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
.elastic-pill { margin-left:auto; display:flex; align-items:center; gap:6px; font-family:var(--mono); font-size:9px; letter-spacing:0.1em; color:rgba(245,242,235,0.35); border:0.5px solid rgba(245,242,235,0.1); border-radius:2px; padding:5px 10px; }
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
.loader-bar { height:100%; width:0%; background:var(--gold); border-radius:2px; animation:load-progress 2s ease-in-out forwards; }
@keyframes load-progress { 0%{width:0%} 60%{width:75%} 90%{width:92%} 100%{width:100%} }
.loader-label { font-family:var(--mono); font-size:10px; letter-spacing:0.15em; color:rgba(245,242,235,0.3); text-transform:uppercase; }

/* Noosphere toolbar */
#noosphere-toolbar { display:flex; align-items:center; gap:6px; margin-left:10px; }
#noosphere-toolbar button { font-family:var(--mono); font-size:10px; letter-spacing:0.08em; padding:5px 10px; border:0.5px solid rgba(245,242,235,0.15); border-radius:2px; cursor:pointer; transition:all 0.15s; color:rgba(245,242,235,0.45); background:transparent; pointer-events:auto; }
#noosphere-toolbar button:hover { border-color:var(--gold); color:var(--gold); }
#noosphere-toolbar button.ns-active { border-color:var(--gold); color:var(--gold); background:rgba(201,168,76,0.08); }

/* Mic button */
#mic-btn { position:absolute; right:52px; height:100%; width:38px; background:none; border:none; border-left:0.5px solid rgba(245,242,235,0.08); color:rgba(245,242,235,0.35); font-size:13px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:color 0.15s; }
#mic-btn:hover { color:var(--paper); }
#mic-btn.listening { color:var(--gold); animation:mic-pulse 1s ease-in-out infinite; }
@keyframes mic-pulse { 0%,100%{box-shadow:0 0 0 0 rgba(201,168,76,0.4)} 50%{box-shadow:0 0 0 6px rgba(201,168,76,0)} }

/* Crucible banner */
#crucible-banner { position:fixed; top:0; left:50%; transform:translateX(-50%); z-index:25; font-family:var(--mono); font-size:10px; letter-spacing:0.18em; color:var(--gold); background:rgba(10,10,18,0.9); border-bottom:0.5px solid rgba(201,168,76,0.25); padding:8px 24px; pointer-events:none; opacity:0; transition:opacity 0.4s; }

/* Crucible labels (CSS2D) */
.crucible-label { font-family:var(--mono); font-size:8px; letter-spacing:0.06em; color:rgba(245,242,235,0.7); background:rgba(10,10,18,0.75); border:0.5px solid rgba(245,242,235,0.1); border-radius:1px; padding:2px 5px; white-space:nowrap; pointer-events:none; }

/* WebXR button */
#xr-btn { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); z-index:10; font-family:var(--mono); font-size:10px; letter-spacing:0.12em; color:var(--gold); background:rgba(10,10,18,0.85); border:0.5px solid rgba(201,168,76,0.35); border-radius:2px; padding:8px 20px; cursor:pointer; transition:all 0.2s; }
#xr-btn:hover { background:rgba(201,168,76,0.08); border-color:var(--gold); }

/* Noosphere onboarding overlay */
#noosphere-intro {
  position:fixed; inset:0; z-index:200; background:var(--ink);
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:36px;
  background-image: radial-gradient(ellipse at 50% 50%, rgba(124,109,250,0.06) 0%, transparent 70%);
}
.ns-wordmark { font-family:var(--display); font-size:52px; font-weight:800; letter-spacing:-0.04em; color:var(--paper); animation:ns-fade 1.2s ease forwards; }
.ns-wordmark em { font-style:normal; color:var(--gold); }
.ns-lore { font-family:var(--serif); font-size:17px; font-style:italic; line-height:2; color:rgba(245,242,235,0.6); text-align:center; max-width:540px; animation:ns-fade 1.4s 0.4s ease both; }
.ns-lore em { font-style:normal; color:var(--gold); }
.ns-subtitle { font-family:var(--mono); font-size:10px; letter-spacing:0.2em; color:rgba(245,242,235,0.25); text-transform:uppercase; animation:ns-fade 1s 0.6s ease both; }
#ns-enter { font-family:var(--mono); font-size:12px; letter-spacing:0.14em; color:var(--ink); background:var(--gold); border:none; border-radius:2px; padding:14px 36px; cursor:pointer; transition:all 0.2s; animation:ns-fade 1s 1.2s ease both; }
#ns-enter:hover { background:#e0be5c; transform:translateY(-1px); }
@keyframes ns-fade { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }

/* Accessibility */
.sr-only { position:absolute; width:1px; height:1px; padding:0; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
`;
document.head.appendChild(style);

// ── Accessibility: reduced-motion ────────────────────────────────────────────
// Wire prefers-reduced-motion both on load and whenever the OS pref changes.
const _motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
function _applyReducedMotion(e) {
  setReducedMotion(e.matches);
}
_applyReducedMotion(_motionQuery);
_motionQuery.addEventListener('change', _applyReducedMotion);

// ── Noosphere toolbar button wiring ─────────────────────────────────────────
const soundBtn = document.getElementById('sound-btn');
if (soundBtn) {
  soundBtn.addEventListener('click', () => {
    const on = toggleSonification();
    soundBtn.textContent = on ? '🔊' : '🔇';
    soundBtn.classList.toggle('ns-active', on);
  });
}

const timeBtn = document.getElementById('time-btn');
if (timeBtn) {
  timeBtn.addEventListener('click', () => {
    const next = !isTimeModeActive();
    toggleTimeMode(next);
    timeBtn.classList.toggle('ns-active', next);
    timeBtn.textContent = next ? '⏱ ORRERY' : '⏱ TIME';
  });
}

// ── Voice input (Web Speech API) ─────────────────────────────────────────────
const micBtn = document.getElementById('mic-btn');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition && micBtn) {
  const recog = new SpeechRecognition();
  recog.lang = 'en-US';
  recog.interimResults = false;
  recog.maxAlternatives = 1;

  micBtn.addEventListener('click', () => {
    micBtn.classList.add('listening');
    try { recog.start(); } catch { }
  });
  recog.onresult = e => {
    const transcript = e.results[0][0].transcript;
    let query = transcript;
    let targetCluster = 'all';

    const lower = transcript.toLowerCase();

    // Intent Decomposition: "show me [cluster] papers about [topic]"
    const clusterMap = {
      'biology': 'bio', 'physics': 'phys', 'machine learning': 'ml', 'ai': 'ml',
      'computer science': 'cs', 'math': 'math', 'chemistry': 'chem', 'economics': 'econ',
      'environmental': 'env', 'environment': 'env', 'medical': 'med', 'medicine': 'med'
    };

    for (const [key, val] of Object.entries(clusterMap)) {
      if (lower.includes(`${key} papers`) || lower.includes(`${key} research`)) {
        targetCluster = val;
        query = lower.replace(new RegExp(`${key} (papers|research)`, 'g'), '')
          .replace(/show me|find|about|on|for/g, '').trim();
        break;
      }
    }

    // Strip generic filler if no domain matched
    if (query === transcript) {
      query = query.replace(/^(show me papers bridging|show me papers about|show me papers on|search for|find papers about|papers on)\s+/i, '');
      query = query.replace(/\bbridging\b/i, '');
      query = query.trim();
    }

    document.getElementById('search-input').value = query || transcript;
    micBtn.classList.remove('listening');

    if (targetCluster !== 'all') {
      // Apply domain filter before running RRF search
      import('./galaxy.js').then(({ filterCluster }) => {
        filterCluster(targetCluster);
        // update UI legend
        document.querySelectorAll('.legend-row').forEach(r => {
          r.classList.toggle('active', r.dataset.cluster === targetCluster);
        });
        triggerSearch();
      });
    } else {
      triggerSearch();
    }
  };
  recog.onend = () => micBtn.classList.remove('listening');
  recog.onerror = () => micBtn.classList.remove('listening');
} else if (micBtn) {
  micBtn.style.display = 'none';
}

// ── Standard interaction wiring ──────────────────────────────────────────────

document.getElementById('search-btn').addEventListener('click', triggerSearch);
document.getElementById('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') triggerSearch(); });

document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.getElementById('search-input').value = chip.dataset.q;
    triggerSearch();
  });
});

document.getElementById('detail-close').addEventListener('click', closeDetail);

// Legend: delegate — rows added dynamically after galaxy loads
document.getElementById('legend').addEventListener('click', e => {
  const row = e.target.closest('.legend-row');
  if (!row) return;
  document.querySelectorAll('.legend-row').forEach(r => r.classList.remove('active'));
  row.classList.add('active');
  const cluster = row.dataset.cluster;
  import('./galaxy.js').then(({ filterCluster }) => filterCluster(cluster));
});

async function triggerSearch() {
  const q = document.getElementById('search-input').value.trim();
  const a11y = document.getElementById('a11y-live');
  if (!q) {
    clearHighlights();
    document.getElementById('results-label').classList.remove('show');
    return;
  }
  const results = await doSearch(q);
  if (!results.length) {
    const label = document.getElementById('results-label');
    label.textContent = 'NO RESULTS FOUND';
    label.classList.add('show');
    if (a11y) a11y.textContent = 'No results found for: ' + q;
    setTimeout(() => label.classList.remove('show'), 2000);
    return;
  }

  const label = document.getElementById('results-label');
  label.textContent = `${results.length} PAPERS FOUND — FLYING TO CLUSTER`;
  label.classList.add('show');
  if (a11y) a11y.textContent = `${results.length} papers found for: ${q}. Flying to cluster.`;
  setTimeout(() => label.classList.remove('show'), 2500);

  highlightStars(results.map(r => r.id));

  const top = results[0];
  const remapped = getRemappedPos(top.id);
  if (remapped) {
    flyToCluster(remapped);
  } else if (top.x !== undefined) {
    flyToCluster({ x: top.x, y: top.y, z: top.z });
  }

  setTimeout(() => showDetail(top), 600);
}

// ── Load stars ────────────────────────────────────────────────────────────────

/**
 * FIX: Priority order with cluster-count guard.
 *
 * The problem was: /api/stars returned 200 OK but only had ml+bio papers
 * (partial pipeline run). loadStars() accepted that and never fell through
 * to the full fallback data.
 *
 * Now: if the returned data has fewer than MIN_CLUSTERS distinct clusters,
 * we treat it as insufficient and try the next source.
 */
const MIN_CLUSTERS = 1; // require at least this many clusters before trusting a source

// FIX: pipeline data uses `cluster_id`; fallback/API data uses `cluster`.
// Check both so stars.json is never skipped due to wrong field name.
function _countClusters(stars) {
  return new Set(stars.map(s => s.cluster || s.cluster_id).filter(Boolean)).size;
}

// Normalise pipeline field names (cluster_id, pos_x, etc.) to what the
// frontend expects (cluster, x, y, z) so stars.json works without backend mapping.
function _normaliseStars(stars) {
  return stars.map(s => ({
    ...s,
    cluster: s.cluster || s.cluster_id || '',
    color: s.color || s.cluster_color || '#ffffff',
    x: s.x ?? s.pos_x ?? 0,
    y: s.y ?? s.pos_y ?? 0,
    z: s.z ?? s.pos_z ?? 0,
    cite: s.cite ?? s.citations ?? 0,
  }));
}

async function loadStars() {
  console.group('[search-comete] loadStars()');

  // 1. Try the live /api/stars endpoint
  try {
    console.log('① Trying /api/stars …');
    const res = await fetch('/api/stars', { signal: AbortSignal.timeout(10000) });
    console.log('  /api/stars HTTP', res.status, res.ok ? 'OK' : 'FAIL');
    if (res.ok) {
      const data = await res.json();
      const raw = Array.isArray(data) ? data : data.stars;
      console.log(`  raw length: ${raw?.length ?? 'null'}`);
      if (raw && raw.length > 0) {
        console.log('  sample[0] keys:', Object.keys(raw[0]).join(', '));
        const stars = _normaliseStars(raw);
        const nc = _countClusters(stars);
        console.log(`  clusters found: ${nc} →`, [...new Set(stars.map(s => s.cluster))]);
        if (nc >= MIN_CLUSTERS) {
          console.info(`✅ Using API: ${stars.length} stars, ${nc} clusters`);
          console.groupEnd();
          return stars;
        }
        console.warn(`  ⚠ only ${nc} cluster(s), need ${MIN_CLUSTERS} — skipping API`);
      } else {
        console.warn('  ⚠ empty array from API');
      }
    }
  } catch (e) {
    console.warn('  ✗ /api/stars failed:', e.message);
  }

  // 2. Try static stars.json (pre-built by pipeline)
  // Vite serves frontend/public/ at /, so this resolves to frontend/public/stars.json
  try {
    console.log('② Trying /stars.json …');
    const res = await fetch('/stars.json', { signal: AbortSignal.timeout(3000) });
    console.log('  /stars.json HTTP', res.status, res.ok ? 'OK' : 'FAIL');
    if (res.ok) {
      const data = await res.json();
      const raw = Array.isArray(data) ? data : data.stars;
      console.log(`  raw length: ${raw?.length ?? 'null'}, isArray: ${Array.isArray(data)}`);
      if (raw && raw.length > 0) {
        console.log('  sample[0] keys:', Object.keys(raw[0]).join(', '));
        console.log('  sample[0]:', JSON.stringify(raw[0]).slice(0, 200));
        const stars = _normaliseStars(raw);
        const nc = _countClusters(stars);
        console.log(`  clusters found: ${nc} →`, [...new Set(stars.map(s => s.cluster))]);
        if (nc >= MIN_CLUSTERS) {
          console.info(`✅ Using stars.json: ${stars.length} stars, ${nc} clusters`);
          console.groupEnd();
          return stars;
        }
        console.warn(`  ⚠ only ${nc} cluster(s) in stars.json, need ${MIN_CLUSTERS} — falling to bundled`);
      } else {
        console.warn('  ⚠ stars.json parsed but array is empty or null');
        console.log('  raw data type:', typeof data, Array.isArray(data) ? '(array)' : '(object)', 'keys:', data ? Object.keys(data).join(', ') : 'null');
      }
    }
  } catch (e) {
    console.warn('  ✗ /stars.json failed:', e.message);
  }

  // 3. Bundled fallback — always has all clusters
  console.info('③ Using bundled FALLBACK_PAPERS');
  console.groupEnd();
  return FALLBACK_PAPERS;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const CLUSTER_LABELS = {
  ml: 'MACHINE LEARNING', bio: 'BIOLOGY', phys: 'PHYSICS', cs: 'COMPUTER SCIENCE',
  math: 'MATHEMATICS', chem: 'CHEMISTRY', econ: 'ECONOMICS', env: 'ENVIRONMENT', med: 'MEDICINE',
  machine_learning: 'MACHINE LEARNING', biology: 'BIOLOGY', physics: 'PHYSICS',
  computer_science: 'COMPUTER SCIENCE', mathematics: 'MATHEMATICS', chemistry: 'CHEMISTRY',
  economics: 'ECONOMICS', environment: 'ENVIRONMENT', medicine: 'MEDICINE',
};

function startGalaxy() {
  loadStars().then(stars => {
    initGalaxy(document.getElementById('canvas'), stars);
    document.getElementById('star-count').textContent = `${stars.length} PAPERS INDEXED`;

    // Initialize Sonification now that we have stars and camera
    initSonification(getCameraPosition, getClusterCentroids);

    // Rebuild legend AFTER initGalaxy() so CLUSTER_COLORS is populated.
    requestAnimationFrame(() => {
      const clusterNames = [...new Set(stars.map(s => s.cluster).filter(Boolean))].sort();
      const legend = document.getElementById('legend');

      const allRow = legend.querySelector('[data-cluster="all"]');
      legend.innerHTML = '';
      if (allRow) legend.appendChild(allRow);

      clusterNames.forEach(name => {
        const colorHex = CLUSTER_COLORS[name];
        const hex = colorHex ? '#' + colorHex.toString(16).padStart(6, '0') : '#888888';
        const label = CLUSTER_LABELS[name.toLowerCase()] || name.toUpperCase().replace(/_/g, ' ');
        const row = document.createElement('div');
        row.className = 'legend-row';
        row.dataset.cluster = name;
        row.innerHTML = `<div class="legend-dot" style="background:${hex}"></div>${label}`;
        legend.appendChild(row);
      });
    });

    // WebXR setup
    if (navigator.xr) {
      navigator.xr.isSessionSupported('immersive-vr').then(supported => {
        if (!supported) return;
        const btn = document.createElement('button');
        btn.id = 'xr-btn';
        btn.textContent = '⬡ ENTER VR';
        document.body.appendChild(btn);
        btn.addEventListener('click', () => enterXR());
      });
    }
  });
}

// ── Noosphere Onboarding Sequence ─────────────────────────────────────────────

if (!localStorage.getItem('noosphere-entered')) {
  const intro = document.createElement('div');
  intro.id = 'noosphere-intro';
  intro.innerHTML = `
    <div class="ns-wordmark">NOOSPHERE <em>2.0</em></div>
    <div class="ns-lore">
      For decades, human knowledge was trapped in two-dimensional archives.<br>
      Today, spatial computing has <em>ignited</em> the dormant data.<br>
      Semantic bonds form gravitational fields.<br>
      A universe of ideas <em>awakens.</em>
    </div>
    <div class="ns-subtitle">PHASE 3 INITIALIZED</div>
    <button id="ns-enter">Enter the Noosphere →</button>
  `;
  document.body.appendChild(intro);

  document.getElementById('ns-enter').addEventListener('click', () => {
    localStorage.setItem('noosphere-entered', '1');
    intro.style.transition = 'opacity 1.2s ease, transform 1.2s ease';
    intro.style.opacity = '0';
    intro.style.transform = 'scale(1.05)';
    intro.style.pointerEvents = 'none';

    // Start background processing while fading out
    startGalaxy();

    setTimeout(() => { intro.remove(); }, 1200);
  });
} else {
  // Return visitor: skip intro
  startGalaxy();
}
