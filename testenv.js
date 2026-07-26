/* testenv.js — where the test assets are, resolved rather than assumed.
 *
 * Seven test files sat dead in this repo for months and none of them announced it. Two
 * causes, both environmental:
 *
 *   1. they required ./kn5.js after the sources moved to ui/, so they threw on LOAD —
 *      a crash, not a failure, which a suite sweep reports as noise rather than as red;
 *   2. they were CLI tools taking a path argument, so running them bare printed a usage
 *      line and exited 1 forever.
 *
 * A third, near-miss version of the same thing let a genuine regression reach main: a test
 * that hardcodes `G:\SteamLibrary` cannot run on the laptop, so nobody saw it go red there.
 *
 * The fix for all three is the same — find the install the way the app itself does, and
 * SKIP loudly with exit 0 when it genuinely is not present, so "not installed here" never
 * looks like "passing" and never looks like "broken" either.
 */
"use strict";
const fs = require("fs");
const path = require("path");

/** Steam library roots, parsed from libraryfolders.vdf — mirrors steam_libs() in lib.rs. */
function steamLibraries() {
  const libs = [];
  for (const c of ["C:/Program Files (x86)/Steam", "C:/Program Files/Steam"]) {
    if (fs.existsSync(c)) libs.push(c);
  }
  for (const base of [...libs]) {
    const vdf = path.join(base, "steamapps", "libraryfolders.vdf");
    let txt;
    try { txt = fs.readFileSync(vdf, "utf8"); } catch { continue; }
    for (const line of txt.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith('"path"')) continue;
      const raw = t.split('"')[3];
      if (!raw) continue;
      const p = raw.replace(/\\\\/g, "\\");
      // a library can be listed and its drive not mounted — existsSync, not trust
      if (fs.existsSync(p) && !libs.includes(p)) libs.push(p);
    }
  }
  return libs;
}

/** The assettocorsa content root, or null if Assetto Corsa is not installed here. */
function acContent() {
  for (const lib of steamLibraries()) {
    const p = path.join(lib, "steamapps", "common", "assettocorsa", "content");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** A car folder by name fragment, or null. */
function carDir(fragment) {
  const c = acContent();
  if (!c) return null;
  const cars = path.join(c, "cars");
  let names;
  try { names = fs.readdirSync(cars); } catch { return null; }
  const hit = names.find(n => n.toLowerCase().includes(String(fragment).toLowerCase()));
  return hit ? path.join(cars, hit) : null;
}

/** A track folder by name fragment, or null. */
function trackDir(fragment) {
  const c = acContent();
  if (!c) return null;
  const tracks = path.join(c, "tracks");
  let names;
  try { names = fs.readdirSync(tracks); } catch { return null; }
  const hit = names.find(n => n.toLowerCase().includes(String(fragment).toLowerCase()));
  return hit ? path.join(tracks, hit) : null;
}

/** The largest .kn5 under a track folder — the main model, mirroring how the app picks. */
function trackKn5(fragment) {
  const dir = trackDir(fragment);
  if (!dir) return null;
  let best = null, bestSize = -1;
  const walk = (d, depth) => {
    if (depth > 2) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.kn5$/i.test(e.name)) {
        const sz = fs.statSync(p).size;
        if (sz > bestSize) { bestSize = sz; best = p; }
      }
    }
  };
  walk(dir, 0);
  return best;
}

/* The replays committed to this repo, so a test has something real to run on with no
 * Assetto Corsa install at all. These were added deliberately as shared fixtures. */
const SAMPLES = path.join(__dirname, "samples");
const sample = (frag) => {
  let names;
  try { names = fs.readdirSync(SAMPLES); } catch { return null; }
  const hit = names.find(n => n.toLowerCase().includes(frag.toLowerCase()) && n.endsWith(".acreplay"));
  return hit ? path.join(SAMPLES, hit) : null;
};

/** The T-180 on its test track — the reference replay, in-repo. */
const sampleReplay = () => sample("t180testtrack");
/** A second, different replay — for tests that need two, on DIFFERENT tracks. */
const sampleReplayB = () => sample("centrifuge");

/**
 * Two replays of the SAME car on the SAME track, from the local AC replay folder.
 *
 * The two in-repo samples are on different circuits, so they cannot serve a test that
 * compares two racing lines — the answer would be a meaningless 44 m of "separation"
 * between a tube track and a centrifuge, and it would read as a pass. Rather than invent a
 * default that makes the assertion vacuous, this looks for a real pair and the caller
 * skips when there is none.
 *
 * AC names a replay <car>_<track>__<timestamp>.acreplay, so the prefix before "__" is the
 * pairing key.
 */
function sameTrackReplayPair(trackFragment) {
  const dir = path.join(process.env.USERPROFILE || "", "Documents", "Assetto Corsa", "replay");
  let names;
  try { names = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith(".acreplay")); }
  catch { return null; }
  const groups = new Map();
  for (const n of names) {
    const key = n.split("__")[0];
    if (trackFragment && !key.toLowerCase().includes(String(trackFragment).toLowerCase())) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(path.join(dir, n));
  }
  // largest group first, so the pair comes from the most-driven track
  let best = null;
  for (const v of groups.values()) if (v.length >= 2 && (!best || v.length > best.length)) best = v;
  return best ? [best[0], best[1]] : null;
}

/**
 * Announce a missing asset and exit 0.
 *
 * Exit 0 because "Assetto Corsa is not installed on this machine" is not a failure of the
 * code under test, and a red suite that is red for environmental reasons trains everyone
 * to ignore it — which is exactly how the centrifuge regression reached main.
 */
function skip(why) {
  console.log("SKIP: " + why);
  process.exit(0);
}

module.exports = { steamLibraries, acContent, carDir, trackDir, trackKn5, sampleReplay,
                   sampleReplayB, sameTrackReplayPair, skip };
