/* test_steeranim.js — authored steering animation (steer.ksanim) on REAL assets.
 *
 * Loads the actual T-180 wheel + shared AC driver + this car's seated pose and
 * steer animation, and proves on the SAME code the viewer runs:
 *   1. PARSER REGRESSION: ksanim v2 keyframes are rotation-first (quat x,y,z,w),
 *      then position, then scale — every track's quats must be unit-norm (the old
 *      position-first read produced garbage quats; this catches any reversion)
 *   2. the hierarchy composition is correct: composing the seated pose's LOCALS
 *      with no anim override reproduces the pose's authored WORLD hand positions
 *   3. sampled anim locals are convention-correct: an unmoving torso bone's local
 *      at anim centre equals the knh's local for it, element for element
 *   4. at anim centre the composed hand lands on the knh's authored hand (≈ 10 mm)
 *   5. THIS car's anim is degenerate — the hand sweeps only ~3 cm lock-to-lock,
 *      too small to express a turning wheel — so driverAnimInit refuses it and
 *      the viewer falls back to the IK/snap path (documented discovery)
 *   6. steerRefCalib recovers a synthetic run's constant slip-steer (pure part)
 *
 * Needs the AC install on G: (same as test_carscene). Run: node test_steeranim.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const KN5 = require("./ui/kn5.js");
const MU = require("./ui/mathutil.js");
Object.assign(global, MU);

const { driverAnimInit, driverAnimWorlds, ksanimLocal, steerRefCalib, palmGrip, snapToMesh } = require("./ui/carrender.js");

// resolve the AC install the way find_car does: every Steam library in
// libraryfolders.vdf, first one that actually contains assettocorsa. Skips (not
// fails) on machines without an AC install — this suite needs the real assets.
function findAC() {
  const roots = [];
  for (const steam of ["C:/Program Files (x86)/Steam", "C:/Program Files/Steam"]) {
    const vdf = path.join(steam, "steamapps", "libraryfolders.vdf");
    if (!fs.existsSync(vdf)) continue;
    roots.push(steam);
    for (const m of fs.readFileSync(vdf, "utf8").matchAll(/"path"\s+"([^"]+)"/g))
      roots.push(m[1].replace(/\\\\/g, "/"));
  }
  roots.push("G:/SteamLibrary");   // last-resort hardcode (the desktop's library)
  for (const r of roots) {
    const ac = path.join(r, "steamapps", "common", "assettocorsa", "content");
    if (fs.existsSync(ac)) return ac;
  }
  return null;
}
const AC = findAC();
if (!AC) { console.log("no Assetto Corsa install found in any Steam library — skipping (real-asset suite)"); process.exit(0); }
const CAR_DIR = path.join(AC, "cars", "ohyeah2389_t180_mach6");
const DRIVER_KN5 = path.join(AC, "driver", "driver.kn5");

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log("  ok  - " + msg);
  } else {
    console.log("  FAIL- " + msg);
    failures++;
  }
}

function readAB(p) { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }

// ---- real assets ----
const kn5s = fs.readdirSync(CAR_DIR).filter(f => f.toLowerCase().endsWith(".kn5"))
  .map(f => ({ f, s: fs.statSync(path.join(CAR_DIR, f)).size })).sort((a, b) => b.s - a.s);
const scene = KN5.extractScene(readAB(path.join(CAR_DIR, kn5s[0].f)));
const sw = scene.steerWheel;
const wheelC = sw.pivot, wheelAxis = v3nrm(sw.ax[2]);

const dscene = KN5.parseDriver(readAB(DRIVER_KN5));
const skel = { parent: dscene.nodes.map(n => n.parent), localBind: dscene.nodes.map(n => n.local),
               bindWorld: dscene.nodes.map(n => n.world), name: dscene.nodes.map(n => n.name),
               nameIndex: dscene.nameIndex, count: dscene.nodes.length };
const parsedPose = KN5.parseDriverPose(readAB(path.join(CAR_DIR, "driver_base_pos.knh")));
const poseWorld = parsedPose.world, poseLocal = parsedPose.local;
const anim = KN5.parseKsanim(readAB(path.join(CAR_DIR, "animations", "steer.ksanim")));

// ---- 1. parser regression: rotation-first keyframes → unit quats everywhere ----
{
  let worst = 0;
  for (const nd of anim.nodes) for (let f = 0; f < anim.frameCount; f++)
    worst = Math.max(worst, Math.abs(Math.hypot(nd.q[f*4], nd.q[f*4+1], nd.q[f*4+2], nd.q[f*4+3]) - 1));
  check(worst < 0.01, `every ksanim quat is unit-norm (worst |q|-1 = ${worst.toFixed(4)}) — keyframes are rotation-first`);
}

// shared rig: anim tracks bound to skeleton + seated-pose locals
const byName = new Map(); for (const nd of anim.nodes) byName.set(nd.name, nd);
const track = new Array(skel.count).fill(null);
for (let i = 0; i < skel.count; i++) { const nd = byName.get(skel.name[i]); if (nd) track[i] = nd; }
const L0 = new Array(skel.count);
for (let i = 0; i < skel.count; i++) L0[i] = (poseLocal && poseLocal[skel.name[i]]) || skel.localBind[i];

// ---- 2. composition: L0-only chain reproduces the seated pose ----
{
  const st0 = { anim, track: new Array(skel.count).fill(null), L0, skel };
  const world = driverAnimWorlds(st0, 0.5);
  let worst = 0;
  for (const nm of ["DRIVER:RIG_HAND_L", "DRIVER:RIG_HAND_R", "DRIVER:RIG_Arm_L", "DRIVER:RIG_Head"]) {
    const i = skel.nameIndex[nm], P = poseWorld[nm];
    if (i == null || !P) continue;
    const M = world[i];
    worst = Math.max(worst, Math.hypot(M[12]-P[12], M[13]-P[13], M[14]-P[14]));
  }
  check(worst < 0.005, `local-chain composition reproduces the seated pose (worst ${(worst * 1000).toFixed(2)} mm)`);
}

// ---- 3. sampled anim local == knh local for an unmoving torso bone ----
{
  const knhL = poseLocal["DRIVER:RIG_Cest"];
  const animL = ksanimLocal(byName.get("DRIVER:RIG_Cest"), (anim.frameCount - 1) / 2);
  let worst = 0;
  for (let k = 0; k < 16; k++) worst = Math.max(worst, Math.abs(knhL[k] - animL[k]));
  check(worst < 0.005, `anim-centre local matches the knh local element-for-element (worst ${worst.toFixed(4)})`);
}

// ---- 4. composed hand at anim centre lands on the authored hand ----
{
  const st = { anim, track, L0, skel };
  const world = driverAnimWorlds(st, 0.5);
  const hi = skel.name.findIndex(n => /RIG_HAND_L$/.test(n));
  const M = world[hi], P = poseWorld["DRIVER:RIG_HAND_L"];
  const d = Math.hypot(M[12]-P[12], M[13]-P[13], M[14]-P[14]);
  check(d < 0.015, `anim-centre hand sits on the knh's authored hand (${(d * 1000).toFixed(1)} mm off)`);

  // ---- 5. THIS anim is degenerate: tiny hand sweep → init refuses, IK takes over ----
  const w0 = driverAnimWorlds(st, 0), w1 = driverAnimWorlds(st, 1);
  const sweep = Math.hypot(w1[hi][12]-w0[hi][12], w1[hi][13]-w0[hi][13], w1[hi][14]-w0[hi][14]);
  check(sweep < 0.10, `T-180's authored hand sweep is tiny (${(sweep * 1000).toFixed(0)} mm lock-to-lock — can't express a turning wheel)`);
  const bound = driverAnimInit(anim, skel, poseWorld, poseLocal, wheelC, wheelAxis);
  check(bound === null, "driverAnimInit refuses the degenerate anim → viewer falls back to the IK/snap path");
}

// ---- 5b. palm-cup grip on the REAL wheel: the cup lands on the handle bar ----
{
  const wverts = [];
  for (const g of sw.groups) for (let i = 0; i + 2 < g.pos.length; i += 3) wverts.push(g.pos[i], g.pos[i+1], g.pos[i+2]);
  const V = new Float32Array(wverts);
  const o = nm => { const M = poseWorld[nm]; return M ? [M[12], M[13], M[14]] : null; };
  for (const [side, nums] of [["L", [1, 2]], ["R", [4, 5]]]) {
    const W0 = o("DRIVER:RIG_HAND_" + side);
    const pts = [];
    for (const fam of ["Index", "Middle", "Ring", "Pinkie"]) for (const n of nums) {
      const p = o("DRIVER:HAND_" + fam + n);
      if (p) pts.push(p);
    }
    check(pts.length === 8, `hand ${side}: all 8 finger joints present in the seated pose`);
    const cup = v3sc(pts.reduce((a, p) => v3add(a, p), [0, 0, 0]), 1 / pts.length);
    const shift = palmGrip(cup, W0, V, 0.005);
    const landed = v3add(cup, shift);
    const core = snapToMesh(cup, V);
    const miss = v3len(v3sub(landed, core));
    check(!!shift && miss <= 0.006, `hand ${side}: shifted palm cup sits on the bar core (${(miss * 1000).toFixed(1)} mm off, trim 5 mm)`);
  }
}

// ---- 6. steerRefCalib on a synthetic constant-slip run (pure, no assets) ----
{
  const N = 400, slip = 0.35, E = { N, dt: 1 / 60, pos: new Float32Array(N * 3), nrm: new Float32Array(N * 3), fwd: new Float32Array(N * 3), gap: new Uint8Array(N) };
  for (let i = 0; i < N; i++) {
    const th = i * 0.01, R = 50;
    E.pos[i*3] = Math.cos(th) * R; E.pos[i*3+1] = 0; E.pos[i*3+2] = Math.sin(th) * R;
    E.nrm[i*3+1] = 1;
    const tx = -Math.sin(th), tz = Math.cos(th);                 // travel tangent
    const c = Math.cos(slip), s = Math.sin(slip);                // body heading = tangent yawed by the slip
    E.fwd[i*3] = tx * c - tz * s; E.fwd[i*3+2] = tx * s + tz * c;
  }
  const ref = steerRefCalib(E);
  check(Math.abs(ref - slip) < 0.05, `steerRefCalib recovers a constant ${(slip * 180 / Math.PI).toFixed(0)}° slip (got ${(ref * 180 / Math.PI).toFixed(1)}°)`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall good");
process.exit(failures ? 1 : 0);
