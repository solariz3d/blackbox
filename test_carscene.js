/* test_carscene.js — kn5.js extractScene car/LOD test + track regression guard.
 *
 * 1. Loads the T-180 car body kn5 and parses it two ways: all LODs vs
 *    { lod0Only: true }. Prints mesh/tri counts both ways + lodSkipped, and
 *    validates the LOD0 geometry (unit-ish normals, finite UVs, in-range
 *    indices, texture blobs present, sane world bounds).
 * 2. REGRESSION: extractScene() with no opts on centrifuge.kn5 must return the
 *    same meshCount/triCount as the baseline captured before the lod0Only change.
 *
 * Run: node test_carscene.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const KN5 = require("./ui/kn5.js");

const CAR_DIR = "G:/SteamLibrary/steamapps/common/assettocorsa/content/cars/ohyeah2389_t180_mach6";
const CENTRIFUGE = "G:/SteamLibrary/steamapps/common/assettocorsa/content/tracks/centrifuge/centrifuge.kn5";

// Baseline captured on the UNCHANGED extractScene (node, before the lod0Only edit).
const CENTRIFUGE_BASELINE = { meshCount: 144, triCount: 3237590 };

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log("  ok  - " + msg);
  } else {
    console.log("  FAIL- " + msg);
    failures++;
  }
}

function readAB(p) {
  const buf = fs.readFileSync(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// locate the T-180 body kn5 (largest kn5 in the folder — mirror of find_car)
function findCarKn5(dir) {
  const kn5s = fs
    .readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith(".kn5"))
    .map((n) => ({ name: n, size: fs.statSync(path.join(dir, n)).size }));
  if (!kn5s.length) throw new Error("no kn5 in " + dir);
  const exact = kn5s.find((f) => f.name.toLowerCase() === path.basename(dir).toLowerCase() + ".kn5");
  const pick = exact || kn5s.reduce((a, b) => (b.size > a.size ? b : a));
  return path.join(dir, pick.name);
}

console.log("== T-180 car scene ==");
const carPath = findCarKn5(CAR_DIR);
console.log("car kn5: " + carPath + " (" + (fs.statSync(carPath).size / 1024 / 1024).toFixed(1) + " MB)");
const carAB = readAB(carPath);

const full = KN5.extractScene(carAB);
const lod0 = KN5.extractScene(carAB, { lod0Only: true });

console.log(
  "  full:   meshCount=" + full.stats.meshCount + " tris=" + full.stats.triCount +
    " groups=" + full.groups.length + " skippedTransparent=" + full.stats.skippedTransparent +
    " lodSkipped=" + (full.stats.lodSkipped || 0)
);
console.log(
  "  lod0:   meshCount=" + lod0.stats.meshCount + " tris=" + lod0.stats.triCount +
    " groups=" + lod0.groups.length + " skippedTransparent=" + lod0.stats.skippedTransparent +
    " lodSkipped=" + lod0.stats.lodSkipped
);

check(lod0.stats.meshCount <= full.stats.meshCount, "lod0 meshCount <= full meshCount");
check(lod0.stats.triCount <= full.stats.triCount, "lod0 triCount <= full triCount");
check(lod0.stats.lodSkipped >= 0, "lodSkipped present (" + lod0.stats.lodSkipped + ")");
check(
  full.stats.meshCount === lod0.stats.meshCount + lod0.stats.lodSkipped,
  "full meshCount === lod0 meshCount + lodSkipped (" +
    full.stats.meshCount + " === " + lod0.stats.meshCount + " + " + lod0.stats.lodSkipped + ")"
);
check(full.stats.lodSkipped === 0 || full.stats.lodSkipped === undefined, "full parse skips no LODs");
check(lod0.textures.length > 0, "texture blobs present (" + lod0.textures.length + ")");
check(lod0.groups.length > 0, "lod0 has drawable groups");

// geometry validation on the LOD0 groups + world bounds
let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
let badNorm = 0, badUV = 0, badIdx = 0, normSampled = 0;
for (const g of lod0.groups) {
  const vc = g.pos.length / 3;
  // indices must all be < this group's vertex count
  for (let i = 0; i < g.idx.length; i++) {
    if (g.idx[i] >= vc) { badIdx++; break; }
  }
  // sample normals for unit length + all UVs finite + accumulate bounds
  const step = Math.max(1, Math.floor(vc / 500));
  for (let v = 0; v < vc; v++) {
    const px = g.pos[v * 3], py = g.pos[v * 3 + 1], pz = g.pos[v * 3 + 2];
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
    if (!Number.isFinite(g.uv[v * 2]) || !Number.isFinite(g.uv[v * 2 + 1])) badUV++;
    if (v % step === 0) {
      const nx = g.nrm[v * 3], ny = g.nrm[v * 3 + 1], nz = g.nrm[v * 3 + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      normSampled++;
      // unit-ish, or exactly zero (degenerate normal left un-normalized)
      if (!(Math.abs(len - 1) < 1e-3 || len === 0)) badNorm++;
    }
  }
}
check(badIdx === 0, "all group indices < group vertex count");
check(badUV === 0, "all UVs finite (" + badUV + " bad)");
check(badNorm === 0, "sampled normals unit-ish (" + badNorm + "/" + normSampled + " off)");

console.log(
  "  lod0 world bounds: X[" + minX.toFixed(2) + "," + maxX.toFixed(2) + "] " +
    "Y[" + minY.toFixed(2) + "," + maxY.toFixed(2) + "] " +
    "Z[" + minZ.toFixed(2) + "," + maxZ.toFixed(2) + "]"
);
console.log(
  "  lod0 size: " + (maxX - minX).toFixed(2) + " x " + (maxY - minY).toFixed(2) +
    " x " + (maxZ - minZ).toFixed(2) + " m (WxHxL)"
);
check([minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite), "world bounds finite");

console.log("\n== centrifuge regression (no opts) ==");
const cenAB = readAB(CENTRIFUGE);
const cen = KN5.extractScene(cenAB);
console.log("  meshCount=" + cen.stats.meshCount + " triCount=" + cen.stats.triCount + " groups=" + cen.groups.length);
check(cen.stats.meshCount === CENTRIFUGE_BASELINE.meshCount,
  "meshCount unchanged (" + cen.stats.meshCount + " === " + CENTRIFUGE_BASELINE.meshCount + ")");
check(cen.stats.triCount === CENTRIFUGE_BASELINE.triCount,
  "triCount unchanged (" + cen.stats.triCount + " === " + CENTRIFUGE_BASELINE.triCount + ")");

console.log("\n" + (failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"));
process.exit(failures === 0 ? 0 : 1);
