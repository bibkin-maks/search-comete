/**
 * search-comete - panel.js
 * The dossier: everything about one paper, and the things you can do with it.
 *  - live abstract, links, topics and keywords from OpenAlex
 *  - pin it, or tie a rope to another pinned paper to compare them
 *  - trace its citation web (references or citing papers, 1-3 levels)
 *  - ask the on-device model where to go next
 *  - nearby papers: the closest stars in the map (closeness = similar meaning)
 */

import { flyTo, getRemappedPos, setSelected, nearestStars, hasStar } from './galaxy.js';
import { getLore } from './search.js';
import { getWork, isOpenAlexId, scholarUrl } from './live.js';
import { USE_BACKEND } from './config.js';
import { isPaperPinned, togglePin, getPins, startRope, tieRope, traceWeb, fieldLabel } from './workspace.js';
import { loadMeaning, meaningReady, relatedTopics, belonging } from './meaning.js';
import { icon } from './icons.js';

let _byId = new Map();
export function setCorpus(stars) {
  _byId = new Map(stars.map(s => [String(s.id), s]));
}

let _current = null;   // paper currently shown, guards async updates
let _depth = 2;
const $ = (id) => document.getElementById(id);

const CLUSTER_CSS = {
  ml: '#7c6dfa', cs: '#5ab4f5', math: '#f06ba8', phys: '#fa8c4f', astro: '#60a5fa',
  chem: '#f9c74f', bio: '#3dd9a4', neuro: '#34d399', med: '#e63946', mat: '#c084fc',
  eng: '#fb923c', env: '#52b788', econ: '#90e0ef', psych: '#f472b6', edu: '#a3e635',
};
const _css = (c) => CLUSTER_CSS[(c || '').toLowerCase()] || '#aaaaaa';

// ── Public API ────────────────────────────────────────────────────────────────

export function showDetail(paper) {
  _current = paper;
  setSelected(hasStar(paper.id) ? paper.id : null);
  const css = _css(paper.cluster);

  const badge = $('detail-category');
  badge.textContent = fieldLabel(paper.cluster).toUpperCase() + (paper.live && !hasStar(paper.id) ? ' · LIVE RESULT' : '');
  badge.style.background = _hexToRgba(css, 0.14);
  badge.style.color = css;

  $('detail-title').textContent   = paper.title || '-';
  $('detail-authors').textContent = paper.authors || '-';
  $('detail-year').textContent    = [paper.year, `${(Number(paper.cite) || 0).toLocaleString()} citations`].filter(Boolean).join('  ·  ');
  $('detail-venue').textContent   = paper.venue || '';
  getLore(paper.cluster).then(txt => { if (_current === paper) $('detail-lore').textContent = txt; });

  // Relevance only means something when we came from a search
  const scoreWrap = $('detail-score-wrap');
  scoreWrap.style.display = typeof paper.score === 'number' ? '' : 'none';
  if (typeof paper.score === 'number') {
    $('score-bar').style.width = Math.round(paper.score * 100) + '%';
    $('score-bar').style.background = css;
    $('score-val').textContent = paper.score.toFixed(3);
    $('score-val').style.color = css;
  }

  _renderActions(paper);
  _renderLinks(paper);
  _renderTopics(paper, null);
  _resetAi(paper);
  _renderBelonging(paper);
  _loadDetails(paper);
  _loadSimilar(paper);

  $('trace-refs').onclick  = () => traceWeb(paper, 'refs', _depth);
  $('trace-cited').onclick = () => traceWeb(paper, 'cited', _depth);
  const canTrace = isOpenAlexId(paper.id);
  $('trace-refs').disabled = $('trace-cited').disabled = !canTrace;

  $('detail-es-wrap').style.display = USE_BACKEND ? '' : 'none';
  $('detail-panel').classList.add('open');
  $('detail-panel').scrollTop = 0;
  window.dispatchEvent(new CustomEvent('detail:opened', { detail: paper }));
}

export function closeDetail() {
  _current = null;
  setSelected(null);
  $('detail-panel').classList.remove('open');
  window.dispatchEvent(new CustomEvent('detail:closed'));
}

export function initPanel() {
  $('web-depth').addEventListener('click', e => {
    const b = e.target.closest('button[data-d]');
    if (!b) return;
    _depth = Number(b.dataset.d);
    $('web-depth').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  });
}

// ── Actions: pin / rope ───────────────────────────────────────────────────────

function _renderActions(paper) {
  const pinBtn = $('pin-btn'), ropeBtn = $('rope-btn'), menu = $('rope-menu');
  const refresh = () => {
    const pinned = isPaperPinned(paper.id);
    pinBtn.innerHTML = `${icon.pin} ${pinned ? 'Pinned' : 'Pin'}`;
    pinBtn.classList.toggle('gold', pinned);
  };
  refresh();
  menu.hidden = true;
  pinBtn.onclick = () => { togglePin(paper); refresh(); };

  ropeBtn.onclick = () => {
    if (!menu.hidden) { menu.hidden = true; return; }
    const others = getPins().filter(p => p.id !== String(paper.id));
    menu.innerHTML = (others.length
      ? `<div class="eyebrow" style="padding:4px 6px 6px">Tie a rope to</div>` + others.map(p => `
          <div class="paper-row" data-id="${_escAttr(p.id)}">
            <span class="swatch" style="background:${_css(p.cluster)};color:${_css(p.cluster)}"></span>
            <div class="body"><div class="title">${_escHtml(p.title)}</div><div class="meta">${p.year || '—'} · ${fieldLabel(p.cluster)}</div></div>
          </div>`).join('')
      : `<div class="live-note">Pin at least one other paper first, or pick the other end in the workspace.</div>`)
      + `<div style="padding:6px"><button class="btn ghost" id="rope-pick">${icon.link} Pick in workspace…</button></div>`;
    menu.hidden = false;
    menu.querySelectorAll('.paper-row').forEach(el => el.addEventListener('click', () => {
      if (!isPaperPinned(paper.id)) togglePin(paper);
      menu.hidden = true;
      refresh();
      tieRope(String(paper.id), el.dataset.id);
    }));
    $('rope-pick').onclick = () => { menu.hidden = true; startRope(paper); refresh(); };
  };
}

// ── Abstract, links, topics (OpenAlex) ────────────────────────────────────────

function _renderLinks(paper) {
  const links = [
    ['Google Scholar', scholarUrl(paper.title || '')],
    isOpenAlexId(paper.id) && ['OpenAlex', paper.id],
    paper.doi && ['DOI', paper.doi],
    paper.pdfUrl ? ['PDF', paper.pdfUrl] : paper.oaUrl && ['Free copy', paper.oaUrl],
  ].filter(link => link && /^https?:\/\//.test(link[1]));
  $('detail-links').innerHTML = links.map(([label, url]) =>
    `<a class="detail-link" href="${_escAttr(url)}" target="_blank" rel="noopener noreferrer">${_escHtml(label)} ↗</a>`
  ).join('');
}

async function _loadDetails(paper) {
  const box = $('detail-abstract');
  if (!isOpenAlexId(paper.id)) {
    box.textContent = paper.abstract || 'No abstract available.';
    _renderTopics(paper, []);
    return;
  }
  if (!paper.abstract) box.textContent = 'Fetching abstract from OpenAlex…';
  else box.textContent = paper.abstract;
  try {
    const full = await getWork(paper.id);
    if (_current !== paper) return;
    Object.assign(paper, {
      abstract: paper.abstract || full.abstract, doi: full.doi, venue: paper.venue || full.venue,
      pdfUrl: full.pdfUrl, oaUrl: full.oaUrl, topics: full.topics, keywords: full.keywords,
    });
    box.textContent = paper.abstract || 'OpenAlex has no abstract for this paper.';
    $('detail-venue').textContent = paper.venue || '';
    _renderLinks(paper);
    _renderTopics(paper, [...(full.topics || []), ...(full.keywords || [])]);
  } catch (e) {
    if (_current !== paper) return;
    if (!paper.abstract) box.textContent = `Couldn't load the abstract (${e.message}).`;
    _renderTopics(paper, []);
  }
}

function _renderTopics(paper, list, ai = []) {
  const box = $('detail-topics');
  if (list === null) { box.innerHTML = '<span class="detail-empty">Loading topics…</span>'; return; }
  const seen = new Set();
  const chips = [...list.map(t => [t, false]), ...ai.map(t => [t, true])].filter(([t]) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  box.dataset.base = JSON.stringify(list);
  box.innerHTML = chips.length
    ? chips.map(([t, isAi]) => `<button class="chip${isAi ? ' ai' : ''}" data-q="${_escAttr(t)}">${_escHtml(t)}</button>`).join('')
    : '<span class="detail-empty">No topics listed.</span>';
  box.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('search:run', { detail: c.dataset.q }));
  }));
}

// ── Related topics by meaning (embedding classifier) ──────────────────────────

function _resetAi(paper) {
  const btn = $('ai-topics-btn'), note = $('ai-note'), bar = $('ai-progress');
  bar.hidden = true;
  btn.disabled = false;
  btn.innerHTML = `${icon.sparkle} Related topics by meaning`;
  note.textContent = meaningReady()
    ? 'Matches this paper against all 4,516 OpenAlex research topics by meaning.'
    : 'Matches this paper against all 4,516 OpenAlex research topics by meaning, using a small model (~23 MB) on your device.';
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      if (!meaningReady()) {
        bar.hidden = false;
        await loadMeaning((frac, mb, total) => {
          bar.firstElementChild.style.width = `${Math.round(frac * 100)}%`;
          btn.innerHTML = `${icon.sparkle} Loading ${Math.round(mb)} / ${Math.round(total)} MB`;
        });
        bar.hidden = true;
      }
      if (_current !== paper) return;
      btn.innerHTML = `${icon.sparkle} Matching…`;
      const topics = await relatedTopics(paper, 8);
      if (_current !== paper) return;
      const base = JSON.parse($('detail-topics').dataset.base || '[]');
      _renderTopics(paper, base, topics.map(t => t.name));
      $('detail-topics').querySelectorAll('.chip.ai').forEach((chip, i) => {
        const t = topics.find(x => x.name === chip.dataset.q);
        if (t) chip.title = `${Math.round(t.score * 100)}% match · ${t.field} › ${t.subfield}`;
      });
      note.textContent = 'Dashed chips are the closest OpenAlex topics by meaning (hover for the match). Click any chip to search it.';
      btn.innerHTML = `${icon.sparkle} Match again`;
      if (!hasStar(paper.id)) _renderBelonging(paper);
    } catch (e) {
      note.textContent = `The on-device model couldn't run here (${e.message}).`;
      btn.innerHTML = `${icon.sparkle} Try again`;
    }
    btn.disabled = false;
  };
}

// ── Where it belongs (papers that aren't in the galaxy) ───────────────────────

async function _renderBelonging(paper) {
  const wrap = $('detail-belongs-wrap'), box = $('detail-belongs');
  if (hasStar(paper.id)) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const render = (b) => {
    const color = _css(b.cluster);
    box.innerHTML = `
      <div class="belongs-head"><span class="swatch" style="background:${color};color:${color}"></span>
        <b>${_escHtml(fieldLabel(b.cluster))}</b><span class="belongs-conf">${Math.round(b.confidence * 100)}% of its nearest papers</span></div>
      <div class="meter"><span style="width:${Math.round(b.confidence * 100)}%;background:${color}"></span></div>
      <div class="ai-note">Closest papers in the galaxy, by meaning:</div>
      ${b.neighbours.slice(0, 3).map(n => `
        <div class="similar-item" data-id="${_escAttr(String(n.star.id))}">
          <div class="similar-title">${_escHtml(n.star.title)}</div>
          <div class="similar-meta">${Math.round(n.score * 100)}% similar · ${n.star.year || ''} · ${_escHtml(fieldLabel(n.star.cluster))}</div>
        </div>`).join('')}`;
    box.querySelectorAll('.similar-item').forEach(el => el.addEventListener('click', () => {
      const found = _byId.get(el.dataset.id);
      if (!found) return;
      showDetail(found);
      const pos = getRemappedPos(found.id);
      if (pos) flyTo(pos);
    }));
  };
  if (paper.belongs) return render(paper.belongs);
  if (!meaningReady()) {
    box.innerHTML = `<button class="btn ice" id="belongs-btn">${icon.locate} Work out where it belongs</button>
      <div class="ai-note">Compares it with all 54k galaxy papers by meaning (small on-device model, ~23 MB once).</div>`;
    $('belongs-btn').onclick = async () => {
      $('belongs-btn').disabled = true;
      $('belongs-btn').innerHTML = `${icon.locate} Loading model…`;
      try { await loadMeaning(); } catch (e) { box.innerHTML = `<div class="detail-empty">Couldn't load the model (${_escHtml(e.message)}).</div>`; return; }
      if (_current === paper) _renderBelonging(paper);
    };
    return;
  }
  box.innerHTML = '<div class="detail-empty">Comparing with the galaxy…</div>';
  const b = await belonging(paper).catch(() => null);
  if (_current !== paper) return;
  if (!b) { box.innerHTML = '<div class="detail-empty">Couldn\'t place this paper.</div>'; return; }
  paper.belongs = b;
  render(b);
}

// ── Nearby papers ─────────────────────────────────────────────────────────────

function _loadSimilar(paper) {
  const container = $('detail-similar');
  const similar = nearestStars(paper.id, 5);
  if (!similar.length) {
    container.innerHTML = '<div class="detail-empty">No nearby papers.</div>';
    return;
  }
  container.innerHTML = similar.map(s => `
    <div class="similar-item" data-id="${_escAttr(String(s.id))}">
      <div class="similar-title">${_escHtml(s.title || '-')}</div>
      <div class="similar-meta">${_escHtml((s.authors||'').split(',')[0])} · ${s.year || ''} · ${(s.cite || 0).toLocaleString()} cites</div>
    </div>`).join('');
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
  const clean = String(hex).replace('#', '');
  const r = parseInt(clean.slice(0,2), 16) || 0, g = parseInt(clean.slice(2,4), 16) || 0, b = parseInt(clean.slice(4,6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
}
function _escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _escAttr(str) {
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;');
}
