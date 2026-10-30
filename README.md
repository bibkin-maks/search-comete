# search-comète

> Navigate the universe of ideas. Every paper is a star.

A 3D map of 54,190 research papers across 15 fields. Each paper's title and abstract were embedded with `all-MiniLM-L6-v2`, squashed to 3D with UMAP, and drawn as a star in Three.js, so papers that mean similar things sit close together. Fly around, search it by words or meaning, search all of OpenAlex live, grow citation trees from any paper, tie ropes between papers to see how they relate, or start from an empty sky and build your own universe.

Built at Unihack 2026 (March 13-15).

---

## Features

- **The galaxy** - 54k papers in one GPU draw call, laid out so stars don't overlap (each field scaled by its bulk, dense cores evened out, overlapping stars relaxed apart). Size = citations. Zoom in on a highly cited paper to see its plasma orb; the 50 most cited are black holes. Deep-space sky, drifting dust and floating field labels.
- **Search** - words (TF-IDF) plus meaning: a small embedding model (all-MiniLM-L6-v2, ~23 MB, runs in the browser) matches your query against every paper. `LIVE` also searches all of [OpenAlex](https://openalex.org) (250M+ works); new papers are placed **where they belong by meaning** among the 54k.
- **Citation tree** - from any paper, grow its references (down, the past) or the papers citing it (up, the future), 1-3 levels at a time. Height is time. Expand any paper in the tree to keep growing it; prune branches; the tree is saved.
- **Pins and ropes** - pin papers, tie a rope between two, and get a relatedness score from map distance, shared references, papers citing both, direct citation and shared topics. An optional small LLM (LFM2.5 350M on WebGPU, SmolLM2 360M on CPU) writes a short take, labelled as possibly wrong.
- **Related topics** - OpenAlex topics and keywords, plus the closest of all 4,516 OpenAlex research topics by meaning (embedding classifier).
- **My universe** - start from an empty sky and grow your own map by searching. Everything you find, pin or grow stays, placed by meaning; the full galaxy is faint dust underneath.
- **Timeline** - papers-per-year histogram; scrub or press play to watch fields appear. Applies to everything, including tree nodes and ropes.
- **Paper dossier** - real abstract, Google Scholar / DOI / PDF / OpenAlex links, nearest papers in the map, and for outside papers, which field they belong to and their closest galaxy papers.
- Shareable links (`?q=...&paper=W...&mode=universe`), `/` to search, `Esc` to close, light mode, comets, sound.

## Quick start

The site is fully static: no backend needed.

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in frontend/dist (deploys to Vercel as-is)
```

It loads `frontend/public/galaxy.json` (9 MB, ~3 MB gzipped, cached after the first visit). If that's missing it falls back to 31 bundled papers.

## Rebuilding the data

```bash
pip install -r pipeline/requirements.txt
python -m pipeline.run --limit 20            # quick test, ~500 papers
python -m pipeline.run                       # full run, 200 papers/topic
python -m pipeline.run --skip-index          # without Elasticsearch
```

Fetches papers from OpenAlex (or `--use-ss` / `--use-arxiv`), embeds them, runs UMAP, lays them out (`pipeline/layout.py`) and writes `frontend/public/galaxy.json`. To re-run only the layout on a raw `stars.json`: `python -m pipeline.compact_stars stars.json frontend/public/galaxy.json`.

Then the files the in-browser model uses (same model as the browser, all-MiniLM-L6-v2):

```bash
cd frontend
node scripts/build-topics.mjs     # public/topics.json + topics.bin (4,516 OpenAlex topics, 1.7 MB)
node scripts/build-vectors.mjs    # public/vectors.json + vectors.bin (54k papers, PCA 64-d int8, 3.3 MB)
```

These are only downloaded when someone searches or asks for related topics, not on page load.

## Optional: Elasticsearch backend

The original hackathon version served search from FastAPI + Elasticsearch (BM25 + kNN with RRF). It still works if you want it:

```bash
cp .env.example .env
docker compose up elasticsearch
python -m pipeline.run --limit 20
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --port 8000
VITE_USE_BACKEND=1 npm run dev --prefix frontend
```

| Endpoint          | ES feature                            |
|-------------------|---------------------------------------|
| `GET /search`     | BM25 `multi_match` + kNN, fused (RRF) |
| `GET /paper/:id`  | `knn` on the `dense_vector` field     |
| `GET /stars`      | `match_all` with `search_after`       |
| `GET /stats`      | `terms` + `avg` + `sum` aggregations  |

## Project structure

```
frontend/src/
  main.js         UI shell, data loading, search flow, URLs
  styles.css      the interface
  galaxy.js       Three.js scene, star field shader, camera, picking
  orb.js          detailed orbs (plasma stars, black holes, visitors)
  space.js        sky, dust, distant galaxies
  links.js        ropes (citation tree, pinned papers)
  hud.js          field labels, sector readout, timeline
  workspace.js    left dock: fields, pins + rope analysis, tree outline
  tree.js         the citation tree and its layout
  graph.js        OpenAlex citation tracing + paper comparison
  universe.js     "my universe" mode
  meaning.js      embedding model: topics, belonging, semantic search
  llm.js          small on-device LLM for rope explanations
  search.js       word search index
  live.js         OpenAlex API
  panel.js        paper dossier
  comet.js, postfx.js, sound.js, sonification.js, wormhole.js
frontend/scripts/ build-topics.mjs, build-vectors.mjs
backend/          FastAPI + Elasticsearch (optional)
pipeline/         fetch -> embed -> UMAP -> layout -> galaxy.json
```

## Notes

- OpenAlex is free and needs no key, but each visitor's IP gets a small daily budget (around 100 searches). When it runs out the UI says so and offers a Google Scholar link instead.
- Google Scholar has no public API, so Scholar is linked, not searched.
- The AI parts run entirely in the visitor's browser (transformers.js); nothing is sent to an AI service. Small models can be wrong and the UI says so; the facts (references, citations, topics) come from OpenAlex.

Built with [Three.js](https://threejs.org) · [OpenAlex](https://openalex.org) · [sentence-transformers](https://sbert.net) · [UMAP](https://umap-learn.readthedocs.io) · [Elasticsearch](https://elastic.co) · [FastAPI](https://fastapi.tiangolo.com)
