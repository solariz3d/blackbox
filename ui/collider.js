/* collider.js — the uniform-grid triangle collider: build, segment raycast, smoke-vs-track query.
 *
 * Extracted verbatim from index.html, which had grown to 6,113 lines of inline script in a
 * single block. Nothing here was rewritten in the move: the point of the split is that
 * behaviour is unchanged and the code becomes findable.
 *
 * A CLASSIC script, not a module, matching every other file in ui/. These all share one
 * global scope and are loaded in dependency order by index.html — see the note above the
 * script tags there. Function declarations hoist only within their own file, so anything
 * running at TOP LEVEL here may only read bindings from a file loaded EARLIER; function
 * bodies are free to reference anything, because they run after every file has parsed.
 */
"use strict";

function buildWorldCollider(verts, tris, cellOverride, bigCapOverride) {
  const nt = tris.length / 3;
  if (!nt) return null;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < verts.length; v += 3) {
    const x = verts[v], z = verts[v + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const spanX = Math.max(1, maxX - minX), spanZ = Math.max(1, maxZ - minZ);
  // small cells → few tris per cell → cheap per-particle queries (the smoke collider passes
  // an override; the camera collider uses the coarse default tuned for a few queries/frame).
  /* CELL SIZE IS A CELL BUDGET, NOT A LENGTH CAP.
   *
   * This was `min(48, max(spanX,spanZ)/96)`, which sizes cells by the scene's EXTENT — and
   * extent is the wrong variable, because it is set by whatever is furthest away rather
   * than by where the geometry actually is. The T-180 test track carries a distant
   * environment shell, so its collider spans 5000 m while the circuit occupies about
   * 950x500 m of that. Cells hit the 48 m cap, almost all of them ended up empty, and the
   * few holding the track held FIFTEEN THOUSAND triangles each (median 4, p99 4342, max
   * 15504 — measured, not estimated).
   *
   * The follow cam raycasts this grid once per frame and its boom is always in those cells,
   * because it sits behind the car on the racing surface. Free fly never calls it at all,
   * which is exactly why 11 ms spikes appeared only in follow cam.
   *
   * Budgeting cells instead keeps resolution proportional to the space rather than to the
   * furthest prop, and degrades sensibly on a genuinely huge track: sakura's 49 km extent
   * still lands at ~43 m cells, which is fine there because its geometry really is spread
   * out (p99 of 89). Two million cells of mostly-empty array is a few megabytes, once, at
   * track load — cheap against a per-frame raycast. */
  const CELL_BUDGET = 2000000;
  const cell = cellOverride ||
    Math.max(2, Math.min(48, Math.sqrt(spanX * spanZ / CELL_BUDGET)));
  /* BIGCAP has to be a WORLD AREA, not a cell count, or it fights the line above.
   *
   * At 48 m cells a 200 m triangle spans 25 cells and buckets normally; at 3.5 m it spans
   * 3200 and gets dumped into bigTris — which collideSegment tests in FULL on every call.
   * Shrinking cells without fixing this trades one stall for a worse one: measured, it took
   * nordic's always-tested list from 79 triangles to 33,472. Expressed as a size on the
   * ground it means the same thing at any resolution, and only genuinely enormous geometry
   * (backdrops, environment shells) lands in the list.
   *
   * Measured worst case — densest cell plus the whole bigTris list — before and after:
   *   t180testtrack 15,609 -> 791     nordic 2,443 -> 309     centrifuge 5,378 -> 397
   * Sakura only improves 1.9x (43,812 -> 22,967): its 49 km extent pins the cell at the
   * 48 m ceiling, so its density problem is a different one and is not fixed here. */
  const BIG_WORLD_M = 400;
  const nx = Math.max(1, Math.ceil(spanX / cell)), nz = Math.max(1, Math.ceil(spanZ / cell));
  if (nx * nz > 8000000) return buildWorldCollider(verts, tris);   // guard: too many cells → fall back to coarse
  const cells = new Array(nx * nz);
  const bigTris = [];              // triangles too large to bucket sanely
  // max cells a triangle may occupy before it becomes an always-tested "big" tri — derived
  // from BIG_WORLD_M above, with the old 48 as a floor so a coarse grid behaves as before
  const BIGCAP = bigCapOverride || Math.max(48, Math.round((BIG_WORLD_M / cell) * (BIG_WORLD_M / cell)));
  for (let t = 0; t < nt; t++) {
    const i0 = tris[t * 3], i1 = tris[t * 3 + 1], i2 = tris[t * 3 + 2];
    const ax = verts[i0 * 3], az = verts[i0 * 3 + 2];
    const bx = verts[i1 * 3], bz = verts[i1 * 3 + 2];
    const cx2 = verts[i2 * 3], cz2 = verts[i2 * 3 + 2];
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx, cx2) - minX) / cell));
    const c1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx2) - minX) / cell));
    const r0 = Math.max(0, Math.floor((Math.min(az, bz, cz2) - minZ) / cell));
    const r1 = Math.min(nz - 1, Math.floor((Math.max(az, bz, cz2) - minZ) / cell));
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > BIGCAP) { bigTris.push(t); continue; }
    for (let cz = r0; cz <= r1; cz++) for (let cx = c0; cx <= c1; cx++) {
      const k = cz * nx + cx; (cells[k] || (cells[k] = [])).push(t);
    }
  }
  return { verts, tris, minX, minZ, cell, nx, nz, cells, bigTris, stamp: new Int32Array(nt), stampCur: 0, count: nt };
}
// nearest hit parameter t in (0,1] of segment p0→p1 vs the world, or -1 if clear.
function collideSegment(C, p0, p1) {
  if (!C) return -1;
  const { verts, tris, minX, minZ, cell, nx, nz, cells, bigTris, stamp } = C;
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
  const cur = ++C.stampCur;
  let best = -1;
  const test = (ti) => {
    if (stamp[ti] === cur) return; stamp[ti] = cur;
    const i0 = tris[ti * 3], i1 = tris[ti * 3 + 1], i2 = tris[ti * 3 + 2];
    const ax = verts[i0 * 3], ay = verts[i0 * 3 + 1], az = verts[i0 * 3 + 2];
    const e1x = verts[i1 * 3] - ax, e1y = verts[i1 * 3 + 1] - ay, e1z = verts[i1 * 3 + 2] - az;
    const e2x = verts[i2 * 3] - ax, e2y = verts[i2 * 3 + 1] - ay, e2z = verts[i2 * 3 + 2] - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-7 && det < 1e-7) return;
    const inv = 1 / det;
    const tx = p0[0] - ax, ty = p0[1] - ay, tz = p0[2] - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const vv = (dx * qx + dy * qy + dz * qz) * inv;
    if (vv < 0 || u + vv > 1) return;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (tt > 1e-4 && tt <= 1 && (best < 0 || tt < best)) best = tt;
  };
  /* WALK THE RAY, don't sweep its bounding box.
   *
   * This iterated every cell in the segment's XZ bounding box, so its cost was width x
   * height — an AREA — when the ray only ever passes through a LINE of cells. The waste is
   * zero for an axis-aligned segment and grows with the diagonal.
   *
   * Which is why the stalls arrived on banking, and only in follow cam. Behind a car on the
   * flat the boom's XZ footprint is a thin sliver and the box is a couple of cells. As the
   * car banks, the camera swings out sideways: the footprint widens in BOTH axes at once
   * and the box area goes up with the product. Same boom, same length, many times the work.
   *
   * It also fought the finer grid from the previous commit: halving the cell size quarters
   * the density per cell but QUADRUPLES how many cells a fixed-size box covers. A DDA walk
   * is proportional to ray length over cell size, so it improves with a finer grid instead
   * of fighting it, and the two changes finally point the same way.
   *
   * This is exact, not an approximation — the visited set is a subset of the old one. A
   * triangle sits in the cells its XZ bounds overlap, so a ray that never enters those
   * cells in XZ cannot intersect it. Standard Amanatides-Woo in two dimensions, on the XZ
   * plane the grid is built in. */
  const dxs = p1[0] - p0[0], dzs = p1[2] - p0[2];
  let cx = Math.max(0, Math.min(nx - 1, Math.floor((p0[0] - minX) / cell)));
  let cz = Math.max(0, Math.min(nz - 1, Math.floor((p0[2] - minZ) / cell)));
  const ecx = Math.max(0, Math.min(nx - 1, Math.floor((p1[0] - minX) / cell)));
  const ecz = Math.max(0, Math.min(nz - 1, Math.floor((p1[2] - minZ) / cell)));
  const stepX = dxs > 0 ? 1 : (dxs < 0 ? -1 : 0);
  const stepZ = dzs > 0 ? 1 : (dzs < 0 ? -1 : 0);
  // t at which the ray crosses its next cell boundary on each axis, and the t per whole cell
  let tMaxX = Infinity, tDeltaX = Infinity, tMaxZ = Infinity, tDeltaZ = Infinity;
  if (stepX !== 0) {
    const bx = minX + (cx + (stepX > 0 ? 1 : 0)) * cell;
    tMaxX = (bx - p0[0]) / dxs; tDeltaX = cell / Math.abs(dxs);
  }
  if (stepZ !== 0) {
    const bz = minZ + (cz + (stepZ > 0 ? 1 : 0)) * cell;
    tMaxZ = (bz - p0[2]) / dzs; tDeltaZ = cell / Math.abs(dzs);
  }
  // a walk can never need more steps than the grid is wide plus tall; the guard means a
  // degenerate ray or a rounding edge cannot spin here forever
  let guard = nx + nz + 4;
  for (;;) {
    const list = cells[cz * nx + cx];
    if (list) for (let n = 0; n < list.length; n++) test(list[n]);
    if (cx === ecx && cz === ecz) break;
    if (--guard < 0) break;
    if (tMaxX < tMaxZ) { if (tMaxX > 1) break; cx += stepX; tMaxX += tDeltaX; }
    else { if (tMaxZ > 1) break; cz += stepZ; tMaxZ += tDeltaZ; }
    if (cx < 0 || cx >= nx || cz < 0 || cz >= nz) break;
  }
  for (let n = 0; n < bigTris.length; n++) test(bigTris[n]);
  return best;
}
// like collideSegment but also returns the hit triangle's geometric normal, so smoke can
// slide ALONG the track surface (bend) instead of clipping through it. Scalar args (no
// per-particle array allocation). Returns a shared mutated object or null.
const _smkHit = { t: 0, nx: 0, ny: 0, nz: 0 };
function collideSmokeSeg(C, x0, y0, z0, x1, y1, z1) {
  const { verts, tris, minX, minZ, cell, nx, nz, cells, bigTris, stamp } = C;
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const cur = ++C.stampCur;
  let best = -1, bnx = 0, bny = 0, bnz = 0;
  const test = (ti) => {
    if (stamp[ti] === cur) return; stamp[ti] = cur;
    const i0 = tris[ti*3], i1 = tris[ti*3+1], i2 = tris[ti*3+2];
    const ax = verts[i0*3], ay = verts[i0*3+1], az = verts[i0*3+2];
    const e1x = verts[i1*3]-ax, e1y = verts[i1*3+1]-ay, e1z = verts[i1*3+2]-az;
    const e2x = verts[i2*3]-ax, e2y = verts[i2*3+1]-ay, e2z = verts[i2*3+2]-az;
    const px = dy*e2z-dz*e2y, py = dz*e2x-dx*e2z, pz = dx*e2y-dy*e2x;
    const det = e1x*px+e1y*py+e1z*pz; if (det > -1e-7 && det < 1e-7) return;
    const inv = 1/det;
    const tx = x0-ax, ty = y0-ay, tz = z0-az;
    const u = (tx*px+ty*py+tz*pz)*inv; if (u < 0 || u > 1) return;
    const qx = ty*e1z-tz*e1y, qy = tz*e1x-tx*e1z, qz = tx*e1y-ty*e1x;
    const vv = (dx*qx+dy*qy+dz*qz)*inv; if (vv < 0 || u+vv > 1) return;
    const tt = (e2x*qx+e2y*qy+e2z*qz)*inv;
    if (tt > 1e-4 && tt <= 1 && (best < 0 || tt < best)) { best = tt; bnx = e1y*e2z-e1z*e2y; bny = e1z*e2x-e1x*e2z; bnz = e1x*e2y-e1y*e2x; }
  };
  const c0 = Math.max(0, Math.floor((Math.min(x0,x1)-minX)/cell)), c1 = Math.min(nx-1, Math.floor((Math.max(x0,x1)-minX)/cell));
  const r0 = Math.max(0, Math.floor((Math.min(z0,z1)-minZ)/cell)), r1 = Math.min(nz-1, Math.floor((Math.max(z0,z1)-minZ)/cell));
  for (let cz = r0; cz <= r1; cz++) for (let cx = c0; cx <= c1; cx++) { const list = cells[cz*nx+cx]; if (!list) continue; for (let n = 0; n < list.length; n++) test(list[n]); }
  for (let n = 0; n < bigTris.length; n++) test(bigTris[n]);
  if (best < 0) return null;
  const nl = Math.hypot(bnx, bny, bnz) || 1;
  _smkHit.t = best; _smkHit.nx = bnx/nl; _smkHit.ny = bny/nl; _smkHit.nz = bnz/nl;
  return _smkHit;
}

// merge non-translucent scene groups' world-space geometry into one collider.
function buildWorldColliderFromGroups(groups, cellOverride, bigCapOverride) {
  let nv = 0, nt = 0;
  for (const g of groups) { nv += g.pos.length; nt += g.idx.length; }
  if (!nt) return null;
  const verts = new Float32Array(nv), tris = new Uint32Array(nt);
  let vo = 0, to = 0, base = 0;
  for (const g of groups) {
    verts.set(g.pos, vo);
    const id = g.idx;
    for (let i = 0; i < id.length; i++) tris[to + i] = id[i] + base;
    base += g.pos.length / 3; vo += g.pos.length; to += id.length;
  }
  return buildWorldCollider(verts, tris, cellOverride, bigCapOverride);
}

