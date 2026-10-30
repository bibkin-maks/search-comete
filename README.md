# search-comète

> Navigate the universe of ideas. Every paper is a star.

A 3D map of 54,190 research papers across 15 fields. Each paper's title and abstract were embedded with `all-MiniLM-L6-v2`, squashed to 3D with UMAP, and drawn as a star in Three.js, so papers that mean similar things sit close together. You can fly around, search the map, or search all of OpenAlex (250M+ works) live and watch new papers appear as visitor stars next to their closest neighbours.

Built at Unihack 2026 (March 13-15).

---

## Features

- **The galaxy** - 54k papers in one GPU draw call. Star size = citations. Highly cited papers get animated plasma orbs when you zoom in, and the 50 most cited ones are black holes with accretion disks.
- **Search this galaxy** - instant in-browser TF-IDF search over titles. Hits light up and the camera flies to the best match.
- **Live search** - the `LIVE` toggle also queries [OpenAlex](https://openalex.org). Results that are already mapped light up; new ones show up as gold-ringed visitor orbs placed near the mapped papers they most resemble.
- **Paper panel** - real abstract (from OpenAlex), Google Scholar / DOI / PDF / OpenAlex links, and the nearest papers in the map.
- **Time travel** - year slider hides everything published after the chosen year.
- **Comets, sounds, light mode (wormhole button), pinned stars, meteor of the day.**
- **Shareable links** - `?q=protein+folding&paper=W3177318507`. Press `/` to search, `Esc` to close the panel.

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

Fetches papers from OpenAlex (or `--use-ss` / `--use-arxiv`), embeds them, runs UMAP, and writes `frontend/public/galaxy.json`. To convert an existing `stars.json` by hand: `python -m pipeline.compact_stars in.json out.json`.

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
  galaxy.js       Three.js scene, star field shader, camera, picking
  orb.js          detailed hero orbs (plasma stars, black holes, visitors)
  search.js       in-browser search index
  live.js         OpenAlex live search + abstracts
  panel.js        paper detail panel
  comet.js        comets flying across the galaxy
  postfx.js       bloom + lens effects
  sound.js, sonification.js, wormhole.js
backend/          FastAPI + Elasticsearch (optional)
pipeline/         fetch -> embed -> UMAP -> index -> galaxy.json
```

## Notes

- OpenAlex is free and needs no key, but each visitor's IP gets a small daily budget (around 100 searches). When it runs out the UI says so and offers a Google Scholar link instead.
- Google Scholar has no public API, so Scholar is linked, not searched.

Built with [Three.js](https://threejs.org) · [OpenAlex](https://openalex.org) · [sentence-transformers](https://sbert.net) · [UMAP](https://umap-learn.readthedocs.io) · [Elasticsearch](https://elastic.co) · [FastAPI](https://fastapi.tiangolo.com)
