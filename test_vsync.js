/* test_vsync.js — frame time is QUANTISED, and an average of it lies.
 *
 * Reported from the T-180 test track: "we are always over budget, lowest is 2.9" on a 360 Hz
 * panel whose budget is 2.78 ms. Read as a percentage that is 104% — a 4% overrun, and four
 * percent of work to go and find. There is no such work.
 *
 * With vsync on, a frame lasts one refresh period or two. 2.78 ms or 5.56 ms. Never 2.9. So
 * an AVERAGE of 2.9 cannot describe any frame that happened; it is what you get from being
 * exactly on budget almost always and doubling occasionally. The average is the artefact
 * and the dropped frame is the event, which is why the HUD counts lost refresh periods
 * instead of reporting a ratio.
 *
 * Run: node test_vsync.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

let fails = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL " + m); fails++; } };

/* Lost refresh periods for one frame — mirrors the counter in the loop.
 *
 * Round to the NEAREST whole number of periods, then subtract the one the frame was
 * entitled to. My first version was round(dt/bud - 0.5), which is off by one at every
 * boundary: at exactly one period it gives round(0.5) = 1 and reports a lost frame on a
 * perfect one. The test below caught it before it shipped, which is the only reason this
 * comment is about arithmetic rather than about a HUD that cried wolf every frame. */
const missed = (dtMs, budMs) => Math.max(0, Math.round(dtMs / budMs) - 1);

const BUD = 1000 / 360;   // 2.7778 ms

console.log("the 2.9 ms average, explained");
{
  /* The claim under test: one doubled frame in twenty-five produces exactly the reported
   * average. If this arithmetic is wrong the whole diagnosis is wrong, so it is checked
   * rather than asserted in prose. */
  const frames = Array(24).fill(BUD).concat([BUD * 2]);
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  ok(Math.abs(avg - 2.89) < 0.01, `24 clean frames + 1 doubled averages ${avg.toFixed(3)} ms — the reported 2.9`);
  ok(avg > BUD, "so the average sits above budget while 24 of 25 frames were perfectly on time");
  // and the percentage that average produces is the misleading number
  ok(Math.abs(100 * avg / BUD - 104) < 1, `which reads as ${(100 * avg / BUD).toFixed(0)}% of budget — implying 4% to shave`);
}

console.log("counting events instead: what the same second actually lost");
{
  const frames = Array(24).fill(BUD).concat([BUD * 2]);
  const lost = frames.reduce((n, f) => n + missed(f, BUD), 0);
  ok(lost === 1, `one lost refresh period, not a 4% overrun (got ${lost})`);
}

console.log("jitter around an on-time frame is not a miss");
{
  // rAF timestamps are not exact. A frame that arrives on time can measure a little either
  // side of the period, and counting that as a drop would report constant misses on a
  // perfectly smooth run — the same false-alarm failure as the percentage.
  for (const j of [-0.3, -0.1, 0, 0.1, 0.3, 0.5, 1.0]) {
    ok(missed(BUD + j, BUD) === 0, `${(BUD + j).toFixed(2)} ms measures as no loss (jitter ${j > 0 ? "+" : ""}${j})`);
  }
  // the reported "lowest 2.9" is exactly this case and must not count
  ok(missed(2.9, BUD) === 0, "2.9 ms on a 2.78 ms panel lost nothing");
}

console.log("real drops are counted, and counted correctly");
{
  ok(missed(BUD * 2, BUD) === 1, "a doubled frame loses one period");
  ok(missed(BUD * 3, BUD) === 2, "a tripled frame loses two");
  ok(missed(8.2, BUD) === 2, "the reported 8.2 ms spike lost two periods");
  ok(missed(14, BUD) === 4, "the reported 14 ms spike lost four");
  // the boundary sits halfway, so a frame is attributed to the nearer period
  ok(missed(BUD * 1.4, BUD) === 0, "1.4 periods rounds to on-time");
  ok(missed(BUD * 1.6, BUD) === 1, "1.6 periods rounds to one lost");
}

console.log("the same code answers correctly on a 60 Hz panel");
{
  // the other monitor on this desk. A fixed millisecond threshold would be meaningless
  // across the pair; a period count is the same idea at both rates.
  const B60 = 1000 / 60;
  ok(missed(16.7, B60) === 0, "16.7 ms is one clean frame at 60 Hz");
  ok(missed(33.3, B60) === 1, "33.3 ms loses one");
  // and the frame that was a 4-period disaster at 360 Hz is nearly fine at 60
  ok(missed(14, B60) === 0, "14 ms — four lost periods at 360 Hz — loses nothing at 60 Hz");
}

console.log("constants match the shipped source");
{
  const src = require("./testenv.js").uiSource();
  ok(src.includes("Math.round(dtMs / frameBudgetMs()) - 1"), "the round-to-nearest-period rule is in the loop");
  ok(!src.includes("frameBudgetMs() - 0.5"), "and the off-by-one version has not come back");
  ok(src.includes("missed ${vsyncMissedShown}/s"), "the HUD reports missed periods per second");
  ok(!/budget \$\{frameMsEMA \? \(100 \* frameMsEMA/.test(src),
     "and the misleading budget percentage is gone");
}

console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exit(fails ? 1 : 0);
