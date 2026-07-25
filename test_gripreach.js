/* test_gripreach.js — glued-grip steering (gripSat / armSolve / gripLockCalib) headless test.
 *
 * One spin drives the cockpit wheel AND the hands, so glue is structural; what
 * needs proof is the solver, on the SAME code the viewer runs (carrender.js
 * exports it), against a synthetic seated rig with realistic proportions:
 *   1. the live grip W is exactly the bind grip orbited about the wheel axis
 *      (radius + axial offset preserved, in-plane angle = the spin)
 *   2. bone lengths hold at every angle (|E−S| = L1, |W−E| = L2): the wrist
 *      lands ON the grip, never clamped short of the rim
 *   3. the shoulder never leans past DRIVER_SHOULDER_REACH, and does not move
 *      at all within plain arm reach (bind pose untouched at rest)
 *   4. gripLockCalib: everything reachable inside the lock, some arm fails past it
 *   5. gripSat: near-linear in normal corners, monotone, always inside the lock,
 *      still creeping (not frozen) at silly steer angles
 *
 * Run: node test_gripreach.js
 */
"use strict";

const MU = require("./ui/mathutil.js");
Object.assign(global, MU);
global.DRIVER_SHOULDER_REACH = 0.15;

const { gripSat, armSolve, gripLockCalib, driverSeatedPose, snapToMesh, palmGrip } = require("./ui/carrender.js");

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log("  ok  - " + msg);
  } else {
    console.log("  FAIL- " + msg);
    failures++;
  }
}

// ---- synthetic rig: tilted column, 0.18 m rim, shoulders behind it, arms nearly straight ----
const C = [0, 0.95, 0.45];                       // wheel centre (car space)
const ax = v3nrm([0, 0.34, -0.94]);              // column axis
const xw = v3nrm(v3cross([0, 1, 0], ax));        // wheel-plane basis
const yw = v3nrm(v3cross(ax, xw));
const R = 0.18;
function mkArm(side) {
  const S0 = [side * 0.18, 1.02, 0.02];          // shoulder
  // grip at 9 / 3 o'clock ON THE SHOULDER'S OWN SIDE (pick the rim end nearest it)
  const cand = [v3add(C, v3sc(xw, R)), v3add(C, v3sc(xw, -R))];
  const W0 = v3len(v3sub(cand[0], S0)) < v3len(v3sub(cand[1], S0)) ? cand[0] : cand[1];
  const mid = v3add(S0, v3sc(v3sub(W0, S0), 0.52));
  const E0 = v3add(mid, [0, -0.06, 0]);          // elbow hangs a little below the chain
  return { S0, E0, W0, L1: v3len(v3sub(E0, S0)), L2: v3len(v3sub(W0, E0)), pole: v3sub(E0, S0), gripBase: 0 };
}
const arms = [mkArm(-1), mkArm(1)];
const SH = DRIVER_SHOULDER_REACH;
const SH_TIGHT = 0.005;                          // near-zero lean budget → forces a real, finite lock

// independent in-plane angle of a grip point, in the (xw, yw) wheel basis
function planeAngleOf(W, W0) {
  const a = v3sub(W, C), b = v3sub(W0, C);
  const a2 = [v3dot(a, xw), v3dot(a, yw)], b2 = [v3dot(b, xw), v3dot(b, yw)];
  return Math.atan2(a2[1] * b2[0] - a2[0] * b2[1], a2[0] * b2[0] + a2[1] * b2[1]);
}

const lock = gripLockCalib(arms, C, ax, SH);
const lockTight = gripLockCalib(arms, C, ax, SH_TIGHT);
check(lock > 0.9, `full shoulder budget: lock is a real range (${(lock * 180 / Math.PI).toFixed(1)}°)`);
check(lockTight > 0 && lockTight < lock,
  `tight budget: a real finite lock, smaller than with the lean (${(lockTight * 180 / Math.PI).toFixed(1)}° < ${(lock * 180 / Math.PI).toFixed(1)}°) — the shoulder buys range`);

// ---- 1+2+3. sweep the whole usable range: glue + bone lengths + shoulder budget ----
{
  let okOrbit = true, okBones = true, okShoulder = true, maxLean = 0;
  for (let a = -lock; a <= lock; a += 0.005) {
    for (const arm of arms) {
      const g = armSolve(arm, a, C, ax, SH);
      // W is the bind grip truly orbited: radius, axial offset, in-plane angle
      const rB = v3len(v3sub(arm.W0, C)), rL = v3len(v3sub(g.W, C));
      if (Math.abs(rL - rB) > 1e-9) okOrbit = false;
      if (Math.abs(v3dot(ax, v3sub(g.W, C)) - v3dot(ax, v3sub(arm.W0, C))) > 1e-9) okOrbit = false;
      if (Math.abs(planeAngleOf(g.W, arm.W0) - (-a)) > 1e-6 && Math.abs(planeAngleOf(g.W, arm.W0) - a) > 1e-6) okOrbit = false;
      // bone lengths hold → the wrist really lands on W (nothing clamped short)
      if (Math.abs(v3len(v3sub(g.E, g.S)) - arm.L1) > 1e-6) okBones = false;
      if (Math.abs(v3len(v3sub(g.W, g.E)) - arm.L2) > 1e-6) okBones = false;
      const lean = v3len(v3sub(g.S, arm.S0));
      maxLean = Math.max(maxLean, lean);
      if (lean > SH + 1e-9) okShoulder = false;
    }
  }
  check(okOrbit, "live grip is exactly the bind grip orbited about the wheel axis");
  check(okBones, "bone lengths hold at every angle — the hand lands ON the grip, never short");
  check(okShoulder, `shoulder lean stays inside the budget (max ${maxLean.toFixed(3)} m ≤ ${SH} m)`);
  check(maxLean > 1e-6, "the crossed-over range actually uses the shoulder lean (it fired)");
}

// ---- 3b. at rest, the authored pose is untouched ----
{
  let ok = true;
  for (const arm of arms) {
    const g = armSolve(arm, 0, C, ax, SH);
    if (v3len(v3sub(g.W, arm.W0)) > 1e-12 || v3len(v3sub(g.S, arm.S0)) > 1e-12) ok = false;
  }
  check(ok, "spin=0: grips at bind, shoulders unmoved (seated pose reproduced)");
}

// ---- 4. the lock is honest: reachable inside, fails just past (tight budget) ----
{
  let inOk = true;
  for (const sgn of [1, -1]) for (const arm of arms) if (!armSolve(arm, sgn * lockTight, C, ax, SH_TIGHT).ok) inOk = false;
  let outFail = false;
  for (const sgn of [1, -1]) for (const arm of arms) if (!armSolve(arm, sgn * (lockTight + 0.03), C, ax, SH_TIGHT).ok) outFail = true;
  check(inOk, "both hands reach everywhere inside the lock");
  check(outFail, "just past the lock, an arm genuinely can't reach (the lock is real)");
}

// ---- 5. gripSat: the wheel keeps moving, never freezes, never exceeds the lock ----
{
  check(Math.abs(gripSat(0.3, lock) - 0.3) < 0.01, "normal-corner steer is passed through near-linearly");
  let mono = true, prev = -Infinity, bounded = true;
  for (let raw = -8; raw <= 8; raw += 0.05) {
    const a = gripSat(raw, lock);
    if (a <= prev) mono = false;
    if (Math.abs(a) >= lock) bounded = false;
    prev = a;
  }
  check(mono, "wheel angle is strictly monotone in the steer (it never freezes)");
  check(bounded, "wheel angle always stays inside the arms' lock (hands can always hold it)");
  check(gripSat(1e9, 0) === 1e9, "no driver rig (lock 0) → wheel uncapped");
}

// ---- 6. full skeleton pose: the hand is WELDED to the wheel ----
// A minimal one-arm skeleton run through driverSeatedPose (the real pose code):
// the hand bone must land exactly on the live grip, the finger must ride rigidly
// with it (orientation check via a point — convention-free), and the arm chain
// (shoulder → elbow → wrist) must meet the same grip the solver placed.
{
  const arm0 = arms[0];
  const F0 = v3add(arm0.W0, v3sc(yw, 0.03));     // a fingertip 3 cm up the rim from the grip
  const rvAt = p => [1,0,0,0, 0,1,0,0, 0,0,1,0, p[0],p[1],p[2],1];   // identity rotation, origin p
  const names = ["Arm", "Fore", "Hand", "Finger"];
  const origins = [arm0.S0, arm0.E0, arm0.W0, F0];
  const poseWorld = {}; names.forEach((n, i) => poseWorld[n] = rvAt(origins[i]));
  global.carDriver = {
    poseWorld,
    skel: { count: 4, name: names, bindWorld: names.map((n, i) => rvAt(origins[i])) },
    arms: [{ ...arm0, armSub: [0, 1, 2, 3], foreSub: [1, 2, 3], handSub: [2, 3] }],
    wheelC: C, wheelAxis: ax,
  };
  // independent Rodrigues orbit (test's own math, not the solver's)
  const orbit = (p, ang) => {
    const c = Math.cos(ang), s = Math.sin(ang), o = 1 - c;
    const v = v3sub(p, C), d = v3dot(ax, v), cx = v3cross(ax, v);
    return [C[0] + v[0]*c + cx[0]*s + ax[0]*d*o, C[1] + v[1]*c + cx[1]*s + ax[1]*d*o, C[2] + v[2]*c + cx[2]*s + ax[2]*d*o];
  };
  let okHand = true, okFinger = true, okChain = true;
  for (const ang of [0.5, 1.5, 2.6, -1.0, -2.4]) {
    const world = driverSeatedPose(ang);
    const g = armSolve(arm0, ang, C, ax, SH);
    const at = i => [world[i][12], world[i][13], world[i][14]];
    if (v3len(v3sub(at(2), orbit(arm0.W0, ang))) > 1e-6) okHand = false;     // hand origin = orbited grip
    if (v3len(v3sub(at(3), orbit(F0, ang))) > 1e-6) okFinger = false;        // finger orbits rigidly with it
    if (v3len(v3sub(at(0), g.S)) > 1e-6) okChain = false;                    // shoulder where the solver leaned it
    if (v3len(v3sub(at(1), g.E)) > 1e-6) okChain = false;                    // elbow on the IK solution
    if (Math.abs(v3len(v3sub(at(2), at(1))) - arm0.L2) > 1e-6) okChain = false;   // forearm meets the welded wrist
  }
  check(okHand, "hand bone lands exactly on the live grip (welded to the wheel)");
  check(okFinger, "fingers ride rigidly with the hand (grip orientation = authored grip, orbited)");
  check(okChain, "arm chain (leaned shoulder → IK elbow → wrist) meets the welded hand");
  global.carDriver = null;
}

// ---- 7. snapToMesh: a handle WITH A HOLE beside it — snap must find the bar ----
// A handle bar (dense cylinder of verts) with an opening (no verts) between it and
// the hub, the exact T-180 situation. The authored grip sits IN the opening, 2 cm
// from the bar: the snap must land at the bar's core, never float in the hole.
{
  const barC = v3add(C, v3add(v3sc(xw, 0.16), v3sc(yw, 0.02)));   // handle bar centre
  const barDir = yw, barR = 0.012, barLen = 0.10;
  const pos = [];
  for (let i = 0; i < 600; i++) {                                  // the bar (cylinder surface)
    const t = (i / 600) * barLen - barLen / 2, th = i * 2.399963;  // golden-angle wrap
    const rad = v3add(v3sc(xw, Math.cos(th) * barR), v3sc(ax, Math.sin(th) * barR));
    const p = v3add(v3add(barC, v3sc(barDir, t)), rad);
    pos.push(p[0], p[1], p[2]);
  }
  for (let i = 0; i < 300; i++) {                                  // hub far away (must not attract)
    const th = (i / 300) * 2 * Math.PI;
    const p = v3add(C, v3add(v3sc(xw, Math.cos(th) * 0.05), v3sc(yw, Math.sin(th) * 0.05)));
    pos.push(p[0], p[1], p[2]);
  }
  const verts = new Float32Array(pos);
  const inHole = v3add(barC, v3sc(xw, -0.02));                     // authored grip: 2 cm off the bar, in the opening
  const snap = snapToMesh(inHole, verts);
  check(!!snap, "snapToMesh finds material near the authored grip");
  if (snap) {
    const toAxis = v3sub(snap, v3add(barC, v3sc(barDir, v3dot(v3sub(snap, barC), barDir))));
    check(v3len(toAxis) < barR, `snap lands INSIDE the handle bar's core (${(v3len(toAxis) * 1000).toFixed(1)} mm off its axis, bar r=${barR * 1000} mm)`);
    check(v3len(v3sub(snap, inHole)) > 0.005, "snap actually moved the grip out of the hole");
  }

  // palmGrip: shifting by it puts the PALM CUP on the bar core (with depth trim)
  const cup = v3add(barC, v3sc(xw, -0.037));                       // palm cup hanging 37 mm past the bar
  const wrist = v3add(cup, v3sc(xw, -0.112));                      // wrist ~11 cm behind the cup
  const shift = palmGrip(cup, wrist, verts, 0);
  check(!!shift && v3len(v3sub(v3add(cup, shift), snapToMesh(cup, verts))) < 1e-9,
    "palmGrip's shift lands the palm cup exactly on the bar core");
  const shiftTrim = palmGrip(cup, wrist, verts, 0.005);
  if (shift && shiftTrim) {
    const d = v3len(v3sub(shiftTrim, shift));
    check(Math.abs(d - 0.005) < 1e-9, `depth trim backs the cup off by exactly the trim (${(d * 1000).toFixed(1)} mm)`);
    check(v3dot(v3sub(shiftTrim, shift), v3sub(wrist, cup)) > 0, "the trim backs off toward the wrist, not deeper in");
  }

  // ---- 8. the weld rides a snapped grip: hand + arm meet on the real handle ----
  const arm0 = arms[0];
  const G0 = v3add(arm0.W0, [0.01, 0.012, -0.008]);                // a snapped grip ~18 mm from authored
  const F0 = v3add(arm0.W0, v3sc(yw, 0.03));
  const rvAt = p => [1,0,0,0, 0,1,0,0, 0,0,1,0, p[0],p[1],p[2],1];
  const names = ["Arm", "Fore", "Hand", "Finger"];
  const origins = [arm0.S0, arm0.E0, arm0.W0, F0];
  const poseWorld = {}; names.forEach((n, i) => poseWorld[n] = rvAt(origins[i]));
  global.carDriver = {
    poseWorld,
    skel: { count: 4, name: names, bindWorld: names.map((n, i) => rvAt(origins[i])) },
    arms: [{ ...arm0, G0, gripShift: v3sub(G0, arm0.W0), armSub: [0, 1, 2, 3], foreSub: [1, 2, 3], handSub: [2, 3] }],
    wheelC: C, wheelAxis: ax,
  };
  const orbit = (p, ang) => {
    const c = Math.cos(ang), s = Math.sin(ang), o = 1 - c;
    const v = v3sub(p, C), d = v3dot(ax, v), cx = v3cross(ax, v);
    return [C[0] + v[0]*c + cx[0]*s + ax[0]*d*o, C[1] + v[1]*c + cx[1]*s + ax[1]*d*o, C[2] + v[2]*c + cx[2]*s + ax[2]*d*o];
  };
  let okW = true, okChain2 = true, okRest = true;
  for (const ang of [0, 0.8, 1.4, -1.2]) {
    const world = driverSeatedPose(ang || 1e-9);   // pose runs even at ~0 so the snap seats the hand
    const at = i => [world[i][12], world[i][13], world[i][14]];
    const g = armSolve(carDriver.arms[0], ang || 1e-9, C, ax, SH);
    if (v3len(v3sub(at(2), orbit(G0, ang || 1e-9))) > 1e-6) okW = false;      // hand ON the snapped grip's orbit
    if (v3len(v3sub(at(2), g.W)) > 1e-6) okChain2 = false;                    // = exactly where the arm was solved to
    if (Math.abs(v3len(v3sub(at(2), at(1))) - arm0.L2) > 1e-6) okChain2 = false;   // forearm really meets it
    if (ang === 0 && v3len(v3sub(at(2), G0)) > 1e-6) okRest = false;          // at rest the hand sits on the measured rim
  }
  check(okW, "welded hand rides the SNAPPED grip's orbit (on the measured rim)");
  check(okChain2, "arm chain meets the snapped grip exactly (wrist = solver target, forearm length holds)");
  check(okRest, "at rest the hand is seated ON the measured rim, not the authored guess");
  global.carDriver = null;
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall good");
process.exit(failures ? 1 : 0);
