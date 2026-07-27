/* bench_glowalloc.js — did the allocation pass actually reduce allocation?
 *
 * WHY. The pass was justified by an argument: drawCarLights ran once per car per frame and
 * rebuilt three growing Arrays, a closure, a per-side sort, an mXfPt result per lamp, three
 * colour literals and a Float32Array per batch. The argument is plausible and was never
 * checked. A commit gets its tether for free on CORRECTNESS — the tests pass — but the claim
 * this change was made for is PERFORMANCE, and nothing in the suite measures it. That tether
 * has to be gone and got.
 *
 * HOW. Both versions of the real function are evaluated against the same GL stub and driven
 * for the same frames, and bytes allocated is read from V8 rather than inferred. This does not
 * measure frame time, GPU cost, or anything about the running app — only how much garbage the
 * changed code path creates, which is exactly and only what the pass claimed to change.
 *
 *   node --expose-gc bench_glowalloc.js [frames]
 *
 * Without --expose-gc it still runs; the numbers are noisier because a collection can land
 * mid-measurement. Reported either way rather than silently degraded.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const v8 = require("v8");
const { execFileSync } = require("child_process");

const FRAMES = parseInt(process.argv[2], 10) || 20000;
const CARS = 9;                                    // a full field, the case the pass was for

/* ---- the two versions of the real source ---- */

function versionAt(rev) {
  return execFileSync("git", ["show", `${rev}:ui/lightfx.js`], { cwd: __dirname, encoding: "utf8" });
}
function fnFrom(src, name) {
  const m = new RegExp("^(?:async )?function " + name + "\\s*\\(", "m").exec(src);
  if (!m) return null;
  let i = src.indexOf("{", m.index), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(m.index, j + 1);
  }
  return null;
}

const AFTER = fs.readFileSync(path.join(__dirname, "ui", "lightfx.js"), "utf8");
const BEFORE = versionAt("9a5feaf~1");             // the commit before the allocation pass

/* ---- one harness, two bodies ---- */

/* The stub must allocate NOTHING during the measured loop. The first version of this file
 * pushed every draw count into an array — 540,000 entries across the run — and that array,
 * not the code under test, was the dominant allocator. Both versions then reported an
 * identical 11.9 MB and the pass looked like it had changed nothing. The harness was the
 * measurement. So: recording is gated, and only the verification pass turns it on. */
let draws = [];
let recording = true;
const gl = {
  ARRAY_BUFFER: 1, DYNAMIC_DRAW: 2, POINTS: 3, FLOAT: 4, BLEND: 5, ONE: 6,
  useProgram() {}, uniformMatrix4fv() {}, enable() {}, disable() {}, blendFunc() {},
  depthMask() {}, bindBuffer() {}, enableVertexAttribArray() {}, vertexAttribPointer() {},
  uniform3f() {}, bufferData() {}, drawArrays(_m, _f, n) { if (recording) draws.push(n); },
};
const cv = { height: 1080 };
const camEye = () => [0, 2, 30];
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mXfPt = (v, M) => [v[0]*M[0]+v[1]*M[4]+v[2]*M[8]+M[12],
                         v[0]*M[1]+v[1]*M[5]+v[2]*M[9]+M[13],
                         v[0]*M[2]+v[1]*M[6]+v[2]*M[10]+M[14]];
const lamps = n => Array.from({ length: n }, (_, i) => [i % 2 ? 0.6 : -0.6, 1 + i * 0.1, 2]);
const carLights = {
  headLamps: lamps(6),
  tail: [[0, 1, -2], [0.4, 1, -2], [-0.4, 1, -2]],
  accentR: [[0.5, 0.9, 0], [-0.5, 0.9, 0]],
  accentW: [[0.3, 1.1, 1], [-0.3, 1.1, 1]],
};

function buildAfter() {
  const pre = `
    const GLOW_CAP = 256;
    const _glowWarm={a:new Float32Array(GLOW_CAP*5),n:0},_glowRed={a:new Float32Array(GLOW_CAP*5),n:0},
          _glowWhite={a:new Float32Array(GLOW_CAP*5),n:0},_glowFwd=[0,0,0];
    const _lampL=[],_lampR=[],_lampSides=[_lampL,_lampR];
    let _lampSrc=null,_glowOverflowed=false;
    const progGlow={},glowBuf={},HDR_EMIT=2.7,glowLoc={mvp:0,pos:1,size:2,bright:3,color:4};`;
  const body = ["pushGlow", "headLampSides", "drawCarLights", "batchGlow"]
    .map(n => fnFrom(AFTER, n)).join("\n");
  return new Function("gl", "cv", "camEye", "carLights", "console",
                      pre + body + "; return drawCarLights;")(gl, cv, camEye, carLights, console);
}
function buildBefore() {
  const pre = `const progGlow={},glowBuf={},HDR_EMIT=2.7,glowLoc={mvp:0,pos:1,size:2,bright:3,color:4};`;
  return new Function("gl", "cv", "camEye", "carLights", "mXfPt",
                      pre + fnFrom(BEFORE, "drawCarLights") + "; return drawCarLights;")
                     (gl, cv, camEye, carLights, mXfPt);
}

/* ---- measure ---- */

function bytesFor(fn, frames) {
  recording = false;                 // the harness must not be the thing being measured
  if (global.gc) global.gc();
  // warm up so JIT compilation is not charged to the measurement
  for (let i = 0; i < 500; i++) for (let c = 0; c < CARS; c++) fn(IDENT, IDENT, 0.5, 1, 0.3);
  if (global.gc) global.gc();
  const t0 = process.hrtime.bigint();
  const a0 = v8.getHeapStatistics().total_heap_size;
  const s0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < frames; i++) for (let c = 0; c < CARS; c++) fn(IDENT, IDENT, 0.5, 1, 0.3);
  const s1 = process.memoryUsage().heapUsed;
  const t1 = process.hrtime.bigint();
  return { grown: Math.max(0, s1 - s0), heap: v8.getHeapStatistics().total_heap_size - a0,
           ms: Number(t1 - t0) / 1e6 };
}

const after = buildAfter(), before = buildBefore();
if (!after || !before) { console.error("could not build both versions"); process.exit(2); }

// draw counts must match, or the two are not doing the same work and nothing below means anything
draws.length = 0; before(IDENT, IDENT, 0.5, 1, 0.3); const dBefore = draws.slice();
draws.length = 0; after(IDENT, IDENT, 0.5, 1, 0.3);  const dAfter = draws.slice();
const sameWork = dBefore.length === dAfter.length && dBefore.every((n, i) => n === dAfter[i]);

const B = bytesFor(before, FRAMES);
const A = bytesFor(after, FRAMES);

const mb = n => (n / 1048576).toFixed(1) + " MB";
const perFrame = n => (n / FRAMES).toFixed(0) + " B";

console.log(`bench_glowalloc — ${FRAMES} frames x ${CARS} cars, gc ${global.gc ? "exposed" : "NOT exposed (noisier)"}`);
console.log(`  draws per frame: before ${dBefore.join("/")} · after ${dAfter.join("/")} — ` +
            (sameWork ? "same work" : "*** DIFFERENT WORK — numbers below are meaningless ***"));
console.log(`  before  heapUsed grew ${mb(B.grown)}  (${perFrame(B.grown)}/frame)  in ${B.ms.toFixed(0)} ms`);
console.log(`  after   heapUsed grew ${mb(A.grown)}  (${perFrame(A.grown)}/frame)  in ${A.ms.toFixed(0)} ms`);
if (B.grown > 0) {
  const cut = 100 * (1 - A.grown / B.grown);
  console.log(`  allocation cut: ${cut.toFixed(1)}%  (${(B.grown / Math.max(1, A.grown)).toFixed(1)}x less garbage)`);
}
console.log(`\n  What this does and does not say: it measures garbage created by this code path,`);
console.log(`  which is what the pass claimed to change. It says nothing about frame time in the`);
console.log(`  running app, GPU cost, or whether the observed stalls came from here at all.`);
process.exit(sameWork ? 0 : 1);
