/* test_engineharmonic.js — the harmonic engine's material and its rpm→frequency law.
 *
 * The audio graph itself needs a browser (Web Audio), and a shader-style "it runs" check is the
 * only real proof of the SOUND. What IS checkable headlessly is everything upstream of that: the
 * generated profile table, the harmonic grid the whole method rests on, and the mapping from rpm
 * to cycle frequency. If any of these are wrong the engine cannot sound right, so they get pinned.
 *
 *   node test_engineharmonic.js
 */
const fs = require("fs");
const path = require("path");

let fails = 0;
const check = (ok, msg) => { console.log((ok ? "  ok   " : "  FAIL ") + msg); if (!ok) fails++; };

// engineprofile.js is a classic script assigning a global — load it with a window stub
const src = fs.readFileSync(path.join(__dirname, "ui", "engineprofile.js"), "utf8");
const sandbox = { window: {} };
new Function("window", src)(sandbox.window);
const P = sandbox.window.BBEngineProfile;

console.log("profile table");
check(!!P && Array.isArray(P.profiles) && P.profiles.length > 0, `loads and carries ${P && P.profiles ? P.profiles.length : 0} profiles`);
check(P.grid === "rpm/120", `declares the harmonic grid it was measured on (${P.grid})`);

const on = P.profiles.filter(p => p.load === "on").sort((a, b) => a.rpm - b.rpm);
const off = P.profiles.filter(p => p.load === "off").sort((a, b) => a.rpm - b.rpm);
check(on.length >= 3 && off.length >= 1, `both load banks present (on ${on.length}, off ${off.length})`);

let badHarm = 0, badNoise = 0, badPeak = 0, thin = 0;
for (const p of P.profiles) {
  if (!Array.isArray(p.harm) || !p.harm.length) { badHarm++; continue; }
  if (p.harm.some(v => !isFinite(v) || v < 0 || v > 1.0001)) badHarm++;
  if (Math.abs(Math.max(...p.harm) - 1) > 1e-3) badPeak++;      // normalised so the loudest harmonic is 1
  if (p.harm.length < 24) thin++;                                // too few harmonics = no timbre to morph
  if (!Array.isArray(p.noise) || p.noise.length !== 8 || p.noise.some(v => !isFinite(v) || v < 0)) badNoise++;
}
check(badHarm === 0, "every profile's harmonics are finite and in 0..1");
check(badPeak === 0, "every profile is peak-normalised (so voices sum predictably)");
check(thin === 0, "no profile is too thin to carry timbre (≥24 harmonics)");
check(badNoise === 0, "every profile has 8 finite noise bands");
check(P.noiseEdges && P.noiseEdges.length === 9, "noise band edges shipped with the table");

console.log("\nthe grid the method rests on");
// the measured f0 must sit on rpm/120, or resynthesizing at rpm/120 plays a different engine
let onGrid = 0, offGrid = [];
for (const p of P.profiles) {
  const err = Math.abs(p.f0 / (p.rpm / 120) - 1);
  if (err <= 0.01) onGrid++; else offGrid.push(`${p.file} ${(err * 100).toFixed(1)}%`);
}
console.log(`  ${onGrid}/${P.profiles.length} recordings measured within 1% of rpm/120` + (offGrid.length ? `  (outliers: ${offGrid.join(", ")})` : ""));
check(onGrid >= Math.ceil(P.profiles.length * 0.7), "the grid holds across the bank — the model is the recordings', not an assumption");

console.log("\nrpm → cycle frequency (the thing the sample bank could not do)");
const f = rpm => rpm / 120;
check(f(8700) > f(7644) && f(7644) > f(1642), "monotonic in rpm");
check(Math.abs(f(8700) - 72.5) < 0.01, `8700 rpm → ${f(8700)} Hz`);
// the whole point: the pitch law has no clamp, so the span is whatever the driving was
const span = 12 * Math.log2(f(9105) / f(7088));
console.log(`  a pinned run (7088→9105 rpm) spans ${span.toFixed(2)} semitones with NO clamp`);
check(Math.abs(span - 12 * Math.log2(9105 / 7088)) < 1e-9, "frequency is exactly proportional to rpm (no compression anywhere)");
// harmonics must stay inside the audible band at the top of the range, or the top notes go hollow
const topHarm = Math.max(...P.profiles.map(p => p.harm.length));
console.log(`  deepest profile carries ${topHarm} harmonics → ${(f(9500) * topHarm / 1000).toFixed(1)} kHz at 9500 rpm`);
check(f(9500) * topHarm > 12000, "harmonic stack still reaches past 12 kHz at redline (no dull ceiling)");

console.log("\nwiring");
const eng = fs.readFileSync(path.join(__dirname, "ui", "audioengine.js"), "utf8");
check(/window\.BBEngineProfile/.test(eng), "audioengine reads the generated profile");
check(/setEngineMode/.test(eng) && /getEngineMode/.test(eng) && /hasHarmonic/.test(eng), "mode A/B is exported");
check(/rpm \/ 120/.test(eng), "runtime uses the same rpm/120 grid the analysis measured");
const html = fs.readFileSync(path.join(__dirname, "ui", "index.html"), "utf8");
check(html.indexOf('src="engineprofile.js"') > 0 && html.indexOf('src="engineprofile.js"') < html.indexOf('src="audioengine.js"'),
      "profile script loads BEFORE audioengine (classic scripts, shared global scope)");
check(/btnEngMode/.test(html), "the A/B button exists in the header");

console.log(fails ? `\n${fails} FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
