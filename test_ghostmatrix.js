// test_ghostmatrix.js — carModelMatrix must be PURE per car.
//
// The bug this locks out: carModelMatrix used to assign the global carSteerAngle as a
// side effect, so drawing a second car overwrote the first car's steering and every
// ghost ended up wearing the last one's wheels. It now returns {mat, steer}.
//
// carrender.js is a classic script with no exports, so it is evaluated in a vm sandbox
// holding the globals it reads at call time.   node test_ghostmatrix.js
const fs = require("fs");
const vm = require("vm");
const path = require("path");

let fails = 0;
function ok(cond, msg) { console.log(`  ${cond ? "ok " : "FAIL"} - ${msg}`); if (!cond) fails++; }
function near(a, b, eps, msg) { ok(Math.abs(a - b) <= eps, `${msg}  (${a.toFixed(5)} ~= ${b.toFixed(5)})`); }

const sandbox = { Math, Float32Array, Float64Array, Uint8Array, console,
                  carSlipExag: 1.0, carLift: 0, carSteerAngle: 999, ex: null, driverRig: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "ui", "carrender.js"), "utf8"), sandbox,
                { filename: "carrender.js" });

/* A run travelling in a straight line along `travel`, with the body pointed along
 * `heading`. The angle between them is the slip the front wheels should steer to. */
function straightRun(travelDeg, headingDeg, N) {
  N = N || 60;
  const rad = d => d * Math.PI / 180;
  const t = [Math.sin(rad(travelDeg)), 0, Math.cos(rad(travelDeg))];
  const h = [Math.sin(rad(headingDeg)), 0, Math.cos(rad(headingDeg))];
  const pos = new Float64Array(N * 3), nrm = new Float32Array(N * 3), fwd = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i*3] = t[0] * i; pos[i*3+1] = 0; pos[i*3+2] = t[2] * i;   // 1 m per frame along travel
    nrm[i*3+1] = 1;                                                // flat road, up = +Y
    fwd[i*3] = h[0]; fwd[i*3+1] = h[1]; fwd[i*3+2] = h[2];
  }
  return { N, dt: 0.05, pos, nrm, fwd, gap: new Uint8Array(N) };
}

console.log("\nreturn shape");
{
  sandbox.ex = straightRun(0, 0);
  const r = sandbox.carModelMatrix(20);
  ok(r && typeof r === "object" && !(r instanceof Float32Array), "returns an object, not a bare matrix");
  ok(r.mat instanceof Float32Array && r.mat.length === 16, "carries a 16-float model matrix");
  ok(typeof r.steer === "number" && isFinite(r.steer), "carries a finite steer angle");
}

console.log("\nsteer follows the slip angle");
{
  sandbox.ex = straightRun(0, 0);
  near(sandbox.carModelMatrix(20).steer, 0, 1e-6, "travelling straight ahead needs no steering");

  // body pointed straight, car actually travelling 30 deg off — wheels point at the line
  sandbox.ex = straightRun(30, 0);
  const s30 = sandbox.carModelMatrix(20).steer;
  near(Math.abs(s30), 30 * Math.PI / 180, 1e-3, "a 30 deg slip steers the wheels 30 deg");

  sandbox.ex = straightRun(-30, 0);
  const sm30 = sandbox.carModelMatrix(20).steer;
  ok(Math.sign(sm30) === -Math.sign(s30), "sliding the other way steers the other way");

  // the T-180 crabs past 90 and the wheels are supposed to follow all the way round
  sandbox.ex = straightRun(120, 0);
  ok(isFinite(sandbox.carModelMatrix(20).steer), "a slip beyond 90 deg still produces a finite angle");
}

console.log("\nTHE REGRESSION: two ghosts must not share one steer");
{
  sandbox.carSteerAngle = 999;

  sandbox.ex = straightRun(0, 0);
  const straight = sandbox.carModelMatrix(20);
  sandbox.ex = straightRun(30, 0);
  const crabbed = sandbox.carModelMatrix(20);

  ok(sandbox.carSteerAngle === 999, "carModelMatrix writes NO app global (the old bug)");
  ok(Math.abs(straight.steer - crabbed.steer) > 0.4, "two runs report genuinely different steer");
  near(straight.steer, 0, 1e-6, "and the first car's steer survives the second car being drawn");
}

console.log("\nexplicit run argument");
{
  const a = straightRun(0, 0), b = straightRun(30, 0);
  sandbox.ex = a;                                   // primary is the straight run
  const viaArg = sandbox.carModelMatrix(20, b);     // ...but ask for the crabbed one
  const viaGlobal = sandbox.carModelMatrix(20);
  ok(Math.abs(viaArg.steer - viaGlobal.steer) > 0.4, "src argument selects the run, overriding the primary");
  near(viaGlobal.steer, 0, 1e-6, "omitting src still falls back to the primary run");

  // position must come from the requested run too, not just the steer
  const pa = sandbox.carModelMatrix(20, a).mat, pb = sandbox.carModelMatrix(20, b).mat;
  ok(Math.abs(pa[12] - pb[12]) > 1e-6, "the matrix translation also comes from the requested run");
}

console.log("\ndriverPose takes its ghost's steer");
{
  sandbox.ex = straightRun(0, 0);
  sandbox.carSteerAngle = 0;
  sandbox.driverRig = { headYaw: 0, headRoll: 0, headBob: [0,0,0], bodyLean: 0, bodyTwist: 0 };
  const hasRig = typeof sandbox.driverPose === "function";
  ok(hasRig, "driverPose is defined");
  if (hasRig) {
    const sig = sandbox.driverPose.length;
    ok(sig >= 3, `driverPose accepts a steer argument (arity ${sig})`);
  }
}

console.log(fails ? `\n${fails} FAILED` : "\nALL GREEN");
process.exit(fails ? 1 : 0);
