/* carrender.js — car body + wheels + driver rendering and posing.
 * Pure render/pose functions, loaded before the main script (shared global scope).
 * They read/write app state declared in index.html (ex, carSteerAngle, carWheels,
 * carDriver, carSteerWheel, driverRig, the STEER_WHEEL_/WHEEL_ROLL/SUSP_/DRIVER_
 * tunables) and use gl/tLoc from glcore.js and the helpers in mathutil.js — all at
 * call time (runtime), so load order is fine.
 *
 * MULTI-GHOST: the per-car functions take the run they operate on (`src`) and return
 * their per-car results rather than writing app globals — carModelMatrix returns
 * {mat, steer} instead of assigning carSteerAngle. Omit `src` and they fall back to the
 * primary run, which is what the single-car path still does. Still global, deliberately:
 * carGForces and driverRig read/serve the HUD and the driver you're actually watching.
 */
// build the car's world matrix at a FRACTIONAL frame position. Orientation is
// the REAL recorded body attitude: up = road surface normal, heading = the
// front-axle→rear-axle vector from the wheels (carries the true slip angle the
// car actually had). Everything interpolated so it's smooth at any refresh.
function carModelMatrix(fpos, src) {
  const E = src || ex;                 // src = a ghost's own run; default = the primary
  const P = E.pos, NM = E.nrm, FW = E.fwd, N = E.N;
  const i0 = Math.max(0, Math.min(N - 1, Math.floor(fpos)));
  const i1 = Math.min(N - 1, i0 + 1);
  const f = E.gap[i1] ? 0 : Math.max(0, Math.min(1, fpos - i0));
  const lp = (A, o) => A[i0 * 3 + o] + (A[i1 * 3 + o] - A[i0 * 3 + o]) * f;
  const px0 = lp(P, 0), py0 = lp(P, 1), pz0 = lp(P, 2);
  // up
  let ux = lp(NM, 0), uy = lp(NM, 1), uz = lp(NM, 2);
  const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
  // real body heading (wheels); velocity as sign-reference + fallback. The velocity
  // window is INTERPOLATED across the sub-frame (i0→i1 by f) so the steer angle — and
  // thus the wheels + exo — is smooth at any refresh, not stepped at the 66 Hz frames.
  const a = Math.max(0, i0 - 3), b = Math.min(N - 1, i0 + 4);
  const a1 = Math.max(0, i1 - 3), b1 = Math.min(N - 1, i1 + 4);
  const vx = (P[b*3]-P[a*3]) + ((P[b1*3]-P[a1*3]) - (P[b*3]-P[a*3])) * f;
  const vy = (P[b*3+1]-P[a*3+1]) + ((P[b1*3+1]-P[a1*3+1]) - (P[b*3+1]-P[a*3+1])) * f;
  const vz = (P[b*3+2]-P[a*3+2]) + ((P[b1*3+2]-P[a1*3+2]) - (P[b*3+2]-P[a*3+2])) * f;
  let hx = lp(FW, 0), hy = lp(FW, 1), hz = lp(FW, 2);
  if (Math.hypot(hx, hy, hz) < 1e-4) { hx = vx; hy = vy; hz = vz; }  // fallback to velocity
  let hl = Math.hypot(hx, hy, hz) || 1; hx /= hl; hy /= hl; hz /= hl;
  // NOTE: do NOT re-align the nose to the velocity. The wheel heading (front axle −
  // rear axle) already IS the true nose direction; forcing it to point with travel
  // flips the car 180° ("switches ends") exactly when the drift passes 90°, which is
  // when we most want to see the real backward-facing slide. Trust the wheels.
  const hd = hx * ux + hy * uy + hz * uz; hx -= ux * hd; hy -= uy * hd; hz -= uz * hd; // ⟂ up
  hl = Math.hypot(hx, hy, hz) || 1; hx /= hl; hy /= hl; hz /= hl;
  // amplify the real slip (angle between travel and body heading) toward the crab look
  if (carSlipExag !== 1) {
    let vpx = vx, vpy = vy, vpz = vz;
    const vd = vpx * ux + vpy * uy + vpz * uz; vpx -= ux * vd; vpy -= uy * vd; vpz -= uz * vd;
    const vpl = Math.hypot(vpx, vpy, vpz);
    if (vpl > 1e-4) {
      vpx /= vpl; vpy /= vpl; vpz /= vpl;
      const dvh = Math.max(-1, Math.min(1, vpx * hx + vpy * hy + vpz * hz));
      const cX = vpy * hz - vpz * hy, cY = vpz * hx - vpx * hz, cZ = vpx * hy - vpy * hx;
      const sign = (cX * ux + cY * uy + cZ * uz) >= 0 ? 1 : -1;
      let ang = Math.acos(dvh) * sign * carSlipExag;
      ang = Math.max(-1.4, Math.min(1.4, ang)); // cap at ~80°
      const c = Math.cos(ang), s = Math.sin(ang);
      hx = vpx * c + (uy * vpz - uz * vpy) * s;
      hy = vpy * c + (uz * vpx - ux * vpz) * s;
      hz = vpz * c + (ux * vpy - uy * vpx) * s;
      hl = Math.hypot(hx, hy, hz) || 1; hx /= hl; hy /= hl; hz /= hl;
    }
  }
  const rx = -(uy * hz - uz * hy), ry = -(uz * hx - ux * hz), rz = -(ux * hy - uy * hx); // right
  // steer angle for the FRONT wheels: turn them to point along the actual travel
  // direction (the line) while the body keeps its crabbed heading. It's the slip
  // angle, capped at the steering lock. (X = right, Z = nose in the car's frame.)
  // RETURNED rather than written to a global: with several ghosts on track each car
  // needs its own steer, and one shared global meant the last car drawn silently
  // overwrote the steering of every car drawn before it.
  let steer = 0;
  {
    let sx = vx, sy = vy, sz = vz;
    const sd = sx * ux + sy * uy + sz * uz; sx -= ux * sd; sy -= uy * sd; sz -= uz * sd; // travel ⟂ up
    const sl = Math.hypot(sx, sy, sz);
    if (sl > 1e-4) {
      sx /= sl; sy /= sl; sz /= sl;
      const vH = sx * hx + sy * hy + sz * hz;   // along nose (+Z local)
      const vR = sx * rx + sy * ry + sz * rz;   // along right (+X local)
      // point the wheels EXACTLY at the line — no steering-lock cap. The T-180
      // crabs to 90°+ and the wheels follow all the way (atan2 handles the full range).
      steer = Math.atan2(vR, vH);
    }
  }
  // local axes → world: X→right, Y→up, Z(nose)→heading
  return {
    mat: new Float32Array([
      rx, ry, rz, 0,
      ux, uy, uz, 0,
      hx, hy, hz, 0,
      px0 + ux * carLift, py0 + uy * carLift, pz0 + uz * carLift, 1,
    ]),
    steer,
  };
}

// draw a set of car mesh groups under a model matrix (progT must be active with its
// shared uniforms already set; sets uModel per call so wheels can differ from body)
function drawCarGroups(groups, modelMat) {
  gl.uniformMatrix4fv(tLoc.model, false, modelMat);
  for (const g of groups) {
    gl.bindTexture(gl.TEXTURE_2D, g.tex);
    gl.uniform1f(tLoc.alphaTest, g.alphaTested ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.posBuf);
    gl.enableVertexAttribArray(tLoc.pos); gl.vertexAttribPointer(tLoc.pos, 3, gl.FLOAT, false, 12, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.nrmBuf);
    gl.enableVertexAttribArray(tLoc.nrm); gl.vertexAttribPointer(tLoc.nrm, 3, gl.FLOAT, false, 12, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.uvBuf);
    gl.enableVertexAttribArray(tLoc.uv); gl.vertexAttribPointer(tLoc.uv, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.idxBuf);
    gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
  }
}
// carMat ⊗ (rotate about model-up through the wheel centre by `steer`) — steers a
// front wheel to point down the line. X=right, Z=nose in the car's local frame.
/* Scratch for the three matrices that never leave this function. Four wheels x every car x
 * every frame put three throwaway 16-element Arrays plus the mMul result on the heap per
 * call; only the returned matrix is retained by the caller, so only it is allocated. */
const _wsRy = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
const _wsRx = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
const _wsR  = new Float32Array(16);
function wheelSteerModel(carMat, pivot, steer, roll, lift) {
  const cy = Math.cos(steer), sy = Math.sin(steer);
  const cx = Math.cos(roll || 0), sx = Math.sin(roll || 0);
  const Ry = _wsRy, Rx = _wsRx;
  Ry[0] = cy; Ry[2] = -sy; Ry[8] = sy; Ry[10] = cy;     // steer about up (model Y)
  Rx[5] = cx; Rx[6] = sx; Rx[9] = -sx; Rx[10] = cx;     // roll about the axle (model X)
  const R = mMulInto(_wsR, Ry, Rx);   // roll in the wheel's own frame, then steer that frame
  const px = pivot[0], py = pivot[1], pz = pivot[2];   // rotate about the wheel-centre pivot
  R[12] = px - (R[0]*px + R[4]*py + R[8]*pz);
  R[13] = py - (R[1]*px + R[5]*py + R[9]*pz) + (lift || 0);   // suspension travel along body up (model Y)
  R[14] = pz - (R[2]*px + R[6]*py + R[10]*pz);
  // the one retained allocation: two of these are alive at once at some call sites (tyre and
  // cage), so this result cannot come from shared scratch.
  return mMulInto(new Float32Array(16), carMat, R);
}
// lateral / longitudinal / vertical g at fractional frame `fp`, from the path's local
// acceleration — deterministic (scrub-safe) and windowed so it's smooth. Feeds the
// procedural suspension (dive/squat, roll, bumps). Same math the driver lean reads.
function carGForces(fp, src) {
  const E = src || ex;
  const P = E.pos, N = E.N, dt = E.dt;
  const i = Math.max(1, Math.min(N - 2, Math.round(fp)));
  const w = Math.max(3, Math.round(0.1 / dt));
  const a = Math.max(0, i - w), b = Math.min(N - 1, i + w);
  let ux = E.nrm[i*3], uy = E.nrm[i*3+1], uz = E.nrm[i*3+2]; const ul = Math.hypot(ux,uy,uz)||1; ux/=ul;uy/=ul;uz/=ul;
  let hx = P[b*3]-P[a*3], hy = P[b*3+1]-P[a*3+1], hz = P[b*3+2]-P[a*3+2];
  const hd = hx*ux+hy*uy+hz*uz; hx-=ux*hd; hy-=uy*hd; hz-=uz*hd; const hl = Math.hypot(hx,hy,hz)||1; hx/=hl;hy/=hl;hz/=hl;
  const rx = uy*hz-uz*hy, ry = uz*hx-ux*hz, rz = ux*hy-uy*hx;   // right = up×heading
  const iv = 1 / (w * dt);
  const dvx = ((P[b*3]-P[i*3]) - (P[i*3]-P[a*3])) * iv * iv;
  const dvy = ((P[b*3+1]-P[i*3+1]) - (P[i*3+1]-P[a*3+1])) * iv * iv;
  const dvz = ((P[b*3+2]-P[i*3+2]) - (P[i*3+2]-P[a*3+2])) * iv * iv;
  const longG = (dvx*hx + dvy*hy + dvz*hz) / 9.81;
  const latG = (dvx*rx + dvy*ry + dvz*rz) / 9.81;
  return {
    latG,                                         // + = pushed toward +right (raw, includes banking gravity)
    longG,                                        // + = accelerating, − = braking (raw)
    vertA: (dvx*ux + dvy*uy + dvz*uz) / 9.81,     // + = pushed up (bump), − = crest
    // gravity-corrected braking: heading is flattened to the road plane, so gravity's
    // along-track pull is just its vertical component (hy). Subtracting it means climbing
    // a loop/banking no longer reads as braking. + = real braking-direction contact force.
    brakeG: -longG - hy,
    // gravity-corrected lateral (same trick on the right axis): the "right" vector tilts
    // with banking, so gravity projects onto it (its y-component, ry). Subtracting that
    // leaves only the tyre's GENUINE lateral demand — near zero when the banking carries
    // the car, large only when actually cornering harder than the bank supports. This is
    // what should lay rubber, so banked laps stop over-marking.
    latGcorr: latG + ry,
  };
}
// Kinematic upshift detection (the replay has no gear channel): an upshift briefly cuts
// torque, so longitudinal acceleration dips sharply toward zero mid-pull. Returns the
// frame indices of detected shifts (used to trigger exhaust backfires). Approximate.
function detectShifts(ex) {
  const dt = ex.dt, N = ex.N;
  const v = new Float64Array(N);
  for (let f = 0; f < N; f++) v[f] = (ex.speed[f] || 0) / 3.6;   // m/s
  const W = Math.max(1, Math.round(0.045 / dt)), acc = new Float64Array(N).fill(NaN);
  for (let f = W; f < N - W; f++) { if (ex.gap && (ex.gap[f] || ex.gap[f-W] || ex.gap[f+W])) continue; acc[f] = (v[f+W] - v[f-W]) / (2 * W * dt); }
  const K = Math.max(2, Math.round(0.12 / dt)), minGap = Math.round(0.3 / dt), shifts = [];
  let last = -1e9;
  for (let f = K + W; f < N - K - W; f++) {
    const a = acc[f]; if (!isFinite(a)) continue;
    const aL = acc[f - K], aR = acc[f + K]; if (!isFinite(aL) || !isFinite(aR)) continue;
    const flank = Math.min(aL, aR);
    // accelerating on both sides, a sharp dip toward zero, a true local min, spaced out
    if (flank > 2.0 && a < 1.2 && a < flank * 0.5 && v[f] > 12 && f - last > minGap) {
      let lm = true; for (let k = -K; k <= K; k++) if (isFinite(acc[f + k]) && acc[f + k] < a - 0.01) { lm = false; break; }
      if (lm) { shifts.push(f); last = f; }
    }
  }
  return shifts;
}
// per-wheel suspension travel (m, along body up): dive/squat + roll + bump, clamped
function wheelLift(w, g) {
  const front = w.front, left = w.pivot[0] > 0;
  let lift = (front ? -1 : 1) * g.longG * SUSP_LONG          // brake → front compresses, rear extends
           + (left ? 1 : -1) * g.latG * SUSP_LAT * SUSP_LAT_SIGN  // outer corner compresses
           + g.vertA * SUSP_BUMP;                            // bumps push all four up
  return Math.max(-SUSP_MAX, Math.min(SUSP_MAX, lift));
}
// travelled distance (m) at fractional frame `fp`, interpolated — drives the wheel
// roll-spin so it's scrub-safe (scrub back → wheels roll back, pause → they stop).
function wheelRollDistance(fp, src) {
  const E = src || ex;
  const cd = E && E.cumDist; if (!cd) return 0;
  const i = Math.max(0, Math.min(E.N - 1, Math.floor(fp)));
  const j = Math.min(E.N - 1, i + 1);
  return cd[i] + (cd[j] - cd[i]) * (fp - i);
}
// recorded wheel-centre WORLD position at fractional frame `fp` for wheel k (0=FL,1=FR,
// 2=RL,3=RR). This is the real per-wheel position from the replay — placing each wheel
// here makes it track the actual banked/bumpy surface (real suspension), no floating.
// Returns null when the frame's wheel quad is invalid (gap / unsupported replay).
function wheelWorldAt(fp, k, src) {
  const E = src || ex;
  const W = E && E.wheels, ok = E && E.wheelsOk; if (!W) return null;
  const N = E.N;
  const i0 = Math.max(0, Math.min(N - 1, Math.floor(fp)));
  const i1 = Math.min(N - 1, i0 + 1);
  if (!ok[i0] || !ok[i1]) return null;
  const f = E.gap[i1] ? 0 : Math.max(0, Math.min(1, fp - i0));   // snap across a discontinuity, like the body
  const at = (i, o) => W[i * 12 + k * 3 + o];
  const lin = o => at(i0, o) + (at(i1, o) - at(i0, o)) * f;
  // Catmull-Rom through the recorded centres when a clean 4-frame stencil exists
  // (no ends, no gap spanning it). Smooths sharp single-frame suspension events
  // (curb strikes) that plain lerp would ramp linearly; identical to lerp otherwise.
  const im1 = i0 - 1, ip2 = i1 + 1;
  const clean = im1 >= 0 && ip2 < N && ok[im1] && ok[ip2]
    && !E.gap[i0] && !E.gap[i1] && !E.gap[ip2];
  if (!clean) return [lin(0), lin(1), lin(2)];
  const f2 = f * f, f3 = f2 * f;
  const cr = o => {
    const p0 = at(im1, o), p1 = at(i0, o), p2 = at(i1, o), p3 = at(ip2, o);
    return 0.5 * (2*p1 + (-p0 + p2)*f + (2*p0 - 5*p1 + 4*p2 - p3)*f2 + (-p0 + 3*p1 - 3*p2 + p3)*f3);
  };
  return [cr(0), cr(1), cr(2)];
}

// ---- tyre slip signal → skid marks + smoke ---------------------------------
// The REAL signal, from recorded wheel data: the SLIP ANGLE — the angle between where
// the car points (body heading from front axle − rear axle, `ex.fwd`) and where it's
// actually travelling (velocity). A gripping tyre points where it goes (slip ≈ 0°, even
// at huge banked-corner G); a sliding/scrubbing tyre doesn't. This is what actually lays
// rubber and makes smoke — unlike lateral G, which is tyre LOAD (high while gripping too).
// Units are DEGREES. Validated: a gripping centrifuge lap reads ~0-3°, real slides read high.
const SKID_ON = 9;        // deg of slip below this lays NO rubber (grip); above → marks
const SKID_RANGE = 16;    // deg span above the deadzone that ramps 0→full intensity
function skidIntensity(s) { return Math.max(0, Math.min(1, (s - SKID_ON) / SKID_RANGE)); }
const SMOKE_ON = 9;       // deg of slip below this makes NO smoke
const SMOKE_RANGE = 14;
function smokeIntensity(s) { return Math.max(0, Math.min(1, (s - SMOKE_ON) / SMOKE_RANGE)); }
// Real AC wheelSlip → equivalent "smoke degrees" so it feeds the same tuned pipeline.
// Calibrated from a clean PB lap: grip sits <2, p95≈7, real slides run ~20–80+ (spiking to
// thousands on a lockup). ON sits just above the grip band; full by +42. This is PER-WHEEL,
// so rear wheelspin or a locked front tyre smoke on their own — things the car-wide slip
// ANGLE can't see. ON/SPAN are the tuning knobs.
const REAL_SLIP_ON = 8, REAL_SLIP_SPAN = 42;
function realSlipToDeg(s) { return SMOKE_ON + Math.max(0, Math.min(1, (s - REAL_SLIP_ON) / REAL_SLIP_SPAN)) * SMOKE_RANGE; }
// Fills two signals per wheel [frame*4 + k], k = 0:FL 1:FR 2:RL 3:RR, both in degrees:
//   slip      — slip angle × outer-wheel weight (marks: outer tyres scrub more)
//   smokeSlip — the car-wide slip angle (smoke; rear bias is applied at emit time)
// Returns { slip, smokeSlip }; callers apply skidIntensity()/smokeIntensity().
function computeWheelSlip(ex) {
  const N = ex.N, P = ex.pos, F = ex.fwd, NM = ex.nrm, dt = ex.dt, gap = ex.gap;
  const slip = new Float32Array(N * 4), smokeSlip = new Float32Array(N * 4);
  for (let i = 1; i < N - 1; i++) {
    if (gap[i] || gap[i - 1] || gap[i + 1]) continue;              // need both neighbours for velocity
    let hx = F[i*3], hy = F[i*3+1], hz = F[i*3+2]; const hn = Math.hypot(hx, hy, hz);
    if (hn < 1e-6) continue; hx /= hn; hy /= hn; hz /= hn;         // body heading (unit)
    const vx = (P[(i+1)*3] - P[(i-1)*3]) / (2*dt), vy = (P[(i+1)*3+1] - P[(i-1)*3+1]) / (2*dt), vz = (P[(i+1)*3+2] - P[(i-1)*3+2]) / (2*dt);
    const sp = Math.hypot(vx, vy, vz); if (sp < 5) continue;       // below ~18 km/h slip angle is just noise
    let ux = NM[i*3], uy = NM[i*3+1], uz = NM[i*3+2]; const un = Math.hypot(ux, uy, uz) || 1; ux /= un; uy /= un; uz /= un;
    let rx = uy*hz - uz*hy, ry = uz*hx - ux*hz, rz = ux*hy - uy*hx; const rn = Math.hypot(rx, ry, rz) || 1; rx /= rn; ry /= rn; rz /= rn;
    const latV = vx*rx + vy*ry + vz*rz, alongV = vx*hx + vy*hy + vz*hz;
    const slipDeg = Math.abs(Math.atan2(latV, alongV)) * 180 / Math.PI;   // sideways-slide angle
    const outerRight = latV > 0;                                   // the side sliding outward scrubs more
    const hasReal = ex.tel && ex.tel.has && ex.tel.has.slip;       // real per-wheel wheelSlip available?
    for (let k = 0; k < 4; k++) {
      const right = (k === 1 || k === 3);
      slip[i*4 + k] = slipDeg * (right === outerRight ? 1.0 : 0.6); // marks: outer wheels weighted
      // smoke: car-wide slip ANGLE (drift), blended with REAL per-wheel wheelSlip (wheelspin /
      // lockup) when telemetry is present — whichever signal calls for more smoke wins.
      let sm = slipDeg;                                            // kinematic drift angle
      if (hasReal) sm = Math.max(sm, realSlipToDeg(ex.tel.slip[i*4 + k]));
      smokeSlip[i*4 + k] = sm;                                     // rear bias still applied at emit
    }
  }
  return { slip, smokeSlip };
}
// Prebuild the whole skid-mark ribbon mesh once (interleaved: pos3, frame, lap,
// intensity, cross, run — 8 floats/vertex). Centreline is the real recorded contact
// patch; width is across the travel direction, lifted just off the surface. `cross`
// is -1..1 across the width and `run` is metres along the path — the shader uses them
// to draw tread striations + grain. Only laid where the tyre is actually sliding.
function buildTireMarkMesh(ex) {
  const N = ex.N, W = ex.wheels, ok = ex.wheelsOk, NM = ex.nrm, slip = ex.slip;
  if (!W || !ok || !slip) return new Float32Array(0);
  const HALF = 0.14, LIFT = 0.03;              // tyre half-width (m), lift off the surface (m)
  // per-wheel radius (0:FL 1:FR 2:RL 3:RR): drop the recorded wheel CENTRE to the CONTACT
  // PATCH on the track, else marks float ~a radius (≈ a foot) above the surface.
  const R = [0.33, 0.33, 0.33, 0.33];
  if (typeof carWheels !== "undefined" && carWheels)
    for (const w of carWheels) R[(/F$/i.test(w.corner) ? 0 : 2) + (/^L/i.test(w.corner) ? 0 : 1)] = w.radius || 0.33;
  const lapOf = new Int32Array(N);             // lap bucket per frame (crossings passed)
  { const L = ex.laps || []; let li = 0;
    for (let f = 0; f < N; f++) { while (li < L.length && L[li].frame <= f) li++; lapOf[f] = li; } }
  const out = [];
  const push = (p, fr, lp, it, cr, rn) => { out.push(p[0], p[1], p[2], fr, lp, it, cr, rn); };
  // Surface normal AS RECORDED, normalised — deliberately NOT forced toward the sky. extractCar
  // builds nrm from the wheel quad and resolves its winding once for the whole run (the
  // median-tilt flip), so the sign already points out of the road toward the car's roof, and it
  // keeps doing that when the car is past vertical. Forcing uy >= 0 there inverts it, and since
  // `contact` is W - up*r that lands the patch a tyre DIAMETER on the far side of the tarmac —
  // taking the LIFT into the surface with it and reversing `right` = up × travel, so the ribbon
  // also faces backwards. Centrifuge runs 1,313 frames of 16,577 past vertical (7.92%) and t180,
  // the reference replay, has 57 of 7,728 — this was never confined to the one stunt sample.
  // The old comment here called the recorded sign unreliable. What is unreliable is WORLD UP as a
  // stand-in for it, and the measurement that separates them is continuity: as recorded this
  // vector turns at most 12.5° between adjacent 15 ms frames, while forced skyward it swings up
  // to 180° at the crossing — a surface normal that reverses inside 15 ms is not a surface.
  // carModelMatrix already poses the car BODY from this same normal unflipped, so the marks and
  // the car laying them now agree. All of the above is measured in test_skidnormal.js.
  const upAt = (f) => {
    const ux = NM[f*3], uy = NM[f*3+1], uz = NM[f*3+2]; const l = Math.hypot(ux, uy, uz) || 1;
    return [ux/l, uy/l, uz/l];
  };
  const contact = (f, k, up) => { const a = f*12+k*3, r = R[k]; return [W[a]-up[0]*r, W[a+1]-up[1]*r, W[a+2]-up[2]*r]; };
  // ribbon edge: width across travel (right = up × travel), lifted just off the surface
  const edge = (ca, cb, up, sgn) => {
    const tx = cb[0]-ca[0], ty = cb[1]-ca[1], tz = cb[2]-ca[2];
    let rx = up[1]*tz - up[2]*ty, ry = up[2]*tx - up[0]*tz, rz = up[0]*ty - up[1]*tx;
    const rl = Math.hypot(rx, ry, rz) || 1; rx/=rl; ry/=rl; rz/=rl;
    return [ca[0] + up[0]*LIFT + rx*HALF*sgn, ca[1] + up[1]*LIFT + ry*HALF*sgn, ca[2] + up[2]*LIFT + rz*HALF*sgn];
  };
  for (let k = 0; k < 4; k++) {
    let run = 0;                               // metres along this wheel's path (resets across breaks)
    for (let f = 0; f + 1 < N; f++) {
      if (ex.gap[f] || ex.gap[f+1] || !ok[f] || !ok[f+1]) { run = 0; continue; }
      const up0 = upAt(f), up1 = upAt(f+1);
      const c0 = contact(f, k, up0), c1 = contact(f+1, k, up1);
      const run0 = run, run1 = run + Math.hypot(c1[0]-c0[0], c1[1]-c0[1], c1[2]-c0[2]);
      run = run1;                              // advance even when not marking, so the grain stays continuous
      const s0 = skidIntensity(slip[f*4+k]), s1 = skidIntensity(slip[(f+1)*4+k]);
      if (s0 <= 0.01 && s1 <= 0.01) continue;
      const Lo0 = edge(c0, c1, up0, -1), Ro0 = edge(c0, c1, up0, 1);
      const Lo1 = edge(c1, c0, up1, 1), Ro1 = edge(c1, c0, up1, -1);   // c0→c1 flipped for the far end
      const fr0 = f, fr1 = f+1, lp0 = lapOf[f], lp1 = lapOf[f+1];
      push(Lo0, fr0, lp0, s0, -1, run0); push(Ro0, fr0, lp0, s0, 1, run0); push(Lo1, fr1, lp1, s1, -1, run1);
      push(Ro0, fr0, lp0, s0, 1, run0); push(Ro1, fr1, lp1, s1, 1, run1); push(Lo1, fr1, lp1, s1, -1, run1);
    }
  }
  return new Float32Array(out);
}

// carMat ⊗ (rotate `ang` about an arbitrary unit axis through a pivot) — for the
// cockpit steering wheel spinning about its tilted column.
function axisSpinModel(carMat, ax, ang, piv) {
  let x = ax[0], y = ax[1], z = ax[2]; const l = Math.hypot(x, y, z) || 1; x/=l; y/=l; z/=l;
  const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
  const R = [
    t*x*x+c,   t*x*y+s*z, t*x*z-s*y, 0,
    t*x*y-s*z, t*y*y+c,   t*y*z+s*x, 0,
    t*x*z+s*y, t*y*z-s*x, t*z*z+c,   0,
    0, 0, 0, 1,
  ];
  const px = piv[0], py = piv[1], pz = piv[2];
  R[12] = px - (R[0]*px+R[4]*py+R[8]*pz); R[13] = py - (R[1]*px+R[5]*py+R[9]*pz); R[14] = pz - (R[2]*px+R[6]*py+R[10]*pz);
  return new Float32Array(mMul(carMat, R));
}

// Procedural driver pose: read lateral/longitudinal G from the telemetry and lean
// the body + turn the head into the corner. Returns {body, head} model matrices
// (⊗ carMat), smoothed so the motion is slow and weighty.
function driverPose(fp, carMat, steer, src, rig) {
  const E = src || ex;                                   // this ghost's run, else the primary
  const st = steer != null ? steer : carSteerAngle;      // this ghost's steer, else the primary's
  // Each car needs its OWN smoothed rig. These values (headYaw, headRoll, bodyRoll,
  // bodyPitch) ease toward their targets over frames, so two cars sharing one object
  // would blend into a single driver: both heads chasing whichever car was posed last,
  // at a rate neither of them is actually turning.
  const R = rig || driverRig;
  const P = E.pos, N = E.N, dt = E.dt;
  const i = Math.max(1, Math.min(N - 2, Math.round(fp)));
  const w = Math.max(3, Math.round(0.1 / dt));
  const a = Math.max(0, i - w), b = Math.min(N - 1, i + w);
  let ux = E.nrm[i*3], uy = E.nrm[i*3+1], uz = E.nrm[i*3+2]; const ul = Math.hypot(ux,uy,uz)||1; ux/=ul;uy/=ul;uz/=ul;
  let hx = P[b*3]-P[a*3], hy = P[b*3+1]-P[a*3+1], hz = P[b*3+2]-P[a*3+2];
  const hd = hx*ux+hy*uy+hz*uz; hx-=ux*hd; hy-=uy*hd; hz-=uz*hd; const hl = Math.hypot(hx,hy,hz)||1; hx/=hl;hy/=hl;hz/=hl;
  const rx = uy*hz-uz*hy, ry = uz*hx-ux*hz, rz = ux*hy-uy*hx;   // right = up×heading
  const inv = 1 / (w * dt);
  const v1x = (P[i*3]-P[a*3])*inv, v1y = (P[i*3+1]-P[a*3+1])*inv, v1z = (P[i*3+2]-P[a*3+2])*inv;
  const v2x = (P[b*3]-P[i*3])*inv, v2y = (P[b*3+1]-P[i*3+1])*inv, v2z = (P[b*3+2]-P[i*3+2])*inv;
  const dvx = (v2x-v1x)*inv, dvy = (v2y-v1y)*inv, dvz = (v2z-v1z)*inv;   // ≈ acceleration (m/s²)
  const latG = (dvx*rx + dvy*ry + dvz*rz) / 9.81;    // + = pushed toward +right
  const clamp = (v, m) => Math.max(-m, Math.min(m, v));
  // head faces THE LINE, like the wheels: yaw by the slip angle so the driver
  // looks where the car is going — but capped at a realistic neck range (~49°).
  const yawT = clamp(st * DRIVER_HEAD_SIGN, DRIVER_HEAD_YAW_MAX);
  const hrollT = clamp(-latG * 0.035, 0.08);         // a little head tilt with the G (body leans too now)
  const k = 1 - Math.exp(-3.0 / 60);                 // slow settle (~3/s)
  R.headYaw += (yawT - R.headYaw) * k;
  R.headRoll += (hrollT - R.headRoll) * k;
  // subtle head BOB from G-load — nudged opposite the acceleration (inertia): sideways with lateral G,
  // fore/aft with braking/accel. Small + smoothed so it reads as weight, not wobble.
  const longG = (dvx * hx + dvy * hy + dvz * hz) / 9.81;
  // SLIGHT body lean — he's belted in snug, so the torso/shoulders only shift a little with the G
  // (roll into lateral G, pitch forward under braking) about the hips. The head rides on top.
  /* LATERAL ONLY. The fore/aft pitch is gone on purpose: a racing seat plus a harness holds the
   * driver against braking and acceleration almost completely, so bobbing him back and forth under
   * long G reads as wonky rather than weighty — invisible from a chase cam, obvious once the camera
   * sits half a metre away. Lateral sway survives because belts do far less against sideways load
   * and you genuinely see drivers move with it. */
  const bRollT = clamp(-latG * 0.009, 0.02), bPitchT = 0;
  void longG;
  R.bodyRoll = (R.bodyRoll || 0) + (bRollT - (R.bodyRoll || 0)) * k;
  R.bodyPitch = (R.bodyPitch || 0) + (bPitchT - (R.bodyPitch || 0)) * k;
  // The body is a RIGID seated pose (the car's own driver_base_pos.knh, in car
  // space) — hands already on the wheel. Only the head moves, pivoting about the
  // real neck joint (also in car space), then everything rides carMat to world.
  const pv = (carDriver && carDriver.neckPivot) || [0, 1.08, 0.09];
  // head yaw (looks to the line) + a little roll with G — but NO separate positional bob: the head's
  // shift is now purely the CONSEQUENCE of the torso lean it rides on (a separate bob = moonwalk).
  const headExtra = mMul(rotP(1, R.headYaw, pv[0], pv[1], pv[2]), rotP(2, R.headRoll, pv[0], pv[1], pv[2]));
  // torso lean about the hips; the head rides ON the leaned body so shoulders + head move together
  /* Sway about the GRIP, not the hips. Leaning the rigid seated pose about the hips swings the
   * shoulders AND the arms, but the wheel does not move with them, so the hands slid around the rim
   * and the grip read as loose. A driver holding a wheel is hinged at his hands: the grip is the
   * fixed point and the body sways about it. Measured: 4.9 mm of hand drift at max lean → 1.5 mm. */
  const hip = (carDriver && carDriver.wheelC) ? carDriver.wheelC : [0, 0.4, 0.02];
  const bodyExtra = mMul(rotP(2, R.bodyRoll, hip[0], hip[1], hip[2]), rotP(0, R.bodyPitch, hip[0], hip[1], hip[2]));
  const bodyMat = mMul(carMat, bodyExtra);
  return {
    body: new Float32Array(bodyMat),
    head: new Float32Array(mMul(bodyMat, headExtra)),
  };
}

// upload the driver's skinned meshes for a given posed skeleton `world` (array of mat4)
function driverSkinUpload(world, key) {
  for (const sm of carDriver.skinned) {
    /* Reused bone-matrix palette, built once per mesh and refilled in place.
     *
     * This was `.map(... rvMul(...))` — a fresh result array, a fresh closure, and a fresh
     * Float32Array(16) PER BONE, per skinned mesh, per car, every frame. At 360 Hz with a
     * 60-bone palette that is millions of matrices a minute, and the measured heap climbed
     * from 160 MB to 320 MB across a session with collections costing 8-11 ms.
     *
     * `bm` is dead the moment the vertex loop below finishes — nothing retains it, nothing
     * reads it on a later frame — so a per-mesh scratch is safe. The null entries have to
     * stay null rather than become identity: the inner loop tests `if (!M) continue` to skip
     * an unmapped bone, and an identity there would silently pull those vertices to the
     * model origin instead of leaving their weight unapplied. */
    if (!sm._bm) sm._bm = sm.boneNodeIdx.map(ni => ni < 0 ? null : new Float32Array(16));
    const bm = sm._bm;
    for (let b = 0; b < sm.boneNodeIdx.length; b++) {
      const ni = sm.boneNodeIdx[b];
      if (ni >= 0) rvMulInto(bm[b], sm.invBind[b], world[ni]);
    }
    /* PER-CAR skinned output. sm.skinPos/skinNrm are one buffer shared by every car, which
     * is what forced each car to re-pose every frame: skipping a car's pose left whichever
     * car posed last in the buffer, so a ghost would wear another driver's arms.
     *
     * Each car now keeps its own skinned vertices, so a skipped frame can re-upload that
     * car's OWN last result instead of recomputing it. The GL buffer is still shared, so
     * the upload happens every frame regardless — what is saved is the IK solve and the
     * skinning maths, which is the expensive half. Memory is a few hundred KB per car.
     *
     * Falls back to the shared buffer when no key is given, so the load-time seating path
     * and anything else calling driverSkinUpload directly behaves exactly as before. */
    let op = sm.skinPos, on = sm.skinNrm;
    if (key !== undefined) {
      if (!sm._perCar) sm._perCar = new Map();
      let slot = sm._perCar.get(key);
      if (!slot) { slot = { p: new Float32Array(sm.skinPos.length), n: new Float32Array(sm.skinNrm.length) };
                   sm._perCar.set(key, slot); }
      op = slot.p; on = slot.n;
    }
    const bp = sm.bindPos, bn = sm.bindNrm, bw = sm.bw, bi = sm.bi, nv = bp.length / 3;
    for (let v = 0; v < nv; v++) {
      const x = bp[v*3], y = bp[v*3+1], z = bp[v*3+2], nx = bn[v*3], ny = bn[v*3+1], nz = bn[v*3+2];
      let ox=0,oy=0,oz=0,onx=0,ony=0,onz=0;
      for (let k = 0; k < 4; k++) {
        const wt = bw[v*4+k]; if (wt <= 0) continue; const M = bm[bi[v*4+k]]; if (!M) continue;
        ox += wt*(x*M[0]+y*M[4]+z*M[8]+M[12]); oy += wt*(x*M[1]+y*M[5]+z*M[9]+M[13]); oz += wt*(x*M[2]+y*M[6]+z*M[10]+M[14]);
        onx += wt*(nx*M[0]+ny*M[4]+nz*M[8]); ony += wt*(nx*M[1]+ny*M[5]+nz*M[9]); onz += wt*(nx*M[2]+ny*M[6]+nz*M[10]);
      }
      op[v*3]=ox;op[v*3+1]=oy;op[v*3+2]=oz; on[v*3]=onx;on[v*3+1]=ony;on[v*3+2]=onz;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, sm.grp.posBuf); gl.bufferData(gl.ARRAY_BUFFER, op, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, sm.grp.nrmBuf); gl.bufferData(gl.ARRAY_BUFFER, on, gl.DYNAMIC_DRAW);
  }
}

/**
 * Push a car's already-computed skin to the GL buffers without re-solving it.
 *
 * The GL buffer is shared by every car, so even a skipped car has to put ITS vertices back
 * before it draws — otherwise it renders whatever the previous car uploaded. What the skip
 * avoids is the IK solve and the skinning loop, which is the expensive half; the upload is
 * bandwidth and happens either way.
 *
 * Returns false when this car has no cached skin yet, so the caller can fall through to a
 * full pose rather than drawing an empty buffer on the first frame a ghost appears.
 */
function driverSkinReupload(key) {
  for (const sm of carDriver.skinned) {
    const slot = sm._perCar && sm._perCar.get(key);
    if (!slot) return false;
    gl.bindBuffer(gl.ARRAY_BUFFER, sm.grp.posBuf); gl.bufferData(gl.ARRAY_BUFFER, slot.p, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, sm.grp.nrmBuf); gl.bufferData(gl.ARRAY_BUFFER, slot.n, gl.DYNAMIC_DRAW);
  }
  return true;
}

// Glued-grip steering: the hands ride the wheel's REAL grip points at any steer,
// and the wheel turns as far as the arms can physically follow. Three pieces:
//
// gripSat — the wheel's rotation is a smooth saturating map of the raw steer:
// lock·tanh(raw/lock). Near-linear in normal corners, keeps creeping toward the
// lock in hairpins/drifts (never freezes mid-corner like a hard clamp), and never
// spins past what the hands can hold. lock=0 → uncapped (no driver rig to limit it).
function gripSat(raw, lock) { return lock > 0 ? lock * Math.tanh(raw / lock) : raw; }

// armSolve — one arm at one grip angle: orbit the grip (G0 if snapped onto the
// measured rim, else the authored W0) about the wheel axis to the live grip W, and
// when W is past the 2-bone reach, lean the SHOULDER toward it (up to shoulderMax
// metres) the way a real driver rolls a shoulder into a crossed-over turn. Without
// this, ik2bone clamps its target short and the hand floats off the rim — the
// exact artefact this replaces. Pure (testable headless).
function armSolve(arm, ang, C, ax, shoulderMax) {
  const c = Math.cos(ang), s = Math.sin(ang), o = 1 - c;
  const v = v3sub(arm.G0 || arm.W0, C), d = v3dot(ax, v), cx = v3cross(ax, v);
  const W = [C[0] + v[0]*c + cx[0]*s + ax[0]*d*o,           // Rodrigues: W0 orbited to the live grip
             C[1] + v[1]*c + cx[1]*s + ax[1]*d*o,
             C[2] + v[2]*c + cx[2]*s + ax[2]*d*o];
  const reach = (arm.L1 + arm.L2) * 0.999;                   // ik2bone's own clamp threshold
  const over = v3len(v3sub(W, arm.S0)) - reach;
  const S = over > 0 ? v3add(arm.S0, v3sc(v3nrm(v3sub(W, arm.S0)), Math.min(over, shoulderMax))) : arm.S0;
  /* WRIST BEND GOES IN THE ELBOW (docs/DRIVER_WRIST.md attempt 4).
   * A relative rotation is twist + bend. WRIST_FOLLOW absorbs the TWIST in the forearm —
   * measurably, and measurably it cannot touch the bend (test_wristbend.js): it rotates
   * the forearm about its own axis, so elbow→wrist doesn't move, and the hand is welded
   * to the rim, so that doesn't move either. The angle between them is untouched by
   * construction, which is why three attempts at pronation never fixed what the eye sees.
   * The bend's only free variable is WHERE THE ELBOW SITS. ik2bone places it on a circle
   * about the shoulder→wrist axis and `pole` picks the point, so swinging the pole turns
   * the forearm's direction while leaving the wrist on the grip and the hand on the rim.
   * Aim it at the elbow that would make the forearm collinear with the hand — which is
   * what a driver's elbow does rather than folding the wrist. */
  let pole = arm.pole;
  if (WRIST_POLE > 0 && arm.G0) {
    const hv = v3nrm(v3sub(arm.G0, arm.W0));                 // bind hand axis: wrist → grip contact
    const hd = v3dot(ax, hv), hcx = v3cross(ax, hv);         // welded to the rim: same orbit as W
    const hA = [hv[0]*c + hcx[0]*s + ax[0]*hd*o,
                hv[1]*c + hcx[1]*s + ax[1]*hd*o,
                hv[2]*c + hcx[2]*s + ax[2]*hd*o];
    const want = v3sub(v3sub(W, v3sc(hA, arm.L2)), S);       // ideal elbow, relative to the shoulder
    if (v3len(want) > 1e-4) {
      const a0 = v3nrm(arm.pole), a1 = v3nrm(want);          // blend DIRECTIONS; ik2bone only uses the direction
      const k = Math.min(1, WRIST_POLE);
      pole = k >= 1 ? a1 : v3add(v3sc(a0, 1 - k), v3sc(a1, k));
    }
  }
  const { E } = ik2bone(S, W, arm.L1, arm.L2, pole);
  return { S, E, W, ok: over <= shoulderMax };
}

// WRIST_FOLLOW / WRIST_RAMP (declared with the other tunables in index.html): how the wheel's roll
// is absorbed as forearm pronation instead of a folded wrist — see docs/DRIVER_WRIST.md.

// snapToMesh — the grip target is the local CENTRE OF MATERIAL nearest the
// authored grip: nearest wheel vertex, then two mean-shift steps (centroid of the
// verts inside a handle-sized ball). This lands in the middle of the physical
// handle bar and can NEVER land in a hole — a hole has no vertices to attract it.
// (An idealized circle fit can't tell a handle from the opening beside it, which
// put the hands through the T-180's grip holes.) Pure (testable headless).
function snapToMesh(p, verts, ballR) {
  const r2 = (ballR || 0.025) * (ballR || 0.025);
  let best = -1, bd = Infinity;
  for (let i = 0; i + 2 < verts.length; i += 3) {
    const dx = verts[i] - p[0], dy = verts[i+1] - p[1], dz = verts[i+2] - p[2];
    const d = dx*dx + dy*dy + dz*dz;
    if (d < bd) { bd = d; best = i; }
  }
  if (best < 0) return null;
  let c = [verts[best], verts[best+1], verts[best+2]];
  for (let pass = 0; pass < 2; pass++) {
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let i = 0; i + 2 < verts.length; i += 3) {
      const dx = verts[i] - c[0], dy = verts[i+1] - c[1], dz = verts[i+2] - c[2];
      if (dx*dx + dy*dy + dz*dz < r2) { sx += verts[i]; sy += verts[i+1]; sz += verts[i+2]; n++; }
    }
    if (!n) break;
    c = [sx / n, sy / n, sz / n];
  }
  return c;
}

// palmGrip — the rigid shift that puts the PALM CUP (centroid of the curled
// fingers' proximal+middle joints in the seated pose) onto the nearest bar core,
// plus a small depth trim back along the cup→wrist axis. The wrist was the wrong
// thing to place — it sits ~11 cm behind the actual contact, so wrist-based
// placement pushed the fingers past the wheel (screenshot-verified on the T-180).
function palmGrip(cup, W0, verts, trim) {
  const core = snapToMesh(cup, verts);
  if (!core) return null;
  let shift = v3sub(core, cup);
  if (trim) {
    const back = v3sub(W0, cup), l = v3len(back);
    if (l > 1e-6) shift = v3add(shift, v3sc(back, trim / l));
  }
  return shift;
}

// gripLockCalib — sweep the orbit both ways at load and find the largest angle
// BOTH hands can still reach (shoulder lean included). The wheel's lock is
// calibrated to THIS car's actual rig, not a guessed constant.
function gripLockCalib(arms, C, ax, shoulderMax) {
  let lock = Math.PI;
  for (const sgn of [1, -1]) {
    let a = 0;
    for (; a < Math.PI; a += 0.01) {
      let ok = true;
      for (const arm of arms) if (!armSolve(arm, sgn * a + (arm.gripBase || 0), C, ax, shoulderMax).ok) { ok = false; break; }
      if (!ok) break;
    }
    lock = Math.min(lock, Math.max(0, a - 0.01));
  }
  return lock;
}

// ---- authored steering animation (steer.ksanim) ----
// The car ships the mod author's own lock-to-lock steering animation: clavicles,
// arms, hands, EVERY finger, authored ON this wheel — palms wrapped around the
// grips at every angle. When present it drives the driver (AC itself drives this
// same file from steer input); the IK/snap pipeline below stays as the fallback
// for cars without one.

// quaternion (x,y,z,w) → row-vector rotation matrix rows (v' = v·M)
function ksanimLocal(nd, ff) {   // sample one node's PQS track at fractional frame ff
  const last = nd.p.length / 3 - 1;
  const f0 = Math.max(0, Math.min(last, Math.floor(ff))), f1 = Math.min(last, f0 + 1), t = Math.max(0, Math.min(1, ff - f0));
  const px = nd.p[f0*3] + (nd.p[f1*3] - nd.p[f0*3]) * t;
  const py = nd.p[f0*3+1] + (nd.p[f1*3+1] - nd.p[f0*3+1]) * t;
  const pz = nd.p[f0*3+2] + (nd.p[f1*3+2] - nd.p[f0*3+2]) * t;
  let ax = nd.q[f0*4], ay = nd.q[f0*4+1], az = nd.q[f0*4+2], aw = nd.q[f0*4+3];
  let bx = nd.q[f1*4], by = nd.q[f1*4+1], bz = nd.q[f1*4+2], bw = nd.q[f1*4+3];
  if (ax*bx + ay*by + az*bz + aw*bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let qx = ax + (bx-ax)*t, qy = ay + (by-ay)*t, qz = az + (bz-az)*t, qw = aw + (bw-aw)*t;   // nlerp
  const ql = Math.hypot(qx, qy, qz, qw) || 1; qx/=ql; qy/=ql; qz/=ql; qw/=ql;
  const sx = nd.s[f0*3] + (nd.s[f1*3] - nd.s[f0*3]) * t;
  const sy = nd.s[f0*3+1] + (nd.s[f1*3+1] - nd.s[f0*3+1]) * t;
  const sz = nd.s[f0*3+2] + (nd.s[f1*3+2] - nd.s[f0*3+2]) * t;
  return [   // S·R with translation row (row-vector convention, matches kn5 node matrices)
    (1 - 2*(qy*qy + qz*qz)) * sx, (2*(qx*qy + qz*qw)) * sx, (2*(qx*qz - qy*qw)) * sx, 0,
    (2*(qx*qy - qz*qw)) * sy, (1 - 2*(qx*qx + qz*qz)) * sy, (2*(qy*qz + qx*qw)) * sy, 0,
    (2*(qx*qz + qy*qw)) * sz, (2*(qy*qz - qx*qw)) * sz, (1 - 2*(qx*qx + qy*qy)) * sz, 0,
    px, py, pz, 1,
  ];
}

// driverAnimWorlds — compose the skeleton's world matrices at anim time t (0..1):
// animated nodes take their ksanim local, the rest keep the seated pose's local,
// all chained parent→child (kn5 node order is depth-first, parents first).
function driverAnimWorlds(st, t) {
  const skel = st.skel, N = skel.count;
  const ff = Math.max(0, Math.min(1, t)) * (st.anim.frameCount - 1);
  const world = new Array(N);
  for (let i = 0; i < N; i++) {
    const L = st.track[i] ? ksanimLocal(st.track[i], ff) : st.L0[i];
    const p = skel.parent[i];
    world[i] = p >= 0 ? rvMul(L, world[p]) : L;
  }
  return world;
}

// driverAnimInit — bind the ksanim to the skeleton and calibrate its wheel range
// from the HAND's own arc about the wheel axis (θ(t) lookup, so hands and wheel
// stay in exact sync even where the authored animation isn't linear in t).
function driverAnimInit(anim, skel, poseWorld, poseLocal, wheelC, wheelAxis) {
  if (!anim || !anim.frameCount || anim.frameCount < 2) return null;
  const track = new Array(skel.count).fill(null);
  const byName = new Map(); for (const nd of anim.nodes) byName.set(nd.name, nd);
  let hits = 0;
  for (let i = 0; i < skel.count; i++) { const nd = byName.get(skel.name[i]); if (nd) { track[i] = nd; hits++; } }
  if (!hits) return null;
  const L0 = new Array(skel.count);
  for (let i = 0; i < skel.count; i++)
    L0[i] = (poseLocal && poseLocal[skel.name[i]]) || skel.localBind[i];
  const st = { anim, track, L0, skel };
  const ax = v3nrm(wheelAxis);
  let u = v3cross(ax, [0, 1, 0]); if (v3len(u) < 1e-4) u = v3cross(ax, [1, 0, 0]);
  u = v3nrm(u); const w2 = v3cross(ax, u);
  const hL = skel.name.findIndex(n => /RIG_HAND_L$/.test(n));
  const hand = hL >= 0 ? hL : skel.name.findIndex(n => /RIG_HAND_R$/.test(n));
  if (hand < 0) return null;
  const S = 25, map = [];
  let prev = 0;
  for (let i = 0; i < S; i++) {
    const world = driverAnimWorlds(st, i / (S - 1));
    const M = world[hand], v = v3sub([M[12], M[13], M[14]], wheelC);
    let th = Math.atan2(v3dot(v, w2), v3dot(v, u));
    if (i) { while (th - prev > Math.PI) th -= 2 * Math.PI; while (th - prev < -Math.PI) th += 2 * Math.PI; }
    map.push(th); prev = th;
  }
  const c = map[(S - 1) >> 1];
  for (let i = 0; i < S; i++) map[i] -= c;   // θ relative to the animation's centre
  st.map = map;
  st.lock = Math.min(Math.abs(map[0]), Math.abs(map[S - 1]));
  // an anim whose hand barely sweeps (the T-180's moves ~3 cm lock-to-lock) can't
  // express a wheel that visibly turns — fall back to the IK path, which can
  if (st.lock < 0.35) return null;
  return st;
}

// animT — invert the θ(t) lookup: which anim time puts the hands at wheel spin
// `spin`. Clamps into the authored range.
function animT(st, spin) {
  const m = st.map, S = m.length;
  const lo = Math.min(m[0], m[S - 1]), hi = Math.max(m[0], m[S - 1]);
  const s = Math.max(lo, Math.min(hi, spin));
  for (let i = 0; i + 1 < S; i++) {
    const a = m[i], b = m[i + 1];
    if ((s >= Math.min(a, b) && s <= Math.max(a, b)) || i === S - 2) {
      const f = Math.abs(b - a) > 1e-9 ? (s - a) / (b - a) : 0;
      return (i + Math.max(0, Math.min(1, f))) / (S - 1);
    }
  }
  return 0.5;
}

// ---- per-run linear steer scale ----
// per-frame slip-steer straight from the extract (the same travel-vs-heading math
// the model matrix uses), computable at load without touching the draw path
function steerOfFrame(E, i) {
  const P = E.pos, N = E.N;
  const a = Math.max(0, i - 3), b = Math.min(N - 1, i + 4);
  let ux = E.nrm[i*3], uy = E.nrm[i*3+1], uz = E.nrm[i*3+2];
  const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
  let vx = P[b*3]-P[a*3], vy = P[b*3+1]-P[a*3+1], vz = P[b*3+2]-P[a*3+2];
  let hx = E.fwd[i*3], hy = E.fwd[i*3+1], hz = E.fwd[i*3+2];
  if (Math.hypot(hx, hy, hz) < 1e-4) { hx = vx; hy = vy; hz = vz; }
  const hd = hx*ux + hy*uy + hz*uz; hx -= ux*hd; hy -= uy*hd; hz -= uz*hd;
  const hl = Math.hypot(hx, hy, hz) || 1; hx /= hl; hy /= hl; hz /= hl;
  const rx = -(uy*hz - uz*hy), ry = -(uz*hx - ux*hz), rz = -(ux*hy - uy*hx);
  const sd = vx*ux + vy*uy + vz*uz; vx -= ux*sd; vy -= uy*sd; vz -= uz*sd;
  const sl = Math.hypot(vx, vy, vz);
  if (sl < 1e-4) return 0;
  return Math.atan2((vx*rx + vy*ry + vz*rz) / sl, (vx*hx + vy*hy + vz*hz) / sl);
}

// 98th-percentile |steer| of the whole run — the wildest sustained steer this
// replay actually reaches. The wheel maps LINEARLY (proportional the whole way,
// no saturating crawl) so that THIS lands exactly at the lock: condensed zone,
// per-run self-calibrated, and the wheel never visibly stalls while the car turns.
function steerRefCalib(E) {
  if (!E || !E.N) return 0;
  const vals = [];
  for (let i = 4; i < E.N - 4; i += 2) {
    if (E.gap[i]) continue;
    const s = Math.abs(steerOfFrame(E, i));
    if (isFinite(s)) vals.push(s);
  }
  if (vals.length < 50) return 0;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.98)];
}

// Skin the driver's body into this car's authored seated pose (driver_base_pos.knh),
// which places the skeleton — and therefore the hands — onto THIS car's wheel. Each
// bone's world matrix comes straight from the knh (car space); bones absent from it
// fall back to the model's bind pose. `spin` (rad) orbits both hands with the wheel:
// per arm the grip point rotates about the wheel axis and the elbow re-solves (2-bone
// IK), then the whole arm→hand→finger subtree rotates so nothing tears. spin=0
// reproduces the seated pose exactly. Rigid body otherwise, so only the arms move.
function driverSeatedPose(spin) {
  const D = carDriver;
  if (!D || !D.poseWorld) return null;
  const skel = D.skel, N = skel.count;
  const world = new Array(N);
  for (let i = 0; i < N; i++) world[i] = D.poseWorld[skel.name[i]] || skel.bindWorld[i];
  if (D.arms && D.wheelAxis) {     // runs at spin=0 too: snapped grips re-seat the hands onto the measured rim
    const C = D.wheelC, ax = D.wheelAxis;
    const A0 = ax[0], A1 = ax[1], A2 = ax[2];
    const rotMat = (c, s, o) => new Float32Array([   // row-vector rotation MATRIX about `ax` (the wheel's own spin)
      c + A0*A0*o, A0*A1*o + A2*s, A0*A2*o - A1*s, 0,
      A0*A1*o - A2*s, c + A1*A1*o, A1*A2*o + A0*s, 0,
      A0*A2*o + A1*s, A1*A2*o - A0*s, c + A2*A2*o, 0,
      0, 0, 0, 1]);
    for (const arm of D.arms) {
      const ang = spin + (arm.gripBase || 0);   // steer + this hand's base grip-height offset
      const c = Math.cos(ang), s = Math.sin(ang), o = 1 - c;
      const { S, E, W } = armSolve(arm, ang, C, ax, DRIVER_SHOULDER_REACH);   // live grip + (possibly leaned) shoulder + elbow
      const dS = v3sub(S, arm.S0);                                // shoulder lean (zero within plain reach)
      const Rup = rvFromTo(v3sub(arm.E0, arm.S0), v3sub(E, S));   // upper arm swings about the leaned shoulder
      const W1 = v3add(S, mRot(v3sub(arm.W0, arm.S0), Rup));      // wrist after lean + Rup
      const Rfore = rvFromTo(v3sub(W1, E), v3sub(W, E));          // forearm swings about E → wrist lands ON the grip
      // the HAND is welded to the WHEEL, not swung with the arm: its orientation is
      // the authored grip orbited about the wheel axis, exactly like the wheel mesh.
      // (Stacking Rup+Rfore+roll on it — the old way — twisted the wrist goofily at
      // crossed-over angles.) The arm swings to meet the wrist; the wrist flex is
      // whatever connects them, which is what a real wrist does.
      const handSet = arm.handSub ? new Set(arm.handSub) : null;
      for (const b of arm.armSub) {                               // arm (minus hand): translate with the shoulder, then swing
        if (handSet && handSet.has(b)) continue;
        const M = Array.from(world[b]); M[12] += dS[0]; M[13] += dS[1]; M[14] += dS[2];
        world[b] = rvRotAbout(M, Rup, S);
      }
      for (const b of arm.foreSub) { if (handSet && handSet.has(b)) continue; world[b] = rvRotAbout(world[b], Rfore, E); }
      /* WRIST TWIST GOES IN THE FOREARM, not the wrist joint.
       * The hand is welded to the rim (below), so it carries the full wheel rotation. The forearm,
       * placed by IK, only knows where the elbow and wrist ARE — not how the hand is rolled. The
       * difference has to appear somewhere, and with nothing else absorbing it, it shows up as a
       * bent wrist on the hand travelling DOWN the rim (turn left → left hand at the bottom → left
       * wrist folds, and mirrored on a right turn).
       * A real arm does this with pronation: the radius rotates about the forearm's own axis, which
       * moves neither the elbow nor the wrist, so it is free for us too. Roll the forearm by the
       * part of the wheel's rotation that lies ALONG that axis and the wrist comes back straight. */
      if (arm.foreSub && WRIST_FOLLOW > 0) {
        const u = v3nrm(v3sub(W, E));                       // forearm axis, elbow → wrist
        const twist = ang * v3dot(ax, u) * WRIST_FOLLOW;    // the wheel's spin resolved onto that axis
        if (Math.abs(twist) > 1e-4) {
          // rvRotAbout wants a 4x4 ROTATION MATRIX (same convention rvFromTo returns), not an
          // axis-angle 3-vector — handing it one silently reads undefined elements, fills the
          // matrix with NaN, and the arm disappears rather than erroring.
          const mkTw = t => {
            const cw = Math.cos(t), sw = Math.sin(t), Cw = 1 - cw;
            const x = u[0], y = u[1], z = u[2];
            return new Float32Array([
              cw + x*x*Cw,     x*y*Cw + z*sw, x*z*Cw - y*sw, 0,
              x*y*Cw - z*sw,   cw + y*y*Cw,   y*z*Cw + x*sw, 0,
              x*z*Cw + y*sw,   y*z*Cw - x*sw, cw + z*z*Cw,   0,
              0, 0, 0, 1,
            ]);
          };
          // twist-bone distribution: the proximal forearm turns only WRIST_RAMP of the
          // pronation (the elbow crease barely shears), the distal ForeArm_END subtree
          // turns all of it, and the skin weighted between the two bones blends the
          // ramp. Rigs without the END bone fall back to the one-lump form.
          const endSet = arm.foreEndSub && arm.foreEndSub.length ? new Set(arm.foreEndSub) : null;
          const Rprox = mkTw(endSet ? twist * WRIST_RAMP : twist);
          const Rfull = endSet ? mkTw(twist) : null;
          for (const b of arm.foreSub) {
            if (handSet && handSet.has(b)) continue;
            world[b] = rvRotAbout(world[b], endSet && endSet.has(b) ? Rfull : Rprox, E);
          }
        }
      }
      if (arm.handSub) {                                          // hand: shift onto the measured rim, then orbit with the wheel
        const Rw = rotMat(c, s, o), dW = arm.gripShift;
        for (const b of arm.handSub) {
          let M = world[b];
          if (dW) { M = Array.from(M); M[12] += dW[0]; M[13] += dW[1]; M[14] += dW[2]; }
          world[b] = rvRotAbout(M, Rw, C);
        }
      }
    }
  }
  return world;
}

/* DRIVER POSE RATE, decoupled from the display rate.
 *
 * The whole IK re-pose plus skin runs here, and it was running once per car per FRAME —
 * 360 times a second on a 360 Hz panel. It is by a wide margin the largest per-frame
 * allocator in the app, and it is resampling a signal that does not move anywhere near that
 * fast: a driver's forearms and fingers at 360 Hz is 360 solutions of a pose that changes
 * over tenths of a second.
 *
 * WHY THIS IS SAFE, and it is the reason to do it this way rather than rewrite the IK maths
 * with out-params: the driver is skinned in CAR-LOCAL space and placed in the world by the
 * car matrix, which still updates every single frame. So capping this rate makes the
 * ARTICULATION update at 144 Hz while the driver still rides the car exactly as before. The
 * position is never stale; only the elbow angle is, by up to 7 ms.
 *
 * Skipping also skips the upload, which is correct — the VBO still holds the last skin, and
 * re-uploading identical vertices would keep the bandwidth while dropping only the maths.
 *
 * PER CAR, now that each car keeps its own skinned vertices.
 *
 * This was keyed on which car posed LAST, because one shared skin buffer meant skipping a
 * car left whichever car posed most recently in it — a ghost wearing another driver's arms.
 * The consequence was that the cap did nothing whenever ghosts were on track, which is
 * exactly the heaviest case: four cars, four full IK solves per frame, the cap disabled.
 *
 * With per-car skinned output a skipped car re-uploads its OWN last result, so the cap now
 * applies to every car independently. The upload still happens every frame because the GL
 * buffer is shared; what is skipped is the solve and the skinning, which is the expensive
 * half.
 *
 * `spin` is remembered per car too: if that car's steering has moved meaningfully its pose
 * is redone regardless of the clock, so a fast correction is never smeared across the
 * interval.
 */
/* Target, not a guarantee — the ACHIEVED rate is quantised to the frame clock, because a
 * pose can only happen on a frame. The gate fires once the interval has elapsed, so the
 * real rate is frameRate / ceil(frameRate / target): at 360 Hz a target of 60 lands on
 * every sixth frame, exactly matching the smoke/air sim's own fixed 60 Hz step. At 60 Hz
 * the cap equals the frame rate and nothing is skipped, so a slow display never gets worse.
 *
 * SET TO 60 AS AN EXPERIMENT, not as a settled value. The stalls are 10-22 ms spent in
 * neither our JS (0.5-1.6 ms measured) nor the GPU (1.5-2.1 ms), which leaves collection as
 * the leading explanation — and this is the largest remaining allocator, so halving its
 * rate again is the cheapest test of whether allocation drives the stall at all. If the
 * spike rate moves, a fixed-rate simulation with interpolated rendering is worth building
 * properly. If it does not, allocation is not the cause and the architecture work would be
 * effort spent on the wrong thing. Was 144 (achieving 120); if this reads worse in the
 * hands, that is the number to go back to. */
let DRIVER_POSE_HZ = 60;
const _dpose = new Map();          // car key -> { t, spin }, one entry per car on track
/** forget one car's pose timing (called when a run leaves the comparison set) */
function driverPoseForget(key) { _dpose.delete(key); }
function driverSeatedSkin(spin, key) {
  const k = key === undefined ? 0 : key;
  const nowMs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  const p = _dpose.get(k);
  if (p && DRIVER_POSE_HZ > 0) {
    /* A 2% tolerance on the interval, and it is load-bearing rather than cosmetic.
     *
     * Frame times and the interval are both derived from the same rates, so at a target
     * equal to the refresh rate the comparison is float-against-identical-float and
     * rounding decides it. Measured: a 60 Hz cap on a 60 Hz display posed 40 times a second
     * instead of 60, dropping a third of them — which breaks the one property that made
     * this safe to ship, that a slow display is never made worse. The same rounding cost
     * 55 poses instead of 60 at 360 Hz.
     *
     * Firing 2% early can never overshoot the target meaningfully (it is 0.3 ms on a 60 Hz
     * interval) and removes the boundary entirely. */
    const due = nowMs - p.t >= (1000 / DRIVER_POSE_HZ) * 0.98;
    // 0.4 degrees of wheel movement — narrower than the hand's own grip on the rim, so a
    // skip can never hide a change in where the hands visibly are
    const moved = Math.abs(spin - p.spin) > 0.007;
    // a skipped car must still put ITS vertices back, since the GL buffer is shared; if it
    // has no cached skin yet (first frame this ghost appears) fall through to a full pose
    if (!due && !moved && driverSkinReupload(k)) return;
  }
  const world = driverSeatedPose(spin);
  if (world) driverSkinUpload(world, k);
  _dpose.set(k, { t: nowMs, spin });
}
/** forget every cached pose — call when the car model or the run set changes */
function driverPoseReset() { _dpose.clear(); }

if (typeof module !== "undefined") module.exports = { gripSat, armSolve, gripLockCalib, driverSeatedPose, snapToMesh, palmGrip,
  ksanimLocal, driverAnimWorlds, driverAnimInit, animT, steerOfFrame, steerRefCalib,
  // exported so the mark geometry can be measured on a real replay under node — the two are a
  // pair, since the mesh only exists where computeWheelSlip says the tyre was sliding
  buildTireMarkMesh, computeWheelSlip };
