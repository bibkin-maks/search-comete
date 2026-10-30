/**
 * search-comete - graph.js
 * Citation webs and paper comparisons from OpenAlex.
 *
 * Tracing references n levels deep would explode (40 refs → 1,600 → 64,000),
 * so each level keeps the papers most *shared* by the previous level: a
 * paper referenced by 9 of your 30 references is part of the foundation,
 * one referenced once usually isn't. That keeps a 3-level web to ~5
 * requests and ~140 papers.
 */

import { getWork, getWorks, getCitingWorks, countCitingBoth } from './live.js';

const LEVEL_CAP    = [80, 36, 24];   // papers kept per level
const FRONTIER_CAP = [30, 20];       // papers expanded from level 1 / level 2

/**
 * @returns {{ root, nodes: Map<id,{paper,depth,votes}>, edges: Array<{from,to,depth}>, direction }}
 */
export async function traceReferences(rootId, depth = 2, onProgress, { limit } = {}) {
  onProgress?.('Reading the paper…');
  const root = await getWork(rootId);
  const nodes = new Map([[root.id, { paper: root, depth: 0, votes: 0 }]]);
  const edges = [];
  let frontier = [root];

  for (let d = 1; d <= depth && frontier.length; d++) {
    const votes = new Map();
    frontier.forEach(p => (p.refs || []).forEach(ref => {
      if (nodes.has(ref)) {
        // Cross-link back into the web (keeps the structure, not new papers)
        if (nodes.get(ref).depth > 0 && edges.length < 600) edges.push({ from: p.id, to: ref, depth: d, cross: true });
        return;
      }
      let v = votes.get(ref);
      if (!v) votes.set(ref, v = { count: 0, parents: [] });
      v.count++;
      v.parents.push(p.id);
    }));
    const picked = [...votes.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, LEVEL_CAP[d - 1]);
    if (!picked.length) break;

    onProgress?.(`Level ${d}: ${picked.length} papers`);
    let papers = await getWorks(picked.map(([id]) => id));
    // With a limit, keep the most shared, then most cited
    if (limit) papers = papers.sort((a, b) => (votes.get(b.id)?.count ?? 0) - (votes.get(a.id)?.count ?? 0) || b.cite - a.cite).slice(0, limit);
    papers.forEach(p => {
      const v = votes.get(p.id);
      if (!v) return;
      nodes.set(p.id, { paper: p, depth: d, votes: v.count });
      v.parents.forEach(parent => edges.push({ from: parent, to: p.id, depth: d }));
    });
    frontier = papers
      .sort((a, b) => (votes.get(b.id)?.count ?? 0) - (votes.get(a.id)?.count ?? 0) || b.cite - a.cite)
      .slice(0, FRONTIER_CAP[d - 1] ?? 0);
  }
  return { root, nodes, edges, direction: 'refs' };
}

/** Who built on this paper: most cited citing papers, then theirs. */
export async function traceCitedBy(rootId, depth = 2, onProgress, { limit } = {}) {
  onProgress?.('Reading the paper…');
  const root = await getWork(rootId);
  const nodes = new Map([[root.id, { paper: root, depth: 0, votes: 0 }]]);
  const edges = [];

  onProgress?.('Level 1: who cites it');
  const first = await getCitingWorks(root.id, limit || 30);
  first.results.forEach(p => {
    nodes.set(p.id, { paper: p, depth: 1, votes: 1 });
    edges.push({ from: root.id, to: p.id, depth: 1 });
  });

  let frontier = first.results.slice(0, 6);
  for (let d = 2; d <= Math.min(depth, 3) && frontier.length; d++) {
    onProgress?.(`Level ${d}: who cites those`);
    const per = d === 2 ? 8 : 5;
    const batches = await Promise.all(frontier.map(p => getCitingWorks(p.id, per).catch(() => ({ results: [] }))));
    const next = [];
    batches.forEach((batch, k) => batch.results.forEach(p => {
      const parent = frontier[k].id;
      if (nodes.has(p.id)) { edges.push({ from: parent, to: p.id, depth: d, cross: true }); return; }
      nodes.set(p.id, { paper: p, depth: d, votes: 1 });
      edges.push({ from: parent, to: p.id, depth: d });
      next.push(p);
    }));
    frontier = next.sort((a, b) => b.cite - a.cite).slice(0, 4);
  }
  return { root, nodes, edges, direction: 'cited', total: first.total };
}

/**
 * Everything we can say for sure about how two papers relate.
 * @param a,b    papers (OpenAlex ids)
 * @param map    { distance, sameField } from the galaxy layout
 */
export async function compareFacts(a, b, map = {}) {
  const [A, B] = await Promise.all([getWork(a.id), getWork(b.id)]);
  const refsA = new Set(A.refs || []), refsB = new Set(B.refs || []);
  const shared = [...refsA].filter(r => refsB.has(r));
  const union = new Set([...refsA, ...refsB]).size;
  const lower = (xs) => new Set((xs || []).map(x => x.toLowerCase()));
  const kwA = lower(A.keywords), kwB = lower(B.keywords);
  const topicsA = new Set(A.topics || []);

  const [coCited, sharedPapers] = await Promise.all([
    countCitingBoth(A.id, B.id).catch(() => null),
    shared.length ? getWorks(shared.slice(0, 4), 'id,display_name,publication_year,cited_by_count').catch(() => []) : [],
  ]);

  const facts = {
    a: A, b: B,
    sharedRefs: shared.length,
    refJaccard: union ? shared.length / union : 0,
    sharedPapers,
    aCitesB: refsA.has(B.id),
    bCitesA: refsB.has(A.id),
    coCited,
    sharedTopics: (B.topics || []).filter(t => topicsA.has(t)),
    sharedKeywords: (B.keywords || []).filter(k => kwA.has(k.toLowerCase())),
    keywordOverlap: kwA.size && kwB.size ? [...kwA].filter(k => kwB.has(k)).length / Math.min(kwA.size, kwB.size) : 0,
    yearGap: A.year && B.year ? Math.abs(A.year - B.year) : null,
    distance: map.distance ?? null,
    sameField: map.sameField ?? null,
  };
  facts.score = relatedness(facts);
  return facts;
}

/** 0-100 blend of the signals; each one capped so no single signal dominates. */
export function relatedness(f) {
  const closeness = f.distance == null ? 0 : f.sameField ? Math.exp(-f.distance / 14) : 0.05;
  const coupling  = Math.min(1, f.sharedRefs / 8);
  const cocite    = f.coCited ? Math.min(1, Math.log10(f.coCited + 1) / 3) : 0;
  const direct    = f.aCitesB || f.bCitesA ? 1 : 0;
  const topical   = Math.min(1, f.sharedTopics.length / 2 * 0.6 + f.keywordOverlap * 0.6);
  const score = 0.28 * closeness + 0.22 * coupling + 0.2 * cocite + 0.15 * direct + 0.15 * topical;
  return Math.round(score * 100);
}
