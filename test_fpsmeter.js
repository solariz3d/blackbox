/* test_fpsmeter.js — the on-screen frame rate must not flatter itself.
 *
 * The old meter smoothed INSTANTANEOUS RATES: fps += (1000/dt - fps) * k. That is biased
 * high and cannot not be: rate is 1/dt, dt jitters, and by Jensen's inequality
 * mean(1/dt) > 1/mean(dt) for any non-constant dt. Worse, a duplicate timestamp
 * (dt = 0, clamped to 0.1 ms) injects a single sample worth 10,000 fps.
 *
 * Smoothing the FRAME TIME and inverting at the end has no such bias.
 *
 * Run: node test_fpsmeter.js
 */
"use strict";

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok " : "FAIL"} - ${m}`); if (!c) fails++; };

// the old meter, exactly as it was
function oldMeter(frameTimes, k = 0.08) {
  let fps = 0, prev = 0, t = 0;
  for (const dt of frameTimes) {
    t += dt;
    if (prev) fps += (1000 / Math.max(0.1, t - prev) - fps) * k;
    prev = t;
  }
  return fps;
}

// the new meter: smooth the frame time, invert once at the end
function newMeter(frameTimes, k = 0.08) {
  let ms = 0, prev = 0, t = 0;
  for (const dt of frameTimes) {
    t += dt;
    if (prev) {
      const d = t - prev;
      if (d > 0.05) ms = ms ? ms + (d - ms) * k : d;   // ignore coalesced/duplicate stamps
    }
    prev = t;
  }
  return ms ? 1000 / ms : 0;
}

/** n frames whose times average exactly `meanMs`, jittering by +/- `jitter` */
function frames(n, meanMs, jitter) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(meanMs + (i % 2 ? jitter : -jitter));
  return out;
}

console.log("\ntruth: frames averaging 6.94 ms are 144 fps, however they jitter");
{
  for (const j of [0, 1, 2, 3]) {
    const f = frames(4000, 6.944, j);
    const truth = 1000 / (f.reduce((a, b) => a + b, 0) / f.length);
    const o = oldMeter(f), n = newMeter(f);
    console.log(`   jitter +/-${j} ms   truth ${truth.toFixed(1)}   old ${o.toFixed(1)}   new ${n.toFixed(1)}`);
    // 3% allows for EMA RIPPLE — with an alternating input the average never fully settles,
    // and where it stops depends on the last sample's phase. That is bounded oscillation
    // around the truth, not bias: it does not grow with jitter the way the old meter does.
    ok(Math.abs(n - truth) < truth * 0.03, `new meter is within 3% of truth at jitter ${j} (${n.toFixed(1)})`);
    if (j > 0) ok(o > truth + 0.5, `old meter reads HIGH at jitter ${j} (by ${(o - truth).toFixed(1)} fps)`);
  }
}

console.log("\na single duplicate timestamp used to be worth 10,000 fps");
{
  // measure the PEAK, not the final value: the spike decays away over the following
  // frames, so reading only the end of the run misses the thing being tested. (First
  // version of this test did exactly that and passed the old meter.)
  const peak = (meter, f) => {
    let hi = 0;
    for (let i = 2; i < f.length; i++) hi = Math.max(hi, meter(f.slice(0, i)));
    return hi;
  };
  const f = frames(400, 6.944, 0);
  f[200] = 0;                       // two callbacks, same stamp
  const o = peak(oldMeter, f), n = peak(newMeter, f);
  ok(o > 300, `old meter spikes to ${o.toFixed(0)} fps on one duplicate`);
  ok(n < 170, `new meter shrugs it off (peak ${n.toFixed(1)} fps)`);
}

console.log("\nthe case that made it look like a lie: heavy jitter around a real 60");
{
  // a real stutter pattern: mostly fast frames, occasional long one. Average is 60 fps.
  const f = [];
  for (let i = 0; i < 4000; i++) f.push(i % 10 === 0 ? 78 : 14.7);
  const truth = 1000 / (f.reduce((a, b) => a + b, 0) / f.length);
  const o = oldMeter(f), n = newMeter(f);
  console.log(`   truth ${truth.toFixed(1)}   old ${o.toFixed(1)}   new ${n.toFixed(1)}`);
  ok(o > truth * 1.15, `old meter overstates a stuttering ${truth.toFixed(0)} fps as ${o.toFixed(0)}`);
  ok(Math.abs(n - truth) < truth * 0.12, "new meter stays near the truth the eye sees");
}

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall good");
process.exit(fails ? 1 : 0);
