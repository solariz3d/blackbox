/* lightfx.js — everything that emits or receives light: thruster, backfires, car lamp glow, track-lamp glare, lens flare, contact shadow, texture upload helpers, the track-light budget and the time-of-day key light.
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

// thruster flame — round additive blue point-sprites, perspective-sized
const progThr = gl.createProgram();
gl.attachShader(progThr, shader(gl.VERTEX_SHADER,
  "attribute vec3 aPos; attribute float aSize; attribute float aBright;" +
  "uniform mat4 uMVP; varying float vB;" +
  "void main(){ gl_Position = uMVP*vec4(aPos,1.0); gl_PointSize = aSize; vB = aBright; }"));
gl.attachShader(progThr, shader(gl.FRAGMENT_SHADER,
  "precision mediump float; varying float vB;" +
  "void main(){ float r = length(gl_PointCoord-0.5)*2.0; float a = pow(smoothstep(1.0,0.0,r),1.8)*vB;" +
  " vec3 col = mix(vec3(0.14,0.46,1.0), vec3(0.92,0.97,1.0), min(a,1.0));" +   // deep blue edge → white-hot core
  " gl_FragColor = vec4(col*a, a); }"));
gl.linkProgram(progThr);
const thrLoc = {
  pos: gl.getAttribLocation(progThr, "aPos"),
  size: gl.getAttribLocation(progThr, "aSize"),
  bright: gl.getAttribLocation(progThr, "aBright"),
  mvp: gl.getUniformLocation(progThr, "uMVP"),
};
const thrBuf = gl.createBuffer();

// turbine activity inferred from the driving state (the mod fires it under high
// slip during hard cornering, per its design + our research). 0..1.
/* How much of the turbine you actually see, as a function of what the car is doing.
 *
 * A jet on a car is used in two places: down a STRAIGHT, where thrust is free speed, and
 * mid-SLIDE, where it rotates the car. Through an ordinary corner it is a liability, and a
 * plume burning flat-out the whole lap stops meaning anything — it becomes wallpaper, and
 * the moments that should read as dramatic read as normal.
 *
 * So the plume is gated: full on a straight or in a big slide, TURBINE_IDLE in between.
 * Note it gates the DISPLAY, not the data — when a replay carries the real afterburner
 * button (schema 6) that channel still decides when the flame fires; this only decides how
 * much of it is shown. It never invents a plume the driver did not ask for.
 */
let TURBINE_IDLE = 0.18;        // floor through normal cornering (0 = plume off entirely)
const TURBINE_SLIP_ON = 12;     // degrees of slip where "a slide" starts counting
const TURBINE_SLIP_FULL = 34;   // ...and where it is fully open
const TURBINE_STRAIGHT_R = 260; // path radius (m) above which the car counts as straight
const TURBINE_CORNER_R = 90;    // ...and below which it is definitely cornering

/** signed path curvature radius at frame i, in metres; Infinity on a straight */
function pathRadius(E, i) {
  const P = E.pos, N = E.N;
  const w = Math.max(2, Math.round(0.25 / E.dt));            // ~quarter second each side
  const a = Math.max(0, i - w), b = Math.min(N - 1, i + w);
  if (b - a < 2) return Infinity;
  const v1 = [P[i*3] - P[a*3], P[i*3+1] - P[a*3+1], P[i*3+2] - P[a*3+2]];
  const v2 = [P[b*3] - P[i*3], P[b*3+1] - P[i*3+1], P[b*3+2] - P[i*3+2]];
  const l1 = Math.hypot(v1[0], v1[1], v1[2]), l2 = Math.hypot(v2[0], v2[1], v2[2]);
  if (l1 < 1e-3 || l2 < 1e-3) return Infinity;
  const dot = Math.max(-1, Math.min(1, (v1[0]*v2[0] + v1[1]*v2[1] + v1[2]*v2[2]) / (l1 * l2)));
  const turn = Math.acos(dot);
  if (turn < 1e-4) return Infinity;
  // A chord's direction is the tangent at the MIDPOINT of its segment, so the angle
  // between the two chords is the tangent's rotation across ONE segment, not two —
  // the arc length that corresponds to it is the average of the chords, not their sum.
  // Using the sum reported every radius as exactly double, which the test caught.
  return ((l1 + l2) * 0.5) / turn;
}

function turbineGate(i, E) {
  const ramp = (v, lo, hi) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  // a slide: the biggest wheel slip this frame, if the run has the signal
  let slip = 0;
  if (E.slip) for (let k = 0; k < 4; k++) { const s = Math.abs(E.slip[i * 4 + k] || 0); if (s > slip) slip = s; }
  const slideF = ramp(slip, TURBINE_SLIP_ON, TURBINE_SLIP_FULL);
  // a straight: a big path radius. Inverted ramp — tighter than CORNER_R is fully cornering.
  const R = pathRadius(E, i);
  const straightF = ramp(R, TURBINE_CORNER_R, TURBINE_STRAIGHT_R);
  return Math.max(TURBINE_IDLE, Math.max(slideF, straightF));
}

function turbineIntensity(i, src) {
  const E = src || ex;
  const N = E.N;
  if (i < 1 || i >= N - 1 || E.gap[i]) return 0;
  const gate = turbineGate(i, E);
  const g = (v) => v * gate;
  /* BEST: the turbine's own state, as the mod itself reads it. The afterburner is a BUTTON
   * (CSP `scriptControllerInputs[12]`/`[17]`) and the plume is real thrust (`[9]`) — neither is
   * visible in AC's shared memory, so this only exists in replays recorded with the BLACKBOX CSP
   * bridge installed (schema 6). When it's there, the flame fires when the driver fired it. */
  if (E.tel && E.tel.has.turbine) {
    const thrust = Math.max(0, Math.min(1, E.tel.thrust[i]));
    const ab = Math.max(0, Math.min(1, E.tel.afterburner[i]));
    // afterburner is the dramatic one: it forces the plume to full and past it, thrust alone idles it
    // NOT gated: when the replay carries the real button, a deliberate press outranks any
    // guess about what the car "should" be doing — the driver fired it, so it fires.
    if (ab > 0.02) return Math.min(1, Math.max(thrust, ab * (0.85 + 0.15 * thrust)));
    return g(Math.min(1, thrust));
  }
  // FALLBACK when the replay predates the bridge: infer the plume from turbo boost
  // pressure (1.0 idle → ~1.94 at load), throttle-gated so a lift collapses it. This is a
  // stand-in for the button, not a reading of it — it cannot know when you pressed it.
  if (E.tel && E.tel.has.boost) {
    const boostN = Math.max(0, Math.min(1, (E.tel.boost[i] - 1.05) / 0.85));
    const thr = Math.max(0, Math.min(1, E.tel.gas[i]));
    return g(Math.min(1, boostN * (0.4 + 0.6 * thr)));
  }
  // ---- kinematic fallback (no telemetry stamped) ----
  const P = E.pos, FW = E.fwd;
  // slip: angle between velocity and real body heading
  const a = Math.max(0, i - 3), b = Math.min(N - 1, i + 3);
  let vx = P[b * 3] - P[a * 3], vy = P[b * 3 + 1] - P[a * 3 + 1], vz = P[b * 3 + 2] - P[a * 3 + 2];
  const vl = Math.hypot(vx, vy, vz) || 1; vx /= vl; vy /= vl; vz /= vl;
  let hx = FW[i * 3], hy = FW[i * 3 + 1], hz = FW[i * 3 + 2];
  const hl = Math.hypot(hx, hy, hz);
  let slip = 0;
  if (hl > 1e-4) {
    hx /= hl; hy /= hl; hz /= hl;
    let d = Math.abs(hx * vx + hy * vy + hz * vz);
    slip = Math.acos(Math.max(0, Math.min(1, d))); // radians
  }
  const slipN = Math.min(1, slip / 0.35);           // ~20° = full
  // hard acceleration (boost) from speed rise. E, not ex: a ghost's plume must read its
  // own speed trace, or every car would flare on the reference car's acceleration.
  const s0 = E.speed[i], sm = E.speed[Math.max(0, i - 4)];
  const acc = isFinite(s0) && isFinite(sm) ? Math.max(0, (s0 - sm)) / 40 : 0;
  return g(Math.min(1, slipN * 0.85 + Math.min(1, acc) * 0.5));
}

// blue thruster plume from the Mach 6's rear, perspective-sized point sprites — a straight
// jet out the nozzle. `lum` brightens it (cranked at night).
// JET AFTERBURNER — a continuous blue flame cone out the turbine nozzle: a thin white-hot core with
// shock diamonds (the periodic bright spots real afterburners show), wrapped in a soft blue glow, with
// turbulent wobble that grows toward the tip and a plume that stretches under boost. Additive, blue.
/* Plume staging. The particle count is a compile-time constant (KC + KG) and every slot is
 * rewritten on every call, so a pool is exactly equivalent to the per-call allocation it
 * replaces — and the draw count is that same constant, never the buffer's capacity. */
const THR_KC = 32, THR_KG = 22;                              // core / outer-glow particle counts
const _thrArr = new Float32Array((THR_KC + THR_KG) * 5);     // sized FROM them, never a repeated literal
function drawThruster(m, inten, mvp, lum) {
  lum = lum || 1;
  const eye = camEye();
  const nz = carNozzle || [0, 0.49, -2.1];                    // emit from the turbine nozzle geometry
  const lx = nz[0], ly = nz[1], lz = nz[2] + 0.02;            // sit at the nozzle mouth (barely recessed) — a deep recess + fat sprites washed the housing
  const ox = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
  const oy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
  const oz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
  const bx = -m[8], by = -m[9], bz = -m[10];                  // backward = −nose (plume axis)
  const rx = m[0], ry = m[1], rz = m[2], ux = m[4], uy = m[5], uz = m[6];   // car right / up → lateral turbulence plane
  const th = Math.tan(0.9 / 2), Hpx = cv.height;
  const t0 = performance.now();
  const flick = 0.86 + 0.14 * Math.sin(t0 * 0.05) + 0.06 * Math.sin(t0 * 0.017);  // combustion flicker
  // Length is where this ran away: 0.4 + inten*1.5 put nearly two metres of flame out the
  // back at full — longer than the car's own overhang — so max thrust read as a rocket
  // exhaust rather than a turbine. The intent was always a SHORT girthy burst at the
  // nozzle; the drama is meant to come from the white-hot core, the shock diamonds and the
  // bloom, none of which need reach. ~1.1 m at full now, and the idle length is barely
  // changed so the plume still shows when the gate holds it low.
  const len = 0.32 + inten * 0.78;
  const KC = THR_KC, KG = THR_KG, K = KC + KG, arr = _thrArr;   // fixed-size pool, fully rewritten below
  let idx = 0;
  const push = (t, r, b, jitAmp, seed) => {
    const ang = t0 * 0.011 + seed * 2.3;                     // swirl direction in the lateral plane
    const wob = jitAmp * Math.sin(t * 9.0 + t0 * 0.02 + seed);
    const jx = (rx * Math.cos(ang) + ux * Math.sin(ang)) * wob;
    const jy = (ry * Math.cos(ang) + uy * Math.sin(ang)) * wob;
    const jz = (rz * Math.cos(ang) + uz * Math.sin(ang)) * wob;
    const px = ox + bx * t * len + jx, py = oy + by * t * len + jy, pz = oz + bz * t * len + jz;
    const dist = Math.hypot(px - eye[0], py - eye[1], pz - eye[2]) || 1;
    arr[idx * 5] = px; arr[idx * 5 + 1] = py; arr[idx * 5 + 2] = pz;
    arr[idx * 5 + 3] = Math.min(500, r * Hpx / (dist * th));
    arr[idx * 5 + 4] = b;
    idx++;
  };
  // inner core — thin, white-hot, dense; brightness pulses at shock diamonds and tapers to the tip
  for (let k = 0; k < KC; k++) {
    const t = k / (KC - 1);
    const shock = 1 + 0.55 * Math.pow(Math.max(0, Math.sin(t * 13.0 - t0 * 0.02)), 6);   // shock diamonds drifting aft
    // belly profile: NARROW at the mouth (so it doesn't wash the housing) → fattest just aft → taper
    const r = (0.11 * (0.3 + 0.7 * Math.min(1, t * 4.5)) * (1 - t * 0.55) + 0.010) * (0.85 + 0.35 * inten);
    const b = (1 - Math.pow(t, 1.25)) * inten * flick * lum * shock * 1.15;
    push(t, r, b, (0.014 + 0.09 * t * t) * (0.6 + 0.4 * inten), k * 0.7);
  }
  // outer glow — wider, softer blue cone enveloping the core
  for (let k = 0; k < KG; k++) {
    const t = k / (KG - 1);
    const r = (0.2 * (0.32 + 0.68 * Math.min(1, t * 3.8)) * (1 - t * 0.45) + 0.018) * (0.75 + 0.45 * inten);   // wide envelope, but narrow at the mouth so it doesn't spill onto the housing
    const b = (1 - t) * 0.45 * inten * flick * lum;
    push(t, r, b, (0.02 + 0.12 * t * t) * (0.6 + 0.4 * inten), 100 + k * 0.9);
  }
  gl.useProgram(progThr);
  gl.uniformMatrix4fv(thrLoc.mvp, false, mvp);
  gl.bindBuffer(gl.ARRAY_BUFFER, thrBuf);
  gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(thrLoc.pos); gl.vertexAttribPointer(thrLoc.pos, 3, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(thrLoc.size); gl.vertexAttribPointer(thrLoc.size, 1, gl.FLOAT, false, 20, 12);
  gl.enableVertexAttribArray(thrLoc.bright); gl.vertexAttribPointer(thrLoc.bright, 1, gl.FLOAT, false, 20, 16);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);
  gl.drawArrays(gl.POINTS, 0, K);
  gl.depthMask(true); gl.disable(gl.BLEND);
}

// backfire intensity at fractional frame `fp`: a sharp pop right at a detected upshift,
// decaying over ~0.16 s. Deterministic (scrub-safe). 0 when not near a shift.
// Real backfire trigger frames from telemetry: gear changes (the throttle-cut pop),
// throttle lifts at high rpm (overrun crackle), and rev-limiter onset (limiter bang).
// Far truer than the kinematic upshift guess — exact timing, and it catches downshifts
// and lift-off pops the kinematic version never saw. Returns sorted frames, or null.
function detectTelemetryBackfires(ex) {
  const T = ex.tel; if (!T) return null;
  const N = ex.N, out = [];
  const minGap = Math.max(1, Math.round(0.09 / ex.dt));   // debounce so one event = one pop
  let last = -1e9, lastReal = -1;
  const gearAt = k => Math.round(T.gear[k]);
  for (let i = 1; i < N; i++) {
    if (ex.gap[i] || ex.gap[i - 1]) continue;
    let pop = false;
    const gi = gearAt(i);
    if (gi >= 2) {                                                                 // a forward-gear reading
      if (lastReal >= 2 && gi !== lastReal) pop = true;                            // gear changed vs last real gear (skips transient N blips)
      lastReal = gi;
    }
    if (!pop && T.gas[i - 1] > 0.8 && T.gas[i] < 0.25 && T.rpm[i] > 5200) pop = true; // lift-off overrun crackle
    if (!pop && T.rpm[i] >= 9750 && T.rpm[i - 1] < 9750 && T.gas[i] > 0.7) pop = true; // rev-limiter bang (real limiter ~9842)
    if (pop && (i - last) >= minGap) { out.push(i); last = i; }
  }
  return out;
}
function backfireAt(fp, src) {
  const E = src || ex;
  const sh = E.shifts; if (!sh || !sh.length) return 0;
  const decay = Math.max(2, Math.round(0.16 / E.dt));
  let lo = 0, hi = sh.length - 1, best = -1;   // largest shift frame ≤ fp
  while (lo <= hi) { const m = (lo + hi) >> 1; if (sh[m] <= fp) { best = m; lo = m + 1; } else hi = m - 1; }
  if (best < 0) return 0;
  const d = fp - sh[best];
  if (d < 0 || d > decay) return 0;
  return Math.pow(1 - d / decay, 1.6);   // sharp attack at the shift, quick decay
}
// exhaust backfire: bright orange pops on an upshift — from the TWO DUAL EXHAUSTS that flank
// the turbine (NOT the turbine itself), brighter at night.
// dual-exhaust openings relative to the turbine nozzle — measured from the Mach 6 kn5 geometry:
// exhaust pipes flank the turbine at x≈±0.30, tips at z≈-2.4 / y≈0.48 (nozzle ≈ [0,0.50,-2.24]).
const EXH_X = 0.30, EXH_Y = -0.02, EXH_Z = -0.16;
/* A real backfire is not one orange blob fading in place. It is unburnt fuel igniting AT
 * the pipe: a white-hot core for an instant, an orange body that punches out and spreads
 * as it goes, and a ragged edge, because flame is turbulent and a straight line of
 * identical sprites reads as a decal.
 *
 * Three things give it that, without touching the glow program:
 *   1. LAYERS, as separate passes because uColor is per batch — a short white-hot core,
 *      the orange body, and a blue flash of raw fuel in the first instant only. The core
 *      dies first: the hottest part is the youngest.
 *   2. AGE. inten runs 1 -> 0 across the pop, so (1 - inten) is how far through it is.
 *      The plume lengthens and its puffs swell as it ages — an expanding cloud rather
 *      than a dimming stick.
 *   3. DETERMINISTIC jitter. Sprites are pushed off-axis by a hash of their index, so the
 *      plume is ragged and the two outlets differ. A hash, never Math.random: this
 *      renderer is scrub-safe and the same frame must draw identically every time, or a
 *      paused timeline would shimmer.
 */
const bfHash = (i) => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

function drawBackfire(cm, mvp, th, inten, nightF) {
  const eye = camEye(), Hpx = cv.height;
  const nz = carNozzle || [0, 0.49, -2.1];
  const outlets = [[nz[0] + EXH_X, nz[1] + EXH_Y, nz[2] + EXH_Z], [nz[0] - EXH_X, nz[1] + EXH_Y, nz[2] + EXH_Z]];
  let bx = -cm[8], by = -cm[9], bz = -cm[10]; const bl = Math.hypot(bx, by, bz) || 1; bx /= bl; by /= bl; bz /= bl;   // backward
  const rx = cm[0], ry = cm[1], rz = cm[2];                     // car right, for lateral spread
  const ux = cm[4], uy = cm[5], uz = cm[6];                     // car up
  const lum = inten * (1.0 + nightF * 1.8);                     // pops brighter at night
  const age = 1 - Math.max(0, Math.min(1, inten));              // 0 at ignition, 1 as it dies
  const NB = 9;

  const layer = (reach, spread, sz, fade, seed) => {
    const s = [];
    for (let o = 0; o < outlets.length; o++) {
      const L = outlets[o];
      const ox = cm[0]*L[0] + cm[4]*L[1] + cm[8]*L[2] + cm[12];
      const oy = cm[1]*L[0] + cm[5]*L[1] + cm[9]*L[2] + cm[13];
      const oz = cm[2]*L[0] + cm[6]*L[1] + cm[10]*L[2] + cm[14];
      for (let k = 0; k < NB; k++) {
        const t = k / (NB - 1);
        const h1 = bfHash(seed + o * 31 + k * 7), h2 = bfHash(seed + o * 57 + k * 13 + 5);
        const w = spread * t * (0.4 + h1);                      // flares with distance back
        const px = ox + bx * t * reach + (rx * (h1 - 0.5) + ux * (h2 - 0.5)) * w;
        const py = oy + by * t * reach + (ry * (h1 - 0.5) + uy * (h2 - 0.5)) * w;
        const pz = oz + bz * t * reach + (rz * (h1 - 0.5) + uz * (h2 - 0.5)) * w;
        const dist = Math.hypot(px - eye[0], py - eye[1], pz - eye[2]) || 1;
        const grow = sz * (0.55 + t * 0.85) * (1 + age * 0.45); // puffs swell as they age
        const b = Math.pow(1 - t, fade) * lum * (0.65 + 0.7 * h2);
        s.push(px, py, pz, Math.min(500, grow * Hpx / (dist * th)), b);
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, glowBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(s), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(glowLoc.pos); gl.vertexAttribPointer(glowLoc.pos, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(glowLoc.size); gl.vertexAttribPointer(glowLoc.size, 1, gl.FLOAT, false, 20, 12);
    gl.enableVertexAttribArray(glowLoc.bright); gl.vertexAttribPointer(glowLoc.bright, 1, gl.FLOAT, false, 20, 16);
    gl.drawArrays(gl.POINTS, 0, NB * outlets.length);
  };

  gl.useProgram(progGlow); gl.uniformMatrix4fv(glowLoc.mvp, false, mvp);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);

  // Sizes are tuned SMALL on purpose. The shape work (layers, expansion, ragged edge) is
  // what makes a pop read as flame; scale is what makes it read as a real exhaust rather
  // than a flamethrower. A backfire out of a race pipe is a hand-sized crack of light, not
  // a metre of fire — so the plume is short and the sprites are tight, and the drama comes
  // from the hot core and the bloom, not from covering the back of the car.
  // body: deep orange, punches out and spreads as it ages (HDR -> blooms)
  gl.uniform3f(glowLoc.color, 1.45 * HDR_EMIT, 0.42 * HDR_EMIT, 0.08 * HDR_EMIT);
  layer(0.52 + age * 0.85, 0.20, 0.105, 1.7, 11);

  // core: white-hot, short, and it dies FIRST
  const core = Math.max(0, inten - 0.25) / 0.75;
  if (core > 0.01) {
    gl.uniform3f(glowLoc.color, 2.3 * HDR_EMIT * core, 1.55 * HDR_EMIT * core, 0.85 * HDR_EMIT * core);
    layer(0.24 + age * 0.24, 0.07, 0.062, 2.6, 29);
  }

  // the first instant only: raw fuel igniting blue at the pipe mouth, gone in a blink
  const flash = Math.max(0, inten - 0.72) / 0.28;
  if (flash > 0.01) {
    gl.uniform3f(glowLoc.color, 0.55 * HDR_EMIT * flash, 0.75 * HDR_EMIT * flash, 1.7 * HDR_EMIT * flash);
    layer(0.15, 0.04, 0.046, 3.2, 47);
  }

  gl.depthMask(true); gl.disable(gl.BLEND);
}

// additive coloured glow sprites — the car's headlights (warm, wafting beam) and
// tail lights (red bleed). Colour is a per-batch uniform so one program does both.
const progGlow = gl.createProgram();
gl.attachShader(progGlow, shader(gl.VERTEX_SHADER,
  "attribute vec3 aPos; attribute float aSize; attribute float aBright;" +
  "uniform mat4 uMVP; varying float vB;" +
  "void main(){ gl_Position = uMVP*vec4(aPos,1.0); gl_PointSize = aSize; vB = aBright; }"));
gl.attachShader(progGlow, shader(gl.FRAGMENT_SHADER,
  "precision mediump float; varying float vB; uniform vec3 uColor;" +
  "void main(){ float r = length(gl_PointCoord-0.5)*2.0; float a = pow(smoothstep(1.0,0.0,r),1.7)*vB;" +
  " gl_FragColor = vec4(uColor*a, a); }"));
gl.linkProgram(progGlow);
const glowLoc = {
  pos: gl.getAttribLocation(progGlow, "aPos"), size: gl.getAttribLocation(progGlow, "aSize"),
  bright: gl.getAttribLocation(progGlow, "aBright"), mvp: gl.getUniformLocation(progGlow, "uMVP"),
  color: gl.getUniformLocation(progGlow, "uColor"),
};
const glowBuf = gl.createBuffer();

/* TRACK LAMP GLARE — the lamp seen, as distinct from the lamp lighting something.
 *
 * These are two different distances and the configs say so plainly. The T-180 test track's
 * lamps declare RANGE 180 m and FADE_AT 1000 m, and the track is 943 m across: the author
 * means the pool of light is local and the lamp ITSELF is visible from anywhere on the
 * circuit. Nordic is starker still — 300 m range, 2000 m fade. Illumination alone therefore
 * gives a night track that goes black fifty metres out, which is not what a real night
 * circuit looks like from the far side.
 *
 * Separate program from the car's glow because colour has to be PER SPRITE here. The car
 * batches by colour (one warm set, one red set) and a track's lamps do not batch — sakura's
 * are white, thunderhead's run blue and orange within the same series.
 *
 * There is no cull to twelve here. That limit exists because each lit fragment costs a
 * shader loop iteration; a point sprite costs one vertex and a few pixels, so every lamp
 * within its fade distance is drawn — all 207 of nordic's. */
const progLamp = gl.createProgram();
gl.attachShader(progLamp, shader(gl.VERTEX_SHADER,
  "attribute vec3 aPos; attribute vec3 aCol; attribute vec2 aSB;" +
  "uniform mat4 uMVP; varying vec3 vC; varying float vB;" +
  "void main(){ gl_Position = uMVP*vec4(aPos,1.0); gl_PointSize = aSB.x; vC = aCol; vB = aSB.y; }"));
gl.attachShader(progLamp, shader(gl.FRAGMENT_SHADER,
  "precision mediump float; varying vec3 vC; varying float vB;" +
  // a hot core inside a much wider, much softer halo — one smoothstep gives a flat disc
  // that reads as a decal, and a lamp at distance is mostly halo
  "void main(){ float r = length(gl_PointCoord-0.5)*2.0;" +
  " float core = pow(smoothstep(1.0,0.0,r), 6.0);" +
  " float halo = pow(smoothstep(1.0,0.0,r), 1.6) * 0.42;" +
  " float a = (core + halo) * vB; gl_FragColor = vec4(vC*a, a); }"));
gl.linkProgram(progLamp);
const lampLoc = {
  pos: gl.getAttribLocation(progLamp, "aPos"), col: gl.getAttribLocation(progLamp, "aCol"),
  sb: gl.getAttribLocation(progLamp, "aSB"), mvp: gl.getUniformLocation(progLamp, "uMVP"),
};
const lampBuf = gl.createBuffer();
let TRACK_LAMP_GLOW = 1;
let _glareBuf = null;      // reused sprite staging — see drawTrackLampGlare
let LAMP_GLARE_GAIN = 1.0;
/* Above this bounding radius a matched mesh is a lit STRUCTURE, not a fixture, and gets no
 * glare sprite — it is seen as its own emissive geometry instead. 20 m is comfortably above
 * the biggest real lamp in the library (sakura's 18 m lantern cluster, nordic's 13 m lamp
 * heads) and far below the smallest structure (thunderhead's 224 m stadium light banks). */
let LAMP_FIXTURE_MAX_RADIUS = 20;
/* NO DISTANCE LIMIT, and that is the design rather than an oversight.
 *
 * A light source is visible from however far away you can see it — that is what makes it a
 * light. Its EMISSION is local, bounded by RANGE, and that is a separate thing: the pool on
 * the tarmac ends where the author said it ends. Two properties of one lamp, and every
 * version of this before now conflated them, first by using RANGE for both, then FADE_AT,
 * then a floor under FADE_AT. Each was a bigger number standing in for the right idea.
 *
 * So there is no fade and no cull here. Brightness does not fall off with distance either:
 * what reaches the eye from a distant point source is glare, and glare is why a street lamp
 * a mile off and one across the road look about equally bright — what changes is how big
 * they are, not how bright. Size still carries that, all the way down to the pixel floor.
 * The frustum and the depth buffer remain the only things that hide a lamp. */

/* Draw every track lamp as an additive sprite, sized by distance but never allowed to
 * vanish. `th` is tan(fov/2), so the projection matches the car's glow layer. */
function drawTrackLampGlare(mvp, nightF, th) {
  // follows the same switch as the lamps themselves — turning a track's lights off and
  // leaving its glares hanging in the air would be a strange half-state
  if (!TRACK_LIGHTS_ON || !TRACK_LAMP_GLOW || !trackLights.length) return;
  const eye = camEye(), Hpx = cv.height;
  /* Reused staging buffer with a write cursor, instead of a JS array grown by push() and
   * then copied into a fresh Float32Array every frame. Written by me, and at 60 lamps it
   * was ~10 KB of garbage a frame — on nordic's 207 lamps, ~34 KB. Sized on first use to
   * whatever the track actually declares, since that never changes while it is loaded. */
  if (!_glareBuf || _glareBuf.length < trackLights.length * 8) {
    _glareBuf = new Float32Array(Math.max(64, trackLights.length) * 8);
  }
  const v = _glareBuf;
  let vn = 0;
  for (const L of trackLights) {
    const gate = L.night ? nightF : 1;
    if (gate <= 0.02) continue;
    /* A glare sprite needs a POINT to sit on, and not every light has one. The T-180 test
     * track names its roof as a light source — deliberately, a 682 m glowing ceiling — and
     * a sprite at the centre of that is a dot hanging in mid-air inside the structure,
     * which is both nowhere near a visible lamp and hidden behind geometry until you are
     * almost touching it. Half that track's 60 lights are meshes of this kind, and on
     * thunderhead it is 42 of 54.
     *
     * They are not dropped, only their sprite is: they still light the scene through the
     * shader, and they are still SEEN — as their own emissive geometry, which is what a
     * glowing ceiling actually looks like. A sprite would be a worse drawing of a thing
     * already drawn correctly. */
    if (L.radius > LAMP_FIXTURE_MAX_RADIUS) continue;
    const dx = L.pos[0] - eye[0], dy = L.pos[1] - eye[1], dz = L.pos[2] - eye[2];
    const d = Math.hypot(dx, dy, dz) || 1;
    /* A LAMP IS SHIELDED BY ITS OWN BODY. The T-180 test track's lamps aim straight down
     * (DIRECTION = 0,-1,0) and are solid geometry above the bulb, so from above you should
     * see the housing and no light at all — the sprite was punching through it, because
     * it is nudged toward the eye precisely so a fixture cannot hide its own glare.
     *
     * The nudge is still right for a viewer the lamp is pointing at. What was missing is
     * that visibility of a SOURCE follows the same cone as its emission, so the same SPOT
     * angle the shader uses for the light is used here for the sight of it. Same
     * smoothstep shape as the shader's cone, so a lamp dims out at the rim rather than
     * blinking off. Point lights and NORMAL-aimed lamps have no usable cone and are seen
     * from everywhere, which for an unshielded bulb is correct. */
    let cone = 1;
    if (L.spotUsable) {
      const dl = Math.hypot(L.dir[0], L.dir[1], L.dir[2]) || 1;
      // direction from the LAMP to the eye, against where the lamp is pointing
      const c = -(dx * L.dir[0] + dy * L.dir[1] + dz * L.dir[2]) / (d * dl);
      const cosHalf = Math.cos(Math.min(359, L.spot) * 0.5 * Math.PI / 180);
      const outer = cosHalf, inner = cosHalf + (1 - cosHalf) * 0.35;
      cone = Math.max(0, Math.min(1, (c - outer) / Math.max(1e-4, inner - outer)));
      cone = cone * cone * (3 - 2 * cone);            // smoothstep
      if (cone <= 0.004) continue;                    // behind the shield: nothing to draw
    }
    // no distance term at all — see the note on the constants above
    const b = gate * LAMP_GLARE_GAIN * cone;
    if (b <= 0.004) continue;
    /* Size: a real fixture's angular size, EXCEPT that it is not allowed below 5 px. The
     * floor is the whole point. A lamp 900 m away subtends about 0.7 px, so the honest
     * projection makes it disappear — but a real light at that distance is still plainly
     * visible, because the eye receives its glare rather than resolving its shape. Five
     * pixels because 2.5 was arithmetically sufficient and visually still nothing.
     *
     * With no distance term on brightness, THIS is now the only thing that distinguishes a
     * near lamp from a far one — which is right, and is how real lights behave: what
     * changes across a mile is their size, not their brightness. Below about a pixel a
     * sprite also shimmers as it crosses the sample grid, so the floor fixes the flicker
     * and the vanishing in one move.
     *
     * The world size is the FIXTURE'S OWN radius now that the parser keeps it, rather than
     * a number derived from intensity. A lamp's brightness and a lamp's size are unrelated
     * — sakura's lanterns are 1 m across and Miandros's floodlights are metres wide at
     * thirty times the declared intensity — and the measurement was sitting in the kn5. */
    const world = Math.max(0.5, Math.min(8, L.radius || 1));
    const px = Math.max(5, Math.min(70, world * Hpx / (d * th)));
    /* WHERE THE BULB ACTUALLY IS. The lamp's position is its mesh's bounding-sphere CENTRE,
     * which is inside the housing, so a sprite drawn there loses the depth test to the
     * fixture's own front face and the lamp swallows its own glare.
     *
     * This used to be fixed by pulling the sprite toward the EYE. That works from below and
     * is precisely wrong from above: it drags the bulb out through the top of the housing,
     * so a downward-aimed lamp showed a bright dot sitting on its own lid.
     *
     * A real bulb sits under its shade, so the offset follows the lamp's OWN AIM. Slightly
     * more than the fixture radius puts it just clear of the housing's lower face, where the
     * light physically leaves. Seen from below it is in front of the shade and visible; seen
     * from above the shade is between it and the eye and the depth buffer hides it, which is
     * what a shade is for. No camera-dependent term at all, so the sprite no longer moves
     * when you move.
     *
     * A lamp with no usable aim (a point light, or DIRECTION = NORMAL whose true aim we
     * cannot know) has no "under" to sit beneath, so it keeps the eye-ward nudge — correct
     * for an unshielded bulb, which is what those are. */
    let sx, sy, sz;
    if (L.spotUsable) {
      const dl = Math.hypot(L.dir[0], L.dir[1], L.dir[2]) || 1;
      const out = Math.max(0.35, (L.radius || 0) * 1.15);
      sx = L.pos[0] + L.dir[0] / dl * out;
      sy = L.pos[1] + L.dir[1] / dl * out;
      sz = L.pos[2] + L.dir[2] / dl * out;
    } else {
      const k = Math.max(0.5, d * 0.004, (L.radius || 0) * 1.1) / d;
      sx = L.pos[0] - dx * k; sy = L.pos[1] - dy * k; sz = L.pos[2] - dz * k;
    }
    v[vn] = sx; v[vn+1] = sy; v[vn+2] = sz;
    v[vn+3] = L.color[0]; v[vn+4] = L.color[1]; v[vn+5] = L.color[2];
    v[vn+6] = px; v[vn+7] = b;
    vn += 8;
  }
  if (!vn) return;
  gl.useProgram(progLamp);
  gl.uniformMatrix4fv(lampLoc.mvp, false, mvp);
  gl.bindBuffer(gl.ARRAY_BUFFER, lampBuf);
  // subarray, not a copy — a view costs one small object instead of the whole staging array
  gl.bufferData(gl.ARRAY_BUFFER, v.subarray(0, vn), gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(lampLoc.pos);
  gl.vertexAttribPointer(lampLoc.pos, 3, gl.FLOAT, false, 32, 0);
  gl.enableVertexAttribArray(lampLoc.col);
  gl.vertexAttribPointer(lampLoc.col, 3, gl.FLOAT, false, 32, 12);
  gl.enableVertexAttribArray(lampLoc.sb);
  gl.vertexAttribPointer(lampLoc.sb, 2, gl.FLOAT, false, 32, 24);
  gl.enable(gl.BLEND);
  /* PREMULTIPLIED additive, like every other glow layer in this file, and the reason the
   * first version of this reached nowhere. The fragment already outputs vec4(colour*a, a),
   * so SRC_ALPHA multiplies by a a SECOND time and the contribution goes quadratic. The
   * cost is 1/a, which is nothing up close where a is near 1 and severe exactly where this
   * feature earns its keep: a lamp at 0.2 brightness arrived at 0.04, a fifth of its
   * value — while the lamp beside the camera looked perfectly correct. */
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.depthMask(false);                          // a lamp behind a grandstand stays hidden,
  gl.enable(gl.DEPTH_TEST);                     // but glare must not occlude what follows
  gl.drawArrays(gl.POINTS, 0, vn / 8);   // the cursor, not the buffer's capacity
  gl.disableVertexAttribArray(lampLoc.col);
  gl.disableVertexAttribArray(lampLoc.sb);
  gl.disable(gl.BLEND);
  gl.depthMask(true);
}

/* ---- glow staging ----
 * drawCarLights runs once per car per frame, and every one of these used to be built fresh:
 * three growing Arrays, a `push` closure, a per-side .slice().sort(), an mXfPt result per
 * lamp, and a Float32Array copy per batch. With the field on track that is the heaviest
 * remaining allocator in the light path. The pools below are module-scope and reused; only
 * the fill changes per car. */
const GLOW_CAP = 256;                                        // sprites per colour per car
const _glowWarm  = { a: new Float32Array(GLOW_CAP * 5), n: 0 };
const _glowRed   = { a: new Float32Array(GLOW_CAP * 5), n: 0 };
const _glowWhite = { a: new Float32Array(GLOW_CAP * 5), n: 0 };
const _glowFwd = [0, 0, 0];                                  // scratch: the beam/forward axis

/* Append one sprite. Hoisted out of drawCarLights so the closure that captured eye/Hpx/th is
 * gone — they ride in as arguments instead. */
let _glowOverflowed = false;
function pushGlow(S, px, py, pz, r, b, eye, Hpx, th) {
  if (S.n >= GLOW_CAP) {                                     // pool size is the ceiling
    // The arrays this replaced were unbounded, so a lamp-heavy model that would once have
    // drawn every sprite now silently loses the tail. Silence is the bad part, not the cap —
    // say it once so a missing light is diagnosable instead of mysterious.
    if (!_glowOverflowed) { _glowOverflowed = true; console.warn(`glow pool full at ${GLOW_CAP} sprites — some lamps not drawn`); }
    return;
  }
  const dist = Math.hypot(px - eye[0], py - eye[1], pz - eye[2]) || 1;
  const o = S.n * 5;
  S.a[o] = px; S.a[o + 1] = py; S.a[o + 2] = pz;
  S.a[o + 3] = Math.min(500, r * Hpx / (dist * th));
  S.a[o + 4] = b;
  S.n++;
}

/* The left/right split and the top-lamp-first ordering depend only on the car's lamp
 * geometry in model space, which does not change from frame to frame — this was a
 * .slice().sort() per side per car per frame for an answer that is always the same.
 * Keyed on array identity, so loading a different car rebuilds it. */
const _lampL = [], _lampR = [], _lampSides = [_lampL, _lampR];
let _lampSrc = null;
function headLampSides(hl) {
  if (hl === _lampSrc) return _lampSides;
  _lampSrc = hl; _lampL.length = 0; _lampR.length = 0;
  for (const a of hl) (a[0] > 0 ? _lampL : _lampR).push(a);
  const byHeight = (p, q) => q[1] - p[1];                    // top lamp first — index 0 keeps the wide bloom
  _lampL.sort(byHeight); _lampR.sort(byHeight);
  return _lampSides;
}

// glow layer: red tail lights (flare on braking) + the body's white & red LED accent
// arrays. Headlights are the shader cone spotlight, not here. All fade in at night.
function drawCarLights(cm, mvp, th, nightF, brakeF) {
  if (!carLights) return;
  const eye = camEye(), Hpx = cv.height;
  const warm = _glowWarm, red = _glowRed, white = _glowWhite;
  warm.n = 0; red.n = 0; white.n = 0;
  // warm headlamp glow — each of the 3 lamps per side gets a CRISP bulb; only the top
  // lamp keeps a soft halo, so the lower two don't leak light onto the body.
  { const sides = headLampSides(carLights.headLamps || []);
    const fl = Math.hypot(cm[8], cm[9], cm[10]) || 1, fwd = _glowFwd;   // beam/forward axis
    fwd[0] = cm[8] / fl; fwd[1] = cm[9] / fl; fwd[2] = cm[10] / fl;
    for (const side of sides) for (let idx = 0; idx < side.length; idx++) {
      const a = side[idx];
      const Px = a[0]*cm[0] + a[1]*cm[4] + a[2]*cm[8]  + cm[12];        // mXfPt, inlined to scalars
      const Py = a[0]*cm[1] + a[1]*cm[5] + a[2]*cm[9]  + cm[13];
      const Pz = a[0]*cm[2] + a[1]*cm[6] + a[2]*cm[10] + cm[14];
      // how head-on the beam is to the camera — real headlights GLARE far brighter when you look into
      // them, so the luminous halo swells when the beams point your way (bloom's gone, so draw the glow).
      const dx = eye[0] - Px, dy = eye[1] - Py, dz = eye[2] - Pz; const dl = Math.hypot(dx, dy, dz) || 1;
      const facing = Math.max(0, (dx * fwd[0] + dy * fwd[1] + dz * fwd[2]) / dl);
      // fade the soft halos OUT with distance: far off, the sprites converge and stack additively into a
      // blown-out ball, so keep only the tight bulb at range (still reads as a distant headlight point).
      const near = Math.max(0, Math.min(1, (42 - dl) / 30));                 // 1 within ~12m → 0 by ~42m
      pushGlow(warm, Px, Py, Pz, 0.05, (0.6 + 0.5 * facing) * nightF * (0.4 + 0.6 * near), eye, Hpx, th);   // crisp bulb (dimmer at range so the 3-lamp cluster doesn't stack hot)
      pushGlow(warm, Px, Py, Pz, 0.13, (0.10 + 0.30 * facing) * nightF * near, eye, Hpx, th);               // soft luminous halo — near only
      if (idx === 0) pushGlow(warm, Px, Py, Pz, 0.26, (0.03 + 0.18 * facing * facing) * nightF * near, eye, Hpx, th);  // wide bloom — near + head-on only
    }
  }
  // tail lights: red running glow → wider/hotter flare under braking (3 lamps/side).
  // Keep the silhouette (sizes) but toned-down luminosity.
  const base = 0.4 + 0.85 * brakeF, spread = 1.0 + 0.25 * brakeF;   // MUCH brighter on braking, barely bigger
  for (const t of (carLights.tail || [])) {
    const Tx = t[0]*cm[0] + t[1]*cm[4] + t[2]*cm[8]  + cm[12];
    const Ty = t[0]*cm[1] + t[1]*cm[5] + t[2]*cm[9]  + cm[13];
    const Tz = t[0]*cm[2] + t[1]*cm[6] + t[2]*cm[10] + cm[14];
    pushGlow(red, Tx, Ty, Tz, 0.08 * spread, base * nightF, eye, Hpx, th);
    pushGlow(red, Tx, Ty, Tz, 0.11 * spread, 0.42 * base * nightF, eye, Hpx, th);
  }
  // red LED accents on the body — small crisp glows + a tight halo (bloom spreads them)
  for (const a of (carLights.accentR || [])) {
    const Px = a[0]*cm[0] + a[1]*cm[4] + a[2]*cm[8]  + cm[12];
    const Py = a[0]*cm[1] + a[1]*cm[5] + a[2]*cm[9]  + cm[13];
    const Pz = a[0]*cm[2] + a[1]*cm[6] + a[2]*cm[10] + cm[14];
    pushGlow(red, Px, Py, Pz, 0.055, 0.9 * nightF, eye, Hpx, th);
    pushGlow(red, Px, Py, Pz, 0.09, 0.30 * nightF, eye, Hpx, th);
  }
  // white LED accents
  for (const a of (carLights.accentW || [])) {
    const Px = a[0]*cm[0] + a[1]*cm[4] + a[2]*cm[8]  + cm[12];
    const Py = a[0]*cm[1] + a[1]*cm[5] + a[2]*cm[9]  + cm[13];
    const Pz = a[0]*cm[2] + a[1]*cm[6] + a[2]*cm[10] + cm[14];
    pushGlow(white, Px, Py, Pz, 0.055, 0.9 * nightF, eye, Hpx, th);
    pushGlow(white, Px, Py, Pz, 0.09, 0.30 * nightF, eye, Hpx, th);
  }

  gl.useProgram(progGlow); gl.uniformMatrix4fv(glowLoc.mvp, false, mvp);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);
  const E = HDR_EMIT;
  batchGlow(_glowWarm, 1.0*E, 0.92*E, 0.72*E);                        // warm headlamp glow (3 lamps/side)
  batchGlow(_glowRed, 1.0*E, (0.06 + 0.13 * brakeF)*E, 0.03*E);       // tail + red accents (hotter when braking)
  batchGlow(_glowWhite, 0.85*E, 0.93*E, 1.0*E);                       // cool-white LED accents
  gl.depthMask(true); gl.disable(gl.BLEND);
}
/* Upload one staging pool and draw it. Colour arrives as three scalars rather than an array
 * literal, which is three fewer throwaway objects per car per frame. */
function batchGlow(S, cr, cg, cb) {
  // the cursor, not the buffer's capacity — S.a.length is a constant now that this is a pool,
  // so reading the fill off it draws the whole pool and resurrects the previous car's tail.
  const n = S.n; if (!n) return;
  // Upload stays full-capacity on purpose: a constant-size bufferData avoids GL buffer
  // reallocation, and a subarray view would allocate the very object this pass removes.
  gl.bindBuffer(gl.ARRAY_BUFFER, glowBuf); gl.bufferData(gl.ARRAY_BUFFER, S.a, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(glowLoc.pos); gl.vertexAttribPointer(glowLoc.pos, 3, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(glowLoc.size); gl.vertexAttribPointer(glowLoc.size, 1, gl.FLOAT, false, 20, 12);
  gl.enableVertexAttribArray(glowLoc.bright); gl.vertexAttribPointer(glowLoc.bright, 1, gl.FLOAT, false, 20, 16);
  gl.uniform3f(glowLoc.color, cr, cg, cb); gl.drawArrays(gl.POINTS, 0, n);
}

// ELEGANT LENS FLARE — a screen-space additive glare for the headlamps at night: a tight core, a
// soft round glow, an anamorphic horizontal streak (the cinematic bit), and a faint vertical spike.
// Only shows when the beams face the camera (front views / flybys), so it isn't a constant smear.
const progFlare = gl.createProgram();
gl.attachShader(progFlare, shader(gl.VERTEX_SHADER,
  "attribute vec2 aP; varying vec2 vN; void main(){ vN = aP; gl_Position = vec4(aP,0.0,1.0); }"));
gl.attachShader(progFlare, shader(gl.FRAGMENT_SHADER,
  "precision mediump float; varying vec2 vN; uniform float uAspect; uniform vec3 uWarm;" +
  "uniform vec3 uL0; uniform vec3 uL1;" +   // xy = ndc pos, z = intensity (0 = off)
  "float flare(vec3 L){ if(L.z<=0.0) return 0.0; vec2 d = vN - L.xy; d.x *= uAspect;" +
  "  float r2 = dot(d,d);" +
  "  float core = exp(-r2*130.0);" +                                  // tight bright core
  "  float glow = exp(-r2*13.0)*0.32;" +                              // soft round glare
  "  float streak = exp(-d.y*d.y*850.0)*exp(-d.x*d.x*6.0)*0.55;" +    // anamorphic horizontal streak
  "  float spike = exp(-d.x*d.x*850.0)*exp(-d.y*d.y*70.0)*0.14;" +    // subtle vertical spike (star)
  "  return (core+glow+streak+spike)*L.z; }" +
  "void main(){ float f = flare(uL0)+flare(uL1); gl_FragColor = vec4(uWarm*f, f); }"));
gl.linkProgram(progFlare);
const flareLoc = {
  p: gl.getAttribLocation(progFlare, "aP"), aspect: gl.getUniformLocation(progFlare, "uAspect"),
  warm: gl.getUniformLocation(progFlare, "uWarm"), l0: gl.getUniformLocation(progFlare, "uL0"), l1: gl.getUniformLocation(progFlare, "uL1"),
};
const flareBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, flareBuf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);  // fullscreen tri
// project a world point to NDC, and gauge how head-on the beam is to the camera → flare intensity
function drawLensFlare(cm, mvp, nightF) {
  if (!carLights || nightF < 0.02 || !carLights.head || carLights.head.length < 2) return;
  const eye = camEye();
  const fl = Math.hypot(cm[8], cm[9], cm[10]) || 1, fwd = [cm[8] / fl, cm[9] / fl, cm[10] / fl];
  const L = [[0, 0, 0], [0, 0, 0]];
  for (let k = 0; k < 2; k++) {
    const P = mXfPt(carLights.head[k], cm);
    const cx = mvp[0] * P[0] + mvp[4] * P[1] + mvp[8] * P[2] + mvp[12];
    const cy = mvp[1] * P[0] + mvp[5] * P[1] + mvp[9] * P[2] + mvp[13];
    const cw = mvp[3] * P[0] + mvp[7] * P[1] + mvp[11] * P[2] + mvp[15];
    if (cw <= 0.0001) continue;                                   // behind the camera
    const nx = cx / cw, ny = cy / cw;
    if (Math.abs(nx) > 1.4 || Math.abs(ny) > 1.4) continue;       // well off-screen
    let dx = eye[0] - P[0], dy = eye[1] - P[1], dz = eye[2] - P[2]; const dl = Math.hypot(dx, dy, dz) || 1;
    const facing = Math.max(0, (dx * fwd[0] + dy * fwd[1] + dz * fwd[2]) / dl);
    const edge = Math.max(0, 1 - Math.max(Math.abs(nx), Math.abs(ny)) * 0.7);   // ease out toward screen edges
    // the flare is screen-space (fixed NDC size), so without this a FAR car throws the same full-size
    // glare ball as a near one — fade it hard with distance so it only blooms when the car is close.
    const distFade = Math.max(0, Math.min(1, (60 - dl) / 45));                  // full within ~15m → gone by ~60m
    const inten = Math.pow(facing, 3.0) * nightF * (0.35 + 0.65 * edge) * distFade * 0.85;  // elegant = restrained
    if (inten < 0.015) continue;
    L[k] = [nx, ny, Math.min(inten, 1.1)];
  }
  if (L[0][2] <= 0 && L[1][2] <= 0) return;
  gl.useProgram(progFlare);
  gl.uniform1f(flareLoc.aspect, cv.width / cv.height);
  gl.uniform3f(flareLoc.warm, 1.0, 0.94, 0.82);                   // warm-white flare
  gl.uniform3f(flareLoc.l0, L[0][0], L[0][1], L[0][2]);
  gl.uniform3f(flareLoc.l1, L[1][0], L[1][1], L[1][2]);
  gl.bindBuffer(gl.ARRAY_BUFFER, flareBuf);
  gl.enableVertexAttribArray(flareLoc.p); gl.vertexAttribPointer(flareLoc.p, 2, gl.FLOAT, false, 0, 0);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);             // additive
  gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
}

// contact shadow: a soft dark oval decal laid flat on the track under the car so it
// reads as grounded (not floating). Cheap stand-in until real cast shadows land.
const progShadow = gl.createProgram();
gl.attachShader(progShadow, shader(gl.VERTEX_SHADER,
  "attribute vec3 aPos; attribute vec2 aUV; uniform mat4 uMVP; varying vec2 vUV;" +
  "void main(){ gl_Position = uMVP*vec4(aPos,1.0); vUV = aUV; }"));
gl.attachShader(progShadow, shader(gl.FRAGMENT_SHADER,
  "precision mediump float; varying vec2 vUV; uniform float uStr;" +
  "void main(){ float r = length(vUV-0.5)*2.0; float a = (1.0 - smoothstep(0.35, 1.0, r)) * uStr;" +
  " gl_FragColor = vec4(0.0, 0.0, 0.0, a); }"));
gl.linkProgram(progShadow);
const shadLoc = { pos: gl.getAttribLocation(progShadow, "aPos"), uv: gl.getAttribLocation(progShadow, "aUV"),
  mvp: gl.getUniformLocation(progShadow, "uMVP"), str: gl.getUniformLocation(progShadow, "uStr") };
const shadBuf = gl.createBuffer(), shadowVerts = new Float32Array(20);

function drawCarShadow(cm, mvp) {
  let ux = cm[4], uy = cm[5], uz = cm[6]; const ul = Math.hypot(ux,uy,uz)||1; ux/=ul;uy/=ul;uz/=ul;   // road up
  let fx = cm[8], fy = cm[9], fz = cm[10]; const fl = Math.hypot(fx,fy,fz)||1; fx/=fl;fy/=fl;fz/=fl;   // forward
  let rx = cm[0], ry = cm[1], rz = cm[2]; const rl = Math.hypot(rx,ry,rz)||1; rx/=rl;ry/=rl;rz/=rl;    // right
  const cx = cm[12] + ux*0.04, cy = cm[13] + uy*0.04, cz = cm[14] + uz*0.04;   // just above the road
  const HW = 1.55, HL = 2.95, V = shadowVerts;
  const set = (sx, sl, u, v, o) => { V[o]=cx+rx*sx*HW+fx*sl*HL; V[o+1]=cy+ry*sx*HW+fy*sl*HL; V[o+2]=cz+rz*sx*HW+fz*sl*HL; V[o+3]=u; V[o+4]=v; };
  set(-1,-1,0,0,0); set(1,-1,1,0,5); set(-1,1,0,1,10); set(1,1,1,1,15);
  gl.useProgram(progShadow);
  gl.uniformMatrix4fv(shadLoc.mvp, false, mvp); gl.uniform1f(shadLoc.str, 0.5);
  gl.bindBuffer(gl.ARRAY_BUFFER, shadBuf); gl.bufferData(gl.ARRAY_BUFFER, V, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(shadLoc.pos); gl.vertexAttribPointer(shadLoc.pos, 3, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(shadLoc.uv); gl.vertexAttribPointer(shadLoc.uv, 2, gl.FLOAT, false, 20, 12);
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.depthMask(true); gl.disable(gl.BLEND);
}

// car/driver/wheel render + pose functions → carrender.js (loaded before the main script)

function makeFallbackTexture(rgb) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                new Uint8Array([rgb[0], rgb[1], rgb[2], 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return t;
}
function isPOT(x) { return (x & (x - 1)) === 0; }
function uploadImageTexture(bitmap) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  let src = bitmap;
  if (!isGL2 && (!isPOT(bitmap.width) || !isPOT(bitmap.height))) {
    // WebGL1: repeat-wrap needs power-of-two — resample via canvas.
    // GL2 handles NPOT + REPEAT + mips natively, keeping full fidelity.
    const cw = 1 << Math.round(Math.log2(bitmap.width));
    const ch = 1 << Math.round(Math.log2(bitmap.height));
    const cnv = document.createElement("canvas");
    cnv.width = Math.max(1, cw); cnv.height = Math.max(1, ch);
    cnv.getContext("2d").drawImage(bitmap, 0, 0, cnv.width, cnv.height);
    src = cnv;
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  return t;
}

// Cars lighting and shadowing each other. Both were single-car assumptions: the shader
// carries one car's worth of lamps, and the car pass disabled shadow sampling outright to
// dodge self-shadow acne. The acne guard is now a normal-offset plus a metric bias (see
// the shadow work of 2026-07-25), so receiving shadows is worth having — set CAR_SHADOWS
// to 0 if acne ever returns on the bodywork.
let CAR_LIGHTS_ON = 1;
let CAR_SHADOWS = 1;
/* Track lights — the lamps the track author placed, from CSP's LIGHT_SERIES config.
 * A track can declare hundreds (nordic 207, thunderhead 156) and the shader carries
 * MAX_TLIGHTS slots, so the nearest are chosen each frame.
 *
 * The old note here read "12 is enough that the handful lighting the car are always
 * present" — true only for a camera sitting on the car. From any wider view the budget is
 * the number of a circuit's pools that can be lit AT ONCE, and below the lamp count the
 * chosen set changes with the camera: lamps come on as you approach and go off behind you.
 * That is the whole of the "not all lights render, and going to the dark ones turns others
 * off" symptom. See the sizing note in glcore.js. */
let TRACK_LIGHTS_ON = 1;
/* Tree policy — the CSP change the keeper already makes by hand in Assetto, where sakura is
 * unplayable on a modest PC and stripping tree lighting and shadows is the fix.
 *
 *   0 full · 1 no shadows · 2 unlit
 *
 * Measured on sakura_speedway (test_trackcost.js): 831,096 foliage triangles of 3,132,796
 * — 26.5% of the track — against 76k of trunk. At mode 1 those leave the near depth cascade
 * (drawn EVERY frame), the far cascade (re-baked on every movement of the time slider) and
 * the headlight-beam pass. At mode 2 they also stop receiving shadows and lamps.
 *
 * This is not only a speed knob. A leaf-sized caster in a cascade sized for a whole circuit
 * aliases into noise, so the shadows it buys are bad shadows — which is why the track looks
 * wrong as well as running badly. Trunks keep casting, so the trees stay grounded. */
/* THE ENVIRONMENT REMASTER — instanced trees replacing a track's authored canopy.
 * treeSys is NOT a group and never enters sceneGroups (the two-constructor lesson).
 * Suppression is draw-list-side only, so extractScene output — and the goldens — are
 * untouched by construction. */
let treeSys = null;
let REMASTER_ON = true;
try { REMASTER_ON = localStorage.getItem("bb_remaster") !== "off"; } catch (_) {}
const treeHidden = (g) => REMASTER_ON && !!treeSys && g.remastered;
let SHADOW_NIGHT_SOFT = 5;   // extra PCF spread at full night — see pcfSoft in glcore.js
/* FOLIAGE DISTANCE DISSOLVE — the "too many trees" lever, sized by measurement.
 *
 * Sakura's trees are authored as a few enormous alpha-tested cards per tree (80–117 m² per
 * triangle, measured), so a corridor pixel sits under median 36 / p95 78 canopy layers and
 * over half of a sightline's crossings are beyond 200 m — distant layers that cost full
 * fill and read as undifferentiated pink haze. Between START and END the alpha threshold
 * rises toward 0.95, discarding progressively more of each card (the tree visibly thins
 * rather than popping); past END the chunk is skipped outright, which also relieves vertex
 * and raster load. Near trees are untouched. Applies to foliage groups only, so tracks
 * without foliage (t180, centrifuge) are unaffected by construction — the goldens hold.
 * END = 0 disables the whole mechanism. */
let FOLIAGE_FADE_START = 400;
let FOLIAGE_FADE_END = 800;
let TREE_MODE = 0;
/* Flat-colour every material, to identify geometry on screen instead of inferring it from
 * an offline profile. Four attempts at centrifuge's dome panels were spent guessing which
 * material a shape belonged to. Key: K. */
let MAT_DEBUG = 0;
const MAT_PALETTE = [[1,0.25,0.25],[0.3,1,0.35],[0.35,0.55,1],[1,0.9,0.25],[1,0.4,1],[0.3,1,1],[1,0.6,0.2],[0.7,0.4,1],[0.6,1,0.6],[1,1,1]];
let matLegend = "";
/* CSP's COLOR intensities are photometric-ish and span a huge range — Miandros declares
 * 28.76 on its stadium floodlights, sakura 10 to 20, the T-180 test track 3. Fed straight
 * into a forward renderer with a range-normalised falloff, 28 is a white blob rather than a
 * lamp; there is no honest conversion between CSP's units and ours, so this stays an
 * explicit gain set by eye rather than a pretence at a formula.
 *
 * It is TWO numbers because one cannot do the job. A gain low enough to tame 28.76 leaves a
 * 3.0 lamp contributing almost nothing, which is how a night track ends up dark everywhere
 * a floodlight is not. So the outlier is clamped first and the gain is then set for the
 * common case — the clamp costs Miandros some of its declared punch, and that is the right
 * trade against every other track being unlit. */
let TRACK_LIGHT_MAX_INTENSITY = 6;
let TRACK_LIGHT_GAIN = 0.5;
/* Same honesty as above, for the two material terms read out of the kn5.
 *
 * EMISSIVE. Authors write ksEmissive well past 1 — aurora's road strips are 3.0, one of its
 * batches 4.0 — because AC tonemaps and we do not (the HDR pass is off by decision). At 1:1
 * a 3.0 strip clips to flat white and loses the colour that makes it read as a light rather
 * than a hole in the geometry. This keeps them bright and still coloured.
 *
 * SPECULAR. ksSpecular has a sane 0-1 range already and needs no rescaling in principle;
 * what it needs is restraint, because our key light has no roughness model behind it and a
 * full-strength highlight on every road panel reads as wet, not glossy. Both are dials to
 * be set by eye, and both are the first thing to reach for if a track looks overcooked. */
let TRACK_EMISSIVE_GAIN = 0.6;
let TRACK_SPEC_GAIN = 0.5;
const MAX_TLIGHTS = 64;   // must match MAXTLIGHTS in glcore.js — see the sizing note there
/* Bounds of the WHOLE scene, from the chunk AABBs — as opposed to `trackAABB`, which is the
 * road surface only. The difference is the point: a caster does not have to be near the
 * tarmac. Centrifuge's is a dome enclosing the entire circuit, 1191 m of vertical. */
let sceneAABB = null;          // {x0,y0,z0,x1,y1,z1} or null
let trackLights = [];          // every resolved lamp, world space
let lampsBaked = false;        // night lamps live in the vertex buffers, not the light loop
/* What the last setTrackLights / setShadow actually put on the GPU. The lit loop overrides
 * both per group for unlit foliage and must restore the real values for the next group,
 * which means something has to remember them. */
let _tlN = 0, _shadowBase = 0;
const _tlPos = new Float32Array(MAX_TLIGHTS * 3);
const _tlCol = new Float32Array(MAX_TLIGHTS * 3);
const _tlDir = new Float32Array(MAX_TLIGHTS * 3);
const _tlArg = new Float32Array(MAX_TLIGHTS * 2);
const CAR_LIGHT_RANGE = 40;   // metres; past this another car's lamps do nothing visible

/* ===================== time-of-day lighting =====================
 * One `timeOfDay` (hours, 0..24) drives a single key light that arcs across the sky and
 * crossfades sun→moon, plus the atmosphere (sky/ground ambient + fog colour). Keyframed
 * at midnight / dawn / noon / dusk and interpolated. The sun/moon is one continuous light:
 * the moon is just "the sun, low, cool and dim". Feeds progT's uSun and uAmb uniforms
 * plus the clear/fog colour. Default is night (his hotlaps). Shadows come next. */
let timeOfDay = 1.0;   // 24h clock; 1:00 = deep night
const LIGHT_KEYS = [
  // t   dir (toward light, unnormalised)  key colour+intensity   ambSky            ambGround         fog/sky
  { t: 0,  dir: [0.25, 0.72, 0.34], sun: [0.22, 0.28, 0.44], ambSky: [0.022, 0.032, 0.07], ambGround: [0.008, 0.012, 0.026], fog: [0.012, 0.02, 0.05] },
  { t: 6,  dir: [0.92, 0.20, 0.34], sun: [1.00, 0.60, 0.40], ambSky: [0.36, 0.35, 0.44], ambGround: [0.16, 0.12, 0.12], fog: [0.52, 0.40, 0.42] },
  { t: 12, dir: [0.18, 0.95, 0.20], sun: [1.00, 0.97, 0.90], ambSky: [0.50, 0.60, 0.75], ambGround: [0.28, 0.28, 0.26], fog: [0.55, 0.63, 0.74] },
  { t: 18, dir: [-0.92, 0.20, 0.34], sun: [1.00, 0.48, 0.28], ambSky: [0.42, 0.32, 0.44], ambGround: [0.18, 0.12, 0.14], fog: [0.52, 0.32, 0.32] },
  { t: 24, dir: [0.25, 0.72, 0.34], sun: [0.22, 0.28, 0.44], ambSky: [0.022, 0.032, 0.07], ambGround: [0.008, 0.012, 0.026], fog: [0.012, 0.02, 0.05] },
];
function lightingFor(t) {
  t = ((t % 24) + 24) % 24;
  let i = 0; while (i < LIGHT_KEYS.length - 1 && LIGHT_KEYS[i + 1].t <= t) i++;
  const a = LIGHT_KEYS[i], b = LIGHT_KEYS[Math.min(i + 1, LIGHT_KEYS.length - 1)];
  const f = Math.max(0, Math.min(1, (t - a.t) / ((b.t - a.t) || 1)));
  const lp = (u, v) => [u[0] + (v[0] - u[0]) * f, u[1] + (v[1] - u[1]) * f, u[2] + (v[2] - u[2]) * f];
  const d = lp(a.dir, b.dir), dl = Math.hypot(d[0], d[1], d[2]) || 1;
  return { dir: [d[0]/dl, d[1]/dl, d[2]/dl], sun: lp(a.sun, b.sun), ambSky: lp(a.ambSky, b.ambSky), ambGround: lp(a.ambGround, b.ambGround), fog: lp(a.fog, b.fog) };
}
/* Upload the nearest track lights for this frame.
 *
 * Night-gated lamps are scaled by nightF here rather than in the shader, so a daytime lap
 * costs nothing: they scale to zero, get skipped by the intensity test, and the slots go
 * to lamps that are actually on. `eye` is the camera, not the car — you light what is on
 * screen, and a chase cam can be a long way from the car it follows. */
function setTrackLights(eye, nightF, vp, skipNight) {
  let n = 0;
  if (TRACK_LIGHTS_ON && trackLights.length && window.TrackLights) {
    /* Frustum first, budget second, and the order is the point. The frustum pass is EXACT —
     * a lamp whose range-sphere misses the view cannot light a visible fragment — so every
     * lamp it removes frees a slot for one that can actually be seen. Doing it the other way
     * round would spend slots on lamps behind the camera. `vp` is optional: without it the
     * behaviour is exactly what it was before. */
    const visible = vp ? TrackLights.cullToFrustum(trackLights, frustumPlanes(vp)) : trackLights;
    const near = TrackLights.cullLights(visible, eye, MAX_TLIGHTS);
    for (const L of near) {
      if (skipNight && L.night) continue;   // already in the vertex bake
      const gate = L.night ? nightF : 1;
      // CLAMP, then gain. A single gain cannot serve a library whose declared intensities
      // span 3 to 28.76: tuned so Miandros's floodlights do not blow out, 0.16 left every
      // ordinary track — the T-180 test track's own lamps are 3.0 — barely lit at all,
      // which is what "everything is dark" was. Clamping the outlier first lets the gain
      // be set for the common case instead of against the extreme.
      const amp = Math.min(L.intensity, TRACK_LIGHT_MAX_INTENSITY) * gate * TRACK_LIGHT_GAIN;
      if (amp <= 0.002) continue;               // a lamp that is off costs no slot
      _tlPos[n*3] = L.pos[0]; _tlPos[n*3+1] = L.pos[1]; _tlPos[n*3+2] = L.pos[2];
      _tlCol[n*3] = L.color[0]*amp; _tlCol[n*3+1] = L.color[1]*amp; _tlCol[n*3+2] = L.color[2]*amp;
      const d = L.dir, dl = Math.hypot(d[0], d[1], d[2]) || 1;
      _tlDir[n*3] = d[0]/dl; _tlDir[n*3+1] = d[1]/dl; _tlDir[n*3+2] = d[2]/dl;
      // SPOT is the cone's FULL angle in degrees; the shader wants cos(half). A point
      // light is flagged -1 so the cone test is skipped entirely. spotUsable is false for
      // a lamp declared DIRECTION = NORMAL, whose true aim we cannot know — pointing it
      // somewhere confident and wrong is worse than lighting in all directions.
      _tlArg[n*2] = L.range;
      /* SPOT is the cone's FULL angle and this halves it, so the clamp belongs at 359, not
       * 179. Clamping the full angle to 179 capped every cone at a 89.5 deg half-angle —
       * the T-180 test track declares SPOT = 250, a deliberately wide 125 deg downward
       * wash, and it was being rendered as a narrow one. Anything at or above 359 is a
       * point light and never reaches here; spotUsable has already sent it down the -1
       * path, which skips the cone test in the shader entirely. */
      _tlArg[n*2+1] = L.spotUsable ? Math.cos(Math.min(359, L.spot) * 0.5 * Math.PI / 180) : -1;
      if (++n >= MAX_TLIGHTS) break;
    }
  }
  for (let i = n; i < MAX_TLIGHTS; i++) { _tlCol[i*3] = _tlCol[i*3+1] = _tlCol[i*3+2] = 0; }
  gl.uniform3fv(tLoc.tLightPos, _tlPos);
  gl.uniform3fv(tLoc.tLightCol, _tlCol);
  gl.uniform3fv(tLoc.tLightDir, _tlDir);
  gl.uniform2fv(tLoc.tLightArg, _tlArg);
  gl.uniform1i(tLoc.tLightN, n);
  // remembered so a per-group override (unlit foliage) can switch lamps off for one draw
  // and put the real count back for the next, without recomputing the upload
  _tlN = n;
}

// the car-lamp upload buffers, hoisted out of setCarLamps — see the note at its top
const _clp = {
  hp: new Float32Array(8 * 3), ha: new Float32Array(4 * 3), hi: new Float32Array(4),
  bp: new Float32Array(8 * 3), ba: new Float32Array(4 * 3), bi: new Float32Array(4),
};

function setSceneLighting(L) {   // push the lit-scene program's light + atmosphere uniforms
  gl.uniform3f(tLoc.fogC, L.fog[0], L.fog[1], L.fog[2]);
  gl.uniform3f(tLoc.sun, L.dir[0], L.dir[1], L.dir[2]);
  gl.uniform3f(tLoc.sunCol, L.sun[0], L.sun[1], L.sun[2]);
  gl.uniform3f(tLoc.ambSky, L.ambSky[0], L.ambSky[1], L.ambSky[2]);
  gl.uniform3f(tLoc.ambGround, L.ambGround[0], L.ambGround[1], L.ambGround[2]);
}
/* Push EVERY car's lamps to the lit-scene program at once.
 *
 * This replaced a pair of one-car setters, and the reason is the bug they caused: with a
 * single set of lamp uniforms, a car could only be lit by one other car, so on a track
 * with three ghosts some pairs lit each other and some didn't, with no pattern the eye
 * could read. The shader now carries an array of up to MAXCARS, and every car is lit by
 * every other one.
 *
 * `skip` is the index of the car being drawn, because a car must never be lit by its own
 * lamps — the cones pool on its own livery. Pass -1 for the track, which every car lights.
 *
 * `cars` is [{ mat, headInt, brakeInt }]; the lamp housings come from carLights, which is
 * one model shared by every car (they are all the same car for now).
 */
function setCarLamps(cars, headVP, skip) {
  const N = Math.min(cars.length, 4);
  /* Reused, following the same pattern as _tlPos/_tlCol/_tlDir/_tlArg above — six fresh
   * typed arrays per call, six calls per frame, was ~1 KB of garbage a frame for nothing.
   *
   * THE ZEROING IS LOAD-BEARING, and it is why `new` looked correct here. A fresh
   * Float32Array is zero-filled, and the loop below only writes slots for cars that clear
   * the intensity threshold — the shader reads all four regardless. Reuse without clearing
   * leaves the previous frame's lamps lit on cars that no longer have any, which would
   * appear as a ghost's headlights hanging in the air after it stopped emitting. */
  _clp.hp.fill(0); _clp.ha.fill(0); _clp.hi.fill(0);
  _clp.bp.fill(0); _clp.ba.fill(0); _clp.bi.fill(0);
  const hp = _clp.hp, ha = _clp.ha, hi = _clp.hi;
  const bp = _clp.bp, ba = _clp.ba, bi = _clp.bi;
  let n = 0;
  const haveHead = carLights && carLights.head && carLights.head.length >= 2;
  const haveBrake = carLights && carLights.brake && carLights.brake.length >= 2;
  for (let c = 0; c < N; c++) {
    if (c === skip) continue;                     // never lit by yourself
    const car = cars[c], m = car.mat;
    if (!m) continue;
    if (haveHead && car.headInt > 0.001) {
      const A = mXfPt(carLights.head[0], m), B = mXfPt(carLights.head[1], m);
      let dx = m[8] + m[4] * 0.06, dy = m[9] + m[5] * 0.06, dz = m[10] + m[6] * 0.06;  // aim slightly UP
      const dl = Math.hypot(dx, dy, dz) || 1;
      hp.set(A, n * 6); hp.set(B, n * 6 + 3);
      ha.set([dx / dl, dy / dl, dz / dl], n * 3);
      hi[n] = car.headInt;
    }
    if (haveBrake && car.brakeInt > 0.001) {
      const A = mXfPt(carLights.brake[0], m), B = mXfPt(carLights.brake[1], m);
      let dx = -m[8], dy = -m[9], dz = -m[10];    // backward = −nose
      const dl = Math.hypot(dx, dy, dz) || 1;
      bp.set(A, n * 6); bp.set(B, n * 6 + 3);
      ba.set([dx / dl, dy / dl, dz / dl], n * 3);
      bi[n] = car.brakeInt;
    }
    n++;
  }
  gl.uniform3fv(tLoc.headPos, hp); gl.uniform3fv(tLoc.headAim, ha); gl.uniform1fv(tLoc.headInt, hi);
  gl.uniform3fv(tLoc.brakePos, bp); gl.uniform3fv(tLoc.brakeAim, ba); gl.uniform1fv(tLoc.brakeInt, bi);
  gl.uniform1i(tLoc.carN, n);
  // Beam occlusion has ONE depth map, baked for the reference car, so it is applied to
  // slot 0 only (the shader does this). Skipping the reference car means slot 0 is
  // somebody else's lamp, and their beam must not be occluded by another car's map.
  if (headVP && headReady && skip !== 0) {
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, headDepthTex);
    gl.uniform1i(tLoc.headDepth, 2); gl.uniformMatrix4fv(tLoc.headVP, false, headVP);
    gl.uniform1f(tLoc.headOccOn, 1); gl.activeTexture(gl.TEXTURE0);
  } else gl.uniform1f(tLoc.headOccOn, 0);
}
