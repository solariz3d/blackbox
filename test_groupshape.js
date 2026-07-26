/* test_groupshape.js — the group descriptor contract.
 *
 * On 2026-07-25 three features (foliage flag, frustum bounds, lamp-bake vertex data) were
 * added to a car-only constructor while the track was built by a near-identical inline push
 * forty lines away: live in code, dead in effect, all tests green. The fix is one factory —
 * makeGroup() — that both paths call. This test pins the two properties that make the fix
 * hold:
 *
 *   1. THE FIELD UNION: every field any render pass reads must exist (possibly null, never
 *      undefined) on BOTH group kinds. `in`-checks, so null passes and absence fails.
 *   2. THE TRIPWIRE: `posBuf: ` appears in exactly ONE object literal in index.html. A
 *      second occurrence means someone has started a second constructor — the recurrence
 *      alarm for the whole bug class.
 *
 * vm-sandbox pattern per test_shadowbox.js. CLAUDE.md trap heeded: `const` inside a vm
 * context is a lexical binding, not a sandbox property — makeGroup/uploadGroups are function
 * DECLARATIONS (those do attach), and every const they close over is stubbed onto the
 * sandbox explicitly, never read back out of it.
 *
 * Run: node test_groupshape.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok " : "FAIL"} - ${m}`); if (!c) fails++; };

const html = fs.readFileSync(path.join(__dirname, "ui", "index.html"), "utf8");

console.log("the tripwire: one constructor, ever");
{
  const n = (html.match(/posBuf: /g) || []).length;
  ok(n === 1, `\`posBuf: \` object-literal count is ${n} (must be exactly 1 — a second is a new constructor)`);
}

console.log("\nextract makeGroup + uploadGroups into a stub sandbox");
const grab = (name) => {
  const re = new RegExp(`async function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  const m = html.match(re);
  if (!m) throw new Error(`could not extract ${name}`);
  return m[0];
};
let sandbox;
{
  let bufN = 0, texN = 0;
  sandbox = {
    gl: {
      ARRAY_BUFFER: 1, ELEMENT_ARRAY_BUFFER: 2, STATIC_DRAW: 3,
      createBuffer: () => ({ buf: ++bufN }),
      bindBuffer: () => {}, bufferData: () => {},
    },
    // async in the real code; a resolved token is all the contract needs
    makeSceneTexture: async () => ({ tex: ++texN }),
    makeFallbackTexture: () => ({ fallback: true }),
    isFoliageMaterial: require("./ui/kn5.js").isFoliageMaterial,
    Object,
  };
  vm.createContext(sandbox);
  new vm.Script(grab("makeGroup") + "\n" + grab("uploadGroups"), { filename: "index.html#extract" })
    .runInContext(sandbox);
  ok(typeof sandbox.makeGroup === "function", "makeGroup extracted");
  ok(typeof sandbox.uploadGroups === "function", "uploadGroups extracted");
}

/* The union of fields read by the passes, each annotated with its reader:
 * lit loop (tex, alphaTested, alphaRef, spec, specExp, emissive, emisTex, translucent,
 * lampBuf, matName, foliage, centre, radius, buffers), depth cascades + beam (foliage,
 * centre, radius, buffers), glass filter (glass), bake (lampBuf, pos, nrm, centre, radius),
 * HUD counters (tris, count). */
const UNION = [
  "posBuf", "nrmBuf", "uvBuf", "idxBuf", "count", "tex",
  "alphaTested", "translucent", "alphaRef",
  "emissive", "emisTex", "spec", "specExp",
  "matName", "foliage", "tris", "centre", "radius", "lampBuf", "glass", "pos", "nrm",
];

const G = { pos: new Float32Array(9), nrm: new Float32Array(9), uv: new Float32Array(6),
            idx: new Uint32Array([0, 1, 2]), centre: [1, 2, 3], radius: 4 };

(async () => {
  console.log("\ncar-kind group (via uploadGroups) carries the full union");
  {
    const scene = { textures: [], materials: [{ name: "GlassThing", alphaTested: 1, blendMode: 0 }] };
    const out = await sandbox.uploadGroups([Object.assign({ materialId: 0 }, G)], scene, [1, 2, 3]);
    const g = out[0];
    for (const f of UNION) ok(f in g, `car group has \`${f}\``);
    ok(g.glass === true, "car extra: glass classified from the name");
    ok(g.translucent === false, "translucent (not the retired `blend` alias) is the shared name");
  }

  console.log("\ntrack-kind group (makeGroup with track extras) carries the full union");
  {
    const mat = { name: "Track", alphaTested: 0, blendMode: 0, emissive: [1, 2, 3], specular: 0.5, specExp: 40 };
    const g = await sandbox.makeGroup(Object.assign({ materialId: 0 }, G), mat, {}, [9, 9, 9],
      { emissive: mat.emissive, emisTex: null, spec: mat.specular, specExp: mat.specExp });
    for (const f of UNION) ok(f in g, `track group has \`${f}\``);
    ok(Array.isArray(g.emissive), "track extra: emissive rides through");
    ok(g.spec === 0.5 && g.specExp === 40, "track extra: spec pair rides through");
  }

  console.log("\nedge semantics survive the move");
  {
    const g0 = await sandbox.makeGroup(Object.assign({ materialId: 0 }, G),
      { name: "Fence", alphaTested: 1, blendMode: 0, alphaRef: 0 }, {}, [1, 1, 1]);
    ok(g0.alphaRef === 0.5, "alphaRef 0 on disk means 'unset' and becomes 0.5");
    const g1 = await sandbox.makeGroup(Object.assign({ materialId: 0 }, G),
      { name: "Decal", blendMode: 1 }, {}, [1, 1, 1]);
    ok(g1.translucent === true, "blendMode 1 is translucent");
    ok(g1.lampBuf === null, "lampBuf present-but-null before the bake");
  }

  console.log("\nthe retired alias stays retired");
  {
    const readers = (html.match(/\.blend\b/g) || []).filter(s => s === ".blend").length;
    // gl.blendFunc etc. don't match `.blend\b` followed by nothing — count raw `.blend` word hits
    const raw = (html.match(/\bg\.blend\b/g) || []).length;
    ok(raw === 0, `no reader of the old car-only \`g.blend\` alias remains (found ${raw})`);
  }

  console.log(fails ? `\n${fails} FAILED` : "\nall good");
  process.exit(fails ? 1 : 0);
})();
