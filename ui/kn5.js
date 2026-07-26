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
    /* The property block used to be stepped over wholesale — `str(); off += 40;` — and the
     * cost of that was invisible because nothing complained: tracks simply rendered as flat
     * unlit diffuse and looked like it was the best the data allowed. It wasn't. Every one
     * of these materials carries ksEmissive, ksSpecular and ksSpecularEXP, and they are what
     * tell a lit sign from a painted one and wet asphalt from felt.
     *
     * A record is a name followed by exactly 40 bytes = ten floats, in four fixed groups:
     * A is one float, B is two, C is three, D is four. Scalars live in A, colours in C. */
    const props = i32();
    let emissive = null, specular = 0, specExp = 10, alphaRef = 0;
    for (let p = 0; p < props; p++) {
      const pn = str();
      const a = f32();                          // A: 1 float
      off += 8;                                 // B: 2 floats
      const c0 = f32(), c1 = f32(), c2 = f32(); // C: 3 floats
      off += 16;                                // D: 4 floats
      if (pn === "ksEmissive") { if (c0 > 0.001 || c1 > 0.001 || c2 > 0.001) emissive = [c0, c1, c2]; }
      else if (pn === "ksSpecular") specular = a;
      else if (pn === "ksSpecularEXP") specExp = a;
      else if (pn === "ksAlphaRef") alphaRef = a;
    }
    const maps = i32();
    let txDiffuse = null, txEmissive = null;
    for (let q = 0; q < maps; q++) {
      const sampler = str();
      i32();          // slot
      const texName = str();
      if (sampler === "txDiffuse") txDiffuse = texName;
      // A MASK, not a colour: aurora's track1/2/3 declare ksEmissive 3.0 with a
      // track*_emissive.dds beside it, and the mask is the whole point — the glow belongs
      // to the light strips painted into it. Multiply ksEmissive by the DIFFUSE instead and
      // the entire road surface becomes a light box.
      else if (sampler === "txEmissive") txEmissive = texName;
    }
    materials.push({ name, shader, blendMode, alphaTested, txDiffuse,
                     txEmissive, emissive, specular, specExp, alphaRef });
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
  // wheels split out by corner (LF/RF/LR/RR) so they can be steered independently of
  // the body. corner -> { pivot:[x,y,z] (wheel centre, model-local), byMat: Map }
  const wheelByCorner = new Map();
  const steerWheelByMat = new Map();   // the in-cockpit steering wheel (spins with steer)
  let steerWheelData = null;
  let meshCount = 0, skippedTransparent = 0, lodSkipped = 0, logicSkipped = 0;
  /* Node names and their world origins, for CSP's LIGHT_SERIES.
   *
   * A light series does not carry coordinates — it carries MESHES = TorusLight?,
   * StartFinishGate_SUB2 and places one light AT each matching mesh (hence "series").
   * So the track's lights cannot be resolved without knowing where its named nodes are.
   * The walk already computes every node's world matrix and then discards it, so this
   * costs a push per node and nothing else. Off unless asked for: the array is one entry
   * per node and only the lighting path wants it. */
  const wantNodes = !!(opts && opts.collectNodes);
  const nodes = [];

  function readNode(parentM, wheel, steer, hidden) {
    const cls = i32();
    const name = str();
    const children = i32();
    u8(); // active
    /* AC's LOGIC OBJECTS are geometry the game never draws: AC_PIT_n (pit boxes),
     * AC_START_n (grid slots), AC_TIME_n_L/R (timing gates), AC_HOTLAP_START_n,
     * AC_AUDIO_*, AC_CREW_*. The game reads their transforms and hides the meshes; a
     * renderer that just draws every mesh in the kn5 puts them all on screen — which is
     * what "the spawn points render in the map" was. Hide the whole SUBTREE, because the
     * marker is usually an empty transform with placeholder geometry beneath it.
     *
     * Still parsed, never drawn: the format is a sequential walk, so the bytes must be
     * consumed to find what follows. Skipping the read would desynchronise the parser. */
    hidden = hidden || /^AC_/i.test(name);
    let m = parentM;
    let childWheel = wheel;
    let childSteer = steer;
    // the driveshaft flexes at CV joints in reality; steering it rigidly swings it
    // out the back like a stick, so keep it in the body (never in a wheel group).
    const isDriveshaft = /driveshaft/i.test(name);

    if (cls === 1) {
      const t = new Float64Array(16);
      for (let i = 0; i < 16; i++) t[i] = f32();
      m = matMulRowVec(t, parentM);
      // world origin of this node, for LIGHT_SERIES mesh lookups. Row-vector convention,
      // so the translation is row 3. AC_* markers are kept deliberately: they are never
      // drawn, but a light series is free to hang off one.
      if (wantNodes && name) nodes.push({ name, pos: [m[12], m[13], m[14]] });
      // the whole per-corner assembly STEERS together: the wheel (tyre+rim) PLUS the
      // Mach6 exo-suit — its suspension (SUSP_) and hub (HUB_), which form the "M" when
      // the wheels turn sideways. But only the tyre (WHEEL_) also ROLLS on its axle; the
      // exo cage/hub must not spin. Tag which part this subtree is so roll hits just the tyre.
      const wm = /^(WHEEL|SUSP|HUB)_(LF|RF|LR|RR)$/i.exec(name);
      if (wm) childWheel = { corner: wm[2].toUpperCase(), pivot: [m[12], m[13], m[14]], roll: /^WHEEL$/i.test(wm[1]) };
      if (/steerwheel$/i.test(name) && !childSteer) {   // the cockpit steering wheel node
        // world-matrix rows are the node's axes (row-vector); keep all three so the
        // render can spin the wheel about the right one (the column / disc normal).
        childSteer = { pivot: [m[12], m[13], m[14]], ax: [[m[0],m[1],m[2]], [m[4],m[5],m[6]], [m[8],m[9],m[10]]] };
        steerWheelData = childSteer;
      }
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
      // Bounding sphere, in the parent node's LOCAL space. Previously skipped, and its
      // absence is why every mesh-based light landed on the world origin: a class-2 mesh
      // carries no transform, so using the parent's origin puts every mesh under a root
      // node at [0,0,0]. Sakura's 143 lamps all resolved to the same point. The sphere
      // centre is where the geometry actually is.
      const bsX = f32(), bsY = f32(), bsZ = f32();
      /* The RADIUS matters as much as the centre, because it says whether the centre means
       * anything. A LIGHT_SERIES names meshes, and some of the meshes it names are not lamp
       * fixtures at all: the T-180 test track's TrackBottom_Light.010 has a 257 m radius —
       * a whole strip of lights authored as one object. Its centre is a point in mid-air
       * inside the structure, which is both nowhere near a lamp and buried behind geometry.
       * A consumer needs the size to tell a fixture from a fixture-farm. */
      const bsR = f32();
      const isRenderable = u8();
      // MESHES = in a LIGHT_SERIES names MESHES, not transform nodes — the two are
      // different classes in a kn5, and collecting only transforms resolved zero lights on
      // every mesh-based track. A class-2 mesh carries no transform of its own, so its
      // world position is its parent's origin. Recorded even when not renderable: an
      // invisible marker mesh is a perfectly normal thing to hang a lamp on.
      //
      // The MATERIAL name comes too, because a series may select by material instead:
      // MATERIALS = StreetLampGlow. Measured across this library the two forms are used
      // about equally, so handling only MESHES leaves half the tracks dark.
      if (wantNodes && name) {
        const mm = materials[materialId];
        // local bounding-sphere centre through the parent's world matrix (row-vector)
        const wx = bsX*m[0] + bsY*m[4] + bsZ*m[8]  + m[12];
        const wy = bsX*m[1] + bsY*m[5] + bsZ*m[9]  + m[13];
        const wz = bsX*m[2] + bsY*m[6] + bsZ*m[10] + m[14];
        // radius is scaled by the parent transform too, or a metre on a scaled node is
        // not a metre. Row-vector basis: the length of the transformed X axis.
        const sc = Math.hypot(m[0], m[1], m[2]) || 1;
        nodes.push({ name, pos: [wx, wy, wz], mat: (mm && mm.name) || "", radius: bsR * sc });
      }
      if (isRenderable !== 0) {
        const mat = materials[materialId];
        if (hidden) {
          logicSkipped++;   // inside an AC_* logic object — the game never draws these
        } else if (lod0Only && lodIn > 0) {
          lodSkipped++;   // lower-detail LOD (renders only past lodIn) — drop it
        } else if (skipTransparent && mat && mat.blendMode === 1) {
          skippedTransparent++;
        } else {
          meshCount++;
          let bag = byMat;                       // body geometry by default
          if (wheel && !isDriveshaft) {          // steerable corner assembly, kept per corner
            let wb = wheelByCorner.get(wheel.corner);
            if (!wb) { wb = { pivot: wheel.pivot, rollByMat: new Map(), staticByMat: new Map() }; wheelByCorner.set(wheel.corner, wb); }
            if (wheel.roll) wb.pivot = wheel.pivot;   // the tyre's own centre is the steer/roll axis
            bag = wheel.roll ? wb.rollByMat : wb.staticByMat;  // tyre rolls; exo cage/hub only steers
          } else if (steer) {                    // the cockpit steering wheel
            bag = steerWheelByMat;
          }
          let g = bag.get(materialId);
          if (!g) { g = { nv: 0, ni: 0, meshes: [] }; bag.set(materialId, g); }
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

    for (let c = 0; c < children; c++) readNode(m, isDriveshaft ? null : childWheel, childSteer, hidden);
  }

  readNode(IDENT, null, null);
  if (off > total) throw kn5ParseError("overran file (" + off + " > " + total + ")");

  // pass 2: bake a material group's meshes into flat, node-transformed arrays
  function bakeGroup(materialId, g) {
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
        nrm[o3] = rx; nrm[o3 + 1] = ry; nrm[o3 + 2] = rz;
        uv[o2] = dv.getFloat32(b + 24, true); uv[o2 + 1] = dv.getFloat32(b + 28, true);
      }
      const iStart = mesh.iStart, ni = mesh.ni;
      for (let i = 0; i < ni; i++) idx[io + i] = dv.getUint16(iStart + i * 2, true) + vertBase;
      io += ni;
      vertBase += nv;
    }
    // meshCount is what decides whether this group can be spatially chunked: a material
    // built from a thousand small meshes splits cleanly, one built from a single circuit-
    // spanning mesh cannot be split at all without cutting triangles.
    return { materialId, pos, nrm, uv, idx, triCount: g.ni / 3, meshCount: g.meshes.length };
  }

  const groups = [];
  let triTotal = 0;
  /* SPATIAL CHUNKING — the thing that makes culling possible at all.
   *
   * Grouping by material alone (which this did) buys batching and destroys locality: one
   * group spans the whole circuit, so it can be neither frustum-culled nor LOD'd, and the
   * renderer had no choice but to draw 100% of the track every frame, three times over.
   * Splitting each material's meshes into world-space cells gives every group its own box.
   *
   * The MESH is the finest split available without cutting triangles, so a material built
   * from one circuit-spanning mesh stays indivisible — measured at 0.1% of the T-180 test
   * track, so the limit is real but not binding.
   *
   * Bounds are computed in a positions-only pre-pass rather than during the bake, because
   * the split has to be decided BEFORE the meshes are merged into one buffer. That is one
   * extra linear read of vertex positions at load and nothing at all per frame. */
  const CHUNK_CELL = (opts && opts.chunkCell) || 200;   // metres

  function meshAABB(mesh) {
    const m = mesh.m;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let v = 0; v < mesh.nv; v++) {
      const b = mesh.vStart + v * 44;
      const x = dv.getFloat32(b, true), y = dv.getFloat32(b + 4, true), z = dv.getFloat32(b + 8, true);
      const wx = x * m[0] + y * m[4] + z * m[8] + m[12];
      const wy = x * m[1] + y * m[5] + z * m[9] + m[13];
      const wz = x * m[2] + y * m[6] + z * m[10] + m[14];
      if (wx < x0) x0 = wx; if (wy < y0) y0 = wy; if (wz < z0) z0 = wz;
      if (wx > x1) x1 = wx; if (wy > y1) y1 = wy; if (wz > z1) z1 = wz;
    }
    return [x0, y0, z0, x1, y1, z1];
  }

  // Cells are XZ only: a circuit is wide and flat relative to its height, so splitting
  // vertically would make many chunks that all pass the same frustum test.
  function chunkOf(meshes) {
    const buckets = new Map();
    for (const mesh of meshes) {
      const b = mesh.aabb || (mesh.aabb = meshAABB(mesh));
      const cx = (b[0] + b[3]) * 0.5, cz = (b[2] + b[5]) * 0.5;
      const key = Math.floor(cx / CHUNK_CELL) + "," + Math.floor(cz / CHUNK_CELL);
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(mesh);
    }
    return [...buckets.values()];
  }

  /* SKYLIGHT PANES — drop them; the opening is meant to be open.
   *
   * Centrifuge's dome openings are filled by geometry on a material named "Transparent"
   * (852,176 tris, NULL diffuse, emissive [1,1,1]) which renders as a pale panel across
   * every hole. The dome SHELL is a different material — `Track`, 2,248,704 tris on
   * centmain.png — so removing this cannot open the dome itself.
   *
   * This was removed, then wrongly reinstated. The faint polygons that appeared alongside
   * it were NOT this geometry: they were the per-vertex lamp bake faceting on the coarse
   * dome (see bakeTrackLamps' BAKE_MIN_LAMPS note). Two separate causes with one look, and
   * blaming this one cost a revert that filled the holes back in.
   *
   * Real alpha-blended meshes never reach here: the track load leaves skipTransparent at
   * its default, so blendMode 1 is dropped at parse. This name has only ever matched opaque
   * geometry named like glass, which on a track is a window. */
  const PANE_NAME = /transparent|glass/i;
  let paneTris = 0;

  for (const [materialId, g] of byMat) {
    const mat = materials[materialId];
    if (mat && PANE_NAME.test(mat.name || "")) {
      for (const mesh of g.meshes) paneTris += mesh.ni / 3;
      continue;
    }
    for (const part of chunkOf(g.meshes)) {
      let nv = 0, ni = 0;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (const mesh of part) {
        nv += mesh.nv; ni += mesh.ni;
        const b = mesh.aabb;
        if (b[0] < x0) x0 = b[0]; if (b[1] < y0) y0 = b[1]; if (b[2] < z0) z0 = b[2];
        if (b[3] > x1) x1 = b[3]; if (b[4] > y1) y1 = b[4]; if (b[5] > z1) z1 = b[5];
      }
      const bg = bakeGroup(materialId, { nv, ni, meshes: part });
      // centre + radius: a sphere test is one dot product per plane and never needs the
      // eight-corner expansion a box does
      bg.aabb = [x0, y0, z0, x1, y1, z1];
      bg.centre = [(x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5];
      bg.radius = 0.5 * Math.hypot(x1 - x0, y1 - y0, z1 - z0);
      /* MONOLITH SPLIT. chunkOf buckets by mesh CENTRE, so a single kilometre-scale mesh
       * lands whole in one cell and becomes an unsplittable chunk — sakura's sktrack.kn5
       * carries Track + Underside as 15 such meshes (855–2,435 m extents, 67k–113k tris
       * each, 1.18M tris = 37.6% of the track), and measured over 24 racing-line cameras
       * the frustum rejected 76% of chunks but only ~60% of triangles because these
       * intersect nearly every view. Splitting at the TRIANGLE level, post-bake (the arrays
       * are already world-space — centroid-bucket the triangles, compact the vertices per
       * cell), turns the floor into ordinary cullable chunks. Guarded by BOTH thresholds so
       * ordinary geometry never pays the copy: a big-but-local grandstand stays whole, and
       * car models (model-space, metres of extent) can never qualify. */
      const wide = Math.max(x1 - x0, z1 - z0);
      /* DISABLED 2026-07-26 06:10 pending investigation — live on sakura the split bought
       * a few fps and cost visible fidelity: the keeper reported tree pop-in and a replay
       * stutter that was not there before. Bounds are exact and triangle totals are
       * byte-identical, so the mechanism is not obviously wrong; suspects are per-frame
       * call count at 935 chunks, an interaction with the far-bake cull, or a confound
       * with the MSAA setting. Machinery and thresholds stay for a session that can
       * measure properly. Infinity is the off switch. */
      const MONOLITH_SPLIT_TRIS = Infinity;
      const parts2 = (bg.triCount > MONOLITH_SPLIT_TRIS && wide > 350) ? splitBakedGroup(bg, 250) : [bg];
      for (const p2 of parts2) { triTotal += p2.triCount; groups.push(p2); }
    }
  }

  // steerable wheels: per corner, split into the rolling tyre (rollGroups) and the
  // static exo cage/hub (staticGroups) — both steer, only rollGroups spins on the axle.
  const wheels = [];
  for (const [corner, wb] of wheelByCorner) {
    const roll = [], stat = [];
    for (const [materialId, g] of wb.rollByMat) { const bg = bakeGroup(materialId, g); triTotal += bg.triCount; roll.push(bg); }
    for (const [materialId, g] of wb.staticByMat) { const bg = bakeGroup(materialId, g); triTotal += bg.triCount; stat.push(bg); }
    wheels.push({ corner, pivot: wb.pivot, rollGroups: roll, staticGroups: stat });
  }

  // cockpit steering wheel: baked groups + its pivot & spin axes
  let steerWheel = null;
  if (steerWheelData && steerWheelByMat.size) {
    const sg = [];
    for (const [materialId, g] of steerWheelByMat) { const bg = bakeGroup(materialId, g); triTotal += bg.triCount; sg.push(bg); }
    steerWheel = { pivot: steerWheelData.pivot, ax: steerWheelData.ax, groups: sg };
  }

  return {
    textures, materials, groups, wheels, steerWheel,
    nodes,   // [{name, pos}] when opts.collectNodes — empty otherwise
    stats: { meshCount, triCount: triTotal, skippedTransparent, lodSkipped, logicSkipped },
  };
}

// Parse a driver kn5: the SKELETON (class-1 node tree with local bind matrices,
// row-vector convention) + SKINNED meshes (class-3: 76-byte verts with 4 bone
// weights + 4 bone indices, plus a per-mesh bone list with inverse-bind matrices).
// At bind pose the raw verts already sit in the driving pose (hands on the wheel);
// animation deforms via boneMat = invBind * nodeWorld (see the driver runtime).
function parseDriver(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  let off = 0;
  const u8 = () => dv.getUint8(off++);
  const i32 = () => { const v = dv.getInt32(off, true); off += 4; return v; };
  const u32 = () => { const v = dv.getUint32(off, true); off += 4; return v; };
  const f32 = () => { const v = dv.getFloat32(off, true); off += 4; return v; };
  const str = () => { const l = u32(); let s = ""; for (let i = 0; i < l; i++) s += String.fromCharCode(dv.getUint8(off + i)); off += l; return s; };
  const mat16 = () => { const t = new Float32Array(16); for (let i = 0; i < 16; i++) t[i] = f32(); return t; };
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3), dv.getUint8(4), dv.getUint8(5));
  if (magic !== "sc6969") throw kn5ParseError("bad magic '" + magic + "'");
  off = 6;
  const version = i32(); if (version > 5) i32();
  const texCount = i32(); const textures = [];
  for (let t = 0; t < texCount; t++) { i32(); const name = str(); const size = u32(); textures.push({ name, blob: new Uint8Array(arrayBuffer, off, size) }); off += size; }
  const matCount = i32(); const materials = [];
  for (let m = 0; m < matCount; m++) {
    const name = str(); const shader = str(); const blendMode = u8(); const alphaTested = u8(); i32();
    const props = i32(); for (let p = 0; p < props; p++) { str(); off += 40; }
    const maps = i32(); let txDiffuse = null;
    for (let q = 0; q < maps; q++) { const sampler = str(); i32(); const texName = str(); if (sampler === "txDiffuse") txDiffuse = texName; }
    materials.push({ name, shader, blendMode, alphaTested, txDiffuse });
  }
  const IDENT = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  const rowMul = (a, b) => { const o = new Float32Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[r*4+c] = a[r*4]*b[c] + a[r*4+1]*b[4+c] + a[r*4+2]*b[8+c] + a[r*4+3]*b[12+c]; return o; };
  const nodes = [], nameIndex = {}, meshes = [];
  function walk(parent, parentWorld) {
    const cls = i32(); const name = str(); const children = i32(); u8();
    const my = nodes.length;
    let local = null;
    if (cls === 1) local = mat16();
    const world = cls === 1 ? rowMul(local, parentWorld) : parentWorld;  // class 2/3 have no own matrix
    nodes.push({ name, parent, local: local || IDENT, world });
    nameIndex[name] = my;
    if (cls === 2) {
      u8(); u8(); u8(); const nv = i32();
      // STATIC mesh (head, helmet, face) — bake into bind-world position so it
      // renders in place. Not skinned; for animation it rides its parent bone.
      const M = world, pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
      for (let v = 0; v < nv; v++) {
        const x = f32(), y = f32(), z = f32(), nx = f32(), ny = f32(), nz = f32();
        pos[v*3] = x*M[0]+y*M[4]+z*M[8]+M[12]; pos[v*3+1] = x*M[1]+y*M[5]+z*M[9]+M[13]; pos[v*3+2] = x*M[2]+y*M[6]+z*M[10]+M[14];
        let rx = nx*M[0]+ny*M[4]+nz*M[8], ry = nx*M[1]+ny*M[5]+nz*M[9], rz = nx*M[2]+ny*M[6]+nz*M[10];
        const l = Math.hypot(rx, ry, rz) || 1; nrm[v*3] = rx/l; nrm[v*3+1] = ry/l; nrm[v*3+2] = rz/l;
        uv[v*2] = f32(); uv[v*2+1] = f32(); off += 12; // tangent
      }
      const ni = i32(); const idx = new Uint32Array(ni);
      for (let i = 0; i < ni; i++) idx[i] = dv.getUint16(off + i*2, true); off += ni * 2;
      const materialId = i32(); u32(); f32(); f32(); off += 16; u8();
      // ownerName/bakeWorld let a re-pose (driver_base_pos.knh) reposition this
      // rigid mesh: seated = bindVert · inv(bakeWorld) · knhWorld[ownerName].
      const ownerName = parent >= 0 ? nodes[parent].name : name;
      meshes.push({ materialId, pos, nrm, uv, idx, skinned: false, ownerName, bakeWorld: M });
    } else if (cls === 3) {
      u8(); u8(); u8();
      const bones = i32(); const boneNames = [], invBind = [];
      for (let b = 0; b < bones; b++) { boneNames.push(str()); invBind.push(mat16()); }
      const nv = i32();
      const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), bw = new Float32Array(nv * 4), bi = new Float32Array(nv * 4);
      for (let v = 0; v < nv; v++) {
        pos[v*3] = f32(); pos[v*3+1] = f32(); pos[v*3+2] = f32();
        nrm[v*3] = f32(); nrm[v*3+1] = f32(); nrm[v*3+2] = f32();
        uv[v*2] = f32(); uv[v*2+1] = f32();
        off += 12; // tangent
        for (let k = 0; k < 4; k++) bw[v*4+k] = f32();
        for (let k = 0; k < 4; k++) bi[v*4+k] = f32();
      }
      const ni = i32(); const idx = new Uint32Array(ni);
      for (let i = 0; i < ni; i++) idx[i] = dv.getUint16(off + i * 2, true); off += ni * 2;
      const materialId = i32(); u32(); off += 8;
      meshes.push({ materialId, pos, nrm, uv, bw, bi, idx, boneNames, invBind, skinned: true });
    } else if (cls !== 1) {
      throw kn5ParseError("unknown node class " + cls, off - 4);
    }
    for (let c = 0; c < children; c++) walk(my, world);
  }
  walk(-1, IDENT);
  return { textures, materials, nodes, nameIndex, meshes };
}

// Parse a .ksanim (v2): per animated node, `frameCount` keyframes of
// position(3f) + quaternion(4f) + scale(3f). Node names match the driver skeleton.
function parseKsanim(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  let off = 0;
  const i32 = () => { const v = dv.getInt32(off, true); off += 4; return v; };
  const f32 = () => { const v = dv.getFloat32(off, true); off += 4; return v; };
  const str = () => { const l = i32(); let s = ""; for (let i = 0; i < l; i++) s += String.fromCharCode(dv.getUint8(off + i)); off += l; return s; };
  const version = i32();
  const nodeCount = i32();
  const nodes = []; let frameCount = 0;
  for (let n = 0; n < nodeCount; n++) {
    const name = str(); const fc = i32(); frameCount = fc;
    const p = new Float32Array(fc * 3), q = new Float32Array(fc * 4), s = new Float32Array(fc * 3);
    for (let f = 0; f < fc; f++) {
      // v2 keyframe layout is ROTATION (quat x,y,z,w) first, then position, then
      // scale — verified against the T-180's steer.ksanim: read this way the quat
      // is unit-norm and the position matches the bone's bind translation.
      q[f*4] = f32(); q[f*4+1] = f32(); q[f*4+2] = f32(); q[f*4+3] = f32();
      p[f*3] = f32(); p[f*3+1] = f32(); p[f*3+2] = f32();
      s[f*3] = f32(); s[f*3+1] = f32(); s[f*3+2] = f32();
    }
    nodes.push({ name, p, q, s });
  }
  return { version, frameCount, nodes };
}

// Parse a car's driver_base_pos.knh — the authored seated pose that repositions
// the shared driver's skeleton so the hands land on THIS car's wheel. It is a
// node tree: [i32 nameLen][name][16 f32 matrix (row-vector, row-major)][i32
// childCount][children...]. Returns { world, local }: name -> car-space matrices.
function parseDriverPose(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  let off = 0;
  const i32 = () => { const v = dv.getInt32(off, true); off += 4; return v; };
  const f32 = () => { const v = dv.getFloat32(off, true); off += 4; return v; };
  const str = () => { const l = i32(); let s = ""; for (let i = 0; i < l; i++) s += String.fromCharCode(dv.getUint8(off + i)); off += l; return s; };
  const IDENT = new Float64Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  const mul = (a, b) => { const o = new Float64Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++)
      o[r*4+c] = a[r*4]*b[c] + a[r*4+1]*b[4+c] + a[r*4+2]*b[8+c] + a[r*4+3]*b[12+c];
    return o; };
  const world = Object.create(null), local = Object.create(null);
  function walk(parentM) {
    const name = str();
    const t = new Float64Array(16);
    for (let i = 0; i < 16; i++) t[i] = f32();
    const w = mul(t, parentM);
    world[name] = w; local[name] = t;
    const nc = i32();
    for (let i = 0; i < nc; i++) walk(w);
  }
  walk(IDENT);
  return { world, local };
}

/* Split one baked group's triangles into XZ cells, compacting vertices per cell.
 *
 * Operates on bakeGroup OUTPUT (world-space typed arrays), not on the kn5 byte stream —
 * that keeps it ~60 lines of plain array work instead of surgery on the mesh walk, and
 * makes it exactly testable: triangle count is preserved, every output vertex is a copy of
 * an input vertex, and each cell's bounds are computed from its actual vertices (tighter
 * than the parent's, which is the point). Returns [bg] untouched when everything lands in
 * one cell, so callers can apply it unconditionally behind their thresholds. */
function splitBakedGroup(bg, cellM) {
  const { pos, nrm, uv, idx } = bg;
  const buckets = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const cx = (pos[a] + pos[b] + pos[c]) / 3;
    const cz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
    const key = Math.floor(cx / cellM) + "," + Math.floor(cz / cellM);
    let arr = buckets.get(key);
    if (!arr) { arr = []; buckets.set(key, arr); }
    arr.push(t);
  }
  if (buckets.size < 2) return [bg];
  const out = [];
  for (const tris of buckets.values()) {
    const remap = new Map();
    const nidx = new Uint32Array(tris.length * 3);
    let vCount = 0;
    for (let i = 0; i < tris.length; i++) {
      for (let k = 0; k < 3; k++) {
        const ov = idx[tris[i] + k];
        let nv = remap.get(ov);
        if (nv === undefined) { nv = vCount++; remap.set(ov, nv); }
        nidx[i * 3 + k] = nv;
      }
    }
    const npos = new Float32Array(vCount * 3);
    const nnrm = new Float32Array(vCount * 3);
    const nuv = new Float32Array(vCount * 2);
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const [ov, nv] of remap) {
      const o3 = ov * 3, n3 = nv * 3;
      const px = pos[o3], py = pos[o3 + 1], pz = pos[o3 + 2];
      npos[n3] = px; npos[n3 + 1] = py; npos[n3 + 2] = pz;
      nnrm[n3] = nrm[o3]; nnrm[n3 + 1] = nrm[o3 + 1]; nnrm[n3 + 2] = nrm[o3 + 2];
      nuv[nv * 2] = uv[ov * 2]; nuv[nv * 2 + 1] = uv[ov * 2 + 1];
      if (px < x0) x0 = px; if (py < y0) y0 = py; if (pz < z0) z0 = pz;
      if (px > x1) x1 = px; if (py > y1) y1 = py; if (pz > z1) z1 = pz;
    }
    out.push({
      materialId: bg.materialId, pos: npos, nrm: nnrm, uv: nuv, idx: nidx,
      triCount: tris.length, meshCount: bg.meshCount,
      aabb: [x0, y0, z0, x1, y1, z1],
      centre: [(x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5],
      radius: 0.5 * Math.hypot(x1 - x0, y1 - y0, z1 - z0),
    });
  }
  return out;
}

/* Is this material foliage — canopy, not timber?
 *
 * The distinction that matters is LEAVES vs TRUNKS, not "anything tree-shaped". A trunk is
 * solid, low-poly and casts an honest shadow that costs nothing; a canopy is hundreds of
 * thousands of alpha-tested triangles whose shadow, in a cascade sized for a whole circuit,
 * arrives as noise. sakura_speedway: 831k foliage triangles of 3.13M, against 76k of trunk
 * — so dropping canopies keeps the tree grounded in its own shadow and loses the mess.
 * `trunk` therefore matches nothing here, deliberately.
 *
 * SHADER FIRST, NAME SECOND, and both are needed. `ksTree` is the author's own declaration
 * and is unambiguous — 463k triangles of sakura's. But its single heaviest foliage material
 * is "Pink leaves" at 322k triangles on a plain `ksPerPixel`, so a shader-only rule would
 * miss the biggest thing on the track. A name-only rule would be guessing at spelling.
 */
const FOLIAGE_SHADER = /^(ksTree|ksGrass|ksFoliage)/i;
const FOLIAGE_NAME = /tree|leaf|leaves|foliage|bush|shrub|branch|sakura|cherry|palm|hedge|plant/i;
function isFoliageMaterial(mat) {
  if (!mat) return false;
  return FOLIAGE_SHADER.test(mat.shader || "") || FOLIAGE_NAME.test(mat.name || "");
}

if (typeof module !== "undefined") module.exports = { extractRoadMesh, extractScene, parseDriver, parseKsanim, parseDriverPose, isFoliageMaterial };
if (typeof window !== "undefined") window.KN5 = { extractRoadMesh, extractScene, parseDriver, parseKsanim, parseDriverPose };
