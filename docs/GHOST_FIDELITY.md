# Ghost cars — getting to 1:1 with the reference car

**Goal (the chair, 2026-07-25):** *"needs to be 1 to 1 the same car, all the effects — or at least
the car that the replay says it is."*

**Where it is now.** A comparison lap draws the full car body, wheels with their own recorded
suspension, its own steer, its own windscreen, **its own driver** (own smoothed rig, own hands on
its own steering wheel), and it casts a shadow. Up to **four cars** on track. What it does not yet
have is lights, smoke, tyre marks, or sound.

**Two ways to place a car**, because they answer different questions:

- **distance** (default, coaching) — each ghost is drawn where *it* was at the same point on track,
  so the gap on screen **is** the time delta.
- **race** (watching) — every lap on one clock with a per-run start offset. Nobody is ahead by
  definition; they start where you place them and race. The offset is what makes it a race rather
  than a synchronised demonstration: without it, four laps by the same driver launch as one car and
  never separate.

**Why four.** Each ghost is a full car *and* a per-frame skinned-driver vertex upload, so cost is
linear in cars and the driver is the expensive part. Four is also about where a chase camera stops
being able to hold them all in frame.

Every one of those is missing for the *same reason*, and it is worth stating once because it decides
the order of the work:

> **Each remaining effect is backed by a singleton that assumes exactly one car exists.**

Nothing here is hard. Each is the same shape of change as the `carModelMatrix(fpos, src)` /
`wheelWorldAt(fp, k, src)` refactors already done: take the run you operate on, return your result,
stop reading the global. The reason they aren't done is that each one owns *mutable smoothed state*,
which is a bigger change than adding a parameter.

## The singletons, in the order worth doing them

| effect | what blocks it | shape of the fix |
|---|---|---|
| ~~**driver**~~ **DONE** | was `driverRig`, one object of smoothed values shared by every car — two drivers would both chase whichever car was posed last, at a rate neither was turning. | `driverPose(fp, carMat, steer, src, rig)`; each run carries its own rig. Note the skinned mesh is a **vertex upload per car per frame**, which is the real cost of a full-fidelity ghost. |
| ~~**thruster / backfire / lamp glow**~~ **DONE** | the draw functions already took a car matrix; only the *intensity readings* (`turbineIntensity`, `backfireAt`, `carGForces`) read the global run. | all three take `src`. Ghosts fire their turbine on their own thrust/afterburner channel, pop on their own upshifts, and — the one that matters most — **brake on their own deceleration**. A ghost flashing its brake lights when the *reference* car braked would be the most actively misleading pixel on screen. |
| **brake / head lights** | `setHeadlights(cm, 0, headVP)` and `setBrakelights(cm, 0)` set **scene** uniforms — the shader carries two lamps (`uHeadA`, `uHeadB`) belonging to one car. A second car's lamps have nowhere to go. | either an array of lamps in the shader (real, costs a uniform loop), or draw ghost lamp glow as emissive geometry only and accept it doesn't light the road. The second is much cheaper and probably enough. |
| **smoke** | `smoke.accum` is a `Float32Array(4)` — one car's four wheels. The puff pool and the `AIR` field are world-space and already shared correctly, so **only the accumulator is per-car.** | per-run accumulator. This is the smallest fix of the three and the most visible. Note `BODY_WAKE_K` was set to 0 *because* there was one car; with ghosts it becomes meaningful again. |
| **tyre marks** | `markVBO` / `markCount` — one prebuilt ribbon per loaded run. | build one per run; draw them all. |
| **sound** | `BBAudio` is one engine instance mapped to the reference car's telemetry. | **needs a decision before any code.** See below — this is the one item where doing it as asked is probably wrong. |

## Sound: why four engines is likely the wrong goal

Everything else on this list gets *better* with four cars. Sound gets worse, and it is worth saying
plainly rather than discovering it after the work.

The engine is AC's authored FMOD event — 12–15 instruments sounding at once at speed. Four cars means
four of those, sixty-odd voices, and here is the problem: they are **the same car driving the same
track within a few seconds of each other.** Their rpm ladders sit a few Hz apart, which is precisely
the condition for audible beating — a slow throbbing warble that sounds like a fault in the mix, not
like a grid.

Real broadcast does not do this either. A race feed follows *one* car's onboard, or a trackside mic
where distance and doppler separate the cars. Both are selection, not summation.

So the useful shapes, in order of preference:

1. **Sound follows one car** — a "listen to" selector in the legend. Cheap, and it's what a viewer
   actually wants: hear the car you're watching.
2. **Distance-attenuated ghosts** — ghost engines at low gain rolled off by distance from the camera,
   so a car passing you is *heard* passing. Needs per-run gain and doppler, and still beats when two
   cars are side by side, which is exactly when you most want it to work.
3. **All four at full gain** — the literal reading of the request. Cheapest to describe, worst to
   listen to.

Recommend (1), with (2) as a later enrichment. Wanted the chair's call before spending the work.

## The other half of "the car the replay says it is"

Ghosts currently draw the **reference car's** model, because that is what is uploaded. If the
comparison replay is a *different* car, it is being drawn as the wrong one — silently.

`ui/ghosts.js` already has the `ModelCache` (`carId → handle`, refcounted) built for exactly this: two
runs in the same car share one upload, two runs in different cars get one each. What is missing is
the call — `loadCarModel(carId)` overwrites the single global `carGroups` rather than returning a
handle to cache. Until that is wired, ghosts should ideally refuse (or visibly mark) a comparison run
whose `carId` differs from the reference.

## What was fixed on the way here

- **Ghost judder / "blurry while moving"** — `refDistanceNow` rounded the reference frame to a whole
  index, quantising the ghost's position to the replay's 66 Hz sample rate while the reference car
  moved smoothly at display rate. The ghost held still for several frames then jumped. Now
  interpolated, like every other frame lookup in the renderer.
