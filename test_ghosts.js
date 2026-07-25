// test_ghosts.js — ui/ghosts.js: lap windows, distance alignment, model refcounting,
// and the ghost set. Pure logic, no GL, so it runs anywhere:  node test_ghosts.js
const G = require("./ui/ghosts.js");

let fails = 0;
function ok(cond, msg) { console.log(`  ${cond ? "ok " : "FAIL"} - ${msg}`); if (!cond) fails++; }
function near(a, b, eps, msg) { ok(Math.abs(a - b) <= eps, `${msg}  (${a} ~= ${b})`); }

/* A synthetic run at constant speed, so distance is exactly time x speed and every
 * expected value can be computed by hand rather than trusted from the code under test. */
function fakeEx(speedMps, crossings, N, dt) {
  dt = dt || 0.05;
  const odo = new Float64Array(N);
  for (let i = 0; i < N; i++) odo[i] = i * dt * speedMps;
  return {
    car: { driver: "test", carId: "mach6" },
    dt, N, odo,
    gap: new Uint8Array(N),
    speed: new Float32Array(N).fill(speedMps * 3.6),
    laps: crossings,
  };
}

console.log("\nlap windows");
{
  const ex = fakeEx(50, [{ frame: 100, timeMs: 0 }, { frame: 300, timeMs: 20000 }, { frame: 480, timeMs: 18000 }], 600);
  const w = G.lapWindows(ex);
  ok(w.length === 2, `two crossings after the first give two complete laps (got ${w.length})`);
  ok(w[0].start === 100 && w[0].end === 300, "lap 0 spans crossing 0 -> crossing 1");
  ok(w[0].timeMs === 20000, "a window carries the time of the lap that ENDED at its end crossing");
  ok(w[1].timeMs === 18000, "lap 1 time");
  ok(G.bestLapIndex(ex) === 1, "best lap is the quickest, not the first");

  ok(G.lapWindows(fakeEx(50, [], 100)).length === 0, "no crossings -> no complete laps");
  ok(G.lapWindows(fakeEx(50, [{ frame: 10, timeMs: 0 }], 100)).length === 0, "one crossing is still zero complete laps");
  ok(G.bestLapIndex(fakeEx(50, [], 100)) === null, "best lap of a lapless run is null, not 0");
  ok(G.lapWindows(null).length === 0, "null ex is handled, not thrown on");
  // a backwards window would corrupt every distance lookup downstream
  ok(G.lapWindows(fakeEx(50, [{ frame: 300, timeMs: 0 }, { frame: 100, timeMs: 1 }], 400)).length === 0,
     "a backwards crossing pair is rejected rather than producing a negative window");
}

console.log("\nlap distances");
{
  const ex = fakeEx(50, [{ frame: 100, timeMs: 0 }, { frame: 300, timeMs: 20000 }], 400);
  const win = G.lapWindows(ex)[0];
  const d = G.lapDistances(ex, win);
  ok(d.length === 201, `window of 100..300 inclusive is 201 frames (got ${d.length})`);
  ok(d[0] === 0, "distance starts at zero at the line, not at the run's odometer");
  near(G.lapLength(d), 200 * 0.05 * 50, 1e-9, "lap length = frames x dt x speed");
  let mono = true;
  for (let i = 1; i < d.length; i++) if (d[i] < d[i - 1]) mono = false;
  ok(mono, "distances are monotonic");

  // a stalled/garbage odometer must not produce a backwards step (binary search relies on it)
  const bad = fakeEx(50, [{ frame: 0, timeMs: 0 }, { frame: 10, timeMs: 1 }], 20);
  bad.odo[5] = NaN; bad.odo[6] = -999;
  const bd = G.lapDistances(bad, G.lapWindows(bad)[0]);
  let mono2 = true;
  for (let i = 1; i < bd.length; i++) if (bd[i] < bd[i - 1]) mono2 = false;
  ok(mono2, "NaN and backwards odometer samples are clamped, never breaking monotonicity");
}

console.log("\nframe lookup by distance");
{
  const ex = fakeEx(50, [{ frame: 0, timeMs: 0 }, { frame: 200, timeMs: 10000 }], 300);
  const win = G.lapWindows(ex)[0];
  const d = G.lapDistances(ex, win);
  ok(G.frameAtDistance(d, 0) === 0, "distance 0 is frame 0");
  near(G.frameAtDistance(d, 50 * 0.05 * 10), 10, 1e-9, "an exact frame distance lands on that frame");
  near(G.frameAtDistance(d, 50 * 0.05 * 10.5), 10.5, 1e-9, "between two frames interpolates fractionally");
  ok(Number.isNaN(G.frameAtDistance(d, G.lapLength(d) + 1)), "past the end of the lap is NaN, never extrapolated");
  ok(Number.isNaN(G.frameAtDistance(d, -1)), "negative distance is NaN");
  ok(Number.isNaN(G.frameAtDistance(new Float64Array(0), 0)), "empty distance array is NaN, not a crash");
  near(G.timeAtDistance(ex, d, 50 * 0.05 * 20), 20 * 0.05, 1e-9, "time at distance = frame x dt");
}

console.log("\ndelta between two runs");
{
  const fast = fakeEx(50, [{ frame: 0, timeMs: 0 }, { frame: 200, timeMs: 10000 }], 300);
  const slow = fakeEx(45, [{ frame: 0, timeMs: 0 }, { frame: 240, timeMs: 11000 }], 300);
  const A = G.alignGhost(G.makeGhost({ ex: fast, label: "fast" }), 0);
  const B = G.alignGhost(G.makeGhost({ ex: slow, label: "slow" }), 0);

  const at = 500;   // metres around the lap, reached by both
  const dl = G.deltaAtDistance(A, B, at);
  ok(dl > 0, `a slower ghost reads POSITIVE (behind) at the same point on track (${dl.toFixed(3)}s)`);
  near(dl, at / 45 - at / 50, 1e-6, "delta equals the real time difference to that point");
  near(G.deltaAtDistance(A, A, at), 0, 1e-9, "a run compared with itself is exactly zero");

  const beyond = Math.max(A.length, B.length) + 10;
  ok(Number.isNaN(G.deltaAtDistance(A, B, beyond)), "delta past either run's data is NaN, not 0");

  // the playback mapping: both cars must be at the same PLACE, not the same clock
  const f = G.ghostFrameFor(A, B, 100);
  const distRef = A.dists[100 - A.win.start];
  near(B.dists[Math.round(f - B.win.start)], distRef, 2.0, "ghost frame maps to the same track distance");
  ok(f > 100, "the slower ghost needs MORE frames to reach the same point");
  ok(Number.isNaN(G.ghostFrameFor(A, B, 99999)), "a reference frame outside the lap maps to NaN");
}

console.log("\nno-lap fallback");
{
  const ex = fakeEx(50, [], 120);
  const a = G.alignGhost(G.makeGhost({ ex, label: "outlap only" }), null);
  ok(a.win.index === -1, "a run with no complete lap still aligns, over the whole recording");
  ok(a.win.start === 0 && a.win.end === 119, "fallback window covers every frame");
  ok(a.length > 0, "and still has a usable length");
}

console.log("\nmodel cache");
{
  const c = new G.ModelCache();
  ok(c.acquire("mach6") === null, "acquiring an unloaded car returns null so the caller uploads it");
  c.put("mach6", { mesh: 1 });
  ok(c.refs("mach6") === 1, "put takes the first reference");
  ok(c.acquire("mach6").mesh === 1, "a second ghost on the same car reuses the handle");
  ok(c.refs("mach6") === 2, "refcount tracks both ghosts");
  ok(c.size === 1, "four ghosts in one car is still one uploaded model");
  ok(c.release("mach6") === null, "releasing while another ghost still draws it frees nothing");
  const dead = c.release("mach6");
  ok(dead && dead.mesh === 1, "the last release hands back the handle so the GPU memory can go");
  ok(c.size === 0 && !c.has("mach6"), "and the entry is gone");
  ok(c.release("nope") === null, "releasing an unknown car is a no-op, not a throw");
  let threw = false;
  c.put("t180", {}); try { c.put("t180", {}); } catch (e) { threw = true; }
  ok(threw, "double-put is a loud error — it would leak the first upload");
}

console.log("\nghost set");
{
  const s = new G.GhostSet();
  const ex = fakeEx(50, [{ frame: 0, timeMs: 0 }, { frame: 100, timeMs: 5000 }], 200);
  const a = s.add(G.makeGhost({ ex, label: "a" }));
  ok(s.primary === a, "the first run added becomes the reference");
  ok(a.mode === G.MODES.FULL, "the reference is a full car — you watch it, you don't chase it");
  ok(a.fx.smoke === true, "and full mode enables the effects");

  const b = s.add(G.makeGhost({ ex, label: "b" }));
  ok(b.mode === G.MODES.HOLO, "later runs default to holographic");
  ok(b.fx.streak === true && b.fx.smoke === false, "holo mode streaks and skips simulation dressing");
  ok(a.colour !== b.colour, "two ghosts never share a colour");

  G.setGhostMode(b, G.MODES.FULL);
  ok(b.fx.smoke === true, "switching a ghost to full turns its effects on at runtime");
  let bad = false; try { G.setGhostMode(b, "sparkly"); } catch (e) { bad = true; }
  ok(bad, "an unknown mode throws rather than silently rendering nothing");

  s.setPrimary(b.id);
  ok(s.primary === b, "any ghost can be promoted to the reference");
  ok(s.length === 2, "promotion reorders, it does not duplicate");

  b.visible = false;
  ok(s.visible.length === 1, "hidden ghosts drop out of the render list but stay loaded");

  s.remove(b.id);
  ok(s.length === 1 && s.primary === a, "removing the primary promotes the next run");
  ok(s.remove(9999) === null, "removing an unknown id is a no-op");

  let threw = false; try { G.makeGhost({ label: "no data" }); } catch (e) { threw = true; }
  ok(threw, "a ghost with no telemetry is refused at construction");
}

console.log(fails ? `\n${fails} FAILED` : "\nALL GREEN");
process.exit(fails ? 1 : 0);
