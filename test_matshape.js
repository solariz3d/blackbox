/* test_matshape.js — where a named material actually lives in the world.
 *
 * Dropping every mesh on centrifuge's "Transparent" material to open the dome's skylights
 * exposed structures that had been behind it, which means the material is not only the
 * skylight panes. Before narrowing the rule, look at the geometry: a scatter of small flat
 * panels is a set of windows; a few huge shells are the dome itself.
 *
 * Run: node test_matshape.js <track> <material-substring>
 */
"use strict";
const fs = require("fs");
const path = require("path");
const K = require("./ui/kn5.js");

let tdir = null;
for (const r of ["C:/Program Files (x86)/Steam", "D:/SteamLibrary", "E:/SteamLibrary", "G:/SteamLibrary"]) {
  const p = path.join(r, "steamapps/common/assettocorsa/content/tracks");
  if (fs.existsSync(p)) { tdir = p; break; }
}
if (!tdir) { console.log("SKIP: no Assetto Corsa install"); process.exit(0); }

const TRACK = process.argv[2] || "centrifuge";
const WANT = (process.argv[3] || "transparent").toLowerCase();
const dir = path.join(tdir, TRACK);

let best = null, size = 0;
(function walk(d, depth) {
  if (depth > 2) return;
  for (const x of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, x.name);
    if (x.isDirectory()) walk(p, depth + 1);
    else if (x.name.toLowerCase().endsWith(".kn5")) { const s = fs.statSync(p).size; if (s > size) { size = s; best = p; } }
  }
})(dir, 0);

const b = fs.readFileSync(best);
const scene = K.extractScene(b.buffer.slice(b.byteOffset, b.byteOffset + b.length), { lod0Only: true });
const mats = scene.materials || [];

// scene extent, so the matched geometry can be judged against the whole world
let sx0 = 1e18, sy0 = 1e18, sz0 = 1e18, sx1 = -1e18, sy1 = -1e18, sz1 = -1e18;
for (const g of scene.groups) {
  if (!g.aabb) continue;
  const a = g.aabb;
  if (a[0] < sx0) sx0 = a[0]; if (a[1] < sy0) sy0 = a[1]; if (a[2] < sz0) sz0 = a[2];
  if (a[3] > sx1) sx1 = a[3]; if (a[4] > sy1) sy1 = a[4]; if (a[5] > sz1) sz1 = a[5];
}
console.log(`${TRACK}: scene spans ${(sx1-sx0).toFixed(0)} x ${(sy1-sy0).toFixed(0)} x ${(sz1-sz0).toFixed(0)} m\n`);
console.log(`chunks whose material name contains "${WANT}":`);
console.log(`  ${"tris".padStart(8)} ${"meshes".padStart(6)}  ${"size (w x h x d)".padStart(22)}  ${"radius".padStart(7)}  material`);

let n = 0, tris = 0;
for (const g of scene.groups) {
  const m = mats[g.materialId] || {};
  if (!(m.name || "").toLowerCase().includes(WANT)) continue;
  const a = g.aabb || [0,0,0,0,0,0];
  const w = a[3]-a[0], h = a[4]-a[1], d = a[5]-a[2];
  n++; tris += g.triCount;
  console.log(`  ${String(g.triCount).padStart(8)} ${String(g.meshCount||1).padStart(6)}  ` +
              `${(w.toFixed(0)+" x "+h.toFixed(0)+" x "+d.toFixed(0)).padStart(22)}  ` +
              `${(g.radius||0).toFixed(0).padStart(7)}  ${m.name}`);
}

const sceneR = 0.5 * Math.hypot(sx1-sx0, sy1-sy0, sz1-sz0);
console.log(`\n  ${n} chunk(s), ${tris.toLocaleString()} tris; scene radius ${sceneR.toFixed(0)} m`);
console.log(`\n  A chunk spanning a large share of the scene is STRUCTURE, not a window pane.`);
console.log(`  Panes are small, flat (one dimension near zero), and there are many of them.`);
