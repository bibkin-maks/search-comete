"""
search-comete - pipeline/layout.py
Turn raw UMAP coordinates into final scene positions.

1. Each field gets an anchor on a big sphere (same order as before: sorted
   cluster ids on a Fibonacci sphere) and its UMAP box is scaled into a cube
   around that anchor.
2. UMAP packs papers into very tight clumps (median nearest neighbour was
   0.07 units for 0.24-0.86 unit stars), so a few relaxation passes push
   overlapping stars apart until each has room for its size. Big picture
   shape stays, stars stop sitting on top of each other.

Done offline so the browser doesn't spend time on it at load.
"""

import math

import numpy as np
from scipy.spatial import cKDTree

ANCHOR_RADIUS = 135.0
CLUSTER_HALF  = 30.0     # each field fills a cube of +-30 units around its anchor
ITERATIONS    = 12


def star_radius(cite: np.ndarray) -> np.ndarray:
    """Personal space of a star, matched to its sprite size in galaxy.js."""
    norm = np.minimum(1.0, np.log10(cite + 1) / 5)
    return 0.14 + norm * 0.22


def anchors_for(clusters: list[str]) -> dict[str, list[float]]:
    names = sorted(set(clusters))
    golden = (1 + math.sqrt(5)) / 2
    out = {}
    for i, name in enumerate(names):
        theta = math.acos(1 - 2 * (i + 0.5) / len(names))
        phi = 2 * math.pi * i / golden
        out[name] = [
            ANCHOR_RADIUS * math.sin(theta) * math.cos(phi),
            ANCHOR_RADIUS * math.sin(theta) * math.sin(phi),
            ANCHOR_RADIUS * math.cos(theta),
        ]
    return out


def relax(pos: np.ndarray, radius: np.ndarray, iterations: int = ITERATIONS) -> np.ndarray:
    pos = pos.copy()
    reach = float(radius.max() * 2)
    for _ in range(iterations):
        pairs = cKDTree(pos).query_pairs(reach, output_type="ndarray")
        if not len(pairs):
            break
        i, j = pairs[:, 0], pairs[:, 1]
        delta = pos[i] - pos[j]
        dist = np.linalg.norm(delta, axis=1)
        need = radius[i] + radius[j]
        hit = dist < need
        if not hit.any():
            break
        i, j, delta, dist, need = i[hit], j[hit], delta[hit], dist[hit], need[hit]
        # Identical points get a random direction
        zero = dist < 1e-6
        if zero.any():
            delta[zero] = np.random.default_rng(len(pairs)).normal(size=(zero.sum(), 3))
            dist[zero] = np.linalg.norm(delta[zero], axis=1)
        push = (delta / dist[:, None]) * ((need - dist) * 0.5 * 0.8)[:, None]
        np.add.at(pos, i, push)
        np.add.at(pos, j, -push)
    return pos


def crowding(pos: np.ndarray, radius: float = 1.6) -> np.ndarray:
    """Neighbours within `radius` of each star. The frontend dims crowded
    stars so dense regions read as dense instead of adding up to pure white."""
    return cKDTree(pos).query_ball_point(pos, r=radius, return_length=True)


def scene_layout(xyz: np.ndarray, clusters: list[str], cite: np.ndarray):
    """xyz: (N, 3) raw UMAP coords. Returns (positions (N, 3), anchors dict)."""
    anchors = anchors_for(clusters)
    pos = np.zeros_like(xyz, dtype=np.float64)
    cl = np.array(clusters)
    radius = star_radius(cite.astype(np.float64))

    for name, anchor in anchors.items():
        idx = np.where(cl == name)[0]
        pts = xyz[idx]
        # Bigger fields get more room (volume grows with paper count)
        half = CLUSTER_HALF * (len(idx) / 3600) ** (1 / 3)
        # Scale by the bulk (2nd-98th percentile), not the extremes: a few
        # outliers used to squeeze everyone else into one bright core
        lo, hi = np.percentile(pts, 2, axis=0), np.percentile(pts, 98, axis=0)
        span = np.where(hi - lo > 0, hi - lo, 1.0)
        local = ((pts - lo) / span - 0.5) * 2 * half
        local = equalize_radius(local, half)
        pos[idx] = relax(local, radius[idx]) + np.array(anchor)
    return pos, anchors


def equalize_radius(local: np.ndarray, half: float, amount: float = 0.6) -> np.ndarray:
    """Pull each paper's distance from the field centre part-way towards an
    even (uniform-in-volume) spread. Directions and radial order are kept,
    so neighbours stay neighbours; the dense core just gets room."""
    centre = np.median(local, axis=0)
    off = local - centre
    r = np.linalg.norm(off, axis=1)
    rank = np.argsort(np.argsort(r)) / max(len(r) - 1, 1)
    r_even = half * rank ** (1 / 3)
    r_new = (1 - amount) * r + amount * r_even
    scale = np.where(r > 1e-9, r_new / np.maximum(r, 1e-9), 1.0)
    return centre + off * scale[:, None]
