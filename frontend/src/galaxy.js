/**
 * search-comete - galaxy.js
 *
 * Three.js scene: camera orbit, the star field, hero orbs, nebulae, edges,
 * hover/click picking and the public API that main.js and panel.js drive.
 *
 * Rendering
 *  - Every paper is one vertex in a single THREE.Points draw call with a
 *    custom sprite shader: hot core, halo, diffraction spikes on the big
 *    papers, and a few star "species" (pulsar, binary, ringed) that show up
 *    when you zoom in.
 *  - Search highlight, the year slider, cluster focus, hover, twinkle and the
 *    idle wobble all happen in the shader via uniforms and small attributes.
 *    Nothing loops over the 54k stars per frame on the CPU any more.
 *  - Papers worth a close look (most cited, clicked, pinned, live visitors)
 *    also get a detailed animated orb from orb.js on top of their sprite.
 */

import * as THREE from 'three';
import { showDetail } from './panel.js';
import { initPostProcessing, resizePostProcessing, updateAndRender, setPostQuality } from './postfx.js';
import { HeroOrbs, ORB_STAR, ORB_BLACK_HOLE, ORB_VISITOR } from './orb.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const PREFERRED_COLORS = {
  ml:    0x7c6dfa, cs:    0x5ab4f5, math:  0xf06ba8,
  phys:  0xfa8c4f, astro: 0x60a5fa, chem:  0xf9c74f,
  bio:   0x3dd9a4, neuro: 0x34d399, med:   0xe63946,
  mat:   0xc084fc, eng:   0xfb923c, env:   0x52b788,
  econ:  0x90e0ef, psych: 0xf472b6, edu:   0xa3e635,
};

const AUTO_PALETTE = [
  0x7c6dfa, 0x3dd9a4, 0xfa8c4f, 0x5ab4f5, 0xf06ba8,
  0xf9c74f, 0x90e0ef, 0x52b788, 0xe63946, 0xc084fc,
  0x34d399, 0xfb923c, 0x60a5fa, 0xf472b6, 0xa3e635,
];
const DEFAULT_COLOR = 0x8888aa;
const PIN_COLOR     = 0xffc857;

const HERO_CITE  = 5000;    // papers above this get a detailed orb
const BH_CITE    = 15000;   // ...and above this they are black holes
const FLAG_HIT    = 1;
const FLAG_PINNED = 2;
const FLAG_BIG    = 4;

// Live reference - populated in _discoverClusters(), imported by main.js
export const CLUSTER_COLORS = {};
let CLUSTER_ANCHORS = {};

// ── Module state ──────────────────────────────────────────────────────────────

let renderer, scene, camera;
let starPoints, starMat;
let heroOrbs;
let diskMesh, diskStars = [];
let edgeSegments;
let ringMesh, ringMat;
let animFrame;

let stars = [];                 // remapped stars, index = vertex index
const idToIndex = new Map();
let basePos, sizeArr, yearArr, clusterArr, flagsArr;
let clusterIds = [];            // index -> cluster id
let clusterMembers = {};        // cluster id -> [star index]
let heroIndices = [];           // stars that always get an orb

let activeYear   = Infinity;
let focusCluster = null;
let highlightOn  = false;
let hitIndices   = [];
let selectedIdx  = -1;
let hoveredIdx   = -1;          // star index, or -(visitorIdx + 2) for visitors
let visitors     = [];          // { paper, x, y, z, rgb, seed }
const pinnedIds  = new Set();

const pivot       = new THREE.Vector3(0, 0, 0);
const pivotTarget = new THREE.Vector3(0, 0, 0);
let camTheta = 0, camPhi = 1.3, camR = 220;
let tgtTheta = 0, tgtPhi = 1.3, tgtR = 220;

let isDragging = false, lastMX = 0, lastMY = 0, mouseMoved = false;
let autoRotate = true;
let autoRotateTimer = null;
const mouse2D   = new THREE.Vector2(-10, -10);
const raycaster = new THREE.Raycaster();
let lastRaycast = 0;
let pointerOnCanvas = false;
let reducedMotion = false;
let detail = 1;                 // shader detail: 1 high, 0.5 medium, 0 low
let lightMode = false;

const dummy = new THREE.Object3D();

window.addEventListener('settings:changed', (e) => {
  const settings = e.detail;
  reducedMotion = !!settings.reducedMotion;
  const quality = settings.quality || 'high';
  detail = quality === 'high' ? 1 : quality === 'medium' ? 0.5 : 0;
  setPostQuality(quality);
  if (renderer) {
    renderer.setPixelRatio(_pixelRatio());
    _onResize();
  }
});

// ── Frame hooks + getters (used by comet.js / main.js) ───────────────────────
const _frameHooks = [];
export function registerFrameHook(fn) { _frameHooks.push(fn); }

export function getScene()     { return scene; }
export function getCamera()    { return camera; }
export function getRaycaster() { return raycaster; }
export function getRenderer()  { return renderer; }

export function getRemappedPos(id) {
  const key = String(id);
  const i = idToIndex.get(key);
  if (i !== undefined) return { x: basePos[i*3], y: basePos[i*3+1], z: basePos[i*3+2] };
  const v = visitors.find(v => String(v.paper.id) === key);
  return v ? { x: v.x, y: v.y, z: v.z } : undefined;
}

export function hasStar(id) { return idToIndex.has(String(id)); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function _pixelRatio() {
  const cap = detail >= 1 ? 1.75 : detail > 0 ? 1.25 : 1;
  return Math.min(devicePixelRatio || 1, cap);
}

// Colours go to the shaders as display (sRGB) values, 0..1
function _rgb(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

function _hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

// Sprite diameter in world units (includes the halo)
function _sizeForCite(cite) {
  const norm = Math.min(1, Math.log10(cite + 1) / 5);
  return 0.24 + norm * 0.62;
}

function _isVisible(i) {
  if (Number.isFinite(activeYear) && yearArr[i] > activeYear) return false;
  if (focusCluster !== null && clusterIds[clusterArr[i]] !== focusCluster) return false;
  return true;
}

// Pixels per world unit at distance 1, in device pixels (matches gl_PointSize)
function _projScale() {
  const h = renderer.getSize(new THREE.Vector2()).y * renderer.getPixelRatio();
  return h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}

function _discoverClusters(list) {
  const names = [...new Set(list.map(s => s.cluster).filter(Boolean))].sort();
  const golden = (1 + Math.sqrt(5)) / 2;
  Object.keys(CLUSTER_COLORS).forEach(k => delete CLUSTER_COLORS[k]);
  CLUSTER_ANCHORS = {};
  names.forEach((name, i) => {
    const theta = Math.acos(1 - 2 * (i + 0.5) / names.length);
    const phi   = 2 * Math.PI * i / golden;
    CLUSTER_COLORS[name]  = PREFERRED_COLORS[String(name).toLowerCase().trim()] ?? AUTO_PALETTE[i % AUTO_PALETTE.length];
    CLUSTER_ANCHORS[name] = new THREE.Vector3(
      80 * Math.sin(theta) * Math.cos(phi),
      80 * Math.sin(theta) * Math.sin(phi),
      80 * Math.cos(theta),
    );
  });
  clusterIds = names;
}

// Each cluster's UMAP box is rescaled into an 36-unit cube around its anchor
function _remapStars(list) {
  const groups = {};
  list.forEach(s => { (groups[s.cluster] ||= []).push(s); });

  const out = [];
  Object.entries(groups).forEach(([cluster, members]) => {
    const anchor = CLUSTER_ANCHORS[cluster] || new THREE.Vector3();
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
        cite: Number(s.cite ?? s.citations ?? 0) || 0,
        x: anchor.x + (((s.x||0)-x0)/rx - 0.5) * R*2,
        y: anchor.y + (((s.y||0)-y0)/ry - 0.5) * R*2,
        z: anchor.z + (((s.z||0)-z0)/rz - 0.5) * R*2,
      });
    });
  });
  return out;
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initGalaxy(canvas, input) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(_pixelRatio());
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x06060f, 1);

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x06060f, 0.0008);
  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 900);

  _discoverClusters(input);
  stars = _remapStars(input);

  _buildBackground();
  _buildNebulae();
  _buildStarField();
  _buildEdges();
  _buildInterClusterLines();
  _buildDisks();
  heroOrbs = new HeroOrbs(scene);
  _syncOrbs();
  _buildRing();
  _bindControls(canvas);
  initPostProcessing(renderer, scene, camera);

  cancelAnimationFrame(animFrame);
  _animate();
}

// ── Star field ────────────────────────────────────────────────────────────────

const STAR_VERT = /* glsl */`
  uniform float uTime;
  uniform float uScale;
  uniform float uYear;
  uniform float uFocus;
  uniform float uHighlight;
  uniform float uMotion;
  uniform float uHover;
  uniform float uSelected;
  attribute vec3  aColor;
  attribute float aSize;
  attribute float aSeed;
  attribute float aYear;
  attribute float aCluster;
  attribute float aFlags;
  attribute float aIndex;
  varying vec3  vColor;
  varying float vSeed;
  varying float vBright;
  varying float vPx;
  varying float vBig;

  void main() {
    bool hidden = aYear > uYear || (uFocus > -0.5 && abs(aCluster - uFocus) > 0.5);
    if (hidden) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }

    float hit    = mod(aFlags, 2.0);
    float pinned = step(1.5, mod(aFlags, 4.0));
    float size   = aSize;
    float bright = 1.0;
    vec3  col    = aColor;

    if (uHighlight > 0.5) {
      if (hit > 0.5) { size *= 1.7; bright = 1.6; col = mix(col, vec3(1.0), 0.3); }
      else           { size *= 0.6; bright = 0.18; }
    }
    if (pinned > 0.5) { col = vec3(1.0, 0.784, 0.341); size *= 1.5; bright = max(bright, 1.3); }
    if (abs(aIndex - uHover) < 0.5 || abs(aIndex - uSelected) < 0.5) { size *= 1.45; bright *= 1.4; }

    // Twinkle + slow wobble (both off with reduced motion)
    bright *= 1.0 - uMotion * 0.2 * (0.5 + 0.5 * sin(uTime * (0.6 + aSeed * 2.4) + aSeed * 91.0));
    vec3 p = position + uMotion * 0.04 * vec3(
      sin(uTime * 0.25 + aSeed * 61.0),
      cos(uTime * 0.20 + aSeed * 83.0),
      sin(uTime * 0.18 + aSeed * 47.0));

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    float px = size * uScale / max(-mv.z, 0.01);
    // Sub-pixel stars keep a 2px sprite but fade, so far clusters shimmer instead of aliasing
    bright *= clamp(px / 2.0, 0.2, 1.0);
    gl_PointSize = clamp(px, 2.0, 160.0);

    vPx     = px;
    vColor  = col;
    vSeed   = aSeed;
    vBright = bright;
    vBig    = step(3.5, mod(aFlags, 8.0));
  }
`;

const STAR_FRAG = /* glsl */`
  uniform float uTime;
  uniform float uDetail;
  uniform float uLight;
  varying vec3  vColor;
  varying float vSeed;
  varying float vBright;
  varying float vPx;
  varying float vBig;

  void main() {
    vec2  uv = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(uv, uv);
    if (r2 > 1.0) discard;
    float r = sqrt(r2);

    // Halos fade as sprites grow on screen, so dense regions don't blow out
    // to white when you fly into them
    float crowd = clamp(7.0 / vPx, 0.15, 1.0);
    float core  = exp(-r2 * 32.0);
    float halo  = (exp(-r2 * 6.0) * 0.42 + exp(-r * 4.5) * 0.12) * crowd;
    float shape = core + halo;

    // Species details only show once a star is big enough on screen
    float zoom = smoothstep(7.0, 18.0, vPx) * uDetail;
    if (zoom > 0.0) {
      float s = vSeed;
      if (s < 0.05) {
        // Pulsar: breathing ring
        float pulse = 0.5 + 0.5 * sin(uTime * 5.0 + s * 300.0);
        shape += exp(-pow((r - 0.5) * 16.0, 2.0)) * 0.7 * pulse * zoom;
      } else if (s < 0.09) {
        // Binary: two cores orbiting each other
        float a = uTime * (0.5 + s * 6.0) + s * 50.0;
        vec2  o = vec2(cos(a), sin(a)) * 0.24;
        float pair = exp(-dot(uv - o, uv - o) * 70.0) + 0.75 * exp(-dot(uv + o, uv + o) * 90.0);
        shape = mix(shape, pair + halo, zoom);
      } else if (s < 0.14) {
        // Ringed: tilted thin ring
        float a = s * 40.0;
        vec2  q = mat2(cos(a), -sin(a), sin(a), cos(a)) * uv;
        q.y *= 3.0;
        shape += exp(-pow((length(q) - 0.62) * 13.0, 2.0)) * 0.55 * zoom;
      }
      if (vBig > 0.5) {
        // Diffraction spikes on the heavily cited papers
        float a = s * 3.14159;
        vec2  q = mat2(cos(a), -sin(a), sin(a), cos(a)) * uv;
        shape += (exp(-abs(q.x) * 55.0) + exp(-abs(q.y) * 55.0)) * (1.0 - r) * 0.65 * zoom;
      }
    }

    // Big sprites get dimmer per pixel: same total light, less white-out in clumps
    float dense = clamp(16.0 / vPx, 0.4, 1.0);
    float alpha = shape * vBright * dense * (1.0 - smoothstep(0.82, 1.0, r));
    vec3  col   = uLight > 0.5
      ? vColor * 0.62
      : mix(vColor, vec3(1.0), clamp(core * 0.65, 0.0, 1.0));
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }
`;

function _buildStarField() {
  const n = stars.length;
  basePos    = new Float32Array(n * 3);
  sizeArr    = new Float32Array(n);
  yearArr    = new Float32Array(n);
  clusterArr = new Uint8Array(n);
  flagsArr   = new Float32Array(n);
  const colors = new Float32Array(n * 3);
  const seeds  = new Float32Array(n);
  const years  = new Float32Array(n);
  const clus   = new Float32Array(n);
  const index  = new Float32Array(n);

  idToIndex.clear();
  clusterMembers = {};
  heroIndices = [];
  const clusterIdx = Object.fromEntries(clusterIds.map((c, i) => [c, i]));

  stars.forEach((s, i) => {
    basePos[i*3] = s.x; basePos[i*3+1] = s.y; basePos[i*3+2] = s.z;
    const seed = _hashSeed(String(s.id));
    const [r, g, b] = _rgb(CLUSTER_COLORS[s.cluster] ?? DEFAULT_COLOR);
    // Slight per-star brightness jitter so clusters don't look flat
    const jitter = 0.85 + seed * 0.3;
    colors[i*3] = Math.min(1, r * jitter); colors[i*3+1] = Math.min(1, g * jitter); colors[i*3+2] = Math.min(1, b * jitter);
    sizeArr[i] = _sizeForCite(s.cite);
    seeds[i]   = seed;
    yearArr[i] = years[i] = Number(s.year) || 0;
    clusterArr[i] = clus[i] = clusterIdx[s.cluster] ?? 0;
    flagsArr[i] = (s.cite > HERO_CITE ? FLAG_BIG : 0) | (pinnedIds.has(String(s.id)) ? FLAG_PINNED : 0);
    index[i] = i;

    idToIndex.set(String(s.id), i);
    (clusterMembers[s.cluster] ||= []).push(i);
    if (s.cite > HERO_CITE) heroIndices.push(i);
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(basePos, 3));
  geo.setAttribute('aColor',   new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSize',    new THREE.BufferAttribute(sizeArr, 1));
  geo.setAttribute('aSeed',    new THREE.BufferAttribute(seeds, 1));
  geo.setAttribute('aYear',    new THREE.BufferAttribute(years, 1));
  geo.setAttribute('aCluster', new THREE.BufferAttribute(clus, 1));
  geo.setAttribute('aFlags',   new THREE.BufferAttribute(flagsArr, 1));
  geo.setAttribute('aIndex',   new THREE.BufferAttribute(index, 1));

  starMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:      { value: 0 },
      uScale:     { value: 1 },
      uYear:      { value: 1e9 },
      uFocus:     { value: -1 },
      uHighlight: { value: 0 },
      uMotion:    { value: 1 },
      uHover:     { value: -1 },
      uSelected:  { value: -1 },
      uDetail:    { value: 1 },
      uLight:     { value: 0 },
    },
    vertexShader:   STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite:  false,
    blending:    THREE.AdditiveBlending,
  });

  starPoints = new THREE.Points(geo, starMat);
  starPoints.frustumCulled = false;
  starPoints.renderOrder = 1;
  scene.add(starPoints);
  console.log(`[galaxy] ${n} stars in one draw call, ${heroIndices.length} hero orbs`);
}

function _flagsChanged() {
  starPoints.geometry.attributes.aFlags.needsUpdate = true;
}

// ── Hero orbs + black hole disks ──────────────────────────────────────────────

function _orbAlpha(i) {
  if (!_isVisible(i)) return 0;
  if (highlightOn && !(flagsArr[i] & FLAG_HIT) && i !== selectedIdx) return 0.12;
  return 1;
}

function _syncOrbs() {
  if (!heroOrbs) return;
  const items = [];
  const seen = new Set();
  const add = (i) => {
    if (i < 0 || seen.has(i)) return;
    seen.add(i);
    const s = stars[i];
    const pinned = !!(flagsArr[i] & FLAG_PINNED);
    const [r, g, b] = _rgb(pinned ? PIN_COLOR : (CLUSTER_COLORS[s.cluster] ?? DEFAULT_COLOR));
    items.push({
      index: i,
      x: basePos[i*3], y: basePos[i*3+1], z: basePos[i*3+2], r, g, b,
      size: sizeArr[i] * 0.55,
      seed: _hashSeed(String(s.id)),
      kind: s.cite > BH_CITE ? ORB_BLACK_HOLE : ORB_STAR,
      alpha: _orbAlpha(i),
    });
  };
  heroIndices.forEach(add);
  pinnedIds.forEach(id => add(idToIndex.get(id) ?? -1));
  // Instances draw in list order with no depth writes, so later = on top.
  // Black holes go last: famous papers sit in tight clumps of other big
  // papers whose orbs would otherwise hide the horizon.
  items.sort((a, b) => (a.kind === ORB_BLACK_HOLE) - (b.kind === ORB_BLACK_HOLE));
  if (selectedIdx >= 0) {
    const k = items.findIndex(o => o.index === selectedIdx);
    if (k >= 0) items.push(items.splice(k, 1)[0]);
    else add(selectedIdx);
  }
  visitors.forEach(v => {
    items.push({ x: v.x, y: v.y, z: v.z, r: v.rgb[0], g: v.rgb[1], b: v.rgb[2],
      size: 0.6, seed: v.seed, kind: ORB_VISITOR, alpha: 1 });
  });
  heroOrbs.set(items);
  _syncDisks();
}

const DISK_V_INJECT = `
  varying vec2 vUvPass;
  varying vec3 vInstanceColorPass;
  varying vec3 vViewPosPass;
  uniform float uLensing;
  uniform float uRS;
`;

const DISK_F_INJECT = `
  varying vec2 vUvPass;
  varying vec3 vInstanceColorPass;
  varying vec3 vViewPosPass;
  uniform float uTime;
  uniform float uRS;
  float d_hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float d_noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    f = f*f*(3.0-2.0*f);
    return mix(mix(d_hash(i), d_hash(i+vec2(1.0,0.0)), f.x), mix(d_hash(i+vec2(0.0,1.0)), d_hash(i+vec2(1.0,1.0)), f.x), f.y);
  }
`;

function _buildDisks() {
  diskStars = stars.map((s, i) => (s.cite > BH_CITE ? i : -1)).filter(i => i >= 0);
  if (!diskStars.length) return;

  const diskMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  diskMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uRS = { value: 0.15 };
    shader.uniforms.uLensing = { value: 1.2 };
    diskMat.userData.shader = shader;

    shader.vertexShader = DISK_V_INJECT + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vUvPass = uv;
       vInstanceColorPass = instanceColor;
       vec4 wPos = instanceMatrix * vec4(position, 1.0);
       vec3 vDir = normalize(cameraPosition - wPos.xyz);
       float rl = length(position.xy);
       float al = dot(normalize(wPos.xyz), vDir);
       if (al < 0.0) {
         float doff = exp(-(rl - uRS) * 0.7);
         transformed.z += al * doff * uLensing;
       }
      `
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
       vViewPosPass = -mvPosition.xyz;
      `
    );

    shader.fragmentShader = DISK_F_INJECT + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
       vec2 dp = vUvPass * 2.0 - 1.0;
       float dr = length(dp) * 10.0;
       float da = atan(dp.y, dp.x);
       float dn = d_noise(vec2(dr * 2.0, da * 1.5 - uTime * 2.0));
       float dlanes = smoothstep(0.0, 1.0, sin(dr * 5.0 + dn * 4.0)) * 0.5 + 0.5;
       vec3 dcol = vInstanceColorPass * (0.4 + dlanes);
       float dalpha = smoothstep(uRS, uRS + 0.5, dr) * (1.0 - smoothstep(8.0, 10.0, dr));
       gl_FragColor = vec4(dcol, dalpha * 0.45);
      `
    );
  };

  diskMesh = new THREE.InstancedMesh(new THREE.RingGeometry(0.2, 2.5, 64, 8), diskMat, diskStars.length);
  diskMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(diskStars.length * 3), 3);
  const col = new THREE.Color();
  diskStars.forEach((i, k) => diskMesh.setColorAt(k, col.setHex(CLUSTER_COLORS[stars[i].cluster] ?? DEFAULT_COLOR)));
  diskMesh.frustumCulled = false;
  scene.add(diskMesh);
}

function _syncDisks() {
  if (!diskMesh) return;
  diskStars.forEach((i, k) => {
    // Each disk gets its own tilt so they don't all lie in one plane
    const seed = _hashSeed(String(stars[i].id));
    dummy.position.set(basePos[i*3], basePos[i*3+1], basePos[i*3+2]);
    dummy.rotation.set(Math.PI / 2 + (seed - 0.5) * 1.1, seed * 6.2831, 0);
    const a = _orbAlpha(i);
    dummy.scale.setScalar(a >= 1 ? 0.5 : a > 0 ? 0.2 : 0);
    dummy.updateMatrix();
    diskMesh.setMatrixAt(k, dummy.matrix);
  });
  diskMesh.instanceMatrix.needsUpdate = true;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function isPinned(id) {
  return pinnedIds.has(String(id));
}

export function togglePinned(id) {
  if (!starMat) return false;
  const key = String(id);
  if (pinnedIds.has(key)) pinnedIds.delete(key);
  else pinnedIds.add(key);
  const i = idToIndex.get(key);
  if (i !== undefined) {
    flagsArr[i] = pinnedIds.has(key) ? (flagsArr[i] | FLAG_PINNED) : (flagsArr[i] & ~FLAG_PINNED);
    _flagsChanged();
  }
  _syncOrbs();
  return pinnedIds.has(key);
}

export function setActiveYear(year) {
  if (!starMat) return;
  activeYear = Number.isFinite(year) ? year : Infinity;
  starMat.uniforms.uYear.value = Number.isFinite(activeYear) ? activeYear : 1e9;
  if (edgeSegments) edgeSegments.material.opacity = Number.isFinite(activeYear) ? 0.18 : 0.45;
  _syncOrbs();
}

export function highlightStars(ids) {
  if (!starMat) return;
  hitIndices.forEach(i => { flagsArr[i] &= ~FLAG_HIT; });
  hitIndices = [];
  ids.forEach(id => {
    const i = idToIndex.get(String(id));
    if (i !== undefined) { flagsArr[i] |= FLAG_HIT; hitIndices.push(i); }
  });
  _flagsChanged();
  highlightOn = true;
  starMat.uniforms.uHighlight.value = 1;
  if (edgeSegments) edgeSegments.material.opacity = 0.03;
  _syncOrbs();
}

export function clearHighlights() {
  if (!starMat) return;
  highlightOn = false;
  starMat.uniforms.uHighlight.value = 0;
  if (edgeSegments) edgeSegments.material.opacity = Number.isFinite(activeYear) ? 0.18 : 0.45;
  _syncOrbs();
}

export function filterCluster(clusterId) {
  if (!starMat) return;
  clearHighlights();

  if (clusterId === 'all') {
    focusCluster = null;
    starMat.uniforms.uFocus.value = -1;
    pivotTarget.set(0, 0, 0);
    tgtR = 85;
    _syncOrbs();
    return;
  }

  focusCluster = clusterId;
  starMat.uniforms.uFocus.value = clusterIds.indexOf(clusterId);
  if (edgeSegments) edgeSegments.material.opacity = 0.01;
  _syncOrbs();

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

/** Mark the star whose detail panel is open, so it gets a hero orb. */
export function setSelected(id) {
  if (!starMat) return;
  selectedIdx = id == null ? -1 : (idToIndex.get(String(id)) ?? -1);
  starMat.uniforms.uSelected.value = selectedIdx;
  _syncOrbs();
}

/** k nearest stars to a star, within its cluster (proximity = semantic similarity). */
export function nearestStars(id, k = 5) {
  const i = idToIndex.get(String(id));
  if (i !== undefined) {
    return _nearest(basePos[i*3], basePos[i*3+1], basePos[i*3+2], clusterMembers[stars[i].cluster] || [], k, i);
  }
  const pos = getRemappedPos(id);
  return pos ? nearestToPoint(pos, k) : [];
}

export function nearestToPoint({ x, y, z }, k = 5) {
  return _nearest(x, y, z, null, k, -1);
}

function _nearest(x, y, z, pool, k, skip) {
  const best = [];   // [d2, i] kept sorted, small k so insertion is fine
  const visit = (i) => {
    if (i === skip) return;
    const dx = basePos[i*3]-x, dy = basePos[i*3+1]-y, dz = basePos[i*3+2]-z;
    const d2 = dx*dx + dy*dy + dz*dz;
    if (best.length < k || d2 < best[best.length-1][0]) {
      best.push([d2, i]);
      best.sort((a, b) => a[0] - b[0]);
      if (best.length > k) best.pop();
    }
  };
  if (pool) pool.forEach(visit);
  else for (let i = 0; i < stars.length; i++) visit(i);
  return best.map(([, i]) => stars[i]);
}

/**
 * Live search results that aren't in the galaxy, shown as visitor orbs.
 * @param {Array<{paper, x, y, z}>} list  scene positions
 */
export function setVisitors(list) {
  visitors = list.map(v => ({
    ...v,
    rgb: _rgb(CLUSTER_COLORS[v.paper.cluster] ?? 0xffd27a),
    seed: _hashSeed(String(v.paper.id)),
  }));
  _syncOrbs();
}

export function clearVisitors() {
  visitors = [];
  _syncOrbs();
}

export function setTheme(mode) {
  if (!starMat) return;
  lightMode = mode === 'light';
  starMat.uniforms.uLight.value = lightMode ? 1 : 0;
  starMat.blending = lightMode ? THREE.NormalBlending : THREE.AdditiveBlending;
  starMat.needsUpdate = true;
}

export function flyTo({ x, y, z }) {
  pivotTarget.set(x, y, z);
  tgtR = 6;
  _warp();
}

// Comet tracking: snap the pivot every frame so it never lags the comet
export function setPivotTarget({ x, y, z }) {
  pivotTarget.set(x, y, z);
  pivot.copy(pivotTarget);
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
  const count = 3000;
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

// Wispy procedural nebula per cluster: value-noise fbm in a soft radial mask
function _nebulaTexture(color, seed) {
  const N = 128;
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = N;
  const ctx = cvs.getContext('2d');
  const img = ctx.createImageData(N, N);
  const [r, g, b] = _rgb(color);

  const rand = (x, y) => {
    const h = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf*xf*(3-2*xf), v = yf*yf*(3-2*yf);
    const a = rand(xi, yi), b2 = rand(xi+1, yi), c = rand(xi, yi+1), d = rand(xi+1, yi+1);
    return a + (b2-a)*u + (c-a)*v + (a-b2-c+d)*u*v;
  };

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const nx = x / N * 4, ny = y / N * 4;
      let f = 0, amp = 0.5, fx = nx, fy = ny;
      for (let o = 0; o < 4; o++) { f += amp * noise(fx, fy); fx *= 2.1; fy *= 2.1; amp *= 0.5; }
      const dx = x / N - 0.5, dy = y / N - 0.5;
      const mask = Math.max(0, 1 - Math.sqrt(dx*dx + dy*dy) * 2);
      const a = Math.pow(mask, 1.6) * Math.pow(f, 2.2) * 0.55;
      const k = (y * N + x) * 4;
      img.data[k]   = r * 255;
      img.data[k+1] = g * 255;
      img.data[k+2] = b * 255;
      img.data[k+3] = Math.min(255, a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function _buildNebulae() {
  clusterIds.forEach((cluster, ci) => {
    const anchor = CLUSTER_ANCHORS[cluster];
    const color  = CLUSTER_COLORS[cluster] ?? DEFAULT_COLOR;
    const tex    = _nebulaTexture(color, ci + 1);
    [[46, 0.55], [28, 0.4]].forEach(([size, opacity], layer) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity, depthWrite: false,
        blending: THREE.AdditiveBlending, rotation: layer * 1.9 + ci,
      }));
      sp.scale.setScalar(size);
      sp.position.copy(anchor);
      scene.add(sp);
    });
  });
}

function _buildEdges() {
  const positions = [], colors = [];
  const K = 4;

  Object.entries(clusterMembers).forEach(([cluster, members]) => {
    if (members.length < 2) return;
    const col = new THREE.Color(CLUSTER_COLORS[cluster] ?? DEFAULT_COLOR);
    const added = new Set();
    // Sample ~300 stars per cluster - the O(n²) neighbour sort is the cost here
    const step = Math.ceil(members.length / 300);
    const sample = members.filter((_, i) => i % step === 0);

    sample.forEach((ia, a) => {
      const dists = [];
      for (let bIdx = 0; bIdx < sample.length; bIdx++) {
        if (bIdx === a) continue;
        const ib = sample[bIdx];
        const dx = basePos[ia*3]-basePos[ib*3], dy = basePos[ia*3+1]-basePos[ib*3+1], dz = basePos[ia*3+2]-basePos[ib*3+2];
        dists.push({ b: bIdx, d: dx*dx+dy*dy+dz*dz });
      }
      dists.sort((x, y) => x.d - y.d);
      const maxD = dists[Math.min(K-1, dists.length-1)].d;

      for (let k = 0; k < Math.min(K, dists.length); k++) {
        const { b, d } = dists[k];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (added.has(key)) continue;
        added.add(key);
        const ib = sample[b];
        const br = Math.max(0.1, 1 - d / (maxD * 2));
        positions.push(basePos[ia*3], basePos[ia*3+1], basePos[ia*3+2], basePos[ib*3], basePos[ib*3+1], basePos[ib*3+2]);
        colors.push(col.r*br, col.g*br, col.b*br, col.r*br, col.g*br, col.b*br);
      }
    });
  });

  if (!positions.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
  edgeSegments = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.45,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  scene.add(edgeSegments);
}

function _buildInterClusterLines() {
  const centres = clusterIds.map(c => CLUSTER_ANCHORS[c]);
  const pos = [];
  for (let a = 0; a < centres.length; a++)
    for (let b = a + 1; b < centres.length; b++)
      pos.push(centres[a].x, centres[a].y, centres[a].z, centres[b].x, centres[b].y, centres[b].z);
  if (!pos.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  scene.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    color: 0x334466, transparent: true, opacity: 0.05, depthWrite: false,
  })));
}

function _buildRing() {
  ringMat = new THREE.MeshBasicMaterial({
    color: 0xc9a84c, side: THREE.DoubleSide, transparent: true, opacity: 0, depthWrite: false,
  });
  ringMesh = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 48), ringMat);
  ringMesh.visible = false;
  ringMesh.renderOrder = 3;
  scene.add(ringMesh);
}

// ── Controls ──────────────────────────────────────────────────────────────────

function _pauseAutoRotate(ms) {
  autoRotate = false;
  clearTimeout(autoRotateTimer);
  autoRotateTimer = setTimeout(() => { autoRotate = true; }, ms);
}

function _onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  resizePostProcessing(innerWidth, innerHeight, renderer.getPixelRatio());
}

function _bindControls(canvas) {
  canvas.addEventListener('mousedown', e => {
    isDragging = true; mouseMoved = false;
    lastMX = e.clientX; lastMY = e.clientY;
    _pauseAutoRotate(10000);
  });

  window.addEventListener('mouseup', () => { isDragging = false; });
  canvas.addEventListener('mouseleave', () => { pointerOnCanvas = false; _clearHover(); });

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
    pointerOnCanvas = e.target === canvas;
  });

  canvas.addEventListener('wheel', e => {
    tgtR = Math.max(1.5, Math.min(400, tgtR * (1 + e.deltaY * 0.0012)));
    _pauseAutoRotate(5000);
  }, { passive: true });

  canvas.addEventListener('click', () => { if (!mouseMoved) _handleClick(); });
  window.addEventListener('resize', _onResize);

  // Touch support
  let lastTouchDist = 0;
  canvas.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      isDragging = true; mouseMoved = false;
      lastMX = e.touches[0].clientX; lastMY = e.touches[0].clientY;
      mouse2D.x =  (lastMX / innerWidth)  * 2 - 1;
      mouse2D.y = -(lastMY / innerHeight) * 2 + 1;
      pointerOnCanvas = true;
      _pauseAutoRotate(8000);
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
      tgtR = Math.max(1.5, Math.min(400, tgtR - (dist - lastTouchDist) * 0.1));
      lastTouchDist = dist;
    }
  }, { passive: true });

  canvas.addEventListener('touchend', () => {
    isDragging = false;
    if (!mouseMoved) _handleClick();
  }, { passive: true });
}

function _handleClick() {
  const hit = _pick();
  if (!hit) return;
  showDetail(hit.star);
  flyTo(hit.worldPos);
}

// ── Animation ─────────────────────────────────────────────────────────────────

let t = 0;
const clock = new THREE.Clock();

function _animate() {
  animFrame = requestAnimationFrame(_animate);

  const delta = Math.min(clock.getDelta(), 0.1);
  t += delta;
  _frameHooks.forEach(fn => fn(delta));

  // Easing is scaled by frame time so the camera moves at the same speed at
  // 30fps as at 144fps (the factors are the old per-frame values at 60fps)
  const ease = (perFrame) => 1 - Math.pow(1 - perFrame, delta * 60);
  if (autoRotate && !isDragging && !reducedMotion) tgtTheta += 0.0006 * delta * 60;

  pivot.lerp(pivotTarget, ease(0.06));

  let dTheta = tgtTheta - camTheta;
  while (dTheta >  Math.PI) dTheta -= Math.PI*2;
  while (dTheta < -Math.PI) dTheta += Math.PI*2;
  camTheta += dTheta * ease(0.05);
  camPhi   += (tgtPhi - camPhi) * ease(0.05);
  camR     += (tgtR   - camR)   * ease(0.05);

  const sinPhi = Math.sin(camPhi);
  camera.position.set(
    pivot.x + camR * sinPhi * Math.sin(camTheta),
    pivot.y + camR * Math.cos(camPhi),
    pivot.z + camR * sinPhi * Math.cos(camTheta),
  );
  camera.lookAt(pivot);

  if (!isDragging && pointerOnCanvas && performance.now() - lastRaycast > 90) {
    lastRaycast = performance.now();
    _updateHover();
  }

  const scale = _projScale();
  const motion = reducedMotion ? 0 : 1;
  const u = starMat.uniforms;
  u.uTime.value   = t;
  u.uScale.value  = scale;
  u.uMotion.value = motion;
  u.uDetail.value = detail;
  heroOrbs.update(t * (0.4 + 0.6 * motion), scale, detail);
  if (diskMesh?.material.userData.shader) diskMesh.material.userData.shader.uniforms.uTime.value = t * motion;

  if (ringMesh.visible) ringMesh.lookAt(camera.position);

  updateAndRender(delta, renderer, scene, camera, camR);
}

// ── Picking ───────────────────────────────────────────────────────────────────

/**
 * Ray vs. star test straight on the position array: no per-star allocations,
 * hidden stars skipped, and a minimum 7px pick radius so far stars are still
 * clickable. Returns { star, worldPos, index } or null.
 */
function _pick() {
  raycaster.setFromCamera(mouse2D, camera);
  const o = raycaster.ray.origin, d = raycaster.ray.direction;
  const ox = o.x, oy = o.y, oz = o.z, dx = d.x, dy = d.y, dz = d.z;
  const near = camera.near;
  const minR = 7 * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / innerHeight;
  const maxYear = Number.isFinite(activeYear) ? activeYear : Infinity;
  const focusIdx = focusCluster === null ? -1 : clusterIds.indexOf(focusCluster);

  let best = -1, bestScore = Infinity;
  const test = (x, y, z, size, i, penalty) => {
    const px = x - ox, py = y - oy, pz = z - oz;
    const along = px*dx + py*dy + pz*dz;
    if (along < near) return;
    const dist2 = px*px + py*py + pz*pz - along*along;
    const rad = Math.max(size * 0.32, along * minR);
    if (dist2 > rad*rad) return;
    const score = Math.sqrt(Math.max(dist2, 0)) / rad + along * 0.002 + penalty;
    if (score < bestScore) { bestScore = score; best = i; }
  };

  // Hot loop over every star: kept flat (no calls, no allocations) on purpose
  for (let i = 0, j = 0, n = stars.length; i < n; i++, j += 3) {
    if (yearArr[i] > maxYear || (focusIdx >= 0 && clusterArr[i] !== focusIdx)) continue;
    const px = basePos[j] - ox, py = basePos[j+1] - oy, pz = basePos[j+2] - oz;
    const along = px*dx + py*dy + pz*dz;
    if (along < near) continue;
    const dist2 = px*px + py*py + pz*pz - along*along;
    let rad = sizeArr[i] * 0.32;
    const pxRad = along * minR;
    if (pxRad > rad) rad = pxRad;
    if (dist2 > rad*rad) continue;
    const dim = highlightOn && !(flagsArr[i] & FLAG_HIT) ? 0.6 : 0;
    const score = Math.sqrt(Math.max(dist2, 0)) / rad + along * 0.002 + dim;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  visitors.forEach((v, k) => test(v.x, v.y, v.z, 1.2, -(k + 2), -0.2));

  if (best === -1) return null;
  if (best <= -2) {
    const v = visitors[-best - 2];
    return { star: v.paper, worldPos: new THREE.Vector3(v.x, v.y, v.z), index: best };
  }
  return {
    star: stars[best],
    worldPos: new THREE.Vector3(basePos[best*3], basePos[best*3+1], basePos[best*3+2]),
    index: best,
  };
}

function _updateHover() {
  const tooltip = document.getElementById('tooltip');
  if (!tooltip) return;
  const result = _pick();

  if (result) {
    document.body.style.cursor = 'pointer';
    if (hoveredIdx !== result.index) {
      hoveredIdx = result.index;
      starMat.uniforms.uHover.value = result.index;
      tooltip.style.display = 'block';
      const s = result.star;
      document.getElementById('tt-title').textContent = s.title || '';
      document.getElementById('tt-meta').textContent =
        `${(s.authors||'').split(',')[0]} · ${s.year||''} · ${(s.cite||0).toLocaleString()} citations`;
      const size = result.index >= 0 ? sizeArr[result.index] : 1.2;
      ringMesh.scale.setScalar(size * 0.9);
    }
    const proj = result.worldPos.clone().project(camera);
    tooltip.style.left = ((proj.x*0.5+0.5)*innerWidth  + 16) + 'px';
    tooltip.style.top  = ((-proj.y*0.5+0.5)*innerHeight - 10) + 'px';
    ringMesh.position.copy(result.worldPos);
    ringMesh.visible = true;
    ringMat.opacity  = 0.85;
  } else {
    _clearHover();
  }
}

function _clearHover() {
  if (hoveredIdx === -1) return;
  document.body.style.cursor = 'crosshair';
  hoveredIdx = -1;
  starMat.uniforms.uHover.value = -1;
  const tooltip = document.getElementById('tooltip');
  if (tooltip) tooltip.style.display = 'none';
  ringMesh.visible = false;
}

// Dev-only handle for poking the scene from the console / screenshot scripts
if (import.meta.env.DEV) {
  window.__galaxy = { orbs: () => heroOrbs, getRemappedPos, flyTo, flyToCluster, filterCluster, highlightStars, clearHighlights, setTheme, nearestStars, setActiveYear };
}
