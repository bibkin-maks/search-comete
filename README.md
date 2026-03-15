# search-comète

> Navigate the universe of ideas. Every paper is a star.

A 3D semantic search engine for academic papers. Papers are embedded with Elasticsearch ELSER, reduced to 3D coordinates via UMAP, and rendered as an interactive star galaxy in Three.js. Proximity = semantic similarity.

---

## Quick start

### Option A - Frontend only (no setup needed)

```bash
cd frontend
npm install
npm run dev
```

Opens at `http://localhost:5173` with 31 bundled papers. No backend or Elasticsearch required - great for the demo.

### Option B - Full stack with real data

```bash
# 1. Start Elasticsearch
docker compose up elasticsearch

# 2. Run the pipeline (test: ~500 papers, ~5 min)
pip install -r pipeline/requirements.txt
python -m pipeline.run --limit 20

# 3. Start the backend
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --port 8000

# 4. Start the frontend
cd frontend && npm install && npm run dev
```

The frontend auto-detects the backend. If it's not running, it falls back to bundled data seamlessly.

---

## Project structure

```
search-comete/
├── frontend/
│   ├── src/
│   │   ├── main.js        - app entry, UI shell, wires modules
│   │   ├── galaxy.js      - Three.js scene, orbit, raycasting
│   │   ├── search.js      - API calls + local fallback search
│   │   ├── panel.js       - detail panel UI
│   │   └── data.js        - bundled fallback papers + keyword map
│   ├── public/
│   │   └── index.html
│   ├── package.json
│   └── vite.config.js
│
├── backend/
│   ├── main.py            - FastAPI routes
│   ├── search.py          - Elasticsearch query logic
│   ├── models.py          - Pydantic models
│   ├── requirements.txt
│   └── Dockerfile
│
├── pipeline/
│   ├── run.py             - orchestrates all steps
│   ├── fetch.py           - Semantic Scholar / arXiv APIs
│   ├── embed.py           - sentence-transformers embeddings
│   ├── umap_reduce.py     - UMAP 384d → 3d
│   ├── index.py           - Elasticsearch bulk indexing
│   └── requirements.txt
│
├── docs/
│   └── architecture.md
│
├── docker-compose.yml
├── .env.example
├── .gitignore
└── README.md
```

---

## How it works

1. **Fetch** - `pipeline/fetch.py` pulls papers from [Semantic Scholar](https://api.semanticscholar.org/) (free, no key) or arXiv across 25 topic queries covering ML, biology, physics, CS, and mathematics.

2. **Embed** - `pipeline/embed.py` runs each paper's title + abstract through `all-MiniLM-L6-v2` (sentence-transformers), producing a 384-dimensional meaning vector per paper.

3. **UMAP** - `pipeline/umap_reduce.py` compresses those 384 dimensions down to 3 (x, y, z). Papers that mean similar things end up physically close - the cluster structure emerges automatically from the data.

4. **Index** - `pipeline/index.py` bulk-indexes everything into Elasticsearch with the `dense_vector` field type enabled for kNN search.

5. **Search** - `backend/search.py` runs BM25 text search on title/abstract for keyword queries, and kNN cosine similarity on the embedding field for "similar papers" lookups.

6. **Render** - `frontend/src/galaxy.js` places a Three.js sphere at each paper's (x, y, z) position, sized by citation count, coloured by cluster. You orbit with your mouse, click stars to open the detail panel, and search to highlight matching papers and warp the camera to the result cluster.

---

## Elasticsearch API used

| Endpoint          | ES feature                                  |
|-------------------|---------------------------------------------|
| `GET /search`     | BM25 `multi_match` with field boosting      |
| `GET /paper/:id`  | `knn` query on `dense_vector` field         |
| `GET /stars`      | `match_all` + `_source` filtering           |
| `GET /stats`      | `terms` + `avg` + `sum` aggregations        |

---

## Pipeline options

```bash
# Quick test (20 papers/topic ≈ 500 total, ~5 min)
python -m pipeline.run --limit 20

# Full run (200 papers/topic ≈ 5,000 total, ~30 min)
python -m pipeline.run

# Use arXiv instead of Semantic Scholar
python -m pipeline.run --use-arxiv

# Skip re-fetching, re-run embed + UMAP + index
python -m pipeline.run --skip-fetch

# Skip everything except exporting stars.json
python -m pipeline.run --skip-fetch --skip-embed --skip-umap --skip-index
```

---

## Environment variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable       | Default                    | Description               |
|----------------|----------------------------|---------------------------|
| `ES_HOST`      | `http://localhost:9200`    | Local Elasticsearch URL   |
| `ES_CLOUD_ID`  | -                          | Elastic Cloud deployment  |
| `ES_API_KEY`   | -                          | Elastic Cloud API key     |

---

Built with [Elasticsearch](https://elastic.co) · [Three.js](https://threejs.org) · [sentence-transformers](https://sbert.net) · [UMAP](https://umap-learn.readthedocs.io) · [FastAPI](https://fastapi.tiangolo.com)
