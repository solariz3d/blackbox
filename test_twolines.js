/* Decisive: extract "position" from TWO different replays on the same track.
 * Identical lines => we're reading track spline. Different lines => real driving.
 * Usage: node test_twolines.js <a.acreplay> <b.acreplay>
 */
"use strict";
const fs = require("fs");
const { parseReplay, extractCar } = require("./ui/acreplay.js");

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

/* Two runs on the SAME track. The pairing matters more than having a default: the two
 * replays committed to samples/ are on different circuits, and comparing them yields 44 m
 * of "line separation" between a tube track and a centrifuge — a number that satisfies the
 * "different runs" verdict below while measuring nothing. A default that makes the
 * assertion vacuous is worse than no default, so this takes a real pair from the local AC
 * replay folder and skips when there is not one. */
const E = require("./testenv.js");
const pair = (process.argv[2] && process.argv[3]) ? [process.argv[2], process.argv[3]]
                                                  : E.sameTrackReplayPair();
if (!pair) E.skip("no two replays of the same car+track found (usage: node test_twolines.js <a.acreplay> <b.acreplay>)");
const [pathA, pathB] = pair;

const exA = loadEx(pathA);
const exB = loadEx(pathB);
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

/* The verdict above was printed for a human to read and the process exited 0 either way,
 * so this file could not fail — it would have reported the spline bug in plain text and
 * still gone green in a suite sweep. The threshold is not invented here; it is the one the
 * line above already states. */
const median = q(0.5);
if (!(median > 1)) {
  console.log(`\nFAIL: median separation ${median.toFixed(2)} m — two runs on the same track ` +
              `should not share a line. Below 0.3 m means positions are coming from a ` +
              `centred spline rather than from the recorded drive.`);
  process.exit(1);
}
console.log(`\nall good — ${seps.length} sampled points, median separation ${median.toFixed(2)} m`);
