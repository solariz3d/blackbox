/* test_turbinegate.js — the turbine plume is gated to a straight or a slide.
 *
 * The chair's rule: keep the turbine low unless there is lots of angle, or a straight
 * line. Through an ordinary corner a plume burning flat-out stops meaning anything.
 *
 * pathRadius and turbineGate live in index.html's inline script, so they are extracted and
 * run against synthetic paths where the right answer is known by construction.
 *
 * Run: node test_turbinegate.js
 */
"use strict";

const fs = require("fs");
const vm = require("vm");
const path = require("path");

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok " : "FAIL"} - ${m}`); if (!c) fails++; };

const html = fs.readFileSync(path.join(__dirname, "ui", "index.html"), "utf8");
const grab = (name) => {
  const m = html.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  if (!m) { console.log(`could not extract ${name}`); process.exit(2); }
  return m[0];
};
const consts = [...html.matchAll(/^(?:let|const) (TURBINE_\w+) = ([\d.]+);/gm)]
  .map(m => `var ${m[1]} = ${m[2]};`).join("\n");

const sandbox = { Math, Infinity, console };
vm.createContext(sandbox);
vm.runInContext(consts + "\n" + grab("pathRadius") + "\n" + grab("turbineGate"), sandbox);
console.log(`  (idle ${sandbox.TURBINE_IDLE}, slip ${sandbox.TURBINE_SLIP_ON}-${sandbox.TURBINE_SLIP_FULL} deg,` +
            ` radius ${sandbox.TURBINE_CORNER_R}-${sandbox.TURBINE_STRAIGHT_R} m)`);

/** a run at constant speed along an arc of the given radius; Infinity = dead straight */
function arcRun(radius, slipDeg, N = 400, dt = 0.05, speed = 60) {
  const pos = new Float64Array(N * 3);
  const step = speed * dt;
  for (let i = 0; i < N; i++) {
    if (!isFinite(radius)) { pos[i*3] = 0; pos[i*3+2] = i * step; continue; }
    const th = (i * step) / radius;
    pos[i*3] = radius * (1 - Math.cos(th));
    pos[i*3+2] = radius * Math.sin(th);
  }
  const slip = new Float32Array(N * 4).fill(slipDeg);
  return { N, dt, pos, slip, gap: new Uint8Array(N), speed: new Float32Array(N).fill(speed * 3.6) };
}

console.log("\npath radius is measured, not guessed");
{
  const straight = sandbox.pathRadius(arcRun(Infinity, 0), 200);
  ok(!isFinite(straight) || straight > 5000, `a straight line reads as huge radius (${straight})`);
  for (const R of [60, 150, 400]) {
    const got = sandbox.pathRadius(arcRun(R, 0), 200);
    ok(Math.abs(got - R) / R < 0.12, `a ${R} m arc measures ${got.toFixed(0)} m (within 12%)`);
  }
}

console.log("\nthe gate: low in a corner, full on a straight or in a slide");
{
  const at = (R, slip) => sandbox.turbineGate(200, arcRun(R, slip));
  const corner = at(70, 0), straight = at(Infinity, 0), slide = at(70, 40);

  ok(Math.abs(corner - sandbox.TURBINE_IDLE) < 1e-6, `an ordinary corner sits at idle (${corner.toFixed(2)})`);
  ok(straight > 0.95, `a straight opens it fully (${straight.toFixed(2)})`);
  ok(slide > 0.95, `a big slide opens it fully even mid-corner (${slide.toFixed(2)})`);
  ok(slide > corner, "sliding through a corner beats tracking through it");

  // the whole point: it must not be open everywhere
  ok(corner < 0.5, "it is genuinely LOW somewhere, or the gate would be decoration");
  const mid = at(150, 0);
  ok(mid > corner && mid < straight, `a fast sweeper lands between the two (${mid.toFixed(2)})`);
}

console.log("\nboundaries");
{
  const at = (R, slip) => sandbox.turbineGate(200, arcRun(R, slip));
  ok(at(Infinity, 0) >= at(400, 0), "straighter is never less open");
  ok(at(70, 50) >= at(70, 20), "more slip is never less open");
  ok(at(70, 0) >= sandbox.TURBINE_IDLE - 1e-9, "never falls below the idle floor");
  ok(at(Infinity, 90) <= 1.0, "never exceeds full");
  const flat = sandbox.turbineGate(200, arcRun(Infinity, 0, 400, 0.05, 0));   // stationary
  ok(isFinite(flat), `a stationary car does not produce NaN (${flat})`);
}

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall good");
process.exit(fails ? 1 : 0);
