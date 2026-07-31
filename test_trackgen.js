/* test_trackgen.js — the stand-in track surface built from replay wheel data.
 *
 * The generator's whole claim is that the emitted vertices are ON THE ROAD: wheel centres
 * dropped by the tyre radius along the recorded surface normal. Every assertion here is
 * against that claim rather than against the shape of the output, because the shape is
 * plausible-looking whether or not the drop happened at all — a mesh made from the raw wheel
 * centres renders fine and is a foot in the air, and nothing on screen says so.
 *
 * Two of these exist because of a specific way this could go wrong quietly:
 *
 *   - the WINDING assertion, because the first triangle order written here was inverted on
 *     12,974 of 13,042 triangles and nothing in the app would have shown it (no back-face
 *     culling; lighting reads the vertex normal, not the face);
 *   - the PAST-VERTICAL assertion, because the neighbouring buildTireMarkMesh forces the
 *     surface normal skyward, and copying that here would put the surface a tyre diameter on
 *     the wrong side for the 7.92% of centrifuge frames the car drives past vertical. That is
 *     the negative control for a shortcut that was sitting right there.
 *
 * Run: node test_trackgen.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { parseReplay, extractCar } = require("./ui/acreplay.js");
const TrackGen = require("./ui/trackgen.js");
const env = require("./testenv.js");

let fails = 0;
function ok(cond, msg) { if (!cond) { console.log("  FAIL " + msg); fails++; } }
const pct = (a, f) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };

function runFrom(file) {
  const b = fs.readFileSync(file);
  return extractCar(parseReplay(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), 0);
}

/* A synthetic run, so the boundary cases have a fixture that is not 20 MB of driving. Only
 * the fields trackgen reads are populated; anything else it starts reading will throw here,
 * which is the intended failure. */
function synthRun(frames) {
  const N = frames.length;
  const r = { N, dt: 0.015, wheels: new Float32Array(N * 12), wheelsOk: new Uint8Array(N),
              nrm: new Float32Array(N * 3), gap: new Uint8Array(N), odo: new Float64Array(N),
              pos: new Float64Array(N * 3) };
  for (let i = 0; i < N; i++) {
    const f = frames[i];
    const [x, y, z] = f.p;
    r.pos[i * 3] = x; r.pos[i * 3 + 1] = y; r.pos[i * 3 + 2] = z;
    r.wheelsOk[i] = f.ok === undefined ? 1 : f.ok;
    r.gap[i] = f.gap ? 1 : 0;
    r.odo[i] = f.odo;
    const n = f.n || [0, 1, 0];
    r.nrm[i * 3] = n[0]; r.nrm[i * 3 + 1] = n[1]; r.nrm[i * 3 + 2] = n[2];
    // a 1.8 m axle across world X, wheel centres a radius above the surface along +n
    const half = 0.9, R = f.R === undefined ? 0.33 : f.R;
    const w = [[x - half, y, z + 1], [x + half, y, z + 1], [x - half, y, z - 1], [x + half, y, z - 1]];
    for (let k = 0; k < 4; k++) {
      r.wheels[i * 12 + k * 3] = w[k][0] + n[0] * R;
      r.wheels[i * 12 + k * 3 + 1] = w[k][1] + n[1] * R;
      r.wheels[i * 12 + k * 3 + 2] = w[k][2] + n[2] * R;
    }
  }
  return r;
}

const straight = (n, step, extra) => synthRun(Array.from({ length: n }, (_, i) =>
  Object.assign({ p: [0, 0, i * step], odo: i * step }, (extra && extra(i)) || {})));

/* ---- 1. the mesh is structurally sound ---- */
{
  const m = TrackGen.buildTrackMesh(straight(50, 2));
  ok(m.pos.length > 0 && m.idx.length > 0, "a straight run produces geometry");
  ok(m.pos.length === m.nrm.length, "one normal per vertex");
  ok(m.pos.length / 3 === m.uv.length / 2, "one uv per vertex");
  ok(m.idx.length % 3 === 0, "indices are whole triangles");
  ok(m.triCount === m.idx.length / 3, "triCount agrees with the index buffer");
  let maxIdx = 0;
  for (const v of m.idx) if (v > maxIdx) maxIdx = v;
  ok(maxIdx < m.pos.length / 3, `every index is in range (max ${maxIdx}, ${m.pos.length / 3} vertices)`);
  ok(m.radius > 0 && isFinite(m.centre[0]), "bounds are finite, for the frustum cull");
}

/* ---- 2. THE CLAIM: vertices sit on the road, a tyre radius below the wheel centres ---- */
{
  const R = 0.31;
  // the synthetic wheels sit exactly R above y=0 along +n, so a correct drop lands every
  // vertex on y=0 — and dropping by the WRONG radius misses by exactly the difference, which
  // is asserted too so that "it landed somewhere" cannot pass for "it landed on the road"
  const m = TrackGen.buildTrackMesh(straight(20, 2, () => ({ R })), { wheelR: R });
  let worst = 0;
  for (let v = 0; v < m.pos.length; v += 3) worst = Math.max(worst, Math.abs(m.pos[v + 1]));
  ok(worst < 1e-5, `the drop lands on the surface, not the wheel centre (worst |y| ${worst.toExponential(1)})`);
  const off = TrackGen.buildTrackMesh(straight(20, 2, () => ({ R })), { wheelR: R + 0.05 });
  let worstOff = 0;
  for (let v = 0; v < off.pos.length; v += 3) worstOff = Math.max(worstOff, Math.abs(off.pos[v + 1] + 0.05));
  ok(worstOff < 1e-5, "a 5 cm radius error moves the surface by exactly 5 cm — a rigid offset, not a deformation");

  // and on real driving, against the recorded data rather than a fixture
  const ex = runFrom(env.sampleReplay());
  const c = TrackGen.trackCorridor(ex, { wheelR: 0.33 });
  let checked = 0, offBy = [];
  for (const strip of c.strips) for (const s of strip) {
    const b = s.frame * 12, W = ex.wheels;
    const mid = [(W[b] + W[b + 6]) / 2, (W[b + 1] + W[b + 7]) / 2, (W[b + 2] + W[b + 8]) / 2];
    const d = Math.hypot(mid[0] - s.l[0], mid[1] - s.l[1], mid[2] - s.l[2]);
    // the offset must be the radius, and must be ALONG the recorded normal
    const dot = ((mid[0] - s.l[0]) * s.n[0] + (mid[1] - s.l[1]) * s.n[1] + (mid[2] - s.l[2]) * s.n[2]);
    offBy.push(Math.abs(d - 0.33) + Math.abs(dot - 0.33));
    checked++;
  }
  ok(checked > 1000, `checked the drop on ${checked} real cross-sections`);
  ok(Math.max(...offBy) < 1e-4, `every real vertex is exactly a radius along -nrm (worst ${Math.max(...offBy).toExponential(1)})`);
}

/* ---- 2b. per-corner radii, because each ribbon edge mixes a front wheel with a rear ---- *
 * A car with 245s on the front and 305s on the rear has genuinely different radii, and the
 * left edge of this ribbon is the midpoint of FL and RL. A single radius would put that edge
 * half the difference off the road. */
{
  ok(Math.abs(TrackGen.trackEdgeRadii(0.4)[0] - 0.4) < 1e-9, "a single radius applies to both edges");
  const [l, r] = TrackGen.trackEdgeRadii([0.30, 0.32, 0.36, 0.38]);   // FL, FR, RL, RR
  ok(Math.abs(l - 0.33) < 1e-9, `the left edge averages FL and RL (got ${l})`);
  ok(Math.abs(r - 0.35) < 1e-9, `the right edge averages FR and RR (got ${r})`);
  for (const bad of [undefined, null, 0, -1, NaN, "0.33"]) {
    ok(TrackGen.trackEdgeRadii(bad)[0] === TrackGen.TRACK_WHEEL_R,
       `a missing or nonsense radius (${String(bad)}) falls back to the stated default, never to zero`);
  }
  // and it reaches the geometry: mismatched radii tilt the section rather than translating it
  const run = straight(6, 2, () => ({ R: 0.33 }));
  const even = TrackGen.trackCorridor(run, { wheelR: 0.33 }).strips[0][0];
  const tilted = TrackGen.trackCorridor(run, { wheelR: [0.33, 0.43, 0.33, 0.43] }).strips[0][0];
  ok(Math.abs(tilted.l[1] - even.l[1]) < 1e-9, "the unchanged side of the axle does not move");
  ok(Math.abs(tilted.r[1] - (even.r[1] - 0.1)) < 1e-9, "and the 10 cm-bigger side drops 10 cm further");
}

/* ---- 3. the ribbon faces the way the road was driven ---- */
{
  for (const [label, file] of [["t180", env.sampleReplay()], ["centrifuge", env.sampleReplayB()]]) {
    const m = TrackGen.buildTrackMesh(runFrom(file));
    let agree = 0, total = 0;
    for (let t = 0; t < m.idx.length; t += 3) {
      const i0 = m.idx[t], i1 = m.idx[t + 1], i2 = m.idx[t + 2];
      const g = (i) => [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]];
      const A = g(i0), B = g(i1), C = g(i2);
      const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const nl = Math.hypot(n[0], n[1], n[2]);
      if (nl < 1e-9) continue;
      total++;
      if ((n[0] * m.nrm[i0 * 3] + n[1] * m.nrm[i0 * 3 + 1] + n[2] * m.nrm[i0 * 3 + 2]) / nl > 0) agree++;
    }
    /* Not 100%, and the residue is real rather than slop: where the car is sliding sideways
     * the strip advances ALONG its own axle, so the quad is sheared to a sliver and its face
     * orientation is ill-conditioned. t180 has 68 such frames of 6,853 — a 260 km/h slide
     * where the nose is 90° off the direction of travel. The vertices are still real road
     * points and the vertex normals are still the recorded ones, so nothing renders wrong;
     * only the face orientation is undefined there. A rule that demanded 100% would be
     * asserting the car never slides. */
    ok(total > 1000, `${label}: ${total} non-degenerate triangles to orient`);
    ok(agree / total > 0.99, `${label}: ${(100 * agree / total).toFixed(2)}% of faces point out of the road`);
  }
}

/* ---- 4. a teleport breaks the ribbon rather than bridging it ---- */
{
  // 40 frames, then a jump of 500 m flagged as a gap, then 40 more
  const frames = [];
  for (let i = 0; i < 40; i++) frames.push({ p: [0, 0, i * 2], odo: i * 2 });
  frames.push({ p: [0, 0, 580], odo: 78, gap: 1 });
  for (let i = 0; i < 40; i++) frames.push({ p: [0, 0, 580 + i * 2], odo: 78 + i * 2 });
  const run = synthRun(frames);
  const c = TrackGen.trackCorridor(run, {});
  ok(c.strips.length === 2, `a teleport splits the corridor into two strips (got ${c.strips.length})`);
  const m = TrackGen.buildTrackMesh(run);
  let longest = 0;
  for (let t = 0; t < m.idx.length; t += 3) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const i = m.idx[t + a], j = m.idx[t + b];
      longest = Math.max(longest, Math.hypot(m.pos[i * 3] - m.pos[j * 3], m.pos[i * 3 + 1] - m.pos[j * 3 + 1], m.pos[i * 3 + 2] - m.pos[j * 3 + 2]));
    }
  }
  ok(longest < 10, `no triangle bridges the 500 m jump (longest edge ${longest.toFixed(2)} m)`);
  // and the real replay's own teleports are honoured
  const ex = runFrom(env.sampleReplay());
  const cr = TrackGen.trackCorridor(ex, {});
  for (const strip of cr.strips) for (let k = 1; k < strip.length; k++) {
    for (let f = strip[k - 1].frame + 1; f <= strip[k].frame; f++) {
      if (ex.gap[f]) { ok(false, `a strip spans gap frame ${f}`); break; }
    }
  }
}

/* ---- 5. resampling by distance: a stopped car does not emit a stack of coincident strips ---- */
{
  // 200 frames sitting still, then 40 moving
  const frames = [];
  for (let i = 0; i < 200; i++) frames.push({ p: [0, 0, 0], odo: 0 });
  for (let i = 1; i <= 40; i++) frames.push({ p: [0, 0, i * 2], odo: i * 2 });
  const c = TrackGen.trackCorridor(synthRun(frames), { stepM: 1 });
  ok(c.strips.length === 1, "standing still does not break the strip");
  ok(c.strips[0].length === 41, `200 stationary frames collapse to one section (got ${c.strips[0].length} of 241)`);
  ok(c.skipped.tooClose === 199, `and the other 199 are reported as skipped, not silently dropped (got ${c.skipped.tooClose})`);

  // on real driving every emitted pair is at least the step apart
  const ex = runFrom(env.sampleReplay());
  const real = TrackGen.trackCorridor(ex, { stepM: 1.0 });
  let minGap = Infinity;
  for (const strip of real.strips) for (let k = 1; k < strip.length; k++) minGap = Math.min(minGap, strip[k].odo - strip[k - 1].odo);
  ok(minGap >= 1.0 - 1e-9, `real sections are never closer than the step (min ${minGap.toFixed(4)} m)`);
}

/* ---- 6. NEGATIVE CONTROL: banking past vertical is kept, not forced skyward ---- */
{
  const ex = runFrom(env.sampleReplayB());   // centrifuge — sustained banking past vertical
  const c = TrackGen.trackCorridor(ex, { wheelR: 0.33 });
  let inverted = 0, wrongSide = 0;
  for (const strip of c.strips) for (const s of strip) {
    if (s.n[1] >= 0) continue;
    inverted++;
    // past vertical the road is ABOVE the wheel centre in world y — a skyward-forced normal
    // would put it below, which is the failure this exists to catch
    const b = s.frame * 12, W = ex.wheels;
    const midY = (W[b + 1] + W[b + 7]) / 2;
    if (s.l[1] <= midY) wrongSide++;
  }
  ok(inverted > 100, `centrifuge drives past vertical (${inverted} inverted sections)`);
  ok(wrongSide === 0, `every inverted section puts the road on the recorded side (${wrongSide} wrong)`);

  // a fixture where the answer is unambiguous: an upside-down surface
  const up = synthRun([{ p: [0, 10, 0], odo: 0, n: [0, -1, 0] }, { p: [0, 10, 2], odo: 2, n: [0, -1, 0] },
                       { p: [0, 10, 4], odo: 4, n: [0, -1, 0] }]);
  const m = TrackGen.buildTrackMesh(up, { wheelR: 0.33 });
  let above = 0;
  for (let v = 0; v < m.pos.length; v += 3) if (m.pos[v + 1] > 10) above++;
  ok(above === 0 && m.pos.length > 0, "an inverted surface drops along its own normal, not toward the ground");
}

/* ---- 7. normals are the RECORDED ones, not a defaulted world-up ---- *
 * A normal array wired to (0,1,0) passes "is it unit" and "is it non-empty" and produces a
 * mesh that looks right on a flat track. So this asserts the DISTRIBUTION instead: on
 * centrifuge the recorded normals have a median tilt of 54.5° from world up, and no default
 * can produce that. The threshold is far under the measurement so it detects a disconnected
 * field rather than tracking the track's banking. */
{
  const m = TrackGen.buildTrackMesh(runFrom(env.sampleReplayB()));
  const tilts = [];
  let notUnit = 0;
  for (let v = 0; v < m.nrm.length; v += 3) {
    const l = Math.hypot(m.nrm[v], m.nrm[v + 1], m.nrm[v + 2]);
    if (Math.abs(l - 1) > 1e-4) notUnit++;
    tilts.push(Math.acos(Math.max(-1, Math.min(1, m.nrm[v + 1] / (l || 1)))) * 180 / Math.PI);
  }
  ok(notUnit === 0, `every normal is unit length (${notUnit} were not)`);
  const median = pct(tilts, 0.5);
  ok(median > 20, `centrifuge's normals carry its real banking, median ${median.toFixed(1)}° from world up (a default would read 0)`);
}

/* ---- 8. several runs union into one surface — the spec's "use every lap" lever ---- */
{
  const a = runFrom(env.sampleReplay()), b = runFrom(env.sampleReplayB());
  const ma = TrackGen.buildTrackMesh(a), mb = TrackGen.buildTrackMesh(b);
  const both = TrackGen.buildTrackMesh([a, b]);
  ok(both.sections === ma.sections + mb.sections, `the union carries both corridors (${both.sections} = ${ma.sections} + ${mb.sections})`);
  ok(both.triCount === ma.triCount + mb.triCount, "and both triangle sets");
  /* The two samples are different circuits whose world coordinates overlap, so the union's
   * bounding sphere need not be LARGER than the bigger of the two — only never smaller, and
   * it must contain both centres. Asserting growth here would be asserting a fact about
   * where two unrelated tracks happen to sit in AC's world space. */
  ok(both.radius >= Math.max(ma.radius, mb.radius) - 1e-6, "and its bounds are no smaller than either");
  for (const one of [ma, mb]) {
    const d = Math.hypot(one.centre[0] - both.centre[0], one.centre[1] - both.centre[1], one.centre[2] - both.centre[2]);
    ok(d + one.radius <= both.radius + 1e-3, "and enclose each corridor it was built from");
  }
}

/* ---- 9. widening is symmetric about the driven line and leaves it where it was ---- */
{
  const run = straight(20, 2);
  const plain = TrackGen.trackCorridor(run, {});
  const wide = TrackGen.trackCorridor(run, { widen: 3 });
  const w0 = (s) => Math.hypot(s.r[0] - s.l[0], s.r[1] - s.l[1], s.r[2] - s.l[2]);
  ok(Math.abs(w0(plain.strips[0][0]) - 1.8) < 1e-4, `the bare corridor is the car's 1.8 m track width (got ${w0(plain.strips[0][0]).toFixed(3)})`);
  ok(Math.abs(w0(wide.strips[0][0]) - 7.8) < 1e-4, `widen 3 adds 3 m to each side (got ${w0(wide.strips[0][0]).toFixed(3)})`);
  const cp = plain.strips[0][0], cw = wide.strips[0][0];
  const mid = (s) => [(s.l[0] + s.r[0]) / 2, (s.l[1] + s.r[1]) / 2, (s.l[2] + s.r[2]) / 2];
  const [ax, ay, az] = mid(cp), [bx, by, bz] = mid(cw);
  ok(Math.hypot(ax - bx, ay - by, az - bz) < 1e-4, "and the driven line stays where it was driven");
}

/* ---- 10. the widening evidence: separate passes ARE at the same place ---- */
{
  const s = TrackGen.measureLineSpread(runFrom(env.sampleReplay()));
  ok(s.pairs > 100, `found ${s.pairs} heading-matched pairs from separate passes`);
  /* The validity check, and it is the reason this number is worth anything: if these were
   * two points a car length apart on the SAME line rather than the same place on two lines,
   * the along-travel offset would be the larger one. It is not, by 5x. */
  ok(s.alongP50 < s.lateralP50, `pairs are side by side, not nose to tail (along ${s.alongP50.toFixed(2)} m vs lateral ${s.lateralP50.toFixed(2)} m)`);
  ok(s.lateralP50 > 1.0, `and separate passes use lines more than a car width apart (median ${s.lateralP50.toFixed(2)} m)`);
}

/* ---- 11. an empty or unusable run yields an empty mesh, not a crash ---- */
{
  const dead = synthRun(Array.from({ length: 10 }, (_, i) => ({ p: [0, 0, i], odo: i, ok: 0 })));
  const m = TrackGen.buildTrackMesh(dead);
  ok(m.triCount === 0 && m.pos.length === 0, "a run with no valid wheel quad produces nothing");
  ok(m.radius === 0, "and reports no bounds rather than NaN");
  const none = TrackGen.buildTrackMesh([]);
  ok(none.triCount === 0, "no runs at all is empty, not a throw");
  const junk = TrackGen.buildTrackMesh([null, undefined, {}]);
  ok(junk.triCount === 0, "and a malformed run is skipped rather than throwing");
}

console.log(fails ? `test_trackgen: ${fails} FAILED` : "test_trackgen: all pass");
process.exit(fails ? 1 : 0);
