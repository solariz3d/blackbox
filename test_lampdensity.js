// How many lamps actually reach a given point on the track?
//
// The forward shader loops EVERY sent light for EVERY fragment. Raising the budget from 24
// to 64 fixed the popping (the T-180 test track declares 60) and cost frame time. Before
// choosing an optimization, measure the thing that decides which one is worth building:
// the OVERLAP FACTOR — lamps whose range actually covers a point, versus lamps sent.
//
// If overlap is low, the loop is mostly rejections and a spatial index over the lamps wins.
// If overlap is high, the lamps genuinely all reach and only a cheaper loop body helps.
const fs = require("fs");
const path = require("path");
const T = require("./ui/tracklights.js");
const KN5 = require("./ui/kn5.js");

let tdir = null;
for (const r of ["C:/Program Files (x86)/Steam", "D:/SteamLibrary", "E:/SteamLibrary", "G:/SteamLibrary"]) {
  const p = path.join(r, "steamapps/common/assettocorsa/content/tracks");
  if (fs.existsSync(p)) { tdir = p; break; }
}
if (!tdir) { console.log("SKIP: no Assetto Corsa install"); process.exit(0); }

const TRACK = process.argv[2] || "ohyeah2389_t180testtrack";
const dir = path.join(tdir, TRACK);
const ini = path.join(dir, "extension", "ext_config.ini");
if (!fs.existsSync(ini)) { console.log("SKIP: no ext_config.ini for " + TRACK); process.exit(0); }

// biggest kn5, for its node names — same choice the harness makes
let best = null, size = 0;
const walk = (d, depth) => {
  if (depth > 2) return;
  for (const x of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, x.name);
    if (x.isDirectory()) walk(p, depth + 1);
    else if (x.name.toLowerCase().endsWith(".kn5")) {
      const s = fs.statSync(p).size; if (s > size) { size = s; best = p; }
    }
  }
};
walk(dir, 0);
const b = fs.readFileSync(best);
const nodes = KN5.extractScene(
  b.buffer.slice(b.byteOffset, b.byteOffset + b.length),
  { lod0Only: true, collectNodes: true }
).nodes || [];
const lights = T.resolveTrackLights(fs.readFileSync(ini, "utf8"), nodes);

console.log(`${TRACK}: ${lights.length} lamps from ${nodes.length} nodes\n`);

// --- radius distribution: a "lamp" with a 257 m radius is a strip authored as one object,
// not a fixture, and it stands as a point light at a centre that may be in mid-air.
const byR = { "fixture (<5m)": 0, "small (5-25m)": 0, "large (25-100m)": 0, "huge (>100m)": 0 };
for (const L of lights) {
  const r = L.radius || 0;
  if (r < 5) byR["fixture (<5m)"]++;
  else if (r < 25) byR["small (5-25m)"]++;
  else if (r < 100) byR["large (25-100m)"]++;
  else byR["huge (>100m)"]++;
}
console.log("mesh bounding-sphere radius:");
for (const [k, v] of Object.entries(byR)) console.log(`  ${k.padEnd(16)} ${v}`);

// --- track extent
const xs = lights.map(L => L.pos[0]), zs = lights.map(L => L.pos[2]);
const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
console.log(`\nlamp spread: ${(x1 - x0).toFixed(0)} m x ${(z1 - z0).toFixed(0)} m`);
console.log(`ranges: min ${Math.min(...lights.map(L => L.range)).toFixed(0)} m, ` +
            `max ${Math.max(...lights.map(L => L.range)).toFixed(0)} m`);

// --- THE NUMBER: sample the lamp-spread area on a grid, count lamps in range of each point.
const N = 60;
let hist = new Map(), sum = 0, samples = 0, maxHit = 0;
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    const px = x0 + (x1 - x0) * (i / (N - 1));
    const pz = z0 + (z1 - z0) * (j / (N - 1));
    let hit = 0;
    for (const L of lights) {
      const dx = L.pos[0] - px, dz = L.pos[2] - pz;
      // horizontal only: lamps aim straight down and the road is roughly level, so this is
      // the reach that matters for road fragments
      if (dx * dx + dz * dz <= L.range * L.range) hit++;
    }
    hist.set(hit, (hist.get(hit) || 0) + 1);
    sum += hit; samples++; if (hit > maxHit) maxHit = hit;
  }
}
console.log(`\nlamps IN RANGE of a sampled point (${N}x${N} grid over the lamp spread):`);
console.log(`  mean ${(sum / samples).toFixed(1)}   max ${maxHit}   sent every frame ${lights.length}`);
const keys = [...hist.keys()].sort((a, b) => a - b);
for (const k of keys) {
  const pct = (hist.get(k) / samples) * 100;
  if (pct < 0.5) continue;
  console.log(`  ${String(k).padStart(3)} lamps: ${"#".repeat(Math.round(pct / 2))} ${pct.toFixed(1)}%`);
}
console.log(`\n  => the loop rejects ${(100 * (1 - sum / samples / lights.length)).toFixed(0)}% of its ` +
            `iterations on an average fragment.`);
