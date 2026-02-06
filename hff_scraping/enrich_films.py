#!/usr/bin/env python3
"""
HFF Film Enrichment Script

Enriches scraped OPAC records with TMDb data:
- Director, cast, crew
- Genres, ratings, runtime
- Poster URL, plot summary
- TMDb ID, IMDb ID

Usage:
    python enrich_films.py                    # Enrich all records
    python enrich_films.py --test             # Test with first 10 records
    python enrich_films.py --resume           # Resume from progress
    python enrich_films.py --input FILE       # Use specific input file
"""

import json
import csv
import time
import logging
import sys
import re
import argparse
from pathlib import Path
from datetime import datetime
from urllib.parse import quote

import requests

# --- Configuration ---
TMDB_API_KEY = "a5416cd7e5a0af7da9fd706b04eceab3"
TMDB_BASE = "https://api.themoviedb.org/3"
TMDB_IMG_BASE = "https://image.tmdb.org/t/p/w500"

INPUT_DIR = Path("output")
OUTPUT_DIR = Path("output/enriched")
PROGRESS_FILE = OUTPUT_DIR / "enrich_progress.json"
LOG_FILE = OUTPUT_DIR / "enrich.log"

REQUEST_DELAY = 0.05  # TMDb allows ~40 req/sec, 0.05s = ~20 req/sec (respectful)
REQUEST_TIMEOUT = 30
MAX_RETRIES = 3


def setup_logging():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("enrich")
    logger.setLevel(logging.DEBUG)
    if not logger.handlers:
        fh = logging.FileHandler(LOG_FILE, encoding="utf-8")
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        ch = logging.StreamHandler(sys.stdout)
        ch.setLevel(logging.INFO)
        ch.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        logger.addHandler(fh)
        logger.addHandler(ch)
    return logger


log = setup_logging()


class TMDbEnricher:
    def __init__(self, test_mode=False):
        self.test_mode = test_mode
        self.session = requests.Session()
        self.session.headers.update({
            "Accept": "application/json",
        })
        self.records = []
        self.enriched = []
        self.unmatched = []
        self.processed_bvids = set()

    # ------------------------------------------------------------------ #
    #  TMDb API
    # ------------------------------------------------------------------ #

    def _api_get(self, endpoint, params=None):
        """Make a TMDb API request."""
        url = f"{TMDB_BASE}{endpoint}"
        params = params or {}
        params["api_key"] = TMDB_API_KEY

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                resp = self.session.get(url, params=params, timeout=REQUEST_TIMEOUT)
                if resp.status_code == 429:  # Rate limited
                    wait = int(resp.headers.get("Retry-After", 10))
                    log.warning("Rate limited, waiting %ds", wait)
                    time.sleep(wait)
                    continue
                resp.raise_for_status()
                time.sleep(REQUEST_DELAY)
                return resp.json()
            except requests.RequestException as e:
                log.warning("API request failed (attempt %d): %s", attempt, e)
                if attempt == MAX_RETRIES:
                    return None
                time.sleep(2 * attempt)
        return None

    def search_movie(self, title, year=None, language="de-DE"):
        """Search TMDb for a movie by title and optional year."""
        params = {
            "query": title,
            "language": language,
            "include_adult": "true",
        }
        if year:
            params["year"] = year

        data = self._api_get("/search/movie", params)
        if data and data.get("results"):
            return data["results"]
        return []

    def get_movie_details(self, tmdb_id):
        """Get full movie details including credits."""
        data = self._api_get(
            f"/movie/{tmdb_id}",
            {"append_to_response": "credits", "language": "de-DE"}
        )
        return data

    # ------------------------------------------------------------------ #
    #  Matching logic
    # ------------------------------------------------------------------ #

    def _normalize_title(self, title):
        """Normalize title for comparison."""
        if not title:
            return ""
        # Remove punctuation, lowercase, collapse whitespace
        t = re.sub(r"[^\w\s]", " ", title.lower())
        t = re.sub(r"\s+", " ", t).strip()
        return t

    def _string_similarity(self, s1, s2):
        """Calculate similarity ratio between two strings (0.0 to 1.0)."""
        if not s1 or not s2:
            return 0.0
        # Use character-level comparison
        if s1 == s2:
            return 1.0
        # Length-based penalty for very different lengths
        len_ratio = min(len(s1), len(s2)) / max(len(s1), len(s2))
        if len_ratio < 0.5:
            return 0.0
        # Character n-gram similarity (bigrams)
        def bigrams(s):
            return set(s[i:i+2] for i in range(len(s)-1)) if len(s) > 1 else {s}
        b1 = bigrams(s1)
        b2 = bigrams(s2)
        if not b1 or not b2:
            return 0.0
        intersection = len(b1 & b2)
        union = len(b1 | b2)
        return intersection / union if union > 0 else 0.0

    def _extract_year(self, record):
        """Extract year from record (could be in 'year' or 'notes' field)."""
        if record.get("year"):
            m = re.search(r"(\d{4})", str(record["year"]))
            if m:
                return int(m.group(1))
        if record.get("notes"):
            # Often contains "Orig.: Country, 1999"
            m = re.search(r"(?:Orig\.?:?|Original:?)\s*[^,]*,?\s*(\d{4})", record["notes"])
            if m:
                return int(m.group(1))
            # Fallback: any 4-digit year
            m = re.search(r"\b(19\d{2}|20\d{2})\b", record["notes"])
            if m:
                return int(m.group(1))
        if record.get("imprint"):
            m = re.search(r"(\d{4})", record["imprint"])
            if m:
                return int(m.group(1))
        return None

    def _extract_director_from_record(self, record):
        """Extract director name from OPAC record."""
        # Check dedicated director field
        if record.get("director"):
            return self._normalize_name(record["director"])

        # Check contributors for [Regisseur] tag
        if record.get("contributors"):
            m = re.search(r"([^;]+)\s*\[Regisseur\]", record["contributors"])
            if m:
                return self._normalize_name(m.group(1))

        # Check credits for "Regie:" or "directed by"
        if record.get("credits"):
            m = re.search(r"(?:Regie|directed\s+by|Director)[:\s]+([^.;]+)",
                         record["credits"], re.IGNORECASE)
            if m:
                return self._normalize_name(m.group(1))

        return None

    def _normalize_name(self, name):
        """Normalize a person's name for comparison."""
        if not name:
            return ""
        # Remove dates like "1960-" or "(1933-2008)"
        name = re.sub(r"\s*[\(\[]?\d{4}[-–]?\d{0,4}[\)\]]?\s*", " ", name)
        # Remove role tags
        name = re.sub(r"\s*\[[^\]]+\]\s*", " ", name)
        # Handle "Last, First" -> "First Last"
        if "," in name:
            parts = name.split(",", 1)
            if len(parts) == 2:
                name = f"{parts[1].strip()} {parts[0].strip()}"
        # Lowercase, remove extra whitespace
        name = re.sub(r"\s+", " ", name.lower()).strip()
        return name

    def _get_tmdb_director(self, credits):
        """Extract director from TMDb credits."""
        if not credits or "crew" not in credits:
            return None
        for person in credits["crew"]:
            if person.get("job") == "Director":
                return self._normalize_name(person.get("name", ""))
        return None

    def _titles_match(self, t1, t2):
        """Check if two titles match. STRICT matching to avoid false positives."""
        n1 = self._normalize_title(t1)
        n2 = self._normalize_title(t2)
        if not n1 or not n2:
            return False

        # Exact match
        if n1 == n2:
            return True

        # Length check - titles must be similar length (within 2x)
        len_ratio = min(len(n1), len(n2)) / max(len(n1), len(n2))
        if len_ratio < 0.4:
            return False

        # One contains the other completely (for subtitle handling)
        # But only if the contained string is substantial (>50% of container)
        if n1 in n2 and len(n1) > len(n2) * 0.5:
            return True
        if n2 in n1 and len(n2) > len(n1) * 0.5:
            return True

        # Use character-based similarity (bigrams) - requires 70% similarity
        similarity = self._string_similarity(n1, n2)
        if similarity >= 0.7:
            return True

        return False

    def _directors_match(self, d1, d2):
        """Check if two director names match."""
        if not d1 or not d2:
            return None  # Can't verify - return None (unknown)
        # Check if last names match (most reliable)
        parts1 = d1.split()
        parts2 = d2.split()
        if parts1 and parts2:
            # Compare last names
            if parts1[-1] == parts2[-1]:
                return True
            # Compare first names if last names don't match
            if parts1[0] == parts2[0] and len(parts1) > 1 and len(parts2) > 1:
                return True
        return d1 == d2

    def _extract_runtime_from_record(self, record):
        """Extract runtime in minutes from OPAC record."""
        # Check dedicated runtime field
        if record.get("runtime"):
            m = re.search(r"(\d+)", str(record["runtime"]))
            if m:
                return int(m.group(1))

        # Check notes field for patterns like "12 Min.", "Länge: 12 Min.", "ca. 88 Min."
        for field in ["notes", "extent", "description"]:
            text = record.get(field, "")
            if not text:
                continue
            # Match patterns: "12 Min", "Länge: 12 Min.", "ca. 88 Min.", "(58 min)"
            patterns = [
                r"Länge[:\s]+(\d+)\s*Min",
                r"(\d+)\s*Min\.?\b",
                r"\((\d+)\s*min\)",
            ]
            for pat in patterns:
                m = re.search(pat, text, re.IGNORECASE)
                if m:
                    return int(m.group(1))
        return None

    def _runtimes_compatible(self, opac_runtime, tmdb_runtime):
        """Check if runtimes are compatible (not wildly different)."""
        if not opac_runtime or not tmdb_runtime:
            return None  # Can't verify - return None (unknown)

        diff = abs(opac_runtime - tmdb_runtime)
        max_runtime = max(opac_runtime, tmdb_runtime)

        # Short films (under 30 min): allow 10 min difference
        if opac_runtime < 30:
            return diff <= 10
        # Medium (30-60 min): allow 15 min difference
        elif opac_runtime < 60:
            return diff <= 15
        # Features: allow 20% difference or 20 min, whichever is larger
        else:
            return diff <= max(20, max_runtime * 0.2)

    def find_match(self, record):
        """Find the best TMDb match for a record. Strict matching to avoid false positives."""
        title = record.get("title", "")
        if not title:
            return None, "no_title"

        year = self._extract_year(record)
        opac_director = self._extract_director_from_record(record)
        opac_runtime = self._extract_runtime_from_record(record)

        # Build list of titles to try
        titles_to_try = [title]
        if record.get("original_title"):
            titles_to_try.append(record["original_title"])
        if record.get("uniform_title"):
            # Prioritize uniform_title (often the original/international title)
            titles_to_try.insert(1, record["uniform_title"])
        if record.get("alt_titles"):
            for alt in record["alt_titles"].split(";"):
                alt = alt.strip()
                if alt and alt not in titles_to_try:
                    titles_to_try.append(alt)

        best_match = None
        best_score = 0
        best_details = None

        for search_title in titles_to_try[:5]:  # Limit to 5 titles
            # Try with year first, then without
            for search_year in ([year, None] if year else [None]):
                results = self.search_movie(search_title, search_year)
                if not results:
                    continue

                for result in results[:5]:  # Check top 5 results
                    score = 0
                    title_matched = False

                    tmdb_title = result.get("title", "")
                    tmdb_original = result.get("original_title", "")
                    tmdb_year = None
                    if result.get("release_date"):
                        try:
                            tmdb_year = int(result["release_date"][:4])
                        except (ValueError, IndexError):
                            pass

                    # REQUIRED: Title must match (baseline requirement)
                    if self._titles_match(search_title, tmdb_title):
                        score += 40
                        title_matched = True
                    elif self._titles_match(search_title, tmdb_original):
                        score += 40
                        title_matched = True

                    # Skip if title doesn't match at all
                    if not title_matched:
                        continue

                    # Year match
                    if year and tmdb_year:
                        if year == tmdb_year:
                            score += 25
                        elif abs(year - tmdb_year) <= 1:
                            score += 15
                        elif abs(year - tmdb_year) <= 2:
                            score += 5

                    # Fetch details to check director and runtime
                    details = self.get_movie_details(result["id"])
                    if not details:
                        continue

                    tmdb_runtime = details.get("runtime")
                    tmdb_director = self._get_tmdb_director(details.get("credits"))

                    # Director check - HARD REJECTION if directors don't match
                    if opac_director:
                        director_match = self._directors_match(opac_director, tmdb_director)
                        if director_match is True:
                            score += 30  # Strong positive signal
                        elif director_match is False:
                            # Hard reject - skip this result entirely
                            continue
                        # If None (unknown TMDb director), no change

                    # Runtime check
                    if opac_runtime:
                        runtime_ok = self._runtimes_compatible(opac_runtime, tmdb_runtime)
                        if runtime_ok is True:
                            score += 15  # Good signal
                        elif runtime_ok is False:
                            score -= 40  # Strong negative - e.g., 12 min vs 111 min
                        # If None (unknown), no change

                    if score > best_score:
                        best_score = score
                        best_match = result
                        best_details = details

                    # Very high confidence match, stop searching
                    if score >= 85:
                        break

                if best_score >= 85:
                    break
            if best_score >= 85:
                break

        # Store details in match for later use
        if best_match and best_details:
            best_match["_details"] = best_details

        # STRICT THRESHOLD: Require score >= 65 (title match + at least one verification)
        if best_match and best_score >= 65:
            return best_match, best_score
        return None, f"no_match (best_score={best_score})" if best_match else "no_match"

    # ------------------------------------------------------------------ #
    #  Enrichment
    # ------------------------------------------------------------------ #

    def enrich_record(self, record, tmdb_match):
        """Merge TMDb data into the record."""
        enriched = record.copy()

        # Get full details if not already fetched
        if "_details" in tmdb_match:
            details = tmdb_match["_details"]
        else:
            details = self.get_movie_details(tmdb_match["id"])

        if not details:
            enriched["tmdb_id"] = tmdb_match["id"]
            enriched["tmdb_match_score"] = tmdb_match.get("_score", 0)
            return enriched

        # Core IDs
        enriched["tmdb_id"] = details.get("id")
        enriched["imdb_id"] = details.get("imdb_id")

        # Title info
        if not enriched.get("original_title") and details.get("original_title"):
            enriched["tmdb_original_title"] = details["original_title"]

        # Year
        if details.get("release_date"):
            enriched["tmdb_release_date"] = details["release_date"]
            if not enriched.get("year"):
                enriched["year"] = details["release_date"][:4]

        # Genres
        if details.get("genres"):
            enriched["tmdb_genres"] = ", ".join(g["name"] for g in details["genres"])

        # Runtime
        if details.get("runtime"):
            enriched["tmdb_runtime"] = details["runtime"]

        # Rating
        if details.get("vote_average"):
            enriched["tmdb_rating"] = details["vote_average"]
            enriched["tmdb_vote_count"] = details.get("vote_count", 0)

        # Plot
        if details.get("overview"):
            enriched["tmdb_plot"] = details["overview"]

        # Poster
        if details.get("poster_path"):
            enriched["tmdb_poster_url"] = f"{TMDB_IMG_BASE}{details['poster_path']}"

        # Production countries
        if details.get("production_countries"):
            enriched["tmdb_countries"] = ", ".join(
                c["name"] for c in details["production_countries"]
            )

        # Credits
        credits = details.get("credits", {})

        # Director(s)
        directors = [p["name"] for p in credits.get("crew", []) if p.get("job") == "Director"]
        if directors:
            enriched["tmdb_director"] = ", ".join(directors)

        # Top cast
        cast = credits.get("cast", [])[:10]
        if cast:
            enriched["tmdb_cast"] = ", ".join(p["name"] for p in cast)

        # Key crew (writer, cinematographer, composer)
        key_jobs = {"Screenplay", "Writer", "Director of Photography", "Original Music Composer"}
        key_crew = [(p["job"], p["name"]) for p in credits.get("crew", []) if p.get("job") in key_jobs]
        if key_crew:
            enriched["tmdb_crew"] = "; ".join(f"{job}: {name}" for job, name in key_crew[:5])

        return enriched

    # ------------------------------------------------------------------ #
    #  Progress / IO
    # ------------------------------------------------------------------ #

    def load_input(self, input_file):
        """Load scraped records from JSON."""
        path = Path(input_file)
        if not path.exists():
            raise FileNotFoundError(f"Input file not found: {path}")

        data = json.loads(path.read_text("utf-8"))
        if isinstance(data, dict) and "records" in data:
            self.records = data["records"]
        elif isinstance(data, list):
            self.records = data
        else:
            raise ValueError("Invalid input format")

        log.info("Loaded %d records from %s", len(self.records), path)

    def load_progress(self):
        """Load progress from previous run."""
        if PROGRESS_FILE.exists():
            try:
                data = json.loads(PROGRESS_FILE.read_text("utf-8"))
                self.enriched = data.get("enriched", [])
                self.unmatched = data.get("unmatched", [])
                self.processed_bvids = set(data.get("processed_bvids", []))
                log.info("Resumed: %d enriched, %d unmatched, %d processed",
                         len(self.enriched), len(self.unmatched), len(self.processed_bvids))
            except (json.JSONDecodeError, KeyError) as e:
                log.warning("Progress load failed: %s", e)

    def save_progress(self):
        """Save progress for resume capability."""
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        PROGRESS_FILE.write_text(json.dumps({
            "enriched": self.enriched,
            "unmatched": self.unmatched,
            "processed_bvids": list(self.processed_bvids),
            "last_updated": datetime.now().isoformat(),
        }, ensure_ascii=False, indent=2), "utf-8")

    def save_output(self):
        """Save enriched records to CSV and JSON."""
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

        # Save enriched JSON
        enriched_json = OUTPUT_DIR / "hff_films_enriched.json"
        enriched_json.write_text(json.dumps({
            "metadata": {
                "source": "HFF Munich Library OPAC + TMDb",
                "enriched_at": datetime.now().isoformat(),
                "total_records": len(self.enriched),
                "unmatched_count": len(self.unmatched),
            },
            "records": self.enriched,
        }, ensure_ascii=False, indent=2), "utf-8")
        log.info("Enriched JSON: %s (%d records)", enriched_json, len(self.enriched))

        # Save unmatched JSON
        if self.unmatched:
            unmatched_json = OUTPUT_DIR / "hff_films_unmatched.json"
            unmatched_json.write_text(json.dumps({
                "metadata": {
                    "note": "Records that could not be matched to TMDb",
                    "count": len(self.unmatched),
                },
                "records": self.unmatched,
            }, ensure_ascii=False, indent=2), "utf-8")
            log.info("Unmatched JSON: %s (%d records)", unmatched_json, len(self.unmatched))

        # Save enriched CSV
        if self.enriched:
            enriched_csv = OUTPUT_DIR / "hff_films_enriched.csv"
            all_keys = set()
            for r in self.enriched:
                all_keys.update(r.keys())

            # Prioritize certain fields
            priority = [
                "title", "tmdb_original_title", "original_title", "alt_titles",
                "tmdb_director", "director", "contributors", "credits",
                "year", "tmdb_release_date",
                "tmdb_genres", "tmdb_rating", "tmdb_vote_count",
                "tmdb_runtime", "runtime", "extent",
                "tmdb_cast", "tmdb_crew",
                "tmdb_plot", "description",
                "tmdb_poster_url",
                "tmdb_id", "imdb_id", "bvid", "permalink",
                "media_type", "language", "tmdb_countries", "country",
                "call_number", "location", "availability",
                "source_url", "scraped_at",
            ]
            fields = [k for k in priority if k in all_keys]
            fields += sorted(all_keys - set(fields))

            with open(enriched_csv, "w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
                w.writeheader()
                w.writerows(self.enriched)
            log.info("Enriched CSV: %s (%d records)", enriched_csv, len(self.enriched))

    # ------------------------------------------------------------------ #
    #  Main
    # ------------------------------------------------------------------ #

    def run(self):
        log.info("=" * 60)
        log.info("  HFF Film Enrichment (TMDb)")
        log.info("=" * 60)

        matched = 0
        unmatched_count = 0

        for i, record in enumerate(self.records):
            bvid = record.get("bvid", "")

            # Skip if already processed
            if bvid and bvid in self.processed_bvids:
                continue

            title = record.get("title", "")[:50]
            log.info("[%d/%d] %s", i + 1, len(self.records), title)

            try:
                tmdb_match, score_or_reason = self.find_match(record)
            except Exception as e:
                log.error("Error matching %s: %s", title, e)
                tmdb_match, score_or_reason = None, str(e)

            if tmdb_match:
                enriched = self.enrich_record(record, tmdb_match)
                enriched["tmdb_match_score"] = score_or_reason
                self.enriched.append(enriched)
                matched += 1
                log.info("  -> Matched: %s (score=%s)", tmdb_match.get("title", "?"), score_or_reason)
            else:
                record_copy = record.copy()
                record_copy["match_failure_reason"] = score_or_reason
                self.unmatched.append(record_copy)
                unmatched_count += 1
                log.info("  -> No match (%s)", score_or_reason)

            if bvid:
                self.processed_bvids.add(bvid)

            # Save progress periodically
            if (i + 1) % 50 == 0:
                self.save_progress()
                log.info("Progress: %d matched, %d unmatched", matched, unmatched_count)

            if self.test_mode and i >= 9:
                log.info("Test mode: stopping after 10 records")
                break

        self.save_progress()
        self.save_output()

        log.info("=" * 60)
        log.info("  DONE - %d matched, %d unmatched", matched, unmatched_count)
        log.info("=" * 60)


def main():
    p = argparse.ArgumentParser(description="Enrich HFF film data with TMDb")
    p.add_argument("--test", action="store_true", help="Test with first 10 records")
    p.add_argument("--resume", action="store_true", help="Resume from progress file")
    p.add_argument("--input", default="output/hff_films.json", help="Input JSON file")
    args = p.parse_args()

    enricher = TMDbEnricher(test_mode=args.test)
    enricher.load_input(args.input)
    if args.resume:
        enricher.load_progress()
    enricher.run()


if __name__ == "__main__":
    main()
