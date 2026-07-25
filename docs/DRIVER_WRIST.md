# The driver's wrist — open problem

**Status: attempts 1–3 all worked the wrong component (measured 2026-07-25). See "The twist/bend
split" below before attempting anything else.** Attempt 3's twist fix is correct on its own terms and
stays; it simply cannot address what is visible.

## The twist/bend split — read this first

A relative rotation between two frames decomposes into **twist** (about the shared axis) and **swing
/ bend** (perpendicular to it). Attempts 1, 2 and 3 all address the twist. The screenshot complaint —
*"the wrist needs to be straight with the line"* — is the **bend**: the angle between the forearm's
direction and the hand's direction.

`WRIST_FOLLOW` cannot change that angle, and the reason is a tautology once seen: it rotates the
forearm about its **own** axis, so elbow→wrist is unmoved, and the hand is welded to the wheel, so it
is unmoved too. The angle between two things neither of which moved cannot change.

Measured across a wheel sweep (`test_wristbend.js`, synthetic rig — the absolute degrees are
illustrative, the zero is geometry):

| wheel | bend, FOLLOW=0 | bend, FOLLOW=1 | change |
|---|---|---|---|
| 0° | 57.9° | 57.9° | **0.00°** |
| 90° | 105.6° | 105.6° | **0.00°** |
| 180° | 138.3° | 138.3° | **0.00°** |

So three attempts were spent on a quantity that provably cannot move the symptom. Attempt 3's headline
number — residual wrist twist 62.5° → 6.5° — is real, and is about twist.

**What can change the bend.** The hand's orientation is fixed (welded to the rim) and the wrist
position is fixed (on the grip). The only remaining freedom is **where the elbow sits**: `ik2bone`
places it at `S + dir·a + pp·h`, on a circle about the shoulder→wrist axis, with `arm.pole` choosing
the point on that circle. Swinging the elbow around that circle rotates the forearm's direction
without moving the wrist or the grip — exactly the free variable the bend needs, and exactly what a
driver's elbow does. `arm.pole` is currently the bind-pose upper-arm direction (`v3sub(E0, S0)`,
`index.html`), i.e. a constant that knows nothing about where the hand is pointing.

**Attempt 4 (proposed, not built):** drive the pole from the hand's own axis — aim the elbow at
`W − L2·handAxis`, the position that would make the forearm collinear with the hand, and let
`ik2bone` snap it to the nearest reachable point on the circle. Blend by a tunable so it can be dialled
back if the elbow silhouette reads badly. Note attempt 1 measured that the pole's perpendicular
component never degenerates on this geometry (bottoms out at 0.573) — that finding says the pole is
*well-conditioned*, which is what makes it safe to steer.

---

**Attempt 3 (2026-07-25) shipped and is live**, twist-bone distribution — see below. Attempts 1–2
remain documented so nothing gets re-derived.

**Question 1 answered (which path runs):** the **IK path** (`driverSeatedSkin`). The T-180's
`steer.ksanim` is degenerate — its hand sweeps 25 mm lock-to-lock (measured in `test_steeranim.js`)
— so `driverAnimInit` refuses it (authored range < 20° guard) and none of what's on screen comes
from Kunos's animation. The IK reasoning below applies in full.

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

## Attempt 3 — twist-bone distribution (SHIPPED 2026-07-25, awaiting eyes)

Attempt 2's own top guess was right: the rig has the intermediate bone. `RIG_ForeArm_END_<s>` sits
mid-forearm (bind: elbow z 0.307 → END z 0.422 → wrist z 0.530), is the HAND's parent, and carries
**more skin weight than the forearm bone itself** (348.7 vs 242.1 total vertex weight) — it is a
real twist bone, skinned exactly where pronation shows. So the same free pronation is now RAMPED
instead of lumped: the proximal forearm turns `WRIST_RAMP` (0.3) of the twist, the END subtree turns
all of it, and the skin weighted between the two bones blends the gradient — the elbow crease barely
shears, which is what made attempt 2 read worse.

Headless proof (`test_gripreach.js` §10, five-bone chain incl. the twist bone): END absorbs the full
pronation (−56.1° of −56.1° at a 69° wheel test angle), forearm turns exactly its 30% share, the
welded hand is untouched, no bone origin moves, and the residual hand-vs-forearm wrist twist
collapses **62.5° → 6.5°**.

Tunables moved to `index.html` with the rest: `WRIST_FOLLOW = 1.0` (0 reverts by eye),
`WRIST_RAMP = 0.3` (proximal share — raise toward 0.5 if the mid-forearm skin bunches, lower toward
0 if the elbow crease shears again). Rigs without the END bone fall back to attempt 2's one-lump form.

## What to try next (if attempt 3 fails by eye)

- **Limit the hand's roll on the rim** and let the hand slide/regrip past the limit — what a driver
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
