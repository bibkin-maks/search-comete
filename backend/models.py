"""
search-comete - models.py
Pydantic models shared across the backend.

Fixes applied:
  1. SearchResult: added `citations` as an alias for `cite` so the frontend
     can always find the field regardless of which name it uses.
  2. StarPoint: same fix - pipeline data uses `citations`, fallback uses `cite`.
  3. All models use `populate_by_name=True` so both field names work on input.
"""

from pydantic import BaseModel, Field
from typing import Optional


class Paper(BaseModel):
    model_config = {"populate_by_name": True}

    id:            str
    title:         str
    abstract:      Optional[str] = ""
    authors:       Optional[str] = ""
    year:          Optional[int] = None
    citations:     Optional[int] = Field(default=0, alias="cite")
    venue:         Optional[str] = ""
    cluster_id:    str
    cluster_label: Optional[str] = ""
    cluster_color: Optional[str] = "#ffffff"
    pos_x:         float = 0.0
    pos_y:         float = 0.0
    pos_z:         float = 0.0


class SearchResult(BaseModel):
    """
    Returned by /search. The frontend expects `cite`, `cluster`, and `color`.
    We expose both `cite` and `citations` so either consumer works.
    """
    model_config = {"populate_by_name": True}

    id:         str
    title:      str
    authors:    Optional[str] = ""
    year:       Optional[int] = None
    # FIX: expose as both `cite` (frontend) and `citations` (pipeline field name)
    cite:       Optional[int] = Field(default=0, alias="citations", serialization_alias="cite")
    citations:  Optional[int] = 0          # kept for backward compat
    abstract:   Optional[str] = ""
    cluster:    str
    color:      Optional[str] = "#ffffff"
    x:          float = 0.0
    y:          float = 0.0
    z:          float = 0.0
    score:      float = 0.0

    def model_post_init(self, __context):
        # Keep cite and citations in sync whichever was set
        if self.cite and not self.citations:
            object.__setattr__(self, 'citations', self.cite)
        elif self.citations and not self.cite:
            object.__setattr__(self, 'cite', self.citations)


class SearchResponse(BaseModel):
    total:   int
    results: list[SearchResult]
    query:   str


class StarPoint(BaseModel):
    """Lightweight star for the galaxy render - no embedding."""
    model_config = {"populate_by_name": True}

    id:      str
    title:   str
    authors: Optional[str] = ""
    year:    Optional[int] = None
    # FIX: same dual-field approach
    cite:       Optional[int] = 0
    citations:  Optional[int] = 0
    cluster: str
    color:   Optional[str] = "#ffffff"
    x:       float
    y:       float
    z:       float

    def model_post_init(self, __context):
        if self.cite and not self.citations:
            object.__setattr__(self, 'citations', self.cite)
        elif self.citations and not self.cite:
            object.__setattr__(self, 'cite', self.citations)


class SimilarPaper(BaseModel):
    id:      str
    title:   str
    authors: Optional[str] = ""
    year:    Optional[int] = None
    x:       float = 0.0
    y:       float = 0.0
    z:       float = 0.0


class PaperDetail(BaseModel):
    model_config = {"populate_by_name": True}

    id:        str
    title:     str
    authors:   Optional[str] = ""
    year:      Optional[int] = None
    citations: Optional[int] = 0
    cite:      Optional[int] = 0       # FIX: added so frontend score bar works
    abstract:  Optional[str] = ""
    venue:     Optional[str] = ""
    cluster:   str
    color:     Optional[str] = "#ffffff"
    x:         float = 0.0
    y:         float = 0.0
    z:         float = 0.0
    score:     Optional[float] = None
    similar:   list[SimilarPaper] = Field(default_factory=list)

    def model_post_init(self, __context):
        if self.cite and not self.citations:
            object.__setattr__(self, 'citations', self.cite)
        elif self.citations and not self.cite:
            object.__setattr__(self, 'cite', self.citations)