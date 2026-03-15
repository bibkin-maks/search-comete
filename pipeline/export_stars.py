"""
pipeline/export_stars.py
Quick utility - exports stars.json directly from Elasticsearch.
Run this if you already have all papers in ES but stars.json is incomplete.

Usage:
  python -m pipeline.export_stars
  python -m pipeline.export_stars --es-host http://localhost:9200
"""
import argparse, json, os
from elasticsearch import Elasticsearch

INDEX      = "knowledge_galaxy"
STARS_JSON = os.path.join(os.path.dirname(__file__), "stars.json")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--es-host", default=os.getenv("ES_HOST", "http://localhost:9200"))
    args = parser.parse_args()

    print(f"Connecting to Elasticsearch at {args.es_host}…")
    es = Elasticsearch(args.es_host)

    try:
        info = es.info()
        print(f"Connected - ES version {info['version']['number']}")
    except Exception as e:
        print(f"Cannot connect to Elasticsearch: {e}")
        print("Make sure Elasticsearch is running on port 9200.")
        return

    # First show what clusters exist
    agg_resp = es.search(index=INDEX, body={
        "size": 0,
        "aggs": {"by_cluster": {"terms": {"field": "cluster_id", "size": 20}}}
    })
    print("\nClusters in Elasticsearch:")
    total_es = 0
    for b in agg_resp["aggregations"]["by_cluster"]["buckets"]:
        print(f"  {b['key']:20s}: {b['doc_count']} papers")
        total_es += b["doc_count"]
    print(f"  TOTAL: {total_es} papers")

    if total_es == 0:
        print("\nNo papers in Elasticsearch. Run the full pipeline first:")
        print("  python -m pipeline.run --limit 50")
        return

    # Export using search_after pagination
    print(f"\nExporting {total_es} papers to stars.json…")
    stars = []
    search_after = None

    while True:
        body = {
            "size": 1000,
            "sort": [{"_id": "asc"}],
            "_source": ["id","title","authors","year","citations",
                        "cluster_id","cluster_color","pos_x","pos_y","pos_z"],
            "query": {"match_all": {}},
        }
        if search_after:
            body["search_after"] = search_after

        resp = es.search(index=INDEX, body=body)
        hits = resp["hits"]["hits"]
        if not hits:
            break

        for h in hits:
            s = h["_source"]
            stars.append({
                "id":      s.get("id", h["_id"]),
                "title":   s.get("title", ""),
                "authors": s.get("authors", ""),
                "year":    s.get("year"),
                "cite":    s.get("citations", 0),
                "cluster": s.get("cluster_id", ""),
                "color":   s.get("cluster_color", "#ffffff"),
                "x":       round(s.get("pos_x", 0), 4),
                "y":       round(s.get("pos_y", 0), 4),
                "z":       round(s.get("pos_z", 0), 4),
            })

        if len(hits) < 1000:
            break
        search_after = hits[-1]["sort"]

    with open(STARS_JSON, "w") as f:
        json.dump(stars, f, separators=(",", ":"))

    size_kb = os.path.getsize(STARS_JSON) // 1024
    print(f"\nExported {len(stars)} stars → {STARS_JSON} ({size_kb} KB)")

    # Show cluster breakdown of exported data
    from collections import Counter
    counts = Counter(s["cluster"] for s in stars)
    print("\nClusters in exported stars.json:")
    for k, v in sorted(counts.items()):
        print(f"  {k:20s}: {v} papers")

    print("\nDone! Restart uvicorn and hard-refresh the browser (Ctrl+Shift+R).")


if __name__ == "__main__":
    main()