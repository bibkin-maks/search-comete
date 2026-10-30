"""
search-comete - pipeline/compact_stars.py
Convert stars (raw UMAP coords) into the compact columnar galaxy.json the
frontend loads: final scene positions from layout.py, keys stored once,
numbers as short ints. About a third of the size of the old stars.json.

Run: python -m pipeline.compact_stars [in.json] [out.json]
in.json is a stars.json array (raw UMAP coords) or a galaxy.json from
before the scene layout existed.
"""

import json
import os
import sys

import numpy as np

from .layout import scene_layout, crowding

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_IN = os.path.join(ROOT, "frontend", "public", "galaxy.json")
DEFAULT_OUT = DEFAULT_IN

ID_PREFIX = "https://openalex.org/"
MAX_AUTHORS = 3
COORD_SCALE = 100  # scene units, 2 decimals


def _short_authors(authors: str) -> str:
    names = [n.strip() for n in (authors or "").split(",") if n.strip()]
    if len(names) > MAX_AUTHORS:
        return ", ".join(names[:MAX_AUTHORS]) + " et al."
    return ", ".join(names)


def load_stars(path: str) -> list[dict]:
    """stars.json array, or a galaxy.json written by an older version (raw UMAP coords)."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    if data.get("layout") == "scene":
        raise SystemExit(f"{path} already has scene positions - pass the raw stars.json instead")
    k = data.get("coordScale", 1)
    return [{
        "id": data["idPrefix"] + data["id"][i],
        "title": data["title"][i],
        "authors": data["authors"][i],
        "year": data["year"][i],
        "cite": data["cite"][i],
        "cluster": data["clusters"][data["cluster"][i]],
        "color": data["colors"][data["clusters"][data["cluster"][i]]],
        "x": data["xyz"][i*3] / k, "y": data["xyz"][i*3+1] / k, "z": data["xyz"][i*3+2] / k,
    } for i in range(data["n"])]


def compact(stars: list[dict]) -> dict:
    clusters: list[str] = []
    colors: dict[str, str] = {}
    cluster_idx: dict[str, int] = {}

    out = {"v": 2, "layout": "scene", "idPrefix": ID_PREFIX, "clusters": clusters, "colors": colors,
           "id": [], "title": [], "authors": [], "year": [], "cite": [], "cluster": []}

    names, raw = [], []
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
        names.append(cl)
        raw.append([float(s.get(k, s.get(alt, 0.0))) for k, alt in (("x", "pos_x"), ("y", "pos_y"), ("z", "pos_z"))])

    pos, anchors = scene_layout(np.array(raw), names, np.array(out["cite"]))
    out["xyz"] = [int(round(v * COORD_SCALE)) for v in pos.reshape(-1)]
    out["anchors"] = {k: [round(c, 2) for c in v] for k, v in anchors.items()}
    out["crowd"] = [int(min(255, c)) for c in crowding(pos)]
    out["n"] = len(out["id"])
    out["coordScale"] = COORD_SCALE
    return out


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_IN
    dst = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    stars = load_stars(src)
    data = compact(stars)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  {len(stars)} stars -> {os.path.getsize(dst)/2**20:.1f} MB ({dst})")


if __name__ == "__main__":
    main()
