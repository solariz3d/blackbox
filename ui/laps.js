/* laps.js — lap comparison: colour ramps, overlay geometry, distance alignment, ghost poses and the lap-picker UI.
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

/* colors */
function speedRGB(s) {
  const t = Math.max(0, Math.min(1, s / 950));
  if (t < 0.5) { const u = t / 0.5; return [(31 + u * 214) / 255, (182 + u * 29) / 255, (208 - u * 145) / 255]; }
  const u = (t - 0.5) / 0.5; return [(245 + u * 10) / 255, (211 - u * 152) / 255, (63 - u * 15) / 255];
}
function bankRGB(deg) {
  const t = Math.max(0, Math.min(1, deg / 130));
  if (t < 0.46) { const u = t / 0.46; return [(58 + u * 187) / 255, (76 + u * 100) / 255, (110 - u * 74) / 255]; }
  if (t < 0.7) { const u = (t - 0.46) / 0.24; return [(245 + u * 10) / 255, (176 - u * 56) / 255, (36 + u * 4) / 255]; }
  const u = (t - 0.7) / 0.3; return [1, (120 - u * 90) / 255, (40 - u * 10) / 255];
}

/* build GPU geometry from extracted car */
/* ===================== lap comparison =====================
 * Every timed lap except the reference gets its driven line drawn, coloured by the SPEED
 * DIFFERENCE against the reference at the same point on track: green where this lap was
 * quicker, red where it was slower, grey where they matched.
 *
 * Aligned by DISTANCE around the lap, never by time (Ghosts.lapDistances /
 * frameAtDistance). Two laps played from a common clock start describing different corners
 * the moment one driver is quicker, so a time-aligned comparison answers a question nobody
 * asked. At equal distance they stay side by side the whole way round, which is what makes
 * "you were 4 km/h slower HERE" a true statement about a place.
 *
 * The lines are drawn, not ribbons: several speed-coloured ribbons over the same corner
 * z-fight and hide each other, and the thing being compared is the LINE anyway. */
const LAP_COLORS = [
  [1.00, 0.28, 0.20], [0.30, 0.85, 1.00], [0.65, 1.00, 0.35],
  [1.00, 0.80, 0.25], [0.85, 0.45, 1.00], [1.00, 0.45, 0.75],
];
const LAP_DV_FULL = 12;   // km/h difference that saturates the colour

/* Comparison runs. Measured on every replay in the folder: each holds exactly ONE timed
 * lap (81.85, 82.50, 82.85, 86.06, 86.32 — five different times, five separate files). So
 * lap-vs-lap lives ACROSS replays, not inside one. A second lap found inside a single
 * replay is handled by the same path; there just aren't any yet. */
let compareRuns = [];   // [{ ex, label, win, dists, color }]

/** the reference: the loaded replay's own best lap */
function lapOverlayInfo() {
  if (!ex || !window.Ghosts) return null;
  const wins = Ghosts.lapWindows(ex);
  if (!wins.length) return null;
  const refI = (lapRefIndex != null && wins[lapRefIndex]) ? lapRefIndex : (Ghosts.bestLapIndex(ex) ?? 0);
  const extra = wins.map((w, k) => ({ w, k })).filter(o => o.k !== refI);
  return { wins, refI, ref: wins[refI], extra };
}

/* The field is capped at four cars — the reference plus three. Not arbitrary: each ghost
 * is a full car AND a per-frame skinned-driver vertex upload, so the cost is linear in
 * cars and the driver is the expensive part. Four is also the point past which a chase
 * camera stops being able to show them together. */
const MAX_CARS = 4;

/** Add another replay's best lap as a comparison run. */
function addCompareRun(ab, name) {
  if (compareRuns.length >= MAX_CARS - 1) throw new Error(`four cars on track is the limit`);
  const rep = ACReplay.parseReplay(ab);
  const cex = ACReplay.extractCar(rep, 0);
  const wins = Ghosts.lapWindows(cex);
  if (!wins.length) throw new Error("that replay has no completed lap to compare");
  const win = wins[Ghosts.bestLapIndex(cex) ?? 0];
  // the slip signal, then this run's own rubber. computeWheelSlip fills ex.slip /
  // ex.smokeSlip, which buildTireMarkMesh needs — without it a ghost lays no marks at all
  // and it looks like the feature is broken rather than the data being absent.
  try {
    const sl = computeWheelSlip(cex);
    cex.slip = sl.slip; cex.smokeSlip = sl.smokeSlip;
  } catch (_) { /* an older replay without wheel data simply lays no rubber */ }
  let mvbo = null, mcount = 0;
  try {
    const mesh = buildTireMarkMesh(cex);
    mcount = mesh.length / 8;
    if (mcount) { mvbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, mvbo); gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW); }
  } catch (_) { mvbo = null; mcount = 0; }
  compareRuns.push({
    ex: cex,
    label: String(name || "run").replace(/\.acreplay$/i, "").slice(-28),
    win,
    markVBO: mvbo, markCount: mcount,
    dists: Ghosts.lapDistances(cex, win),
    color: LAP_COLORS[(compareRuns.length + 1) % LAP_COLORS.length],
    offsetS: 0,                                    // race stagger, seconds; only used in time align
    rig: { roll: 0, pitch: 0, headYaw: 0, headRoll: 0 },   // this car's own driver
  });
  lapCompare = true;
  const btn = document.getElementById("btnLapCmp");
  if (btn) btn.classList.add("on");
  buildGeometry();
}

/** speed (km/h) at a fractional frame, linearly interpolated; NaN-safe */
function speedAtFrame(f) {
  if (!isFinite(f)) return NaN;
  const i0 = Math.max(0, Math.min(ex.N - 1, Math.floor(f)));
  const i1 = Math.min(ex.N - 1, i0 + 1);
  const a = ex.speed[i0], b = ex.speed[i1];
  if (!isFinite(a)) return isFinite(b) ? b : NaN;
  if (!isFinite(b)) return a;
  return a + (b - a) * (f - i0);
}

function buildLapOverlays() {
  for (const o of (bufs.lapOverlays || [])) gl.deleteBuffer(o.buf);
  bufs.lapOverlays = [];
  if (!lapCompare) return;
  const info = lapOverlayInfo();
  if (!info) return;
  const { wins, refI, ref } = info;

  const refDists = Ghosts.lapDistances(ex, ref);
  refAligned = { ex, win: ref, dists: refDists };

  // every comparison lap: the extra laps inside this replay, plus every loaded run
  const laps = [
    ...info.extra.map(o => ({ ex, win: o.w, dists: Ghosts.lapDistances(ex, o.w),
                              color: LAP_COLORS[(o.k + 1) % LAP_COLORS.length],
                              label: `lap ${o.k + 1}` })),
    ...compareRuns,
  ];

  for (const run of laps) {
    const { ex: cex, win, dists, color: col } = run;
    const P = cex.pos, NM = cex.nrm;
    const v = [];
    for (let i = win.start + 1; i <= win.end; i++) {
      if (cex.gap[i] || cex.gap[i - 1]) continue;
      // where on the lap is this frame, and what was the reference doing at that same place?
      const d = dists[i - win.start];
      const rf = Ghosts.frameAtDistance(refDists, d);
      const dv = isFinite(rf) ? (cex.speed[i] - speedAtFrame(ref.start + rf)) : NaN;
      // green faster, red slower, the run's own colour where there is nothing to compare
      let c;
      if (!isFinite(dv)) c = col;
      else {
        const t = Math.max(-1, Math.min(1, dv / LAP_DV_FULL));
        c = t >= 0 ? [0.25 + 0.15 * t, 0.55 + 0.45 * t, 0.30 + 0.10 * t]
                   : [0.65 - 0.35 * t, 0.30 + 0.10 * t, 0.28 + 0.08 * t];
      }
      // lifted a little more than the centre line so the overlay never z-fights it
      const L = 0.9;
      for (const j of [i - 1, i]) {
        v.push(P[j*3] + NM[j*3]*L, P[j*3+1] + NM[j*3+1]*L, P[j*3+2] + NM[j*3+2]*L, c[0], c[1], c[2], 1);
      }
    }
    if (!v.length) continue;
    const arr = new Float32Array(v);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    bufs.lapOverlays.push({ buf, n: arr.length / 7, color: col, timeMs: win.timeMs, label: run.label });
  }
  renderLapLegend(info);
}

/* ===================== ghost cars =====================
 * Each comparison lap gets the SAME car, drawn from the same uploaded model — one upload,
 * N draws, which is what the carId→model cache in ghosts.js exists for. Nothing here
 * re-uploads geometry per ghost.
 *
 * Placed by DISTANCE, not by clock. At the reference car's current position round the lap,
 * each ghost is drawn at the frame where IT was at that same distance — so a ghost ahead
 * on screen is a ghost that was genuinely quicker to that point, and the gap you see IS
 * the time delta. Playing them on a common clock would put them side by side forever and
 * show nothing.
 *
 * It carries its own telemetry: its own steer (carModelMatrix returns per-run steer since
 * the multi-ghost refactor), its own recorded wheel positions, its own roll distance. A
 * ghost wearing the reference car's wheel data would be a puppet, not a lap. */
/** How far round the reference lap we currently are, in metres (NaN outside it).
 *
 * INTERPOLATED, not rounded. Rounding to a whole reference frame quantised the ghost's
 * distance to the replay's 66 Hz sample rate while the reference car moved smoothly at
 * the display rate — so the ghost held still for several frames and then jumped, which
 * reads as judder or, against a moving background, as a blurred double image. Every
 * other consumer of a frame index here is fractional; this was the one that was not. */
function refDistanceNow(refFrame) {
  if (!refAligned) return NaN;
  const rel = refFrame - refAligned.win.start;
  const n = refAligned.dists.length;
  if (rel < 0 || rel > n - 1) return NaN;
  const i0 = Math.floor(rel), i1 = Math.min(n - 1, i0 + 1);
  const f = rel - i0;
  return refAligned.dists[i0] + (refAligned.dists[i1] - refAligned.dists[i0]) * f;
}

/* Two ways to place a ghost, because they answer different questions.
 *
 *   DISTANCE (default) — draw it where IT was at the same point on track. The gap you see
 *   IS the time delta. This is the coaching view: who was ahead through this corner.
 *
 *   TIME — run every lap on one clock, each with its own start offset. Nobody is "ahead
 *   by definition"; they start where you place them and race. This is the watching view,
 *   and the offset is what makes it a race rather than a synchronised demonstration —
 *   without it four laps of the same driver launch as one car and never separate.
 */
/* Default is TIME, and getting this wrong is worth recording.
 *
 * I first defaulted the CARS to distance alignment and described it as "the gap you see
 * is the delta". That is exactly backwards. Distance alignment draws every car at the
 * frame where IT had covered the same distance — so all of them sit at the same point on
 * track, superimposed, interpenetrating. There is no gap to see, and no car is lit by
 * another because they are all zero metres apart.
 *
 * The gap you can see comes from a SHARED CLOCK: at the same elapsed time, the quicker
 * car is further along, and the distance between the cars on screen IS the time delta
 * made visible. That is the racing view and the right default for watching cars.
 *
 * Distance alignment stays, because it is right for the OTHER two consumers — the line
 * overlay (compare the paths at the same corner) and the speed-difference colouring
 * (what were you doing HERE). It is a legitimate car view too, for comparing attitude
 * through one corner, just not the default.
 */
let lapAlign = "time";   // "time" (race, cars spread by pace) | "distance" (cars superimposed)

function ghostFrameAt(run, refFrame) {
  if (lapAlign === "time") {
    const elapsed = refFrame - (refAligned ? refAligned.win.start : 0);   // frames into the reference lap
    const f = run.win.start + elapsed + (run.offsetS || 0) / run.ex.dt;
    return (f >= run.win.start && f <= run.win.end) ? f : NaN;
  }
  const d = refDistanceNow(refFrame);
  if (!isFinite(d)) return NaN;
  const f = Ghosts.frameAtDistance(run.dists, d);
  return isFinite(f) ? run.win.start + f : NaN;               // ghost hasn't reached here
}

/* Live telemetry per ghost, at the SAME PLACE on track rather than the same moment:
 * its speed there, and the running time delta. Both are only meaningful distance-aligned —
 * "he was 8 km/h faster than you" is a fact about a corner, not about a clock reading. */
function updateLapLegendLive() {
  const el = document.getElementById("lapcmp");
  if (!el || !lapCompare || !refAligned || el.style.display === "none") return;
  const refFrame = tCur / ex.dt;
  const d = refDistanceNow(refFrame);
  const rs = speedAtFrame(refFrame);
  const refEl = document.getElementById("lcref");
  if (refEl) refEl.textContent = isFinite(d) ? `${isFinite(rs) ? rs.toFixed(0) : "—"} km/h · ${(d / 1000).toFixed(2)} km in` : "outside the lap";
  for (const span of el.querySelectorAll(".lclive")) {
    const run = compareRuns[+span.dataset.i];
    if (!run) continue;
    const f = ghostFrameAt(run, refFrame);
    if (!isFinite(f) || !isFinite(d)) { span.textContent = "not here yet"; continue; }
    const gi = Math.max(0, Math.min(run.ex.N - 1, Math.round(f)));
    const gs = run.ex.speed[gi];
    const dt = Ghosts.deltaAtDistance(refAligned, run, d);    // + = this run slower to here
    const dv = isFinite(gs) && isFinite(rs) ? gs - rs : NaN;
    const sign = (v, unit, dp) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(dp)}${unit}`;
    span.innerHTML = `${isFinite(gs) ? gs.toFixed(0) : "—"} km/h ` +
      (isFinite(dv) ? `<span style="color:${dv >= 0 ? "#7fdc8a" : "#e08b7f"}">${sign(dv, "", 0)}</span> ` : "") +
      (isFinite(dt) ? `· <span style="color:${dt <= 0 ? "#7fdc8a" : "#e08b7f"}">${sign(dt, "s", 2)}</span>` : "");
  }
}

// This frame's ghosts: matrix AND the run + fractional frame that produced it. The
// additive effects (thruster, backfire, lamp glow) are drawn in a later pass than the
// bodies — after the opaque and glass passes, where additive blending belongs — so they
// need to reach back for the pose rather than re-solve it.
let ghostDraws = [];

/* Solve every ghost's pose ONCE, before anything draws.
 *
 * It has to happen this early for two reasons that only showed up with several cars:
 * the shadow pass runs before the colour pass, so poses solved during drawing were a
 * frame stale in the shadow map; and one car's lamps can only light another car if both
 * matrices exist before either body is drawn. Solving up front also stops the same
 * carModelMatrix being computed twice per ghost per frame. */
function solveGhostPoses() {
  ghostDraws = [];
  if (!lapCompare || !carGroups || !compareRuns.length) return;
  const refFrame = tCur / ex.dt;
  for (const run of compareRuns) {
    const f = ghostFrameAt(run, refFrame);
    if (!isFinite(f)) continue;
    const gi = Math.max(0, Math.min(run.ex.N - 1, Math.floor(f)));
    if (run.ex.gap[gi]) continue;
    const r = carModelMatrix(f, run.ex);                       // this run's pose AND its own steer
    ghostDraws.push({ run, f, mat: r.mat, steer: r.steer });
  }
}

/* Every car on track as a lamp source: slot 0 is always the reference car, then the
 * ghosts in order. Built once per frame and handed to setCarLamps for the track pass and
 * again per car (with that car's slot skipped) for the body passes, so a ghost's
 * headlights fall on the road and on the other cars exactly as the reference car's do.
 *
 * The ghost objects carry `self` back to their entry, so drawGhostCars can find which
 * slot to skip without searching by matrix identity. */
function allCarLamps(nightF, refBrakeInt, cm) {
  const headOn = (carLights && carLights.head && carLights.head.length >= 2 && nightF > 0.02) ? nightF : 0;
  const cars = [{ mat: cm, headInt: headOn, brakeInt: refBrakeInt }];
  for (const g of ghostDraws) {
    const gg = carGForces(g.f, g.run.ex);
    const gdec = gg ? gg.brakeG - BRAKE_SCRUB * gg.latG * gg.latG : 0;
    const gb = Math.max(0, Math.min(1, (gdec - BRAKE_DEADZONE_G) / BRAKE_RANGE_G));
    const entry = { mat: g.mat, headInt: headOn, brakeInt: gb * nightF, ghost: g };
    g.self = entry;
    cars.push(entry);
  }
  return cars;
}

function drawGhostCars(mvp, headVP, nightF, allCars) {
  if (!ghostDraws.length) return;
  for (const g of ghostDraws) {
    const gm = g.mat, gsteer = g.steer, f = g.f, run = g.run;
    // lit by whichever other car is closest — its headlights and its brake lights
    // lit by every OTHER car, not one chosen neighbour: skip is this car's own slot
    if (CAR_LIGHTS_ON) setCarLamps(allCars, headVP, allCars.indexOf(g.self));
    drawCarGroups(carGroups, gm);
    if (carWheels) {
      const rollDist = wheelRollDistance(f, run.ex);
      for (const w of carWheels) {
        const roll = WHEEL_ROLL_SIGN * rollDist / (w.radius || 0.35);
        const kIdx = (/F$/i.test(w.corner) ? 0 : 2) + (/^L/i.test(w.corner) ? 0 : 1);
        const W = wheelWorldAt(f, kIdx, run.ex);               // this run's recorded suspension
        if (W) {
          const tyre = wheelSteerModel(gm, w.pivot, gsteer, roll, 0);
          const cage = wheelSteerModel(gm, w.pivot, gsteer, 0, 0);
          const pw = mXfPt(w.pivot, gm), dx = W[0]-pw[0], dy = W[1]-pw[1], dz = W[2]-pw[2];
          tyre[12] += dx; tyre[13] += dy; tyre[14] += dz;
          cage[12] += dx; cage[13] += dy; cage[14] += dz;
          drawCarGroups(w.rollGroups, tyre); drawCarGroups(w.staticGroups, cage);
        } else {
          drawCarGroups(w.rollGroups, wheelSteerModel(gm, w.pivot, gsteer, roll, 0));
          drawCarGroups(w.staticGroups, wheelSteerModel(gm, w.pivot, gsteer, 0, 0));
        }
      }
    }
    // cockpit wheel + driver, on this run's own steer and its OWN smoothed rig. The rig
    // holds eased values (head yaw/roll, body lean); sharing one between cars would make
    // every driver's head chase whichever car was posed last, at a rate none of them are
    // actually turning. The skinned mesh is a per-car vertex upload, so N cars is N
    // uploads a frame — the real cost of a full-fidelity ghost, and why the roster is capped.
    const animS = carDriver && carDriver.steerAnim;
    const effLock = animS ? animS.lock : Math.min(STEER_WHEEL_MAX, (carDriver && carDriver.gripLock) || Infinity);
    const kSteer = (carSteerRef > 1e-3 && isFinite(effLock)) ? effLock / carSteerRef : STEER_WHEEL_RATIO;
    const gspin = Math.max(-effLock, Math.min(effLock, gsteer * kSteer * STEER_WHEEL_SIGN));
    if (carSteerWheel)
      drawCarGroups(carSteerWheel.groups, axisSpinModel(gm, carSteerWheel.ax[STEER_WHEEL_AXIS], gspin, carSteerWheel.pivot));
    if (carDriver) {
      if (!run.rig) run.rig = { roll: 0, pitch: 0, headYaw: 0, headRoll: 0 };
      const dp = driverPose(f, gm, gsteer, run.ex, run.rig);
      if (animS) driverSkinUpload(driverAnimWorlds(animS, animT(animS, gspin * DRIVER_GRIP_SPIN_SIGN)));
      else driverSeatedSkin(gspin * DRIVER_GRIP_SPIN_SIGN, run);   // `run` identifies this ghost
      for (const sm of carDriver.skinned) drawCarGroups([sm.grp], dp.body);
      drawCarGroups(carDriver.headGroups, dp.head);   // ghosts are never the camera car, so no head-hide
    }
  }
  // No need to restore the skin buffer here: this runs BEFORE the reference car's own
  // driver block, which uploads its pose every frame regardless. Restoring would be a
  // second full vertex upload per frame to undo something nothing has read yet.
}

function buildGeometry() {
  const N = ex.N, P = ex.pos, NM = ex.nrm;
  // the ribbon is ALWAYS the driven line, never a road stand-in — that costume
  // read as "track with a centered line" until the real road renders under it
  const trackLoaded = !!(bufs.trackIdxN || sceneGroups);
  const HALF = trackLoaded ? 0.95 : 2.0;
  const LIFT = trackLoaded ? 0.4 : 0;
  const rib = new Float32Array((N - 1) * 2 * 7 * 2); // 2 verts/frame, pos3+col4, x2 triangles handled by strip via degenerate skip
  // simpler: build triangle list segment by segment to survive gaps
  const verts = [];
  function colAt(i) {
    const v = colorMode === "speed" ? ex.speed[i] : ex.tilt[i];
    if (colorMode === "speed") return isFinite(v) ? speedRGB(v) : [0.3, 0.34, 0.42];
    return isFinite(v) ? bankRGB(v) : [0.3, 0.34, 0.42];
  }
  function edge(i) {
    // right vector = normalize(cross(normal, forward))
    const j = Math.min(i + 1, N - 1);
    let fx = P[j * 3] - P[i * 3], fy = P[j * 3 + 1] - P[i * 3 + 1], fz = P[j * 3 + 2] - P[i * 3 + 2];
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    const nx = NM[i * 3], ny = NM[i * 3 + 1], nz = NM[i * 3 + 2];
    let rx = ny * fz - nz * fy, ry = nz * fx - nx * fz, rz = nx * fy - ny * fx;
    const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    const lx = nx * LIFT, ly = ny * LIFT, lz = nz * LIFT;
    return [
      P[i * 3] - rx * HALF + lx, P[i * 3 + 1] - ry * HALF + ly, P[i * 3 + 2] - rz * HALF + lz,
      P[i * 3] + rx * HALF + lx, P[i * 3 + 1] + ry * HALF + ly, P[i * 3 + 2] + rz * HALF + lz,
    ];
  }
  const [ra, rb] = frameRange();
  let prevEdge = null, prevCol = null, prevI = -1;
  for (let i = ra; i < rb; i++) {
    if (ex.gap[i]) { prevEdge = null; continue; }
    const e = edge(i), c = colAt(i);
    if (prevEdge && i - prevI <= 3) {
      // two triangles: (pL,pR,cL) (pR,cR,cL)
      const shade = 0.85 + 0.15 * Math.max(0, NM[i * 3 + 1]); // slight top-light
      const cc = [c[0] * shade, c[1] * shade, c[2] * shade];
      const pc = prevCol;
      verts.push(
        prevEdge[0], prevEdge[1], prevEdge[2], pc[0], pc[1], pc[2], 1,
        prevEdge[3], prevEdge[4], prevEdge[5], pc[0], pc[1], pc[2], 1,
        e[0], e[1], e[2], cc[0], cc[1], cc[2], 1,
        prevEdge[3], prevEdge[4], prevEdge[5], pc[0], pc[1], pc[2], 1,
        e[3], e[4], e[5], cc[0], cc[1], cc[2], 1,
        e[0], e[1], e[2], cc[0], cc[1], cc[2], 1,
      );
    }
    prevEdge = e; prevCol = c; prevI = i;
  }
  const arr = new Float32Array(verts);
  if (!bufs.ribbon) bufs.ribbon = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, bufs.ribbon);
  gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
  bufs.ribbonN = arr.length / 7;

  // center line (slightly lifted along normal) — only over a real track;
  // over the bare ribbon it reads as "a line in the middle of the road"
  const lv = [];
  for (let i = trackLoaded ? ra + 1 : rb; i < rb; i++) {
    if (ex.gap[i] || ex.gap[i - 1]) continue;
    const c1 = colAt(i - 1), c2 = colAt(i);
    lv.push(
      P[(i - 1) * 3] + NM[(i - 1) * 3] * 0.6, P[(i - 1) * 3 + 1] + NM[(i - 1) * 3 + 1] * 0.6, P[(i - 1) * 3 + 2] + NM[(i - 1) * 3 + 2] * 0.6,
      Math.min(1, c1[0] * 1.35), Math.min(1, c1[1] * 1.35), Math.min(1, c1[2] * 1.35), 1,
      P[i * 3] + NM[i * 3] * 0.6, P[i * 3 + 1] + NM[i * 3 + 1] * 0.6, P[i * 3 + 2] + NM[i * 3 + 2] * 0.6,
      Math.min(1, c2[0] * 1.35), Math.min(1, c2[1] * 1.35), Math.min(1, c2[2] * 1.35), 1,
    );
  }
  const larr = new Float32Array(lv);
  if (!bufs.line) bufs.line = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, bufs.line);
  gl.bufferData(gl.ARRAY_BUFFER, larr, gl.STATIC_DRAW);
  bufs.lineN = larr.length / 7;

  buildLapOverlays();

  // ground grid at minY - 20
  let minX = 1e30, maxX = -1e30, minY = 1e30, minZ = 1e30, maxZ = -1e30, maxY = -1e30;
  for (let i = ra; i < rb; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const gy = minY - 20, gstep = 200;
  const gv = [];
  const gx0 = Math.floor((minX - 400) / gstep) * gstep, gx1 = maxX + 400;
  const gz0 = Math.floor((minZ - 400) / gstep) * gstep, gz1 = maxZ + 400;
  for (let x = gx0; x <= gx1; x += gstep) gv.push(x, gy, gz0, 0.10, 0.12, 0.17, 1, x, gy, gz1, 0.10, 0.12, 0.17, 1);
  for (let z = gz0; z <= gz1; z += gstep) gv.push(gx0, gy, z, 0.10, 0.12, 0.17, 1, gx1, gy, z, 0.10, 0.12, 0.17, 1);
  const garr = new Float32Array(gv);
  if (!bufs.grid) bufs.grid = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, bufs.grid);
  gl.bufferData(gl.ARRAY_BUFFER, garr, gl.STATIC_DRAW);
  bufs.gridN = garr.length / 7;

  // camera fit
  cam.target = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  cam.dist = Math.max(maxX - minX, maxZ - minZ, maxY - minY) * 0.9 + 200;
}

function bindAndDraw(buf, n, mode, ptSize) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(locPos);
  gl.enableVertexAttribArray(locCol);
  gl.vertexAttribPointer(locPos, 3, gl.FLOAT, false, 28, 0);
  gl.vertexAttribPointer(locCol, 4, gl.FLOAT, false, 28, 12);
  gl.uniform1f(locPt, ptSize || 1);
  gl.drawArrays(mode, 0, n);
}

/* Lap comparison legend — the lap times, and which colour is which lap. Facts only:
 * the line colour says where each lap was faster or slower, this says which lap it is
 * and what it cost. Hidden entirely when comparison is off. */
function renderLapLegend(info) {
  let el = document.getElementById("lapcmp");
  if (!el) {
    el = document.createElement("div");
    el.id = "lapcmp";
    el.style.cssText = "position:absolute;left:12px;top:96px;z-index:6;font:12px/1.5 Cascadia Mono,Consolas,monospace;" +
      "background:rgba(8,10,14,.82);border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:8px 10px;color:#cfd6e4";
    document.body.appendChild(el);
  }
  if (!lapCompare || !info) { el.style.display = "none"; return; }
  el.style.display = "block";
  const fmt = (ms) => {
    if (!ms) return "—";
    const s = ms / 1000;
    return `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`;
  };
  const refMs = info.ref.timeMs;
  const swatch = (c) => `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;` +
    `background:rgb(${c.map(x => Math.round(x * 255)).join(",")})"></span>`;
  const row = (c, label, ms, isRef) => {
    const d = isRef ? "reference"
      : (ms && refMs ? `${ms >= refMs ? "+" : "−"}${(Math.abs(ms - refMs) / 1000).toFixed(3)}` : "");
    return `<div>${swatch(c)}${label} · ${fmt(ms)} <span style="opacity:.6">${d}</span></div>`;
  };
  const rows = [
    row([1, 1, 1], `lap ${info.refI + 1}`, refMs, true) +
      `<div style="margin:0 0 3px 15px;opacity:.75"><span id="lcref">—</span></div>`,
    ...info.extra.map(o => row(LAP_COLORS[(o.k + 1) % LAP_COLORS.length], `lap ${o.k + 1}`, o.w.timeMs, false)),
    ...compareRuns.map((r, i) => row(r.color, r.label, r.win.timeMs, false) +
      `<div style="margin:0 0 3px 15px;opacity:.75"><span class="lclive" data-i="${i}">—</span></div>`),
  ].join("");
  const full = compareRuns.length >= MAX_CARS - 1;
  const addRow = `<div id="lcadd" style="margin-top:6px;cursor:${full ? "default" : "pointer"};opacity:${full ? ".4" : ".8"}">` +
    (full ? `four cars is the limit` : `+ add a lap`) + `</div>`;
  // distance = coaching (gap on screen IS the delta); race = one clock, staggered starts
  const modeRow = `<div style="margin-top:6px;opacity:.75">align: ` +
    `<span id="lcmd" style="cursor:pointer;text-decoration:underline">${lapAlign === "time" ? "race (one clock)" : "same point (cars overlap)"}</span></div>`;
  // offsets only mean anything on a shared clock; in distance align a ghost is placed by
  // where it was, so shifting it in time would describe a lap nobody drove
  const offRows = (lapAlign === "time" && compareRuns.length)
    ? `<div style="margin-top:5px;opacity:.75">start offset</div>` + compareRuns.map((r, i) =>
        `<div style="display:flex;gap:6px;align-items:center">${swatch(r.color)}` +
        `<span class="lcoff" data-i="${i}" data-d="-1" style="cursor:pointer;padding:0 5px">−</span>` +
        `<span style="min-width:52px;display:inline-block;text-align:center">${(r.offsetS || 0).toFixed(1)}s</span>` +
        `<span class="lcoff" data-i="${i}" data-d="1" style="cursor:pointer;padding:0 5px">+</span></div>`).join("")
    : "";
  el.innerHTML = `<div style="opacity:.55;margin-bottom:4px">lap comparison · green = faster here</div>` +
    rows + addRow + modeRow + offRows;

  const add = document.getElementById("lcadd");
  if (add && !full) add.onclick = showLapPicker;
  const md = document.getElementById("lcmd");
  if (md) md.onclick = () => { lapAlign = lapAlign === "time" ? "distance" : "time"; renderLapLegend(lapOverlayInfo()); };
  for (const b of el.querySelectorAll(".lcoff")) {
    b.onclick = () => {
      const r = compareRuns[+b.dataset.i];
      if (!r) return;
      r.offsetS = Math.round(((r.offsetS || 0) + (+b.dataset.d) * 0.5) * 10) / 10;
      renderLapLegend(lapOverlayInfo());
    };
  }
}

/* Picking the lap to compare against — IN THE APP, never an OS folder dialog.
 * BLACKBOX already knows every replay for the loaded track (replays_for_track) and
 * already parses each one's fastest lap for the track browser, so the natural picker is
 * a list of this track's laps by time. Sending the chair out to a file dialog to hunt
 * for a filename that encodes the time in a timestamp would be handing him back a job
 * the program has already done. The file input survives only as the browser fallback,
 * where there is no native side to ask. */
let lapPickEl = null;
function ensureLapPicker() {
  if (lapPickEl) return lapPickEl;
  lapPickEl = document.createElement("div");
  lapPickEl.id = "lappick";
  lapPickEl.style.cssText = "position:absolute;left:12px;top:96px;z-index:8;min-width:290px;max-height:60vh;overflow:auto;" +
    "font:12px/1.55 Cascadia Mono,Consolas,monospace;background:rgba(8,10,14,.94);border:1px solid rgba(255,255,255,.12);" +
    "border-radius:6px;padding:8px 10px;color:#cfd6e4";
  document.body.appendChild(lapPickEl);
  return lapPickEl;
}
function hideLapPicker() { if (lapPickEl) lapPickEl.style.display = "none"; }

async function showLapPicker() {
  if (!inTauri) { document.getElementById("lapcmppick").click(); return; }   // browser: no native list
  const el = ensureLapPicker();
  el.style.display = "block";
  const head = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">` +
    `<span style="opacity:.55">compare against…</span>` +
    `<span id="lappickx" style="cursor:pointer;opacity:.5;padding:0 4px">✕</span></div>`;
  el.innerHTML = head + `<div style="opacity:.6">reading this track's replays…</div>`;
  el.querySelector("#lappickx").onclick = hideLapPicker;

  const track = replay && replay.track;
  if (!track) { el.innerHTML = head + `<div style="opacity:.6">load a replay first</div>`; el.querySelector("#lappickx").onclick = hideLapPicker; return; }
  let list;
  try { list = await tinvoke("replays_for_track", { track }); }
  catch (e) { el.innerHTML = head + `<div style="opacity:.7">${esc(String(e))}</div>`; el.querySelector("#lappickx").onclick = hideLapPicker; return; }

  const others = (list || []).filter(r => r.name !== currentReplayName);
  if (!others.length) {
    el.innerHTML = head + `<div style="opacity:.6">no other replays recorded on this track</div>`;
    el.querySelector("#lappickx").onclick = hideLapPicker; return;
  }
  el.innerHTML = head + others.map((r, i) =>
    `<div class="lprow" data-i="${i}" style="cursor:pointer;padding:3px 4px;border-radius:3px;display:flex;gap:10px;justify-content:space-between">` +
    `<span style="opacity:.85">${esc(fmtReplayDate(r))}</span><span class="lp" style="opacity:.5">reading…</span></div>`).join("");
  el.querySelector("#lappickx").onclick = hideLapPicker;

  // lap times, same way the track browser gets them: parse each replay once
  const rows = [...el.querySelectorAll(".lprow")];
  for (let i = 0; i < others.length; i++) {
    const r = others[i], row = rows[i];
    try {
      const ab = await tinvoke("read_file", { path: r.path });
      const cex = ACReplay.extractCar(ACReplay.parseReplay(ab), 0);
      const best = fastestLap(cex);
      row.querySelector(".lp").textContent = best ? fmtLapMs(best) : "no timed lap";
      row.querySelector(".lp").style.opacity = best ? "1" : ".4";
      if (best) {
        row.onmouseenter = () => row.style.background = "rgba(255,255,255,.07)";
        row.onmouseleave = () => row.style.background = "";
        // stays open after a pick: building a four-car field means choosing three, and
        // reopening the list between each one would be three round trips for one decision
        row.onclick = async () => {
          if (row.dataset.added) return;
          try {
            addCompareRun(await tinvoke("read_file", { path: r.path }), r.name);
            row.dataset.added = "1";
            row.style.opacity = ".45";
            row.querySelector(".lp").textContent = "on track";
            if (compareRuns.length >= MAX_CARS - 1) hideLapPicker();   // field full, nothing left to choose
          } catch (err) { row.querySelector(".lp").textContent = String(err.message || err); }
        };
      }
    } catch (e) { row.querySelector(".lp").textContent = "unreadable"; }
  }
}

document.getElementById("lapcmppick").addEventListener("change", function () {
  const f = this.files && this.files[0];
  this.value = "";
  if (!f) return;
  f.arrayBuffer().then(ab => addCompareRun(ab, f.name)).catch(err => {
    const el = document.getElementById("lapcmp");
    if (el) { el.style.display = "block"; el.innerHTML = `<div style="opacity:.7">${err.message || err}</div>`; }
  });
});

document.getElementById("btnLapCmp").addEventListener("click", function () {
  if (!ex) return;
  lapCompare = !lapCompare;
  this.classList.toggle("on", lapCompare);
  buildGeometry();
  if (!lapCompare) { renderLapLegend(null); hideLapPicker(); return; }
  // turning it on with no runs loaded: go straight to picking one, since an empty
  // comparison is a toggle that visibly does nothing. Adding MORE runs is the legend's
  // "+ add a lap" — the button stays a plain on/off so it can always be turned off.
  const info = lapOverlayInfo();
  if (info && info.extra.length + compareRuns.length === 0) showLapPicker();
});
