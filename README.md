# BLACKBOX

3D telemetry viewer for Assetto Corsa replays. The replay file **is** the black
box: BLACKBOX parses `.acreplay` v16 binaries directly — no game running, no
telemetry app needed — and reconstructs position, speed, lap times, and the
road surface itself (banking read from the four wheel contact points).

## Run it

Open `ui/index.html` in any browser. Drop a `.acreplay` from
`Documents\Assetto Corsa\replay\` onto the window.

- **drag** — orbit · **wheel** — zoom · **right-drag** — pan
- **speed / banking** — recolor the ribbon by what you did vs what the road did
- **follow car** — a chase camera that rides the car through the run
- **line** — toggle the driven-line ribbon on/off
- timeline scrubber replays the run; red ticks are lap-line crossings

Sample replays ship in `samples/` — see `samples/README.md`. A replay carries the
cars' motion, **not the world**, so you also need the matching track installed in
Assetto Corsa or the car drives over empty space. `samples/TRACK_FROM_REPLAY.md`
specs a way around that, rebuilding a surface from the replay's own wheel data;
it is written up but not built, and open to anyone who wants it.

Zero runtime dependencies. The viewer is `ui/index.html` + `ui/acreplay.js`
(parser). A sample replay ships in `samples/` — run the Node smoke test on it:

```
node test_parse.js samples/centrifuge.acreplay
```

## How the parser works (the interesting part)

The documented v16 layout is used for the header and car strings, but real
files (CSP-era) disagree with the documented frame stride, so frames
**self-calibrate**:

1. frame stride found by byte autocorrelation over the car's data block
2. position phase found by scanning for a float32 triple that moves like a car
   (finite, continuous, all three axes alive) *and* has the wheel-quad echo at
   +92 bytes — the car's own rigid geometry is the checksum
3. probe runs in the middle third of the block (spawn frames can be stationary)
4. lap times come from the u32 millisecond sawtooth at phase −64; road banking
   from the plane of the four wheel positions at +92

## Known limitations

- Online multi-car autosaves (`AC_*_O_*`) store cars differently (car block is
  zeroed/interleaved) and can teleport the car between frames; the wheel-derived
  heading is also noisier there. Handled defensively but not fully supported.
- Gas/brake/gear live in a zlib CSP appendix, not yet parsed.
- Speed is position-derived (float32, clean); the float16 velocity channel is
  ignored on purpose.

## The real road (kn5)

Drop the track's `.kn5` (from `content\tracks\<track>\`) into the window too:

- `kn5.js` parses the model and keeps only the physical road meshes
  (leading-digit + surfaces.ini KEY convention) — the real track renders under
  your line.
- `roadedge.js` finds the road's boundary edges and the HUD reads out your live
  distance-to-edge; the `test_edgecoach.js` pipeline prints closest-brush tables
  and climb margins.

## Follow camera

A chase camera built in the car's own local frame (right / up = road-normal /
back = heading), so it stays locked on the car through loops, spirals, and
banking. It tracks the car rigidly (no positional lag at speed), chases the
direction of travel, keeps the car pinned on-screen by construction, and springs
its boom around solid track geometry so it doesn't clip through the world. FOV
widens and the framing tilts up the road as it closes in.

## Run as an app (native, Tauri)

`src-tauri/` is a Tauri 2 shell around the same `ui/` web app (which still opens
in any browser directly — the zero-dep soul is intact).

- **Desktop shortcut** `BLACKBOX.lnk` → `launch-blackbox.vbs` (windowless):
  launches `target/release/blackbox.exe` **instantly** — no build on launch.
  New versions are compiled at build time (`cargo tauri build`).
- **Native features** (auto-detected via the global Tauri API): a fullscreen
  track browser built from AC's shipped `ui_track.json` + `preview.png` (with a
  layout map rasterized from the road geometry and, where present, in-game
  screenshots as wallpaper), replays auto-listed per track, and a replay's track
  fetched straight from the Steam AC install (`find_track` parses
  `libraryfolders.vdf`). No folder prompts.
- **Dev**: `cd src-tauri && cargo tauri dev`. **Rust tests**: `cargo test --lib`.

Requires the Rust toolchain (cargo) + WebView2 (ships with Win10/11).

## Ideas / next

- Sign the edge metric by side (outside vs inside of the racing line).
- Edge-distance trace panel + brush markers in the viewer.
- Airtime detection (ballistic signature) → ghost "flight" ribbon.
- Lap-vs-lap ghost comparison (two files or two laps overlaid).
- Cast shadows (shadow mapping) for the 3D scene.
