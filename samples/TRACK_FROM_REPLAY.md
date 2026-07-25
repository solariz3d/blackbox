# Rebuilding a stand-in track from the replay itself

**Status: proposed, not built.** Notes for whoever picks this up.

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
