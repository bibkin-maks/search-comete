/**
 * search-comete - orb.js
 *
 * Detailed "hero" orbs drawn on top of the star field. The star field
 * (galaxy.js) draws every paper as a cheap glowing sprite; this module draws a
 * proper animated orb for the papers worth a close look: the most cited ones,
 * the star you clicked, pinned stars and live "visitor" results.
 *
 * Each orb is one camera-facing instanced quad whose fragment shader paints a
 * sphere analytically (no geometry): rotating plasma surface, limb darkening,
 * hot rim and a noisy corona. Black holes get an event horizon and a
 * Doppler-bright photon ring instead. A few hundred orbs = one draw call.
 *
 * Orbs fade in by their size on screen, so far away they cost almost nothing
 * and the star field's sprite stands in for them.
 *
 * Blending is premultiplied alpha (ONE, ONE_MINUS_SRC_ALPHA): glow is written
 * with alpha 0 so it adds light, while the black hole's horizon is written with
 * alpha 1 so it actually blocks what's behind it.
 */

import * as THREE from 'three';

export const ORB_STAR       = 0;
export const ORB_BLACK_HOLE = 1;
export const ORB_VISITOR    = 2;

const MAX_ORBS = 1024;

const VERT = /* glsl */`
  attribute vec3  aCenter;
  attribute vec3  aColor;
  attribute float aSize;
  attribute float aSeed;
  attribute float aKind;
  attribute float aAlpha;
  attribute float aBorn;
  uniform float uScale;
  uniform float uClock;
  varying vec2  vUv;
  varying vec3  vColor;
  varying float vSeed;
  varying float vKind;
  varying float vAlpha;

  void main() {
    // Billboard: expand the quad along the camera's right/up axes
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    // Grow in after birth (new tree nodes); old orbs have aBorn far in the past
    float grow = clamp((uClock - aBorn) / 0.7, 0.0, 1.0);
    grow = grow * (2.0 - grow);
    vec3 wp    = aCenter + (right * position.x + up * position.y) * aSize * 2.0 * grow;
    vec4 mv    = viewMatrix * vec4(wp, 1.0);

    // Orb diameter on screen in px - fade in between 5 and 16 px
    float px = aSize * uScale / max(-mv.z, 0.001);
    vAlpha   = aAlpha * smoothstep(5.0, 16.0, px) * grow;

    gl_Position = vAlpha < 0.002 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
    vUv    = position.xy * 2.0;   // -1..1, the orb itself has radius 0.5
    vColor = aColor;
    vSeed  = aSeed;
    vKind  = aKind;
  }
`;

const FRAG = /* glsl */`
  uniform float uTime;
  uniform float uDetail;   // 0 = low, 1 = high
  varying vec2  vUv;
  varying vec3  vColor;
  varying float vSeed;
  varying float vKind;
  varying float vAlpha;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i),                  hash(i + vec3(1,0,0)), f.x),
                   mix(hash(i + vec3(0,1,0)),    hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)),    hash(i + vec3(1,0,1)), f.x),
                   mix(hash(i + vec3(0,1,1)),    hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0, a = 0.5;
    float octaves = 2.0 + 3.0 * uDetail;
    for (int i = 0; i < 5; i++) {
      if (float(i) >= octaves) break;
      v += a * noise(p);
      p  = p * 2.03 + 17.1;
      a *= 0.5;
    }
    return v;
  }

  const float R = 0.5;

  void main() {
    vec2  p   = vUv;
    float r   = length(p);
    if (r > 1.0) discard;
    float ang = atan(p.y, p.x);
    float t   = uTime;
    vec3  col = vColor;
    vec3  rgb = vec3(0.0);
    float a   = 0.0;

    if (vKind > 0.5 && vKind < 1.5) {
      // ── Black hole ──────────────────────────────────────────────────────────
      float horizon = R * 0.52;
      float ringR   = R * 0.70;
      float swirl   = fbm(vec3(ang * 2.0 + t * 0.9, r * 9.0, vSeed * 13.0));
      float doppler = 0.45 + 0.55 * cos(ang - t * 0.5 + vSeed * 6.2831);
      float photon  = exp(-pow((r - ringR) * 26.0, 2.0));
      vec3  hot     = mix(col, vec3(1.0, 0.88, 0.7), 0.55);
      rgb  = hot * photon * (0.6 + 2.0 * doppler) * (0.6 + 0.8 * swirl) * 2.6;
      // Lensed glow just outside the ring, and a faint outer halo
      rgb += mix(col, vec3(1.0), 0.3) * exp(-max(r - ringR, 0.0) * 7.0) * 0.8 * step(ringR, r) * (0.6 + 0.8 * swirl);
      rgb += col * exp(-r * 2.5) * 0.18;
      // Shadow: fully dark inside the horizon, fading out towards the ring
      a = 1.0 - smoothstep(horizon, ringR, r);
      rgb *= 1.0 - a * 0.85;
    } else {
      // ── Star / visitor ──────────────────────────────────────────────────────
      if (r < R) {
        vec2  q = p / R;
        float z = sqrt(max(0.0, 1.0 - dot(q, q)));
        vec3  n = vec3(q, z);
        float spin = t * 0.10 + vSeed * 6.2831;
        float c = cos(spin), s = sin(spin);
        vec3  sp = vec3(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);

        float plasma = fbm(sp * 2.4 + vec3(0.0, t * 0.06, vSeed * 7.0));
        float cells  = noise(sp * 10.0 + t * 0.12);
        vec3  hot    = mix(col, vec3(1.0, 0.97, 0.9), 0.6);
        vec3  surf   = mix(col * 0.45, hot, smoothstep(0.28, 0.72, plasma));
        surf *= 0.7 + 0.5 * cells * uDetail + 0.25 * (1.0 - uDetail);
        surf *= 0.3 + 0.7 * pow(z, 0.55);            // limb darkening
        surf += col * pow(1.0 - z, 2.4) * 1.1;       // hot rim
        rgb = surf * 1.5;
        a   = smoothstep(R, R - 0.02, r);            // anti-aliased disc edge
      }
      // Corona + halo (pure glow, alpha 0)
      float d      = max(r - R, 0.0);
      float rays   = fbm(vec3(cos(ang) * 2.2, sin(ang) * 2.2, d * 3.0 - t * 0.22 + vSeed * 5.0));
      float corona = exp(-d * 8.0) * (0.45 + 1.0 * rays) * step(R * 0.97, r);
      float halo   = exp(-r * 3.0) * 0.3;
      rgb += mix(col, vec3(1.0), 0.25) * (corona + halo);

      if (vKind > 1.5) {
        // Visitor (live search result): gold dashed orbit ring + slow pulse
        float ring = exp(-pow((r - 0.8) * 45.0, 2.0));
        float dash = step(0.45, fract(ang / 6.2831 * 18.0 + t * 0.15));
        rgb += vec3(1.0, 0.82, 0.45) * ring * dash * (0.75 + 0.25 * sin(t * 2.5 + vSeed * 9.0));
      }
    }

    float edge = smoothstep(1.0, 0.72, r);
    gl_FragColor = vec4(rgb * edge * vAlpha, a * vAlpha);
  }
`;

export class HeroOrbs {
  constructor(scene) {
    const base = new THREE.PlaneGeometry(1, 1);
    const geo  = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));

    this._center = new Float32Array(MAX_ORBS * 3);
    this._color  = new Float32Array(MAX_ORBS * 3);
    this._size   = new Float32Array(MAX_ORBS);
    this._seed   = new Float32Array(MAX_ORBS);
    this._kind   = new Float32Array(MAX_ORBS);
    this._alpha  = new Float32Array(MAX_ORBS);
    this._born   = new Float32Array(MAX_ORBS).fill(-1e6);
    this._attrs = {
      aCenter: new THREE.InstancedBufferAttribute(this._center, 3),
      aColor:  new THREE.InstancedBufferAttribute(this._color, 3),
      aSize:   new THREE.InstancedBufferAttribute(this._size, 1),
      aSeed:   new THREE.InstancedBufferAttribute(this._seed, 1),
      aKind:   new THREE.InstancedBufferAttribute(this._kind, 1),
      aAlpha:  new THREE.InstancedBufferAttribute(this._alpha, 1),
      aBorn:   new THREE.InstancedBufferAttribute(this._born, 1),
    };
    Object.entries(this._attrs).forEach(([name, attr]) => geo.setAttribute(name, attr));
    geo.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime:   { value: 0 },
        uScale:  { value: 1 },
        uDetail: { value: 1 },
        uClock:  { value: 0 },
      },
      vertexShader:   VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.CustomBlending,
      blendSrc:    THREE.OneFactor,
      blendDst:    THREE.OneMinusSrcAlphaFactor,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder   = 2;
    scene.add(this.mesh);
    this.count = 0;
  }

  /**
   * Replace all orbs.
   * @param {Array<{x,y,z,r,g,b,size,seed,kind,alpha}>} items  colour in 0..1 sRGB
   */
  set(items) {
    const n = Math.min(items.length, MAX_ORBS);
    for (let i = 0; i < n; i++) {
      const o = items[i];
      this._center[i*3] = o.x; this._center[i*3+1] = o.y; this._center[i*3+2] = o.z;
      this._color[i*3]  = o.r; this._color[i*3+1]  = o.g; this._color[i*3+2]  = o.b;
      this._size[i]  = o.size;
      this._seed[i]  = o.seed;
      this._kind[i]  = o.kind;
      this._alpha[i] = o.alpha ?? 1;
      this._born[i]  = o.born ?? -1e6;
    }
    Object.values(this._attrs).forEach(attr => { attr.needsUpdate = true; });
    this.mesh.geometry.instanceCount = n;
    this.count = n;
  }

  update(time, scale, detail, clock) {
    const u = this.material.uniforms;
    u.uClock.value  = clock;
    u.uTime.value   = time;
    u.uScale.value  = scale;
    u.uDetail.value = detail;
  }
}
