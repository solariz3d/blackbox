# `TLNB` — the timeline chunk, and the inline-array rule that unlocked it

Decoded 2026-07-25 against two banks:
- `…\content\cars\ohyeah2389_t180_mach6\sfx\ohyeah2389_t180_mach6.bank` (bank format version 80 / 0x50)
- `…\content\sfx\common.bank` (AC's shared bank)

Companion to `FMOD_BANK_FORMAT.md`, which covers the container and the parameter-sheet path.

---

## 1. The general rule this depended on — **CONFIRMED**

`TLNB` was previously unreadable because "the array header isn't at a fixed offset." The real reason is that a timeline holds **five inline arrays back to back**, and an empty one occupies only two bytes, so every subsequent field floats.

Solving it produced a rule that turns out to govern the whole format:

```
inline array:
    u16 tagged
      tagged == 0          -> no list at all; nothing follows
      tagged odd           -> count = (tagged - 1) / 2
                              if count > 0:  u16 stride ; count * stride bytes
      tagged even, non-zero-> u16 byteLength ; byteLength opaque bytes   (blob)
```

The count is encoded as **`2n + 1`** — a low-bit-set immediate integer. Nothing stores the count as a plain number anywhere in this format.

**Verification:** applied blind to the other chunk types, this rule consumes **every** chunk exactly, in both banks:

| chunk | header at | stride | result |
|---|---|---|---|
| `CURV` | +32 | 16 | 188/188 and 45/45 consume exactly |
| `PMLB` | +48 | 24 | 45/45 and 26/26 consume exactly |
| `PLST` | +8 | 20 | 19/19 and 2/2 consume exactly |
| `EVTB` | +93 | 16 | parameter ref list |
| `TLNB` | +32 | varies | 26/26 and 17/17 consume exactly |

This retroactively explains three things previously logged as puzzles: `CURV`'s `u16 = 5` (= 2 points), `PMLB`'s `u16 = 3` (= 1 child), and `PLST`'s `u16 = 15` (= 7 entries).

## 2. `TLNB` layout — **CONFIRMED**

```
+0    guid[16]   timeline GUID
+16   guid[16]   owner event GUID
+32   array[5]   five inline arrays, per the rule above
```

**26/26 timelines in the T-180 bank and 17/17 in common.bank consume exactly, zero misparses.**

### Instrument placements — **CONFIRMED**

The **stride-24** arrays hold instrument placements:

```
element (24 bytes):
  +0   guid[16]   -> a WAIB (wave) or MUIB (multi) instrument
  +16  u32        startMs   — position on the timeline, milliseconds
  +20  u32        lengthMs  — duration, milliseconds
```

Every stride-24 element in both banks (21/21) resolved to a real `WAIT`/`MUIT` instrument. Milliseconds confirmed by cross-check: fade-out curves land exactly at `startMs + lengthMs` (see §4).

### Slot semantics — **UNKNOWN**

Instruments appeared in **slot 0 and slot 1** in both banks; the parser therefore collects from *any* stride-24 array rather than a fixed slot. Which slot means what (master track vs sub-track) is not established. Slot 3 typically carries an even-tagged **blob** (22 bytes, never instrument GUIDs — likely markers or tempo); its interior is **not decoded**.

## 3. `INST +0` resolved — **CONFIRMED**

Previously logged as "unknown, zero in 154/167 records". It is the **owning timeline GUID**: non-zero exactly when the instrument is timeline-placed, matching that timeline's `TLNB +0`. One fewer unknown.

## 4. The correction that matters most: `CTRL +32` is not always a parameter — **CONFIRMED**

`CTRL +32` names the curve's **x-axis source**, and it resolves to *either* a `PRMB` parameter *or* a `TLNB` timeline.

In common.bank: **33 parameter-sourced, 12 timeline-sourced, 0 unresolved.**

> **The trap.** When the source is a timeline, **x is a `u32` of milliseconds, not a float.** Reading those bytes as a float yields denormals that all round to `0.0`, so a real 0→4800 ms fade-in decodes as the meaningless point list `[[0,0],[0,1]]` — which parses cleanly, looks like data, and is entirely wrong.
>
> Read as `u32`, the same curves are obviously correct:
> - `grass`: gain `0→1` over `0…4800 ms`, then `1→0` over `513600…518688 ms` — and the instrument's own length is **518688 ms**. The fade-out lands exactly on the end.
> - `extraturf`: `355200…362660 ms`, length **362660 ms**. Same.

These timeline curves are **fade envelopes over the instrument's own duration**, not responses to anything the game feeds in. They must stay distinguishable from parameter automation downstream, which is why the emitted curves carry a `t: true` flag.

## 5. Where surface and skid volume actually comes from — **CONFIRMED**

This was the practical question, and the answer is not where an instrument-only reader would look.

- **Instrument-level gain automation on surfaces is timeline fades only** (see §4).
- **The real volume automation lives on the group bus the instrument feeds** — `prop#0`, in **dB**, resolved via `INST +83` → `GBSB`, then `CTRL +16 == busGuid`.

common.bank automation inventory:

```
prop#0 (bus volume, dB) vs speed        x10
prop#0 (bus volume, dB) vs decay        x10
prop#0 (bus volume, dB) vs impact_speed  x3
prop#1 (pitch, semitones) vs speed       x4
prop#1 (pitch, semitones) vs dirtiness   x2
prop#4 (instrument gain, linear) vs <timeline>  x12
prop#4 (instrument gain, linear) vs dirtiness    x2
```

Every surface event (`grass`, `gravel`, `kerb`, `sand`, `old`, `extraturf`) declares exactly two parameters — **`speed [0..500]` and `decay [0..1]`** — and rides them like this:

| | curve |
|---|---|
| `grass` bus volume vs `speed` | `−42 dB @ 5` → `−0.17 dB @ 100` |
| `gravel` bus volume vs `speed` | `−42 dB @ 4` → `−6.65 dB @ 60` → `0 dB @ 400` |
| `kerb` bus volume vs `speed` | `−42 dB @ 5` → `−2 dB @ 40` → `0 dB @ 99.8` |
| all surfaces, bus volume vs `decay` | `0 dB @ 0.099` → `−42 dB @ 1.0` |
| `gravel` / `kerb` / `old` / `extraturf` pitch vs `speed` | e.g. `−0.32 semitones @ 5` → `+0.09 @ 230` |

### Skid: rides **nothing**. — **CONFIRMED**

- In **common.bank**, `skid_ext` and `skid_int` are genuine empty stubs — 0 sheet, 0 timeline.
- In the **car bank**, both exist as single timeline instruments, both playing sample **#37 `Tire Skid LowFreq`** at **−3 semitones** static pitch (`skid_int` looping, `skid_ext` one-shot).
- **`skid_ext` and `skid_int` declare zero parameters, carry zero instrument automation, and their bus carries zero automation.**

So there is no slip-like parameter in the bank to feed. AC drives skid by setting the event instance's volume from game code — the bank supplies only the sample, its static −3 semitone detune, and its loop flag. Wiring per-wheel slip to layer gain directly is correct and is not second-guessing the bank; there is nothing there to contradict.

## 6. Events that gained instruments

**`ohyeah2389_t180_mach6.bank` — 15 timeline instruments across 11 events** (all previously invisible):

```
jumpjack_charge 4   limiter 2   backfire_ext 1   backfire_int 1   gear_grind 1
horn 1   jumpjack 1   skid_ext 1   skid_int 1   tractioncontrol_ext 1   tractioncontrol_int 1
```

Of these, 3 are looping and reach the runtime map: `skid_int` (Tire Skid LowFreq), `limiter` (als_long1), `jumpjack_charge` (t7 starter tone). The rest are one-shots, counted in `oneshots` so the omission stays visible.

**`common.bank` — 10 timeline instruments across 10 events**, every one previously reported as a silent stub:

```
grass 1 (grass_stereo)     gravel 1 (gravel)      kerb 1 (kerb_short)
sand 1 (sand)              old 1 (bodywork_light) extraturf 1 (extraturf_stereo)
screw 1 (multi)            unscrew 1 (multi)      ambience 1 (ambient1)
ds_protection 1 (beep)
```

`dirt` was already visible — it is the one surface AC authored on parameter sheets (3 layers on `dirtiness`), which is why it decoded before and the others did not.

## 7. Engine path: unverified-by-assertion is not enough, so it was diffed

Every pre-existing layer in `ui/eventmap.js` was compared field-by-field against the previous generated file:

```
same   engine_custom      old=18  newSheet=18   same   turbine           old=10  newSheet=10
same   engine_ext_old     old=11  newSheet=11   same   turbine_fuelpump  old= 1  newSheet= 1
same   engine_int_old     old=13  newSheet=13   same   turbo             old= 1  newSheet= 1
same   transmission       old= 2  newSheet= 2   same   wheel             old= 3  newSheet= 3
same   wind               old= 2  newSheet= 2
+ NEW  limiter (1 layer, timeline)   + NEW  skid_int, jumpjack_charge
```

**No regression: every pre-existing layer is byte-identical.** `node test_eventmap.js` — all checks pass, simultaneity unchanged (`1000:11 2000:12 3000:15 5000:11 7000:14 8300:14 9300:13`).

## 8. Emitted shape

Full JSON gains `timeline_instruments[]` per event, each with `sample_index`/`sample_name`, `placement{start_ms,length_ms,timeline_guid}`, `loop_mode`, `static_volume_db`, `static_pitch_semitones`, `autopitch_root`, `automation[]`, `bus_automation[]`, `output_bus_guid`, plus `timeline_instrument_count`.

Compact `window.BBEventMap` gains timeline **loops** in the same `layers` shape, with:
- `param: null`, `from: null`, `to: null` — **deliberate.** The runtime keys layers by parameter name; these answer to no parameter. Handing one `param:"rpms"` with a millisecond extent would make a skid loop sound at every rpm forever.
- `place: "timeline"`, `fromMs`/`toMs` carry the real extent.
- `curves[]` entries flagged `t: true` (x in ms, timeline fade) or `bus: true` (dB, rides a real parameter — this is the one the game modulates).
- `curveParams[]` is `null` for timeline-anchored curves and names the parameter for bus curves.

## 9. Still unknown

- **`TLNB` slot semantics** — five arrays, but which is master track vs sub-track vs markers. Instruments collected from any stride-24 array instead.
- **Even-tagged blob interiors** (the ~22-byte slot-3 payload). Never contains instrument GUIDs; probably markers or tempo.
- **Curve `shape` field** and the trailing per-point `u32` — carried through untouched, still not interpreted.
- **`decay` semantics** — declared by every surface event and driving a `0 dB → −42 dB` bus ramp, but whether AC feeds it as a release envelope or a surface-contact fade is a game-side question the bank cannot answer.
- **Playlist selection mode** for the multi-instruments now visible on timelines (`screw`, `unscrew`, `backfire_ext`) — the `PLST` weight is 1.0 for every entry; random vs sequential is not encoded anywhere located.
- **`PROP` chunk layout** — per-instrument overrides that may supersede the `INST` static volume/pitch reported here. Unchanged from before.
