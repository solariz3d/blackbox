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

const MIN_PX = 5, MAX_PX = 70, NUDGE_M = 0.5;

/** brightness of a lamp's glare at distance d — mirrors drawTrackLampGlare.
 *  `d` is accepted and deliberately unused: a light source is visible at whatever distance
 *  you can see it, and every earlier version of this feature failed by making brightness a
 *  function of distance — first RANGE, then FADE_AT, then a floor under FADE_AT. */
function glare(d, _declaredFade, gate) { return gate; }
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

console.log("a light source has no distance limit — the source, not its emission");
{
  // The T-180 test track: 180 m pool, 1000 m declared fade, 943 m circuit. None of those
  // numbers may bound whether the lamp is SEEN.
  ok(glare(943, 1000, 1) === 1, "a lamp across the whole circuit is at full brightness");
  ok(glare(5000, 1000, 1) === 1, "and so is one five kilometres out — past every declared fade");
  ok(glare(50, 1000, 1) === glare(5000, 1000, 1),
     "near and far are equally bright; SIZE is what separates them, as with real lights");
  // Miandros declares 250 m on floodlights standing 100 m in the air — a statement about
  // processing cost, not about whether a stadium light can be seen from the far straight.
  ok(glare(900, 250, 1) === 1, "a short declared FADE_AT does not dim the source either");
  // the regression this replaces: every previous version made brightness a function of
  // distance, and each time the answer was "still not far enough"
  for (const d of [100, 500, 943, 2000, 10000]) {
    ok(glare(d, 1000, 1) > 0.99, "no falloff at " + d + " m");
  }
}

console.log("illumination stays local — the other half of the separation");
{
  const TL = require("./ui/tracklights.js");
  const at = (x) => ({ pos: [x, 0, 0], range: 60, fadeAt: 1700, intensity: 1, color: [1, 1, 1] });
  const eye = [0, 0, 0];
  // a sakura lamp declares RANGE 60 and FADE_AT 1700. It must be SEEN from 1700 m — that
  // is the glare pass above — and must not be handed to the shader as a light source from
  // there, where its falloff is exactly zero and it would occupy one of twelve slots.
  const kept = TL.cullLights([at(50), at(500), at(1500)], eye, 12);
  ok(kept.length === 1, "only the lamp within RANGE(+margin) is sent to the shader: got " + kept.length);
  ok(kept[0].pos[0] === 50, "and it is the near one");
  // the margin exists so a lamp does not blink out of the sent set the instant it passes
  // its own range boundary
  ok(TL.cullLights([at(85)], eye, 12).length === 1, "a small margin past RANGE is kept");
  ok(TL.cullLights([at(200)], eye, 12).length === 0, "but well past it, no");
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
  ok(body.includes("Math.max(5,") && body.includes("70"), "pixel floor 5 and cap 70 present");
  ok(body.includes("0.55 + 0.22"), "world-size formula present");
  ok(body.includes("Math.min(4, L.intensity)"), "intensity clamp at 4 present");
  ok(body.includes("0.5 / d"), "half-metre depth nudge present");
  // the load-bearing negative: no distance term may creep back into brightness
  ok(!/const b = [^;]*\bd\b/.test(body), "brightness does not reference distance");
  ok(!body.includes("fadeAt"), "and the glare pass does not consult FADE_AT at all");
  ok(!/if \(d > /.test(body), "no distance cull");
  ok(/blendFunc\(gl\.ONE,\s*gl\.ONE\)/.test(body),
     "blend is PREMULTIPLIED additive — SRC_ALPHA here squares an already-premultiplied colour");
  ok(!/blendFunc\(gl\.SRC_ALPHA/.test(body), "and the quadratic blend has not come back");
  ok(body.includes("depthMask(false)"), "glare does not write depth");
  ok(body.includes("gl.DEPTH_TEST"), "but is still depth-tested, so it can be occluded");
}

console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exit(fails ? 1 : 0);
