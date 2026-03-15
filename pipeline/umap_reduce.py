"""
search-comete - pipeline/umap_reduce.py
Reduce high-dimensional embeddings to 3D coordinates for Three.js.

UMAP preserves local structure: papers that are semantically similar
end up physically close in the output space. This is what makes the
galaxy look right - you don't need to manually assign cluster positions.
"""

import numpy as np


def run_umap(
    embeddings: np.ndarray,
    n_neighbors: int = 15,
    min_dist:    float = 0.1,
    scale:       float = 10.0,
    random_state: int  = 42,
) -> np.ndarray:
    """
    Compress (N, D) embeddings → (N, 3) 3D coordinates.

    Args:
        embeddings:   L2-normalised embedding matrix from embed.py
        n_neighbors:  Controls cluster spread. Higher = more global structure.
                      Try 10-30. Default 15 works well for 1k-10k papers.
        min_dist:     Packing within clusters. Lower = tighter stars.
                      Try 0.05-0.2. Default 0.1 gives readable clusters.
        scale:        Output range will be roughly [-scale/2, scale/2].
                      Default 10.0 works with the Three.js camera defaults.
        random_state: Fixed for reproducible galaxy layout.

    Returns:
        (N, 3) float32 array with x, y, z coordinates.
    """
    import umap  # imported here so the rest of the module loads without it

    print(f"  Running UMAP ({embeddings.shape[0]} points, {embeddings.shape[1]}d → 3d)…")
    print(f"  n_neighbors={n_neighbors}, min_dist={min_dist}")

    reducer = umap.UMAP(
        n_components  = 3,
        n_neighbors   = n_neighbors,
        min_dist      = min_dist,
        metric        = "cosine",
        random_state  = random_state,
        verbose       = True,
        low_memory    = False,
    )
    coords = reducer.fit_transform(embeddings)  # shape (N, 3)

    # Normalise each axis independently to [-scale/2, scale/2]
    for dim in range(3):
        col = coords[:, dim]
        rng = col.max() - col.min()
        if rng > 0:
            coords[:, dim] = ((col - col.min()) / rng - 0.5) * scale

    print(f"  UMAP done. Range: {coords.min():.2f} → {coords.max():.2f}")
    return coords.astype(np.float32)
