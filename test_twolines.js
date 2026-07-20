/* Decisive: extract "position" from TWO different replays on the same track.
 * Identical lines => we're reading track spline. Different lines => real driving.
 * Usage: node test_twolines.js <a.acreplay> <b.acreplay>
 */
"use strict";
const fs = require("fs");
const { parseReplay, extractCar } = require("./acreplay.js");

function loadEx(p) {
  const b = fs.readFileSync(p);
  return extractCar(parseReplay(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), 0);
}

function lapPoints(ex, step) {
  const a = ex.laps.length >= 2 ? ex.laps[0].frame : 0;
  const b = ex.laps.length >= 2 ? ex.laps[ex.laps.length - 1].frame : ex.N;
  const pts = [];
  let acc = step;
  for (let i = a + 1; i < b; i++) {
    if (ex.gap[i]) continue;
    const dx = ex.pos[i * 3] - ex.pos[(i - 1) * 3];
    const dy = ex.pos[i * 3 + 1] - ex.pos[(i - 1) * 3 + 1];
    const dz = ex.pos[i * 3 + 2] - ex.pos[(i - 1) * 3 + 2];
    acc += Math.hypot(dx, dy, dz);
    if (acc >= step) {
      pts.push([ex.pos[i * 3], ex.pos[i * 3 + 1], ex.pos[i * 3 + 2]]);
      acc = 0;
    }
  }
  return pts;
}

const exA = loadEx(process.argv[2]);
const exB = loadEx(process.argv[3]);
const A = lapPoints(exA, 10);
const B = lapPoints(exB, 5);
console.log(`A: ${A.length} pts (lap ${exA.laps.map(l => (l.timeMs / 1000).toFixed(1))})`);
console.log(`B: ${B.length} pts (lap ${exB.laps.map(l => (l.timeMs / 1000).toFixed(1))})`);

// grid for B
const cell = 40;
const grid = new Map();
B.forEach((p, i) => {
  const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(i);
});
function nearestB(p) {
  let best = 1e9;
  const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    const lst = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
    if (!lst) continue;
    for (const i of lst) {
      const d = Math.hypot(B[i][0] - p[0], B[i][1] - p[1], B[i][2] - p[2]);
      if (d < best) best = d;
    }
  }
  return best;
}

const seps = A.map(nearestB).filter(d => d < 1e8);
seps.sort((x, y) => x - y);
const q = p => seps[Math.floor(p * (seps.length - 1))];
console.log(`\nline separation A→B (m): p10 ${q(0.10).toFixed(2)}  median ${q(0.5).toFixed(2)}  p90 ${q(0.9).toFixed(2)}  max ${q(1).toFixed(2)}`);
console.log(`VERDICT: median < 0.3 m = same line (spline — BUG); median > 1 m = different human runs (real driving)`);
