/**
 * search-comete - live.js
 * Live search across the whole scholarly record via OpenAlex (250M+ works,
 * free, CORS-enabled, no key needed). Google Scholar has no public API and
 * blocks automated requests, so for Scholar we only build outbound links.
 *
 * Without an API key each visitor's IP gets a small free daily budget
 * (roughly 100 searches), which is plenty for browsing.
 */

import { OPENALEX } from './config.js';

const WORK_FIELDS = [
  'id', 'display_name', 'publication_year', 'cited_by_count', 'doi',
  'authorships', 'primary_location', 'best_oa_location', 'open_access',
  'primary_topic', 'abstract_inverted_index',
].join(',');

const _workCache = new Map();

export class LiveSearchError extends Error {
  constructor(message, { rateLimited = false } = {}) {
    super(message);
    this.rateLimited = rateLimited;
  }
}

async function _get(url, timeoutMs = 8000) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new LiveSearchError(e.name === 'TimeoutError' ? 'OpenAlex timed out' : 'OpenAlex unreachable');
  }
  if (res.status === 429) throw new LiveSearchError('Daily free OpenAlex budget used up', { rateLimited: true });
  if (!res.ok) throw new LiveSearchError(`OpenAlex error ${res.status}`);
  return res.json();
}

/** Search all of OpenAlex. Returns { total, results: Paper[] }. */
export async function searchLive(query, perPage = 12) {
  const url = `${OPENALEX}/works?search=${encodeURIComponent(query)}&per_page=${perPage}&select=${WORK_FIELDS}`;
  const data = await _get(url);
  const results = (data.results || []).map(toPaper);
  results.forEach(p => _workCache.set(p.id, p));
  return { total: data.meta?.count ?? results.length, results };
}

/** Full record for one work (abstract, DOI, PDF...). id = OpenAlex URL or W-id. */
export async function getWork(id) {
  const key = String(id).startsWith('http') ? String(id) : `https://openalex.org/${id}`;
  const cached = _workCache.get(key);
  if (cached?.abstract !== undefined) return cached;
  const wid = key.split('/').pop();
  const paper = toPaper(await _get(`${OPENALEX}/works/${wid}?select=${WORK_FIELDS}`));
  _workCache.set(key, paper);
  return paper;
}

export function isOpenAlexId(id) {
  return /^https:\/\/openalex\.org\/W\d+$/.test(String(id));
}

export function scholarUrl(title) {
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(`"${title}"`)}`;
}

export function toPaper(w) {
  const authors = (w.authorships || []).map(a => a.author?.display_name).filter(Boolean);
  const topic   = w.primary_topic;
  return {
    id:       w.id,
    title:    stripTags(w.display_name || 'Untitled'),
    authors:  authors.length > 3 ? `${authors.slice(0, 3).join(', ')} et al.` : authors.join(', '),
    year:     w.publication_year,
    cite:     w.cited_by_count ?? 0,
    doi:      w.doi || null,
    venue:    w.primary_location?.source?.display_name || '',
    pdfUrl:   w.best_oa_location?.pdf_url || null,
    oaUrl:    w.open_access?.oa_url || w.best_oa_location?.landing_page_url || null,
    field:    topic?.field?.display_name || '',
    subfield: topic?.subfield?.display_name || '',
    topic:    topic?.display_name || '',
    abstract: w.abstract_inverted_index === undefined ? undefined : rebuildAbstract(w.abstract_inverted_index),
    cluster:  clusterForTopic(topic),
    live:     true,
  };
}

// OpenAlex ships abstracts as { word: [positions] } - put the words back in order
export function rebuildAbstract(inverted) {
  if (!inverted) return '';
  const words = [];
  Object.entries(inverted).forEach(([word, positions]) => positions.forEach(p => { words[p] = word; }));
  return words.filter(Boolean).join(' ');
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, '');
}

// OpenAlex field / subfield -> our 15 galaxy clusters
const SUBFIELD_TO_CLUSTER = {
  'Artificial Intelligence': 'ml',
  'Computer Vision and Pattern Recognition': 'ml',
  'Astronomy and Astrophysics': 'astro',
  'Cognitive Neuroscience': 'neuro',
};
const FIELD_TO_CLUSTER = {
  'Computer Science': 'cs',
  'Mathematics': 'math',
  'Physics and Astronomy': 'phys',
  'Chemistry': 'chem',
  'Chemical Engineering': 'chem',
  'Biochemistry, Genetics and Molecular Biology': 'bio',
  'Agricultural and Biological Sciences': 'bio',
  'Immunology and Microbiology': 'bio',
  'Neuroscience': 'neuro',
  'Medicine': 'med',
  'Pharmacology, Toxicology and Pharmaceutics': 'med',
  'Nursing': 'med', 'Health Professions': 'med', 'Dentistry': 'med', 'Veterinary': 'med',
  'Materials Science': 'mat',
  'Engineering': 'eng', 'Energy': 'eng',
  'Environmental Science': 'env', 'Earth and Planetary Sciences': 'env',
  'Economics, Econometrics and Finance': 'econ',
  'Business, Management and Accounting': 'econ', 'Decision Sciences': 'econ',
  'Psychology': 'psych',
  'Social Sciences': 'edu', 'Arts and Humanities': 'edu',
};

export function clusterForTopic(topic) {
  if (!topic) return '';
  return SUBFIELD_TO_CLUSTER[topic.subfield?.display_name]
      || FIELD_TO_CLUSTER[topic.field?.display_name]
      || '';
}
