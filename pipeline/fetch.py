"""
search-comete - pipeline/fetch.py
Fetch papers from OpenAlex (default), arXiv, or Semantic Scholar.

Rate limit summary:
  - OpenAlex:         FREE, no key, 100k req/day, polite pool = no throttling.
                      RECOMMENDED - set OPENALEX_EMAIL env var for priority pool.
  - arXiv:            Free, no key. Can get 429 on fast bulk runs. Use 3s sleep.
  - Semantic Scholar: Free but strict 1 req/s. Set SS_API_KEY for 10 req/s.
"""

import time
import uuid
import os
import requests
import xml.etree.ElementTree as ET


# ── OpenAlex (recommended default) ───────────────────────────────────────────

OPENALEX_URL   = "https://api.openalex.org/works"
OPENALEX_EMAIL = os.getenv("OPENALEX_EMAIL", "")


def fetch_openalex(query: str, limit: int = 200) -> list[dict]:
    """
    Pull papers from OpenAlex - the best free academic API.
    250M+ papers, no rate limits with polite pool, no key required.
    Tip: set OPENALEX_EMAIL=your@email.com env var for priority access.
    Docs: https://docs.openalex.org/
    """
    papers, cursor, per_page = [], "*", min(200, limit)
    consecutive_errors = 0

    params = {
        "search":   query,
        "per-page": per_page,
        "select":   "id,title,abstract_inverted_index,authorships,publication_year,cited_by_count,primary_location",
        "sort":     "relevance_score:desc",
    }
    if OPENALEX_EMAIL:
        params["mailto"] = OPENALEX_EMAIL

    while len(papers) < limit:
        try:
            params["cursor"] = cursor
            r = requests.get(OPENALEX_URL, params=params, timeout=20)

            if r.status_code == 429:
                print(f"    [OpenAlex] Rate limited - sleeping 30s…")
                time.sleep(30)
                consecutive_errors += 1
                continue

            if r.status_code != 200:
                print(f"    [OpenAlex] HTTP {r.status_code} - retrying…")
                time.sleep(5)
                consecutive_errors += 1
                if consecutive_errors >= 3:
                    break
                continue

            consecutive_errors = 0
            data = r.json()
            results = data.get("results", [])
            if not results:
                break

            for w in results:
                title    = (w.get("title") or "").strip()
                inv      = w.get("abstract_inverted_index") or {}
                abstract = _reconstruct_abstract(inv)
                if not title or not abstract:
                    continue

                authorships = w.get("authorships") or []
                author_names = [
                    a.get("author", {}).get("display_name", "")
                    for a in authorships[:5]
                ]
                authors_str = ", ".join(n for n in author_names if n)

                loc    = w.get("primary_location") or {}
                source = loc.get("source") or {}
                venue  = source.get("display_name", "")

                papers.append({
                    "paperId":       w.get("id") or str(uuid.uuid4()),
                    "title":         title,
                    "abstract":      abstract,
                    "authors":       authors_str,
                    "year":          w.get("publication_year") or 2020,
                    "citationCount": w.get("cited_by_count") or 0,
                    "venue":         venue,
                })

            meta   = data.get("meta", {})
            cursor = meta.get("next_cursor")
            if not cursor or len(results) < per_page:
                break

            time.sleep(0.12)  # OpenAlex polite pool is very generous

        except requests.exceptions.Timeout:
            print(f"    [OpenAlex] Timeout - retrying…")
            time.sleep(5)
            consecutive_errors += 1
            if consecutive_errors >= 3:
                break
        except Exception as e:
            print(f"    [OpenAlex] Error: {e}")
            time.sleep(3)
            consecutive_errors += 1
            if consecutive_errors >= 3:
                break

    return papers[:limit]


def _reconstruct_abstract(inverted_index: dict) -> str:
    """Convert OpenAlex abstract_inverted_index back to plain text."""
    if not inverted_index:
        return ""
    positions = {}
    for word, pos_list in inverted_index.items():
        for pos in pos_list:
            positions[pos] = word
    return " ".join(positions[i] for i in sorted(positions))


# ── Semantic Scholar ──────────────────────────────────────────────────────────

SS_URL     = "https://api.semanticscholar.org/graph/v1/paper/search"
SS_FIELDS  = "paperId,title,abstract,authors,year,citationCount,venue"
SS_API_KEY = os.getenv("SS_API_KEY", "")


def fetch_semantic_scholar(query: str, limit: int = 200) -> list[dict]:
    papers, offset, batch = [], 0, min(100, limit)
    consecutive_errors = 0
    headers = {"x-api-key": SS_API_KEY} if SS_API_KEY else {}

    while len(papers) < limit:
        try:
            r = requests.get(SS_URL, params={
                "query":  query,
                "fields": SS_FIELDS,
                "limit":  batch,
                "offset": offset,
            }, headers=headers, timeout=15)

            if r.status_code == 429:
                wait = min(120, 30 * (2 ** consecutive_errors))
                print(f"    [SS] Rate limited - sleeping {wait}s…")
                time.sleep(wait)
                consecutive_errors += 1
                continue

            if r.status_code != 200:
                print(f"    [SS] HTTP {r.status_code}")
                consecutive_errors += 1
                if consecutive_errors >= 3:
                    break
                time.sleep(10)
                continue

            consecutive_errors = 0
            data = r.json().get("data", [])
            if not data:
                break

            papers.extend([p for p in data if p.get("abstract") and p.get("title")])
            offset += batch
            if len(data) < batch:
                break
            time.sleep(1.2)

        except Exception as e:
            print(f"    [SS] Error: {e}")
            time.sleep(5)
            consecutive_errors += 1
            if consecutive_errors >= 3:
                break

    return papers[:limit]


# ── arXiv ─────────────────────────────────────────────────────────────────────

ARXIV_URL = "http://export.arxiv.org/api/query"
ATOM_NS   = "http://www.w3.org/2005/Atom"


def fetch_arxiv(query: str, limit: int = 200) -> list[dict]:
    papers, start, batch = [], 0, min(50, limit)  # smaller batch to avoid 429
    consecutive_errors = 0

    while len(papers) < limit:
        try:
            r = requests.get(ARXIV_URL, params={
                "search_query": f"all:{query}",
                "start":        start,
                "max_results":  batch,
                "sortBy":       "relevance",
                "sortOrder":    "descending",
            }, timeout=20)

            if r.status_code == 429:
                print(f"    [arXiv] Rate limited - sleeping 60s…")
                time.sleep(60)
                continue

            if r.status_code != 200:
                time.sleep(10)
                consecutive_errors += 1
                if consecutive_errors >= 3:
                    break
                continue

            consecutive_errors = 0
            root    = ET.fromstring(r.text)
            entries = root.findall(f"{{{ATOM_NS}}}entry")
            if not entries:
                break

            for e in entries:
                title    = (e.findtext(f"{{{ATOM_NS}}}title")   or "").replace("\n", " ").strip()
                abstract = (e.findtext(f"{{{ATOM_NS}}}summary") or "").replace("\n", " ").strip()
                year_raw = e.findtext(f"{{{ATOM_NS}}}published") or "2020"
                author_names = [
                    (a.findtext(f"{{{ATOM_NS}}}name") or "").strip()
                    for a in e.findall(f"{{{ATOM_NS}}}author")
                ]
                if title and abstract:
                    papers.append({
                        "paperId":       e.findtext(f"{{{ATOM_NS}}}id") or str(uuid.uuid4()),
                        "title":         title,
                        "abstract":      abstract,
                        "authors":       ", ".join(n for n in author_names if n),
                        "year":          int(year_raw[:4]),
                        "citationCount": 0,
                        "venue":         "arXiv",
                    })

            start += batch
            if len(entries) < batch:
                break
            time.sleep(3.0)  # conservative - arXiv asks for 3s between requests

        except ET.ParseError:
            start += batch
            time.sleep(3)
        except Exception as e:
            print(f"    [arXiv] Error: {e}")
            time.sleep(5)
            consecutive_errors += 1
            if consecutive_errors >= 3:
                break

    return papers[:limit]


def normalize_authors(paper: dict) -> str:
    authors = paper.get("authors", "")
    if isinstance(authors, list):
        return ", ".join(
            (a.get("name") or a) if isinstance(a, dict) else str(a)
            for a in authors
        )
    return authors or ""


def deduplicate(papers: list[dict], cluster_infos: list[dict]) -> tuple[list[dict], list[dict]]:
    seen, out_p, out_c = set(), [], []
    for p, c in zip(papers, cluster_infos):
        key = (p.get("title") or "").lower().strip()
        if key and key not in seen:
            seen.add(key)
            out_p.append(p)
            out_c.append(c)
    return out_p, out_c