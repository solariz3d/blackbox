# Road-surface detection — open problem

**Status: 15 tracks found no road mesh when this was measured against a 62-track library.
The library is now 32 tracks (counted 2026-07-26) — the affected list below predates that
change and needs a re-count before anyone acts on the numbers. One fix attempted and
reverted.**

## The symptom

`extractRoadMesh` returns nothing on these tracks, and nothing errors:

```
battenbergring   drift          ks_drag        ks_laguna_seca   ks_silverstone1967
ks_zandvoort     lilski_watkins_glen           Miandros         monza
mugello          rainbow_rd     spa            trento-bondone
Watkins Cobra    Watkins T-180
```

That silently disables everything downstream of the road:

- **smoke collision** (`smokeColl`) — puffs pass through the track instead of rolling off it
- **road-edge readout** (`edgeIndex` / `roadedge.js`) — the distance-to-edge HUD reads nothing
- the driven-line **ribbon width**, which narrows to car width once a real road is known
- anything else that wants to know where the tarmac is

Every one of those degrades quietly. Nothing on screen says the road was never found, which
is why a third of the library was affected without it being obvious.

## What the matcher does

AC names a physical mesh `<digit><SURFACE_KEY>` and resolves the key in the track's
`data/surfaces.ini`. `extractRoadMesh(ab, keyPattern)` defaults to:

```js
/^[1-9]\d*(ROAD|KERB|PIT|RUNOFF)/i
```

Those four are the **Kunos defaults**, not the rule. Real circuits declare their own keys —
spa has `ASPH-SPA_BLACK`, `ASPH-SPA_VIOLET`, `PITSPA`; monza has `MONZA-ASPH`,
`PEN-ASPH-A`; and `IS_VALID_TRACK=1` marks which are drivable.

## Attempt 1 — use the track's own keys (REVERTED)

Read `data/surfaces.ini`, keep the keys with `IS_VALID_TRACK=1`, build the pattern from
those instead of the built-ins. The reasoning was sound and the data is real. The result
was not:

| track | before | after |
|---|---|---|
| trento-bondone | 0 | **1,219,566** |
| centrifuge | **3,200,034** | 0 |
| t180testtrack | **285,596** | 0 |
| spa, monza, mugello, zandvoort, laguna_seca | 0 | 0 |

It fixed one track, **broke two that already worked**, and did nothing for the majority.
Reverted rather than shipped.

## What that result actually tells us

1. **The keys are not the whole rule.** Tracks whose road meshes the default pattern finds
   (centrifuge, t180testtrack) are *not* named after their declared surface keys — so mesh
   name and surface key are related more loosely than `<digit><KEY>` suggests.
2. **spa/monza/etc fail for a different reason again**, since their own keys did not help
   either. Their physical meshes may live in a model the scan did not read, may not carry
   the digit prefix, or may be resolved by AC in some way other than the name.
3. Any fix must be **measured against tracks that currently work**, not only against the
   broken ones. That is exactly what caught this attempt.

## Before attempting again

- Dump the actual mesh names of a working track (centrifuge) and a failing one (spa) and
  compare them directly. The rule is in that diff; everything above is inference.
- Check whether spa's road lives in a kn5 the loader is not reading. **The measurement
  harness for attempt 1 read only ONE model file per track**, and Kunos tracks split a
  circuit across a dozen — that alone could explain the spa/monza results, and it already
  produced one wrong conclusion in this session (nine tracks reported as rendering nothing
  when they render fine).
- Keep `test_trackeffects.js` as the regression net: it reports road/mesh/logic counts for
  every installed track, so a change that fixes five tracks and breaks two is visible
  immediately instead of by eye, weeks later.
