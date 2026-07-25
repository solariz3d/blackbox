/* test_lampglare.js — a lamp SEEN, as distinct from a lamp lighting something.
 *
 * The two are different distances and the track configs say so: the T-180 test track
 * declares RANGE 180 m and FADE_AT 1000 m on a circuit 943 m across. So the requirement is
 * literally "visible from the far side of the track", and the failure it replaces —
 * lights that die fifty metres out — comes from treating one number as both.
 *
 * The pure maths of the sprite is mirrored here rather than imported, because it lives
 * inside a GL draw call in index.html. The mirror is the risk, so every constant it uses is
 * asserted against the real source file below; if index.html changes, this test fails
 * rather than quietly testing a copy of something that no longer exists.
 *
 * Run: node test_lampglare.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

let fails = 0;
function ok(cond, msg) { if (!cond) { console.log("  FAIL " + msg); fails++; } }

const MIN_PX = 2.5, MAX_PX = 70, NUDGE_M = 0.5, FALLOFF_EXP = 0.7;

/** brightness of a lamp's glare at distance d — mirrors drawTrackLampGlare */
function glare(d, fade, gate) {
  if (d > fade) return 0;
  return Math.pow(1 - d / fade, FALLOFF_EXP) * gate;
}
/** on-screen size in pixels, with the floor that keeps a distant lamp from vanishing */
function sizePx(d, intensity, Hpx, th) {
  const world = 0.55 + 0.22 * Math.min(4, intensity);
  return Math.max(MIN_PX, Math.min(MAX_PX, world * Hpx / (d * th)));
}

const Hpx = 1080, th = Math.tan(0.9 / 2);

console.log("the test track's own numbers: 180 m pool, 1000 m fade, 943 m circuit");
{
  const fade = 1000;
  // the complaint, restated as a number: at the far side of the track a lamp must still
  // be meaningfully bright, not a rounding error
  ok(glare(943, fade, 1) > 0.1, "a lamp across the whole track is still visible: " + glare(943, fade, 1).toFixed(3));
  // and it must not simply be uniform — a light 50 m away should read as nearer than one
  // at 900 m, or the depth cue is gone and the track looks like a flat sheet of dots
  ok(glare(50, fade, 1) > glare(900, fade, 1) * 2, "near lamps are clearly brighter than far ones");
  // the author's stated fade is respected exactly, with no pop at the boundary
  ok(glare(1000, fade, 1) === 0, "brightness reaches zero AT the declared fade, not past it");
  ok(glare(1001, fade, 1) === 0, "and stays zero beyond it");
  ok(glare(999, fade, 1) < 0.02, "approaching the fade it is already near zero, so nothing pops out of existence");
}

console.log("falloff is gentler than illumination, and that is the point");
{
  // Illumination falls off toward zero across its RANGE; glare must not, or the effect
  // collapses back into the thing being fixed. At half the fade distance a quadratic pool
  // is down to 25%; the glare should still be well over half.
  const quad = (1 - 0.5) * (1 - 0.5);
  ok(glare(500, 1000, 1) > 0.55, "at half the fade distance: glare " + glare(500, 1000, 1).toFixed(2) + " vs a quadratic pool's " + quad);
  ok(FALLOFF_EXP < 1, "the exponent is below 1, i.e. it holds up across the middle distances");
}

console.log("the pixel floor — the reason a distant lamp does not disappear");
{
  // An honest projection of a small fixture at 900 m is far below one pixel. That is
  // geometrically right and visually wrong: the eye receives a distant light's glare
  // rather than resolving its shape, so it stays plainly visible.
  const honest = (0.55 + 0.22 * 1) * Hpx / (900 * th);
  ok(honest < 2, "an unfloored sprite at 900 m is sub-pixel: " + honest.toFixed(2) + " px");
  ok(sizePx(900, 1, Hpx, th) === MIN_PX, "the floor holds it at " + MIN_PX + " px");
  ok(sizePx(2000, 1, Hpx, th) === MIN_PX, "and does not shrink further however far it gets");
  // sub-pixel sprites also shimmer as they cross the sample grid; the floor fixes the
  // flicker and the vanishing together
  ok(MIN_PX > 1, "the floor is above one pixel, so the sprite cannot alias in and out");
}

console.log("size still varies where it can be seen to vary");
{
  ok(sizePx(30, 1, Hpx, th) > sizePx(200, 1, Hpx, th), "a close lamp is bigger than a mid-distance one");
  ok(sizePx(1, 30, Hpx, th) <= MAX_PX, "and a lamp right at the camera is capped, not a screen-filling blob");
  // intensity is clamped before it reaches the size: CSP writes 28.76 on Miandros's
  // floodlights, and letting that scale the sprite directly gives a 6x wider lamp
  const big = sizePx(100, 28.76, Hpx, th), small = sizePx(100, 4, Hpx, th);
  ok(big === small, "intensity is clamped at 4, so a 28.76 floodlight is not 7x the sprite");
}

console.log("night gating");
{
  ok(glare(100, 1000, 0) === 0, "a night-only lamp contributes nothing by day");
  ok(glare(100, 1000, 0.5) > 0 && glare(100, 1000, 0.5) < glare(100, 1000, 1),
     "and fades up with the night factor rather than switching on");
}

console.log("the depth nudge");
{
  // The sprite sits at the lamp mesh's bounding-sphere CENTRE. At equal depth the fixture's
  // own front face wins the depth test and the lamp hides inside its own housing.
  const d = 200, k = NUDGE_M / d;
  const moved = d * k;
  ok(Math.abs(moved - NUDGE_M) < 1e-9, "the nudge is a constant " + NUDGE_M + " m toward the eye at any distance");
  ok(NUDGE_M < 1, "and under a metre, so glare cannot punch through a wall standing in front of the lamp");
}

/* ---------- the mirror is honest ---------- */

console.log("constants match the shipped source");
{
  const src = fs.readFileSync(path.join(__dirname, "ui", "index.html"), "utf8");
  const fn = src.slice(src.indexOf("function drawTrackLampGlare"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  ok(body.includes("0.7"), "falloff exponent 0.7 present in drawTrackLampGlare");
  ok(body.includes("2.5") && body.includes("70"), "pixel floor 2.5 and cap 70 present");
  ok(body.includes("0.55 + 0.22"), "world-size formula present");
  ok(body.includes("Math.min(4, L.intensity)"), "intensity clamp at 4 present");
  ok(body.includes("0.5 / d"), "half-metre depth nudge present");
  ok(body.includes("L.fadeAt || L.range"), "fades on FADE_AT, falling back to RANGE");
  ok(body.includes("gl.ONE"), "blend is additive");
  ok(body.includes("depthMask(false)"), "glare does not write depth");
  ok(body.includes("gl.DEPTH_TEST"), "but is still depth-tested, so it can be occluded");
}

console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exit(fails ? 1 : 0);
