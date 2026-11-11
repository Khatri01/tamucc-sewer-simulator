// The page. All computation happens in worker.js; the Map and Campus tabs are the
// dashboard's own map.js and campus.js, whose /api/... requests are answered in the
// worker by dashboard/results.py and dashboard/view.py (web_api.py).
"use strict";

const $ = (id) => document.getElementById(id);
const STAGES = ["abm", "couple", "swmm", "export", "verify"];
const STAGE_TEXT = { abm: "Simulating the agents", couple: "Coupling to the sewer network",
                     swmm: "Routing through the sewer model", export: "Reading results",
                     verify: "Running the checks" };
const WEIGHT = { abm: 0.60, couple: 0.03, swmm: 0.33, export: 0.02, verify: 0.02 };   // share of a run's time
const STATIONS = [["MH_62", "Station 1", "residence halls"], ["MH_52", "Station 2", "academic core"],
                  ["MH_60", "Station 3", "campus outlet"]];
const SOURCES = [["restroom", "Restroom"], ["shower", "Shower"], ["laundry", "Laundry"],
                 ["kitchen", "Kitchen"], ["lab", "Laboratory"]];
const AGENTS = [
  ["num-residential", "Resident students", "Live in the residence halls"],
  ["num-commuters", "Commuter students", "Come to campus for classes"],
  ["num-faculty", "Faculty and staff", "Work on campus"],
];
const URL_KEYS = { "num-residential": "residents", "num-commuters": "commuters", "num-faculty": "faculty" };

let worker = null, pyState = null, current = null, stageStart = 0, spec = null, network = null;

// The restricted edition (<html data-edition="restricted">, set by build_restricted.py) shares
// pipe length and diameter and manhole depth only, and offers result files only.
const RESTRICTED = document.documentElement.dataset.edition === "restricted";
if (RESTRICTED) {
  window.propRows = (kind, o) => {
    if (kind === "node") return [
      ["manhole", o.name + (o.kind !== "junction" ? ` (${o.kind === "storage" ? "pump station wet well" : o.kind})` : "")],
      ["monitoring station", o.sensor || "—"],
      ["receives building wastewater", o.loaded ? "yes" : "no"],
      ["depth", o.max_depth != null ? `${o.max_depth.toFixed(2)} ft` : "—"],
    ];
    if (o.kind === "pump") return [["pump", `${o.name}: ${o.from} → ${o.to}`]];
    return [
      ["pipe", `${o.name}: ${o.from} → ${o.to}`],
      ["length", o.length != null ? `${o.length.toFixed(1)} ft` : "—"],
      ["diameter", o.diameter != null ? `${(o.diameter * 12).toFixed(1)} in` : "—"],
    ];
  };
}
let charts = null;

// ------------------------------------------------------------------ tabs
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tabpanel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

// ------------------------------------------------------------------ the worker
function startWorker() {
  worker = new Worker("worker.js?v=d18ad166e4");
  worker.onmessage = onMessage;
  worker.onerror = (e) => fail("The simulation could not start: " + (e.message || "worker error"));
}

// The Python tools (about 25 MB, cached afterwards) start downloading at the first touch of the form.
function warmUp() {
  if (!worker) startWorker();
  if (!pyState) worker.postMessage({ type: "warm" });
}
for (const ev of ["pointerdown", "keydown", "focusin"]) $("form").addEventListener(ev, warmUp, { once: true });

function setPyState(state, text) {
  pyState = state;
  $("py-status").textContent = {
    loading: "Preparing the Python tools in the background…",
    ready: "Python tools ready.",
    failed: "The Python tools could not be downloaded (" + (text || "network error") + "). Check the connection and reload.",
  }[state] || "";
}

// map.js and campus.js fetch /api/...; those requests go to the worker instead of a server.
const pending = new Map();
let apiSeq = 0;
const realFetch = window.fetch.bind(window);
window.fetch = (url, opts) => {
  if (typeof url === "string" && url.startsWith("/api/")) {
    if (!worker) startWorker();
    return new Promise((resolve) => {
      const id = ++apiSeq;
      pending.set(id, resolve);
      worker.postMessage({ type: "api", id, path: url });
    });
  }
  return realFetch(url, opts);
};

function onMessage({ data: m }) {
  if (m.type === "api") {
    const resolve = pending.get(m.id);
    pending.delete(m.id);
    if (resolve) resolve(new Response(m.body, { status: m.status, headers: { "Content-Type": "application/json" } }));
  } else if (m.type === "stage") {
    if (current) setStage(current, "done", secsSince(stageStart));
    current = m.stage;
    stageStart = performance.now();
    setStage(m.stage, "active", "");
    setBar(m.stage, 0);
    $("stage-label").textContent = STAGE_TEXT[m.stage] +
      (m.stage === "couple" && pyState !== "ready" ? " (finishing the Python download)" : "") + "…";
  } else if (m.type === "progress") {
    setStage(m.stage, "active", `day ${m.done} of ${m.of}`);
    setBar(m.stage, m.done / m.of);
  } else if (m.type === "queue") {           // server edition: runs ahead of this one
    $("stage-label").textContent = m.position > 0
      ? `Waiting for the server: ${m.position} run${m.position > 1 ? "s" : ""} ahead of yours…` : "Starting…";
  } else if (m.type === "python") {
    setPyState(m.state, m.text);
  } else if (m.type === "log") {
    addLog(m.text);
  } else if (m.type === "error") {
    addLog(m.text);
    fail("The run stopped with an error; see the Log tab.");
  } else if (m.type === "done") {
    setStage(current, "done", secsSince(stageStart));
    current = null;
    $("bar").style.width = "100%";
    $("percent-label").textContent = "100 %";
    $("stage-label").textContent = `Finished in ${(m.timing.total_s / 60).toFixed(1)} minutes`;
    $("run").disabled = false;
    $("stop").hidden = true;
    showResults(m);
  }
}

const secsSince = (t0) => ((performance.now() - t0) / 1000).toFixed(0) + " s";

function setStage(stage, state, text) {
  const li = document.querySelector(`li[data-stage="${stage}"]`);
  li.classList.remove("active", "done");
  if (state) li.classList.add(state);
  li.querySelector(".state").textContent = text || "";
}

function setBar(stage, frac) {
  let done = 0;
  for (const s of STAGES) { if (s === stage) break; done += WEIGHT[s]; }
  const pct = 100 * Math.min(1, done + WEIGHT[stage] * frac);
  $("bar").style.width = pct.toFixed(1) + "%";
  $("percent-label").textContent = pct.toFixed(0) + " %";
}

function addLog(text) {
  $("log").textContent = ($("log").textContent === "—" ? "" : $("log").textContent) + text + "\n";
}

function fail(text) {
  $("status").textContent = text;
  $("status").classList.add("err");
  $("run").disabled = false;
  $("stop").hidden = true;
  if (current) setStage(current, null, "stopped");
}

function resetViews() {
  // The Map and Campus tabs go back to the base network until the new run is ready.
  if (network) mapBase(network);
  cvPause();
  CV.runId = null; CV.data = null; CV.loading = null;
  $("cv-controls").hidden = true;
  $("cv-body").hidden = true;
  $("bld-card").hidden = true;
  $("bld-hint").hidden = true;
  $("cap-body").hidden = true;
  $("cap-empty").hidden = false;
  $("bld-select").length = 1;
  bld.id = null; bld.listed = null;
  $("cv-note").textContent = "Run the simulation to watch the agents here.";
}

$("stop").addEventListener("click", () => {
  if (!worker) return;
  worker.terminate();
  worker = null; pyState = null;
  for (const [, resolve] of pending) resolve(new Response('{"detail":"stopped"}', { status: 503 }));
  pending.clear();
  $("py-status").textContent = "";
  if (current) setStage(current, null, "stopped");
  current = null;
  $("stage-label").textContent = "Stopped.";
  $("percent-label").textContent = "";
  $("bar").style.width = "0";
  $("run").disabled = false;
  $("stop").hidden = true;
  resetViews();
});

// ------------------------------------------------------------------ inputs: the agent counts
// Only the number of each kind of agent can be set; every other parameter keeps its
// calibrated value (listed read-only). Residents are limited to the halls' beds (the
// model's own limit); commuters and faculty/staff to twice the slider maximum.
function agentLimits(name) {
  const c = spec.controls.find((x) => x.name === name);
  return { min: 0, max: name === "num-residential" ? spec.facts.bed_capacity : 2 * c.max, def: c.default };
}

function readAgents() {
  const out = {};
  for (const [name] of AGENTS) {
    const raw = $("p-" + name).value.trim();
    out[name] = raw === "" ? NaN : Number(raw);
  }
  return out;
}

const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "±") + Math.abs(n).toLocaleString();

// Number boxes are the values; each slider mirrors its box. Shows the change from today's
// (calibrated) campus beside each kind of agent and in the total.
function updateAgents() {
  const v = readAgents();
  let total = 0, today = 0;
  for (const [name] of AGENTS) {
    const { def } = agentLimits(name);
    const x = v[name], ok = Number.isFinite(x);
    if (ok) $("s-" + name).value = x;
    const d = ok ? x - def : 0;
    $("p-" + name).closest(".agent").classList.toggle("changed", ok && d !== 0);
    const el = $("d-" + name);
    el.textContent = !ok ? "" : d === 0 ? "today's value" : `${signed(d)} (${signed(Math.round(100 * d / def))} %)`;
    el.className = "delta" + (d > 0 ? " up" : d < 0 ? " down" : "");
    total += ok ? x : def; today += def;
  }
  const dt = total - today;
  $("total-row").innerHTML = `<span>People on campus<br><span class="hint">today ${today.toLocaleString()}</span></span>` +
    `<span style="text-align:right"><b>${total.toLocaleString()}</b><br><span class="delta ${dt > 0 ? "up" : dt < 0 ? "down" : ""}">` +
    `${dt === 0 ? "same as today" : `${signed(dt)} (${signed(Math.round(1000 * dt / today) / 10)} %)`}</span></span>`;
}

async function loadModel() {
  spec = await (await fetch("params.json?v=d18ad166e4")).json();
  $("agents").innerHTML = AGENTS.map(([name, label, help]) => {
    const { max, def } = agentLimits(name);
    const range = name === "num-residential" ? `up to ${max.toLocaleString()}, the beds in the halls` : `0 to ${max.toLocaleString()}`;
    return `<div class="agent">` +
      `<div class="agent-top"><label class="agent-name" for="p-${name}">${label}</label><span class="delta" id="d-${name}"></span></div>` +
      `<div class="agent-row"><input id="s-${name}" type="range" min="0" max="${max}" step="1" value="${def}" aria-label="${label}">` +
      `<input id="p-${name}" type="number" inputmode="numeric" min="0" max="${max}" step="1" value="${def}"></div>` +
      `<div class="agent-help">${help}; today ${def.toLocaleString()}; ${range}.</div></div>`;
  }).join("");
  $("agents").addEventListener("input", (e) => {
    if (e.target.type === "range") $("p-" + e.target.id.slice(2)).value = e.target.value;
    updateAgents();
  });
  fillFromUrl();

  const r = spec.run;
  let html = `<h3>Run</h3><dl class="plist"><dt>Random seed</dt><dd>${r.seed}</dd>` +
    `<dt>Groundwater infiltration (cfs)</dt><dd>${r.gwi_total_cfs.toFixed(3)}</dd>` +
    `<dt>Day-to-day groundwater variation (sd)</dt><dd>${r.gwi_daily_sd}</dd></dl>`;
  const agentNames = new Set(AGENTS.map((a) => a[0]));
  for (const g of spec.groups) {
    const list = spec.controls.filter((c) => c.group === g && !agentNames.has(c.name));
    if (!list.length) continue;
    html += `<h3>${g}</h3><dl class="plist">` +
      list.map((c) => `<dt title="${c.name}">${c.label}</dt><dd>${c.default}</dd>`).join("") + "</dl>";
  }
  $("param-list").innerHTML = html;
}

$("reset").addEventListener("click", () => {
  for (const [name] of AGENTS) $("p-" + name).value = agentLimits(name).def;
  updateAgents();
});

function shareUrl(counts) {
  const q = new URLSearchParams();
  for (const [name, key] of Object.entries(URL_KEYS)) q.set(key, counts[name]);
  return location.pathname + "?" + q.toString();
}

function fillFromUrl() {
  const q = new URLSearchParams(location.search);
  const ignored = [];
  for (const [name, key] of Object.entries(URL_KEYS)) {
    if (!q.has(key)) continue;
    const v = Number(q.get(key));
    const { min, max } = agentLimits(name);
    if (Number.isInteger(v) && v >= min && v <= max) $("p-" + name).value = v;
    else ignored.push(key);
  }
  if (ignored.length) $("status").textContent =
    `The link's ${ignored.join(" and ")} value was outside the allowed range, so the calibrated number is used.`;
  updateAgents();
}

$("copy").addEventListener("click", async () => {
  const url = new URL(shareUrl(readAgents()), location.href).href;
  try { await navigator.clipboard.writeText(url); $("copied").textContent = "Link copied."; }
  catch { $("copied").textContent = url; }
  setTimeout(() => { $("copied").textContent = ""; }, 5000);
});

// ------------------------------------------------------------------ run
$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!spec) return;
  const counts = readAgents();
  for (const [name, label] of AGENTS) {
    const { min, max } = agentLimits(name);
    const v = counts[name];
    if (!Number.isInteger(v) || v < min || v > max) {
      $("p-" + name).focus();
      $("status").textContent = `${label} must be a whole number from ${min} to ${max.toLocaleString()}.`;
      $("status").classList.add("err");
      return;
    }
  }
  const params = {};
  for (const [name] of AGENTS) if (counts[name] !== agentLimits(name).def) params[name] = counts[name];
  const { seed, gwi_total_cfs: gwi, gwi_daily_sd: sd } = spec.run;
  if (!worker) startWorker();
  for (const s of STAGES) setStage(s, null, "");
  $("status").textContent = "";
  $("status").classList.remove("err");
  $("log").textContent = "—";
  addLog(`residents ${counts["num-residential"]}, commuters ${counts["num-commuters"]}, faculty/staff ${counts["num-faculty"]}`);
  history.replaceState(null, "", shareUrl(counts));
  $("progress-wrap").hidden = false;
  $("bar").style.width = "0";
  $("percent-label").textContent = "0 %";
  $("run").disabled = true;
  $("stop").hidden = false;
  current = null;
  resetViews();
  worker.postMessage({ type: "run", seed, days: 14, gwi, sd, params });
});

// ------------------------------------------------------------------ results
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(",");
  return lines.slice(1).map((l) => {
    const c = l.split(","), o = {};
    head.forEach((h, i) => { o[h] = c[i]; });
    return o;
  });
}
const ms = (ts) => Date.parse(ts.replace(" ", "T") + "Z");
const fmtN = (x, d) => x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

function showResults(m) {
  window.lastRun = m;               // for checking a run from the browser console
  const warm = m.finish.warmup_days;
  showTab("results");
  $("results-empty").hidden = true;
  $("results-body").hidden = false;

  // Station flows, second week (10-minute report steps).
  const sim = parseCsv(m.files["simulated.csv"]);
  const start = ms(sim[0].timestamp) - 10 * 60e3;          // first record is 00:10 on day 1
  const cut = start + warm * 864e5;
  const byNode = {};
  for (const r of sim) {
    const t = ms(r.timestamp);
    if (t < cut) continue;
    (byNode[r.node] = byNode[r.node] || { t: [], v: [] }).t.push(t);
    byNode[r.node].v.push(+r.flow_cfs);
  }
  // Generation by source, second week (15-minute ticks).
  const src = parseCsv(m.files["abm_by_source.csv"]).filter((r) => +r.tick >= warm * 96);
  const srcT = src.map((r) => start + (+r.tick) * 15 * 60e3);
  const genDay = src.reduce((a, r) => a + SOURCES.reduce((b, [k]) => b + +(r[k] || 0), 0), 0) / 7;

  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const tiles = [
    ["People on campus", Object.values(peopleOf(m)).reduce((a, b) => a + b, 0).toLocaleString(), ""],
    ["Water used on campus", fmtN(genDay, 0), "gal/day"],
    ...STATIONS.map(([id, name, desc]) => [`${name} (${desc}), mean flow`, fmtN(mean(byNode[id].v), 3), "cfs"]),
    ["Groundwater infiltration", fmtN(m.couple.gwi_total_cfs, 3), "cfs"],
  ];
  $("tiles").innerHTML = tiles.map(([k, v, u]) =>
    `<div class="tile"><div class="k">${k}</div><div class="v">${v} <span class="u">${u}</span></div></div>`).join("");

  if (!charts) charts = { flow: LineChart($("chart-flow")), source: LineChart($("chart-source")) };
  const t = byNode[STATIONS[0][0]].t;
  charts.flow.update({
    t, unit: "cfs", label: "flow",
    series: STATIONS.map(([id, name, desc], i) => ({ name: `${name} (${desc})`, values: byNode[id].v, color: SERIES_COLORS[i] })),
    extra: [], shade: [],
  });
  charts.source.update({
    t: srcT, unit: "gal", label: "wastewater generated",
    series: SOURCES.filter(([k]) => src.some((r) => +(r[k] || 0) > 0))
      .map(([k, name], i) => ({ name, values: src.map((r) => +(r[k] || 0)), color: SERIES_COLORS[i] })),
    extra: [], shade: [],
  });

  renderChecks(m.checks.rows);
  renderCapacity(m.capacity);
  renderFiles(m);
  // The views key on the run id; the toolbars show the run's population instead.
  const p = peopleOf(m);
  const label = `${p["num-residential"].toLocaleString()} residents · ${p["num-commuters"].toLocaleString()} commuters · ` +
                `${p["num-faculty"].toLocaleString()} faculty/staff`;
  mapLoad(m.runId).then(() => {
    $("map-run").textContent = label;
    // Open on something to see: pipes coloured by flow, unless the reader chose otherwise.
    const lv = $("map-link-var");
    if (!lv.value && [...lv.options].some((o) => o.value === "flow")) { lv.value = "flow"; lv.dispatchEvent(new Event("change")); }
  });
  campusLoad(m.runId);
  $("cv-run").textContent = label;
}

function peopleOf(m) {
  const out = {};
  for (const [name] of AGENTS) out[name] = m.settings.params[name] ?? agentLimits(name).def;
  return out;
}

// ------------------------------------------------------------------ pipe capacity
// From web_couple.capacity(): the second week's largest depth / full depth per pipe, flow
// against full-flow capacity, surcharged manholes, flooding, and the pump stations.
const level = (f) => (f >= 0.95 ? "alert" : f >= 0.8 ? "watch" : "ok");
const pct = (f) => (f == null ? "–" : `${Math.round(100 * f)} %`);
const STATION_OF = { MH_62: "Station 1", MH_52: "Station 2", MH_60: "Station 3" };
const nodeName = (n) => (STATION_OF[n] ? `${n} (${STATION_OF[n]})` : n);

function renderCapacity(c) {
  $("cap-empty").hidden = !!c;
  $("cap-body").hidden = !c;
  if (!c) return;
  const top = c.pipes[0];
  const busiest = c.stations.flatMap((s) => s.pumps.map((p) => ({ ...p, ww: s.name })))
    .sort((a, b) => b.running_pct - a.running_pct)[0];
  const maxSur = c.surcharged[0];
  $("cap-window").textContent = `Peaks over the ${c.window}.`;
  const tiles = [
    ["Fullest pipe", pct(top.max_full), "of full depth", `${top.name}, ${top.when}`, level(top.max_full)],
    ["Pipes at 80 % full or more", `${c.n_pipes_80}`, `of ${c.n_pipes}`, `${c.n_pipes_full} completely full at peak`, c.n_pipes_full ? "alert" : c.n_pipes_80 ? "watch" : "ok"],
    ["Pipes above full-flow capacity", `${c.n_pipes_over_qfull}`, `of ${c.n_pipes}`, "peak flow larger than the pipe carries flowing full", c.n_pipes_over_qfull ? "watch" : "ok"],
    ["Manholes surcharged", `${c.surcharged.length}`, "", maxSur ? `highest ${maxSur.max_above_crown_ft} ft above the pipe top (${maxSur.name})` : "water stays inside the pipes", c.surcharged.length ? "watch" : "ok"],
    ["Flooding", c.flooded.length ? `${c.flooded.length}` : "None", c.flooded.length ? "manholes" : "", c.flooded.length ? "water leaves the network at the surface" : "no manhole overflows", c.flooded.length ? "alert" : "ok"],
    ["Busiest pump", busiest ? `${Math.round(busiest.running_pct)} %` : "–", "of the time", busiest ? `${busiest.name} at ${busiest.ww}` : "", busiest && busiest.running_pct >= 90 ? "watch" : "ok"],
  ];
  $("cap-tiles").innerHTML = tiles.map(([k, v, u, s, lv]) =>
    `<div class="tile ${lv}"><div class="k">${k}</div><div class="v">${v} <span class="u">${u}</span></div><div class="s">${s}</div></div>`).join("");

  const rows = c.pipes.slice(0, 12);
  $("cap-pipes").innerHTML = "<thead><tr><th>Pipe</th><th>From → to</th><th>Size</th><th title='highest water depth ÷ pipe diameter'>Peak fullness</th>" +
    "<th title='hours in the week with the pipe at least 80 % full'>Hours ≥ 80 %</th>" +
    "<th title='highest flow ÷ the flow the pipe carries when just full by gravity; above 100 % it runs under pressure'>Peak flow ÷ capacity</th><th>Peak at</th><th></th></tr></thead><tbody>" +
    rows.map((p, i) => {
      const lv = level(p.max_full);
      const backed = p.max_full >= 0.8 && p.flow_vs_full != null && p.flow_vs_full < 0.1;
      return `<tr><td class="pipe">${p.name}</td><td class="where">${nodeName(p.from)} → ${nodeName(p.to)}</td>` +
        `<td class="num">${p.diameter_in} in</td>` +
        `<td><span class="fill"><i><b class="lvl-${lv}" style="width:${Math.min(100, 100 * p.max_full)}%"></b></i>${pct(p.max_full)}</span>` +
        `${backed ? ' <span class="badge-note">backed up, little flow</span>' : ""}</td>` +
        `<td class="num">${p.hours_80}</td><td class="num">${pct(p.flow_vs_full)}</td><td>${p.when}</td>` +
        `<td><button type="button" class="mini" data-cap="${i}">Show on map</button></td></tr>`;
    }).join("") + "</tbody>";
  $("cap-pipes").querySelectorAll("button[data-cap]").forEach((b) =>
    b.addEventListener("click", () => showPipePeak(rows[+b.dataset.cap])));

  $("cap-pumps").innerHTML = "<thead><tr><th>Station</th><th>Highest level</th><th>Pumps running</th></tr></thead><tbody>" +
    c.stations.map((s) => `<tr><td class="pipe">${s.name}</td>` +
      `<td><span class="fill"><i><b class="lvl-${level(s.max_full || 0)}" style="width:${Math.min(100, 100 * (s.max_full || 0))}%"></b></i>${pct(s.max_full)}</span> <span class="where">${s.when}</span></td>` +
      `<td>${s.pumps.map((p) => `${p.name} ${Math.round(p.running_pct)} %`).join(" · ")}</td></tr>`).join("") + "</tbody>";

  const sur = c.surcharged.length
    ? "<table class='cap-table'><thead><tr><th>Manhole</th><th>Above pipe top</th><th>Hours</th><th>Below rim</th><th>When</th></tr></thead><tbody>" +
      c.surcharged.map((s) => `<tr><td class="pipe">${nodeName(s.name)}</td><td class="num">${s.max_above_crown_ft} ft</td><td class="num">${s.hours}</td>` +
        `<td class="num">${s.below_rim_ft} ft</td><td>${s.when}</td></tr>`).join("") + "</tbody></table>"
    : "<p class='note'>No manhole fills above the top of its pipes.</p>";
  const fl = c.flooded.length
    ? `<p class="note" style="color:var(--red)">Flooding at ${c.flooded.map((f) => `${f.name} (${f.volume_gal.toLocaleString()} gal)`).join(", ")}.</p>`
    : "<p class='note'>No flooding: no manhole overflows at the surface.</p>";
  $("cap-manholes").innerHTML = sur + fl;
}

// Open the Sewer network at a pipe's peak, coloured by how full each pipe is.
// Selected pipes and manholes on the Sewer network get a name label and a yellow halo that
// flashes a few times, so a pipe picked from the capacity table can be found on the map.
// map.js's markSelection() runs on every selection change; this wraps it.
const _markSelection = window.markSelection;
window.markSelection = function () {
  _markSelection();
  const svg = document.querySelector("#network svg");
  if (!svg) return;
  svg.querySelectorAll(".pick-halo, .pick-tag").forEach((e) => e.remove());
  if (!MAP.sel.kind) return;
  const NS = "http://www.w3.org/2000/svg";
  const tag = (x, y, text) => {
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", x); t.setAttribute("y", y);
    t.setAttribute("class", "pick-tag");
    t.textContent = text;
    svg.append(t);                               // on top of everything, but not clickable (CSS)
  };
  for (const name of MAP.sel.names) {
    if (MAP.sel.kind === "link") {
      const o = MAP.els.links[name];
      if (!o) continue;
      const halo = o.line.cloneNode(false);
      halo.removeAttribute("stroke-dasharray");
      halo.setAttribute("class", "pick-halo");
      o.line.parentNode.insertBefore(halo, o.line);
      const L = o.line.getTotalLength(), m = o.line.getPointAtLength(L / 2);
      tag(m.x + 16, m.y - 18, `Pipe ${name}`);
    } else {
      const o = MAP.els.nodes[name];
      if (!o) continue;
      const cx = +o.dot.getAttribute("cx"), cy = +o.dot.getAttribute("cy");
      const halo = document.createElementNS(NS, "circle");
      halo.setAttribute("cx", cx); halo.setAttribute("cy", cy); halo.setAttribute("r", 15);
      halo.setAttribute("class", "pick-halo");
      o.dot.parentNode.insertBefore(halo, o.dot);
      tag(cx + 12, cy - 10, STATION_OF[name] ? `${STATION_OF[name]} (${name})` : name);
    }
  }
};

function showPipePeak(p) {
  showTab("network");
  $("network").scrollIntoView({ behavior: "smooth", block: "center" });
  const lv = $("map-link-var");
  const go = () => {
    if (lv.value !== "capacity") { lv.value = "capacity"; lv.dispatchEvent(new Event("change")); }
    setTimeout(() => { setTime(p.t_index); onPick("link", p.name, false); }, 400);
  };
  go();
}

function renderChecks(rows) {
  const nf = rows.filter((r) => r[0] === "FAIL").length, nw = rows.filter((r) => r[0] === "WARN").length;
  $("checks-empty").hidden = true;
  $("checks-summary").hidden = false;
  $("checks-summary").innerHTML = `<strong>${rows.length} checks: ${nf} failed, ${nw} warning${nw === 1 ? "" : "s"}.</strong> ` +
    `The same checks as the desktop pipeline's <code>--verify</code>, including the volume balance.`;
  const esc = (s) => s.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
  $("checks-table").hidden = false;
  $("checks-table").querySelector("tbody").innerHTML = rows.map(([lv, name, detail]) =>
    `<tr><td class="level ${lv}">${lv === "OK" ? "ok" : lv}</td><td class="gate-name">${esc(name)}</td><td class="detail">${esc(detail)}</td></tr>`).join("");
}

function renderFiles(m) {
  const p = peopleOf(m);
  const tag = `R${p["num-residential"]}_C${p["num-commuters"]}_F${p["num-faculty"]}`;
  const order = RESTRICTED
    ? ["simulated.csv", "abm_by_source.csv"]          // results only: no model input or output files
    : ["simulated.csv", "verify.txt", "manifest.json", "abm_node_inflows.csv", "abm_node_routed.csv",
       "abm_building_flows.csv", "abm_by_source.csv", "abm_view.txt", "Campus_abm.inp", "Campus_abm.rpt"];
  const LABEL = { "simulated.csv": "Flow and depth at the three stations (CSV)",
                  "abm_by_source.csv": "Wastewater generated, by source (CSV)" };
  $("files").innerHTML = "";
  for (const name of order) {
    if (!(name in m.files)) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = RESTRICTED ? LABEL[name] : name;
    b.onclick = () => {
      const url = URL.createObjectURL(new Blob([m.files[name]], { type: "text/plain" }));
      Object.assign(document.createElement("a"), { href: url, download: `${tag}_${name}` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    $("files").appendChild(b);
  }
}

// ------------------------------------------------------------------ map: station names and basemap
// Reader-facing names for the three monitoring stations (the dashboard's map.js and
// campus.js, as copied here, use them for labels, chips and chart series).
window.NODE_LABELS = { MH_62: "Station 1", MH_52: "Station 2", MH_60: "Station 3" };

// ------------------------------------------------------------------ map: OpenStreetMap underneath
// The SWMM model's coordinates are WGS 84 / UTM zone 14N metres (EPSG:32614, as the campus
// shapefiles' .prj states). OpenStreetMap tiles are Web Mercator, so every tile's corners are
// converted to UTM and the tile is placed with its own affine transform; over one tile
// (about 150-600 m) the two projections differ from an affine map by far less than a pixel.
// map.js hands us its coordinate functions (px, py: UTM metres -> SVG units).
const UTM = (() => {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, lon0 = -99 * Math.PI / 180;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2), e4 = e2 * e2, e6 = e4 * e2;
  const m1 = 1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256;
  const meridian = (p) => a * (m1 * p - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * p)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * p) - (35 * e6 / 3072) * Math.sin(6 * p));
  // Snyder (1987), Map Projections -- A Working Manual, eqs. 8-9 to 8-25
  function forward(latDeg, lonDeg) {
    const p = latDeg * Math.PI / 180, l = lonDeg * Math.PI / 180;
    const N = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2), T = Math.tan(p) ** 2, C = ep2 * Math.cos(p) ** 2;
    const A = Math.cos(p) * (l - lon0);
    const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
    const y = k0 * (meridian(p) + N * Math.tan(p) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
      + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
    return [x, y];
  }
  function inverse(x, y) {
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const mu = y / k0 / (a * m1);
    const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
      + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
    const C1 = ep2 * Math.cos(p1) ** 2, T1 = Math.tan(p1) ** 2, s2 = 1 - e2 * Math.sin(p1) ** 2;
    const N1 = a / Math.sqrt(s2), R1 = a * (1 - e2) / s2 ** 1.5, D = (x - 500000) / (N1 * k0);
    const lat = p1 - (N1 * Math.tan(p1) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
      + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
    const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(p1);
    return [lat * 180 / Math.PI, lon * 180 / Math.PI];
  }
  return { forward, inverse };
})();
window.UTM = UTM;     // for checking from the console

const OSM_TILE = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const tileLon = (x, z) => x / 2 ** z * 360 - 180;
const tileLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI;

window.mapUnderlay = (svg, px, py) => {
  const [W, H] = svg.getAttribute("viewBox").split(" ").slice(2).map(Number);
  // SVG units <-> UTM metres (px and py are linear)
  const sx = px(1) - px(0), sy = py(1) - py(0);
  const xAt = (X) => (X - px(0)) / sx, yAt = (Y) => (Y - py(0)) / sy;
  const corners = [[0, 0], [W, 0], [0, H], [W, H]].map(([X, Y]) => UTM.inverse(xAt(X), yAt(Y)));
  const lats = corners.map((c) => c[0]), lons = corners.map((c) => c[1]);
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
  // detail: about one tile pixel per screen pixel, at 1-2 screen pixels per SVG unit
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const z = Math.max(15, Math.min(18, Math.ceil(Math.log2(156543.03392 * Math.cos(lat * Math.PI / 180) * sx * dpr))));
  const n = 2 ** z;
  const tx0 = Math.floor((Math.min(...lons) + 180) / 360 * n), tx1 = Math.floor((Math.max(...lons) + 180) / 360 * n);
  const ty = (la) => Math.floor((1 - Math.log(Math.tan(la * Math.PI / 180) + 1 / Math.cos(la * Math.PI / 180)) / Math.PI) / 2 * n);
  const ty0 = ty(Math.max(...lats)), ty1 = ty(Math.min(...lats));
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("class", "basemap");
  g.style.display = $("map-basemap").checked ? "" : "none";
  const at = (x, y) => { const [ux, uy] = UTM.forward(tileLat(y, z), tileLon(x, z)); return [px(ux), py(uy)]; };
  for (let x = tx0; x <= tx1; x++) {
    for (let y = ty0; y <= ty1; y++) {
      const nw = at(x, y), ne = at(x + 1, y), sw = at(x, y + 1);
      const img = document.createElementNS("http://www.w3.org/2000/svg", "image");
      img.setAttribute("href", OSM_TILE(z, x, y));
      img.setAttribute("width", 1.004); img.setAttribute("height", 1.004);    // hide hairline seams
      img.setAttribute("preserveAspectRatio", "none");
      img.setAttribute("transform", `matrix(${ne[0] - nw[0]} ${ne[1] - nw[1]} ${sw[0] - nw[0]} ${sw[1] - nw[1]} ${nw[0]} ${nw[1]})`);
      g.append(img);
    }
  }
  svg.insertBefore(g, svg.firstChild);
};
$("map-basemap").addEventListener("change", () => {
  const on = $("map-basemap").checked;
  document.querySelectorAll("#network g.basemap").forEach((g) => { g.style.display = on ? "" : "none"; });
  $("network").classList.toggle("on-basemap", on);
  $("osm-credit").hidden = !on;
});

// ------------------------------------------------------------------ campus: street map + real buildings
// campus.js draws in NetLogo patch coordinates. campus_geo.json gives the exact patch -> UTM
// map (fitted on the manholes at build time) and every building's outline in patch
// coordinates, so OpenStreetMap tiles and the outlines land where they are on the ground.
let campusGeo = null;
fetch("campus_geo.json?v=d18ad166e4").then((r) => r.json()).then((g) => {
  campusGeo = g;
  const c = g.patch_to_utm, det = c[0][0] * c[1][1] - c[0][1] * c[1][0];
  g.toUtm = ([x, y]) => [x * c[0][0] + y * c[1][0] + c[2][0], x * c[0][1] + y * c[1][1] + c[2][1]];
  g.toPatch = ([ux, uy]) => {
    const dx = ux - c[2][0], dy = uy - c[2][1];
    return [(dx * c[1][1] - dy * c[1][0]) / det, (-dx * c[0][1] + dy * c[0][0]) / det];
  };
  g.mPerPatch = Math.hypot(c[0][0], c[0][1]);
  if (CV.data) cvFrame(true);
}).catch(() => {});

const tileImages = new Map();
function tileImage(z, x, y) {
  const key = `${z}/${x}/${y}`;
  let img = tileImages.get(key);
  if (!img) {
    img = new Image();
    img.onload = () => { if (CV.data) cvFrame(true); };
    img.src = OSM_TILE(z, x, y);
    tileImages.set(key, img);
  }
  return img;
}

const streetsOn = () => !!campusGeo && $("cv-streets").checked;

// Called by campus.js in place of NetLogo's background. Returns true when it drew.
window.cvBackground = (g, X, Y, size, dpr, ti) => {
  if (!streetsOn()) return false;
  const G = campusGeo, d = CV.data;
  const ax = X(1) - X(0), ay = Y(1) - Y(0);
  const patchAt = (cx, cy) => [(cx - X(0)) / ax, (cy - Y(0)) / ay];
  g.fillStyle = "#e9e6df"; g.fillRect(0, 0, size, size);
  // OpenStreetMap tiles covering the canvas
  const ll = [[0, 0], [size, 0], [0, size], [size, size]].map(([cx, cy]) => UTM.inverse(...G.toUtm(patchAt(cx, cy))));
  const lats = ll.map((p) => p[0]), lons = ll.map((p) => p[1]);
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const mPerPx = G.mPerPatch / Math.abs(ax) / dpr;
  const z = Math.max(15, Math.min(18, Math.ceil(Math.log2(156543.03392 * Math.cos(lat * Math.PI / 180) / mPerPx))));
  const n = 2 ** z;
  const tx = (lo) => Math.floor((lo + 180) / 360 * n);
  const ty = (la) => Math.floor((1 - Math.log(Math.tan(la * Math.PI / 180) + 1 / Math.cos(la * Math.PI / 180)) / Math.PI) / 2 * n);
  const at = (x, y) => { const [px, py] = G.toPatch(UTM.forward(tileLat(y, z), tileLon(x, z))); return [X(px), Y(py)]; };
  for (let x = tx(Math.min(...lons)); x <= tx(Math.max(...lons)); x++) {
    for (let y = ty(Math.max(...lats)); y <= ty(Math.min(...lats)); y++) {
      const img = tileImage(z, x, y);
      if (!img.complete || !img.naturalWidth) continue;
      const nw = at(x, y), ne = at(x + 1, y), sw = at(x, y + 1);
      g.save();
      g.setTransform(dpr * (ne[0] - nw[0]), dpr * (ne[1] - nw[1]), dpr * (sw[0] - nw[0]), dpr * (sw[1] - nw[1]), dpr * nw[0], dpr * nw[1]);
      g.drawImage(img, 0, 0, 1.004, 1.004);
      g.restore();
    }
  }
  g.fillStyle = "rgba(0,0,0,0.30)"; g.fillRect(0, 0, size, size);    // the replay's colours read on a darker map
  // buildings: their real outlines, coloured by occupancy as NetLogo's houses are
  const occ = d.occ[Math.max(0, Math.min(d.occ.length - 1, ti))];
  d.buildings.forEach((b, i) => {
    const rings = G.buildings[b.id];
    if (!rings) return;
    g.beginPath();
    rings.forEach((ring) => ring.forEach(([x, y], k) => (k ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))));
    g.globalAlpha = 0.85;
    g.fillStyle = occColor(b.cap > 0 ? occ[i] / b.cap : 0);
    g.fill("evenodd");
    g.globalAlpha = 1;
    const sel = bld.id === b.id;
    g.strokeStyle = sel ? "#ffffff" : "rgba(0,0,0,.7)"; g.lineWidth = sel ? 3 : 1;
    g.stroke();
  });
  return true;
};
// campus.js asks before drawing a house icon: not when the outline is drawn instead
window.cvBuilding = (b) => streetsOn() && !!campusGeo.buildings[b.id];
window.cvHideOffCampus = streetsOn;
window.cvNoStationChart = true;       // the Campus tab shows no NetLogo-style station hydrograph

$("cv-streets").addEventListener("change", () => {
  $("cv-osm-credit").hidden = !$("cv-streets").checked;
  if (CV.data) cvFrame(true);
});

function insideRings(rings, x, y) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// ------------------------------------------------------------------ campus: one building's wastewater
// Click a building in the replay (or pick it from the list): its wastewater per 15 minutes,
// by source, for the whole run, from the run's own abm_building_flows.csv.
const BLD_SOURCES = [["restroom", "Restroom"], ["shower", "Shower"], ["laundry", "Laundry"],
                     ["kitchen", "Kitchen"], ["lab", "Laboratory"]];
const bld = { run: null, series: null, chart: null, id: null, listed: null };

function buildingSeries() {
  const m = window.lastRun;
  if (!m) return null;
  if (bld.run === m.runId && bld.series) return bld.series;
  const lines = m.files["abm_building_flows.csv"].split(/\r?\n/);
  const head = lines[0].split(",");
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  const out = new Map();
  for (let k = 1; k < lines.length; k++) {
    if (!lines[k]) continue;
    const c = lines[k].split(",");
    const id = +c[col.b_id];
    let s = out.get(id);
    if (!s) {
      s = { tick: [], total: 0 };
      for (const [key] of BLD_SOURCES) s[key] = [];
      out.set(id, s);
    }
    s.tick.push(+c[col.tick]);
    for (const [key] of BLD_SOURCES) {
      const v = col[key] != null ? +c[col[key]] : 0;
      s[key].push(v);
      s.total += v;
    }
  }
  bld.run = m.runId; bld.series = out; bld.listed = null;
  return out;
}

const bldName = (b) => b.name || `${b.cls} building ${b.id}`;

function listBuildings() {
  const d = CV.data, series = buildingSeries();
  if (!d || !series || bld.listed === CV.runId) return;
  const sel = $("bld-select");
  sel.length = 1;
  d.buildings.filter((b) => (series.get(b.id) || {}).total > 0)
    .sort((a, b) => bldName(a).localeCompare(bldName(b)))
    .forEach((b) => sel.append(new Option(b.name ? `${b.name} (${b.cls})` : bldName(b), b.id)));
  bld.listed = CV.runId;
  $("bld-hint").hidden = false;
}

function openBuilding(id) {
  const d = CV.data, series = buildingSeries();
  if (!d || !series) return;
  const b = d.buildings.find((x) => x.id === id);
  const s = series.get(id);
  if (!b) return;
  bld.id = id;
  $("bld-select").value = String(id);
  $("bld-card").hidden = false;
  $("bld-title").textContent = bldName(b);
  const drain = d.nodes.find((n) => n.id === b.drain);
  const drainTxt = drain ? (nodeLabel(drain.name) !== drain.name ? `${nodeLabel(drain.name)} (${drain.name})` : drain.name) : `node ${b.drain}`;
  $("bld-sub").textContent = `${b.cls} · drains to manhole ${drainTxt}`;
  if (!bld.chart) bld.chart = LineChart($("bld-chart"));
  if (!s || !(s.total > 0)) {
    $("bld-stats").innerHTML = "<span>This building generated no wastewater in this run.</span>";
    bld.chart.update(null);
    return;
  }
  const t = s.tick.map((tk) => d.start_ms + tk * d.step_ms);
  const total = s.tick.map((_, i) => BLD_SOURCES.reduce((a, [k]) => a + s[k][i], 0));
  const used = BLD_SOURCES.filter(([k]) => s[k].some((v) => v > 0));
  bld.chart.update({
    t, unit: "gal", label: "wastewater generated", warmupEnd: d.start_ms + d.warmup_ticks * d.step_ms,
    series: [...used.map(([k, name], i) => ({ name, values: s[k], color: SERIES_COLORS[i] })),
             ...(used.length > 1 ? [{ name: "Total", values: total, color: "#0b0b0b" }] : [])],
    extra: [], shade: [],
  });
  // second (analysis) week
  const w0 = d.warmup_ticks;
  const wk = total.slice(w0), days = wk.length / 96;
  let peak = 0, at = 0;
  wk.forEach((v, i) => { if (v > peak) { peak = v; at = i; } });
  const share = used.map(([k, name]) => {
    const v = s[k].slice(w0).reduce((a, x) => a + x, 0);
    return `${name} ${Math.round(100 * v / Math.max(1e-9, wk.reduce((a, x) => a + x, 0)))} %`;
  }).join(" · ");
  $("bld-stats").innerHTML =
    `<div><span>average, second week</span> <b>${Math.round(wk.reduce((a, x) => a + x, 0) / days).toLocaleString()} gal/day</b></div>` +
    `<div><span>largest 15 min</span> <b>${peak.toFixed(1)} gal</b> <span>(${fmtTime(t[w0 + at])})</span></div>` +
    `<div><span>${share}</span></div>`;
  bld.chart.setMarker(d.start_ms + Math.floor(CV.t) * d.step_ms);
  cvFrame(true);                                       // outline the chosen building
  $("bld-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function buildingAt(ev) {
  const d = CV.data;
  if (!d || !CV.geo) return null;
  const r = $("cv-canvas").getBoundingClientRect();
  const x = ev.clientX - r.left, y = ev.clientY - r.top;
  if (streetsOn()) {                                 // inside a real outline
    const { X, Y } = CV.geo, ax = X(1) - X(0), ay = Y(1) - Y(0);
    const px = (x - X(0)) / ax, py = (y - Y(0)) / ay;
    const hit = d.buildings.find((b) => campusGeo.buildings[b.id] && insideRings(campusGeo.buildings[b.id], px, py));
    if (hit) return hit;
  }
  let best = null, bd = 12;                          // as campus.js's tooltip
  d.buildings.forEach((b) => {
    const dist = Math.hypot(CV.geo.X(b.x) - x, CV.geo.Y(b.y) - y);
    if (dist < bd) { bd = dist; best = b; }
  });
  return best;
}

$("cv-canvas").addEventListener("click", (ev) => { const b = buildingAt(ev); if (b) openBuilding(b.id); });
$("cv-canvas").addEventListener("pointermove", (ev) => $("cv-canvas").classList.toggle("over-building", !!buildingAt(ev)));
$("bld-select").addEventListener("focus", listBuildings);
$("bld-select").addEventListener("change", () => { if ($("bld-select").value) openBuilding(+$("bld-select").value); });
$("bld-close").addEventListener("click", () => { $("bld-card").hidden = true; bld.id = null; $("bld-select").value = ""; });
$("bld-csv").addEventListener("click", () => {
  const d = CV.data, s = bld.id != null && buildingSeries() && buildingSeries().get(bld.id);
  if (!d || !s) return;
  const b = d.buildings.find((x) => x.id === bld.id);
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const rows = ["tick,day,weekday,time," + BLD_SOURCES.map(([k]) => k + "_gal").join(",") + ",total_gal"];
  s.tick.forEach((tk, i) => {
    const day = Math.floor(tk / 96), mins = (tk % 96) * 15;
    const time = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
    const vals = BLD_SOURCES.map(([k]) => s[k][i]);
    rows.push([tk, day + 1, DAYS[day % 7], time, ...vals, vals.reduce((a, x) => a + x, 0).toFixed(6)].join(","));
  });
  const p = peopleOf(window.lastRun);
  const name = `R${p["num-residential"]}_C${p["num-commuters"]}_F${p["num-faculty"]}_building_${b.id}.csv`;
  const url = URL.createObjectURL(new Blob([rows.join("\n") + "\n"], { type: "text/csv" }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
// campus.js calls this at every new replay tick
window.cvOnTick = (ms) => {
  listBuildings();
  if (bld.chart && !$("bld-card").hidden) bld.chart.setMarker(ms);
};

// ------------------------------------------------------------------ start
mapWire();
campusWire();
$("network").classList.add("on-basemap");
fetch("network.json?v=d18ad166e4").then((r) => r.json()).then((n) => { network = n; mapBase(n); }).catch(() => {});
loadModel().catch((err) => { $("agents").innerHTML = `<p class="note">The model could not be loaded: ${err}</p>`; });
