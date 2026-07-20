# BLACKBOX — the installed-app shell (design, 2026-07-20)

The vision for the packaged `.exe`. The current dev app opens
straight into a flat replay list; the installed app opens into a **track-first**
experience: you pick where you drove, then which run, then fly it.

## First run (setup)

On first launch (or from a settings button), the app asks for two folders and
remembers them:

1. **Replay folder** — default `Documents\Assetto Corsa\replay`, browse to change.
2. **Assetto Corsa install** (the `content\tracks` folder, or the AC root) —
   auto-detected by parsing Steam's `libraryfolders.vdf` (already working in
   `find_track`), with a "browse" override for non-Steam / moved installs.

Both persist to a config file in the app-data dir. No env assumptions baked in —
the paths are data, not code. (Today's dev build hardcodes the Documents path
and Steam auto-detect; the installer must make both configurable up front.)

## The track gallery (home screen)

A grid of **track cards**, built from data AC already ships in each
`content\tracks\<folder>\`:

- **`ui/preview.png`** — the thumbnail photo (card hero image)
- **`ui/ui_track.json`** — `name` ("The Centrifuge"), `length`, `width`, `run`,
  `country`, `author`, `description`
- **`ui/outline.png`** — the track-map outline (secondary graphic / hover)
- **replay count** — cross-reference the replay folder: how many of your runs
  are on this track (the replay filename embeds the track folder name)

Card = thumbnail + pretty name + "36km · 26m · clockwise" + "N replays".
Default view: only tracks you have replays for (with a toggle to show all
installed tracks). Thumbnails load via Tauri's asset protocol (direct file URL,
no IPC copy of a 7.9MB PNG per card).

## Track → replays → fly

- Click a track card → the replay list for **that track only**, newest first,
  each row showing lap time / date once parsed (or lazily on hover).
- Click a replay → the 3D viewer (the current view), track auto-loaded.
- Back navigation returns to the gallery. The viewer's existing modes
  (speed/banking, follow cam, lap-only, ghosts) are unchanged.

## Layouts (later)

Some tracks have multiple layouts (`ui/<layout>/ui_track.json` + preview). The
replay's `trackConfig` field selects the layout. v1 can ignore layouts (use the
root ui/); v2 shows layout as a sub-card or badge.

## Build order

1. **Config + first-run** — `get_config`/`set_config` Rust commands, folder-pick
   dialog (Tauri dialog plugin), a settings panel. Falls back to today's
   auto-detect when unset.
2. **`list_tracks`** — scan tracks dir, parse each `ui_track.json`, resolve
   `preview.png` path, count replays per track. Return the card data.
3. **Asset protocol** for thumbnails (scope: the tracks dir).
4. **Gallery UI** — the card grid, the track→replays drill-in, back nav.
5. **Installer** — `cargo tauri build` → NSIS/MSI, `.acreplay` file association,
   the racing-line icon. Ship it.

## What already exists (dev build, this session)

- Native commands: `list_replays`, `read_file`, `find_track` (Steam vdf parse).
- Auto replay list on the drop screen; a replay's track auto-loads from the AC
  install. This is the plumbing the gallery extends — same commands, richer UI.
