/**
 * search-comete - hud.js
 * The navigation layer drawn over the 3D scene:
 *  - field labels floating above each field, fading with distance
 *  - the sector readout under the logo ("where am I?")
 *  - the bottom timeline: papers-per-year histogram, scrubbing and playback
 */

import * as THREE from 'three';
import { getCamera, getClusterAnchors, getView, getFocusCluster, CLUSTER_COLORS, setActiveYear } from './galaxy.js';
import { icon } from './icons.js';

const _v = new THREE.Vector3();
const _up = new THREE.Vector3();
let labels = [];      // { id, el, pos: Vector3 }
let counts = {};
let total = 0;
let fieldLabel = (id) => id;

function _hex(id) {
  return '#' + (CLUSTER_COLORS[id] ?? 0x8888aa).toString(16).padStart(6, '0');
}

// ── Field labels ──────────────────────────────────────────────────────────────

export function initLabels(stars, labelFor, onClick) {
  fieldLabel = labelFor;
  counts = {};
  stars.forEach(s => { counts[s.cluster] = (counts[s.cluster] || 0) + 1; });
  total = stars.length;

  const layer = document.getElementById('labels');
  layer.innerHTML = '';
  labels = Object.entries(getClusterAnchors()).map(([id, a]) => {
    const el = document.createElement('div');
    el.className = 'cl-label';
    el.innerHTML = `<div class="name" style="color:${_hex(id)}">${labelFor(id)}</div><div class="n">${(counts[id] || 0).toLocaleString()} papers</div>`;
    el.addEventListener('click', () => onClick(id));
    layer.appendChild(el);
    return { id, el, pos: new THREE.Vector3(a.x, a.y, a.z) };
  });
}

export function updateLabels() {
  const camera = getCamera();
  if (!camera || !labels.length) return;
  _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  const w = innerWidth, h = innerHeight;
  const focus = getFocusCluster();
  const hide = (l) => { l.el.style.opacity = 0; l.el.style.pointerEvents = 'none'; };

  // Project everything first, then place nearest-first so a label hidden
  // behind a nearer one fades instead of printing on top of it
  const placed = [];
  labels
    .map(l => {
      const dist = camera.position.distanceTo(l.pos);
      // Sit just above the field's cloud, in screen-up direction
      _v.copy(l.pos).addScaledVector(_up, 44).project(camera);
      return { l, dist, z: _v.z, x: (_v.x * 0.5 + 0.5) * w, y: (-_v.y * 0.5 + 0.5) * h };
    })
    .sort((a, b) => a.dist - b.dist)
    .forEach(({ l, dist, z, x, y }) => {
      if ((focus && l.id !== focus) || z > 1 || z < -1) return hide(l);
      // Visible from mid range; gone when you're inside the field or very far
      const near = THREE.MathUtils.smoothstep(dist, 60, 110);
      const far = 1 - THREE.MathUtils.smoothstep(dist, 640, 900);
      const edge = Math.min(1, Math.min(x, w - x, y, h - y) / 80);
      const scale = 0.78 + 0.4 * (1 - THREE.MathUtils.smoothstep(dist, 90, 650));
      const box = { x0: x - l.el.offsetWidth * scale / 2, x1: x + l.el.offsetWidth * scale / 2, y0: y - 18, y1: y + 18 };
      const covered = placed.some(b => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
      const o = Math.max(0, near * far * edge) * (covered ? 0.12 : 1);
      if (o > 0.3) placed.push(box);
      l.el.style.opacity = o.toFixed(3);
      l.el.style.pointerEvents = o > 0.3 ? 'auto' : 'none';
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
    });
}

// ── Sector readout ────────────────────────────────────────────────────────────

let _lastSector = '';
export function updateSector() {
  const el = document.getElementById('sector');
  const view = getView();
  if (!el || !view) return;
  let best = null, bestD = Infinity;
  Object.entries(getClusterAnchors()).forEach(([id, a]) => {
    const d = Math.hypot(a.x - view.pivot.x, a.y - view.pivot.y, a.z - view.pivot.z);
    if (d < bestD) { bestD = d; best = id; }
  });
  let html, color = 'var(--faint)';
  if (view.distance > 260) {
    html = `Overview · <b>${Object.keys(counts).length} fields</b> · ${total.toLocaleString()} papers`;
  } else if (best && bestD < 60) {
    color = _hex(best);
    html = `Sector · <b>${fieldLabel(best)}</b> · ${(counts[best] || 0).toLocaleString()} papers`;
  } else {
    html = 'Deep space · <b>between fields</b>';
  }
  const key = html + color;
  if (key === _lastSector) return;
  _lastSector = key;
  el.innerHTML = `<span class="dot" style="background:${color};color:${color}"></span><span>${html}</span>`;
}

// ── Timeline ──────────────────────────────────────────────────────────────────

export function initTimeline(stars) {
  const years = stars.map(s => Number(s.year)).filter(y => y > 0).sort((a, b) => a - b);
  if (!years.length) { document.getElementById('timeline').style.display = 'none'; return; }
  const maxYear = years[years.length - 1];
  // Axis starts at the 1st percentile so a handful of 1800s papers don't
  // squash a century of bars; older papers count into the first bar.
  const minYear = Math.min(years[Math.floor(years.length * 0.01)], maxYear - 20);
  const bins = new Array(maxYear - minYear + 1).fill(0);
  years.forEach(y => { bins[Math.max(0, y - minYear)]++; });
  const cumulative = [];
  bins.reduce((acc, n, i) => (cumulative[i] = acc + n), 0);
  const undated = stars.length - years.length;

  const track  = document.getElementById('tl-track');
  const canvas = document.getElementById('tl-hist');
  const cursor = document.getElementById('tl-cursor');
  const readout = document.getElementById('year-readout');
  const countEl = document.getElementById('year-count');
  const playBtn = document.getElementById('play-btn');
  const slider  = document.getElementById('year-slider');
  document.getElementById('tl-min').textContent = minYear;
  document.getElementById('tl-mid').textContent = Math.round((minYear + maxYear) / 2);
  document.getElementById('tl-max').textContent = maxYear;
  slider.min = minYear; slider.max = maxYear; slider.value = maxYear;
  track.setAttribute('role', 'slider');
  track.setAttribute('tabindex', '0');
  track.setAttribute('aria-label', 'Show papers published up to year');
  track.setAttribute('aria-valuemin', minYear);
  track.setAttribute('aria-valuemax', maxYear);

  let year = maxYear;   // maxYear = all years
  const peak = Math.sqrt(Math.max(...bins));

  const draw = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const light = document.body.classList.contains('light-mode');
    const bw = w / bins.length;
    bins.forEach((n, i) => {
      const bh = Math.max(n ? 1.5 : 0, (Math.sqrt(n) / peak) * (h - 2));
      const on = minYear + i <= year;
      ctx.fillStyle = on ? (light ? 'rgba(138,100,22,0.75)' : 'rgba(227,194,122,0.8)') : (light ? 'rgba(29,26,20,0.12)' : 'rgba(255,255,255,0.1)');
      ctx.fillRect(i * bw + bw * 0.15, h - bh, Math.max(1, bw * 0.7), bh);
    });
  };

  const apply = (y, { fromSlider = false } = {}) => {
    year = Math.max(minYear, Math.min(maxYear, Math.round(y)));
    const all = year >= maxYear;
    setActiveYear(all ? Infinity : year);
    cursor.style.left = `${((year - minYear) / (maxYear - minYear)) * 100}%`;
    readout.textContent = all ? 'All years' : `Up to ${year}`;
    const visible = all ? stars.length : cumulative[year - minYear] + undated;
    countEl.textContent = `${visible.toLocaleString()} papers visible`;
    track.setAttribute('aria-valuenow', year);
    track.setAttribute('aria-valuetext', all ? 'All years' : `Up to ${year}`);
    if (!fromSlider) slider.value = year;
    draw();
  };

  const yearAt = (clientX) => {
    const r = track.getBoundingClientRect();
    return minYear + ((clientX - r.left) / r.width) * (maxYear - minYear);
  };
  let dragging = false;
  track.addEventListener('pointerdown', e => { dragging = true; track.setPointerCapture(e.pointerId); stop(); apply(yearAt(e.clientX)); });
  track.addEventListener('pointermove', e => { if (dragging) apply(yearAt(e.clientX)); });
  track.addEventListener('pointerup', () => { dragging = false; });
  track.addEventListener('dblclick', () => apply(maxYear));
  track.addEventListener('keydown', e => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') { apply(year - step); e.preventDefault(); }
    if (e.key === 'ArrowRight') { apply(year + step); e.preventDefault(); }
    if (e.key === 'Home') apply(minYear);
    if (e.key === 'End') apply(maxYear);
  });
  slider.addEventListener('input', () => apply(Number(slider.value), { fromSlider: true }));

  // Playback: sweep the whole history in ~16 s, then show everything again
  let playTimer = null;
  const setPlayIcon = (playing) => { playBtn.innerHTML = playing ? icon.pause : icon.play; playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play through history'); };
  const stop = () => { if (playTimer) { cancelAnimationFrame(playTimer); playTimer = null; setPlayIcon(false); } };
  playBtn.addEventListener('click', () => {
    if (playTimer) return stop();
    let y = year >= maxYear ? minYear : year;
    let last = performance.now();
    setPlayIcon(true);
    const tick = (now) => {
      y += ((now - last) / 1000) * ((maxYear - minYear) / 16);
      last = now;
      if (y >= maxYear) { apply(maxYear); stop(); return; }
      apply(y);
      playTimer = requestAnimationFrame(tick);
    };
    playTimer = requestAnimationFrame(tick);
  });
  setPlayIcon(false);

  window.addEventListener('resize', draw);
  new MutationObserver(draw).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  apply(maxYear);
}
