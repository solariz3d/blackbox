# Interactive Smoke Physics — Design

Status: **proposed** (design agreed before build). Supersedes the current decorative
smoke motion (static baked curl field + constant buoyancy/wind), which cannot interact
with anything.

## Goal

Smoke that behaves like it's in real air the cars stir — not a canned animation:

- **Tire physics** — the wheel's own momentum swirls the air around it; smoke rides that.
- **Car interaction** — a car moving near existing smoke pushes/shreds it (its wake).
- **Multi-car / multi-replay** — several cars (or ghosts from *different runs at different
  times*) all disturb the **same** smoke. "Non-linear time" coupling falls out for free
  because everyone shares one medium.

The unlock is a **shared air-velocity field** (the "air") that cars *inject into* and
particles *ride*. Everything interactive comes from that one idea.

## Architecture

### 1. The air field (the shared medium) — a SPARSE tube along the track

Never simulate the whole map (~99% empty air). The field exists **only where smoke can be**:
near cars and near live smoke. This forms a "tube" of simulated air that hugs the track and
the action — without precomputing any track geometry.

- **Sparse world-space grid**: cells are a fixed world lattice (cell size `H ≈ 1.5 m`) but
  stored in a hash map keyed by packed integer cell coords `(cx,cy,cz)`. Only cells that are
  **near an active car or a live particle** exist; each holds a velocity vec3 (+ a small TTL).
- Cells are **created on demand** when a car/particle enters them, and **evicted** once their
  velocity has decayed to ~0 and no smoke remains nearby. The tube tracks the cars and trails
  off behind them automatically.
- **Why sparse-Cartesian over a precomputed curvilinear tube:** a centerline-following tube
  needs a Frenet-style frame that **breaks on loops/corkscrews** (which the bowl track has) —
  the frame twists and flips. A world-space grid has none of that: it's just cells in space.
- **Flow follows the track for free:** the air moves along the track and around banking
  because the *cars inject velocity in their travel direction* — not because the grid is
  shaped like the track. Banking, loops, corkscrews all "just work" since everything is
  world-space and driven by real car motion.
- **Cars anywhere, any number:** each car's neighborhood is its own set of live cells, so
  spread-out cars / multiple replays across the whole track all simulate at once. (This is
  strictly better than a single follow-window, which only covered cars racing together.)
- This is the *only* stateful new object. Particles and the field are **global**, not
  per-car — that shared medium is what couples multiple cars/replays.

Perf note: active cell count ≈ (cars + smoke footprint) not map size — a few thousand cells
for a handful of cars. Decay/inject iterate only live cells.

### 2. Injection (cars stir the air) — car-agnostic API
`injectCar(field, wheelsWorld[4], wheelVel[4], bodyVel, dt)` — called **once per active
car per frame**. All cars add into the same field, so wakes accumulate and couple.
- **Wheel swirl** — at each wheel contact, splat a rotational (curl) velocity into nearby
  cells: axis ≈ surface normal, magnitude ∝ wheel speed. This is the tire physics — the
  spinning/scrubbing wheel stirs the air, smoke near it swirls *because of that*.
- **Body wake** — push air outward/forward at the nose and drag it along behind the body
  (a short trailing wake), magnitude ∝ body speed. This is what shreds another car's smoke
  when you drive through it.
- Splat = trilinear deposit (add), so contributions from multiple cars sum.

### 3. Advection (smoke rides the air)
Per particle per frame:
```
v_air   = sampleField(pos)                 // shared air velocity (trilinear)
v_turb  = curlNoise(pos, t) * turbAmt      // small organic detail on top
p.vel  += (v_air + v_turb - p.vel) * relax*dt
p.vel.y += buoyancy * dt                   // heat rise
p.vel  *= (1 - drag*dt)
p.pos  += p.vel * dt
```
The static curl field is **demoted** from "the motion" to a light turbulence overlay.

### 4. Decay / diffusion
Each frame (playback-time driven, so pause freezes / scrub clears, like particles):
- `field *= decay` (≈ 0.90/frame at 60 Hz) — injected velocity dissipates.
- Optional cheap 1-tap diffusion (blur) so wakes spread instead of staying crisp.

## Multi-car / non-linear time

Each replay reports its car's state **at its own playback time**; every active car calls
`injectCar` into the one shared field on the shared tick. So a ghost from run X and a ghost
from run Y coexist in the same air and disturb each other's smoke, even though their lap
times never aligned. No special cross-replay code — the shared field *is* the coupling.

Emission also becomes car-agnostic: loop over active cars, spawn at each car's wheels
(current slip-angle × speed gating per car).

## Performance

- **Sparse**: cost scales with *activity*, not map size. A few cars ≈ a few thousand live
  cells. Decay/inject iterate only live cells (hash map). Advection = `N_particles` trilinear
  samples (already the cost vs the static grid). All CPU, well within budget. GPU port only
  if particle counts grow past tens of thousands (not needed for a few cars).
- Hash-map churn is the thing to watch; mitigate by pooling cell objects and evicting lazily
  (sweep every few frames, not every frame).

## What this replaces / touches

- Replaces `smoke.curl` / `sampleCurl` as the motion source (kept as turbulence overlay).
- New: `air` field object, `airFieldStep()` (decay + inject all cars), `sampleAir()`.
- `smokeStep` advects via `sampleAir` instead of the static curl.
- Emission loop generalized to iterate active cars (one today; N later).

## Open questions / tradeoffs

- **Sparse-Cartesian vs curvilinear tube**: resolved in favour of sparse world-space cells
  (curvilinear centerline frames break on the bowl track's loops/corkscrews). The tube is
  defined by *activity*, not precomputed geometry.
- **Cell eviction cadence**: sweep-and-evict every few frames (not every frame) and pool cell
  objects to keep hash-map churn/GC down.
- **Environment pre-seeding**: cells only appear where cars/smoke are. A steady ambient wind
  is still a global constant added at sample time; pre-seeding cells from the track mesh (so
  wind eddies exist before a car arrives) is a future nicety, not needed now.
- **Reuse for shadows**: cells could carry a *density* channel later, which the planned
  light-space smoke-shadow pass can sample — keep in mind, not building now.
- **Determinism on scrub**: field is live sim (like particles); scrubbing clears it. Fine.
