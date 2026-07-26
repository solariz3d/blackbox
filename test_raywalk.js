/* test_raywalk.js — the follow cam's collision ray walks the grid, it does not sweep a box.
 *
 * Symptom, and it is the one that named the cause: 11 ms spikes in follow cam ONLY, and
 * specifically as the car goes over increased banking. Free fly never raycasts the world
 * collider; follow cam does, once per frame, to fold its boom out of geometry.
 *
 * The raycast iterated every cell in the segment's XZ BOUNDING BOX. That cost is width x
 * height — an area — while a ray only ever passes through a line of cells. Behind a car on
 * the flat, the boom's XZ footprint is a thin sliver and the box is a couple of cells. As
 * the car banks, the camera swings out sideways, the footprint widens in BOTH axes at once,
 * and the box area grows with the product. Same boom, same length, many times the work.
 *
 * It also fought the finer collision grid: halving the cell size quarters the triangles per
 * cell but QUADRUPLES the cells a fixed-size box covers, so the two fixes were pulling
 * against each other until this one.
 *
 * Run: node test_raywalk.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

let fails = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL " + m); fails++; } };

const CELL = 3.5, NX = 400, NZ = 400, MINX = 0, MINZ = 0;

/** the OLD behaviour: every cell in the segment's XZ bounding box */
function boxCells(p0, p1) {
  const c0 = Math.max(0, Math.floor((Math.min(p0[0], p1[0]) - MINX) / CELL));
  const c1 = Math.min(NX - 1, Math.floor((Math.max(p0[0], p1[0]) - MINX) / CELL));
  const r0 = Math.max(0, Math.floor((Math.min(p0[2], p1[2]) - MINZ) / CELL));
  const r1 = Math.min(NZ - 1, Math.floor((Math.max(p0[2], p1[2]) - MINZ) / CELL));
  const out = [];
  for (let z = r0; z <= r1; z++) for (let x = c0; x <= c1; x++) out.push(z * NX + x);
  return out;
}

/** the NEW behaviour — mirrors the DDA in collideSegment */
function walkCells(p0, p1) {
  const dxs = p1[0] - p0[0], dzs = p1[2] - p0[2];
  let cx = Math.max(0, Math.min(NX - 1, Math.floor((p0[0] - MINX) / CELL)));
  let cz = Math.max(0, Math.min(NZ - 1, Math.floor((p0[2] - MINZ) / CELL)));
  const ecx = Math.max(0, Math.min(NX - 1, Math.floor((p1[0] - MINX) / CELL)));
  const ecz = Math.max(0, Math.min(NZ - 1, Math.floor((p1[2] - MINZ) / CELL)));
  const stepX = dxs > 0 ? 1 : (dxs < 0 ? -1 : 0);
  const stepZ = dzs > 0 ? 1 : (dzs < 0 ? -1 : 0);
  let tMaxX = Infinity, tDeltaX = Infinity, tMaxZ = Infinity, tDeltaZ = Infinity;
  if (stepX !== 0) { const bx = MINX + (cx + (stepX > 0 ? 1 : 0)) * CELL;
    tMaxX = (bx - p0[0]) / dxs; tDeltaX = CELL / Math.abs(dxs); }
  if (stepZ !== 0) { const bz = MINZ + (cz + (stepZ > 0 ? 1 : 0)) * CELL;
    tMaxZ = (bz - p0[2]) / dzs; tDeltaZ = CELL / Math.abs(dzs); }
  let guard = NX + NZ + 4;
  const out = [];
  for (;;) {
    out.push(cz * NX + cx);
    if (cx === ecx && cz === ecz) break;
    if (--guard < 0) break;
    if (tMaxX < tMaxZ) { if (tMaxX > 1) break; cx += stepX; tMaxX += tDeltaX; }
    else { if (tMaxZ > 1) break; cz += stepZ; tMaxZ += tDeltaZ; }
    if (cx < 0 || cx >= NX || cz < 0 || cz >= NZ) break;
  }
  return out;
}

console.log("the walk is a SUBSET of the box — exact, not an approximation");
{
  /* This is the correctness claim the speedup rests on. A triangle lives in the cells its
   * XZ bounds overlap, so a ray that never enters those cells in XZ cannot intersect it.
   * If the walk ever visited a cell the box did not, it would be walking somewhere the ray
   * does not go; if it missed one the ray crosses, it would miss collisions. */
  const rays = [
    [[10, 0, 10], [40, 0, 40]],      // diagonal
    [[10, 0, 10], [40, 0, 11]],      // shallow
    [[10, 0, 10], [11, 0, 40]],      // steep
    [[40, 0, 40], [10, 0, 10]],      // reversed
    [[10, 0, 10], [10, 0, 40]],      // axis-aligned Z
    [[10, 0, 10], [40, 0, 10]],      // axis-aligned X
    [[25, 0, 25], [25, 0, 25]],      // degenerate: zero length
    [[7.0, 0, 7.0], [7.0, 0, 24.5]], // starts exactly on a cell boundary
  ];
  for (const [a, b] of rays) {
    const box = new Set(boxCells(a, b));
    const walk = walkCells(a, b);
    ok(walk.every(c => box.has(c)),
       `[${a[0]},${a[2]}]->[${b[0]},${b[2]}]: every walked cell is one the box also visited`);
    ok(new Set(walk).size === walk.length, "  and no cell is visited twice");
  }
}

console.log("a walk contains both endpoints, so nothing at either end is missed");
{
  for (const [a, b] of [[[10,0,10],[40,0,40]], [[40,0,12],[11,0,39]], [[10,0,10],[10,0,40]]]) {
    const w = walkCells(a, b);
    const first = Math.floor(a[2]/CELL)*NX + Math.floor(a[0]/CELL);
    const last  = Math.floor(b[2]/CELL)*NX + Math.floor(b[0]/CELL);
    ok(w[0] === first, "starts in the cell containing p0");
    ok(w[w.length-1] === last, "ends in the cell containing p1");
  }
}

console.log("the banking case: a boom that swings sideways");
{
  /* A camera boom is about 12 m long. Behind a car on the flat its XZ span is nearly all in
   * one direction; as the car banks the same boom rotates until it spans both axes. Its
   * LENGTH never changes — only its diagonal-ness — which is precisely what the box cost
   * was sensitive to and the walk is not. */
  const L = 12, at = (deg) => {
    const r = deg * Math.PI / 180;
    return [[100, 0, 100], [100 + L * Math.cos(r), 0, 100 + L * Math.sin(r)]];
  };
  const flat = at(2), banked = at(45);
  const boxFlat = boxCells(...flat).length, boxBank = boxCells(...banked).length;
  const wFlat = walkCells(...flat).length, wBank = walkCells(...banked).length;
  ok(boxBank > boxFlat * 2,
     `box: ${boxFlat} cells nearly straight -> ${boxBank} at 45 deg, for the same 12 m boom`);
  ok(wBank <= wFlat * 1.6,
     `walk: ${wFlat} -> ${wBank} — the cost tracks LENGTH, not diagonal-ness`);
  /* The saving on a single 12 m boom is real but modest — 1.8x — and that is worth stating
   * honestly rather than rounding up. The box cost grows with the SQUARE of the span while
   * the walk grows linearly, so the gap widens with the length of the ray and with a finer
   * grid; on a short boom in a coarse grid there is simply not much room between them. */
  ok(boxBank / wBank > 1.5,
     `and on the banked case the walk visits ${(boxBank / wBank).toFixed(1)}x fewer cells`);
  ok(boxFlat / wFlat < boxBank / wBank,
     "with the advantage larger when banked than when flat — which is where the stall was");
}

console.log("it improves with a finer grid instead of fighting it");
{
  // the interaction that mattered: the previous commit made cells finer to cut density per
  // cell, which quadrupled the box's cell count. The walk scales linearly, so the two
  // changes finally point the same way.
  // the two helpers take the cell size directly — an earlier version threaded it through a
  // module-level ref declared below them, which is a temporal-dead-zone error and nothing else
  const span = (c) => ({ box: boxCellsC(c, [100,0,100], [108,0,108]).length,
                         walk: walkCellsC(c, [100,0,100], [108,0,108]).length });
  const coarse = span(7), fine = span(3.5);
  const boxGrowth = fine.box / coarse.box, walkGrowth = fine.walk / coarse.walk;
  /* Asserted as a COMPARISON, not against absolute multiples. Asymptotically the box is
   * quadratic (4x per halving) and the walk linear (2x), but on a 12 m segment in a 3-7 m
   * grid the "+1 cell" at each end is a large share of both, so neither reaches its limit.
   * The property that matters is which one degrades faster, and that holds at any size. */
  ok(boxGrowth > walkGrowth * 1.3,
     `halving the cell costs the BOX ${boxGrowth.toFixed(2)}x and the WALK ${walkGrowth.toFixed(2)}x`);
  ok(walkGrowth <= 2.2, `the walk stays near linear (${walkGrowth.toFixed(2)}x), so a finer grid now helps both terms`);
}

console.log("constants match the shipped source");
{
  const src = fs.readFileSync(path.join(__dirname, "ui", "index.html"), "utf8");
  const fn = src.slice(src.indexOf("function collideSegment"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  ok(body.includes("tMaxX") && body.includes("tDeltaZ"), "collideSegment uses a DDA walk");
  ok(body.includes("guard = nx + nz + 4"), "with a step guard so a degenerate ray cannot spin");
  ok(!/for \(let cz = r0; cz <= r1; cz\+\+\) for \(let cx = c0; cx <= c1; cx\+\+\)/.test(body),
     "and the bounding-box sweep is gone from it");
}

console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exit(fails ? 1 : 0);

/* cell-size-parameterised variants, used only by the finer-grid check above.
 * Function declarations, so they hoist above their call site. */
function boxCellsC(c, p0, p1) {
  const c0 = Math.floor(p0[0]/c), c1 = Math.floor(p1[0]/c);
  const r0 = Math.floor(p0[2]/c), r1 = Math.floor(p1[2]/c);
  const out = [];
  for (let z = Math.min(r0,r1); z <= Math.max(r0,r1); z++)
    for (let x = Math.min(c0,c1); x <= Math.max(c0,c1); x++) out.push(z * 10000 + x);
  return out;
}
function walkCellsC(c, p0, p1) {
  const dx = p1[0]-p0[0], dz = p1[2]-p0[2];
  let cx = Math.floor(p0[0]/c), cz = Math.floor(p0[2]/c);
  const ex = Math.floor(p1[0]/c), ez = Math.floor(p1[2]/c);
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0, sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  let tX = Infinity, dX = Infinity, tZ = Infinity, dZ = Infinity;
  if (sx) { tX = ((cx + (sx>0?1:0))*c - p0[0]) / dx; dX = c/Math.abs(dx); }
  if (sz) { tZ = ((cz + (sz>0?1:0))*c - p0[2]) / dz; dZ = c/Math.abs(dz); }
  const out = []; let g = 4000;
  for (;;) { out.push(cz*10000+cx);
    if (cx === ex && cz === ez) break; if (--g < 0) break;
    if (tX < tZ) { if (tX > 1) break; cx += sx; tX += dX; } else { if (tZ > 1) break; cz += sz; tZ += dZ; } }
  return out;
}
