# The replay and the track can be different versions of the same circuit — open problem

**Status: reported 2026-07-26, not investigated. Seen on thunderhead.**

## The symptom

On the desktop there is a thunderhead replay whose driven line does not sit on the track.
The line runs **over or under** the surface — not by a constant offset, but by however much
that section of the circuit has moved since the replay was recorded.

thunderhead has been iterated many times. The replay was recorded against one version of the
geometry; the installed `.kn5` is a later one. Both files are internally consistent and
neither is corrupt — they simply describe different worlds.

## Why this is not the same as a parsing bug

Every other line-placement bug in this project has been ours: a wrong stride, a transform
applied twice, a coordinate flip. This one is not. The replay's wheel positions are exactly
where the car was **on the track as it existed then**, and the mesh is exactly where the
track is **now**. Reprojecting the line onto the current surface would be inventing data.

The keeper's own reading, recorded here because it is probably right and is the first thing
to check: *"it could be because my replay was outdated and the track itself was the newest
one."*

## What to check first

1. **Confirm the direction of the mismatch.** Does `.acreplay` carry any track identifier or
   version/checksum beyond the track's folder name? If it does, the two can be compared and
   the user told plainly, which is most of the value.
2. **Re-record a lap on the current thunderhead** and confirm the line lands correctly. That
   separates "version skew" from "we place lines wrong on this track" in one test. Until this
   is done the diagnosis above is a hypothesis, not a finding.
3. Only then consider what to *do*: refusing to draw, warning, or offering a vertical fit are
   all defensible; silently projecting the line onto the current mesh is not, because it
   would make a wrong lap look like a right one.

## Not reproducible on the laptop

thunderhead is installed here (downloaded 2026-07-26) but there is **no replay for it on this
machine**, so the bug cannot be seen from the laptop — only that the track itself loads. The
replay lives on the desktop.

Related: `TRACK_FROM_REPLAY.md` builds a surface *from* a replay's wheel data, which is the
same relationship viewed from the other end, and would sidestep this entirely for a track
whose geometry no longer matches.
