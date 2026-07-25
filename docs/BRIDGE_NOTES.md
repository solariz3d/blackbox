# BLACKBOX Bridge — CSP → external process

Reads CSP extended-physics values that do **not** exist in AC's stock shared
memory and republishes them into a named Windows file mapping that
`telemetry_logger.rs` can map with the same raw kernel32 FFI it already uses for
`Local\acpmf_physics`.

Written against **CSP 0.2.11 (dwrite.dll 0.2.11.0, 2025-06-11), build 3465**.

---

## 1. Scope verdict — does an APP see `ac.getCarPhysics`?

**Yes.** Confidence high, but stub-level rather than runtime-proven — see §7.

Evidence:

1. **CSP ships per-script-type API stubs**, one `lib.lua` per type, and they are
   genuinely differentiated — not copies:

   | stub type | size | `getCarPhysics` | `scriptControllerInputs` | `writeMemoryMappedFile` |
   |---|---|---|---|---|
   | `ac_apps` | 956,651 | **yes** | **yes** | yes |
   | `ac_new_modes` | 949,925 | yes | yes | yes |
   | `ac_track_script` | 871,882 | yes | yes | yes |
   | `ac_car_cphys` | 456,056 | yes | yes | yes |
   | `ac_splashscreen` | 599,903 | **no** | **no** | yes |

   `ac_splashscreen` lacking both while retaining MMF is the control case: the
   stubs encode real per-type availability. `ac_apps` declaring them is therefore
   meaningful, not boilerplate.

2. **`ac.StateCarPhysics.scriptControllerInputs` is declared in `ac_apps\lib.lua`
   line 4320** — `number[] @256 items, starts with 0`. (256, not the 8 the public
   wiki implies; the wiki's 8 is the `CPHYS_SCRIPT_0..7` *instrument-input*
   subset.)

3. **Shipped non-car scripts already call it**, so it is not car-script-only:
   - `extension\lua\joypad-assist\Advanced Gamepad Assist\assist.lua`
   - `extension\lua\joypad-assist\Advanced Gamepad Assist\CarPerformanceData.lua`
   - `extension\lua\ffb-postprocess\alternative\ffb.lua`

   Caveat, stated plainly: those are `ac_joypad_assist` / `ac_ffb_postprocess`,
   **not** `ac_apps`. No shipped app in this install calls it, so there is no
   in-the-wild app-scope example. The stub table above is the load-bearing
   evidence.

**Anti-silent-zeros.** Because I could not run the game, the bridge is built so
that "app scope doesn't work" is *visibly distinguishable* from "it works and the
value is 0". It publishes `statusFlags` every frame and a live seqlock:

| bit | mask | meaning |
|---|---|---|
| 0 | `0x01` | `ac.getCarPhysics(0)` returned non-nil |
| 1 | `0x02` | `carPhysics.isAvailable` |
| 2 | `0x04` | `car.extendedPhysics` (CSP extended physics active) |
| 3 | `0x08` | `car.physicsAvailable` (not replay / remote car) |
| 4 | `0x10` | `sim.isReplayActive` |
| 5 | `0x20` | `sim.isPaused` |
| 6 | `0x40` | sticky: some input has been non-zero since load |

Diagnosis:

- `frame` not advancing → app not loaded, or `script.update` not running.
- `frame` advancing, bit 0 clear → **app scope cannot reach `getCarPhysics`.**
  That is the failure the coordinator asked to surface. Fallback in §6.
- bit 0 set, bit 2 clear → extended physics is off for this car; enable it.
- bits 0+2 set, bit 6 never sets → scope is fine, the car simply isn't writing
  those indices (wrong car, or indices differ on that variant).

---

## 2. Wire format

Mapping name: `Local\AcTools.CSP.Limited.BlackboxBridge.v0`

The `AcTools.CSP.Limited.` prefix is the carve-out that lets sandboxed
(`withoutIO`) scripts create mappings; it is a plain string for an app and is
harmless here. Keeping it preserves the option of moving this logic into a car
physics script later (333 Hz) without renaming the mapping.

Layout is passed to `ac.writeMemoryMappedFile` as a **raw C string**, never an
`ac.StructItem` table — table layouts get reordered (packing size descending,
then alphabetical, then bin-packed) and would silently desync this struct.

Field order is hand-tuned for **zero implicit padding**. Total **120 bytes**.

| offset | type | field | notes |
|---:|---|---|---|
| 0 | `u32` | `magic` | `0x30584242` (`'BBX0'` LE). 0 = bridge released |
| 4 | `u32` | `version` | `1` |
| 8 | `u32` | `seq` | seqlock; **odd = write in progress** |
| 12 | `u32` | `frame` | published-frame counter |
| 16 | `u32` | `switchMask` | bit *i* set when `inputs[i] > 0.5` |
| 20 | `u32` | `statusFlags` | table in §1 |
| 24 | `u32` | `carIndex` | `0` |
| 28 | `u32` | `inputCount` | `20` |
| 32 | `f64` | `simTimeMs` | `ac.getSim().time` (same clock as AC) |
| 40 | `f32[20]` | `inputs` | `scriptControllerInputs[0..19]` |
| 120 | | | end |

Interpretation of indices deliberately lives in the **consumer**, not the
bridge. For reference, on `ohyeah2389_t180_typea` the car's own `graphics.lua`
uses a 5-wide per-turbine stride: throttle 8/13, thrust 9/14, rpm 10/15,
fuelPump 11/16, **afterburner 12/17**, damage 18/19 (left-or-single / right).
That is that mod's private convention and may differ per car — hence publishing
the whole 0..19 window.

---

## 3. Rust side — paste into `telemetry_logger.rs`

No crates; same style as the existing `acpmf_physics` mapping.

```rust
use std::ffi::c_void;
use std::sync::atomic::{compiler_fence, Ordering};

pub const BRIDGE_MAPPING: &str = r"Local\AcTools.CSP.Limited.BlackboxBridge.v0";
pub const BRIDGE_MAGIC: u32 = 0x3058_4242; // 'BBX0'

// statusFlags bits
pub const F_PHYS_STATE:   u32 = 0x01;
pub const F_PHYS_AVAIL:   u32 = 0x02;
pub const F_EXT_PHYSICS:  u32 = 0x04;
pub const F_CAR_PHYS_OK:  u32 = 0x08;
pub const F_REPLAY:       u32 = 0x10;
pub const F_PAUSED:       u32 = 0x20;
pub const F_EVER_NONZERO: u32 = 0x40;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct BridgeFrame {
    pub magic: u32,
    pub version: u32,
    pub seq: u32,
    pub frame: u32,
    pub switch_mask: u32,
    pub status_flags: u32,
    pub car_index: u32,
    pub input_count: u32,
    pub sim_time_ms: f64,
    pub inputs: [f32; 20],
}
const _: () = assert!(std::mem::size_of::<BridgeFrame>() == 120);

type Handle = *mut c_void;
const FILE_MAP_READ: u32 = 0x0004;

#[link(name = "kernel32")]
extern "system" {
    fn OpenFileMappingW(access: u32, inherit: i32, name: *const u16) -> Handle;
    fn MapViewOfFile(h: Handle, access: u32, off_hi: u32, off_lo: u32, bytes: usize) -> *mut c_void;
    fn UnmapViewOfFile(base: *const c_void) -> i32;
    fn CloseHandle(h: Handle) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub struct BridgeReader {
    handle: Handle,
    ptr: *const BridgeFrame,
}

impl BridgeReader {
    /// Returns None if the mapping does not exist yet (game not running, or the
    /// app is not installed/enabled). Safe to retry every second.
    pub fn open() -> Option<Self> {
        let name = wide(BRIDGE_MAPPING);
        let handle = unsafe { OpenFileMappingW(FILE_MAP_READ, 0, name.as_ptr()) };
        if handle.is_null() {
            return None;
        }
        let view = unsafe {
            MapViewOfFile(handle, FILE_MAP_READ, 0, 0, std::mem::size_of::<BridgeFrame>())
        };
        if view.is_null() {
            unsafe { CloseHandle(handle) };
            return None;
        }
        Some(Self { handle, ptr: view as *const BridgeFrame })
    }

    /// Seqlock read. None = torn beyond retry, or bridge not publishing.
    pub fn read(&self) -> Option<BridgeFrame> {
        let seq_ptr = unsafe { std::ptr::addr_of!((*self.ptr).seq) };
        for _ in 0..16 {
            let s1 = unsafe { seq_ptr.read_volatile() };
            if s1 & 1 != 0 {
                std::hint::spin_loop();
                continue; // writer mid-update
            }
            compiler_fence(Ordering::Acquire);
            let snap = unsafe { std::ptr::read_volatile(self.ptr) };
            compiler_fence(Ordering::Acquire);
            let s2 = unsafe { seq_ptr.read_volatile() };
            if s1 == s2 {
                return if snap.magic == BRIDGE_MAGIC { Some(snap) } else { None };
            }
        }
        None
    }
}

impl Drop for BridgeReader {
    fn drop(&mut self) {
        unsafe {
            UnmapViewOfFile(self.ptr as *const c_void);
            CloseHandle(self.handle);
        }
    }
}

// SAFETY: read-only view of a shared mapping; no interior mutability on our side.
unsafe impl Send for BridgeReader {}
```

Call-site sketch, alongside the existing 333 Hz acpmf loop:

```rust
let mut bridge = BridgeReader::open();
let mut last_bridge_frame = 0u32;

// inside the 333 Hz sample loop:
if bridge.is_none() { /* retry ~1 Hz, not every tick */ }

let (afterburner_l, afterburner_r, switch_mask, bridge_fresh) =
    match bridge.as_ref().and_then(|b| b.read()) {
        Some(f) => {
            let fresh = f.frame != last_bridge_frame;
            last_bridge_frame = f.frame;
            (f.inputs[12], f.inputs[17], f.switch_mask, fresh)
        }
        None => (0.0, 0.0, 0, false),
    };
```

The bridge publishes at graphics rate (~60–165 Hz) while the logger samples at
333 Hz, so ~2–5 consecutive samples share a `frame`. Record `frame` (or the
`bridge_fresh` flag) into the log so downstream can tell held-over values from
newly published ones — do not interpolate a button.

`sim_time_ms` shares AC's clock with `ac.getSim().time`, which is the sane key to
align against replay frames.

---

## 4. Install (explicit, manual — nothing was written into the AC install)

Source lives at `C:\Users\zackn\blackbox\csp\blackbox_bridge\`
(`blackbox_bridge.lua`, `manifest.ini`, `icon.png`).

1. Copy the whole **folder** to:
   `C:\Program Files (x86)\Steam\steamapps\common\assettocorsa\apps\lua\blackbox_bridge\`
   (folder name must match the `.lua` filename — that is how CSP resolves an app.)
2. Content Manager → **Settings → Custom Shaders Patch → Apps** — confirm
   "BLACKBOX Bridge" is listed and enabled.
3. Launch a session with the target car. Open the in-game app bar (right edge)
   and enable **BLACKBOX Bridge** at least once.
4. Extended physics must be on for the car — the T-180s ship with it enabled;
   the window's `car.extendedPhysics` line confirms it live.

Uninstall = delete the folder. It touches no car and no game file.

---

## 5. Verification

**In-game, no external process needed.** The app window is the test rig: `seq`
and `frame` must climb, and pressing the Afterburner bind should light `[12]`
(and `[17]` on twin-turbine cars) yellow and set the corresponding bit in
`mask`. All five status lines should read green except the replay/paused
banners.

**From Rust**, minimal smoke test:

```rust
fn main() {
    let b = BridgeReader::open().expect("mapping absent — is AC running with the app enabled?");
    let mut last = 0;
    loop {
        if let Some(f) = b.read() {
            if f.frame != last {
                last = f.frame;
                println!("frame {:6} flags 0x{:02X} mask 0x{:05X} [12]={:.3} [17]={:.3}",
                         f.frame, f.status_flags, f.switch_mask, f.inputs[12], f.inputs[17]);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(3));
    }
}
```

Expected: `flags 0x4F` while driving (bits 0,1,2,3 set; bit 6 once anything has
moved), `frame` advancing, `[12]` swinging 0→1 with the button.

**Ordering note:** either side may create the mapping and CSP explicitly supports
the file having been "created before by a separate process". But the *layout* is
defined by whoever creates it first — if the Rust logger starts first with a
different size, behaviour is undefined. Simplest discipline: let the Lua app be
the creator, and have Rust treat "mapping absent" as a normal retry state.

---

## 6. If bit 0 never sets (app scope fails)

Ranked fallbacks, all still avoiding edits to the car mod:

1. **`ac_new_modes` script** — `extension\lua\new-modes\`. Its stub declares both
   `getCarPhysics` and `scriptControllerInputs` (949,925 bytes, near-parity with
   `ac_apps`), it is not car-owned, and it has full I/O. Highest-confidence
   alternative; same `script.update` shape, same MMF call.
2. **`ac_joypad_assist`** — the one type *empirically proven* to call
   `ac.getCarPhysics` in shipped code (`assist.lua`). Ugly host for a telemetry
   bridge and it fights Advanced Gamepad Assist for the slot, but it is the
   strongest evidence-backed option.
3. **`ac_ffb_postprocess`** — also proven in shipped code (`ffb.lua`), runs at a
   high rate. Same objection: hijacking a feature slot.
4. **Drop to `car.extraB`** — `ac.StateCar` exposes `extraA`..`extraT` (20 extra
   switches; the wiki still says 6). `__EXT_LIGHT_B` = `extraB` = the raw
   Afterburner button, per that car's `ext_config.ini`
   (`SWITCH_B = Afterburner`, `HOLD_MODE`). Loses the *derived* turbine state
   (heat derate, fuel gating) but is stable CSP API rather than a mod's private
   index convention, and works in any scope that has `ac.getCar`.

A belt-and-braces option: publish `extraA..extraT` as a second bitmask beside
`switchMask`. Cheap, and it would keep the switch usable even if
`scriptControllerInputs` turns out unreachable. Say the word and I'll add it.

---

## 7. Could not verify without running the game

Honest list — none of these are papered over above:

- **App-scope `ac.getCarPhysics` at runtime.** Stub-level evidence is strong
  (§1) but no shipped `ac_apps` example exists. This is why `statusFlags` bit 0
  exists.
- **Whether `script.update` runs with the window closed under `LAZY = 0`.**
  Intent is yes; if `frame` only advances while the window is open, that is the
  cause, and the window can simply be left open.
- **`FLAGS = AUTO_RESIZE`** on `[WINDOW_0]` — copied from the documented flag set
  but not confirmed against this build's parser. If the app fails to load, empty
  the FLAGS line first; it is cosmetic.
- **`REQUIRED_VERSION = 3465`** — taken from the reported build number. If CM
  refuses the app, lower or remove it.
- **Store ordering across the seqlock.** LuaJIT emits no explicit barrier; the
  scheme relies on x86-TSO store ordering. Sound in practice for one writer at
  ~100 Hz and one reader at 333 Hz, but it is a practical guarantee, not a
  language-level one.
- **Whether the `AcTools.CSP.Limited.` prefix has any side effect for a
  non-sandboxed app.** Expected to be inert (it is just a name; the carve-out
  only *grants* access to restricted scripts). Untested.

Verified after the first draft, no longer open:

- **`ac.onRelease(fn)` is the correct unload hook** — there is no
  `script.onRelease`. Confirmed in shipped app-scope code (`CspDebug.lua:1295`,
  `MumbleWrapper.lua:100`). The bridge was corrected accordingly.
- **`bit.lshift` is available in app scope** — LuaJIT builtin, undocumented in
  the stubs but used by the shipped app `CspDebug.lua:40`.
- **`ac.log` / `ac.warn` / `ac.error` all exist** in `ac_apps`.
- **`extension/internal/*` is `ac_apps` scope** per `rules.json`, which is what
  makes `CspDebug` valid evidence about app scope rather than merely about
  internal scripts.
