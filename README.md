# QuickFlat

**Drag-and-drop converter that flattens the HPRA human-medicines XML list into
Power BI / Amazon QuickSight–ready CSV, JSON, NDJSON and XLSX — entirely in your
browser. Plus a star-schema export, a data-quality report and change tracking.**

QuickFlat is a single static page (hostable on GitHub Pages) that takes the
[HPRA "human medicines" XML list](https://www.hpra.ie/find-a-medicine/for-human-use/xml-product-listings)
and turns it into a clean, **rectangular** table that BI tools ingest without
fuss. No install, no upload — the file never leaves your machine.

It has three tabs:

- **Convert** — flatten to CSV / JSON / NDJSON / XLSX, with column selection,
  rename, reorder and saved/shareable profiles, plus a normalized star-schema
  export for proper BI modeling.
- **Quality report** — field completeness, duplicate keys, invalid dates,
  unexpected elements and categorical distributions (downloadable).
- **Compare versions** — diff two published lists to see products added,
  removed and changed, field by field (downloadable changelog).

> This is the web successor to the Python desktop tool
> [PharmaForm](https://github.com/snbyrnes/PharmaForm). See
> [Why it's better](#why-its-better-than-pharmaform).

---

## Features

- **Drag & drop** an XML file (or click to browse / load a built-in demo).
- **100% client-side.** Parsing runs in a Web Worker; nothing is uploaded.
  Good for regulatory data and offline use.
- **HPRA-aware.** Recognises the `Products / Product` schema and applies a
  curated, stable column model (so every file produces the same columns).
- **Generic fallback.** Any other record-list XML is flattened with dotted
  paths so the tool still works.
- **Tidy multi-value handling** for `ATCs`, `RoutesOfAdministration`,
  `ActiveSubstances` and `DispensingLegalStatus`:
  - **Explode** — one row per value (default: per *Active Substance*), or
  - **Join** — collapse repeated values into one cell with a separator.
- **ISO date column** (`AuthorisedDateISO`, `yyyy-mm-dd`) added alongside the
  HPRA `dd/mm/yyyy` value, because BI date parsing is locale-sensitive.
- **`xsi:nil` → null**, XML entities decoded, whitespace trimmed.
- **Five outputs:** CSV (UTF-8 BOM, RFC-4180), JSON array, NDJSON, **XLSX**
  (typed date cells), and a **star-schema** export (a ZIP of related CSVs, or a
  multi-sheet XLSX).
- **Column control + profiles:** include/exclude, rename and reorder columns;
  save a default or copy a shareable link that restores your setup.
- **Data-quality report** and **change tracking** between two published lists.
- **Fast:** the full ~13 MB / 10,000-product list parses in well under a second.

### Star schema (recommended for Power BI)

Instead of one denormalized table, export a `products` fact table plus a bridge
table per multi-value field (`product_atcs`, `product_active_substances`,
`product_routes`, `product_dispensing_status`), all joined on `DrugIDPK`. Relate
them in Power BI and you can slice by **every** repeating field at once with no
row blow-up — the standard star-schema model, and a cleaner alternative to the
explode-vs-join trade-off.

## Why it's better than PharmaForm

| | PharmaForm (Python) | QuickFlat (web) |
|---|---|---|
| Install | Windows .exe / Python | None — open a URL |
| Where it runs | Desktop | Browser (data stays local) |
| Multi-value fields | `ATC[0]`, `ATC[1]`… → **ragged** columns | Explode to rows, join, **or star schema** — stable columns |
| Dates | `dd/mm/yyyy` only | Adds ISO `yyyy-mm-dd` |
| Output | JSON | CSV + JSON + NDJSON + XLSX + star-schema ZIP/XLSX |
| QuickSight | Not targeted | NDJSON/CSV first-class |
| Quality report | Text/Excel report | In-browser report + JSON/CSV export |
| Change tracking | — | Diff two published lists |
| Column control | — | Select / rename / reorder + shareable profiles |
| Preview | — | Live in-page table + stats |

The ragged `ATC[n]` approach means products with three ATC codes create columns
that products with one ATC leave blank — Power BI tolerates it, QuickSight
struggles. QuickFlat keeps the column set identical for every row.

## Quick start

1. Open the hosted page (see [Deployment](#deployment)).
2. Drag the HPRA XML onto the drop zone (or click **try the demo file**).
3. Pick how repeating fields are shaped (default: *Explode by Active Substance*).
4. Download **CSV**, **JSON**, or **NDJSON**.

Get the source XML here: the latest authorised list lives at
`https://www.hpra.ie/img/uploaded/swedocuments/latestHMlist.xml`
(linked from the [HPRA XML product listings](https://www.hpra.ie/find-a-medicine/for-human-use/xml-product-listings) page).

## Output column model (HPRA list)

One row per record (or per exploded value). Columns, in order:

```
DrugIDPK, LicenceNumber, InterchangeableListCode, ProductName, PAHolder,
AuthorisedDate, AuthorisedDateISO, ProductType, MarketInfo, RegistrationStatus,
DosageForm, LegalBasis, SupplyLegalStatus, PromotionLegalStatus, SupplyComments,
ATC, RoutesOfAdministration, ActiveSubstance, DispensingLegalStatus,
SourceDatePublished, SourceSchemaVersion
```

- The **exploded** multi-value column holds a single value per row; the other
  three are joined with the chosen separator (default `" | "`).
- `Source*` columns carry the root `datePublished` / `schemaVersion` for
  provenance (toggle off if unwanted).

## Loading into BI tools

**Power BI**
- *CSV:* Home → Get data → **Text/CSV** → select file → Load.
- *JSON:* Get data → **JSON** → **To Table** → expand the record column.
- Mark `AuthorisedDateISO` as a **Date** type for time-intelligence.

**Amazon QuickSight**
- Upload the **CSV** or **NDJSON** (both flat and rectangular — ideal for
  QuickSight). New dataset → Upload a file (or point at S3) → confirm types.
- For substance-level analysis, export with *Explode by Active Substance*.

## Local development

Because the app uses a Web Worker and `fetch`, open it through a local web
server (not `file://`):

```bash
python -m http.server 8000
# then visit http://localhost:8000
```

### Tests

A Node harness runs the actual browser scripts against the demo sample (and the
full export if you drop `sample_latestHMlist.xml` in the repo root):

```bash
node test/run.cjs
```

An optional headless end-to-end test drives the real UI in Chromium (loads the
demo, toggles columns, exercises every download, and the Quality and Compare
tabs):

```bash
npm install                 # installs Playwright (dev-only)
npx playwright install chromium
python -m http.server 8731  # in another shell
node test/ui.cjs
```

## Deployment (GitHub Pages)

Two options:

1. **Actions (included):** push to `main`; the
   [`deploy.yml`](.github/workflows/deploy.yml) workflow publishes the repo
   root to Pages. In the repo: *Settings → Pages → Build and deployment →
   Source: GitHub Actions*.
2. **Branch:** *Settings → Pages → Source: Deploy from a branch → `main` /
   `/ (root)`*. No build step is required.

## Project structure

```
index.html            # page: tabs, drop zones, controls, preview
css/styles.css        # styling
js/xml-sax.js         # streaming SAX XML parser (worker)
js/extract.js         # SAX events -> normalized record tree (worker)
js/transform.js       # HPRA model, explode/join, column config, star schema, CSV/JSON/NDJSON
js/report.js          # data-quality & validation report
js/diff.js            # change tracking between two lists
js/zip.js             # minimal ZIP writer (store) for star-schema bundles
js/xlsx.js            # minimal XLSX writer (typed dates, multi-sheet)
js/worker.js          # Web Worker glue
js/app.js             # UI controller (tabs, drag/drop, preview, downloads)
sample/hpra-sample.xml# small demo file
test/run.cjs          # Node logic test harness
test/ui.cjs           # Playwright headless UI test
.github/workflows/    # Pages deploy
```

## Notes & limitations

- Leaf-element attributes (other than `xsi:nil`) are not emitted as columns.
- Generic (non-HPRA) mode joins/indexes arrays but does not offer explode or the
  star-schema export.
- The curated column model targets the **human medicines** list. The animal /
  interchangeable / withdrawn HPRA lists still load and flatten via the generic
  fallback; dedicated models for them are a planned addition.
- The HPRA human-medicines XML contains no SPC/PIL document URLs, so none are
  emitted (verified across the full export).
- CSV uses standard RFC-4180 quoting. If you open it in Excel and worry about
  formula injection, import via *Data → From Text/CSV* rather than double-click.
- XLSX and ZIP are written by small built-in encoders (no dependencies); only
  pure `yyyy-mm-dd` values are typed as Excel dates.

## Disclaimer

QuickFlat is an independent utility and is **not** affiliated with, or validated
by, the Health Products Regulatory Authority (HPRA). Source XML data © HPRA.

## License

MIT
