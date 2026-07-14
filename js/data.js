/* data.js — CSV loading, cleaning, column metadata, feasibility, Pareto front.
 * Exposes a single global `DataStore`. No modules / build step (static site). */

(function (global) {
  "use strict";

  // Friendly labels + units for the columns we care about most. Anything not
  // listed falls back to its raw column name.
  const LABELS = {
    P_electric_net:       "Net electric power [MW]",
    P_electric_generated: "Gross electric power [MW]",
    power_electric_net:   "Net power (constraint, norm.)",
    levelized_CoE:        "Levelized CoE",
    E_driver:             "Driver energy [MJ]",
    eta_conversion:       "Driver η (conversion)",
    eta_coupling:         "Coupling η",
    eta_thermal:          "Thermal η",
    rep_rate:             "Rep rate [Hz]",
    R_fuel:               "Fuel radius [mm]",
    R_target:             "Target radius [mm]",
    R_hotspot:            "Hotspot radius",
    ablator:              "Ablator material",
    capital_cost:         "Capital cost",
    P_fus_avg:            "Fusion power, avg [MW]",
    P_fus_peak:           "Fusion power, peak [MW]",
    P_alpha_avg:          "Alpha power, avg [MW]",
    P_driver_avg:         "Driver power, avg [MW]",
    P_neutron_avg:        "Neutron power, avg [MW]",
    Q_plant:              "Plant Q",
    Q_target:             "Target Q (gain)",
    TBR:                  "Tritium breeding ratio",
    Te0_peak:             "Peak Te0",
    duty_cycle:           "Duty cycle",
    peak_wall_flux_avg:   "Peak wall flux, avg",
    n_beams:              "# driver beams",
    gen:                  "Generation",
    req_power_electric_net: "Required net electric power [MW]",
  };

  // Columns that are metadata / bookkeeping, not physics — hidden from axis pickers.
  const META_COLS = new Set([
    "gparent", "status", "case", "Ngen", "Ncase", "dir", "worker_id",
    "elapsed_time", "gen",
  ]);

  // The two optimization objectives (drives Pareto + defaults).
  const OBJECTIVES = {
    x: { key: "P_electric_net", sense: "max" },
    y: { key: "levelized_CoE",  sense: "min" },
  };

  function label(key) { return LABELS[key] || key; }

  // Coerce a parsed cell to a finite number, or NaN. PapaParse dynamicTyping
  // already converts most numbers; this catches "NaN"/"Inf"/"-Inf"/blank strings.
  function toNum(v) {
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    if (v == null) return NaN;
    const s = String(v).trim();
    if (s === "" || s === "NaN" || s === "nan") return NaN;
    if (s === "Inf" || s === "inf") return Infinity;
    if (s === "-Inf" || s === "-inf") return -Infinity;
    const n = Number(s);
    return Number.isNaN(n) ? NaN : n;
  }

  const DataStore = {
    rows: [],          // array of row objects (raw values)
    columns: [],       // all column names
    numericCols: [],   // columns usable on numeric axes (not all-NaN, not constant-meta)
    catCols: [],       // categorical columns (e.g. ablator, status)
    constraintCols: [], // detected FUSE constraint columns (drive feasibility)
    genMin: 0,
    genMax: 0,
    sourceName: "",
    OBJECTIVES,
    label,

    /** Parse a CSV string (PapaParse) and (re)build all derived metadata. */
    loadCSV(text, sourceName) {
      const parsed = Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true,
      });
      const rows = parsed.data.filter((r) => r && Object.keys(r).length > 1);
      this.rows = rows;
      this.columns = parsed.meta.fields || (rows[0] ? Object.keys(rows[0]) : []);
      this.sourceName = sourceName || "data";
      this._buildMeta();
      return this;
    },

    _buildMeta() {
      const cols = this.columns;
      const rows = this.rows;
      const numeric = [];
      const categorical = [];

      for (const c of cols) {
        if (META_COLS.has(c)) continue;
        let finiteCount = 0;
        let firstFinite = null;
        let varies = false;
        let sawString = false;
        for (const r of rows) {
          const raw = r[c];
          const n = toNum(raw);
          if (Number.isFinite(n)) {
            finiteCount++;
            if (firstFinite === null) firstFinite = n;
            else if (n !== firstFinite) varies = true;
          } else if (typeof raw === "string" && raw.trim() !== "" &&
                     raw !== "NaN" && raw !== "Inf" && raw !== "-Inf") {
            sawString = true;
          }
        }
        // Numeric column: has finite values and they actually vary.
        if (finiteCount > 0 && varies) {
          numeric.push(c);
        } else if (sawString) {
          // string-valued, more than one distinct → categorical (e.g. ablator)
          const distinct = new Set(rows.map((r) => r[c]));
          if (distinct.size > 1 && distinct.size < 40) categorical.push(c);
        }
      }

      this.numericCols = numeric;
      this.catCols = categorical;

      // Generation range
      const gens = rows.map((r) => toNum(r.gen)).filter(Number.isFinite);
      this.genMin = gens.length ? Math.min(...gens) : 0;
      this.genMax = gens.length ? Math.max(...gens) : 0;

      this.constraintCols = this._detectConstraintCols();

      // Annotate each row with numeric helpers used throughout the app.
      for (const r of rows) {
        r.__gen = toNum(r.gen);
        r.__success = String(r.status).toLowerCase() === "success";
        r.__feasible = this._isFeasible(r);
      }
    },

    /**
     * FUSE constraint functions (the `min_*`/`max_*` columns) return 0 when met
     * and a positive violation magnitude otherwise. Objective columns share the
     * same prefixes (e.g. `max_power_electric_net`, `min_capital_cost`) but hold
     * raw objective values, so a column only counts as a constraint if its data
     * has the constraint shape: never negative, and 0 in at least one row.
     * (A constraint violated in every row would be missed — no way to tell it
     * apart from an always-positive objective without run metadata.)
     */
    _detectConstraintCols() {
      const out = [];
      for (const c of this.columns) {
        if (!/^(min|max)_/.test(c)) continue;
        let finite = 0, zeros = 0, negs = 0;
        for (const r of this.rows) {
          const v = toNum(r[c]);
          if (!Number.isFinite(v)) continue;
          finite++;
          if (v < -1e-6) { negs++; break; }
          if (v <= 1e-6) zeros++;
        }
        if (finite > 0 && negs === 0 && zeros > 0) out.push(c);
      }
      return out;
    },

    /** Feasibility: succeeded AND every detected constraint satisfied. */
    _isFeasible(r) {
      if (String(r.status).toLowerCase() !== "success") return false;
      if (this.constraintCols.length) {
        for (const c of this.constraintCols) {
          const v = toNum(r[c]);
          if (Number.isFinite(v) && v > 1e-6) return false;
        }
        return true;
      }
      // fallback if no constraint columns are present: require positive net power
      const p = toNum(r.P_electric_net);
      return Number.isFinite(p) && p > 0;
    },

    num: toNum,

    /** Filter rows by the global controls. */
    filter({ successOnly = true, feasibleOnly = false, genLo = -Infinity, genHi = Infinity } = {}) {
      return this.rows.filter((r) => {
        if (successOnly && !r.__success) return false;
        if (feasibleOnly && !r.__feasible) return false;
        if (Number.isFinite(r.__gen)) {
          if (r.__gen < genLo || r.__gen > genHi) return false;
        }
        return true;
      });
    },

    /**
     * Non-dominated (Pareto) set for the two objectives over `rows`.
     * Default objectives: maximize power_electric_net, minimize levelized_CoE.
     * Returns the front rows sorted by x ascending (for a clean line overlay).
     */
    paretoFront(rows, xKey, xSense, yKey, ySense) {
      xKey = xKey || OBJECTIVES.x.key; xSense = xSense || OBJECTIVES.x.sense;
      yKey = yKey || OBJECTIVES.y.key; ySense = ySense || OBJECTIVES.y.sense;

      const pts = rows
        .map((r) => ({ r, x: toNum(r[xKey]), y: toNum(r[yKey]) }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

      // p dominates q if it is no worse in both objectives and strictly better in one.
      const better = (a, b, sense) => (sense === "max" ? a > b : a < b);
      const noWorse = (a, b, sense) => (sense === "max" ? a >= b : a <= b);

      const front = pts.filter((p) =>
        !pts.some((q) =>
          q !== p &&
          noWorse(q.x, p.x, xSense) && noWorse(q.y, p.y, ySense) &&
          (better(q.x, p.x, xSense) || better(q.y, p.y, ySense))
        )
      );

      front.sort((a, b) => a.x - b.x);
      return front;
    },
  };

  global.DataStore = DataStore;
})(window);
