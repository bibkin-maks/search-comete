/**
 * search-comete - panel.js
 * The right-hand detail panel: paper info, live abstract + links from
 * OpenAlex, pin button and nearby papers.
 *
 * "Nearby papers" are the closest stars in the map itself. Positions come
 * from UMAP over the paper embeddings, so closeness = similar meaning, and
 * it costs a few thousand distance checks instead of a backend round trip.
 */

import { flyTo, getRemappedPos, togglePinned, isPinned, setSelected, nearestStars, hasStar } from './galaxy.js';
import { getLore } from './search.js';
import { getWork, isOpenAlexId, scholarUrl } from './live.js';
import { USE_BACKEND } from './config.js';

// Full corpus - set by main.js via setCorpus() after stars load
let _byId = new Map();
export function setCorpus(stars) {
  _byId = new Map(stars.map(s => [String(s.id), s]));
}

let _current = null;   // paper currently shown, guards async updates

// ── Cluster metadata ──────────────────────────────────────────────────────────

const CLUSTER_CSS = {
  ml:    'var(--glow-ml)',   cs:    'var(--glow-cs)',
  math:  'var(--glow-math)', phys:  'var(--glow-phys)',
  astro: '#60a5fa',          chem:  '#f9c74f',
  bio:   'var(--glow-bio)',  neuro: '#34d399',
  med:   '#e63946',          mat:   '#c084fc',
  eng:   '#fb923c',          env:   '#52b788',
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
};

function _clusterCSS(cluster) {
  return CLUSTER_CSS[(cluster || '').toLowerCase()] || '#aaaaaa';
}
function _clusterLabel(cluster) {
  return CLUSTER_LABELS[(cluster || '').toLowerCase()]
    || (cluster || 'Unmapped').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function _getCite(paper) {
  const v = paper.cite ?? paper.citations ?? 0;
  return typeof v === 'number' ? v : 0;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function showDetail(paper) {
  _current = paper;
  setSelected(hasStar(paper.id) ? paper.id : null);

  const css   = _clusterCSS(paper.cluster);
  const badge = document.getElementById('detail-category');
  badge.textContent      = _clusterLabel(paper.cluster).toUpperCase() + (paper.live && !hasStar(paper.id) ? ' · LIVE RESULT' : '');
  badge.style.background = _hexToRgba(paper.color || '#888888', 0.15);
  badge.style.color      = css;

  document.getElementById('detail-title').textContent   = paper.title || '-';
  document.getElementById('detail-authors').textContent = paper.authors || '-';
  document.getElementById('detail-year').textContent    =
    [paper.year, `${_getCite(paper).toLocaleString()} citations`].filter(Boolean).join('  ·  ');
  document.getElementById('detail-venue').textContent   = paper.venue || '';

  const loreBox = document.getElementById('detail-lore');
  getLore(paper.cluster).then(txt => { if (_current === paper) loreBox.textContent = txt; });

  // Relevance only means something when we came from a search
  const scoreWrap = document.getElementById('detail-score-wrap');
  if (typeof paper.score === 'number') {
    scoreWrap.style.display = '';
    document.getElementById('score-bar').style.width      = Math.round(paper.score * 100) + '%';
    document.getElementById('score-bar').style.background = css;
    document.getElementById('score-val').textContent      = paper.score.toFixed(3);
    document.getElementById('score-val').style.color      = css;
  } else {
    scoreWrap.style.display = 'none';
  }

  const pinBtn = document.getElementById('pin-btn');
  const canPin = hasStar(paper.id);
  pinBtn.style.display = canPin ? '' : 'none';
  if (canPin) {
    const refreshPinLabel = () => {
      pinBtn.textContent = isPinned(paper.id) ? '★ UNPIN STAR' : '☆ PIN AS STAR';
    };
    refreshPinLabel();
    pinBtn.onclick = () => { togglePinned(paper.id); refreshPinLabel(); };
  }

  _renderLinks(paper);
  _loadAbstract(paper);
  _loadSimilar(paper);

  const esWrap = document.getElementById('detail-es-wrap');
  esWrap.style.display = USE_BACKEND ? '' : 'none';
  if (USE_BACKEND) {
    document.getElementById('elastic-query').textContent =
`GET /knowledge_galaxy/_search
{
  "knn": {
    "field": "embedding",
    "query_vector": [...],
    "k": 6,
    "num_candidates": 50
  }
}`;
  }

  document.getElementById('detail-panel').classList.add('open');
  window.dispatchEvent(new CustomEvent('detail:opened', { detail: paper }));
}

export function closeDetail() {
  _current = null;
  setSelected(null);
  document.getElementById('detail-panel').classList.remove('open');
  window.dispatchEvent(new CustomEvent('detail:closed'));
}

// ── Abstract + links (OpenAlex) ───────────────────────────────────────────────

function _renderLinks(paper) {
  const links = [
    ['Google Scholar', scholarUrl(paper.title || '')],
    isOpenAlexId(paper.id) && ['OpenAlex', paper.id],
    paper.doi && ['DOI', paper.doi],
    paper.pdfUrl ? ['PDF', paper.pdfUrl] : paper.oaUrl && ['Free copy', paper.oaUrl],
  ].filter(link => link && /^https?:\/\//.test(link[1]));
  document.getElementById('detail-links').innerHTML = links.map(([label, url]) =>
    `<a class="detail-link" href="${_escAttr(url)}" target="_blank" rel="noopener noreferrer">${_escHtml(label)} ↗</a>`
  ).join('');
}

async function _loadAbstract(paper) {
  const box = document.getElementById('detail-abstract');
  if (paper.abstract) { box.textContent = paper.abstract; return; }
  if (!isOpenAlexId(paper.id)) { box.textContent = 'No abstract available.'; return; }

  box.textContent = 'Fetching abstract from OpenAlex…';
  try {
    const full = await getWork(paper.id);
    if (_current !== paper) return;
    Object.assign(paper, {
      abstract: full.abstract, doi: full.doi, venue: paper.venue || full.venue,
      pdfUrl: full.pdfUrl, oaUrl: full.oaUrl,
    });
    box.textContent = full.abstract || 'OpenAlex has no abstract for this paper.';
    document.getElementById('detail-venue').textContent = paper.venue || '';
    _renderLinks(paper);
  } catch (e) {
    if (_current === paper) box.textContent = `Couldn't load the abstract (${e.message}).`;
  }
}

// ── Nearby papers ─────────────────────────────────────────────────────────────

function _loadSimilar(paper) {
  const container = document.getElementById('detail-similar');
  const similar = nearestStars(paper.id, 5);

  if (!similar.length) {
    container.innerHTML = '<div class="detail-empty">No nearby papers.</div>';
    return;
  }

  container.innerHTML = similar.map(s => `
    <div class="similar-item" data-id="${_escAttr(String(s.id))}">
      <div class="similar-title">${_escHtml(s.title || '-')}</div>
      <div class="similar-meta">${_escHtml((s.authors||'').split(',')[0])} · ${s.year || ''} · ${(s.cite || 0).toLocaleString()} cites</div>
    </div>
  `).join('');

  container.querySelectorAll('.similar-item').forEach(el => {
    el.addEventListener('click', () => {
      const found = _byId.get(el.dataset.id);
      if (!found) return;
      showDetail(found);
      const pos = getRemappedPos(found.id);
      if (pos) flyTo(pos);
    });
  });
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
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;');
}
