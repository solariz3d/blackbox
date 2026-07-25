/* test_trackeffects.js — every installed track should support every effect.
 *
 * Blackbox's effects are gated on data extracted per track, and when that extraction
 * comes back empty the effect just does not happen — silently. Nothing errors, so a track
 * where smoke never collides, the road edge never reads, or shadows are unbounded looks
 * merely "a bit off" rather than broken.
 *
 * What each one needs:
 *   road mesh  -> smoke collision, road-edge HUD, ribbon width, the ground the car sits on
 *   scene mesh -> anything visible at all
 *   bounds     -> the static whole-track shadow cascade (trackAABB)
 *
 * This walks the real install and reports which tracks are missing which. It SKIPS on a
 * machine with no Assetto Corsa.  node test_trackeffects.js [--all]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const K = require("./ui/kn5.js");

function tracksDir() {
  for (const r of ["C:/Program Files (x86)/Steam", "D:/SteamLibrary", "E:/SteamLibrary",
                   "F:/SteamLibrary", "G:/SteamLibrary", "H:/SteamLibrary"]) {
    const p = path.join(r, "steamapps/common/assettocorsa/content/tracks");
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const TD = tracksDir();
if (!TD) { console.log("  SKIP: no Assetto Corsa install found"); process.exit(0); }

const ALL = process.argv.includes("--all");
let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok " : "FAIL"} - ${m}`); if (!c) fails++; };

/** the models a layout actually uses, mirroring find_track's layout awareness */
function layoutModels(dir) {
  const inis = fs.readdirSync(dir).filter(f => /^models_.*\.ini$/i.test(f));
  if (!inis.length) return null;
  const out = [];
  for (const ini of inis) {
    const files = [];
    for (const line of fs.readFileSync(path.join(dir, ini), "utf8").split(/\r?\n/)) {
      const m = /^\s*file\s*=\s*(.+?)\s*$/i.exec(line);
      if (m && fs.existsSync(path.join(dir, m[1]))) files.push(m[1]);
    }
    if (files.length) out.push({ layout: ini.replace(/^models_|\.ini$/gi, ""), files });
  }
  return out.length ? out : null;
}

function biggestKn5(dir) {
  let best = null, size = 0;
  const walk = (d, depth) => {
    if (depth > 2) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.toLowerCase().endsWith(".kn5")) {
        const s = fs.statSync(p).size;
        if (s > size) { size = s; best = p; }
      }
    }
  };
  walk(dir, 0);
  return best;
}

const rows = [];
for (const e of fs.readdirSync(TD, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  const dir = path.join(TD, e.name);
  const layouts = layoutModels(dir);
  // EVERY model the layout lists, not just the first. Kunos tracks split a circuit across
  // a dozen kn5s (ks_barcelona's gp layout lists eleven), so reading one file reported
  // nine official tracks as rendering nothing — a defect in this test, not in the app,
  // which loads the whole list. Caught only because "ks_* all broken" was too neat.
  const files = layouts
    ? layouts[0].files.map(f => path.join(dir, f))
    : [biggestKn5(dir)].filter(Boolean);
  if (!files.length) { rows.push({ t: e.name, err: "no kn5" }); continue; }
  let road = 0, meshes = 0, logic = 0, err = null;
  for (const file of files) {
    try {
      const b = fs.readFileSync(file);
      const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
      const r = K.extractRoadMesh(ab);
      road += r && r.tris ? r.tris.length / 3 : 0;
      const s = K.extractScene(ab, { lod0Only: true });
      meshes += s.stats.meshCount; logic += s.stats.logicSkipped || 0;
    } catch (ex) { if (!err) err = ex.message.slice(0, 40); }
  }
  if (meshes) err = null;   // one bad model among many is not a dead track
  rows.push({ t: e.name, road, meshes, logic, err, layouts: layouts ? layouts.length : 1 });
}

const bad = rows.filter(r => r.err || !r.meshes);
const noRoad = rows.filter(r => !r.err && r.meshes && !r.road);

console.log(`\n  tracks scanned: ${rows.length}`);
console.log(`  render nothing (parse error / no meshes): ${bad.length}`);
console.log(`  render but have NO ROAD MESH (no smoke collision, no edge HUD): ${noRoad.length}`);

if (bad.length) {
  console.log("\n  cannot render:");
  for (const r of bad) console.log(`    ${r.t.slice(0, 34).padEnd(36)} ${r.err || "0 meshes"}`);
}
if (noRoad.length) {
  console.log("\n  no road surface detected:");
  for (const r of noRoad) console.log(`    ${r.t.slice(0, 34).padEnd(36)} ${r.meshes} meshes`);
}
if (ALL) {
  console.log("\n  all tracks:");
  for (const r of rows.sort((a, b) => a.t.localeCompare(b.t))) {
    console.log(`    ${r.t.slice(0, 30).padEnd(32)} road ${String(r.road).padStart(7)}  meshes ${String(r.meshes).padStart(5)}  logic ${String(r.logic).padStart(4)}  layouts ${r.layouts}`);
  }
}

// These are the assertions that matter: the parser must handle every track it is given.
ok(rows.length > 0, `found ${rows.length} installed tracks`);
ok(bad.length === 0, `every track produces drawable geometry (${bad.length} failing)`);
ok(rows.some(r => r.logic > 0), "logic-object filtering is active across the library");

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall good");
process.exit(fails ? 1 : 0);
