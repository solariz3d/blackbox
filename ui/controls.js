/* controls.js — input, the transport bar, the header toggles, drag-and-drop and folder persistence.
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

/* ===================== input: orbit controls ===================== */
let dragging = null;
cv.addEventListener("mousedown", e => {
  dragging = { x: e.clientX, y: e.clientY, btn: e.button, moved: false };
});
addEventListener("mousemove", e => {
  if (!dragging) return;
  const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
  dragging.x = e.clientX; dragging.y = e.clientY;
  if (Math.abs(dx) + Math.abs(dy) > 1) dragging.moved = true;
  if (dragging.btn === 0) {
    /* Look deltas are ACCUMULATED here and applied once per frame (lookStep), never per event.
     * A mouse reports at ~125 Hz in uneven bursts while the frame renders at 60: applied
     * immediately, some frames absorb three deltas and others none, which reads as stutter even
     * though no input was lost. Buffering turns the same total motion into a smooth sweep. */
    lookPend.dx += dx; lookPend.dy += dy;
  } else {
    // pan in camera plane
    const eye = camEye();
    const fz = [cam.target[0] - eye[0], cam.target[1] - eye[1], cam.target[2] - eye[2]];
    const fl = Math.hypot(fz[0], fz[1], fz[2]);
    const rx = [fz[2] / fl, 0, -fz[0] / fl];
    const scale = cam.dist * 0.0012;
    cam.target[0] -= (dx * rx[0]) * scale;
    cam.target[2] -= (dx * rx[2]) * scale;
    cam.target[1] += dy * scale;
  }
});
addEventListener("mouseup", () => { dragging = null; });
cv.addEventListener("contextmenu", e => e.preventDefault());
cv.addEventListener("wheel", e => {
  e.preventDefault();
  if (follow.on) {
    // the range continues past the old 0.12 floor — the rig turns that last stretch into a move
    // into the cockpit rather than pulling the chase eye into the bodywork
    follow.distMul = Math.max(0.03, Math.min(2.6, follow.distMul * (e.deltaY > 0 ? 1.1 : 0.9)));
  } else {
    cam.dist = Math.max(3, Math.min(50000, cam.dist * (e.deltaY > 0 ? 1.12 : 0.89)));
  }
}, { passive: false });

/* free-fly cam: WASD flies through 3D toward where you're looking (incl. up/down),
   Shift/Ctrl raise/lower, Space pauses, drag looks, wheel zooms. (Disabled while
   following.) */
const flyKeys = new Set();
const FLY = new Set(["w", "a", "s", "d", "shift", "control"]);
addEventListener("keydown", e => {
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
  if (e.key === " ") { togglePlay(); e.preventDefault(); return; }
  const k = e.key.toLowerCase();
  if (k === "m") {   // toggle the telemetry-driven engine soundscape
    if (window.BBAudio) BBAudio.toggle().then(on => {
      const el = document.getElementById("audioind");
      if (el) { el.textContent = on ? "♪ sound on" : "♪ sound off"; el.style.opacity = on ? "1" : "0.5"; }
    });
    e.preventDefault(); return;
  }
  if (k === "l") { setTrackLampsOn(!TRACK_LIGHTS_ON); e.preventDefault(); return; }
  if (k === "k") {
    MAT_DEBUG = MAT_DEBUG ? 0 : 1;
    if (MAT_DEBUG && sceneGroups) {
      const seen = [];
      for (const g of sceneGroups) if (!seen.includes(g.matName)) seen.push(g.matName);
      const NAMES = ["red","green","blue","yellow","magenta","cyan","orange","purple","pale","white"];
      matLegend = " | MAT: " + seen.map((n,i)=>NAMES[i%NAMES.length]+"="+n).join(" ");
    } else matLegend = "";
    e.preventDefault(); return;
  }
  if (FLY.has(k)) { flyKeys.add(k); e.preventDefault(); }
});
addEventListener("keyup", e => flyKeys.delete(e.key.toLowerCase()));
addEventListener("blur", () => flyKeys.clear());
/* Apply buffered look motion, eased. A TIME-CONSTANT response (not a fixed fraction per frame)
 * keeps the feel identical at 30, 60 or 144 fps. */
const lookPend = { dx: 0, dy: 0 };
const LOOK_TAU = 0.035;            // seconds to absorb a flick — short enough to still feel direct
function lookStep(dtSec) {
  if (!lookPend.dx && !lookPend.dy) return;
  const k = 1 - Math.exp(-Math.max(0.001, dtSec) / LOOK_TAU);
  const dx = lookPend.dx * k, dy = lookPend.dy * k;
  lookPend.dx -= dx; lookPend.dy -= dy;
  if (Math.abs(lookPend.dx) < 0.01) lookPend.dx = 0;
  if (Math.abs(lookPend.dy) < 0.01) lookPend.dy = 0;
  if (follow.on) {
    follow.yawOff += dx * 0.005;
    cam.pitch = Math.max(-1.5, Math.min(1.55, cam.pitch + dy * 0.005));
    return;
  }
  // first-person look: rotate the view about the FIXED eye (not orbit a point)
  const eye = camEye();
  cam.yaw += dx * 0.005;
  cam.pitch = Math.max(-1.5, Math.min(1.55, cam.pitch + dy * 0.005));
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  cam.target[0] = eye[0] - cam.dist * cp * Math.cos(cam.yaw);
  cam.target[1] = eye[1] - cam.dist * sp;
  cam.target[2] = eye[2] - cam.dist * cp * Math.sin(cam.yaw);
}

/* Free-fly with inertia. Stepping the position directly while a key is held starts and stops the
 * camera instantly — that hard start/stop is most of what makes hand-flown footage look jerky; a
 * real camera has mass. Velocity chases the requested direction and coasts when you let go.
 * Behaviour is unchanged while a key is held at steady state: same top speed, same scaling. */
const flyVel = [0, 0, 0];
const FLY_ACCEL = 6.5;             // 1/s — how hard it chases the requested velocity
const FLY_DAMP = 4.0;              // 1/s — coast-down when nothing is held
function flyStep(dtSec) {
  if (follow.on || !ex) { flyVel[0] = flyVel[1] = flyVel[2] = 0; return; }
  const dt = Math.max(0.001, Math.min(0.05, dtSec));
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  // full 3D forward (along the actual look direction incl. pitch) + horizontal strafe
  const fwd = [-cp * cy, -sp, -cp * sy], right = [sy, 0, -cy];
  const v = Math.max(0.1, cam.dist * 0.15);   // speed scales with zoom; slow when close for precision
  const want = [0, 0, 0];
  if (flyKeys.has("w")) { want[0] += fwd[0]; want[1] += fwd[1]; want[2] += fwd[2]; }
  if (flyKeys.has("s")) { want[0] -= fwd[0]; want[1] -= fwd[1]; want[2] -= fwd[2]; }
  if (flyKeys.has("d")) { want[0] += right[0]; want[2] += right[2]; }
  if (flyKeys.has("a")) { want[0] -= right[0]; want[2] -= right[2]; }
  if (flyKeys.has("shift")) want[1] += 1;
  if (flyKeys.has("control")) want[1] -= 1;
  const wl = Math.hypot(want[0], want[1], want[2]);
  if (wl > 1e-6) { want[0] = want[0] / wl * v; want[1] = want[1] / wl * v; want[2] = want[2] / wl * v; }
  const k = 1 - Math.exp(-dt * (wl > 1e-6 ? FLY_ACCEL : FLY_DAMP));
  const T = cam.target;
  for (let i = 0; i < 3; i++) {
    flyVel[i] += (want[i] - flyVel[i]) * k;
    if (Math.abs(flyVel[i]) < 1e-4) flyVel[i] = 0;
    T[i] += flyVel[i] * dt;
  }
}

/* ===================== transport ===================== */
const scrub = document.getElementById("scrub");
const timelabel = document.getElementById("timelabel");
const fmtT = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
function drawScrub() {
  const w = scrub.clientWidth, h = 34;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  if (scrub.width !== w * dpr) { scrub.width = w * dpr; scrub.height = h * dpr; }
  const c = scrub.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  if (!ex) return;
  const [ra, rb] = frameRange();
  const t0r = ra * ex.dt, t1r = rb * ex.dt;
  // speed sparkline background
  c.beginPath();
  c.moveTo(0, h);
  for (let x = 0; x < w; x++) {
    const i = ra + Math.floor(x / w * (rb - ra));
    const v = ex.speed[i];
    c.lineTo(x, h - (isFinite(v) ? v / 1000 * (h - 4) : 0));
  }
  c.lineTo(w, h);
  c.closePath();
  c.fillStyle = "rgba(245,211,63,0.18)";
  c.fill();
  // lap lines
  for (const l of ex.laps) {
    const lt = l.frame * ex.dt;
    if (lt < t0r || lt > t1r) continue;
    const x = (lt - t0r) / (t1r - t0r) * w;
    c.strokeStyle = "rgba(226,58,46,0.8)"; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
  }
  // playhead
  const x = (tCur - t0r) / (t1r - t0r) * w;
  c.strokeStyle = "#FFFFFF"; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
}
function scrubTo(e) {
  const r = scrub.getBoundingClientRect();
  const [ra, rb] = frameRange();
  const t0r = ra * ex.dt, t1r = rb * ex.dt;
  tCur = t0r + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (t1r - t0r);
}
let scrubbing = false;
scrub.addEventListener("mousedown", e => { scrubbing = true; scrubTo(e); });
addEventListener("mousemove", e => { if (scrubbing) scrubTo(e); });
addEventListener("mouseup", () => { scrubbing = false; });

/* auto-hide the transport: fade + drop away when idle, reveal on activity */
(function () {
  const tp = document.getElementById("transport");
  let idle = 0;
  function poke() {
    tp.classList.remove("faded");
    clearTimeout(idle);
    idle = setTimeout(() => { if (!scrubbing && !tp.matches(":hover")) tp.classList.add("faded"); }, 2600);
  }
  window.pokeTransport = poke;                 // called when a replay loads
  addEventListener("mousemove", poke);
  addEventListener("keydown", poke);
  tp.addEventListener("mouseenter", () => { tp.classList.remove("faded"); clearTimeout(idle); });
  tp.addEventListener("mouseleave", poke);
})();

function togglePlay() {
  playing = !playing;
  document.getElementById("btnPlay").textContent = playing ? "pause" : "play";
}
document.getElementById("btnPlay").addEventListener("click", togglePlay);
document.getElementById("rate").addEventListener("change", function () { rate = +this.value; });
document.getElementById("modeSpeed").addEventListener("click", () => setMode("speed"));
document.getElementById("modeBank").addEventListener("click", () => setMode("bank"));

document.getElementById("btnLap").addEventListener("click", function () {
  lapOnly = !lapOnly;
  this.classList.toggle("on", lapOnly);
  if (ex) {
    buildGeometry();
    tCur = frameRange()[0] * ex.dt;
  }
});
document.getElementById("btnFollow").addEventListener("click", function () {
  follow.on = !follow.on;
  this.classList.toggle("on", follow.on);
  if (follow.on) {
    follow.saved = { yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, target: cam.target.slice() };
    follow.yawOff = 0;
    follow.distMul = 1;
    follow.rig.ready = false; follow.rig.eye = null; follow.rig.look = null; follow.rig.fwd = null;  // snap to car, then ease
    follow.rig.shotEye = null; follow.rig.shotAt = null;   // clear the cockpit filter too, or it eases in from a stale pose
  } else if (follow.saved) {
    cam.yaw = follow.saved.yaw; cam.pitch = follow.saved.pitch;
    cam.dist = follow.saved.dist; cam.target = follow.saved.target;
  }
});
document.getElementById("btnCar").addEventListener("click", function () {
  showCar = !showCar;
  this.classList.toggle("on", showCar);
});
document.getElementById("btnLine").addEventListener("click", function () {
  showLine = !showLine;
  this.classList.toggle("on", showLine);
});
(function () {   // time-of-day slider → timeOfDay (hours); updates the ☀/🌙 icon + HH:MM label
  const sl = document.getElementById("timeSlider"), ic = document.getElementById("timeIcon"), lb = document.getElementById("timeLabel");
  const upd = () => {
    timeOfDay = (+sl.value) / 60;
    const hh = Math.floor(timeOfDay), mm = Math.round((timeOfDay - hh) * 60);
    lb.textContent = String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
    ic.textContent = (timeOfDay >= 6 && timeOfDay < 18) ? "☀" : "🌙";
  };
  sl.addEventListener("input", upd);
  upd();
})();
/* Track lamps on/off — a look, not a debug flag.
 *
 * An unlit night run is its own thing: headlights against a black circuit, the way a track
 * with no floodlighting actually drives. The glare sprites follow the same switch, because
 * lamps that are off still hanging their glare in the air is a stranger state than either.
 *
 * It doubles as the only honest measurement of what the lamp pass costs, and that needs a
 * FIXED camera — driving to the same corner twice compares two different frames, toggling
 * in place compares the same one. Hence the key as well as the button. */
function setTrackLampsOn(on) {
  TRACK_LIGHTS_ON = on ? 1 : 0;
  const btn = document.getElementById("btnLamps");
  if (btn) btn.classList.toggle("on", !!TRACK_LIGHTS_ON);
}
(function () {   // track lamps
  const btn = document.getElementById("btnLamps");
  if (btn) btn.addEventListener("click", () => setTrackLampsOn(!TRACK_LIGHTS_ON));
})();
(function () {   // the remaster toggle — per-machine preference, like MSAA but live
  const btn = document.getElementById("btnRemaster");
  if (btn) btn.addEventListener("click", () => {
    REMASTER_ON = !REMASTER_ON;
    try { localStorage.setItem("bb_remaster", REMASTER_ON ? "on" : "off"); } catch (_) {}
    // the far cascade is a BAKE: without this the suppressed originals' solid-quad
    // shadows (or the new dapple) would survive the toggle inside it
    staticBakeTime = null;
    updateRemasterUI();
  });
})();
(function () {   // foliage policy: full → no shadows → unlit
  const btn = document.getElementById("btnTrees");
  if (!btn) return;
  const LBL = ["trees · full", "trees · no shadows", "trees · unlit"];
  btn.addEventListener("click", () => {
    TREE_MODE = (TREE_MODE + 1) % 3;
    btn.textContent = LBL[TREE_MODE];
    btn.classList.toggle("on", TREE_MODE !== 0);
    // The far cascade is baked and only redrawn when the sun moves, so without this the
    // leaf shadows already in it would survive being switched off — visibly, and looking
    // like the toggle did nothing.
    staticBakeTime = null;
    const n = sceneGroups ? sceneGroups.filter(g => g.foliage).length : 0;
    const t = sceneGroups ? sceneGroups.filter(g => g.foliage).reduce((s, g) => s + (g.tris || 0), 0) : 0;
    btn.title = `${LBL[TREE_MODE]} — ${n} foliage group(s), ${t.toLocaleString()} triangles on this track`;
  });
})();
(function () {   // cast-shadow toggle (disabled if the GPU lacks depth-texture support)
  const btn = document.getElementById("btnShadow");
  if (!shadowReady) { btn.classList.remove("on"); btn.disabled = true; btn.title = "needs WebGL2 depth textures"; return; }
  btn.addEventListener("click", function () { SHADOW_ON = !SHADOW_ON; this.classList.toggle("on", SHADOW_ON); });
})();
(function () {   // tyre marks + smoke: cycle lap (reset each lap) → keep (accumulate + fade) → off
  const btn = document.getElementById("btnTyres");
  const LBL = ["tyres · off", "tyres · lap", "tyres · keep"];
  btn.addEventListener("click", function () {
    TYRE_MODE = (TYRE_MODE + 1) % 3;
    btn.textContent = LBL[TYRE_MODE];
    btn.classList.toggle("on", TYRE_MODE !== 0);
    if (TYRE_MODE === 0) { smoke.pool.length = 0; }   // clear live particles when switched off
  });
})();
(function () {   // volume slider → master gain; icon click mutes/unmutes
  const slider = document.getElementById("volSlider"), icon = document.getElementById("volIcon");
  if (!slider) return;
  let lastNonZero = 100;
  const iconFor = v => v <= 0 ? "🔇" : v < 45 ? "🔈" : v < 80 ? "🔉" : "🔊";
  const apply = v => { if (icon) icon.textContent = iconFor(v); if (window.BBAudio) BBAudio.setVolume(v / 100); };
  slider.addEventListener("input", function () { const v = +this.value; if (v > 0) lastNonZero = v; apply(v); });
  if (icon) icon.addEventListener("click", function () {
    const cur = +slider.value;
    const v = cur > 0 ? 0 : (lastNonZero || 100);
    slider.value = v; apply(v);
  });
  apply(+slider.value);
})();
(function () {   // the CSP bridge — offered, never installed behind the user's back
  /* The turbine's afterburner is a button in CSP's extended physics that AC's shared memory never
   * exposes, so a replay can only carry it if this small app was running while you drove. That
   * means writing into the user's Assetto Corsa folder, which is theirs — so this asks, states
   * exactly where it will write, and does nothing until clicked. Nothing here affects existing
   * replays; it changes what future ones record. */
  /* Deferred to a task, NOT run at parse time: `inTauri` is a `const` declared further down this
   * same script, so touching it from here during parse throws a temporal-dead-zone ReferenceError —
   * which aborts the WHOLE inline script and takes the track browser down with it (symptom: the app
   * opens on the bare drop-a-file screen instead of the track menu). Anything added near the top
   * that reads app state must wait until the script has finished running. */
  setTimeout(bridgeChip, 0);
  function bridgeChip() {
  const chip = document.getElementById("chipBridge");
  if (!chip || !inTauri) return;
  const show = html => { chip.innerHTML = html; chip.classList.remove("hidden"); };
  const check = async () => {
    let s;
    try { s = await tinvoke("bridge_status"); } catch (e) { return; }   // no AC install → nothing to offer
    if (s.installed && s.current) { chip.classList.add("hidden"); return; }
    const verb = s.installed ? "UPDATE" : "INSTALL";
    show(`TURBINE TELEMETRY — the afterburner button lives in CSP's extended physics and is invisible to AC's shared memory, so replays can't carry it unless a small CSP app is running while you drive. <b>${verb}</b> it into <code>${esc(s.path)}</code>? <button id="btnBridge">${verb.toLowerCase()} bridge</button> <span class="dim">then enable "BLACKBOX Bridge" in CSP's app list. Existing replays are unaffected.</span>`);
    const b = document.getElementById("btnBridge");
    if (b) b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const path = await tinvoke("install_bridge");
        show(`Bridge installed to <code>${esc(path)}</code> — enable <b>BLACKBOX Bridge</b> in CSP's app list, then drive. Replays saved after that carry turbine and afterburner data.`);
      } catch (e) { show("bridge install failed: " + esc(String(e))); }
    });
  };
  check();
  }
})();
(function () {   // auto-hide the header + the top-right "drag look" help: fade them out when the pointer is idle, bring them back on activity
  const header = document.querySelector("header");
  if (!header) return;
  const faders = [header, document.getElementById("help")].filter(Boolean);
  let t = null;
  const IDLE_MS = 2600;
  const setFaded = on => faders.forEach(el => el.classList.toggle("faded", on));
  const wake = () => {
    setFaded(false);
    if (t) clearTimeout(t);
    t = setTimeout(() => setFaded(true), IDLE_MS);
  };
  ["pointermove", "pointerdown", "keydown", "wheel"].forEach(ev => addEventListener(ev, wake, { passive: true }));
  // never fade while the pointer is actually over one of them (mid-adjustment / reading the keys)
  faders.forEach(el => {
    el.addEventListener("pointerenter", () => { if (t) clearTimeout(t); setFaded(false); });
    el.addEventListener("pointerleave", wake);
  });
  wake();
})();
(function () {   // windowed fullscreen — Tauri borderless-fullscreen (no exclusive mode switch); F11 or the ⛶ button
  const twin = (window.__TAURI__ && window.__TAURI__.window) ? window.__TAURI__.window : null;
  async function toggle() {
    try {
      if (twin) {
        const w = twin.getCurrentWindow ? twin.getCurrentWindow() : twin.appWindow;
        await w.setFullscreen(!(await w.isFullscreen()));
      } else if (!document.fullscreenElement) {      // browser fallback (dev in a plain browser)
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (e) { console.warn("[fullscreen]", e); }
  }
  const btn = document.getElementById("btnFull");
  if (btn) btn.addEventListener("click", toggle);
  addEventListener("keydown", e => { if (e.key === "F11") { e.preventDefault(); toggle(); } });
})();
function setMode(m) {
  colorMode = m;
  document.getElementById("modeSpeed").classList.toggle("on", m === "speed");
  document.getElementById("modeBank").classList.toggle("on", m === "bank");
  if (ex) buildGeometry();
}

/* ===================== file loading ===================== */
const drop = document.getElementById("drop");
const droperr = document.getElementById("droperr");
const filepick = document.getElementById("filepick");
const trackpick = document.getElementById("trackpick");
document.getElementById("btnOpen").addEventListener("click", () => filepick.click());
document.getElementById("btnOpen2").addEventListener("click", () => filepick.click());
document.getElementById("btnTrack").addEventListener("click", () => trackpick.click());
filepick.addEventListener("change", () => { if (filepick.files[0]) loadFile(filepick.files[0]); });
trackpick.addEventListener("change", () => { if (trackpick.files[0]) loadTrack(trackpick.files[0]); });
addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("dragging"); });
addEventListener("dragleave", () => drop.classList.remove("dragging"));
addEventListener("drop", e => {
  e.preventDefault(); drop.classList.remove("dragging");
  for (const f of e.dataTransfer.files) {
    if (/\.kn5$/i.test(f.name)) loadTrack(f);
    else loadFile(f);
  }
});

/* ---- tracks-folder persistence (File System Access API) ---- */
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("blackbox", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise(res => {
      const g = db.transaction("kv", "readonly").objectStore("kv").get(key);
      g.onsuccess = () => res(g.result || null);
      g.onerror = () => res(null);
    });
  } catch (e) { return null; }
}
async function idbSet(key, val) {
  try {
    const db = await idbOpen();
    await new Promise(res => {
      const p = db.transaction("kv", "readwrite").objectStore("kv").put(val, key);
      p.onsuccess = res; p.onerror = res;
    });
  } catch (e) { /* non-fatal */ }
}

const chipTrack = () => document.getElementById("chipTrack");
document.getElementById("btnTracksDir").addEventListener("click", async () => {
  if (!window.showDirectoryPicker) { alert("This browser lacks the File System Access API (use Chrome/Edge) — drag the kn5 in manually."); return; }
  try {
    const dir = await showDirectoryPicker();
    await idbSet("tracksDir", dir);
    if (replay && !sceneGroups && !bufs.trackIdxN) maybeAutoLoadTrack(replay.track);
    else chipTrack().textContent = "tracks folder saved — future replays auto-load their track";
  } catch (e) { /* user cancelled */ }
});
document.getElementById("btnStandIn").addEventListener("click", () => buildStandInTrack());

