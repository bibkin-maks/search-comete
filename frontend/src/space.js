/**
 * search-comete - space.js
 * Everything that makes the galaxy feel like it's in space, but isn't data:
 *
 *  - sky: procedural milky-way band, dust lanes, faint nebulae and pinpoint
 *    stars, rendered once into a cube map at startup (free per frame)
 *  - dust: particles kept in a box around the camera, so flying anywhere
 *    gives parallax and a sense of speed
 *  - a few distant spiral galaxies far beyond the data
 */

import * as THREE from 'three';

const NOISE = /* glsl */`
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i),               hash(i + vec3(1,0,0)), f.x),
                   mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                   mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) { v += a * noise(p); p = p * 2.02 + 13.7; a *= 0.5; }
    return v;
  }
`;

const SKY_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */`
  varying vec3 vDir;
  ${NOISE}
  void main() {
    vec3 d = normalize(vDir);
    vec3 col = mix(vec3(0.008, 0.008, 0.022), vec3(0.016, 0.013, 0.036), d.y * 0.5 + 0.5);

    // Milky-way band along a tilted great circle, with dark dust lanes
    vec3  n      = normalize(vec3(0.35, 1.0, 0.4));
    float h      = dot(d, n);
    float band   = exp(-h * h * 9.0);
    float core   = exp(-h * h * 40.0);
    float clouds = fbm(d * 3.2);
    float lanes  = smoothstep(0.48, 0.72, fbm(d * 6.0 + 11.0)) * core;
    vec3  bandCol = mix(vec3(0.16, 0.13, 0.28), vec3(0.36, 0.27, 0.22), fbm(d * 8.0 + 4.0));
    col += bandCol * band * (0.25 + 0.75 * clouds) * 0.5 * (1.0 - 0.75 * lanes);
    col += vec3(0.30, 0.24, 0.20) * core * clouds * 0.18 * (1.0 - lanes);

    // Faint coloured nebulae away from the band
    col += vec3(0.20, 0.07, 0.30) * smoothstep(0.58, 0.95, fbm(d * 2.1 + 3.0)) * 0.22;
    col += vec3(0.03, 0.16, 0.22) * smoothstep(0.62, 1.0,  fbm(d * 2.7 - 7.0)) * 0.20;

    // Pinpoint stars, denser in the band
    for (int layer = 0; layer < 2; layer++) {
      float density = layer == 0 ? 140.0 : 320.0;
      vec3  g    = d * density;
      vec3  cell = floor(g);
      float pick = hash(cell + float(layer) * 31.0);
      float thresh = layer == 0 ? 0.992 - band * 0.012 : 0.985 - band * 0.03;
      if (pick > thresh) {
        vec3  off  = vec3(hash(cell + 1.3), hash(cell + 2.1), hash(cell + 3.7)) - 0.5;
        float dist = length(fract(g) - 0.5 - off * 0.5);
        float b    = smoothstep(0.32, 0.0, dist) * (0.35 + 0.65 * hash(cell + 5.0));
        vec3  tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.86, 0.7), hash(cell + 9.0));
        col += tint * b * (layer == 0 ? 0.9 : 0.45);
      }
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

const DUST_VERT = /* glsl */`
  uniform vec3  uCam;
  uniform float uBox;
  uniform float uScale;
  attribute float aSeed;
  varying float vFade;
  void main() {
    // Wrap every particle into a box centred on the camera
    vec3 p = mod(position - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = -mv.z;
    vFade = smoothstep(uBox * 0.5, uBox * 0.15, length(p - uCam)) * smoothstep(0.5, 4.0, dist) * (0.4 + 0.6 * aSeed);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(0.05 * uScale / max(dist, 0.1), 1.0, 3.5);
  }
`;

const DUST_FRAG = /* glsl */`
  varying float vFade;
  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float a = exp(-dot(uv, uv) * 3.0) * vFade * 0.55;
    gl_FragColor = vec4(0.72, 0.78, 1.0, a);
  }
`;

let dust, skyTarget;

export function buildSpace(scene, renderer) {
  _bakeSky(scene, renderer);
  _buildDust(scene);
  _buildGalaxies(scene);
}

export function updateSpace(camera, scale) {
  if (!dust) return;
  dust.material.uniforms.uCam.value.copy(camera.position);
  dust.material.uniforms.uScale.value = scale;
}

function _bakeSky(scene, renderer) {
  const skyScene = new THREE.Scene();
  skyScene.add(new THREE.Mesh(
    new THREE.SphereGeometry(10, 48, 32),
    new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false }),
  ));
  skyTarget = new THREE.WebGLCubeRenderTarget(1024, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const cubeCam = new THREE.CubeCamera(0.1, 100, skyTarget);
  const toneMapping = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  cubeCam.update(renderer, skyScene);
  renderer.toneMapping = toneMapping;
  scene.background = skyTarget.texture;
}

function _buildDust(scene) {
  const count = 1800, box = 90;
  const pos = new Float32Array(count * 3), seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i*3] = Math.random() * box; pos[i*3+1] = Math.random() * box; pos[i*3+2] = Math.random() * box;
    seed[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  dust = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: { uCam: { value: new THREE.Vector3() }, uBox: { value: box }, uScale: { value: 1 } },
    vertexShader: DUST_VERT, fragmentShader: DUST_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  dust.frustumCulled = false;
  scene.add(dust);
}

// Small spiral galaxy drawn on a canvas: bright bulge + two noisy arms
function _galaxyTexture(hue, seed) {
  const N = 256, cvs = document.createElement('canvas');
  cvs.width = cvs.height = N;
  const ctx = cvs.getContext('2d');
  ctx.globalCompositeOperation = 'lighter';
  const rand = (i) => { const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453; return x - Math.floor(x); };
  for (let i = 0; i < 2600; i++) {
    const arm = i % 2;
    const t = rand(i) ** 0.8;
    const ang = t * 7.5 + arm * Math.PI + (rand(i + 9) - 0.5) * 0.9 * (1 - t * 0.5);
    const rad = t * N * 0.45;
    const x = N / 2 + Math.cos(ang) * rad, y = N / 2 + Math.sin(ang) * rad * 0.55;
    const light = 70 - t * 30;
    ctx.fillStyle = `hsla(${hue + (rand(i + 3) - 0.5) * 40}, 60%, ${light}%, ${0.05 + (1 - t) * 0.1})`;
    ctx.beginPath(); ctx.arc(x, y, 1 + rand(i + 5) * 2.2, 0, Math.PI * 2); ctx.fill();
  }
  const g = ctx.createRadialGradient(N/2, N/2, 0, N/2, N/2, N * 0.16);
  g.addColorStop(0, 'rgba(255,240,220,0.9)'); g.addColorStop(1, 'rgba(255,220,180,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, N, N);
  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function _buildGalaxies(scene) {
  const hues = [215, 280, 30, 190, 330, 250, 45];
  hues.forEach((hue, i) => {
    const dir = new THREE.Vector3(Math.sin(i * 2.4) * Math.cos(i * 1.3), Math.cos(i * 2.4) * 0.6, Math.sin(i * 1.3)).normalize();
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: _galaxyTexture(hue, i + 1), transparent: true, opacity: 0.55, depthWrite: false,
      blending: THREE.AdditiveBlending, rotation: i * 0.9, fog: false,
    }));
    sp.position.copy(dir.multiplyScalar(1100 + (i % 3) * 250));
    sp.scale.setScalar(90 + (i % 4) * 45);
    scene.add(sp);
  });
}
