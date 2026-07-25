/* test_wristbend.js — is the visible "broken wrist" a TWIST or a BEND?
 *
 * Attempts 1–3 (docs/DRIVER_WRIST.md) all worked the pronation axis: rotation ABOUT the
 * forearm's own axis. §10 of test_gripreach.js proves that component is now absorbed
 * (62.5° → 6.5°). But the screenshot complaint is "the wrist needs to be straight with
 * the line" — that is not twist. That is the ANGLE BETWEEN the forearm's direction and
 * the hand's direction, and a rotation about the forearm axis cannot change it at all.
 *
 * A relative rotation splits into twist (about the axis) and swing (perpendicular to it).
 * WRIST_FOLLOW removes the twist. This measures what is left.
 *
 * Run: node test_wristbend.js
 */
"use strict";

const MU = require("./ui/mathutil.js");
Object.assign(global, MU);
global.DRIVER_SHOULDER_REACH = 0.15;
global.WRIST_FOLLOW = 1.0;
global.WRIST_RAMP = 0.3;

const { armSolve, driverSeatedPose } = require("./ui/carrender.js");

// same synthetic seated rig the grip tests use
const C = [0, 0.95, 0.45];
const ax = v3nrm([0, 0.34, -0.94]);
const R = 0.18;
const SH = global.DRIVER_SHOULDER_REACH;

// wheel plane basis
const xw = v3nrm(v3cross(Math.abs(ax[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], ax));
const yw = v3nrm(v3cross(ax, xw));

function armAt(sideSign) {
  const grip = v3add(C, v3add(v3sc(xw, sideSign * R * 0.94), v3sc(yw, R * 0.34)));
  const S0 = v3add(C, [sideSign * 0.20, -0.16, -0.34]);
  const W0 = grip;
  const E0 = v3add(v3sc(v3add(S0, W0), 0.5), v3sc(yw, -0.10));
  // armSolve needs the bone lengths and the IK pole. The pole is the bind-pose upper-arm
  // direction — and it is the free variable this whole investigation is circling.
  return {
    S0, E0, W0,
    L1: v3len(v3sub(E0, S0)),
    L2: v3len(v3sub(W0, E0)),
    pole: v3sub(E0, S0),
  };
}

const rvAt = (p) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0], p[1], p[2], 1];
const DEG = 180 / Math.PI;

/** Build the five-bone chain carrender expects, for one side. */
function rigFor(sideSign) {
  const a = armAt(sideSign);
  const FE0 = v3sc(v3add(a.E0, a.W0), 0.5);
  // the hand's own pointing direction: wrist → knuckles, tangent to the rim, which is
  // how a hand actually lies on a wheel
  const tangent = v3nrm(v3cross(ax, v3sub(a.W0, C)));
  const F0 = v3add(a.W0, v3sc(tangent, 0.09));
  const names = ["Arm", "Fore", "ForeEnd", "Hand", "Finger"];
  const origins = [a.S0, a.E0, FE0, a.W0, F0];
  const poseWorld = {};
  names.forEach((n, i) => (poseWorld[n] = rvAt(origins[i])));
  return {
    poseWorld,
    skel: { count: 5, name: names, bindWorld: names.map((n, i) => rvAt(origins[i])) },
    arms: [{ ...a, armSub: [0, 1, 2, 3, 4], foreSub: [1, 2, 3, 4], foreEndSub: [2, 3, 4], handSub: [3, 4] }],
    wheelC: C, wheelAxis: ax,
  };
}

const originOf = (M) => [M[12], M[13], M[14]];

/** twist (about the forearm axis) and bend (angle off it), in degrees. */
function measure(sideSign, ang, follow) {
  global.carDriver = rigFor(sideSign);
  const prev = global.WRIST_FOLLOW;
  global.WRIST_FOLLOW = follow;
  const w = driverSeatedPose(ang);
  global.WRIST_FOLLOW = prev;
  const g = armSolve(carDriver.arms[0], ang, C, ax, SH);
  global.carDriver = null;
  if (!w) return null;

  const fore = v3nrm(v3sub(originOf(w[3]), originOf(w[1])));  // elbow → wrist
  const hand = v3nrm(v3sub(originOf(w[4]), originOf(w[3])));  // wrist → knuckles
  const bend = Math.acos(Math.max(-1, Math.min(1, v3dot(fore, hand)))) * DEG;
  const parallel = Math.abs(v3dot(ax, v3nrm(v3sub(g.W, g.E))));
  return { bend, parallel };
}

console.log("\nWrist bend — the angle between the forearm and the hand.");
console.log("A rotation about the forearm axis (WRIST_FOLLOW) cannot change this number.\n");
console.log("  wheel     bend @FOLLOW=0   bend @FOLLOW=1   change   fore·wheelAxis");
console.log("  " + "-".repeat(70));

let maxBend = 0;
let followMoved = 0;
for (const deg of [0, 30, 60, 90, 120, 180, 270]) {
  const ang = deg / DEG;
  const off = measure(1, ang, 0);
  const on = measure(1, ang, 1);
  if (!off || !on) { console.log(`  ${String(deg).padStart(5)}°   (no pose)`); continue; }
  const d = on.bend - off.bend;
  maxBend = Math.max(maxBend, on.bend);
  followMoved = Math.max(followMoved, Math.abs(d));
  console.log(
    `  ${String(deg).padStart(5)}°   ${off.bend.toFixed(1).padStart(10)}°   ${on.bend.toFixed(1).padStart(12)}°   ${d.toFixed(2).padStart(6)}°   ${on.parallel.toFixed(3).padStart(12)}`
  );
}

console.log("\n  " + "-".repeat(70));
console.log(`  worst bend with the fix ON : ${maxBend.toFixed(1)}°`);
console.log(`  most WRIST_FOLLOW moved it : ${followMoved.toFixed(2)}°`);
console.log(
  followMoved < 1
    ? "\n  => CONFIRMED: pronation does not touch the bend. Attempts 1-3 fixed the twist;\n     the bend is a separate, untouched component."
    : "\n  => pronation does affect the bend — hypothesis wrong, re-derive."
);
