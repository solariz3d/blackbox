/* smokesim.js — tyre marks, the baked noise/curl assets, the air-velocity field and the fixed-rate smoke sim.
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

/* tyre marks + smoke — both fed by the same recorded-slip signal (carrender.js).
 * TYRE_MODE: 0 = off, 1 = reset each lap (default), 2 = accumulate + slow fade. */
let TYRE_MODE = 1;
let markVBO = null, markCount = 0;                    // prebuilt skid-mark ribbon (per loaded car)
const MARK_COLOR = [0.02, 0.02, 0.025], MARK_ALPHA = 0.55;
/* How long accumulated rubber takes to fade in mode 2, in SECONDS of replay time.
 *
 * This was 900 *frames*, and the frames in question are the REPLAY's, not the display's —
 * `curFrame` arrives as `tCur / ex.dt`, so refresh rate never entered into it and the
 * display-Hz bug this looked like it belonged to was never here. What is real is narrower:
 * `ex.dt` comes from the replay file's own `intervalMs`, so it varies between recordings, and
 * a frame count means a different duration in each. Two cars from replays recorded at
 * different rates faded at different speeds in the same scene.
 *
 * 13.5 s is 900 frames at the 15 ms interval both sample replays carry (66.67 Hz), so the
 * tuned look is preserved exactly for those and only mixed-rate scenes change. */
const MARK_FADE_SECONDS = 13.5;
const smoke = { pool: [], cap: 420, vbo: null, arr: null,
  noiseTex: null, curl: null, accum: new Float32Array(4) };   // baked noise, curl field, per-wheel slide build-up
const SMOKE_MERGE_LO = 0.10, SMOKE_MERGE_HI = 0.65;    // summed-density ramp: fuses overlapping puffs into one field
let SMOKE_ERODE = 0.6;                                  // composite noise erosion: frays the merged field into wisps
let SMOKE_COLLIDE = true;                              // per-frame smoke↔track collision (uses the fine smokeColl grid)
let smokePrevT = null;                                 // last playback time (for emission gating + scrub detect)
/* The particle/air simulation runs at a FIXED rate, not the render rate — see the note in
 * smokeStepAndDraw. 60 Hz because that is where this sim was tuned by eye; the step size is
 * what the physics was balanced against, so changing it changes the look, not just the cost. */
const SIM_STEP = 1 / 60;
const SIM_MAX_CATCHUP = 4;
let simAccum = 0;
const CURL_G = 24, CURL_FREQ = 0.35, CURL_STR = 1.7;   // curl velocity grid (now a turbulence overlay only)
const SMOKE_WIND = [0.25, 0, 0.10];                    // gentle ambient drift (world x,z)
// sparse "air" velocity field — the shared medium cars stir and smoke rides. Cells exist
// ONLY near cars/smoke (a tube along the track, not the whole map). See docs/SMOKE_PHYSICS.md.
const AIR = { H: 1.5, inv: 1 / 1.5, cells: new Map() };  // cell size (m); Map<packedKey,{vx,vy,vz,ttl}>
const AIR_TAU = 0.6, AIR_TTL = 1.2;                    // velocity dissipation τ (s); cell lifetime after last inject (s)
// Injection is mostly SWIRL (rotates in place → smoke stays put and trails behind) with
// almost no forward drag (drag would carry the smoke along with the car — no trail).
const WHEEL_DRAG_K = 0.04, WHEEL_SWIRL_K = 0.15, BODY_WAKE_K = 0.0, AIR_TURB = 0.35;  // wake off (0) — it only matters for shredding OTHER cars' smoke; with one car it disturbs its own trail
const SLIDE_GAIN = 3.0, SLIDE_TAU = 0.5, SLIDE_MAX = 2.5;   // per-wheel slide accumulator: grow / decay-τ / cap

// ---- smoke assets: baked domain-warped noise texture + curl velocity field --------
// Built once (CPU), no external files. The noise gives each billboard internal wispy
// structure; the curl field gives organic divergence-free swirl motion (Bridson 2007).
function _h2(ix, iy, P) { ix = ((ix % P) + P) % P; iy = ((iy % P) + P) % P; const n = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453; return n - Math.floor(n); }
function _vn2(x, y, P) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = _h2(xi, yi, P), b = _h2(xi + 1, yi, P), c = _h2(xi, yi + 1, P), d = _h2(xi + 1, yi + 1, P);
  const p = a + (b - a) * u; return p + ((c + (d - c) * u) - p) * v;
}
function _fbm2(x, y) { let t = 0, amp = 0.5, fr = 4; for (let o = 0; o < 3; o++) { t += amp * _vn2(x * fr, y * fr, fr); fr *= 2; amp *= 0.5; } return t; }
function _warp2(x, y) { const qx = _fbm2(x, y), qy = _fbm2(x + 0.53, y + 0.13); return _fbm2(x + 0.8 * qx, y + 0.8 * qy); }   // domain warp → turbulence
function bakeSmokeNoise() {
  const S = 256, data = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) data[y * S + x] = Math.max(0, Math.min(255, Math.round(_warp2(x / S, y / S) * 255)));
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, S, S, 0, gl.RED, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  smoke.noiseTex = tex;
}
function _h3(ix, iy, iz) { const n = Math.sin(ix * 127.1 + iy * 311.7 + iz * 74.7) * 43758.5453; return n - Math.floor(n); }
function _vn3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const c = (dx, dy, dz) => _h3(xi + dx, yi + dy, zi + dz);
  const x00 = c(0,0,0)+(c(1,0,0)-c(0,0,0))*u, x10 = c(0,1,0)+(c(1,1,0)-c(0,1,0))*u,
        x01 = c(0,0,1)+(c(1,0,1)-c(0,0,1))*u, x11 = c(0,1,1)+(c(1,1,1)-c(0,1,1))*u;
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}
function bakeCurl() {
  const G = CURL_G, e = 0.01, inv = 1 / (2 * e), field = new Float32Array(G * G * G * 3);
  const psi = (x, y, z, s) => _vn3(x + s * 17.3, y + s * 7.1, z + s * 23.9);   // 3 independent potentials
  for (let zi = 0; zi < G; zi++) for (let yi = 0; yi < G; yi++) for (let xi = 0; xi < G; xi++) {
    const x = xi / G * 4, y = yi / G * 4, z = zi / G * 4;
    const vx = ((psi(x,y+e,z,2) - psi(x,y-e,z,2)) - (psi(x,y,z+e,1) - psi(x,y,z-e,1))) * inv;
    const vy = ((psi(x,y,z+e,0) - psi(x,y,z-e,0)) - (psi(x+e,y,z,2) - psi(x-e,y,z,2))) * inv;
    const vz = ((psi(x+e,y,z,1) - psi(x-e,y,z,1)) - (psi(x,y+e,z,0) - psi(x,y-e,z,0))) * inv;
    const idx = (zi * G * G + yi * G + xi) * 3; field[idx] = vx; field[idx + 1] = vy; field[idx + 2] = vz;
  }
  smoke.curl = field;
}
function sampleCurl(wx, wy, wz) {
  const G = CURL_G, f = smoke.curl; if (!f) return [0, 0, 0];
  let gx = (((wx * CURL_FREQ) % G) + G) % G, gy = (((wy * CURL_FREQ) % G) + G) % G, gz = (((wz * CURL_FREQ) % G) + G) % G;
  const x0 = Math.floor(gx), y0 = Math.floor(gy), z0 = Math.floor(gz), xf = gx - x0, yf = gy - y0, zf = gz - z0;
  const x1 = (x0 + 1) % G, y1 = (y0 + 1) % G, z1 = (z0 + 1) % G;
  const at = (xi, yi, zi, c) => f[(zi * G * G + yi * G + xi) * 3 + c];
  const L = (a, b, t) => a + (b - a) * t, out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = L(L(at(x0,y0,z0,c), at(x1,y0,z0,c), xf), L(at(x0,y1,z0,c), at(x1,y1,z0,c), xf), yf);
    const b = L(L(at(x0,y0,z1,c), at(x1,y0,z1,c), xf), L(at(x0,y1,z1,c), at(x1,y1,z1,c), xf), yf);
    out[c] = L(a, b, zf);
  }
  return out;
}
function ensureSmokeAssets() { if (!smoke.noiseTex) bakeSmokeNoise(); if (!smoke.curl) bakeCurl(); }

// ---- sparse air-velocity field: the shared medium cars stir and smoke rides -------
// Cells are a fixed world lattice but stored sparsely (only where cars/smoke are), so we
// simulate a tube of air along the track, never the whole map. All cars inject into the
// SAME field, so smoke from one run is pushed by another car/run driving through it.
function airKey(cx, cy, cz) { return ((cx + 4096) * 8192 + (cy + 4096)) * 8192 + (cz + 4096); }
function airAdd(cx, cy, cz, vx, vy, vz) {
  const k = airKey(cx, cy, cz); let c = AIR.cells.get(k);
  if (!c) { c = { vx: 0, vy: 0, vz: 0, ttl: 0 }; AIR.cells.set(k, c); }
  c.vx += vx; c.vy += vy; c.vz += vz; c.ttl = AIR_TTL;
}
function sampleAir(x, y, z) {                            // trilinear; missing cells = still air (0)
  const A = AIR, gx = x * A.inv - 0.5, gy = y * A.inv - 0.5, gz = z * A.inv - 0.5;
  const x0 = Math.floor(gx), y0 = Math.floor(gy), z0 = Math.floor(gz);
  const fx = gx - x0, fy = gy - y0, fz = gz - z0;
  let vx = 0, vy = 0, vz = 0;
  for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    const c = A.cells.get(airKey(x0 + dx, y0 + dy, z0 + dz)); if (!c) continue;
    const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    vx += c.vx * w; vy += c.vy * w; vz += c.vz * w;
  }
  return [vx, vy, vz];
}
// a wheel stirs the air: drag along its travel + a vertical-axis swirl (vortex) around it
function injectWheel(pos, up, dir, wSpd) {
  const A = AIR, H = A.H, R = 2, rad = R * H, s = Math.min(wSpd, 25);
  const drag = s * WHEEL_DRAG_K, swirl = s * WHEEL_SWIRL_K;
  const cx0 = Math.floor(pos[0] * A.inv), cy0 = Math.floor(pos[1] * A.inv), cz0 = Math.floor(pos[2] * A.inv);
  for (let dz = -R; dz <= R; dz++) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const cxx = cx0 + dx, cyy = cy0 + dy, czz = cz0 + dz;
    const ox = (cxx + 0.5) * H - pos[0], oy = (cyy + 0.5) * H - pos[1], oz = (czz + 0.5) * H - pos[2];
    const dist = Math.hypot(ox, oy, oz); if (dist > rad) continue;
    const w = 1 - dist / rad;
    let tx = oz, tz = -ox; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;   // swirl around world-up (horizontal)
    airAdd(cxx, cyy, czz, (dir[0]*drag + tx*swirl) * w, 0, (dir[2]*drag + tz*swirl) * w);  // horizontal only — never into the ground
  }
}
// the car body drags a wake along its heading — this is what shreds another car's smoke
function injectWake(pos, dir, spd, up) {
  const A = AIR, H = A.H, R = 3, rad = R * H, push = Math.min(spd, 40) * BODY_WAKE_K;
  const cx0 = Math.floor(pos[0] * A.inv), cy0 = Math.floor(pos[1] * A.inv), cz0 = Math.floor(pos[2] * A.inv);
  for (let dz = -R; dz <= R; dz++) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const cxx = cx0 + dx, cyy = cy0 + dy, czz = cz0 + dz;
    const ox = (cxx + 0.5) * H - pos[0], oy = (cyy + 0.5) * H - pos[1], oz = (czz + 0.5) * H - pos[2];
    const dist = Math.hypot(ox, oy, oz); if (dist > rad) continue;
    const w = 1 - dist / rad;
    airAdd(cxx, cyy, czz, dir[0]*push*w, 0, dir[2]*push*w);        // wake runs horizontally, never into the ground
  }
}
// one field tick: dissipate + evict, then inject the current car (car-agnostic — call once
// per active car; one today, N when multiple replays run).
function airStep(dt, i, fp) {
  const cells = AIR.cells, decay = Math.exp(-dt / AIR_TAU);
  for (const [k, c] of cells) { c.vx *= decay; c.vy *= decay; c.vz *= decay; c.ttl -= dt; if (c.ttl <= 0) cells.delete(k); }
  if (!ex.wheelsOk[i]) return;
  let ux = ex.nrm[i*3], uy = ex.nrm[i*3+1], uz = ex.nrm[i*3+2]; const un = Math.hypot(ux, uy, uz) || 1;
  const up = [ux/un, uy/un, uz/un];
  const cs = [];
  for (let k = 0; k < 4; k++) {
    const cur = wheelWorldAt(fp, k), prev = wheelWorldAt(Math.max(0, fp - 1), k); cs.push(cur);
    if (!cur || !prev) continue;
    let tx = cur[0]-prev[0], ty = cur[1]-prev[1], tz = cur[2]-prev[2]; const tl = Math.hypot(tx, ty, tz) || 1e-6;
    injectWheel(cur, up, [tx/tl, ty/tl, tz/tl], tl / ex.dt);
  }
  if (BODY_WAKE_K > 0 && cs[0] && cs[1] && cs[2] && cs[3]) {  // body wake (off until multiple cars exist)
    const cen = [(cs[0][0]+cs[1][0]+cs[2][0]+cs[3][0])/4, (cs[0][1]+cs[1][1]+cs[2][1]+cs[3][1])/4 + 0.4, (cs[0][2]+cs[1][2]+cs[2][2]+cs[3][2])/4];
    let hx = ex.fwd[i*3], hy = ex.fwd[i*3+1], hz = ex.fwd[i*3+2]; const hl = Math.hypot(hx, hy, hz);
    if (hl > 1e-6) injectWake(cen, [hx/hl, hy/hl, hz/hl], (ex.speed[i] || 0) / 3.6, up);
  }
}

// draw the prebuilt skid-mark ribbon, revealed up to curFrame (fractional). Blends
// dark onto the track; doesn't write depth (it's a decal sitting just off the surface).
function drawTireMarks(mvp, L, fogD, curFrame, curLap, vbo, count, dt) {
  // vbo/count default to the reference car's ribbon; each ghost passes its own, built from
  // its own recorded slip. The fade is relative to THAT car's current frame — a ghost's
  // rubber on the reference car's timeline would put skid marks in corners nobody had
  // reached yet.
  vbo = vbo || markVBO;
  count = (count === undefined) ? markCount : count;
  if (TYRE_MODE === 0 || !count) return;
  gl.useProgram(progMark);
  gl.uniformMatrix4fv(markLoc.mvp, false, mvp);
  gl.uniform1f(markLoc.curFrame, curFrame);
  gl.uniform1f(markLoc.curLap, curLap);
  gl.uniform1f(markLoc.mode, TYRE_MODE === 2 ? 1 : 0);   // 0 = reset each lap, 1 = accumulate + fade
  // in THIS car's frames — curFrame is its own timeline, so the fade window has to be too
  const carDt = (dt === undefined ? (typeof ex !== "undefined" && ex ? ex.dt : 0.015) : dt) || 0.015;
  gl.uniform1f(markLoc.fade, MARK_FADE_SECONDS / carDt);
  gl.uniform1f(markLoc.markAlpha, MARK_ALPHA);
  gl.uniform3fv(markLoc.markColor, MARK_COLOR);
  gl.uniform3f(markLoc.fogC, L.fog[0], L.fog[1], L.fog[2]);
  gl.uniform1f(markLoc.fogD, fogD);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.enableVertexAttribArray(markLoc.pos);   gl.vertexAttribPointer(markLoc.pos, 3, gl.FLOAT, false, 32, 0);
  gl.enableVertexAttribArray(markLoc.frame); gl.vertexAttribPointer(markLoc.frame, 1, gl.FLOAT, false, 32, 12);
  gl.enableVertexAttribArray(markLoc.lap);   gl.vertexAttribPointer(markLoc.lap, 1, gl.FLOAT, false, 32, 16);
  gl.enableVertexAttribArray(markLoc.inten); gl.vertexAttribPointer(markLoc.inten, 1, gl.FLOAT, false, 32, 20);
  gl.enableVertexAttribArray(markLoc.cross); gl.vertexAttribPointer(markLoc.cross, 1, gl.FLOAT, false, 32, 24);
  gl.enableVertexAttribArray(markLoc.run);   gl.vertexAttribPointer(markLoc.run, 1, gl.FLOAT, false, 32, 28);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false);
  gl.drawArrays(gl.TRIANGLES, 0, count);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.disableVertexAttribArray(markLoc.frame);
  gl.disableVertexAttribArray(markLoc.lap);
  gl.disableVertexAttribArray(markLoc.inten);
  gl.disableVertexAttribArray(markLoc.cross);
  gl.disableVertexAttribArray(markLoc.run);
}

// advance the smoke particle pool by playback-time dt and spawn from sliding wheels.
// Motion = curl-noise advection (organic swirl) + buoyancy + drag + gentle wind. Emission
// is driven by a per-wheel slide accumulator so smoke BUILDS UP the longer/harder a wheel
// slides. Two classes: rising "puffs" and long-lived ground-hugging "haze" (lingering trail).
/* NOTE for the ghost-smoke work (docs/GHOST_FIDELITY.md): the pool here is world-space and
 * SHARED, which is already correct — every car should stir one cloud, and it is why the
 * AIR field needed no change. What is per-car is only the EMISSION and the four-wheel
 * `accum`. So the split is smokeStep -> advance-once + emit-per-car, NOT calling this
 * whole function per car: that would age every particle and integrate the air N times, so
 * smoke would evaporate faster the more cars were on track. */
function smokeStep(dt, emit, i, nightF) {
  const P = smoke.pool, acc = smoke.accum, t = smokePrevT || 0;
  const collide = SMOKE_COLLIDE && smokeColl;                       // per-frame track collision (fine grid → cheap)
  for (let j = P.length - 1; j >= 0; j--) {
    const p = P[j]; p.age += dt;
    if (p.age >= p.life) { P[j] = P[P.length - 1]; P.pop(); continue; }
    const av = sampleAir(p.x, p.y, p.z);                            // shared air the cars stir (the physics)
    const cv = sampleCurl(p.x + t * 0.6, p.y, p.z);                 // small turbulence overlay for organic detail
    const tgx = av[0] + cv[0] * p.curl * AIR_TURB, tgz = av[2] + cv[2] * p.curl * AIR_TURB;
    p.vx += (tgx - p.vx) * p.relax * dt + SMOKE_WIND[0] * dt;
    p.vz += (tgz - p.vz) * p.relax * dt + SMOKE_WIND[2] * dt;
    p.vy = p.vy * (1 - p.drag * dt) + (av[1] + cv[1] * p.curl * AIR_TURB * 0.4 + p.buoy) * dt;
    p.vx *= (1 - p.drag * dt); p.vz *= (1 - p.drag * dt);
    const ox = p.x, oy = p.y, oz = p.z;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    // per-frame track collision against the fine collider: the segment test can't tunnel even
    // at speed, so smoke bends off any track/world geometry it crosses. Cheap (few tris/cell).
    if (collide) {
      // 1) movement crossing → bend off walls/banking/any surface it moves through
      const hit = collideSmokeSeg(smokeColl, ox, oy, oz, p.x, p.y, p.z);
      if (hit) {
        const tt = Math.max(0, hit.t - 0.03);
        p.x = ox + (p.x - ox) * tt; p.y = oy + (p.y - oy) * tt; p.z = oz + (p.z - oz) * tt;
        const vn = p.vx * hit.nx + p.vy * hit.ny + p.vz * hit.nz;   // slide along the surface (bend)
        p.vx -= hit.nx * vn; p.vy -= hit.ny * vn; p.vz -= hit.nz * vn;
      }
      // 2) per-frame FLOOR: cast down to the ACTUAL track surface under the particle now (not
      // its spawn plane) and keep it above — catches smoke that drifted over higher/banked
      // track or was born a hair below the shell (the "shit ton going through" case).
      const floor = collideSmokeSeg(smokeColl, p.x, p.y + 2.5, p.z, p.x, p.y - 1.5, p.z);
      if (floor) {
        const hy = (p.y + 2.5) - 4.0 * floor.t;                     // world Y of the surface below
        if (p.y < hy + 0.05) {
          p.y = hy + 0.05;
          const vn = p.vx * floor.nx + p.vy * floor.ny + p.vz * floor.nz;
          if (vn < 0) { p.vx -= floor.nx * vn; p.vy -= floor.ny * vn; p.vz -= floor.nz * vn; }
        }
      }
    } else {
      // no collider: fall back to the cheap spawn-plane floor
      const gd = (p.x - p.gx) * p.nx + (p.y - p.gy) * p.ny + (p.z - p.gz) * p.nz;
      if (gd < 0.02) {
        const c = 0.02 - gd;
        p.x += p.nx * c; p.y += p.ny * c; p.z += p.nz * c;
        const vn = p.vx * p.nx + p.vy * p.ny + p.vz * p.nz;
        if (vn < 0) { p.vx -= p.nx * vn; p.vy -= p.ny * vn; p.vz -= p.nz * vn; }
      }
    }
  }
  if (!emit || !ex.smokeSlip || !ex.wheelsOk[i]) {                   // decay accumulators even when idle
    for (let k = 0; k < 4; k++) acc[k] = Math.max(0, acc[k] - acc[k] * dt / SLIDE_TAU);
    return;
  }
  // real tyre smoke scales with slip SPEED, not just angle: a slow pit peel-out has a big
  // slip angle but little actual scrub, so gate the amount by speed. ~nothing under 30 km/h,
  // full by ~90 km/h. Keeps long high-speed drifts smoky, kills the low-speed cloud.
  const spd = ex.speed[i] || 0;
  // speed→smoke amount, calibrated to the T-180 (tops ~570 km/h): 100 km/h ≈ 4%,
  // 200 ≈ 50%, 400+ = full. Piecewise so the low-mid range barely smokes.
  const speedFac =
    spd <= 100 ? 0.10 * (spd / 100) :
    spd <= 200 ? 0.10 + 0.40 * (spd - 100) / 100 :
    spd <= 400 ? 0.50 + 0.50 * (spd - 200) / 200 : 1.0;
  const spinAmt = 0.8 + Math.min(spd / 3.6 / 20, 1.6);             // swirl grows with wheel momentum
  const fp = tCur / ex.dt;                                          // exact sub-frame playback position
  // surface normal (forced toward the sky — ex.nrm sign is unreliable), used to drop the
  // recorded wheel CENTRE down to the tyre CONTACT PATCH so smoke comes from the tyre exactly.
  let unx = ex.nrm[i*3], uny = ex.nrm[i*3+1], unz = ex.nrm[i*3+2]; const unl = Math.hypot(unx, uny, unz) || 1;
  unx /= unl; uny /= unl; unz /= unl; if (uny < 0) { unx = -unx; uny = -uny; unz = -unz; }
  if (!smoke.wheelR && carWheels) {                                // cache per-wheel radius (0:FL 1:FR 2:RL 3:RR)
    smoke.wheelR = [0.33, 0.33, 0.33, 0.33];
    for (const w of carWheels) smoke.wheelR[(/F$/i.test(w.corner) ? 0 : 2) + (/^L/i.test(w.corner) ? 0 : 1)] = w.radius || 0.33;
  }
  // only fill the wheel path travelled since the LAST rendered frame (not a whole replay
  // frame) so smoke is born AT the tyre, not smeared half a frame behind it.
  const fill = Math.min(1, dt / ex.dt);
  for (let k = 0; k < 4; k++) {
    const it = smokeIntensity(ex.smokeSlip[i * 4 + k]) * speedFac;  // speed-scaled slide intensity
    acc[k] = Math.min(SLIDE_MAX, Math.max(0, acc[k] + it * SLIDE_GAIN * dt - acc[k] * dt / SLIDE_TAU));
    const build = acc[k] / SLIDE_MAX;                                // 0..1 sustained-slide build-up
    const drive = Math.max(it, build * 0.6);
    if (drive <= 0.05) continue;
    const rearW = k >= 2 ? 1.0 : 0.22;                              // rear-drive: smoke mostly off the rears
    // spawn at the TRUE current wheel position (sub-frame) and spread along the wheel's
    // path this frame — so a fast car doesn't leave the smoke lagging a frame behind.
    const cur = wheelWorldAt(fp, k); if (!cur) continue;
    const prev = wheelWorldAt(Math.max(0, fp - 1), k) || cur;
    const rad = smoke.wheelR ? smoke.wheelR[k] : 0.33;
    // the wheel's world velocity — fresh smoke inherits it so it moves WITH the car briefly
    // (staying around the tyre, swirling up) before air-drag slows it and it trails off.
    const iex = 1 / ex.dt, INH = 0.62;
    const wvx = (cur[0] - prev[0]) * iex * INH, wvy = (cur[1] - prev[1]) * iex * INH, wvz = (cur[2] - prev[2]) * iex * INH;
    const rate = drive * 1.1 * dt * 60 * (0.9 + 0.4 * build) * rearW;  // sparse — one car's worth, not a pack
    let n = Math.floor(rate); if (Math.random() < rate - n) n++;
    for (let e = 0; e < n && P.length < smoke.cap; e++) {
      const t = 1 - Math.random() * fill;                          // front of the path → AT the tyre (contact patch)
      const bx = prev[0] + (cur[0] - prev[0]) * t - unx * rad, by = prev[1] + (cur[1] - prev[1]) * t - uny * rad, bz = prev[2] + (cur[2] - prev[2]) * t - unz * rad;
      const ang = Math.random() * 6.283, jr = Math.random() * 0.08; // tight to the tyre
      P.push({                                                       // puff: pools thick + low at the tyre, then wafts up
        x: bx + Math.cos(ang) * jr, y: by + 0.03, z: bz + Math.sin(ang) * jr,
        vx: wvx - Math.sin(ang) * spinAmt * 1.5 + Math.cos(ang) * 0.25,   // wheel velocity + tangential swirl (vortex)
        vy: wvy + 0.5 + Math.random() * 0.5, vz: wvz + Math.cos(ang) * spinAmt * 1.5 + Math.sin(ang) * 0.25,
        buoy: 3.0, drag: 0.7, curl: CURL_STR * 0.6, relax: 1.4,     // drag slows the inherited velocity → stays near the tyre, then rises
        age: 0, life: 2.8 + Math.random() * 1.8, size0: (0.38 + it * 0.7) * (1 + 0.5 * build),
        baseA: 0.13 + it * 0.18,                                    // thick at the wheels only when it's really sliding
        gx: bx, gy: by, gz: bz, nx: unx, ny: uny, nz: unz,         // spawn-surface plane (banking-aware floor)
        lx: bx, ly: by, lz: bz,                                     // last-collision-check position
      });
    }
    if (P.length < smoke.cap && Math.random() < (0.06 + 0.18 * build) * rearW) { // sparse lingering ground haze
      const t = 1 - Math.random() * fill;                          // front of the path → AT the tyre
      const bx = prev[0] + (cur[0] - prev[0]) * t - unx * rad, by = prev[1] + (cur[1] - prev[1]) * t - uny * rad, bz = prev[2] + (cur[2] - prev[2]) * t - unz * rad;
      const ang = Math.random() * 6.283, jr = Math.random() * 0.22;
      P.push({
        x: bx + Math.cos(ang) * jr, y: by + 0.02, z: bz + Math.sin(ang) * jr,
        vx: wvx * 0.7 + Math.cos(ang) * 0.25, vy: 0.02, vz: wvz * 0.7 + Math.sin(ang) * 0.25,
        buoy: 0.05, drag: 0.9, curl: CURL_STR * 0.4, relax: 0.6,   // high drag settles it into a ground trail
        age: 0, life: 3.5 + Math.random() * 2.5, size0: 0.8 + build * 1.2,
        baseA: 0.06, seed: Math.random(),
        gx: bx, gy: by, gz: bz, nx: unx, ny: uny, nz: unz,         // spawn-surface plane (banking-aware floor)
        lx: bx, ly: by, lz: bz,                                     // last-collision-check position
      });
    }
  }
}

// step + draw the smoke pool. Playback-time driven: pause freezes it, a scrub/jump
// clears it (particles are live sim, not replayable), forward play ages + emits. Shaded
// like the scene (sun + ambient), lit into the HDR buffer, premultiplied so no dark
// fringes, with soft-particle depth fade when the scene depth is available (HDR path).
function smokeStepAndDraw(mvp, view, L, fogD, i, nightF, softOn, zNear, zFar) {
  if (TYRE_MODE === 0) { smoke.pool.length = 0; AIR.cells.clear(); return; }
  let dt = smokePrevT === null ? 0 : tCur - smokePrevT;
  const scrub = smokePrevT === null || dt < 0 || dt > 0.2;
  smokePrevT = tCur;
  if (scrub) { smoke.pool.length = 0; AIR.cells.clear(); simAccum = 0; }   // live sim → clear on scrub
  else if (dt > 0) {
    /* FIXED-RATE SIM, decoupled from the render rate.
     *
     * This used to step once per rendered frame with that frame's dt. On a 60 Hz screen
     * that is 60 steps a second; on the keeper's 240 Hz laptop it is 240, and on the 360 Hz
     * desktop 360 — six times the particle integration and six times the AIR field update,
     * for a result that is not six times better. Every term here is already dt-scaled (the
     * emission rate, the slide accumulators, the drag and buoyancy integration), so smaller
     * steps buy accuracy nobody can see while the cost scales linearly with refresh rate.
     * The frame rate was paying for the monitor being good.
     *
     * A fixed 60 Hz step with an accumulator makes the simulation cost identical at 60 and
     * at 360, which is the only way a high-refresh target is affordable at all.
     *
     * The guard caps catch-up at four steps: after a stall, draining a large accumulated dt
     * in one frame would cost more than the stall did and turn one late frame into several
     * (the spiral of death). Dropping simulated time is the right trade — the smoke is
     * decoration, and nothing downstream measures it. */
    simAccum += dt;
    let steps = 0;
    while (simAccum >= SIM_STEP && steps < SIM_MAX_CATCHUP) {
      if (playing && !scrubbing) airStep(SIM_STEP, i, tCur / ex.dt);   // cars stir the shared air first
      smokeStep(SIM_STEP, playing && !scrubbing, i, nightF);           // then smoke rides it
      simAccum -= SIM_STEP; steps++;
    }
    if (steps >= SIM_MAX_CATCHUP) simAccum = 0;   // gave up catching up; do not hold the debt
    /* Recorded so a spike can be checked against it. The sim is a FIXED 60 Hz while the
     * render loop runs at the panel's rate, so at 360 Hz these two cadences are 1:6 — the
     * sim does a frame's worth of work on one frame in six and nothing on the other five.
     * That is the only periodic asymmetry left in the frame, now that the far shadow bake
     * is known to run once per sun angle, so if stalls land on sim frames the cause is in
     * here, and if they scatter evenly across all six it is somewhere else entirely. */
    lastSimSteps = steps;
  }
  const P = smoke.pool; if (!P.length) return;
  const FL = 9;                                                  // floats/vertex: center3, corner2, size, alpha, seed, life
  const need = P.length * 6 * FL;
  if (!smoke.arr || smoke.arr.length < need) smoke.arr = new Float32Array(Math.max(need, 6 * FL * 64));
  const A = smoke.arr, CORN = [[-1,-1],[1,-1],[1,1],[-1,-1],[1,1],[-1,1]];
  let o = 0;
  for (const p of P) {
    const tt = p.age / p.life;
    const av = Math.min(1, tt / 0.07) * Math.max(0, 1 - Math.max(0, (tt - 0.38) / 0.62));   // holds full through the spread, fades late
    const size = p.size0 * (0.5 + p.age * 2.1), alpha = av * p.baseA;   // billows bigger as it spreads → thicker cloud
    for (let c = 0; c < 6; c++) {
      A[o++] = p.x; A[o++] = p.y; A[o++] = p.z;
      A[o++] = CORN[c][0]; A[o++] = CORN[c][1];
      A[o++] = size; A[o++] = alpha; A[o++] = p.seed; A[o++] = tt;
    }
  }
  if (!smoke.vbo) smoke.vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, smoke.vbo);
  gl.bufferData(gl.ARRAY_BUFFER, A.subarray(0, o), gl.DYNAMIC_DRAW);
  gl.useProgram(progSmoke);
  gl.uniformMatrix4fv(smokeLoc.mvp, false, mvp);
  gl.uniform3f(smokeLoc.camRight, view[0], view[4], view[8]);   // camera basis from the view matrix
  gl.uniform3f(smokeLoc.camUp, view[1], view[5], view[9]);
  gl.uniform3f(smokeLoc.sunDir, L.dir[0], L.dir[1], L.dir[2]);
  gl.uniform3f(smokeLoc.sunCol, L.sun[0], L.sun[1], L.sun[2]);
  gl.uniform3f(smokeLoc.ambSky, L.ambSky[0], L.ambSky[1], L.ambSky[2]);
  gl.uniform3f(smokeLoc.ambGround, L.ambGround[0], L.ambGround[1], L.ambGround[2]);
  gl.uniform3f(smokeLoc.fogC, L.fog[0], L.fog[1], L.fog[2]);
  gl.uniform1f(smokeLoc.fogD, fogD);
  gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, smoke.noiseTex); gl.uniform1i(smokeLoc.noise, 5);
  const st = FL * 4;
  const setAttribs = () => {
    gl.enableVertexAttribArray(smokeLoc.center); gl.vertexAttribPointer(smokeLoc.center, 3, gl.FLOAT, false, st, 0);
    gl.enableVertexAttribArray(smokeLoc.corner); gl.vertexAttribPointer(smokeLoc.corner, 2, gl.FLOAT, false, st, 12);
    gl.enableVertexAttribArray(smokeLoc.size);   gl.vertexAttribPointer(smokeLoc.size, 1, gl.FLOAT, false, st, 20);
    gl.enableVertexAttribArray(smokeLoc.alpha);  gl.vertexAttribPointer(smokeLoc.alpha, 1, gl.FLOAT, false, st, 24);
    gl.enableVertexAttribArray(smokeLoc.seed);   gl.vertexAttribPointer(smokeLoc.seed, 1, gl.FLOAT, false, st, 28);
    gl.enableVertexAttribArray(smokeLoc.life);   gl.vertexAttribPointer(smokeLoc.life, 1, gl.FLOAT, false, st, 32);
  };
  const clearAttribs = () => {
    gl.disableVertexAttribArray(smokeLoc.corner); gl.disableVertexAttribArray(smokeLoc.size);
    gl.disableVertexAttribArray(smokeLoc.alpha); gl.disableVertexAttribArray(smokeLoc.seed); gl.disableVertexAttribArray(smokeLoc.life);
  };

  if (softOn && hdrFX.smokeDens && smoke.depthTex) {
    // SEAMLESS MERGE: accumulate density additively into a half-res buffer, then one
    // composite pass ramps the summed density → overlapping puffs fuse into one field.
    const dens = hdrFX.smokeDens;
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, smoke.depthTex); gl.uniform1i(smokeLoc.sceneDepth, 6);
    gl.uniform1f(smokeLoc.softOn, 1);
    gl.uniform2f(smokeLoc.screen, dens.w, dens.h);               // gl_FragCoord matches this half-res pass
    gl.uniform2f(smokeLoc.camRange, zNear, zFar);
    gl.uniform1f(smokeLoc.fadeDist, 0.6);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dens.fbo);
    gl.viewport(0, 0, dens.w, dens.h);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);           // additive: sum overlapping puffs' density
    setAttribs();
    gl.drawArrays(gl.TRIANGLES, 0, P.length * 6);
    clearAttribs();
    gl.bindFramebuffer(gl.FRAMEBUFFER, hdrFX.hdr.fbo);           // composite the merged field over the scene
    gl.viewport(0, 0, cv.width, cv.height);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(progSmokeComp);
    gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, dens.tex); gl.uniform1i(smokeCompLoc.dens, 7);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, smoke.noiseTex); gl.uniform1i(smokeCompLoc.noise, 5);
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, smoke.depthTex); gl.uniform1i(smokeCompLoc.sceneDepth, 6);
    gl.uniformMatrix4fv(smokeCompLoc.invVP, false, rvInv(mvp));      // world-pos reconstruction for anchored noise
    gl.uniform3f(smokeCompLoc.wind, SMOKE_WIND[0], SMOKE_WIND[1], SMOKE_WIND[2]);
    gl.uniform1f(smokeCompLoc.time, tCur);
    gl.uniform1f(smokeCompLoc.erode, SMOKE_ERODE);
    gl.uniform1f(smokeCompLoc.lo, SMOKE_MERGE_LO); gl.uniform1f(smokeCompLoc.hi, SMOKE_MERGE_HI);
    hdrTri(progSmokeComp);
    gl.activeTexture(gl.TEXTURE0);
    gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
  } else {
    // fallback (no float density buffer): direct premultiplied billboards, as before
    const soft = softOn && smoke.depthTex ? 1 : 0;
    gl.uniform1f(smokeLoc.softOn, soft);
    if (soft) {
      gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, smoke.depthTex); gl.uniform1i(smokeLoc.sceneDepth, 6);
      gl.uniform2f(smokeLoc.screen, cv.width, cv.height); gl.uniform2f(smokeLoc.camRange, zNear, zFar); gl.uniform1f(smokeLoc.fadeDist, 0.6);
    }
    gl.activeTexture(gl.TEXTURE0);
    setAttribs();
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    gl.drawArrays(gl.TRIANGLES, 0, P.length * 6);
    gl.depthMask(true); gl.disable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    clearAttribs();
  }
}

