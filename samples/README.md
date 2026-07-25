# Sample replays

Assetto Corsa `.acreplay` files (v16) for exercising BLACKBOX without recording your own.
Open one with **open replay…**, or drag it onto the window.

| file | car | track | size | telemetry |
|---|---|---|---|---|
| `ohyeah2389_t180_mach6_ohyeah2389_t180testtrack__240726-143319.acreplay` | T-180 Mach 6 | `ohyeah2389_t180testtrack` | 20.5 MB | **yes** — schema 5, 313,949 samples |
| `centrifuge.acreplay` | T-180 Mach 6 | `centrifuge` | 5.5 MB | no — position only |

## There is no separate telemetry file

Engine telemetry is **stapled onto the end of the `.acreplay` itself** by
`src-tauri/src/bin/telemetry_logger.rs`, not shipped alongside it:

```
[ …original .acreplay… ][ telemetry blob ][ u32 blobLen ][ "BBX1" ]
```

The replay parser ignores trailing bytes, so the file still plays in Assetto Corsa.
`parseTelemetry()` reads the tail; `alignTelemetry()` resamples it onto the replay's frames.
Of the test-track replay's 20.5 MB, **18.0 MB is that blob** — the replay proper is ~2.5 MB.

**It cannot be regenerated after the fact.** Assetto Corsa publishes live physics to shared
memory only while you *drive* — not during replay playback (verified). So RPM, gear,
throttle, brake, slip and boost exist only if `telemetry_logger.exe` was running at record
time. No amount of post-processing recovers them from a replay that lacks them; the
positions are there, the driver's inputs are not.

Practical consequences:

- On `centrifuge.acreplay`, **throttle and brake read 0% and RPM is dead**. That is missing
  data, not a broken HUD. Load the test-track replay to see those channels populated.
- Schema 5 carries a timestamp per sample, so alignment is exact even across pauses. Older
  schemas (3, 4) have no timestamps and fall back to assuming a uniform ~333 Hz tail — fine
  for one clean continuous lap, approximate if the buffer had gaps.
- The logger appends to the **named** save, not the `AC_…_O_…` autosave. Of a pair from one
  session, the named one is the one worth keeping.
- To check any replay: read the last 4 bytes. `BBX1` means telemetry is present.

## You also need the track

A replay stores **the cars' motion, not the world** — positions, wheel quads, lap times.
The scenery comes from the track's `.kn5`, which BLACKBOX loads from your Assetto Corsa
install. So a replay here plus AC with the matching track installed gives you the full
scene; without the track you get the telemetry, the line and the car, over empty space.

The track models are **not** in this repo on purpose: `ohyeah2389_t180testtrack` alone is
a 111.7 MB `.kn5`, past GitHub's 100 MB per-file hard limit, and it isn't ours to
redistribute. Install the track into
`…/steamapps/common/assettocorsa/content/tracks/` and BLACKBOX finds it by name.

## Why these two

`centrifuge` is the extreme case — sustained banking past vertical, which is what the
road-normal attitude, the tilt readout and the shadow bias on steep surfaces were built
against. The T-180 test track is the ordinary case: flat-ish, grandstands casting long
bands across the road, several clean laps. Between them they cover the two ways the
renderer tends to break.

## Lap comparison needs two files

Measured across every replay in a real AC replay folder: **each one holds exactly one timed
lap.** AC saves a replay per session, and a hotlap session is one flying lap. So `compare
laps` overlays a *second replay file*, not a second lap inside this one — click it, then
pick another `.acreplay` of the same track.

(An earlier version of this file claimed the test-track replay held several laps and could
be loaded twice against itself. It does not, and it cannot. `Ghosts.lapWindows()` reports 1
complete lap for it: two line crossings, one lap between them.)
