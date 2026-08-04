/* perf.js — instrumentation: GPU timers, cull stats, the frame-time meter, display-Hz polling and spike attribution.
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

/* ===================== main loop ===================== */
let lastTs = 0;
/* Frame rate, measured honestly.
 *
 * This used to smooth the INSTANTANEOUS RATE: fps += (1000/dt - fps) * k. That reads high
 * and cannot not: rate is 1/dt, dt jitters, and mean(1/dt) > 1/mean(dt) for any
 * non-constant dt (Jensen). Measured in test_fpsmeter.js: frames averaging a true 144 fps
 * report 174 at +/-3 ms of jitter, and a stuttering real 48 reports as 64. A single
 * duplicate timestamp, clamped by Math.max(0.1, dt), was one sample worth 10,000 fps and
 * spiked the display to 932.
 *
 * Smoothing the FRAME TIME and inverting once at the end has no such bias. The worst frame
 * over the last second is tracked too, because that is what the eye actually notices — a
 * mean of 360 with a 20 ms hitch in it looks like a stutter, and a mean alone hides it. */
/* PER-PASS GPU TIME. The frame meter above says a frame cost 6.7 ms; it cannot say which
 * pass spent it, and three separate optimizations on this project have now been aimed by
 * inference rather than measurement (two helped, one — foliage on sakura — did nothing).
 * A CPU timer cannot answer it either: GL calls return long before the GPU has drawn them.
 *
 * EXT_disjoint_timer_query_webgl2 is the only honest instrument. Its rules shape this code:
 * exactly ONE TIME_ELAPSED query may be open at a time (so passes are timed in sequence,
 * which they already run in), results arrive several frames late (so completed queries are
 * drained separately from where they were started), and a GPU_DISJOINT between begin and
 * end invalidates the timing entirely (so those samples are thrown away rather than shown).
 *
 * The extension is frequently unavailable — browsers restrict it for timing-attack reasons.
 * When it is missing this degrades to nothing at all rather than to a wrong number. */
const GT = (function () {
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  if (!ext) return { ok: false, begin() {}, end() {}, poll() {}, text: () => "",
                     tick() {}, frame: () => 0, gpuForFrame: () => null };
  const inflight = [], ms = new Map();
  let active = null;
  /* RAW totals, per frame, unsmoothed — for spike attribution.
   *
   * The `ms` map above is an EMA, which is right for a steady HUD reading and useless for
   * finding a stall: a single 12 ms frame in a 2 ms stream moves a 0.1-weighted average by
   * one millisecond and vanishes. A spike has to be read raw.
   *
   * Keyed by FRAME NUMBER because these results arrive late. A timer query is asynchronous
   * — the answer for frame N typically resolves several frames afterwards — so reading
   * "the GPU time" at the moment a spike is noticed reports some earlier frame's work and
   * attributes it to the wrong one. Each query carries the frame it was begun on, and the
   * spike log fills its GPU column in when the answer actually arrives. */
  const rawByFrame = new Map();
  let frameNo = 0;
  return {
    ok: true,
    tick() {
      frameNo++;
      // keep a short tail; a spike is inspected within a second or two of happening
      if (rawByFrame.size > 600) {
        for (const k of rawByFrame.keys()) { if (k < frameNo - 600) rawByFrame.delete(k); }
      }
    },
    frame() { return frameNo; },
    gpuForFrame(f) { const v = rawByFrame.get(f); return v === undefined ? null : v; },
    begin(name) {
      if (active) return;                       // one at a time, per the extension
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      active = { name, q, f: frameNo };
    },
    end() {
      if (!active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      inflight.push(active); active = null;
    },
    poll() {
      // in order: a query completes no earlier than one begun before it
      while (inflight.length) {
        const f = inflight[0];
        if (!gl.getQueryParameter(f.q, gl.QUERY_RESULT_AVAILABLE)) break;
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
          const v = gl.getQueryParameter(f.q, gl.QUERY_RESULT) / 1e6;   // ns → ms
          const p = ms.get(f.name);
          ms.set(f.name, p ? p + (v - p) * 0.1 : v);
          rawByFrame.set(f.f, (rawByFrame.get(f.f) || 0) + v);
        }
        gl.deleteQuery(f.q); inflight.shift();
      }
    },
    text() {
      if (!ms.size) return "";
      return " · " + [...ms.entries()].sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v.toFixed(2)}`).join(" ");
    },
  };
})();
/* How many chunks survived culling, for the HUD. Reported rather than assumed: a culling
 * system that silently rejects nothing looks exactly like one that works, and the first
 * question about any of this is "is it actually skipping anything". */
const cullStat = { track: 0, shadow: 0, far: -1, bakes: 0, total: 0, trees: 0, treesTotal: 0 };
const matOrder = [];   // material name -> palette index, stable across frames
/* Persistent draw-order machinery for the lit pass — see the FRONT-TO-BACK note at the
 * call site. Split once per track (the translucent tail never changes), sort only the
 * opaque head, reuse one ordered array so a 240 Hz loop allocates nothing per frame. */
let _sgRef = null, _sgOpaque = [], _sgOrdered = [];
let _lm = {};   // last-bound material state, reset each lit pass — see the elision note in the loop
function sortedSceneGroups(eye) {
  if (_sgRef !== sceneGroups) {
    _sgRef = sceneGroups;
    _sgOpaque = sceneGroups.filter(g => !g.translucent);
    const matI = new Map();
    for (const g of _sgOpaque) { if (!matI.has(g.matName)) matI.set(g.matName, matI.size); g._matI = matI.get(g.matName); }
    _sgOrdered = _sgOpaque.concat(sceneGroups.filter(g => g.translucent));
  }
  for (const g of _sgOpaque) {
    const c = g.centre;
    if (c) { const dx = c[0]-eye[0], dy = c[1]-eye[1], dz = c[2]-eye[2]; g._d2 = dx*dx+dy*dy+dz*dz; }
    else g._d2 = 0;   // boundless groups draw first; they were never cullable anyway
  }
  /* BAND then MATERIAL, not raw distance. Raw distance interleaves materials, which costs
   * a texture bind + uniform refresh per chunk — the elision cache in the lit loop only
   * pays off when consecutive chunks share state. 150 m bands keep the early-z benefit
   * (a canopy 400 m behind another still draws after it) while chunks within a band group
   * by material and mostly skip their state changes. */
  for (const g of _sgOpaque) g._band = Math.floor(Math.sqrt(g._d2) / 150);
  _sgOpaque.sort((a, b) => a._band - b._band || a._matI - b._matI || a._d2 - b._d2);
  for (let i = 0; i < _sgOpaque.length; i++) _sgOrdered[i] = _sgOpaque[i];
  return _sgOrdered;
}
let frameMsEMA = 0, fpsPrev = 0, frameMsWorst = 0, frameWorstAt = 0;

/* THE PANEL, ASKED RATHER THAN GUESSED.
 *
 * A frame is "fast enough" only relative to what the display is asking for, and the web
 * platform has no way to find that out — no refresh-rate API, so the usual trick is timing
 * requestAnimationFrame and calling the result the refresh rate. That inference is only
 * valid while the GPU keeps up; the moment it does not, it measures the render loop and
 * reports it as the panel. The native side just asks Windows, and gets an exact answer.
 *
 * It is polled, not read once, for two reasons that are both real on this machine: the
 * window can be dragged between a 360 Hz panel and a 60 Hz one — six times the frame budget
 * for the identical scene — and the refresh rate itself can be changed in Windows while the
 * app is open. Three Win32 calls every two seconds is not a cost worth optimising.
 *
 * 0 means UNKNOWN and must stay distinguishable from a real value. Substituting 60 would
 * manufacture a budget that is confidently wrong, and every reading derived from it would
 * inherit the error while looking measured. */
let displayHz = 0, displayName = "";
/* The budget is what THIS RUN is actually trying to hit, not what the panel could do. Under
 * the 60 Hz diagnostic cap the target is 16.667 ms, and reporting 2.778 made a perfectly
 * smooth capped run read as "4682 spikes out of 4682 frames" — every drawn frame counted as a
 * spike against a budget it was never aiming at. True numbers, useless label, and that exact
 * shape has already cost this investigation a night. */
function frameBudgetMs() {
  if (!displayHz) return 0;
  return (1000 / displayHz) * CAP_DIV;
}
async function refreshDisplayInfo() {
  if (!TAURI) return;
  try {
    const d = await tinvoke("display_info");
    displayHz = (d && d.hz) || 0;
    displayName = (d && d.monitor) || "";
  } catch (_) { displayHz = 0; displayName = ""; }
}
if (TAURI) { refreshDisplayInfo(); setInterval(refreshDisplayInfo, 2000); }
let bfPrevFrame = -1;   // last frame audio saw, for firing backfire cracks on shift-frame crossings

/* SPIKE ATTRIBUTION.
 *
 * A worst-frame number tells you a stall happened and nothing about what caused it, which
 * is the position every guess starts from. On a 360 Hz panel the budget is 2.78 ms, so a
 * 14 ms frame is not slow rendering — it is five frames' worth of something, and the useful
 * question is WHICH something.
 *
 * The decisive split is CPU versus GPU, because they have opposite causes and the fix for
 * one does nothing for the other:
 *
 *   GPU time also spiked  -> the graphics card genuinely did more work that frame. A
 *                            shadow re-bake, a sudden pile of geometry, an upload.
 *   GPU time stayed flat  -> nothing was rendered that wasn't rendered every other frame,
 *                            and the CPU was blocked. Garbage collection, a synchronous
 *                            readback, a texture decode, the driver, the compositor.
 *
 * Without that split, "it stutters" sends you optimising draw calls when the answer is an
 * allocation, and there is no way to tell from the outside. So every spike records both,
 * plus the per-frame counters that name the usual periodic suspects.
 *
 * Kept to the last 12, printed on demand rather than streamed: a spike log that itself
 * allocates every frame would be the very thing it is hunting. */
const SPIKE_FACTOR = 1.8;                 // over this multiple of budget = worth recording
const spikeLog = [];

/* MISSED VSYNCS, because an average frame time lies under vsync.
 *
 * With vsync on, a frame lasts one refresh period or two — 2.78 ms or 5.56 ms on a 360 Hz
 * panel, never 2.9. So an average of 2.9 does NOT mean "4% too slow everywhere", which is
 * what a budget percentage implies and would send anyone hunting for 4% to shave. It means
 * on budget almost always and DOUBLED occasionally: 24 frames at 2.78 plus one at 5.56
 * averages 2.89. The average is the artefact; the dropped frame is the event.
 *
 * So this counts events. `missed` is how many refresh periods were lost in the last second —
 * 0 is a clean second, and each unit is one visible hitch. That number is actionable in a
 * way a percentage never is. */
let vsyncMissed = 0, vsyncMissedShown = 0, vsyncWindowAt = 0;
/* CUMULATIVE, because "does this divider stutter" is a question about the whole run and the
 * per-second figure answers only about the last second. A rung that drops one frame a minute
 * reads 0/s almost every time it is looked at, and that single dropped frame is exactly the
 * transient stutter the divider is being chosen to eliminate. Zero here over a long run is
 * the only form the criterion can take. */
let vsyncMissedTotal = 0, vsyncFramesLate = 0;
/* Allocation accounting — summed in the frame loop, reported below. Positive deltas only;
 * see the note at the call site for why a collection must not cancel the garbage that
 * caused it. */
let allocBytes = 0, allocPrevHeap = 0, allocSince = 0;
let lastSimSteps = 0;          // smoke/air sim steps taken on the frame just drawn
/* How long those steps took. Declared here beside the count and written by smokesim.js, the
 * same split lastSimSteps already uses. Without it the table can say a spike landed on a sim
 * frame but not whether the sim WAS the frame — and the burst openers on 2026-08-04 read
 * "our JS ran long" at 5.7-5.9 ms cpu with no way to say which of our JS. */
let lastSimMs = 0;
let simFrames = 0, simSpikes = 0, allFrames = 0, allSpikes = 0;   // for the correlation readout
let simMsTotal = 0, simMsWorst = 0, simStepsWorst = 0;            // and for the sim's cost, not just its incidence
/* THE VSYNC DIVIDER (Shift+6 cycles it). The presentation rate is not a free parameter: rAF
 * fires on vsync, so the only rates a panel can actually HOLD are refreshHz/n. Ask for 240 on
 * a 360 Hz panel and frames land on a 1.5-vsync cadence — 2.78, 5.56, 2.78, 5.56 — which
 * judders worse than a locked 60 despite the bigger number. So the choice is which integer
 * divider to sit on, and nothing else is on offer.
 *
 * This is why the cap is a DIVIDER rather than a target framerate: a hardcoded 120 is
 * unreachable on a 60 Hz panel, while ÷3 means "a third of whatever this machine has" and is
 * correct everywhere. Caring about the divider is what lets the app stop caring about the
 * user's refresh rate.
 *
 * 1 = uncapped, the default — nothing changes for anyone who never presses the key.
 * Counted in vsyncs rather than milliseconds because the timestamps jitter ±0.15 ms and a
 * millisecond threshold would occasionally admit or drop a frame at the boundary. */
const CAP_DIVS = [1, 2, 3, 4, 6];
let CAP_DIV = 1, _capTick = 0;
function resetPerfStats() {
  frameMsEMA = 0; fpsPrev = 0; frameMsWorst = 0; frameWorstAt = 0;
  simFrames = 0; simSpikes = 0; allFrames = 0; allSpikes = 0;
  simMsTotal = 0; simMsWorst = 0; simStepsWorst = 0;
  spikeLog.length = 0;
  vsyncMissed = 0; vsyncMissedShown = 0; vsyncWindowAt = 0;
  vsyncMissedTotal = 0; vsyncFramesLate = 0;
  allocBytes = 0; allocPrevHeap = 0; allocSince = 0;
}
let cpuMsPrev = 0;                        // wall time inside our own frame body, last frame
let bakesPrev = 0;                        // so a spike can report whether a bake ran THAT frame
function recordSpike(ts, dtMs) {
  spikeLog.push({
    at: +(ts / 1000).toFixed(1),
    frameMs: +dtMs.toFixed(2),
    // our own JS body. If this is ~0 and the frame was 14 ms, the stall was NOT our code
    // running long — it was our code being suspended, or the GPU, or the compositor.
    cpuMs: +cpuMsPrev.toFixed(2),
    gpuMs: null,                          // filled in when the timer query resolves
    _frame: GT.ok ? GT.frame() - 1 : -1,   // the frame this spike measured
    bakedThisFrame: cullStat.bakes !== bakesPrev,
    sim: lastSimSteps,                    // how many 60 Hz sim steps ran on this frame — >1 means catch-up
    simMs: +lastSimMs.toFixed(2),         // and how much of the frame they were
    chunks: cullStat.track + "+" + cullStat.shadow,
    trees: cullStat.trees,
    smoke: smoke.pool.length,
    air: AIR.cells.size,
    cars: 1 + (typeof ghostDraws !== "undefined" ? ghostDraws.length : 0),
    // Chrome-only. When present, a jump here across a flat-GPU spike is the signature of a
    // collection rather than a guess at one; when absent it is null, not zero.
    heapMB: (performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null),
  });
  bakesPrev = cullStat.bakes;
  if (spikeLog.length > 12) spikeLog.shift();
}
/**
 * Print the spike log. Call `spikes()` in the devtools console (Ctrl+Shift+I).
 *
 * The verdict column is the point of the whole instrument. GPU time and wall time spiking
 * TOGETHER means the card genuinely did more work — a re-bake, an upload, a pile of
 * geometry. Wall time spiking while GPU time stays flat means nothing extra was rendered
 * and the CPU was blocked: garbage collection, a synchronous readback, a shader compile, a
 * texture decode, the driver, the compositor. The two have no fixes in common, and without
 * this split there is no way to tell them apart from the outside.
 */
function spikeVerdict(s) {
  if (s.gpuMs === null) return "gpu timing pending";
  if (s.gpuMs > s.frameMs * 0.5) return "GPU did the work";
  if (s.cpuMs > s.frameMs * 0.5) return "our JS ran long";
  return "CPU STALLED — not our code";
}
/** Fill in GPU columns for any spike whose timer query has since resolved. */
function resolveSpikes() {
  GT.poll();
  for (const s of spikeLog) {
    if (s.gpuMs === null && s._frame >= 0) {
      const g = GT.gpuForFrame(s._frame);
      if (g !== null) s.gpuMs = +g.toFixed(2);
    }
  }
}
/* ON SCREEN, not in the console.
 *
 * The first version of this printed a console.table, which is unreachable: tauri is built
 * without the devtools feature, so a release build has no console at all and Ctrl+Shift+I
 * does nothing. An instrument the person holding the machine cannot open is not an
 * instrument. Toggle with P; it is also screenshottable, which is how this one actually
 * gets read. */
const spikePanel = document.getElementById("spikepanel");
let SPIKES_SHOWN = false;
function renderSpikePanel() {
  if (!SPIKES_SHOWN || !spikePanel) return;
  resolveSpikes();
  const bud = frameBudgetMs();
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  let out = `<span class="hdr">panel ${displayHz || "?"}Hz · budget ${bud ? bud.toFixed(2) : "?"}ms · ` +
            `recording over ${bud ? (SPIKE_FACTOR * bud).toFixed(2) : "?"}ms · ${spikeLog.length} spikes</span>\n`;
  /* THE VERDICT LINE. The smoke/air sim is fixed at 60 Hz while the render loop runs at the
   * panel rate, so at 360 Hz one frame in six does a sim step and five do none. If spikes
   * land on sim frames far more often than that base rate, the cause is the sim's
   * allocation burst; if they track the base rate, it is somewhere else and the audit's
   * headline finding is not this stall. Stated as both numbers so the comparison is
   * visible rather than asserted. */
  /* Both counters run over every frame since load. An earlier version of this line divided
   * simSpikes (all spikes ever) by spikeLog.length (the last twelve), which are different
   * populations and produce a ratio that means nothing — the exact kind of confident wrong
   * number this panel exists to prevent. */
  if (allFrames > 0 && allSpikes > 0) {
    const base = 100 * simFrames / allFrames;          // how often a sim frame occurs at all
    const onSim = 100 * simSpikes / allSpikes;         // how often a spike lands on one
    const judged = allSpikes >= 8;
    const verdict = !judged ? "  (need 8+ spikes to judge)"
      : onSim > base * 2 ? "  <span class=\"hot\">← SIM CORRELATED</span>"
      : "  <span class=\"cool\">← not the sim</span>";
    out += `<span class="hdr">sim runs on ${base.toFixed(1)}% of frames · ` +
           `${onSim.toFixed(0)}% of spikes land there (${simSpikes}/${allSpikes})${verdict}</span>\n`;
  }
  if (!spikeLog.length) {
    spikePanel.innerHTML = out + "\nnothing has exceeded the budget yet";
    return;
  }
  out += `<span class="hdr">${"at".padStart(7)}${"frame".padStart(8)}${"cpu".padStart(7)}` +
         `${"gpu".padStart(7)}${"sim".padStart(4)}${"simMs".padStart(7)}  ${"bake".padStart(4)} ${"chunks".padStart(9)} ${"trees".padStart(5)} ` +
         `${"smk".padStart(4)} ${"heapMB".padStart(7)}  verdict</span>\n`;
  for (const s of spikeLog.slice().reverse()) {
    const v = spikeVerdict(s);
    const cls = v.startsWith("CPU STALLED") ? "hot" : (v.startsWith("GPU") ? "cool" : "");
    out += `${String(s.at).padStart(7)}${s.frameMs.toFixed(2).padStart(8)}` +
           `${s.cpuMs.toFixed(2).padStart(7)}${(s.gpuMs === null ? "—" : s.gpuMs.toFixed(2)).padStart(7)}` +
           `${(s.sim > 0 ? "x" + s.sim : "-").padStart(4)}${(s.sim > 0 ? (s.simMs || 0).toFixed(2) : "-").padStart(7)}` +
           `  ${(s.bakedThisFrame ? "YES" : "-").padStart(4)} ${esc(s.chunks).padStart(9)} ` +
           `${String(s.trees).padStart(5)} ${String(s.smoke).padStart(4)} ` +
           `${(s.heapMB === null ? "—" : s.heapMB.toFixed(0)).padStart(7)}  <span class="${cls}">${v}</span>\n`;
  }
  spikePanel.innerHTML = out;
}
addEventListener("keydown", (e) => {
  if (e.key !== "p" && e.key !== "P") return;
  if (e.target && /input|textarea/i.test(e.target.tagName)) return;   // not while typing
  SPIKES_SHOWN = !SPIKES_SHOWN;
  if (spikePanel) spikePanel.style.display = SPIKES_SHOWN ? "block" : "none";
  renderSpikePanel();
});
/* Shift+6 toggles the 60 Hz diagnostic cap. Matched on e.code, not e.key: with Shift held,
 * "6" reports as "^" on a US layout and as something else again elsewhere, so keying off the
 * character would work on this machine and quietly fail on another. */
addEventListener("keydown", (e) => {
  if (e.code !== "Digit6" || !e.shiftKey) return;
  if (e.target && /input|textarea/i.test(e.target.tagName)) return;
  CAP_DIV = CAP_DIVS[(CAP_DIVS.indexOf(CAP_DIV) + 1) % CAP_DIVS.length];
  _capTick = 0;
  resetPerfStats();               // samples taken at different dividers must never share an average
  console.log(`[perf] vsync divider ÷${CAP_DIV} = ${displayHz ? (displayHz / CAP_DIV).toFixed(0) : "?"} Hz ` +
              `· budget ${frameBudgetMs().toFixed(2)} ms — stats cleared`);
  renderSpikePanel();             // the panel header carries the state; see perfReport()
});
// still available from a dev build's console, where one exists
window.spikes = function () { resolveSpikes(); console.table(spikeLog.map(s => ({ ...s, verdict: spikeVerdict(s) }))); };

/* THE SAME REPORT, WRITTEN TO DISK.
 *
 * Every version of this instrument so far has needed a human as the courier — read the
 * console, or press P and screenshot the panel — and the reading that decides the diagnosis
 * needs eight samples plus a base rate, caught during a hitch nobody can schedule. Asking
 * repeatedly for that reading is a design failure, not an impatience problem.
 *
 * So the app writes it. The web side cannot touch the filesystem; the native side can, and
 * this is exactly the sort of thing that native shell is for.
 *
 * Only while spikes are actually accruing, and only when the count has changed, so an idle
 * session does no disk I/O at all. Whole-file overwrite of a bounded ring — a history would
 * grow without limit and tell us nothing the last twelve do not. */
let _perfWroteAt = 0, _perfLastCount = 0;   // 0 = nothing written yet; see the liveness note
function perfReport() {
  const bud = frameBudgetMs();
  const L = [];
  L.push(`blackbox perf — panel ${displayHz || "?"} Hz (${displayName || "unknown monitor"})`);
  L.push(`budget ${bud ? bud.toFixed(3) : "?"} ms · spike threshold ${bud ? (bud * SPIKE_FACTOR).toFixed(2) : "?"} ms`);
  L.push(`frames ${allFrames} · spikes ${allSpikes} · missed periods last second ${vsyncMissedShown}`);
  L.push(`ema ${frameMsEMA.toFixed(3)} ms · worst(1s) ${frameMsWorst.toFixed(2)} ms`);
  /* Stated in the report rather than left to be remembered. A capped run and an uncapped run
   * produce files that look alike apart from the numbers, and a diagnostic reading applied to
   * the wrong one is worse than no reading — it would say the stutter was fixed. */
  if (CAP_DIV > 1) L.push(`*** VSYNC DIVIDER ÷${CAP_DIV} = ${(displayHz / CAP_DIV).toFixed(0)} Hz — this is not a panel-rate run ***`);
  /* THE VERDICT ON A DIVIDER, in the terms the choice is actually made in: a rung "works" if
   * it never drops a frame, not if it averages well. One late frame a minute is invisible in
   * an EMA and is precisely the transient stutter being hunted. */
  {
    const mins = allFrames && frameMsEMA ? (allFrames * frameMsEMA) / 60000 : 0;
    L.push(`late frames ${vsyncFramesLate} · periods lost ${vsyncMissedTotal} total` +
           (mins > 0.2 ? ` over ${mins.toFixed(1)} min → ${(vsyncFramesLate / mins).toFixed(1)}/min` : "") +
           (vsyncFramesLate === 0 ? "   ← CLEAN at this divider" : ""));
  }
  /* WHAT THE CONTEXT ACTUALLY GRANTED, not what was asked for. `desynchronized` and
   * `powerPreference` are HINTS — the UA may ignore either. A run read as "the low-latency
   * path did not help" when it was never granted would be a false negative on the only lever
   * this app has over presentation, so the state is read rather than assumed. */
  /* THE NUMBER THAT NAMES THE CULPRIT. If this is large, the stalls are collections and the
   * garbage is ours — regardless of what the per-spike verdict column says, because that
   * column cannot see a stopped world. If it is near zero and the stalls persist, GC is
   * genuinely excluded and the dead air is somebody else's. */
  if (performance.memory && allocSince) {
    const secs = (performance.now() - allocSince) / 1000;
    const mbs = secs > 0 ? (allocBytes / 1048576) / secs : 0;
    const perFrame = allFrames > 0 ? allocBytes / allFrames / 1024 : 0;
    L.push(`allocation · ${mbs.toFixed(1)} MB/s · ${perFrame.toFixed(1)} KB/frame · heap now ${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)} MB`);
  } else {
    L.push("allocation · not measurable (performance.memory unavailable — not Chromium)");
  }
  try {
    const a = (typeof gl !== "undefined" && gl.getContextAttributes) ? gl.getContextAttributes() : null;
    if (a) L.push(`ctx granted · antialias ${a.antialias} · desynchronized ${a.desynchronized} · power ${a.powerPreference || "(unreported)"}`);
    else L.push("ctx granted · (getContextAttributes unavailable)");
  } catch (e) { L.push("ctx granted · unreadable: " + e); }
  if (allFrames > 0) {
    const base = 100 * simFrames / allFrames;
    const onSim = allSpikes ? 100 * simSpikes / allSpikes : 0;
    L.push(`sim(60Hz) runs on ${base.toFixed(1)}% of frames · ${onSim.toFixed(1)}% of spikes land there (${simSpikes}/${allSpikes})`);
    if (simFrames) {
      L.push(`sim cost · mean ${(simMsTotal / simFrames).toFixed(2)} ms · worst ${simMsWorst.toFixed(2)} ms ` +
             `· most steps in one frame x${simStepsWorst} of ${4} allowed · budget ${frameBudgetMs().toFixed(2)} ms`);
    }
  }
  // isOn(), not .enabled — the flag is module-private and only exposed through the getter.
  // Reading .enabled would have quietly reported "off" forever, which is exactly the kind of
  // always-plausible wrong value this whole log exists to avoid.
  const audioOn = (typeof BBAudio !== "undefined" && typeof BBAudio.isOn === "function") ? BBAudio.isOn() : null;
  L.push(`audio ${audioOn === null ? "?" : audioOn ? "ON" : "off"} · cars ${1 + (typeof ghostDraws !== "undefined" ? ghostDraws.length : 0)}` +
         ` · smoke ${smoke.pool.length} · air ${AIR.cells.size} · trees ${cullStat.trees}/${cullStat.treesTotal}`);
  L.push("");
  L.push("      at   frame     cpu     gpu  sim   simMs  bake    chunks trees  smk   heapMB  verdict");
  for (const s of spikeLog) {
    L.push(
      String(s.at).padStart(8) + s.frameMs.toFixed(2).padStart(8) + s.cpuMs.toFixed(2).padStart(8) +
      (s.gpuMs === null ? "-" : s.gpuMs.toFixed(2)).padStart(8) +
      (s.sim > 0 ? "x" + s.sim : "-").padStart(5) + (s.sim > 0 ? (s.simMs || 0).toFixed(2) : "-").padStart(8) +
      (s.bakedThisFrame ? "YES" : "-").padStart(6) +
      String(s.chunks).padStart(10) + String(s.trees).padStart(6) + String(s.smoke).padStart(5) +
      (s.heapMB === null ? "-" : s.heapMB.toFixed(1)).padStart(9) + "  " + spikeVerdict(s));
  }
  return L.join("\n");
}
function maybeWritePerf(ts) {
  if (!TAURI) return;
  /* One write on the first frame, before any spike has happened.
   *
   * It is a liveness proof, and it exists because "the process is running" is not one. Every
   * script here shares a global scope, so a ReferenceError during parse stops the rest, the
   * error panel appears, and the window stays open looking perfectly healthy. That is the
   * exact failure the module split could introduce, and checking for a live process would
   * not have caught it. A log file with a frame count in it means the render loop reached
   * this line, which means every file parsed and every binding resolved. */
  if (!_perfLastCount) { _perfLastCount = -1; _perfWroteAt = ts; try { tinvoke("write_perf_log", { body: perfReport() }); } catch (_) {} return; }
  if (!allSpikes) return;
  if (allSpikes === _perfLastCount) return;      // nothing new happened
  if (ts - _perfWroteAt < 3000) return;          // at most every three seconds
  _perfWroteAt = ts; _perfLastCount = allSpikes;
  resolveSpikes();
  try { tinvoke("write_perf_log", { body: perfReport() }); } catch (_) {}
}

/* HUD throttle clock — see the note at its use site in index.html. Lives here because the
 * frame loop's own scope is rebuilt per call and this must persist across frames. */
let _hudAt = 0;
