/* test_logicobjects.js — AC's logic objects must never render.
 *
 * AC_PIT_n (pit boxes), AC_START_n (grid slots), AC_TIME_n_L/R (timing gates),
 * AC_HOTLAP_START_n, AC_AUDIO_*, AC_CREW_* are markers the game reads and hides. A
 * renderer that draws every mesh in the kn5 puts them all on screen — the "spawn points
 * rendering in the map".
 *
 * Runs against real installed tracks, and SKIPS cleanly where Assetto Corsa is absent.
 *
 * Run: node test_logicobjects.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const K = require("./ui/kn5.js");

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok " : "FAIL"} - ${m}`); if (!c) fails++; };

// find the AC tracks folder the way find_car does — any Steam library
function tracksDir() {
  const roots = ["C:/Program Files (x86)/Steam", "D:/SteamLibrary", "E:/SteamLibrary",
                 "F:/SteamLibrary", "G:/SteamLibrary", "H:/SteamLibrary"];
  for (const r of roots) {
    const p = path.join(r, "steamapps/common/assettocorsa/content/tracks");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const tdir = tracksDir();
if (!tdir) { console.log("  SKIP: no Assetto Corsa install found"); process.exit(0); }

// biggest kn5 in each of a few tracks — the main circuit model
function biggestKn5(dir) {
  let best = null, bestSize = 0;
  const walk = (d, depth) => {
    if (depth > 2) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.toLowerCase().endsWith(".kn5")) {
        const s = fs.statSync(p).size;
        if (s > bestSize) { bestSize = s; best = p; }
      }
    }
  };
  try { walk(dir, 0); } catch (_) {}
  return best;
}

const candidates = fs.readdirSync(tdir, { withFileTypes: true })
  .filter(e => e.isDirectory()).map(e => path.join(tdir, e.name));

let checked = 0, totalHidden = 0;
console.log("");
for (const dir of candidates) {
  if (checked >= 6) break;
  const f = biggestKn5(dir);
  if (!f) continue;
  let scene;
  try {
    const b = fs.readFileSync(f);
    scene = K.extractScene(b.buffer.slice(b.byteOffset, b.byteOffset + b.length), { lod0Only: true });
  } catch (_) { continue; }
  const st = scene.stats || {};
  if (typeof st.logicSkipped !== "number") { ok(false, "stats must report logicSkipped"); break; }
  checked++;
  totalHidden += st.logicSkipped;
  console.log(`   ${path.basename(dir).slice(0, 28).padEnd(30)} meshes ${String(st.meshCount).padStart(5)}   logic hidden ${st.logicSkipped}`);
}

ok(checked > 0, `parsed ${checked} track model(s)`);
ok(totalHidden > 0, `AC_* logic objects were found and hidden (${totalHidden} meshes across ${checked} tracks)`);

console.log("\nthe filter is a subtree filter, not a name filter");
{
  // a marker is usually an empty transform with its placeholder geometry BENEATH it, so
  // hiding only the node whose own name matches would still draw the children
  const src = fs.readFileSync(path.join(__dirname, "ui", "kn5.js"), "utf8");
  ok(/hidden = hidden \|\| \/\^AC_\/i\.test\(name\)/.test(src), "hidden is inherited (|| not =), so it propagates down");
  ok(/readNode\(m, isDriveshaft \? null : childWheel, childSteer, hidden\)/.test(src), "children are passed the hidden flag");
  ok(/logicSkipped\+\+/.test(src), "hidden meshes are counted, not silently dropped");
}

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall good");
process.exit(fails ? 1 : 0);
