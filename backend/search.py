"""
search-comete - search.py
All Elasticsearch query logic, isolated from the FastAPI routes.

Fixes applied:
  1. text_search(): maps `cluster_id` → `cluster` and `cluster_color` → `color`
     and `citations` → `cite` in the returned SearchResult so the frontend
     receives the field names it actually uses.
  2. get_all_stars(): same mapping. Also exposes both `cite` and `citations`.
  3. get_paper_with_similar(): maps all fields correctly in PaperDetail.
  4. Added error handling for missing `embedding` field (papers indexed without
     embeddings won't crash the similar-papers lookup).
"""

from elasticsearch import AsyncElasticsearch
from models import SearchResult, StarPoint, SimilarPaper, PaperDetail

INDEX = "knowledge_galaxy"


async def text_search(
    es: AsyncElasticsearch,
    query: str,
    size: int = 20,
    cluster: str | None = None,
) -> tuple[int, list[SearchResult]]:
    """
    Hybrid BM25 + field-boosted search.
    Returns (total_hits, results).
    """
    filters = []
    if cluster:
        filters.append({"term": {"cluster_id": cluster}})

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
        s = h["_source"]
        cite_val = s.get("citations", 0) or s.get("cite", 0) or 0
        results.append(SearchResult(
            id         = s["id"],
            title      = s["title"],
            authors    = s.get("authors", ""),
            year       = s.get("year"),
            # FIX: expose as `cite` - frontend uses this field name
            cite       = cite_val,
            citations  = cite_val,
            abstract   = s.get("abstract", ""),
            # FIX: map cluster_id → cluster, cluster_color → color
            cluster    = s.get("cluster_id", s.get("cluster", "")),
            color      = s.get("cluster_color", s.get("color", "#ffffff")),
            # FIX: map pos_x/y/z → x/y/z
            x          = s.get("pos_x", s.get("x", 0.0)),
            y          = s.get("pos_y", s.get("y", 0.0)),
            z          = s.get("pos_z", s.get("z", 0.0)),
            score      = round(h["_score"] / max_score, 3),
        ))
    return resp["hits"]["total"]["value"], results


async def get_all_stars(
    es: AsyncElasticsearch,
    cluster: str | None = None,
) -> list[StarPoint]:
    """
    Returns every paper's lightweight star data for the galaxy render.
    Uses search_after pagination to safely handle large datasets beyond ES's
    default 10 000-hit window.
    """
    query = {"term": {"cluster_id": cluster}} if cluster else {"match_all": {}}
    source_fields = [
        "id", "title", "authors", "year", "citations",
        "cluster_id", "cluster_color", "pos_x", "pos_y", "pos_z",
        # also accept alternate field names written by older pipeline versions
        "cluster", "color", "x", "y", "z", "cite",
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
            s = h["_source"]
            cite_val = s.get("citations", 0) or s.get("cite", 0) or 0
            results.append(StarPoint(
                id        = s["id"],
                title     = s["title"],
                authors   = s.get("authors", ""),
                year      = s.get("year"),
                cite      = cite_val,
                citations = cite_val,
                # FIX: accept both naming conventions
                cluster   = s.get("cluster_id",    s.get("cluster", "")),
                color     = s.get("cluster_color",  s.get("color", "#ffffff")),
                x         = s.get("pos_x",          s.get("x", 0.0)),
                y         = s.get("pos_y",          s.get("y", 0.0)),
                z         = s.get("pos_z",          s.get("z", 0.0)),
            ))

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
    Fetch a paper by its 'id' field value (e.g. an arxiv URL), then run kNN
    to find the k most similar papers.
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

    doc = hits[0]
    src = doc["_source"]
    embedding = src.get("embedding", [])
    similar: list[SimilarPaper] = []

    # FIX: only attempt kNN if we actually have an embedding
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
                    similar.append(SimilarPaper(
                        id      = s["id"],
                        title   = s["title"],
                        authors = s.get("authors", ""),
                        year    = s.get("year"),
                        x       = s.get("pos_x", s.get("x", 0.0)),
                        y       = s.get("pos_y", s.get("y", 0.0)),
                        z       = s.get("pos_z", s.get("z", 0.0)),
                    ))
        except Exception as e:
            # kNN failed (e.g. index has no embedding field) - return without similar
            print(f"[search] kNN lookup failed for {paper_id}: {e}")

    cite_val = src.get("citations", 0) or src.get("cite", 0) or 0

    return PaperDetail(
        id        = src["id"],
        title     = src["title"],
        authors   = src.get("authors", ""),
        year      = src.get("year"),
        citations = cite_val,
        cite      = cite_val,
        abstract  = src.get("abstract", ""),
        venue     = src.get("venue", ""),
        cluster   = src.get("cluster_id",   src.get("cluster", "")),
        color     = src.get("cluster_color", src.get("color", "#ffffff")),
        x         = src.get("pos_x",         src.get("x", 0.0)),
        y         = src.get("pos_y",         src.get("y", 0.0)),
        z         = src.get("pos_z",         src.get("z", 0.0)),
        similar   = similar[:k],
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
                        "color":       {"terms": {"field": "cluster_color", "size": 1}},
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
