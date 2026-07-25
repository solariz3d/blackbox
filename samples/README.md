# Sample replays

Assetto Corsa `.acreplay` files (v16) for exercising BLACKBOX without recording your own.
Open one with **open replay…**, or drag it onto the window.

| file | car | track | size |
|---|---|---|---|
| `ohyeah2389_t180_mach6_ohyeah2389_t180testtrack__240726-143319.acreplay` | T-180 Mach 6 | `ohyeah2389_t180testtrack` | 20.5 MB |
| `centrifuge.acreplay` | T-180 Mach 6 | `centrifuge` | 5.5 MB |

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

The test-track replay contains multiple complete laps, which makes it the one to use for
lap-vs-lap ghost comparison — you can load it twice and align two of your own laps
without needing a second file.
