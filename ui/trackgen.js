/* trackgen.js — a stand-in track surface built from the replay's own wheel data.
 *
 * The real track is a 111.7 MB .kn5 that cannot live in this repo, so on a machine with no
 * Assetto Corsa install a sample replay renders the car and the line over empty space. The
 * four wheel-centre world positions in every frame are contact patches on the actual tarmac:
 * drop each by the loaded tyre radius along -nrm and you have points ON the road surface,
 * with the banking already correct — including the parts of centrifuge that go past vertical.
 * Ribbon those together and the app has a surface under the car with no download.
 *
 * See samples/TRACK_FROM_REPLAY.md for the spec this implements and what it cannot do. Three
 * of its expectations did not survive measurement; each is marked MEASURED below.
 *
 * A CLASSIC script, not a module, matching every other file in ui/ — and pure, so it runs
 * under node with no GL. Uploading the result is loaders.js's job.
 */
"use strict";

/* Minimum distance between emitted cross-sections, metres.
 *
 * MEASURED, and the spec's stated reason for this is not the reason it earns its place. The
 * spec expects distance resampling to stop "slow corners getting dense strips and straights
 * sparse ones". At 15 ms frames both sample replays step 1.06–2.38 m (t180) and 1.72–3.96 m
 * (centrifuge) between frames, p10 to max — already coarser than any sane step, and varying
 * only about 2:1. So decimation is nearly a no-op on the driving (6522 sections from 6854
 * usable frames) and it CANNOT densify a straight: nothing here interpolates, so a strip is
 * never finer than the frames that produced it.
 *
 * What it does earn: t180 holds 105 frames whose step is under 5 mm — the car sitting still
 * before the run. Those produce zero-area triangles and duplicate vertices, and this is what
 * removes them. On a slower car (a road car at 50 km/h steps 0.2 m) it does the job the spec
 * describes as well. Kept for both reasons, the smaller one stated first because it is the
 * one this corpus actually exercises. */
const TRACK_STEP_M = 1.0;

/* Fallback loaded-tyre radius, metres — the same 0.33 buildTireMarkMesh falls back to, and
 * for the same reason: on a machine with no AC install there is no car .kn5 either, so
 * carWheels[].radius is unavailable exactly when this file is needed most. This is a rigid
 * offset along the surface normal: getting it wrong translates the whole surface, it does
 * not deform it. A 3 cm error puts the car 3 cm into the road, nothing worse. */
const TRACK_WHEEL_R = 0.33;

/* UV scale: one texture tile per 10 m, isotropic in both directions, so a road texture is
 * not stretched along the ribbon. Nothing samples a real texture today (the stand-in gets a
 * flat fallback colour), but a wrong UV scale is invisible until someone supplies one. */
const TRACK_UV_M = 10;

/** Per-edge tyre radius from a number or a 4-array [FL,FR,RL,RR], averaged over the pair of
 *  wheels whose midpoint that edge is. Front and rear radii genuinely differ on many cars,
 *  and each edge of this ribbon mixes one front wheel with one rear. */
function trackEdgeRadii(wheelR) {
  if (Array.isArray(wheelR) || ArrayBuffer.isView(wheelR)) {
    return [(wheelR[0] + wheelR[2]) / 2, (wheelR[1] + wheelR[3]) / 2];   // left = FL,RL · right = FR,RR
  }
  const r = (typeof wheelR === "number" && isFinite(wheelR) && wheelR > 0) ? wheelR : TRACK_WHEEL_R;
  return [r, r];
}

/**
 * The driven corridor of one run, as cross-sections grouped into unbroken strips.
 *
 * Each section is the pair of road-surface points under the left and right wheel midpoints,
 * plus that frame's road normal. Sections are grouped into strips that may be triangulated
 * end to end; a strip breaks wherever the car teleported or the wheel quad went invalid,
 * because bridging those makes the ribbon shoot across the map.
 *
 * The normal is used AS RECORDED, not forced skyward. extractCar already resolves the winding
 * of the wheel quad globally (its median-tilt flip), so nrm points out of the road; on
 * centrifuge 7.92% of frames legitimately have nrm.y < 0 because the car is past vertical,
 * and forcing those up would place the surface a diameter away on the wrong side.
 */
function trackCorridor(ex, opts) {
  const o = opts || {};
  const stepM = o.stepM > 0 ? o.stepM : TRACK_STEP_M;
  const widen = o.widen > 0 ? o.widen : 0;
  const [rL, rR] = trackEdgeRadii(o.wheelR);
  const W = ex.wheels, OK = ex.wheelsOk, NM = ex.nrm, GAP = ex.gap, ODO = ex.odo;
  const strips = [];
  let cur = null, lastOdo = 0;
  const skipped = { unusable: 0, tooClose: 0 };

  for (let i = 0; i < ex.N; i++) {
    if (!OK[i] || GAP[i]) {   // teleport, crash-warp debris, or no wheel quad this frame
      if (cur && cur.length >= 2) strips.push(cur);
      cur = null;
      skipped.unusable++;
      continue;
    }
    if (cur && ODO[i] - lastOdo < stepM) { skipped.tooClose++; continue; }

    let nx = NM[i * 3], ny = NM[i * 3 + 1], nz = NM[i * 3 + 2];
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-6) { if (cur && cur.length >= 2) strips.push(cur); cur = null; skipped.unusable++; continue; }
    nx /= nl; ny /= nl; nz /= nl;

    const b = i * 12;
    // wheel-centre midpoints: left = FL,RL (0,2) · right = FR,RR (1,3), then down to the tarmac
    let lx = (W[b] + W[b + 6]) / 2 - nx * rL;
    let ly = (W[b + 1] + W[b + 7]) / 2 - ny * rL;
    let lz = (W[b + 2] + W[b + 8]) / 2 - nz * rL;
    let rx = (W[b + 3] + W[b + 9]) / 2 - nx * rR;
    let ry = (W[b + 4] + W[b + 10]) / 2 - ny * rR;
    let rz = (W[b + 5] + W[b + 11]) / 2 - nz * rR;

    if (widen) {
      // widen along the ribbon's own lateral axis rather than a recomputed one: left→right IS
      // the axle direction, already perpendicular to travel and already banked
      let ax = rx - lx, ay = ry - ly, az = rz - lz;
      const al = Math.hypot(ax, ay, az);
      if (al > 1e-6) {
        ax /= al; ay /= al; az /= al;
        lx -= ax * widen; ly -= ay * widen; lz -= az * widen;
        rx += ax * widen; ry += ay * widen; rz += az * widen;
      }
    }

    if (!cur) cur = [];
    cur.push({ l: [lx, ly, lz], r: [rx, ry, rz], n: [nx, ny, nz], odo: ODO[i], frame: i });
    lastOdo = ODO[i];
  }
  if (cur && cur.length >= 2) strips.push(cur);
  return { strips, skipped };
}

/**
 * A renderable mesh from one or more runs.
 *
 * Takes an array of extractCar() results so several replays of the same track union into one
 * surface — the spec's "unless you use every lap" lever. See measureLineSpread() for what
 * that lever is actually worth on the replays in this repo, which is less than the spec
 * assumes and not nothing.
 *
 * Returns the same shape the kn5 path hands makeGroup: pos/nrm/uv/idx plus centre and radius
 * for the frustum cull, so it uploads through exactly the same factory.
 */
function buildTrackMesh(runs, opts) {
  const list = Array.isArray(runs) ? runs : [runs];
  const o = opts || {};
  const pos = [], nrm = [], uv = [], idx = [];
  let sections = 0, strips = 0, degenerate = 0;
  const skipped = { unusable: 0, tooClose: 0 };

  for (const ex of list) {
    if (!ex || !ex.wheels || !ex.wheelsOk || !ex.nrm) continue;
    const c = trackCorridor(ex, o);
    skipped.unusable += c.skipped.unusable;
    skipped.tooClose += c.skipped.tooClose;
    for (const strip of c.strips) {
      strips++;
      const base = pos.length / 3;
      for (const s of strip) {
        const v = s.odo / TRACK_UV_M;
        const half = Math.hypot(s.r[0] - s.l[0], s.r[1] - s.l[1], s.r[2] - s.l[2]) / 2 / TRACK_UV_M;
        pos.push(s.l[0], s.l[1], s.l[2], s.r[0], s.r[1], s.r[2]);
        nrm.push(s.n[0], s.n[1], s.n[2], s.n[0], s.n[1], s.n[2]);
        uv.push(-half, v, half, v);
        sections++;
      }
      /* Winding: (L0,R0,L1) and (R0,R1,L1) puts the front face on the +normal side, i.e. the
       * side the road is driven on. Nothing culls back faces today — the stand-in is visible
       * either way — so this is for the lighting and for anything downstream that trusts a
       * face normal. It is asserted in test_trackgen.js against the recorded normal rather
       * than reasoned about: the first order tried here was inverted on 12,974 of 13,042
       * triangles, and no amount of thinking about handedness caught that. The measurement
       * did, in one run. */
      for (let k = 0; k + 1 < strip.length; k++) {
        const a = base + k * 2, b = a + 2;
        const A = strip[k], B = strip[k + 1];
        // a strip that doubles back on itself (a spin) still triangulates; only a section pair
        // that is coincident within a millimetre is dropped, since it has no area to draw
        if (Math.hypot(B.l[0] - A.l[0], B.l[1] - A.l[1], B.l[2] - A.l[2]) < 1e-3 &&
            Math.hypot(B.r[0] - A.r[0], B.r[1] - A.r[1], B.r[2] - A.r[2]) < 1e-3) { degenerate++; continue; }
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }

  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i] < x0) x0 = pos[i]; if (pos[i] > x1) x1 = pos[i];
    if (pos[i + 1] < y0) y0 = pos[i + 1]; if (pos[i + 1] > y1) y1 = pos[i + 1];
    if (pos[i + 2] < z0) z0 = pos[i + 2]; if (pos[i + 2] > z1) z1 = pos[i + 2];
  }
  const centre = pos.length ? [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2] : [0, 0, 0];
  const radius = pos.length ? 0.5 * Math.hypot(x1 - x0, y1 - y0, z1 - z0) : 0;

  return {
    pos: new Float32Array(pos), nrm: new Float32Array(nrm),
    uv: new Float32Array(uv), idx: new Uint32Array(idx),
    centre, radius, triCount: idx.length / 3,
    // the box as well as the sphere: sceneAABB wants one and the frustum cull wants the other
    aabb: pos.length ? { x0, y0, z0, x1, y1, z1 } : null,
    sections, strips, degenerate, skipped,
  };
}

/**
 * What a widening guess would be worth: the lateral spread between separate passes.
 *
 * MEASURED, and this is where the spec is beaten rather than merely implemented. It calls
 * widening to a plausible road width "a guess", and it is — but the driven data does bound it
 * from below wherever two passes cross the same ground on different lines. For each sampled
 * point this finds the nearest point from a pass at least `minFrameGap` frames away whose
 * travel direction agrees within ~20°, and reports the offset perpendicular to travel.
 *
 * The along-travel offset is returned as the check that these are same-place pairs and not
 * two points a car length apart; on both samples its median is under 0.7 m against lateral
 * medians of 2.0 and 2.7, so they are.
 *
 * THE CONFOUND, which is why this returns a distribution and not a road width: a heading-
 * matched pass a few metres to the side may be a different LINE on the same tarmac, or it may
 * be a pit lane, a parallel section, or an excursion onto runoff. The median is good evidence
 * that the used corridor is wider than one car. The tail is not evidence of anything until
 * something can tell those apart, and nothing here can.
 */
function measureLineSpread(runs, opts) {
  const list = Array.isArray(runs) ? runs : [runs];
  const o = opts || {};
  const minFrameGap = o.minFrameGap || 200;
  const maxPairM = o.maxPairM || 25;
  const cellM = o.cellM || 8;
  const pts = [];
  for (let runIdx = 0; runIdx < list.length; runIdx++) {
    const ex = list[runIdx];
    if (!ex || !ex.wheels || !ex.wheelsOk) continue;
    for (let i = 1; i < ex.N; i++) {
      if (!ex.wheelsOk[i] || ex.gap[i] || ex.gap[i - 1]) continue;
      const b = i * 12, W = ex.wheels;
      const x = (W[b] + W[b + 3] + W[b + 6] + W[b + 9]) / 4;
      const y = (W[b + 1] + W[b + 4] + W[b + 7] + W[b + 10]) / 4;
      const z = (W[b + 2] + W[b + 5] + W[b + 8] + W[b + 11]) / 4;
      let tx = ex.pos[i * 3] - ex.pos[(i - 1) * 3];
      let ty = ex.pos[i * 3 + 1] - ex.pos[(i - 1) * 3 + 1];
      let tz = ex.pos[i * 3 + 2] - ex.pos[(i - 1) * 3 + 2];
      const tl = Math.hypot(tx, ty, tz);
      if (tl < 1e-6) continue;
      tx /= tl; ty /= tl; tz /= tl;
      const nx = ex.nrm[i * 3], ny = ex.nrm[i * 3 + 1], nz = ex.nrm[i * 3 + 2];
      let lx = ny * tz - nz * ty, ly = nz * tx - nx * tz, lz = nx * ty - ny * tx;
      const ll = Math.hypot(lx, ly, lz);
      if (ll < 1e-6) continue;
      pts.push({ run: runIdx, i, x, y, z, tx, ty, tz, lx: lx / ll, ly: ly / ll, lz: lz / ll });
    }
  }
  const cells = new Map();
  for (const p of pts) {
    const k = Math.round(p.x / cellM) + "," + Math.round(p.z / cellM);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(p);
  }
  const lateral = [], along = [];
  for (let n = 0; n < pts.length; n += (o.sampleEvery || 5)) {
    const p = pts[n];
    let best = null, bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const list2 = cells.get((Math.round(p.x / cellM) + dx) + "," + (Math.round(p.z / cellM) + dz));
      if (!list2) continue;
      for (const q of list2) {
        if (q.run === p.run && Math.abs(q.i - p.i) < minFrameGap) continue;   // same pass
        if (q.tx * p.tx + q.ty * p.ty + q.tz * p.tz < 0.94) continue;          // ~20° of heading
        const d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
        if (d < bestD) { bestD = d; best = q; }
      }
    }
    if (!best || bestD > maxPairM) continue;
    const dx = best.x - p.x, dy = best.y - p.y, dz = best.z - p.z;
    lateral.push(Math.abs(dx * p.lx + dy * p.ly + dz * p.lz));
    along.push(Math.abs(dx * p.tx + dy * p.ty + dz * p.tz));
  }
  const pct = (a, f) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
  return {
    pairs: lateral.length,
    lateralP50: pct(lateral, 0.5), lateralP90: pct(lateral, 0.9), lateralMax: lateral.length ? Math.max(...lateral) : NaN,
    alongP50: pct(along, 0.5), alongP90: pct(along, 0.9),
  };
}

if (typeof module !== "undefined") module.exports = { buildTrackMesh, trackCorridor, trackEdgeRadii, measureLineSpread, TRACK_STEP_M, TRACK_WHEEL_R, TRACK_UV_M };
if (typeof window !== "undefined") window.TrackGen = { buildTrackMesh, trackCorridor, trackEdgeRadii, measureLineSpread, TRACK_STEP_M, TRACK_WHEEL_R, TRACK_UV_M };
