/* test_kn5tex.js — Node test for kn5tex.js against REAL kn5 texture blobs.
 *
 * Walks the kn5 texture block inline (kn5.js seeks past the blobs and does
 * not export them): "sc6969" magic, int32 version (+1 extra int32 if v>5),
 * int32 texCount, then per texture: int32 type, u32 nameLen + name,
 * u32 dataSize, blob.
 *
 * Usage: node test_kn5tex.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const tex = require("./kn5tex.js");

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log("  PASS  " + msg); }
  else { failures++; console.log("  FAIL  " + msg); }
}

// ---------------------------------------------------------------- synthetic

console.log("== synthetic unit checks ==");

// sniffFormat boundaries
check(tex.sniffFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) === "png",
      "sniffFormat: PNG signature");
check(tex.sniffFormat(new Uint8Array([0x44, 0x44, 0x53, 0x20, 0, 0, 0, 0])) === "dds",
      "sniffFormat: DDS magic");
check(tex.sniffFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])) === "jpg",
      "sniffFormat: JPEG SOI marker");
check(tex.sniffFormat(new Uint8Array([1, 2, 3, 4])) === "unknown",
      "sniffFormat: garbage -> unknown");
check(tex.sniffFormat(new Uint8Array(0)) === "unknown",
      "sniffFormat: empty input -> unknown");

// decodeDXT: known DXT1 block, 4-color mode.
// c0 = red 0xF800, c1 = blue 0x001F (c0 > c1 -> 4-color opaque mode).
// index rows: row0 all 0 (red), row1 all 1 (blue), row2 all 2 (2/3 red),
// row3 all 3 (1/3 red).
{
  const block = new Uint8Array([0x00, 0xf8, 0x1f, 0x00, 0x00, 0x55, 0xaa, 0xff]);
  const out = tex.decodeDXT({ width: 4, height: 4, data: block }, "dxt1");
  check(out.length === 4 * 4 * 4, "dxt1: output length 4x4x4");
  check(out[0] === 255 && out[1] === 0 && out[2] === 0 && out[3] === 255,
        "dxt1: row0 = pure red opaque");
  check(out[16] === 0 && out[18] === 255 && out[19] === 255,
        "dxt1: row1 = pure blue opaque");
  check(out[32] === Math.round(2 * 255 / 3) && out[34] === Math.round(255 / 3),
        "dxt1: row2 = 2/3 red interpolant");
  check(out[48] === Math.round(255 / 3) && out[50] === Math.round(2 * 255 / 3),
        "dxt1: row3 = 1/3 red interpolant");
}

// decodeDXT: DXT1 3-color mode punch-through (c0 <= c1, index 3 -> transparent)
{
  const block = new Uint8Array([0x1f, 0x00, 0x00, 0xf8, 0xff, 0xff, 0xff, 0xff]);
  const out = tex.decodeDXT({ width: 4, height: 4, data: block }, "dxt1");
  check(out[3] === 0 && out[0] === 0 && out[1] === 0 && out[2] === 0,
        "dxt1: 3-color mode index 3 = transparent black");
}

// decodeDXT: DXT3 explicit alpha (nibbles 0x0F -> texel0 a=255, texel1 a=0)
{
  const block = new Uint8Array(16);
  block[0] = 0x0f; // texel0 nibble F? low nibble = texel0 -> 0x0f & 15 = 15 -> 255
  block[8] = 0x00; block[9] = 0xf8; // c0 red
  const out = tex.decodeDXT({ width: 4, height: 4, data: block }, "dxt3");
  check(out[3] === 255 && out[7] === 0,
        "dxt3: explicit 4-bit alpha (15 -> 255, 0 -> 0)");
  check(out[0] === 255 && out[1] === 0 && out[2] === 0,
        "dxt3: color block decodes (red)");
}

// decodeDXT: DXT5 interpolated alpha, a0 > a1 -> 8-entry ramp
// a0=255, a1=0; indices: texel0 = 0 (255), texel1 = 1 (0), texel2 = 2 (ramp)
{
  const block = new Uint8Array(16);
  block[0] = 255; block[1] = 0;
  block[2] = 0x88; // bits: t0=000, t1=001(? check) -> 0x88 = 10001000b: t0=000, t1=001, t2=010
  block[8] = 0x00; block[9] = 0xf8;
  const out = tex.decodeDXT({ width: 4, height: 4, data: block }, "dxt5");
  check(out[3] === 255, "dxt5: alpha index 0 -> a0 (255)");
  check(out[7] === 0, "dxt5: alpha index 1 -> a1 (0)");
  check(out[11] === Math.round(6 * 255 / 7), "dxt5: alpha index 2 -> 6/7 ramp");
}

// decodeDXT: DXT5 a0 <= a1 mode -> index 6 = 0, index 7 = 255
{
  const block = new Uint8Array(16);
  block[0] = 10; block[1] = 20;
  block[2] = 0xfe; // t0=110(6)->0, t1=111(7)->255
  const out = tex.decodeDXT({ width: 4, height: 4, data: block }, "dxt5");
  check(out[3] === 0 && out[7] === 255,
        "dxt5: a0<=a1 mode indices 6/7 -> 0/255");
}

// decodeDXT: non-multiple-of-4 dims (edge clamp) — 2x2 mip from one block
{
  const block = new Uint8Array([0x00, 0xf8, 0x1f, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const out = tex.decodeDXT({ width: 2, height: 2, data: block }, "dxt1");
  check(out.length === 2 * 2 * 4, "dxt1: 2x2 mip output length 16");
}

// parseDDS: synthetic uncompressed BGRA 2x1 (masks R=0xff0000 G=0xff00 B=0xff A=0xff000000)
{
  const buf = new Uint8Array(128 + 8);
  const dv = new DataView(buf.buffer);
  buf.set([0x44, 0x44, 0x53, 0x20], 0);          // "DDS "
  dv.setUint32(4, 124, true);                     // header size
  dv.setUint32(8, 0x1007, true);                  // CAPS|HEIGHT|WIDTH|PIXELFORMAT
  dv.setUint32(12, 1, true);                      // height
  dv.setUint32(16, 2, true);                      // width
  dv.setUint32(76, 32, true);                     // ddspf size
  dv.setUint32(80, 0x41, true);                   // DDPF_RGB | ALPHAPIXELS
  dv.setUint32(88, 32, true);                     // bit count
  dv.setUint32(92, 0x00ff0000, true);             // R
  dv.setUint32(96, 0x0000ff00, true);             // G
  dv.setUint32(100, 0x000000ff, true);            // B
  dv.setUint32(104, 0xff000000, true);            // A
  // texel0 BGRA = (1,2,3,4) -> RGBA (3,2,1,4); texel1 = (10,20,30,40)
  buf.set([1, 2, 3, 4, 10, 20, 30, 40], 128);
  const p = tex.parseDDS(buf);
  check(p.format === "rgba8" && p.width === 2 && p.height === 1,
        "parseDDS: uncompressed 32-bit BGRA header");
  const d = p.mips[0].data;
  check(d[0] === 3 && d[1] === 2 && d[2] === 1 && d[3] === 4 &&
        d[4] === 30 && d[5] === 20 && d[6] === 10 && d[7] === 40,
        "parseDDS: BGRA -> RGBA channel swizzle");
}

// parseDDS: truncated DXT1 should fail loudly
{
  const buf = new Uint8Array(128 + 4); // DXT1 4x4 needs 8 bytes, give 4
  const dv = new DataView(buf.buffer);
  buf.set([0x44, 0x44, 0x53, 0x20], 0);
  dv.setUint32(4, 124, true);
  dv.setUint32(8, 0x1007, true);
  dv.setUint32(12, 4, true);
  dv.setUint32(16, 4, true);
  dv.setUint32(76, 32, true);
  dv.setUint32(80, 0x4, true);                    // DDPF_FOURCC
  buf.set([0x44, 0x58, 0x54, 0x31], 84);          // "DXT1"
  let threw = false;
  try { tex.parseDDS(buf); } catch (e) { threw = /truncated/.test(e.message); }
  check(threw, "parseDDS: truncated mip data throws 'truncated'");
}

// decodePNGDims: minimal synthetic IHDR
{
  const buf = new Uint8Array(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(buf.buffer);
  dv.setUint32(8, 13, false);
  buf.set([0x49, 0x48, 0x44, 0x52], 12);          // "IHDR"
  dv.setUint32(16, 640, false);
  dv.setUint32(20, 480, false);
  const d = tex.decodePNGDims(buf);
  check(d.width === 640 && d.height === 480, "decodePNGDims: IHDR 640x480");
}

// ---------------------------------------------------------------- real files

// walk the kn5 texture block, return [{ name, blob }]
function readKn5Textures(file) {
  const buf = fs.readFileSync(file);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let off = 0;
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3], u8[4], u8[5]);
  if (magic !== "sc6969") throw new Error(file + ": bad kn5 magic '" + magic + "'");
  off = 6;
  const version = dv.getInt32(off, true); off += 4;
  if (version > 5) off += 4;
  const texCount = dv.getInt32(off, true); off += 4;
  const out = [];
  for (let t = 0; t < texCount; t++) {
    off += 4; // type
    const nameLen = dv.getUint32(off, true); off += 4;
    let name = "";
    for (let i = 0; i < nameLen; i++) name += String.fromCharCode(u8[off + i]);
    off += nameLen;
    const size = dv.getUint32(off, true); off += 4;
    out.push({ name, blob: u8.subarray(off, off + size) });
    off += size;
  }
  return out;
}

function surveyFile(file) {
  console.log("\n== " + file + " ==");
  let textures;
  try { textures = readKn5Textures(file); }
  catch (e) { failures++; console.log("  FAIL  " + e.message); return []; }
  console.log("  " + textures.length + " textures");
  const results = [];
  const unsupported = [];
  for (const t of textures) {
    const fmt = tex.sniffFormat(t.blob);
    let line = "  " + t.name.padEnd(36) + " " + String(t.blob.length).padStart(9) + " B  ";
    let rec = { name: t.name, sniff: fmt, parsed: null, error: null };
    if (fmt === "dds") {
      try {
        const p = tex.parseDDS(t.blob);
        rec.parsed = p;
        line += p.format + "  " + p.width + "x" + p.height + "  mips=" + p.mips.length;
      } catch (e) {
        rec.error = e.message;
        unsupported.push(t.name + ": " + e.message);
        line += "UNSUPPORTED: " + e.message;
      }
    } else if (fmt === "png") {
      try {
        const d = tex.decodePNGDims(t.blob);
        rec.parsed = d;
        line += "png    " + d.width + "x" + d.height;
      } catch (e) {
        rec.error = e.message;
        unsupported.push(t.name + ": " + e.message);
        line += "UNSUPPORTED: " + e.message;
      }
    } else if (fmt === "jpg") {
      // browser decodes via createImageBitmap, same path as PNG; no Node dims
      rec.parsed = { container: "jpg" };
      line += "jpg    (browser-decoded; dims not parsed in Node)";
    } else {
      rec.error = "unknown container";
      unsupported.push(t.name + ": unknown container (first bytes " +
        Array.from(t.blob.subarray(0, 8)).map(b => b.toString(16).padStart(2, "0")).join(" ") + ")");
      line += "UNKNOWN container";
    }
    console.log(line);
    results.push(rec);
  }
  const nOk = results.filter(r => r.parsed).length;
  check(nOk === textures.length,
        path.basename(file) + ": all " + textures.length + " textures parsed" +
        (unsupported.length ? " (" + unsupported.length + " unsupported)" : ""));
  for (const u of unsupported) console.log("    unsupported -> " + u);
  return results;
}

const CENTRIFUGE = "G:\\SteamLibrary\\steamapps\\common\\assettocorsa\\content\\tracks\\centrifuge\\centrifuge.kn5";
const MIANDROS_DIR = "G:\\SteamLibrary\\steamapps\\common\\assettocorsa\\content\\tracks\\Miandros";

const allResults = surveyFile(CENTRIFUGE);

// Miandros kn5s (~22 textures across four files)
let mianFiles = [];
try {
  mianFiles = fs.readdirSync(MIANDROS_DIR)
    .filter(f => f.toLowerCase().endsWith(".kn5"))
    .map(f => path.join(MIANDROS_DIR, f));
} catch (e) { failures++; console.log("FAIL  cannot list " + MIANDROS_DIR + ": " + e.message); }
for (const f of mianFiles) allResults.push(...surveyFile(f));

// decode the top mip of one real DXT texture and sanity-check the pixels.
// (Pick the largest DXT found — centrifuge's only DXT is NULL.dds, a 4x4
// solid-white placeholder whose pixels are legitimately all identical.)
console.log("\n== real DXT decode sanity ==");
{
  const dxts = allResults.filter(r => r.parsed && /^dxt/.test(r.parsed.format || ""));
  const dxt = dxts.sort((a, b) =>
    b.parsed.width * b.parsed.height - a.parsed.width * a.parsed.height)[0];
  if (!dxt) { failures++; console.log("  FAIL  no DXT texture found in any surveyed kn5"); }
  else {
    const mip = dxt.parsed.mips[0];
    console.log("  decoding " + dxt.name + " (" + dxt.parsed.format + " " +
                mip.width + "x" + mip.height + " top mip)");
    const t0 = Date.now();
    const rgba = tex.decodeDXT(mip, dxt.parsed.format);
    console.log("  decoded in " + (Date.now() - t0) + " ms");
    check(rgba.length === mip.width * mip.height * 4,
          "decodeDXT: output length == w*h*4 (" + rgba.length + ")");
    let allSame = true;
    for (let i = 4; i < rgba.length; i += 4) {
      if (rgba[i] !== rgba[0] || rgba[i + 1] !== rgba[1] ||
          rgba[i + 2] !== rgba[2] || rgba[i + 3] !== rgba[3]) { allSame = false; break; }
    }
    check(!allSame, "decodeDXT: pixels are not all identical");
    const w = mip.width, h = mip.height;
    for (const [x, y] of [[0, 0], [w >> 1, h >> 1], [w - 1, h - 1]]) {
      const o = (y * w + x) * 4;
      console.log("  pixel (" + x + "," + y + ") = rgba(" +
                  rgba[o] + "," + rgba[o + 1] + "," + rgba[o + 2] + "," + rgba[o + 3] + ")");
    }
  }
}

// ---------------------------------------------------------------- verdict

console.log("\n" + (failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"));
process.exit(failures === 0 ? 0 : 1);
