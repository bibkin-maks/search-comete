/**
 * search-comete - meaning.js
 * A small embedding model (all-MiniLM-L6-v2, ~23 MB, runs on any device via
 * WebAssembly) used as a classifier rather than a text generator:
 *
 *  - relatedTopics(paper): match the paper against all ~4,500 OpenAlex
 *    research topics by meaning (zero-shot classification)
 *  - belonging(paper): where a paper that isn't in the galaxy belongs - its
 *    nearest galaxy papers, its field with a confidence, and a position
 *  - semanticSearch(query): galaxy papers by meaning, not just shared words
 *
 * Topic and paper vectors are precomputed with the same model
 * (scripts/build-topics.mjs, scripts/build-vectors.mjs) and loaded lazily.
 */

const MODEL = 'Xenova/all-MiniLM-L6-v2';

let _embed = null, _loading = null;
let _topics = null, _topicVecs = null;
let _pca = null, _paperVecs = null;
let _stars = [];

export function setMeaningCorpus(stars) { _stars = stars; }
export function meaningReady() { return !!(_embed && _paperVecs); }

/** Load the model and the precomputed vectors. onProgress(fraction, loadedMB, totalMB). */
export function loadMeaning(onProgress) {
  if (_loading) return _loading;
  _loading = (async () => {
    const { pipeline } = await import('@huggingface/transformers');
    const files = new Map();
    const progress_callback = (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, [p.loaded, p.total]);
      let loaded = 0, total = 0;
      files.forEach(([l, t]) => { loaded += l; total += t; });
      onProgress?.(loaded / total, loaded / 1048576, total / 1048576);
    };
    const [embed, topics, topicBin, pca, paperBin] = await Promise.all([
      pipeline('feature-extraction', MODEL, { dtype: 'q8', device: 'wasm', progress_callback }),
      fetch('/topics.json').then(r => r.json()),
      fetch('/topics.bin').then(r => r.arrayBuffer()),
      fetch('/vectors.json').then(r => r.json()),
      fetch('/vectors.bin').then(r => r.arrayBuffer()),
    ]);
    _embed = embed;
    _topics = topics;
    _topicVecs = new Int8Array(topicBin);
    _pca = { mean: Float32Array.from(pca.mean), comp: Float32Array.from(pca.components), k: pca.k, dim: pca.dim };
    _paperVecs = new Int8Array(paperBin);
  })().catch(e => { _loading = null; throw e; });
  return _loading;
}

async function _vector(text) {
  const out = await _embed(text, { pooling: 'mean', normalize: true });
  return out.data;   // Float32Array(384), unit length
}

// 384-d embedding -> the 64-d PCA space the galaxy vectors live in (unit length)
function _project(v) {
  const { mean, comp, k, dim } = _pca;
  const y = new Float32Array(k);
  for (let d = 0; d < dim; d++) {
    const x = v[d] - mean[d];
    for (let j = 0; j < k; j++) y[j] += x * comp[d * k + j];
  }
  let norm = 0;
  for (let j = 0; j < k; j++) norm += y[j] * y[j];
  norm = Math.sqrt(norm) || 1;
  for (let j = 0; j < k; j++) y[j] /= norm;
  return y;
}

// Top-k galaxy papers by cosine similarity in the 64-d space
function _nearestPapers(y, k) {
  const K = _pca.k, n = _paperVecs.length / K;
  const best = [];
  let floor = -Infinity;
  for (let i = 0; i < n; i++) {
    let dot = 0;
    const o = i * K;
    for (let j = 0; j < K; j++) dot += y[j] * _paperVecs[o + j];
    if (dot <= floor && best.length >= k) continue;
    best.push([dot / 127, i]);
    if (best.length > k * 4) { best.sort((a, b) => b[0] - a[0]); best.length = k; floor = best[k - 1][0] * 127; }
  }
  return best.sort((a, b) => b[0] - a[0]).slice(0, k);
}

/** OpenAlex topics closest in meaning to the paper (excluding ones it already has). */
export async function relatedTopics(paper, k = 8) {
  await loadMeaning();
  const v = await _vector(`${paper.title}. ${(paper.abstract || '').slice(0, 1200)}`);
  const own = new Set((paper.topics || []).map(t => t.toLowerCase()));
  const dim = _topics.dim, scores = [];
  for (let i = 0; i < _topics.count; i++) {
    let dot = 0;
    const o = i * dim;
    for (let d = 0; d < dim; d++) dot += v[d] * _topicVecs[o + d];
    scores.push([dot / 127, i]);
  }
  return scores.sort((a, b) => b[0] - a[0])
    .filter(([, i]) => !own.has(_topics.name[i].toLowerCase()))
    .slice(0, k)
    .map(([score, i]) => ({ name: _topics.name[i], field: _topics.fields[_topics.field[i]], subfield: _topics.subfields[_topics.subfield[i]], score }));
}

/**
 * Where a paper belongs among the galaxy's papers.
 * Galaxy vectors are title-only, so the new paper is embedded by title too.
 * @returns {{ neighbours: Array<{star, score}>, cluster, confidence, position: {x,y,z} }}
 */
export async function belonging(paper, k = 12) {
  await loadMeaning();
  const near = _nearestPapers(_project(await _vector(paper.title)), k)
    .map(([score, i]) => ({ star: _stars[i], score }))
    .filter(n => n.star);
  if (!near.length) return null;

  // Field = similarity-weighted vote of the neighbours
  const votes = {};
  let sum = 0;
  near.forEach(({ star, score }) => { const w = Math.max(0, score) ** 2; votes[star.cluster] = (votes[star.cluster] || 0) + w; sum += w; });
  const [cluster, weight] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];

  // Position: weighted centre of the closest neighbours in the winning field
  const anchors = near.filter(n => n.star.cluster === cluster).slice(0, 5);
  let x = 0, y = 0, z = 0, w = 0;
  anchors.forEach(({ star, score }) => {
    const p = star._scene || star;
    const s = Math.max(0.05, score) ** 3;
    x += p.x * s; y += p.y * s; z += p.z * s; w += s;
  });
  return { neighbours: near.slice(0, 5), cluster, confidence: sum ? weight / sum : 0, position: { x: x / w, y: y / w, z: z / w } };
}

/** Galaxy papers by meaning. Returns [{ star, score }]. */
export async function semanticSearch(query, k = 30) {
  if (!meaningReady()) return [];
  return _nearestPapers(_project(await _vector(query)), k).map(([score, i]) => ({ star: _stars[i], score }));
}
