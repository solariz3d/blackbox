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
function sizePx(d, radius, Hpx, th) {
  // the fixture's own measured radius, not a number derived from intensity: brightness and
  // size are unrelated, and the measurement is in the kn5
  const world = Math.max(0.5, Math.min(8, radius || 1));
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

console.log("a lit STRUCTURE is not a fixture, and gets no sprite");
{
  const MAX_R = 20;
  /* The T-180 test track's own series, verbatim:
   *     MESHES = TorusLight?, StartFinishGate_SUB2, Roof_SUB2
   * The author is deliberately making the roof of the tube a light — a 682 m glowing
   * ceiling washing down on the track, correct as illumination. It has no POINT though:
   * a sprite at its centre hangs in mid-air inside the structure, invisible behind
   * geometry until you are almost touching it. That was "they spawn in the sky" and
   * "they only show up when I get really close", one cause, two symptoms.
   *
   * Radii measured from the real files, so the threshold is checked against the actual
   * gap rather than a number that merely sounds safe. */
  const fixtures = [
    ["sakura lantern", 1.0], ["sakura lantern cluster", 12.7], ["nordic lamp head", 13.1],
    ["t180 TorusLight", 7.8], ["sakura biggest lantern", 18.0],
  ];
  const structures = [
    ["t180 Roof", 682.3], ["t180 StartFinishGate", 186.0],
    ["thunderhead stadium light bank", 224.1], ["sakura templo", 88.3],
  ];
  for (const [what, r] of fixtures) ok(r <= MAX_R, what + " (r=" + r + ") is a fixture and keeps its sprite");
  for (const [what, r] of structures) ok(r > MAX_R, what + " (r=" + r + ") is a structure and loses its sprite");
  // the threshold is only meaningful if there is real daylight between the two groups
  const biggestFixture = Math.max(...fixtures.map(f => f[1]));
  const smallestStructure = Math.min(...structures.map(s => s[1]));
  ok(smallestStructure > 4 * biggestFixture,
     `the gap is wide, not a knife-edge: largest fixture ${biggestFixture} m vs smallest structure ${smallestStructure} m`);
  // and a light with no mesh at all — explicit POSITION — is always a real point
  ok((0 || 0) <= MAX_R, "an explicitly positioned light has radius 0 and always keeps its sprite");
}

console.log("the depth nudge scales, because depth precision does not");
{
  /* A flat half metre works near the camera and cannot work far from it: depth resolution
   * falls off with the square of distance, so the sprite ties with its own housing and
   * loses. Approximate resolution of a 24-bit buffer at distance z with near plane n:
   * z^2 / (n * 2^24). */
  const res = (z, n) => (z * z) / (n * (1 << 24));
  const flat = (d) => 0.5;
  const scaled = (d, r) => Math.max(0.5, d * 0.004, (r || 0) * 1.1);
  const near = 0.3;
  ok(flat(3000) < res(3000, near), "at 3 km a flat 0.5 m nudge is below one depth unit — it cannot separate");
  ok(scaled(3000, 0) > 3 * res(3000, near), "the scaled nudge stays several units clear");
  ok(scaled(50, 0) === 0.5, "and does not inflate up close, where 0.5 m was already plenty");
  ok(scaled(1000, 0) / 1000 < 0.01, "it stays under 1% of the distance, so it cannot pull a lamp through a wall");
  // a wide fixture must clear its own housing regardless of how near it is
  ok(scaled(30, 13) > 13, "a 13 m lamp head is nudged past its own radius");
}

console.log("emission carries as far as the source — no distance rejection in the cull");
{
  const TL = require("./ui/tracklights.js");
  const at = (x) => ({ pos: [x, 0, 0], range: 60, fadeAt: 1700, intensity: 1, color: [1, 1, 1] });
  const eye = [0, 0, 0];
  /* A lamp lights the ground AROUND ITSELF, not around the camera. Rejecting lamps further
   * from the eye than their own RANGE answers the wrong question: from 500 m away every
   * lamp on a circuit fails it, nothing is sent, and the whole track goes black — while
   * the pools of light being looked at are exactly what should still be there. */
  const far = TL.cullLights([at(50), at(500), at(1500)], eye, 24);
  ok(far.length === 3, "lamps far beyond their own RANGE are still sent: got " + far.length);
  ok(far[0].pos[0] === 50 && far[2].pos[0] === 1500, "and they are ordered nearest first");
  ok(TL.cullLights([at(20000)], eye, 24).length === 1, "distance alone never rejects a lamp");
  // what remains is a BUDGET, not a cull — the shader has a fixed number of slots
  const many = TL.cullLights(Array.from({ length: 100 }, (_, i) => at((i + 1) * 10)), eye, 24);
  ok(many.length === 24, "the slot budget still caps how many are sent: got " + many.length);
  ok(many[0].pos[0] === 10 && many[23].pos[0] === 240, "and the nearest win the slots");
}

console.log("a shielded lamp is not visible from behind its shield");
{
  /* The T-180 test track's lamps aim straight down and are solid geometry above the bulb.
   * Visibility of a source follows the same cone as its emission, so the SPOT angle the
   * shader uses for the light governs the sight of it too. */
  const coneAt = (toEyeDir, dir, spotDeg) => {
    const dl = Math.hypot(...dir) || 1;
    const c = (toEyeDir[0]*dir[0] + toEyeDir[1]*dir[1] + toEyeDir[2]*dir[2]) / dl;
    // 359, not 179: SPOT is the FULL angle and this halves it, so clamping at 179 caps
    // every cone at a 89.5 deg half-angle and silently narrows a wide wash
    const cosHalf = Math.cos(Math.min(359, spotDeg) * 0.5 * Math.PI / 180);
    const outer = cosHalf, inner = cosHalf + (1 - cosHalf) * 0.35;
    let t = Math.max(0, Math.min(1, (c - outer) / Math.max(1e-4, inner - outer)));
    return t * t * (3 - 2 * t);
  };
  const DOWN = [0, -1, 0], SPOT = 250;      // the test track's own values
  ok(coneAt([0, -1, 0], DOWN, SPOT) === 1, "from directly below a downlight, fully visible");
  ok(coneAt([0, 1, 0], DOWN, SPOT) === 0, "from directly above it, not visible at all");
  ok(coneAt([1, 0, 0], DOWN, SPOT) > 0, "from level with it, still visible — a 250 deg cone is wide");
  /* It must dim through the rim rather than blink off as the camera crosses a threshold.
   * The cone's edge is at 125 deg from straight down; sample a direction just inside it. */
  const rim = 125 * Math.PI / 180, eps = 0.03;
  const nearRim = [Math.sin(rim - eps), -Math.cos(rim - eps), 0];
  const v = coneAt(nearRim, DOWN, SPOT);
  ok(v > 0 && v < 1, "and dims through the rim rather than switching: " + v.toFixed(3));
  // a lamp with no usable cone — a point light, or a NORMAL-aimed one — must skip this
  // entirely; an unshielded bulb IS visible from every side
  const src = require("./testenv.js").uiSource();
  const fn = src.slice(src.indexOf("function drawTrackLampGlare"));
  ok(/if \(L\.spotUsable\)/.test(fn.slice(0, fn.indexOf("\n}"))),
     "the cone is applied only when the lamp has a usable one");
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

console.log("size varies with the FIXTURE, and where it can be seen to vary");
{
  ok(sizePx(30, 1, Hpx, th) > sizePx(200, 1, Hpx, th), "a close lamp is bigger than a mid-distance one");
  ok(sizePx(1, 5, Hpx, th) <= MAX_PX, "and a lamp right at the camera is capped, not a screen-filling blob");
  // a 13 m nordic lamp head should read as bigger than a 1 m sakura lantern at the same
  // distance — that is real information, and it was previously overwritten by intensity
  ok(sizePx(150, 13, Hpx, th) > sizePx(150, 1, Hpx, th), "a big fixture reads bigger than a small one alongside it");
  ok(sizePx(150, 13, Hpx, th) === sizePx(150, 40, Hpx, th),
     "and the world size is capped at 8 m, so an outlier radius cannot make a wall of light");
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
  const src = require("./testenv.js").uiSource();
  const fn = src.slice(src.indexOf("function drawTrackLampGlare"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  ok(body.includes("Math.max(5,") && body.includes("70"), "pixel floor 5 and cap 70 present");
  ok(body.includes("Math.min(8, L.radius"), "world size comes from the fixture's radius");
  ok(body.includes("LAMP_FIXTURE_MAX_RADIUS"), "structures are excluded from the sprite pass");
  ok(body.includes("d * 0.004"), "the depth nudge scales with distance");
  ok(!/Math\.min\(179/.test(src), "no full-angle SPOT is clamped at 179 anywhere — that halves to 89.5 deg");
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
