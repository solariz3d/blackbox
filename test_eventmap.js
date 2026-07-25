/* test_eventmap.js — the decoded AC event map, and the voice count that is the whole point.
 *
 *   node test_eventmap.js
 *
 * The audio graph needs a browser, but the recipe does not: this pins the data the AC-event mode
 * plays and the properties that make it different from our own two engines.
 */
const fs = require("fs");
const path = require("path");

let fails = 0;
const check = (ok, msg) => { console.log((ok ? "  ok   " : "  FAIL ") + msg); if (!ok) fails++; };

const mapPath = path.join(__dirname, "ui", "eventmap.js");
if (!fs.existsSync(mapPath)) { console.log("SKIP: no ui/eventmap.js (run make_eventmap.js)"); process.exit(0); }
global.window = {};
require(mapPath);
const M = global.window.BBEventMap;

console.log("map");
check(!!M && !!M.events, "loads and defines window.BBEventMap");
check(!!M.car, `records which car it was decoded from (${M.car})`);
const ev = M.events.engine_custom || M.events.engine_ext_old;
const EXTRA = ["turbine", "transmission", "wheel"];
check(!!ev && ev.layers.length >= 8, `carries a playable event (${ev ? ev.layers.length : 0} looping layers)`);

console.log("\nlayer data");
let badSample = 0, badCurve = 0, badBox = 0;
for (const L of ev.layers) {
  if (typeof L.sample !== "number" || L.sample < 0) badSample++;
  if (!Array.isArray(L.curves) || L.curves.some(c => !Array.isArray(c.pts) || c.pts.some(p => !isFinite(p[0]) || !isFinite(p[1])))) badCurve++;
  if (!(isFinite(L.from) && isFinite(L.to) && L.to > L.from)) badBox++;
}
check(badSample === 0, "every layer names an FSB5 sample index");
check(badCurve === 0, "every gain curve is a finite point list");
check(badBox === 0, "every trigger box is a real interval");
check(ev.layers.every(L => L.db > -90 && L.db < 30), "static gains are sane dB");

console.log("\nthe traps this mode exists to avoid");
// the authored autopitch root is NOT the number in the sample's name — assuming it is detunes
// whole layers (5972a_inside is rooted at 5900, 7348c at 7050, 6365d at 12800)
const named = ev.layers.filter(L => L.root > 1 && /^\D*(\d{3,5})/.test(L.name));
const mismatched = named.filter(L => Math.abs(parseInt(L.name.match(/(\d{3,5})/)[1], 10) - L.root) > 1);
console.log(`  ${mismatched.length}/${named.length} layers have an authored root that differs from their name` +
            (mismatched.length ? ": " + mismatched.map(L => `${L.name}→${L.root}`).join(", ") : ""));
check(mismatched.length > 0, "the map carries authored roots (a name-derived ladder would be detuned)");
check(ev.layers.some(L => !(L.root > 1)), "unpitched beds are marked (root ≤ 1 → play at native rate)");

console.log("\nsimultaneity — the number that was 2");
const evalC = (pts, x) => {
  if (!pts.length) return 1;
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) {
    const [a, b] = pts[i - 1], [c, d] = pts[i];
    return b + (d - b) * ((x - a) / Math.max(1e-9, c - a));
  }
  return pts[pts.length - 1][1];
};
const liveAt = rpm => {
  let n = 0;
  for (const L of ev.layers) {
    if (L.param === "throttle" || rpm < L.from || rpm > L.to) continue;
    let g = 1;
    // bus_volume curves are dB, instrument_gain curves are linear — mixing them up is the whole
    // reason each curve carries its own units
    for (const c of L.curves) g *= c.db ? Math.pow(10, evalC(c.pts, rpm) / 20) : evalC(c.pts, rpm);
    if (g > 0.01) n++;
  }
  return n;
};
const probes = [1000, 2000, 3000, 5000, 7000, 8300, 9300];
const counts = probes.map(liveAt);
console.log("  " + probes.map((r, i) => `${r}:${counts[i]}`).join("  "));
check(Math.min(...counts) >= 5, `at least 5 layers audible everywhere in the driving range (min ${Math.min(...counts)})`);
check(counts[probes.indexOf(8300)] >= 8, `a pinned engine at 8300 rpm sounds ${counts[probes.indexOf(8300)]} layers`);
// gains must not be so hot that a dozen voices clip the master before the limiter earns its keep
const worst = Math.max(...probes.map(rpm => {
  let sum = 0;
  for (const L of ev.layers) {
    if (L.param === "throttle" || rpm < L.from || rpm > L.to) continue;
    let g = Math.pow(10, (L.db || 0) / 20);
    for (const c of L.curves) g *= c.db ? Math.pow(10, evalC(c.pts, rpm) / 20) : evalC(c.pts, rpm);
    sum += g;
  }
  return sum;
}));
console.log(`  worst-case summed linear gain across the sweep: ${worst.toFixed(1)} (runtime scales by AC_LEVEL)`);
const src = fs.readFileSync(path.join(__dirname, "ui", "audioengine.js"), "utf8");
const lvl = parseFloat((src.match(/AC_LEVEL\s*=\s*([0-9.]+)/) || [])[1] || "1");
check(worst * lvl < 8, `AC_LEVEL ${lvl} keeps the summed voices out of hard clipping (${(worst * lvl).toFixed(1)})`);

console.log("\nthe rest of the car");
for (const n of EXTRA) check(!!(M.events[n] && M.events[n].layers.length), n + ": " + (M.events[n] ? M.events[n].layers.length + " layers" : "MISSING"));
check(M.events.transmission.layers.some(L => L.curves.some(c => c.db)), "transmission curves are flagged as dB (reading them as linear gain would be wildly wrong)");
check(M.events.wheel.layers.some(L => L.param === "speed"), "tyre_rolling rides road speed");

console.log(fails ? `\n${fails} FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
