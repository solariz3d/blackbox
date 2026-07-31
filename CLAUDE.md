# BLACKBOX — orientation for a fresh session

3D telemetry viewer for Assetto Corsa `.acreplay` v16 files. Tauri v2 shell (Rust) around
a static web frontend. See `README.md` for what it does; this file is the things that will
otherwise cost you an hour.

## The stand-in track

No Assetto Corsa install, or no track for this replay? **stand-in track** builds a surface
from the replay's own wheel data — `ui/trackgen.js` (pure, node-testable) ribbons the driven
corridor, `buildStandInTrack()` in `loaders.js` uploads it through the same `makeGroup` the
kn5 path uses. It is the driven corridor, not the road, and there is no scenery in telemetry
and never will be — so **nothing shadow-related can be reproduced on it**, which rules out a
whole category of use. `samples/TRACK_FROM_REPLAY.md` is the spec plus what the build measured
against it; read the bottom section before trusting any number in the top one.

## Architecture

`ui/` is **classic scripts in shared global scope**, not modules — load order in
`index.html` is `mathutil → glcore → acreplay → kn5 → kn5tex → carrender → audioengine →
roadedge → intro`, then one big inline `<script>` (~3000 lines) that is the app. Files
read each other's globals at call time, so load order only matters for top-level code.

- `acreplay.js` — the binary parser. `extractCar(replay, i)` is indexed: a replay holds
  every car, and `#carsel` already switches between them.
- `glcore.js` — GL context, shader programs (`FST` is the lit-scene fragment shader), and
  the `tLoc` uniform-location table. A new uniform needs three edits: declare it in the
  shader string, add a `tLoc` entry, and upload it in `index.html`.
- `carrender.js` — car body/wheels/driver posing. The per-car functions take the run they
  operate on (`src`) and **return** their results; `carModelMatrix` returns `{mat, steer}`
  rather than assigning a global, so several cars can be drawn per frame.
- `ghosts.js` — multi-replay state, `carId`→model cache, and lap alignment **by distance
  around the lap, not by time**. Done and tested; the render walk that uses it is not.

Each module ends with `module.exports` **and** `window.X`, so it runs under node and in
the browser. Follow that pattern.

## Tests

Standalone node scripts at the repo root, no runner, no package.json:

```
node runtests.js              # everything; exit code IS the verdict
node runtests.js glow lamp    # only tests whose filename contains one of these
```

**Use the runner, not a shell loop.** `for f in test_*.js; do node $f; done` reports the
status of the LAST test, not the worst one — on 2026-07-27 a loop printed a failure, exited 0,
and a commit went out on top of a red test that had been printed to screen and read past.

**All 43 tests currently pass.** The note that used to sit here — `test_kn5.js`,
`test_kn5scene.js`, `test_kn5tex.js`, `test_lateral.js`, `test_roadedge.js`, `test_twolines.js`
and `test_edgecoach.js` are broken with `Cannot find module './kn5.js'`, `test_parse.js` needs
an argument — was true before the module split was cleaned up and is not any more. It is
removed rather than left as history: a standing note that says "expect these to be red" is how
a real failure gets waved through.

**Before you trust a green suite, run `node covgap.js`.** It reports which functions your
change touched that no test reaches — green here means "you didn't break anything else", and
covgap is what says whether it also means anything about what you just wrote. `--ref HEAD~1`
for a commit, `--files ui/x.js` to audit one file, `--strict` to make it exit 1. It prints
what its own answer does and does not claim; read that before acting on it.

Code that lives in `index.html`'s inline script, or in a classic script with no exports,
is still testable: evaluate it in a `vm` sandbox with stub globals (`test_ghostmatrix.js`
and `test_shadowbox.js` both do this). **Trap:** `const` inside a `vm` context is a lexical
binding, *not* a property of the sandbox object — reading one gives `undefined`, and an
assertion written against it will quietly test the old behaviour and pass for the wrong
reason. Parse constants out of the source text instead.

## Building — the thing that wastes the most time

`tauri.conf.json` sets `frontendDist: "../ui"`, so **the UI is embedded into the exe at
build time**. Editing `ui/` changes nothing about a running app, and relaunching the old
exe changes nothing either. What matters is the exe's *build* time, never the process
start time. Rebuild:

```
cargo build --release --manifest-path src-tauri/Cargo.toml
```

Close BLACKBOX first — a running exe cannot be relinked (`Access is denied` at link). If
another agent is mid-build you'll also see `Blocking waiting for file lock on build
directory`; wait and retry rather than killing anything.

Shaders compile on the GPU at load and `shader()` **throws** on failure, so a broken
shader means the app won't start at all. If it launches and renders, the GLSL compiled —
that is the only real verification, and no test can do it for you.

## Working alongside other agents

Several Claude panes may be editing this repo at once (Consonance committee — the
`consonance` MCP tools `read_board`/`post_board` are the shared channel). Before editing a
shared file, check its mtime and post what you're claiming. `ui/index.html` and
`ui/carrender.js` are the usual collision points. Say when you're done so nobody holds
off, and say when a rebuild is safe.

## House style

Comments explain *why*, especially the non-obvious constraint that made the code look the
way it does — see the shadow-cascade and grip-placement comments for the register. Prefer
a stated reason over a restatement of the code. `CHANGELOG.md` gets an entry per
meaningful change, with the symptom that prompted it.
