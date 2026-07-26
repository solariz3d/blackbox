/* test_roadedge.js — synthetic-geometry tests for roadedge.js (no kn5 needed).
 * Run: node test_roadedge.js
 */
"use strict";

const { buildEdgeIndex, distanceToEdge, distanceProfile } = require("./ui/roadedge.js");

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (ok ? "" : "  -- " + detail));
  if (!ok) failed++;
}
function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

// Grid mesh: (nx+1)x(nw+1) vertices, fn(i,j) -> [x,y,z], quads split into tris.
function buildGrid(nx, nw, fn) {
  const verts = new Float32Array((nx + 1) * (nw + 1) * 3);
  for (let i = 0; i <= nx; i++)
    for (let j = 0; j <= nw; j++) {
      const p = fn(i, j), o = (i * (nw + 1) + j) * 3;
      verts[o] = p[0]; verts[o + 1] = p[1]; verts[o + 2] = p[2];
    }
  const tris = new Uint32Array(nx * nw * 6);
  let t = 0;
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nw; j++) {
      const a = i * (nw + 1) + j, b = a + (nw + 1);
      tris[t++] = a; tris[t++] = b; tris[t++] = a + 1;
      tris[t++] = a + 1; tris[t++] = b; tris[t++] = b + 1;
    }
  return { verts, tris };
}

// --- flat road 1000 m x 12 m, 2 m quads ---------------------------------
const flat = buildGrid(500, 6, (i, j) => [i * 2, 0, j * 2 - 6]);
const flatIdx = buildEdgeIndex(flat.verts, flat.tris);

// boundary of a 500x6 quad grid rectangle = 2*(500+6) = 1012 edge segments
check("flat: boundary segment count", flatIdx.count === 1012, "got " + flatIdx.count);

let r = distanceToEdge(flatIdx, 500, 0, 0);
check("flat: center dist ~ 6", approx(r.dist, 6, 1e-3), "got " + r.dist);

r = distanceToEdge(flatIdx, 500, 0, -5);
check("flat: 1 m from left edge", approx(r.dist, 1, 1e-3), "got " + r.dist);

r = distanceToEdge(flatIdx, 1010, 0, 0);
check("flat: 10 m past the end", approx(r.dist, 10, 1e-3), "got " + r.dist);
check("flat: closest point on end edge",
  approx(r.px, 1000, 1e-3) && approx(r.py, 0, 1e-3) && approx(r.pz, 0, 1e-3),
  "got (" + r.px + "," + r.py + "," + r.pz + ")");

r = distanceToEdge(flatIdx, 500, 0, 6);
check("flat: point on boundary dist ~ 0", approx(r.dist, 0, 1e-4), "got " + r.dist);

// --- same road as TWO abutting meshes, vertices duplicated at the seam ---
const meshA = buildGrid(250, 6, (i, j) => [i * 2, 0, j * 2 - 6]);
const meshB = buildGrid(250, 6, (i, j) => [500 + i * 2, 0, j * 2 - 6]);
const nA = meshA.verts.length / 3;
const seamVerts = new Float32Array(meshA.verts.length + meshB.verts.length);
seamVerts.set(meshA.verts, 0);
seamVerts.set(meshB.verts, meshA.verts.length);
const seamTris = new Uint32Array(meshA.tris.length + meshB.tris.length);
seamTris.set(meshA.tris, 0);
for (let i = 0; i < meshB.tris.length; i++) seamTris[meshA.tris.length + i] = meshB.tris[i] + nA;
const seamIdx = buildEdgeIndex(seamVerts, seamTris);

check("seam: boundary count matches single mesh", seamIdx.count === 1012, "got " + seamIdx.count);
r = distanceToEdge(seamIdx, 500, 0, 0);
check("seam: center-on-seam dist still ~ 6 (seam not boundary)",
  approx(r.dist, 6, 1e-3), "got " + r.dist);
r = distanceToEdge(seamIdx, 501, 0, 2);
check("seam: near-seam interior point dist ~ 4", approx(r.dist, 4, 1e-3), "got " + r.dist);

// --- banked road: flat, then twists to fully vertical (90 deg) ----------
// x < 400 flat, 400..600 ramps 0 -> 90 deg, x > 600 vertical (width along Y)
const bank = buildGrid(500, 6, (i, j) => {
  const x = i * 2, w = j * 2 - 6;
  const th = x <= 400 ? 0 : x >= 600 ? Math.PI / 2 : ((x - 400) / 200) * Math.PI / 2;
  return [x, w * Math.sin(th), w * Math.cos(th)];
});
const bankIdx = buildEdgeIndex(bank.verts, bank.tris);

r = distanceToEdge(bankIdx, 800, 0, 0);
check("bank: center of vertical section dist ~ 6", approx(r.dist, 6, 1e-3), "got " + r.dist);
r = distanceToEdge(bankIdx, 800, 0, 3);
check("bank: 3 m off vertical surface dist ~ sqrt(45)",
  approx(r.dist, Math.sqrt(45), 1e-3), "got " + r.dist);
r = distanceToEdge(bankIdx, 200, 0, -5);
check("bank: flat section still works", approx(r.dist, 1, 1e-3), "got " + r.dist);

// --- distanceProfile matches per-point queries (hint must not skew) -----
const NCHK = 200;
const chk = new Float64Array(NCHK * 3);
for (let i = 0; i < NCHK; i++) {
  chk[3 * i] = Math.random() * 1000;
  chk[3 * i + 1] = 0;
  chk[3 * i + 2] = Math.random() * 12 - 6;
}
const prof = distanceProfile(flatIdx, chk, NCHK);
let profOk = true, profBad = "";
for (let i = 0; i < NCHK; i++) {
  const d = distanceToEdge(flatIdx, chk[3 * i], chk[3 * i + 1], chk[3 * i + 2]).dist;
  if (!approx(prof[i], d, 1e-4)) { profOk = false; profBad = "frame " + i + ": " + prof[i] + " vs " + d; break; }
}
check("profile: matches distanceToEdge on 200 random points", profOk, profBad);

// --- performance: 17,000 queries on the flat road -----------------------
const NPERF = 17000;
const perfPos = new Float64Array(NPERF * 3);
for (let i = 0; i < NPERF; i++) {
  perfPos[3 * i] = Math.random() * 1000;
  perfPos[3 * i + 1] = 0;
  perfPos[3 * i + 2] = Math.random() * 12 - 6;
}
const t0 = process.hrtime.bigint();
const perfProf = distanceProfile(flatIdx, perfPos, NPERF);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
let sane = true;
for (let i = 0; i < NPERF; i++)
  if (!(perfProf[i] >= 0 && perfProf[i] <= 6.001)) { sane = false; break; }
check("perf: all " + NPERF + " results in [0, 6]", sane, "out-of-range distance");
check("perf: " + NPERF + " queries < 1000 ms", ms < 1000, ms.toFixed(1) + " ms");
console.log("perf: " + NPERF + " queries in " + ms.toFixed(1) + " ms ("
  + (ms * 1000 / NPERF).toFixed(2) + " us/query)");

console.log(failed === 0 ? "\nall tests passed" : "\n" + failed + " test(s) FAILED");
process.exit(failed === 0 ? 0 : 1);
