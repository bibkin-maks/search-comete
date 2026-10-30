"""
search-comete - pipeline/compact_stars.py
Convert stars.json (array of objects) into the compact columnar galaxy.json
the frontend loads. Same data, roughly a third of the size, because keys are
not repeated 54k times and numbers are stored as short ints.

Run: python -m pipeline.compact_stars [in.json] [out.json]
Defaults: frontend/public/stars.json -> frontend/public/galaxy.json
"""

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_IN = os.path.join(ROOT, "frontend", "public", "stars.json")
DEFAULT_OUT = os.path.join(ROOT, "frontend", "public", "galaxy.json")

ID_PREFIX = "https://openalex.org/"
MAX_AUTHORS = 3
COORD_SCALE = 1000  # 3 decimals is far below what you can see in the scene


def _short_authors(authors: str) -> str:
    names = [n.strip() for n in (authors or "").split(",") if n.strip()]
    if len(names) > MAX_AUTHORS:
        return ", ".join(names[:MAX_AUTHORS]) + " et al."
    return ", ".join(names)


def compact(stars: list[dict]) -> dict:
    clusters: list[str] = []
    colors: dict[str, str] = {}
    cluster_idx: dict[str, int] = {}

    out = {"v": 2, "idPrefix": ID_PREFIX, "clusters": clusters, "colors": colors,
           "id": [], "title": [], "authors": [], "year": [], "cite": [],
           "cluster": [], "xyz": []}

    for s in stars:
        cl = s.get("cluster") or s.get("cluster_id") or ""
        if cl not in cluster_idx:
            cluster_idx[cl] = len(clusters)
            clusters.append(cl)
            colors[cl] = s.get("color") or s.get("cluster_color") or "#8888aa"

        sid = str(s["id"])
        out["id"].append(sid[len(ID_PREFIX):] if sid.startswith(ID_PREFIX) else sid)
        out["title"].append(s.get("title") or "")
        out["authors"].append(_short_authors(s.get("authors")))
        out["year"].append(int(s.get("year") or 0))
        out["cite"].append(int(s.get("cite") or s.get("citations") or 0))
        out["cluster"].append(cluster_idx[cl])
        for k, alt in (("x", "pos_x"), ("y", "pos_y"), ("z", "pos_z")):
            out["xyz"].append(round(float(s.get(k, s.get(alt, 0.0))) * COORD_SCALE))

    out["n"] = len(out["id"])
    out["coordScale"] = COORD_SCALE
    return out


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_IN
    dst = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    with open(src, encoding="utf-8") as f:
        stars = json.load(f)
    data = compact(stars)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  {len(stars)} stars: {os.path.getsize(src)/2**20:.1f} MB -> {os.path.getsize(dst)/2**20:.1f} MB ({dst})")


if __name__ == "__main__":
    main()
