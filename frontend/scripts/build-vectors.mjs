// Meaning vectors for every galaxy paper, so the browser can work out where a
// new paper belongs (nearest papers, field) and search by meaning.
//
// Titles are embedded with all-MiniLM-L6-v2 (the model the browser runs),
// reduced 384 -> 64 dims with PCA, normalised and stored as int8: 3.5 MB for
// 54k papers instead of 83 MB.
//
//   node scripts/build-vectors.mjs
//   MODELS_DIR=/path/to/local/models node scripts/build-vectors.mjs
//
// Writes public/vectors.bin (int8, galaxy.json order) and public/vectors.json (PCA).

import { pipeline, env } from '@huggingface/transformers';
import { readFileSync, writeFileSync } from 'node:fs';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384, K = 64;
const PUB = new URL('../public/', import.meta.url);

if (process.env.MODELS_DIR) {
  env.localModelPath = process.env.MODELS_DIR;
  env.allowRemoteModels = false;
}

const galaxy = JSON.parse(readFileSync(new URL('galaxy.json', PUB)));
const titles = galaxy.title.map(t => t.replace(/<[^>]*>/g, ''));
const n = titles.length;
const embed = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });

// 1. Embed
const X = new Float32Array(n * DIM);
for (let i = 0; i < n; i += 128) {
  const out = await embed(titles.slice(i, i + 128), { pooling: 'mean', normalize: true });
  X.set(out.data, i * DIM);
  process.stdout.write(`\r  embedded ${Math.min(i + 128, n)}/${n}`);
}
console.log();

// 2. PCA: mean, covariance, top-K eigenvectors by block power iteration
const mean = new Float64Array(DIM);
for (let i = 0; i < n; i++) for (let d = 0; d < DIM; d++) mean[d] += X[i * DIM + d];
for (let d = 0; d < DIM; d++) mean[d] /= n;

const C = new Float64Array(DIM * DIM);
const row = new Float64Array(DIM);
for (let i = 0; i < n; i++) {
  for (let d = 0; d < DIM; d++) row[d] = X[i * DIM + d] - mean[d];
  for (let a = 0; a < DIM; a++) {
    const ra = row[a];
    if (ra === 0) continue;
    const base = a * DIM;
    for (let b = a; b < DIM; b++) C[base + b] += ra * row[b];
  }
}
for (let a = 0; a < DIM; a++) for (let b = a; b < DIM; b++) { C[a * DIM + b] /= n; C[b * DIM + a] = C[a * DIM + b]; }

let Q = Float64Array.from({ length: DIM * K }, (_, i) => Math.sin(i * 12.9898) * 43758.5453 % 1);
const orthonormalise = (M) => {
  for (let k = 0; k < K; k++) {
    for (let j = 0; j < k; j++) {
      let dot = 0;
      for (let d = 0; d < DIM; d++) dot += M[d * K + k] * M[d * K + j];
      for (let d = 0; d < DIM; d++) M[d * K + k] -= dot * M[d * K + j];
    }
    let norm = 0;
    for (let d = 0; d < DIM; d++) norm += M[d * K + k] ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < DIM; d++) M[d * K + k] /= norm;
  }
};
orthonormalise(Q);
for (let it = 0; it < 60; it++) {
  const Z = new Float64Array(DIM * K);
  for (let a = 0; a < DIM; a++) for (let b = 0; b < DIM; b++) {
    const c = C[a * DIM + b];
    for (let k = 0; k < K; k++) Z[a * K + k] += c * Q[b * K + k];
  }
  orthonormalise(Z);
  Q = Z;
}
let total = 0, kept = 0;
for (let d = 0; d < DIM; d++) total += C[d * DIM + d];
for (let k = 0; k < K; k++) {
  let v = 0;
  for (let a = 0; a < DIM; a++) { let s = 0; for (let b = 0; b < DIM; b++) s += C[a * DIM + b] * Q[b * K + k]; v += Q[a * K + k] * s; }
  kept += v;
}
console.log(`  PCA ${DIM} -> ${K}: keeps ${(kept / total * 100).toFixed(1)}% of the variance`);

// 3. Project, normalise, quantise
const out = new Int8Array(n * K);
const y = new Float64Array(K);
for (let i = 0; i < n; i++) {
  y.fill(0);
  for (let d = 0; d < DIM; d++) {
    const v = X[i * DIM + d] - mean[d];
    for (let k = 0; k < K; k++) y[k] += v * Q[d * K + k];
  }
  let norm = 0;
  for (let k = 0; k < K; k++) norm += y[k] ** 2;
  norm = Math.sqrt(norm) || 1;
  for (let k = 0; k < K; k++) out[i * K + k] = Math.round((y[k] / norm) * 127);
}

writeFileSync(new URL('vectors.bin', PUB), Buffer.from(out.buffer));
writeFileSync(new URL('vectors.json', PUB), JSON.stringify({
  model: MODEL, dim: DIM, k: K, n, text: 'title',
  mean: [...mean].map(v => +v.toFixed(6)),
  components: [...Q].map(v => +v.toFixed(6)),   // DIM x K, row-major
}));
console.log(`  wrote vectors.bin (${(out.length / 1048576).toFixed(1)} MB) + vectors.json`);
