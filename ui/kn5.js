/* kn5.js — Assetto Corsa .kn5 model parser (zero dependencies, browser + Node).
 *
 * Layout per RaduMC/kn5-converter + gro-ove/actools Kn5Writer.cs (they agree):
 * "sc6969" magic, int32 version (6 adds one extra int32), textures block
 * (blob sizes let us seek past the images), materials block, then a recursive
 * node tree. Class 1 = dummy (row-major float[16], translation at 12/13/14,
 * row-vector convention v' = v*M), class 2 = static mesh (44-byte vertices:
 * pos3f normal3f uv2f tangent3f; uint16 indices), class 3 = skinned (skipped).
 *
 * extractRoadMesh() keeps only PHYSICAL surface meshes: AC treats any mesh
 * whose name starts with a non-zero digit as collidable, keyed by the text
 * after the digit against surfaces.ini KEYs (ROAD/KERB/PIT/RUNOFF built-ins).
 */
"use strict";

function kn5ParseError(msg, off) {
  return new Error("kn5: " + msg + (off != null ? " at " + off : ""));
}

function extractRoadMesh(arrayBuffer, keyPattern) {
  const pat = keyPattern || /^[1-9]\d*(ROAD|KERB|PIT|RUNOFF)/i;
  const dv = new DataView(arrayBuffer);
  const total = arrayBuffer.byteLength;
  let off = 0;

  function u8() { const v = dv.getUint8(off); off += 1; return v; }
  function i32() { const v = dv.getInt32(off, true); off += 4; return v; }
  function u32() { const v = dv.getUint32(off, true); off += 4; return v; }
  function f32() { const v = dv.getFloat32(off, true); off += 4; return v; }
  function str() {
    const len = u32();
    if (len > 1 << 20) throw kn5ParseError("string too long (" + len + ")", off - 4);
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
    off += len;
    return s;
  }

  // header
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2),
                                    dv.getUint8(3), dv.getUint8(4), dv.getUint8(5));
  if (magic !== "sc6969") throw kn5ParseError("bad magic '" + magic + "'");
  off = 6;
  const version = i32();
  if (version > 5) i32(); // v6 extra header int

  // textures — seek past blobs
  const texCount = i32();
  for (let t = 0; t < texCount; t++) {
    i32();            // active
    str();            // name
    const size = u32();
    off += size;      // image data
  }

  // materials — names only, skip the rest field-accurately
  const matCount = i32();
  const materials = [];
  for (let m = 0; m < matCount; m++) {
    const name = str();
    str();            // shader
    u8(); u8();       // blendMode, alphaTested
    i32();            // depthMode (present in v5/v6)
    const props = i32();
    for (let p = 0; p < props; p++) { str(); off += 40; } // A f + B 2f + C 3f + D 4f
    const maps = i32();
    for (let q = 0; q < maps; q++) { str(); i32(); str(); }
    materials.push(name);
  }

  // node tree
  const roadVerts = [];   // Float32Array chunks
  const roadTris = [];    // Uint32Array chunks (already offset)
  let vertBase = 0;
  let meshCount = 0, meshTotal = 0, skinnedCount = 0;
  const roadNames = [];

  // row-vector convention: v' = v * M ; compose child = child * parent
  function matMulRowVec(a, b) { // returns a*b for row-major row-vector matrices
    const o = new Float64Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
    return o;
  }
  const IDENT = new Float64Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

  function readNode(parentM) {
    const cls = i32();
    const name = str();
    const children = i32();
    u8(); // active
    let m = parentM;

    if (cls === 1) {
      const t = new Float64Array(16);
      for (let i = 0; i < 16; i++) t[i] = f32();
      m = matMulRowVec(t, parentM);
    } else if (cls === 2) {
      meshTotal++;
      u8(); u8(); u8(); // castShadows, isVisible, isTransparent
      const nv = i32();
      const vStart = off;
      off += nv * 44;
      const ni = i32();
      const iStart = off;
      off += ni * 2;
      i32();            // materialId
      u32();            // layer
      f32(); f32();     // lodIn, lodOut
      off += 16;        // bounding sphere center+radius
      u8();             // isRenderable
      if (pat.test(name)) {
        meshCount++;
        if (roadNames.length < 40) roadNames.push(name);
        const verts = new Float32Array(nv * 3);
        for (let v = 0; v < nv; v++) {
          const b = vStart + v * 44;
          const x = dv.getFloat32(b, true), y = dv.getFloat32(b + 4, true), z = dv.getFloat32(b + 8, true);
          verts[v * 3]     = x * m[0] + y * m[4] + z * m[8]  + m[12];
          verts[v * 3 + 1] = x * m[1] + y * m[5] + z * m[9]  + m[13];
          verts[v * 3 + 2] = x * m[2] + y * m[6] + z * m[10] + m[14];
        }
        const tris = new Uint32Array(ni);
        for (let i = 0; i < ni; i++) tris[i] = dv.getUint16(iStart + i * 2, true) + vertBase;
        roadVerts.push(verts);
        roadTris.push(tris);
        vertBase += nv;
      }
    } else if (cls === 3) {
      skinnedCount++;
      u8(); u8(); u8();
      const bones = i32();
      for (let b = 0; b < bones; b++) { str(); off += 64; }
      const nv = i32();
      off += nv * 76;
      const ni = i32();
      off += ni * 2;
      i32(); u32();     // materialId, layer
      off += 8;         // trailing (lodIn/lodOut presumed)
    } else {
      throw kn5ParseError("unknown node class " + cls, off - 4);
    }

    for (let c = 0; c < children; c++) readNode(m);
  }

  readNode(IDENT);
  if (off > total) throw kn5ParseError("overran file (" + off + " > " + total + ")");

  // merge chunks
  let nvTotal = 0, ntTotal = 0;
  for (const v of roadVerts) nvTotal += v.length;
  for (const t of roadTris) ntTotal += t.length;
  const verts = new Float32Array(nvTotal);
  const tris = new Uint32Array(ntTotal);
  let vo = 0, to = 0;
  for (const v of roadVerts) { verts.set(v, vo); vo += v.length; }
  for (const t of roadTris) { tris.set(t, to); to += t.length; }

  return {
    version, meshCount, meshTotal, skinnedCount,
    materialCount: matCount, textureCount: texCount,
    names: roadNames, verts, tris,
    consumed: off, total,
  };
}

/* extractScene() — full visual pass for 1:1 rendering. Same certified walk as
 * extractRoadMesh (string/struct reads copied verbatim, kept self-contained so
 * the road parser is untouched), but keeps EVERY renderable class-2 mesh,
 * captures the embedded texture blobs (zero-copy subarray views) and the
 * material txDiffuse mapping, and merges meshes by materialId into one
 * drawable group per material (two-pass: count, then fill final-size arrays).
 * blendMode 1 = alpha-blend; those meshes are skipped by default
 * (opts.skipTransparent, default true) and counted in stats.skippedTransparent.
 *
 * opts.lod0Only (default false) keeps only the highest-detail LOD: cars ship
 * several LODs of the same body and we want just LOD0. A mesh is LOD0 when its
 * lodIn is 0 (it renders from distance 0); meshes with lodIn > 0 are farther-
 * away lower-detail LODs and are excluded, counted in stats.lodSkipped. A mesh
 * with no LOD system (lodIn and lodOut both 0) is always-visible → kept.
 */
function extractScene(arrayBuffer, opts) {
  const skipTransparent = !opts || opts.skipTransparent !== false;
  const lod0Only = !!(opts && opts.lod0Only);
  const dv = new DataView(arrayBuffer);
  const total = arrayBuffer.byteLength;
  let off = 0;

  function u8() { const v = dv.getUint8(off); off += 1; return v; }
  function i32() { const v = dv.getInt32(off, true); off += 4; return v; }
  function u32() { const v = dv.getUint32(off, true); off += 4; return v; }
  function f32() { const v = dv.getFloat32(off, true); off += 4; return v; }
  function str() {
    const len = u32();
    if (len > 1 << 20) throw kn5ParseError("string too long (" + len + ")", off - 4);
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
    off += len;
    return s;
  }

  // header
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2),
                                    dv.getUint8(3), dv.getUint8(4), dv.getUint8(5));
  if (magic !== "sc6969") throw kn5ParseError("bad magic '" + magic + "'");
  off = 6;
  const version = i32();
  if (version > 5) i32(); // v6 extra header int

  // textures — capture blobs as views into the source buffer (no copies)
  const texCount = i32();
  const textures = [];
  for (let t = 0; t < texCount; t++) {
    i32();            // active
    const name = str();
    const size = u32();
    textures.push({ name, blob: new Uint8Array(arrayBuffer, off, size) });
    off += size;      // image data
  }

  // materials — full record incl. the texture-slot mappings (txDiffuse)
  const matCount = i32();
  const materials = [];
  for (let m = 0; m < matCount; m++) {
    const name = str();
    const shader = str();
    const blendMode = u8();
    const alphaTested = u8();
    i32();            // depthMode (present in v5/v6)
    const props = i32();
    for (let p = 0; p < props; p++) { str(); off += 40; } // A f + B 2f + C 3f + D 4f
    const maps = i32();
    let txDiffuse = null;
    for (let q = 0; q < maps; q++) {
      const sampler = str();
      i32();          // slot
      const texName = str();
      if (sampler === "txDiffuse") txDiffuse = texName;
    }
    materials.push({ name, shader, blendMode, alphaTested, txDiffuse });
  }

  // node tree — pass 1: walk, record mesh descriptors grouped by materialId
  // row-vector convention: v' = v * M ; compose child = child * parent
  function matMulRowVec(a, b) { // returns a*b for row-major row-vector matrices
    const o = new Float64Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
    return o;
  }
  const IDENT = new Float64Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

  const byMat = new Map(); // materialId -> { nv, ni, meshes: [{vStart,nv,iStart,ni,m}] }
  let meshCount = 0, skippedTransparent = 0, lodSkipped = 0;

  function readNode(parentM) {
    const cls = i32();
    const name = str();
    const children = i32();
    u8(); // active
    let m = parentM;

    if (cls === 1) {
      const t = new Float64Array(16);
      for (let i = 0; i < 16; i++) t[i] = f32();
      m = matMulRowVec(t, parentM);
    } else if (cls === 2) {
      u8(); u8(); u8(); // castShadows, isVisible, isTransparent
      const nv = i32();
      const vStart = off;
      off += nv * 44;
      const ni = i32();
      const iStart = off;
      off += ni * 2;
      const materialId = i32();
      u32();            // layer
      const lodIn = f32(); f32(); // lodIn, lodOut (lod0Only filters on lodIn)
      off += 16;        // bounding sphere center+radius
      const isRenderable = u8();
      if (isRenderable !== 0) {
        const mat = materials[materialId];
        if (lod0Only && lodIn > 0) {
          lodSkipped++;   // lower-detail LOD (renders only past lodIn) — drop it
        } else if (skipTransparent && mat && mat.blendMode === 1) {
          skippedTransparent++;
        } else {
          meshCount++;
          let g = byMat.get(materialId);
          if (!g) { g = { nv: 0, ni: 0, meshes: [] }; byMat.set(materialId, g); }
          g.meshes.push({ vStart, nv, iStart, ni, m });
          g.nv += nv;
          g.ni += ni;
        }
      }
    } else if (cls === 3) {
      u8(); u8(); u8();
      const bones = i32();
      for (let b = 0; b < bones; b++) { str(); off += 64; }
      const nv = i32();
      off += nv * 76;
      const ni = i32();
      off += ni * 2;
      i32(); u32();     // materialId, layer
      off += 8;         // trailing (lodIn/lodOut presumed)
    } else {
      throw kn5ParseError("unknown node class " + cls, off - 4);
    }

    for (let c = 0; c < children; c++) readNode(m);
  }

  readNode(IDENT);
  if (off > total) throw kn5ParseError("overran file (" + off + " > " + total + ")");

  // pass 2: fill final-size arrays per material group
  const groups = [];
  let triTotal = 0;
  for (const [materialId, g] of byMat) {
    const pos = new Float32Array(g.nv * 3);
    const nrm = new Float32Array(g.nv * 3);
    const uv  = new Float32Array(g.nv * 2);
    const idx = new Uint32Array(g.ni);
    let vertBase = 0, io = 0;
    for (const mesh of g.meshes) {
      const m = mesh.m, vStart = mesh.vStart, nv = mesh.nv;
      for (let v = 0; v < nv; v++) {
        const b = vStart + v * 44;
        const o3 = (vertBase + v) * 3, o2 = (vertBase + v) * 2;
        const x = dv.getFloat32(b, true), y = dv.getFloat32(b + 4, true), z = dv.getFloat32(b + 8, true);
        pos[o3]     = x * m[0] + y * m[4] + z * m[8]  + m[12];
        pos[o3 + 1] = x * m[1] + y * m[5] + z * m[9]  + m[13];
        pos[o3 + 2] = x * m[2] + y * m[6] + z * m[10] + m[14];
        const nx = dv.getFloat32(b + 12, true), ny = dv.getFloat32(b + 16, true), nz = dv.getFloat32(b + 20, true);
        let rx = nx * m[0] + ny * m[4] + nz * m[8];
        let ry = nx * m[1] + ny * m[5] + nz * m[9];
        let rz = nx * m[2] + ny * m[6] + nz * m[10];
        const len = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (len > 0) { rx /= len; ry /= len; rz /= len; }
        nrm[o3]     = rx;
        nrm[o3 + 1] = ry;
        nrm[o3 + 2] = rz;
        uv[o2]     = dv.getFloat32(b + 24, true);
        uv[o2 + 1] = dv.getFloat32(b + 28, true);
      }
      const iStart = mesh.iStart, ni = mesh.ni;
      for (let i = 0; i < ni; i++) idx[io + i] = dv.getUint16(iStart + i * 2, true) + vertBase;
      io += ni;
      vertBase += nv;
    }
    triTotal += g.ni / 3;
    groups.push({ materialId, pos, nrm, uv, idx, triCount: g.ni / 3 });
  }

  return {
    textures, materials, groups,
    stats: { meshCount, triCount: triTotal, skippedTransparent, lodSkipped },
  };
}

if (typeof module !== "undefined") module.exports = { extractRoadMesh, extractScene };
if (typeof window !== "undefined") window.KN5 = { extractRoadMesh, extractScene };
