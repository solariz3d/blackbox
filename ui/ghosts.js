/* ghosts.js — multi-replay ghosts: which runs exist, what each looks like, which model
 * they share, and how two laps line up against each other.
 *
 * Pure data and arithmetic. No WebGL, no DOM — so it runs under node and is covered by
 * test_ghosts.js. The renderer owns pixels; this owns everything upstream of them.
 *
 * ALIGNMENT IS BY DISTANCE, NOT TIME. Two laps played from a common clock start drift
 * apart the instant one driver is quicker, and after one corner they are no longer
 * showing you the same piece of track. Compared at the same distance around the lap they
 * stay side-by-side the whole way, and the time difference at that point IS the delta.
 * That is the difference between a novelty and something you can learn a corner from.
 *
 * `ex` throughout is an extractCar() result from acreplay.js:
 *   { car, dt, N, pos, tilt, nrm, fwd, wheels, wheelsOk, speed, gap, odo, lapMs, laps }
 * `laps` is [{ frame, timeMs }] — frame is the line crossing that STARTS a new lap and
 * timeMs is the time of the lap that just ENDED.
 */

/* ── ghost appearance ─────────────────────────────────────────────────────────── */

// Two ways to show a run. Holographic is the chase-the-ghost look: translucent body and
// a streak ribbon down the racing line, no simulation dressing. Full is a second real
// car — smoke, lights, marks, driver — for when you want a field rather than a target.
const MODES = { HOLO: "holo", FULL: "full" };

// What each mode switches on. The renderer consults this table instead of scattering
// `if (mode === 'holo')` through every effect subsystem.
const MODE_FX = {
  holo: { body: true, wheels: true, translucent: true, streak: true,
          driver: false, smoke: false, marks: false, lights: false, audio: false },
  full: { body: true, wheels: true, translucent: false, streak: false,
          driver: true, smoke: true, marks: true, lights: true, audio: false },
};

// Chosen to stay separable at speed against a dark track, and to survive the translucent
// holo pass without washing to white. Primary run always takes slot 0.
const GHOST_COLOURS = [
  [1.00, 0.28, 0.20],   // ember   — primary/reference
  [0.30, 0.85, 1.00],   // cyan
  [0.65, 1.00, 0.35],   // lime
  [1.00, 0.80, 0.25],   // amber
  [0.85, 0.45, 1.00],   // violet
  [1.00, 0.45, 0.75],   // rose
];

let nextGhostId = 1;

/* A ghost is one run on track. `ex` is its extracted telemetry, `model` is a handle from
 * the ModelCache (shared with any other ghost on the same carId). */
function makeGhost(opts) {
  const o = opts || {};
  if (!o.ex) throw new Error("makeGhost: ex is required");
  const mode = o.mode === MODES.FULL ? MODES.FULL : MODES.HOLO;
  return {
    id: o.id != null ? o.id : nextGhostId++,
    label: o.label || (o.ex.car && (o.ex.car.driver || o.ex.car.carId)) || "run",
    source: o.source || "",            // file name the run came from
    carId: o.carId || (o.ex.car && o.ex.car.carId) || null,
    ex: o.ex,
    mode,
    fx: MODE_FX[mode],
    colour: o.colour || GHOST_COLOURS[0],
    visible: o.visible !== false,
    model: null,                        // ModelCache handle, set by the loader
    lap: null,                          // selected lap index (null = whole run)
  };
}

function setGhostMode(ghost, mode) {
  if (mode !== MODES.HOLO && mode !== MODES.FULL) throw new Error("unknown ghost mode: " + mode);
  ghost.mode = mode;
  ghost.fx = MODE_FX[mode];
  return ghost;
}

/* ── the set of loaded runs ───────────────────────────────────────────────────── */

/* ghosts[0] is the primary: the run the camera follows, the HUD reads, and every delta
 * is measured against. Removing the primary promotes the next one rather than leaving
 * the app with no reference. */
class GhostSet {
  constructor() { this.ghosts = []; }

  get primary() { return this.ghosts[0] || null; }
  get length() { return this.ghosts.length; }
  get visible() { return this.ghosts.filter(g => g.visible); }

  // first unused colour, so two ghosts never share one until the palette runs out
  nextColour() {
    const used = new Set(this.ghosts.map(g => g.colour.join(",")));
    return GHOST_COLOURS.find(c => !used.has(c.join(","))) || GHOST_COLOURS[this.ghosts.length % GHOST_COLOURS.length];
  }

  add(ghost) {
    if (!ghost.colour || this.ghosts.some(g => g !== ghost && g.colour === ghost.colour)) ghost.colour = this.nextColour();
    // the first run in is the reference, and it is a full car — you are watching it, not chasing it
    if (this.ghosts.length === 0) setGhostMode(ghost, MODES.FULL);
    this.ghosts.push(ghost);
    return ghost;
  }

  remove(id) {
    const i = this.ghosts.findIndex(g => g.id === id);
    if (i < 0) return null;
    return this.ghosts.splice(i, 1)[0];
  }

  get(id) { return this.ghosts.find(g => g.id === id) || null; }

  // promote to reference; the old primary keeps its own mode rather than being demoted
  setPrimary(id) {
    const i = this.ghosts.findIndex(g => g.id === id);
    if (i <= 0) return this.primary;
    const [g] = this.ghosts.splice(i, 1);
    this.ghosts.unshift(g);
    return g;
  }

  clear() { this.ghosts.length = 0; }
}

/* ── model reuse ──────────────────────────────────────────────────────────────── */

/* Car models are the heaviest thing loaded. Four ghosts in the same car must upload one
 * model and draw it four times, not upload it four times. This is bookkeeping only — the
 * GL upload and disposal stay with the renderer, which owns the context.
 *
 *   const h = cache.acquire(id) || cache.put(id, await uploadCarModel(id));
 *   ...
 *   const dead = cache.release(id); if (dead) disposeCarModel(dead);
 */
class ModelCache {
  constructor() { this.entries = new Map(); }

  has(carId) { return this.entries.has(carId); }
  refs(carId) { const e = this.entries.get(carId); return e ? e.refs : 0; }
  get size() { return this.entries.size; }

  // take a reference to an already-uploaded model, or null if it isn't loaded yet
  acquire(carId) {
    const e = this.entries.get(carId);
    if (!e) return null;
    e.refs++;
    return e.handle;
  }

  // store a freshly uploaded model; the caller already holds the first reference
  put(carId, handle) {
    if (this.entries.has(carId)) throw new Error("ModelCache: already cached: " + carId);
    this.entries.set(carId, { handle, refs: 1 });
    return handle;
  }

  // drop a reference; returns the handle ONLY when the last one goes, so the caller
  // knows to free the GPU memory. Returns null while anyone else is still drawing it.
  release(carId) {
    const e = this.entries.get(carId);
    if (!e) return null;
    if (--e.refs > 0) return null;
    this.entries.delete(carId);
    return e.handle;
  }
}

/* ── laps ─────────────────────────────────────────────────────────────────────── */

/* Lap boundaries as usable windows. `laps` marks line crossings, so lap k runs from
 * crossing k to crossing k+1; the drive out to the first crossing and the tail after the
 * last are not complete laps and are excluded. A run with fewer than two crossings has
 * no complete lap — that is a real answer, not a failure. */
function lapWindows(ex) {
  const out = [];
  if (!ex || !ex.laps || ex.laps.length < 2) return out;
  for (let k = 0; k < ex.laps.length - 1; k++) {
    const start = ex.laps[k].frame, end = ex.laps[k + 1].frame;
    if (!(end > start)) continue;                      // defensive: never a backwards window
    out.push({
      index: out.length,
      start, end,
      timeMs: ex.laps[k + 1].timeMs,                   // the time of the lap that just ended
      timeS: ex.laps[k + 1].timeMs / 1000,
    });
  }
  return out;
}

// fastest complete lap, or null when the run has none
function bestLapIndex(ex) {
  const w = lapWindows(ex);
  if (!w.length) return null;
  let best = 0;
  for (let i = 1; i < w.length; i++) if (w[i].timeMs > 0 && w[i].timeMs < w[best].timeMs) best = i;
  return w[best].timeMs > 0 ? best : null;
}

/* Per-frame distance travelled since the lap started, in metres, for one window.
 * Built from ex.odo (cumulative). Monotonic by construction — a non-advancing frame
 * repeats the previous distance rather than going backwards, so the lookup below can
 * binary-search it safely even across a data gap. */
function lapDistances(ex, win) {
  const n = win.end - win.start + 1;
  const d = new Float64Array(n);
  const base = ex.odo[win.start];
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const raw = ex.odo[win.start + i] - base;
    prev = isFinite(raw) && raw > prev ? raw : prev;
    d[i] = prev;
  }
  return d;
}

function lapLength(dists) { return dists.length ? dists[dists.length - 1] : 0; }

/* Fractional frame index (relative to the window start) at a given lap distance.
 * NaN past the end of this lap — deliberately NOT extrapolated, because a ghost that
 * ran a shorter distance has nothing honest to say about the part it never drove. */
function frameAtDistance(dists, metres) {
  const n = dists.length;
  if (!n || !(metres >= 0) || metres > dists[n - 1]) return NaN;
  let lo = 0, hi = n - 1;
  while (lo < hi) {                     // first index with dists[i] >= metres
    const mid = (lo + hi) >> 1;
    if (dists[mid] < metres) lo = mid + 1; else hi = mid;
  }
  if (lo === 0) return 0;
  const d0 = dists[lo - 1], d1 = dists[lo];
  const span = d1 - d0;
  return span > 0 ? (lo - 1) + (metres - d0) / span : lo;
}

// seconds since the lap started, at a given distance around it
function timeAtDistance(ex, dists, metres) {
  const f = frameAtDistance(dists, metres);
  return isFinite(f) ? f * ex.dt : NaN;
}

/* The delta: how far behind the ghost is at this point on track, in seconds.
 * Positive = ghost is slower (behind), negative = ghost is quicker (ahead) — the sign a
 * driver expects from a timing screen. NaN when either run has not reached this
 * distance, which the UI should show as blank rather than as zero. */
function deltaAtDistance(ref, ghost, metres) {
  const tr = timeAtDistance(ref.ex, ref.dists, metres);
  const tg = timeAtDistance(ghost.ex, ghost.dists, metres);
  return isFinite(tr) && isFinite(tg) ? tg - tr : NaN;
}

/* Playback mapping: given the reference run's frame, which frame should the ghost be on
 * so both are at the same point on track? This is what the render loop calls per ghost
 * per frame. Returns a fractional frame ABSOLUTE in the ghost's own timeline (window
 * start already added), or NaN when the ghost has no data for that place. */
function ghostFrameFor(refAligned, ghostAligned, refFrame) {
  const rel = refFrame - refAligned.win.start;
  if (rel < 0 || rel >= refAligned.dists.length) return NaN;
  const metres = refAligned.dists[rel];
  const f = frameAtDistance(ghostAligned.dists, metres);
  return isFinite(f) ? ghostAligned.win.start + f : NaN;
}

/* Bundle a ghost with the lap it is showing. `lapIndex` null selects its best lap; a run
 * with no complete lap falls back to the whole recording so it still appears on track. */
function alignGhost(ghost, lapIndex) {
  const wins = lapWindows(ghost.ex);
  let win;
  if (!wins.length) {
    win = { index: -1, start: 0, end: ghost.ex.N - 1, timeMs: 0, timeS: ghost.ex.N * ghost.ex.dt };
  } else {
    const k = lapIndex != null ? lapIndex : (bestLapIndex(ghost.ex) ?? 0);
    win = wins[Math.max(0, Math.min(wins.length - 1, k))];
  }
  const dists = lapDistances(ghost.ex, win);
  return { ghost, ex: ghost.ex, win, dists, length: lapLength(dists) };
}

const Ghosts = {
  MODES, MODE_FX, GHOST_COLOURS,
  makeGhost, setGhostMode, GhostSet, ModelCache,
  lapWindows, bestLapIndex, lapDistances, lapLength,
  frameAtDistance, timeAtDistance, deltaAtDistance, ghostFrameFor, alignGhost,
};

if (typeof module !== "undefined") module.exports = Ghosts;
if (typeof window !== "undefined") window.Ghosts = Ghosts;
