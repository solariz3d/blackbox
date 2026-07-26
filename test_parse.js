/* Node test: parse a real replay and print the story. Usage:
 *   node test_parse.js "path\to\file.acreplay"
 */
"use strict";
const fs = require("fs");
const { parseReplay, extractCar, runStats } = require("./ui/acreplay.js");

// defaults to the sample committed to samples/, so a bare run works
const E = require("./testenv.js");
const path = process.argv[2] || E.sampleReplay();
if (!path) E.skip("no replay given and none in samples/ (usage: node test_parse.js <file.acreplay>)");

const buf = fs.readFileSync(path);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const t0 = Date.now();
const rep = parseReplay(ab);
console.log(`v${rep.version} track=${rep.track} weather=${rep.weather} cars=${rep.numCars} frames=${rep.numFrames} interval=${rep.intervalMs}ms`);
for (const c of rep.cars) {
  console.log(`  car=${c.carId} driver=${c.driver} skin=${c.skin} stride=${c.stride} posOff=${c.posOff} frames=${c.frames}`);
}
const ex = extractCar(rep, 0);
const st = runStats(ex);
console.log(`parse+extract: ${Date.now() - t0} ms`);
console.log(`duration ${(st.durationS / 60).toFixed(1)} min  distance ${st.distanceKm.toFixed(2)} km`);
console.log(`speed: median ${st.medianKph.toFixed(0)}  max ${st.maxKph.toFixed(0)} kph`);
console.log(`vertical ${st.verticalM.toFixed(0)} m  median tilt ${st.medianTilt.toFixed(1)} deg  inverted ${st.invertedPct.toFixed(1)}%`);
const fmt = ms => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, "0")}`;
for (const l of ex.laps) console.log(`lap crossing at frame ${l.frame} (t=${(l.frame * ex.dt).toFixed(1)}s): ${fmt(l.timeMs)}`);
