"""
search-comete — models.py
Pydantic V2 canonical schema.

The single source of truth for field names across the stack:
  cite      (not citations)
  cluster   (not cluster_id)
  x, y, z   (not pos_x, pos_y, pos_z)

model_validator(mode='before') accepts legacy aliases from the pipeline
and normalises them before validation, so old star data still works.
After this layer, all downstream code receives clean, predictable fields.
"""

from pydantic import BaseModel, Field, model_validator
from typing import Optional, Any


def _normalise(data: dict) -> dict:
    """
    Accept legacy pipeline field names and normalise to canonical schema.
    Operates on the raw dict before Pydantic validates it.
    """
    if not isinstance(data, dict):
        return data

    # citations → cite
    if 'cite' not in data or data.get('cite') is None:
        data['cite'] = data.get('citations', 0) or 0

    # cluster_id → cluster
    if 'cluster' not in data or not data.get('cluster'):
        data['cluster'] = data.get('cluster_id', '') or ''

    # cluster_color → color
    if 'color' not in data or not data.get('color'):
        data['color'] = data.get('cluster_color', '#ffffff') or '#ffffff'

    # pos_x/y/z → x/y/z
    if 'x' not in data or data.get('x') is None:
        data['x'] = data.get('pos_x', 0.0) or 0.0
    if 'y' not in data or data.get('y') is None:
        data['y'] = data.get('pos_y', 0.0) or 0.0
    if 'z' not in data or data.get('z') is None:
        data['z'] = data.get('pos_z', 0.0) or 0.0

    return data


class Paper(BaseModel):
    """Internal pipeline model — still uses legacy names, mapped on output."""
    model_config = {"populate_by_name": True}

    id:            str
    title:         str
    abstract:      Optional[str] = ""
    authors:       Optional[str] = ""
    year:          Optional[int] = None
    cite:          Optional[int] = 0
    venue:         Optional[str] = ""
    cluster:       str = ""
    cluster_label: Optional[str] = ""
    color:         Optional[str] = "#ffffff"
    x:             float = 0.0
    y:             float = 0.0
    z:             float = 0.0

    @model_validator(mode='before')
    @classmethod
    def normalise_fields(cls, data: Any) -> Any:
        return _normalise(data)


class SearchResult(BaseModel):
    """Returned by /search. Canonical field names only."""
    model_config = {"populate_by_name": True}

    id:       str
    title:    str
    authors:  Optional[str] = ""
    year:     Optional[int] = None
    cite:     Optional[int] = 0
    abstract: Optional[str] = ""
    cluster:  str = ""
    color:    Optional[str] = "#ffffff"
    x:        float = 0.0
    y:        float = 0.0
    z:        float = 0.0
    score:    float = 0.0

    @model_validator(mode='before')
    @classmethod
    def normalise_fields(cls, data: Any) -> Any:
        return _normalise(data)


class SearchResponse(BaseModel):
    total:   int
    results: list[SearchResult]
    query:   str


class StarPoint(BaseModel):
    """Lightweight star for the galaxy render — no embedding."""
    model_config = {"populate_by_name": True}

    id:      str
    title:   str
    authors: Optional[str] = ""
    year:    Optional[int] = None
    cite:    Optional[int] = 0
    cluster: str = ""
    color:   Optional[str] = "#ffffff"
    x:       float = 0.0
    y:       float = 0.0
    z:       float = 0.0

    @model_validator(mode='before')
    @classmethod
    def normalise_fields(cls, data: Any) -> Any:
        return _normalise(data)


class SimilarPaper(BaseModel):
    id:      str
    title:   str
    authors: Optional[str] = ""
    year:    Optional[int] = None
    x:       float = 0.0
    y:       float = 0.0
    z:       float = 0.0

    @model_validator(mode='before')
    @classmethod
    def normalise_fields(cls, data: Any) -> Any:
        return _normalise(data)


class PaperDetail(BaseModel):
    model_config = {"populate_by_name": True}

    id:       str
    title:    str
    authors:  Optional[str] = ""
    year:     Optional[int] = None
    cite:     Optional[int] = 0
    abstract: Optional[str] = ""
    venue:    Optional[str] = ""
    cluster:  str = ""
    color:    Optional[str] = "#ffffff"
    x:        float = 0.0
    y:        float = 0.0
    z:        float = 0.0
    score:    Optional[float] = None
    similar:  list[SimilarPaper] = Field(default_factory=list)

    @model_validator(mode='before')
    @classmethod
    def normalise_fields(cls, data: Any) -> Any:
        return _normalise(data)