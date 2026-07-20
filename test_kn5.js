/* Node test: parse a real track kn5 and cross-check against the replay path.
 * Usage: node test_kn5.js <file.kn5> [file.acreplay]
 */
"use strict";
const fs = require("fs");
const { extractRoadMesh } = require("./kn5.js");

const path = process.argv[2];
if (!path) { console.error("usage: node test_kn5.js <file.kn5> [file.acreplay]"); process.exit(1); }

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

const repPath = process.argv[3];
if (repPath) {
  const { parseReplay, extractCar } = require("./acreplay.js");
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
}
