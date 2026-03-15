"""
search-comete - pipeline/index.py
Bulk-index processed papers into Elasticsearch.
"""
import uuid
import time
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
            "citations":      {"type": "integer"},
            "venue":          {"type": "keyword"},
            "cluster_id":     {"type": "keyword"},
            "cluster_label":  {"type": "keyword"},
            "cluster_color":  {"type": "keyword"},
            "pos_x":          {"type": "float"},
            "pos_y":          {"type": "float"},
            "pos_z":          {"type": "float"},
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
            print(f"  Index '{INDEX}' already exists - skipping create")
            return
    print(f"  Creating index '{INDEX}'…")
    es.indices.create(index=INDEX, body=MAPPING)


def _normalize_authors(authors_field) -> str:
    if not authors_field:
        return ""
    if isinstance(authors_field, str):
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
    docs = []
    for i, (paper, cl) in enumerate(zip(papers, cluster_infos)):
        docs.append({
            "id":            paper.get("paperId") or str(uuid.uuid4()),
            "title":         paper.get("title", ""),
            "abstract":      (paper.get("abstract") or "")[:2000],
            "authors":       _normalize_authors(paper.get("authors")),
            "year":          paper.get("year") or 0,
            "citations":     paper.get("citationCount") or 0,
            "venue":         paper.get("venue") or "",
            "cluster_id":    cl["id"],
            "cluster_label": cl["label"],
            "cluster_color": cl["color"],
            "pos_x":         float(coords_3d[i, 0]),
            "pos_y":         float(coords_3d[i, 1]),
            "pos_z":         float(coords_3d[i, 2]),
            "embedding":     embeddings[i].tolist(),
        })
    return docs


def bulk_index(es: Elasticsearch, docs: list[dict], chunk_size: int = 100):
    """
    Sequential bulk index in small chunks with retries.
    Uses chunk_size=100 and single thread to avoid connection timeouts
    on cloud Elasticsearch - slower but reliable.
    """
    actions = [
        {"_index": INDEX, "_id": d["id"], "_source": d}
        for d in docs
    ]
    total     = len(actions)
    ok_count  = 0
    err_count = 0

    print(f"  Bulk indexing {total} documents in chunks of {chunk_size}…")

    for i in range(0, total, chunk_size):
        chunk   = actions[i : i + chunk_size]
        attempt = 0
        while attempt < 3:
            try:
                for ok, info in helpers.streaming_bulk(
                    es, chunk,
                    chunk_size=chunk_size,
                    raise_on_error=False,
                    request_timeout=60,
                ):
                    if ok:
                        ok_count += 1
                    else:
                        err_count += 1
                        print(f"  Doc error: {info}")
                break  # success - move to next chunk
            except Exception as e:
                attempt += 1
                print(f"  Chunk {i//chunk_size} attempt {attempt} failed: {e}")
                if attempt < 3:
                    time.sleep(5 * attempt)  # back off: 5s, 10s
                else:
                    print(f"  Giving up on chunk {i//chunk_size} after 3 attempts")
                    err_count += len(chunk)

        # Progress every 5000 docs
        if ok_count % 5000 < chunk_size:
            print(f"  Progress: {ok_count}/{total} indexed…")

    es.indices.refresh(index=INDEX)
    print(f"  Done - {ok_count} indexed, {err_count} errors")
    return ok_count