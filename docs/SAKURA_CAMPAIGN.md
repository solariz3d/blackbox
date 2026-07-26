# Sakura campaign — the measured plan

**2026-07-26, ~4:45 AM.** Built from four parallel investigation reports (geometry profile, fill
analysis, CSP config survey, structure audit) plus the keeper's live observation that toggling tree
*shadow casting* barely moves the frame rate in the dense zones. Everything below carries the number
that justifies it. Nothing below is a guess; the guesses are what this replaces.

## The diagnosis — two stacked problems, not one

**A. A geometry floor that culling cannot touch.** `sktrack.kn5` holds Track (671,744 tris) and
Underside (506,378) in **15 single meshes of kilometre scale** (855–2,435 m XZ extents each). The
chunker splits at mesh granularity, so these are indivisible: measured over 24 racing-line cameras,
a 60° frustum rejects 76% of *chunks* but the frame still draws **~40% of all triangles** from any
viewpoint. 1.18 M tris × three passes (lit, near cascade, beam) is the floor under every frame.

**B. Corridor fill at night.** In the tree tunnels a pixel sits under **median 36 / p95 78** canopy
layers (exact per-triangle raycast), drawn in arbitrary order, alpha-tested with `discard` (which
defers depth writes), at `alphaRef 0.1` so ~half the card texels survive. Each surviving fragment at
night pays **26–51 dependent shadow-map taps** — the 25-tap `pcfSoft` night path (added 2026-07-26)
against 8192² cascades, ×2 in the blend border. Modelled: **2.4–4 ms of foliage fill alone at
night** vs ~1 ms by day, against a 2.78 ms (360 Hz) budget. This is why disabling canopy *casting*
changes little: the cost is *receiving*, not casting.

Exonerated by measurement: the lamp loop (all 143 lamps night-gated → all baked; live loop gets 0;
mean lamps-in-range of a point is 0.6), canopy shadow *casting* (keeper's live test), and
"Pink leaves" as an overdraw source (322k tris, but **opaque** — it costs vertices, not fill).

Confirmed bugs found en route:
- `progDepth` has no UV/texture/discard — **it cannot alpha-test**, so every ~13 m leaf card casts a
  SOLID QUAD shadow. The "messed up" tree shadows are a correctness bug, not just aliasing.
  TREE_MODE 1 (trunks only) is more correct than mode 0, not merely cheaper.
- `resetTrackScene` never deletes `g.emisTex` → texture leak on every track swap.
- The two group constructors still disagree (`translucent` vs `blend`) — the same disease that made
  three features silently dead on 2026-07-25.
- Stale doc: the library is **32 tracks, not 62** ("15 of 62" in road-detection notes predates a
  library change).

## The plan, in order

### Phase 0 — structure first (audit's argument: every optimization below adds group fields)
1. **`makeGroup()` consolidation** — one factory for both constructors, ~30 lines added / ~55
   removed, behaviour-identical. With `test_groupshape.js`: asserts the union of every field any
   pass reads exists on both group kinds (the assertion that would have caught the 07-25 bug), plus
   a tripwire that `posBuf:` appears in exactly one object literal.
   Same commit: fix the `emisTex` leak (one line), retire `blend` in favour of `translucent`.
2. Correct the stale 62-track claims in docs.

### Phase 1 — free and cheap, each step measured on the HUD timers before the next
3. **The TREE_MODE measurement session** (zero code — the toggle has never actually run until the
   descriptor fix). Fixed camera, night, dense zone; let the EMA settle; record `track`/`shadow`:
   - baseline day vs night at mode 0 (the delta ≈ the PCF-tap term; model says ~3×),
   - mode 1: expect `shadow` drops, slider-scrub hitching stops (no 831k-tri far re-bakes), and
     solid-blob tree shadows disappear (correctness win),
   - mode 2: expect the big night `track` drop (model: half or more). **If `track` barely moves,
     the corridor model is wrong — stop and re-diagnose before building anything below.**
4. **Front-to-back sort of opaque chunks** (few lines, zero visual change — depth testing is
   order-independent for opaque/cutout). Converts arbitrary-order shading (~5.8 full shades/pixel)
   to ~2. Expected ~2.5–3× cut in foliage shading; the measured drop also validates the overdraw
   model independently.
5. **Contain the night-PCF cost** (mine, from tonight): candidates — soften only the far cascade
   (pools live there; the near box is 80–104 m and mostly road), drop night taps 25 → 13 (Poisson
   pattern), or scale softness by cascade texel size. Measure day/night `track` delta first; keep
   the soft look, lose the tap bill.

### Phase 2 — structural
6. **Triangle-level splitting of the 15 sktrack monoliths** at load (the chunker gains a
   split-giant-meshes path; target ≤200 m cells). Lifts the 1.18 M floor — the single biggest
   lever on this track. Also improves every pass at once.
7. **Underside render-skip** — 16.2% of all triangles, a duplicate under-skin ~1–5 m below the
   deck, invisible from above-deck cameras. **Landmine:** it lives on the same `1ROAD_*` nodes the
   road-edge index and colliders consume — render-skip only; `extractRoadMesh` consumers keep it.
   (Longer term this wants occlusion reasoning, not a name check — do it via config/flag, measured.)
8. **CSP config reader** (~140-line `ui/trackconfig.js` + ~35 in index.html + 6 in kn5.js + tests;
   survey: MATERIAL_ADJUSTMENT is `ksEmissive` in 84/84 cases, NIGHT_SHARP dominant, two OFF
   spellings, `CULL_MODE=DOUBLESIDED` is a recorded no-op since BLACKBOX never culls backfaces).
   Gives sakura its config-declared night glow (lantern/Lamp/Light) and retires the pane-name
   heuristic where data exists. **Keeper's decision attached:** centrifuge's config says the dome
   panels GLOW at night (author intent); the keeper preferred them gone (open holes). Pick at
   build time; default to the keeper's look with author-intent as the option.

### Phase 3 — only if still over budget, in this order
9. Alpha-to-coverage for foliage (restores early-z fully + MSAA finally AAs leaf edges; couples
   foliage to MSAA staying on; needs alpha sharpening care under ESSL 1.00).
10. Distance-based foliage dissolve (raise alphaRef with distance; the p95-274-layer sightline tail
    is >200 m out — but the pink hillsides are the track's identity, so tune by eye).
11. Camera-depth prepass with an alpha-testing depth shader (rasterizes foliage twice; only wins at
    high N) / half-res foliage compositing (last resort).
12. `antialias:false` startup option (relaunch-level; ~10–25% raster bandwidth; forecloses #9 —
    expose as a setting and as a diagnostic, not as the fix).

### OPEN BUG — distant trees load in as the camera approaches (pre-existing)
Confirmed present on a build with NO distance mechanism of any kind, so it predates the
campaign. Eliminated: the dissolve (off), the monolith split (off), the camera far plane
(20–60 km), and — partially — mip-alpha dilution: the leaf textures are PNGs mipped by
generateMipmap with LINEAR_MIPMAP_LINEAR, a distance-compensated alpha threshold was
shipped (FST, 80→600 m ramp) and did NOT visibly cure it, so the simple dilution model is
wrong or incomplete. Next diagnostic, fresh: fixed camera stepped toward a popping
treeline with the K material view on, to name the material and distance band; then read
that texture's actual mip chain. The remaster below kills this class by construction and
is the chosen endgame; the diagnosis still matters for every other track.

### Phase 2.5 — THE ENVIRONMENT REMASTER (keeper's directive, 2026-07-26 ~6:22 AM)
Verbatim: "remove all trees and put good ones that would maximize space… rip the guy who
made the track since the track is genius, but the environment not so much." Feasible and
BLACKBOX-legal — it is our renderer over AC's data; we already replace lighting, shadows
and sound. Design: (1) harvest the author's tree PLACEMENTS from trees.kn5 (2,268 mesh
positions/sizes — the forest layout is part of the track's identity and is kept);
(2) author 3–4 good tree assets — many small cards, mip-safe alpha, palette sampled from
the original textures; (3) GPU-instance them (thousands of trees, a handful of draws);
(4) the impostor idea becomes the far LOD of the same system, crossfaded. Standing law:
every tree, every distance, nothing spawns. Per-track, optional, original files untouched.
Supersedes the bare impostor plan below as the primary path.

### Phase 2.5-prior — impostors alone (kept for reference)
The keeper, verbatim: "make the tree geometry less complex and sort of conglomerated
together" — which is impostors, independently reinvented. Past a distance, draw each
foliage chunk as ONE pre-rendered quad instead of dozens of stacked alpha cards. The
replay-viewer asymmetry applies again: the world is known at load, so impostors can be
baked once per track load (~475 chunks x 128px atlas ≈ 30 MB). Trees stay visible at ALL
distances — his standing constraint — only parallax degrades at range. Hard problem:
lighting consistency across the time slider (bake albedo, light the quad with a simple
normal). Crossfade the transition. This is the crown of the fill work; build after A2C
and the monolith split, measured against them.

### Measured live so far (worst corridors, follow cam)
- baseline: 80–90 fps · sort: "a little better" · +state elision/band sort: similar ·
  +13-tap night PCF +dissolve(400/800): lowest seen 109. Dissolve then DISABLED by the
  keeper's call — trees at all distances beat the ~20%. The 13-tap PCF stays.
- Elimination ledger: casting NO, lamps NO, draw order small, CPU calls small, night taps
  halved; remaining: raster/bandwidth fill (MSAA A/B untested), monolith floor, A2C.

### Watch items
- **The lamp bake will facet on `Land`** — median triangle edges 29–41 m vs 60–70 m lamp pools:
  single triangles spanning whole pools (the centrifuge-dome failure, relocated to grass). Track
  itself is dense (2.3 m edges) and safe. If lantern pools on terrain look wrong at night, the fix
  is Land subdivision or a per-pixel fallback for coarse meshes — not lamp-count changes.
- Sakura's `Track` material has a config SHADER_REPLACEMENT to a textured-emissive road
  (`Emissive_track.dds` ships in the track). Real feature, separate spec, not in this campaign.

## Standing lesson (kept from the night this plan replaced)
Six wrong guesses on one dome, three features dead on the wrong constructor, one backtick killing
the whole app — every one resolved in a single look the moment an instrument existed. **Measure,
then build; when a result surprises, check the instrument before the theory.**
