/* test_wristbend.js — is the visible "broken wrist" a TWIST or a BEND, and does the
 * elbow fix it?
 *
 * Attempts 1–3 (docs/DRIVER_WRIST.md) all worked the pronation axis: rotation ABOUT the
 * forearm's own axis. §10 of test_gripreach.js proves that component is absorbed
 * (62.5° → 6.5°). But the screenshot complaint is "the wrist needs to be straight with
 * the line", which is the ANGLE BETWEEN the forearm and the hand — and a rotation about
 * the forearm axis cannot change it, because it moves neither of them.
 *
 * A relative rotation is twist (about the axis) + swing (perpendicular). WRIST_FOLLOW
 * takes the twist. This measures the swing, and whether WRIST_POLE — steering the IK
 * pole so the elbow lands where the forearm lines up with the hand — takes it.
 *
 * Run: node test_wristbend.js
 */
"use strict";

const MU = require("./ui/mathutil.js");
Object.assign(global, MU);
global.DRIVER_SHOULDER_REACH = 0.15;
global.WRIST_FOLLOW = 1.0;
global.WRIST_RAMP = 0.3;
global.WRIST_POLE = 1.0;

const { armSolve, driverSeatedPose } = require("./ui/carrender.js");

let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? "ok " : "FAIL"} - ${msg}`);
  if (!cond) failures++;
}

// same synthetic seated rig the grip tests use
const C = [0, 0.95, 0.45];
const ax = v3nrm([0, 0.34, -0.94]);
const R = 0.18;
const SH = global.DRIVER_SHOULDER_REACH;
const DEG = 180 / Math.PI;

const xw = v3nrm(v3cross(Math.abs(ax[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], ax));
const yw = v3nrm(v3cross(ax, xw));

/** One arm, with the wrist set BACK from the grip contact along the hand's own axis —
 *  the real rig's geometry ("the wrist sits ~11 cm behind the contact"). Without that
 *  separation there is no hand axis to speak of and the bend is undefined. */
function armAt(sideSign) {
  const contact = v3add(C, v3add(v3sc(xw, sideSign * R * 0.94), v3sc(yw, R * 0.34)));
  const tangent = v3nrm(v3cross(ax, v3sub(contact, C)));  // a hand lies along the rim tangent
  const W0 = v3sub(contact, v3sc(tangent, 0.09));         // wrist, 9 cm back along the hand
  const S0 = v3add(C, [sideSign * 0.20, -0.16, -0.34]);
  const E0 = v3add(v3sc(v3add(S0, W0), 0.5), v3sc(yw, -0.10));
  return {
    S0, E0, W0, G0: contact,
    L1: v3len(v3sub(E0, S0)),
    L2: v3len(v3sub(W0, E0)),
    pole: v3sub(E0, S0),   // the bind-pose upper-arm direction — attempt 4's variable
    handAxis0: tangent,
  };
}

const rvAt = (p) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0], p[1], p[2], 1];
const originOf = (M) => [M[12], M[13], M[14]];

function rigFor(sideSign) {
  const a = armAt(sideSign);
  const FE0 = v3sc(v3add(a.E0, a.W0), 0.5);
  const F0 = v3add(a.W0, v3sc(a.handAxis0, 0.09));    // knuckles, at the contact
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

/** The angle between the forearm (elbow→wrist) and the hand (wrist→knuckles), in degrees. */
function bendAt(sideSign, ang, { follow = 1, pole = 1 } = {}) {
  global.carDriver = rigFor(sideSign);
  const pf = global.WRIST_FOLLOW, pp = global.WRIST_POLE;
  global.WRIST_FOLLOW = follow;
  global.WRIST_POLE = pole;
  const w = driverSeatedPose(ang);
  global.WRIST_FOLLOW = pf;
  global.WRIST_POLE = pp;
  global.carDriver = null;
  if (!w) return null;
  const fore = v3nrm(v3sub(originOf(w[3]), originOf(w[1])));
  const hand = v3nrm(v3sub(originOf(w[4]), originOf(w[3])));
  return Math.acos(Math.max(-1, Math.min(1, v3dot(fore, hand)))) * DEG;
}

const ANGLES = [0, 30, 60, 90, 120, 180, 270];

console.log("\n1. Pronation cannot touch the bend (the tautology, made checkable)\n");
console.log("   wheel    FOLLOW=0    FOLLOW=1     change");
let followMoved = 0;
for (const deg of ANGLES) {
  const off = bendAt(1, deg / DEG, { follow: 0, pole: 0 });
  const on = bendAt(1, deg / DEG, { follow: 1, pole: 0 });
  if (off == null || on == null) continue;
  followMoved = Math.max(followMoved, Math.abs(on - off));
  console.log(`   ${String(deg).padStart(4)}°   ${off.toFixed(1).padStart(8)}°   ${on.toFixed(1).padStart(8)}°   ${(on - off).toFixed(2).padStart(8)}°`);
}
check(followMoved < 0.01, `WRIST_FOLLOW moves the bend by ~0 (max ${followMoved.toFixed(3)}°) — it is the wrong component`);

console.log("\n2. The elbow does (attempt 4: WRIST_POLE)\n");
console.log("   wheel     POLE=0      POLE=1     improvement");
let worstOff = 0, worstOn = 0, everWorse = false;
for (const deg of ANGLES) {
  const off = bendAt(1, deg / DEG, { pole: 0 });
  const on = bendAt(1, deg / DEG, { pole: 1 });
  if (off == null || on == null) continue;
  worstOff = Math.max(worstOff, off);
  worstOn = Math.max(worstOn, on);
  if (on > off + 0.5) everWorse = true;
  console.log(`   ${String(deg).padStart(4)}°   ${off.toFixed(1).padStart(8)}°   ${on.toFixed(1).padStart(8)}°   ${(off - on).toFixed(1).padStart(9)}°`);
}
check(!everWorse, "the pole fix never makes the bend worse at any wheel angle");
check(worstOn < worstOff - 10, `worst-case bend improves materially (${worstOff.toFixed(1)}° → ${worstOn.toFixed(1)}°)`);

console.log("\n3. It must not move the things that are already right\n");
{
  const ang = 1.2;
  const g0 = (() => { global.carDriver = rigFor(1); global.WRIST_POLE = 0; const r = armSolve(carDriver.arms[0], ang, C, ax, SH); global.WRIST_POLE = 1; global.carDriver = null; return r; })();
  const g1 = (() => { global.carDriver = rigFor(1); const r = armSolve(carDriver.arms[0], ang, C, ax, SH); global.carDriver = null; return r; })();
  const dW = v3len(v3sub(g0.W, g1.W)), dS = v3len(v3sub(g0.S, g1.S));
  check(dW < 1e-6, `the grip target does not move (${dW.toExponential(1)} m) — the hand stays on the rim`);
  check(dS < 1e-6, `the shoulder does not move (${dS.toExponential(1)} m)`);
  const arm = rigFor(1).arms[0];
  const l1 = v3len(v3sub(g1.E, g1.S)), l2 = v3len(v3sub(g1.W, g1.E));
  check(Math.abs(l1 - arm.L1) < 1e-4, `upper-arm length holds (${l1.toFixed(4)} vs ${arm.L1.toFixed(4)})`);
  check(Math.abs(l2 - arm.L2) < 1e-4, `forearm length holds (${l2.toFixed(4)} vs ${arm.L2.toFixed(4)})`);
  check(v3len(v3sub(g1.E, g0.E)) > 1e-3, "the ELBOW is what moved — which is the whole mechanism");
}

console.log("\n4. Both sides, and the blend is continuous\n");
{
  let symOk = true;
  for (const deg of ANGLES) {
    const l = bendAt(1, deg / DEG, { pole: 1 }), r = bendAt(-1, deg / DEG, { pole: 1 });
    if (l == null || r == null || !isFinite(l) || !isFinite(r)) symOk = false;
  }
  check(symOk, "both arms solve at every angle (no NaN, no dropped pose)");
  const mid = bendAt(1, 1.2, { pole: 0.5 }), off = bendAt(1, 1.2, { pole: 0 }), on = bendAt(1, 1.2, { pole: 1 });
  const lo = Math.min(off, on) - 0.5, hi = Math.max(off, on) + 0.5;
  check(mid >= lo && mid <= hi, `a half blend lands between the ends (${off.toFixed(1)}° / ${mid.toFixed(1)}° / ${on.toFixed(1)}°)`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall good");
process.exit(failures ? 1 : 0);
