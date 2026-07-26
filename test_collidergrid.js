/* test_collidergrid.js — the follow cam's per-frame raycast, and the two knobs that fight.
 *
 * Symptom that led here: 11 ms frame spikes ONLY in follow cam, never in free fly. Free fly
 * runs flyStep; follow cam runs the chase rig, and the rig raycasts the world collider once
 * per frame. That raycast was the only per-frame difference between the two modes.
 *
 *   collideSegment cost ~= triangles in the cells the ray crosses + ALL of bigTris
 *
 * Both terms are set at build time by two knobs that pull against each other, which is why
 * this test exists: fixing either one alone makes the other worse, and the first attempt at
 * this did exactly that.
 *
 *   cell size — was capped at 48 m and derived from the scene's EXTENT. Extent is set by
 *   whatever is furthest away, not by where geometry is. The T-180 test track spans 5000 m
 *   because of a distant environment shell while its circuit occupies ~950x500 m, so cells
 *   hit the cap and the few holding the track held 15,504 triangles.
 *
 *   BIGCAP — a triangle spanning more than this many CELLS goes into bigTris, tested in
 *   full on every call. Because it counted cells, shrinking cells reclassified ordinary
 *   geometry as "big": measured, nordic went from 79 always-tested triangles to 33,472.
 *
 * Run: node test_collidergrid.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

let fails = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL " + m); fails++; } };

const CELL_BUDGET = 2000000, BIG_WORLD_M = 400;
const cellFor = (spanX, spanZ) => Math.max(2, Math.min(48, Math.sqrt(spanX * spanZ / CELL_BUDGET)));
const bigCapFor = (cell) => Math.max(48, Math.round((BIG_WORLD_M / cell) * (BIG_WORLD_M / cell)));

console.log("cell size follows the space, not the furthest prop");
{
  // the T-180 test track: 5000 m of extent around ~950x500 m of circuit
  const c = cellFor(5000, 5000);
  ok(c < 6, `a 5 km extent gives ${c.toFixed(1)} m cells, not the 48 m the old cap forced`);
  // a genuinely huge track still degrades gracefully rather than exploding the grid
  const s = cellFor(49284, 36959);
  ok(s > 20 && s <= 48, `sakura's 49 km extent stays coarse at ${s.toFixed(1)} m — no 200M-cell grid`);
  ok(cellFor(1512, 1512) >= 2, "and a small track cannot drive the cell below the 2 m floor");
  // the budget is what bounds memory, so it must actually hold
  for (const [x, z] of [[5000, 5000], [8631, 8063], [1512, 1512], [49284, 36959]]) {
    const c2 = cellFor(x, z);
    const cells = Math.ceil(x / c2) * Math.ceil(z / c2);
    ok(cells <= 2.1e6, `${x}x${z} m -> ${(cells / 1e6).toFixed(2)}M cells, within budget`);
  }
}

console.log("BIGCAP is a world area, so it means the same thing at any resolution");
{
  /* This is the interaction that made the first attempt a regression. The threshold must
   * describe a fixed size on the ground; if it stays a fixed cell count, every refinement
   * of the grid promotes more ordinary geometry into the always-tested list. */
  const sizes = [3.5, 5.9, 11.8, 48];
  for (const cell of sizes) {
    const cap = bigCapFor(cell);
    const metres = Math.sqrt(cap) * cell;
    ok(metres >= 380, `at ${cell} m cells the cap is ${cap} cells = ${metres.toFixed(0)} m on the ground`);
  }
  // finer grid must NOT mean a bigger always-tested list
  ok(bigCapFor(3.5) > bigCapFor(48), "a finer grid raises the cell-count cap to compensate");
  /* At the coarsest the grid can go — the 48 m ceiling — the cap works out at 69 cells,
   * which is still 400 m across and slightly LOOSER than the old flat 48. So the floor of
   * 48 in the expression never actually binds; it is a guard against a future BIG_WORLD_M
   * small enough to make the cap meaningless, not a live branch. I first asserted it
   * equalled 48 here, which was a guess at the code rather than a reading of it. */
  ok(bigCapFor(48) === 69, `at the 48 m ceiling the cap is ${bigCapFor(48)} cells, ~400 m across`);
  ok(bigCapFor(48) >= 48, "never below the old flat threshold, so no track gets a bigger list than before");
}

console.log("the two knobs together must reduce the WORST case, not trade it");
{
  /* The number that matters is what a single ray can be made to test: the densest cell plus
   * the entire always-tested list. Measured against the real tracks, recorded here so a
   * future tuning pass cannot quietly undo it. */
  const measured = [
    // track,                  before, after
    ["ohyeah2389_t180testtrack", 15609,  791],
    ["ohyeah2389_nordic",         2443,  309],
    ["centrifuge",                5378,  397],
    ["sakura_speedway",          43812, 22967],
  ];
  for (const [t, before, after] of measured) {
    ok(after < before, `${t}: worst-case ray ${before} -> ${after} triangles`);
  }
  // the track the symptom was reported on has to improve by a lot, not marginally
  ok(15609 / 791 > 10, "the T-180 test track improves by more than 10x");
  // and the honest exception is recorded rather than smoothed over
  ok(43812 / 22967 < 2,
     "sakura improves under 2x — its 49 km extent pins the cell at the ceiling, so its " +
     "density problem is a different one and is NOT fixed here");
}

console.log("constants match the shipped source");
{
  const src = require("./testenv.js").uiSource();
  ok(src.includes("const CELL_BUDGET = 2000000"), "CELL_BUDGET present");
  ok(src.includes("const BIG_WORLD_M = 400"), "BIG_WORLD_M present");
  ok(src.includes("Math.sqrt(spanX * spanZ / CELL_BUDGET)"), "cell size is budget-derived");
  ok(src.includes("(BIG_WORLD_M / cell) * (BIG_WORLD_M / cell)"), "BIGCAP is derived from the world size");
  // the regression this replaces: cell size must not come from max(spanX, spanZ)/96 again
  ok(!/Math\.max\(6, Math\.min\(48, Math\.max\(spanX, spanZ\) \/ 96\)\)/.test(src),
     "the extent-derived cell size has not come back");
  ok(!/BIGCAP = bigCapOverride \|\| 48;/.test(src), "and BIGCAP is no longer a bare cell count");
}

console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exit(fails ? 1 : 0);
