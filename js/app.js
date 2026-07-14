/* app.js — wires controls <-> data <-> plots. Global state + event handlers. */

(function () {
  "use strict";

  const D = window.DataStore;
  const P = window.Plots;

  const state = {
    view: "pareto",
    filters: { successOnly: true, feasibleOnly: false, genLo: 0, genHi: 0 },
    scatter: { x: "P_electric_net", y: "levelized_CoE", color: "gen", size: "(none)", xlog: false, ylog: false },
    dist: { col: "P_electric_net", bins: 40, split: false },
    convergence: { objKey: "P_electric_net", sense: "max", feasibleOnly: true },
    pareto: { showFront: true },
    reactor: { mode: "selected", idx: null, animate: true },
  };

  const $ = (id) => document.getElementById(id);

  // ---------- data load ----------
  function afterLoad() {
    // index rows for click->detail lookups
    D.rows.forEach((r, i) => { r.__idx = i; });

    $("datastatus").textContent =
      `${D.sourceName} · ${D.rows.length} rows · gen ${D.genMin}–${D.genMax}`;

    // generation sliders
    const lo = $("f-gen-lo"), hi = $("f-gen-hi");
    lo.min = hi.min = D.genMin; lo.max = hi.max = D.genMax;
    lo.value = D.genMin; hi.value = D.genMax;
    state.filters.genLo = D.genMin; state.filters.genHi = D.genMax;
    updateGenLabel();

    populateColumnPickers();
    render();
  }

  function loadText(text, name) {
    try {
      D.loadCSV(text, name);
      afterLoad();
    } catch (e) {
      console.error(e);
      $("datastatus").textContent = "failed to parse CSV";
    }
  }

  function loadBundled() {
    fetch("data/extract.csv", { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then((t) => loadText(t, "extract.csv (bundled)"))
      .catch(() => {
        $("datastatus").textContent = "drop an extract.csv to begin";
      });
  }

  // ---------- column pickers ----------
  function fillSelect(sel, cols, { withNone = false, noneLabel = "(none)", selected } = {}) {
    sel.innerHTML = "";
    if (withNone) sel.add(new Option(noneLabel, "(none)"));
    for (const c of cols) sel.add(new Option(D.label(c), c));
    if (selected && cols.includes(selected)) sel.value = selected;
  }

  function populateColumnPickers() {
    const numeric = D.numericCols;

    fillSelect($("s-x"), numeric, { selected: pick(numeric, ["P_electric_net", numeric[0]]) });
    fillSelect($("s-y"), numeric, { selected: pick(numeric, ["levelized_CoE", numeric[1]]) });
    // color picker: numeric + "gen" pseudo-option
    const colorSel = $("s-color");
    colorSel.innerHTML = "";
    colorSel.add(new Option("generation", "gen"));
    colorSel.add(new Option("(none)", "(none)"));
    for (const c of numeric) colorSel.add(new Option(D.label(c), c));
    colorSel.value = "gen";
    fillSelect($("s-size"), numeric, { withNone: true, selected: "(none)" });
    $("s-size").value = "(none)";

    state.scatter.x = $("s-x").value;
    state.scatter.y = $("s-y").value;
    state.scatter.color = "gen";
    state.scatter.size = "(none)";

    fillSelect($("d-col"), numeric, { selected: pick(numeric, ["P_electric_net", numeric[0]]) });
    state.dist.col = $("d-col").value;
  }

  function pick(cols, prefs) {
    for (const p of prefs) if (p && cols.includes(p)) return p;
    return cols[0];
  }

  // ---------- view switching ----------
  function activateView(view) {
    state.view = view;
    document.querySelectorAll(".tab").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === view));
    document.querySelectorAll(".view-controls").forEach((p) =>
      p.classList.toggle("hidden", p.dataset.view !== view));
    render();
  }

  // ---------- render ----------
  function currentRows() {
    return D.filter(state.filters);
  }

  function render() {
    if (!D.rows.length) return;
    const rows = currentRows();
    $("filter-count").textContent = `${rows.length} of ${D.rows.length} rows shown`;

    switch (state.view) {
      case "pareto":
        P.pareto(rows, state.pareto); break;
      case "scatter": {
        const s = state.scatter;
        // "gen" reads the raw numeric `gen` column; "(none)" → flat color.
        P.scatter(rows, {
          x: s.x, y: s.y, color: s.color,
          size: s.size, xlog: s.xlog, ylog: s.ylog,
        });
        break;
      }
      case "dist":
        P.dist(rows, state.dist); break;
      case "convergence":
        P.convergence(rows, state.convergence); break;
      case "reactor":
        P.reactor(reactorRow(), { animate: state.reactor.animate }); break;
    }

    // Rebind click->select after every Plotly render. The Reactor view purges
    // the div (dropping listeners), so a one-time binding wouldn't survive it.
    if (state.view !== "reactor") P.onClick(selectDesign);
  }

  // ---------- reactor (single design) ----------
  // Resolve which one design the Reactor view should portray.
  function reactorRow() {
    const m = state.reactor.mode;
    if (m === "selected" && state.reactor.idx != null) return D.rows[state.reactor.idx];
    const presets = {
      maxpow: ["P_electric_net", "max"],
      mincoe: ["levelized_CoE", "min"],
      maxgain: ["Q_target", "max"],
    };
    const [key, sense] = presets[m] || presets.maxpow;
    let best = null, bestV = sense === "max" ? -Infinity : Infinity;
    for (const r of D.rows) {
      if (!r.__success) continue;
      const v = D.num(r[key]);
      if (!Number.isFinite(v)) continue;
      if (sense === "max" ? v > bestV : v < bestV) { bestV = v; best = r; }
    }
    return best || (state.reactor.idx != null ? D.rows[state.reactor.idx] : D.rows[0]) || null;
  }

  // ---------- click a point -> open that design in the Reactor view ----------
  function selectDesign(idx) {
    const r = D.rows[idx];
    if (!r) return;
    // Remember the clicked design and surface it in the Reactor view.
    state.reactor.idx = idx;
    state.reactor.mode = "selected";
    const rsel = $("r-design");
    if (rsel) rsel.value = "selected";
    fillDetail(r);
    activateView("reactor");
  }

  // ---------- detail panel ----------
  function fillDetail(r) {
    const tbl = $("detail-table");
    tbl.innerHTML = "";
    const order = ["gen", "status", "P_electric_net", "levelized_CoE",
      "E_driver", "eta_conversion", "rep_rate", "R_fuel", "ablator",
      "P_fus_avg", "Q_plant", "Q_target", "TBR", "capital_cost"];
    const seen = new Set();
    const addRow = (k) => {
      if (seen.has(k) || !(k in r)) return;
      seen.add(k);
      const v = r[k];
      const num = D.num(v);
      const disp = Number.isFinite(num) ? num.toPrecision(5) : (v == null ? "—" : String(v));
      const tr = tbl.insertRow();
      tr.insertCell().textContent = D.label(k);
      tr.insertCell().textContent = disp;
    };
    order.forEach(addRow);
    // then everything else
    D.columns.forEach(addRow);
    $("detail").classList.remove("hidden");
  }

  // ---------- events ----------
  function updateGenLabel() {
    const { genLo, genHi } = state.filters;
    $("f-gen-label").textContent =
      (genLo === D.genMin && genHi === D.genMax) ? "all" : `${genLo}–${genHi}`;
  }

  function wireEvents() {
    // tabs
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => activateView(btn.dataset.view));
    });

    // global filters
    $("f-success").addEventListener("change", (e) => { state.filters.successOnly = e.target.checked; render(); });
    $("f-feasible").addEventListener("change", (e) => { state.filters.feasibleOnly = e.target.checked; render(); });

    const lo = $("f-gen-lo"), hi = $("f-gen-hi");
    const onGen = () => {
      let a = +lo.value, b = +hi.value;
      if (a > b) { [a, b] = [b, a]; }
      state.filters.genLo = a; state.filters.genHi = b;
      updateGenLabel(); render();
    };
    lo.addEventListener("input", onGen);
    hi.addEventListener("input", onGen);

    $("reset-filters").addEventListener("click", () => {
      state.filters = { successOnly: true, feasibleOnly: false, genLo: D.genMin, genHi: D.genMax };
      $("f-success").checked = true; $("f-feasible").checked = false;
      lo.value = D.genMin; hi.value = D.genMax;
      updateGenLabel(); render();
    });

    // pareto
    $("pareto-front").addEventListener("change", (e) => { state.pareto.showFront = e.target.checked; render(); });

    // scatter
    $("s-x").addEventListener("change", (e) => { state.scatter.x = e.target.value; render(); });
    $("s-y").addEventListener("change", (e) => { state.scatter.y = e.target.value; render(); });
    $("s-color").addEventListener("change", (e) => { state.scatter.color = e.target.value; render(); });
    $("s-size").addEventListener("change", (e) => { state.scatter.size = e.target.value; render(); });
    $("s-xlog").addEventListener("change", (e) => { state.scatter.xlog = e.target.checked; render(); });
    $("s-ylog").addEventListener("change", (e) => { state.scatter.ylog = e.target.checked; render(); });

    // distributions
    $("d-col").addEventListener("change", (e) => { state.dist.col = e.target.value; render(); });
    $("d-bins").addEventListener("change", (e) => { state.dist.bins = Math.max(5, +e.target.value || 40); render(); });
    $("d-split").addEventListener("change", (e) => { state.dist.split = e.target.checked; render(); });

    // convergence
    $("c-obj").addEventListener("change", (e) => {
      const [objKey, sense] = e.target.value.split("|");
      state.convergence.objKey = objKey; state.convergence.sense = sense; render();
    });
    $("c-feasible").addEventListener("change", (e) => { state.convergence.feasibleOnly = e.target.checked; render(); });

    // reactor
    $("r-design").addEventListener("change", (e) => { state.reactor.mode = e.target.value; render(); });
    $("r-animate").addEventListener("change", (e) => { state.reactor.animate = e.target.checked; render(); });
    $("r-fire").addEventListener("click", () => { if (state.view === "reactor") P.reactorFire(); });

    // detail close
    $("detail-close").addEventListener("click", () => $("detail").classList.add("hidden"));
    // (plot click -> detail is bound after the first render, see render())

    // file load (drag/drop + click)
    const dz = $("dropzone"), fi = $("fileinput");
    dz.addEventListener("click", () => fi.click());
    fi.addEventListener("change", () => { if (fi.files[0]) readFile(fi.files[0]); });
    ["dragenter", "dragover"].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragover"); }));
    ["dragleave", "drop"].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragover"); }));
    dz.addEventListener("drop", (e) => {
      const f = e.dataTransfer.files[0];
      if (f) readFile(f);
    });
  }

  function readFile(file) {
    const fr = new FileReader();
    fr.onload = () => loadText(fr.result, file.name);
    fr.readAsText(file);
  }

  // ---------- boot ----------
  document.addEventListener("DOMContentLoaded", () => {
    wireEvents();
    // Deep link: #<view> opens that tab on load (e.g. index.html#reactor).
    const hash = (location.hash || "").slice(1);
    const tab = hash && document.querySelector(`.tab[data-view="${hash}"]`);
    if (tab) tab.click();
    loadBundled();
  });
})();
