// The whole run, in a Web Worker so the page stays responsive:
//   ABM (NetLogo Web engine) -> coupling (pipeline/ in Pyodide) -> SWMM (WebAssembly) -> export.
// Messages to the page: {type: "stage"|"progress"|"log"|"done"|"error", ...}.

// --------------------------------------------------------------- NetLogo Web engine
// The engine bundle touches a few window/document names when it loads; in a worker
// they are inert stand-ins. model.js declares its names globally (as a <script> would),
// so everything of ours below lives inside one function scope and cannot collide.
self.window = self;
self.parent = self;
self.document = { createElement: () => ({ getContext: () => null }) };
self.Extensions = {};
self.modelConfig = { output: { clear() {}, write() {} }, print: { write() {} } };
// The compiler bundle is loaded although the model is pre-compiled: it defines the
// global `Nobody` object the engine compares against (NetLogo Web's own page loads both).
importScripts("vendor/tortoise-compiler.js?v=d18ad166e4", "vendor/tortoise-engine.min.js?v=d18ad166e4", "model.js?v=d18ad166e4", "vendor/swmm5.js?v=d18ad166e4");

(() => {
"use strict";
const { workspace, world, ProcedurePrims, createSwmm } = self;
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";
const post = (m) => self.postMessage(m);
const log = (text) => post({ type: "log", text });
const sec = (t0) => (performance.now() - t0) / 1000;

// --------------------------------------------------------------- Pyodide, loaded once
let pyReady = null;
function loadPython() {
  if (pyReady) return pyReady;
  pyReady = (async () => {
    const t0 = performance.now();
    post({ type: "python", state: "loading" });
    importScripts(PYODIDE + "pyodide.js");
    const py = await self.loadPyodide({ indexURL: PYODIDE });
    await py.loadPackage(["numpy", "pandas"]);
    const files = await (await fetch("py/files.json?v=d18ad166e4")).json();
    if (files.bundle) {                    // restricted edition: one archive instead of loose files
      const buf = await (await fetch("py/" + files.bundle + "?v=d18ad166e4")).arrayBuffer();
      py.FS.mkdirTree("/proj");
      py.unpackArchive(buf, "zip", { extractDir: "/proj" });
    } else {
      for (const f of files) {
        const buf = new Uint8Array(await (await fetch("py/" + f + "?v=d18ad166e4")).arrayBuffer());
        const dest = "/proj/" + f;
        py.FS.mkdirTree(dest.slice(0, dest.lastIndexOf("/")));
        py.FS.writeFile(dest, buf);
      }
    }
    py.runPython("import sys; sys.path.insert(0, '/proj'); import web_couple, web_api");
    log(`Python ready in ${sec(t0).toFixed(1)} s (Pyodide 0.28.3, numpy, pandas)`);
    post({ type: "python", state: "ready" });
    return py;
  })();
  pyReady.catch((err) => post({ type: "python", state: "failed", text: String(err) }));
  return pyReady;
}

// --------------------------------------------------------------- ABM export, as patch_model writes it
const nlmath = self.tortoise_require("util/nlmath");
const fmt = (x) => workspace.dump(x);
const p6 = (x) => fmt(nlmath.precision(x, 6));
const breed = (b) => world.turtleManager.turtlesOfBreed(b).toArray();
const v = (a, k) => a.getVariable(k);

function nodeCsv(variable) {
  const nodes = breed("NODES").sort((a, b) => v(a, "n-id") - v(b, "n-id"));
  const series = nodes.map((n) => v(n, variable));
  const rows = ["tick," + nodes.map((n) => fmt(v(n, "n-id"))).join(",")];
  for (let t = 0; t < series[0].length; t++) rows.push(t + "," + series.map((s) => p6(s[t])).join(","));
  return rows.join("\n") + "\n";
}

function buildingCsv() {
  const rows = ["tick,b_id,drain_node,restroom,shower,laundry,kitchen,lab"];
  const bs = breed("BUILDINGS").sort((a, b) => v(a, "b-id") - v(b, "b-id"));
  for (const b of bs) {
    const s = ["q-restroom-series", "q-shower-series", "q-laundry-series", "q-kitchen-series", "q-lab-series"]
      .map((k) => v(b, k));
    for (let t = 0; t < s[0].length; t++)
      rows.push([t, fmt(v(b, "b-id")), fmt(v(b, "drain-node-id")), ...s.map((x) => p6(x[t]))].join(","));
  }
  return rows.join("\n") + "\n";
}

// --------------------------------------------------------------- ABM settings
// The model's interface globals, read once before any run changes them. Every run first
// puts all of them back to these defaults and then applies its own values, so nothing
// carries over from an earlier run in the same worker (setup's clear-all keeps them,
// exactly as in desktop NetLogo).
let defaults = null;
async function interfaceDefaults() {
  if (defaults) return defaults;
  const spec = await (await fetch("params.json?v=d18ad166e4")).json();
  defaults = {};
  for (const c of spec.controls) defaults[c.name] = world.observer.getGlobal(c.name);
  return defaults;
}

function applySettings(base, changed) {
  for (const [k, val] of Object.entries(base)) world.observer.setGlobal(k, val);
  for (const [k, val] of Object.entries(changed)) {
    if (!(k in base)) throw new Error("unknown ABM setting: " + k);
    if (typeof val !== typeof base[k]) throw new Error(`setting ${k}: expected a ${typeof base[k]}`);
    world.observer.setGlobal(k, val);
  }
}

// --------------------------------------------------------------- one run
const nextTurn = () => new Promise((r) => setTimeout(r, 0));
let runCount = 0;

async function run({ seed, days, gwi, sd, params = {} }) {
  const T = performance.now();
  const ticks = days * 96;
  const runId = `web_run_${++runCount}`;      // a new id per run, so the views never mix two runs
  const dir = `/proj/runs/${runId}/`;
  const pyPromise = loadPython();          // downloads while the ABM runs (between days)

  post({ type: "stage", stage: "abm" });
  let t0 = performance.now();
  applySettings(await interfaceDefaults(), params);
  world.observer.setGlobal("simulation-mode", "analysis");
  if (Object.keys(params).length) log("ABM settings changed: " + JSON.stringify(params));
  workspace.rng.setSeed(seed);
  ProcedurePrims.callCommand("setup");
  // The view trace for the Campus tab: recording only (inside with-local-randomness).
  ProcedurePrims.callCommand("abm-swmm-start-trace", "abm_view.txt");
  for (let d = 0; d < days; d++) {
    for (let t = 0; t < 96; t++) ProcedurePrims.callCommand("go-headless");
    post({ type: "progress", stage: "abm", done: d + 1, of: days });
    await nextTurn();
  }
  const abmS = sec(t0);
  log(`ABM: ${days} days (${ticks} ticks) in ${abmS.toFixed(1)} s`);
  const files = { "abm_node_inflows.csv": nodeCsv("q-local-series"),
                  "abm_node_routed.csv": nodeCsv("q-node-series"),
                  "abm_building_flows.csv": buildingCsv(),
                  "abm_view.txt": world.observer.getGlobal("web-trace").join("\n") + "\n" };

  post({ type: "stage", stage: "couple" });
  const py = await pyPromise;
  t0 = performance.now();
  py.globals.set("params_json", JSON.stringify(params));
  py.runPython(`web_couple.start("${runId}", ${seed}, params_json)`);
  for (const name of ["abm_node_inflows.csv", "abm_node_routed.csv", "abm_building_flows.csv", "abm_view.txt"])
    py.FS.writeFile(dir + name, files[name]);
  const couple = JSON.parse(py.runPython(`web_couple.couple(${seed}, ${gwi}, ${sd})`));
  const inp = py.FS.readFile(dir + "Campus_abm.inp");
  log(`Coupling: ${couple.n_inflow_rows} inflow rows, ${couple.abm_gallons.toFixed(0)} gal from the ABM, ` +
      `groundwater ${couple.gwi_total_cfs.toFixed(3)} cfs (${sec(t0).toFixed(1)} s)`);

  post({ type: "stage", stage: "swmm" });
  t0 = performance.now();
  const swmm = await createSwmm({ locateFile: (f) => "vendor/" + f + "?v=d18ad166e4", print: () => {}, printErr: () => {} });
  swmm.FS.mkdir("/w");
  swmm.FS.writeFile("/w/Campus_abm.inp", inp);
  const code = swmm.ccall("swmm_run", "number", ["string", "string", "string"],
                          ["/w/Campus_abm.inp", "/w/Campus_abm.rpt", "/w/Campus_abm.out"]);
  const rpt = swmm.FS.readFile("/w/Campus_abm.rpt");
  py.FS.writeFile(dir + "Campus_abm.rpt", rpt);
  if (code !== 0) throw new Error("SWMM stopped with error code " + code +
                                  ": " + new TextDecoder().decode(rpt).slice(-1500));
  py.FS.writeFile(dir + "Campus_abm.out", swmm.FS.readFile("/w/Campus_abm.out"));
  const swmmS = sec(t0);
  log(`SWMM 5.2.4 (WebAssembly): ${swmmS.toFixed(1)} s`);

  post({ type: "stage", stage: "export" });
  const fin = JSON.parse(py.runPython("web_couple.finish()"));
  let capacity = null;
  try { capacity = JSON.parse(py.runPython("web_couple.capacity()")); }
  catch (err) { log("Pipe capacity summary not available: " + String(err && err.message || err).slice(0, 300)); }

  post({ type: "stage", stage: "verify" });
  t0 = performance.now();
  const checks = JSON.parse(py.runPython("web_couple.check()"));
  const nFail = checks.rows.filter((r) => r[0] === "FAIL").length;
  log(`Checks: ${checks.rows.length} run, ${nFail} failed (${sec(t0).toFixed(1)} s)`);

  const text = (p) => new TextDecoder().decode(py.FS.readFile(p));
  Object.assign(files, {
    "simulated.csv": text(dir + "simulated.csv"),
    "abm_by_source.csv": text(dir + "abm_by_source.csv"),
    "Campus_abm.inp": new TextDecoder().decode(inp),
    "Campus_abm.rpt": new TextDecoder().decode(rpt),
    "verify.txt": text(dir + "verify.txt"),
    "manifest.json": text(dir + "manifest.json"),
  });
  post({ type: "done", runId, files, couple, finish: fin, checks, capacity,
         timing: { abm_s: abmS, swmm_s: swmmS, total_s: sec(T) },
         settings: { seed, days, gwi, sd, params } });
}

self.onmessage = (e) => {
  if (e.data.type === "run") {
    run(e.data).catch((err) => post({ type: "error", text: String(err && err.stack || err) }));
  } else if (e.data.type === "warm") {
    loadPython().catch(() => {});        // reported through the "python" message
  } else if (e.data.type === "api") {
    // One request from the Map or Campus tab, answered by dashboard/results.py or view.py.
    const { id, path } = e.data;
    loadPython().then((py) => {
      py.globals.set("api_path", path);
      const res = py.runPython("web_api.call(api_path)").toJs();
      post({ type: "api", id, status: res[0], body: res[1] });
    }).catch((err) => post({ type: "api", id, status: 500,
                              body: JSON.stringify({ detail: String(err && err.message || err) }) }));
  }
};
post({ type: "ready" });
})();
