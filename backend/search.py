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
try:
    from .models import SearchResult, StarPoint, SimilarPaper, PaperDetail, LoreResponse
except ImportError:
    from models import SearchResult, StarPoint, SimilarPaper, PaperDetail, LoreResponse

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


async def rrf_search(
    es: AsyncElasticsearch,
    query: str,
    size: int = 20,
    cluster: str | None = None,
) -> tuple[str, int, list[SearchResult]]:
    """
    Hybrid search using Reciprocal Rank Fusion (RRF).
    Combines BM25 (text) and kNN (vector) results.
    Returns (mode, total, results).
    """
    # 1. Get raw BM25 results
    total_text, text_results = await text_search(es, query, size=size*2, cluster=cluster)
    
    # 2. Extract embedding from top hit (or use a dedicated embedding service if available)
    # For this demo, we use the embedding of the best text match if it has one.
    embedding = []
    if text_results:
        best_id = text_results[0].id
        best_paper = await get_paper_with_similar(es, best_id, k=0)
        if best_paper:
             # We need the raw source for embedding - get_paper_with_similar excludes it
             raw = await es.get(index=INDEX, id=doc_id_from_paper_id(best_id))
             embedding = raw["_source"].get("embedding", [])

    if not embedding:
        # Fallback to pure text search if no embedding found
        return "text", total_text, text_results[:size]

    # 3. Get kNN results
    knn_body = {
        "knn": {
            "field": "embedding",
            "query_vector": embedding,
            "k": size * 2,
            "num_candidates": 100,
        },
        "_source": {"excludes": ["embedding"]},
    }
    if cluster:
        knn_body["knn"]["filter"] = {"term": {"cluster_id": cluster}}

    knn_resp = await es.search(index=INDEX, body=knn_body)
    knn_hits = knn_resp["hits"]["hits"]
    
    # 4. RRF Logic
    # score = sum( 1 / (k + rank) )
    K = 60
    scores = {} # id -> rrf_score
    docs = {}   # id -> SearchResult
    
    # Rank BM25
    for rank, res in enumerate(text_results):
        scores[res.id] = scores.get(res.id, 0) + (1.0 / (K + rank + 1))
        docs[res.id] = res
        
    # Rank kNN
    for rank, hit in enumerate(knn_hits):
        s = hit["_source"]
        pid = s["id"]
        scores[pid] = scores.get(pid, 0) + (1.0 / (K + rank + 1))
        if pid not in docs:
            cite_val = s.get("citations", 0) or s.get("cite", 0) or 0
            docs[pid] = SearchResult(
                id=pid, title=s["title"], authors=s.get("authors", ""),
                year=s.get("year"), cite=cite_val, citations=cite_val,
                abstract=s.get("abstract", ""),
                cluster=s.get("cluster_id", s.get("cluster", "")),
                color=s.get("cluster_color", s.get("color", "#ffffff")),
                x=s.get("pos_x", s.get("x", 0.0)),
                y=s.get("pos_y", s.get("y", 0.0)),
                z=s.get("pos_z", s.get("z", 0.0)),
                score=0.0 # will update below
            )

    # 5. Sort by RRF score
    sorted_ids = sorted(scores.keys(), key=lambda x: scores[x], reverse=True)
    final_results = []
    max_rrf = scores[sorted_ids[0]] if sorted_ids else 1.0
    
    for pid in sorted_ids[:size]:
        res = docs[pid]
        res.score = round(scores[pid] / max_rrf, 3)
        final_results.append(res)
        
    return "hybrid", len(sorted_ids), final_results

def doc_id_from_paper_id(paper_id: str) -> str:
    # Most paper IDs in the galaxy are arxiv URLs or similar. 
    # ES _id is usually the same.
    return paper_id


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


async def get_lore(cluster: str) -> LoreResponse:
    """Thematic generator for cluster 'lore'."""
    LORE = {
        "ml": "A dense neural collective, pulsing with the weight of trillion-parameter optimization. Here, logic is not written, but grown in the fertile silicon of the Noosphere.",
        "cs": "The digital foundation. Architectures of pure reason where abstract algorithms manifest as the very physics of our reality.",
        "math": "The realm of absolute truth. Geometric symmetries and axiomatic structures that exist independent of time, space, or observer.",
        "phys": "Where the abstract meets the iron laws of nature. A high-energy dance of particles and fields probing the absolute limits of the measurable.",
        "bio": "The code of life. Swirling helices of carbon and information, mapping the fundamental blueprints of organic vitality.",
        "chem": "Molecular alchemy. The study of bonds and breaks, where the rearrangement of atoms defines the potential of material existence.",
        "astro": "The cosmic scale. Infinite voids and stellar nurseries, tracking the history of the universe through the light of ancient stars.",
        "med": "The study of the fragile vessel. Clinical insights and biological interventions aimed at preserving the flicker of consciousness.",
        "econ": "The flows of value and incentive. Modeling the collective behavior of agents in a world of finite resources and infinite desire.",
        "psych": "The interior landscape. Mapping the neural architecture of thought, emotion, and the emergent mystery of the self.",
    }
    fallback = "A dense cluster of human knowledge, emitting the faint heat of collective intellectual labor. Its exact signature remains partially obscured."
    desc = LORE.get(cluster.lower().strip(), fallback)
    return LoreResponse(cluster=cluster, description=desc)
