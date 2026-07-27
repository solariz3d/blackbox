/* test_glowpool.js — the contract that pooled staging buffers have to keep.
 *
 * WHY THIS EXISTS. `drawCarLights` and `wheelSteerModel` were converted from
 * allocate-per-call to module-scope scratch, and the whole test suite passed the entire time
 * — because nothing in it touches either function. Green said "you didn't break anything
 * else"; it could not say the change was right. This closes that.
 *
 * The bug it was written against was real and shipped in the working tree for an hour:
 * `batchGlow` read its draw count off `S.a.length / 5`, which is the pool's CAPACITY, not
 * the cursor `pushGlow` maintains. The expression was correct before the conversion (the
 * staging array was a growing Array, so length WAS the fill) and became a constant the
 * moment it became a pool. A frame staging fewer sprites than the last then redraws the
 * previous car's tail — its world positions, frozen, forever.
 *
 * That is the general hazard of pooling and it is the only thing here worth asserting:
 * a pool is only equivalent to a fresh allocation if nothing beyond the fill is ever read.
 *
 * Where the maths is mirrored rather than imported it is because the real code lives inside
 * a GL draw call. Every mirror is tied back to the real source below, so drift fails the
 * test instead of quietly testing a copy.
 *
 * Run: node test_glowpool.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { uiFunction } = require("./testenv.js");

let fails = 0;
function ok(cond, msg) { if (!cond) { console.log("  FAIL " + msg); fails++; } }

const LIGHTFX = fs.readFileSync(path.join(__dirname, "ui", "lightfx.js"), "utf8");

/* ---- 1. the pool contract, as pure logic ---- */

const CAP = 8;                                   // small stand-in for GLOW_CAP
const mkPool = () => ({ a: new Float32Array(CAP * 5), n: 0 });
function push(S, x, b) {
  if (S.n >= CAP) return false;
  const o = S.n * 5;
  S.a[o] = x; S.a[o + 1] = 0; S.a[o + 2] = 0; S.a[o + 3] = 1; S.a[o + 4] = b;
  S.n++;
  return true;
}
const drawCountFromCursor   = S => S.n;
const drawCountFromCapacity = S => S.a.length / 5;   // the defect, kept so the test can see it fail

// a frame stages some sprites, the next frame stages fewer — the exact ghost-light setup
function stageFrame(S, xs) { S.n = 0; for (const x of xs) push(S, x, 1); return S; }

{
  const S = mkPool();
  stageFrame(S, [10, 11, 12, 13, 14]);           // car A: five lamps
  stageFrame(S, [20, 21]);                       // car B: two
  ok(drawCountFromCursor(S) === 2, "draw count equals this frame's fill, not the last frame's");
  // the stale data is still in the buffer — that is fine and expected. The contract is only
  // that nothing reads it.
  ok(S.a[2 * 5] === 12, "stale tail genuinely survives in the pool (so the guard is load-bearing)");
  ok(drawCountFromCapacity(S) === CAP,
     "capacity-derived count would have drawn the tail — the regression this test pins");
}

{ // an empty frame must draw nothing: the early-out has to still be reachable
  const S = mkPool();
  stageFrame(S, [1, 2, 3]);
  stageFrame(S, []);
  ok(drawCountFromCursor(S) === 0, "a car with no lamps of a colour issues no draw at all");
}

{ // overflow is a cap, not a corruption
  const S = mkPool();
  const accepted = Array.from({ length: CAP + 4 }, (_, i) => push(S, i, 1)).filter(Boolean).length;
  ok(accepted === CAP, "the pool caps at capacity rather than writing out of range");
  ok(S.n === CAP, "cursor never exceeds capacity");
}

/* ---- 2. tie the mirror to the real source ---- */

/* Comments are stripped before any lexical assertion below. This test failed on its first
 * run for exactly the reason the codebase has now hit three separate times: a comment
 * EXPLAINING the bug contains the token that identifies the bug, and a regex cannot tell
 * using from mentioning. Stripping first is the only fix that scales. */
const decomment = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const batchGlow = uiFunction("batchGlow");
ok(batchGlow !== null, "batchGlow is findable in the ui source");
if (batchGlow) {
  const code = decomment(batchGlow);
  const drawLine = /gl\.drawArrays\(gl\.POINTS,\s*0,\s*([^)]+)\)/.exec(code);
  ok(drawLine !== null, "batchGlow issues a POINTS draw");
  // The property, stated as the property: the count handed to drawArrays must be the cursor.
  // Deriving it from the backing store's length is what made it a constant.
  ok(drawLine && !/\.length/.test(code.slice(0, code.indexOf("drawArrays"))),
     "batchGlow's draw count is never derived from the buffer's length");
}

ok(/const GLOW_CAP = \d+/.test(LIGHTFX), "GLOW_CAP is a named constant");
{ // the thruster pool must be sized FROM its particle counts, not from a repeated literal —
  // a duplicated 32/22 is a silent truncation waiting for someone to raise the count
  const decl = /const _thrArr = new Float32Array\(\(([^)]+)\) \* 5\)/.exec(LIGHTFX);
  ok(decl !== null, "the thruster pool declares its size from an expression");
  ok(decl && /THR_KC|THR_KG/.test(decl[1]), "thruster pool size references the particle-count constants");
  ok(/const KC = THR_KC, KG = THR_KG/.test(LIGHTFX), "drawThruster reads those same constants");
}

/* ---- 3. wheelSteerModel: the result cannot come from shared scratch ---- */

// The real function, evaluated — not a mirror. Two of its results are alive at once at the
// tyre/cage call sites, so pooling the RETURN value (the obvious next optimisation) would
// silently make the second call overwrite the first. Assert the property that forbids it.
{
  const math = require("./ui/mathutil.js");
  const src = uiFunction("wheelSteerModel");
  ok(src !== null, "wheelSteerModel is findable in the ui source");
  if (src) {
    const scratch = "const _wsRy=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);" +
                    "const _wsRx=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);" +
                    "const _wsR=new Float32Array(16);";
    const make = new Function("mMulInto", "mMul", scratch + src + "; return wheelSteerModel;")
                   (math.mMulInto, math.mMul);
    const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    const a = make(I, [0.7, 0.3, 1.2], 0.4, 0.1, 0.05);
    const b = make(I, [-0.7, 0.3, -1.2], -0.4, 0, 0);
    ok(a !== b, "each call returns its own matrix");
    // recompute the first one and compare: if the return were pooled, `a` would now hold b's
    const again = make(I, [0.7, 0.3, 1.2], 0.4, 0.1, 0.05);
    let same = true;
    for (let i = 0; i < 16; i++) if (Math.abs(a[i] - again[i]) > 1e-6) same = false;
    ok(same, "an earlier result survives a later call with different arguments");

    // and the scratch reuse is genuinely equivalent: identity-initialised arrays with only
    // some slots rewritten must give the same answer as building the literals fresh.
    const ref = (carMat, pivot, steer, roll, lift) => {
      const cy = Math.cos(steer), sy = Math.sin(steer);
      const cx = Math.cos(roll || 0), sx = Math.sin(roll || 0);
      const Ry = [cy,0,-sy,0, 0,1,0,0, sy,0,cy,0, 0,0,0,1];
      const Rx = [1,0,0,0, 0,cx,sx,0, 0,-sx,cx,0, 0,0,0,1];
      const R = math.mMul(Ry, Rx);
      const px = pivot[0], py = pivot[1], pz = pivot[2];
      R[12] = px - (R[0]*px + R[4]*py + R[8]*pz);
      R[13] = py - (R[1]*px + R[5]*py + R[9]*pz) + (lift || 0);
      R[14] = pz - (R[2]*px + R[6]*py + R[10]*pz);
      return math.mMul(carMat, R);
    };
    for (const [piv, st, rl, lf] of [[[0.7,0.3,1.2],0.4,0.1,0.05], [[-0.7,0.3,-1.2],-0.9,0,0],
                                     [[0,0,0],0,0,0], [[1,2,3],Math.PI/2,Math.PI/3,0.2]]) {
      const got = make(I, piv, st, rl, lf), want = ref(I, piv, st, rl, lf);
      let worst = 0;
      for (let i = 0; i < 16; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
      // f32 scratch rounds intermediates the old float64 Arrays did not; the tolerance is
      // that rounding, not a fudge factor — 2^-23 relative on values of order 1.
      ok(worst < 1e-6, `pooled scratch matches fresh literals for steer=${st} roll=${rl} (worst ${worst.toExponential(2)})`);
    }
  }
}

/* ---- 4. drawCarLights end to end, against a recording GL stub ----
 *
 * Added after `covgap.js` reported that this very test left `drawCarLights` MENTION-ONLY and
 * `headLampSides` UNCOVERED — it exercised `batchGlow` and discussed the rest in prose. The
 * function the incident was about was still not reached, and the changelog line claiming the
 * gap was closed was an over-claim. Trust the red.
 *
 * The real functions are evaluated here, not mirrored, with a fake `gl` that records draw
 * counts and the vertex data it was handed. That makes the ghost-lights property testable as
 * a PROPERTY rather than as a proxy: stage a car with many lamps, then one with few, and
 * assert the second frame never draws the first car's positions.
 */
{
  const math = require("./ui/mathutil.js");
  const names = ["pushGlow", "headLampSides", "drawCarLights", "batchGlow"];
  const srcs = names.map(uiFunction);
  names.forEach((n, i) => ok(srcs[i] !== null, `${n} is findable in the ui source`));

  if (srcs.every(Boolean)) {
    const preamble = `
      const GLOW_CAP = 256;
      const _glowWarm  = { a: new Float32Array(GLOW_CAP * 5), n: 0 };
      const _glowRed   = { a: new Float32Array(GLOW_CAP * 5), n: 0 };
      const _glowWhite = { a: new Float32Array(GLOW_CAP * 5), n: 0 };
      const _glowFwd = [0, 0, 0];
      const _lampL = [], _lampR = [], _lampSides = [_lampL, _lampR];
      let _lampSrc = null, _glowOverflowed = false;
      const progGlow = {}, glowBuf = {}, HDR_EMIT = 2.7;
      const glowLoc = { mvp: 0, pos: 1, size: 2, bright: 3, color: 4 };
    `;
    const build = new Function("gl", "cv", "camEye", "carLightsRef", `
      ${preamble}
      const carLights = carLightsRef;
      ${srcs.join("\n")}
      return { drawCarLights, headLampSides, pools: { _glowWarm, _glowRed, _glowWhite } };
    `);

    // a GL stub that records what each draw was actually given
    const draws = [];
    let uploaded = null;
    const gl = {
      ARRAY_BUFFER: 1, DYNAMIC_DRAW: 2, POINTS: 3, FLOAT: 4, BLEND: 5, ONE: 6,
      useProgram() {}, uniformMatrix4fv() {}, enable() {}, disable() {}, blendFunc() {},
      depthMask() {}, bindBuffer() {}, enableVertexAttribArray() {}, vertexAttribPointer() {},
      uniform3f() {}, bufferData(_t, src) { uploaded = src; },
      drawArrays(_m, _first, count) { draws.push({ count, data: uploaded.slice(0, count * 5) }); },
    };
    const cv = { height: 1080 };
    const camEye = () => [0, 2, 30];
    const IDENT = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    const lamps = n => Array.from({ length: n }, (_, i) => [i % 2 ? 0.6 : -0.6, 1 + i * 0.1, 2]);

    // headLampSides: the split and the ordering, on the real function
    {
      const api = build(gl, cv, camEye, { headLamps: [], tail: [], accentR: [], accentW: [] });
      const hl = [[0.6, 1.0, 2], [-0.6, 1.4, 2], [0.6, 1.4, 2], [-0.6, 1.0, 2]];
      const [L, R] = api.headLampSides(hl);
      ok(L.length === 2 && R.length === 2, "headLampSides splits lamps by sign of x");
      ok(L[0][1] > L[1][1] && R[0][1] > R[1][1], "each side is ordered top lamp first");
      const again = api.headLampSides(hl);
      ok(again[0] === L, "the identity cache returns the same arrays for the same source");
      const other = api.headLampSides([[0.6, 1.0, 2]]);
      ok(other[0].length === 1 && other[1].length === 0, "a different source rebuilds the split");
    }

    // THE GHOST-LIGHTS PROPERTY, end to end through the real drawCarLights
    {
      const car = { headLamps: lamps(6), tail: [[0, 1, -2], [0.4, 1, -2]], accentR: [], accentW: [] };
      const api = build(gl, cv, camEye, car);
      draws.length = 0;
      api.drawCarLights(IDENT, IDENT, Math.tan(0.5), 1, 0);
      const big = draws.map(d => d.count);
      const warmPositions = new Set();
      for (let i = 0; i < draws[0].count; i++) warmPositions.add(draws[0].data[i * 5 + 1].toFixed(3));
      ok(big[0] > 0, "a car with headlamps draws warm sprites");

      // now the SAME pools, a car with fewer lamps — the exact ghost-lights setup
      car.headLamps = lamps(2);
      car.tail = [[0, 1, -2]];
      draws.length = 0;
      api.drawCarLights(IDENT, IDENT, Math.tan(0.5), 1, 0);
      ok(draws[0].count < big[0], "a car with fewer lamps draws fewer sprites than the last one");
      // every position drawn this frame must belong to THIS frame's lamps
      let stale = 0;
      for (let i = 0; i < draws[0].count; i++) {
        const y = draws[0].data[i * 5 + 1];
        if (!car.headLamps.some(l => Math.abs(l[1] - y) < 1e-4)) stale++;
      }
      ok(stale === 0, "no sprite from the previous car survives into this frame's draw");
    }

    // a car with no accents of a colour must issue no draw for it at all
    {
      const api = build(gl, cv, camEye,
        { headLamps: lamps(2), tail: [[0, 1, -2]], accentR: [], accentW: [] });
      draws.length = 0;
      api.drawCarLights(IDENT, IDENT, Math.tan(0.5), 1, 0);
      ok(draws.length === 2, "only the colours with staged sprites are drawn (warm + red, no white)");
    }

    // the cap holds through the real path rather than only in the mirror above
    {
      const api = build(gl, cv, camEye,
        { headLamps: lamps(400), tail: [], accentR: [], accentW: [] });
      draws.length = 0;
      const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
      api.drawCarLights(IDENT, IDENT, Math.tan(0.5), 1, 0);
      console.warn = warn;
      ok(draws[0].count === 256, "the real path caps at GLOW_CAP rather than overrunning");
      ok(warned === 1, "overflow is announced exactly once, not silently and not every frame");
    }
  }
}

console.log(fails ? `test_glowpool: ${fails} FAILED` : "test_glowpool: all pass");
process.exit(fails ? 1 : 0);
