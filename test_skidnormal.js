/* test_skidnormal.js — the skid-mark ribbon uses the recorded surface normal, not world up.
 *
 * THE BUG THIS PINS. `buildTireMarkMesh`'s `upAt()` used to force the surface normal toward the
 * sky, on the stated grounds that the recorded sign was unreliable. It is not: extractCar builds
 * `nrm` from the wheel quad and resolves its winding once for the whole run, so the vector points
 * out of the road toward the car's roof and keeps doing that when the car is past vertical. Since
 * `contact = W - up*r`, forcing it skyward there put the contact patch a tyre DIAMETER on the far
 * side of the tarmac.
 *
 * HOW THE OLD BEHAVIOUR IS REPRODUCED HERE, because this matters more than the assertions. There
 * is no copy of the old `upAt` in this file. The old code is exactly the shipped function applied
 * to a run whose normals have been pre-flipped skyward — `upAt` reads nothing but `ex.nrm` and
 * normalising commutes with a sign flip — so `sky(ex)` transforms the INPUT and the function under
 * test stays the one that ships. A mirror of the function would drift from it and pass anyway;
 * that failure has already happened twice in this committee's tools and once in this repo's own
 * `test_lampglare.js` neighbourhood, so it is not a hypothetical.
 *
 * WHAT "ON THE SURFACE" MEANS WHEN THERE IS NO TRACK MODEL. The centrifuge replay has no kn5 in
 * the repo, so nothing here can query the real tarmac. Two witnesses stand in, and neither assumes
 * where the track is:
 *
 *   CONTINUITY — a surface normal cannot reverse inside one 15 ms frame. As recorded it turns at
 *   most 12.5°/frame; forced skyward it swings to 180° at the crossing. That is the measurement
 *   that says which sign is the physical one.
 *
 *   RIGIDITY — the contact patch is bolted to the wheel a radius away, so its path length must
 *   track the wheel centre's. Forcing the normal teleports the patch 0.66 m at each crossing and
 *   the ribbon's `run` coordinate accumulates travel the car never made.
 *
 * A measurement this file deliberately does NOT make, recorded because it looked convincing and is
 * worthless: dot(carPos - wheelCentroid, nrm), i.e. "the body is above the wheels, so that
 * resolves the sign". AC's car origin sits IN the wheel-centre plane — median -0.035 m on t180,
 * 5,323 of 7,728 frames negative — so that dot product is noise around zero and an assertion on it
 * would pass or fail by which sample it met first.
 *
 * Run: node test_skidnormal.js
 */
"use strict";
const fs = require("fs");
const { parseReplay, extractCar } = require("./ui/acreplay.js");
const { buildTireMarkMesh, computeWheelSlip } = require("./ui/carrender.js");
const env = require("./testenv.js");

let fails = 0;
function ok(cond, msg) { if (!cond) { console.log("  FAIL " + msg); fails++; } }

const V = 8;            // floats per vertex: pos3, frame, lap, intensity, cross, run
const QUAD = 6 * V;     // two triangles, emitted together, per frame pair per wheel
const RUN_FIELD = 7;
const FALLBACK_R = 0.33; // buildTireMarkMesh's per-wheel radius when no car model is loaded
const LIFT = 0.03;

function runFrom(file) {
  const b = fs.readFileSync(file);
  const ex = extractCar(parseReplay(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), 0);
  const sl = computeWheelSlip(ex);        // the mesh only exists where the tyre was sliding
  ex.slip = sl.slip; ex.smokeSlip = sl.smokeSlip;
  return ex;
}

/* The old behaviour, as an input transform rather than a second copy of the code. */
function sky(ex) {
  const n = new Float32Array(ex.nrm);
  for (let f = 0; f < ex.N; f++) if (n[f * 3 + 1] < 0) { n[f * 3] *= -1; n[f * 3 + 1] *= -1; n[f * 3 + 2] *= -1; }
  return Object.assign({}, ex, { nrm: n });
}

const unit = (ex, f) => {
  const x = ex.nrm[f * 3], y = ex.nrm[f * 3 + 1], z = ex.nrm[f * 3 + 2];
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};
const pastVertical = (ex, f) => ex.nrm[f * 3 + 1] < 0;

/* ---- 1. both samples carry past-vertical frames, and one of them is the reference lap ---- */

const T180 = runFrom(env.sampleReplay());
const CENT = runFrom(env.sampleReplayB());

function countPastVertical(ex) {
  let n = 0, tot = 0;
  for (let f = 0; f < ex.N; f++) if (ex.wheelsOk[f]) { tot++; if (pastVertical(ex, f)) n++; }
  return { n, tot };
}
{
  const c = countPastVertical(CENT);
  ok(c.n === 1313 && c.tot === 16577, `centrifuge: ${c.n} of ${c.tot} frames past vertical (expected 1313 of 16577)`);
  /* t180 is the replay every other test in this repo is tuned against, and it is NOT a clean
   * control for this bug — 0.74% of it is past vertical too. Asserted so that a future change
   * which "only affects the stunt sample" has to argue with a number. */
  const t = countPastVertical(T180);
  ok(t.n === 57 && t.tot === 7728, `t180: ${t.n} of ${t.tot} frames past vertical (expected 57 of 7728)`);
}

/* ---- 2. CONTINUITY: the recorded normal is a surface, the forced one is not ---- */

function maxTurn(ex, force) {
  let worst = 0, over20 = 0;
  for (let f = 0; f + 1 < ex.N; f++) {
    if (!ex.wheelsOk[f] || !ex.wheelsOk[f + 1] || ex.gap[f + 1]) continue;
    const a = unit(ex, f), b = unit(ex, f + 1);
    if (force) { if (a[1] < 0) { a[0] *= -1; a[1] *= -1; a[2] *= -1; } if (b[1] < 0) { b[0] *= -1; b[1] *= -1; b[2] *= -1; } }
    const d = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI;
    if (d > worst) worst = d;
    if (d > 20) over20++;
  }
  return { worst, over20 };
}
for (const [name, ex, cap] of [["t180", T180, 7], ["centrifuge", CENT, 13]]) {
  const real = maxTurn(ex, false), forced = maxTurn(ex, true);
  ok(real.worst < cap && real.over20 === 0,
    `${name}: as recorded the normal turns at most ${real.worst.toFixed(1)}° per 15 ms frame, never over 20°`);
  /* The negative control for the witness itself. If this ever stops failing, the forced version
   * has become indistinguishable from the real one and the argument above is empty. */
  ok(forced.worst > 170 && forced.over20 > 0,
    `${name}: forced skyward it swings ${forced.worst.toFixed(1)}° on ${forced.over20} frames — not a surface`);
}

/* ---- 3. THE POSITIVE WALL: the 1,313 banked frames, measured on the shipped geometry ---- */

/* Every quad, tagged with the frames it came from. The mesh is emitted in a fixed order —
 * vertices 0,1,3 belong to frame f and 2,4,5 to frame f+1 — so a quad's provenance is readable
 * straight out of the buffer rather than reconstructed. */
function quads(mesh) {
  const out = [];
  for (let o = 0; o + QUAD <= mesh.length; o += QUAD) out.push({ o, f0: mesh[o + 3], f1: mesh[o + 2 * V + 3] });
  return out;
}

/* A vertex belongs to ONE frame — 0,1,3 to the quad's near end and 2,4,5 to its far end — and it
 * is that frame's normal that placed it. Sorting by the vertex's own frame rather than by the
 * quad's is what separates the 0.66 m displacement from the seam, below. */
const NEAR = [0, 1, 3], FAR = [2, 4, 5];

for (const [name, ex, expectBoth, expectSeam] of [["t180", T180, 8, 2], ["centrifuge", CENT, 914, 40]]) {
  const now = buildTireMarkMesh(ex);
  const before = buildTireMarkMesh(sky(ex));
  ok(now.length === before.length,
    `${name}: the fix moves vertices, it does not add or drop them (${now.length / V} both ways)`);

  const dist = (v, o) => {
    const p = o + v * V;
    return Math.hypot(now[p] - before[p], now[p + 1] - before[p + 1], now[p + 2] - before[p + 2]);
  };
  let both = 0, seam = 0, flipped = 0, minD = Infinity, maxD = 0, worstSeam = 0;
  for (const q of quads(now)) {
    const d0 = pastVertical(ex, q.f0), d1 = pastVertical(ex, q.f1);
    if (!d0 && !d1) continue;
    if (d0 && d1) both++; else seam++;
    for (const v of NEAR.concat(FAR)) {
      const onFlipped = NEAR.includes(v) ? d0 : d1;
      const d = dist(v, q.o);
      if (onFlipped) { flipped++; if (d < minD) minD = d; if (d > maxD) maxD = d; }
      else if (d > worstSeam) worstSeam = d;
    }
  }
  ok(both === expectBoth && seam === expectSeam,
    `${name}: ${both} quads sit entirely past vertical and ${seam} straddle the crossing (expected ${expectBoth} and ${expectSeam})`);

  /* 0.662 m, derivable rather than observed: the contact patch swings 2r (0.660) along the
   * normal, the 0.03 lift reverses with it (-2*LIFT on the same axis, 0.600 net) and `right` =
   * up × travel reverses too, putting the ribbon's half-width on the other side (2*HALF = 0.280
   * across). hypot(0.600, 0.280) = 0.662. If this figure drifts, one of those three consequences
   * has changed and the sentence above it has gone stale. */
  const expect = Math.hypot(2 * (FALLBACK_R - LIFT), 2 * 0.14);
  ok(flipped === expectBoth * 6 + expectSeam * 3,
    `${name}: ${flipped} vertices were placed by a past-vertical frame`);
  ok(Math.abs(minD - expect) < 5e-3 && Math.abs(maxD - expect) < 5e-3,
    `${name}: every one of them moved by the same ${expect.toFixed(3)} m (measured ${minD.toFixed(3)}..${maxD.toFixed(3)})`);

  /* The seam, stated rather than swept in with the rest. A straddling quad's normal-up end also
   * moves, by up to 3 cm — not from its own normal but because the ribbon's width runs across the
   * travel direction toward its neighbour, and that neighbour's contact patch moved. It is a fifth
   * of the mark's own half-width and it is the honest edge of "normal-up frames are unchanged". */
  ok(worstSeam > 0 && worstSeam < 0.05,
    `${name}: the normal-up end of a straddling quad shifts at most ${worstSeam.toFixed(3)} m, from its neighbour's tangent`);
}

/* The contact patch itself, straight from the run data rather than through the ribbon. */
{
  let n = 0;
  for (let f = 0; f < CENT.N; f++) {
    if (!CENT.wheelsOk[f] || !pastVertical(CENT, f)) continue;
    const u = unit(CENT, f);
    for (let k = 0; k < 4; k++) {
      const a = f * 12 + k * 3;
      const W = [CENT.wheels[a], CENT.wheels[a + 1], CENT.wheels[a + 2]];
      const now = [W[0] - u[0] * FALLBACK_R, W[1] - u[1] * FALLBACK_R, W[2] - u[2] * FALLBACK_R];
      const before = [W[0] + u[0] * FALLBACK_R, W[1] + u[1] * FALLBACK_R, W[2] + u[2] * FALLBACK_R];
      // the fixed patch is a radius BELOW the wheel centre along the recorded normal...
      const below = (now[0] - W[0]) * u[0] + (now[1] - W[1]) * u[1] + (now[2] - W[2]) * u[2];
      // ...and the old one was a full diameter away from it, on the other side of the tarmac
      const gap = Math.hypot(now[0] - before[0], now[1] - before[1], now[2] - before[2]);
      if (Math.abs(below + FALLBACK_R) < 1e-6 && Math.abs(gap - 2 * FALLBACK_R) < 1e-6) n++;
    }
  }
  ok(n === 1313 * 4, `all ${1313 * 4} past-vertical contact patches sit one radius below the wheel, ${(2 * FALLBACK_R).toFixed(2)} m from where they were (${n} do)`);
}

/* ---- 4. THE NEGATIVE CONTROL: normal-up frames are bit-identical in geometry ---- */

for (const [name, ex, expectClean] of [["t180", T180, 15240], ["centrifuge", CENT, 28254]]) {
  const now = buildTireMarkMesh(ex);
  const before = buildTireMarkMesh(sky(ex));
  let clean = 0, identical = 0, runDiff = 0, worstRun = 0;
  for (const q of quads(now)) {
    if (pastVertical(ex, q.f0) || pastVertical(ex, q.f1)) continue;
    clean++;
    let same = true, runSame = true;
    for (let v = 0; v < 6; v++) {
      const p = q.o + v * V;
      for (let c = 0; c < V; c++) {
        if (now[p + c] === before[p + c]) continue;
        if (c === RUN_FIELD) { runSame = false; worstRun = Math.max(worstRun, Math.abs(now[p + c] - before[p + c])); }
        else same = false;
      }
    }
    if (same) identical++;
    if (!runSame) runDiff++;
  }
  ok(clean === expectClean, `${name}: ${clean} quads have both frames normal-up (expected ${expectClean})`);
  /* Position, frame, lap, intensity and cross — bit-identical, not merely close. A fix that
   * nudges flat-track marks is a regression wearing a repair's clothes. */
  ok(identical === clean, `${name}: all ${clean} are bit-identical in geometry (${identical} are)`);
  /* And the one field that DOES change on unflipped quads, stated rather than hidden, because it
   * is the difference between "unchanged" and "unchanged where it matters". `run` is metres along
   * the wheel's path, accumulated contact-to-contact across the whole stint — so every 0.66 m
   * teleport the old code made at a crossing was added to the tally and every later mark on that
   * wheel inherited it. The grain phase shifts downstream of a past-vertical section; the marks
   * do not move. Correcting the arc length is the same repair, not a second change. */
  ok(runDiff > 0 && worstRun > 0.5,
    `${name}: and ${runDiff} of them carry a corrected grain coordinate, up to ${worstRun.toFixed(2)} m of travel the car never made`);
}

/* ---- 5. the shortcut is gone from the shipped source, and its neighbour never had it ---- */
{
  const src = env.uiFunction("buildTireMarkMesh");
  ok(src !== null, "buildTireMarkMesh is present in the shipped UI source");
  /* Belt to the braces above: the measurements would catch a reinstated flip anywhere in the
   * function, but this catches it in a form that reads as innocent — a clamp, a Math.abs, an
   * `uy = Math.max(0, uy)` — without needing to guess which shape it takes. */
  ok(src && !/uy\s*<\s*0/.test(src) && !/Math\.abs\(\s*uy/.test(src),
    "and it no longer forces the normal's sign from world up");
  /* carModelMatrix poses the car body from the same normal without flipping it. That agreement is
   * the reason the fix is a fix and not a preference: before it, the marks and the car laying them
   * disagreed about which way was up on 1,313 frames. */
  const body = env.uiFunction("carModelMatrix");
  ok(body && !/uy\s*<\s*0/.test(body), "carModelMatrix reads the same normal unflipped — body and marks agree");
}

console.log(fails ? `test_skidnormal: ${fails} FAILED` : "test_skidnormal: all pass");
process.exit(fails ? 1 : 0);
