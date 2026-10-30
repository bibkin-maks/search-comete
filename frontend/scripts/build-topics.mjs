// Build the topic classifier data: every OpenAlex topic, embedded with the
// same small model the browser uses (all-MiniLM-L6-v2), so a paper can be
// matched to topics by meaning.
//
//   node scripts/build-topics.mjs
//   MODELS_DIR=/path/to/local/models node scripts/build-topics.mjs   (offline copy)
//
// Writes public/topics.json (names, fields) and public/topics.bin (int8 vectors).

import { pipeline, env } from '@huggingface/transformers';
import { writeFileSync } from 'node:fs';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const OUT = new URL('../public/', import.meta.url);

if (process.env.MODELS_DIR) {
  env.localModelPath = process.env.MODELS_DIR;
  env.allowRemoteModels = false;
}

async function fetchTopics() {
  const all = [];
  for (let page = 1; ; page++) {
    const url = `https://api.openalex.org/topics?per_page=200&page=${page}&select=id,display_name,description,keywords,subfield,field,works_count`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OpenAlex ${res.status}`);
    const data = await res.json();
    all.push(...data.results);
    process.stdout.write(`\r  topics: ${all.length}/${data.meta.count}`);
    if (all.length >= data.meta.count || !data.results.length) break;
  }
  console.log();
  return all;
}

const topics = await fetchTopics();
const embed = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });

const dim = 384;
const vectors = new Int8Array(topics.length * dim);
const texts = topics.map(t =>
  `${t.display_name}. ${t.description || ''} Keywords: ${(t.keywords || []).map(k => k.display_name ?? k).join(', ')}`);

for (let i = 0; i < texts.length; i += 64) {
  const out = await embed(texts.slice(i, i + 64), { pooling: 'mean', normalize: true });
  const data = out.data;
  for (let j = 0; j < data.length; j++) vectors[i * dim + j] = Math.max(-127, Math.min(127, Math.round(data[j] * 127)));
  process.stdout.write(`\r  embedded: ${Math.min(i + 64, texts.length)}/${texts.length}`);
}
console.log();

const fields = [...new Set(topics.map(t => t.field?.display_name || ''))];
const subfields = [...new Set(topics.map(t => t.subfield?.display_name || ''))];
writeFileSync(new URL('topics.json', OUT), JSON.stringify({
  model: MODEL, dim, count: topics.length, fields, subfields,
  id: topics.map(t => t.id.split('/').pop()),
  name: topics.map(t => t.display_name),
  field: topics.map(t => fields.indexOf(t.field?.display_name || '')),
  subfield: topics.map(t => subfields.indexOf(t.subfield?.display_name || '')),
  works: topics.map(t => t.works_count || 0),
}));
writeFileSync(new URL('topics.bin', OUT), Buffer.from(vectors.buffer));
console.log(`  wrote topics.json + topics.bin (${(vectors.length / 1048576).toFixed(1)} MB)`);
