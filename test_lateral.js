/* Decisive test: is the replay position a human line or a centered spline?
 * Measures signed left/right boundary distances per frame -> lateral ratio.
 * Usage: node test_lateral.js <track.kn5> <replay.acreplay>
 */
"use strict";
const fs = require("fs");
const { extractRoadMesh } = require("./ui/kn5.js");
const { parseReplay, extractCar } = require("./ui/acreplay.js");
const { buildEdgeIndex } = require("./ui/roadedge.js");

function loadAB(p) {
  const b = fs.readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/* Arguments still override; without them this reads the T-180 test track and the sample
 * replay committed to samples/. It used to crash on fs.readFileSync(undefined), which is a
 * worse failure than a usage line: a stack trace looks like a broken test rather than a
 * tool that was never given its input. */
const E = require("./testenv.js");
const kn5Path = process.argv[2] || E.trackKn5("t180testtrack");
const repPath = process.argv[3] || E.sampleReplay();
if (!kn5Path) E.skip("no track .kn5 (usage: node test_lateral.js <track.kn5> <replay.acreplay>)");
if (!repPath) E.skip("no replay (usage: node test_lateral.js <track.kn5> <replay.acreplay>)");

const mesh = extractRoadMesh(loadAB(kn5Path));
const index = buildEdgeIndex(mesh.verts, mesh.tris);
const ex = extractCar(parseReplay(loadAB(repPath)), 0);

const segs = index.segs; // flat pairs of endpoints
const nseg = index.count;

// coarse per-segment midpoints for prefilter
const mids = new Float64Array(nseg * 3);
for (let s = 0; s < nseg; s++) {
  mids[s * 3] = (segs[s * 6] + segs[s * 6 + 3]) / 2;
  mids[s * 3 + 1] = (segs[s * 6 + 1] + segs[s * 6 + 4]) / 2;
  mids[s * 3 + 2] = (segs[s * 6 + 2] + segs[s * 6 + 5]) / 2;
}

function closestOnSeg(s, px, py, pz) {
  const ax = segs[s * 6], ay = segs[s * 6 + 1], az = segs[s * 6 + 2];
  const bx = segs[s * 6 + 3], by = segs[s * 6 + 4], bz = segs[s * 6 + 5];
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const L2 = dx * dx + dy * dy + dz * dz;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return [ax + t * dx, ay + t * dy, az + t * dz];
}

// lap window
const a = ex.laps.length >= 2 ? ex.laps[0].frame : 0;
const b = ex.laps.length >= 2 ? ex.laps[ex.laps.length - 1].frame : ex.N;

const ratios = [];
const samples = [];
for (let i = a; i < b; i += 20) {
  if (ex.gap[i]) continue;
  const px = ex.pos[i * 3], py = ex.pos[i * 3 + 1], pz = ex.pos[i * 3 + 2];
  const j = Math.min(i + 4, ex.N - 1);
  let fx = ex.pos[j * 3] - px, fy = ex.pos[j * 3 + 1] - py, fz = ex.pos[j * 3 + 2] - pz;
  const fl = Math.hypot(fx, fy, fz);
  if (fl < 0.5) continue;
  fx /= fl; fy /= fl; fz /= fl;
  const nx = ex.nrm[i * 3], ny = ex.nrm[i * 3 + 1], nz = ex.nrm[i * 3 + 2];
  // right = normal x forward
  let rx = ny * fz - nz * fy, ry = nz * fx - nx * fz, rz = nx * fy - ny * fx;
  const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;

  let dL = 1e9, dR = 1e9;
  for (let s = 0; s < nseg; s++) {
    const mx = mids[s * 3] - px, my = mids[s * 3 + 1] - py, mz = mids[s * 3 + 2] - pz;
    if (mx * mx + my * my + mz * mz > 2500) continue; // 50 m prefilter
    const c = closestOnSeg(s, px, py, pz);
    const ex_ = c[0] - px, ey = c[1] - py, ez = c[2] - pz;
    const d = Math.hypot(ex_, ey, ez);
    // ignore boundary points mostly along-track (ahead/behind artifacts)
    const along = Math.abs(ex_ * fx + ey * fy + ez * fz);
    if (along > d * 0.85) continue;
    const side = ex_ * rx + ey * ry + ez * rz;
    if (side >= 0) { if (d < dR) dR = d; }
    else { if (d < dL) dL = d; }
  }
  if (dL > 100 || dR > 100) continue;
  const width = dL + dR;
  if (width < 4 || width > 60) continue;
  const ratio = dR / width; // 0 = hugging right edge... wait: dR small = close to right
  ratios.push(ratio);
  samples.push({ t: +(i * ex.dt).toFixed(1), km: +((ex.odo[i] - ex.odo[a]) / 1000).toFixed(2), dL: +dL.toFixed(1), dR: +dR.toFixed(1), width: +width.toFixed(1), ratio: +ratio.toFixed(2) });
}

ratios.sort((x, y) => x - y);
const q = p => ratios[Math.floor(p * (ratios.length - 1))];
const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length;
const sd = Math.sqrt(ratios.reduce((s, x) => s + (x - mean) * (x - mean), 0) / ratios.length);
console.log(`lateral ratio (0 = on right edge, 1 = on left edge, 0.5 = dead center):`);
console.log(`  n=${ratios.length}  p5 ${q(0.05).toFixed(2)}  p25 ${q(0.25).toFixed(2)}  median ${q(0.5).toFixed(2)}  p75 ${q(0.75).toFixed(2)}  p95 ${q(0.95).toFixed(2)}`);
console.log(`  mean ${mean.toFixed(3)}  sd ${sd.toFixed(3)}`);
console.log(`  VERDICT: sd < 0.05 would mean spline-centered; sd > 0.15 is a human line sweeping the road`);

/* Nothing checked that verdict, so the answer this test exists to give — is the replay a
 * real driven line or a centred spline? — was printed and never enforced. The 0.15 is the
 * file's own stated threshold, not a new one. */
if (!(sd > 0.15)) {
  console.log(`\nFAIL: lateral sd ${sd.toFixed(3)} — the car is holding a near-constant ` +
              `position across the road, which is what a centred spline looks like, not a driven line`);
  process.exit(1);
}

// show a corner sequence: 20 consecutive samples around the slowest corner (26.8 km)
console.log(`\nline through the 26.8 km corner (dL/dR = meters to left/right edge):`);
for (const s of samples.filter(s => s.km > 26.2 && s.km < 27.4).slice(0, 14)) {
  const bar = "L" + "-".repeat(Math.round(s.ratio * 20)) + "O" + "-".repeat(Math.max(0, 20 - Math.round(s.ratio * 20))) + "R";
  console.log(`  ${s.km.toFixed(2)}km  w${String(s.width).padStart(5)}  ${bar}  (${s.dL} | ${s.dR})`);
}
