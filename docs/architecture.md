# search-comete - Architecture

## Overview

```
search-comete/
├── frontend/          # Vite + Three.js - the 3D galaxy UI
├── backend/           # FastAPI - search API over Elasticsearch
├── pipeline/          # One-time data processing: fetch → embed → UMAP → index
└── docs/              # This file
```

## Data flow

```
Semantic Scholar API / arXiv
        │
        ▼
  pipeline/fetch.py       - HTTP → structured paper dicts
        │
        ▼
  pipeline/embed.py       - sentence-transformers → (N, 384) float32 array
        │
        ▼
  pipeline/umap_reduce.py - UMAP → (N, 3) x/y/z coords
        │
        ├──► pipeline/stars.json   - lightweight positions for frontend
        │
        └──► Elasticsearch index   - full docs + embeddings for kNN search
                    │
                    ▼
             backend/main.py       - FastAPI routes
             backend/search.py     - ES query logic
                    │
                    ▼
             frontend/src/main.js  - loads stars, wires UI
             frontend/src/galaxy.js - Three.js scene
             frontend/src/search.js - search → highlight stars
             frontend/src/panel.js  - detail panel
```

## Elasticsearch index: `knowledge_galaxy`

| Field          | Type           | Purpose                                  |
|----------------|----------------|------------------------------------------|
| `id`           | keyword        | Semantic Scholar paper ID                |
| `title`        | text           | Full-text search                         |
| `abstract`     | text           | Full-text search                         |
| `authors`      | text           | Display                                  |
| `year`         | integer        | Display / filter                         |
| `citations`    | integer        | Star size in Three.js                    |
| `cluster_id`   | keyword        | ml / bio / phys / cs / math              |
| `cluster_label`| keyword        | Display label                            |
| `cluster_color`| keyword        | Hex colour for Three.js material         |
| `pos_x/y/z`    | float          | Pre-computed UMAP coords for Three.js    |
| `embedding`    | dense_vector   | 384-dim for kNN search                   |

## Search strategy

1. **Text search** (`/search`): BM25 over `title` (boost 2.5×) + `abstract`
2. **kNN similar papers** (`/paper/:id`): cosine similarity on `embedding` field,
   filtered to same cluster, returns 6 nearest neighbours

## Running locally

```bash
# 1 - Elasticsearch
docker compose up elasticsearch

# 2 - Pipeline (test run: 20 papers/topic ≈ 5 min)
pip install -r pipeline/requirements.txt
python -m pipeline.run --limit 20

# 3 - Backend
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --port 8000

# 4 - Frontend
cd frontend
npm install
npm run dev
# → http://localhost:5173
```

## Scaling

| Papers | Pipeline time | stars.json | Notes                        |
|--------|--------------|------------|------------------------------|
| ~500   | 3 min        | ~200 KB    | Good for quick tests         |
| ~5,000 | 30 min       | ~2 MB      | Hackathon demo sweet spot    |
| ~50,000| ~5 hrs       | ~20 MB     | Load stars in chunks via API |
