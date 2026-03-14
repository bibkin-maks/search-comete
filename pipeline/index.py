"""
search-comete — pipeline/index.py
Bulk-index processed papers into Elasticsearch.

Canonical field names written to ES (Phase 1 schema unification):
  cite        (was: citations)
  cluster     (was: cluster_id)
  color       (was: cluster_color)
  x, y, z     (was: pos_x, pos_y, pos_z)

Legacy aliases are no longer created. The Pydantic models in backend/models.py
have validators that still accept old names for any existing index data.
"""
import uuid
import numpy as np
from elasticsearch import Elasticsearch, helpers

INDEX      = "knowledge_galaxy"
EMBED_DIMS = 384

MAPPING = {
    "mappings": {
        "properties": {
            "id":             {"type": "keyword"},
            "title":          {"type": "text", "fields": {"raw": {"type": "keyword"}}},
            "abstract":       {"type": "text"},
            "authors":        {"type": "text"},
            "year":           {"type": "integer"},
            "cite":           {"type": "integer"},         # canonical
            "venue":          {"type": "keyword"},
            "cluster":        {"type": "keyword"},         # canonical
            "cluster_label":  {"type": "keyword"},
            "color":          {"type": "keyword"},         # canonical
            "x":              {"type": "float"},           # canonical
            "y":              {"type": "float"},
            "z":              {"type": "float"},
            "embedding": {
                "type":       "dense_vector",
                "dims":       EMBED_DIMS,
                "index":      True,
                "similarity": "cosine",
            },
        }
    },
    "settings": {
        "number_of_shards":   1,
        "number_of_replicas": 0,
    },
}


def setup_index(es: Elasticsearch, recreate: bool = True):
    if es.indices.exists(index=INDEX):
        if recreate:
            print(f"  Deleting existing index '{INDEX}'…")
            es.indices.delete(index=INDEX)
        else:
            print(f"  Index '{INDEX}' already exists — skipping create")
            return
    print(f"  Creating index '{INDEX}'…")
    es.indices.create(index=INDEX, body=MAPPING)


def _normalize_authors(authors_field) -> str:
    """
    Handle authors coming in as either:
      - list of dicts:  [{"name": "Alice"}, {"name": "Bob"}]  (Semantic Scholar)
      - plain string:   "Alice, Bob, Carol"                    (arXiv after fix)
      - list of str:    ["Alice", "Bob"]                       (edge case)
    Always returns a comma-joined string of at most 5 names.
    """
    if not authors_field:
        return ""
    if isinstance(authors_field, str):
        # Already a string — just clean it up and limit to 5 names
        names = [n.strip() for n in authors_field.split(",") if n.strip()]
        return ", ".join(names[:5])
    if isinstance(authors_field, list):
        names = []
        for a in authors_field:
            if isinstance(a, dict):
                names.append(a.get("name") or a.get("author") or "")
            elif isinstance(a, str):
                names.append(a)
        names = [n.strip() for n in names if n.strip()]
        return ", ".join(names[:5])
    return str(authors_field)


def build_docs(
    papers:        list[dict],
    cluster_infos: list[dict],
    embeddings:    np.ndarray,
    coords_3d:     np.ndarray,
) -> list[dict]:
    """Assemble Elasticsearch documents from all pipeline outputs.
    Uses canonical field names so no remapping is needed downstream.
    """
    docs = []
    for i, (paper, cl) in enumerate(zip(papers, cluster_infos)):
        docs.append({
            "id":            paper.get("paperId") or str(uuid.uuid4()),
            "title":         paper.get("title", ""),
            "abstract":      (paper.get("abstract") or "")[:2000],
            "authors":       _normalize_authors(paper.get("authors")),
            "year":          paper.get("year") or 0,
            "cite":          paper.get("citationCount") or 0,   # canonical
            "venue":         paper.get("venue") or "",
            "cluster":       cl["id"],                           # canonical
            "cluster_label": cl["label"],
            "color":         cl["color"],                        # canonical
            "x":             float(coords_3d[i, 0]),             # canonical
            "y":             float(coords_3d[i, 1]),
            "z":             float(coords_3d[i, 2]),
            "embedding":     embeddings[i].tolist(),
        })
    return docs


def bulk_index(es: Elasticsearch, docs: list[dict], chunk_size: int = 200):
    """Parallel bulk index, then refresh."""
    actions = [
        {"_index": INDEX, "_id": d["id"], "_source": d}
        for d in docs
    ]
    print(f"  Bulk indexing {len(actions)} documents…")
    ok_count, err_count = 0, 0
    for ok, info in helpers.parallel_bulk(es, actions, chunk_size=chunk_size, thread_count=4):
        if ok:
            ok_count += 1
        else:
            err_count += 1
            print(f"  Error: {info}")
    es.indices.refresh(index=INDEX)
    print(f"  Done — {ok_count} indexed, {err_count} errors")
    return ok_count