"""
search-comete — backend/main.py
FastAPI app. Routes only — query logic lives in search.py.
Run: uvicorn backend.main:app --reload --port 8000
"""

from fastapi import FastAPI, Query, HTTPException, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from elasticsearch import AsyncElasticsearch
from typing import Optional
import os

from .models import SearchResponse, PaperDetail
from . import search as es_search

app = FastAPI(title="search-comete API — Noosphere Edition", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Elasticsearch client ──────────────────────────────────────────────────────
ES_HOST     = os.getenv("ES_HOST",     "http://localhost:9200")
ES_CLOUD_ID = os.getenv("ES_CLOUD_ID", "")
ES_API_KEY  = os.getenv("ES_API_KEY",  "")

def _make_es_client() -> AsyncElasticsearch:
    if ES_CLOUD_ID and ES_API_KEY:
        return AsyncElasticsearch(cloud_id=ES_CLOUD_ID, api_key=ES_API_KEY)
    return AsyncElasticsearch(ES_HOST)

es = _make_es_client()

# ── Static stars.json ─────────────────────────────────────────────────────────
_stars_path = os.path.join(os.path.dirname(__file__), '..', 'pipeline', 'stars.json')

@app.get("/stars.json")
async def stars_json():
    if os.path.exists(_stars_path):
        return FileResponse(_stars_path, media_type="application/json")
    raise HTTPException(status_code=404, detail="stars.json not yet generated — run the pipeline first")

# ── Route factory — registers each route at both /xxx and /api/xxx ────────────
def _make_router(prefix: str) -> APIRouter:
    router = APIRouter(prefix=prefix)

    @router.get("/health")
    async def health():
        try:
            info = await es.info()
            return {"status": "ok", "es_version": info["version"]["number"]}
        except Exception as e:
            return {"status": "degraded", "error": str(e)}

    @router.get("/search")
    async def search(
        q:       str           = Query(..., description="Search query"),
        size:    int           = Query(20, ge=1, le=100),
        cluster: Optional[str] = Query(None),
    ):
        try:
            mode, total, results = await es_search.rrf_search(es, q, size=size, cluster=cluster)
            return {
                "total": total,
                "results": [r.model_dump() for r in results],
                "query": q,
                "mode": mode,
            }
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    @router.get("/stars")
    async def stars_dynamic(cluster: Optional[str] = Query(None)):
        """Live star list from ES — always reflects the full current index."""
        try:
            data = await es_search.get_all_stars(es, cluster=cluster)
            return [s.model_dump() for s in data]
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    @router.get("/paper/{paper_id:path}", response_model=PaperDetail)
    async def paper(paper_id: str):
        result = await es_search.get_paper_with_similar(es, paper_id)
        if not result:
            raise HTTPException(status_code=404, detail=f"Paper not found: {paper_id}")
        return result

    @router.get("/stats")
    async def stats():
        try:
            return await es_search.get_cluster_stats(es)
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    return router

# Register routes at both / and /api/ so old and new frontend files both work
app.include_router(_make_router(prefix=""))
app.include_router(_make_router(prefix="/api"))