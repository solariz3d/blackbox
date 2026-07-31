# Rebuilding a stand-in track from the replay itself

**Status: BUILT, 2026-07-31** — `ui/trackgen.js` plus `buildStandInTrack()` in `loaders.js`,
behind the **stand-in track** button. Tests: `test_trackgen.js`, `test_standin.js`.

Everything above the "What the build measured" section at the bottom is the original proposal,
left as written. The approach held. Three of its expectations did not survive measurement and
are corrected there rather than edited away, because the reasoning that produced them is worth
more intact than tidy — and one of the three was already contradicted by `README.md` in this
same folder six days before this file was picked up.

Read the whole file before changing anything: the honest limits decide whether this is worth
using for your purpose, and one of them (no scenery, therefore no shadow casters) rules out a
whole category of use.

## Why

The real track is a 111.7 MB `.kn5` that can't live in this repo (past GitHub's 100 MB
per-file hard limit, and not ours to redistribute). So on a fresh machine a sample replay
renders the car and the line over empty space. This is a way to get a *surface* back from
data already in the repo — no track download, no second file.

## The data is already there

`extractCar()` in `ui/acreplay.js` returns, per frame:

| field | shape | what it is |
|---|---|---|
| `wheels` | `N × 12` | the four wheel-centre **world positions** (FL, FR, RL, RR) |
| `wheelsOk` | `N` | 1 when that frame's wheel quad is valid |
| `nrm` | `N × 3` | road surface normal, already derived from the wheel quad |
| `pos` | `N × 3` | car body position |
| `odo`, `laps`, `dt` | | distance, lap boundaries, timestep |

Those wheel centres are contact patches on the actual tarmac. Drop each by the wheel
radius along `-nrm` and you have four points *on the road surface*, every frame, with the
banking already correct — including the parts of `centrifuge` that go past vertical.

## Sketch

1. For each frame where `wheelsOk`, take left edge = midpoint(FL, RL), right edge =
   midpoint(FR, RR), each lowered by the wheel radius along `-nrm[i]`.
2. Emit two triangles per frame-pair between consecutive left/right points — a ribbon
   following the driven line, banked by construction.
3. Skip across `gap[i]` frames rather than bridging them, or the ribbon teleports.
4. Resample by **distance** (`odo`), not frame index, so slow corners don't get dense
   strips and straights sparse ones.
5. Upload it exactly like `sceneGroups`, so the shadow passes, the road shader and the
   contact queries all work unchanged.

## The honest limits

- **You get the driven corridor, not the road.** The ribbon is the car's own track width,
  roughly 2 m, not the tarmac's 12 m. Widening to a plausible road width is a guess.
- **Unless you use every lap.** The test-track replay holds several laps on different
  lines; the union of all their corridors covers far more of the real surface than any one
  lap. That is the single biggest quality lever here, and it's free.
- **No scenery, ever.** Grandstands, kerbs, barriers, buildings are not in the telemetry
  and cannot be inferred from it. Which matters more than it sounds: the grandstands are
  what cast the long shadow bands across the road, so **a reconstructed track cannot
  reproduce the shadow-cascade bug fixed on 2026-07-24**. Anything shadow-related still
  needs the real `.kn5`.
- **`roadedge.js` does not help here.** It consumes a kn5 road mesh to find boundary
  edges; it is the opposite direction. It could run *on* the generated ribbon afterwards.

## So what is it good for

Ghost comparison, lap alignment, the racing line, the HUD, tyre marks, smoke, car
rendering, camera work — everything that only needs a surface under the car. That covers
most of the app on a machine that has no Assetto Corsa install at all.

---

## What the build measured (2026-07-31)

Three claims above are wrong, and the corrections are the useful part of having built it.
Numbers are from both in-repo samples; every one re-derives from a run of the test suite or
from `TrackGen.measureLineSpread`.

**1. "Unless you use every lap … the test-track replay holds several laps on different lines
… the single biggest quality lever here, and it's free."**

It holds **one lap** — two line crossings — and so does `centrifuge`. `samples/README.md` had
already established this on 2026-07-25, one day after this file was written, and corrected
itself in print; this file was not updated with it. Only **10.6%** of the 4 m cells the car
visits are revisited on a later pass, and those are the out-lap and in-lap crossing the timed
lap rather than several racing lines. The union support is built and still free — pass more
runs, load a comparison replay and they all go in — but on the shipped samples the lever is
small, and it is *not* the biggest one here. Widening is.

**2. "Resample by distance, so slow corners don't get dense strips and straights sparse
ones."**

Right instinct, wrong track. At 15 ms frames the samples step **1.06–2.38 m** (t180) and
**1.72–3.96 m** (centrifuge) between consecutive frames, p10 to max — already coarser than any
useful step, varying only about 2:1. Decimation is close to a no-op on the driving (6,522
sections from 6,854 usable frames) and it can never make a straight *denser*, because nothing
interpolates: a strip is never finer than the frames that made it. What the step genuinely
earns is the other end — t180 holds **105 frames stepping under 5 mm**, the car sitting still
before the run, which without it are zero-area triangles and duplicate vertices. On a slower
car it would do the advertised job too; on this corpus it does the unadvertised one.

**3. "Widening to a plausible road width is a guess."**

Less of one than this says. Where two passes cross the same ground on different lines with
headings within ~20°, their **lateral** separation is measurable: median **1.98 m** (t180) and
**2.72 m** (centrifuge). The check that these are the same place and not two points a car
length apart is the along-travel offset, which is about **five times smaller** (0.34 m and
0.65 m). Two 1.8 m corridors whose centres are 2 m apart span 3.8 m of used tarmac, so
`STANDIN_WIDEN_M = 1.0` reproduces the width the driving demonstrably used and no more.

The confound, which is why this is a distribution and not a road width: that same
distribution's tail reaches **9.3 m**, and nothing here can tell a wide line on the same
tarmac from a pit lane running parallel or an excursion onto runoff. The median is evidence.
The tail is not, and is not spent.

### And one the spec did not raise

**Where the car slides sideways the ribbon is ill-conditioned.** The strip advances along its
own axle rather than across it, so the quad shears to a sliver and its face orientation is
undefined — 68 frames of 6,853 on t180, a 260 km/h slide with the nose 90° off the direction
of travel. The vertices are still real road points and the vertex normals are still the
recorded ones, so nothing renders wrong; the winding test asserts 99%, not 100%, and says why.
A rule demanding 100% would be asserting that the car never slides.
