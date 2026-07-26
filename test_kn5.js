/* Node test: parse a real track kn5 and cross-check against the replay path.
 * Usage: node test_kn5.js <file.kn5> [file.acreplay]
 */
"use strict";
const fs = require("fs");
const { extractRoadMesh } = require("./ui/kn5.js");

// An argument still overrides, but running it bare now works: this file spent months
// printing a usage line and exiting 1, which reads as "broken" in a suite sweep and meant
// nobody noticed it had also stopped loading at all.
const E = require("./testenv.js");
const path = process.argv[2] || E.trackKn5("t180testtrack");
if (!path) E.skip("no .kn5 given and no Assetto Corsa install found (usage: node test_kn5.js <file.kn5> [file.acreplay])");

const buf = fs.readFileSync(path);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const t0 = Date.now();
const mesh = extractRoadMesh(ab);
console.log(`v${mesh.version}: ${mesh.meshTotal} meshes (${mesh.skinnedCount} skinned), ${mesh.textureCount} textures, ${mesh.materialCount} materials`);
console.log(`road: ${mesh.meshCount} meshes, ${(mesh.verts.length / 3).toLocaleString()} verts, ${(mesh.tris.length / 3).toLocaleString()} tris`);
console.log(`consumed ${mesh.consumed} / ${mesh.total} (${mesh.total - mesh.consumed} slack)`);
console.log(`parse: ${Date.now() - t0} ms`);
console.log("sample names:", mesh.names.slice(0, 8).join(", "));

let minX = 1e30, maxX = -1e30, minY = 1e30, maxY = -1e30, minZ = 1e30, maxZ = -1e30;
const V = mesh.verts;
for (let i = 0; i < V.length; i += 3) {
  if (V[i] < minX) minX = V[i]; if (V[i] > maxX) maxX = V[i];
  if (V[i + 1] < minY) minY = V[i + 1]; if (V[i + 1] > maxY) maxY = V[i + 1];
  if (V[i + 2] < minZ) minZ = V[i + 2]; if (V[i + 2] > maxZ) maxZ = V[i + 2];
}
console.log(`road bounds: X ${minX.toFixed(0)}..${maxX.toFixed(0)}  Y ${minY.toFixed(0)}..${maxY.toFixed(0)}  Z ${minZ.toFixed(0)}..${maxZ.toFixed(0)}`);

// the in-repo sample, so the replay half of this test runs by default too
const repPath = process.argv[3] || E.sampleReplay();
if (repPath) {
  const { parseReplay, extractCar } = require("./ui/acreplay.js");
  const rb = fs.readFileSync(repPath);
  const rab = rb.buffer.slice(rb.byteOffset, rb.byteOffset + rb.byteLength);
  const ex = extractCar(parseReplay(rab), 0);
  let inX = 0;
  for (let i = 0; i < ex.N; i += 50) {
    const x = ex.pos[i * 3], y = ex.pos[i * 3 + 1], z = ex.pos[i * 3 + 2];
    if (x > minX - 30 && x < maxX + 30 && y > minY - 60 && y < maxY + 60 && z > minZ - 30 && z < maxZ + 30) inX++;
  }
  const frac = inX / Math.ceil(ex.N / 50);
  console.log(`replay-path containment in road bounds: ${(frac * 100).toFixed(1)}% (want ~100)`);
  /* "want ~100" was a note to a reader and nothing checked it, so a replay landing entirely
   * off its own track would print 0.0% and still exit 0. The bar is 95%, not 100: the
   * bounds come from road meshes only, and a car legitimately leaves them in a spin or a
   * run-off. Anything below that means the replay and the track model disagree about where
   * the world is — a coordinate or layout mismatch, which is the failure worth catching.
   *
   * Its reach is limited, and worth naming rather than overselling. The bounds are one
   * axis-aligned box with generous margins, so a SMALL track's replay checked against a
   * LARGE track's model passes at 100%: centrifuge's dome contains the T-180 test track's
   * coordinates outright. It catches the disjoint case — the same replay against the
   * T-180's own bounds scores 19.8% and fails — which is the wrong-track, wrong-scale and
   * wrong-coordinate-system family. Containment is a necessary condition, not a sufficient
   * one, and this line only ever claimed the necessary half. */
  if (frac < 0.95) {
    console.log(`FAIL: only ${(frac * 100).toFixed(1)}% of the replay path lies within the ` +
                `track's road bounds — replay and model disagree about the world`);
    process.exit(1);
  }
}
console.log("all good");
