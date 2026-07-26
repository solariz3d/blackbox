/* test_trackcost.js — where a track's triangles actually go, by material and shader.
 *
 * The question this exists to answer: sakura_speedway is punishing here and punishing in
 * Assetto itself, and the keeper's own workaround in AC is to strip tree lighting and
 * shadows. Before replicating that as a CSP-style policy, measure it — which materials
 * hold the geometry, and how much of the SHADOW pass (drawn twice, once per cascade, with
 * no shading to show for it) is foliage.
 *
 * Foliage is identifiable without guessing at names: AC gives every material a shader, and
 * trees use ksTree / ksGrass / ksPerPixelMultiMap_damage_dirt variants, with alphaTested
 * set. Name matching is the fallback, not the rule.
 *
 * Run: node test_trackcost.js [trackname]
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

const TRACK = process.argv[2] || "sakura_speedway";
const dir = path.join(tdir, TRACK);
if (!fs.existsSync(dir)) { console.log("SKIP: no such track " + TRACK); process.exit(0); }

// Kunos circuits split across many kn5s; take them all, biggest first.
const kn5s = [];
const walk = (d, depth) => {
  if (depth > 2) return;
  for (const x of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, x.name);
    if (x.isDirectory()) walk(p, depth + 1);
    else if (x.name.toLowerCase().endsWith(".kn5")) kn5s.push({ p, size: fs.statSync(p).size });
  }
};
walk(dir, 0);
kn5s.sort((a, b) => b.size - a.size);
if (!kn5s.length) { console.log("SKIP: no kn5 in " + TRACK); process.exit(0); }

console.log(`${TRACK}: ${kn5s.length} kn5 file(s), largest ${(kn5s[0].size / 1e6).toFixed(1)} MB\n`);

/* The classifier lives in kn5.js and is imported rather than restated, because the whole
 * value of this tool is that it reports what the RENDERER will actually do. A second copy
 * of the rule here would drift, and then the profile would be measuring a track that no
 * longer matches the one being drawn. */
const isFoliage = K.isFoliageMaterial;

let triAll = 0, triFoliage = 0, groupsAll = 0, groupsFoliage = 0;
const byShader = new Map();
const rows = [];
const chunkR = [];   // every chunk's bounding radius, for the sizing report
let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;

for (const { p } of kn5s.slice(0, 6)) {
  let scene;
  try {
    const b = fs.readFileSync(p);
    scene = K.extractScene(b.buffer.slice(b.byteOffset, b.byteOffset + b.length), { lod0Only: true });
  } catch (e) { console.log(`  (skip ${path.basename(p)}: ${e.message})`); continue; }

  const mats = scene.materials || [];
  for (const g of scene.groups || []) {
    const m = mats[g.materialId] || {};
    const shader = m.shader || "?";
    const name = m.name || "?";
    const foliage = isFoliage(m);
    triAll += g.triCount; groupsAll++;
    if (foliage) { triFoliage += g.triCount; groupsFoliage++; }
    byShader.set(shader, (byShader.get(shader) || 0) + g.triCount);
    if (g.radius !== undefined) chunkR.push(g.radius);
    if (g.aabb) {
      const b = g.aabb;
      if (b[0] < bx0) bx0 = b[0]; if (b[1] < by0) by0 = b[1]; if (b[2] < bz0) bz0 = b[2];
      if (b[3] > bx1) bx1 = b[3]; if (b[4] > by1) by1 = b[4]; if (b[5] > bz1) bz1 = b[5];
    }
    rows.push({ name, shader, tris: g.triCount, meshes: g.meshCount || 1,
                alpha: m.alphaTested, blend: m.blendMode, foliage });
  }
}

console.log("heaviest materials:");
rows.sort((a, b) => b.tris - a.tris);
console.log(`  ${"tris".padStart(8)} ${"meshes".padStart(7)}  ${"tris/mesh".padStart(9)}  material`);
for (const r of rows.slice(0, 14)) {
  console.log(`  ${String(r.tris).padStart(8)} ${String(r.meshes).padStart(7)}  ` +
              `${String(Math.round(r.tris / r.meshes)).padStart(9)}  ${r.foliage ? "FOLIAGE " : "        "}` +
              `${r.name.slice(0, 22).padEnd(23)} ${r.shader.slice(0, 20)}`);
}

/* CHUNKABILITY. Frustum culling needs geometry split into pieces with their own bounds,
 * and the finest split available without cutting triangles is the MESH. A material made of
 * many meshes chunks well; one made of a single mesh spanning the circuit is indivisible,
 * and no amount of culling will ever skip part of it. */
const single = rows.filter(r => r.meshes === 1);
const singleTris = single.reduce((s, r) => s + r.tris, 0);
console.log(`\nchunkability:`);
console.log(`  ${rows.length - single.length} of ${rows.length} groups are multi-mesh`);
console.log(`  ${single.length} are a SINGLE mesh — ${singleTris.toLocaleString()} tris ` +
            `(${triAll ? (100 * singleTris / triAll).toFixed(1) : 0}%) that culling cannot subdivide`);

/* Chunk SIZE is what decides whether culling pays. A chunk whose radius approaches the
 * track's own is culled only when off screen entirely — the box test passes almost always
 * and the work is wasted. Small chunks relative to the circuit are what let a frustum
 * actually reject most of the world. */
if (chunkR.length) {
  chunkR.sort((a, b) => a - b);
  const med = chunkR[chunkR.length >> 1];
  const trackR = 0.5 * Math.hypot(bx1 - bx0, by1 - by0, bz1 - bz0);
  console.log(`\nchunk sizes (radius, metres):`);
  console.log(`  track radius ${trackR.toFixed(0)}   chunks ${chunkR.length}   ` +
              `median ${med.toFixed(0)}   largest ${chunkR[chunkR.length - 1].toFixed(0)}`);
  const spanning = chunkR.filter(r => r > trackR * 0.5).length;
  console.log(`  ${spanning} chunk(s) span more than half the track — those cull rarely`);
  console.log(`  => a chunk of radius ${med.toFixed(0)} m in a ${trackR.toFixed(0)} m circuit is ` +
              `what makes frustum culling worth doing`);
}

console.log("\ntriangles by shader:");
for (const [s, t] of [...byShader.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(t).padStart(8)}  ${s}`);
}

const pct = triAll ? (100 * triFoliage / triAll) : 0;
console.log(`\ntotal      ${triAll} tris across ${groupsAll} groups`);
console.log(`foliage    ${triFoliage} tris across ${groupsFoliage} groups  =  ${pct.toFixed(1)}%`);
/* NOT "twice per frame" — an earlier version of this line said that and it was wrong. The
 * near cascade re-renders every frame; the FAR cascade is baked once and only redrawn when
 * the sun moves (time changed). So foliage is paid once per frame in the depth pass, plus
 * once more in the lit pass, plus a far-cascade redraw on every tick of the time slider. */
console.log(`\n  => foliage is drawn in the near depth cascade EVERY frame, and again in the`);
console.log(`     lit pass. The far cascade re-bakes it on every movement of the time slider.`);
console.log(`  => dropping foliage as a shadow CASTER removes ${triFoliage.toLocaleString()} triangles`);
console.log(`     from the per-frame depth pass and from every far-cascade re-bake.`);
