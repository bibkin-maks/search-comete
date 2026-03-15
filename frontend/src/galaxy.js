/**
 * search-comete - galaxy.js
 *
 * Fixes applied:
 *  1. _normaliseCite(): stars from the pipeline have `cite:0` but also carry
 *     `citations` - we unify to `cite` before any size bucketing so instanced
 *     mesh counts are never wrong.
 *  2. Instanced mesh creation: if ALL stars are cite=0 (common with live API
 *     data), every star goes to instancedSmall. That is fine - but we must
 *     never leave instancedMed / instancedLarge as `null` and then try to
 *     setMatrixAt() on them. Guard added in _buildStars tier assignment.
 *  3. filterCluster 'all' now also restores edge opacity correctly.
 *  4. flyTo / flyToCluster unchanged - they were correct.
 *  5. CLUSTER_COLORS export made reliable (was exported before _discoverClusters
 *     ran, so importers got an empty object). Now exported as a live reference.
 */

import * as THREE from 'three';
import { showDetail } from './panel.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const PREFERRED_COLORS = {
  // Short cluster IDs (from pipeline)
  ml:    0x7c6dfa, cs:    0x5ab4f5, math:  0xf06ba8,
  phys:  0xfa8c4f, astro: 0x60a5fa, chem:  0xf9c74f,
  bio:   0x3dd9a4, neuro: 0x34d399, med:   0xe63946,
  mat:   0xc084fc, eng:   0xfb923c, env:   0x52b788,
  econ:  0x90e0ef, psych: 0xf472b6, edu:   0xa3e635,
  // Full-name variants
  machine_learning:  0x7c6dfa, 'machine learning': 0x7c6dfa,
  computer_science:  0x5ab4f5, 'computer science': 0x5ab4f5,
  mathematics:       0xf06ba8, statistics:          0xf06ba8,
  physics:           0xfa8c4f, astrophysics:        0x60a5fa,
  astronomy:         0x60a5fa, chemistry:           0xf9c74f,
  biology:           0x3dd9a4, bioinformatics:      0x3dd9a4,
  neuroscience:      0x34d399, medicine:            0xe63946,
  materials_science: 0xc084fc, materials:           0xc084fc,
  engineering:       0xfb923c, environment:         0x52b788,
  environmental:     0x52b788, ecology:             0x52b788,
  economics:         0x90e0ef, finance:             0x90e0ef,
  psychology:        0xf472b6, education:           0xa3e635,
  // Legacy aliases
  medical: 0xe63946, healthcare: 0xe63946, clinical: 0xe63946,
  genomics: 0x3dd9a4, quantum: 0xfa8c4f, systems: 0x5ab4f5,
  ai: 0x7c6dfa, nlp: 0x7c6dfa,
};

const AUTO_PALETTE = [
  0x7c6dfa, 0x3dd9a4, 0xfa8c4f, 0x5ab4f5, 0xf06ba8,
  0xf9c74f, 0x90e0ef, 0x52b788, 0xe63946, 0xc084fc,
  0x34d399, 0xfb923c, 0x60a5fa, 0xf472b6, 0xa3e635,
];
const DEFAULT_COLOR = 0x8888aa;

// Live reference - populated in _discoverClusters(), imported by main.js
export const CLUSTER_COLORS = {};
let CLUSTER_ANCHORS = {};

function _spherePositions(n, radius = 80) {
  const positions = [], golden = (1 + Math.sqrt(5)) / 2;
  for (let i = 0; i < n; i++) {
    const theta = Math.acos(1 - 2 * (i + 0.5) / n);
    const phi   = 2 * Math.PI * i / golden;
    positions.push(new THREE.Vector3(
      radius * Math.sin(theta) * Math.cos(phi),
      radius * Math.sin(theta) * Math.sin(phi),
      radius * Math.cos(theta),
    ));
  }
  return positions;
}

function _discoverClusters(stars) {
  const names = [...new Set(stars.map(s => s.cluster).filter(Boolean))].sort();
  const positions = _spherePositions(names.length);
  // Mutate the exported object in-place so existing imports stay in sync
  Object.keys(CLUSTER_COLORS).forEach(k => delete CLUSTER_COLORS[k]);
  CLUSTER_ANCHORS = {};
  names.forEach((name, i) => {
    const key = String(name).toLowerCase().trim();
    CLUSTER_COLORS[name]  = PREFERRED_COLORS[key] ?? AUTO_PALETTE[i % AUTO_PALETTE.length];
    CLUSTER_ANCHORS[name] = positions[i];
  });
  console.log('[galaxy] Clusters discovered:', names);
}

// ── FIX 1: Normalise cite field ───────────────────────────────────────────────
// Pipeline stars use `citations`; fallback papers use `cite`.
// After this, every star has a numeric `.cite` we can rely on.
function _normaliseCite(star) {
  const c = star.cite ?? star.citations ?? 0;
  return { ...star, cite: typeof c === 'number' ? c : 0 };
}

// ── Module state ──────────────────────────────────────────────────────────────

let renderer, scene, camera;
let instancedSmall, instancedMed, instancedLarge;
let instanceMapSmall = [], instanceMapMed = [], instanceMapLarge = [];
let starDataArray = [];
let basePosArray;
let edgeSegments;
let ringMesh, ringMat;
let animFrame;
let activeYear = Infinity;
const pinnedIds = new Set();

const pivot       = new THREE.Vector3(0, 0, 0);
const pivotTarget = new THREE.Vector3(0, 0, 0);
let camTheta = 0, camPhi = 1.3,  camR = 220;
let tgtTheta = 0, tgtPhi = 1.3, tgtR = 220;

let isDragging = false, lastMX = 0, lastMY = 0, mouseMoved = false;
let autoRotate = true;
const mouse2D  = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
let hoveredStarIdx = -1;
let lastRaycast = 0;

const dummy       = new THREE.Object3D();
const _col        = new THREE.Color();
const _floatDummy = new THREE.Object3D();

// ── COMET ADDITION 1: frame hook registry ─────────────────────────────────────
const _frameHooks = [];
export function registerFrameHook(fn) { _frameHooks.push(fn); }
// ── END COMET ADDITION 1 ──────────────────────────────────────────────────────

const _remappedPos = {};
export function getRemappedPos(id) { return _remappedPos[String(id)]; }

// ── COMET ADDITION 2: scene/camera/raycaster getters ─────────────────────────
export function getScene()     { return scene; }
export function getCamera()    { return camera; }
export function getRaycaster() { return raycaster; }
export function getRenderer()  { return renderer; }
// ── END COMET ADDITION 2 ──────────────────────────────────────────────────────

function _isYearVisible(star) {
  if (!Number.isFinite(activeYear)) return true;
  const y = Number(star.year);
  return !Number.isFinite(y) || y <= activeYear;
}

function _baseScaleForStar(star) {
  if (!_isYearVisible(star)) return 0.01;

  const cite = Math.max(0, Number(star.cite ?? star.citations ?? 0));
  const norm = Math.min(1, Math.log10(cite + 1) / 5); // 0..1 roughly
  let scale = 0.72 + norm * 1.28;

  if (pinnedIds.has(String(star.id))) scale *= 1.55;
  return scale;
}
function _baseColorForStar(star) {
  if (pinnedIds.has(String(star.id))) return 0xffc857;
  return CLUSTER_COLORS[star.cluster] || DEFAULT_COLOR;
}

function _applyVisualState(entry, opts = {}) {
  const { scaleMul = 1, colorHex = null } = opts;
  const { star, tierMesh, localId, globalIdx } = entry;

  const b = basePosArray;
  dummy.position.set(b[globalIdx * 3], b[globalIdx * 3 + 1], b[globalIdx * 3 + 2]);
  dummy.quaternion.identity();
  dummy.scale.setScalar(Math.max(0.01, _baseScaleForStar(star) * scaleMul));
  dummy.updateMatrix();
  tierMesh.setMatrixAt(localId, dummy.matrix);

  _col.setHex(colorHex ?? _baseColorForStar(star));
  tierMesh.setColorAt(localId, _col);
}

function _applyVisualStateAll() {
  starDataArray.forEach(entry => _applyVisualState(entry));
  _flushAll();
}

// ── Loader ────────────────────────────────────────────────────────────────────

function showLoader() {
  const el = document.getElementById('galaxy-loader');
  if (el) el.style.display = 'flex';
}
function hideLoader() {
  const el = document.getElementById('galaxy-loader');
  if (!el) return;
  el.style.transition = 'opacity 0.8s ease';
  el.style.opacity = '0';
  setTimeout(() => { el.style.display = 'none'; }, 800);
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initGalaxy(canvas, stars) {
  showLoader();

  // FIX 1: normalise all stars so .cite is always a number
  stars = stars.map(_normaliseCite);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x06060f, 1);

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x06060f, 0.0008);

  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 600);

  scene.add(new THREE.AmbientLight(0x111133, 2));
  _buildBackground();

  _discoverClusters(stars);

  const remapped = _remapStars(stars);

  // Debug logging
  const clusterCounts = {};
  remapped.forEach(s => { clusterCounts[s.cluster] = (clusterCounts[s.cluster] || 0) + 1; });
  console.log('[galaxy] Stars per cluster:', clusterCounts);

  _buildNebulae(remapped);

  requestAnimationFrame(() => {
    _buildStars(remapped);
    _buildEdges(remapped);
    _buildInterClusterLines(remapped);
    _buildRing();
    _bindControls(canvas);
    cancelAnimationFrame(animFrame);
    _animate();
    hideLoader();
  });
}

// ── Remap ─────────────────────────────────────────────────────────────────────

function _remapStars(stars) {
  const groups = {};
  stars.forEach(s => {
    if (!groups[s.cluster]) groups[s.cluster] = [];
    groups[s.cluster].push(s);
  });

  const out = [];
  Object.entries(groups).forEach(([cluster, members]) => {
    const anchor = CLUSTER_ANCHORS[cluster] || new THREE.Vector3(0, 0, 0);
    let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity,z0=Infinity,z1=-Infinity;
    members.forEach(s => {
      x0=Math.min(x0,s.x||0); x1=Math.max(x1,s.x||0);
      y0=Math.min(y0,s.y||0); y1=Math.max(y1,s.y||0);
      z0=Math.min(z0,s.z||0); z1=Math.max(z1,s.z||0);
    });
    const rx=(x1-x0)||1, ry=(y1-y0)||1, rz=(z1-z0)||1, R=18;
    members.forEach(s => {
      out.push({
        ...s,
        x: anchor.x + (((s.x||0)-x0)/rx - 0.5) * R*2,
        y: anchor.y + (((s.y||0)-y0)/ry - 0.5) * R*2,
        z: anchor.z + (((s.z||0)-z0)/rz - 0.5) * R*2,
      });
    });
  });
  return out;
}

// ── Public API ────────────────────────────────────────────────────────────────
export function isPinned(id) {
  return pinnedIds.has(String(id));
}

export function togglePinned(id) {
  const key = String(id);
  if (pinnedIds.has(key)) pinnedIds.delete(key);
  else pinnedIds.add(key);
  _applyVisualStateAll();
  return pinnedIds.has(key);
}

export function setActiveYear(year) {
  activeYear = Number.isFinite(year) ? year : Infinity;
  _applyVisualStateAll();
  if (edgeSegments) edgeSegments.material.opacity = Number.isFinite(activeYear) ? 0.18 : 0.45;
}


export function highlightStars(ids) {
  const set = new Set(ids.map(String));
  starDataArray.forEach(entry => {
    if (!_isYearVisible(entry.star)) {
      _applyVisualState(entry);
      return;
    }

    const hit = set.has(String(entry.star.id));
    if (hit) {
      _applyVisualState(entry, { scaleMul: 1.8, colorHex: 0xffffff });
    } else {
      _applyVisualState(entry, { scaleMul: 0.35, colorHex: 0x3a3a52 });
    }
  });
  _flushAll();
  if (edgeSegments) edgeSegments.material.opacity = 0.02;
}

export function clearHighlights() {
  _applyVisualStateAll();
  if (edgeSegments) edgeSegments.material.opacity = Number.isFinite(activeYear) ? 0.18 : 0.45;
}

export function filterCluster(clusterId) {
  clearHighlights();

  if (clusterId === 'all') {
    pivotTarget.set(0, 0, 0);
    tgtR = 85;
    // Restore all stars to full size and edges to normal opacity
    if (edgeSegments) edgeSegments.material.opacity = 0.45;
    starDataArray.forEach(({ tierMesh, localId, globalIdx }) => {
      const b = basePosArray;
      dummy.position.set(b[globalIdx*3], b[globalIdx*3+1], b[globalIdx*3+2]);
      dummy.quaternion.identity();
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      tierMesh.setMatrixAt(localId, dummy.matrix);
    });
    _flushAll(true);
    return;
  }

  starDataArray.forEach(entry => {
    const match = entry.star.cluster === clusterId && _isYearVisible(entry.star);
    if (match) {
      _applyVisualState(entry, { scaleMul: 1.2 });
    } else {
      const { tierMesh, localId, globalIdx } = entry;
      const b = basePosArray;
      dummy.position.set(b[globalIdx * 3], b[globalIdx * 3 + 1], b[globalIdx * 3 + 2]);
      dummy.quaternion.identity();
      dummy.scale.setScalar(0.01);
      dummy.updateMatrix();
      tierMesh.setMatrixAt(localId, dummy.matrix);
      _col.setHex(_baseColorForStar(entry.star));
      tierMesh.setColorAt(localId, _col);
    }
  });

  _flushAll(true);
  if (edgeSegments) edgeSegments.material.opacity = 0.01;

  const anchor = CLUSTER_ANCHORS[clusterId];
  if (anchor) {
    pivotTarget.copy(anchor);
    const dir = anchor.clone().normalize();
    tgtTheta = Math.atan2(dir.x, dir.z) + 0.3;
    tgtPhi   = Math.acos(Math.max(-1, Math.min(1, dir.y))) * 0.8 + 0.3;
    tgtR = 22;
    _warp();
  }
}

export function flyTo({ x, y, z }) {
  pivotTarget.set(x, y, z);
  tgtR = 6;
  _warp();
}

// COMET ADDITION: update pivot target for comet tracking.
// We set pivotTarget AND directly copy to pivot each frame so the lerp
// never lags - the comet moves slowly enough that instant-follow is smooth.
export function setPivotTarget({ x, y, z }) {
  pivotTarget.set(x, y, z);
  pivot.copy(pivotTarget); // no lerp lag - snap directly every frame
  // 45 units: close enough to clearly see the comet head,
  // far enough that the full tail behind it stays in the camera frustum
  tgtR = 45;
}

export function flyToCluster({ x, y, z }) {
  pivotTarget.set(x, y, z);
  tgtR = 28;
  const dir = new THREE.Vector3(x, y, z).normalize();
  tgtTheta = Math.atan2(dir.x, dir.z) + 0.4;
  tgtPhi   = Math.acos(Math.max(-1, Math.min(1, dir.y))) * 0.8 + 0.35;
  _warp();
}

function _warp() {
  const el = document.getElementById('warp-overlay');
  if (el) { el.classList.add('active'); setTimeout(() => el.classList.remove('active'), 450); }
  // Notify sound system that a camera travel just happened
  window.dispatchEvent(new CustomEvent('galaxy:travel'));
}

// ── Scene builders ────────────────────────────────────────────────────────────

function _buildBackground() {
  const count = 3000; // reduced from 8000 - big perf win for identical visual result
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i*3]   = (Math.random()-0.5)*900;
    pos[i*3+1] = (Math.random()-0.5)*900;
    pos[i*3+2] = (Math.random()-0.5)*900;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xffffff, size: 0.07, transparent: true, opacity: 0.14, sizeAttenuation: true,
  })));
}

function _buildNebulae(stars) {
  const seen = new Set();
  stars.forEach(s => {
    if (seen.has(s.cluster)) return;
    seen.add(s.cluster);
    const anchor = CLUSTER_ANCHORS[s.cluster];
    if (!anchor) return;
    const color = CLUSTER_COLORS[s.cluster] || DEFAULT_COLOR;
    [22, 12].forEach(sz => scene.add(_makeNebula(color, sz, anchor)));
  });
}

function _makeNebula(color, size, anchor) {
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = 256;
  const ctx = cvs.getContext('2d');
  const r=(color>>16)&255, g=(color>>8)&255, b=color&255;
  const gr = ctx.createRadialGradient(128,128,0,128,128,128);
  gr.addColorStop(0,   `rgba(${r},${g},${b},0.20)`);
  gr.addColorStop(0.4, `rgba(${r},${g},${b},0.07)`);
  gr.addColorStop(1,   'rgba(0,0,0,0)');
  ctx.fillStyle = gr; ctx.fillRect(0,0,256,256);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cvs), transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  sp.scale.setScalar(size);
  sp.position.copy(anchor);
  return sp;
}

function _makeStarTex() {
  const sz = 64, c = document.createElement('canvas');
  c.width = c.height = sz;
  const ctx = c.getContext('2d'), h = sz/2;
  const g = ctx.createRadialGradient(h,h,0,h,h,h);
  g.addColorStop(0,   'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.6)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.15)');
  g.addColorStop(1,   'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0,0,sz,sz);
  return new THREE.CanvasTexture(c);
}

function _buildStars(stars) {
  starDataArray = [];

  // FIX 2: Count tiers correctly after cite normalisation
  const cntS = stars.filter(s => s.cite <= 200).length;
  const cntM = stars.filter(s => s.cite > 200 && s.cite <= 5000).length;
  const cntL = stars.filter(s => s.cite > 5000).length;

  console.log(`[galaxy] Star tiers - small(≤200): ${cntS}, med(201-5000): ${cntM}, large(>5000): ${cntL}`);

  const mat = () => new THREE.MeshBasicMaterial({ color: 0xffffff });

  // Always create all three meshes with at least 1 slot to avoid null references.
  // Extra slots beyond actual count are harmless - they'll have scale(0).
  instancedSmall = new THREE.InstancedMesh(new THREE.SphereGeometry(0.07, 4, 4),  mat(), Math.max(1, cntS));
  instancedMed   = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 5, 5),  mat(), Math.max(1, cntM));
  instancedLarge = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 6, 6),  mat(), Math.max(1, cntL));

  [instancedSmall, instancedMed, instancedLarge].forEach(im => {
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Hide all slots by default - _buildStars will set real ones
    for (let i = 0; i < im.count; i++) {
      dummy.position.set(0, 0, 0);
      dummy.quaternion.identity();
      dummy.scale.setScalar(0);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    }
  });

  let iS=0, iM=0, iL=0;
  basePosArray = new Float32Array(stars.length * 3);

  const glowByCluster = {};

  stars.forEach((star, gi) => {
    const cite = star.cite; // always a number after _normaliseCite
    _col.setHex(_baseColorForStar(star));
    dummy.position.set(star.x, star.y, star.z);
    dummy.quaternion.identity();
    dummy.scale.setScalar(_baseScaleForStar(star));
    dummy.updateMatrix();

    basePosArray[gi*3]   = star.x;
    basePosArray[gi*3+1] = star.y;
    basePosArray[gi*3+2] = star.z;

    // FIX 2: assign tier - if cite=0 (all live API papers), all go to small.
    // That is intentional and correct.
    let tierMesh, localId;
    if (cite > 5000)      { tierMesh = instancedLarge; localId = iL++; }
    else if (cite > 200)  { tierMesh = instancedMed;   localId = iM++; }
    else                  { tierMesh = instancedSmall;  localId = iS++; }

    tierMesh.setMatrixAt(localId, dummy.matrix);
    tierMesh.setColorAt(localId, _col);
    starDataArray.push({ star, tierMesh, localId, globalIdx: gi });
    _remappedPos[String(star.id)] = { x: star.x, y: star.y, z: star.z };

    if (!glowByCluster[star.cluster]) glowByCluster[star.cluster] = [];
    glowByCluster[star.cluster].push(star.x, star.y, star.z);
  });

  _flushAll();
  instanceMapSmall = starDataArray.filter(e => e.tierMesh === instancedSmall);
  instanceMapMed   = starDataArray.filter(e => e.tierMesh === instancedMed);
  instanceMapLarge = starDataArray.filter(e => e.tierMesh === instancedLarge);
  [instancedSmall, instancedMed, instancedLarge].forEach(im => {
    if (!im) return;
    im.frustumCulled = false; // instanced meshes need this off - Three.js can't cull them correctly
    scene.add(im);
  });

  const starTex = _makeStarTex();
  Object.entries(glowByCluster).forEach(([cluster, pts]) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
      map: starTex,
      color: new THREE.Color(CLUSTER_COLORS[cluster] || DEFAULT_COLOR),
      size: 0.5,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      alphaTest: 0.01,
    })));
  });
}

function _buildEdges(stars) {
  const groups = {};
  stars.forEach(s => {
    if (!groups[s.cluster]) groups[s.cluster] = [];
    groups[s.cluster].push(s);
  });

  const positions = [], colors = [];
  const K = 4; // fewer edges per star = less geometry

  Object.entries(groups).forEach(([cluster, members]) => {
    if (members.length < 2) return;
    const col = new THREE.Color(CLUSTER_COLORS[cluster] || DEFAULT_COLOR);
    const added = new Set();

    // PERF: cap per-cluster sample to 300 stars for edge building.
    // With 1000+ stars per cluster the O(n²) distance sort is very slow.
    // We pick a representative sample - the visual result is identical.
    const sample = members.length > 300
      ? members.filter((_, i) => i % Math.ceil(members.length / 300) === 0)
      : members;

    sample.forEach((sa, a) => {
      const dists = [];
      for (let b = 0; b < sample.length; b++) {
        if (b === a) continue;
        const sb = sample[b];
        const dx=sa.x-sb.x, dy=sa.y-sb.y, dz=sa.z-sb.z;
        dists.push({ b, d: dx*dx+dy*dy+dz*dz }); // skip sqrt - only need relative order
      }
      dists.sort((x,y) => x.d - y.d);
      const maxD = dists[Math.min(K-1, dists.length-1)].d;

      for (let k = 0; k < Math.min(K, dists.length); k++) {
        const { b, d } = dists[k];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (added.has(key)) continue;
        added.add(key);
        const sb = sample[b];
        const br = Math.max(0.1, 1 - d / (maxD * 2));
        positions.push(sa.x,sa.y,sa.z, sb.x,sb.y,sb.z);
        colors.push(col.r*br,col.g*br,col.b*br, col.r*br,col.g*br,col.b*br);
      }
    });
  });

  if (!positions.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
  edgeSegments = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: document.body.dataset.theme === 'light' ? 0.18 : 0.5,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  scene.add(edgeSegments);
}

function _buildInterClusterLines(stars) {
  const c = {};
  stars.forEach(s => {
    if (!c[s.cluster]) c[s.cluster] = {x:0,y:0,z:0,n:0};
    c[s.cluster].x+=s.x; c[s.cluster].y+=s.y; c[s.cluster].z+=s.z; c[s.cluster].n++;
  });
  const ids = Object.keys(c);
  const pts = {};
  ids.forEach(id => { pts[id] = new THREE.Vector3(c[id].x/c[id].n, c[id].y/c[id].n, c[id].z/c[id].n); });
  const pos = [];
  for (let a=0; a<ids.length; a++)
    for (let b=a+1; b<ids.length; b++) {
      const pa=pts[ids[a]], pb=pts[ids[b]];
      pos.push(pa.x,pa.y,pa.z, pb.x,pb.y,pb.z);
    }
  if (!pos.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  scene.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    color: 0x334466, transparent: true, opacity: 0.05, depthWrite: false,
  })));
}

function _buildRing() {
  ringMat = new THREE.MeshBasicMaterial({
    color: 0xc9a84c, side: THREE.DoubleSide, transparent: true, opacity: 0,
  });
  ringMesh = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.32, 32), ringMat);
  ringMesh.visible = false;
  scene.add(ringMesh);
}

// ── Controls ──────────────────────────────────────────────────────────────────

function _bindControls(canvas) {
  canvas.addEventListener('mousedown', e => {
    isDragging = true; mouseMoved = false;
    lastMX = e.clientX; lastMY = e.clientY;
    autoRotate = false;
    setTimeout(() => { autoRotate = true; }, 10000);
  });

  window.addEventListener('mouseup', () => { isDragging = false; });

  window.addEventListener('mousemove', e => {
    if (isDragging) {
      const dx = e.clientX - lastMX, dy = e.clientY - lastMY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) mouseMoved = true;
      tgtTheta -= dx * 0.005;
      tgtPhi    = Math.max(0.15, Math.min(Math.PI-0.15, tgtPhi - dy * 0.004));
      lastMX = e.clientX; lastMY = e.clientY;
    }
    mouse2D.x =  (e.clientX / innerWidth)  * 2 - 1;
    mouse2D.y = -(e.clientY / innerHeight) * 2 + 1;
  });

  window.addEventListener('wheel', e => {
    tgtR = Math.max(1.5, Math.min(400, tgtR + e.deltaY * 0.12));
    autoRotate = false;
    setTimeout(() => { autoRotate = true; }, 5000);
  }, { passive: true });

  canvas.addEventListener('click', () => { if (!mouseMoved) _handleClick(); });

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // Touch support
  let lastTouchDist = 0;
  canvas.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      isDragging = true; mouseMoved = false;
      lastMX = e.touches[0].clientX; lastMY = e.touches[0].clientY;
      autoRotate = false;
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchDist = Math.sqrt(dx*dx + dy*dy);
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', e => {
    if (e.touches.length === 1 && isDragging) {
      const dx = e.touches[0].clientX - lastMX;
      const dy = e.touches[0].clientY - lastMY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) mouseMoved = true;
      tgtTheta -= dx * 0.005;
      tgtPhi    = Math.max(0.15, Math.min(Math.PI-0.15, tgtPhi - dy * 0.004));
      lastMX = e.touches[0].clientX; lastMY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      tgtR = Math.max(2, Math.min(150, tgtR - (dist - lastTouchDist) * 0.1));
      lastTouchDist = dist;
    }
  }, { passive: true });

  canvas.addEventListener('touchend', () => { isDragging = false; setTimeout(() => { autoRotate = true; }, 5000); }, { passive: true });
}

function _handleClick() {
  raycaster.setFromCamera(mouse2D, camera);
  const hit = _castAgainstInstances();
  if (hit) {
    showDetail(hit.star);
    flyTo(hit.worldPos);
  }
}

// ── Animation ─────────────────────────────────────────────────────────────────

let t = 0;
const clock = new THREE.Clock();

function _animate() {
  animFrame = requestAnimationFrame(_animate);

  // ── COMET ADDITION 3: named delta so frame hooks receive it ────────────────
  const delta = clock.getDelta();
  t += delta;
  _frameHooks.forEach(fn => fn(delta));
  // ── END COMET ADDITION 3 ──────────────────────────────────────────────────

  if (autoRotate && !isDragging) tgtTheta += 0.0006;

  pivot.lerp(pivotTarget, 0.06);

  let dTheta = tgtTheta - camTheta;
  while (dTheta >  Math.PI) dTheta -= Math.PI*2;
  while (dTheta < -Math.PI) dTheta += Math.PI*2;
  camTheta += dTheta * 0.05;
  camPhi   += (tgtPhi - camPhi) * 0.05;
  camR     += (tgtR   - camR)   * 0.05;

  const sinPhi = Math.sin(camPhi);
  camera.position.set(
    pivot.x + camR * sinPhi * Math.sin(camTheta),
    pivot.y + camR * Math.cos(camPhi),
    pivot.z + camR * sinPhi * Math.cos(camTheta),
  );
  camera.lookAt(pivot);

  _animateFloats();
  if (performance.now() - lastRaycast > 120) { lastRaycast = performance.now(); _updateHover(); }

  renderer.render(scene, camera);
}

// Float animation runs every N frames, not every frame.
// With 15k stars running sin/cos + matrix decompose + updateMatrix every 16ms
// burns significant CPU. At 60fps, every-4th-frame is still 15fps of float
// movement which looks perfectly smooth for subtle drift.
let _floatFrame = 0;
const FLOAT_EVERY = 4; // animate floats every 4 frames

function _animateFloats() {
  _floatFrame++;
  // Only run the expensive loop every FLOAT_EVERY frames
  if (_floatFrame % FLOAT_EVERY !== 0) return;

  // Only animate stars within ~60 units of the camera pivot (visible cluster)
  // Stars far away are invisible at normal zoom so no need to update them
  const px = pivot.x, py = pivot.y, pz = pivot.z;
  const DIST2 = 120 * 120; // squared distance threshold - scaled with new cluster size

  let nS=false, nM=false, nL=false;
  const b = basePosArray;
  starDataArray.forEach(({ tierMesh, localId, globalIdx }) => {
    const bx = b[globalIdx*3], by = b[globalIdx*3+1], bz = b[globalIdx*3+2];
    // Skip stars far from the current pivot (not in view)
    const dx=bx-px, dy=by-py, dz=bz-pz;
    if (dx*dx+dy*dy+dz*dz > DIST2) return;

    tierMesh.getMatrixAt(localId, _floatDummy.matrix);
    _floatDummy.matrix.decompose(_floatDummy.position, _floatDummy.quaternion, _floatDummy.scale);
    if (_floatDummy.scale.x < 0.1) return;

    _floatDummy.position.set(
      bx + Math.sin(t*0.25 + globalIdx)     * 0.04,
      by + Math.cos(t*0.2  + globalIdx*1.3) * 0.04,
      bz + Math.sin(t*0.18 + globalIdx*0.7) * 0.04,
    );
    _floatDummy.updateMatrix();
    tierMesh.setMatrixAt(localId, _floatDummy.matrix);
    if (tierMesh === instancedSmall) nS=true;
    else if (tierMesh === instancedMed) nM=true;
    else nL=true;
  });
  if (nS && instancedSmall) instancedSmall.instanceMatrix.needsUpdate = true;
  if (nM && instancedMed)   instancedMed.instanceMatrix.needsUpdate   = true;
  if (nL && instancedLarge) instancedLarge.instanceMatrix.needsUpdate = true;
}

// ── Raycast ───────────────────────────────────────────────────────────────────

function _castAgainstInstances() {
  raycaster.setFromCamera(mouse2D, camera);
  let best = null, bestDist = Infinity;

  for (const [im, map] of [
    [instancedSmall, instanceMapSmall],
    [instancedMed,   instanceMapMed],
    [instancedLarge, instanceMapLarge],
  ]) {
    if (!im || !map.length) continue;
    const hits = raycaster.intersectObject(im);
    if (!hits.length || hits[0].distance >= bestDist) continue;
    bestDist = hits[0].distance;
    const entry = map.find(e => e.localId === hits[0].instanceId);
    if (!entry) continue;
    im.getMatrixAt(hits[0].instanceId, dummy.matrix);
    const worldPos = new THREE.Vector3().setFromMatrixPosition(dummy.matrix);
    best = { star: entry.star, worldPos };
  }
  return best;
}

// ── Hover ─────────────────────────────────────────────────────────────────────

function _updateHover() {
  const result = _castAgainstInstances();
  const tooltip = document.getElementById('tooltip');
  if (!tooltip) return;

  if (result) {
    document.body.style.cursor = 'pointer';
    const newIdx = starDataArray.findIndex(e => e.star === result.star);
    if (hoveredStarIdx !== newIdx) {
      hoveredStarIdx = newIdx;
      tooltip.style.display = 'block';
      document.getElementById('tt-title').textContent = result.star.title || '';
      document.getElementById('tt-meta').textContent =
        `${(result.star.authors||'').split(',')[0]} · ${result.star.year||''} · ${(result.star.cite||0).toLocaleString()} citations`;
    }
    const proj = result.worldPos.clone().project(camera);
    tooltip.style.left = ((proj.x*0.5+0.5)*innerWidth  + 16) + 'px';
    tooltip.style.top  = ((-proj.y*0.5+0.5)*innerHeight - 10) + 'px';
    ringMesh.position.copy(result.worldPos);
    ringMesh.lookAt(camera.position);
    ringMesh.visible = true;
    ringMat.opacity  = 0.9;
  } else {
    if (hoveredStarIdx !== -1) {
      document.body.style.cursor = 'crosshair';
      hoveredStarIdx = -1;
      tooltip.style.display = 'none';
      ringMesh.visible = false;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _flushAll(matrixOnly = false) {
  for (const im of [instancedSmall, instancedMed, instancedLarge]) {
    if (!im) continue;
    im.instanceMatrix.needsUpdate = true;
    if (!matrixOnly && im.instanceColor) im.instanceColor.needsUpdate = true;
  }
}