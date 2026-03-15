"""
search-comete - pipeline/embed.py
Generate dense embeddings for paper abstracts using sentence-transformers.

Model: all-MiniLM-L6-v2
  - 384 dimensions
  - Runs on CPU (~2,000 papers/min)
  - Good semantic quality for academic text
  - Download: ~90 MB (cached after first run)

For higher quality (slower), swap for: 'allenai-specter' (768d, academic-specific)
"""

import numpy as np
from sentence_transformers import SentenceTransformer

MODEL_NAME = "all-MiniLM-L6-v2"
EMBED_DIMS = 384


def load_model(model_name: str = MODEL_NAME) -> SentenceTransformer:
    print(f"  Loading embedding model '{model_name}'…")
    model = SentenceTransformer(model_name)
    print(f"  Model ready. Dims: {model.get_sentence_embedding_dimension()}")
    return model


def embed_papers(papers: list[dict], model: SentenceTransformer, batch_size: int = 64) -> np.ndarray:
    """
    Embed each paper's title + abstract.
    Returns an (N, EMBED_DIMS) float32 array, L2-normalised.
    """
    texts = [
        f"{p.get('title', '')} {p.get('abstract', '')}".strip()
        for p in papers
    ]
    print(f"  Embedding {len(texts)} papers (batch_size={batch_size})…")
    embeddings = model.encode(
        texts,
        batch_size=batch_size,
        show_progress_bar=True,
        normalize_embeddings=True,   # cosine similarity works best on normalised vectors
        convert_to_numpy=True,
    )
    return embeddings.astype(np.float32)
