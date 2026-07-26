/* test_goldens.js — reference tracks must parse EXACTLY as they did when they worked.
 *
 * The keeper's constraint, stated 2026-07-26 as the sakura campaign began: "what we do to
 * sakura mustn't change t-180 test track." The test track runs flawlessly (240 fps locked);
 * every sakura-motivated change to the load path (chunking, pane drops, bake thresholds,
 * material policy) is a chance to silently alter it. This pins the parse output to golden
 * numbers so that chance becomes a red test instead of a discovery on track.
 *
 * If a change legitimately alters these numbers, updating the goldens is a CONSCIOUS act
 * that names the change in the diff — which is the entire point.
 *
 * Skips (never fails) when the AC install or a track is absent, per the house rule that
 * harnesses must not ENOENT-crash on machines without the content.
 *
 * Run: node test_goldens.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const K = require("./ui/kn5.js");

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok " : "FAIL"} - ${m}`); if (!c) fails++; };

let tdir = null;
for (const r of ["C:/Program Files (x86)/Steam", "D:/SteamLibrary", "E:/SteamLibrary", "G:/SteamLibrary"]) {
  const p = path.join(r, "steamapps/common/assettocorsa/content/tracks");
  if (fs.existsSync(p)) { tdir = p; break; }
}
if (!tdir) { console.log("SKIP: no Assetto Corsa install"); process.exit(0); }

/* Golden values recorded 2026-07-26 on the build where each track was verified BY EYE:
 * t180 at a locked 240 fps with lamps on; centrifuge with open skylights, sun-tracking
 * light, and intact dome. tris is the strongest invariant (any dropped/added mesh moves
 * it); chunk count pins the chunker's behaviour at the default 200 m cell; the material
 * list pins the drop policies. */
const GOLDEN = {
  /* 2026-07-26: chunk counts briefly moved to 59/195 for the monolith split, then moved
   * BACK when the split was disabled pending investigation (live fidelity regression on
   * sakura). If they move again it must be on purpose:
   * tris changing means geometry was dropped or duplicated; chunks changing means only
   * the partitioning did. */
  ohyeah2389_t180testtrack: {
    chunks: 43, tris: 937148,
    materials: ["PlaceholderCanopy", "PlaceholderDark", "PlaceholderLight",
                "PlaceholderMetalGray", "PlaceholderRoad", "TrackMetal_Baked"],
  },
  centrifuge: {
    chunks: 34, tris: 2385042,
    materials: ["Flask", "Light", "Pipe", "Track", "Trackmiddle"],   // Transparent panes dropped by design
  },
};

for (const [track, want] of Object.entries(GOLDEN)) {
  const dir = path.join(tdir, track);
  if (!fs.existsSync(dir)) { console.log(`  SKIP - ${track} not installed`); continue; }
  let best = null, size = 0;
  (function walk(d, depth) {
    if (depth > 2) return;
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, x.name);
      if (x.isDirectory()) walk(p, depth + 1);
      else if (x.name.toLowerCase().endsWith(".kn5")) { const s = fs.statSync(p).size; if (s > size) { size = s; best = p; } }
    }
  })(dir, 0);
  const b = fs.readFileSync(best);
  const sc = K.extractScene(b.buffer.slice(b.byteOffset, b.byteOffset + b.length), { lod0Only: true });
  let tris = 0;
  const mats = new Set();
  for (const g of sc.groups) { tris += g.triCount; mats.add((sc.materials[g.materialId] || {}).name); }
  const got = [...mats].sort();

  console.log(`${track}`);
  ok(sc.groups.length === want.chunks, `chunks ${sc.groups.length} == ${want.chunks}`);
  ok(tris === want.tris, `tris ${tris.toLocaleString()} == ${want.tris.toLocaleString()}`);
  ok(JSON.stringify(got) === JSON.stringify(want.materials),
     `materials [${got.join(", ")}] match the golden list`);
}

console.log(fails ? `\n${fails} FAILED — a load-path change altered a verified-good track` : "\nall good");
process.exit(fails ? 1 : 0);
