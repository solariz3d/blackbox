/* test_orthofrustum.js — frustumPlanes against an ORTHO light matrix.
 *
 * The shadow cascades are orthographic, and frustum culling was added to them tonight while
 * the only tests covered a PERSPECTIVE matrix. If the plane extraction is wrong for ortho,
 * the far cascade draws nothing, its depth map comes back empty, every sample reports "no
 * occluder", and the whole track outside the near box renders fully lit — which is exactly
 * what centrifuge is doing.
 *
 * Run: node test_orthofrustum.js
 */
"use strict";
const M = require("./ui/mathutil.js");

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok " : "FAIL"} - ${m}`); if (!c) fails++; };

/* Rebuild what buildLightVP does for the FAR cascade: no `reach`, so back = R*1.8 and
 * depth = R*4, looking down-sun at the track centre. Numbers from centrifuge:
 * trackAABB.radius 1352 -> R = 1472. */
const R = 1472;
const c = [0, 0, 0];
const d = M.v3nrm([0.3, 0.9, 0.2]);              // direction TO the sun, roughly overhead
const back = Math.max(0, R * 1.8);
const depth = back + Math.max(0, R * 2.2);
const eye = [c[0] + d[0] * back, c[1] + d[1] * back, c[2] + d[2] * back];
const up = Math.abs(d[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0];
const vp = M.mMul(M.mOrtho(-R, R, -R, R, 1, depth), M.mLookAt(eye, c, up));
const planes = M.frustumPlanes(vp);

console.log("ortho light frustum (far cascade shape)");
ok(planes.length === 6, "six planes");
ok(planes.every(p => p.every(Number.isFinite)), "no NaN/Infinity in any plane");

// the track centre is the thing the box is built around — if this fails, nothing draws
ok(M.sphereInFrustum(planes, c, 1), "the track centre is inside the box");
ok(M.sphereInFrustum(planes, [0, 0, 0], 0), "a zero-radius point at the centre is inside");

// a dome high above the centre must be inside — it is the caster that matters
ok(M.sphereInFrustum(planes, [0, 300, 0], 50), "a dome 300 m above the centre is inside");

// points across the track, well within R
for (const p of [[500, 0, 500], [-900, 20, 300], [0, 5, -1200]]) {
  ok(M.sphereInFrustum(planes, p, 10), `a chunk at ${p.join(",")} is inside`);
}

// and something genuinely outside, so the test can fail in the other direction too
ok(!M.sphereInFrustum(planes, [R * 6, 0, 0], 10), "a point far outside the box is rejected");

/* THE REAL CASE. A chunk is a sphere, and the ones that matter here are huge: centrifuge's
 * largest is 1334 m of radius against a 1352 m track. A test that rejects those rejects the
 * dome. */
ok(M.sphereInFrustum(planes, [0, 0, 0], 1334), "centrifuge's largest chunk (r=1334) is inside");
ok(M.sphereInFrustum(planes, [0, 100, 0], 378), "a median chunk (r=378) is inside");

// The NEAR cascade: small box, carries an explicit reach.
{
  const nR = 60, reach = 600;
  const nback = Math.max(reach, nR * 1.8);
  const ndepth = nback + Math.max(reach, nR * 2.2);
  const neye = [d[0] * nback, d[1] * nback, d[2] * nback];
  const nvp = M.mMul(M.mOrtho(-nR, nR, -nR, nR, 1, ndepth), M.mLookAt(neye, [0, 0, 0], up));
  const np = M.frustumPlanes(nvp);
  console.log("\nnear cascade (tight box, 600 m reach)");
  ok(M.sphereInFrustum(np, [0, 0, 0], 1), "the car's own position is inside");
  /* UP-SUN means along the light direction, not straight up. `reach` lengthens the box
   * along the light axis; it does not widen it. A caster 300 m vertically above the car is
   * 111 m off-axis when the sun is 21 deg from vertical, so a 60 m box rejects it — and
   * that is correct, not a bug. This assertion asserted the wrong thing first time. */
  const upSun = [d[0] * 300, d[1] * 300, d[2] * 300];
  ok(M.sphereInFrustum(np, upSun, 20), "a caster 300 m along the light axis is inside (what reach is for)");
  ok(!M.sphereInFrustum(np, [0, 300, 0], 20), "a caster 300 m VERTICALLY up is off-axis and rejected");
  ok(!M.sphereInFrustum(np, [2000, 0, 0], 5), "a chunk 2 km sideways is rejected");
  ok(M.sphereInFrustum(np, [0, 0, 0], 1334), "a track-sized chunk still overlaps the small box");
}

console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exit(fails ? 1 : 0);
