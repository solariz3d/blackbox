/* test_poserate.js — the driver's pose rate, decoupled from the display rate.
 *
 * The full IK re-pose plus skin ran once per car per FRAME: 360 times a second on a 360 Hz
 * panel, and by a wide margin the largest per-frame allocator in the app. It is resampling
 * a signal that does not move at anything like that rate — a driver's forearms and fingers
 * change over tenths of a second, not over 2.8 ms.
 *
 * Two properties make capping it safe, and both are tested here because getting either
 * wrong is invisible until it is embarrassing:
 *
 *   1. The driver is skinned in CAR-LOCAL space and placed by the car matrix, which still
 *      updates every frame. A capped pose is stale in ELBOW ANGLE, never in position.
 *   2. The skin buffers are SHARED by every car. Each car poses, uploads and draws in
 *      sequence, so skipping a pose leaves whichever car posed LAST in the buffer — which
 *      with ghosts on track would put one driver's steering on another's body. The cache is
 *      therefore keyed on which car posed last, so with several cars it never hits and
 *      every car poses every frame, exactly as before.
 *
 * Run: node test_poserate.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

let fails = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL " + m); fails++; } };

/* Read the target out of the shipped source rather than restating it, because this number
 * is deliberately a dial being tuned against measurements — pinning a literal here means
 * every experiment breaks the test and the test teaches nothing. What the test guards is
 * the BEHAVIOUR at whatever the dial says: never faster than the target, correct
 * quantisation, an immediate re-pose on real movement, and the multi-car safety property. */
const HZ = (() => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "ui", "carrender.js"), "utf8");
  const m = /let DRIVER_POSE_HZ = (\d+)/.exec(src);
  if (!m) throw new Error("DRIVER_POSE_HZ not found in ui/carrender.js");
  return +m[1];
})();
const SPIN_EPS = 0.007;

/** mirrors driverSeatedSkin's gate; returns true when a full re-pose happens */
function makeGate() {
  let last = null;
  return function pose(key, nowMs, spin) {
    if (last && last.key === key && HZ > 0) {
      const due = nowMs - last.t >= (1000 / HZ) * 0.98;   // see the tolerance note in carrender.js
      const moved = Math.abs(spin - last.spin) > SPIN_EPS;
      if (!due && !moved) return false;
    }
    last = { key, t: nowMs, spin };
    return true;
  };
}

console.log("one car: the pose rate is capped, the frame rate is not");
{
  /* The achieved rate is QUANTISED to the frame clock — a pose can only happen on a frame,
   * and the gate fires once the interval has elapsed, so the real rate is
   * frameRate / ceil(frameRate / target). At 360 Hz that is every third frame: 120 Hz, not
   * 144. I first asserted ~144 here, which was the target rather than the behaviour. */
  const expected = (fps) => fps / Math.ceil(fps / HZ);
  const g = makeGate();
  let posed = 0;
  const frames = 360;                       // one second at 360 Hz
  for (let i = 0; i < frames; i++) if (g(0, i * (1000 / 360), 0.5)) posed++;
  ok(posed === expected(360), `360 frames produced ${posed} poses (1 in ${360 / posed}), not 360`);
  ok(posed <= HZ, "and never more often than the target asks for");
  ok(frames / posed >= 2, `a ${(frames / posed).toFixed(1)}x reduction in the app's largest allocator`);
}

console.log("...and it scales with the panel, not against it");
{
  // the point of the whole exercise: a faster display must not cost more pose work
  for (const fps of [144, 240, 360, 500]) {
    const g = makeGate();
    let posed = 0;
    for (let i = 0; i < fps; i++) if (g(0, i * (1000 / fps), 0.5)) posed++;
    /* Bounds, not an exact count. The gate compares elapsed time against 1000/144, and at
     * some frame rates a pose lands exactly ON that boundary where the comparison is
     * decided by floating-point equality — 144 Hz frames are 6.94444... ms and the
     * threshold is the same number. Pinning the exact count would be pinning float rounding
     * rather than behaviour; what matters is that the target is never exceeded and the
     * saving is real. */
    ok(posed <= HZ + 1, `at ${fps} fps the driver poses ${posed} times a second, not ${fps}`);
    ok(fps <= HZ || posed < fps * 0.8, `and at ${fps} fps that is a genuine reduction (${posed})`);
  }
  // on a 60 Hz panel nothing is capped away — the cap is above the frame rate
  const g60 = makeGate();
  let p60 = 0;
  for (let i = 0; i < 60; i++) if (g60(0, i * (1000 / 60), 0.5)) p60++;
  /* THE PROPERTY THAT MADE THIS SAFE TO SHIP: on a display no faster than the target, the
   * cap must skip nothing at all. Without the tolerance in the gate this measured 40/60 —
   * a third of poses dropped on a 60 Hz monitor by float rounding on an exact boundary. */
  ok(p60 === 60, `at 60 fps every frame still poses (${p60}/60) — the cap never makes things worse`);
}

console.log("a real steering movement re-poses immediately, cap or no cap");
{
  const g = makeGate();
  g(0, 0, 0.0);
  ok(!g(0, 1, 0.0), "no time passed, no movement: skipped");
  ok(!g(0, 1, 0.006), "movement below the threshold: still skipped");
  ok(g(0, 1, 0.02), "a real movement re-poses on the very next frame, not at the next tick");
  // the threshold has to be smaller than anything an eye could catch on the rim
  ok(SPIN_EPS < 0.01, `the movement threshold is ${SPIN_EPS} rad (~0.4 deg), narrower than the grip itself`);
}

console.log("several cars: each is capped independently");
{
  /* INVERTED DELIBERATELY. This used to assert that with ghosts on track every car re-posed
   * every frame — because one shared skin buffer meant a skipped car would draw whichever
   * car posed last, wearing another driver's arms. Correct then, and it meant the cap did
   * nothing in the heaviest case: four cars, four full IK solves a frame.
   *
   * Each car now keeps its own skinned vertices, so a skipped car re-uploads its own last
   * result and the cap applies per car. The old assertion is not weakened here, it is
   * obsolete — the constraint that forced it is gone. */
  const gates = new Map();
  const gate = (k) => { if (!gates.has(k)) gates.set(k, makeGate()); return gates.get(k); };
  const cars = ["ref", "ghost1", "ghost2", "ghost3"];
  let posed = 0, draws = 0;
  for (let i = 0; i < 360; i++) for (const c of cars) { draws++; if (gate(c)(c, i * (1000 / 360), 0.5)) posed++; }
  ok(posed < draws / 2, `4 cars over a second: ${posed} poses for ${draws} draws, not one each`);
  ok(posed <= cars.length * (HZ + 1), `and no car exceeds its own ${HZ} Hz target (${posed} total)`);
  // the safety property that replaces the old one: a car's pose depends only on its own key
  const gA = makeGate(), gB = makeGate();
  gA("a", 0, 0.5); gB("b", 0, 0.9);
  ok(!gA("a", 1, 0.5), "car A skips on its own timing");
  ok(!gB("b", 1, 0.9), "car B skips on its own timing, with its own steering");
  ok(gA("a", 1, 0.9), "and A re-poses when A's OWN steering moves, not when B's does");
}

console.log("constants match the shipped source");
{
  const cr = require("./testenv.js").uiSource();
  ok(/let DRIVER_POSE_HZ = \d+/.test(cr), `DRIVER_POSE_HZ present (currently ${HZ})`);
  ok(HZ >= 30 && HZ <= 240, `and in a sane range — ${HZ} Hz`);
  ok(cr.includes("Math.abs(spin - p.spin) > 0.007"), "the movement escape hatch is present");
  ok(/const _dpose = new Map\(\)/.test(cr), "the cache is per car");
  ok(/sm\._perCar/.test(cr), "and each car keeps its own skinned vertices");
  ok(/driverSkinReupload\(k\)/.test(cr),
     "a skipped car re-uploads its OWN skin — the GL buffer is shared, so it must");
  ok(/if \(!slot\) return false/.test(cr),
     "and falls through to a full pose when a car has no cached skin yet");
  const src = require("./testenv.js").uiSource();
  ok(src.includes("driverPoseReset(); driverSeatedSkin(0, 0)"),
     "load-time seating forces a pose through rather than letting the cap defer it");
  ok(/driverSeatedSkin\([^)]*, run\)/.test(src), "ghosts pass their run as the key");
}

console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exit(fails ? 1 : 0);

