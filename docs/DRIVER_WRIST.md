# The driver's wrist — open problem

**Status: unsolved. Two attempts, both measured, both rejected.** Written down so the next attempt
starts from the evidence instead of re-deriving it. Nothing here is half-applied: the code is in the
shipped state described below.

## The symptom

Close to the car (the cockpit zoom makes this visible; from the chase cam it never was), the
**inside** hand's wrist reads as broken — bent hard, "like you're going to break your wrist". It is
the hand travelling **down** the rim: turn left → left hand → left wrist; turn right → right hand.
The other arm looks fine at the same moment.

The wrist should be roughly **straight with the forearm** where it meets the hand on the rim.

## Why it happens (this part is solid)

`driverSeatedSkin` / `driverAnimWorlds` in `ui/carrender.js` weld the hand to the WHEEL, not to the
arm — deliberately, and the comment there explains it: the hand's orientation is the authored grip
orbited about the wheel axis, exactly like the wheel mesh, because stacking `Rup + Rfore + roll` onto
the hand "twisted the wrist goofily at crossed-over angles". The arm then swings to meet it, and *the
wrist flex is whatever connects them*.

That last part is the problem. Measured on a representative arm (elbow `[0.26, 0.80, 0.28]`, wrist on
the rim `[0.17, 0.92, 0.55]`, wheel axis `+Z`):

| wheel angle | roll the wrist joint absorbs |
|---|---|
| 60° | 52° |
| 90° | **79°** |
| 120° | **105°** |
| 270° | **236°** |

The forearm axis is aligned **0.87** with the wheel axis, so almost all of the rim's rotation lands
on the wrist. Human wrists do not do this: pronation/supination totals ~150° and happens in the
**forearm**, with the wrist joint contributing very little.

## Attempt 1 — the IK pole (WRONG, reverted)

Hypothesis: `armSolve` passes `arm.pole = v3sub(E0, S0)`, the bind-pose upper-arm direction, and
`ik2bone` positions the elbow using that pole *projected perpendicular to the shoulder→wrist axis*.
When the hand crosses toward the body, the axis should approach the pole, the projection should
collapse, and the elbow should become arbitrary — which would explain the left/right asymmetry.

**Measured across a full wheel sweep: the surviving perpendicular component bottoms out at 0.573.**
A fade threshold of 0.45 would never fire. The pole never degenerates on this geometry, so this is
not the cause. Reverted; do not re-attempt without re-measuring.

## Attempt 2 — forearm pronation (SOUND ON PAPER, LOOKED WORSE, disabled)

Roll the forearm about its own axis by the component of the wheel's rotation lying along that axis
(`twist = ang * dot(wheelAxis, forearmAxis)`), so the twist is absorbed where a real arm absorbs it.
Rotation about the forearm's own axis moves neither elbow nor wrist, so the IK solution and the grip
are untouched — it is free.

Implemented, verified as a proper rotation (orthonormal, det 1, axis preserved), and it **looked
worse by eye**. Shipped disabled: `WRIST_FOLLOW = 0.0` in `ui/carrender.js`. Set it to 1.0 to try
again.

Why it may have looked worse — untested guesses, in the order worth testing:
- **Skinning, not bones.** Rolling the forearm bone twists the skinned mesh around it; the deltoid
  and elbow crease shear, which can read as worse than a bent wrist even when the joint angle is
  better. A real rig distributes this over *twist bones* along the forearm, not one roll at the elbow.
- **The hand kept its own roll.** The relative twist was moved, not removed — possibly to a more
  visible place.
- **Wrong sign or wrong pivot** for one side. It is symmetric by construction, but that was never
  verified visually per-side.

## What to try next

1. **Check which path is even running.** `driverAnimWorlds` (authored `steer.ksanim`) vs
   `driverSeatedSkin` (IK fallback). If the T-180 ships an authored steering animation, the arms may
   be following Kunos's animation and none of the IK reasoning above applies to what is on screen.
   This is the cheapest check and it invalidates or confirms everything else.
2. **Distribute the twist** along the forearm chain rather than applying it at the elbow, if the rig
   has intermediate bones.
3. **Limit the hand's roll on the rim** and let the hand slide/regrip past the limit — what a driver
   actually does — instead of tracking the rim 1:1 through 270°.

## Separate, related open item

The hands read as **too open** at close range. Not a wrist issue: the hand mesh is sculpted around
AC's generic *fat* rim (~50 mm palm-to-fingertip channel) and this car's bar is ~24 mm, so the spare
finger length has to go somewhere and the grip never closes. The existing grip work pushes it to the
hidden palm side (`DRIVER_GRIP_BIAS`, `DRIVER_PALM_OFFSET`) which is why it reads fine from outside.
Truly closing it needs a per-phalanx conform — curling each finger joint to the bar radius. The
skeleton, weights and inverse-binds are all parsed already, and `test_gripreach.js` shows the shape
such a headless check would take.

## Environment note

`test_steeranim.js` has a hardcoded `G:\SteamLibrary\...` path and only runs on the desktop; it fails
with ENOENT on the laptop. Not a regression — worth making it resolve the Steam library the way
`find_car` does.
