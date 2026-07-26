/* followcam.js — the orbit camera, the follow/cockpit rig and the per-frame chase-cam solve.
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

/* camera: orbit */
const cam = { yaw: -0.7, pitch: 0.5, dist: 2500, target: [0, 0, 0] };
/* follow-cam: a cinematographer, not a rigid boom. It lives in the car's own
 * local frame (right / up = road-normal / back = −heading, all from the recorded
 * wheel attitude), so it stays locked through loops & spirals and never dips
 * through the road it's following. Speed opens it up on straights; curvature
 * tightens it and swings it into the corner. drag = orbit offset, wheel = zoom. */
let FOLLOW_SWING = 1;   // sign of the into-corner swing (flip if it swings out)
let FOLLOW_LOOKDOWN = 0.21;  // extra downward pitch (rad, ~12°) at full zoom — "look down with a neck"
const follow = {
  on: false, yawOff: 0, distMul: 1, saved: null, prevTs: 0,
  rig: { ready: false, dist: 160, height: 60, side: 0, la: 30, up: [0, 1, 0], eye: null, look: null },
};
// clamped smoothstep — eased 0..1, so a blend starts and ends without a visible kink
function smooth01(t) { const x = t < 0 ? 0 : t > 1 ? 1 : t; return x * x * (3 - 2 * x); }

/* Keep the close camera out of the driver, in CAR MODEL SPACE — which is the only place this is
 * simple, because the driver, the wheel and the cabin are all fixed there while the car flies
 * around the world. Two constraints, both cheap:
 *
 *   1. a CAPSULE from the head down to the wheel, radius DRIVER_CLEAR. That segment is the torso,
 *      shoulders and arms — everything the camera can bury itself in while orbiting the wheel. The
 *      eye gets pushed radially out to the capsule's surface, so the arms stay visible rather than
 *      being hidden, which is the whole point of the shot.
 *   2. a CEILING on how far it may sit from the wheel, so pushing out of the driver cannot shove
 *      the eye through the bodywork into open air.
 *
 * Returns the corrected model-space point. Nothing here needs the car's mesh: a helmet, a torso and
 * a cabin are well described by a capsule and a radius, and a mesh collider for a moving car is a
 * far bigger machine for the same result.
 */
function cockpitClear(p, wheelC, neckPivot, maxR) {
  /* The keep-out starts BELOW the head, not at it. Spanning the full head→wheel line blocked the
   * region the camera used to sit in and moved the shot; the head does not need protecting here
   * anyway, because it is hidden once the eye is inside HEAD_HIDE_DIST. What must stay clear is
   * the chest, shoulders and arms — the part you want to keep SEEING rather than fly through. */
  const B = wheelC;
  const A = [neckPivot[0] + (wheelC[0] - neckPivot[0]) * DRIVER_CLEAR_FROM,
             neckPivot[1] + (wheelC[1] - neckPivot[1]) * DRIVER_CLEAR_FROM,
             neckPivot[2] + (wheelC[2] - neckPivot[2]) * DRIVER_CLEAR_FROM];
  const abx = B[0] - A[0], aby = B[1] - A[1], abz = B[2] - A[2];
  const ab2 = abx * abx + aby * aby + abz * abz || 1;
  const out = [p[0], p[1], p[2]];
  const pushOut = () => {
    let t = ((out[0] - A[0]) * abx + (out[1] - A[1]) * aby + (out[2] - A[2]) * abz) / ab2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;                     // nearest point ON the segment
    const cx = A[0] + abx * t, cy = A[1] + aby * t, cz = A[2] + abz * t;
    let dx = out[0] - cx, dy = out[1] - cy, dz = out[2] - cz;
    let d = Math.hypot(dx, dy, dz);
    if (d >= DRIVER_CLEAR) return false;
    if (d < 1e-4) { dx = 0; dy = 1; dz = 0; d = 1; }   // dead centre: pop straight up rather than NaN
    const s = DRIVER_CLEAR / d;
    out[0] = cx + dx * s; out[1] = cy + dy * s; out[2] = cz + dz * s;
    return true;
  };
  const pullIn = () => {
    const wx = out[0] - wheelC[0], wy = out[1] - wheelC[1], wz = out[2] - wheelC[2];
    const wd = Math.hypot(wx, wy, wz);
    if (wd <= maxR || wd < 1e-4) return false;
    const s = maxR / wd;
    out[0] = wheelC[0] + wx * s; out[1] = wheelC[1] + wy * s; out[2] = wheelC[2] + wz * s;
    return true;
  };
  /* The two constraints genuinely conflict in some directions — behind the head there is NO point
   * that is both clear of the driver and inside the cabin radius, so one has to win. Relaxing a
   * couple of times settles the easy cases, and the keep-out is applied LAST so the unsatisfiable
   * ones end up slightly outside the cabin rather than inside the driver's shoulder. Sitting a few
   * centimetres proud of the bodywork is invisible; sitting inside an arm is not.
   * (Applying them in the other order silently re-buried the camera — the pull-in undid the push,
   * landing 0.165 m from the capsule against a 0.30 m limit.) */
  for (let i = 0; i < 3; i++) { pushOut(); if (!pullIn()) break; }
  pushOut();
  return out;
}
function followActive() { return follow.on && follow.rig.ready && !!follow.rig.eye; }
function camEye() {
  if (followActive()) return follow.rig.eye;
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  return [
    cam.target[0] + cam.dist * cp * Math.cos(cam.yaw),
    cam.target[1] + cam.dist * sp,
    cam.target[2] + cam.dist * cp * Math.sin(cam.yaw),
  ];
}
// frame-rate-independent exponential approach factor for a given stiffness.
// easeK → mathutil.js

// ---- world collider: a coarse XZ grid over ALL solid track geometry (road,
// terrain, walls, scenery) so the drone cam paths around anything that would
// come between it and the car, for unbroken flow with no clipping. Triangles
// whose XZ footprint spans too many cells (huge terrain quads) go into a small

function followUpdate(fp, dt) {
  const P = ex.pos, NM = ex.nrm, N = ex.N;
  const i0 = Math.max(0, Math.min(N - 1, Math.floor(fp)));
  if (ex.gap[i0]) return;                       // car absent this frame — hold
  const i1 = Math.min(N - 1, i0 + 1);
  const f = ex.gap[i1] ? 0 : Math.max(0, Math.min(1, fp - i0));
  const lp = (A, o) => A[i0 * 3 + o] + (A[i1 * 3 + o] - A[i0 * 3 + o]) * f;
  const px = lp(P, 0), py = lp(P, 1), pz = lp(P, 2);
  // up = road-surface normal
  let ux = lp(NM, 0), uy = lp(NM, 1), uz = lp(NM, 2);
  const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
  // the wheel-plane normal can flip sign past ~90° of bank (loops / corkscrews),
  // which would snap the camera to the far side of the track and read as the car
  // swapping over. Keep it on the SAME side as last frame — a genuine inversion
  // rotates gradually (small per-frame steps, dot stays positive), so only a true
  // sign-flip gets corrected. This makes Bf<0 hold, which keeps the aim forward.
  { const pv = follow.rig.up; if (pv && follow.rig.ready && (ux * pv[0] + uy * pv[1] + uz * pv[2]) < 0) { ux = -ux; uy = -uy; uz = -uz; } }
  // chase heading = DIRECTION OF TRAVEL (velocity), NOT the body heading. The
  // body crabs during slip (the T-180's whole character) and would whip the
  // camera 180° when slip passes 90°. Velocity is smooth and always points
  // down-road, so the car stays facing correctly away from the lens.
  const wf = Math.max(4, Math.round(0.12 / ex.dt));
  // GAP-FREE velocity window: online replays (AC_*_O_*) teleport the car between
  // frames; a window spanning the jump made the heading point along the teleport
  // and whipped the camera ~90°. Never let the window cross a gap.
  let a = i0, b = i0;
  while (a > 0 && i0 - a < wf && !ex.gap[a - 1]) a--;
  while (b < N - 1 && b - i0 < wf && !ex.gap[b + 1]) b++;
  let hx = P[b * 3] - P[a * 3], hy = P[b * 3 + 1] - P[a * 3 + 1], hz = P[b * 3 + 2] - P[a * 3 + 2];
  let hd = hx * ux + hy * uy + hz * uz; hx -= ux * hd; hy -= uy * hd; hz -= uz * hd; // ⟂ up
  let hl = Math.hypot(hx, hy, hz);
  const rig = follow.rig;
  // hold the heading when the car is actually stopped (gate on real speed, not
  // window length — a teleport makes the window huge, not tiny) or the window
  // collapsed against a gap. This freezes orientation instead of spinning it.
  const moving = (ex.speed[i0] || 0) > 3 && b > a && hl > 1e-3;
  if (!moving) {
    if (rig.fwd) { hx = rig.fwd[0]; hy = rig.fwd[1]; hz = rig.fwd[2]; } else { hx = 1; hy = 0; hz = 0; }
  } else { hx /= hl; hy /= hl; hz /= hl; }
  if (!rig.fwd) rig.fwd = [hx, hy, hz];          // light smoothing kills residual jitter
  const kFwd = easeK(9.0, dt);
  rig.fwd[0] += (hx - rig.fwd[0]) * kFwd; rig.fwd[1] += (hy - rig.fwd[1]) * kFwd; rig.fwd[2] += (hz - rig.fwd[2]) * kFwd;
  const fl = Math.hypot(rig.fwd[0], rig.fwd[1], rig.fwd[2]) || 1;
  hx = rig.fwd[0] / fl; hy = rig.fwd[1] / fl; hz = rig.fwd[2] / fl;
  // right = up × heading
  const rx = uy * hz - uz * hy, ry = uz * hx - ux * hz, rz = ux * hy - uy * hx;
  // signed curvature: turn between the segment before and after the car, on the road plane
  const proj = (vx, vy, vz) => {
    const dd = vx * ux + vy * uy + vz * uz;
    let ox = vx - ux * dd, oy = vy - uy * dd, oz = vz - uz * dd;
    const l = Math.hypot(ox, oy, oz) || 1; return [ox / l, oy / l, oz / l];
  };
  const c = Math.min(N - 1, i0 + 2 * wf);
  const D1 = proj(P[i0 * 3] - P[a * 3], P[i0 * 3 + 1] - P[a * 3 + 1], P[i0 * 3 + 2] - P[a * 3 + 2]);
  const D2 = proj(P[c * 3] - P[i0 * 3], P[c * 3 + 1] - P[i0 * 3 + 1], P[c * 3 + 2] - P[i0 * 3 + 2]);
  const dot = Math.max(-1, Math.min(1, D1[0] * D2[0] + D1[1] * D2[1] + D1[2] * D2[2]));
  const ang = Math.acos(dot);
  const crossU = (D1[1] * D2[2] - D1[2] * D2[1]) * ux + (D1[2] * D2[0] - D1[0] * D2[2]) * uy + (D1[0] * D2[1] - D1[1] * D2[0]) * uz;
  const turnSign = crossU >= 0 ? 1 : -1;
  const curveN = Math.min(1, ang / 0.6);
  // speed
  let s = ex.speed[i0]; if (!isFinite(s)) s = 0;
  const speedN = Math.min(1, s / 300);
  // shape targets: right on the car's tail, low, opening out on straights. Much
  // closer than before — the framing pass below guarantees the car stays in shot.
  const DMIN = 4, DMAX = 18, HMIN = 2, HMAX = 6.5;
  // zoomN: 0 at the default distance, 1 fully zoomed in (wheel min). As it zooms in
  // the eye must also DROP to the car's level, or it ends up above the car looking
  // down at the ground; low + behind lets the framing tilt up the road instead.
  const zoomN = Math.max(0, Math.min(1, (1 - (follow.distMul || 1)) / 0.88));
  /* The chase eye stops at the bodywork. The zoom range now runs below 0.12 so the last stretch
   * can carry the camera into the cockpit, but the CHASE pose must not follow it in — unfloored it
   * ends up centimetres behind the car's origin, buried inside the panels. Going further in is the
   * cockpit blend's job, below. */
  const distT = Math.max(1.5, (DMIN + (DMAX - DMIN) * speedN * (1 - 0.55 * curveN)) * (follow.distMul || 1));
  const heightT = (HMIN + (HMAX - HMIN) * speedN * (1 - 0.5 * curveN)) * (1 - 0.8 * zoomN);
  const sideT = distT * 0.34 * curveN * turnSign * FOLLOW_SWING;   // swing into the corner
  const bankT = 0.16 * curveN * speedN * turnSign * FOLLOW_SWING;  // drone roll into the turn
  const R = rig;
  if (!R.ready) { R.dist = distT; R.height = heightT; R.side = sideT; R.bank = bankT; R.up = [ux, uy, uz]; R.ready = true; }
  // kUp fast enough to track a corkscrew's spinning road-normal; kSlow eases FOV/framing
  const kMed = easeK(5.0, dt), kUp = easeK(5.5, dt), kBank = easeK(3.0, dt), kSlow = easeK(2.0, dt);
  // back up fast, pull in SLOW — so a violent slowdown (distT drops with speed) doesn't rush the eye
  // in and crowd the car; it stays backed off, keeping room, especially when zoomed all the way in.
  R.dist += (distT - R.dist) * (distT < R.dist ? easeK(1.6, dt) : easeK(6.0, dt));
  R.height += (heightT - R.height) * kMed;
  R.side += (sideT - R.side) * kMed;
  R.bank = (R.bank || 0) + (bankT - (R.bank || 0)) * kBank;
  R.up[0] += (ux - R.up[0]) * kUp; R.up[1] += (uy - R.up[1]) * kUp; R.up[2] += (uz - R.up[2]) * kUp;
  const sul = Math.hypot(R.up[0], R.up[1], R.up[2]) || 1; R.up[0] /= sul; R.up[1] /= sul; R.up[2] /= sul;
  // chase direction = −heading rotated by the user's drag offset about up (Rodrigues)
  const yaw = follow.yawOff || 0, cy = Math.cos(yaw), sy = Math.sin(yaw);
  const kd = ux * hx + uy * hy + uz * hz;   // heading is ⟂ up so ~0, kept for generality
  const Hx = hx * cy + (uy * hz - uz * hy) * sy + ux * kd * (1 - cy);
  const Hy = hy * cy + (uz * hx - ux * hz) * sy + uy * kd * (1 - cy);
  const Hz = hz * cy + (ux * hy - uy * hx) * sy + uz * kd * (1 - cy);
  // rigid desired eye — tracks the car every frame with only the SHAPE smoothed,
  // so there is NO positional lag (the old eye-smoothing trailed ~15 m at 300 km/h
  // and couldn't hold a corkscrew). Collision & framing ride on top.
  // RIGIDLY attached to the car — inherits its whole motion, so it rides seamlessly through any loop /
  // spiral / bank. (Softening the vertical DETACHED the eye from the car and broke that seamless follow;
  // the bumps worth killing are the object-collision folds, handled below — not the car's own motion.)
  const desx = px - Hx * R.dist + R.up[0] * R.height + rx * R.side;
  const desy = py - Hy * R.dist + R.up[1] * R.height + ry * R.side;
  const desz = pz - Hz * R.dist + R.up[2] * R.height + rz * R.side;
  // --- drone collision: fold the boom in fluidly if the world would occlude the car.
  // Only the fraction is smoothed (spring feel) — the base still tracks rigidly. ---
  const pivot = [px - Hx * 2 + R.up[0] * 2, py - Hy * 2 + R.up[1] * 2, pz - Hz * 2 + R.up[2] * 2];
  const hit = collideSegment(worldColl, pivot, [desx, desy, desz]);
  // Ignore 1-frame flickers — a thin trackside object flashing through the boom shouldn't jolt the
  // cam; only a collision that PERSISTS folds it. Then smooth ASYMMETRICALLY: fold in quick enough to
  // avoid clipping, but ease back out slowly so clearing an object doesn't snap the framing. Keeps the
  // genuine sustained collisions (the immersive track rebound) while killing the object-bump jitter.
  /* The flicker filter is a DURATION, not a frame count, and that distinction is the
   * difference between this working and this being a stutter generator.
   *
   * It was `hitFrames >= 2`, which means 33 ms at 60 Hz and 5.6 ms at 360 Hz — so on a fast
   * panel the filter it describes is six times weaker than the one that was tuned, and a
   * thin object flashing past the boom for a few milliseconds clears it. What follows is a
   * fold-in at rate 7.0 and a recovery at 1.6: a visible camera lurch, on a frame that met
   * its budget comfortably. It never appears in a frame-time graph because the frame was
   * fine; the camera was somewhere else.
   *
   * 33 ms preserves the original intent exactly — two frames at 60 Hz — and now means the
   * same length of time on every display. The rest of this rig was already dt-correct
   * (easeK is 1 - exp(-rate*dt)); this was the one constant counted in frames. */
  const rawHit = hit > 0 && hit < 1;
  const HIT_HOLD_S = 0.033;
  R.hitTime = rawHit ? (R.hitTime || 0) + dt : 0;
  const fracT = R.hitTime >= HIT_HOLD_S ? Math.max(0.12, hit * 0.9) : 1;
  const prevFrac = (R.collFrac == null) ? 1 : R.collFrac;
  const kColl = fracT < prevFrac ? easeK(7.0, dt) : easeK(1.6, dt);   // fold in fast, recover slow
  R.collFrac = (R.collFrac == null) ? fracT : R.collFrac + (fracT - R.collFrac) * kColl;
  const fr = Math.min(1, R.collFrac);
  let exW = pivot[0] + (desx - pivot[0]) * fr;
  let eyW = pivot[1] + (desy - pivot[1]) * fr;
  let ezW = pivot[2] + (desz - pivot[2]) * fr;
  // never ram the car: keep the eye outside the car BODY, not just its centre. The
  // T-180's tail reaches ~2.7 m behind its origin, so a smaller radius put the low
  // zoomed eye inside the model (backfaces + near-clip glitch). Sit just behind it.
  const MINCAR = 3.6 * (1 - 0.78 * zoomN);   // shrink the keep-out radius hard as it zooms → right into the cockpit
  const cvx = exW - px, cvy = eyW - py, cvz = ezW - pz, cvl = Math.hypot(cvx, cvy, cvz);
  if (cvl > 1e-4 && cvl < MINCAR) { const g = MINCAR / cvl; exW = px + cvx * g; eyW = py + cvy * g; ezW = pz + cvz * g; }
  // anti-clip floor: keep the eye a minimum clearance on the +up side of the road
  const upDot = (exW - px) * R.up[0] + (eyW - py) * R.up[1] + (ezW - pz) * R.up[2];
  const MINH = 1.6 * (1 - 0.8 * zoomN);   // let the eye ride low when fully zoomed in
  if (upDot < MINH) { const add = MINH - upDot; exW += R.up[0] * add; eyW += R.up[1] * add; ezW += R.up[2] * add; }
  // (no ground clamp — it broke spirals/loops and shuffled on stacked track; the original anti-clip
  // floor above is enough. The car being centred is by AIMING, not by burying the eye.)
  R.eye = R.eye || [0, 0, 0];
  R.eye[0] = exW; R.eye[1] = eyW; R.eye[2] = ezW;   // rigid, no lag
  // FOV + framing height ease SLOWLY toward their close/far targets: as it closes in
  // the FOV widens and the car sinks lower, angling the lens up the road ahead.
  const closeN = Math.max(0, Math.min(1, (22 - R.dist) / (22 - 4)));
  const fovT = Math.min(1.55, 0.85 + 0.40 * closeN + 0.28 * zoomN);  // wide-angle when zoomed in (~88°)
  const frameYT = -0.28 - 0.50 * closeN - 0.10 * zoomN;              // fully zoomed → car sits low, lens tilts up the road
  R.fov = (R.fov == null) ? fovT : R.fov + (fovT - R.fov) * kSlow;
  R.frameY = (R.frameY == null) ? frameYT : R.frameY + (frameYT - R.frameY) * kSlow;
  // --- framing guarantee (robust): place the car at R.frameY using the STABLE
  // heading/up basis — never the eye→car direction, which degenerates (and used to
  // flip 180°) when the camera rides near overhead. Solve the aim pitch β in the
  // heading–up plane that lands the car's vertical screen position exactly at frameY. ---
  // as it zooms in, drift the framing focus from the car centre UP onto the driver's head (cockpit feel)
  const nk = (carDriver && carDriver.neckPivot) ? carDriver.neckPivot : [0, 1.08, 0.09];
  const df = zoomN * 0.85, dh = nk[1] * df;
  const dEx = (px + R.up[0] * dh) - R.eye[0], dEy = (py + R.up[1] * dh) - R.eye[1], dEz = (pz + R.up[2] * dh) - R.eye[2];
  const Af = dEx * Hx + dEy * Hy + dEz * Hz;                // car-ahead component (along heading)
  const Bf = dEx * R.up[0] + dEy * R.up[1] + dEz * R.up[2]; // car-vertical component (along up)
  const kf = R.frameY * Math.tan(R.fov * 0.5);
  let beta = Math.atan2(Bf - kf * Af, Af + kf * Bf);        // pitch that puts the car at frameY
  const BMAX = 1.45; if (beta > BMAX) beta = BMAX; else if (beta < -BMAX) beta = -BMAX; // never aim backward
  beta -= (FOLLOW_LOOKDOWN + 0.44) * zoomN;   // tilt the view down like a neck as it zooms in — +~25° at full zoom for the low cockpit look
  const cbe = Math.cos(beta), sbe = Math.sin(beta);
  const fX = Hx * cbe + R.up[0] * sbe, fY = Hy * cbe + R.up[1] * sbe, fZ = Hz * cbe + R.up[2] * sbe;
  R.look = [R.eye[0] + fX * 60, R.eye[1] + fY * 60, R.eye[2] + fZ * 60];
  // drone bank: roll the VIEW up around the heading (view only — doesn't move eye)
  const bc = Math.cos(R.bank || 0), bs = Math.sin(R.bank || 0);
  R.viewUp = [R.up[0] * bc - rx * bs, R.up[1] * bc - ry * bs, R.up[2] * bc - rz * bs];  // up' = up·cos + (H×up)·sin
  /* THE COCKPIT SHOT — where the zoom keeps going after the chase cam has run out of room.
   *
   * `enter` carries the eye from the chase pose to a point just ahead of the steering wheel, aimed
   * back at it, so you end up looking at the rim, the driver's hands and the arms behind them.
   * `deep` is the last squeeze: keep scrolling and it pushes closer and narrows the lens onto the
   * hands themselves. Both are anchored on `carDriver.wheelC` — the wheel's own pivot from the car
   * model — so it lands correctly on any car instead of on numbers tuned for this one.
   *
   * The pose is LOCKED to the car: fixed eye, fixed aim, no drone bank. Everything that makes the
   * chase cam feel alive — the swing into corners, the framing solve, the roll — is exactly what
   * ruins a close shot, because at half a metre those corrections read as camera shake. Rigid to
   * the car means the cockpit sits still while the world tears past, which is the shot worth having.
   */
  const enter = smooth01((0.26 - (follow.distMul || 1)) / (0.26 - 0.07));
  follow.enter = enter;
  if (enter > 0.001 && ex) {
    const wc = (carDriver && carDriver.wheelC) ? carDriver.wheelC
             : (carDriver && carDriver.neckPivot) ? [carDriver.neckPivot[0], carDriver.neckPivot[1] - 0.16, carDriver.neckPivot[2] + 0.40]
             : [0, 0.92, 0.55];
    const deep = smooth01((0.07 - (follow.distMul || 1)) / (0.07 - 0.03));
    const fwdOff = COCKPIT_FWD - (COCKPIT_FWD - COCKPIT_FWD_DEEP) * deep;   // final squeeze onto the hands
    const up = COCKPIT_UP - (COCKPIT_UP - COCKPIT_UP_DEEP) * deep;
    /* Which side to shoot from: whichever side the user has orbited to. `yawOff` is their own drag
     * around the car, so its sine gives both the side and how committed they are — tanh saturates
     * it quickly, so a small nudge off dead-astern already picks a side and holds it rather than
     * creeping. Orbit through the back and the shot crosses over to the other shoulder. */
    const sideAmt = Math.tanh(Math.sin(follow.yawOff || 0) * 3);
    const sideOff = (COCKPIT_SIDE - (COCKPIT_SIDE - COCKPIT_SIDE_DEEP) * deep) * sideAmt;
    /* Use the CAR'S OWN MODEL MATRIX, not a basis rebuilt here. `wheelC` is in the car model's
     * space, and the rig's H is the CHASE direction — it points from the car back toward the
     * camera, not forward — so mapping model coordinates through it put the eye behind the car
     * looking out the back. carModelMatrix is the same transform the wheel, the driver and the
     * hands are drawn with, so anchoring to it is correct by construction on any car. */
    const cmr = carModelMatrix(fp);
    const M = cmr && cmr.mat;
    const xf = (a, b, c) => M
      ? [M[0] * a + M[4] * b + M[8] * c + M[12],
         M[1] * a + M[5] * b + M[9] * c + M[13],
         M[2] * a + M[6] * b + M[10] * c + M[14]]
      : [px + rx * a + R.up[0] * b + Hx * c, py + ry * a + R.up[1] * b + Hy * c, pz + rz * a + R.up[2] * b + Hz * c];
    /* Which way is "ahead of the wheel" in this model's space? Don't assume ±Z — measure it. The
     * driver's neck sits BEHIND the wheel, so wheel-minus-neck points toward the nose. Self-
     * calibrating, so a car authored along the other axis still gets the camera on the right side
     * of the wheel instead of buried in the driver's chest. */
    const nkp = carDriver && carDriver.neckPivot;
    const dz = nkp ? wc[2] - nkp[2] : 1;
    const fs = Math.abs(dz) > 0.02 ? Math.sign(dz) : 1;
    // eye off to the chosen side and slightly ahead, aimed at the wheel: a diagonal look INTO the
    // cockpit at the hands working the rim. Diagonal rather than straight-on is the difference
    // between an action shot and a rear-facing view.
    // build the eye in MODEL space first, so the keep-out volumes below are simple fixed shapes
    let eM = [wc[0] + sideOff, wc[1] + up, wc[2] + fwdOff * fs];
    // aim lifts as the zoom deepens: pointing dead at the rim buries the frame in dashboard, and a
    // few degrees up puts the hands low in shot with the road beyond them
    const aimUp = 0.02 + COCKPIT_ORBIT_R * Math.tan(COCKPIT_AIM_UP) * deep;
    const tW = xf(wc[0] + sideOff * 0.15, wc[1] + aimUp, wc[2]);
    /* At MAX zoom the shot becomes a full orbit of the wheel — drag all the way round it, over the
     * top, under it, from the driver's side or the far side. The side-offset framing above
     * saturates on purpose (it commits to a shoulder rather than creeping), which is right for the
     * approach but would cap you at ±60 cm here. So the last of the zoom blends that into a true
     * sphere around the wheel, driven by the same drag: yaw goes all the way round, pitch lifts and
     * drops the eye. Aim stays pinned to the rim, so the hands hold the frame from every angle. */
    if (deep > 0.001) {
      const yaw = follow.yawOff || 0;
      const pit = Math.max(-1.15, Math.min(1.15, cam.pitch || 0));
      const hr = COCKPIT_ORBIT_R * Math.cos(pit);
      // the sphere is centred on the WHEEL (plus a token lift toward the hands), not on the eye
      // height — centring it higher makes the radius shrink as you pitch down, which walks the
      // camera into the rim at the bottom of the arc
      const om = [wc[0] + Math.sin(yaw) * hr,
                  wc[1] + COCKPIT_ORBIT_UP + COCKPIT_ORBIT_R * Math.sin(pit),
                  wc[2] + Math.cos(yaw) * hr * fs];
      eM = [eM[0] + (om[0] - eM[0]) * deep, eM[1] + (om[1] - eM[1]) * deep, eM[2] + (om[2] - eM[2]) * deep];
    }
    // push the eye out of the driver (head, torso, arms) and keep it inside the cabin
    const nkC = (carDriver && carDriver.neckPivot) ? carDriver.neckPivot : [wc[0], wc[1] + 0.16, wc[2] - 0.46 * fs];
    eM = cockpitClear(eM, wc, nkC, COCKPIT_ORBIT_R + 0.10);
    const eW = xf(eM[0], eM[1], eM[2]);
    const exW2 = eW[0], eyW2 = eW[1], ezW2 = eW[2];
    const txW = tW[0], tyW = tW[1], tzW = tW[2];
    /* NO world-space smoothing here, deliberately. Filtering the world position of a camera that is
     * rigidly bolted to a moving car makes the pose TRAIL the car while it drives — and the instant
     * you pause, the filter catches up and the camera glides forward into the cockpit. That is the
     * "momentum lag" artifact. The pose is exact each frame; it is steady because it is expressed in
     * the car's own frame, and any residual jitter belongs to the car matrix, where it should be
     * fixed rather than papered over here. */
    R.shotEye = [exW2, eyW2, ezW2]; R.shotAt = [txW, tyW, tzW];
    for (let k = 0; k < 3; k++) {
      R.eye[k] += (R.shotEye[k] - R.eye[k]) * enter;
      R.look[k] += (R.shotAt[k] - R.look[k]) * enter;
    }
    R.fov += ((COCKPIT_FOV - (COCKPIT_FOV - COCKPIT_FOV_DEEP) * deep) - R.fov) * enter;
    R.bank = (R.bank || 0) * (1 - enter);   // locked orientation: the shot does not roll into corners
  } else {
    R.shotEye = null; R.shotAt = null;      // re-seed the filter next time instead of easing in from a stale pose
  }
  cam.dist = R.dist;   // fog scales with chase distance
  cam.target[0] = R.look[0]; cam.target[1] = R.look[1]; cam.target[2] = R.look[2];
}
