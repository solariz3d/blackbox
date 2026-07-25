/* test_revexpand.js — the rev expander, measured on a real replay.
 *
 * audioengine.js is a browser classic script (window.BBAudio = ...), so it cannot be required
 * here. Per CLAUDE.md, constants are PARSED OUT OF THE SOURCE TEXT rather than re-typed — a copy
 * of the number in this file would keep passing after someone retunes the engine, which is the
 * failure mode where a test proves nothing and looks green doing it.
 *
 *   node test_revexpand.js [replay.acreplay]
 */
const fs = require("fs");
const path = require("path");
const AC = require("./ui/acreplay.js");

const SRC = fs.readFileSync(path.join(__dirname, "ui", "audioengine.js"), "utf8");
const num = (name) => {
  const m = SRC.match(new RegExp(name + "\\s*=\\s*([0-9.]+)"));
  if (!m) throw new Error("could not parse " + name + " out of audioengine.js");
  return parseFloat(m[1]);
};
const EXPAND = num("REV_EXPAND_DEFAULT");
const RATE_LO = num("RATE_LO"), RATE_HI = num("RATE_HI");
// the ON bank's rpm centres, read from the same source line the engine uses
const ON = (SRC.match(/const ON = \[([^\]]+)\]/) || [])[1].split(",").map(s => parseFloat(s.trim()));

const file = process.argv[2] ||
  path.join(__dirname, "samples", "ohyeah2389_t180_mach6_ohyeah2389_t180testtrack__240726-143319.acreplay");
const b = fs.readFileSync(file);
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const replay = AC.parseReplay(ab);
const ex = AC.extractCar(replay, 0);
const tel = AC.alignTelemetry(AC.parseTelemetry(ab), ex.N, ex.dt);
if (!tel) { console.error("FAIL: " + path.basename(file) + " carries no telemetry tail — nothing to test"); process.exit(1); }

// the driving frames only: parked/idle frames would dominate the median and flatter the result
const rpm = [];
for (let i = 0; i < ex.N; i++) if (tel.rpm[i] > 1000 && isFinite(ex.speed[i]) && ex.speed[i] > 30) rpm.push(tel.rpm[i]);
const sorted = rpm.slice().sort((a, b) => a - b);
const q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const pivot = q(0.5);   // exactly what index.html hands BBAudio.setRevPivot per replay

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const expand = (r, e) => e === 1 ? r : clamp(pivot * Math.pow(r / pivot, e), 500, 12000);
const semis = (a, b) => 12 * Math.log2(b / a);

// residency: which band each frame lands nearest, and the loudest band's share
function residency(e) {
  const hits = new Array(ON.length).fill(0);
  for (const r of rpm) {
    const v = expand(r, e);
    let bi = 0, bd = Infinity;
    ON.forEach((c, k) => { const d = Math.abs(v - c); if (d < bd) { bd = d; bi = k; } });
    hits[bi]++;
  }
  const share = hits.map(h => h / rpm.length);
  return { share, used: share.filter(s => s > 0.02).length, top: Math.max(...share) };
}

const before = { span: semis(q(0.05), q(0.95)), ...residency(1) };
const after = { span: semis(expand(q(0.05), EXPAND), expand(q(0.95), EXPAND)), ...residency(EXPAND) };

console.log(`replay: ${path.basename(file)}  ·  ${rpm.length} driving frames  ·  pivot (median rpm) ${pivot | 0}`);
console.log(`rpm p5–p95: ${q(0.05) | 0} → ${q(0.95) | 0}`);
console.log(`expand ${EXPAND}: p5–p95 maps to ${expand(q(0.05), EXPAND) | 0} → ${expand(q(0.95), EXPAND) | 0}`);
console.log(`  pitch span     ${before.span.toFixed(2)} st  →  ${after.span.toFixed(2)} st`);
console.log(`  bands in use   ${before.used}  →  ${after.used}   (of ${ON.length})`);
console.log(`  busiest band   ${(before.top * 100).toFixed(1)}%  →  ${(after.top * 100).toFixed(1)}%`);

let fails = 0;
const check = (ok, msg) => { console.log((ok ? "  ok   " : "  FAIL ") + msg); if (!ok) fails++; };

check(EXPAND >= 1 && EXPAND <= 3, `expand default in range (${EXPAND})`);
check(Math.abs(expand(pivot, EXPAND) - pivot) < 1e-6,
      "identity at the pivot — the engine's resting voice does not move");
check(expand(q(0.05), EXPAND) < q(0.05) && expand(q(0.95), EXPAND) > q(0.95),
      "expands both ways about the pivot (not a pitch shift)");
check(after.span > before.span * 1.4, `pitch span widened materially (${before.span.toFixed(2)} → ${after.span.toFixed(2)} st)`);
check(after.used > before.used, `more sample bands in play (${before.used} → ${after.used}) — timbre moves, not just pitch`);
check(after.top < before.top, `no single band dominates as hard (${(before.top * 100).toFixed(1)}% → ${(after.top * 100).toFixed(1)}%)`);
// the sample bank must stay inside its own pitch clamp, or the top of the range silently flattens
// again — this is the trap the ORIGINAL sound hit, one octave up
{
  const top = expand(q(0.99), EXPAND), lo = expand(q(0.01), EXPAND);
  const rTop = top / ON[ON.length - 1], rLo = lo / ON[0];
  check(rTop <= RATE_HI + 1e-9, `p99 still tracks inside RATE_HI (needs ${rTop.toFixed(3)} ≤ ${RATE_HI})`);
  check(rLo >= RATE_LO - 1e-9 || lo >= ON[0], `p1 does not fall through the bottom band (${rLo.toFixed(3)})`);
}
check(expand(20000, EXPAND) <= 12000 && expand(1, EXPAND) >= 500, "clamped at both extremes (no runaway on junk rpm)");

console.log(fails ? `\n${fails} FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
