/* test_tracklights.js — CSP LIGHT_SERIES resolved to concrete world lights.
 *
 * Synthetic configs pin the parsing rules; the real installed tracks prove the result is
 * not vacuous (lights actually land on real meshes at real coordinates).
 *
 * Run: node test_tracklights.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const T = require("./ui/tracklights.js");
const K = require("./ui/kn5.js");

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok " : "FAIL"} - ${m}`); if (!c) fails++; };

const NODES = [
  { name: "TorusLight1", pos: [10, 5, 0], mat: "TrackMetal" },
  { name: "TorusLight2", pos: [20, 5, 0], mat: "TrackMetal" },
  { name: "TorusLightXX", pos: [30, 5, 0], mat: "TrackMetal" },  // two chars — '?' must NOT match
  { name: "StartFinishGate_SUB2", pos: [0, 8, 0], mat: "LampGlow" },
  { name: "Grandstand", pos: [50, 3, 0], mat: "Concrete" },
];

console.log("\na series places one light per matching mesh");
{
  const ini = `
[LIGHT_SERIES_0]
MESHES = TorusLight?, StartFinishGate_SUB2
DIRECTION = 0, -1, 0
SPOT = 250
RANGE = 180
CONDITION = NIGHT_SHARP
COLOR = 0.9, 0.95, 1.0, 3
`;
  const L = T.resolveTrackLights(ini, NODES);
  ok(L.length === 3, `TorusLight? matched two, plus the gate = 3 lights (got ${L.length})`);
  ok(!L.some(x => x.pos[0] === 30), "'?' matches exactly one character — TorusLightXX excluded");
  ok(!L.some(x => x.pos[0] === 50), "an unmatched mesh contributes no light");
  const g = L.find(x => x.pos[1] === 8);
  ok(!!g, "the gate light is at the gate's world position");
  ok(Math.abs(g.range - 180) < 1e-6, "range carried through");
  ok(Math.abs(g.spot - 250) < 1e-6, "spot angle carried through");
  ok(g.night === true, "CONDITION = NIGHT_SHARP marks it night-gated");
}

console.log("\na series can select by MATERIAL instead of by mesh name");
{
  // Measured on the real library, MATERIALS and MESHES are used about equally. Handling
  // only meshes left 11 of 15 T-180 tracks resolving nothing despite shipping a config:
  // eagleton went 0 -> 98 lights and sakura_speedway 0 -> 143 once this was added.
  const L = T.resolveTrackLights(`
[LIGHT_SERIES_0]
MATERIALS = LampGlow
COLOR = 1, 1, 1, 2
RANGE = 40
`, NODES);
  ok(L.length === 1, `one mesh carries that material (got ${L.length})`);
  ok(L[0].pos[1] === 8, "the light lands at that mesh's position");

  const wild = T.resolveTrackLights(`[LIGHT_SERIES_0]\nMATERIALS = Track*\n`, NODES);
  ok(wild.length === 3, `wildcards work on materials too (got ${wild.length})`);

  // both forms in one series must not double-count a mesh that satisfies each
  const both = T.resolveTrackLights(`[LIGHT_SERIES_0]\nMESHES = StartFinishGate_SUB2\nMATERIALS = LampGlow\n`, NODES);
  ok(both.length === 1, `a mesh matching by BOTH name and material yields one light, not two (got ${both.length})`);
}

console.log("\nCOLOR's fourth component is INTENSITY, not alpha");
{
  const L = T.resolveTrackLights(`
[LIGHT_SERIES_0]
MESHES = Grandstand
COLOR = 0.9, 0.95, 1.0, 3
`, NODES);
  ok(L.length === 1, "one light");
  ok(Math.abs(L[0].intensity - 3) < 1e-6, `intensity is 3, not 1 (got ${L[0].intensity})`);
  ok(Math.abs(L[0].color[2] - 1.0) < 1e-6, "colour keeps only rgb");
  // reading it as alpha would silently make every lamp equal and dim
  const dim = T.resolveTrackLights(`[LIGHT_SERIES_0]\nMESHES = Grandstand\nCOLOR = 1,1,1\n`, NODES);
  ok(Math.abs(dim[0].intensity - 1) < 1e-6, "absent fourth component defaults to 1");
}

console.log("\nexplicit POSITION, OFFSET, ACTIVE");
{
  const p = T.resolveTrackLights(`[LIGHT_0]\nPOSITION = 1, 2, 3\nRANGE = 10\n`, NODES);
  ok(p.length === 1 && p[0].pos[0] === 1 && p[0].pos[2] === 3, "explicit coordinates are used");

  const o = T.resolveTrackLights(`[LIGHT_SERIES_0]\nMESHES = Grandstand\nOFFSET = 0, 4, 0\n`, NODES);
  ok(Math.abs(o[0].pos[1] - 7) < 1e-6, `OFFSET is added to the mesh position (3 + 4 = ${o[0].pos[1]})`);

  const a = T.resolveTrackLights(`[LIGHT_SERIES_0]\nMESHES = Grandstand\nACTIVE = 0\n`, NODES);
  ok(a.length === 0, "ACTIVE = 0 is skipped");
}

console.log("\nculling: nearest first, out-of-range dropped");
{
  const mk = (x, range) => ({ pos: [x, 0, 0], color: [1,1,1], intensity: 1, range, dir: [0,-1,0], spot: 360, sharpness: 0.3, night: true });
  const lights = [mk(10, 50), mk(500, 50), mk(30, 50), mk(20, 50)];
  const got = T.cullLights(lights, [0, 0, 0], 2);
  ok(got.length === 2, "capped at n");
  ok(got[0].pos[0] === 10 && got[1].pos[0] === 20, "nearest two, in order");
  ok(!T.cullLights(lights, [0,0,0], 10).some(l => l.pos[0] === 500), "a lamp far beyond its own range is dropped");
  ok(T.cullLights([], [0,0,0], 4).length === 0, "no lights is not a crash");
}

console.log("\nagainst the real install");
{
  let tdir = null;
  for (const r of ["C:/Program Files (x86)/Steam", "D:/SteamLibrary", "E:/SteamLibrary", "G:/SteamLibrary"]) {
    const p = path.join(r, "steamapps/common/assettocorsa/content/tracks");
    if (fs.existsSync(p)) { tdir = p; break; }
  }
  if (!tdir) { console.log("  SKIP: no Assetto Corsa install"); }
  else {
    let checked = 0, withLights = 0, total = 0;
    for (const e of fs.readdirSync(tdir, { withFileTypes: true })) {
      if (!e.isDirectory() || checked >= 8) continue;
      const dir = path.join(tdir, e.name);
      const ini = path.join(dir, "extension", "ext_config.ini");
      if (!fs.existsSync(ini)) continue;
      // biggest kn5, for its node names
      let best = null, size = 0;
      const walk = (d, depth) => {
        if (depth > 2) return;
        for (const x of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, x.name);
          if (x.isDirectory()) walk(p, depth + 1);
          else if (x.name.toLowerCase().endsWith(".kn5")) { const s = fs.statSync(p).size; if (s > size) { size = s; best = p; } }
        }
      };
      try { walk(dir, 0); } catch (_) {}
      if (!best) continue;
      let nodes = [];
      try {
        const b = fs.readFileSync(best);
        nodes = K.extractScene(b.buffer.slice(b.byteOffset, b.byteOffset + b.length), { lod0Only: true, collectNodes: true }).nodes;
      } catch (_) { continue; }
      checked++;
      const L = T.resolveTrackLights(fs.readFileSync(ini, "utf8"), nodes);
      if (L.length) { withLights++; total += L.length; }
      console.log(`   ${e.name.slice(0, 26).padEnd(28)} nodes ${String(nodes.length).padStart(5)}   lights ${String(L.length).padStart(4)}`);
    }
    ok(checked > 0, `parsed ${checked} real tracks`);
    ok(withLights > 0, `${withLights} of them resolved actual light sources (${total} lamps)`);
  }
}

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall good");
process.exit(fails ? 1 : 0);
