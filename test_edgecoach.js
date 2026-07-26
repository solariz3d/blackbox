/* The coaching number: distance-to-edge for a real replay on the real track.
 * Usage: node test_edgecoach.js <track.kn5> <replay.acreplay>
 */
"use strict";
const fs = require("fs");
const { extractRoadMesh } = require("./ui/kn5.js");
const { parseReplay, extractCar } = require("./ui/acreplay.js");
const { buildEdgeIndex, distanceProfile } = require("./ui/roadedge.js");

function loadAB(p) {
  const b = fs.readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

// arguments override; bare, it runs the T-180 test track against the in-repo sample replay
const E = require("./testenv.js");
const [argKn5, argRep] = process.argv.slice(2);
const kn5Path = argKn5 || E.trackKn5("t180testtrack");
const repPath = argRep || E.sampleReplay();
if (!kn5Path) E.skip("no track .kn5 (usage: node test_edgecoach.js <track.kn5> <replay.acreplay>)");
if (!repPath) E.skip("no replay (usage: node test_edgecoach.js <track.kn5> <replay.acreplay>)");
let t0 = Date.now();
const mesh = extractRoadMesh(loadAB(kn5Path));
console.log(`kn5: ${(mesh.tris.length / 3).toLocaleString()} road tris (${Date.now() - t0} ms)`);

t0 = Date.now();
const index = buildEdgeIndex(mesh.verts, mesh.tris);
console.log(`edge index: ${index.count.toLocaleString()} boundary segments (${Date.now() - t0} ms)`);

const ex = extractCar(parseReplay(loadAB(repPath)), 0);
t0 = Date.now();
const prof = distanceProfile(index, ex.pos, ex.N);
console.log(`edge profile: ${ex.N.toLocaleString()} frames (${Date.now() - t0} ms)`);

// stats over the flying lap only (between first and last lap-line crossing if present)
let a = 0, b = ex.N;
if (ex.laps.length >= 2) { a = 0; b = ex.laps[ex.laps.length - 1].frame; a = ex.laps[0].frame; }
const lap = Array.from(prof.slice(a, b)).filter(x => isFinite(x));
lap.sort((x, y) => x - y);
const q = p => lap[Math.floor(p * (lap.length - 1))];
console.log(`\nLAP edge-distance (m): min ${q(0).toFixed(2)}  p1 ${q(0.01).toFixed(2)}  p10 ${q(0.10).toFixed(2)}  median ${q(0.5).toFixed(2)}  p90 ${q(0.9).toFixed(2)}`);

// closest approaches: local minima under 2 m, min 3 s apart
const dt = ex.dt;
const events = [];
let i = a;
while (i < b) {
  let ji = i, jv = 1e9;
  const end = Math.min(b, i + Math.round(3 / dt));
  for (let j = i; j < end; j++) if (prof[j] < jv) { jv = prof[j]; ji = j; }
  if (jv < 2.0) { events.push([ji, jv]); i = ji + Math.round(3 / dt); }
  else i = end;
}
console.log(`\nclosest brushes with the edge (<2 m), lap-time / dist-into-lap / meters / speed / alt:`);
const lapStartT = a * dt;
for (const [j, v] of events.slice(0, 20)) {
  console.log(`  ${((j * dt) - lapStartT).toFixed(1).padStart(6)}s  ${(ex.odo[j] - ex.odo[a]).toFixed(0).padStart(6)}m  ${v.toFixed(2)}m  ${isFinite(ex.speed[j]) ? ex.speed[j].toFixed(0) : "—"}kph  alt ${ex.pos[j * 3 + 1].toFixed(0)}m`);
}

// the climb: 28.5-31.5 km into the lap
const odoA = ex.odo[a];
const climb = [];
for (let j = a; j < b; j++) {
  const d = ex.odo[j] - odoA;
  if (d > 28500 && d < 31500 && isFinite(prof[j])) climb.push(prof[j]);
}
climb.sort((x, y) => x - y);
if (climb.length) {
  const cq = p => climb[Math.floor(p * (climb.length - 1))];
  console.log(`\nTHE CLIMB (28.5-31.5 km): edge-dist min ${cq(0).toFixed(2)}  p10 ${cq(0.10).toFixed(2)}  median ${cq(0.5).toFixed(2)}  p90 ${cq(0.9).toFixed(2)} m`);
  console.log(`unspent outside margin on the climb (median): ~${cq(0.5).toFixed(1)} meters of dark`);
}
