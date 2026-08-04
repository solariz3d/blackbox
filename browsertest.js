#!/usr/bin/env node
/* browsertest.js — serve ui/ to a plain browser, with a stub for every Tauri command.
 *
 * WHY. Five candidate causes for the 360 Hz stutter have been eliminated by test: the pose
 * interpolation, the collision debounce, SMT, the second monitor, and "it's pacing not
 * stalls". The app's own instrumentation exonerates the app — on a spiking frame the JS body
 * runs ~1 ms and the GPU ~1.2 ms inside a 5.5 ms frame, so 3 ms is dead air where nothing of
 * ours is executing. Every verdict reads CPU STALLED — NOT OUR CODE, which names where the
 * time went but not whose it was.
 *
 * The one fork nobody has tested is the SHELL. Same code, same panel, same scene, rendered by
 * a plain browser instead of by WebView2 inside Tauri:
 *
 *   clean in the browser, spiky in Tauri  -> the host is the problem, and it is fixable
 *   spiky in both                         -> Chromium's presentation path on Windows is the
 *                                            ceiling, no shell change helps, and a native
 *                                            renderer is the only lever. Worth knowing BEFORE
 *                                            spending weeks on a port rather than after.
 *
 * That question has been open all night and it is answerable in about a minute.
 *
 * WHY A SHIM RATHER THAN JUST OPENING THE FILE. `tinvoke` (loaders.js:1135) dereferences
 * window.__TAURI__.core with no null guard, so outside Tauri it throws — possibly before the
 * render loop ever starts, which would give a false "the browser is broken too". The stubs
 * below answer the fifteen commands the frontend calls with the least-surprising value each,
 * so the app boots far enough to run its loop and draw its HUD.
 *
 * WHAT THIS TEST CANNOT DO, so it is not over-read: with no Assetto Corsa content and no
 * replay, the SCENE IS NOT THE SAME. Fewer draws, no track meshes, no car models. So it
 * cannot compare absolute frame times against the Tauri run. What it CAN compare is the
 * SHAPE: whether frames arrive evenly, or whether they still come in bursts of exactly-doubled
 * intervals with dead air inside them. That signature is the thing under investigation and it
 * does not need a loaded track to appear.
 *
 * Usage:  node browsertest.js        then open the printed URL in Edge or Chrome
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "ui");
const PORT = 8787;

/* The shim. Every command the frontend calls, answered with the least-surprising value.
 * `display_info` matters most — perf.js derives the frame budget from it, and a wrong
 * refresh rate would make every spike threshold wrong. */
const SHIM = `<script>
window.__TAURI__ = {
  core: { invoke: function (cmd, args) {
    switch (cmd) {
      // the only one that changes what gets MEASURED — refresh rate drives frameBudgetMs()
      case "display_info":        return Promise.resolve({ hz: 360, name: "browser-test", width: 2560, height: 1440 });
      case "write_perf_log":      return Promise.resolve("(browser test: not written)");
      // content discovery — nothing installed in this harness, so: found nothing
      case "list_tracks":
      case "list_screenshots":
      case "replays_for_track":
      case "track_light_configs": return Promise.resolve([]);
      case "find_track":
      case "find_car":
      case "find_car_bank":
      case "find_driver":
      case "track_outline":
      case "track_map_raster":    return Promise.resolve(null);
      case "read_file":           return Promise.reject(new Error("browser test: no filesystem"));
      case "bridge_status":       return Promise.resolve({ installed: false });
      case "install_bridge":      return Promise.reject(new Error("browser test: no install"));
      default:
        console.warn("[browsertest] unstubbed Tauri command:", cmd, args);
        return Promise.reject(new Error("browser test: unstubbed " + cmd));
    }
  }},
  window: null,   // controls.js already null-guards this one
};
console.log("[browsertest] Tauri shim installed — this is NOT the real app shell.");
</script>
`;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json",
                ".wasm": "application/wasm", ".ico": "image/x-icon" };

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const file = path.join(ROOT, rel);
  // never serve outside ui/
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("no"); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found: " + rel); }
    const ext = path.extname(file).toLowerCase();
    if (ext === ".html") {
      // inject the shim FIRST, before any app script can dereference __TAURI__
      let html = buf.toString("utf8");
      const at = html.search(/<script/i);
      html = at >= 0 ? html.slice(0, at) + SHIM + html.slice(at) : SHIM + html;
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(html);
    }
    res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream" });
    res.end(buf);
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`
browsertest — the same ui/ served to a plain browser, Tauri commands stubbed.

  open:  http://127.0.0.1:${PORT}/

WHAT TO LOOK FOR — read the HUD, and press P for the spike panel:

  · the FPS/ms readout and (worst N.N)
  · "missed periods last second" in the spike panel header
  · whether spikes cluster in BURSTS of exactly-doubled frame times (5.5 ms on a
    360 Hz panel), which is the signature under investigation

COMPARE THE SHAPE, NOT THE ABSOLUTE NUMBERS. No track and no replay is loaded here,
so the scene is lighter and the frame times are not comparable to the Tauri run.
The question is whether the BURSTS of doubled intervals still happen.

  no bursts here, bursts in Tauri  ->  the WebView2 host, and it is fixable
  bursts in both                   ->  Chromium presentation on Windows is the ceiling

Ctrl+C to stop.
`);
});
