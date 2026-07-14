# IFE MOOP Explorer

A small, static web app for exploring FUSE **Inertial Fusion Energy multi-objective
optimization (MOOP)** scan results. It loads an `extract.csv` produced by a MOOP study
(e.g. `ife_moop.jl`) entirely in the browser — no backend, no build step — inspired by
[fuseexplorer.com](https://fuseexplorer.com).

## What it shows

Each row of `extract.csv` is one optimizer evaluation. The app provides five views:

- **Pareto** — the core trade-off: net electric power (maximize) vs. levelized CoE
  (minimize), colored by generation, with the non-dominated Pareto front overlaid.
  Click any point to inspect that design.
- **Scatter** — plot any numeric column vs. any other, with color/size mappings and
  per-axis log scaling. The "plot anything vs. anything" workhorse.
- **Distributions** — histogram of any column, optionally split by feasibility.
- **Convergence** — best objective value vs. generation (with running best and per-gen
  design counts) to show optimizer progress.

Global filters (shared across views): success-only, feasible-only, and a generation range.
*Feasible* = the case succeeded **and** `power_electric_net ≥ req_power_electric_net`.

## Run locally

Plotly needs the CSV served over HTTP for the bundled-data auto-load:

```bash
cd explorer
python3 -m http.server 8000
# open http://localhost:8000
```

You can also just open `index.html` directly (or skip the bundled file) and **drag-and-drop**
any `extract.csv` onto the *Data source* box — that path works from `file://` too.

## Use your own scan

Drop any run's `extract.csv` onto the *Data source* box, or replace
`data/extract.csv` with your file. The bundled sample is a copy of
`../ife_moop_run/extract.csv` (≈5,900 designs).

## Deploy

Everything is static (HTML/CSS/JS + Plotly.js & PapaParse from CDN). Copy the `explorer/`
folder to any static host — GitHub Pages, Netlify, S3, an internal web server — and it just
works. No server-side code.

## Files

```
explorer/
  index.html        layout, tabs, controls, CDN script tags
  css/style.css     dashboard styling
  js/data.js        CSV parse/clean, column metadata, feasibility, Pareto front, filtering
  js/plots.js       Plotly figure builders for each view
  js/app.js         control wiring + state
  data/extract.csv  bundled sample dataset
```
