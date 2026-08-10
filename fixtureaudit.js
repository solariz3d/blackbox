/* fixtureaudit.js — how much of each sample replay is actually usable telemetry.
 *
 * WHY THIS EXISTS. Tests in this repo run against the replays in samples/, and several of them
 * quietly assume the whole file is good data. It is not: a replay carries frames where the wheel
 * quad failed to parse, and stretches the parser marks as teleports (a crash reset, a pit warp,
 * the recorder still writing after the session ended). A test that samples "the first 500 frames"
 * or "every 7th frame" can therefore be measuring the dead part of a fixture and still go green,
 * which is the failure mode that costs the most to find later.
 *
 * So this reports, per fixture, what fraction of frames a consumer can actually use, and flags
 * any fixture that falls below the floor a test can safely assume. It is an instrument, not a
 * gate: it prints numbers and a list, and exits 0 unless --strict is passed.
 *
 * WHAT IT DOES NOT CLAIM. "Usable" here means the frame has a valid wheel quad and is not inside
 * a teleport. It does NOT mean the frame is physically sensible, that the telemetry tail is
 * present, or that the driving is representative of anything. A fixture can be 100% usable and
 * still be the wrong fixture for your test.
 *
 * Run:  node fixtureaudit.js               # audit samples/
 *       node fixtureaudit.js --dir path    # audit somewhere else
 *       node fixtureaudit.js --strict      # exit 1 if any fixture is below the floor
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { parseReplay, extractCar } = require("./ui/acreplay.js");

/* The floor a test may assume without checking. Below 80%, more than one frame in five is dead,
 * so the "sample every Nth frame" idiom used across this suite is expected to land on a dead
 * frame within its first five samples — at which point a test that does not check is measuring
 * the broken part of the fixture rather than the driving. */
const USABLE_FLOOR = 0.80;

/* Teleports arrive in runs — one crash produces a block of flagged frames, not one flagged frame.
 * Runs closer together than this are counted as a single event, so `teleports` reads as a count
 * of INCIDENTS rather than of frames, which is what someone asking "how broken is this fixture"
 * means by the word. */
const TELEPORT_JOIN = 30;

function auditOne(file) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const replay = parseReplay(ab);
  const ex = extractCar(replay, 0);

  let usable = 0, noQuad = 0, inGap = 0;
  const gapRuns = [];
  for (let i = 0; i < ex.N; i++) {
    const bad = !ex.wheelsOk[i] || ex.gap[i];
    if (!bad) { usable++; continue; }
    if (!ex.wheelsOk[i]) noQuad++;
    if (ex.gap[i]) {
      inGap++;
      const last = gapRuns[gapRuns.length - 1];
      if (last && i - last.end <= TELEPORT_JOIN) last.end = i;
      else gapRuns.push({ start: i, end: i });
    }
  }

  return {
    name: path.basename(file),
    track: replay.track || "?",
    cars: replay.cars.length,
    frames: ex.N,
    usable,
    usablePct: ex.N ? usable / ex.N : 0,
    noQuad,
    inGap,
    teleports: gapRuns.length,
    km: ex.odo[ex.N - 1] / 1000,
    belowFloor: false,
  };
}

function main(argv) {
  const strict = argv.includes("--strict");
  const dirIdx = argv.indexOf("--dir");
  const dir = dirIdx >= 0 ? argv[dirIdx + 1] : path.join(__dirname, "samples");

  let names;
  try {
    names = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith(".acreplay"));
  } catch (e) {
    console.log("no such directory: " + dir);
    return 2;
  }
  if (!names.length) {
    console.log("no .acreplay files in " + dir);
    return 2;
  }

  const results = [];
  for (const n of names) {
    try {
      results.push(auditOne(path.join(dir, n)));
    } catch (e) {
      // a fixture that will not parse is a finding, not a crash — report it and keep going
      results.push({ name: n, error: e.message });
    }
  }

  console.log(`fixtureaudit — ${results.length} replay(s) in ${dir}\n`);
  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  for (const r of results) {
    if (r.error) { console.log(`  ${pad(r.name, 46)} PARSE FAILED — ${r.error}`); continue; }
    console.log(`  ${pad(r.name, 46)} ${num((100 * r.usablePct).toFixed(1), 5)}% usable  ` +
                `${num(r.frames, 6)} frames  ${num(r.teleports, 3)} teleport(s)  ` +
                `${num(r.km.toFixed(2), 7)} km  ${num(r.cars, 2)} car(s)  [${r.track}]`);
  }

  /* The corpus figure is pooled over FRAMES rather than averaged over files: a 200-frame fixture
   * and a 20,000-frame one should not get an equal vote in "how much of the corpus is usable",
   * because a consumer draws frames, not files. */
  const parsed = results.filter(r => !r.error);
  const totalFrames = parsed.reduce((s, r) => s + r.frames, 0);
  const totalUsable = parsed.reduce((s, r) => s + r.usable, 0);
  const corpusPct = totalFrames ? totalUsable / totalFrames : 0;

  const problems = parsed.filter(r => r.belowFloor);
  for (const r of problems) {
    console.log(`\n  BELOW FLOOR: ${r.name} is ${(100 * r.usablePct).toFixed(1)}% usable, ` +
                `under the ${(100 * USABLE_FLOOR).toFixed(0)}% a test may assume`);
  }

  const failed = results.length - parsed.length;
  console.log(`\n  corpus: ${(100 * corpusPct).toFixed(1)}% of ${totalFrames.toLocaleString()} ` +
              `frames usable · ${problems.length} fixture(s) below the ${(100 * USABLE_FLOOR).toFixed(0)}% floor` +
              (failed ? ` · ${failed} unparseable` : ""));
  console.log(`\n  "usable" = valid wheel quad AND not inside a teleport. It says nothing about\n` +
              `  whether the driving in a fixture suits your test.`);

  return strict && (problems.length || failed) ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { auditOne, main, USABLE_FLOOR, TELEPORT_JOIN };
