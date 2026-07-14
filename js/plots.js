/* plots.js — Plotly figure builders for each view. Exposes global `Plots`.
 * Each builder takes the filtered rows + options and renders into #plot. */

(function (global) {
  "use strict";

  const D = global.DataStore;
  const PLOT = "plot";

  // Light theme — matches css/style.css (teal accent, crimson highlight).
  const C = {
    teal: "#0f766e",
    tealSoft: "rgba(15,118,110,0.16)",
    crimson: "#d6336c",
    grey: "#94a3b8",
    scale: "Viridis",
  };
  const THEME = {
    paper_bgcolor: "#ffffff",
    plot_bgcolor: "#ffffff",
    font: { color: "#1f2933", family: "Inter, -apple-system, Segoe UI, Roboto, sans-serif" },
    margin: { l: 70, r: 30, t: 46, b: 60 },
    hovermode: "closest",
    title: { font: { size: 15 } },
  };
  const AXIS = { gridcolor: "#e7ebf0", zerolinecolor: "#cdd5de", linecolor: "#cdd5de" };

  // Ablator material → shell tint (Reactor view). Falls back to a neutral grey.
  const MATERIALS = {
    HDC: "#d7d2c4", CH: "#e6dcc8", Be: "#cfd8e3", B: "#d6cfe3",
    C: "#c8ccd2", diamond: "#dfe7ee", DT: "#9fe6d8",
  };
  const CONFIG = { responsive: true, displaylogo: false };

  function axis(title, log) {
    return Object.assign({ title: { text: title }, type: log ? "log" : "linear" }, AXIS);
  }

  // Build hover text + a stable customdata index back into the source rows.
  function hoverText(r) {
    const f = (k) => {
      const v = D.num(r[k]);
      return Number.isFinite(v) ? v.toPrecision(4) : "—";
    };
    return [
      `gen ${r.__gen} · ${r.__feasible ? "feasible" : "infeasible"}`,
      `${D.label("P_electric_net")}: ${f("P_electric_net")}`,
      `${D.label("levelized_CoE")}: ${f("levelized_CoE")}`,
      `${D.label("E_driver")}: ${f("E_driver")}`,
      `${D.label("rep_rate")}: ${f("rep_rate")}`,
    ].join("<br>");
  }

  const Plots = {
    /** Pareto Explorer: objective-x vs objective-y, colored by generation. */
    pareto(rows, { showFront = true } = {}) {
      const xKey = D.OBJECTIVES.x.key, yKey = D.OBJECTIVES.y.key;
      const pts = rows
        .map((r) => ({ r, x: D.num(r[xKey]), y: D.num(r[yKey]) }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

      const scatter = {
        type: "scattergl",
        mode: "markers",
        x: pts.map((p) => p.x),
        y: pts.map((p) => p.y),
        text: pts.map((p) => hoverText(p.r)),
        customdata: pts.map((p) => p.r.__idx),
        hovertemplate: "%{text}<extra></extra>",
        marker: {
          size: 6,
          color: pts.map((p) => p.r.__gen),
          colorscale: C.scale,
          colorbar: { title: { text: "gen" }, thickness: 12 },
          line: { width: 0 },
          opacity: 0.8,
        },
        name: "designs",
      };

      const traces = [scatter];
      if (showFront) {
        const front = D.paretoFront(rows);
        traces.push({
          type: "scatter",
          mode: "lines+markers",
          x: front.map((p) => p.x),
          y: front.map((p) => p.y),
          customdata: front.map((p) => p.r.__idx),
          line: { color: C.crimson, width: 2 },
          marker: { color: C.crimson, size: 8, symbol: "diamond", line: { color: "#fff", width: 1 } },
          name: "Pareto front",
          hovertemplate: "Pareto front<extra></extra>",
        });
      }

      const layout = Object.assign({}, THEME, {
        title: { text: "Pareto: net electric power (max) vs levelized CoE (min)" },
        xaxis: axis(D.label(xKey)),
        yaxis: axis(D.label(yKey)),
        showlegend: true,
        legend: { x: 1, y: 1, xanchor: "right", bgcolor: "rgba(0,0,0,0)" },
      });
      Plotly.react(PLOT, traces, layout, CONFIG);
    },

    /** Scatter Explorer: arbitrary x/y/color/size. */
    scatter(rows, { x, y, color, size, xlog, ylog } = {}) {
      const pts = rows
        .map((r) => ({ r, x: D.num(r[x]), y: D.num(r[y]) }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) &&
                       (!xlog || p.x > 0) && (!ylog || p.y > 0));

      const marker = { size: 6, opacity: 0.8, line: { width: 0 } };
      if (color && color !== "(none)") {
        marker.color = pts.map((p) => D.num(p.r[color]));
        marker.colorscale = C.scale;
        marker.colorbar = { title: { text: D.label(color) }, thickness: 12 };
      } else {
        marker.color = C.teal;
      }
      if (size && size !== "(none)") {
        const vals = pts.map((p) => D.num(p.r[size]));
        const finite = vals.filter(Number.isFinite);
        const lo = Math.min(...finite), hi = Math.max(...finite);
        const span = hi - lo || 1;
        marker.size = vals.map((v) => Number.isFinite(v) ? 5 + 18 * (v - lo) / span : 5);
      }

      const trace = {
        type: "scattergl",
        mode: "markers",
        x: pts.map((p) => p.x),
        y: pts.map((p) => p.y),
        text: pts.map((p) => hoverText(p.r)),
        customdata: pts.map((p) => p.r.__idx),
        hovertemplate: "%{text}<extra></extra>",
        marker,
      };
      const layout = Object.assign({}, THEME, {
        title: { text: `${D.label(y)} vs ${D.label(x)}` },
        xaxis: axis(D.label(x), xlog),
        yaxis: axis(D.label(y), ylog),
      });
      Plotly.react(PLOT, [trace], layout, CONFIG);
    },

    /** Distribution: histogram of one column, optionally split by feasibility. */
    dist(rows, { col, bins = 40, split = false } = {}) {
      const make = (subset, name, colr) => {
        const vals = subset.map((r) => D.num(r[col])).filter(Number.isFinite);
        return {
          type: "histogram",
          x: vals,
          name,
          marker: { color: colr },
          opacity: split ? 0.65 : 0.85,
          nbinsx: bins,
        };
      };
      let traces;
      if (split) {
        traces = [
          make(rows.filter((r) => r.__feasible), "feasible", C.teal),
          make(rows.filter((r) => !r.__feasible), "infeasible", C.crimson),
        ];
      } else {
        traces = [make(rows, "all", C.teal)];
      }
      const layout = Object.assign({}, THEME, {
        title: { text: `Distribution of ${D.label(col)}` },
        xaxis: axis(D.label(col)),
        yaxis: axis("count"),
        barmode: "overlay",
        bargap: 0.02,
      });
      Plotly.react(PLOT, traces, layout, CONFIG);
    },

    /**
     * Convergence: best objective value so far vs generation, plus feasible count.
     * objKey/sense pick the objective; feasibleOnly restricts to feasible designs.
     */
    convergence(rows, { objKey, sense, feasibleOnly = true } = {}) {
      const pool = feasibleOnly ? rows.filter((r) => r.__feasible) : rows;
      // group by generation
      const byGen = new Map();
      for (const r of pool) {
        const g = r.__gen;
        if (!Number.isFinite(g)) continue;
        const v = D.num(r[objKey]);
        if (!Number.isFinite(v)) continue;
        if (!byGen.has(g)) byGen.set(g, []);
        byGen.get(g).push(v);
      }
      const gens = [...byGen.keys()].sort((a, b) => a - b);
      const bestPerGen = gens.map((g) => {
        const vs = byGen.get(g);
        return sense === "max" ? Math.max(...vs) : Math.min(...vs);
      });
      // running best across generations
      const running = [];
      let acc = sense === "max" ? -Infinity : Infinity;
      for (const b of bestPerGen) {
        acc = sense === "max" ? Math.max(acc, b) : Math.min(acc, b);
        running.push(acc);
      }
      const counts = gens.map((g) => byGen.get(g).length);

      const traces = [
        {
          type: "scatter", mode: "markers", name: "best in gen",
          x: gens, y: bestPerGen,
          marker: { color: C.grey, size: 6 },
        },
        {
          type: "scatter", mode: "lines+markers", name: "running best",
          x: gens, y: running,
          line: { color: C.teal, width: 2.5 },
        },
        {
          type: "bar", name: "# designs", x: gens, y: counts,
          yaxis: "y2", marker: { color: C.tealSoft },
        },
      ];
      const layout = Object.assign({}, THEME, {
        title: { text: `Convergence — ${sense} ${D.label(objKey)}` },
        xaxis: axis("generation"),
        yaxis: axis(D.label(objKey)),
        yaxis2: Object.assign({ title: { text: "count" }, overlaying: "y", side: "right", showgrid: false }, AXIS),
        legend: { x: 0.01, y: 0.99, bgcolor: "rgba(0,0,0,0)" },
      });
      Plotly.react(PLOT, traces, layout, CONFIG);
    },

    /**
     * Reactor: a single design rendered as an IFE target cross-section with
     * converging driver beams and an implosion→ignition animation loop.
     * Not a Plotly figure — builds an SVG directly into #plot.
     */
    reactor(row, { animate = true } = {}) {
      const el = document.getElementById(PLOT);
      // Tear down any prior animation + Plotly internals on the shared div.
      this._reactorStop();
      try { Plotly.purge(PLOT); } catch (_) { /* not a Plotly div */ }

      if (!row) {
        el.innerHTML =
          `<div class="reactor-empty">No design to show.<br>Load data or pick a design.</div>`;
        return;
      }

      const n = (k) => D.num(row[k]);
      const f3 = (v) => (Number.isFinite(v) ? v.toPrecision(3) : "—");

      // ----- physical inputs (mm) -----
      const cx = 380, cy = 312, chamberR = 250;
      const Rt = n("R_target"), Rf = n("R_fuel"), Rh = n("R_hotspot");
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

      // ----- chamber radius (real, from the dd) -----
      // TODO(extract_ife): add `R_chamber` [m] to extract_ife(dd). Until then we
      // fall back to a labelled placeholder so the scale still renders.
      let Rcham_m = n("R_chamber");
      const chamberPlaceholder = !Number.isFinite(Rcham_m);
      if (chamberPlaceholder) Rcham_m = 6.0;
      const Rcham_mm = Rcham_m * 1000;
      const ratio = Number.isFinite(Rt) && Rt > 0 ? Rcham_mm / Rt : NaN;

      // ----- continuous logarithmic radial scale (physical radius -> screen px) -----
      // Small features (hotspot/fuel) are expanded, the chamber compressed, so the
      // full pellet→chamber span (~1000×) fits honestly on one continuous axis.
      const loPhys = Number.isFinite(Rh) && Rh > 0 ? Rh
        : (Number.isFinite(Rf) && Rf > 0 ? Rf * 0.3 : 0.2);
      const lnLo = Math.log(loPhys), lnHi = Math.log(Rcham_mm), pxLo = 30, pxHi = 196;
      const toPx = (r) => pxLo + (pxHi - pxLo) * (Math.log(r) - lnLo) / (lnHi - lnLo);
      const rHot = Number.isFinite(Rh) && Rh > 0 ? toPx(Rh) : pxLo;
      const rFuel = Number.isFinite(Rf) && Rf > 0 ? toPx(Rf) : pxLo + 16;
      const rOuter = Number.isFinite(Rt) && Rt > 0 ? toPx(Rt) : pxLo + 28;
      const firstWallR = pxHi, blanketInner = pxHi, blanketOuter = pxHi + 30, vesselR = pxHi + 34;

      const nBeams = clamp(Math.round(n("n_beams")) || 12, 3, 48);
      const Edrv = n("E_driver");
      const ws = clamp(Number.isFinite(Edrv) ? 0.7 + (Edrv - 1) * 0.22 : 1, 0.7, 1.6);

      // polar→cartesian + 1-dp formatter, used by every chamber primitive
      const P = (r, a) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
      const f1 = (v) => v.toFixed(1);
      const beamAngles = [];
      for (let i = 0; i < nBeams; i++) beamAngles.push(-Math.PI / 2 + (2 * Math.PI * i) / nBeams);

      // ----- driver beams + final-optic ports through the blanket -----
      let beams = "", ports = "";
      for (const a of beamAngles) {
        const px = -Math.sin(a), py = Math.cos(a);
        const oR = blanketOuter - 2, iR = rOuter + 5;
        const hwO = 13 * ws, hwI = 2.6;
        const [ox, oy] = P(oR, a), [ix, iy] = P(iR, a);
        const pts = [
          [ox + px * hwO, oy + py * hwO], [ix + px * hwI, iy + py * hwI],
          [ix - px * hwI, iy - py * hwI], [ox - px * hwO, oy - py * hwO],
        ].map((p) => `${f1(p[0])},${f1(p[1])}`).join(" ");
        beams += `<polygon points="${pts}" fill="url(#beamGrad)"/>`
              +  `<line x1="${f1(ox)}" y1="${f1(oy)}" x2="${f1(ix)}" y2="${f1(iy)}" class="reactor-beamcore"/>`;
        // glassy final-optic at the vessel
        const [lx, ly] = P(blanketOuter + 1, a);
        ports += `<ellipse cx="${f1(lx)}" cy="${f1(ly)}" rx="${(hwO + 4).toFixed(1)}" ry="5.5"`
              +  ` transform="rotate(${(a * 180 / Math.PI + 90).toFixed(1)} ${f1(lx)} ${f1(ly)})" class="reactor-optic"/>`;
      }

      // ----- neutron burst (radial, lights on ignition) -----
      let neutrons = "";
      for (let i = 0; i < 72; i++) {
        const a = (2 * Math.PI * i) / 72;
        const [x0, y0] = P(rOuter * 0.35, a), [x1, y1] = P(firstWallR - 3, a);
        neutrons += `<line x1="${f1(x0)}" y1="${f1(y0)}" x2="${f1(x1)}" y2="${f1(y1)}"/>`;
      }

      // ----- log radial scale legend (decade ticks along the bottom) -----
      const ratioTxt = Number.isFinite(ratio) ? Math.round(ratio).toLocaleString() : "—";
      const phMark = chamberPlaceholder ? " · R_chamber placeholder" : "";
      const ruler = (() => {
        const y = 598, x0 = 250, W = 330;
        const lo = Math.min(0.1, Number.isFinite(Rh) && Rh > 0 ? Rh : 0.1), hi = Rcham_mm;
        const lnlo = Math.log(lo), lnhi = Math.log(hi);
        const X = (v) => x0 + W * (Math.log(v) - lnlo) / (lnhi - lnlo);
        const fmt = (mm) => mm >= 1000 ? `${(mm / 1000).toPrecision(2)} m`
          : mm >= 10 ? `${(mm / 10).toPrecision(2)} cm` : `${mm.toPrecision(2)} mm`;
        const ticks = [0.1, 1, 10, 100, 1000].filter((v) => v >= lo && v <= hi).concat([hi]);
        let s = `<line x1="${x0}" y1="${y}" x2="${x0 + W}" y2="${y}" class="ruler-bar"/>`;
        for (const v of ticks) {
          const x = X(v).toFixed(1);
          s += `<line x1="${x}" y1="${y - 5}" x2="${x}" y2="${y + 5}" class="ruler-tick"/>`
            +  `<text x="${x}" y="${y + 16}" text-anchor="middle" class="ruler-brk">${fmt(v)}</text>`;
        }
        return s + `<text x="${x0}" y="${y - 9}" class="ruler-note">log radial scale · pellet→chamber ≈ ${ratioTxt}×${phMark}</text>`;
      })();

      const ablColor = MATERIALS[String(row.ablator)] || "#cdd5de";

      // ----- HUD stats -----
      const stats = [
        ["NET ELECTRIC", `${f3(n("P_electric_net"))} MW`],
        ["TARGET GAIN", `${f3(n("Q_target"))}×`],
        ["DRIVER", `${f3(Edrv)} MJ · ${nBeams} beams`],
        ["PEAK FUSION", `${f3(n("P_fus_peak"))} MW`],
        ["NEUTRON PWR", `${f3(n("P_neutron_avg"))} MW`],
        ["WALL LOAD", `${f3(n("peak_wall_flux_avg"))}`],
        ["REP RATE", `${f3(n("rep_rate"))} Hz`],
        ["ABLATOR", String(row.ablator ?? "—")],
      ];
      let hud = "";
      stats.forEach(([k, v], i) => {
        const y = 438 + i * 22;
        hud += `<text x="30" y="${y}" class="hud-k">${k}</text>`
            +  `<text x="172" y="${y}" class="hud-v">${v}</text>`;
      });

      // ----- callouts: target layers (right column) + chamber (left column) -----
      // Each is a 2-line block (name / value) anchored in a fixed side column, with a
      // short leader from a dot on the feature — keeps labels off the long radial fans.
      const callout = (angDeg, rDot, lx, ly, name, value, anchor) => {
        const a = (angDeg * Math.PI) / 180;
        const [sx, sy] = P(rDot, a);
        const tx = lx + (anchor === "end" ? -6 : 6);
        return `<line x1="${f1(sx)}" y1="${f1(sy)}" x2="${f1(lx)}" y2="${f1(ly)}" class="reactor-lead"/>`
             + `<circle cx="${f1(sx)}" cy="${f1(sy)}" r="2.4" class="reactor-leaddot"/>`
             + `<text y="${f1(ly)}" text-anchor="${anchor}" class="hud-call">`
             +   `<tspan x="${f1(tx)}" class="hud-call-name">${name}</tspan>`
             +   `<tspan x="${f1(tx)}" dy="13" class="hud-call-val">${value}</tspan>`
             + `</text>`;
      };
      const rBlanketMid = (blanketInner + blanketOuter) / 2;
      const callouts =
        // target layers — right column, anchored at x = 602
        callout(-35, rOuter, 602, 248, "ablator", `${f3(Rt)} mm`, "start") +
        callout(0, rFuel, 602, 306, "DT fuel", `${f3(Rf)} mm`, "start") +
        callout(35, rHot, 602, 364, "hotspot", `${f3(Rh)} mm`, "start") +
        // chamber — left column, anchored at x = 158
        callout(205, rBlanketMid, 158, 248, "breeding blanket", `TBR ${f3(n("TBR"))}`, "end") +
        callout(158, firstWallR, 158, 364, "first wall", `R ${f3(Rcham_m)} m`, "end");

      el.innerHTML = `
<svg class="reactor-svg" viewBox="0 0 760 624" preserveAspectRatio="xMidYMid meet">
  <defs>
    <radialGradient id="chamberBg" cx="50%" cy="46%" r="62%">
      <stop offset="0%" stop-color="#101a2e"/>
      <stop offset="60%" stop-color="#0a1120"/>
      <stop offset="100%" stop-color="#05080f"/>
    </radialGradient>
    <radialGradient id="beamGrad" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${chamberR}">
      <stop offset="0%" stop-color="#fffdf5" stop-opacity="0.95"/>
      <stop offset="32%" stop-color="#ffd27a" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#ff8a3c" stop-opacity="0.12"/>
    </radialGradient>
    <radialGradient id="fuelGrad" cx="38%" cy="34%" r="75%">
      <stop offset="0%" stop-color="#dff4ff"/>
      <stop offset="60%" stop-color="#8fd0ef"/>
      <stop offset="100%" stop-color="#4f9fce"/>
    </radialGradient>
    <linearGradient id="blanketGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#243752"/>
      <stop offset="100%" stop-color="#151f33"/>
    </linearGradient>
    <radialGradient id="opticGrad" cx="50%" cy="32%" r="72%">
      <stop offset="0%" stop-color="#e6faff" stop-opacity="0.95"/>
      <stop offset="55%" stop-color="#7fc6d8" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#2a6b7e" stop-opacity="0.7"/>
    </radialGradient>
    <radialGradient id="ablGrad" cx="38%" cy="34%" r="78%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.85"/>
      <stop offset="45%" stop-color="${ablColor}"/>
      <stop offset="100%" stop-color="#5b6675"/>
    </radialGradient>
    <radialGradient id="hotGrad" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="40%" stop-color="#ffe7a3"/>
      <stop offset="100%" stop-color="#ff8a1e"/>
    </radialGradient>
    <radialGradient id="igniteGrad" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="1"/>
      <stop offset="35%" stop-color="#ffe08a" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#ff7a1e" stop-opacity="0"/>
    </radialGradient>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="6" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <rect x="0" y="0" width="760" height="624" fill="url(#chamberBg)"/>
  <text x="30" y="44" class="hud-title">IFE REACTOR CHAMBER — CROSS SECTION</text>
  <text x="30" y="62" class="hud-sub">log radial scale</text>

  <!-- chamber: vessel · breeding blanket · ports · first wall -->
  <circle cx="${cx}" cy="${cy}" r="${vesselR}" class="reactor-vessel"/>
  <circle class="reactor-blanketglow" cx="${cx}" cy="${cy}" r="${rBlanketMid.toFixed(1)}"
          stroke-width="${(blanketOuter - blanketInner).toFixed(1)}" filter="url(#glow)"/>
  <g class="reactor-ports">${ports}</g>
  <circle cx="${cx}" cy="${cy}" r="${firstWallR}" class="reactor-firstwall"/>
  <circle class="reactor-wallglow" cx="${cx}" cy="${cy}" r="${firstWallR}" filter="url(#glow)"/>

  <g class="reactor-neutrons" filter="url(#glow)">${neutrons}</g>
  <g class="reactor-beams" filter="url(#glow)">${beams}</g>

  <circle class="reactor-ignite" cx="${cx}" cy="${cy}" r="${(rOuter * 1.5).toFixed(1)}" fill="url(#igniteGrad)" filter="url(#glow)"/>

  <g class="reactor-shells">
    <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="url(#ablGrad)" class="reactor-abl"/>
    <circle cx="${cx}" cy="${cy}" r="${rFuel.toFixed(1)}" fill="url(#fuelGrad)" class="reactor-fuel"/>
    <circle cx="${cx}" cy="${cy}" r="${rHot.toFixed(1)}" fill="url(#hotGrad)" filter="url(#glow)" class="reactor-hot"/>
  </g>

  <circle class="reactor-flash" cx="${cx}" cy="${cy}" r="${chamberR}" fill="#ffffff" opacity="0"/>

  ${callouts}
  ${hud}
  ${ruler}
</svg>`;

      // Period loosely scaled by rep rate, kept watchable.
      const repHz = n("rep_rate");
      const period = clamp(6000 / Math.cbrt(Number.isFinite(repHz) && repHz > 0 ? repHz : 1), 2000, 4200);
      this._reactorBuildPlay(el, period);
      if (animate) this._reactorPlay(Infinity);
    },

    /** Build (but don't start) the implosion timeline for the current SVG. */
    _reactorBuildPlay(el, period) {
      const q = (s) => el.querySelector(s);
      const shells = q(".reactor-shells"), beams = q(".reactor-beams");
      const ignite = q(".reactor-ignite"), flash = q(".reactor-flash");
      const neutrons = q(".reactor-neutrons");
      const blanketGlow = q(".reactor-blanketglow"), wallGlow = q(".reactor-wallglow");
      const opt = { duration: period, easing: "ease-in-out", fill: "both" };

      this._reactorPlay = (iterations) => {
        this._reactorStop();
        const A = [];
        const add = (node, frames) => { if (node) A.push(node.animate(frames, { ...opt, iterations })); };
        add(shells, [
          { transform: "scale(1)", offset: 0 },
          { transform: "scale(1)", offset: 0.20, easing: "cubic-bezier(.6,0,.9,.35)" },
          { transform: "scale(0.40)", offset: 0.50, easing: "ease-out" },
          { transform: "scale(0.44)", offset: 0.60 },
          { transform: "scale(1.06)", offset: 0.82 },
          { transform: "scale(1)", offset: 1 },
        ]);
        add(beams, [
          { opacity: 0.06, offset: 0 },
          { opacity: 0.95, offset: 0.18, easing: "ease-out" },
          { opacity: 1, offset: 0.46 },
          { opacity: 0.08, offset: 0.54 },
          { opacity: 0.06, offset: 1 },
        ]);
        add(ignite, [
          { opacity: 0, transform: "scale(0.3)", offset: 0 },
          { opacity: 0, transform: "scale(0.3)", offset: 0.48 },
          { opacity: 1, transform: "scale(1.7)", offset: 0.58, easing: "ease-out" },
          { opacity: 0.8, transform: "scale(1.5)", offset: 0.66 },
          { opacity: 0, transform: "scale(2.3)", offset: 0.86 },
          { opacity: 0, transform: "scale(0.3)", offset: 1 },
        ]);
        add(flash, [
          { opacity: 0, offset: 0 }, { opacity: 0, offset: 0.52 },
          { opacity: 0.5, offset: 0.57, easing: "ease-out" },
          { opacity: 0, offset: 0.7 }, { opacity: 0, offset: 1 },
        ]);
        // neutrons stream out at ignition and heat the blanket / first wall
        add(neutrons, [
          { opacity: 0, offset: 0 }, { opacity: 0, offset: 0.5 },
          { opacity: 0.85, offset: 0.6, easing: "ease-out" },
          { opacity: 0.25, offset: 0.74 }, { opacity: 0, offset: 0.92 }, { opacity: 0, offset: 1 },
        ]);
        add(wallGlow, [
          { opacity: 0, offset: 0 }, { opacity: 0, offset: 0.53 },
          { opacity: 0.7, offset: 0.61, easing: "ease-out" },
          { opacity: 0, offset: 0.8 }, { opacity: 0, offset: 1 },
        ]);
        add(blanketGlow, [
          { opacity: 0, offset: 0 }, { opacity: 0, offset: 0.56 },
          { opacity: 0.5, offset: 0.66 }, { opacity: 0.18, offset: 0.82 },
          { opacity: 0, offset: 1 },
        ]);
        this._reactorAnims = A;
      };
    },

    /** Restart the implosion once (used by the Fire button). */
    reactorFire() { if (this._reactorPlay) this._reactorPlay(1); },

    /** Cancel any running reactor animations. */
    _reactorStop() {
      (this._reactorAnims || []).forEach((a) => { try { a.cancel(); } catch (_) {} });
      this._reactorAnims = [];
    },

    onClick(handler) {
      const el = document.getElementById(PLOT);
      // Clear any prior binding so repeated renders don't stack handlers.
      if (typeof el.removeAllListeners === "function") el.removeAllListeners("plotly_click");
      el.on("plotly_click", (ev) => {
        const pt = ev.points && ev.points[0];
        if (pt && pt.customdata != null) handler(pt.customdata);
      });
    },
  };

  global.Plots = Plots;
})(window);
