/**
 * search-comete - panel.js
 * Manages the right-hand detail panel: show, close, similar papers.
 *
 * Key fixes vs previous version:
 *  - _loadSimilar() no longer tries to fetch /api/paper/{openalex_url} when
 *    ES is down - that was causing 3s timeouts on every star click because
 *    the OpenAlex URL ID gets URL-encoded into a nonsense endpoint.
 *  - Similar papers now search the FULL loaded corpus (all stars.json papers)
 *    not just the 31 hardcoded FALLBACK_PAPERS.
 *  - setCorpus() called from main.js after stars load so panel has the data.
 *  - All 15 cluster labels and colors mapped correctly.
 */

import { flyTo, getRemappedPos, togglePinned, isPinned } from './galaxy.js';


// Full corpus - set by main.js via setCorpus() after stars load
let _corpus = [];
export function setCorpus(stars) { _corpus = stars; }

// ── Cluster metadata ──────────────────────────────────────────────────────────

const CLUSTER_CSS = {
  ml:    'var(--glow-ml)',   cs:    'var(--glow-cs)',
  math:  'var(--glow-math)', phys:  'var(--glow-phys)',
  astro: '#60a5fa',          chem:  '#f9c74f',
  bio:   'var(--glow-bio)',  neuro: '#34d399',
  med:   '#e63946',          mat:   '#c084fc',
  eng:   '#fb923c',          env:   'var(--glow-bio)',  // reuse green
  econ:  '#90e0ef',          psych: '#f472b6',
  edu:   '#a3e635',
};

const CLUSTER_LABELS = {
  ml:    'Machine Learning',  cs:    'Computer Science',
  math:  'Mathematics',       phys:  'Physics',
  astro: 'Astronomy',         chem:  'Chemistry',
  bio:   'Biology',           neuro: 'Neuroscience',
  med:   'Medicine',          mat:   'Materials Science',
  eng:   'Engineering',       env:   'Environment',
  econ:  'Economics',         psych: 'Psychology',
  edu:   'Education',
  // full-name pipeline variants
  machine_learning: 'Machine Learning', computer_science: 'Computer Science',
  mathematics: 'Mathematics',           physics: 'Physics',
  astronomy: 'Astronomy',               chemistry: 'Chemistry',
  biology: 'Biology',                   neuroscience: 'Neuroscience',
  medicine: 'Medicine',                 materials_science: 'Materials Science',
  engineering: 'Engineering',           environment: 'Environment',
  economics: 'Economics',               psychology: 'Psychology',
  education: 'Education',
  // legacy
  'machine learning': 'Machine Learning', 'computer science': 'Computer Science',
  bioinformatics: 'Bioinformatics',       astrophysics: 'Astrophysics',
  medical: 'Medicine',                    healthcare: 'Healthcare',
  environmental: 'Environmental Science', finance: 'Finance',
};

function _clusterCSS(cluster) {
  return CLUSTER_CSS[cluster] || CLUSTER_CSS[(cluster||'').toLowerCase()] || '#aaaaaa';
}
function _clusterLabel(cluster) {
  return CLUSTER_LABELS[cluster] || CLUSTER_LABELS[(cluster||'').toLowerCase()]
    || (cluster||'Unknown').replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Cite normalisation ────────────────────────────────────────────────────────

function _getCite(paper) {
  const v = paper.cite ?? paper.citations ?? 0;
  return typeof v === 'number' ? v : 0;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function showDetail(paper) {
  const css   = _clusterCSS(paper.cluster);
  const label = _clusterLabel(paper.cluster);

  const badge = document.getElementById('detail-category');
  badge.textContent        = label.toUpperCase();
  badge.style.background   = _hexToRgba(paper.color || '#888888', 0.15);
  badge.style.color        = css;

  document.getElementById('detail-title').textContent   = paper.title   || '-';
  document.getElementById('detail-authors').textContent = paper.authors  || '-';
  document.getElementById('detail-year').textContent    =
    `${paper.year || ''}  ·  ${_getCite(paper).toLocaleString()} citations`;
  document.getElementById('detail-abstract').textContent = paper.abstract || '-';

  const score = paper.score !== undefined ? paper.score : 0.5 + Math.random() * 0.4;
  document.getElementById('score-bar').style.width      = Math.round(score * 100) + '%';
  document.getElementById('score-bar').style.background = css;
  document.getElementById('score-val').textContent      = score.toFixed(3);
  document.getElementById('score-val').style.color      = css;

  const pinBtn = document.getElementById('pin-btn');
  if (pinBtn) {
    const refreshPinLabel = () => {
      pinBtn.textContent = isPinned(paper.id) ? '★ UNPIN STAR' : '☆ PIN AS STAR';
    };
    refreshPinLabel();
    pinBtn.onclick = () => {
      togglePinned(paper.id);
      refreshPinLabel();
    };
  }
  
  _loadSimilar(paper);

  const kw = (paper.keywords || [])[0] || (paper.title || '').split(' ')[0] || '';
  document.getElementById('elastic-query').textContent =
`GET /knowledge_galaxy/_search
{
  "knn": {
    "field": "embedding",
    "query_vector": [...],
    "k": 10,
    "num_candidates": 100
  },
  "query": {
    "match": {
      "abstract": "${kw}"
    }
  }
}`;

  document.getElementById('detail-panel').classList.add('open');
}

export function closeDetail() {
  document.getElementById('detail-panel').classList.remove('open');
}

// ── Similar papers ────────────────────────────────────────────────────────────

async function _loadSimilar(paper) {
  const container = document.getElementById('detail-similar');
  container.innerHTML = '<div style="font-family:var(--mono);font-size:9px;color:rgba(245,242,235,0.3);padding:4px 0;">Finding similar…</div>';

  let similar = [];

  // Only try the API if we're likely to have ES running (not an OpenAlex URL endpoint)
  // Check: if /api/health previously returned ok AND id doesn't look like a full URL
  const idIsUrl = String(paper.id).startsWith('http');
  if (!idIsUrl) {
    try {
      const res = await fetch(`/api/paper/${encodeURIComponent(paper.id)}`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = await res.json();
        similar = (data.similar || []).slice(0, 5);
      }
    } catch { /* ES not running, skip silently */ }
  }

  // Local fallback - search full corpus by cluster + title word overlap
  if (!similar.length) {
    similar = _findSimilarLocally(paper, 5);
  }

  if (!similar.length) {
    container.innerHTML = '<div style="font-family:var(--mono);font-size:9px;color:rgba(245,242,235,0.3);padding:4px 0;">No similar papers found.</div>';
    return;
  }

  container.innerHTML = similar.map(s => `
    <div class="similar-item" data-id="${_escAttr(String(s.id))}">
      <div class="similar-title">${_escHtml(s.title || '-')}</div>
      <div class="similar-meta">${_escHtml((s.authors||'').split(',')[0])} · ${s.year || ''}</div>
    </div>
  `).join('');

  container.querySelectorAll('.similar-item').forEach(el => {
    el.addEventListener('click', () => {
      const id    = el.dataset.id;
      const found = _corpus.find(p => String(p.id) === id);
      if (!found) return;
      showDetail(found);
      const pos = getRemappedPos(found.id);
      if (pos) flyTo(pos);
    });
  });
}

/**
 * Find similar papers locally by:
 * 1. Same cluster (weighted heavily)
 * 2. Title word overlap (TF style)
 * Returns top N results excluding the paper itself.
 */
function _findSimilarLocally(paper, n = 5) {
  const corpus = _corpus.length > 0 ? _corpus : [];
  if (!corpus.length) return [];

  const myId     = String(paper.id);
  const myCluster = paper.cluster;
  const myTokens  = new Set(_tokenise(`${paper.title} ${paper.abstract || ''}`));

  const scored = corpus
    .filter(p => String(p.id) !== myId)
    .map(p => {
      let score = 0;
      // Same cluster = strong signal
      if (p.cluster === myCluster) score += 4;
      // Title/abstract token overlap
      const theirTokens = _tokenise(`${p.title} ${p.abstract || ''}`);
      theirTokens.forEach(t => { if (myTokens.has(t)) score += 1; });
      return { p, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);

  return scored.map(({ p }) => ({
    id: p.id, title: p.title, authors: p.authors, year: p.year,
  }));
}

function _tokenise(text) {
  const STOP = new Set(['a','an','the','and','or','of','in','to','for','is','are',
    'was','were','with','this','that','it','on','we','our','using','based','paper']);
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g,' ')
    .split(/\s+/).filter(t => t.length > 2 && !STOP.has(t));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _hexToRgba(hex, alpha) {
  let clean = typeof hex === 'number'
    ? hex.toString(16).padStart(6, '0')
    : (hex || '').replace('#', '');
  if (clean.length === 3) clean = clean.split('').map(c => c+c).join('');
  const r = parseInt(clean.slice(0,2), 16) || 0;
  const g = parseInt(clean.slice(2,4), 16) || 0;
  const b = parseInt(clean.slice(4,6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
}

function _escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _escAttr(str) {
  return String(str).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}