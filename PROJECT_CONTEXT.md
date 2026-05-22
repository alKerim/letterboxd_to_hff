# Project Context for Future Agents

This file is a quick orientation document for anyone picking up work on this repository.

## Project Goal

The original goal of this project is a Chrome extension for Letterboxd that helps a user see whether films visible on a Letterboxd page are available in the HFF Munich library.

## Project Journey So Far

1. The first approach was live lookup:
   scan visible films on Letterboxd, then search the HFF WebOPAC in real time for each title.
2. That approach worked as a prototype, but it was not efficient enough:
   it depends on live requests, session handling, rate limits, HTML parsing, and repeated search noise.
3. Because of that, the project direction changed:
   instead of treating WebOPAC as a live search backend, the library catalog was scraped locally.
4. The current strategic direction is:
   use the scraped catalog as the main source of truth, enrich it offline, and ship a lightweight matching/indexing strategy for the extension.

## What Exists Right Now

### Extension

- `background.js` still performs live HFF WebOPAC searches.
- `content.js` scans visible Letterboxd films and sends lookup requests.
- The current extension behavior is therefore still closer to the original live-search prototype than to the newer offline-dataset approach.

### Scraping Pipeline

- `hff_scraping/hff_scraper.py` scrapes HFF WebOPAC film records and captures stable catalog identifiers such as `bvid` and `permalink`.
- The raw scrape output currently lives in `hff_scraping/output/hff_films.json`.

### Cleaning / Match-Preparation Pipeline

- `hff_scraping/clean_hff_films.py` deduplicates raw OPAC records by `bvid`, merges field variants, extracts better year signals, extracts directors where possible, and creates normalized matching fields.
- It writes:
  - `hff_scraping/output/cleaned/hff_films_clean.json`
  - `hff_scraping/output/cleaned/hff_films_match_ready.json`
  - `hff_scraping/output/cleaned/quality_report.json`

### TMDb Enrichment Pipeline

- `hff_scraping/enrich_films.py` already exists.
- It tries to match OPAC records to TMDb using title, year, director, and runtime checks.
- It can enrich records with:
  - `tmdb_id`
  - `imdb_id`
  - release date
  - genres
  - runtime
  - rating
  - plot
  - poster URL
  - countries
  - director / cast / crew
- It supports resume/progress tracking and stores unmatched records separately.

## Current Data Status

As observed in the repository:

- The cleaning pipeline has already been run.
- `hff_scraping/output/cleaned/quality_report.json` shows:
  - `47,488` raw records
  - `41,923` cleaned records
  - `5,565` rows deduplicated away
  - `98.29%` records with a usable `match_year`
  - `99.39%` records with a usable normalized title
- The TMDb enrichment pipeline appears to have only been tested on a small subset so far.
- `hff_scraping/output/enriched/hff_films_enriched.json` currently contains only `4` enriched records.
- `hff_scraping/output/enriched/hff_films_unmatched.json` currently contains `6` unmatched records from that small run.
- `hff_scraping/output/enriched/enrich_progress.json` shows a last update on `2026-02-06`.

## Important Product Insight

The project already has the most valuable library-side identifier: the HFF permalink / `bvid`.

That means the hardest part is not linking to the catalog entry after a match.
The hardest part is reliable movie identity matching between:

- Letterboxd film data
- the scraped HFF catalog data
- optional TMDb enrichment data

Once a record is confidently matched, linking out is easy because the permalink already exists.

## User Direction and Preference

The current preference from the user is:

- keep the solution as simple as possible
- lean into the scraped/offline approach
- use TMDb enrichment only insofar as it makes matching easier and more reliable
- avoid going back to heavy live-search behavior if possible

## Recommended Mental Model

Treat the system as a two-stage pipeline:

1. Offline preparation:
   scrape, clean, normalize, enrich, and build a compact lookup index.
2. Runtime lookup in the extension:
   extract a Letterboxd title/year, normalize it, perform a local lookup, and return the stored HFF permalink.

## Strong Likely Next Step

The simplest promising direction is not "full enrichment everywhere first."
It is:

1. make the cleaned dataset the main base
2. enrich only enough metadata to improve identity resolution
3. build a compact lookup/index artifact from that data
4. make the extension query that artifact instead of live WebOPAC whenever possible

## Notes for Future Work

- Prefer the cleaned dataset over the raw scrape for matching work.
- Keep `bvid` and `permalink` as canonical HFF identifiers.
- Be cautious with false-positive TMDb matches, especially for:
  - short films
  - alternate-language titles
  - episodic discs / compilations
  - generic titles such as `Lucky`, `Disc 8`, `Tatort`, etc.
- If improving the enrichment script, prefer precision over recall.
- If shipping runtime lookup in the extension, avoid embedding huge raw JSON directly if a smaller precomputed index can be generated.

