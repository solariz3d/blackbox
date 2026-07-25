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

const MIN_PX = 5, MAX_PX = 70, NUDGE_M = 0.5, FALLOFF_EXP = 0.45, MIN_REACH = 1500;

/** brightness of a lamp's glare at distance d — mirrors drawTrackLampGlare */
function glare(d, declaredFade, gate) {
  // FADE_AT is a cost hint, not a visibility limit — Miandros declares 250 m on lamps 100 m
  // in the air. The glare uses the larger of the author's number and our floor.
  const fade = Math.max(declaredFade, MIN_REACH);
  if (d > fade) return 0;
  return Math.pow(1 - d / fade, FALLOFF_EXP) * gate;
}
/** what actually reaches the framebuffer, given the blend mode — the bug lived HERE */
function contribution(b, blendSrcIsAlpha) {
  const a = b;                       // sprite centre: core 1.0, halo 0.42, before shaping
  return blendSrcIsAlpha ? a * a : a;
}
/** on-screen size in pixels, with the floor that keeps a distant lamp from vanishing */
function sizePx(d, intensity, Hpx, th) {
  const world = 0.55 + 0.22 * Math.min(4, intensity);
  return Math.max(MIN_PX, Math.min(MAX_PX, world * Hpx / (d * th)));
}

const Hpx = 1080, th = Math.tan(0.9 / 2);

console.log("premultiplied blend — the bug that made the first version reach nowhere");
{
  /* The fragment outputs vec4(colour*a, a), i.e. already premultiplied. Blending with
   * SRC_ALPHA multiplies by a a second time, so the contribution goes quadratic. Harmless
   * near the camera where a is close to 1, and ruinous exactly where this feature earns
   * its keep. This is the assertion that would have caught it. */
  /* The cost of the extra multiply is exactly 1/a, so it is stated against brightness
   * rather than against any particular distance — the falloff has since been retuned and
   * the property must not be pinned to numbers that moved. */
  const dim = 0.2, bright = 0.95;
  ok(Math.abs(contribution(dim, false) / contribution(dim, true) - 5) < 1e-9,
     "a lamp at 0.2 brightness lost a factor of 5 to the second multiply");
  ok(contribution(bright, false) / contribution(bright, true) < 1.06,
     "and one at 0.95 lost almost nothing — which is why the bug hid in plain sight");
  ok(contribution(dim, false) === dim, "premultiplied output reaches the framebuffer unchanged");
}

console.log("the test track's own numbers: 180 m pool, 1000 m declared fade, 943 m circuit");
{
  const fade = 1000;
  // the complaint, restated as a number: at the far side of the track a lamp must still
  // be plainly bright — not merely non-zero, which the first version technically was
  ok(glare(943, fade, 1) > 0.6, "a lamp across the whole track is still strong: " + glare(943, fade, 1).toFixed(3));
  ok(glare(500, fade, 1) > 0.8, "and at mid-distance it has barely dropped: " + glare(500, fade, 1).toFixed(3));
  // it must not be flat either — a light 50 m away should read as nearer than one at
  // 900 m, or the depth cue is gone and the track becomes a sheet of identical dots
  ok(glare(50, fade, 1) > glare(900, fade, 1) * 1.15, "near lamps still read as nearer than far ones");
  // and it does end, without a pop at the boundary
  ok(glare(MIN_REACH, fade, 1) === 0, "brightness reaches zero at the reach");
  ok(glare(MIN_REACH + 1, fade, 1) === 0, "and stays zero beyond it");
  ok(glare(MIN_REACH - 1, fade, 1) < 0.05, "approaching it, already near zero — nothing pops out of existence");
}

console.log("the reach floor overrides a short FADE_AT, deliberately");
{
  // Miandros declares 250 m on floodlights standing 100 m in the air. That is a statement
  // about processing cost, not about whether a stadium light can be seen from the far
  // straight, and taking it literally is what left tracks dark past the next corner.
  ok(glare(900, 250, 1) > 0.5, "a Miandros floodlight is visible from 900 m: " + glare(900, 250, 1).toFixed(2));
  // a LONGER declared fade is still respected — the floor only ever raises
  ok(glare(1900, 2000, 1) > 0, "nordic's declared 2000 m is not clipped back to the floor");
  ok(glare(1900, 250, 1) === 0, "while a short one is raised to the floor, not to infinity");
}

console.log("falloff is gentler than illumination, and that is the point");
{
  // Illumination falls off toward zero across its RANGE; glare must not, or the effect
  // collapses back into the thing being fixed. At half the reach a quadratic pool is down
  // to 25%; the glare should still be holding most of its strength.
  const quad = (1 - 0.5) * (1 - 0.5);
  ok(glare(750, 1000, 1) > 0.7, "at half the reach: glare " + glare(750, 1000, 1).toFixed(2) + " vs a quadratic pool's " + quad);
  ok(FALLOFF_EXP < 0.6, "the exponent is well below 1, i.e. it holds up right across a circuit");
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
  // 2.5 px was arithmetically sufficient and visually still nothing — a dot that small at
  // a fraction of full brightness reads as a stuck sensor pixel, not a light
  ok(MIN_PX >= 4, "and it is large enough to read AS a light, not merely to exist");
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
  ok(body.includes("0.45"), "falloff exponent 0.45 present in drawTrackLampGlare");
  ok(body.includes("Math.max(5,") && body.includes("70"), "pixel floor 5 and cap 70 present");
  ok(body.includes("0.55 + 0.22"), "world-size formula present");
  ok(body.includes("Math.min(4, L.intensity)"), "intensity clamp at 4 present");
  ok(body.includes("0.5 / d"), "half-metre depth nudge present");
  ok(body.includes("L.fadeAt || L.range"), "fades on FADE_AT, falling back to RANGE");
  ok(body.includes("LAMP_GLARE_MIN_REACH"), "and raises a short fade to the reach floor");
  ok(/blendFunc\(gl\.ONE,\s*gl\.ONE\)/.test(body),
     "blend is PREMULTIPLIED additive — SRC_ALPHA here squares an already-premultiplied colour");
  ok(!/blendFunc\(gl\.SRC_ALPHA/.test(body), "and the quadratic blend has not come back");
  ok(body.includes("depthMask(false)"), "glare does not write depth");
  ok(body.includes("gl.DEPTH_TEST"), "but is still depth-tested, so it can be occluded");
}

console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exit(fails ? 1 : 0);
