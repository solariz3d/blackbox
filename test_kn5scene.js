/* test_kn5scene.js — Node validation for kn5.js extractScene().
 *
 * Runs the full visual scene pass on centrifuge + all Miandros kn5s and checks:
 *  - group count == number of materials actually used
 *  - centrifuge total tris >= 3.2M
 *  - normals unit-length within 2% on a 1000-vertex sample per file
 *  - all UVs finite
 *  - all indices < their group's vertex count
 *  - texture blob magics are PNG or DDS
 *  - extractRoadMesh regression guard: meshCount/verts/tris/consumed identical
 *    to the pre-extractScene baselines captured 2026-07-19
 * Prints per-group triCounts + material names for the integrator.
 *
 * Usage: node test_kn5scene.js
 */
"use strict";

const fs = require("fs");
const { extractRoadMesh, extractScene } = require("./kn5.js");

const TRACKS = "G:/SteamLibrary/steamapps/common/assettocorsa/content/tracks";
const FILES = [
  TRACKS + "/centrifuge/centrifuge.kn5",
  TRACKS + "/Miandros/track.kn5",
  TRACKS + "/Miandros/env.kn5",
  TRACKS + "/Miandros/stadium.kn5",
  TRACKS + "/Miandros/support.kn5",
];

// extractRoadMesh outputs captured BEFORE extractScene was added (regression guard).
const ROAD_BASELINE = {
  "centrifuge/centrifuge.kn5": { meshCount: 97, meshTotal: 144, verts: 10268733, tris: 9600102, consumed: 179823746 },
  "Miandros/track.kn5":        { meshCount: 70, meshTotal: 125, verts: 1772886,  tris: 1418976, consumed: 43273299 },
  "Miandros/env.kn5":          { meshCount: 0,  meshTotal: 80,  verts: 0,        tris: 0,       consumed: 64167922 },
  "Miandros/stadium.kn5":      { meshCount: 0,  meshTotal: 43,  verts: 0,        tris: 0,       consumed: 116983016 },
  "Miandros/support.kn5":      { meshCount: 0,  meshTotal: 338, verts: 0,        tris: 0,       consumed: 12458695 },
};

let failures = 0;
function check(ok, label) {
  if (ok) { console.log("  PASS  " + label); }
  else { failures++; console.log("  FAIL  " + label); }
}

function mb(n) { return (n / (1024 * 1024)).toFixed(1) + " MB"; }

function texMagic(blob) {
  if (blob.length >= 8 &&
      blob[0] === 0x89 && blob[1] === 0x50 && blob[2] === 0x4e && blob[3] === 0x47) return "PNG";
  if (blob.length >= 4 &&
      blob[0] === 0x44 && blob[1] === 0x44 && blob[2] === 0x53 && blob[3] === 0x20) return "DDS";
  // kn5 embeds raw image files verbatim; JPEG occurs in the wild (stadium.kn5)
  if (blob.length >= 3 &&
      blob[0] === 0xff && blob[1] === 0xd8 && blob[2] === 0xff) return "JPG";
  return "?" + Array.from(blob.subarray(0, 4)).map(b => b.toString(16).padStart(2, "0")).join("");
}

for (const file of FILES) {
  const shortName = file.split("/").slice(-2).join("/");
  console.log("\n=== " + shortName + " ===");
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  console.log("file: " + mb(ab.byteLength));

  // --- regression guard: extractRoadMesh unchanged ---
  const t0 = Date.now();
  const road = extractRoadMesh(ab);
  const roadMs = Date.now() - t0;
  const base = ROAD_BASELINE[shortName];
  console.log("extractRoadMesh: meshCount=" + road.meshCount + " meshTotal=" + road.meshTotal +
              " verts.length=" + road.verts.length + " tris.length=" + road.tris.length +
              " consumed=" + road.consumed + " (" + roadMs + " ms)");
  check(road.meshCount === base.meshCount && road.meshTotal === base.meshTotal &&
        road.verts.length === base.verts && road.tris.length === base.tris &&
        road.consumed === base.consumed && road.consumed === road.total,
        "extractRoadMesh matches pre-change baseline");

  // --- scene pass ---
  const memBefore = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
  const t1 = Date.now();
  const scene = extractScene(ab);
  const sceneMs = Date.now() - t1;
  const memAfter = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;

  let sceneBytes = 0, totalVerts = 0;
  for (const g of scene.groups) {
    sceneBytes += g.pos.byteLength + g.nrm.byteLength + g.uv.byteLength + g.idx.byteLength;
    totalVerts += g.pos.length / 3;
  }
  console.log("extractScene: " + sceneMs + " ms, " + scene.stats.meshCount + " meshes, " +
              scene.stats.triCount + " tris, " + totalVerts + " verts, " +
              scene.stats.skippedTransparent + " transparent skipped");
  console.log("scene arrays: " + mb(sceneBytes) + " (process delta " + mb(memAfter - memBefore) + ")");
  console.log("textures: " + scene.textures.length + ", materials: " + scene.materials.length +
              ", groups: " + scene.groups.length);

  // group count == materials actually used
  const usedMats = new Set(scene.groups.map(g => g.materialId));
  check(scene.groups.length === usedMats.size, "group count (" + scene.groups.length +
        ") == distinct materials used (" + usedMats.size + ")");
  check(scene.groups.every(g => g.materialId >= 0 && g.materialId < scene.materials.length),
        "all group materialIds in materials range");

  // centrifuge triangle floor
  if (shortName === "centrifuge/centrifuge.kn5") {
    check(scene.stats.triCount >= 3200000, "centrifuge triCount " + scene.stats.triCount + " >= 3.2M");
  }

  // stats.triCount consistent with groups
  let groupTris = 0;
  for (const g of scene.groups) groupTris += g.triCount;
  check(groupTris === scene.stats.triCount, "stats.triCount == sum of group triCounts");

  // normals unit-length within 2% on a 1000-vertex sample (spread across all groups)
  if (totalVerts > 0) {
    let sampled = 0, badNrm = 0, worst = 0;
    const step = Math.max(1, Math.floor(totalVerts / 1000));
    let globalV = 0;
    for (const g of scene.groups) {
      const nvg = g.pos.length / 3;
      for (let v = globalV % step === 0 ? 0 : step - (globalV % step); v < nvg; v += step) {
        const i = v * 3;
        const len = Math.hypot(g.nrm[i], g.nrm[i + 1], g.nrm[i + 2]);
        const dev = Math.abs(len - 1);
        if (dev > worst) worst = dev;
        if (dev > 0.02) badNrm++;
        sampled++;
      }
      globalV += nvg;
    }
    check(badNrm === 0, "normals unit-length within 2% (" + sampled + " sampled, worst dev " +
          (worst * 100).toFixed(3) + "%)");
  }

  // all UVs finite; all indices < group vertex count (full scan)
  let uvBad = 0, idxBad = 0;
  for (const g of scene.groups) {
    for (let i = 0; i < g.uv.length; i++) if (!Number.isFinite(g.uv[i])) uvBad++;
    const nvg = g.pos.length / 3;
    for (let i = 0; i < g.idx.length; i++) if (g.idx[i] >= nvg) idxBad++;
  }
  check(uvBad === 0, "all UVs finite (" + uvBad + " bad)");
  check(idxBad === 0, "all indices < group vertex count (" + idxBad + " bad)");

  // texture blob magics
  const magicCounts = {};
  let unknownMagic = 0;
  for (const t of scene.textures) {
    const m = texMagic(t.blob);
    magicCounts[m] = (magicCounts[m] || 0) + 1;
    if (m !== "PNG" && m !== "DDS" && m !== "JPG") { unknownMagic++; console.log("    unknown magic: " + t.name + " -> " + m); }
  }
  check(unknownMagic === 0, "texture magics all known image formats " + JSON.stringify(magicCounts));

  // txDiffuse names resolve to embedded textures (informational + sanity)
  const texNames = new Set(scene.textures.map(t => t.name));
  const usedWithDiffuse = scene.groups.filter(g => scene.materials[g.materialId].txDiffuse !== null);
  const unresolved = usedWithDiffuse.filter(g => !texNames.has(scene.materials[g.materialId].txDiffuse));
  check(unresolved.length === 0, "every used material's txDiffuse resolves to an embedded texture (" +
        usedWithDiffuse.length + "/" + scene.groups.length + " groups textured)");

  // per-group draw-call table for the integrator
  console.log("  --- draw calls (groups sorted by triCount) ---");
  const sorted = scene.groups.slice().sort((a, b) => b.triCount - a.triCount);
  for (const g of sorted) {
    const m = scene.materials[g.materialId];
    console.log("    mat " + String(g.materialId).padStart(3) + "  " +
                String(g.triCount).padStart(8) + " tris  " +
                m.name + "  [" + m.shader + " blend=" + m.blendMode +
                " at=" + m.alphaTested + "]  tx=" + (m.txDiffuse || "-"));
  }
}

console.log("\n" + (failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"));
process.exit(failures === 0 ? 0 : 1);
