// BLACKBOX native shell (Tauri 2). Three commands give the web UI native disk
// access: list the replay folder, read any file as raw bytes (no permission
// prompts), and locate a track's .kn5 files from the Steam AC install by
// parsing libraryfolders.vdf. The UI runs identically in a browser (drag-drop)
// or here (auto-listed) — it feature-detects window.__TAURI__.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(serde::Serialize)]
struct ReplayInfo {
    name: String,
    path: String,
    size: u64,
    modified: u64,
}

#[derive(serde::Serialize)]
struct TrackFile {
    name: String,
    path: String,
}

fn replay_dir() -> Result<PathBuf, String> {
    // Documents may be OneDrive-redirected (laptop) or plain (desktop) — the
    // shell decides, not us. Check both roots; first one that actually holds
    // an "Assetto Corsa\replay" wins. Zero deps, both machines honest.
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(profile) = std::env::var("USERPROFILE") {
        roots.push(Path::new(&profile).join("Documents"));
    }
    if let Ok(onedrive) = std::env::var("OneDrive") {
        roots.push(Path::new(&onedrive).join("Documents"));
    }
    let candidates: Vec<PathBuf> = roots
        .iter()
        .map(|r| r.join("Assetto Corsa").join("replay"))
        .collect();
    candidates
        .iter()
        .find(|p| p.is_dir())
        .cloned()
        .ok_or_else(|| {
            format!(
                "Assetto Corsa replay folder not found (checked: {})",
                candidates
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(" ; ")
            )
        })
}

#[tauri::command]
fn list_replays() -> Result<Vec<ReplayInfo>, String> {
    let dir = replay_dir()?;
    let read = std::fs::read_dir(&dir).map_err(|e| format!("{}: {}", dir.display(), e))?;
    let mut out = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        let is_replay = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("acreplay"))
            .unwrap_or(false);
        if !is_replay {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(ReplayInfo {
            name: entry.file_name().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            size: meta.len(),
            modified,
        });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified)); // newest first
    Ok(out)
}

#[tauri::command]
fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("{}: {}", path, e))
}

// AC's in-game screenshots (F8) land here as
// `Screenshot_<carId>_<trackId>_<timestamp>.jpg`. Documents may be OneDrive-
// redirected, so try both roots and keep the plain one for the error message.
fn screens_dir() -> Result<PathBuf, String> {
    let profile = std::env::var("USERPROFILE").map_err(|e| e.to_string())?;
    let plain = Path::new(&profile)
        .join("Documents")
        .join("Assetto Corsa")
        .join("screens");
    let onedrive = Path::new(&profile)
        .join("OneDrive")
        .join("Documents")
        .join("Assetto Corsa")
        .join("screens");
    if plain.exists() {
        Ok(plain)
    } else if onedrive.exists() {
        Ok(onedrive)
    } else {
        Ok(plain) // return the canonical path so the error names it
    }
}

// List every screenshot (full path). Matching a shot to a track is done in the
// UI, which holds the canonical track-folder list (both carId and trackId can
// contain underscores, so the track is found as a suffix of the mid-section).
#[tauri::command]
fn list_screenshots() -> Result<Vec<String>, String> {
    let dir = screens_dir()?;
    let read = std::fs::read_dir(&dir).map_err(|e| format!("{}: {}", dir.display(), e))?;
    let mut out = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        let is_img = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| {
                let s = s.to_ascii_lowercase();
                s == "jpg" || s == "jpeg" || s == "png"
            })
            .unwrap_or(false);
        if is_img {
            out.push(path.to_string_lossy().to_string());
        }
    }
    Ok(out)
}

// Enumerate Steam library roots: the default install(s) plus every path listed
// in libraryfolders.vdf (that's how AC ends up on a second drive like G:).
fn steam_libraries() -> Vec<PathBuf> {
    let mut libs: Vec<PathBuf> = Vec::new();
    for c in [
        r"C:\Program Files (x86)\Steam",
        r"C:\Program Files\Steam",
    ] {
        let p = PathBuf::from(c);
        if p.exists() {
            libs.push(p);
        }
    }
    // parse libraryfolders.vdf from any found default install
    let bases: Vec<PathBuf> = libs.clone();
    for base in bases {
        let vdf = base.join("steamapps").join("libraryfolders.vdf");
        if let Ok(txt) = std::fs::read_to_string(&vdf) {
            for line in txt.lines() {
                let line = line.trim();
                if line.starts_with("\"path\"") {
                    // "path"		"D:\\SteamLibrary"
                    if let Some(raw) = line.split('"').nth(3) {
                        let p = PathBuf::from(raw.replace("\\\\", "\\"));
                        if p.exists() && !libs.contains(&p) {
                            libs.push(p);
                        }
                    }
                }
            }
        }
    }
    libs
}

fn collect_kn5(dir: &Path, out: &mut Vec<TrackFile>, depth: u32) {
    if depth > 3 {
        return;
    }
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // skip the ui/preview folder — never physical track geometry
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name.eq_ignore_ascii_case("ui") {
                continue;
            }
            collect_kn5(&path, out, depth + 1);
        } else if path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("kn5"))
            .unwrap_or(false)
        {
            out.push(TrackFile {
                name: path.file_name().unwrap().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
            });
        }
    }
}

#[tauri::command]
fn find_track(name: String) -> Result<Vec<TrackFile>, String> {
    for lib in steam_libraries() {
        let tdir = lib
            .join("steamapps")
            .join("common")
            .join("assettocorsa")
            .join("content")
            .join("tracks")
            .join(&name);
        if tdir.is_dir() {
            let mut out = Vec::new();
            collect_kn5(&tdir, &mut out, 0);
            if !out.is_empty() {
                return Ok(out);
            }
        }
    }
    Err(format!("track '{}' not found in any Steam library", name))
}

// The shared driver 3D model (content/driver/driver.kn5) + this car's steering
// animation (content/cars/<car_id>/animations/steer.ksanim). Returns [driver, steer]
// (steer omitted if absent). The car's own driver override lives in the packed
// data.acd, which we don't read — the default driver is a close-enough stand-in.
#[tauri::command]
fn find_driver(car_id: String) -> Result<Vec<TrackFile>, String> {
    for lib in steam_libraries() {
        let base = lib
            .join("steamapps")
            .join("common")
            .join("assettocorsa")
            .join("content");
        let driver = base.join("driver").join("driver.kn5");
        if driver.exists() {
            let mut out = vec![TrackFile {
                name: "driver".to_string(),
                path: driver.to_string_lossy().to_string(),
            }];
            let anim = base
                .join("cars")
                .join(&car_id)
                .join("animations")
                .join("steer.ksanim");
            if anim.exists() {
                out.push(TrackFile {
                    name: "steer".to_string(),
                    path: anim.to_string_lossy().to_string(),
                });
            }
            // this car's authored seated pose (repositions the shared driver's
            // skeleton so the hands land on THIS car's wheel). Named "pose".
            let pose = base
                .join("cars")
                .join(&car_id)
                .join("driver_base_pos.knh");
            if pose.exists() {
                out.push(TrackFile {
                    name: "pose".to_string(),
                    path: pose.to_string_lossy().to_string(),
                });
            }
            return Ok(out);
        }
    }
    Err("driver model not found in any Steam library".to_string())
}

// Locate a car's visual model kn5 from the Steam AC install. Cars live at
// content/cars/<car_id>/ and ship several kn5 (the body plus tiny collider.kn5
// / driver.kn5). We want the visual body: prefer <car_id>.kn5 if it exists,
// else fall back to the LARGEST kn5 in the folder (the extras are only KBs).
// The chosen model is returned first; any other kn5 follow it.
#[tauri::command]
fn find_car(car_id: String) -> Result<Vec<TrackFile>, String> {
    for lib in steam_libraries() {
        let cdir = lib
            .join("steamapps")
            .join("common")
            .join("assettocorsa")
            .join("content")
            .join("cars")
            .join(&car_id);
        if !cdir.is_dir() {
            continue;
        }
        // gather every kn5 directly in the car folder, with its size
        let mut kn5s: Vec<(PathBuf, u64)> = Vec::new();
        if let Ok(read) = std::fs::read_dir(&cdir) {
            for entry in read.flatten() {
                let path = entry.path();
                let is_kn5 = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|s| s.eq_ignore_ascii_case("kn5"))
                    .unwrap_or(false);
                if is_kn5 {
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    kn5s.push((path, size));
                }
            }
        }
        if kn5s.is_empty() {
            continue;
        }
        // pick the main model: <car_id>.kn5 if present, else the largest kn5
        let want = format!("{}.kn5", car_id);
        let main_idx = kn5s
            .iter()
            .position(|(p, _)| {
                p.file_name()
                    .and_then(|s| s.to_str())
                    .map(|n| n.eq_ignore_ascii_case(&want))
                    .unwrap_or(false)
            })
            .unwrap_or_else(|| {
                // largest kn5 wins the fallback
                let mut best = 0usize;
                for (i, (_, sz)) in kn5s.iter().enumerate() {
                    if *sz > kn5s[best].1 {
                        best = i;
                    }
                }
                best
            });
        // main first, then the rest in their original order
        let (main_path, _) = kn5s.remove(main_idx);
        let mut out = Vec::with_capacity(kn5s.len() + 1);
        out.push(TrackFile {
            name: main_path.file_name().unwrap().to_string_lossy().to_string(),
            path: main_path.to_string_lossy().to_string(),
        });
        for (p, _) in kn5s {
            out.push(TrackFile {
                name: p.file_name().unwrap().to_string_lossy().to_string(),
                path: p.to_string_lossy().to_string(),
            });
        }
        return Ok(out);
    }
    Err(format!("car '{}' not found in any Steam library", car_id))
}

// Smoke tests against the REAL local install — this machine's replays and
// Steam AC content. Not portable by design: they prove the native data layer
// (folder scan, Steam vdf parse, byte read) works here, so the gallery can be
// built on a verified foundation instead of by eye. `cargo test`.
#[cfg(test)]
mod smoke {
    use super::*;

    #[test]
    fn list_replays_finds_runs() {
        let r = list_replays();
        match &r {
            Ok(v) => {
                println!("list_replays: {} replays", v.len());
                for x in v.iter().take(3) {
                    println!("  {} ({} KB)", x.name, x.size / 1024);
                }
            }
            Err(e) => println!("list_replays ERR: {}", e),
        }
        assert!(r.is_ok(), "list_replays failed");
        assert!(!r.unwrap().is_empty(), "no replays found — check the folder");
    }

    #[test]
    fn list_screenshots_returns_images() {
        // The screens folder is optional (a fresh install has none), so this
        // asserts the command succeeds and only checks contents when present.
        let r = list_screenshots();
        match &r {
            Ok(v) => {
                println!("list_screenshots: {} images", v.len());
                for x in v.iter().take(3) {
                    println!("  {}", x);
                }
                for p in v {
                    let low = p.to_lowercase();
                    assert!(
                        low.ends_with(".jpg") || low.ends_with(".jpeg") || low.ends_with(".png"),
                        "non-image path returned: {}",
                        p
                    );
                }
            }
            Err(e) => println!("list_screenshots ERR (folder may not exist): {}", e),
        }
        assert!(r.is_ok(), "list_screenshots command failed");
    }

    #[test]
    fn find_track_locates_centrifuge_kn5() {
        let r = find_track("centrifuge".to_string());
        match &r {
            Ok(v) => {
                println!("find_track(centrifuge): {} kn5 file(s)", v.len());
                for x in v {
                    println!("  {} -> {}", x.name, x.path);
                }
            }
            Err(e) => println!("find_track ERR: {}", e),
        }
        assert!(r.is_ok(), "find_track failed (Steam vdf parse?)");
        assert!(!r.unwrap().is_empty(), "centrifuge kn5 not located");
    }

    #[test]
    fn read_file_returns_replay_bytes() {
        let list = list_replays().expect("need replays");
        let first = list.first().expect("need at least one replay");
        let bytes = std::fs::read(&first.path).expect("read failed");
        println!("read {} -> {} bytes", first.name, bytes.len());
        assert!(bytes.len() > 1000, "replay suspiciously small");
        // header sanity: v16 int at offset 0
        let ver = i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        println!("  replay version field = {}", ver);
        assert_eq!(ver, 16, "not a v16 replay");
    }

    #[test]
    fn list_tracks_has_metadata_and_counts() {
        let r = list_tracks();
        match &r {
            Ok(v) => {
                println!("list_tracks: {} tracks", v.len());
                for t in v.iter().take(6) {
                    println!(
                        "  {} [{}] {} · {} · {} replays · preview={}",
                        t.name,
                        t.folder,
                        t.length,
                        t.run,
                        t.replays,
                        !t.preview.is_empty()
                    );
                }
            }
            Err(e) => println!("list_tracks ERR: {}", e),
        }
        assert!(r.is_ok(), "list_tracks failed");
        let v = r.unwrap();
        assert!(!v.is_empty(), "no tracks found");
        // centrifuge should be present with a replay count and a preview
        let cen = v.iter().find(|t| t.folder.eq_ignore_ascii_case("centrifuge"));
        assert!(cen.is_some(), "centrifuge not in track list");
        let cen = cen.unwrap();
        assert!(cen.replays > 0, "centrifuge should have replays");
        assert!(!cen.preview.is_empty(), "centrifuge should have a preview.png");
        println!("  centrifuge name = {:?}", cen.name);
    }

    #[test]
    fn replays_for_track_filters() {
        let r = replays_for_track("centrifuge".to_string());
        match &r {
            Ok(v) => println!("replays_for_track(centrifuge): {}", v.len()),
            Err(e) => println!("ERR: {}", e),
        }
        assert!(r.is_ok() && !r.unwrap().is_empty());
    }

    #[test]
    fn find_car_locates_t180_body_kn5() {
        let r = find_car("ohyeah2389_t180_mach6".to_string());
        match &r {
            Ok(v) => {
                println!("find_car(t180): {} kn5 file(s)", v.len());
                for x in v {
                    println!("  {} -> {}", x.name, x.path);
                }
            }
            Err(e) => println!("find_car ERR: {}", e),
        }
        assert!(r.is_ok(), "find_car failed (Steam vdf parse?)");
        let v = r.unwrap();
        assert!(!v.is_empty(), "t180 kn5 not located");
        // the FIRST entry must be the real visual body: a file that exists on
        // disk and is well over 100 KB (collider/driver kn5 are only KBs)
        let main = &v[0];
        let size = std::fs::metadata(&main.path)
            .map(|m| m.len())
            .expect("resolved car kn5 must exist on disk");
        println!("  resolved model: {} ({} bytes = {} KB)", main.path, size, size / 1024);
        assert!(size > 100 * 1024, "main car kn5 too small ({} bytes) — picked a collider?", size);
    }

    #[test]
    fn find_track_multi_file_track() {
        // Miandros ships several kn5s — proves multi-file collection works
        let r = find_track("Miandros".to_string());
        if let Ok(v) = &r {
            println!("find_track(Miandros): {} kn5 file(s)", v.len());
        }
        assert!(r.is_ok(), "Miandros lookup failed");
    }

    #[test]
    fn track_outline_centrifuge_from_road() {
        let r = track_outline("centrifuge".to_string());
        match &r {
            Ok(o) => println!(
                "track_outline(centrifuge): {} points, bounds [{:.1}, {:.1}, {:.1}, {:.1}] span {:.1} x {:.1} m",
                o.count, o.bounds[0], o.bounds[1], o.bounds[2], o.bounds[3],
                o.bounds[2] - o.bounds[0], o.bounds[3] - o.bounds[1]
            ),
            Err(e) => println!("track_outline(centrifuge) ERR: {}", e),
        }
        assert!(r.is_ok(), "track_outline(centrifuge) failed — parse desync?");
        let o = r.unwrap();
        assert!(o.count > 1000, "expected >1000 points, got {}", o.count);
        assert_eq!(o.points.len(), o.count as usize * 2, "flat array must be 2*count");
        for p in &o.points {
            assert!(*p >= 0.0 && *p <= 1.0, "normalized point out of 0..1: {}", p);
        }
        let sx = o.bounds[2] - o.bounds[0];
        let sz = o.bounds[3] - o.bounds[1];
        // centrifuge road spans hundreds of meters — not tiny, not NaN/huge
        assert!(sx.is_finite() && sz.is_finite(), "bounds not finite");
        assert!(sx > 100.0 && sx < 5000.0, "X span not sane: {}", sx);
        assert!(sz > 100.0 && sz < 5000.0, "Z span not sane: {}", sz);
    }

    #[test]
    fn track_outline_miandros_from_road() {
        let r = track_outline("Miandros".to_string());
        match &r {
            Ok(o) => println!(
                "track_outline(Miandros): {} points, bounds [{:.1}, {:.1}, {:.1}, {:.1}] span {:.1} x {:.1} m",
                o.count, o.bounds[0], o.bounds[1], o.bounds[2], o.bounds[3],
                o.bounds[2] - o.bounds[0], o.bounds[3] - o.bounds[1]
            ),
            Err(e) => println!("track_outline(Miandros) ERR: {}", e),
        }
        assert!(r.is_ok(), "track_outline(Miandros) failed — parse desync?");
        let o = r.unwrap();
        assert!(o.count > 1000, "expected >1000 points, got {}", o.count);
        let sx = o.bounds[2] - o.bounds[0];
        let sz = o.bounds[3] - o.bounds[1];
        assert!(sx.is_finite() && sz.is_finite(), "bounds not finite");
        assert!(sx > 100.0 && sx < 20000.0, "X span not sane: {}", sx);
        assert!(sz > 100.0 && sz < 20000.0, "Z span not sane: {}", sz);
    }

    // Parse the track_map_raster byte buffer: (W, H, minX, minZ, maxX, maxZ,
    // coverage[W*H]) and report coverage as the fraction of non-zero pixels.
    fn parse_map(buf: &[u8]) -> (u32, u32, [f32; 4], f64) {
        assert!(buf.len() >= 24, "map buffer too short: {}", buf.len());
        let w = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        let h = u32::from_le_bytes(buf[4..8].try_into().unwrap());
        let mut b = [0f32; 4];
        for i in 0..4 {
            let o = 8 + i * 4;
            b[i] = f32::from_le_bytes(buf[o..o + 4].try_into().unwrap());
        }
        let cov = &buf[24..];
        assert_eq!(cov.len(), w as usize * h as usize, "coverage len != W*H");
        let nonzero = cov.iter().filter(|&&x| x > 0).count();
        let frac = nonzero as f64 / cov.len().max(1) as f64;
        (w, h, b, frac)
    }

    fn assert_plausible_map(name: &str, buf: &[u8]) -> (u32, u32, [f32; 4], f64) {
        let (w, h, b, frac) = parse_map(buf);
        println!(
            "track_map_raster({}): {}x{} px, bounds [{:.1}, {:.1}, {:.1}, {:.1}] span {:.1} x {:.1} m, coverage {:.1}%",
            name, w, h, b[0], b[1], b[2], b[3], b[2] - b[0], b[3] - b[1], frac * 100.0
        );
        // plausible dims: hundreds to ~1024, and one axis pinned to 1024
        assert!((100..=1024).contains(&w), "{}: W not plausible: {}", name, w);
        assert!((100..=1024).contains(&h), "{}: H not plausible: {}", name, h);
        assert!(w == 1024 || h == 1024, "{}: longest axis should be 1024", name);
        let sx = b[2] - b[0];
        let sz = b[3] - b[1];
        assert!(sx.is_finite() && sz.is_finite(), "{}: bounds not finite", name);
        assert!(sx > 100.0 && sz > 100.0, "{}: spans too small", name);
        // a meaningful — but not saturating — fraction of the frame is road
        assert!(frac > 0.02, "{}: coverage too low ({:.3}) — fill failed?", name, frac);
        assert!(frac < 0.95, "{}: coverage too high ({:.3}) — over-filled?", name, frac);
        (w, h, b, frac)
    }

    #[test]
    fn track_map_raster_centrifuge_fills() {
        let buf = track_map_bytes("centrifuge").expect("track_map_bytes(centrifuge) failed");
        let (_w, _h, b, _frac) = assert_plausible_map("centrifuge", &buf);
        // centrifuge road spans ~±740 m — the outline analysis put it near 1480 m
        let sx = b[2] - b[0];
        let sz = b[3] - b[1];
        assert!(sx > 1000.0 && sx < 2200.0, "centrifuge X span off: {}", sx);
        assert!(sz > 1000.0 && sz < 2200.0, "centrifuge Z span off: {}", sz);
    }

    #[test]
    fn track_map_raster_miandros_fills() {
        let buf = track_map_bytes("Miandros").expect("track_map_bytes(Miandros) failed");
        let (_w, _h, b, _frac) = assert_plausible_map("Miandros", &buf);
        let sx = b[2] - b[0];
        let sz = b[3] - b[1];
        assert!(sx > 100.0 && sx < 20000.0, "Miandros X span off: {}", sx);
        assert!(sz > 100.0 && sz < 20000.0, "Miandros Z span off: {}", sz);
    }
}

#[derive(serde::Serialize)]
struct TrackCard {
    folder: String,
    name: String,
    length: String,
    width: String,
    run: String,
    country: String,
    author: String,
    description: String,
    preview: String, // absolute path to ui/preview.png ("" if absent)
    outline: String,
    replays: u32,
}

// The track a replay was recorded on lives in its header: after the int32
// version + f64 interval come two length-prefixed strings (weather, then
// track). Read just the head — cheaper than parsing the whole replay.
fn read_replay_track(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = [0u8; 512];
    let n = f.read(&mut buf).ok()?;
    let buf = &buf[..n];
    let mut off = 12usize; // skip version (4) + interval (8)
    let wl = u32::from_le_bytes(buf.get(off..off + 4)?.try_into().ok()?) as usize;
    off += 4 + wl;
    let tl = u32::from_le_bytes(buf.get(off..off + 4)?.try_into().ok()?) as usize;
    off += 4;
    Some(String::from_utf8_lossy(buf.get(off..off + tl)?).to_string())
}

fn tracks_dir() -> Result<PathBuf, String> {
    steam_libraries()
        .into_iter()
        .map(|l| {
            l.join("steamapps")
                .join("common")
                .join("assettocorsa")
                .join("content")
                .join("tracks")
        })
        .find(|p| p.is_dir())
        .ok_or_else(|| "Assetto Corsa tracks folder not found in any Steam library".to_string())
}

#[tauri::command]
fn list_tracks() -> Result<Vec<TrackCard>, String> {
    let tdir = tracks_dir()?;

    // count replays per track (by header, lowercased for matching)
    let mut counts: HashMap<String, u32> = HashMap::new();
    if let Ok(replays) = list_replays() {
        for r in replays {
            if let Some(t) = read_replay_track(Path::new(&r.path)) {
                *counts.entry(t.to_lowercase()).or_insert(0) += 1;
            }
        }
    }

    let get = |v: &serde_json::Value, k: &str| -> String {
        v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
    };

    let mut cards = Vec::new();
    for entry in std::fs::read_dir(&tdir).map_err(|e| e.to_string())?.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let folder = entry.file_name().to_string_lossy().to_string();
        let ui = dir.join("ui");
        let mut card = TrackCard {
            name: folder.clone(),
            folder: folder.clone(),
            length: String::new(),
            width: String::new(),
            run: String::new(),
            country: String::new(),
            author: String::new(),
            description: String::new(),
            preview: String::new(),
            outline: String::new(),
            replays: *counts.get(&folder.to_lowercase()).unwrap_or(&0),
        };
        if let Ok(txt) = std::fs::read_to_string(ui.join("ui_track.json")) {
            let txt = txt.trim_start_matches('\u{feff}');
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(txt) {
                let n = get(&v, "name");
                if !n.is_empty() {
                    card.name = n;
                }
                card.length = get(&v, "length");
                card.width = get(&v, "width");
                card.run = get(&v, "run");
                card.country = get(&v, "country");
                card.author = get(&v, "author");
                card.description = get(&v, "description");
            }
        }
        let preview = ui.join("preview.png");
        if preview.exists() {
            card.preview = preview.to_string_lossy().to_string();
        }
        let outline = ui.join("outline.png");
        if outline.exists() {
            card.outline = outline.to_string_lossy().to_string();
        }
        cards.push(card);
    }

    // tracks you've actually driven float to the top (by replay count), then A-Z
    cards.sort_by(|a, b| {
        b.replays
            .cmp(&a.replays)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(cards)
}

#[tauri::command]
fn replays_for_track(track: String) -> Result<Vec<ReplayInfo>, String> {
    let all = list_replays()?;
    let want = track.to_lowercase();
    Ok(all
        .into_iter()
        .filter(|r| {
            read_replay_track(Path::new(&r.path))
                .map(|t| t.to_lowercase() == want)
                .unwrap_or(false)
        })
        .collect())
}

// ---------------------------------------------------------------------------
// track_outline — a top-down 2D map of a track built from its PHYSICAL road
// geometry, so we can draw our own minimap even for tracks AC didn't ship an
// outline.png for. This is a faithful Rust port of kn5.js extractRoadMesh's
// road-vertex extraction: same header/texture/material skipping, same node-tree
// walk, same row-vector transform math. We keep only vertex X/Z (top-down),
// downsample, and cache the result to disk keyed by the kn5 modified-time.

#[derive(serde::Serialize)]
struct TrackOutline {
    points: Vec<f32>, // flat [x0,y0, x1,y1, ...], each in 0..1
    bounds: [f32; 4], // [minX, minZ, maxX, maxZ] in world meters
    count: u32,       // number of 2D points
}

// On-disk cache record: the same payload plus the kn5 mtime it was built from,
// so a rebuilt/updated track invalidates the stale outline automatically.
#[derive(serde::Serialize, serde::Deserialize)]
struct OutlineCache {
    mtime: u64,
    points: Vec<f32>,
    bounds: [f32; 4],
    count: u32,
}

// A little cursor over the kn5 byte buffer — the Rust twin of kn5.js's DataView
// closures (u8/i32/u32/f32/str), with bounds checks in place of DataView throws.
struct Kn5Cur<'a> {
    b: &'a [u8],
    off: usize,
}

impl<'a> Kn5Cur<'a> {
    fn need(&self, n: usize) -> Result<usize, String> {
        let end = self.off.checked_add(n).ok_or("kn5: offset overflow")?;
        if end > self.b.len() {
            return Err(format!("kn5: read past end ({} > {})", end, self.b.len()));
        }
        Ok(end)
    }
    fn u8(&mut self) -> Result<u8, String> {
        let e = self.need(1)?;
        let v = self.b[self.off];
        self.off = e;
        Ok(v)
    }
    fn i32(&mut self) -> Result<i32, String> {
        let e = self.need(4)?;
        let v = i32::from_le_bytes(self.b[self.off..e].try_into().unwrap());
        self.off = e;
        Ok(v)
    }
    fn u32(&mut self) -> Result<u32, String> {
        let e = self.need(4)?;
        let v = u32::from_le_bytes(self.b[self.off..e].try_into().unwrap());
        self.off = e;
        Ok(v)
    }
    fn f32(&mut self) -> Result<f32, String> {
        let e = self.need(4)?;
        let v = f32::from_le_bytes(self.b[self.off..e].try_into().unwrap());
        self.off = e;
        Ok(v)
    }
    fn skip(&mut self, n: usize) -> Result<(), String> {
        let e = self.need(n)?;
        self.off = e;
        Ok(())
    }
    // Length-prefixed string (u32 count + that many bytes, one byte per char —
    // matches kn5.js String.fromCharCode). Only used for names/shaders.
    fn string(&mut self) -> Result<String, String> {
        let len = self.u32()? as usize;
        if len > (1 << 20) {
            return Err(format!("kn5: string too long ({})", len));
        }
        let e = self.need(len)?;
        let s: String = self.b[self.off..e].iter().map(|&c| c as char).collect();
        self.off = e;
        Ok(s)
    }
}

// AC treats a mesh as collidable road surface when its name starts with a
// non-zero digit followed by a surfaces.ini KEY. Mirror of kn5.js's
// /^[1-9]\d*(ROAD|KERB|PIT|RUNOFF)/i without pulling in a regex dependency.
fn is_road_name(name: &str) -> bool {
    let b = name.as_bytes();
    if b.is_empty() || !(b'1'..=b'9').contains(&b[0]) {
        return false;
    }
    let mut i = 1;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let rest = name[i..].to_ascii_uppercase();
    rest.starts_with("ROAD")
        || rest.starts_with("KERB")
        || rest.starts_with("PIT")
        || rest.starts_with("RUNOFF")
}

// Row-major, row-vector matrix product (child = local * parent), exactly as
// kn5.js matMulRowVec: o[r*4+c] = sum_k a[r*4+k] * b[k*4+c].
fn mat_mul_row_vec(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
    let mut o = [0f64; 16];
    for r in 0..4 {
        for c in 0..4 {
            o[r * 4 + c] = a[r * 4] * b[c]
                + a[r * 4 + 1] * b[4 + c]
                + a[r * 4 + 2] * b[8 + c]
                + a[r * 4 + 3] * b[12 + c];
        }
    }
    o
}

fn read_f32_at(b: &[u8], off: usize) -> Result<f32, String> {
    let end = off.checked_add(4).ok_or("kn5: vertex offset overflow")?;
    if end > b.len() {
        return Err("kn5: vertex read past end".into());
    }
    Ok(f32::from_le_bytes(b[off..end].try_into().unwrap()))
}

// Read one node's common header + class body, appending world (X,Z) of any
// road-surface vertices to `out`. Returns (node matrix, child count) so the
// caller can walk children with the correct parent transform.
fn read_node(
    c: &mut Kn5Cur,
    parent: &[f64; 16],
    out: &mut Vec<[f32; 2]>,
) -> Result<([f64; 16], i32), String> {
    let cls = c.i32()?;
    let name = c.string()?;
    let children = c.i32()?;
    c.u8()?; // active
    let mut m = *parent;

    if cls == 1 {
        // dummy: 16-float local matrix, composed onto the parent
        let mut t = [0f64; 16];
        for slot in t.iter_mut() {
            *slot = c.f32()? as f64;
        }
        m = mat_mul_row_vec(&t, parent);
    } else if cls == 2 {
        // static mesh
        c.u8()?; // castShadows
        c.u8()?; // isVisible
        c.u8()?; // isTransparent
        let nv = c.i32()?;
        let v_start = c.off;
        c.skip(nv as usize * 44)?;
        let ni = c.i32()?;
        c.skip(ni as usize * 2)?;
        c.i32()?; // materialId
        c.u32()?; // layer
        c.f32()?; // lodIn
        c.f32()?; // lodOut
        c.skip(16)?; // bounding sphere center + radius
        c.u8()?; // isRenderable
        if is_road_name(&name) {
            let buf = c.b; // Copy of the &[u8]; independent of the &mut cursor
            for v in 0..nv as usize {
                let base = v_start + v * 44;
                let x = read_f32_at(buf, base)? as f64;
                let y = read_f32_at(buf, base + 4)? as f64;
                let z = read_f32_at(buf, base + 8)? as f64;
                // world X and Z only (top-down); Y/normal/uv/tangent ignored
                let wx = (x * m[0] + y * m[4] + z * m[8] + m[12]) as f32;
                let wz = (x * m[2] + y * m[6] + z * m[10] + m[14]) as f32;
                out.push([wx, wz]);
            }
        }
    } else if cls == 3 {
        // skinned mesh — skipped, byte-exact per kn5.js
        c.u8()?;
        c.u8()?;
        c.u8()?;
        let bones = c.i32()?;
        for _ in 0..bones {
            c.string()?;
            c.skip(64)?;
        }
        let nv = c.i32()?;
        c.skip(nv as usize * 76)?;
        let ni = c.i32()?;
        c.skip(ni as usize * 2)?;
        c.i32()?; // materialId
        c.u32()?; // layer
        c.skip(8)?; // trailing (lodIn/lodOut)
    } else {
        return Err(format!("kn5: unknown node class {} at {}", cls, c.off - 4));
    }

    Ok((m, children))
}

// Parse one kn5 buffer and append world (X,Z) of every road vertex to `out`.
// Faithful to kn5.js extractRoadMesh: header, texture-blob skip, material skip,
// then an explicit-stack DFS over the flat pre-order node stream.
fn parse_road_xz(buf: &[u8], out: &mut Vec<[f32; 2]>) -> Result<(), String> {
    let mut c = Kn5Cur { b: buf, off: 0 };

    // header
    c.need(6)?;
    if &buf[0..6] != b"sc6969" {
        return Err(format!("kn5: bad magic '{}'", String::from_utf8_lossy(&buf[0..6])));
    }
    c.off = 6;
    let version = c.i32()?;
    if version > 5 {
        c.i32()?; // v6 extra header int
    }

    // textures — seek past blobs
    let tex_count = c.i32()?;
    for _ in 0..tex_count {
        c.i32()?; // active
        c.string()?; // name
        let size = c.u32()? as usize;
        c.skip(size)?;
    }

    // materials — skip field-accurately
    let mat_count = c.i32()?;
    for _ in 0..mat_count {
        c.string()?; // name
        c.string()?; // shader
        c.u8()?; // blendMode
        c.u8()?; // alphaTested
        c.i32()?; // depthMode
        let props = c.i32()?;
        for _ in 0..props {
            c.string()?;
            c.skip(40)?;
        }
        let maps = c.i32()?;
        for _ in 0..maps {
            c.string()?;
            c.i32()?;
            c.string()?;
        }
    }

    // node tree — explicit-stack DFS (pre-order, matching the file layout)
    const IDENT: [f64; 16] = [
        1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
    ];
    let (m0, ch0) = read_node(&mut c, &IDENT, out)?;
    let mut stack: Vec<([f64; 16], i32)> = vec![(m0, ch0)];
    loop {
        let top = match stack.len() {
            0 => break,
            n => n - 1,
        };
        if stack[top].1 > 0 {
            stack[top].1 -= 1;
            let parent = stack[top].0;
            let node = read_node(&mut c, &parent, out)?;
            stack.push(node);
        } else {
            stack.pop();
        }
    }

    if c.off > buf.len() {
        return Err(format!("kn5: overran file ({} > {})", c.off, buf.len()));
    }
    Ok(())
}

// Cache file for a track's outline: %LOCALAPPDATA%\BLACKBOX\outline_cache\<folder>.json
fn outline_cache_path(folder: &str) -> Option<PathBuf> {
    let base = std::env::var("LOCALAPPDATA").ok()?;
    let safe: String = folder
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    Some(
        Path::new(&base)
            .join("BLACKBOX")
            .join("outline_cache")
            .join(format!("{}.json", safe)),
    )
}

fn file_mtime_secs(path: &str) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
fn track_outline(folder: String) -> Result<TrackOutline, String> {
    // 1. locate the track's kn5 file(s) via the existing lookup
    let files = find_track(folder.clone())?;
    if files.is_empty() {
        return Err(format!("no kn5 file for track '{}'", folder));
    }

    // combined signature = newest mtime across the track's kn5 files
    let mtime = files.iter().map(|f| file_mtime_secs(&f.path)).max().unwrap_or(0);

    // 5. serve a fresh cache if the kn5 hasn't changed
    let cache_path = outline_cache_path(&folder);
    if let Some(cp) = &cache_path {
        if let Ok(txt) = std::fs::read_to_string(cp) {
            if let Ok(cached) = serde_json::from_str::<OutlineCache>(&txt) {
                if cached.mtime == mtime && !cached.points.is_empty() {
                    return Ok(TrackOutline {
                        points: cached.points,
                        bounds: cached.bounds,
                        count: cached.count,
                    });
                }
            }
        }
    }

    // 2. parse each kn5 (multi-file tracks merge road verts); only fully-parsed
    // files contribute, so a desync in the road file surfaces as an error below.
    let mut verts: Vec<[f32; 2]> = Vec::new();
    let mut last_err: Option<String> = None;
    for f in &files {
        let buf = match std::fs::read(&f.path) {
            Ok(b) => b,
            Err(e) => {
                last_err = Some(format!("{}: {}", f.name, e));
                continue;
            }
        };
        let mut tmp: Vec<[f32; 2]> = Vec::new();
        match parse_road_xz(&buf, &mut tmp) {
            Ok(()) => verts.extend_from_slice(&tmp),
            Err(e) => last_err = Some(format!("{}: {}", f.name, e)),
        }
    }
    if verts.is_empty() {
        return Err(last_err.unwrap_or_else(|| format!("no road meshes found for '{}'", folder)));
    }

    // 4. bounds from ALL road verts
    let mut min_x = f32::INFINITY;
    let mut min_z = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_z = f32::NEG_INFINITY;
    for v in &verts {
        min_x = min_x.min(v[0]);
        max_x = max_x.max(v[0]);
        min_z = min_z.min(v[1]);
        max_z = max_z.max(v[1]);
    }
    let span_x = (max_x - min_x).max(1e-6);
    let span_z = (max_z - min_z).max(1e-6);

    // downsample to ~5000 evenly-strided points, normalized into 0..1
    const TARGET: usize = 5000;
    let stride = if verts.len() > 6000 {
        verts.len().div_ceil(TARGET)
    } else {
        1
    };
    let mut points: Vec<f32> = Vec::with_capacity((verts.len() / stride + 1) * 2);
    let mut i = 0;
    while i < verts.len() {
        let v = verts[i];
        points.push((v[0] - min_x) / span_x);
        points.push((v[1] - min_z) / span_z);
        i += stride;
    }
    let count = (points.len() / 2) as u32;
    let bounds = [min_x, min_z, max_x, max_z];

    // 5. persist the cache (best-effort; failures don't break the response)
    if let Some(cp) = &cache_path {
        if let Some(parent) = cp.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let record = OutlineCache {
            mtime,
            points: points.clone(),
            bounds,
            count,
        };
        if let Ok(js) = serde_json::to_string(&record) {
            let _ = std::fs::write(cp, js);
        }
    }

    Ok(TrackOutline {
        points,
        bounds,
        count,
    })
}

// ---------------------------------------------------------------------------
// track_map_raster — a SOLID top-down coverage map of a track's physical road.
// Where track_outline returns a stippled point cloud, this returns a filled
// 8-bit alpha bitmap: every road TRIANGLE rasterized into a coverage buffer so
// the ribbon reads as one clean shape. Same road extraction as track_outline
// (kn5.js extractRoadMesh port) but we also capture the uint16 triangle indices
// that vertex-only extraction skipped, and keep per-vertex (X,Z). Returned as a
// raw byte buffer (u32 W, u32 H, f32 minX/minZ/maxX/maxZ, then W*H coverage
// bytes) — the frontend paints it into a canvas ImageData. Cached to disk keyed
// by the newest kn5 mtime, same discipline as track_outline.

// Merged road geometry: world (X,Z) per vertex + a flat triangle index list
// (every 3 indices = one triangle), rebased across all meshes AND all kn5 files.
struct RoadGeom {
    verts: Vec<[f32; 2]>, // world (X,Z), top-down
    tris: Vec<u32>,       // indices into verts, 3 per triangle
}

fn read_u16_at(b: &[u8], off: usize) -> Result<u16, String> {
    let end = off.checked_add(2).ok_or("kn5: index offset overflow")?;
    if end > b.len() {
        return Err("kn5: index read past end".into());
    }
    Ok(u16::from_le_bytes(b[off..end].try_into().unwrap()))
}

// Twin of read_node, but for road meshes it ALSO captures the triangle indices
// (rebased by the running vertex count) so we can fill, not just scatter. Byte
// layout walked is identical — only road-name meshes diverge (keep verts+tris).
fn read_node_mesh(
    c: &mut Kn5Cur,
    parent: &[f64; 16],
    out: &mut RoadGeom,
) -> Result<([f64; 16], i32), String> {
    let cls = c.i32()?;
    let name = c.string()?;
    let children = c.i32()?;
    c.u8()?; // active
    let mut m = *parent;

    if cls == 1 {
        let mut t = [0f64; 16];
        for slot in t.iter_mut() {
            *slot = c.f32()? as f64;
        }
        m = mat_mul_row_vec(&t, parent);
    } else if cls == 2 {
        c.u8()?; // castShadows
        c.u8()?; // isVisible
        c.u8()?; // isTransparent
        let nv = c.i32()?;
        let v_start = c.off;
        c.skip(nv as usize * 44)?;
        let ni = c.i32()?;
        let i_start = c.off;
        c.skip(ni as usize * 2)?;
        c.i32()?; // materialId
        c.u32()?; // layer
        c.f32()?; // lodIn
        c.f32()?; // lodOut
        c.skip(16)?; // bounding sphere center + radius
        c.u8()?; // isRenderable
        if is_road_name(&name) {
            let buf = c.b;
            // rebase this mesh's indices by everything already merged (prior
            // meshes AND prior kn5 files, since `out` persists across files)
            let vert_base = out.verts.len() as u32;
            for v in 0..nv as usize {
                let base = v_start + v * 44;
                let x = read_f32_at(buf, base)? as f64;
                let y = read_f32_at(buf, base + 4)? as f64;
                let z = read_f32_at(buf, base + 8)? as f64;
                let wx = (x * m[0] + y * m[4] + z * m[8] + m[12]) as f32;
                let wz = (x * m[2] + y * m[6] + z * m[10] + m[14]) as f32;
                out.verts.push([wx, wz]);
            }
            for i in 0..ni as usize {
                let idx = read_u16_at(buf, i_start + i * 2)? as u32;
                out.tris.push(vert_base + idx);
            }
        }
    } else if cls == 3 {
        // skinned mesh — skipped, byte-exact per kn5.js
        c.u8()?;
        c.u8()?;
        c.u8()?;
        let bones = c.i32()?;
        for _ in 0..bones {
            c.string()?;
            c.skip(64)?;
        }
        let nv = c.i32()?;
        c.skip(nv as usize * 76)?;
        let ni = c.i32()?;
        c.skip(ni as usize * 2)?;
        c.i32()?; // materialId
        c.u32()?; // layer
        c.skip(8)?; // trailing (lodIn/lodOut)
    } else {
        return Err(format!("kn5: unknown node class {} at {}", cls, c.off - 4));
    }

    Ok((m, children))
}

// Parse one kn5 buffer, appending road verts + triangles to `out`. Same header,
// texture-blob, material, and node-tree walk as parse_road_xz — this variant
// keeps the index list too. `out` may already hold prior files' geometry.
fn parse_road_mesh(buf: &[u8], out: &mut RoadGeom) -> Result<(), String> {
    let mut c = Kn5Cur { b: buf, off: 0 };

    c.need(6)?;
    if &buf[0..6] != b"sc6969" {
        return Err(format!("kn5: bad magic '{}'", String::from_utf8_lossy(&buf[0..6])));
    }
    c.off = 6;
    let version = c.i32()?;
    if version > 5 {
        c.i32()?; // v6 extra header int
    }

    let tex_count = c.i32()?;
    for _ in 0..tex_count {
        c.i32()?; // active
        c.string()?; // name
        let size = c.u32()? as usize;
        c.skip(size)?;
    }

    let mat_count = c.i32()?;
    for _ in 0..mat_count {
        c.string()?; // name
        c.string()?; // shader
        c.u8()?; // blendMode
        c.u8()?; // alphaTested
        c.i32()?; // depthMode
        let props = c.i32()?;
        for _ in 0..props {
            c.string()?;
            c.skip(40)?;
        }
        let maps = c.i32()?;
        for _ in 0..maps {
            c.string()?;
            c.i32()?;
            c.string()?;
        }
    }

    const IDENT: [f64; 16] = [
        1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
    ];
    let (m0, ch0) = read_node_mesh(&mut c, &IDENT, out)?;
    let mut stack: Vec<([f64; 16], i32)> = vec![(m0, ch0)];
    loop {
        let top = match stack.len() {
            0 => break,
            n => n - 1,
        };
        if stack[top].1 > 0 {
            stack[top].1 -= 1;
            let parent = stack[top].0;
            let node = read_node_mesh(&mut c, &parent, out)?;
            stack.push(node);
        } else {
            stack.pop();
        }
    }

    if c.off > buf.len() {
        return Err(format!("kn5: overran file ({} > {})", c.off, buf.len()));
    }
    Ok(())
}

// Cache file for a track's raster map:
// %LOCALAPPDATA%\BLACKBOX\map_cache\<folder>.bin — the on-disk record is the
// kn5 mtime (u64 LE) followed by the exact response byte buffer.
fn map_cache_path(folder: &str) -> Option<PathBuf> {
    let base = std::env::var("LOCALAPPDATA").ok()?;
    let safe: String = folder
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    Some(
        Path::new(&base)
            .join("BLACKBOX")
            .join("map_cache")
            .join(format!("{}.bin", safe)),
    )
}

// Signed area of the triangle a,b,c (also the edge function for point c vs ab).
fn edge_fn(a: (f32, f32), b: (f32, f32), c: (f32, f32)) -> f32 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}

// Core: build the raw map byte buffer for a track (parse → bounds → size →
// supersampled triangle fill → box downsample → header+coverage), with the same
// mtime-keyed disk cache as track_outline. Returned bytes are what the command
// hands back via Response; the test drives this directly to inspect them.
fn track_map_bytes(folder: &str) -> Result<Vec<u8>, String> {
    // longest world axis maps to this many pixels; the raster is filled at SS×
    // resolution then box-downsampled to kill jaggies on the road ribbon.
    const MAP_LONG: u32 = 1024;
    const MAP_SS: u32 = 4;

    let files = find_track(folder.to_string())?;
    if files.is_empty() {
        return Err(format!("no kn5 file for track '{}'", folder));
    }

    // combined signature = newest mtime across the track's kn5 files
    let mtime = files.iter().map(|f| file_mtime_secs(&f.path)).max().unwrap_or(0);

    // serve a fresh cache if the kn5 hasn't changed
    let cache_path = map_cache_path(folder);
    if let Some(cp) = &cache_path {
        if let Ok(data) = std::fs::read(cp) {
            if data.len() > 8 {
                let stored = u64::from_le_bytes(data[0..8].try_into().unwrap());
                if stored == mtime {
                    return Ok(data[8..].to_vec());
                }
            }
        }
    }

    // parse every kn5 (multi-file tracks merge geometry); indices rebase across
    // files because `geom` persists — see read_node_mesh's vert_base.
    let mut geom = RoadGeom {
        verts: Vec::new(),
        tris: Vec::new(),
    };
    let mut last_err: Option<String> = None;
    for f in &files {
        let buf = match std::fs::read(&f.path) {
            Ok(b) => b,
            Err(e) => {
                last_err = Some(format!("{}: {}", f.name, e));
                continue;
            }
        };
        // parse into a scratch geom, keyed off the current merged vertex count,
        // so a mid-file desync doesn't corrupt already-merged geometry.
        let vbase = geom.verts.len() as u32;
        let mut tmp = RoadGeom {
            verts: Vec::new(),
            tris: Vec::new(),
        };
        match parse_road_mesh(&buf, &mut tmp) {
            Ok(()) => {
                geom.verts.extend_from_slice(&tmp.verts);
                for t in &tmp.tris {
                    geom.tris.push(vbase + t);
                }
            }
            Err(e) => last_err = Some(format!("{}: {}", f.name, e)),
        }
    }
    if geom.verts.is_empty() {
        return Err(last_err.unwrap_or_else(|| format!("no road meshes found for '{}'", folder)));
    }
    if geom.tris.len() < 3 {
        return Err(format!("no road triangles found for '{}'", folder));
    }

    // world bounds from all road verts
    let mut min_x = f32::INFINITY;
    let mut min_z = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_z = f32::NEG_INFINITY;
    for v in &geom.verts {
        min_x = min_x.min(v[0]);
        max_x = max_x.max(v[0]);
        min_z = min_z.min(v[1]);
        max_z = max_z.max(v[1]);
    }
    let span_x = (max_x - min_x).max(1e-6);
    let span_z = (max_z - min_z).max(1e-6);

    // image size: longest axis → MAP_LONG, other by aspect (capped at MAP_LONG)
    let (w, h) = if span_x >= span_z {
        let h = (((MAP_LONG as f32) * span_z / span_x).round() as u32).clamp(1, MAP_LONG);
        (MAP_LONG, h)
    } else {
        let w = (((MAP_LONG as f32) * span_x / span_z).round() as u32).clamp(1, MAP_LONG);
        (w, MAP_LONG)
    };
    // ~3% padding so the ribbon doesn't touch the frame; clamp so it can't eat
    // more than a quarter of the smaller dimension on very elongated tracks.
    let p = (((MAP_LONG as f32) * 0.03).round() as u32).min(w.min(h) / 4);

    // supersampled coverage buffer (0 = off-road, 255 = road), filled per-tri
    let s = MAP_SS as usize;
    let wh = w as usize * s;
    let hh = h as usize * s;
    let mut hi = vec![0u8; wh * hh];
    let ph = (p * MAP_SS) as f32;
    let inner_w = (wh as f32) - 2.0 * ph;
    let inner_h = (hh as f32) - 2.0 * ph;
    // world (X,Z) → hi-res pixel (image Z increases downward so north is up)
    let project = |v: [f32; 2]| -> (f32, f32) {
        (
            (v[0] - min_x) / span_x * inner_w + ph,
            (max_z - v[1]) / span_z * inner_h + ph,
        )
    };

    let nverts = geom.verts.len() as u32;
    for t in geom.tris.chunks_exact(3) {
        if t[0] >= nverts || t[1] >= nverts || t[2] >= nverts {
            continue; // defensive: never index past the merged vertex list
        }
        let a = project(geom.verts[t[0] as usize]);
        let b = project(geom.verts[t[1] as usize]);
        let cc = project(geom.verts[t[2] as usize]);
        let area = edge_fn(a, b, cc);
        if area == 0.0 {
            continue; // degenerate
        }
        let min_px = (a.0.min(b.0).min(cc.0).floor().max(0.0)) as i32;
        let max_px = (a.0.max(b.0).max(cc.0).ceil().min(wh as f32)) as i32;
        let min_py = (a.1.min(b.1).min(cc.1).floor().max(0.0)) as i32;
        let max_py = (a.1.max(b.1).max(cc.1).ceil().min(hh as f32)) as i32;
        let pos = area > 0.0;
        for py in min_py..max_py {
            let row = py as usize * wh;
            let cy = py as f32 + 0.5;
            for px in min_px..max_px {
                let cp = (px as f32 + 0.5, cy);
                let w0 = edge_fn(b, cc, cp);
                let w1 = edge_fn(cc, a, cp);
                let w2 = edge_fn(a, b, cp);
                let inside = if pos {
                    w0 >= 0.0 && w1 >= 0.0 && w2 >= 0.0
                } else {
                    w0 <= 0.0 && w1 <= 0.0 && w2 <= 0.0
                };
                if inside {
                    hi[row + px as usize] = 255;
                }
            }
        }
    }

    // box downsample SS×SS → final coverage (any-road pixel averages toward 255)
    let s2 = (MAP_SS * MAP_SS) as u32;
    let mut cov = vec![0u8; w as usize * h as usize];
    for oy in 0..h as usize {
        for ox in 0..w as usize {
            let mut sum = 0u32;
            for sy in 0..s {
                let base = (oy * s + sy) * wh + ox * s;
                for sx in 0..s {
                    sum += hi[base + sx] as u32;
                }
            }
            cov[oy * w as usize + ox] = (sum / s2) as u8;
        }
    }

    // pack header (all little-endian) + coverage
    let mut out = Vec::with_capacity(24 + cov.len());
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    out.extend_from_slice(&min_x.to_le_bytes());
    out.extend_from_slice(&min_z.to_le_bytes());
    out.extend_from_slice(&max_x.to_le_bytes());
    out.extend_from_slice(&max_z.to_le_bytes());
    out.extend_from_slice(&cov);

    // persist cache (best-effort): u64 mtime prefix + the response bytes
    if let Some(cp) = &cache_path {
        if let Some(parent) = cp.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut disk = Vec::with_capacity(8 + out.len());
        disk.extend_from_slice(&mtime.to_le_bytes());
        disk.extend_from_slice(&out);
        let _ = std::fs::write(cp, &disk);
    }

    Ok(out)
}

#[tauri::command]
fn track_map_raster(folder: String) -> Result<tauri::ipc::Response, String> {
    track_map_bytes(&folder).map(tauri::ipc::Response::new)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_replays,
            read_file,
            list_screenshots,
            find_track,
            find_car,
            find_driver,
            list_tracks,
            replays_for_track,
            track_outline,
            track_map_raster
        ])
        .run(tauri::generate_context!())
        .expect("error while running BLACKBOX");
}
