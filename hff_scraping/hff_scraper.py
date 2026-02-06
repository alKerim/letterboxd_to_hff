#!/usr/bin/env python3
"""
HFF Munich Library OPAC Scraper

Scrapes film records (DVD, Blu-ray, VHS) from https://webopac.hff-muc.de/
Uses requests + BeautifulSoup for speed and reliability.
Outputs to both CSV and JSON.

Usage:
    python hff_scraper.py                # Full scrape
    python hff_scraper.py --test         # Test: scrape first page only
    python hff_scraper.py --resume       # Resume from saved progress
    python hff_scraper.py --debug        # Save raw HTML for inspection
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
from urllib.parse import urljoin, urlencode

import requests
from bs4 import BeautifulSoup, NavigableString, Comment

# --- Configuration ---
BASE_URL = "https://webopac.hff-muc.de/"
OPAC_PATH = "/webOPACClient.hffsis/"
OUTPUT_DIR = Path("output")
PROGRESS_FILE = OUTPUT_DIR / "progress.json"
LOG_FILE = OUTPUT_DIR / "scraper.log"
DEBUG_DIR = OUTPUT_DIR / "debug"

REQUEST_DELAY = 1.0       # seconds between requests
REQUEST_TIMEOUT = 120     # seconds per HTTP request
MAX_RETRIES = 3

# Media type dropdown values from the OPAC HTML
MEDIA_TYPES = {"DVD": "9", "Blu-Ray": "12"}

# Search every letter + digit to ensure full catalog coverage.
# Duplicates are skipped via BV ID deduplication.
SEARCH_LETTERS = list("abcdefghijklmnopqrstuvwxyz0123456789")

# German field label -> normalized English key
FIELD_MAP = {
    "Titel": "title",
    "Haupttitel": "title",
    "weitere Titel": "alt_titles",
    "Einheitssachtitel": "uniform_title",
    "Parallelsachtitel": "parallel_title",
    "Verfasser": "author",
    "Autor": "author",
    "Sonstige Person": "contributors",
    "Verfasserangabe": "credits",
    "Beteiligte": "contributors",
    "Regie": "director",
    "Regisseur": "director",
    "Erscheinungsjahr": "year",
    "Jahr": "year",
    "Erscheinungsort": "place",
    "Ort": "place",
    "Verlag": "publisher",
    "ISBN": "isbn",
    "ISSN": "issn",
    "EAN": "ean",
    "Signatur": "call_number",
    "Standort": "location",
    "Schlagwort": "subject",
    "Schlagwörter": "subjects",
    "Schlagwortkette": "subject_chain",
    "Medienart": "media_type_opac",
    "Medientyp": "media_type_opac",
    "Sprache": "language",
    "Schrift-Sprache": "language",
    "Umfang": "extent",
    "Ausgabe": "edition",
    "Auflage": "edition",
    "Serie": "series",
    "Reihe": "series",
    "Gesamttitel": "series",
    "Notation": "classification",
    "Systematik": "classification",
    "Anmerkungen": "notes",
    "Anmerkung": "notes",
    "Fußnote": "footnote",
    "Kurzbeschreibung": "description",
    "Inhalt": "content_note",
    "Inhaltsverzeichnis": "toc",
    "Land": "country",
    "Produktionsland": "country",
    "Laufzeit": "runtime",
    "Spieldauer": "runtime",
    "FSK": "age_rating",
    "Altersfreigabe": "age_rating",
    "Untertitel": "subtitle",
    "Originaltitel": "original_title",
    "Originalsprache": "original_language",
    "Bandangabe": "volume",
    "Bestand": "holdings",
    "Begleitmaterial": "supplementary",
    "Status": "status",
    "Kategorie": "category",
    "Genre": "genre",
    "Erscheinungsort, Verlag, Erscheinungsjahr": "imprint",
}


def setup_logging():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("hff")
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


def norm_field(name):
    """Normalize a German field label to a consistent English key."""
    name = name.strip().rstrip(":").strip()
    if name in FIELD_MAP:
        return FIELD_MAP[name]
    for de, en in FIELD_MAP.items():
        if name.lower() == de.lower():
            return en
    return re.sub(r"[^a-zA-Z0-9]+", "_", name.lower()).strip("_") or name


def clean_text(text):
    """Clean extracted text: remove JS artifacts, special markers, excess whitespace."""
    # Remove ¬ markers used by the OPAC
    text = text.replace("¬", "")
    # Remove inline JavaScript blocks
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    text = re.sub(r"var\s+\w+\s*=.*?//-->", "", text, flags=re.DOTALL)
    text = re.sub(r"\$\(.*?\)\s*;", "", text, flags=re.DOTALL)
    # Collapse whitespace
    text = re.sub(r"\s+", " ", text).strip()
    return text


class HFFScraper:
    def __init__(self, debug=False, test_mode=False):
        self.debug = debug
        self.test_mode = test_mode
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
        })
        self.records = []
        self.scraped_bvids = set()  # BV IDs from permalinks for dedup
        self.completed_searches = set()  # Tuples of (media_type, letter) that are done
        self._action_url = None
        self._csid = None

    # ------------------------------------------------------------------ #
    #  Session management
    # ------------------------------------------------------------------ #

    def _init_session(self):
        """Load the OPAC homepage, establish cookies, capture form params."""
        log.info("Initializing session...")
        resp = self._get(BASE_URL)
        soup = BeautifulSoup(resp.text, "lxml")

        form = soup.find("form", {"id": "AdvancedSearchForm"})
        if form and form.get("action"):
            self._action_url = form["action"]
        else:
            for a in soup.find_all("a", href=True):
                m = re.search(r"(jsessionid=[A-Fa-f0-9]+)", a["href"])
                if m:
                    self._action_url = f"{OPAC_PATH}search.do;{m.group(1)}"
                    break

        csid_el = soup.find("input", {"name": "CSId"})
        if csid_el:
            self._csid = csid_el.get("value", "")

        if not self._action_url:
            raise RuntimeError("Failed to establish OPAC session")
        log.info("Session ready (action=%s)", self._action_url)

    def _refresh_session(self):
        """Re-initialize session if it might have timed out."""
        log.info("Refreshing session...")
        self._init_session()

    # ------------------------------------------------------------------ #
    #  Progress / resume
    # ------------------------------------------------------------------ #

    def load_progress(self):
        if PROGRESS_FILE.exists():
            try:
                data = json.loads(PROGRESS_FILE.read_text("utf-8"))
                self.records = data.get("records", [])
                self.scraped_bvids = set(data.get("scraped_bvids", []))
                # Load completed searches as set of tuples
                self.completed_searches = set(
                    tuple(x) for x in data.get("completed_searches", [])
                )
                log.info("Resumed: %d records, %d BV IDs, %d completed searches",
                         len(self.records), len(self.scraped_bvids), len(self.completed_searches))
            except (json.JSONDecodeError, KeyError) as e:
                log.warning("Progress load failed: %s", e)

    def save_progress(self):
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        PROGRESS_FILE.write_text(json.dumps({
            "records": self.records,
            "scraped_bvids": list(self.scraped_bvids),
            "completed_searches": list(self.completed_searches),
            "last_updated": datetime.now().isoformat(),
            "total_records": len(self.records),
        }, ensure_ascii=False, indent=2), "utf-8")

    # ------------------------------------------------------------------ #
    #  HTTP helpers
    # ------------------------------------------------------------------ #

    def _get(self, url, **kwargs):
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                resp = self.session.get(url, timeout=REQUEST_TIMEOUT, **kwargs)
                if resp.status_code == 502:
                    log.warning("502 Bad Gateway (attempt %d): %s", attempt, url[:100])
                    time.sleep(5 * attempt)
                    continue
                resp.raise_for_status()
                time.sleep(REQUEST_DELAY)
                return resp
            except requests.RequestException as e:
                log.warning("Request failed (attempt %d): %s", attempt, e)
                if attempt == MAX_RETRIES:
                    raise
                time.sleep(3 * attempt)

    def _build_search_url(self, term, media_value=""):
        base = urljoin(BASE_URL, self._action_url)
        return f"{base}?{urlencode({
            'methodToCall': 'submit',
            'CSId': self._csid or '',
            'methodToCallParameter': 'submitSearch',
            'searchCategories[0]': '-1',
            'searchString[0]': term,
            'callingPage': 'searchParameters',
            'searchRestrictionID[0]': '5',
            'searchRestrictionValue1[0]': media_value,
        })}"

    def _save_debug(self, label, html):
        if not self.debug:
            return
        DEBUG_DIR.mkdir(parents=True, exist_ok=True)
        (DEBUG_DIR / f"{label}_{int(time.time())}.html").write_text(html, "utf-8")

    # ------------------------------------------------------------------ #
    #  Search & results
    # ------------------------------------------------------------------ #

    def _search(self, term, media_value):
        """Execute search, return (soup, total_count, identifier)."""
        url = self._build_search_url(term, media_value)
        log.info("Searching: term=%r media=%s", term, media_value)
        resp = self._get(url)
        soup = BeautifulSoup(resp.text, "lxml")
        self._save_debug(f"search_{term}_{media_value}", resp.text)

        # Parse total count
        total = -1
        text = soup.get_text()
        for pat in [r"lokale Datenbank\s*\((\d[\d.]*)\)",
                     r"von\s+([\d.]+)\s+Treffer",
                     r"([\d.]+)\s+Treffer"]:
            m = re.search(pat, text)
            if m:
                total = int(m.group(1).replace(".", "").replace(",", ""))
                break

        # Extract search identifier
        identifier = None
        for a in soup.find_all("a", href=True):
            m = re.search(r"identifier=([^&#]+)", a["href"])
            if m:
                identifier = m.group(1)
                break

        log.info("Search results: total=%d, identifier=%s", total, identifier)
        return soup, total, identifier

    def _detail_url(self, cur_pos, identifier):
        """Build a detail page URL for a specific result position."""
        return (
            f"{urljoin(BASE_URL, OPAC_PATH)}"
            f"singleHit.do?methodToCall=showHit"
            f"&curPos={cur_pos}&identifier={identifier}"
            f"&tab=showTitleActive"
        )

    def _list_page_url(self, cur_pos, identifier):
        """Build a list page URL for pagination (10 items per page)."""
        return (
            f"{urljoin(BASE_URL, OPAC_PATH)}"
            f"hitList.do?methodToCall=pos"
            f"&identifier={identifier}&curPos={cur_pos}"
        )

    def _extract_bvids_from_list(self, soup):
        """
        Extract BV IDs from COinS spans on a search results list page.
        Returns list of (position, bvid) tuples for items on this page.
        """
        results = []
        # Find all COinS spans (Z3988 is the COinS standard class)
        for span in soup.find_all("span", class_="Z3988"):
            title = span.get("title", "")
            # BV ID is in rft_id parameter: ...Query%3D10%3D%22BV024087632%22
            m = re.search(r'(BV\d+)', title)
            if m:
                bvid = m.group(1)
                results.append(bvid)
        return results

    def _scan_list_pages(self, identifier, total, media_label,
                         search_term=None, media_value=None):
        """
        Scan all list pages to collect BV IDs without fetching detail pages.
        Returns list of (position, bvid) for items NOT already scraped.
        """
        items_per_page = 10
        total_pages = (total + items_per_page - 1) // items_per_page
        new_items = []  # (position, bvid)
        session_requests = 0

        log.info("Scanning %d list pages for BV IDs...", total_pages)

        for page_num in range(total_pages):
            start_pos = page_num * items_per_page + 1

            # Refresh session periodically
            session_requests += 1
            if session_requests > 500:
                self._refresh_session()
                if search_term is not None:
                    _, _, new_id = self._search(search_term, media_value or "")
                    if new_id:
                        identifier = new_id
                session_requests = 0

            # Fetch list page
            url = self._list_page_url(start_pos, identifier)
            try:
                resp = self._get(url)
                soup = BeautifulSoup(resp.text, "lxml")
            except Exception as e:
                log.warning("Failed to fetch list page %d: %s", page_num + 1, e)
                continue

            # Extract BV IDs from this page
            bvids = self._extract_bvids_from_list(soup)

            for i, bvid in enumerate(bvids):
                pos = start_pos + i
                if bvid not in self.scraped_bvids:
                    new_items.append((pos, bvid))

            # Progress log every 100 pages
            if (page_num + 1) % 100 == 0:
                log.info("Scanned %d/%d pages, found %d new items so far",
                         page_num + 1, total_pages, len(new_items))

        log.info("List scan complete: %d new items out of %d total",
                 len(new_items), total)
        return new_items, identifier

    # ------------------------------------------------------------------ #
    #  Record extraction
    # ------------------------------------------------------------------ #

    def _extract_record(self, cur_pos, identifier, media_type):
        """Fetch and parse a single record's detail page."""
        url = self._detail_url(cur_pos, identifier)
        record = {
            "media_type": media_type,
            "scraped_at": datetime.now().isoformat(),
        }

        try:
            resp = self._get(url)
        except requests.RequestException as e:
            record["error"] = str(e)
            record["source_url"] = url
            return record, None

        soup = BeautifulSoup(resp.text, "lxml")
        if cur_pos <= 3:
            self._save_debug(f"record_{media_type}_{cur_pos}", resp.text)

        # Extract permalink / BV ID
        bvid = None
        plink = soup.find("span", {"id": "permalink_link"})
        if plink:
            permalink = plink.get_text(strip=True)
            record["permalink"] = permalink
            m = re.search(r"(BV\d+)", permalink)
            if m:
                bvid = m.group(1)
                record["bvid"] = bvid

        # Extract fields from tab-content (the "mehr zum Titel" tab)
        tab = soup.find("div", {"id": "tab-content"})
        if tab:
            self._parse_strong_labels(tab, record)

        # Fallback: extract from box-container (default view)
        box = soup.find("div", class_="box-container")
        if box:
            self._parse_strong_labels(box, record, skip_existing=True)

        # Get title from h1 if not found yet
        if "title" not in record:
            for h in soup.find_all("h1"):
                t = h.get_text(strip=True)
                if t and t.lower() != "webopac" and len(t) > 1:
                    record["title"] = clean_text(t)
                    break

        # Extract copies/holdings info from Exemplare table
        self._parse_copies_table(soup, record)

        record["source_url"] = url
        return record, bvid

    def _parse_strong_labels(self, container, record, skip_existing=False):
        """
        Parse <strong class="c2">Label:</strong> Value patterns.
        Handles repeated labels by concatenating with '; '.
        """
        for strong in container.find_all("strong", class_="c2"):
            label = strong.get_text(strip=True).rstrip(":")
            if not label:
                continue

            # Collect text until next <strong class="c2">
            parts = []
            for sib in strong.next_siblings:
                if isinstance(sib, Comment):
                    continue
                if hasattr(sib, "name"):
                    if sib.name == "strong" and "c2" in (sib.get("class") or []):
                        break
                    if sib.name == "script":
                        continue
                    if sib.name == "br":
                        continue
                    t = sib.get_text(strip=True)
                else:
                    t = str(sib).strip()
                t = clean_text(t)
                if t:
                    parts.append(t)

            val = " ".join(parts)
            if not val:
                continue

            key = norm_field(label)
            if skip_existing and key in record:
                continue

            if key in record:
                record[key] += " ; " + val
            else:
                record[key] = val

    def _parse_copies_table(self, soup, record):
        """Extract call number and status from the Exemplare (copies) table."""
        # The copies table has headers: Medientyp, Signatur, Fußnoten, Mediennummer, Standort, Zweigstelle, Status
        tables = soup.find_all("table", class_="data")
        for table in tables:
            headers = [th.get_text(strip=True) for th in table.find_all("th")]
            if "Signatur" in headers or "Status" in headers:
                rows = table.find_all("tr")
                for row in rows[1:]:  # skip header row
                    cells = row.find_all("td")
                    if len(cells) >= 4:
                        sig = cells[0].get_text(strip=True) if len(cells) > 0 else ""
                        if sig and "call_number" not in record:
                            record["call_number"] = sig
                        status = cells[-2].get_text(strip=True) if len(cells) >= 2 else ""
                        if status and "availability" not in record:
                            record["availability"] = status
                        loc = cells[-3].get_text(strip=True) if len(cells) >= 3 else ""
                        if loc and "branch" not in record:
                            record["branch"] = loc
                break

    # ------------------------------------------------------------------ #
    #  Scraping logic
    # ------------------------------------------------------------------ #

    def scrape_media_type(self, media_name, media_value):
        """Scrape all records of a given media type using multiple search letters."""
        log.info("=" * 55)
        log.info("  SCRAPING: %s", media_name)
        log.info("=" * 55)

        total_new = 0

        for letter in SEARCH_LETTERS:
            # Skip if this search was already completed (resume support)
            search_key = (media_name, letter)
            if search_key in self.completed_searches:
                log.info("Skipping '%s' + %s (already completed)", letter, media_name)
                continue

            # Refresh session for each new search to avoid timeouts
            self._refresh_session()

            soup, total, identifier = self._search(letter, media_value)
            if total <= 0 or not identifier:
                log.info("No results for '%s' + %s, skipping", letter, media_name)
                self.completed_searches.add(search_key)
                continue

            log.info("'%s' + %s: %d results (identifier=%s)", letter, media_name, total, identifier)
            new = self._scrape_result_set(identifier, total, media_name,
                                          search_term=letter, media_value=media_value)
            total_new += new

            # Mark this search as completed
            self.completed_searches.add(search_key)

            log.info("Finished '%s': %d new records (%d total, %d unique BVIDs)",
                     letter, new, len(self.records), len(self.scraped_bvids))
            self.save_progress()

            if self.test_mode:
                log.info("Test mode: stopping after first search letter")
                break

        log.info("Completed %s: %d new records total", media_name, total_new)
        self.save_progress()

    def scrape_vhs(self):
        """Scrape VHS records via text search (not in media dropdown)."""
        # Skip if already completed
        search_key = ("VHS", "VHS")
        if search_key in self.completed_searches:
            log.info("Skipping VHS (already completed)")
            return

        log.info("=" * 55)
        log.info("  SCRAPING: VHS (text search)")
        log.info("=" * 55)

        self._refresh_session()
        soup, total, identifier = self._search("VHS", "")

        if total <= 0 or not identifier:
            log.warning("No VHS results found")
            self.completed_searches.add(search_key)
            return

        log.info("VHS search: %d results", total)
        new = self._scrape_result_set(identifier, total, "VHS",
                                      search_term="VHS", media_value="")

        # Mark as completed
        self.completed_searches.add(search_key)
        log.info("Completed VHS: %d new records", new)
        self.save_progress()

    def _scrape_result_set(self, identifier, total, media_label,
                           search_term=None, media_value=None):
        """
        Scrape results using optimized list-first approach:
        1. Scan list pages to extract BV IDs (fast, 10 items per page)
        2. Filter out already-scraped duplicates
        3. Only fetch detail pages for new items
        """
        # Step 1: Scan list pages to find new items
        new_items, identifier = self._scan_list_pages(
            identifier, total, media_label, search_term, media_value
        )

        if not new_items:
            log.info("No new items to scrape for %s", media_label)
            return 0

        log.info("Fetching detail pages for %d new items...", len(new_items))

        new_count = 0
        session_requests = 0

        for idx, (pos, bvid) in enumerate(new_items):
            # Refresh session periodically (OPAC has 10-min timeout)
            session_requests += 1
            if session_requests > 400:
                self._refresh_session()
                # Re-execute search to get a valid identifier for the new session
                if search_term is not None:
                    _, _, new_id = self._search(search_term, media_value or "")
                    if new_id:
                        identifier = new_id
                session_requests = 0

            # Double-check we haven't scraped this BV ID (in case of concurrent updates)
            if bvid in self.scraped_bvids:
                continue

            try:
                record, extracted_bvid = self._extract_record(pos, identifier, media_label)
            except Exception as e:
                log.error("Error at pos %d (bvid %s): %s", pos, bvid, e)
                continue

            # Use the BV ID we found from list page if extraction failed
            if not extracted_bvid:
                extracted_bvid = bvid
                record["bvid"] = bvid

            # Only keep records with actual data
            data_keys = set(record.keys()) - {"media_type", "scraped_at", "source_url", "error", "bvid"}
            if not data_keys:
                continue

            self.records.append(record)
            self.scraped_bvids.add(extracted_bvid)
            new_count += 1

            if new_count % 100 == 0:
                log.info("Progress: %d/%d new for %s (%d total records)",
                         new_count, len(new_items), media_label, len(self.records))
                self.save_progress()

            if self.test_mode and new_count >= 10:
                log.info("Test mode: stopping after 10 records")
                break

        return new_count

    # ------------------------------------------------------------------ #
    #  Output
    # ------------------------------------------------------------------ #

    def save_csv(self):
        if not self.records:
            log.warning("No records to save")
            return

        priority = [
            "title", "original_title", "uniform_title", "alt_titles", "subtitle",
            "credits", "contributors", "director", "author",
            "year", "publisher", "place", "imprint",
            "isbn", "ean", "bvid", "permalink",
            "call_number", "location", "branch", "availability",
            "media_type", "media_type_opac",
            "language", "original_language", "country",
            "runtime", "extent", "supplementary",
            "subject", "subjects", "subject_chain", "genre", "classification",
            "series", "edition", "volume",
            "notes", "footnote", "description", "content_note", "toc",
            "age_rating", "category", "status", "holdings",
            "source_url", "scraped_at", "error",
        ]
        all_keys = set()
        for r in self.records:
            all_keys.update(r.keys())
        fields = [k for k in priority if k in all_keys]
        fields += sorted(all_keys - set(fields))

        path = OUTPUT_DIR / "hff_films.csv"
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
            w.writeheader()
            w.writerows(self.records)
        log.info("CSV: %s (%d records)", path, len(self.records))

    def save_json(self):
        if not self.records:
            log.warning("No records to save")
            return
        path = OUTPUT_DIR / "hff_films.json"
        path.write_text(json.dumps({
            "metadata": {
                "source": "HFF Munich Library OPAC",
                "url": BASE_URL,
                "scraped_at": datetime.now().isoformat(),
                "total_records": len(self.records),
            },
            "records": self.records,
        }, ensure_ascii=False, indent=2), "utf-8")
        log.info("JSON: %s (%d records)", path, len(self.records))

    # ------------------------------------------------------------------ #
    #  Main
    # ------------------------------------------------------------------ #

    def run(self):
        log.info("=" * 60)
        log.info("  HFF Munich Library OPAC Film Scraper")
        log.info("=" * 60)

        try:
            self._init_session()

            for name, val in MEDIA_TYPES.items():
                try:
                    self.scrape_media_type(name, val)
                except Exception as e:
                    log.error("Failed %s: %s", name, e, exc_info=True)
                    self.save_progress()

            try:
                self.scrape_vhs()
            except Exception as e:
                log.error("Failed VHS: %s", e, exc_info=True)

            self.save_csv()
            self.save_json()

            log.info("=" * 60)
            log.info("  DONE — %d records scraped", len(self.records))
            log.info("=" * 60)

        except Exception as e:
            log.error("Fatal: %s", e, exc_info=True)
            self.save_progress()
            raise


def main():
    p = argparse.ArgumentParser(description="HFF Munich Library OPAC Film Scraper")
    p.add_argument("--debug", action="store_true", help="Save HTML for debugging")
    p.add_argument("--test", action="store_true", help="Test mode: limited scrape")
    p.add_argument("--resume", action="store_true", help="Resume from progress file")
    args = p.parse_args()

    scraper = HFFScraper(debug=args.debug, test_mode=args.test)
    if args.resume:
        scraper.load_progress()
    scraper.run()


if __name__ == "__main__":
    main()
