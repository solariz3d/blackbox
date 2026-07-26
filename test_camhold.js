/* test_camhold.js — camera behaviour must not depend on the display's refresh rate.
 *
 * The chase rig folds its boom in when the world would occlude the car, and ignores brief
 * flickers so a thin trackside object does not jolt the camera. That filter was written as
 * `hitFrames >= 2` — a FRAME COUNT — which is 33 ms on a 60 Hz panel and 5.6 ms on a 360 Hz
 * one. On the fast display it is six times weaker than the filter that was tuned, so short
 * contacts get through, the boom folds at rate 7.0 and eases back at 1.6, and the result is
 * a visible lurch on a frame that comfortably met its budget.
 *
 * That failure is invisible to every frame-time instrument in this app, because the frame
 * was never slow — the camera was simply somewhere else. It is only catchable by asking
 * whether the same wall-clock event produces the same camera response at any refresh rate,
 * which is what this test does.
 *
 * The rig itself is inside a GL draw path in index.html, so the two rules under test are
 * mirrored here and both constants are asserted against the shipped source below.
 *
 * Run: node test_camhold.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { easeK } = require("./ui/mathutil.js");

let fails = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL " + m); fails++; } };

const HIT_HOLD_S = 0.033;

/** How long a contact must persist before the boom folds — mirrors followUpdate. */
function foldsAfter(dtSeconds, contactSeconds) {
  let held = 0;
  const steps = Math.round(contactSeconds / dtSeconds);
  for (let i = 0; i < steps; i++) {
    held += dtSeconds;
    if (held >= HIT_HOLD_S) return true;
  }
  return false;
}

console.log("the flicker filter is a duration, not a frame count");
{
  const HZ = { "60": 1 / 60, "144": 1 / 144, "240": 1 / 240, "360": 1 / 360 };
  // A 10 ms brush past the boom is a flicker at every refresh rate. Under the frame-counted
  // rule it was ignored at 60 Hz (2 frames = 33 ms) and ACTED ON at 360 Hz (2 frames =
  // 5.6 ms) — the same event, two different cameras, decided by the monitor.
  for (const [hz, dt] of Object.entries(HZ)) {
    ok(!foldsAfter(dt, 0.010), `${hz} Hz: a 10 ms brush is ignored`);
  }
  // and a real, sustained contact still folds, at every rate
  for (const [hz, dt] of Object.entries(HZ)) {
    ok(foldsAfter(dt, 0.200), `${hz} Hz: a 200 ms contact folds the boom`);
  }
  /* The boundary lands in the same place on every display, which is the whole property.
   * The margin is one and a half frames of the display being tested, not a fixed few
   * milliseconds: at 60 Hz the rig can only resolve time in 16.7 ms steps, so asking it to
   * distinguish 27 ms from 33 ms is asking it to see between its own samples. My first
   * version used a flat 6 ms and failed at 60 Hz for exactly that reason — the test was
   * wrong, not the rig. Quantisation is a property of the display, so the tolerance has to
   * be too. */
  for (const [hz, dt] of Object.entries(HZ)) {
    const m = dt * 1.5;
    ok(!foldsAfter(dt, HIT_HOLD_S - m), `${hz} Hz: just under the hold, ignored`);
    ok(foldsAfter(dt, HIT_HOLD_S + m), `${hz} Hz: just over the hold, folds`);
  }
}

console.log("the old frame-counted rule really did diverge — this is what was fixed");
{
  const framesRule = (dt, contactSeconds) => Math.round(contactSeconds / dt) >= 2;
  const brush = 0.010;
  ok(!framesRule(1 / 60, brush), "under the old rule a 10 ms brush was ignored at 60 Hz");
  ok(framesRule(1 / 360, brush), "and acted on at 360 Hz — same event, different camera");
  // stated as the ratio, so the size of the error is on the record rather than implied
  ok(Math.abs((2 / 360) / (2 / 60) - 1 / 6) < 1e-9,
     "the filter was exactly 6x weaker at 360 Hz than at 60 Hz");
}

console.log("the rest of the rig's smoothing was already rate-independent");
{
  /* easeK is 1 - exp(-rate*dt), so stepping it N times at dt/N converges to the same place
   * as one step at dt. This is asserted because it is the reason the hitFrames bug was the
   * ONLY rate dependence in the rig — had the smoothing been a bare per-frame lerp, the
   * camera would have moved at different speeds on the two monitors as well. */
  const converge = (rate, total, dt) => {
    let v = 0;
    for (let t = 0; t < total - 1e-9; t += dt) v += (1 - v) * easeK(rate, dt);
    return v;
  };
  const at60 = converge(5, 0.5, 1 / 60);
  const at360 = converge(5, 0.5, 1 / 360);
  ok(Math.abs(at60 - at360) < 0.01,
     `same approach over the same half-second at 60 and 360 Hz (${at60.toFixed(4)} vs ${at360.toFixed(4)})`);
  // a naive per-frame lerp is what this would look like if it were wrong — kept as the
  // contrast, so the assertion above is visibly non-trivial
  const naive = (k, total, dt) => { let v = 0; for (let t = 0; t < total - 1e-9; t += dt) v += (1 - v) * k; return v; };
  // over a tenth of a second, where the two have not both already saturated — at half a
  // second both are near 1 and the divergence is real but invisible, which is how this
  // class of bug hides in the first place
  const n60 = naive(0.08, 0.1, 1 / 60), n360 = naive(0.08, 0.1, 1 / 360);
  ok(n360 - n60 > 0.3,
     `whereas a bare per-frame lerp converges far faster at 360 Hz (${n60.toFixed(2)} vs ${n360.toFixed(2)}) — the bug class being avoided`);
}

console.log("constants match the shipped source");
{
  const src = fs.readFileSync(path.join(__dirname, "ui", "index.html"), "utf8");
  ok(src.includes("const HIT_HOLD_S = 0.033"), "HIT_HOLD_S present at 0.033 s");
  ok(src.includes("R.hitTime = rawHit ? (R.hitTime || 0) + dt : 0"),
     "the hold accumulates dt, not frames");
  // the STATE, not the word — the comment above the fix names hitFrames deliberately, to
  // record what was wrong, and a test that forbids mentioning it would forbid the
  // explanation along with the bug
  ok(!/R\.hitFrames/.test(src), "and the frame-counted state is gone, not merely bypassed");
}

console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exit(fails ? 1 : 0);
