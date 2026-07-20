# Changelog

## 2026-07-20 — drone follow-cam, world collision, drift-heading fix, lighting

### Added
- Fullscreen track browser (tabbed menu, one track at a time, scroll/arrow nav)
  with the rasterized layout map + per-track in-game screenshots as wallpaper
  (`list_screenshots` Tauri command; UI matches `Screenshot_<car>_<track>_<ts>.jpg`
  to a track by longest track-folder suffix, with a unique-last-token fallback).
- Line-ribbon on/off toggle.
- Lighting pass on the 3D scene: hemisphere ambient (cool sky above → dark ground
  below) + warm directional key + a light saturation/contrast grade.

### Changed
- Follow camera rebuilt as a chase "drone": rigid car tracking (only the shape is
  smoothed, so no positional lag at speed or through corkscrews), chases the
  direction of travel, a framing solve that pins the car to a fixed on-screen spot
  from the stable heading+up basis (cannot flip), a world-geometry collider that
  springs the boom in around solid meshes, drone banking, and dynamic FOV + tilt-up
  as it closes in.

### Fixed
- Car model "switched ends" mid-drift: removed the line that re-aligned the wheel
  heading to the velocity, which flipped the car 180° whenever real slip passed 90°.
  The front-axle−rear-axle wheel vector already is the true nose; trust it.
- Online-replay robustness: parser flips isolated single-frame wheel-heading sign
  glitches (+ a global forward-majority check); follow-cam derives heading from a
  gap-free window and holds it when the car is stopped, so teleports/gaps in
  `AC_*_O_*` replays can't whip the camera.

## 2026-07-20 — track_map_raster: a SOLID top-down road map (filled, not stippled)

### Added
- `src-tauri/src/lib.rs` `track_map_raster(folder) -> tauri::ipc::Response` Tauri
  command (registered in `generate_handler!`). Where `track_outline` returns a
  scattered point cloud, this returns a filled 8-bit coverage (alpha) bitmap of
  the road viewed top-down, so the ribbon reads as one clean shape. Raw byte
  layout (all little-endian): `u32 width`, `u32 height`, `f32 minX/minZ/maxX/maxZ`
  (world metres), then `width*height` coverage bytes (255 = solid road, 0 =
  off-road), row-major, top row first, with world Z flipped so the image reads
  north-up. The frontend paints it into a canvas `ImageData` — no image/png crate.
- Road extraction now also captures TRIANGLES, not just points: new
  `read_node_mesh` / `parse_road_mesh` mirror `read_node` / `parse_road_xz` byte
  for byte but keep the previously-skipped uint16 index list, rebased by the
  running vertex count across all meshes AND all kn5 files (multi-file tracks like
  Miandros merge). Existing `track_outline` path is untouched.
- Rasterizer fills every road triangle (edge-function / barycentric test) at 4×
  supersample resolution then box-downsamples to the target — kills jaggies so the
  ribbon is a clean solid. Image size: longest world axis → 1024 px, other axis by
  aspect (capped at 1024), with ~3% padding.
- Disk cache at `%LOCALAPPDATA%\BLACKBOX\map_cache\<sanitized folder>.bin`, keyed
  by the newest kn5 mtime (u64 LE prefix + the exact response bytes), same
  discipline as `track_outline`'s cache; cache hit returns the stored buffer.
- Smoke tests `track_map_raster_centrifuge_fills` / `track_map_raster_miandros_fills`
  parse the header, assert plausible dims + bounds + coverage fraction. 11 lib
  tests green.

### Findings
- centrifuge: 1024×1024 px, bounds [-738.9, -739.4, 739.9, 739.5] (span 1478.8 ×
  1478.8 m ≈ ±740 m — matches the outline analysis), road coverage 22.8%.
- Miandros (4 kn5, merged): 998×1024 px, bounds [-250.7, -317.4, 305.3, 253.2]
  (span 555.9 × 570.6 m), road coverage 36.8%. Both bounds match `track_outline`
  exactly, confirming the triangle path extracts the same geometry as the points.

## 2026-07-20 — find_car + extractScene lod0Only: first step toward rendering the car

### Added
- `src-tauri/src/lib.rs` `find_car(car_id) -> Vec<TrackFile>` Tauri command
  (registered in `generate_handler!`). Locates a car's visual model kn5 from the
  Steam AC install (`content/cars/<car_id>/`), reusing `steam_libraries()`.
  Cars ship several kn5 (body + tiny `collider.kn5`/`driver.kn5`); it returns the
  visual body FIRST — `<car_id>.kn5` if present, else the largest kn5 in the
  folder — with any others after it. Smoke test `find_car_locates_t180_body_kn5`
  resolves `ohyeah2389_t180_mach6.kn5` (108,998,456 bytes) and asserts >100 KB.
  9 lib tests green.
- `ui/kn5.js` `extractScene(ab, { lod0Only: true })` option: keeps only LOD0
  meshes (those with `lodIn === 0`, which render from distance 0), excluding
  lower-detail LODs (`lodIn > 0`) and counting them in `stats.lodSkipped`. A mesh
  with no LOD system (`lodIn`/`lodOut` both 0) is always-visible and kept. Default
  behavior (opts absent or `lod0Only` falsy) is byte-identical to before — the
  walk is unchanged, only the previously-discarded `lodIn` is now read.
- `test_carscene.js` (Node): parses the T-180 body full vs `lod0Only`, validates
  LOD0 geometry (unit-ish normals, finite UVs, in-range indices, texture blobs)
  and prints world bounds; REGRESSION-guards centrifuge `extractScene()` at the
  captured baseline (meshCount 144, triCount 3,237,590 — unchanged). All green.

### Findings
- T-180 body full == lod0: 74 meshes, 57,696 tris, 20 material groups, 22 texture
  blobs, 3 transparent skipped, `lodSkipped=0`. All 77 class-2 meshes have
  `lodIn=0/lodOut=0`: this car uses AC's EXTERNAL LOD system (separate lod kn5 via
  `lods.ini`), not in-model per-mesh LODs — so lod0Only is a no-op here but the
  field read is verified correct.
- T-180 LOD0 local bounds: X[-1.32, 1.32] Y[0.01, 1.47] Z[-2.70, 3.30] m
  (2.65 × 1.47 × 6.00 m W×H×L). Origin is centered in X, near-zero floor in Y,
  and offset in Z (more model behind the origin than ahead).

## 2026-07-20 — track_outline: our own minimap from the road geometry

### Added
- `src-tauri/src/lib.rs` `track_outline(folder)` Tauri command → `TrackOutline
  { points: Vec<f32>, bounds: [f32;4], count: u32 }`. A top-down 2D outline of a
  track built from its PHYSICAL road meshes, so BLACKBOX can draw a minimap even
  for tracks AC didn't ship an `outline.png` for. Faithful Rust port of
  `kn5.js extractRoadMesh`: same `sc6969` header, texture-blob skip, byte-exact
  material skip, and the recursive node-tree walk (class 1 dummy matrix compose
  with row-vector convention, class 2 static mesh, class 3 skinned skip). Keeps
  only road/kerb/pit/runoff vertices (`/^[1-9]\d*(ROAD|KERB|PIT|RUNOFF)/i`),
  transformed to world X/Z (top-down), downsampled to ~5000 points normalized
  into 0..1; `bounds` are the true world-meter extents from all road verts.
  Reuses `find_track` for lookup and merges road verts across multi-file tracks.
- Disk cache at `%LOCALAPPDATA%\BLACKBOX\outline_cache\<folder>.json`, keyed by
  the newest kn5 mtime, so a 171 MB kn5 is parsed once (cache-hit path ~0.01s).
- Smoke tests `track_outline_centrifuge_from_road` /
  `track_outline_miandros_from_road`: centrifuge 4997 pts spanning 1478.8 ×
  1478.8 m, Miandros 4967 pts spanning 555.9 × 570.6 m. 8 lib tests green.

## 2026-07-19 — v0.3, the 1:1 pass (untextured render read as a centerline; it was the missing skin)

### Verified first
- Two-replay line comparison (`test_twolines.js`): today's centrifuge lap vs
  Jul-12's differ by median 2.71 m / max 16 m — the extracted positions are
  driven lines, not a track spline. The "centered line" perception was the
  UNTEXTURED render: the painted rubble edges live in the textures, and the bare
  collision geometry is wider than the visual track.
- `test_lateral.js` — lateral-ratio proof (sd 0.265; a spline would be ~0) and
  the ASCII of the 26.8 km corner sweeping 19 m of road.

### Added
- `kn5.js extractScene()` (scene-extract agent, regression-guarded): ALL
  renderable meshes with normals + UVs, merged per material, texture blobs +
  txDiffuse mapping captured. Centrifuge full scene: 57 ms, 3.24M tris,
  7 material groups, one 1440×4320 PNG skins the whole track.
- `kn5tex.js` (texture agent, 22 checks green on 35 real blobs): DDS parser
  (DXT1/3/5 + uncompressed BGRA/RGBA), pure-JS BC1/2/3 software decoder,
  WebGL upload with s3tc fast path, PNG/JPG sniffing for browser decode.
- Viewer: textured + lit scene pass (second shader program: diffuse texture,
  wrap lighting, fog, alpha-test); WebGL2 context when available (NPOT+REPEAT
  keeps centmain.png at full fidelity; canvas POT-resample fallback on GL1);
  materials named transparent/glass render translucent (α 0.16, depth-read,
  drawn last) so the tube's glass doesn't hide the road; NULL.dds placeholder
  probe (tiny near-black → neutral grey); bare-grey road render kept as the
  fallback path; edge index unchanged (still built from the physical mesh).

## 2026-07-19 — v0.2, same Sunday, three agents deep

### Added
- `kn5.js` — .kn5 track model parser (v5/v6): walks header/textures/materials
  exactly, extracts only physical road meshes (leading-digit + surface-KEY name
  rule: ROAD/KERB/PIT/RUNOFF), applies the node transform stack (row-vector
  matrices). Layout certified from two independent directions: web sources
  (RaduMC converter + actools writer + Blender exporters, via research agent)
  and a byte-level probe agent that walked all six kn5s on this machine to
  exact EOF (~530 MB, zero slack). Centrifuge: 3.2M road tris parsed in ~100 ms.
- `roadedge.js` (built by its own agent, 15/15 synthetic tests) — boundary-edge
  extraction (position-quantized at 1 mm so mesh seams don't read as edges) +
  spatial-hash nearest-edge queries, ~1 µs each.
- `test_kn5.js`, `test_edgecoach.js` — kn5 walk validation (exact-EOF, replay
  containment cross-check) and the coaching pipeline (replay + kn5 →
  edge-distance profile + closest-brush table + climb-margin stats).
- Viewer: drop the track's .kn5 alongside the replay → real road mesh renders
  under the line (indexed draw, OES_element_index_uint); edge index builds in
  the background; live HUD gains an `edge N.NN m` readout (bold under 2 m).

### Findings (first real run)
- Tens of thousands of boundary segments; edge index builds in a few seconds; a
  full-lap distance-to-edge profile runs in tens of milliseconds.
- Per-lap output: median edge distance, closest brush (with speed + altitude),
  and per-sector climb margins.

### Added (post-first-launch)
- Follow-car camera: chase cam eased onto the cursor, auto-swinging behind the
  direction of travel; drag offsets the chase angle, wheel sets chase distance,
  toggling off restores the saved overview camera.

### Known caveats
- Edge metric is side-agnostic (nearest boundary, inside or outside); signing
  it by side of the racing line is the natural next step.
- Skinned (class 3) node layout is unexercised — zero instances in all six
  local files; tracks appear to never use them.

## 2026-07-19 — v0.1, born on a Sunday

### Added
- `acreplay.js` — zero-dependency .acreplay v16 parser (browser + Node).
  Self-calibrating frame decode: stride by autocorrelation, position phase by
  physics gates + wheel-echo verification, probe in the middle third of the car
  block (spawn can be stationary — this bug ate the first detector, whose
  "smooth" test let constants pass; second detector required actual travel but
  probed the stationary spawn; third one probes mid-run). Extracts position,
  derived speed/odometer, road-surface normal + banking from the wheel quad,
  lap times from the ms sawtooth at phase −64.
- `index.html` — 3D WebGL viewer, no libraries: banked track ribbon (surface
  normal from wheels, so the tube and inversions render as built), center line,
  speed/banking color modes, orbit/zoom/pan mouse controls, replay cursor with
  play/pause/rate, speed-sparkline scrubber with lap ticks, drag-and-drop
  loading, multi-car selector.
- `test_parse.js` — Node smoke test.
- Verified against three real replays (15 ms and 30 ms intervals): lap times
  match the in-game clock, stats match an independent decode byte-for-byte.

### Known broken
- Online multi-car autosaves (`AC_*_O_*`): car block zeroed/interleaved — clear
  error message instead of garbage. Support later if wanted.
