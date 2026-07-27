/* test_markfade.js — accumulated rubber fades over a duration, not a frame count.
 *
 * WHAT THIS IS ACTUALLY ABOUT, because the first diagnosis was wrong and that is the useful
 * part. `MARK_FADE_FRAMES = 900` was flagged as belonging to the frame-counted-duration bug
 * class — the one where a value tuned at 60 Hz behaves differently at 360 Hz. It does not.
 * `drawTireMarks` receives `tCur / ex.dt`, a REPLAY frame index, so the display's refresh rate
 * never entered into it. Checking before fixing is what found that, and "fixing" it as a
 * display-Hz bug would have changed a tuned look for no reason at all.
 *
 * The real defect is narrower and survives: `ex.dt` is `replay.intervalMs / 1000`, read from
 * each replay FILE. It varies between recordings. A frame count therefore means a different
 * number of seconds per replay, so a ghost recorded at a different rate than the reference car
 * faded its rubber at a different speed in the same scene — while both were, by construction,
 * meant to be showing the same thing.
 *
 * Both sample replays carry intervalMs 15 (66.67 Hz), which is why 900 frames is 13.5 s and
 * not the 15 s it looks like. The constant is that measured value, so the tuned look is
 * preserved exactly for these and only mixed-rate scenes change.
 *
 * Run: node test_markfade.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { uiFunction } = require("./testenv.js");

let fails = 0;
function ok(cond, msg) { if (!cond) { console.log("  FAIL " + msg); fails++; } }

const SMOKE = fs.readFileSync(path.join(__dirname, "ui", "smokesim.js"), "utf8");
const RENDER = fs.readFileSync(path.join(__dirname, "ui", "render.js"), "utf8");
const decomment = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/* ---- 1. the constant is a duration, and the old frame count is gone ---- */

const m = /const MARK_FADE_SECONDS = ([\d.]+)/.exec(SMOKE);
ok(m !== null, "the fade is declared in seconds");
const SECONDS = m ? parseFloat(m[1]) : 0;
ok(!/MARK_FADE_FRAMES/.test(decomment(SMOKE)),
   "no frame-count constant survives in code (the comment may still explain the history)");

/* ---- 2. it preserves the tuned look at the rate the sample replays actually use ---- */

// measured, not assumed: both replays in samples/ carry intervalMs 15
const SAMPLE_DT = 15 / 1000;
ok(Math.abs(SECONDS / SAMPLE_DT - 900) < 1e-6,
   `${SECONDS}s at the samples' 15 ms interval is the original 900 frames ` +
   `(got ${(SECONDS / SAMPLE_DT).toFixed(3)})`);

/* ---- 3. THE BUG: two replays at different rates must fade over the same SECONDS ---- */

// mirror of the one line that matters, tied to the real source below
const fadeFrames = (seconds, dt) => seconds / dt;
{
  const slow = fadeFrames(SECONDS, 1 / 30);      // a 30 Hz recording
  const fast = fadeFrames(SECONDS, 1 / 90);      // a 90 Hz recording
  ok(Math.abs(slow - fast) > 1,
     "different recording rates need different FRAME windows — which is why one constant was wrong");
  ok(Math.abs(slow * (1 / 30) - fast * (1 / 90)) < 1e-9,
     "and those different frame windows are the same number of seconds — the property that was broken");

  // the old behaviour, kept so the regression is visible rather than described
  const oldFrames = 900;
  ok(Math.abs(oldFrames * (1 / 30) - oldFrames * (1 / 90)) > 1,
     "a fixed frame count gave a 30 Hz replay a 3x longer fade than a 90 Hz one");
}

/* ---- 4. tie the mirror to the real source ---- */

const draw = uiFunction("drawTireMarks");
ok(draw !== null, "drawTireMarks is findable in the ui source");
if (draw) {
  const code = decomment(draw);
  ok(/function drawTireMarks\([^)]*\bdt\b[^)]*\)/.test(code),
     "drawTireMarks takes the car's own dt");
  ok(/markLoc\.fade,\s*MARK_FADE_SECONDS\s*\/\s*\w+/.test(code),
     "the fade uniform is seconds divided by that dt, not a bare constant");
  ok(!/markLoc\.fade,\s*\d/.test(code), "and never a literal frame count");
}

/* ---- 5. every call site passes a dt — a default would silently reintroduce the bug ---- */
{
  const calls = decomment(RENDER).match(/drawTireMarks\([^;]*?\)/g) || [];
  ok(calls.length >= 2, `render.js draws marks for the reference car and for ghosts (found ${calls.length})`);
  for (const c of calls) {
    const args = c.slice(c.indexOf("(") + 1, c.lastIndexOf(")")).split(",");
    ok(args.length === 8, `each call passes dt explicitly: ${c.slice(0, 60)}…`);
    ok(/\bdt\b/.test(args[args.length - 1]),
       `and the last argument is a dt, not a frame count: ${args[args.length - 1].trim()}`);
  }
  // the ghost path is the whole point: it must NOT reuse the reference car's dt
  ok(/g\.run\.ex\.dt/.test(RENDER),
     "the ghost passes its OWN replay's dt, not the reference car's");
}

console.log(fails ? `test_markfade: ${fails} FAILED` : "test_markfade: all pass");
process.exit(fails ? 1 : 0);
