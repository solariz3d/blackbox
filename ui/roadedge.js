/* roadedge.js — distance-to-road-edge queries over a kn5 road-surface mesh
 * (zero dependencies, browser + Node).
 *
 * Input is a triangle soup of the drivable surface. Boundary edges are edges
 * referenced by exactly one triangle — BUT kn5 tracks duplicate vertices
 * across mesh seams (same xyz, different index), so canonical vertex identity
 * is the POSITION quantized to 1 mm, not the raw index. Without that, every
 * mesh seam would read as a false road edge.
 *
 * Queries walk a uniform spatial hash (default 25 m cells) outward ring by
 * ring; the search stops only when no unvisited ring can beat the best hit
 * ((ring-1)*cellSize > bestDist), so the returned segment is the true nearest.
 */
"use strict";

const QUANT = 1000;        // vertex canonicalization: 1 mm
const CELL_SIZE = 25;      // grid cell in meters — coarse enough that a
                           // multi-km track stays at a few thousand cells,
                           // fine enough that on-track queries end at ring 0-1
const COFF = 65536;        // cell-coord offset; keys stay exact below 2^53
const CSPAN = 131072;

function cellKey(cx, cy, cz) {
  return ((cx + COFF) * CSPAN + (cy + COFF)) * CSPAN + (cz + COFF);
}

function buildEdgeIndex(verts, tris) {
  const nv = (verts.length / 3) | 0;
  const nt = (tris.length / 3) | 0;

  // 1. canonical vertex ids by quantized position
  const canon = new Int32Array(nv);
  const posMap = new Map();
  const px = [], py = [], pz = [];
  for (let i = 0; i < nv; i++) {
    const x = verts[3 * i], y = verts[3 * i + 1], z = verts[3 * i + 2];
    const key = Math.round(x * QUANT) + "," + Math.round(y * QUANT) + "," + Math.round(z * QUANT);
    let id = posMap.get(key);
    if (id === undefined) {
      id = posMap.size;
      posMap.set(key, id);
      px.push(x); py.push(y); pz.push(z);
    }
    canon[i] = id;
  }
  const nCanon = posMap.size;

  // 2. count edge references; boundary = referenced exactly once
  const edges = new Map(); // loId*nCanon+hiId -> reference count
  for (let t = 0; t < nt; t++) {
    const a = canon[tris[3 * t]], b = canon[tris[3 * t + 1]], c = canon[tris[3 * t + 2]];
    if (a === b || b === c || c === a) continue; // degenerate after quantization
    for (let e = 0; e < 3; e++) {
      const u = e === 0 ? a : e === 1 ? b : c;
      const v = e === 0 ? b : e === 1 ? c : a;
      const k = u < v ? u * nCanon + v : v * nCanon + u;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }

  let nb = 0;
  for (const count of edges.values()) if (count === 1) nb++;
  if (nb === 0) throw new Error("no boundary edges found (closed mesh?)");

  // 3. boundary segments as flat endpoint pairs
  const segs = new Float32Array(nb * 6);
  let s = 0;
  for (const [k, count] of edges) {
    if (count !== 1) continue;
    const u = Math.floor(k / nCanon), v = k % nCanon;
    const o = s * 6;
    segs[o] = px[u]; segs[o + 1] = py[u]; segs[o + 2] = pz[u];
    segs[o + 3] = px[v]; segs[o + 4] = py[v]; segs[o + 5] = pz[v];
    s++;
  }

  // 4. spatial hash: every cell a segment's AABB overlaps
  const grid = new Map();
  let minCx = Infinity, maxCx = -Infinity, minCy = Infinity, maxCy = -Infinity,
      minCz = Infinity, maxCz = -Infinity;
  for (let i = 0; i < nb; i++) {
    const o = i * 6;
    const x0 = Math.floor(Math.min(segs[o], segs[o + 3]) / CELL_SIZE);
    const x1 = Math.floor(Math.max(segs[o], segs[o + 3]) / CELL_SIZE);
    const y0 = Math.floor(Math.min(segs[o + 1], segs[o + 4]) / CELL_SIZE);
    const y1 = Math.floor(Math.max(segs[o + 1], segs[o + 4]) / CELL_SIZE);
    const z0 = Math.floor(Math.min(segs[o + 2], segs[o + 5]) / CELL_SIZE);
    const z1 = Math.floor(Math.max(segs[o + 2], segs[o + 5]) / CELL_SIZE);
    if (x0 < minCx) minCx = x0; if (x1 > maxCx) maxCx = x1;
    if (y0 < minCy) minCy = y0; if (y1 > maxCy) maxCy = y1;
    if (z0 < minCz) minCz = z0; if (z1 > maxCz) maxCz = z1;
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++)
        for (let cz = z0; cz <= z1; cz++) {
          const k = cellKey(cx, cy, cz);
          let list = grid.get(k);
          if (list === undefined) { list = []; grid.set(k, list); }
          list.push(i);
        }
  }

  return {
    segs: segs,
    count: nb,
    grid: grid,
    cellSize: CELL_SIZE,
    bounds: [minCx, maxCx, minCy, maxCy, minCz, maxCz],
  };
}

// res: Float64Array(5) -> [dist2, segIdx, px, py, pz]
function segClosest(segs, seg, x, y, z, res) {
  const o = seg * 6;
  const ax = segs[o], ay = segs[o + 1], az = segs[o + 2];
  const dx = segs[o + 3] - ax, dy = segs[o + 4] - ay, dz = segs[o + 5] - az;
  const L2 = dx * dx + dy * dy + dz * dz;
  let t = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / L2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = ax + t * dx, cy = ay + t * dy, cz = az + t * dz;
  const ex = x - cx, ey = y - cy, ez = z - cz;
  const d2 = ex * ex + ey * ey + ez * ez;
  if (d2 < res[0]) {
    res[0] = d2; res[1] = seg; res[2] = cx; res[3] = cy; res[4] = cz;
  }
}

function scanCell(index, cx, cy, cz, x, y, z, res) {
  const list = index.grid.get(cellKey(cx, cy, cz));
  if (list === undefined) return;
  const segs = index.segs;
  for (let i = 0; i < list.length; i++) segClosest(segs, list[i], x, y, z, res);
}

// hint: segment index from a previous nearby query (seeds the upper bound so
// far-from-grid queries stop expanding early), or -1
function nearest(index, x, y, z, hint, res) {
  res[0] = Infinity; res[1] = -1;
  if (hint >= 0) segClosest(index.segs, hint, x, y, z, res);
  const cs = index.cellSize;
  const qx = Math.floor(x / cs), qy = Math.floor(y / cs), qz = Math.floor(z / cs);
  const b = index.bounds;
  const maxRing = Math.max(
    Math.abs(qx - b[0]), Math.abs(qx - b[1]),
    Math.abs(qy - b[2]), Math.abs(qy - b[3]),
    Math.abs(qz - b[4]), Math.abs(qz - b[5]));
  for (let r = 0; r <= maxRing; r++) {
    if (res[1] >= 0 && r >= 1) {
      const lo = (r - 1) * cs; // min possible distance to any ring-r cell
      if (lo * lo > res[0]) break;
    }
    if (r === 0) {
      scanCell(index, qx, qy, qz, x, y, z, res);
      continue;
    }
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) {
        scanCell(index, qx + dx, qy + dy, qz - r, x, y, z, res);
        scanCell(index, qx + dx, qy + dy, qz + r, x, y, z, res);
      }
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r + 1; dz <= r - 1; dz++) {
        scanCell(index, qx + dx, qy - r, qz + dz, x, y, z, res);
        scanCell(index, qx + dx, qy + r, qz + dz, x, y, z, res);
      }
    for (let dy = -r + 1; dy <= r - 1; dy++)
      for (let dz = -r + 1; dz <= r - 1; dz++) {
        scanCell(index, qx - r, qy + dy, qz + dz, x, y, z, res);
        scanCell(index, qx + r, qy + dy, qz + dz, x, y, z, res);
      }
  }
  if (res[1] < 0) throw new Error("edge index has no reachable segments");
}

const _scratch = new Float64Array(5);

function distanceToEdge(index, x, y, z) {
  nearest(index, x, y, z, -1, _scratch);
  return {
    dist: Math.sqrt(_scratch[0]),
    px: _scratch[2], py: _scratch[3], pz: _scratch[4],
  };
}

function distanceProfile(index, pos, n) {
  if (pos.length < n * 3) throw new Error("pos too short for n=" + n);
  const out = new Float32Array(n);
  const res = _scratch;
  let hint = -1;
  for (let i = 0; i < n; i++) {
    nearest(index, pos[3 * i], pos[3 * i + 1], pos[3 * i + 2], hint, res);
    out[i] = Math.sqrt(res[0]);
    hint = res[1];
  }
  return out;
}

if (typeof module !== "undefined") module.exports = { buildEdgeIndex, distanceToEdge, distanceProfile };
if (typeof window !== "undefined") window.RoadEdge = { buildEdgeIndex, distanceToEdge, distanceProfile };
