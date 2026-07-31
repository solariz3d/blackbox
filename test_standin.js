/* test_standin.js — wiring the stand-in track into the scene without leaking or stacking.
 *
 * trackgen.js is pure and test_trackgen.js covers the geometry. This covers the half that
 * touches the scene, which is where this repo's track code has actually gone wrong before:
 * resetTrackScene exists because loading track A then track B rendered both at once, and the
 * emissive-mask leak survived until someone counted the deletion sites. A stand-in that a
 * real kn5 does not displace is the same bug with a new source, so it is asserted rather
 * than reasoned about.
 *
 * buildStandInTrack and freeStandInTrack live in loaders.js, which cannot load under node —
 * it needs a GL context and a DOM. They are extracted with uiFunction() and evaluated in a
 * vm against a recording stub, the pattern test_shadowbox.js established.
 *
 * Run: node test_standin.js
 */
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const E = require("./testenv.js");
const { parseReplay, extractCar } = require("./ui/acreplay.js");

let fails = 0;
function ok(cond, msg) { if (!cond) { console.log("  FAIL " + msg); fails++; } }
const decomment = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const src = E.uiSource();
/* The extraction is written as a literal E.uiFunction("name") at every site rather than
 * wrapped in a helper that takes the name. covgap reads `uiFunction("X")` positionally as a
 * SOURCE-REACHING use of X; a helper hides that, and the first version of this file made
 * loadTrackBuffers report MENTION-ONLY — the classification covgap's own header calls "the
 * one that looks like coverage and is not". The tool was right and the test was hiding from
 * it. */
const need = (name, text) => { if (!text) { console.log(`could not extract ${name} from any ui/ source`); process.exit(2); } return text; };

function runFrom(file) {
  const b = fs.readFileSync(file);
  return extractCar(parseReplay(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), 0);
}
const REF = runFrom(E.sampleReplay());
const OTHER = runFrom(E.sampleReplayB());

/* A GL stub that only records. Buffers and textures are counted in and out so a leak is a
 * number, not an impression. */
function makeSandbox() {
  let nextId = 1;
  const live = new Set();
  const gl = {
    ARRAY_BUFFER: 1, ELEMENT_ARRAY_BUFFER: 2, STATIC_DRAW: 3,
    createBuffer() { const b = { id: nextId++, kind: "buf" }; live.add(b); return b; },
    deleteBuffer(b) { if (b) live.delete(b); },
    bindBuffer() {}, bufferData() {},
    createTexture() { const t = { id: nextId++, kind: "tex" }; live.add(t); return t; },
    deleteTexture(t) { if (t) live.delete(t); },
  };
  const calls = { buildGeometry: 0, edgeIndex: 0, collider: 0, teardownTreeSys: 0 };
  const chip = { textContent: "", classList: { remove() { chip.hidden = false; }, add() { chip.hidden = true; } } };
  const fileinfo = { textContent: "start" };
  const sb = {
    Math, Float32Array, Float64Array, Uint8Array, Uint32Array, Int32Array, Array, Object, Number, String, Set, Map, Error, JSON, isFinite, console,
    Promise, ArrayBuffer,
    gl, live, calls,
    performance: { now: () => 0 },
    document: { getElementById: (id) => (id === "fileinfo" ? fileinfo : chip) },
    chipTrack: () => chip,
    TrackGen: require("./ui/trackgen.js"),
    RoadEdge: { buildEdgeIndex: () => { calls.edgeIndex++; return { count: 7 }; } },
    buildWorldCollider: () => { calls.collider++; return { count: 11 }; },
    buildGeometry: () => { calls.buildGeometry++; },
    makeFallbackTexture: () => gl.createTexture(),
    // the real predicate, not a stub — makeGroup asks it what the material is, and a
    // stand-in road that came back as foliage would be handed to the tree suppressor
    isFoliageMaterial: require("./ui/kn5.js").isFoliageMaterial,
    // scene state the real globals hold
    ex: null, compareRuns: [], sceneGroups: null, standInGroup: null,
    sceneAABB: null, trackAABB: null, staticBakeTime: 1234,
    bufs: { trackIdxN: 0 },
    // the rest of what the full teardown reaches, so resetTrackScene can be run here too
    teardownTreeSys: () => { calls.teardownTreeSys++; },
    trackLights: [{ lamp: 1 }], lampsBaked: true, edgeIndex: null, worldColl: null, smokeColl: null,
    carGroups: null, carGlass: null, carLights: null, carNozzle: null,
    carWheels: null, carSteerWheel: null, carDriver: null,
    _chip: chip, _fileinfo: fileinfo,
  };
  vm.createContext(sb);
  vm.runInContext(need("makeGroup", E.uiFunction("makeGroup")), sb, { filename: "makeGroup" });
  vm.runInContext(need("freeStandInTrack", E.uiFunction("freeStandInTrack")), sb, { filename: "freeStandInTrack" });
  vm.runInContext(need("buildStandInTrack", E.uiFunction("buildStandInTrack")), sb, { filename: "buildStandInTrack" });
  vm.runInContext(need("resetTrackScene", E.uiFunction("resetTrackScene")), sb, { filename: "resetTrackScene" });
  // `const` in a vm context is a lexical binding, not a sandbox property — read the literal
  // out of the shipped source so this can never run with the widen silently undefined
  const m = /const STANDIN_WIDEN_M\s*=\s*([\d.]+)/.exec(src);
  if (!m) { console.log("STANDIN_WIDEN_M not found in any ui/ source"); process.exit(2); }
  sb.STANDIN_WIDEN_M = Number(m[1]);
  sb.STANDIN_RGB = [96, 98, 104];
  return sb;
}

(async () => {

/* ---- 1. it refuses rather than half-building when there is nothing to build from ---- */
{
  const sb = makeSandbox();
  await sb.buildStandInTrack();
  ok(sb.sceneGroups === null, "no replay open: nothing is added to the scene");
  ok(/open a replay first/.test(sb._chip.textContent), "and the chip says why");
  ok(sb.live.size === 0, "and no GL resource was allocated");
}

/* ---- 2. a build populates everything the renderer reads ---- */
{
  const sb = makeSandbox();
  sb.ex = REF;
  await sb.buildStandInTrack();
  ok(Array.isArray(sb.sceneGroups) && sb.sceneGroups.length === 1, `one group is in the scene (got ${sb.sceneGroups && sb.sceneGroups.length})`);
  ok(sb.sceneGroups[0] === sb.standInGroup, "and it is the stand-in, tracked for later teardown");
  ok(sb.sceneGroups[0].tris > 1000, `carrying the corridor's triangles (${sb.sceneGroups[0].tris})`);
  ok(sb.sceneGroups[0].translucent === false, "opaque, so it enters the shadow and depth passes");
  ok(sb.sceneGroups[0].foliage === false, "and not foliage, so the tree passes leave it alone");
  ok(sb.sceneAABB && isFinite(sb.sceneAABB.x0), "sceneAABB is set — the shadow reach needs it");
  ok(sb.trackAABB && sb.trackAABB.radius > 0, "trackAABB is set — the static bake is sized from it");
  ok(sb.staticBakeTime === null, "and the previous world's bake is invalidated");
  ok(sb.calls.edgeIndex === 1 && sb.calls.collider === 2, `the edge index and both colliders are built (${sb.calls.edgeIndex}, ${sb.calls.collider})`);
  ok(sb.calls.buildGeometry === 1, "and the line ribbon is rebuilt now that there is a surface");
  ok(/STAND-IN TRACK/.test(sb._chip.textContent) && /not the road/.test(sb._chip.textContent),
     "the chip says what this is and what it is not");
}

/* ---- 3. THE LEAK: building twice replaces, and frees what it replaced ---- */
{
  const sb = makeSandbox();
  sb.ex = REF;
  await sb.buildStandInTrack();
  const first = sb.standInGroup, afterOne = sb.live.size;
  await sb.buildStandInTrack();
  ok(sb.sceneGroups.length === 1, `a second build leaves one group, not two (got ${sb.sceneGroups.length})`);
  ok(sb.standInGroup !== first, "and it is a new one");
  ok(sb.live.size === afterOne, `with no GL resources leaked (${afterOne} → ${sb.live.size})`);
  ok(!sb.live.has(first.posBuf) && !sb.live.has(first.tex), "the replaced group's buffers and texture are gone");
}

/* ---- 4. a real track outranks it, both ways round ---- */
{
  const sb = makeSandbox();
  sb.ex = REF;
  sb.sceneGroups = [{ real: true }];          // a kn5 is already loaded
  await sb.buildStandInTrack();
  ok(sb.sceneGroups.length === 1 && sb.sceneGroups[0].real, "with a real track loaded the stand-in refuses");
  ok(sb.standInGroup === null, "and builds nothing");
  ok(/real track is loaded/.test(sb._chip.textContent), "and says so");

  const sb2 = makeSandbox();
  sb2.ex = REF; sb2.bufs.trackIdxN = 900;     // the bare road-mesh fallback path
  await sb2.buildStandInTrack();
  ok(sb2.standInGroup === null, "a bare road mesh also outranks it");
}

/* ---- 5. freeing leaves nothing behind ---- */
{
  const sb = makeSandbox();
  sb.ex = REF;
  await sb.buildStandInTrack();
  sb.freeStandInTrack();
  ok(sb.standInGroup === null, "the reference is dropped");
  ok(sb.sceneGroups === null, "the scene is empty again rather than holding an empty array");
  ok(sb.live.size === 0, `every GL resource is released (${sb.live.size} left)`);
  sb.freeStandInTrack();
  ok(true, "and freeing twice is not an error");
}

/* ---- 6. every loaded run contributes — the union lever ---- */
{
  const a = makeSandbox(); a.ex = REF; await a.buildStandInTrack();
  const b = makeSandbox(); b.ex = REF; b.compareRuns = [{ ex: OTHER }]; await b.buildStandInTrack();
  ok(b.standInGroup.tris > a.standInGroup.tris,
     `a comparison run adds its corridor to the surface (${a.standInGroup.tris} → ${b.standInGroup.tris} tris)`);
  ok(/from 2 run\(s\)/.test(b._fileinfo.textContent), "and the count is reported, not silent");
}

/* ---- 7. the real kn5 path frees the stand-in BEFORE it installs its own groups ---- *
 * Structural, and stated as such: this asserts the ordering in the shipped source rather
 * than running loadTrackBuffers, which needs a real kn5 and a real GL context. It is the
 * weaker half of this file. What makes it worth having anyway is that the failure it guards
 * is silent — the stand-in would keep drawing under the real road and only its buffers would
 * be lost. */
{
  const fn = decomment(need("loadTrackBuffers", E.uiFunction("loadTrackBuffers")));
  const free = fn.indexOf("freeStandInTrack()");
  const install = fn.indexOf("sceneGroups = allGroups");
  ok(free >= 0, "loadTrackBuffers frees the stand-in");
  ok(install >= 0, "and installs the kn5's groups");
  ok(free >= 0 && install >= 0 && free < install, "in that order");
}

/* ---- 8. the full teardown takes the stand-in with it — and takes the car too, which is
 * exactly why buildStandInTrack does not use it. Both halves are asserted: without the first
 * the reference dangles past its freed buffers, and without the second there is no reason
 * for freeStandInTrack to exist at all. ---- */
{
  const sb = makeSandbox();
  sb.ex = REF;
  await sb.buildStandInTrack();
  const carTex = sb.gl.createTexture();
  sb.carGroups = [{ posBuf: sb.gl.createBuffer(), nrmBuf: sb.gl.createBuffer(), uvBuf: sb.gl.createBuffer(), idxBuf: sb.gl.createBuffer(), tex: carTex }];
  const before = sb.live.size;
  sb.resetTrackScene();
  ok(sb.standInGroup === null, "resetTrackScene drops the stand-in reference, not just the scene");
  ok(sb.sceneGroups === null, "and empties the scene");
  ok(sb.live.size === 0, `and releases everything (${before} live → ${sb.live.size})`);
  ok(sb.carGroups === null, "including the CAR — which is why the stand-in has its own narrower free");
  ok(sb.calls.teardownTreeSys === 1 && sb.trackLights.length === 0 && sb.lampsBaked === false,
     "and the rest of the per-track state goes with it");
  ok(sb._chip.hidden === false, "the track chip comes back, since there is no track any more");
}

/* ---- 9. the globals it writes actually exist in the shipped source ---- *
 * THE HOLE THIS CLOSES, and it is the one a sandbox test cannot see by construction: the
 * sandbox defines whatever name the code under test asks for. If buildStandInTrack wrote
 * `sceneAabb` and the app declared `sceneAABB`, every assertion above would still pass and
 * the app would throw ReferenceError on the first click — these files are "use strict", so an
 * undeclared assignment is an error, not a new global. So each name is checked against the
 * real declarations instead. (Verified while writing this: `staticBakeTime` is declared in
 * shadowpass.js, four files away from every one of its assignments.) */
{
  const WRITES = ["sceneGroups", "sceneAABB", "trackAABB", "staticBakeTime",
                  "edgeIndex", "worldColl", "smokeColl", "standInGroup"];
  const READS = ["ex", "compareRuns", "bufs"];
  const declared = (n) => new RegExp("(?:^|[;{]\\s*)(?:let|var|const)\\s[^;{}]*\\b" + n + "\\b", "m").test(src);
  for (const n of WRITES.concat(READS)) ok(declared(n), `${n} is declared somewhere in ui/, not created by assignment`);
  // and the check has teeth: a name that is genuinely absent must fail it
  ok(!declared("sceneAabb"), "the check rejects a name that does not exist (the misspelling case)");
  // and the list is not stale: every name on it is one this function really assigns
  const body = decomment(need("buildStandInTrack", E.uiFunction("buildStandInTrack")));
  for (const n of WRITES) ok(new RegExp("\\b" + n + "\\s*=[^=]").test(body), `${n} is still assigned by buildStandInTrack`);
}

console.log(fails ? `test_standin: ${fails} FAILED` : "test_standin: all pass");
process.exit(fails ? 1 : 0);

})();
