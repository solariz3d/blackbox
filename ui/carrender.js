/* carrender.js — car body + wheels + driver rendering and posing.
 * Pure render/pose functions, loaded before the main script (shared global scope).
 * They read/write app state declared in index.html (ex, carSteerAngle, carWheels,
 * carDriver, carSteerWheel, driverRig, the STEER_WHEEL_/WHEEL_ROLL/SUSP_/DRIVER_
 * tunables) and use gl/tLoc from glcore.js and the helpers in mathutil.js — all at
 * call time (runtime), so load order is fine. carModelMatrix SETS carSteerAngle.
 */
// build the car's world matrix at a FRACTIONAL frame position. Orientation is
// the REAL recorded body attitude: up = road surface normal, heading = the
// front-axle→rear-axle vector from the wheels (carries the true slip angle the
// car actually had). Everything interpolated so it's smooth at any refresh.
function carModelMatrix(fpos) {
  const P = ex.pos, NM = ex.nrm, FW = ex.fwd, N = ex.N;
  const i0 = Math.max(0, Math.min(N - 1, Math.floor(fpos)));
  const i1 = Math.min(N - 1, i0 + 1);
  const f = ex.gap[i1] ? 0 : Math.max(0, Math.min(1, fpos - i0));
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
      carSteerAngle = Math.atan2(vR, vH);
    }
  }
  // local axes → world: X→right, Y→up, Z(nose)→heading
  return new Float32Array([
    rx, ry, rz, 0,
    ux, uy, uz, 0,
    hx, hy, hz, 0,
    px0 + ux * carLift, py0 + uy * carLift, pz0 + uz * carLift, 1,
  ]);
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
function wheelSteerModel(carMat, pivot, steer, roll, lift) {
  const cy = Math.cos(steer), sy = Math.sin(steer);
  const cx = Math.cos(roll || 0), sx = Math.sin(roll || 0);
  const Ry = [cy, 0, -sy, 0,  0, 1, 0, 0,  sy, 0, cy, 0,  0, 0, 0, 1];   // steer about up (model Y)
  const Rx = [1, 0, 0, 0,  0, cx, sx, 0,  0, -sx, cx, 0,  0, 0, 0, 1];   // roll about the axle (model X)
  const R = mMul(Ry, Rx);   // roll in the wheel's own frame, then steer that frame
  const px = pivot[0], py = pivot[1], pz = pivot[2];   // rotate about the wheel-centre pivot
  R[12] = px - (R[0]*px + R[4]*py + R[8]*pz);
  R[13] = py - (R[1]*px + R[5]*py + R[9]*pz) + (lift || 0);   // suspension travel along body up (model Y)
  R[14] = pz - (R[2]*px + R[6]*py + R[10]*pz);
  return new Float32Array(mMul(carMat, R));
}
// lateral / longitudinal / vertical g at fractional frame `fp`, from the path's local
// acceleration — deterministic (scrub-safe) and windowed so it's smooth. Feeds the
// procedural suspension (dive/squat, roll, bumps). Same math the driver lean reads.
function carGForces(fp) {
  const P = ex.pos, N = ex.N, dt = ex.dt;
  const i = Math.max(1, Math.min(N - 2, Math.round(fp)));
  const w = Math.max(3, Math.round(0.1 / dt));
  const a = Math.max(0, i - w), b = Math.min(N - 1, i + w);
  let ux = ex.nrm[i*3], uy = ex.nrm[i*3+1], uz = ex.nrm[i*3+2]; const ul = Math.hypot(ux,uy,uz)||1; ux/=ul;uy/=ul;uz/=ul;
  let hx = P[b*3]-P[a*3], hy = P[b*3+1]-P[a*3+1], hz = P[b*3+2]-P[a*3+2];
  const hd = hx*ux+hy*uy+hz*uz; hx-=ux*hd; hy-=uy*hd; hz-=uz*hd; const hl = Math.hypot(hx,hy,hz)||1; hx/=hl;hy/=hl;hz/=hl;
  const rx = uy*hz-uz*hy, ry = uz*hx-ux*hz, rz = ux*hy-uy*hx;   // right = up×heading
  const iv = 1 / (w * dt);
  const dvx = ((P[b*3]-P[i*3]) - (P[i*3]-P[a*3])) * iv * iv;
  const dvy = ((P[b*3+1]-P[i*3+1]) - (P[i*3+1]-P[a*3+1])) * iv * iv;
  const dvz = ((P[b*3+2]-P[i*3+2]) - (P[i*3+2]-P[a*3+2])) * iv * iv;
  const longG = (dvx*hx + dvy*hy + dvz*hz) / 9.81;
  return {
    latG: (dvx*rx + dvy*ry + dvz*rz) / 9.81,     // + = pushed toward +right
    longG,                                        // + = accelerating, − = braking (raw)
    vertA: (dvx*ux + dvy*uy + dvz*uz) / 9.81,     // + = pushed up (bump), − = crest
    // gravity-corrected braking: heading is flattened to the road plane, so gravity's
    // along-track pull is just its vertical component (hy). Subtracting it means climbing
    // a loop/banking no longer reads as braking. + = real braking-direction contact force.
    brakeG: -longG - hy,
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
function wheelRollDistance(fp) {
  const cd = ex && ex.cumDist; if (!cd) return 0;
  const i = Math.max(0, Math.min(ex.N - 1, Math.floor(fp)));
  const j = Math.min(ex.N - 1, i + 1);
  return cd[i] + (cd[j] - cd[i]) * (fp - i);
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
function driverPose(fp, carMat) {
  const P = ex.pos, N = ex.N, dt = ex.dt;
  const i = Math.max(1, Math.min(N - 2, Math.round(fp)));
  const w = Math.max(3, Math.round(0.1 / dt));
  const a = Math.max(0, i - w), b = Math.min(N - 1, i + w);
  let ux = ex.nrm[i*3], uy = ex.nrm[i*3+1], uz = ex.nrm[i*3+2]; const ul = Math.hypot(ux,uy,uz)||1; ux/=ul;uy/=ul;uz/=ul;
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
  const yawT = clamp(carSteerAngle * DRIVER_HEAD_SIGN, DRIVER_HEAD_YAW_MAX);
  const hrollT = clamp(-latG * 0.05, 0.10);          // a little head tilt with the G
  const k = 1 - Math.exp(-3.0 / 60);                 // slow settle (~3/s)
  driverRig.headYaw += (yawT - driverRig.headYaw) * k;
  driverRig.headRoll += (hrollT - driverRig.headRoll) * k;
  // The body is a RIGID seated pose (the car's own driver_base_pos.knh, in car
  // space) — hands already on the wheel. Only the head moves, pivoting about the
  // real neck joint (also in car space), then everything rides carMat to world.
  const pv = (carDriver && carDriver.neckPivot) || [0, 1.08, 0.09];
  const headExtra = mMul(rotP(1, driverRig.headYaw, pv[0], pv[1], pv[2]), rotP(2, driverRig.headRoll, pv[0], pv[1], pv[2]));
  return {
    body: new Float32Array(carMat),
    head: new Float32Array(mMul(carMat, headExtra)),
  };
}

// upload the driver's skinned meshes for a given posed skeleton `world` (array of mat4)
function driverSkinUpload(world) {
  for (const sm of carDriver.skinned) {
    const bm = sm.boneNodeIdx.map((ni, b) => ni < 0 ? null : rvMul(sm.invBind[b], world[ni]));
    const bp = sm.bindPos, bn = sm.bindNrm, bw = sm.bw, bi = sm.bi, op = sm.skinPos, on = sm.skinNrm, nv = bp.length / 3;
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

// Skin the driver's body into this car's authored seated pose (driver_base_pos.knh),
// which places the skeleton — and therefore the hands — onto THIS car's wheel. Each
// bone's world matrix comes straight from the knh (car space); bones absent from it
// fall back to the model's bind pose. `spin` (rad) orbits both hands with the wheel:
// per arm the grip point rotates about the wheel axis and the elbow re-solves (2-bone
// IK), then the whole arm→hand→finger subtree rotates so nothing tears. spin=0
// reproduces the seated pose exactly. Rigid body otherwise, so only the arms move.
function driverSeatedSkin(spin) {
  const D = carDriver;
  if (!D || !D.poseWorld) return;
  const skel = D.skel, N = skel.count;
  const world = new Array(N);
  for (let i = 0; i < N; i++) world[i] = D.poseWorld[skel.name[i]] || skel.bindWorld[i];
  if (spin && D.arms && D.wheelAxis) {
    const C = D.wheelC, ax = D.wheelAxis;
    const cs = Math.cos(spin), sn = Math.sin(spin), one = 1 - cs;
    const orbit = p => {   // Rodrigues: rotate point p about axis `ax` through C by spin
      const v = v3sub(p, C), d = v3dot(ax, v), cx = v3cross(ax, v);
      return [C[0] + v[0]*cs + cx[0]*sn + ax[0]*d*one,
              C[1] + v[1]*cs + cx[1]*sn + ax[1]*d*one,
              C[2] + v[2]*cs + cx[2]*sn + ax[2]*d*one];
    };
    for (const arm of D.arms) {
      const S = arm.S0, W = orbit(arm.W0);
      const { E } = ik2bone(S, W, arm.L1, arm.L2, arm.pole);      // elbow for the orbited grip
      const Rup = rvFromTo(v3sub(arm.E0, S), v3sub(E, S));        // upper arm swings about S
      const W1 = v3add(S, mRot(v3sub(arm.W0, S), Rup));          // wrist after only Rup
      const Rfore = rvFromTo(v3sub(W1, E), v3sub(W, E));          // forearm swings about E
      for (const b of arm.armSub)  world[b] = rvRotAbout(world[b], Rup, S);
      for (const b of arm.foreSub) world[b] = rvRotAbout(world[b], Rfore, E);
    }
  }
  driverSkinUpload(world);
}
