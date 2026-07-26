/* test_lampbake.js — does the vertex lamp bake actually produce light?
 *
 * The bake replaced a 60-lamp per-fragment loop with a per-vertex constant. On the T-180
 * test track it produced a black ground, and the two candidate causes look identical on
 * screen: the MATHS returning zero, or the buffer never reaching the shader. This runs the
 * bake's exact arithmetic headlessly, so the answer is one of the two and not a guess.
 *
 * Run: node test_lampbake.js [trackname]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const K = require("./ui/kn5.js");
const T = require("./ui/tracklights.js");

const TRACK_LIGHT_MAX_INTENSITY = 6, TRACK_LIGHT_GAIN = 0.5;   // must match index.html

let tdir = null;
for (const r of ["C:/Program Files (x86)/Steam", "D:/SteamLibrary", "E:/SteamLibrary", "G:/SteamLibrary"]) {
  const p = path.join(r, "steamapps/common/assettocorsa/content/tracks");
  if (fs.existsSync(p)) { tdir = p; break; }
}
if (!tdir) { console.log("SKIP: no Assetto Corsa install"); process.exit(0); }

const TRACK = process.argv[2] || "ohyeah2389_t180testtrack";
const dir = path.join(tdir, TRACK);
const ini = path.join(dir, "extension", "ext_config.ini");

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
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
const scene = K.extractScene(ab, { lod0Only: true, collectNodes: true });
const lightsAll = T.resolveTrackLights(fs.readFileSync(ini, "utf8"), scene.nodes || []);
const lamps = lightsAll.filter(L => L.night);

console.log(`${TRACK}`);
console.log(`  groups(chunks) ${scene.groups.length}   lamps ${lightsAll.length}   night-gated ${lamps.length}`);

// Do the chunks carry bounds at all? Missing bounds is also why culling would reject nothing.
const withBounds = scene.groups.filter(g => g.radius !== undefined && g.centre).length;
console.log(`  chunks carrying centre+radius: ${withBounds} / ${scene.groups.length}`);
if (!lamps.length) { console.log("  !! no night-gated lamps — the bake would return early"); process.exit(0); }

let gMax = 0, gSum = 0, gN = 0, litVerts = 0, skippedNoNear = 0;

for (const g of scene.groups) {
  const pos = g.pos, nrm = g.nrm;
  if (!pos || !nrm) continue;
  const nV = pos.length / 3;
  const out = new Float32Array(nV * 3);

  const near = [];
  if (g.centre && g.radius !== undefined) {
    for (const L of lamps) {
      const dx = L.pos[0] - g.centre[0], dy = L.pos[1] - g.centre[1], dz = L.pos[2] - g.centre[2];
      const reach = L.range + g.radius;
      if (dx * dx + dy * dy + dz * dz <= reach * reach) near.push(L);
    }
  } else near.push(...lamps);
  if (!near.length) skippedNoNear++;

  for (const L of near) {
    const amp = Math.min(L.intensity, TRACK_LIGHT_MAX_INTENSITY) * TRACK_LIGHT_GAIN;
    if (amp <= 0.002) continue;
    const cr = L.color[0] * amp, cg = L.color[1] * amp, cb = L.color[2] * amp;
    const range = L.range, r2 = range * range;
    const dl = Math.hypot(L.dir[0], L.dir[1], L.dir[2]) || 1;
    const dxn = L.dir[0] / dl, dyn = L.dir[1] / dl, dzn = L.dir[2] / dl;
    const cosHalf = L.spotUsable ? Math.cos(Math.min(359, L.spot) * 0.5 * Math.PI / 180) : -1;
    const inner = cosHalf + (1 - cosHalf) * 0.35;

    for (let v = 0; v < nV; v++) {
      const o = v * 3;
      const tx = L.pos[0] - pos[o], ty = L.pos[1] - pos[o + 1], tz = L.pos[2] - pos[o + 2];
      const d2 = tx * tx + ty * ty + tz * tz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) || 1e-3;
      const lx = tx / d, ly = ty / d, lz = tz / d;
      const ndl = nrm[o] * lx + nrm[o + 1] * ly + nrm[o + 2] * lz;
      if (ndl <= 0) continue;
      let att = 1 - d / range; att *= att;
      let cone = 1;
      if (cosHalf > -0.5) {
        const c = -(lx * dxn + ly * dyn + lz * dzn);
        let t = (c - cosHalf) / Math.max(1e-4, inner - cosHalf);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        cone = t * t * (3 - 2 * t);
        if (cone <= 0) continue;
      }
      const k = ndl * att * cone;
      out[o] += cr * k; out[o + 1] += cg * k; out[o + 2] += cb * k;
    }
  }

  litVerts += nV;
  for (let i = 0; i < out.length; i += 3) {
    const v = out[i];
    if (v > gMax) gMax = v;
    if (v > 0.001) { gSum += v; gN++; }
  }
}

console.log(`  chunks whose bounds rejected EVERY lamp: ${skippedNoNear}`);
console.log(`  vertices baked: ${litVerts}`);
console.log(`  vertices receiving any light: ${gN} (${litVerts ? (100 * gN / litVerts).toFixed(1) : 0}%)`);
console.log(`  red channel: max ${gMax.toFixed(3)}   mean(lit) ${gN ? (gSum / gN).toFixed(3) : 0}`);
console.log(gMax > 0.01
  ? "\n  => the MATHS is fine. A black ground means the buffer is not reaching the shader."
  : "\n  => the MATHS returns ~zero. The bug is here, not in the plumbing.");

// One lamp, one flat patch directly beneath it — the simplest case that must work.
const L0 = lamps[0];
if (L0) {
  const groundY = L0.pos[1] - 10;
  const p = [L0.pos[0], groundY, L0.pos[2]], n = [0, 1, 0];
  const tx = L0.pos[0] - p[0], ty = L0.pos[1] - p[1], tz = L0.pos[2] - p[2];
  const d = Math.hypot(tx, ty, tz), lx = tx / d, ly = ty / d, lz = tz / d;
  const ndl = n[0] * lx + n[1] * ly + n[2] * lz;
  const att = Math.pow(1 - d / L0.range, 2);
  console.log(`\n  sanity — a point 10 m under lamp 0:`);
  console.log(`    lamp pos ${L0.pos.map(x => x.toFixed(1))}  range ${L0.range}  spot ${L0.spot}` +
              `  spotUsable ${L0.spotUsable}  intensity ${L0.intensity}`);
  console.log(`    ndl ${ndl.toFixed(3)}  att ${att.toFixed(3)}  => expected non-zero light`);
}
