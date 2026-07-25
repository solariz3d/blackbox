/* acreplay.js — Assetto Corsa .acreplay v16 parser (zero dependencies).
 *
 * Strategy: the documented v16 layout (abchouhan/acreplay-parser) is used for
 * the header and car-header strings, but real-world files (CSP, mods) disagree
 * with the documented frame stride. So the frame block SELF-CALIBRATES:
 *   1. stride found by byte autocorrelation over the frame region
 *   2. position phase found by scanning for a float32 triple that moves like
 *      a car (finite, continuous) AND has the wheel-quad echo at +92 bytes
 *   3. everything else is derived from position + wheels + the lap-time
 *      sawtooth (u32 ms counter at phase-64)
 * Works in browser and Node (no DOM usage).
 */
"use strict";

function readStr(dv, off) {
  const len = dv.getUint32(off, true);
  if (len > 4096) throw new Error("bad string len " + len + " at " + off);
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + 4 + i));
  return [s, off + 4 + len];
}

function parseReplay(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  let off = 0;
  const version = dv.getInt32(0, true); off = 4;
  const intervalMs = dv.getFloat64(4, true); off = 12;
  if (version !== 16) throw new Error("only .acreplay v16 supported (got " + version + ")");
  let weather, track, trackConfig;
  [weather, off] = readStr(dv, off);
  [track, off] = readStr(dv, off);
  [trackConfig, off] = readStr(dv, off);
  const numCars = dv.getUint32(off, true); off += 4;
  const recIndex = dv.getUint32(off, true); off += 4;
  const numFrames = dv.getUint32(off, true); off += 4;
  const numTrackObj = dv.getUint32(off, true); off += 4;
  off += (4 + 12 * numTrackObj) * numFrames; // scene block

  const cars = [];
  for (let c = 0; c < numCars; c++) {
    try {
      let carId, driver, nation, team, skin;
      [carId, off] = readStr(dv, off);
      [driver, off] = readStr(dv, off);
      [nation, off] = readStr(dv, off);
      [team, off] = readStr(dv, off);
      [skin, off] = readStr(dv, off);
      const carFrames = dv.getUint32(off, true); off += 4;
      const numWings = dv.getUint32(off, true); off += 4;
      const dataStart = off;

      // --- 1. stride by autocorrelation ---
      const stride = detectStride(bytes, dataStart, Math.min(bytes.length, dataStart + 400000));
      // --- 2. position phase by physics + wheel echo ---
      const posOff = detectPositionPhase(dv, bytes.length, dataStart, stride, intervalMs / 1000, carFrames);
      if (posOff < 0) throw new Error(
      "could not locate car motion data — online multi-car autosaves (AC_*_O_*) " +
      "store cars differently and are not supported yet; hotlap/practice replays work");
      const usable = Math.min(carFrames, Math.floor((bytes.length - posOff - 140) / stride));

      cars.push({
        carId, driver, nation, team, skin,
        numWings, declaredFrames: carFrames, frames: usable,
        stride, dataStart, posOff,
      });
      off = dataStart + carFrames * stride; // advance best-effort for next car
    } catch (e) {
      // online autosaves pad later car slots with garbage — keep what parsed
      if (cars.length === 0) throw e;
      break;
    }
  }
  return { version, intervalMs, weather, track, trackConfig, numCars, numFrames, recIndex, cars, dv,
           telemetry: parseTelemetry(arrayBuffer) };
}

/* ---- BLACKBOX telemetry tail (real engine data, appended by telemetry_logger) ----
 * Layout, from the end of the file:
 *   [ …replay… ][ "BBTL" u16ver u16schema u32count u32bytesPerSample | samples ][ u32 blobLen ][ "BBX1" ]
 * The replay parser above reads the file byte-identical and ignores this tail; here we
 * find the blob from the footer. Returns a lazy reader (no per-sample copy) or null. */
function parseTelemetry(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const n = dv.byteLength;
  if (n < 24) return null;
  // footer "BBX1"
  if (dv.getUint8(n-4)!==0x42 || dv.getUint8(n-3)!==0x42 || dv.getUint8(n-2)!==0x58 || dv.getUint8(n-1)!==0x31) return null;
  const blobLen = dv.getUint32(n-8, true);
  const blobStart = n - 8 - blobLen;
  if (blobStart < 0 || blobStart + 16 > n) return null;
  // magic "BBTL"
  if (dv.getUint8(blobStart)!==0x42 || dv.getUint8(blobStart+1)!==0x42 || dv.getUint8(blobStart+2)!==0x54 || dv.getUint8(blobStart+3)!==0x4c) return null;
  const ver = dv.getUint16(blobStart+4, true);
  const schema = dv.getUint16(blobStart+6, true);
  const count = dv.getUint32(blobStart+8, true);
  const bps = dv.getUint32(blobStart+12, true);
  const dataOff = blobStart + 16;
  if (count < 1 || bps < 4 || dataOff + count*bps > n) return null;
  // field index (in f32 units) within one sample, per schema; -1 = channel absent.
  const F = { time:-1, rpm:-1, gear:-1, gas:-1, brake:-1, speed:-1, slip:-1, boost:-1, susp:-1,
              turbRpm:-1, thrust:-1, afterburner:-1, switches:-1 };
  /* Schema 6 = schema 5 + the CSP script-controller channels. Those live in CSP's extended physics
   * (`ac.getCarPhysics(0).scriptControllerInputs`), NOT in AC's shared memory, which is why no
   * earlier replay can ever have them — the value was never in the page the logger reads. A car's
   * indices are its own; these four are what the T-180 mod's own graphics.lua reads:
   *   [10] turbine rpm · [9] thrust · [12]/[17] afterburner · plus a bitmask of every switch. */
  if (schema === 6)      { F.time=0; F.rpm=1; F.gear=2; F.gas=3; F.brake=4; F.speed=5; F.slip=6; F.boost=10; F.susp=11;
                           F.turbRpm=15; F.thrust=16; F.afterburner=17; F.switches=18; }
  else if (schema === 5) { F.time=0; F.rpm=1; F.gear=2; F.gas=3; F.brake=4; F.speed=5; F.slip=6; F.boost=10; F.susp=11; }
  else if (schema === 4) { F.rpm=0; F.gear=1; F.gas=2; F.brake=3; F.speed=4; F.slip=5; F.boost=11; F.susp=12; }
  else if (schema === 3) { F.rpm=0; F.gear=1; F.gas=2; F.brake=3; F.speed=4; F.slip=5; F.boost=11; }
  else return null; // schema 1/2 were experimental (position-based) — no engine channels to use
  const get = (i, fi) => dv.getFloat32(dataOff + i*bps + fi*4, true);
  return { ver, schema, count, bps, F, get };
}

/* Resample the telemetry onto the replay's N frames. Both streams END at the save
 * moment, so we TAIL-align: frame i (time-before-end = (N-1-i)*dt) maps to the sample
 * with the matching time-before-end. Schema 5 carries per-sample ms → exact even with a
 * session-long buffer or mid-session pauses. Older schemas (no timestamps) fall back to a
 * uniform-rate tail assumption (AC physics ≈ 333 Hz) — good for a clean continuous lap,
 * approximate if the buffer had gaps. Returns per-frame arrays or null. */
function alignTelemetry(tel, N, dt) {
  if (!tel || N < 1) return null;
  const C = tel.count, F = tel.F, get = tel.get;
  const out = {
    schema: tel.schema,
    rpm: new Float32Array(N), gear: new Float32Array(N), gas: new Float32Array(N),
    brake: new Float32Array(N), speed: new Float32Array(N), boost: new Float32Array(N),
    slip: new Float32Array(N*4), susp: new Float32Array(N*4),
    turbRpm: new Float32Array(N), thrust: new Float32Array(N), afterburner: new Float32Array(N), switches: new Float32Array(N),
    has: { boost: F.boost>=0, slip: F.slip>=0, susp: F.susp>=0,
           turbine: F.turbRpm>=0, afterburner: F.afterburner>=0, switches: F.switches>=0 },
    mode: F.time>=0 ? "time" : "count",
  };
  let sampleForFrame;
  if (F.time >= 0) {
    const tEnd = get(C-1, F.time);           // ms at the last sample = the save moment
    const t0 = get(0, F.time);
    sampleForFrame = (i) => {
      const target = tEnd - (N-1-i)*dt*1000;  // ms this frame wants (measured from the end)
      if (target <= t0) return 0;
      if (target >= tEnd) return C-1;
      let lo = 0, hi = C-1;                    // timeMs is monotonic → binary search
      while (lo < hi) { const mid = (lo+hi)>>1; if (get(mid, F.time) < target) lo = mid+1; else hi = mid; }
      if (lo>0 && Math.abs(get(lo-1,F.time)-target) <= Math.abs(get(lo,F.time)-target)) return lo-1;
      return lo;
    };
  } else {
    const RATE = 333;                          // assume AC physics tick
    const M = Math.min(C, Math.max(1, Math.round(N*dt*RATE)));
    const base = C - M;                        // last M samples ≈ the replay window
    const span = Math.max(1, M-1), fden = Math.max(1, N-1);
    sampleForFrame = (i) => Math.min(C-1, base + Math.round((i/fden)*span));
  }
  for (let i = 0; i < N; i++) {
    const j = sampleForFrame(i);
    out.rpm[i]=get(j,F.rpm); out.gear[i]=get(j,F.gear); out.gas[i]=get(j,F.gas);
    out.brake[i]=get(j,F.brake); out.speed[i]=get(j,F.speed);
    if (F.boost>=0) out.boost[i]=get(j,F.boost);
    if (F.turbRpm>=0) out.turbRpm[i]=get(j,F.turbRpm);
    if (F.thrust>=0) out.thrust[i]=get(j,F.thrust);
    if (F.afterburner>=0) out.afterburner[i]=get(j,F.afterburner);
    if (F.switches>=0) out.switches[i]=get(j,F.switches);
    if (F.slip>=0) for (let k=0;k<4;k++) out.slip[i*4+k]=get(j,F.slip+k);
    if (F.susp>=0) for (let k=0;k<4;k++) out.susp[i*4+k]=get(j,F.susp+k);
  }
  return out;
}

function detectStride(bytes, start, end) {
  const n = end - start - 500;
  if (n < 5000) throw new Error("frame region too small");
  const samples = 12000;
  let best = -1, bestSim = -1;
  for (let s = 200; s <= 420; s++) {
    let same = 0;
    for (let k = 0; k < samples; k++) {
      const i = start + ((k * 2654435761) >>> 0) % n;
      if (bytes[i] === bytes[i + s]) same++;
    }
    if (same > bestSim) { bestSim = same; best = s; }
  }
  return best;
}

function detectPositionPhase(dv, total, dataStart, stride, dt, carFrames) {
  const testFrames = 220;
  const maxSpan = dataStart + stride * 3;
  function score(o) {
    // probe the middle third of THIS CAR's block — spawn frames can be
    // stationary, and past the block lies other cars' data
    const avail = Math.min(carFrames - 4, Math.floor((total - o - 140) / stride));
    if (avail < testFrames * 2) return -1;
    const start = Math.floor(avail / 3);
    let good = 0, echoTight = 0, travel = 0;
    let minX = 1e30, maxX = -1e30, minY = 1e30, maxY = -1e30, minZ = 1e30, maxZ = -1e30;
    let px = 0, py = 0, pz = 0, has = false;
    for (let f = 0; f < testFrames; f++) {
      const b = o + (start + f) * stride;
      const x = dv.getFloat32(b, true), y = dv.getFloat32(b + 4, true), z = dv.getFloat32(b + 8, true);
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) { has = false; continue; }
      if (has) {
        const d = Math.hypot(x - px, y - py, z - pz);
        if (d < 12) { good++; travel += d; }
      }
      const wx = dv.getFloat32(b + 92, true), wy = dv.getFloat32(b + 96, true), wz = dv.getFloat32(b + 100, true);
      if (isFinite(wx) && Math.hypot(wx - x, wy - y, wz - z) < 3.0) echoTight++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      px = x; py = y; pz = z; has = true;
    }
    // hard gates: smooth, moving, and every axis alive (a real car's altitude
    // and both lateral axes all vary within 3+ seconds of driving)
    if (good < testFrames * 0.9) return -1;
    if (travel < testFrames * dt * 0.5) return -1;
    if (maxX - minX < 3 || maxZ - minZ < 3 || maxY - minY < 0.05) return -1;
    return echoTight + Math.min(travel, 2000) * 0.01;
  }
  let best = -1, bestScore = 0;
  for (let o = dataStart; o < maxSpan; o += 4) {
    const s = score(o);
    if (s > bestScore) { bestScore = s; best = o; }
  }
  return best;
}

/* Extract per-frame channels + derived physics for one car. */
function extractCar(replay, carIndex) {
  const car = replay.cars[carIndex];
  const dv = replay.dv;
  const dt = replay.intervalMs / 1000;
  const N = car.frames;
  const P = car.posOff, S = car.stride;

  const pos = new Float64Array(N * 3);
  const tilt = new Float32Array(N).fill(NaN);
  const nrm = new Float32Array(N * 3); // road surface normal (unit), world-up fallback
  for (let i = 0; i < N; i++) nrm[i * 3 + 1] = 1;
  const fwd = new Float32Array(N * 3); // REAL body heading from the wheels (front axle − rear axle)
  const wheels = new Float32Array(N * 12);   // recorded wheel-centre world positions (FL,FR,RL,RR) — real suspension
  const wheelsOk = new Uint8Array(N);        // 1 = this frame's wheel quad is valid
  const lapMs = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    const b = P + i * S;
    let x = dv.getFloat32(b, true), y = dv.getFloat32(b + 4, true), z = dv.getFloat32(b + 8, true);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
      if (i > 0) { x = pos[(i - 1) * 3]; y = pos[(i - 1) * 3 + 1]; z = pos[(i - 1) * 3 + 2]; }
      else { x = y = z = 0; }
    }
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;

    // live wheel quad at +92 (FL, FR, RL, RR — 12 bytes each)
    const w = [];
    let wOk = true;
    for (let k = 0; k < 4; k++) {
      const wb = b + 92 + 12 * k;
      const wx = dv.getFloat32(wb, true), wy = dv.getFloat32(wb + 4, true), wz = dv.getFloat32(wb + 8, true);
      if (!isFinite(wx) || !isFinite(wy) || !isFinite(wz) || Math.hypot(wx - x, wy - y, wz - z) > 8) { wOk = false; break; }
      w.push([wx, wy, wz]);
    }
    if (wOk) {
      wheelsOk[i] = 1;
      for (let k = 0; k < 4; k++) { wheels[i*12 + k*3] = w[k][0]; wheels[i*12 + k*3 + 1] = w[k][1]; wheels[i*12 + k*3 + 2] = w[k][2]; }
      const a = [w[1][0] - w[0][0], w[1][1] - w[0][1], w[1][2] - w[0][2]];
      const bb = [w[2][0] - w[0][0], w[2][1] - w[0][1], w[2][2] - w[0][2]];
      let nx = a[1] * bb[2] - a[2] * bb[1];
      let ny = a[2] * bb[0] - a[0] * bb[2];
      let nz = a[0] * bb[1] - a[1] * bb[0];
      const nn = Math.hypot(nx, ny, nz);
      if (nn > 1e-9) {
        const cosT = ny / nn;
        tilt[i] = Math.acos(Math.max(-1, Math.min(1, cosT))) * 180 / Math.PI;
        nrm[i * 3] = nx / nn; nrm[i * 3 + 1] = ny / nn; nrm[i * 3 + 2] = nz / nn;
      }
      // real body heading: front axle centre − rear axle centre (w0,w1 = one axle,
      // w2,w3 = the other). Carries the true slip angle the car actually had.
      let hx = (w[0][0] + w[1][0]) * 0.5 - (w[2][0] + w[3][0]) * 0.5;
      let hy = (w[0][1] + w[1][1]) * 0.5 - (w[2][1] + w[3][1]) * 0.5;
      let hz = (w[0][2] + w[1][2]) * 0.5 - (w[2][2] + w[3][2]) * 0.5;
      const hn = Math.hypot(hx, hy, hz);
      if (hn > 1e-6) { fwd[i * 3] = hx / hn; fwd[i * 3 + 1] = hy / hn; fwd[i * 3 + 2] = hz / hn; }
    }
    // lap-time sawtooth at phase -64 relative to position
    const lb = b - 64;
    lapMs[i] = lb >= 0 ? dv.getUint32(lb, true) : 0;
  }

  // orientation consistency: if median tilt > 90 the normal winding is flipped
  const finiteTilts = [];
  for (let i = 0; i < N; i += 7) if (isFinite(tilt[i])) finiteTilts.push(tilt[i]);
  finiteTilts.sort((a, b) => a - b);
  if (finiteTilts.length && finiteTilts[Math.floor(finiteTilts.length / 2)] > 90) {
    for (let i = 0; i < N; i++) if (isFinite(tilt[i])) {
      tilt[i] = 180 - tilt[i];
      nrm[i * 3] *= -1; nrm[i * 3 + 1] *= -1; nrm[i * 3 + 2] *= -1;
    }
  }

  // derived: teleports, speed, odo
  const speed = new Float32Array(N).fill(NaN); // kph
  const gap = new Uint8Array(N);
  const odo = new Float64Array(N);
  for (let i = 1; i < N; i++) {
    const dx = pos[i * 3] - pos[(i - 1) * 3];
    const dy = pos[i * 3 + 1] - pos[(i - 1) * 3 + 1];
    const dz = pos[i * 3 + 2] - pos[(i - 1) * 3 + 2];
    const d = Math.hypot(dx, dy, dz);
    if (d > 8) { gap[i] = 1; odo[i] = odo[i - 1]; continue; }
    odo[i] = odo[i - 1] + d;
    speed[i] = d / dt * 3.6;
  }
  // crash-warp debris: short islands of "continuous" frames stranded after a
  // teleport (post-crash reset junk the recorder keeps writing) — flag whole
  // islands under 2 s so they never render or count, keeping the first island
  // (the spawn) regardless
  {
    let s = 0, firstIsland = true;
    for (let i = 1; i <= N; i++) {
      if (i === N || gap[i]) {
        const durS = (i - s) * dt;
        if (!firstIsland && durS < 2.0) for (let k = s; k < i; k++) gap[k] = 1;
        firstIsland = false;
        s = i; // the jumped-to frame starts the next island
      }
    }
  }

  // wheel-heading (nose) cleanup. The front-axle−rear-axle vector IS the true nose
  // direction and carries the real slip/drift — but online replays emit occasional
  // single-frame sign glitches (a >90° flip in one 33 Hz step is physically
  // impossible). Enforce sign continuity so the car never momentarily "switches
  // ends", then a global majority check so the nose points with travel overall.
  {
    // collect frames that actually have a heading
    const idx = [];
    for (let i = 0; i < N; i++) if (Math.hypot(fwd[i * 3], fwd[i * 3 + 1], fwd[i * 3 + 2]) >= 1e-6) idx.push(i);
    const dot = (p, q) => fwd[p * 3] * fwd[q * 3] + fwd[p * 3 + 1] * fwd[q * 3 + 1] + fwd[p * 3 + 2] * fwd[q * 3 + 2];
    // flip ONLY isolated spikes — a frame that reverses vs BOTH neighbours. A real
    // drift rotates smoothly (neighbours agree), so genuine backward-facing slides
    // survive; only lone one-frame glitches get corrected (no section inversion).
    for (let k = 1; k + 1 < idx.length; k++) {
      const i = idx[k];
      if (dot(i, idx[k - 1]) < 0 && dot(i, idx[k + 1]) < 0) { fwd[i * 3] *= -1; fwd[i * 3 + 1] *= -1; fwd[i * 3 + 2] *= -1; }
    }
    // global safety: the nose should point WITH travel overall; flip all if inverted
    let fwdN = 0, backN = 0;
    for (let i = 1; i < N; i++) {
      if (gap[i]) continue;
      const dx = pos[i * 3] - pos[(i - 1) * 3], dy = pos[i * 3 + 1] - pos[(i - 1) * 3 + 1], dz = pos[i * 3 + 2] - pos[(i - 1) * 3 + 2];
      if (Math.hypot(dx, dy, dz) < 0.05) continue;
      const fx = fwd[i * 3], fy = fwd[i * 3 + 1], fz = fwd[i * 3 + 2];
      if (Math.hypot(fx, fy, fz) < 1e-6) continue;
      if (fx * dx + fy * dy + fz * dz > 0) fwdN++; else backN++;
    }
    if (backN > fwdN) for (let i = 0; i < N; i++) { fwd[i * 3] *= -1; fwd[i * 3 + 1] *= -1; fwd[i * 3 + 2] *= -1; }
  }

  // smooth speed (5)
  const spS = new Float32Array(N).fill(NaN);
  for (let i = 0; i < N; i++) {
    let s = 0, c = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j >= 0 && j < N && isFinite(speed[j])) { s += speed[j]; c++; }
    }
    if (c) spS[i] = s / c;
  }
  // trim artifacts near gaps and ends
  for (let i = 0; i < N; i++) {
    if (gap[i]) for (let k = -8; k <= 8; k++) {
      const j = i + k; if (j >= 0 && j < N) spS[j] = NaN;
    }
  }
  for (let k = 0; k < 9; k++) { spS[k] = NaN; spS[N - 1 - k] = NaN; }
  for (let i = 0; i < N; i++) if (spS[i] > 1500) spS[i] = NaN;

  // laps from the ms sawtooth: reset = crossing the line
  const laps = [];
  for (let i = 1; i < N; i++) {
    const d = lapMs[i] - lapMs[i - 1];
    if (d < -5000 && lapMs[i - 1] > 5000 && lapMs[i - 1] < 3600000) {
      laps.push({ frame: i, timeMs: lapMs[i - 1] });
    }
  }

  // the post-lap shrug: driving after the FINAL line-crossing that ends in a
  // teleport is a completed run's throwaway tail (cross the line, stop caring,
  // fly off, reset) — cut it at the data layer so no view mode resurrects it.
  // A partial next lap that simply runs out of recording has no teleport and
  // survives untouched.
  if (laps.length) {
    const L = laps[laps.length - 1].frame;
    let tp = -1;
    for (let i = L + 1; i < N; i++) if (gap[i]) { tp = i; break; }
    if (tp > 0) {
      const from = Math.min(N, L + Math.round(0.5 / dt));
      for (let k = from; k < N; k++) { gap[k] = 1; spS[k] = NaN; }
    }
  }

  return { car, dt, N, pos, tilt, nrm, fwd, wheels, wheelsOk, speed: spS, gap, odo, lapMs, laps };
}

/* stats helper */
function runStats(ex) {
  const v = [];
  for (let i = 0; i < ex.N; i++) if (isFinite(ex.speed[i])) v.push(ex.speed[i]);
  v.sort((a, b) => a - b);
  const q = p => v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN;
  let minY = 1e9, maxY = -1e9;
  for (let i = 0; i < ex.N; i++) {
    const y = ex.pos[i * 3 + 1];
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const t = [];
  for (let i = 0; i < ex.N; i += 3) if (isFinite(ex.tilt[i])) t.push(ex.tilt[i]);
  t.sort((a, b) => a - b);
  const tq = p => t.length ? t[Math.min(t.length - 1, Math.floor(p * t.length))] : NaN;
  return {
    durationS: ex.N * ex.dt,
    distanceKm: ex.odo[ex.N - 1] / 1000,
    maxKph: q(0.999), medianKph: q(0.5),
    verticalM: maxY - minY,
    medianTilt: tq(0.5),
    invertedPct: t.length ? t.filter(x => x > 100).length / t.length * 100 : 0,
    laps: ex.laps,
  };
}

if (typeof module !== "undefined") module.exports = { parseReplay, extractCar, runStats, parseTelemetry, alignTelemetry };
if (typeof window !== "undefined") window.ACReplay = { parseReplay, extractCar, runStats, parseTelemetry, alignTelemetry };
