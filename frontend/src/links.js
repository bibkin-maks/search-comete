/**
 * search-comete - links.js
 * Glowing ropes between points in the galaxy: citation webs and the ropes
 * you tie between pinned papers.
 *
 * Each link is a quadratic Bézier arched away from the galaxy centre, drawn
 * as line segments with light pulses flowing from source to target, plus a
 * few particles riding along it. One LinkLayer = two draw calls however many
 * links it holds.
 */

import * as THREE from 'three';

const SEGMENTS = 28;

const LINE_VERT = /* glsl */`
  attribute float aT;
  attribute vec3  aColor;
  attribute float aStrength;
  attribute float aPhase;
  attribute float aBorn;
  attribute float aYear;
  uniform float uClock;
  uniform float uYear;
  varying float vT;
  varying vec3  vColor;
  varying float vStrength;
  varying float vPhase;
  varying float vReveal;
  void main() {
    vT = aT; vColor = aColor; vStrength = aStrength; vPhase = aPhase;
    vReveal = clamp((uClock - aBorn) / 0.9, 0.0, 1.0);
    if (aYear > uYear) vReveal = -1.0;   // hidden by the timeline
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const LINE_FRAG = /* glsl */`
  uniform float uTime;
  varying float vT;
  varying vec3  vColor;
  varying float vStrength;
  varying float vPhase;
  varying float vReveal;     // 0..1: each rope draws itself from source to target
  void main() {
    if (vT > vReveal) discard;
    float pulse = smoothstep(0.82, 1.0, fract(vT * 3.0 - uTime * 0.45 + vPhase));
    float ends  = smoothstep(0.0, 0.08, vT) * smoothstep(1.0, 0.92, vT);
    float a = (0.22 + 0.78 * pulse) * vStrength * (0.35 + 0.65 * ends);
    gl_FragColor = vec4(mix(vColor, vec3(1.0), pulse * 0.5), a);
  }
`;

const BEAD_VERT = /* glsl */`
  uniform float uTime;
  uniform float uScale;
  uniform float uClock;
  uniform float uYear;
  attribute float aBorn;
  attribute float aYear;
  attribute vec3  aStart;
  attribute vec3  aCtrl;
  attribute vec3  aEnd;
  attribute vec3  aColor;
  attribute float aPhase;
  attribute float aSpeed;
  varying vec3  vColor;
  varying float vFade;
  void main() {
    float t = fract(aPhase + uTime * aSpeed);
    float u = 1.0 - t;
    vec3 p = u * u * aStart + 2.0 * u * t * aCtrl + t * t * aEnd;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(0.35 * uScale / -mv.z, 2.0, 10.0);
    vColor = aColor;
    vFade = sin(t * 3.14159) * step(aBorn + 0.9, uClock) * step(aYear, uYear);
  }
`;

const BEAD_FRAG = /* glsl */`
  varying vec3  vColor;
  varying float vFade;
  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(uv, uv);
    if (r2 > 1.0) discard;
    float a = exp(-r2 * 5.0) * vFade;
    gl_FragColor = vec4(mix(vColor, vec3(1.0), 0.6), a);
  }
`;

function _ctrlPoint(a, b) {
  // Arch the rope away from the galaxy centre, more for longer ropes
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const len = a.distanceTo(b);
  const out = mid.lengthSq() > 1e-6 ? mid.clone().normalize() : new THREE.Vector3(0, 1, 0);
  return mid.add(out.multiplyScalar(Math.min(len * 0.35, 60)));
}

export class LinkLayer {
  constructor(scene, { beadsPerLink = 2 } = {}) {
    this.scene = scene;
    this.beadsPerLink = beadsPerLink;
    this.lineMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uClock: { value: 0 }, uYear: { value: 1e9 } },
      vertexShader: LINE_VERT, fragmentShader: LINE_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.beadMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: 1 }, uClock: { value: 0 }, uYear: { value: 1e9 } },
      vertexShader: BEAD_VERT, fragmentShader: BEAD_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.lines = null;
    this.beads = null;
  }

  /**
   * @param {Array<{from:{x,y,z}, to:{x,y,z}, color:[r,g,b], strength?:number, born?:number}>} links
   *        born: clock time the rope starts drawing itself (omit = already drawn)
   *        year: newest year among its two ends, for the timeline filter
   */
  set(links) {
    this.clear();
    if (!links.length) return;

    const n = links.length;
    const pos = new Float32Array(n * SEGMENTS * 2 * 3);
    const tAttr = new Float32Array(n * SEGMENTS * 2);
    const col = new Float32Array(n * SEGMENTS * 2 * 3);
    const str = new Float32Array(n * SEGMENTS * 2);
    const phs = new Float32Array(n * SEGMENTS * 2);
    const brn = new Float32Array(n * SEGMENTS * 2);
    const yr  = new Float32Array(n * SEGMENTS * 2);
    const bBorn = new Float32Array(n * this.beadsPerLink);
    const bYear = new Float32Array(n * this.beadsPerLink);

    const nb = n * this.beadsPerLink;
    const bStart = new Float32Array(nb * 3), bCtrl = new Float32Array(nb * 3), bEnd = new Float32Array(nb * 3);
    const bCol = new Float32Array(nb * 3), bPhase = new Float32Array(nb), bSpeed = new Float32Array(nb);

    const a = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3();
    links.forEach((link, li) => {
      a.set(link.from.x, link.from.y, link.from.z);
      b.set(link.to.x, link.to.y, link.to.z);
      const c = _ctrlPoint(a, b);
      const strength = link.strength ?? 1;
      const phase = (li * 0.618) % 1;
      const point = (t) => {
        const u = 1 - t;
        return p.set(
          u*u*a.x + 2*u*t*c.x + t*t*b.x,
          u*u*a.y + 2*u*t*c.y + t*t*b.y,
          u*u*a.z + 2*u*t*c.z + t*t*b.z);
      };
      for (let s = 0; s < SEGMENTS; s++) {
        for (let e = 0; e < 2; e++) {
          const t = (s + e) / SEGMENTS;
          const v = (li * SEGMENTS + s) * 2 + e;
          point(t);
          pos[v*3] = p.x; pos[v*3+1] = p.y; pos[v*3+2] = p.z;
          tAttr[v] = t;
          col[v*3] = link.color[0]; col[v*3+1] = link.color[1]; col[v*3+2] = link.color[2];
          str[v] = strength;
          phs[v] = phase;
          brn[v] = link.born ?? -1e6;
          yr[v]  = link.year || 0;
        }
      }
      for (let k = 0; k < this.beadsPerLink; k++) {
        const bi = li * this.beadsPerLink + k;
        bStart.set([a.x, a.y, a.z], bi*3);
        bCtrl.set([c.x, c.y, c.z], bi*3);
        bEnd.set([b.x, b.y, b.z], bi*3);
        bCol.set(link.color, bi*3);
        bPhase[bi] = (phase + k / this.beadsPerLink) % 1;
        bSpeed[bi] = 0.12 / Math.max(1, a.distanceTo(b) / 20);
        bBorn[bi] = link.born ?? -1e6;
        bYear[bi] = link.year || 0;
      }
    });

    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position',  new THREE.BufferAttribute(pos, 3));
    lg.setAttribute('aT',        new THREE.BufferAttribute(tAttr, 1));
    lg.setAttribute('aColor',    new THREE.BufferAttribute(col, 3));
    lg.setAttribute('aStrength', new THREE.BufferAttribute(str, 1));
    lg.setAttribute('aPhase',    new THREE.BufferAttribute(phs, 1));
    lg.setAttribute('aBorn',     new THREE.BufferAttribute(brn, 1));
    lg.setAttribute('aYear',     new THREE.BufferAttribute(yr, 1));
    this.lines = new THREE.LineSegments(lg, this.lineMat);

    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nb * 3), 3));
    bg.setAttribute('aStart', new THREE.BufferAttribute(bStart, 3));
    bg.setAttribute('aCtrl',  new THREE.BufferAttribute(bCtrl, 3));
    bg.setAttribute('aEnd',   new THREE.BufferAttribute(bEnd, 3));
    bg.setAttribute('aColor', new THREE.BufferAttribute(bCol, 3));
    bg.setAttribute('aPhase', new THREE.BufferAttribute(bPhase, 1));
    bg.setAttribute('aSpeed', new THREE.BufferAttribute(bSpeed, 1));
    bg.setAttribute('aBorn',  new THREE.BufferAttribute(bBorn, 1));
    bg.setAttribute('aYear',  new THREE.BufferAttribute(bYear, 1));
    this.beads = new THREE.Points(bg, this.beadMat);

    [this.lines, this.beads].forEach(o => { o.frustumCulled = false; o.renderOrder = 4; this.scene.add(o); });
  }

  /** Hide links whose `year` (the newer end) is after `year`. */
  setYear(year) {
    this.lineMat.uniforms.uYear.value = year;
    this.beadMat.uniforms.uYear.value = year;
  }

  /**
   * Move existing links to new end points without rebuilding buffers (for
   * the self-arranging tree, every frame). Falls back to set() when the
   * number of links changed.
   */
  move(links) {
    if (!this.lines || links.length * SEGMENTS * 2 !== this.lines.geometry.attributes.position.count) return this.set(links);
    const pos = this.lines.geometry.attributes.position.array;
    const bs = this.beads.geometry.attributes.aStart.array;
    const bc = this.beads.geometry.attributes.aCtrl.array;
    const be = this.beads.geometry.attributes.aEnd.array;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    links.forEach((link, li) => {
      a.set(link.from.x, link.from.y, link.from.z);
      b.set(link.to.x, link.to.y, link.to.z);
      const c = _ctrlPoint(a, b);
      for (let s = 0; s < SEGMENTS; s++) {
        for (let e = 0; e < 2; e++) {
          const t = (s + e) / SEGMENTS, u = 1 - t;
          const v = ((li * SEGMENTS + s) * 2 + e) * 3;
          pos[v]   = u*u*a.x + 2*u*t*c.x + t*t*b.x;
          pos[v+1] = u*u*a.y + 2*u*t*c.y + t*t*b.y;
          pos[v+2] = u*u*a.z + 2*u*t*c.z + t*t*b.z;
        }
      }
      for (let k = 0; k < this.beadsPerLink; k++) {
        const bi = (li * this.beadsPerLink + k) * 3;
        bs[bi] = a.x; bs[bi+1] = a.y; bs[bi+2] = a.z;
        bc[bi] = c.x; bc[bi+1] = c.y; bc[bi+2] = c.z;
        be[bi] = b.x; be[bi+1] = b.y; be[bi+2] = b.z;
      }
    });
    this.lines.geometry.attributes.position.needsUpdate = true;
    ['aStart', 'aCtrl', 'aEnd'].forEach(k => { this.beads.geometry.attributes[k].needsUpdate = true; });
  }

  clear() {
    [this.lines, this.beads].forEach(o => {
      if (!o) return;
      this.scene.remove(o);
      o.geometry.dispose();
    });
    this.lines = this.beads = null;
  }

  update(time, clock, scale) {
    this.lineMat.uniforms.uTime.value = time;
    this.lineMat.uniforms.uClock.value = clock;
    this.beadMat.uniforms.uTime.value = time;
    this.beadMat.uniforms.uClock.value = clock;
    this.beadMat.uniforms.uScale.value = scale;
  }
}
