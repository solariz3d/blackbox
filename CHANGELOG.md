# Changelog

## 2026-07-31 — skid marks stop punching through the tarmac where the road banks past vertical

The symptom: on centrifuge, wherever the car goes past vertical, the tyre marks are laid a full
tyre diameter on the far side of the road — through it, not on it. `buildTireMarkMesh`'s `upAt()`
forced the surface normal toward the sky on the stated grounds that the recorded sign was
unreliable, and since a contact patch is `wheelCentre - up * radius`, inverting `up` puts the
patch 0.66 m the wrong way. The sign was never unreliable: `extractCar` resolves the wheel quad's
winding once for the whole run, so `nrm` points out of the road toward the roof and goes on doing
that when the car is upside down. What is unreliable is world up as a stand-in for it.
`carModelMatrix` has always posed the car BODY from the same normal unflipped — so on those
frames the marks and the car laying them disagreed about which way was down.

### Fixed
- **`upAt()` in `ui/carrender.js` uses the normal as recorded.** Three consequences went with the
  flip, not one: the contact patch moved a diameter, the 0.03 m lift pushed the ribbon *into* the
  surface instead of off it, and `right = up × travel` reversed, so the mark's width was laid on
  the wrong side and the strip faced backwards.
- **It was never confined to the stunt sample.** centrifuge runs 1,313 frames of 16,577 past
  vertical (7.92%), and **t180 — the reference replay this repo tunes everything else against —
  has 57 of 7,728**. Marks were laid on 5 of those.
- **The grain coordinate downstream is corrected too.** `run` is metres along the wheel's path,
  accumulated contact-to-contact across the whole stint, so every 0.66 m teleport at a crossing
  was added to the tally and every later mark on that wheel inherited it: up to 1.0 m of phantom
  travel on t180 and 9.9 m on centrifuge. Mark *positions* on normal-up frames are bit-identical;
  this field is the one thing that changes, and it changes because it was wrong.

### Added
- **`test_skidnormal.js`** — 44 tests pass. The old behaviour is reproduced by pre-flipping the
  run's normals and calling the *shipped* function, rather than by keeping a copy of the old
  `upAt` that could drift from it and pass anyway. Mutation-checked both ways: reinstating the
  flip turns 7 assertions red, and a form the source-text check cannot see (`s = uy >= 0 ? 1 : -1`)
  still turns 6 red on the measurements alone.
- `buildTireMarkMesh` and `computeWheelSlip` are exported from `carrender.js` so the mark geometry
  can be measured on a real replay under node.

### Measured — how "on the surface" is established with no track model in the repo
- **Continuity.** A surface normal cannot reverse inside one 15 ms frame. As recorded it turns at
  most 6.6° (t180) / 12.5° (centrifuge) between adjacent frames; forced skyward it swings to
  177.8° / 180.0°, on 2 and 65 frames. That is the measurement that says which sign is physical.
- **Rigidity.** The contact patch is bolted to the wheel a radius away, so its path length must
  track the wheel centre's — which is what the `run` figures above show the old code violating.
- **Not used, and recorded because it looked convincing:** `dot(carPos - wheelCentroid, nrm)`,
  i.e. "the body is above the wheels, so that resolves the sign". AC's car origin sits *in* the
  wheel-centre plane — median -0.035 m on t180, 5,323 of 7,728 frames negative — so the quantity
  is noise around zero and a test built on it would have passed for the wrong reason.

## 2026-07-31 — a stand-in track from the replay's own wheels, and three things the spec got wrong

The symptom: on a machine with no Assetto Corsa install, a sample replay renders the car and
the line over empty space. The real track is a 111.7 MB `.kn5` that cannot live in this repo,
and `samples/TRACK_FROM_REPLAY.md` has specced the way out since 2026-07-24 — the four
wheel-centre world positions in every frame are contact patches on the actual tarmac, so
dropping them by the tyre radius along `-nrm` gives points *on the road*, banking included.
Built now. The spec was right about the approach and wrong about three of its own
expectations; the measurements are below and the spec carries a dated correction.

### Added
- **`ui/trackgen.js`** — pure geometry, no GL, so it runs under node. `buildTrackMesh(runs)`
  ribbons the driven corridor into `pos/nrm/uv/idx` in exactly the shape `makeGroup` takes, so
  the stand-in uploads through the same factory the kn5 path uses and the shadow passes, the
  road shader, the edge index and the contact queries all work on it unchanged. Takes an array
  of runs, so every loaded replay unions into one surface.
- **`buildStandInTrack()` / `freeStandInTrack()` in `loaders.js`**, and a **stand-in track**
  button. It refuses when a real track is loaded, and a real kn5 arriving afterwards frees
  exactly the stand-in group rather than going through `resetTrackScene()`, which would take
  the car model with it.
- **`test_trackgen.js`, `test_standin.js`** — 43 tests pass. Both were mutation-checked rather
  than trusted green: reverting the tyre-radius drop, forcing the normal skyward, inverting the
  winding, bridging teleports, dropping the distance resampling, removing either free, removing
  the real-track guard, and dropping the comparison runs each turn the suite red.

### Measured — where the spec's own expectations did not survive
- **The union-of-laps lever is nearly absent from the shipped samples.** The spec calls using
  every lap "the single biggest quality lever here, and it's free", on the belief that the
  test-track replay holds several laps on different lines. It holds **two line crossings — one
  complete lap**, and so does centrifuge; `samples/README.md` already corrected this on
  2026-07-25 and the spec was never updated. Only 10.6% of the 4 m cells the car visits are
  revisited on a later pass. The union support is still there and still free, it is just worth
  much less than advertised until a second replay is loaded.
- **Resampling by distance cannot do what the spec asks of it.** It expects the step to stop
  "slow corners getting dense strips and straights sparse ones". At 15 ms frames both samples
  step 1.06–2.38 m (t180) and 1.72–3.96 m (centrifuge) between frames — already coarser than
  any sane step, varying only about 2:1, and nothing interpolates, so a strip can never be
  *finer* than its frames. What the step actually earns: t180 holds 105 frames stepping under
  5 mm, the car sitting still before the run, which without it become zero-area triangles.
- **Widening is less of a guess than the spec says.** It calls a plausible road width "a
  guess", and the tarmac's real ~12 m would be. But where two passes cross the same ground on
  different lines with matching heading, their lateral separation is measurable: median 1.98 m
  (t180) and 2.72 m (centrifuge), with an along-travel offset five times smaller, which is the
  check that these are the same place and not two points nose to tail. Two 1.8 m corridors 2 m
  apart span 3.8 m of used tarmac, so `STANDIN_WIDEN_M = 1.0` reproduces the width the driving
  demonstrably used and no more. The tail of that distribution reaches 9 m and is **not** spent,
  because nothing here can tell a wide line from a pit lane running parallel.

### Found, not fixed — `buildTireMarkMesh` on inverted surfaces
`upAt()` in `carrender.js` forces the road normal skyward, commented "ex.nrm sign is
unreliable". On centrifuge **1,313 frames of 16,577 (7.92%) legitimately have `nrm.y < 0`** —
the car is past vertical, which is the case that replay exists to exercise. Since
`contact = W - up * r`, a flipped `up` puts the skid-mark contact patch a full tyre *diameter*
(0.66 m) on the wrong side of the tarmac there. Measured in the data, not seen on screen, and
left alone as outside this change. `trackgen.js` deliberately does not copy the shortcut, and
`test_trackgen.js` fails with 1,313 wrong sections if it is ever reinstated.

## 2026-07-27 — `covgap.js`: nine defects from review, four of them false-clean

Reviewed independently and measured rather than read. Four failed in the direction the tool
exists to prevent — reporting nothing wrong about a change nothing had looked at.

### Fixed
- **Default scope was `git diff` — unstaged only**, though the docstring promised staged and
  unstaged. Staging before a commit, which is to say being about to commit, produced "no
  top-level ui functions in scope" and a clean report on an unexamined change. An empty report
  is indistinguishable from a good one, which made this the worst of the nine. Now `git diff
  HEAD`, and the scope label says so.
- **A multi-line arrow parameter list collapsed its function to lines 1-1.** The old test asked
  whether a `{` appeared before the first newline; with the params wrapped, the brace is on
  line 3+, so the span stopped at line 1, a change to the body failed `overlaps()`, and the
  function vanished from the report — not covered, not uncovered, absent. Replaced with
  `valueEnd()`, which finds the arrow at bracket depth zero and then brace-matches or runs to
  the terminating `;`.
- **`--files` ate the next flag's value.** It filtered `--`-prefixed tokens out of the whole
  tail, stranding the value behind, so `--files ui/mathutil.js --ref HEAD~1` exited 2 with "no
  such file: HEAD~1". Now stops at the first flag.
- **The property-access guard was computed and never wired in**, so `results.cullLights = 3`
  classified as *executed*. The dead variable was itself the discrimination that would have
  prevented it. The fix is not to ban the dot — `TL.cullLights(...)` after a `require` is the
  primary execution shape here — but to cut on call-vs-access.
- **A string inside a `${}` template hole landed in code position.** The hole walker copied
  bytes by brace depth with no sub-lexing, so the same literal took a different class depending
  on where it sat, and a `}` inside a string in a hole walked the depth counter off the end.
  The hole is now lexed recursively.
- **`sourceReaching`'s regex-literal test used `[\\s+]`**, which as a regex source is a class of
  backslash, `s` and `+` — accidentally the right three characters, so it passed on every
  mirror in the repo and would have missed `/function *name/` or `/function\s*name/`. Right
  answer, wrong reason.

### Changed
- **`--strict` gates on UNCOVERED only.** Failing on MENTION-ONLY contradicted the contract the
  tool prints on every run — "a lead to check by hand, not a verdict" — and, with the
  deliberate self-reference in `test_covgap.js`, made `--strict` permanently red. A gate that
  can never go green is a gate people route around.
- **The header no longer says "close to proof of absence" or "trust the red."** Measured
  against the repo: of 178 functions reported UNCOVERED, **22 are called directly by a function
  the suite executes** — one-hop and same-file, so a lower bound. Roughly one in eight runs
  incidentally with no test naming it. The contract printed at the bottom of every run already
  said this; the header was the thing that disagreed, so the header moved.

### Added
- `changedRanges` split into `diffArgs` + pure `parseDiff`; argv parsing split into `parseArgv`;
  the strict gate into `strictFailures`. Three of the nine lived in `changedRanges`, `main()`
  and the arrow arithmetic — **code this suite never ran a line of.** Splitting them out is
  what makes the regressions assertable, and `test_covgap.js` now covers all nine.

### Notes
- **The structural hole is not closed.** covgap's scope is `ui/*.js`, so it cannot see the
  repo-root tools, including itself — which is why nobody could have run covgap on covgap.
  Widening to root `*.js` is a few lines but changes what every run reports; recorded in the
  header rather than done quietly.

## 2026-07-27 — `covgap.js`: which changed functions no test reaches

The symptom is the entry below this one. `drawCarLights` and `wheelSteerModel` were rewritten,
the suite was green from start to finish, and a real defect lived in the working tree for an
hour — because no test in the repo touched either function. Green could only ever have meant
"you did not break anything else," and nothing in the repo said so out loud. This does.

### Added
- **`covgap.js`** — give it a diff and it reports which changed top-level `ui/` functions no
  test reaches. Root, beside `testenv.js`: it consumes `ui/*.js` and `test_*.js` by the same
  convention, and the repo's other node tools already live there.
  `node covgap.js` (working tree) · `--ref HEAD~1` · `--files a.js b.js` · `--all` · `--json` ·
  `--strict` (exit 1 when anything in scope is uncovered, for a hook).

  Four classes, kept separate because they fail differently: **UNCOVERED** (no test says the
  name at all), **MENTION-ONLY** (named only in a comment or an inert string — the one that
  looks covered to a grep and is not), **pinned** (a mirror anchored to the shipped source, as
  `test_lampglare` and `test_glowpool` do), **exec** (imported and called, or rebuilt through
  `new Function`/`vm` and called). The contract prints on every run: UNCOVERED is a sound
  negative about *targeting*, `exec`/`pin` never claim the assertions are any good, and nothing
  here reads call graphs — a function can still run incidentally via a tested caller.

  Using vs mentioning is decided **positionally, not textually**, by a scanner that labels every
  byte code/comment/string/template/regex. The repo has been bitten four times by regexes that
  could not tell the two apart, but the obvious fix — strip comments and strings — is wrong here
  in the expensive direction: `uiFunction("batchGlow")` puts the name *in a string* and is the
  strongest coverage signal in the codebase. Stripping strings would report every mirror-anchored
  test as no coverage at all.
- **`test_covgap.js`** — pins both directions of that discrimination, on synthetic input and
  against the real repo. Two assertions are regressions for defects found while building it: a
  file-level "this test uses `new Function`" flag promoted `batchGlow` to executed when its test
  only regexes it (the tool committing the exact error it exists to catch), and `pathRadius` /
  `turbineGate` read as mention-only although `test_turbinegate` genuinely runs them in a `vm`
  sandbox via a local extract helper.

### Notes
- On the change below, `covgap.js --ref HEAD~1` reported 1 uncovered, 3 mention-only, 3 reached.
  `drawCarLights` — the function the incident was about — came back **mention-only**:
  `test_glowpool` discussed it in prose and exercised `batchGlow`. The tool's first real use
  was to catch an over-claim in the entry below it, which had said the gap was closed.

### Fixed
- **That gap, properly.** `test_glowpool.js` now evaluates the real `drawCarLights`,
  `headLampSides` and `pushGlow` against a recording GL stub, so the ghost-lights failure is
  asserted as a property rather than through a proxy: stage a car with six headlamps, then one
  with two, and require that no sprite from the first survives into the second frame's draw.
  Also covers the empty-colour early-out and the overflow cap through the real path. Verified
  by reinstating the defect — it takes three of the new assertions down, not just the lexical
  one. `covgap.js` now reports `drawCarLights` as `exec`.

## 2026-07-27 — Allocation pass on the per-frame light and wheel paths

The third of the three items after the module split. `drawCarLights` runs once per car per
frame and was rebuilding everything it needed each time; `wheelSteerModel` runs four times
per car on top of that. Reviewed by two independent readers before it went in.

### Changed
- **`drawCarLights` staging is pooled.** Three growing Arrays, a `push` closure, a per-side
  `.slice().sort()`, an `mXfPt` result per lamp, three colour array literals and a
  `new Float32Array(arr)` per draw batch — all per car per frame — become module-scope pools,
  a hoisted `pushGlow`/`batchGlow`, an identity-cached left/right lamp split, and inlined
  point transforms. The sort was recomputing a fixed answer: the split and the top-lamp-first
  order depend only on model-space geometry, which does not change between frames.
- **`wheelSteerModel` allocates once, not five times.** `Ry`/`Rx`/`R` never escape and now use
  module scratch via the new `mMulInto`. The returned matrix is still allocated fresh, and has
  to be: `tyre` and `cage` are alive simultaneously at the `render.js` and `laps.js` call
  sites, so pooling the return value would silently make the second call clobber the first.
- **`drawThruster`'s particle buffer is pooled**, sized from `THR_KC`/`THR_KG` rather than a
  repeated `(32 + 22)` literal — a duplicated count is a silent truncation waiting for someone
  to raise it, since out-of-range `Float32Array` writes are dropped without a throw.

### Added
- **`mMulInto(o, a, b)`** in mathutil — the column-major twin of `rvMulInto`, same aliasing
  rule, and exported alongside it.
- **`test_glowpool.js`** — the contract pooled buffers have to keep. The whole suite passed
  throughout this change because nothing in it touches either function; green said "you didn't
  break anything else," not "this is right." Asserts that a frame staging fewer sprites than
  the last never draws the leftovers, that the empty-frame early-out stays reachable, that
  overflow caps rather than corrupts, and that two `wheelSteerModel` results stay independent.
  Verified to fail when the defect is reinstated, not just to pass.
- **One-shot warning when the glow pool overflows.** The arrays this replaced were unbounded,
  so a lamp-heavy model now loses sprites; the cap is fine, the silence was not.

### Fixed
- **`batchGlow` drew the pool's capacity instead of the fill count.** `S.a.length / 5` was
  correct while the staging array was a growing Array — length *was* the fill — and became a
  constant 256 the moment it became a pool. Consequences: an 18× over-draw in the pass meant
  to reduce work, a dead empty-batch early-out, and a latent ghost-lights bug where a car
  loaded with fewer lamps than the previous one redraws the previous car's world positions
  every frame thereafter. Both reviewers caught it independently and both quoted the comment
  twelve lines above it — "the cursor, not the buffer's capacity."

## 2026-07-26 — Buttery pass: the tree depth prepass, night-tap cuts, and the magic-trees root cause

The keeper's bar: 240 solid at max night. Three look-preserving cuts plus the find of the session.

### Fixed
- **THE MAGIC-TREES ROOT CAUSE — camera-coupled fog.** `fogD = 0.35/max(cam.dist, 120)`:
  in follow cam the floor made fog **24× the baseline** (0.0029), so 800 m was 90% fogged
  and 1.2 km was 97% — everything distant dissolved into fog that matches the night sky
  and "spawned in" on approach. Sakura's four giant landmark sakuras, 126–181 m tall,
  were erased past ~800 m. Found only after LOD fields, mip alpha, texture completeness,
  suppression and three cull systems were EACH exonerated by scripted measurement — the
  bug predated every tree change and hid behind all of them. Now capped at 0.00055
  (visibility ~4 km in follow cam; close-in haze kept; zoomed-out cameras untouched).
  The keeper's law, enforced: nothing may vanish.

### Added
- **Tree depth PREPASS** (the deep-stack killer for the 90-fps last turn): the forest
  rasterizes once colour-off through the alpha-tested instanced depth shader — positions
  bit-identical down to the shared sway clock — then the lit pass shades each pixel
  EXACTLY ONCE at LEQUAL instead of once per overlapping canopy layer.
- **Night-tap cuts, all invisible by design**: trees receive the 9-tap shadow path even
  at full night (PCF softness inside a canopy is unresolvable detail; the track keeps its
  soft moonlit pools); trees no longer occlude the road-aimed headlight beam (the whole
  visible forest was re-rasterized into the beam depth map every night frame for
  nothing); tree cell runs draw near-first so close canopy primes depth and the corridor
  z-rejects behind it.

Handed to the desktop mid-verification: the last-turn floor reading on this build, the
HUD timer tail at that spot, and the MSAA A/B (Settings → relaunch) — still the untested
big lever if raster bandwidth is what remains.

*(This entry shipped one commit late: the write script printed "changelog updated" while
a CRLF mismatch made its replace a silent no-op — the third unconditional-success failure
of the night, caught by the keeper's "double check just to make sure." Scripts that
report success must verify it; the Edit path does.)*

## 2026-07-26 — The environment remaster: sakura's forest, rebuilt and instanced

The keeper's directive, verbatim: "remove all trees and put good ones that would maximize
space… the track is genius, but the environment not so much." Built from three parallel
investigation reports (placement harvest, procedural assets, instanced integration) in one
session. Worst corridors measured 80–90 fps at campaign start; with the remaster: **143
minimum, 240 sustained**. First-light verdict on the art: "trees look a little cheap, the
cherry blossom is nice" — the renderer is right, the assets get a polish pass next.

### Added
- **ui/remaster.js** — the remaster's data layer, zero GL:
  - `harvestTrees(scene)`: decomposes the author's merged foliage into individual trees via
    connected components + trunk-seeded assembly. Sakura: **746 trees in ~0.5 s**, validated
    1:1 against his 740 trunk meshes; the premise correction that mattered: **each mesh is
    ONE tree** — fantasy scale, 60–105 m tall, 40–63 m canopies built of 30–60 m cards, plus
    four giant landmark sakuras (126–181 m) carrying thousands of leaf puffs. Generality:
    eagleton 490 trees; nordic/t180/centrifuge 0 — correctly, so the remaster is inert there
    by construction and the goldens stay green untouched.
  - `makeTreeMesh`: 26 cards / **52 tris per tree**; golden-angle azimuth coverage,
    horizontal cap cards, SPHERICAL normals so the canopy lights as one volume.
  - `generateLeafTexture` + `buildLeafMips`: procedural blossom/leaf textures with
    **coverage-preserving mip chains** (Castano rescale, +1 LSB headroom). Measured on the
    track's own sakura1.png: naive mipping hits 0.000 alpha coverage by mip 8 — which IS
    the "trees load in as you approach" bug — while the preserved chain holds flat to 4×4,
    so a distant tree decays to a solid pixel, never to nothing.
- **glcore.js: two instanced programs** (GL2-only, VAO-fenced so no divisor ever leaks into
  the default-VAO renderer): a lit pass with the full cascade shadow receive (shadow GLSL
  shared by CONCATENATION, never interpolation — the syntax lint's scanner stays honest),
  fog, per-instance tint, the distance-compensated alpha test; and an **alpha-tested
  instanced depth pass — the keeper's dappled shadows**, which the stock progDepth
  structurally cannot do. Wind sway lives in the shared transform, identical in lit and
  depth so the dapple sways WITH the canopy. Height and radius scale separately per
  instance — the measured proportions (h p50 87 m vs r p50 54 m) fit no uniform scale.
- **Suppression, draw-list-side only**: alpha-tested canopy materials (sakura: six ksTree
  materials, **463,536 tris — the measured corridor overdraw**) skip the lit pass, both
  cascades and the beam pass via `g.remastered` + `treeHidden()`. Trunks stay (real
  geometry, honest shadows). Opaque canopy stays — the four giants are the author's
  signature pieces. `extractScene` output untouched; `test_goldens` green by construction.
- **remaster button** (live toggle, localStorage-persisted, far-bake invalidation on flip),
  `trees N/total` in the HUD, a "trees" GT timer, teardown as one complete site in
  `resetTrackScene`. TREE_MODE carries over: 1 = instanced trees stop casting, 2 = unlit.
- **The `_lm` state-cache reset that two comments promised and the code never had** — a
  latent stale-texture bug the tree atlas would have made real every frame; found by the
  integration investigation, fixed as one line at pass start.
- `test_remaster.js` (mesh determinism/bounds, texture coverage + anti-dust, the mip
  divergence proof, the suppression-rule truth table); `test_groupshape` UNION consciously
  extended with `remastered`.

### The build's own lesson
One non-idempotent patch script double-applied mid-build (a second run re-inserted ten
patches) and was recovered by `git checkout` + a marker-guarded idempotent rewrite whose
second run verifiably applies zero. Patch scripts must be re-runnable; now they are.

## 2026-07-26 — Centrifuge: open skylights, light that tracks the sun — and making this app admit when it breaks

Centrifuge's dome sat behind three separate faults that all looked like one, and the hour
this took was mostly spent inferring instead of measuring. Every failure mode in this app is
SILENT — a shader that will not compile leaves the window open, a script that throws takes
every later script with it while the HTML sits there looking fine, and a culling system that
rejects nothing is indistinguishable from one that works. The instruments added at the end
each answered in one screenshot what reasoning had failed at for half an hour.

### Fixed
- **The near shadow cascade's caster reach was a hardcoded 600 m; centrifuge is 1191 m tall.**
  Its dome fell outside the near box, so that cascade found no occluder overhead and reported
  the ground lit — a pool of light travelling with the car, in exactly the shape of the box.
  The far cascade had the dome all along, which is why everything outside the box was already
  correctly dark. Reach is now derived from the scene's own bounds (the largest distance along
  the light direction to any corner of the whole-scene box), so every caster is inside by
  construction whatever its height. Costs depth precision only; being short deletes shadows.
- **The far cascade was sized from the ROAD mesh** (`trackAABB`, tarmac plus a flat 120 m),
  which assumes casters sit near the track. Centrifuge's caster ENCLOSES it: road radius
  1206 m gives a 1326 m box against a 1352 m scene, so outer dome sections were never in the
  depth map. Light leaked where the shell should block it, and since which part of the dome
  covers a given point depends on the sun angle, **the leak moved as the time of day changed**.
  Now sized and centred on the scene bounds, capped at 2.5x the road radius so one distant
  backdrop cannot wreck resolution everywhere (keeps centrifuge's dome at 1.1x; rejects the
  T-180 test track's 3540 m environment shell at 6x).
- **Dome skylights are dropped, so the openings are open.** Geometry on a material named
  `Transparent` (852,176 tris, NULL diffuse, emissive [1,1,1]) filled every hole with a pale
  panel. Dropping it also removes it from the shadow cascades, so daylight actually passes
  through — an invisible pane still occludes, which would stop light at a hole you can see
  straight through. The dome SHELL is a different material (`Track`, 2,248,704 tris) and is
  untouched.
- **The vertex lamp bake no longer runs below 24 lamps.** The bake stores one colour per
  VERTEX; on centrifuge's faceted dome a value across a facet metres wide renders as a flat
  polygon of slightly different brightness — faint hexagons fixed in place, visible from
  inside, receiving shadows like real surface, and impossible to delete because they are not
  a mesh. It exists to kill a 60-lamp per-fragment loop on the test track (~230M iterations a
  frame); centrifuge declares FIVE, where the live loop costs nothing, so there was no gain
  to trade an artifact for. Reported by the keeper as "you put them there" — correct, and
  ahead of the diagnosis.
- **A stray backtick inside a shader template killed the whole app.** The shader sources are
  JS template literals; a comment written in the GLSL used markdown-style backticks around an
  identifier, which CLOSED the string, so the rest was parsed as JavaScript. `glcore.js` died
  with "Unexpected identifier", every later script never ran, and — because they share one
  global scope — the `if (inTauri)` branch that opens the track gallery was never reached.
  Symptom: the start menu showed the browser drop-a-replay screen instead of the track list.
  One character, four files from where it showed. Introduced while writing the comment that
  explained the previous breakage of the same file.
- **A GLSL built-in was shadowed** (`float step = …`) in the same function, which fails to
  compile on ANGLE. Same silent death, same symptom.

### Added
- **Soft shadows after dark.** A hard-edged pool of light reads as a solid object lying on
  the floor; at night what comes through a roof opening is skylight from a source the size of
  the sky, whose shadow edge is correspondingly wide. `pcfSoft` uses 25 taps rather than
  widening the 3x3 (nine taps spread far apart are nine visible steps), gated by `nightF` so
  dusk crosses over gradually. Free by day — `soft` is 1, the cheap path is taken, and the
  branch is on a uniform so no fragment diverges. Dial: `SHADOW_NIGHT_SOFT`.
- **An error panel and a startup watchdog.** An uncaught error or a failed shader compile now
  paints itself full-screen with its stack; and if the track gallery has not opened shortly
  after load, a panel reports WHY — whether Tauri's bridge is present, how far the main script
  reached, what the DOM sees. The reporter is the FIRST script in the document, because one
  living in the second file is blind to the first. This is what finally located the backtick.
- **`K` — flat-colour every material**, with a legend in the HUD. Five attempts at the dome
  panels were spent inferring which material a shape belonged to from an offline profile;
  this asks the renderer instead.
- **`smoke` and `marks` GPU timers**, and a **far-cascade counter** (`far N(B)`: chunks drawn,
  bakes run) — because "the bake never ran" and "it ran and drew nothing" look identical.
- **`docs/REPLAY_TRACK_VERSION.md`** — thunderhead's line does not sit on the track, most
  likely because the replay predates the current geometry. Not reproducible on the laptop (no
  replay for it here). Records the check that would settle it and the thing not to do:
  silently projecting an old line onto new geometry would make a wrong lap look right.

### Tests
- `test_shadersyntax.js` — no stray backticks inside shader templates, every UI script parses,
  the 5,271-line inline block parses. Two seconds, and it catches the class of bug above.
- `test_orthofrustum.js` — frustum planes against ORTHO light matrices; the cascade culling
  was added while the only tests covered perspective. One assertion in it was wrong first
  time and is kept, corrected, with the reason: `reach` lengthens the light box along the
  light axis and does NOT widen it, so a caster 300 m vertically above the car is 111 m
  off-axis and correctly rejected.
- `test_matshape.js` — where a named material actually sits in the world, so "is this a pane
  or the dome" is a measurement.

## 2026-07-26 — Night runs at full refresh: the lamp bake, spatial culling, and the descriptor that made three features do nothing

The T-180 test track held 240 fps by day and fell to **150 with the lamps on**, dropping to
~170 transiently with the follow cam close. On a 240 Hz laptop the budget is 4.17 ms and on
the 360 Hz desktop 2.78 ms, so "a bit slower at night" was the whole budget. It now holds
**240 fps at 4.2 ms** with lamps on, and the follow cam no longer dips.

### Fixed
- **The track's group descriptor is built inline in `loadTrackKn5`, NOT by `uploadGroups`**
  — and three features were added to the wrong one, so they were live in code and dead in
  effect. This is the root cause of the evening, and it produced three separate and very
  convincing "that didn't help" results:
  - the **foliage policy** had no `foliage` flag to test, so stripping sakura's 831k canopy
    triangles changed literally nothing — the toggle was a no-op, not a bad idea;
  - **frustum culling** had no bounds, so it rejected 0 of 43 chunks (`chunks 43+43/43`);
  - the **lamp bake** had no vertex data, so it produced no buffer and the ground went black.
  Two near-identical group constructors forty lines apart, one serving cars and one serving
  the track. Found from a screenshot: `43+43/43` and an unlit ground are one cause, not two.
- **The lamp glare sprite punched through the top of its own housing.** It was offset toward
  the EYE so a fixture could not hide its own glare — correct from below, exactly wrong from
  above, where it drags the bulb out through the lid. It now sits just under the housing
  along the lamp's **own aim**, where light physically leaves, and the depth buffer hides it
  from above, which is what a shade is for. No camera-dependent term, so it no longer moves
  when you do. Point lights and `DIRECTION = NORMAL` lamps keep the eye nudge — correct for
  an unshielded bulb.

### Added
- **Track lamp lighting is baked into vertices at load.** The measured cause of the 100 fps
  loss was not the lamps' maths but their count: 60 slots walked for each of ~3.9M pixels is
  ~230M iterations per frame, and no cheaper iteration fixes an arithmetic problem that
  size. Nothing moves — the lamps are fixed to the track, the track to the world, and a
  replay changes neither — so a track vertex's lamp light is a constant and belongs in a
  buffer. `uTLightN` is set to 0 on the track pass and the loop exits immediately.
  **A live game cannot do this**; its world and lights are not knowable in advance. Baked
  60 lamps into 1,252,706 vertices, 89.2% of them receiving light.
  - Night-gated lamps only: their gate is one scalar applied at draw time, so baking at full
    strength and scaling by `nightF` is exact and the time slider keeps working. Always-on
    lamps stay live — no scalar makes those correct, and they are rare.
  - Cars keep the live loop. They move; four cars are a small share of the screen.
- **Spatial chunking + frustum culling.** The renderer had **no visibility culling at all** —
  the only cull anywhere was for lamps. Every frame drew 100% of the track three times
  (near cascade, headlight beam, lit pass) regardless of where the camera pointed. Grouping
  by material bought batching by destroying locality: one group spanned the circuit and was
  neither cullable nor LOD-able. Meshes are now bucketed into 200 m world cells at load, each
  chunk carrying a bounding sphere. Test track: 6 material groups → **43 chunks**, median
  radius **184 m** against a track radius of 3540 m; only 2.5% is single-mesh and indivisible.
  Live result: `chunks 27+14/43` — the lit pass skips 16, the shadow cascade 29.
  - Each pass culls against **its own** volume: the lit pass against the camera, the shadow
    cascade against the *light's* box (a caster matters because it is in the light, not
    because you can see it), the beam pass against the beam.
- **The particle/air simulation runs at a fixed 60 Hz**, decoupled from the render rate. It
  stepped once per rendered frame, so the same sim cost 4× more on a 240 Hz screen and 6× on
  a 360 Hz one — the frame rate was being charged for the monitor being good. Every term was
  already `dt`-scaled, so smaller steps bought accuracy nobody can see. Catch-up is capped at
  four steps; after a stall, dropping simulated time beats turning one late frame into five.
- **Per-pass GPU timing in the HUD** (`EXT_disjoint_timer_query_webgl2`): `track`, `shadow`,
  `glare`, `smoke`, `marks`, in real milliseconds. Three optimizations tonight were aimed by
  inference and one of them was aimed at nothing; a CPU timer cannot answer this because GL
  calls return long before the GPU draws. Degrades to silence when the extension is absent,
  never to a wrong number. Also reports `chunks <lit>+<shadow>/<total>`, because a culling
  system that rejects nothing looks exactly like one that works.
- **`lamps` toggle** (button + `L`) — an unlit night run is its own look, and it is also the
  only honest way to measure what the lamp pass costs, which needs a fixed camera.
- **`trees` toggle** (full · no shadows · unlit) — the CSP change made by hand in Assetto,
  where sakura is unplayable on a modest PC. Foliage is classified **shader-first**
  (`ksTree`, the author's own declaration) with a name fallback, because sakura's heaviest
  foliage material is "Pink leaves" at 322k triangles on a plain `ksPerPixel`. `trunk`
  matches nothing deliberately: a trunk's shadow is cheap and honest, a canopy's aliases into
  noise. **Never actually ran until the descriptor fix above — sakura is worth retrying.**
- **`MAX_TLIGHTS` 24 → 64.** The test track declares 60 lamps; below the lamp count the gate
  is not "dimmer extras" but *which* lamps are lit changing with the camera, so lamps switched
  on as you approached and off behind you. Third time this wall has been hit (12 → 24 → 64),
  now sized to a measurement rather than a round number.
- **Squared-distance rejection** in the light loop — 83% of iterations are rejections
  (measured: a fragment is in range of 9.9 lamps of 60), and each was paying a `sqrt` before
  being thrown away.
- **Exact frustum cull for lamps** (`cullToFrustum`, `frustumPlanes`, `sphereInFrustum`). A
  lamp lights ground around *itself*, so the test is its range **sphere** against the view —
  a lamp behind the camera whose range reaches forward is kept. Testing the point instead
  would put a dark bite in the road.

### Tests
- `test_lampdensity.js` — lamp overlap: 9.9 of 60 in range on average, 83% rejections.
- `test_trackcost.js` — triangles by material/shader, foliage share, and chunkability.
- `test_lampbake.js` — runs the bake headlessly. When the ground was black this separated
  "the maths returns zero" from "the buffer never arrives" in one run; it was the latter.
- 8 new cases in `test_tracklights.js` for the frustum cull, including the sphere-not-point
  case. `test_carscene.js` still fails on this machine — it hardcodes `G:\SteamLibrary`,
  the same bug `test_steeranim.js` had fixed on 07-25. Pre-existing, not touched.

## 2026-07-25 — Wrist attempt 3: twist-bone distribution (docs/DRIVER_WRIST.md)

### Fixed
- **Question 1 of the wrist doc answered from existing evidence**: the IK path is what's on screen —
  the T-180's `steer.ksanim` is degenerate (25 mm hand sweep, measured in `test_steeranim.js`), so
  `driverAnimInit` refuses it. The IK reasoning in the doc applies in full.
- **Attempt 3 shipped**: the same free pronation as attempt 2, but distributed like a twist-bone rig
  instead of lumped at the elbow. `RIG_ForeArm_END` is a real twist bone — mid-forearm, parent of
  the hand, and carrying MORE skin weight than the forearm bone (348.7 vs 242.1) — so the proximal
  forearm turns `WRIST_RAMP` (0.3) of the twist, the END subtree turns all of it, and the skin blends
  the gradient (the elbow-crease shear that sank attempt 2 by eye). Headless: END absorbs the full
  pronation, forearm exactly its share, hand untouched, origins fixed, residual wrist twist
  **62.5° → 6.5°** (`test_gripreach.js` §10). `WRIST_FOLLOW`/`WRIST_RAMP` moved to the index.html
  tunables block (they were file-scoped in carrender.js, which shadowed test control). Verdict by eye
  pending; `WRIST_FOLLOW = 0` reverts.
- **`test_steeranim.js` now resolves the AC install from `libraryfolders.vdf`** (any Steam library,
  the way `find_car` does) and SKIPS with a message instead of ENOENT-crashing on machines without
  AC — the wrist doc's environment note.

## 2026-07-25 — TLNB decoded: timeline instruments, and tyre squeal

### Added
- **`TLNB` (timeline-placed instruments) is decoded**, which unlocked events that had been reading as
  empty stubs. The key: every inline array in this format is `u16 tagged (= 2n+1), u16 stride`, a
  timeline holds **five** of them back to back, and an empty one occupies two bytes — which is why
  nothing ever sat at a fixed offset. `TLNB` = `guid[16]` timeline, `guid[16]` owner event, then those
  five arrays; stride-24 elements are `guid[16], u32 startMs, u32 lengthMs`. **26/26 timelines in the
  car bank and 17/17 in `common.bank` consume exactly, zero misparses**, and the same rule then
  explained the previously-unexplained count words in `CURV`, `PMLB`, `PLST` and `EVTB`.
  - T-180 bank gained **15 instruments across 11 events** — `limiter`, `backfire_ext`/`_int`,
    `gear_grind`, `horn`, `jumpjack`, `jumpjack_charge`, `tractioncontrol_ext`/`_int`, `skid_ext`/`_int`.
  - `common.bank` gained **10** — `grass`, `gravel`, `kerb`, `sand`, `old`, `extraturf`, `screw`,
    `unscrew`, `ambience`, `ds_protection`. (`dirt` was already visible: it is the one surface AC
    authored on parameter sheets.)
- **Tyre squeal**, from the car's own `Tire Skid LowFreq` with its authored −3 semitone detune.
- **`find_common_bank`** (Rust) — AC's shared bank, where the surface sounds live.

### What the decode settled, that guessing would have got wrong
- **Skid rides nothing.** `skid_ext`/`skid_int` declare **zero parameters**, zero instrument
  automation, and zero bus automation — AC drives skid volume from game code. So mapping our slip
  signal to gain is not a shortcut around an authored curve; it is the only thing the format leaves
  to the consumer. Stated in the source so it is not "fixed" later by someone hunting for the curve.
- **Surfaces are different** and do declare `speed [0..500]` and `decay [0..1]`, with volume on the
  **group bus** (dB) rather than the instrument — e.g. `kerb` −42 dB @ 5 km/h → 0 dB @ 100. Bus
  automation is resolved now (`INST +83` → `GBSB` → `CTRL +16`), flagged `bus: true`. Not yet played:
  it needs per-wheel surface detection we do not have.
- **A curve's x-axis can be a TIMELINE, not a parameter — and then x is `u32` milliseconds, not
  float.** Read as float those bytes are denormals that all round to 0.0, so a real 0→4800 ms fade-in
  decodes as `[[0,0],[0,1]]`: parses cleanly, looks like data, entirely wrong. Timeline curves now
  carry `t: true` with `param: null`.

### Fixed
- **Timeline layers were silently mute.** They carry no parameter and no trigger box (`from`/`to` are
  `null`), and the runtime gated every layer on `x >= L.from` — which compares `false` against null,
  so every timeline instrument would have been skipped without a word.
- **The skid signal was the wrong one, caught by measuring before listening.** The first pass used
  the kinematic slide angle (body heading vs velocity) and would have squealed through **70% of the
  lap**: the T-180 has four-wheel steering, so its body crabs and that angle reads a median of 17°
  with a p90 of 47° — nothing like tyre scrub. Skid now uses AC's real per-wheel `wheelSlip`
  (>1 = sliding, car-agnostic; measured p50 0.59, p90 1.92, p98 4.5), with the kinematic angle as a
  clearly-labelled fallback for replays carrying no telemetry. On the sample lap the new mapping is
  audible on 20% of moving frames and loud on 5%.
- Skid is driven **separately from the engine**, because slip is kinematic: `centrifuge.acreplay`,
  which has no telemetry and therefore no engine voice, still squeals through its corners.
- `make_eventmap.js` searched for the FSB5 chunk from a hardcoded `0x2e000` — fine for the T-180's
  188 KB metadata region, a crash on any other bank. And short event names collide (AC's shared
  `GUIDs.txt` lists a `skid_ext` for every stock car), so the populated event now wins instead of
  whichever came last.

## 2026-07-25 — Turbine telemetry: a CSP bridge, schema 6, and a flame that fires when you fired it

### The problem
The T-180's afterburner is a **button**, and it lives in CSP's extended physics —
`ac.getCarPhysics(0).scriptControllerInputs[12]`/`[17]`, exactly where the mod's own `graphics.lua`
reads it. It is **not** in AC's shared memory (verified: `drs` and `kersInput` stay 0 while it is
held), which is why BLACKBOX has always inferred the plume from turbo boost — a stand-in for the
button, never a reading of it. Research confirmed there is **no general CSP telemetry page** to
piggyback on; every CSP mapping is feature-specific, so the bridge had to be written.

### Added
- **`csp/blackbox_bridge/`** — a CSP app that mirrors `scriptControllerInputs[0..19]` for car 0 into
  `Local\AcTools.CSP.Limited.BlackboxBridge.v0`: 120 bytes, hand-ordered for zero implicit padding,
  published under a **seqlock** (odd while writing, even when published). It also publishes a
  `statusFlags` word so failure is *visible* — a climbing frame counter with the ready bit clear
  means "app scope cannot reach `getCarPhysics`", distinguishable from a real zero or a dead bridge.
- **`install_bridge` / `bridge_status`** (Rust) — the app's three files are **embedded in the
  BLACKBOX binary** (`include_str!`/`include_bytes!`), so the installer stays one exe with no
  "resource not found" failure on someone else's machine. A chip in the UI offers the install, names
  the exact folder it will write to, and does nothing until clicked: this writes into the user's own
  game directory, and doing that silently is how a tool earns distrust.
- **Telemetry schema 6** = schema 5 + `turbineRpm` (`[10]`), `thrust` (`[9]`), `afterburner`
  (max of `[12]`/`[17]`) and a **switch bitmask** (bit *i* = input *i* > 0.5, capturing every toggle
  the car declares — jump jacks, fuel-pump cutoff, steering modes — in 4 bytes). 76 bytes/sample
  against 60; recording all 20 indices as floats would have more than doubled the blob for data that
  is mostly binary.
- **The flame reads the real thing** when present: afterburner forces the plume, thrust tracks it.
  Without schema 6 the boost-derived stand-in is unchanged.

### The rule that keeps this honest
**Schema is chosen at save time, not record time.** The logger always buffers the wide sample, but if
the bridge never published, the four CSP columns are stripped back out and the file says schema 5 —
truthfully. A replay claiming schema 6 with dead channels would show a flame that never fires and
read as a viewer bug forever. The bridge flag also resets when AC closes, so a stale `true` cannot
mislabel the next session.

### Honest status
App-scope `ac.getCarPhysics` is **stub-level evidence, not runtime-proven**: CSP's `ac_apps` API stub
declares both it and `scriptControllerInputs` (256 entries) while `ac_splashscreen` declares neither,
and shipped non-car scripts call it — but no shipped *app* does. If the ready bit never sets, the
ranked fallbacks (in `scratchpad/BRIDGE_NOTES.md` §6) end at `car.extraB`, which is the raw
`__EXT_LIGHT_B` afterburner button on a stable API: less turbine detail, same flame at the right
moment. **Existing replays can never gain these channels** — the value was never in the page the
logger was reading, the same way `centrifuge.acreplay` can never gain throttle and brake.

## 2026-07-25 — The rest of the car, and wind that belongs to the camera

### Added
- **The car is not one event.** Alongside the engine, BLACKBOX now plays the car's **`turbine`**
  (10 layers of N1/N2 spool, afterburner and combustion — the jet half of this car's voice),
  **`transmission`** (two `911gt3_gears` layers riding `drivetrain_speed`, roots 80 and 150) and
  **`wheel`** (`tyre_rolling` on road speed). Measured on the shipped map: **28 of 34 voices audible
  at 8300 rpm / 320 km/h** — engine 14, turbine 10, gearbox 2, tyre 2.
- **Wind is listener-local.** It is driven by the **camera's own airspeed**, measured from the eye's
  world motion, and routed straight to the master bus — no panner, no distance falloff, no doppler.
  Park beside a car doing 400 km/h and there is no wind; fly with it and there is. This distinction
  does not exist in AC, whose listener *is* the driver, so its `wind` event rides `air_pressure` and
  the speed→gain mapping here is **ours, not the sound designer's** — the only invented element left
  in the engine, marked as such in the source.
- **`turbine_fuelpump`** as well; **not** included: `turbo` (authored at −80 dB — the designer muted
  it, so we honour that) and the `wind` event's own `air_pressure` curve (superseded, see above).

### Fixed
- **Gain curves come in two unit systems and we were assuming one.** `instrument_gain` (prop #4) is
  linear 0..1, but `bus_volume` (prop #0) is **decibels** — transmission authors its curves in dB
  running −42 → +10. Carrying only linear curves would have made the gearbox wildly wrong the moment
  it was switched on. Each curve now carries its own units, and a curve may ride a *different*
  parameter than the one gating its instrument.
- **`AC_LEVEL` 0.22 → 0.11.** The summed authored gain roughly doubles with the extra events (~11 →
  ~22 at speed); the old level sat inside the limiter, which pumps audibly on a mix this dense.

### Why 14/18 voices is correct, not a bug
The four silent engine layers at 8300 rpm are the idle ones (`idle_2826` ×2, `idle_1837` ×2), whose
trigger boxes end at 4000 and 5000 rpm — AC shuts idle off above that. Swept across 0–12000 rpm no
layer is ever dead; the count moving between ~11 and ~15 is the authored mix working.

### Known missing
`skid_ext`, `limiter`, `gear_grind` and the surface sounds are **empty stubs in the car bank** — they
live in AC's shared `content/sfx/common.bank` (41.8 MB), which is not loaded yet. Tyre *squeal* is
therefore still absent; tyre *roll* is present. The parser and decoder already work on any bank, and
BLACKBOX already computes per-wheel slip for the tyre marks and smoke, which is the signal AC drives
skid volume with.

## 2026-07-25 — One engine, raw: the AC event and nothing else

### Removed
- **The other two engines.** The crossfaded sample ladder and the harmonic resynthesis were both
  *our* designs playing AC's samples; the authored event beat them by ear, so they and their
  generator/tests are gone (`ui/engineprofile.js`, `make_engineprofile.js`, `test_engineharmonic.js`,
  `test_revexpand.js`). With them go the **rev-contrast expander** (it existed to widen a two-voice
  crossfade — a twelve-voice authored mix doesn't need it) and the `eng:`/`raw:` header buttons.
  Two engines that sound alike and unlike the game are not two options; they are one dead end.
- **The whole colouring chain**, permanently: the EQ curve (body/presence/air/top-air), the parallel
  grit waveshaper, the "menace" growl oscillators, the synthetic firing/sub body, and the
  reverb/echo sends. Every part of it was tuned to fatten nine thin samples. Against AC's own mix it
  was colouring us *away* from the game, which is exactly what the RAW A/B showed.

### What is left
Bank → authored event → panner → ceiling. `ui/audioengine.js` is ~half its former size and the
signal path is: the car's own samples, a 3D panner with the exhaust cone and doppler, a transparent
40 Hz high-pass, and the master limiter. `setDistance()` is now a no-op kept for API compatibility —
distance is the panner's job once the wet sends are gone.

### Changed
- The HUD reads `♪ 8342 rpm · 14/18 voices · engine_custom · t180_mach6`, or **`no engine loaded`**
  when the bank or the event map didn't bind. Silence now has a stated cause instead of being
  mistaken for a taste problem.
- A car with no decoded map plays **nothing** and logs the regeneration command. That is deliberate:
  the previous fallback quietly played the Mach 6's samples under another car's name.

## 2026-07-25 — Play AC's own engine event, decoded from the bank

### Added
- **AC-event engine mode** (`eng: AC`, default when a decoded map exists for the car; the header
  button now cycles AC → harmonic → sample). Instead of our design playing AC's samples, this plays
  **AC's authored event**: every looping instrument on the `rpms` sheet with the trigger box, gain
  curves, static dB and autopitch root the sound designer wrote.
- **`make_eventmap.js`** — decodes a car bank's FMOD event metadata (the 188 KB `RIFF`/`FEV FMT`
  region before the FSB5 audio) into the full forensic JSON plus a compact `ui/eventmap.js` for the
  runtime. **`test_eventmap.js`** pins the result.

### What the decode found — and why hand-tuning was never going to reach it
- **`engine_ext` and `engine_int` are EMPTY STUBS in this bank** — zero instruments, they produce no
  sound. The engine is on **`engine_custom`** (CSP's extended-sound path, 24 instruments), with
  `engine_ext_old` (14) and `engine_int_old` (16) holding the legacy layers, plus `turbine` (11).
- **6–15 instruments sound simultaneously, mean 12.** Measured on the shipped map: 11 layers at
  1000 rpm, 15 at 3000, **14 at 8300**. Our engine crossfaded **two**. That single number explains
  more than every tuning pass of the night put together.
- **Sustained beds run under the whole range** — `PinkNoise`, `als_front`, `sin5`,
  `IdleEngine_noise` (+7 dB), `combustion`, `afterburner near` (+10 dB). We played none of them.
- **The autopitch root is authored per instrument and is NOT the number in the sample's name**
  (`5972a_inside` → 5900, `7348c` → 7050, `6365d` → 12800). Every name-derived ladder — ours
  included — was detuned by construction.
- **Gain curves are authored as fade-in/fade-out pairs** that multiply into trapezoid windows, and
  **AC plays nothing outside a layer's trigger box** (no extrapolation; we stretched the top layer).
- Kunos's suffix convention, confirmed character-for-character against `ks_ferrari_488_gt3`: bare
  `NNNNx` = interior, `_ext` = exterior, `_front` = front mic. Our single "ladder" had been
  crossfading *across mic positions* mid-sweep, which changes timbre and phase discontinuously.

### Fixed
- **The sample ladder lost the ~5972 rung.** Interior-named layers were dropped outright, but
  `5972a_inside` is the only recording near 6000 rpm in this bank (the hand-pulled set shipped it as
  `eng_on_5972`). Rule is now "exterior wins at the same rpm", not "never interior".

### Honest limits
- One-shots (throttle-sheet backfire/pop multi-instruments) are **not** carried into the runtime map
  yet — they need trigger/retrigger logic rather than a gain curve, and BLACKBOX already fires
  backfires off detected shifts. The count is reported by the generator so the omission is visible.
- Curve `shape` (per-point curvature) is undecoded; playback interpolates linearly, which is exact
  wherever shape is 0 — most points.
- `ui/eventmap.js` is generated **per car, offline**. Another car keeps the sampled engine and logs
  the command to regenerate. Porting the decoder into the browser (as `fsb5.js` already is) is what
  makes this work for any car without a build step.

## 2026-07-25 — The engine comes from the replay's own car, not from wavs we ship

### Added
- **`ui/fsb5.js`** — reads an Assetto Corsa car's FMOD sound bank in the browser (FSB5, PCM16), and
  **`find_car_bank`** (Rust) locates `<car>/sfx/<car>.bank` across Steam libraries. On load, a replay
  now pulls its **own car's** engine layers: `loadCarSound(carId)` in `index.html` →
  `BBAudio.setCarBank()`. Non-fatal by design — no Tauri, no bank, an unexpected codec, or fewer than
  three engine layers all keep the built-in wavs, so the app degrades to how it sounded before.
- **`extract_bank.js`** — the same parser as a CLI, to dump any car's samples to wav for analysis.

### Why
The wavs in `ui/audio` are **one car's** engine (the Mach 6) hand-pulled from its bank — and there
are **16 T-180 variants installed on this machine alone**, which do not sound alike. Every replay of
any other car was playing the wrong engine. The bank also carries what the hand-pulled subset never
had: on the Mach 6, **11 on-load layers** (including four idle stages — the shipped set jumps 1642 →
3754 with nothing between) and **8 turbine/afterburner layers**. AC's engine is a *composite* — an
rpm ladder plus a jet spool — and we had been rebuilding only the ladder, from a subset of it. That
is the likelier reason the sound stayed thin than anything about the resynthesis method.

### Fixed
- **The FSB5 name table is a bare offset array, not a counted one.** Assuming a count shifts every
  name by one sample, which fails *silently* — a full set of plausible names attached to the wrong
  audio (`turbine.wav` would have been "backfire_5"; `eng_on_8700` would have been
  "IdleEngine_noise"). Caught by matching extracted PCM against the wavs already in `ui/audio`, which
  a different tool had extracted earlier: with the fix, all 24 shipped wavs match the bank sample
  **of the same name**. `test_fsb5.js` pins it with that same invariant rather than with durations —
  the first draft of that test asserted durations I had copied from the broken run, so it agreed with
  the bug.
- **`911gt3_gears` was being classified as an engine layer at "911 rpm".** A loose digit match put a
  gearbox recording in the rpm ladder; the layer name must now be the rpm and nothing else
  (`5591a_ext`, `7348c`, `6944b_off`, `idle_1837`), per AC's own convention.
- **Harmonic mode refuses to play the wrong car.** `engineprofile.js` now records which car it was
  measured from; loading a different car's bank hands the run back to the sample bank (which is that
  car's own layers, so correct by construction) and repaints the header button, instead of quietly
  playing the Mach 6's harmonic signature under another car's name.
- **Race on the audio graph**: `setCarBank` could install bank layers while `ensureGraph()` was still
  in flight, and that build appends its wav layers when it finishes — both engines stacked. It now
  waits for the build to finish first.

## 2026-07-25 — A second engine: harmonic resynthesis of the car's own signature

### Added
- **Harmonic engine** (`eng: harm` in the header, default; `eng: smpl` is the old bank — straight
  A/B, switchable mid-lap). Two wavetable oscillators per load bank carry the **measured harmonic
  profiles** of the neighbouring recordings, morph between them by rpm, and run at exactly
  **rpm/120 Hz** — the four-stroke cycle fundamental. Pitch therefore tracks revs continuously: no
  ±3-semitone clamp, no band edges to snap across, no loop to drone on. Routed into the existing
  `engineMix`, so the EQ, grit, panner, cone and doppler that were already tuned all still apply.
- **`make_engineprofile.js`** — measures that signature out of `ui/audio/eng_*.wav` and generates
  `ui/engineprofile.js` (23.8 KB): amplitude per harmonic, plus the broadband residual between
  harmonics in 8 bands, per recording. Regenerate after changing the recordings.
- **A broadband noise bed** driven by that measured residual, tracking rpm in the upper bands. Left
  out, a harmonic resynth sounds like an organ — the residual is 1–47% of these recordings' energy
  and it is where the "air" lives.
- **`test_engineharmonic.js`** — pins the material and the pitch law headlessly (the sound itself
  needs the browser): normalisation, harmonic depth, 8 noise bands, the grid holding across the
  bank, frequency exactly proportional to rpm, the stack still reaching 17.4 kHz at redline, and
  the script load order that classic-scope globals depend on. 19 checks.

### Why this method, on evidence
The recordings were probed before anything was written. Granular/PSOLA — the obvious "keep the real
audio, re-clock it" answer — was **ruled out by measurement**: no consistent firing period exists in
these files at any cylinder count (best mean autocorrelation 0.155 at the model lag), so grains
would have smeared. What the probe found instead is that they are **73–99% tonal** and every one is
a harmonic stack on the *same* grid, integer multiples of rpm/120 — 9 of 12 within ±0.5%, with
`eng_on_7644` simply starting on the 3rd harmonic of that grid rather than the 1st. A harmonic
series with amplitudes that move with rpm and load is directly resynthesizable, so that is what this
does.

**This is not the invented V8 muted on 2026-07-23.** That was synthesis laid *over* the samples,
which is exactly why it stopped sounding like the car. Nothing here is invented: every amplitude is
measured from the car's own audio. Honest limit, stated so it isn't rediscovered by ear: harmonic
mode does not widen the rev range by itself — frequency is exactly proportional to rpm, so a pinned
run still spans 4.34 semitones. It buys continuity and timbre movement; the **rev** slider (which
feeds this path too) is what buys span.

## 2026-07-25 — Rev contrast: the engine sounds flat when you never let it drop

### Added
- **Rev expander** (`REV_EXPAND_DEFAULT`, 1.75, live on the header's **rev** slider, 1.00 = untouched).
  Symptom, in the keeper's words: the Mach 6 held at high rpm goes *"wahhhhhh"* instead of revving.
  Measured on the T-180 sample and he's right — of 6,669 driving frames, p5–p95 rpm is 7,088–9,105,
  **88% of the run sits nearest the top TWO of nine sample bands and 27% above the highest recording**
  (8,700), so the bank has almost nothing to crossfade and the whole session spans 4.3 semitones. The
  samples were being rendered honestly; a pinned engine really is a drone. What was missing is contrast.
  So rpm is now expanded about a pivot before it drives band selection and pitch —
  `rpm' = pivot·(rpm/pivot)^expand` — which is a contrast curve, not a pitch shift: identity at the
  pivot, stretching both directions away from it. On the sample: **4.34 → 7.59 semitones, 4 → 6 bands
  in play**, so the timbre moves and not just the pitch, which is most of what "revvy" is.
- **The pivot is per replay** — this run's median driving rpm (set from `ex.tel` at load), so the
  expansion pushes away from *how you actually drove* and the engine's resting voice stays put. A
  cruise and a qualifying lap both stay recognisable instead of one of them being shifted wholesale.
- **`test_revexpand.js`** — measures the effect on a real replay rather than asserting the formula
  back to itself: identity at the pivot, symmetric expansion, span widened, more bands in play, and
  the p99 still inside `RATE_HI` (the top of the range flattening again is exactly the bug being
  fixed, so it gets a regression check). Constants are parsed out of `audioengine.js` source, never
  re-typed, so retuning the engine cannot leave this test green for the wrong reason.

### Fixed
- **Overrun mush at the top of the range** (`RATE_HI_OFF`, 1.5). The off-load bank stops at 6,944 rpm
  and shared the on-load pitch ceiling of 1.26, so above ~8,750 a lift left the overrun layer
  pitch-locked *below* the on-load layer — two detuned engines instead of one lifting. It now gets its
  own wider ceiling and tracks up there, which is where the "blwahhh" lives. 17% of the sample run is
  off-throttle, so this is not a corner case.

## 2026-07-25 — The logger watched a folder that doesn't exist on this machine

### Fixed
- **`telemetry_logger.rs` never stamped anything on a OneDrive-redirected machine.** `replay_dir()`
  hardcoded `%USERPROFILE%\Documents\Assetto Corsa\replay`, but Documents is OneDrive-redirected on
  the laptop (`%OneDrive%\Documents\…`), so the once-a-second scan for new replays walked a path that
  does not exist, found nothing forever, and stamped no telemetry — **silently**, because a missing
  folder and a folder with no new replays look identical to the scan. Every replay recorded on that
  machine therefore had no RPM/gas/brake/gear tail, which reads downstream as dead audio in BLACKBOX
  (`BBAudio.update` gets nothing to resynth from), not as a logger error. Now both roots are checked
  and whichever actually holds the folder wins — the same "paths are data, not code" fix already
  applied to `lib.rs`'s `replay_dir`. The chosen path is written to `telemetry_logger.log` on startup,
  and the no-folder case logs a WARNING naming the fallback, so this failure can never be silent again.

### Fixed
- **A lit rectangle that travelled with the car** (screenshot-verified): the grandstand's shadow
  bands crossed the track, stopped dead in a box centred on the car, and resumed with hard vertical
  edges. `buildLightVP` derived its caster reach from `R` — eye at `R*1.8`, far plane at `R*4` — so
  tightening `R` from 90 to 40 for sharpness also cut how far up-sun the near cascade looked for
  casters, 161 m → 71 m. The grandstand fell outside the near map, so nothing cast inside it, while
  the far cascade still had it: hence the boundary. In light space a caster shadows the same (x,y)
  it occupies, so a tight box never loses a caster *sideways* — only one standing between the light
  and the near plane. Reach is now an explicit argument (`SHADOW_CASTER_REACH`, 600 m) independent
  of `R`, so `R` buys texel density and reach decides caster capture. Regression-tested in
  `test_shadowbox.js`, which extracts the real `buildLightVP` and asserts the old box clips a 120 m
  caster while the new one captures it.
- **Shadow bias is now stated in metres, not NDC.** The light box got ~7.5× deeper, and a fixed NDC
  bias means a different world distance in every box — `0.0006` is 10 cm in a 160 m box and 60 cm in
  a 1.2 km one. Left alone the fix above would have traded missing shadows for peter-panning. The
  shader now takes the cascade's depth range as `uShadowDepth0` and converts, so the bias is immune
  to whatever `R` or reach are set to next.

### Changed
- **Sharper cast shadows.** Near cascade `R` 90 → 40 and size 4096 → 8192: 4.4 cm → 0.98 cm per
  texel on the car's own shadow. Far (static whole-track) bake 4096 → 8192, which is why distant
  shadows no longer read as absent until you approach. Near/far cascades now blend across the near
  box border rather than switching on a hard `if`. `initShadow` clamps a cascade to
  `MAX_TEXTURE_SIZE`, so a smaller GPU loses sharpness instead of losing shadows to an incomplete FBO.

### Added
- **`ui/ghosts.js`** — state and alignment for running several replays at once, ahead of the
  rendering work: per-ghost holographic/full modes as one declarative effect table, a `GhostSet`
  with a primary reference run, and a `carId`→model cache with refcounts so four cars in one Mach 6
  upload once and draw four times. Alignment is by **distance around the lap, not time** — two laps
  on a common clock stop showing the same piece of track after one corner, whereas at equal distance
  they stay side by side and the time difference *is* the delta. Covered by `test_ghosts.js`.
- **`samples/`** now carries a T-180 test-track replay so the app can be exercised without an
  Assetto Corsa install.

### Changed (internal)
- **`carModelMatrix` is pure.** It used to assign the global `carSteerAngle` as a side effect — the
  reason the call site was commented "call it exactly once" — so a second car would silently
  overwrite the first car's steering. It now takes the run to operate on and returns `{mat, steer}`;
  `driverPose` likewise takes its ghost's steer. Omitting the new arguments falls back to the primary
  run, so the single-car path is unchanged. `test_ghostmatrix.js` pins it.

## 2026-07-24 — Grip hollow + curl bias (fingers no longer clip through the wheel face)

### Fixed
- **Fingertips poked out through the wheel's far face** (screenshot-verified): the hand is sculpted
  gripping AC's generic FAT rim (~50 mm palm-to-fingertip channel), but the T-180's bar is ~24 mm —
  the fingers are longer than the bar is deep, so the spare length must exit somewhere, and it exited
  the visible face. The grip anchor is now the **hollow of the whole digit ring** (knuckles + mids +
  TIPS + thumb tips, measured from the rig) **biased deeper into the curl** (`DRIVER_GRIP_BIAS`,
  12 mm, along the measured knuckles→tips direction), which seats the bar in the fingers and sends
  the spare length to the hidden palm side instead. Net on the T-180: each hand sits ~33 mm further
  back toward the driver. A true per-phalanx finger-conform (curling joints to the bar radius) is the
  full fix if ever needed; this is the placement-only version.
- **Final eyes-on tune**: `DRIVER_PALM_OFFSET` is now SIGNED and set to −20 mm (hands+fingers seated
  ~1 inch forward of the hollow+bias anchor) — judged on-screen by the keeper as the landing point.
  The full grip chain is: digit-ring hollow → +12 mm curl bias → −20 mm depth trim → bar core snap.

## 2026-07-24 — Palm-cup grip placement (hands no longer overshoot the handles)

### Fixed
- **Hands reached the wheel but carried on past it** (screenshot-verified): grip placement anchored
  the WRIST, but the actual contact — the palm cup, the hollow of the curled fingers — sits ~112 mm
  past the wrist in the seated pose, so wrist-based placement pushed fingers beyond the bar. Now the
  **palm cup** (centroid of the 8 proximal+middle finger joints, measured from the rig: L fingers are
  Index/Middle/Ring/Pinkie 1–3, R fingers 4–6) is placed on the bar core via `palmGrip`
  (`ui/carrender.js`), with `DRIVER_PALM_OFFSET` repurposed as a small grip-depth trim (5 mm).
  On the real T-180 this pulls each hand ~26 mm back and ~24 mm inboard — the measured overshoot.
  Verified on real assets: shifted cups land on the bar core to the millimetre, both hands.

## 2026-07-24 — Linear per-run steering + steer.ksanim support (and a parser bug it exposed)

### Fixed
- **`parseKsanim` read v2 keyframes in the wrong field order** (`ui/kn5.js`): position-first instead
  of the actual layout — **rotation (quat x,y,z,w), then position, then scale**. Nothing had ever
  called it, so the bug was latent since the parser was written. Proof of the fix on the T-180's
  steer.ksanim: every quat becomes exactly unit-norm and an unmoving torso bone's position matches
  its bind translation to the millimetre. Regression-guarded in `test_steeranim.js`.
- **The wheel visibly stalled near its lock while the car kept turning**: the saturating tanh map
  crawls asymptotically long before the cap. Replaced with a **LINEAR per-run scale** — the wheel is
  proportional to the car's steer the whole way, scaled so this replay's 98th-percentile steer
  (`steerRefCalib`, computed at load from the extract) lands exactly at the lock. It only caps in the
  top 2% wildest frames. On the T-180 the effective lock is the full ±120° (`STEER_WHEEL_MAX`), since
  the arms' calibrated reach covers the whole orbit of its small wheel.

### Added
- **Authored steering-animation support** (`driverAnimInit`/`driverAnimWorlds`/`animT`/`ksanimLocal`
  in `ui/carrender.js`): when a car ships `animations/steer.ksanim` (the Rust side already served it;
  nothing had used it), the mod author's own lock-to-lock animation — clavicles, arms, hands, every
  finger — drives the driver, palms wrapped on the grips by authorship. Anim locals compose over the
  seated pose's local chain (verified: L0-only composition reproduces the knh worlds to 0.0 mm); the
  wheel↔hand sync uses a sampled θ(t) arc map so they stay glued even where the anim isn't linear
  in t. **Discovery, documented in the test: the T-180's own steer anim is degenerate** — its hand
  sweeps 25 mm lock-to-lock, too small to express a turning wheel — so `driverAnimInit` refuses it
  (guard: authored range < 20°) and the viewer falls back to the IK/snap path. Cars with real
  steering anims get the authored version automatically.
- **`test_steeranim.js`** — real-asset proof (needs the G: AC install, like `test_carscene.js`):
  parser regression, composition exactness, anim-centre local == knh local element-for-element,
  anim-centre hand on the authored hand at 9 mm, the degenerate-anim refusal, and `steerRefCalib`
  recovering a synthetic run's constant slip. 7 checks, all passing.

## 2026-07-24 — Glued-grip steering (wheel turns with the car; hands stay ON the grips)

### Fixed
- **Cockpit wheel no longer stops short in sharp corners** (`ui/index.html`). It was hard-clamped to
  the driver's hand-orbit limit (±60°, `DRIVER_GRIP_SPIN_MAX`), so past that the wheel and driver froze
  while the road wheels kept steering. `STEER_WHEEL_RATIO` also raised 3.0 → 6.0 so the rotation reads
  like a real wheel.
- **Hands no longer float off the rim at big angles**: `ik2bone` silently clamps an out-of-reach target
  short of the grip, which is exactly where the hovering hands came from. The arms now always land ON
  the grip (see below). *(An intermediate hand-over-hand re-grip approach — `gripWrap`/`gripFollow` —
  was built and replaced the same day, uncommitted: it let wheel and hands diverge, which looked worse,
  not better.)*

### Added
- **Glued-grip solver** (`gripSat`/`armSolve`/`gripLockCalib` in `ui/carrender.js`). One spin drives
  the wheel AND the hands, so they can't diverge. The raw steer runs through a smooth saturating lock
  (`lock·tanh(raw/lock)`): near-linear in normal corners, keeps creeping in hairpins — never freezes —
  and never exceeds what the hands can hold. When the grip crosses past plain 2-bone reach, the
  **shoulder leans toward it** (up to `DRIVER_SHOULDER_REACH`, 0.15 m), like a real driver in a
  crossed-over turn, and the whole arm subtree translates with it. The lock itself is **calibrated at
  load from the car's own rig** (largest orbit both hands can reach, lean included) — a guessed
  constant replaced by measurement, in the house style.
- **Wrist no longer twists goofily at big angles**: the hand used to get the upper-arm swing + forearm
  swing + a wheel-roll stacked on top, which drifted its orientation off the authored grip as angles
  grew. The hand (+fingers) is now **welded to the wheel** — its pose is exactly the authored grip
  orbited about the wheel axis, same as the wheel mesh — and the arm swings to meet the wrist, the
  wrist flex being whatever connects them (like a real wrist). `driverSeatedSkin` split into
  `driverSeatedPose` (pure, testable) + upload.
- **Grips snapped onto the wheel's actual MATERIAL** (`snapToMesh`/`gripTarget` in `ui/carrender.js`).
  The T-180's authored hands floated ~150 mm from the spin axis but its wheel mesh ends at 127 mm —
  the pose gripped a wheel that isn't there. A first attempt fitted an idealized rim circle
  (`rimFit`, same-day, uncommitted), which a handled wheel defeats: the fit passes through the grip
  HOLES. Now the grip snaps to the nearest actual material — nearest wheel vertex, then mean-shift to
  the local centre of the handle bar (a hole has no verts to attract it) — and the wrist holds a
  **palm offset** (`DRIVER_PALM_OFFSET`, 30 mm) back along its approach so the palm wraps the bar
  instead of the wrist sinking into its core (fingers through the hole). Verified against the real
  T-180: wrists land 30 mm off the bar core at the handle band's outer edge, hand mesh riding the
  shift, arms re-solved to it even at rest. Blend tunable `DRIVER_GRIP_SNAP`.
- **Condensed high-sensitivity steering zone** (`STEER_WHEEL_MAX`, default ±120°): the wheel still
  tracks the car's full steer range monotonically, but compressed formula-style instead of sawing
  through crossed-over arm territory. Effective lock = min(this, the calibrated arm reach). (First
  cut at ±86° read as not turning enough — opened to ±120°.)
- **`test_gripreach.js`** — headless proof on the same exported code: live grip is exactly the orbited
  bind grip, bone lengths hold at every angle (the hand really lands on the grip), shoulder lean stays
  in budget and fires when needed, the calibrated lock is honest (reachable inside, genuinely not just
  past), seated pose untouched at rest, saturating map monotone/bounded, a full synthetic-skeleton
  pass proving the hand weld (hand on the live grip, fingers rigid with it, arm chain meeting it),
  rim recovery on a synthetic dished wheel (centre found to 0.1 mm from a pivot 28 mm off), and the
  weld riding a snapped grip. 24 checks, all passing.

## 2026-07-24 — Telemetry logger: continuous buffer (reset-heavy hotlapping no longer loses laps)

### Fixed
- **Restarts/resets no longer wipe the telemetry buffer** (`src-tauri/src/bin/telemetry_logger.rs`).
  The stint detector cleared the whole buffer whenever `live` returned after a >2.5 s non-live gap —
  but a "restart session" *is* such a gap, so reset-heavy hotlapping (run off → restart, repeatedly)
  cleared the buffer on every restart. The clean lap you finally saved came out with idle-fragment or
  no telemetry → bugged/silent audio in BLACKBOX. Root-caused from a real broken recording (2026-07-24
  15:16: AC autosave had zero telemetry, CM save had a 2,366-sample idle fragment; the log showed three
  back-to-back "new driving stint" clears just before).
- **Now a continuous rolling buffer:** records the whole time AC is open, clears only on AC **close**
  (genuine new session). BLACKBOX's existing time-based tail-align grabs the saved replay's slice, so
  any reset pattern is fine. Capped at ~25 min (trims oldest 5 min) so a day-long session can't grow
  unbounded — lossless for the loader, which only uses the tail. Built + deployed to
  `%LOCALAPPDATA%\BLACKBOX\telemetry_logger.exe` and restarted live.

## 2026-07-23 — Windowed fullscreen

### Added
- **Windowed fullscreen toggle** — `F11` or the `⛶ full` header button toggles Tauri borderless
  fullscreen (no exclusive mode switch; alt-tab friendly). Falls back to the browser Fullscreen API
  when not running under Tauri. Granted `core:window:allow-set-fullscreen` + `allow-is-fullscreen` in
  the capabilities (only `core:default` was present, which doesn't include the fullscreen setter).

## 2026-07-23 — Thruster rebuilt as a blue jet afterburner

### Changed
- **Turbine flame is now a real afterburner cone** (`drawThruster`) instead of a line of ~11 dots. A
  dense (32) thin white-hot blue **core** with drifting **shock diamonds** (periodic bright spots),
  wrapped in a soft blue **outer glow** (22), with turbulent lateral wobble that grows toward the tip
  and a plume that stretches harder under boost. Shader core color deepened (blue edge → white-hot
  center). Matches the "blue afterburner" look confirmed by the user. Then dialed **shorter and
  girthier** per feedback: `len 0.55+3.4·inten → 0.4+1.5·inten`, core/glow radii fattened (~0.095/0.19,
  fattest at the nozzle) — a stubby burst out the nozzle rather than a long trail.

## 2026-07-23 — Night lights: distance attenuation (fix distance blowout + see-through)

### Fixed
- **No more distant "ball of light"** — the lens flare is screen-space (fixed NDC size), so a far car
  threw the same full-size glare as a near one; now faded hard with distance (full ≤15m → gone by ~60m).
  The headlamp soft-halos also fade out with distance (gone by ~42m) leaving only the crisp bulb, and
  each bulb dims at range so the 3-lamp cluster doesn't stack additively into a hot blob.
- Reduced the see-through-geometry at range (the halos that spilled over environment geometry are now
  distance-faded). NOTE: near-field glow is depth-tested by the lamp-center depth, so a lamp behind a
  wall is hidden, but a large halo can still spill over *thin* foreground geometry when the lamp center
  peeks through a gap, and the flare ignores depth by design (lens artifact). A proper per-pixel fix
  needs a scene-depth texture (also would restore smoke soft-particles lost when HDR was disabled) —
  deferred.

## 2026-07-23 — Night: luminescent headlights + elegant lens flare

### Added
- **Headlamps read more luminescent at night** (`drawCarLights`) — each lamp now gets a soft additive
  halo (plus a wide bloom on the top lamp) that swells with how head-on the beam is to the camera, so
  the lights glare when you look into them. Rebuilt as drawn glow because HDR bloom is now off.
- **Elegant lens flare** (`progFlare` / `drawLensFlare`) — a screen-space additive glare for the
  headlamps: tight core + soft round glow + anamorphic horizontal streak + a faint vertical spike,
  warm-white. Gated on `facing^3 × nightF` and eased toward screen edges, so it only appears when the
  beams point at the camera (front views / flybys) and stays restrained rather than a constant smear.

## 2026-07-23 — Tach scale matched to the real limiter

### Fixed
- **Tach no longer under-fills** — the bar left a chunk of empty range when using all of a gear. First
  pass scaled to the limiter (`RPM_MAX 10200→9850`), but a chunk remained: telemetry shows hard
  upshifts land ~9069 rpm and p99.9 is 9355 — the 9842 limiter is only a top-0.1% brush, so scaling to
  it still left the shift point at ~92%. Set `RPM_MAX=9350`, `REDLINE=8900` (the real shift/redline
  zone) so a hard pull reads near-full with a sliver and the rare limiter kiss pegs the bar. Also moved
  the rev-limiter backfire trigger 9400 → 9750 (it was firing mid-rev, below the actual limiter).

## 2026-07-23 — UI: HDR removed, volume control, auto-hiding top bar

### Removed
- **HDR/bloom turned off for good + toggle button removed** — the bloomed look was disliked. `hdrFX.enabled`
  now defaults `false` (scene renders straight to canvas, no bloom/ACES tonemap); the `HDR` header button
  and its toggle handler are gone. Smoke falls to its direct-billboard path (the same look seen with HDR
  toggled off). HDR post code is left in place, dormant, in case it's ever wanted back.

### Added
- **Volume control in the header** (`#volCtl` slider + speaker icon) — drives a new `BBAudio.setVolume(0..1)`
  that scales the master ceiling live; the icon click mutes/unmutes (remembers last level). Replaces the
  old HDR button's slot in the bar.
- **Auto-hiding top bar** — the header now fades away after ~2.6s of pointer idle and returns on any
  activity (mirrors the existing transport auto-hide: same timing, kept visible while hovered). It's now an
  absolute overlay with a gradient backdrop so the 3D view goes full-screen when the bar is gone.

## 2026-07-23 — Engine audio: longer travel, quieter tail, wider directional stereo

### Changed
- **Sound travels much further — a loud car carries far, then genuinely fades** (`ui/audioengine.js`)
  — distance falloff retuned `DIST_REF 20→48`, `DIST_ROLLOFF 1.5→1.4` (exponential). Big full bubble
  so the T-180 carries out to long range, then keeps diminishing with no plateau (~38% at 96m, ~14%
  at 200m, ~4% at 500m, ~1.4% at 1000m).
- **Killed the far-distance plateau** — the reverb/echo wash bypasses the panner and had a hard floor
  (`k = 0.15 + 0.85*df`) that never let it drop below 15%, so once the dry engine went faint far off,
  the never-dying wash was all you heard → "fly across the map and it never gets quieter." Removed the
  floor (`k = df`): the wash now fades fully to zero with distance, so flying out genuinely goes silent.
  (Superseded the same-day 36/2.2 and 48/1.25 passes.)
- **More directional stereo** — the HRTF panner output now runs through the mid-side `widener` (1.35)
  before the master bus, boosting the inter-aural (L↔R) difference so left/right car positions swing
  harder across the field. Mono-safe (mid untouched); kept moderate so the center stays solid.

## 2026-07-22 — Interactive smoke physics, density merge, collision, light fixes — PARTLY UNTESTED

### Added
- **Sparse "air" velocity field** (`AIR`, docs/SMOKE_PHYSICS.md) — cars stir a shared, world-
  anchored velocity grid (per-wheel swirl injection, flattened to the surface plane); smoke
  advects through it. Foundation for multi-car / multi-replay interaction (body wake off by
  default until a 2nd car exists).
- **Real slip-angle signal** (`computeWheelSlip`) — smoke + marks now key off the ANGLE between
  body heading and travel (from recorded wheel data), not lateral G. A gripping banked lap reads
  ~0° → no smoke; genuine slides read high. Validated offline against bowl/centrifuge replays.
- **Velocity inheritance + tyre-precise spawn** — fresh smoke inherits the wheel's velocity (stays
  around the tyre, then trails), spawns at the true sub-frame CONTACT PATCH (wheel centre − radius),
  speed-gated (T-180 curve: 100 km/h ≈ 10%, 200 ≈ 50%, 400+ full).
- **Seamless density merge** (`progSmokeComp` + half-res accumulation buffer) — particles splat
  additively; one composite ramps the summed density so overlapping puffs fuse into one field.
  Plus **world-anchored noise erosion** (reconstructed from depth) that frays it into wisps.
- **Per-frame smoke↔track collision** — dedicated FINE-celled collider built from the ROAD MESH
  ONLY (`smokeColl`, not the environment) so per-particle queries stay cheap on asset-heavy tracks;
  segment test bends smoke off surfaces, plus a per-frame down-ray floor to the actual surface.
- **Skid marks dropped to the contact patch** (were floating a wheel-radius above the track).

### Changed / Fixed
- **Light housings no longer leak** — head/brake cones no longer light the car's own body; glow
  halos tightened to the apertures (HDR bloom does the spread); brake bulbs flare brighter (not
  bigger) on braking; turbine glow recessed inside the nozzle.
- **Turbine plume** dot-spacing now scales with turbine power; **backfire moved off the turbine to
  the two dual exhausts** that flank it (`EXH_*` offsets, tune to model).

### Notes
- Much of this is still being visually dialled in. Collision uses the road mesh only (won't collide
  with off-track props — intended). Real telemetry (RPM/gear/throttle) is NOT in autosave replays;
  backfire/turbine are kinematic inferences — see the single-file append-telemetry experiment.

## 2026-07-22 — Smoke rework: soft particles, curl motion, build-up — VISUALLY UNTESTED

Full rework of tyre smoke after research (three agents: billboard texture, motion/build-up,
volumetric-vs-particle). Verdict: well-lit soft particles, not raymarching.

### Added
- **Baked domain-warped fbm noise texture** (`bakeSmokeNoise`, CPU, 256² R8, no assets) —
  sampled per-billboard with two rotated/scrolling UV layers that evolve over the particle's
  life, so each puff has internal wispy churn and a noise-carved soft edge instead of a flat disc.
- **Particle shading** (`progSmoke` rewrite) — half-Lambert against the sun + hemisphere sky/
  ground ambient + vertical self-shadow, output linear into the HDR buffer so ACES+bloom light
  the sunlit rims. Premultiplied alpha (`ONE, ONE_MINUS_SRC_ALPHA`) kills dark fringes.
- **Soft-particle depth fade** — scene depth is blitted from the HDR fbo's depth renderbuffer
  into a sampleable depth texture (`depthTexTarget`) each frame; the smoke fades where it meets
  ground/car instead of cutting a hard line. HDR path only; degrades gracefully without it.
- **Curl-noise motion** (`bakeCurl`/`sampleCurl`, Bridson 2007) — a baked 24³ divergence-free
  velocity grid, trilinearly sampled per particle and relaxed into velocity → organic swirl
  instead of radial puffs. Plus a gentle ambient wind (`SMOKE_WIND`).
- **Build-up over time** — per-wheel slide accumulator (`SLIDE_GAIN/TAU/MAX`): smoke thickens
  the longer/harder a wheel slides (emission rate + start size scale with it), decays fast on
  grip. Two particle classes: rising **puffs** + long-lived ground-hugging **haze** (the
  lingering trail), haze fraction rising with build-up.

### Notes
- **Built this session — compiles + launches, NOT visually verified.** Dials: `smoke.cap`,
  the `11` emission-rate + `baseA` per class (smokeStep), `SLIDE_*`, `CURL_FREQ/STR`,
  `SMOKE_WIND`, the `fadeDist` 0.6 (soft-particle softness), and the noise UV scroll speeds
  in the smoke FS.

## 2026-07-22 — Tyre marks + smoke, Catmull-Rom suspension — VISUALLY UNTESTED

### Added
- **Tyre skid marks.** A dark ribbon laid along each wheel's real recorded contact
  patch (`ex.wheels`), gated by a slip signal inferred from the stable G-forces
  (`computeWheelSlip` — cornering loads the outer pair, braking loads the front).
  The whole mesh is prebuilt once per car (`buildTireMarkMesh`), each vertex tagged
  with the frame + lap it was laid at; a shader (`progMark`) reveals it up to the
  current frame, so marks draw on as the car drives and scrub correctly — near-zero
  runtime cost. New `tyres` toolbar button cycles **lap** (reset each lap, default) →
  **keep** (accumulate + slow fade) → **off**.
- **Tyre smoke.** Live camera-facing billboard particles (`progSmoke`, JS pool) emitted
  off the same slip signal, into the HDR buffer so it fogs + tonemaps with the scene.
  Playback-time driven: pause freezes it, a scrub/jump clears it, forward play ages +
  emits. Grey dims at night so it doesn't glow.

### Changed
- **Wheel suspension interpolation is now Catmull-Rom** (`wheelWorldAt`) through the
  recorded wheel centres, with a clean 4-frame stencil (falls back to linear at the
  ends / across gaps). Smooths sharp single-frame events (curb strikes) that plain
  lerp ramped in straight segments. Identical to lerp for normal banking/bumps.

### Notes
- **Built this session — compiles + launches, NOT yet visually verified.** Tuning
  knobs: `SKID_ON`/`SKID_RANGE` (slip deadzone/ramp, carrender.js), `MARK_COLOR`/
  `MARK_ALPHA`/`MARK_FADE_FRAMES`, and the smoke pool constants in `smokeStep`
  (life, buoyancy, size, `smoke.cap`) + the grey in `smokeStepAndDraw`.

## 2026-07-21 — HDR pipeline (blacks black, light LIGHT) — VISUALLY UNTESTED

### Added
- **True HDR rendering.** The scene renders into an RGBA16F float buffer with an
  UNCLAMPED range (the in-shader clamp + grade were removed — the tonemap owns tone
  now). A post chain blooms only genuinely-bright pixels (threshold ≈ 1.0) and
  **ACES-tonemaps** to the screen: darkness stays crushed, highlights roll to white
  and never hard-clip. `HDR` toolbar toggle; falls back to direct rendering without
  `EXT_color_buffer_float`.
- Night ambient crushed toward black so unlit night is truly dark; the moon key + the
  car's own lights do the lighting.
- Car lamps / tail / LEDs / backfire / turbine emit real HDR (`HDR_EMIT`) so they blow
  out and bloom instead of clamping to flat white.

### Notes
- **Built during an autonomous session — compiles + launches, but NOT visually verified.**
  Tuning knobs: `hdrFX.exposure/threshold/bloomAmt/sat`, `HDR_EMIT`, the night
  `LIGHT_KEYS` ambient. Daytime tone may need a keyframe re-tune (the old keys were set
  for clamped LDR). If anything looks wrong, the `HDR` toggle reverts to the prior look.

## 2026-07-21 — cast shadows (car + track) + headlight occlusion

### Added
- **Directional cast shadows**: the car (and nearby track) render depth-only from the
  sun/moon direction into a 2048² depth map; the scene shader PCF-samples it, so the car
  and the track's own banking/crests cast soft shadows that swing + stretch with the time
  of day. Slope-scaled bias (more at grazing/dusk angles) kills shimmer; a soft map-border
  fade stops the shadow popping on loops/corkscrews; `SHADOW_ON` toolbar toggle. Falls
  back to the contact-blob when unsupported.
- **Headlight beam occlusion**: scene depth rendered from the headlight's view (night only),
  so track geometry (bowl banking, crests) blocks the beam instead of it shining through
  solids. The car is deliberately excluded from the beam occluder (its own nose spar would
  blot the beam centre).
- Ride height nudged (`carLift −0.28`) so banked sections don't clip the tyres.

### Notes
- Two extra full-scene depth passes at night (shadow + beam) — a quality/tier feature.

## 2026-07-21 — turbine, backfires, gear detection, car seating

### Added
- **Turbine luminous at night**: the thruster plume now brightens with `nightF` (up to
  ~3×). It also emits from the model's actual turbine nozzle (`Placeholder_TurbineGlow`,
  extracted at load) at the nozzle **mouth** so the housing occludes it (depth-tested) —
  it glows out the opening instead of through the bodywork — and is tighter so it no
  longer clips the nozzle.
- **Exhaust backfires on upshifts** (the "woke" bit): `detectShifts(ex)` finds upshifts
  kinematically at load — an upshift briefly cuts torque, so acceleration dips sharply
  toward zero mid-pull (validated ~4–8/min across tracks; false positives filtered). At
  those frames a bright orange pop fires out the nozzle, brighter at night. Inferred (no
  gear channel), so approximate.

### Fixed
- Car was floating: the recorded position sits ~0.36 m above the track (tyre geometry
  bottoms out at model y≈0.006, i.e. the ground plane), so `carLift` drops it onto the
  surface.

## 2026-07-21 — night: day/night lighting, car lights, contact shadow

### Added
- **Time-of-day lighting**: one `timeOfDay` (0–24h) drives a single key light arcing
  across the sky and crossfading sun→moon, plus the atmosphere (hemisphere ambient +
  sky/fog colour), keyframed at midnight/dawn/noon/dusk. A toolbar slider (🌙/☀ +
  clock) scrubs it; opens at night. Scene shader (glcore FST) takes the sun dir/colour
  and ambient sky/ground as uniforms.
- **Car lights** (emitted from the model's own housings, clustered per lamp): headlights
  are a warm **cone spotlight in the shader** that lights the road ahead; the 3 lamps
  per side glow as crisp bulbs (only the top keeps a halo, so the lower two don't leak).
  Tail lights bleed red and **flare + wash red behind the car under braking** (a wide
  backward cone). White + red LED accent arrays on the body glow too. All fade in at
  night (`nightF`).
- **Contact shadow**: a soft dark oval decal on the track under the car so it reads as
  grounded, not hovering. Stand-in until real cast shadows.

### Fixed
- Brake-light triggering: the replay has **no brake channel** (verified by probing the
  full 284-byte frame as float/int and by correlation — online autosaves store only
  visual state). So braking is inferred *physically*: gravity-corrected deceleration
  (`brakeG = −longG − hy`, so loops/banking don't count) minus cornering scrub
  (`BRAKE_SCRUB·latG²`), then a deadzone (`BRAKE_DEADZONE_G`). Only real braking lights up.

## 2026-07-21 — refactor: extract car/driver rendering (no behaviour change)

### Changed
- Moved the whole car/driver/wheel render layer out of the `index.html` monolith into
  `carrender.js` (loaded before the main script): `carModelMatrix` (+ slip),
  `drawCarGroups`, `wheelSteerModel` (steer + roll + suspension lift), `axisSpinModel`,
  `carGForces`/`wheelLift`, and the driver system (`driverPose`, `driverSkinUpload`,
  `driverSeatedSkin` IK). App state + tunables stay in `index.html`; behaviour unchanged.
  `index.html` is now render loop + UI + asset loading (~2,660 → ~2,180 lines). Final
  step of splitting the monolith before the lighting/shadow work.

## 2026-07-21 — refactor: extract math helpers (no behaviour change)

### Changed
- Pulled all the pure matrix/vector helpers out of the `index.html` inline script
  into a new `mathutil.js` (loaded first, shares global scope): `mMul`,
  `mPerspective`, `mLookAt`, `rotP`, `scaleMat`, the `v3*` vector kit, `mXfPt`,
  `mRot`, `mT`, the row-vector `rv*` set, `ik2bone`, `easeK`, `IDENT4`. The file
  documents the two matrix conventions (column-major camera/GL vs row-vector
  kn5/skeleton) so they stop getting mixed up. First step of splitting the monolith
  before adding the lighting/shadow passes; behaviour is unchanged.

## 2026-07-21 — procedural suspension

### Added
- Each wheel corner now travels vertically against the body under load and bumps.
  The replay has no suspension channel, so it's inferred from the path's local
  acceleration (`carGForces`): dive/squat from longitudinal g, roll from lateral g,
  bumps from vertical g. Deterministic (scrub-safe), clamped to ±4.5 cm. Tunables:
  `SUSP_LONG`, `SUSP_LAT`, `SUSP_BUMP`, `SUSP_MAX`, `SUSP_LAT_SIGN`, `SUSP_ON`.
  Whole corner (tyre + exo cage) travels together via a `lift` arg on
  `wheelSteerModel`. Still to be dialed in visually.

## 2026-07-21 — wheel roll-spin

### Added
- The road wheels now roll on their axle with the car's travel (they used to only
  steer). Roll angle = cumulative distance / tyre radius, read from a per-frame
  cumulative-distance track built at load, so it's scrub-safe: scrub back and the
  tyres roll backward, pause and they stop. Direction flips via `WHEEL_ROLL_SIGN`.
- Tyre rolling radius is measured from the wheel mesh (furthest vertex from the
  pivot in the plane perpendicular to the axle).

### Changed
- Each corner is now split during kn5 parse into the rolling tyre (`rollGroups`) and
  the static exo cage / hub (`staticGroups`, the Mach6 "M" pods). Both steer with the
  wheel, but only the tyre rolls — the exo cage no longer spins with the axle.

## 2026-07-21 — follow-cam fog clamp + look-down

### Changed
- Follow-cam distance fog no longer washes out the background when zoomed in close.
  The density was `0.35 / cam.dist`, so a small chase distance blew it up; it's now
  clamped with a distance floor (`0.35 / max(cam.dist, 120)`), keeping the soft
  far-fade when pulled back without the close-up haze.
- Fully zoomed in, the follow camera now pitches ~12° downward (ramped by zoom) for
  a "looking down with a neck" angle over the car (`FOLLOW_LOOKDOWN`).

## 2026-07-21 — driver seated on the wheel + real car colours

### Added
- Driver hands are now genuinely on the wheel. Instead of guessing a grip target
  and fighting inverse kinematics against it, the driver's skeleton is posed with
  the car's own authored seated pose (`driver_base_pos.knh`), which repositions the
  shared driver so the hands grip *this* car's wheel exactly. New
  `parseDriverPose` (knh node-tree parser) in kn5.js; `find_driver` now also
  returns the car's `driver_base_pos.knh`. Rigid head/helmet meshes are corrected
  onto the seated head by their nearest posed ancestor bone (RIG_Head), so the head
  sits on the neck instead of floating at the model's bind position.
- Hands orbit with the steering: each grip point rotates about the wheel's spin
  axis by the steer angle and the elbow re-solves (2-bone IK), then the whole
  arm→hand→finger subtree swings so nothing tears. Steer=0 reproduces the seated
  pose exactly. Orbit is capped (`DRIVER_GRIP_SPIN_MAX`) because the rigged arm is
  nearly straight at rest and can't reach up-and-over past ~40° without a real
  hand-cross; beyond the cap the wheel spins under a held grip.

### Fixed
- 24-bit uncompressed DDS textures now decode (kn5tex.js). AC paints each car
  component with a tiny `color_*.dds` swatch, and the T-180's are all 24bpp RGB —
  the decoder only accepted 32bpp, so every painted part (wheels, red suspension,
  carbon, tyres, copper, metal, LEDs) fell back to flat white. The body livery was
  DXT5 and always worked, which is why only the body had colour. Now the whole car
  is coloured as authored.

### Changed
- Driver body is a rigid seated pose in car space (no more scale/offset fudge
  factors); only the head turns into corners, capped at a realistic neck range.

## 2026-07-20 — steered wheels + driver model (WIP), camera refinements

### Added
- Wheels are split out of the car body during kn5 parse (by `WHEEL_LF/RF/LR/RR`
  nodes, keeping each centre pivot) and steered every frame to point along the
  actual direction of travel (the slip angle) while the body keeps its crab. No
  steering-lock cap — the wheels follow the line even in a 90°+ slide.
- Driver model + steering animation groundwork: `parseDriver` (skeleton + class-3
  skinned meshes with bone weights/inverse-bind) and `parseKsanim` (v2: per-node
  position/quaternion/scale keyframes) in kn5.js; `find_driver` Tauri command
  locates the shared driver kn5 + the car's `steer.ksanim`. The driver renders at
  its bind (seated) pose for now — skinned steering animation is next.

### Changed
- Camera: fully-zoomed view drops the eye to the car's level and tilts up the road
  with a wider FOV (was looking at the ground); zoom range pulled back slightly.
- Playback defaults to 1×; the transport bar auto-hides when idle; the HUD metric
  chips are slimmer/subtler.

### Fixed
- Close-up clipping: the eye no longer sits inside the car body when zoomed (min
  distance clears the tail), and the follow-cam near plane is small enough not to
  clip the car.

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
