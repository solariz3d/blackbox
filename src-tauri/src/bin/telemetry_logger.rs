#![windows_subsystem = "windows"] // no console window (background helper; must not steal game focus)
// BLACKBOX telemetry logger — a tiny standalone background exe.
//
// Assetto Corsa publishes live physics to a Windows shared-memory page while you DRIVE
// (it does NOT during replay playback — verified). So this logs live: it timestamps + samples
// RPM, gear, throttle, brake, speed, wheel-slip, turbo boost + suspension travel, and when AC
// autosaves the session's .acreplay it staples the telemetry onto the end of that file with a footer:
//
//     [ …original .acreplay… ][ telemetry blob ][ u32 blobLen ][ "BBX1" ]
//
// BLACKBOX reads the tail (the replay parser ignores trailing bytes, proven). Assetto
// still lists/plays the file too IF it tolerates trailing bytes (the BBXTEST check).
//
// Zero game overhead — it just maps a buffer AC writes every physics tick anyway.
// Struct offsets are the version-stable base SPageFilePhysics layout (wheels: FL,FR,RL,RR;
// gear encoding 0=R,1=N,2=1st).

use std::ffi::c_void;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

// ---- minimal kernel32 FFI (no crate dependency) ---------------------------------
type Handle = *mut c_void;
const FILE_MAP_READ: u32 = 0x0004;
#[link(name = "kernel32")]
extern "system" {
    fn OpenFileMappingW(access: u32, inherit: i32, name: *const u16) -> Handle;
    fn MapViewOfFile(map: Handle, access: u32, off_hi: u32, off_lo: u32, len: usize) -> *mut c_void;
    fn UnmapViewOfFile(base: *const c_void) -> i32;
    fn CloseHandle(h: Handle) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Append a line to the logger's own log (no console — this is a background app).
fn log(msg: &str) {
    let dir = Path::new(&std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into())).join("BLACKBOX");
    let _ = fs::create_dir_all(&dir);
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(dir.join("telemetry_logger.log")) {
        let _ = writeln!(f, "{}", msg);
    }
}

/// A read-only view of one AC shared-memory page.
struct Page {
    handle: Handle,
    view: *const u8,
}
impl Page {
    fn open(name: &str) -> Option<Page> {
        unsafe {
            let h = OpenFileMappingW(FILE_MAP_READ, 0, wide(name).as_ptr());
            if h.is_null() {
                return None;
            }
            let v = MapViewOfFile(h, FILE_MAP_READ, 0, 0, 0) as *const u8;
            if v.is_null() {
                CloseHandle(h);
                return None;
            }
            Some(Page { handle: h, view: v })
        }
    }
    #[inline]
    fn f32(&self, off: usize) -> f32 {
        unsafe { (self.view.add(off) as *const f32).read_unaligned() }
    }
    /// volatile: the bridge page is written by another process while we read it, and the seqlock
    /// only works if the compiler actually re-reads `seq` instead of caching it
    #[inline]
    fn u32(&self, off: usize) -> u32 {
        unsafe { (self.view.add(off) as *const u32).read_volatile() }
    }
    #[inline]
    fn i32(&self, off: usize) -> i32 {
        unsafe { (self.view.add(off) as *const i32).read_unaligned() }
    }
}
impl Drop for Page {
    fn drop(&mut self) {
        unsafe {
            UnmapViewOfFile(self.view as *const c_void);
            CloseHandle(self.handle);
        }
    }
}

// ---- SPageFilePhysics offsets (base layout, bytes) ------------------------------
const PH_PACKET_ID: usize = 0;
const PH_GAS: usize = 4;
const PH_BRAKE: usize = 8;
const PH_GEAR: usize = 16;
const PH_RPMS: usize = 20;
const PH_SPEED_KMH: usize = 28;
const PH_WHEEL_SLIP: usize = 56; // float[4] FL,FR,RL,RR
const PH_SUSP_TRAVEL: usize = 184; // float[4] FL,FR,RL,RR — JUMP JACKS read off this: a jack
                                   // lifts the car so the jacked corners' springs extend fully
                                   // (all four / left pair FL+RL / right pair FR+RR). Standard
                                   // physics field, not a mod channel — the lift can't hide.
const PH_TURBO_BOOST: usize = 276; // real turbo boost pressure (1.0 idle → ~1.94 at load). NOTE:
                                   // this is continuous boost, NOT the T-180's discrete turbine
                                   // OVERRIDE — that's a custom CSP/Lua flag invisible to shared
                                   // memory (verified: drs & kersInput stay 0). We drive the
                                   // turbine visual off this real boost instead of the button.
// SPageFileGraphics: we only need `status` (offset 4) to gate on live driving. (Car position
// lived here at a padding-fragile offset; dropped — BLACKBOX syncs by time, not position.)
const GR_STATUS: usize = 4;

const AC_LIVE: i32 = 2;

/* ---- the CSP bridge: turbine state AC's shared memory does not carry ------------
 *
 * The T-180's afterburner is a BUTTON living in CSP's extended physics
 * (`ac.getCarPhysics(0).scriptControllerInputs[12]` / `[17]`, read by the mod's own graphics.lua),
 * and the turbine's thrust and rpm live beside it at [9] and [10]. None of that appears in
 * `acpmf_physics` — verified: `drs` and `kersInput` stay 0 while the button is held — which is why
 * every replay recorded before this bridge existed shows a plume inferred from turbo boost rather
 * than the driver's actual input. No general CSP telemetry page exists to piggyback on; the bridge
 * is a CSP app (csp/blackbox_bridge/) that mirrors the array into this mapping.
 *
 * Wire format is a seqlock: `seq` is odd while the writer is mid-update, even when published, so a
 * reader retries while it is odd or changed across the read. 120 bytes, hand-ordered for zero
 * implicit padding — do not reorder without changing the app to match.
 */
const BRIDGE_MAPPING: &str = r"Local\AcTools.CSP.Limited.BlackboxBridge.v0";
const BRIDGE_MAGIC: u32 = 0x3058_4242; // 'BBX0'
const BR_MAGIC: usize = 0;
const BR_SEQ: usize = 8;
const BR_FRAME: usize = 12;
const BR_SWITCH_MASK: usize = 16;
const BR_INPUTS: usize = 40; // f32[20]
// the T-180 family's own index convention, read off its graphics.lua. Other cars assign these
// slots differently, which is why the bridge publishes the whole window and the meaning is applied
// here, at the consumer, where it can be corrected per car.
const IN_THRUST: usize = 9;
const IN_TURBINE_RPM: usize = 10;
const IN_AFTERBURNER_L: usize = 12;
const IN_AFTERBURNER_R: usize = 17;

struct BridgeSnap {
    frame: u32,
    switch_mask: u32,
    inputs: [f32; 20],
}

/// Seqlock read of the bridge page. `None` = not publishing, or torn beyond retry.
fn read_bridge(p: &Page) -> Option<BridgeSnap> {
    if p.u32(BR_MAGIC) != BRIDGE_MAGIC {
        return None;
    }
    for _ in 0..16 {
        let s1 = p.u32(BR_SEQ);
        if s1 & 1 != 0 {
            std::hint::spin_loop();
            continue; // writer mid-update
        }
        let frame = p.u32(BR_FRAME);
        let switch_mask = p.u32(BR_SWITCH_MASK);
        let mut inputs = [0f32; 20];
        for (k, v) in inputs.iter_mut().enumerate() {
            *v = p.f32(BR_INPUTS + k * 4);
        }
        if p.u32(BR_SEQ) == s1 {
            return Some(BridgeSnap { frame, switch_mask, inputs });
        }
    }
    None
}

// ---- one telemetry sample (schema 6: 76 bytes, little-endian f32) ---------------
// 15 base floats (schema 5) + turbineRpm, thrust, afterburner, switchMask. The wide sample is
// always buffered; append_telemetry narrows it back to schema 5 when the bridge never published.
const SAMPLE_BYTES: usize = 76;
// timeMs, rpm, gear, gas, brake, speedKmh, slip[4], turboBoost, suspTravel[4]  (15 floats)
// timeMs = ms since this driving stint began. BLACKBOX tail-aligns telemetry to the replay by
// time (both streams end at the save moment), so a session-length buffer maps onto a short
// replay correctly and mid-session pauses don't desync it.
fn push_f32(buf: &mut Vec<u8>, v: f32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

/// Where AC saves replays. Documents is OneDrive-redirected on some machines (the laptop)
/// and plain on others (the desktop), so the shell decides, not us: check both roots and take
/// whichever actually holds the folder. Getting this wrong is SILENT — the folder scan simply
/// finds nothing forever and no replay is ever stamped — so log the choice either way.
fn replay_dir() -> PathBuf {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(up) = std::env::var("USERPROFILE") {
        roots.push(Path::new(&up).join("Documents"));
    }
    if let Ok(od) = std::env::var("OneDrive") {
        roots.push(Path::new(&od).join("Documents"));
    }
    let candidates: Vec<PathBuf> = roots
        .iter()
        .map(|r| r.join("Assetto Corsa").join("replay"))
        .collect();
    if let Some(hit) = candidates.iter().find(|p| p.is_dir()) {
        log(&format!("watching replay folder: {}", hit.display()));
        return hit.clone();
    }
    let fallback = candidates
        .into_iter()
        .next()
        .unwrap_or_else(|| PathBuf::from("C:\\"));
    log(&format!(
        "WARNING: no Assetto Corsa replay folder found — falling back to {} (nothing will be stamped until it exists)",
        fallback.display()
    ));
    fallback
}

fn list_acreplays(dir: &Path) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("acreplay")).unwrap_or(false) {
                v.push(p);
            }
        }
    }
    v
}

/// Is this replay already telemetry-stamped? (ends with the "BBX1" footer) — avoids
/// double-appending if the logger restarts or re-sees a file.
fn already_stamped(replay: &Path) -> bool {
    if let Ok(mut f) = fs::File::open(replay) {
        if f.seek(SeekFrom::End(-4)).is_ok() {
            let mut b = [0u8; 4];
            if f.read_exact(&mut b).is_ok() {
                return &b == b"BBX1";
            }
        }
    }
    false
}

/// Append the telemetry blob + BBX1 footer onto the freshly-saved replay. ONE file that
/// plays natively in AC/Content Manager (verified: they tolerate trailing bytes) AND carries
/// telemetry for BLACKBOX, which finds the blob from the tail via the footer.
///   [ …replay… ][ "BBTL" | u16 ver | u16 schema | u32 count | u32 bytesPerSample | samples ][ u32 blobLen | "BBX1" ]
/// `bridge_live` = the CSP bridge actually published during this stint.
///
/// Schema is chosen HERE, not at record time, and the rule is deliberate: a replay that claims
/// schema 6 with dead turbine channels is worse than an honest schema 5 — the viewer would show a
/// flame that never fires and it would read as a bug in BLACKBOX forever. So the buffer always
/// carries the wide sample, and if the bridge never published, the four CSP columns are stripped
/// back out on the way to disk and the file says schema 5, truthfully.
fn append_telemetry(replay: &Path, samples: &[u8], count: u32, bridge_live: bool) {
    if already_stamped(replay) {
        return;
    }
    let (schema, bps, payload): (u16, u32, Vec<u8>) = if bridge_live {
        (6, SAMPLE_BYTES as u32, samples.to_vec())
    } else {
        let mut narrow = Vec::with_capacity(count as usize * 60);
        for s in samples.chunks_exact(SAMPLE_BYTES) {
            narrow.extend_from_slice(&s[..60]); // drop turbRpm, thrust, afterburner, switchMask
        }
        (5, 60, narrow)
    };
    let mut blob = Vec::with_capacity(payload.len() + 16);
    blob.extend_from_slice(b"BBTL");
    blob.extend_from_slice(&5u16.to_le_bytes()); // version 5
    // schema 5 = timeMs,rpm,gear,gas,brake,speed,slip[4],turboBoost,suspTravel[4]        (15 f32)
    // schema 6 = schema 5 + turbineRpm,thrust,afterburner,switchMask (CSP bridge)        (19 f32)
    blob.extend_from_slice(&schema.to_le_bytes());
    blob.extend_from_slice(&count.to_le_bytes());
    blob.extend_from_slice(&bps.to_le_bytes());
    blob.extend_from_slice(&payload);
    let mut footer = Vec::new();
    footer.extend_from_slice(&(blob.len() as u32).to_le_bytes());
    footer.extend_from_slice(b"BBX1");

    match fs::OpenOptions::new().append(true).open(replay) {
        Ok(mut f) => {
            if f.write_all(&blob).and_then(|_| f.write_all(&footer)).and_then(|_| f.flush()).is_ok() {
                log(&format!("appended {} telemetry samples onto {}", count, replay.display()));
            } else {
                log(&format!("append write failed: {}", replay.display()));
            }
        }
        Err(e) => log(&format!("could not open {} to append: {}", replay.display(), e)),
    }
}

fn main() {
    log("telemetry logger started — waiting for Assetto Corsa…");
    let dir = replay_dir();
    // remember which replays already existed so we only stamp NEW ones
    let mut seen: Vec<PathBuf> = list_acreplays(&dir);

    let mut phys: Option<Page> = None;
    let mut graf: Option<Page> = None;
    // the CSP bridge is optional: without it we simply record schema 5 as before
    let mut bridge: Option<Page> = None;
    let mut bridge_live = false;          // did it ever actually publish this stint?
    let mut bridge_logged = false;
    let mut last_bridge_scan = std::time::Instant::now();

    let mut samples: Vec<u8> = Vec::new();
    let mut count: u32 = 0;
    let mut last_packet: i32 = -1;
    let mut was_live = false;
    let mut stint_start: Option<std::time::Instant> = None; // t=0 for this session's sample timestamps
    let mut last_sample: Option<std::time::Instant> = None;  // freshness guard so we never staple a stale buffer
    let mut last_scan = std::time::Instant::now();

    loop {
        // (re)connect to the shared memory when AC is up
        if phys.is_none() {
            phys = Page::open("Local\\acpmf_physics");
            graf = Page::open("Local\\acpmf_graphics");
            if phys.is_some() {
                log("connected to Assetto Corsa shared memory.");
            }
        }
        // the bridge is a separate CSP app the user enables in-game, so it can appear (and vanish)
        // independently of AC itself. Retry ~1 Hz rather than every tick — OpenFileMapping on a
        // missing name at 333 Hz is pure syscall churn.
        if bridge.is_none() && last_bridge_scan.elapsed() >= Duration::from_secs(1) {
            last_bridge_scan = std::time::Instant::now();
            bridge = Page::open(BRIDGE_MAPPING);
            if bridge.is_some() && !bridge_logged {
                bridge_logged = true;
                log("CSP bridge mapping found.");
            }
        }

        if let (Some(p), Some(g)) = (&phys, &graf) {
            let status = g.i32(GR_STATUS);
            let live = status == AC_LIVE;

            // CONTINUOUS rolling buffer — resets/restarts NEVER wipe telemetry. Reset-heavy
            // hotlapping (run off → restart session, over and over) used to clear the buffer on
            // every restart (a restart is a >2.5 s non-live gap), so the clean lap you finally saved
            // came out silent. Now the logger records the whole time AC is open; BLACKBOX tail-aligns
            // this buffer to whatever replay you save (both end at the save moment, so it grabs the
            // last replay-length slice = your saved lap). The buffer is cleared ONLY when AC actually
            // closes — a genuine new session — handled in the disconnect branch below.
            if live && stint_start.is_none() {
                stint_start = Some(std::time::Instant::now());
                log("driving — logging telemetry (continuous; restarts/resets won't wipe it).");
            }
            was_live = live;

            if live {
                let packet = p.i32(PH_PACKET_ID);
                if packet != last_packet {
                    last_packet = packet;
                    // physics-page channels only (all rock-solid offsets). Car position lived on
                    // the graphics page at a padding-fragile offset and isn't needed — BLACKBOX
                    // syncs telemetry to replay frames by TIME, not position.
                    let t_ms = stint_start.map_or(0.0, |t0| t0.elapsed().as_secs_f64() * 1000.0) as f32;
                    push_f32(&mut samples, t_ms); // ms since stint start (tail-align anchor)
                    push_f32(&mut samples, p.i32(PH_RPMS) as f32);
                    push_f32(&mut samples, p.i32(PH_GEAR) as f32);
                    push_f32(&mut samples, p.f32(PH_GAS));
                    push_f32(&mut samples, p.f32(PH_BRAKE));
                    push_f32(&mut samples, p.f32(PH_SPEED_KMH));
                    for w in 0..4 {
                        push_f32(&mut samples, p.f32(PH_WHEEL_SLIP + w * 4));
                    }
                    push_f32(&mut samples, p.f32(PH_TURBO_BOOST)); // real boost pressure
                    // jump-jack signal: suspension travel per corner (FL,FR,RL,RR)
                    for w in 0..4 {
                        push_f32(&mut samples, p.f32(PH_SUSP_TRAVEL + w * 4));
                    }
                    // ---- CSP bridge channels (schema 6). Zeroes when the bridge is absent, and
                    // append_telemetry then strips these columns and writes schema 5 instead, so a
                    // file never claims turbine data it does not have.
                    let snap = bridge.as_ref().and_then(read_bridge);
                    match &snap {
                        Some(b) => {
                            push_f32(&mut samples, b.inputs[IN_TURBINE_RPM]);
                            push_f32(&mut samples, b.inputs[IN_THRUST]);
                            // either turbine's afterburner lights the plume
                            push_f32(&mut samples, b.inputs[IN_AFTERBURNER_L].max(b.inputs[IN_AFTERBURNER_R]));
                            push_f32(&mut samples, b.switch_mask as f32); // exact to 2^24 switches
                            if !bridge_live && b.frame > 0 {
                                bridge_live = true;
                                log("CSP bridge is publishing — recording turbine/afterburner (schema 6).");
                            }
                        }
                        None => {
                            for _ in 0..4 {
                                push_f32(&mut samples, 0.0);
                            }
                        }
                    }
                    count += 1;
                    last_sample = Some(std::time::Instant::now());
                    // cap the rolling buffer at ~25 min so a session left open all day can't grow
                    // unbounded; trim the oldest 5 min when it fills. The loader only uses the tail
                    // (the saved replay's length), so trimming the oldest samples is lossless for it.
                    const CAP: u32 = 25 * 60 * 333;         // ~25 min at ~333 Hz
                    if count > CAP {
                        let drop = 5u32 * 60 * 333;         // trim oldest 5 min
                        samples.drain(0..(drop as usize) * SAMPLE_BYTES);
                        count -= drop;
                    }
                }
            }
        } else {
            // AC closed → genuine session boundary: drop the mappings AND clear the buffer, so the
            // NEXT session (new car/track) starts fresh instead of tail-aligning onto old telemetry.
            phys = None;
            graf = None;
            // AC closing takes the bridge's mapping with it — drop ours so the next session
            // re-opens it, and re-arm the "did it publish" flag so a stale true can't make the
            // next replay claim schema 6 it has no data for
            bridge = None;
            bridge_live = false;
            bridge_logged = false;
            samples.clear();
            count = 0;
            stint_start = None;
            last_sample = None;
        }

        // Watch for a NEW .acreplay (AC saved the session) — but scan the FOLDER at most once
        // a second, NOT every telemetry tick. Scanning the directory 333×/s hammers the
        // filesystem and causes system-wide micro-stutter. New replays only appear at session
        // end anyway, so once-a-second is plenty and never happens mid-drive (skip while live).
        if !was_live && last_scan.elapsed() >= Duration::from_secs(1) {
            last_scan = std::time::Instant::now();
            let now = list_acreplays(&dir);
            for p in &now {
                if !seen.contains(p) {
                    let stable = |path: &Path| {
                        let a = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                        sleep(Duration::from_millis(400));
                        let b = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                        a == b && b > 0
                    };
                    // freshness guard: only staple a buffer that was still filling recently, so a
                    // save made long after driving (AC left open) never gets a stale stint.
                    let fresh_buf = last_sample.map_or(false, |t| t.elapsed() < Duration::from_secs(120));
                    if count > 0 && fresh_buf && stable(p) {
                        // Do NOT clear the buffer: one save often emits TWO files (a CM save +
                        // AC's autosave, seconds apart). Both must get the SAME telemetry; each
                        // tail-aligns itself to its own replay length. The buffer keeps rolling and
                        // is cleared only when AC closes. (already_stamped guards against re-appending.)
                        append_telemetry(p, &samples, count, bridge_live);
                    }
                }
            }
            seen = now;
        }

        // sample fast only while actually driving; idle cheaply otherwise
        let ms = if phys.is_none() { 500 } else if was_live { 2 } else { 150 };
        sleep(Duration::from_millis(ms));
    }
}
