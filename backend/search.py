"""
search-comete — search.py
All Elasticsearch query logic, isolated from the FastAPI routes.

Field mapping is now handled entirely by the Pydantic V2 models in models.py.
This file passes raw ES source dicts directly to the model constructors;
the normalise_fields validator handles any legacy alias names.
"""

from __future__ import annotations
import asyncio
from elasticsearch import AsyncElasticsearch
from .models import SearchResult, StarPoint, SimilarPaper, PaperDetail

# ── Lazy sentence-transformer singleton ──────────────────────────────────────
_embed_model = None

def _get_embed_model():
    global _embed_model
    if _embed_model is None:
        try:
            from sentence_transformers import SentenceTransformer
            _embed_model = SentenceTransformer('all-MiniLM-L6-v2')
            print('[search] Loaded all-MiniLM-L6-v2 for RRF hybrid search')
        except Exception as e:
            print(f'[search] sentence-transformers unavailable: {e}')
    return _embed_model

INDEX = "knowledge_galaxy"


async def rrf_search(
    es: AsyncElasticsearch,
    query: str,
    size: int = 20,
    cluster: str | None = None,
    rrf_k: int = 60,
) -> tuple[str, int, list[SearchResult]]:
    """
    Reciprocal Rank Fusion of BM25 + kNN results.
    Returns (mode, total_hits, results) where mode is 'rrf' or 'bm25'.
    Falls back to text_search() if embedding model is unavailable.
    """
    model = _get_embed_model()
    if model is None:
        total, results = await text_search(es, query, size=size, cluster=cluster)
        return 'bm25', total, results

    # Encode query in a thread pool so we don't block the event loop
    loop = asyncio.get_event_loop()
    vector = await loop.run_in_executor(None, lambda: model.encode(query).tolist())

    filters = []
    if cluster:
        # Accept both canonical and legacy cluster field name
        filters.append({"bool": {"should": [
            {"term": {"cluster":    cluster}},
            {"term": {"cluster_id": cluster}},
        ]}})

    base_query = {
        "bool": {
            "should": [
                {"match": {"title":    {"query": query, "boost": 2.5}}},
                {"match": {"abstract": {"query": query, "boost": 1.0}}},
            ],
            "filter": filters,
            "minimum_should_match": 1,
        }
    }
    bm25_body = {
        "query": base_query,
        "size": size * 3,
        "_source": {"excludes": ["embedding"]},
    }
    knn_body = {
        "knn": {
            "field": "embedding",
            "query_vector": vector,
            "k": size * 3,
            "num_candidates": max(100, size * 10),
        },
        "_source": {"excludes": ["embedding"]},
        "size": size * 3,
    }
    if filters:
        knn_body["knn"]["filter"] = filters[0]

    # Run both searches in parallel
    bm25_resp, knn_resp = await asyncio.gather(
        es.search(index=INDEX, body=bm25_body),
        es.search(index=INDEX, body=knn_body),
    )

    # Build RRF scores: score(d) = Σ 1/(k + rank)
    rrf_scores: dict[str, float] = {}
    docs: dict[str, dict] = {}

    for rank, hit in enumerate(bm25_resp["hits"]["hits"]):
        doc_id = hit["_source"]["id"]
        rrf_scores[doc_id] = rrf_scores.get(doc_id, 0.0) + 1.0 / (rrf_k + rank + 1)
        docs[doc_id] = hit["_source"]

    for rank, hit in enumerate(knn_resp["hits"]["hits"]):
        doc_id = hit["_source"]["id"]
        rrf_scores[doc_id] = rrf_scores.get(doc_id, 0.0) + 1.0 / (rrf_k + rank + 1)
        docs[doc_id] = hit["_source"]

    # Sort by RRF score descending, take top `size`
    sorted_ids = sorted(rrf_scores, key=lambda d: rrf_scores[d], reverse=True)[:size]
    max_rrf = rrf_scores[sorted_ids[0]] if sorted_ids else 1.0

    results = []
    for doc_id in sorted_ids:
        s = docs[doc_id]
        results.append(SearchResult(
            **s,
            score=round(rrf_scores[doc_id] / max_rrf, 3),
        ))

    total = len(rrf_scores)  # approx combined unique hits
    return 'rrf', total, results


async def text_search(
    es: AsyncElasticsearch,
    query: str,
    size: int = 20,
    cluster: str | None = None,
) -> tuple[int, list[SearchResult]]:
    """
    BM25 text search fallback.
    Returns (total_hits, results).
    """
    filters = []
    if cluster:
        filters.append({"bool": {"should": [
            {"term": {"cluster":    cluster}},
            {"term": {"cluster_id": cluster}},
        ]}})

    body = {
        "query": {
            "bool": {
                "should": [
                    {"match": {"title":    {"query": query, "boost": 2.5}}},
                    {"match": {"abstract": {"query": query, "boost": 1.0}}},
                ],
                "filter": filters,
                "minimum_should_match": 1,
            }
        },
        "size": size,
        "_source": {"excludes": ["embedding"]},
    }

    resp = await es.search(index=INDEX, body=body)
    max_score = resp["hits"]["max_score"] or 1.0

    results = []
    for h in resp["hits"]["hits"]:
        results.append(SearchResult(
            **h["_source"],
            score=round(h["_score"] / max_score, 3),
        ))
    return resp["hits"]["total"]["value"], results


async def get_all_stars(
    es: AsyncElasticsearch,
    cluster: str | None = None,
) -> list[StarPoint]:
    """
    Returns every paper's lightweight star data for the galaxy render.
    Uses search_after pagination to handle datasets beyond the 10k hit window.
    """
    if cluster:
        query = {"bool": {"should": [
            {"term": {"cluster":    cluster}},
            {"term": {"cluster_id": cluster}},
        ]}}
    else:
        query = {"match_all": {}}

    source_fields = [
        "id", "title", "authors", "year",
        "cite", "citations",
        "cluster", "cluster_id",
        "color", "cluster_color",
        "x", "y", "z",
        "pos_x", "pos_y", "pos_z",
    ]
    results = []
    search_after = None
    page_size = 1000

    while True:
        body = {
            "query": query,
            "size": page_size,
            "sort": [{"_id": "asc"}],
            "_source": source_fields,
        }
        if search_after:
            body["search_after"] = search_after

        resp = await es.search(index=INDEX, body=body)
        hits = resp["hits"]["hits"]
        if not hits:
            break

        for h in hits:
            results.append(StarPoint(**h["_source"]))

        if len(hits) < page_size:
            break
        search_after = hits[-1]["sort"]

    return results


async def get_paper_with_similar(
    es: AsyncElasticsearch,
    paper_id: str,
    k: int = 6,
) -> PaperDetail | None:
    """
    Fetch a paper by its 'id' field value, then run kNN to find similar papers.
    """
    search_resp = await es.search(
        index=INDEX,
        body={
            "query": {"term": {"id": paper_id}},
            "size": 1,
        },
    )
    hits = search_resp["hits"]["hits"]
    if not hits:
        return None

    src = hits[0]["_source"]
    embedding = src.get("embedding", [])
    similar: list[SimilarPaper] = []

    if embedding:
        try:
            knn_resp = await es.search(
                index=INDEX,
                body={
                    "knn": {
                        "field":          "embedding",
                        "query_vector":   embedding,
                        "k":              k + 1,
                        "num_candidates": 50,
                    },
                    "_source": {"excludes": ["embedding"]},
                    "size": k + 1,
                },
            )
            for hit in knn_resp["hits"]["hits"]:
                s = hit["_source"]
                if s["id"] != paper_id:
                    similar.append(SimilarPaper(**s))
        except Exception as e:
            print(f"[search] kNN lookup failed for {paper_id}: {e}")

    return PaperDetail(
        **src,
        similar=similar[:k],
    )


async def get_cluster_stats(es: AsyncElasticsearch) -> dict:
    """Aggregations used by the legend to show paper counts per cluster."""
    resp = await es.search(
        index=INDEX,
        body={
            "size": 0,
            "aggs": {
                "by_cluster": {
                    "terms": {"field": "cluster_id", "size": 20},
                    "aggs": {
                        "label":       {"terms": {"field": "cluster_label", "size": 1}},
                        "color":       {"terms": {"field": "cluster_color",  "size": 1}},
                        "avg_year":    {"avg":   {"field": "year"}},
                        "total_cites": {"sum":   {"field": "citations"}},
                    },
                }
            },
        },
    )
    clusters = []
    for b in resp["aggregations"]["by_cluster"]["buckets"]:
        clusters.append({
            "id":          b["key"],
            "label":       b["label"]["buckets"][0]["key"] if b["label"]["buckets"] else b["key"],
            "color":       b["color"]["buckets"][0]["key"] if b["color"]["buckets"] else "#ffffff",
            "count":       b["doc_count"],
            "avg_year":    round(b["avg_year"]["value"] or 0),
            "total_cites": int(b["total_cites"]["value"]),
        })
    return {"clusters": clusters}