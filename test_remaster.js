/* test_remaster.js — the remaster's asset generators, pinned to their measured properties.
 *
 * The load-bearing assertion is the MIP one: the whole reason these trees exist is that
 * the originals' alpha coverage dies to 0.000 by mip 8 (measured on sakura's real
 * sakura1.png), which is the "trees load in as you approach" bug. If the coverage-
 * preserving chain ever regresses to naive behaviour, distant trees dissolve again and
 * the keeper's standing law — every tree, every distance, nothing spawns — is broken.
 * So this test builds both chains from the same texture and demands they DIVERGE the
 * right way.
 *
 * Run: node test_remaster.js
 */
"use strict";

const R = require("./ui/remaster.js");

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok " : "FAIL"} - ${m}`); if (!c) fails++; };

console.log("tree mesh");
{
  const m = R.makeTreeMesh(26, 7);
  ok(m.triCount === 52, `26 cards = 52 tris (got ${m.triCount}) — forest of 5k trees ≈ 260k tris, under a third of the original`);
  ok(m.idx.length === m.triCount * 3, "index count matches");
  ok(m.pos.length === 26 * 4 * 3, "vertex count matches (4 verts/card)");
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let i = 0; i < m.pos.length; i += 3) {
    if (m.pos[i] < x0) x0 = m.pos[i]; if (m.pos[i] > x1) x1 = m.pos[i];
    if (m.pos[i + 1] < y0) y0 = m.pos[i + 1]; if (m.pos[i + 1] > y1) y1 = m.pos[i + 1];
  }
  /* Envelope measured over 50 seeds: |x|,|z| reach 1.42, y dips to -0.061 (a card corner
   * ~6 cm below the instance base at unit scale — buried in the terrain the tree stands
   * on; the trunk anchors the visual base, so this is tolerance, not a bug). The assert
   * pins the measured envelope with margin, not a wished-for one. */
  ok(x1 <= 1.6 && x0 >= -1.6 && y1 <= 1.5 && y0 >= -0.1, "unit-space bounds inside the measured envelope");
  const m2 = R.makeTreeMesh(26, 7);
  ok(JSON.stringify([...m.idx]) === JSON.stringify([...m2.idx]) && m.pos[0] === m2.pos[0],
     "deterministic: same seed, same mesh (forest identical across loads)");
  const m3 = R.makeTreeMesh(26, 8);
  ok(m.pos[0] !== m3.pos[0], "different seed, different variant");
}

console.log("\nleaf texture");
{
  for (const pal of ["sakura", "green"]) {
    const t = R.generateLeafTexture(256, pal, pal === "sakura" ? 7 : 8);
    let opaque = 0, interior = 0;
    const N = 256;
    const A = (x, y) => t[(y * N + x) * 4 + 3];
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
      if (A(x, y) === 0) continue;
      opaque++;
      if (A(x-1,y) && A(x+1,y) && A(x,y-1) && A(x,y+1) && A(x-1,y-1) && A(x+1,y-1) && A(x-1,y+1) && A(x+1,y+1)) interior++;
    }
    const cov = opaque / (N * N), interiorFrac = opaque ? interior / opaque : 0;
    ok(cov > 0.2 && cov < 0.45, `${pal}: coverage ${cov.toFixed(3)} in the designed range (denser than the originals' 0.14–0.22 — 26 cards must read full)`);
    ok(interiorFrac > 0.8, `${pal}: interior fraction ${interiorFrac.toFixed(3)} — clumped blobs, not dust (dust scores <0.5)`);
    let binary = true;
    for (let i = 3; i < t.length; i += 4) if (t[i] !== 0 && t[i] !== 255) { binary = false; break; }
    ok(binary, `${pal}: level-0 alpha is binary (0 or 255) — hard coverage by construction`);
  }
}

console.log("\nthe mip chain — the pop-in fix itself");
{
  const t = R.generateLeafTexture(256, "sakura", 7);
  const cov = (d, n) => { let c = 0; for (let i = 0; i < n; i++) if (d[i * 4 + 3] > 127) c++; return c / n; };
  const target = cov(t, 256 * 256);

  const preserved = R.buildLeafMips(t.slice(), 256, { threshold: 0.5 });
  const naive = R.buildLeafMips(t.slice(), 256, { threshold: 0.5, preserveCoverage: false });
  ok(preserved.length === 9, `full chain to 1x1 (${preserved.length} levels)`);

  // Preserved: coverage holds near target down to the 4x4 mip.
  let held = true;
  for (let l = 1; l < preserved.length - 2; l++) {
    const c = cov(preserved[l].data, preserved[l].w * preserved[l].h);
    if (Math.abs(c - target) > 0.12) { held = false; console.log(`      level ${l} (${preserved[l].w}px): ${c.toFixed(3)} vs target ${target.toFixed(3)}`); }
  }
  ok(held, `preserved chain holds coverage ≈${target.toFixed(3)} down to 4x4 — distant trees stay PRESENT`);

  // The tail never dies: smallest mips keep nonzero coverage (decay to a solid pixel,
  // never to nothing — the standing law's preferred failure).
  const tail = preserved[preserved.length - 2];   // the 2x2
  ok(cov(tail.data, tail.w * tail.h) > 0, "2x2 mip keeps nonzero coverage — a distant tree becomes a pixel, not a hole");

  // And the naive chain DOES decay away from target down the chain — the divergence that
  // proves the preservation is doing real work. (On sakura's real PNG the naive chain hits
  // literal 0.000 by mip 8; our binary level-0 alpha delays but does not prevent decay.)
  const nTail = naive[naive.length - 2];
  const naiveDrift = Math.abs(cov(nTail.data, nTail.w * nTail.h) - target);
  const presDrift = Math.abs(cov(tail.data, tail.w * tail.h) - target);
  ok(naiveDrift > presDrift, `naive drifts from target more than preserved at the tail (${naiveDrift.toFixed(3)} vs ${presDrift.toFixed(3)})`);
}

console.log("\nharvest contract");
{
  const h = R.harvestTrees({ groups: [], materials: [] });
  ok(Array.isArray(h) && h.length === 0, "empty scene → [], never throws — t180/centrifuge inert by construction");
}

console.log("\nsuppression rule — alpha-tested canopy only, the measured fill problem");
{
  ok(R.isSuppressedMaterial({ name: "branch-1-01", shader: "ksTree", alphaTested: 1 }),
     "alpha-tested ksTree canopy IS suppressed (the 463k-tri corridor overdraw)");
  ok(!R.isSuppressedMaterial({ name: "Pink leaves", shader: "ksPerPixel", alphaTested: 0 }),
     "opaque canopy is NOT suppressed — the four giant landmark sakuras keep their originals");
  ok(!R.isSuppressedMaterial({ name: "trunk-01", shader: "ksPerPixel", alphaTested: 1 }),
     "trunks are NOT suppressed — real geometry, honest shadows, the author's");
  ok(!R.isSuppressedMaterial({ name: "TrackMetal_Baked", shader: "ksPerPixelMultiMap_AT", alphaTested: 1 }),
     "t180's alpha-tested track metal is NOT suppressed — not canopy, goldens inert");
  ok(!R.isSuppressedMaterial(null), "null material never throws");
}

console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exit(fails ? 1 : 0);
