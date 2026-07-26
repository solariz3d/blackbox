/* remaster.js — the environment remaster: replace a track's badly-authored vegetation with
 * instanced trees of our own, KEEPING the original author's forest layout.
 *
 * Born 2026-07-26 from the keeper's directive on sakura_speedway: "remove all trees and put
 * good ones that would maximize space… the track is genius, but the environment not so
 * much." The original trees are 3–4 crossed 13-metre alpha cards each — catastrophic fill
 * (corridor pixels sit under median 36 canopy layers) and mip-unsafe alpha. Ours: many
 * small cards, coverage-preserving mip chains, GPU instancing, and — the keeper's pick —
 * alpha-tested DAPPLED cast shadows, which the originals never had (the stock depth pass
 * casts solid quad blobs; a confirmed bug).
 *
 * Standing law, from the keeper: EVERY TREE, EVERY DISTANCE, NOTHING SPAWNS. Any mechanism
 * in this file that trades presence for speed is a design bug, not a tuning knob.
 *
 * THE ROOT CAUSE OF "TREES LOAD IN", proven on sakura's real leaf texture (frac of texels
 * with alpha > T, per mip, naive generateMipmap chain vs the coverage-preserving one):
 *
 *     mip  size   naive T=0.5   preserved   naive T=0.1   preserved
 *      0   1024      0.143        0.143        0.160        0.160
 *      6     16      0.141        0.145        0.332        0.168
 *      8      4      0.000        0.188        0.375        0.188
 *      9      2      0.000        0.250        1.000        0.250
 *
 * Naive fails BOTH ways: at a 0.5 test distant mips reach zero coverage — trees dissolve
 * and "load in" on approach (the keeper's exact report) — while at AC's 0.1 test they
 * bloat toward solid — the "conglomerated" distant look he hates. Two complaints, one bug,
 * opposite directions. It is also why a distance-compensated alpha threshold could not
 * cure it: past mip ~7 there is no alpha above 0.5 left to recover at ANY threshold. The
 * per-mip coverage rescale (Castano) holds coverage flat; a sub-pixel-distant tree decays
 * to one solid palette-coloured pixel rather than to nothing, which is the standing law's
 * preferred failure. The depth pass samples the SAME chain, so dapple density stays stable
 * with distance too.
 *
 * House pattern: classic script, dual export, zero dependencies, testable under node.
 * Everything here is data-in data-out; all GL work lives with the other passes.
 *
 * THE CONTRACT (consumed by index.html's draw path, pinned by test_remaster.js):
 *   harvestTrees(scene) -> {
 *     instances: Float32Array,  // 10 floats/tree: x,y,z, radius, height, yawCos, yawSin,
 *                               //                 tintVal, tintWarm, phase
 *     count,
 *     sourceGroups,             // scene-group identities the instances REPLACE — the draw
 *                               // path suppresses exactly these when the remaster is on
 *   }
 *   Returns count 0 (never throws) on tracks with no recognisable vegetation — which is
 *   what keeps t180/centrifuge inert and the goldens untouched by construction.
 */
"use strict";

/* ---- deterministic RNG — the forest must be identical on every load ---- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---- card geometry ----------------------------------------------------------------
 * One static unit-space card cloud per variant; instances scale it. 26 cards = 52 tris —
 * at 5k trees that is ~260k tris for the whole forest, under a third of the original's
 * 940k, in a handful of instanced draws. x,z span [-1.35,1.35] (scaled by instance
 * RADIUS), y spans [0.10,1.30] (scaled by instance HEIGHT). ~62% vertical cards placed
 * in a canopy ellipsoid with golden-angle yaws (even azimuth coverage), the rest
 * near-horizontal CAP cards in the upper canopy — crossed verticals alone read hollow
 * from above. NORMALS ARE SPHERICAL (radial from canopy centre, y-compressed): per-card
 * normals flip dark one card at a time as the sun crosses their planes; radial normals
 * light the canopy as one volume. Trunks are NOT built here — the author's trunk meshes
 * (76k tris, real geometry, honest solid shadows) are kept as-is. */
function makeTreeMesh(cards, seed) {
  cards = cards || 26;
  const rnd = mulberry32(seed == null ? 1234 : seed);
  const CY = 0.62, RY = 0.36;                      // canopy centre / vertical half-extent
  const nVert = Math.max(3, Math.round(cards * 0.62));
  const nCap = cards - nVert;
  const pos = new Float32Array(cards * 12), nrm = new Float32Array(cards * 12);
  const uv = new Float32Array(cards * 8), idx = new Uint16Array(cards * 6);
  let v = 0, q = 0;
  function emit(cx, cy, cz, ax, ay, az, bx, by, bz, flip) {   // quad = centre ± A ± B
    const px = [cx - ax - bx, cx + ax - bx, cx + ax + bx, cx - ax + bx];
    const py = [cy - ay - by, cy + ay - by, cy + ay + by, cy - ay + by];
    const pz = [cz - az - bz, cz + az - bz, cz + az + bz, cz - az + bz];
    for (let k = 0; k < 4; k++) {
      const i3 = (v + k) * 3, i2 = (v + k) * 2;
      pos[i3] = px[k]; pos[i3 + 1] = py[k]; pos[i3 + 2] = pz[k];
      let nx = px[k], ny = (py[k] - CY) / RY * 0.6, nz = pz[k];
      const l = Math.hypot(nx, ny, nz) || 1;
      nrm[i3] = nx / l; nrm[i3 + 1] = ny / l; nrm[i3 + 2] = nz / l;
      const u = (k === 1 || k === 2) ? 1 : 0, w = (k >= 2) ? 1 : 0;
      uv[i2] = flip ? 1 - u : u; uv[i2 + 1] = 1 - w;
    }
    const b = q * 6, o = v;
    idx[b] = o; idx[b + 1] = o + 1; idx[b + 2] = o + 2;
    idx[b + 3] = o; idx[b + 4] = o + 2; idx[b + 5] = o + 3;
    v += 4; q++;
  }
  const GOLD = Math.PI * (3 - Math.sqrt(5));       // golden angle: even azimuth coverage
  for (let i = 0; i < nVert; i++) {
    const yaw = i * GOLD + (rnd() - 0.5) * 0.7;
    const rr = Math.sqrt(rnd()) * 0.45, aa = rnd() * Math.PI * 2;
    const cx = Math.cos(aa) * rr, cz = Math.sin(aa) * rr, cy = CY + (rnd() - 0.5) * 2 * RY * 0.7;
    const hw = 0.55 + rnd() * 0.25, hh = 0.30 + rnd() * 0.14;
    const s = Math.sin(yaw), c = Math.cos(yaw), lean = (rnd() - 0.5) * 0.24;
    emit(cx, cy, cz, c * hw, 0, s * hw, -s * hw * lean, hh, c * hw * lean, rnd() < 0.5);
  }
  for (let i = 0; i < nCap; i++) {                 // horizontal caps: volume from above
    const aa = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 0.4;
    const cx = Math.cos(aa) * rr, cz = Math.sin(aa) * rr, cy = CY + RY * (0.15 + rnd() * 0.75);
    const hw = 0.5 + rnd() * 0.28, rot = rnd() * Math.PI;
    const s = Math.sin(rot), c = Math.cos(rot), tilt = (rnd() - 0.5) * 0.3;
    emit(cx, cy, cz, c * hw, tilt * 0.4, s * hw, -s * hw, tilt, c * hw, rnd() < 0.5);
  }
  return { pos, nrm, uv, idx, quadCount: cards, triCount: cards * 2 };
}

/* ---- palettes — harvested from the track's own PNGs, pink anchored to #f4b8c8 ---- */
const PALETTES = {
  sakura: { light: [244, 184, 200], mid: [205, 133, 141], dark: [154, 96, 110] },
  green:  { light: [116, 144, 68],  mid: [87, 108, 55],   dark: [64, 80, 42] },
};

/* hash-based value noise for ragged organic edges */
function vnoise(x, y, seed) {
  function h(ix, iy) {
    let n = (ix * 374761393 + iy * 668265263 + seed * 2246822519) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  return h(ix, iy) * (1 - sx) * (1 - sy) + h(ix + 1, iy) * sx * (1 - sy)
       + h(ix, iy + 1) * (1 - sx) * sy + h(ix + 1, iy + 1) * sx * sy;
}

/* ---- leaf texture -----------------------------------------------------------------
 * Clustered elliptical blossom blobs, depth-sorted dark→light (light clumps read as the
 * lit front), BINARY alpha at level 0, transparent texels filled with the palette mid so
 * bilinear never bleeds a dark rim, 4%-of-size clear border so card edges never clip.
 * Measured self-check at 256²: coverage ~0.29 (denser than the originals' 0.14–0.22 on
 * purpose — 26 cards must read full where the original leaned on 36 layers of overdraw);
 * interior fraction ~0.91 (anti-dust: opaque texels whose whole 8-neighbourhood is
 * opaque; dust scores under 0.5). */
function generateLeafTexture(size, palette, seed) {
  const pal = typeof palette === "string" ? PALETTES[palette] : palette;
  const rnd = mulberry32(seed == null ? 77 : seed);
  const out = new Uint8Array(size * size * 4);
  const border = Math.ceil(size * 0.04);
  const nClusters = Math.max(8, Math.round(size / 16));
  const blobs = [];
  for (let cIdx = 0; cIdx < nClusters; cIdx++) {
    const ca = rnd() * Math.PI * 2, cr = Math.sqrt(rnd()) * size * 0.33;
    const ccx = size * 0.5 + Math.cos(ca) * cr, ccy = size * 0.5 + Math.sin(ca) * cr * 0.9;
    const cRad = size * (0.07 + rnd() * 0.07), nBlobs = 22 + Math.floor(rnd() * 20), cShade = rnd();
    for (let b = 0; b < nBlobs; b++) {
      const gx = (rnd() + rnd() - 1) * cRad, gy = (rnd() + rnd() - 1) * cRad;   // clumped, not dust
      blobs.push({ x: ccx + gx, y: ccy + gy,
                   a: size * (0.020 + rnd() * 0.030), b: size * (0.014 + rnd() * 0.022),
                   th: rnd() * Math.PI,
                   light: Math.min(1, Math.max(0, cShade * 0.5 + rnd() * 0.7)),
                   ns: (seed || 0) * 7919 + cIdx * 131 + b });
    }
  }
  blobs.sort((p, q) => p.light - q.light);
  const L = pal.light, M = pal.mid, D = pal.dark;
  for (const bl of blobs) {
    const co = Math.cos(bl.th), si = Math.sin(bl.th), rMax = Math.max(bl.a, bl.b) * 1.3;
    const x0 = Math.max(border, Math.floor(bl.x - rMax)), x1 = Math.min(size - border, Math.ceil(bl.x + rMax));
    const y0 = Math.max(border, Math.floor(bl.y - rMax)), y1 = Math.min(size - border, Math.ceil(bl.y + rMax));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const dx = x - bl.x, dy = y - bl.y;
      const ex = (dx * co + dy * si) / bl.a, ey = (-dx * si + dy * co) / bl.b;
      const d = ex * ex + ey * ey + (vnoise(x * 0.35, y * 0.35, bl.ns) - 0.5) * 0.9;  // organic edge
      if (d < 1) {
        const i4 = (y * size + x) * 4;
        let t = bl.light * (1 - d * 0.45) + (vnoise(x * 0.9, y * 0.9, bl.ns + 1) - 0.5) * 0.22;
        t = Math.min(1, Math.max(0, t));
        for (let k = 0; k < 3; k++)
          out[i4 + k] = t < 0.5 ? Math.round(D[k] + (M[k] - D[k]) * t * 2)
                                : Math.round(M[k] + (L[k] - M[k]) * (t * 2 - 1));
        out[i4 + 3] = 255;                          // HARD alpha at level 0
      }
    }
  }
  for (let i = 0; i < size * size; i++)             // fill transparents with mid: no dark rim
    if (out[i * 4 + 3] === 0) { out[i * 4] = M[0]; out[i * 4 + 1] = M[1]; out[i * 4 + 2] = M[2]; }
  return out;
}

/* ---- the mip chain — THE fix for trees that dissolve at distance -------------------
 * 2x2 box filter with alpha-weighted colour, then the Castano coverage rescale per mip:
 * binary-search the threshold t whose coverage matches level 0, scale alpha by
 * (T + 1/255) / t. The +1/255 is measured, not decorative: without it the rescale parks
 * edge alpha exactly ON the threshold and the shader's a > T test loses by half an LSB —
 * whole tail mips read 0.000 coverage.
 *
 * Upload level-by-level (WebGL2), never generateMipmap:
 *   for (let l = 0; l < mips.length; l++)
 *     gl.texImage2D(gl.TEXTURE_2D, l, gl.RGBA8, mips[l].w, mips[l].h, 0,
 *                   gl.RGBA, gl.UNSIGNED_BYTE, mips[l].data);
 */
function buildLeafMips(rgba, size, opts) {
  const T = (opts && opts.threshold != null) ? opts.threshold : 0.5;
  const preserve = !opts || opts.preserveCoverage !== false;
  const mips = [{ w: size, h: size, data: rgba }];
  const cov = (d, n, t) => {
    let c = 0; const t255 = t * 255;
    for (let i = 0; i < n; i++) if (d[i * 4 + 3] > t255) c++;
    return c / n;
  };
  const targetCov = cov(rgba, size * size, T);
  let src = rgba, w = size, h = size;
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    const dst = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const s0 = ((y * 2) * w + x * 2) * 4, s1 = s0 + 4, s2 = ((y * 2 + 1) * w + x * 2) * 4, s3 = s2 + 4;
      const a0 = src[s0 + 3], a1 = src[s1 + 3], a2 = src[s2 + 3], a3 = src[s3 + 3];
      const asum = a0 + a1 + a2 + a3, o = (y * nw + x) * 4;
      for (let k = 0; k < 3; k++)
        dst[o + k] = asum > 0
          ? Math.round((src[s0 + k] * a0 + src[s1 + k] * a1 + src[s2 + k] * a2 + src[s3 + k] * a3) / asum)
          : Math.round((src[s0 + k] + src[s1 + k] + src[s2 + k] + src[s3 + k]) / 4);
      dst[o + 3] = Math.round(asum / 4);
    }
    if (preserve) {
      let lo = 0, hi = 1;
      for (let it = 0; it < 12; it++) {
        const mid = (lo + hi) / 2;
        if (cov(dst, nw * nh, mid) > targetCov) lo = mid; else hi = mid;
      }
      const t = (lo + hi) / 2;
      const scale = t > 1e-6 ? (T + 1 / 255) / t : 1;
      if (Math.abs(scale - 1) > 1e-4)
        for (let i = 0; i < nw * nh; i++) dst[i * 4 + 3] = Math.min(255, Math.round(dst[i * 4 + 3] * scale));
    }
    mips.push({ w: nw, h: nh, data: dst });
    src = dst; w = nw; h = nh;
  }
  return mips;
}

/* ---- placement harvest ------------------------------------------------------------
 * Decompose the author's merged foliage geometry into individual tree instances, keeping
 * his layout. Validated on sakura against the trunk meshes as ground truth: 746 trees
 * (740 trunk-seeded 1:1, 4 self-seeded giants, 2 orphan-clustered), and the premise
 * correction that matters: EACH MESH IS ONE TREE — this is a fantasy-scale track, trees
 * 60–105 m tall with 40–63 m canopies built from 30–60 m crossed cards, plus four giant
 * landmark sakuras (126–181 m) carrying thousands of individual leaf puffs.
 *
 * Two-stage: (1) connected components per foliage group — triangles joined through welded
 * vertices (2 cm); a component is a card-cluster or one whole trunk, never a whole tree.
 * (2) TRUNK-SEEDED ASSEMBLY — a trunk is unambiguously one tree, so trunk bases seed the
 * trees and canopy components join their nearest seed (distance normalised by capture
 * radius, material-affinity discount, and a cannot-attach-far-above-the-seed's-top rule
 * that keeps a giant's puffs off an ordinary trunk standing inside its crown). Leftovers
 * fall to grid-DBSCAN. Pure XZ clustering alone was rejected by measurement: adjacent-tree
 * spacing is smaller than card size here.
 *
 * Generality, measured: eagleton 490 trees (same author's asset pack), nordic 0 —
 * correctly, it has no foliage. Tracks with no match return [] and the remaster stays
 * inert (t180/centrifuge, verified 0 foliage chunks each).
 *
 * Ground truth on planting: the author buries every trunk 1–18 m below terrain (median
 * 4.1 m), and canopies hang 2–13 m above trunk-bottom — so an instance planted at trunk
 * bottom with the canopy starting ~7% up its height lands the visual crown about where
 * the original's was. Runtime on sakura: ~0.4–0.5 s once per track load (the vertex weld
 * over ~600k foliage vertices dominates). */
function harvestTrees(scene, opts) {
  const EPS = (opts && opts.eps) || 8;            // DBSCAN eps for seedless clustering, metres
  const CAPTURE = (opts && opts.capture) || 60;   // trunk seed capture radius, metres
  const WELD = 0.02;                              // vertex weld quantum, metres
  const SELF_TRIS = (opts && opts.selfTris) || 1500;   // a canopy comp this big + tall is a
  const SELF_YEXT = (opts && opts.selfYext) || 60;     // whole authored tree: self-seeds

  const FOLIAGE_SHADER = /^(ksTree|ksGrass|ksFoliage)/i;
  const FOLIAGE_NAME = /tree|leaf|leaves|foliage|bush|shrub|branch|sakura|cherry|palm|hedge|plant/i;
  const TRUNK_NAME = /trunk|bark|stem|timber|log\b/i;
  const PINK_NAME = /sakura|cherry|pink|blossom/i;

  function matClass(mat) {
    if (!mat) return null;
    const hay = (mat.name || "") + " " + (mat.txDiffuse || "");
    const isFol = FOLIAGE_SHADER.test(mat.shader || "") || FOLIAGE_NAME.test(hay);
    if (TRUNK_NAME.test(hay)) return "trunk";     // trunk wins: bark.jpg has no foliage word
    if (!isFol) return null;
    return "canopy";
  }

  // ---- stage 1: connected components across ALL foliage groups at once ----
  const outer = new Map();
  let weldCount = 0;
  const QOFF = 1 << 20;                            // supports |coord| < ~10.4 km at 2 cm
  function weldId(x, y, z) {
    const qx = Math.round(x / WELD) + QOFF, qy = Math.round(y / WELD) + QOFF, qz = Math.round(z / WELD) + QOFF;
    const k1 = qx * 2097152 + qz;                  // 21+21 bits, exact in a double
    let inner = outer.get(k1);
    if (!inner) { inner = new Map(); outer.set(k1, inner); }
    let id = inner.get(qy);
    if (id === undefined) { id = weldCount++; inner.set(qy, id); }
    return id;
  }
  let parent = new Int32Array(1 << 16);
  function ensure(n) {
    if (n <= parent.length) return;
    const np = new Int32Array(Math.max(n, parent.length * 2));
    np.set(parent); parent = np;
  }
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }

  const folGroups = [];
  for (const g of scene.groups) {
    const cls = matClass(scene.materials[g.materialId]);
    if (!cls) continue;
    const nv = g.pos.length / 3;
    const wid = new Int32Array(nv);
    const base = weldCount;
    for (let v = 0; v < nv; v++) wid[v] = weldId(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]);
    ensure(weldCount);
    for (let i = base; i < weldCount; i++) parent[i] = i;
    folGroups.push({ g, cls, wid });
  }
  if (!folGroups.length) return [];
  for (const fg of folGroups) {
    const idx = fg.g.idx, wid = fg.wid;
    for (let t = 0; t < idx.length; t += 3) {
      const a = find(wid[idx[t]]), b = find(wid[idx[t + 1]]), c = find(wid[idx[t + 2]]);
      if (b !== a) parent[b] = a;
      const c2 = find(c); if (c2 !== a) parent[c2] = a;
    }
  }

  const comps = new Map();
  for (const fg of folGroups) {
    const { g, cls, wid } = fg;
    const pos = g.pos, idx = g.idx;
    const mat = scene.materials[g.materialId];
    const pink = PINK_NAME.test((mat.name || "") + " " + (mat.txDiffuse || ""));
    const at = !!mat.alphaTested;                  // suppression happens per-material later;
    for (let t = 0; t < idx.length; t += 3) {      // the instance records how much of its
      const root = find(wid[idx[t]]);              // canopy came from suppressed geometry
      let e = comps.get(root);
      if (!e) {
        e = { cls, mid: g.materialId, tris: 0, pinkTris: 0, atTris: 0,
              x0: 1/0, y0: 1/0, z0: 1/0, x1: -1/0, y1: -1/0, z1: -1/0,
              bx: 0, bz: 0, bn: 0, by: 1/0 };
        comps.set(root, e);
      }
      if (e.cls !== cls && cls === "trunk") e.cls = "trunk";
      e.tris++;
      if (pink) e.pinkTris++;
      if (at) e.atTris++;
      for (let k = 0; k < 3; k++) {
        const vi = idx[t + k];
        const x = pos[vi * 3], y = pos[vi * 3 + 1], z = pos[vi * 3 + 2];
        if (x < e.x0) e.x0 = x; if (y < e.y0) e.y0 = y; if (z < e.z0) e.z0 = z;
        if (x > e.x1) e.x1 = x; if (y > e.y1) e.y1 = y; if (z > e.z1) e.z1 = z;
      }
    }
  }
  for (const fg of folGroups) {                    // trunk base = centroid of lowest 3 m
    if (fg.cls !== "trunk") continue;
    const pos = fg.g.pos, wid = fg.wid, nv = pos.length / 3;
    for (let v = 0; v < nv; v++) {
      const e = comps.get(find(wid[v]));
      if (!e || e.cls !== "trunk") continue;
      const y = pos[v * 3 + 1];
      if (y < e.y0 + 3) { e.bx += pos[v * 3]; e.bz += pos[v * 3 + 2]; e.bn++; if (y < e.by) e.by = y; }
    }
  }

  const trunkComps = [], canopyComps = [];
  for (const e of comps.values()) {
    e.cx = (e.x0 + e.x1) / 2; e.cz = (e.z0 + e.z1) / 2;
    if (e.cls === "trunk") { e.px = e.bn ? e.bx / e.bn : e.cx; e.pz = e.bn ? e.bz / e.bn : e.cz; trunkComps.push(e); }
    else canopyComps.push(e);
  }

  // ---- stage 2a: seeds = trunks + self-standing giants; normalised assignment ----
  const seeds = trunkComps.map(s => ({
    px: s.px, pz: s.pz, ground: s.by < 1/0 ? s.by : s.y0, top: s.y1, cap: CAPTURE, self: null,
  }));
  const smallCanopy = [];
  for (const c of canopyComps) {
    if (c.tris >= SELF_TRIS && (c.y1 - c.y0) >= SELF_YEXT) {
      const cap = Math.max(CAPTURE, 0.5 * Math.hypot(c.x1 - c.x0, c.z1 - c.z0) + 30);
      seeds.push({ px: c.cx, pz: c.cz, ground: c.y0, top: c.y1, cap, self: c });
    } else smallCanopy.push(c);
  }

  const maxCap = seeds.reduce((m, s) => Math.max(m, s.cap), 0);
  const CELL = Math.max(1, maxCap);
  const seedGrid = new Map();
  const gk = (x, z) => Math.floor(x / CELL) * 100003 + Math.floor(z / CELL);
  seeds.forEach((s, i) => {
    const k = gk(s.px, s.pz);
    let a = seedGrid.get(k); if (!a) { a = []; seedGrid.set(k, a); }
    a.push(i);
  });

  function newTrees() {
    return seeds.map(s => ({
      x: s.px, z: s.pz, ground: s.ground, top: s.top,
      canopy: s.self ? [s.self] : [], pinkTris: s.self ? s.self.pinkTris : 0,
      atTris: s.self ? s.self.atTris : 0,
      canopyTris: s.self ? s.self.tris : 0, seeded: !s.self, giant: !!s.self,
    }));
  }
  function assign(trees, affinity) {
    const orphans = [];
    for (const c of smallCanopy) {
      let best = 1, bi = -1;
      const cx = Math.floor(c.cx / CELL), cz = Math.floor(c.cz / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const a = seedGrid.get((cx + dx) * 100003 + (cz + dz));
        if (!a) continue;
        for (const i of a) {
          const s = seeds[i];
          if (c.y0 > s.top + 20) continue;   // floating above this seed's reach: not its canopy
          let d = Math.hypot(s.px - c.cx, s.pz - c.cz) / s.cap;
          if (affinity && d < 1 && affinity[i] && affinity[i].has(c.mid)) d -= 0.3;
          if (d < best) { best = d; bi = i; }
        }
      }
      if (bi >= 0) {
        const t = trees[bi];
        t.canopy.push(c); t.canopyTris += c.tris; t.pinkTris += c.pinkTris; t.atTris += c.atTris;
        if (c.y1 > t.top) t.top = c.y1;
      } else orphans.push(c);
    }
    return orphans;
  }
  let trees = newTrees();
  assign(trees, null);
  const affinity = trees.map(t => {
    const h = new Map();
    for (const c of t.canopy) h.set(c.mid, (h.get(c.mid) || 0) + c.tris);
    const s = new Set();
    for (const [mid, tr] of h) if (tr >= 0.2 * t.canopyTris) s.add(mid);
    return s;
  });
  trees = newTrees();
  const orphans = assign(trees, affinity);

  // ---- stage 2b: grid-DBSCAN on orphan centroids (also the no-trunk path) ----
  if (orphans.length) {
    const DC = EPS;
    const gk2 = (x, z) => Math.floor(x / DC) * 100003 + Math.floor(z / DC);
    const og = new Map();
    orphans.forEach((c, i) => {
      const k = gk2(c.cx, c.cz);
      let a = og.get(k); if (!a) { a = []; og.set(k, a); }
      a.push(i);
    });
    const op = new Int32Array(orphans.length);
    for (let i = 0; i < op.length; i++) op[i] = i;
    const ofind = x => { while (op[x] !== x) { op[x] = op[op[x]]; x = op[x]; } return x; };
    orphans.forEach((c, i) => {
      const cx = Math.floor(c.cx / DC), cz = Math.floor(c.cz / DC);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const a = og.get((cx + dx) * 100003 + (cz + dz));
        if (!a) continue;
        for (const j of a) {
          if (j <= i) continue;
          const o = orphans[j];
          if ((o.cx - c.cx) ** 2 + (o.cz - c.cz) ** 2 <= DC * DC) {
            const ra = ofind(i), rb = ofind(j); if (ra !== rb) op[rb] = ra;
          }
        }
      }
    });
    const byRoot = new Map();
    orphans.forEach((c, i) => {
      const r = ofind(i);
      let t = byRoot.get(r);
      if (!t) { t = { x: 0, z: 0, ground: 1/0, top: -1/0, canopy: [], pinkTris: 0, atTris: 0, canopyTris: 0, seeded: false, giant: false, _w: 0 }; byRoot.set(r, t); }
      t.canopy.push(c); t.canopyTris += c.tris; t.pinkTris += c.pinkTris; t.atTris += c.atTris;
      t.x += c.cx * c.tris; t.z += c.cz * c.tris; t._w += c.tris;
      if (c.y0 < t.ground) t.ground = c.y0;
      if (c.y1 > t.top) t.top = c.y1;
    });
    for (const t of byRoot.values()) { t.x /= t._w; t.z /= t._w; trees.push(t); }
  }

  // ---- emit ----
  const instances = [];
  let debris = 0;
  for (const t of trees) {
    if (!t.seeded && !t.giant && (t.canopyTris < 24 || (t.top - t.ground) < 5)) { debris++; continue; }
    let cb = 1/0, r = 0;
    for (const c of t.canopy) {
      if (c.y0 < cb) cb = c.y0;
      const rx = Math.max(Math.abs(c.x0 - t.x), Math.abs(c.x1 - t.x));
      const rz = Math.max(Math.abs(c.z0 - t.z), Math.abs(c.z1 - t.z));
      const rr = Math.sqrt(rx * rx + rz * rz);
      if (rr > r) r = rr;
    }
    const type = t.canopyTris === 0 ? "generic"
               : t.pinkTris * 2 > t.canopyTris ? "sakura-pink" : "green";
    const qx = Math.round(t.x * 4), qz = Math.round(t.z * 4);
    const tintSeed = ((Math.imul(qx, 2654435761) ^ Math.imul(qz, 40503)) >>> 0) / 4294967296;
    instances.push({
      x: t.x, y: t.ground, z: t.z,
      height: t.top - t.ground,
      canopyRadius: r,
      canopyBottom: t.canopy.length ? cb - t.ground : 0,
      type, tintSeed,
      seeded: t.seeded, giant: t.giant,
      canopyComps: t.canopy.length, tris: t.canopyTris,
      // fraction of the canopy that came from alpha-tested (i.e. suppressed) materials —
      // an instance is only WORTH drawing when it replaces something that stops drawing
      suppressedFrac: t.canopyTris ? t.atTris / t.canopyTris : 0,
    });
  }
  instances.debris = debris;
  return instances;
}

/* Which materials the remaster suppresses: alpha-tested canopy — the measured fill
 * problem (sakura: six ksTree materials, 463k tris under median-36-layer corridors) —
 * and nothing else. Trunks stay (real geometry, honest shadows). Opaque canopy stays
 * ("Pink leaves" = the four giant landmark sakuras, the author's signature pieces; opaque
 * costs vertices, not fill — exonerated by measurement). */
function isSuppressedMaterial(mat) {
  if (!mat || !mat.alphaTested) return false;
  const hay = (mat.name || "") + " " + (mat.txDiffuse || "");
  if (/trunk|bark|stem|timber|log\b/i.test(hay)) return false;
  return /^(ksTree|ksGrass|ksFoliage)/i.test(mat.shader || "")
      || /tree|leaf|leaves|foliage|bush|shrub|branch|sakura|cherry|palm|hedge|plant/i.test(hay);
}

const Remaster = { harvestTrees, isSuppressedMaterial, makeTreeMesh, generateLeafTexture, buildLeafMips, PALETTES, mulberry32 };
if (typeof module !== "undefined") module.exports = Remaster;
if (typeof window !== "undefined") window.Remaster = Remaster;
