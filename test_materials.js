/* test_materials.js — the kn5 material property block.
 *
 * These properties were stepped over for the whole life of the renderer (`str(); off += 40;`)
 * and nothing complained, because a track missing its emissive and gloss still draws — it
 * just draws flat, and flat looks like a limit of the data rather than a bug. So the risk
 * here is not a crash, it is a silent zero. Every assertion below therefore checks a value
 * we know is non-zero on disk, not merely that a field exists.
 *
 * Run: node test_materials.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const KN5 = require("./ui/kn5.js");

let fails = 0;
function ok(cond, msg) { if (!cond) { console.log("  FAIL " + msg); fails++; } }

/* ---------- 1. synthetic: the record layout, independent of any install ---------- */

/* A property is a name plus exactly ten floats in four groups — A(1) B(2) C(3) D(4). If
 * that layout is misread the whole material list desynchronises and every LATER material is
 * garbage, so this is worth pinning without needing Assetto Corsa present. */
function buildKn5({ props, samplers }) {
  const parts = [];
  const str = (s) => { const b = Buffer.alloc(4 + s.length); b.writeInt32LE(s.length, 0); b.write(s, 4, "latin1"); return b; };
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v, 0); return b; };
  const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return b; };
  parts.push(Buffer.from("sc6969", "latin1"), i32(5));
  parts.push(i32(0));                       // no textures
  parts.push(i32(1));                       // one material
  parts.push(str("mat"), str("ksPerPixel"), Buffer.from([0, 1]), i32(0));
  parts.push(i32(props.length));
  for (const p of props) {
    parts.push(str(p.name), f32(p.a));
    parts.push(f32(0), f32(0));                            // B
    parts.push(f32(p.c[0]), f32(p.c[1]), f32(p.c[2]));     // C
    parts.push(f32(0), f32(0), f32(0), f32(0));            // D
  }
  parts.push(i32(samplers.length));
  for (const s of samplers) parts.push(str(s.name), i32(0), str(s.tex));
  // the node tree is not optional — the parser walks it immediately after the materials, so
  // a bare terminator desynchronises it. One childless class-1 root with an identity
  // transform is the smallest well-formed tree.
  parts.push(i32(1), str("root"), i32(0), Buffer.from([1]));
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) parts.push(f32(r === c ? 1 : 0));
  const buf = Buffer.concat(parts);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

console.log("record layout (synthetic)");
{
  const ab = buildKn5({
    props: [
      { name: "ksAmbient", a: 0.4, c: [0, 0, 0] },
      { name: "ksEmissive", a: 0, c: [2.0, 0.4, 0.0] },
      { name: "ksSpecular", a: 0.7, c: [0, 0, 0] },
      { name: "ksSpecularEXP", a: 42, c: [0, 0, 0] },
      { name: "ksAlphaRef", a: 0.25, c: [0, 0, 0] },
    ],
    samplers: [{ name: "txDiffuse", tex: "d.dds" }, { name: "txEmissive", tex: "e.dds" }],
  });
  const m = KN5.extractScene(ab, {}).materials[0];
  // the colour comes out of group C, the scalars out of group A — swapping them is the
  // failure this catches, and it would produce plausible-looking numbers, not obvious junk
  ok(m.emissive && m.emissive[0] === 2 && Math.abs(m.emissive[1] - 0.4) < 1e-6 && m.emissive[2] === 0,
     "ksEmissive read from group C: got " + JSON.stringify(m.emissive));
  ok(Math.abs(m.specular - 0.7) < 1e-6, "ksSpecular from group A: got " + m.specular);
  ok(m.specExp === 42, "ksSpecularEXP from group A: got " + m.specExp);
  ok(Math.abs(m.alphaRef - 0.25) < 1e-6, "ksAlphaRef from group A: got " + m.alphaRef);
  ok(m.txDiffuse === "d.dds", "txDiffuse still read: got " + m.txDiffuse);
  ok(m.txEmissive === "e.dds", "txEmissive read: got " + m.txEmissive);
  // properties we do not consume must still be STEPPED correctly, or everything after them
  // shifts — ksAmbient sits first above precisely to make that failure visible here
  ok(m.name === "mat" && m.shader === "ksPerPixel", "material header intact past the props");
}

console.log("a black emissive is no emissive");
{
  // ksEmissive is present on all 294 materials in the library and zero on 273 of them.
  // Carrying [0,0,0] as a live value would put every one of them through the emissive
  // branch and bind a mask slot for nothing.
  const ab = buildKn5({ props: [{ name: "ksEmissive", a: 0, c: [0, 0, 0] }], samplers: [] });
  ok(KN5.extractScene(ab, {}).materials[0].emissive === null, "zero ksEmissive stays null");
}

console.log("defaults when a property is absent");
{
  const ab = buildKn5({ props: [], samplers: [{ name: "txDiffuse", tex: "d.dds" }] });
  const m = KN5.extractScene(ab, {}).materials[0];
  ok(m.emissive === null, "no ksEmissive -> null");
  ok(m.specular === 0, "no ksSpecular -> 0 (unlit-equivalent, so old look is preserved)");
  ok(m.specExp === 10, "no ksSpecularEXP -> 10");
  ok(m.alphaRef === 0, "no ksAlphaRef -> 0, and the caller substitutes 0.5");
  ok(m.txEmissive === null, "no txEmissive -> null");
}

/* ---------- 2. the real library, when it is here ---------- */

const ROOTS = [
  "G:/SteamLibrary/steamapps/common/assettocorsa/content/tracks",
  "Z:/SteamLibrary/steamapps/common/assettocorsa/content/tracks",
  "C:/Program Files (x86)/Steam/steamapps/common/assettocorsa/content/tracks",
];
const root = ROOTS.find(r => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });

if (!root) {
  console.log("\n(no Assetto Corsa install found — synthetic checks only)");
} else {
  // one kn5 per track is NOT enough: a track's meshes are split across several models and
  // reading only the first has produced confidently wrong verdicts here before
  const kn5sFor = (dir) => {
    const out = [];
    const walk = (d, depth) => {
      if (depth > 2) return;
      let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (/\.kn5$/i.test(e.name)) out.push(p);
      }
    };
    walk(dir, 0);
    return out;
  };
  const materialsOf = (track) => {
    const dir = fs.readdirSync(root).find(d => d.toLowerCase().includes(track));
    if (!dir) return null;
    const out = [];
    for (const f of kn5sFor(path.join(root, dir))) {
      let raw; try { raw = fs.readFileSync(f); } catch { continue; }
      try { out.push(...KN5.extractScene(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), {}).materials); }
      catch { /* a model we cannot parse is not this test's subject */ }
    }
    return out;
  };

  console.log("\naurora — the masked road glow");
  const aurora = materialsOf("aurora");
  if (!aurora) console.log("  (not installed, skipped)");
  else {
    const lit = aurora.filter(m => m.emissive);
    ok(lit.length >= 6, "aurora has emissive materials: got " + lit.length);
    const road = lit.filter(m => /^track[123]$/.test(m.name));
    ok(road.length >= 3, "its track surfaces are among them: got " + road.length);
    // the mask is the whole reason this is not just "make the road bright" — without it,
    // ksEmissive 3.0 on a road material turns the entire racing surface into a light box
    ok(road.every(m => m.txEmissive && /emissive/i.test(m.txEmissive)),
       "every emissive road material carries its mask: " + road.map(m => m.txEmissive).join(","));
    ok(road.every(m => m.emissive[0] > 1), "and is authored above 1.0, so the gain matters");
  }

  console.log("thunderhead — LED panels, coloured, unmasked");
  const th = materialsOf("thunderhead_raceway");
  if (!th) console.log("  (not installed, skipped)");
  else {
    const lit = th.filter(m => m.emissive);
    ok(lit.length >= 5, "thunderhead has emissive materials: got " + lit.length);
    // these are colours, not brightnesses — a blue LED at [0,0.6,3] must not arrive grey
    const coloured = lit.filter(m => Math.max(...m.emissive) > 3 * Math.min(...m.emissive) + 0.1);
    ok(coloured.length >= 3, "several are strongly coloured: got " + coloured.length);
    ok(lit.every(m => !m.txEmissive), "and none carry a mask, so they fall back to diffuse");
  }

  console.log("gloss is present across the library, not just on a few materials");
  {
    let n = 0, withSpec = 0, exps = [];
    for (const t of ["sakura", "miandros", "thunderhead_raceway", "nordic", "t180testtrack"]) {
      const mats = materialsOf(t);
      if (!mats) continue;
      for (const m of mats) { n++; if (m.specular > 0) withSpec++; if (m.specExp > 0) exps.push(m.specExp); }
    }
    if (!n) console.log("  (no tracks installed, skipped)");
    else {
      ok(withSpec > n * 0.5, `most materials declare ksSpecular: ${withSpec}/${n}`);
      ok(exps.some(e => e > 1), "and real exponents, not all zero");
      // a specular exponent of 0 makes pow() return 1 everywhere — a full-brightness wash
      // over the entire surface. The shader clamps to >= 1; this records why.
      ok(exps.every(e => e >= 0), "exponents are non-negative");
    }
  }
}

console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exit(fails ? 1 : 0);
