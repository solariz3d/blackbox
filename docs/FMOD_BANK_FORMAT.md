# FMOD Studio `.bank` — event metadata format

Reverse-engineered 2026-07-25 against
`C:\Program Files (x86)\Steam\steamapps\common\assettocorsa\content\cars\ohyeah2389_t180_mach6\sfx\ohyeah2389_t180_mach6.bank`
(72,480,672 bytes, **bank format version 80 / 0x50**, built for FMOD Studio 1.08.x — Assetto Corsa ships `fmodstudio64.dll` **1.08.12 build 80229**).

Everything below is tagged **CONFIRMED** (verified against the file, usually by an independent cross-check), **INFERRED** (strong evidence, no documentation), or **UNKNOWN**.

Working code: `riffwalk.js` (chunk tree), `riffstats.js` (taxonomy), `bankdump.js` (human-readable extraction), `genjson.js` (machine-readable extraction). All in this directory, all Node, no dependencies.

---

## 1. Container

**CONFIRMED.** Standard RIFF.

```
0x00000000  "RIFF"  u32 size=72480664  form="FEV "
0x0000000c  "FMT "  size=8    -> u32 version=80 (0x50), u32 =70
0x0000001c  LIST "PROJ"  size=191930     <- ALL event metadata
0x0002edf8  "SND "  size=72288698        <- FSB5 payload
```

Two traps:

1. **`"FEV FMT"` is not a chunk name.** `FEV ` is the RIFF *form type*; `FMT ` is the first chunk id, immediately adjacent. There is no "FEV FMT" chunk. Any documentation treating it as one is wrong.
2. **Chunk bodies are packed, not aligned.** Strings land at +23, floats at +33, GUIDs at +53. Do **not** assume 4-byte field alignment. The chunks themselves *are* padded to even boundaries — `offset += 8 + size + (size & 1)`.

**Recurring inline-array idiom (CONFIRMED):** `u16 tag, u16 elementStride, element[…]`, with the element count derived from remaining chunk size, never stored. Appears in `CURV`, `PMLB`, `PLST`, `TLNB`, `EVTB`.

**GUID encoding (CONFIRMED):** Microsoft layout — `u32` LE, `u16` LE, `u16` LE, then 8 raw bytes. Renders in the same text order as `GUIDs.txt`.

---

## 2. `PROJ` sub-lists (counts from this bank)

| Path | Contents | n |
|---|---|---|
| `BNKI` | bank GUID + counters | 1 |
| `EVTS/EVNT/EVTB` | **events** | 26 |
| `PRMS/PARM/PRMB` | **parameter definitions** | 45 |
| `PMLS/PMLO/PMLB`,`CTRO` | **parameter sheets** — instrument placement vs a parameter | 45 |
| `TLNS/TMLN/TLNB`,`TRNS` | **timelines** + transitions | 26 |
| `WAIS/WAIT/{INST,WAIB,PRPS}` | **wave (single-sound) instruments** | 167 |
| `MUIS/MUIT/{INST,MUIB,PLST}` | **multi instruments** + playlists | 19 |
| `WAVS/WAV ` | **waveform refs** -> FSB5 sample index | 103 |
| `CRVS/CURV` | **automation curve points** | 188 |
| `CTRS/CTRL` | **automation bindings** | 188 |
| `MODS/MODU` | modulators (ADSR/LFO/random) | 5 |
| `MPGS/MAP ` | parameter mappings / labels | 14 |
| `GBSS/GBUS`, `IBSS/IBUS`, `MBSS/MBUS` | group / input / master buses | 69 / 26 / 26 |
| `BEFX/BEFF`, `PEFX/PEFF` (+`PMEF`) | built-in and plugin effects (+ opaque plugin state) | 75 / 9 |
| `STBL`, `STDT` | string table — **size 0 here** | — |

### The `"INST{"` marker — solved (CONFIRMED)

Not a magic string. `INST` is the chunk id; `{` is `0x7B` = **123**, the low byte of the little-endian `u32` size. Every instrument record is exactly 123 bytes, so all of them read as `INST{\0\0\0`. Count: 167 wave + 19 multi = **186**.

### Event names (CONFIRMED)

`STBL`/`STDT` are empty — AC car banks ship no `.strings.bank`, so there are no event path strings in the file. Paths come from `sfx/GUIDs.txt`, and its GUIDs match `EVTB +0` byte-for-byte.
Verified: `{16387c2e-d70c-4e95-8774-02fa6a1bba5d}` = `event:/cars/ohyeah2389_t180_mach6/engine_ext` = first 16 bytes of `EVTB @0x16e92`.

---

## 3. Record layouts

### `PRMB` — parameter definition (variable) — **CONFIRMED**

```
+0        guid[16]   parameter GUID
+16..20   (5 bytes, zero in this bank)
+21       u16        name length N
+23       char[N]    name
+23+N     float      minimum
+27+N     float      maximum
end-16    guid[16]   GUID repeated
```

45 parameters decode cleanly: `rpms [0..25000]`, `rpms [0..20000]`, `throttle [0..1]`, `boost [0..2]`, `afterburner [0..1]`, `drivetrain_speed [0..800]`, `susp_travel_speed [0..1]`, `air_pressure [0.8..1.5]`, `Event Cone Angle [0..180]`, `Distance [0..500]`, etc. Duplicate names with different ranges are normal — each event owns its own parameter instance.

### `PMLB` — parameter sheet — **CONFIRMED**

```
+0    guid[16]   sheet GUID (== the parameter's GUID; PARM and PMLO are 1:1 here)
+16   guid[16]   repeated
+32   guid[16]   OWNER EVENT GUID          <- 45/45 matched an EVTB GUID
+48   u16        tag
+50   u16        stride = 24               (present only when children exist)
+52   child[n]   n = (size - 52) / 24
      child: guid[16] instrumentGUID, float start, float LENGTH
```

Minimum size 50 = no children. `+32` is the most reliable event->content link in the file — more so than walking `EVTB`.

> **AMBIGUOUS READING — this one will cost you hours.** The second float is **length, not max**. Both readings parse without error. Reading it as `max` yields plausible-looking narrow ranges and silently inverts some (`start 15000, second float 10000` reads as `15000..10000`). Correct: `15000..25000`. Independently confirmed by FModBankParser's `struct FTriggerBox { FModGuid Guid; uint StartTime, Length; }` — note theirs is `uint` (timeline, milliseconds) while the parameter-sheet variant is `float` in parameter units. Both forms exist.

### `WAIB` — wave instrument binding (32 bytes) — **CONFIRMED**

```
+0    guid[16]   instrument GUID (referenced by PMLB children and PLST entries)
+16   guid[16]   -> WAV chunk GUID
```

### `WAV ` — waveform reference (30 bytes) — **CONFIRMED**

```
+0    guid[16]
+16   u16 = 12   type
+22   u16        FSB5 SAMPLE INDEX
```

### `PLST` — multi-instrument playlist (variable) — **CONFIRMED**

```
+0    u32, u32, u16 tag
+10   u16 stride = 20
+12   entry[n]   n = (size - 12) / 20
      entry: guid[16] -> a WAIB (not a WAV directly), float weight
```

Nesting: multi instrument -> wave instruments -> `WAV` -> sample. All weights are 1.0 in this bank.
**UNKNOWN:** selection mode (random / sequential / shuffle) — not located.

### `INST` — instrument record (123 bytes, fixed)

Derived from a byte-variance analysis across all 167 wave instruments, then validated semantically.

```
+0    guid[16]   UNKNOWN — zero in 154/167 records
+16   float      volume, dB                        CONFIRMED
+20   float      pitch, semitones                  CONFIRMED
+24   u32        0xFFFFFFFF = loop, 0 = one-shot   CONFIRMED
+28   u8         1 = loop, 0 = one-shot            CONFIRMED (redundant with +24)
+29..52          zero
+53   guid[16]   parameter / sheet reference       CONFIRMED (51/167 non-zero)
+69   float      see below                         INFERRED
+76   u32        0x7FFFFFFF, constant
+83   guid[16]   output bus reference (-> GBSB)    CONFIRMED (78/167 non-zero)
+99..122         small counters                    UNKNOWN
```

**Why volume/pitch/loop are CONFIRMED, not guessed** — the values are self-evidencing:
- `+16` yields exactly `0.00, 1.00, 3.00, 5.00, 7.00, -8.00, -10.50` dB. Clean authored dB.
- `+20` yields exactly `-12.00` (one octave down) and `+10.00`. Exact semitones.
- `+24/+28` splits 65 loop / 102 one-shot, and the split is **100% semantically coherent**: every looping instrument is a sustained bed (`idle_2826`, `IdleEngine_noise`, `als_front`, `sin5`, `combustion`, `wind_mid`, `flat_tyre_mono`, `ext_idle1635_front`), every one-shot is transient (`911Backfire_ex_3`, `backfireEXT_7`, `door_open`, `Jump Jack normal`, `s1_pop_a_1`, `airstairs motor`). Zero misclassifications across 167 records.

**`+69` float — INFERRED, semantics NOT established.** It equals the RPM encoded in the sample's own filename, exactly, for engine loops:

| sample | `+69` |
|---|---|
| `idle_2826` | 2826.00 |
| `ext_idle1635_front` | 1635.00 |
| `IdleEngine_noise` | 6400.00 |
| `6365d` | 12800.00 |
| `sin5` | 21800.00 |
| `als_front` | 3000.00 |

116 of 167 records hold exactly `1.0`. Two exact filename matches to the digit are not coincidence — the field is real and carries the reference RPM of the recording. **But which FMOD property it is remains unidentified.** Emitted in the JSON as `float_at_inst_69`; do not build on an assumed meaning.

> **CAVEAT on static volume/pitch.** Each `WAIT` also carries a `LIST:PRPS` of `PROP` chunks (46/62 bytes, two GUIDs each) — per-instrument property overrides, **not decoded**. If a `PROP` override exists it may supersede the `INST +16`/`+20` values reported here.

### `CURV` — automation curve points — **CONFIRMED**

```
+0    guid[16]   curve GUID
+16   guid[16]   repeated
+32   u16 = 5    tag
+34   u16 = 16   point stride
+36   point[n]   n = (size - 36) / 16
      point: float x (parameter value), float y (property value), float shape, u32 type
```

Sizes 68 / 84 / 100 = 2 / 3 / 4 points. Matches FModBankParser's `struct FCurvePoint { float X, Y, Shape; uint Type; }` exactly — independent confirmation.
**UNKNOWN:** the `shape` semantics (0.0 in most curves; presumably interpolation curvature) and the trailing `type` u32.

### `CTRL` — automation binding (68 bytes) — **CONFIRMED**, 1:1 with `CURV` (188/188)

```
+0    guid[16]   == the CURV GUID
+16   guid[16]   TARGET OBJECT  (a WAIB, a GBSB group bus, or a BEFB/PEFB effect)
+32   guid[16]   PARAMETER GUID (the curve's x-axis)
+48   guid[16]   == +0
+64   u32        property enum
```

Property enum — **INFERRED** from target type plus observed value range, not from documentation:

| enum | n | target type | y range | reading |
|---|---|---|---|---|
| 0 | 84 | group buses (80), wave instr (3) | −42…+10 | bus volume, dB |
| 1 | 6 | wave instruments | −0.48…1.00 | pitch |
| 4 | 67 | wave instruments **only** | strictly 0…1 | instrument gain, linear |
| 1000/1001/1002 | 31 | bank & plugin effects only | varies | effect parameter index (1000 + n) |

`prop#4` is the engine crossfade. It appears exclusively as fade-in / fade-out pairs against `rpms`.

> **INFERRED combination rule.** An instrument frequently carries *two* `prop#4` curves against the *same* parameter — e.g. `(0,0)→(1000,1)` plus `(2000,1)→(4000,0)`. FMOD Studio's UI cannot author two curves on one property against one parameter, so these must combine. Under a **product** rule with endpoints held outside the defined span, the pair forms a trapezoid window: rise 0→1 over 0–1000, flat to 2000, fall to 0 by 4000. That is exactly the shape an engine crossfade needs, so the product rule is almost certainly right — **but it is not documented and not verified against playback.**

### `EVTB` — event (111–193 bytes) — **PARTIAL**

`+0` = event GUID (**CONFIRMED**). A `u16 tag / u16 stride=16` array at `+93` lists referenced parameter GUIDs (**CONFIRMED**). Trailing fields — polyphony, priority, min/max distance — **UNKNOWN**. Prefer `PMLB +32` for event ownership.

### `TLNB` — timeline — **PARTIAL**

`+16` = owner event GUID (**CONFIRMED**). Child array **UNKNOWN**: base offset varies (42 / 68 / …), so the array header is not at a fixed offset. **82 of 186 instruments are placed on timelines and are therefore not recovered by the parameter-sheet route.** For this car that does not matter — all engine layers live on `rpms` parameter sheets — but a general-purpose parser needs this. FModBankParser's `Nodes/TimelineNode` is where to read next.

---

## 4. FSB5 name table — the silent off-by-one

**CONFIRMED, and this is the single most dangerous trap in the whole format.**

The name table is a **bare `u32` offset array with no count field**. Offsets are relative to the table start and begin at `ntStart + 0`.

Reading them at `ntStart + 4` (assuming a leading count) parses without error and produces a **complete, plausible-looking sample list shifted by one**. In this bank that reading labels engine layers as `door_open` and `tyre_explosion` — wrong, but not obviously wrong.

**Sanity check that catches it:** `readU32(ntStart) == 4 * sampleCount`. Here `412 == 4 × 103`. If it holds, the first u32 *is* the first name's offset and there is no count field.

---

## 5. Applying it to this car

Instrument placements per event, via the parameter-sheet route:

```
 24  engine_custom      16  engine_int_old     14  engine_ext_old     11  turbine
  4  wheel               4  jumpjack_charge     3  limiter
  2  door / gear_ext / gear_int / gear_grind / wind / transmission / skid_ext / skid_int /
     tractioncontrol_ext / tractioncontrol_int / horn
  0  engine_ext          0  engine_int
```

**`engine_ext` and `engine_int` are empty stubs.** Their timeline chunk is the minimum 42 bytes and all four of their parameter sheets are the minimum 50 bytes. They contain no instruments and produce no sound from this bank. The engine lives on **`engine_custom`** (24 instruments — the CSP extended-sound path), with `engine_ext_old` / `engine_int_old` holding the legacy exterior/interior layers.

---

## 6. Tools and sources worth using

| Tool | Event metadata? | Verdict |
|---|---|---|
| [Masusder/FModBankParser](https://github.com/Masusder/FModBankParser) (C#, Apache-2.0) | **Yes, deeply** | The only real native parser. `EventNode`, `CurveNode`, `FCurvePoint`, `FTriggerBox`, `FEvaluator`, all instrument node types. Tested bank versions **0x33–0x92** — this bank's 0x50 is well inside. Read-only by design. Its source is the best public documentation of this format that exists. |
| [doggywatty/FMOD-Decompiler](https://github.com/doggywatty/FMOD-Decompiler) | Via the API only | Does **not** decode the format — loads banks with the real `fmodstudio.dll` and infers structure by playing events while watching `SOUND_PLAYED` callbacks. Behavioural reconstruction; cannot recover automation curves, effects or routing. |
| [Fmod5Sharp](https://github.com/SamboyCoding/Fmod5Sharp), [python-fsb5](https://github.com/HearthSim/python-fsb5), [fsbext](https://github.com/HanabishiRecca/fsbext), [vgmstream](https://github.com/vgmstream/vgmstream), [Fmod-Bank-Tools](https://github.com/Wouldubeinta/Fmod-Bank-Tools) | **No** | FSB5 audio only. python-fsb5 [issue #9](https://github.com/HearthSim/python-fsb5/issues/9) is an explicit dead end. Fmod-Bank-Tools "rebuild" is byte-budget sample substitution — hence its "duration must be same or less" rule, which proves it understands no metadata. |

**Nothing open-source can write event metadata.**

### What FMOD's own API can and cannot do

**Can:** `Studio::System::loadBankFile` -> `Bank::getEventCount`/`getEventList`; `EventDescription::getID`, `getParameterDescriptionCount`/`getParameterDescriptionByIndex` (`FMOD_STUDIO_PARAMETER_DESCRIPTION`: name, id, minimum, maximum, defaultvalue, type, flags, guid), `getLength`, `getMinMaxDistance`, `isOneshot`, `is3D`, `hasSustainPoint`.

**Cannot — structurally, not accidentally:**
- **Automation curves.** No API of any kind. FMOD staff, directly: the sidechain hack is *"the only way to get an automated value out of an event,"* and improvements are not on the roadmap — <https://qa.fmod.com/t/send-automation-curve-from-fmod-to-unity/13953>
- **Instrument enumeration**, trigger regions, layering. The word "instrument" appears four times in the entire API doc set, all prose. The runtime models an event as a black box with parameters and a master-track ChannelGroup.
- `getPath()` returns `FMOD_ERR_EVENT_NOTFOUND` without a `.strings.bank`. Moot here — `GUIDs.txt` supplies the mapping.
- `getEventList` omits events referenced by event instruments but built to another bank.

**Gotchas if you use the API to cross-check:**
- AC ships FMOD **1.08**; `FMOD_CHANNELCONTROL_DSP_*` differs between generations (1.x has a 4th `PANNER`, `TAIL = -4`; 2.x is `HEAD -1, FADER -2, TAIL -3`). Most mirrored headers online are 1.x.
- 1.08 uses `getParameterCount`/`getParameterByIndex`; the `…DescriptionCount`/`…DescriptionByIndex` names arrived in 2.00.
- `PARAMETER_FLAGS_LABELED` is never set in banks built before Studio 2.01.10 — this bank is older, expect no labels.
- Automatic parameters (`Distance`, `Event Cone Angle` — both present) cannot be swept; `setParameterByName` returns `FMOD_ERR_INVALID_PARAM`.
- For empirical sampling: `FMOD_OUTPUTTYPE_NOSOUND_NRT` + `FMOD_STUDIO_INIT_SYNCHRONOUS_UPDATE` gives one `Studio::System::update()` = exactly one mix block (don't also call core `update()`); pass `ignoreseekspeed = true` or you measure the seek-speed slew filter; assert `Channel::isVirtual() == false`; `FMOD_DSP_METERING_INFO` levels are linear, not dB. Authored randomness (multi-instruments, round-robins) is **not** defeatable through any API.

### Round-tripping a bank into FMOD Studio: not possible, by policy

Four staff answers over seven years, unanimous — [2019](https://qa.fmod.com/t/lost-source-any-decompile-possibilities/14279), [2020](https://qa.fmod.com/t/import-bank-file/15967) (deliberately unsupported to prevent copyright violation, *"no interest in supporting un-building banks in future"*), [2024](https://qa.fmod.com/t/opening-bank-file/21298), [2024](https://qa.fmod.com/t/getting-fmod-project-from-bank-files/21376) (asked whether Studio will ever open banks: *"No."*).

The Studio **scripting API** does expose the full graph — `event.masterTrack` / `groupTracks[]` -> `track.automationTracks[i]` -> `automator.objectBeingAutomated`, `automator.nameOfPropertyBeingAutomated`, `automationCurves[j].automationPoints`, and `Triggerable.addParameterCondition(parameter, min, max)` — but **only on an open `.fspro`**. `studio.project` has no `open`/`loadBank`. See <https://qa.fmod.com/t/fmod-studio-script-to-retrieve-automation-data/23152>.

That object model is a near-exact mirror of the binary (`objectBeingAutomated` = `CTRL +16`, `nameOfPropertyBeingAutomated` = `CTRL +64`, `automationPoints` = `CURV`), which is further confirmation the decode above is structurally right.

### FMOD Designer `.fev` is a red herring

This bank is **Studio-era**. AC ships `fmodstudio.dll` (Designer/FMOD Ex would be `fmod_event.dll` + `fmodex.dll`); `.bank` + `GUIDs.txt` + `common.strings.bank` is the Studio toolchain; the internal object model is Studio's. The `FEV ` you see is the RIFF form type, **not** the Designer format — FMOD reused the tag. Designer-era `.fev` documentation will not help and is an active wrong lead.

---

## 7. Consolidated unknowns

- `CURV` point `shape` semantics and the trailing `type` u32.
- `PLST` playlist selection mode (random / sequential / shuffle).
- `TLNB` child array — **82 of 186 instruments** are timeline-placed and unrecovered.
- `EVTB` trailing fields (polyphony, priority, min/max distance).
- `INST +0..15` GUID (zero in 154/167) and `INST +99..122` counters.
- `PROP` chunk layout — per-instrument property overrides that may supersede `INST +16`/`+20`.
- Fade in/out times, start offset, probability, and trigger conditions beyond the parameter trigger box.
- `INST +69` — value is real and matches recorded RPM exactly; the FMOD property it corresponds to is unidentified.
- Whether multiple `prop#4` curves combine multiplicatively (inferred) or otherwise.
