/* test_posesmooth.js — the car pose must be C1 across replay-sample boundaries.
 *
 * THE SYMPTOM THIS EXISTS FOR: the frame counter reads a locked 360 and the motion
 * still looks stepped. That is not a throughput problem and no frame rate fixes it.
 * Replay data arrives at ~66.7 Hz (15 ms). `carModelMatrix` synthesises every render
 * frame in between. If it does so LINEARLY, position is continuous but VELOCITY IS
 * PIECEWISE CONSTANT — it jumps at every one of those 66.7 boundaries per second. The
 * car travels a straight chord, kinks, travels another. At 360 Hz you get ~5.4 clean
 * frames per kink, forever.
 *
 * HOW IT IS MEASURED, without a screen: drive a synthetic car around a circle at
 * constant speed, sample the pose at 360 Hz, and take the discrete second difference
 * of the translation — a proxy for acceleration.
 *
 *   true circular motion  -> |a| is CONSTANT, so max/mean = 1
 *   linear interpolation  -> |a| is ~0 inside each segment and spikes at every
 *                            boundary, so max/mean ~= the frames-per-sample ratio
 *
 * That ratio is the whole test. It cannot be satisfied by making anything faster.
 *
 * Run: node test_posesmooth.js
 */
"use strict";

global.carSlipExag = 1;    // no crab exaggeration — this test is about the path, not the yaw
global.carLift = 0;

const { carModelMatrix } = require("./ui/carrender.js");

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log("  ok  - " + msg); }
  else { console.log("  FAIL- " + msg); failures++; }
}

// ---- a synthetic run: constant speed around a circle, sampled at the replay's rate ----
// A circle is the cleanest referent available: true |acceleration| is constant, so any
// variation in the measured second difference is interpolation artifact and nothing else.
const R = 30;                 // m — tighter than a hairpin, so the effect is not marginal
const V = 40;                 // m/s (~144 km/h)
const DT = 0.015;             // s — the replay sample interval (66.7 Hz)
const N = 400;
const OMEGA = V / R;          // rad/s

const pos = new Float32Array(N * 3);
const nrm = new Float32Array(N * 3);
const fwd = new Float32Array(N * 3);
const gap = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  const th = OMEGA * DT * i;
  pos[i * 3] = R * Math.cos(th);
  pos[i * 3 + 1] = 0;
  pos[i * 3 + 2] = R * Math.sin(th);
  nrm[i * 3] = 0; nrm[i * 3 + 1] = 1; nrm[i * 3 + 2] = 0;
  // tangent to the circle, unit
  fwd[i * 3] = -Math.sin(th); fwd[i * 3 + 1] = 0; fwd[i * 3 + 2] = Math.cos(th);
}
const run = { pos, nrm, fwd, gap, N, dt: DT };

// ---- sample the pose at 360 Hz over the middle of the run ----
const RENDER_HZ = 360;
const STEP = (1 / RENDER_HZ) / DT;        // fractional frames advanced per render frame
console.log(`  circle R=${R}m v=${V}m/s · replay ${(1 / DT).toFixed(1)}Hz · render ${RENDER_HZ}Hz · ${STEP.toFixed(2)} render frames per sample`);

const P = [];
for (let fp = 20; fp < N - 20; fp += STEP) {
  const m = carModelMatrix(fp, run).mat;
  P.push([m[12], m[13], m[14]]);
}

// discrete second difference — proportional to acceleration at fixed render step
const acc = [];
for (let k = 1; k < P.length - 1; k++) {
  const ax = P[k + 1][0] - 2 * P[k][0] + P[k - 1][0];
  const ay = P[k + 1][1] - 2 * P[k][1] + P[k - 1][1];
  const az = P[k + 1][2] - 2 * P[k][2] + P[k - 1][2];
  acc.push(Math.hypot(ax, ay, az));
}
const mean = acc.reduce((s, x) => s + x, 0) / acc.length;
const max = Math.max(...acc);
const ratio = mean > 0 ? max / mean : Infinity;

console.log(`  |second difference|: mean ${mean.toExponential(3)}  max ${max.toExponential(3)}  max/mean ${ratio.toFixed(2)}`);

// A perfect circle sampled uniformly gives exactly 1. Linear interpolation gives about
// STEP^-1 — one spike per replay sample, near-zero between. The bar sits well clear of
// both so it cannot pass by luck in either direction.
check(ratio < 2.0,
  `acceleration is not spiking at sample boundaries (max/mean ${ratio.toFixed(2)} < 2.0; linear interpolation gives ~${(1 / STEP).toFixed(1)})`);

// ---- the path must still BE the circle: smoothness is worthless if it wanders ----
let worstR = 0;
for (const p of P) worstR = Math.max(worstR, Math.abs(Math.hypot(p[0], p[2]) - R));
console.log(`  worst radial error: ${(worstR * 1000).toFixed(3)} mm`);
check(worstR < 0.01, `path stays on the circle within 10 mm (worst ${(worstR * 1000).toFixed(2)} mm) — guards against overshoot`);

// ---- a gap must still hard-stop interpolation: never invent a curve through absent data ----
const gapRun = { pos, nrm, fwd, gap: new Uint8Array(N), N, dt: DT };
gapRun.gap[200] = 1;
const before = carModelMatrix(199.0, gapRun).mat;
const mid = carModelMatrix(199.5, gapRun).mat;
check(Math.abs(before[12] - mid[12]) < 1e-6 && Math.abs(before[14] - mid[14]) < 1e-6,
  "interpolation is disabled across a gap frame (pose holds, no invented curve)");

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
