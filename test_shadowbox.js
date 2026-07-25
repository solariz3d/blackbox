// test_shadowbox.js — the near shadow cascade must capture tall casters.
//
// The bug: buildLightVP derived its caster reach from R (eye at R*1.8, far at R*4), so
// tightening R for sharpness also shortened how far up-sun it looked for casters. At
// R=40 that was 71 m — the grandstand fell outside the near map, its shadow vanished
// inside the near cascade while the far cascade still had it, and the result was a lit
// rectangle with hard edges that tracked the car.
//
// buildLightVP lives in index.html's inline script, so it is extracted and evaluated
// against the real mathutil.js.        node test_shadowbox.js
const fs = require("fs");
const vm = require("vm");
const path = require("path");

let fails = 0;
function ok(cond, msg) { console.log(`  ${cond ? "ok " : "FAIL"} - ${msg}`); if (!cond) fails++; }

const ui = path.join(__dirname, "ui");
const sandbox = { Math, Float32Array, Float64Array, Array, console, window: {}, module: undefined };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ui, "mathutil.js"), "utf8"), sandbox, { filename: "mathutil.js" });

// pull buildLightVP + the reach constant straight out of the shipped page
const html = fs.readFileSync(path.join(ui, "index.html"), "utf8");
const fn = html.match(/function buildLightVP[\s\S]*?\n\}/);
const konst = html.match(/const SHADOW_CASTER_REACH\s*=\s*\d+;/);
if (!fn) { console.log("could not extract buildLightVP"); process.exit(2); }
vm.runInContext(fn[0], sandbox);
// `const` in a vm context is a lexical binding, NOT a property of the sandbox — read the
// literal out of the source instead, so the test can never silently run with reach
// undefined (which quietly re-tests the old behaviour and passes for the wrong reason).
if (!konst) { console.log("SHADOW_CASTER_REACH not found in index.html"); process.exit(2); }
sandbox.SHADOW_CASTER_REACH = Number(konst[0].match(/\d+/)[0]);
console.log(`  (extracted buildLightVP, SHADOW_CASTER_REACH = ${sandbox.SHADOW_CASTER_REACH} m)`);

// project a world point through a light view-projection into the shader's 0..1 depth space
function project(vp, p) {
  const m = vp, x = p[0], y = p[1], z = p[2];
  const cx = m[0]*x + m[4]*y + m[8]*z + m[12];
  const cy = m[1]*x + m[5]*y + m[9]*z + m[13];
  const cz = m[2]*x + m[6]*y + m[10]*z + m[14];
  const cw = m[3]*x + m[7]*y + m[11]*z + m[15] || 1;
  return { x: (cx/cw)*0.5+0.5, y: (cy/cw)*0.5+0.5, z: (cz/cw)*0.5+0.5 };
}
// the shader treats a fragment as inside a cascade when xy are in range and z < 1
const inside = c => c.x > 0 && c.x < 1 && c.y > 0 && c.y < 1 && c.z > 0 && c.z < 1;

const SUN = [0, 1, 0];          // straight overhead
const R = 40;                    // the tight near cascade
const CENTRE = [0, 0, 0];

console.log("\nthe regression: a tall caster up-sun");
{
  const old = sandbox.buildLightVP(SUN, R, CENTRE);                          // no reach = old behaviour
  const now = sandbox.buildLightVP(SUN, R, CENTRE, sandbox.SHADOW_CASTER_REACH);

  const grandstand = [0, 120, 0];        // a roof 120 m up — well past the old 71 m reach
  ok(!inside(project(old.vp, grandstand)), "OLD: a caster 120 m up-sun is clipped out (this WAS the bug)");
  ok(inside(project(now.vp, grandstand)), "NEW: the same caster is captured");

  const high = [0, 500, 0];
  ok(inside(project(now.vp, high)), "NEW: a caster 500 m up-sun is still captured");

  const beyond = [0, sandbox.SHADOW_CASTER_REACH + 50, 0];
  ok(!inside(project(now.vp, beyond)), "NEW: past the stated reach it does clip — the bound is real, not infinite");
}

console.log("\nwhat must not change");
{
  const now = sandbox.buildLightVP(SUN, R, CENTRE, sandbox.SHADOW_CASTER_REACH);
  ok(inside(project(now.vp, [0, 0, 0])), "the car itself, at the box centre, is inside");
  ok(inside(project(now.vp, [R * 0.9, 0, 0])), "ground just inside the box edge is inside");
  ok(!inside(project(now.vp, [R * 1.5, 0, 0])), "ground outside the box is outside (R still bounds sharpness)");
  ok(inside(project(now.vp, [0, -30, 0])), "geometry BELOW the car (dip, tunnel) is still covered");

  // resolution is what R buys, and it must be untouched by the reach change
  const tight = sandbox.buildLightVP(SUN, R, CENTRE, sandbox.SHADOW_CASTER_REACH);
  const wide  = sandbox.buildLightVP(SUN, R * 2, CENTRE, sandbox.SHADOW_CASTER_REACH);
  const p = [10, 0, 0];
  const dt = Math.abs(project(tight.vp, p).x - 0.5), dw = Math.abs(project(wide.vp, p).x - 0.5);
  ok(dt > dw * 1.8, "halving R still doubles the texel density — reach did not dilute sharpness");
}

console.log("\ndepth range is reported for the bias");
{
  const now = sandbox.buildLightVP(SUN, R, CENTRE, sandbox.SHADOW_CASTER_REACH);
  ok(typeof now.depth === "number" && now.depth > 0, `depth is returned (${now.depth} m)`);
  ok(now.depth >= sandbox.SHADOW_CASTER_REACH, "depth spans at least the reach");

  const old = sandbox.buildLightVP(SUN, R, CENTRE);
  ok(now.depth > old.depth * 3, "the box got much deeper — which is exactly why the bias had to become metric");

  // a far-cascade-sized box must report a much bigger range, or one bias would fit both
  const far = sandbox.buildLightVP(SUN, 1200, CENTRE);
  ok(far.depth > now.depth * 2, "a whole-track box reports a far larger depth than the near one");
}

console.log("\nlow sun (the case that makes shadows long)");
{
  const lowSun = [0.9, 0.15, 0];        // sun near the horizon
  const now = sandbox.buildLightVP(lowSun, R, CENTRE, sandbox.SHADOW_CASTER_REACH);
  ok(inside(project(now.vp, [0, 0, 0])), "box still centred on the car with a grazing sun");
  // a caster far away along the light direction is what casts the long shadow into the box
  const upSun = [0.9 * 300, 0.15 * 300, 0];
  ok(inside(project(now.vp, upSun)), "a caster 300 m up-sun at low elevation is captured");
}

console.log(fails ? `\n${fails} FAILED` : "\nALL GREEN");
process.exit(fails ? 1 : 0);
