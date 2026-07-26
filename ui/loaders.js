/* loaders.js — getting data in: track and car loading, the replay parse, the Tauri bridge and the native gallery.
 *
 * Extracted verbatim from index.html, which had grown to 6,113 lines of inline script in a
 * single block. Nothing here was rewritten in the move: the point of the split is that
 * behaviour is unchanged and the code becomes findable.
 *
 * A CLASSIC script, not a module, matching every other file in ui/. These all share one
 * global scope and are loaded in dependency order by index.html — see the note above the
 * script tags there. Function declarations hoist only within their own file, so anything
 * running at TOP LEVEL here may only read bindings from a file loaded EARLIER; function
 * bodies are free to reference anything, because they run after every file has parsed.
 */
"use strict";

async function maybeAutoLoadTrack(trackName) {
  if (!trackName || sceneGroups || bufs.trackIdxN) return;
  // native app: fetch the track's kn5 files straight from the Steam AC install
  if (inTauri) {
    try {
      chipTrack().textContent = `finding ${trackName} in your AC install…`;
      // pass the LAYOUT. A multi-layout track keeps every layout's models in one folder,
      // so without this the loader takes all of them — on eagleton that is the long and
      // short circuits stacked through each other, and the car drives through a jumble.
      const files = await tinvoke("find_track", { name: trackName, config: (replay && replay.trackConfig) || null });
      if (!files || !files.length) {
        chipTrack().textContent = `track "${trackName}" not found in your Steam AC install — load a kn5 manually`;
        return;
      }
      chipTrack().textContent = `loading ${trackName} (${files.length} kn5)…`;
      const items = [];
      for (const f of files) {
        const ab = await tinvoke("read_file", { path: f.path });
        items.push({ name: f.name, ab });
      }
      await loadTrackBuffers(items);
    } catch (e) {
      chipTrack().textContent = "track auto-load failed: " + e;
    }
    return;
  }
  const dir = await idbGet("tracksDir");
  if (!dir) {
    chipTrack().textContent = `NO TRACK LOADED — click "tracks folder…" once (pick ...\\assettocorsa\\content\\tracks) and replays will load their track automatically.`;
    return;
  }
  try {
    let perm = await dir.queryPermission({ mode: "read" });
    if (perm !== "granted") perm = await dir.requestPermission({ mode: "read" });
    if (perm !== "granted") return;
    let found = null;
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "directory" && name.toLowerCase() === trackName.toLowerCase()) { found = handle; break; }
    }
    if (!found) {
      chipTrack().textContent = `track folder "${trackName}" not found in the saved tracks folder — load the kn5 manually`;
      return;
    }
    const items = [];
    for await (const [name, handle] of found.entries()) {
      if (handle.kind === "file" && /\.kn5$/i.test(name)) {
        items.push({ name, ab: await (await handle.getFile()).arrayBuffer() });
      }
    }
    if (!items.length) {
      chipTrack().textContent = `no .kn5 files in "${trackName}" — load manually`;
      return;
    }
    chipTrack().textContent = `auto-loading ${trackName} (${items.length} kn5)…`;
    await loadTrackBuffers(items);
  } catch (e) {
    chipTrack().textContent = "track auto-load failed: " + e.message;
  }
}

async function makeSceneTexture(blob, name) {
  const fmt = KN5Tex.sniffFormat(blob);
  if (fmt === "dds") {
    const parsed = KN5Tex.parseDDS(blob);
    // placeholder textures (NULL.dds etc.): tiny and near-black would kill the
    // material — probe and substitute a neutral surface grey
    if (parsed.width <= 4 && parsed.height <= 4) {
      let rgba;
      if (parsed.format === "rgba8") rgba = parsed.mips[0].data;
      else rgba = KN5Tex.decodeDXT(parsed.mips[0], parsed.format);
      let lum = 0;
      for (let i = 0; i < rgba.length; i += 4) lum += rgba[i] + rgba[i + 1] + rgba[i + 2];
      lum /= (rgba.length / 4) * 3;
      if (lum < 24) return makeFallbackTexture([120, 124, 132]);
    }
    return KN5Tex.uploadTexture(gl, parsed, extS3TC);
  }
  // png / jpg / unknown: let the browser decode
  const bmp = await createImageBitmap(new Blob([blob]));
  return uploadImageTexture(bmp);
}

async function loadTrackBuffers(items) { // items: [{name, ab}]
  const fi = document.getElementById("fileinfo");
  const prev = fi.textContent;
  try {
    if (!extUint) throw new Error("browser lacks uint index support for big track meshes");
    const t0 = performance.now();
    let triCount = 0;
    const allGroups = [];
    const treeHarvest = [];   // remaster instances, accumulated per kn5
    const roadChunks = []; // {verts, tris} per file for the edge index
    const collGroups = []; // {pos, idx} of solid meshes for the world collider

    /* Road-key experiment REVERTED — see docs/TRACK_ROAD_DETECTION.md.
     * Restricting the mesh-name match to the track's own surfaces.ini keys recovered
     * trento-bondone but broke centrifuge and the T-180 test track, which the built-in
     * ROAD|KERB|PIT|RUNOFF pattern already handled. Left as the default until the real
     * naming rule is understood. */
    const roadKeyPattern = null;

    const lightNodes = [];   // {name, pos, mat} across every model, for LIGHT_SERIES
    for (const item of items) {
      try {
        const scene = KN5.extractScene(item.ab, { collectNodes: true });
        // the remaster placement harvest — per scene, additive across the track's kn5s;
        // ~0.5 s on sakura's trees.kn5, near-zero on foliage-free files
        if (window.Remaster && isGL2) {
          try { treeHarvest.push(...Remaster.harvestTrees(scene)); }
          catch (e) { console.warn("tree harvest failed:", e); }
        }
        if (scene.nodes && scene.nodes.length) lightNodes.push(...scene.nodes);
        const texByName = {};
        for (const t of scene.textures) texByName[t.name] = t;
        for (const g of scene.groups) {
          const mat = scene.materials[g.materialId] || {};
          /* NAME-BASED MATERIAL RULES ON A TRACK: DON'T. Three attempts died here.
           *
           * Centrifuge's dome openings sit on a material named "Transparent". It was drawn
           * blended at a hardcoded alpha 0.16 because the NAME matched /transparent|glass/,
           * which painted a milky white film over every opening. Trusting the file's
           * blendMode 0 instead filled them with plate. Dropping the material entirely
           * deleted 852,176 triangles across 25 chunks — 26% of the track, including chunks
           * 1033 m tall that are dome STRUCTURE, not glazing — and exposed everything behind
           * them, which is where the stray shapes came from.
           *
           * The track says what it is, in its own CSP config, and none of the three guesses
           * were close:
           *     [SHADER_REPLACEMENT] MATERIALS = Light, Transparent  CULL_MODE = DOUBLESIDED
           *     [MATERIAL_ADJUSTMENT] CONDITION = NIGHT_SHARP  MATERIALS = Transparent
           *                           ksEmissive = 10,10,10,12   (off: 1,1,1)
           * It is a DOUBLE-SIDED EMISSIVE surface — the openings are meant to glow, and are
           * the light source. Not glass, not a hole, not a wall.
           *
           * So the material name buys nothing here and the CSP config buys everything.
           * Reading MATERIAL_ADJUSTMENT / SHADER_REPLACEMENT is the real fix; until then
           * these render as ordinary opaque geometry, which is at least what the kn5 says
           * and leaves the structure intact. */
          /* The emissive MASK, when the material declares one. Uploaded on its own texture
           * unit rather than folded into the diffuse, because the two are sampled with the
           * same UVs but mean different things: one is the surface, one is where the light
           * is. A failed decode falls back to no mask rather than to a fallback texture —
           * a grey 1x1 in the mask slot would make the whole material glow uniformly,
           * which is the exact failure the mask exists to prevent. */
          let emisTex = null;
          if (mat.emissive && mat.txEmissive) {
            try {
              const ee = texByName[mat.txEmissive];
              if (ee) emisTex = await makeSceneTexture(ee.blob, ee.name);
            } catch (e) { emisTex = null; }
          }
          // Built by the SAME factory as the car groups — see makeGroup's birth
          // certificate for the 2026-07-25 bug that mandates it. Track-only extras ride
          // in `extra`; everything else gets the shared defaults.
          const grp = await makeGroup(g, mat, texByName, [120, 124, 132], {
            emissive: mat.emissive || null, emisTex,
            spec: mat.specular || 0, specExp: mat.specExp || 10,
            // alpha-tested canopy only — the measured fill problem. Trunks, opaque canopy
            // (the four giant landmark sakuras) and everything else keep drawing.
            remastered: !!(window.Remaster && isGL2 && Remaster.isSuppressedMaterial(mat)),
          });
          allGroups.push(grp);
          if (!grp.translucent) collGroups.push({ pos: g.pos, idx: g.idx }); // solid → collider
          triCount += g.triCount;
        }
      } catch (sceneErr) {
        console.warn("scene path failed for " + item.name + ":", sceneErr);
      }
      try {
        // Match this TRACK's own drivable surface keys, not the Kunos defaults. AC names
        // a physical mesh <digit><SURFACE_KEY> and resolves the key in surfaces.ini, and
        // real circuits define their own (spa: ASPH-SPA_BLACK, monza: MONZA-ASPH). With
        // the hardcoded ROAD|KERB|PIT|RUNOFF, 15 tracks (of a then-62 library; now 32 — see docs/TRACK_ROAD_DETECTION.md) found no road at
        // all — spa, monza, mugello, zandvoort among them — so smoke never collided and
        // the edge readout never worked there.
        const road = KN5.extractRoadMesh(item.ab, roadKeyPattern);
        if (road.tris.length) roadChunks.push(road);
      } catch (e) { console.warn("road extract failed for " + item.name + ":", e); }
    }

    /* The track's own lamps. Resolved once here, not per frame: a LIGHT_SERIES has to be
     * matched against every node in every model, and the answer never changes while the
     * track is loaded. Both config sources are passed — the track's own and CSP's — since
     * for several circuits only the latter has any. */
    trackLights = [];
    if (inTauri && replay && replay.track && window.TrackLights) {
      try {
        const cfgs = await tinvoke("track_light_configs", { name: replay.track });
        if (cfgs && cfgs.length) {
          trackLights = TrackLights.resolveTrackLights(cfgs, lightNodes);
          if (trackLights.length) {
            console.log(`track lights: ${trackLights.length} (${trackLights.filter(l => l.night).length} night) from ${cfgs.length} config(s)`);
          }
        }
      } catch (e) { console.warn("track lights unavailable:", e); }
    }

    if (allGroups.length) {
      allGroups.sort((a, b) => (a.translucent ? 1 : 0) - (b.translucent ? 1 : 0));
      // whole-scene bounds, before the bake releases anything — the shadow reach needs them
      { let x0 = 1e18, y0 = 1e18, z0 = 1e18, x1 = -1e18, y1 = -1e18, z1 = -1e18, any = false;
        for (const g of allGroups) {
          if (!g.centre || g.radius === undefined) continue;
          any = true;
          if (g.centre[0] - g.radius < x0) x0 = g.centre[0] - g.radius;
          if (g.centre[1] - g.radius < y0) y0 = g.centre[1] - g.radius;
          if (g.centre[2] - g.radius < z0) z0 = g.centre[2] - g.radius;
          if (g.centre[0] + g.radius > x1) x1 = g.centre[0] + g.radius;
          if (g.centre[1] + g.radius > y1) y1 = g.centre[1] + g.radius;
          if (g.centre[2] + g.radius > z1) z1 = g.centre[2] + g.radius;
        }
        sceneAABB = any ? { x0, y0, z0, x1, y1, z1 } : null; }
      bakeTrackLamps(allGroups);
      buildTreeSys(treeHarvest, allGroups);
      sceneGroups = allGroups;
    } else if (roadChunks.length) {
      // bare fallback from the first road chunk set
      const road = roadChunks[0];
      if (!bufs.trackPos) bufs.trackPos = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.trackPos);
      gl.bufferData(gl.ARRAY_BUFFER, road.verts, gl.STATIC_DRAW);
      if (!bufs.trackIdx) bufs.trackIdx = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufs.trackIdx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, road.tris, gl.STATIC_DRAW);
      bufs.trackIdxN = road.tris.length;
      triCount = road.tris.length / 3;
    } else {
      throw new Error("no renderable meshes found in " + items.map(i => i.name).join(", "));
    }

    if (ex) buildGeometry(); // ribbon shrinks to car width now that the road is real
    document.getElementById("chipTrack").classList.add("hidden");
    fi.textContent = prev + ` · track: ${items.length} kn5, ${(triCount).toLocaleString()} tris${allGroups.length ? " textured" : " (bare)"} (${((performance.now() - t0) / 1000).toFixed(1)}s) · building edge index…`;

    setTimeout(() => {
      try {
        // merge road chunks for one edge index
        let nv = 0, nt = 0;
        for (const r of roadChunks) { nv += r.verts.length; nt += r.tris.length; }
        const verts = new Float32Array(nv);
        const tris = new Uint32Array(nt);
        let vo = 0, to = 0, base = 0;
        for (const r of roadChunks) {
          verts.set(r.verts, vo);
          for (let i = 0; i < r.tris.length; i++) tris[to + i] = r.tris[i] + base;
          base += r.verts.length / 3; vo += r.verts.length; to += r.tris.length;
        }
        edgeIndex = RoadEdge.buildEdgeIndex(verts, tris);
        // track world bounds → sizes the static whole-track shadow bake; reset forces a re-bake
        { let a = 1e18, b = 1e18, c = 1e18, d = -1e18, e = -1e18, f = -1e18;
          for (let v = 0; v < verts.length; v += 3) { const x = verts[v], y = verts[v+1], z = verts[v+2];
            if (x<a)a=x; if(x>d)d=x; if(y<b)b=y; if(y>e)e=y; if(z<c)c=z; if(z>f)f=z; }
          trackAABB = { cx:(a+d)/2, cy:(b+e)/2, cz:(c+f)/2, radius: 0.5*Math.hypot(d-a, e-b, f-c) };
          staticBakeTime = null; }
        // world collider: full solid scene if we have it, else the road mesh
        try {
          worldColl = collGroups.length ? buildWorldColliderFromGroups(collGroups)
                                        : buildWorldCollider(verts, tris);
          // smoke collides with the TRACK SURFACE ONLY (the road mesh), not the environment
          // (grandstands/props/buildings) — keeps the per-particle queries cheap on detailed
          // tracks. verts/tris here are the merged road mesh.
          smokeColl = (tris && tris.length) ? buildWorldCollider(verts, tris, 3, 4096)
                    : (collGroups.length ? buildWorldColliderFromGroups(collGroups, 3, 4096) : null);
        } catch (e) { worldColl = null; smokeColl = null; console.warn("collider build failed:", e); }
        fi.textContent = fi.textContent.replace(" · building edge index…",
          ` · ${edgeIndex.count.toLocaleString()} edge segments${worldColl ? ", " + worldColl.count.toLocaleString() + " collider tris" : ""}`);
      } catch (err) {
        fi.textContent = fi.textContent.replace(" · building edge index…", " · edge index failed");
      }
    }, 60);
  } catch (err) {
    fi.textContent = prev;
    alert("kn5 load failed: " + err.message);
  }
}

function loadTrack(file) {
  file.arrayBuffer().then(ab => loadTrackBuffers([{ name: file.name, ab }]));
}

// clear the prior track's scene + GPU buffers before loading another, or they
// stack (bug: open track A, then B → both rendered at once)
function resetTrackScene() {
  if (sceneGroups) {
    for (const g of sceneGroups) {
      gl.deleteBuffer(g.posBuf); gl.deleteBuffer(g.nrmBuf);
      gl.deleteBuffer(g.uvBuf); gl.deleteBuffer(g.idxBuf);
      if (g.lampBuf) gl.deleteBuffer(g.lampBuf);   // the baked lamp light, one per chunk
      if (g.tex) gl.deleteTexture(g.tex);
      // the emissive mask was the one GPU resource this loop forgot — every track swap
      // leaked them until the 2026-07-26 structure audit counted the deletion sites
      if (g.emisTex) gl.deleteTexture(g.emisTex);
    }
    sceneGroups = null;
  }
  teardownTreeSys();   // VAOs, mesh + instance buffers, atlases — one site, complete
  sceneAABB = null;   // bounds belong to the track that was unloaded, not the next one
  trackLights = [];   // lamps belong to the track that was unloaded, not the next one
  lampsBaked = false;
  if (carGroups) {
    for (const g of carGroups) {
      gl.deleteBuffer(g.posBuf); gl.deleteBuffer(g.nrmBuf);
      gl.deleteBuffer(g.uvBuf); gl.deleteBuffer(g.idxBuf);
      if (g.tex) gl.deleteTexture(g.tex);
    }
    carGroups = null;
  }
  if (carGlass) {
    for (const g of carGlass) { gl.deleteBuffer(g.posBuf); gl.deleteBuffer(g.nrmBuf); gl.deleteBuffer(g.uvBuf); gl.deleteBuffer(g.idxBuf); if (g.tex) gl.deleteTexture(g.tex); }
    carGlass = null;
  }
  carLights = null; carNozzle = null;
  if (carWheels) {
    for (const w of carWheels) for (const g of [...w.rollGroups, ...w.staticGroups]) {
      gl.deleteBuffer(g.posBuf); gl.deleteBuffer(g.nrmBuf);
      gl.deleteBuffer(g.uvBuf); gl.deleteBuffer(g.idxBuf);
      if (g.tex) gl.deleteTexture(g.tex);
    }
    carWheels = null;
  }
  if (carSteerWheel) {
    for (const g of carSteerWheel.groups) {
      gl.deleteBuffer(g.posBuf); gl.deleteBuffer(g.nrmBuf);
      gl.deleteBuffer(g.uvBuf); gl.deleteBuffer(g.idxBuf);
      if (g.tex) gl.deleteTexture(g.tex);
    }
    carSteerWheel = null;
  }
  if (carDriver) {
    for (const g of [...carDriver.headGroups, ...carDriver.skinned.map(s => s.grp)]) {
      gl.deleteBuffer(g.posBuf); gl.deleteBuffer(g.nrmBuf);
      gl.deleteBuffer(g.uvBuf); gl.deleteBuffer(g.idxBuf);
      if (g.tex) gl.deleteTexture(g.tex);
    }
    carDriver = null;
  }
  bufs.trackIdxN = 0;
  edgeIndex = null;
  worldColl = null; smokeColl = null;
  const ct = document.getElementById("chipTrack");
  if (ct) ct.classList.remove("hidden");
}

/* BAKE THE TRACK'S LAMP LIGHTING INTO ITS VERTICES.
 *
 * Measured, and this is the whole reason it exists: with the lamps on, the T-180 test track
 * loses about 100 fps — roughly 3 ms of a 4.17 ms budget at 240 Hz, and more than the whole
 * budget at 360. The cause is not the lamps' maths but their COUNT: the fragment shader
 * walks 60 slots for every one of ~3.9 million pixels, which is ~230 million iterations a
 * frame. Nothing that makes each iteration cheaper fixes an arithmetic problem that size,
 * and neither does culling geometry — a culled chunk was never going to be shaded anyway.
 *
 * What makes it removable is that NOTHING HERE MOVES. The lamps are fixed to the track, the
 * track is fixed to the world, and a replay never changes either. So a track vertex's lamp
 * illumination is a constant, and a constant belongs in a buffer, not in a per-pixel loop.
 * A live game cannot do this — its world and its lights are not knowable in advance. A
 * replay viewer can, and that is the difference the whole optimisation rests on.
 *
 * Cost: one pass at load. The chunk bounds built for frustum culling pay off a second time
 * here — a chunk only tests lamps whose range reaches its bounding sphere, so the bake is a
 * few million operations rather than vertices x 60.
 *
 * NIGHT-GATED LAMPS ONLY. Their gate is a single scalar (nightF) applied at draw time, so
 * baking at full strength and scaling later is exact, and the time slider keeps working.
 * Always-on lamps are deliberately left to the live loop: there is no scalar that makes
 * them correct, they are rare, and leaving them live costs a loop that is now nearly empty.
 */
function bakeTrackLamps(groups) {
  for (const g of groups) { g.lampBuf = null; }
  const lamps = trackLights.filter(L => L.night);
  lampsBaked = false;
  /* ONLY BAKE WHEN IT PAYS, because baking is not free in looks.
   *
   * The bake stores one colour PER VERTEX and lets the rasteriser interpolate it. On dense
   * geometry that is invisible. On a coarse mesh it is not: centrifuge's dome is a faceted
   * sphere, and a per-vertex value across a facet metres wide renders as a flat polygon of
   * slightly different brightness — faint hexagons in fixed spots, visible from inside,
   * receiving shadows like any other surface, and impossible to remove by deleting meshes
   * because they are not a mesh. Reported as "you put them there", which was exactly right;
   * five attempts went into hunting geometry that the renderer had painted on.
   *
   * The bake exists to delete a 60-lamp per-fragment loop on the T-180 test track, roughly
   * 230M iterations a frame. Centrifuge declares FIVE lamps. Five in the live loop cost
   * nothing measurable, so there is no gain here to trade an artifact for.
   *
   * A threshold rather than a switch: above it the loop dominates and faceting is worth
   * accepting; below it the loop is noise and it is not. */
  const BAKE_MIN_LAMPS = 24;
  if (lamps.length < BAKE_MIN_LAMPS) {
    for (const g of groups) { g.pos = g.nrm = null; }
    console.log(`[lamps] ${lamps.length} night lamp(s) — below ${BAKE_MIN_LAMPS}, keeping the live loop (no vertex bake)`);
    return;
  }

  let litVerts = 0, pairs = 0;
  lampsBaked = true;
  for (const g of groups) {
    const pos = g.pos, nrm = g.nrm;
    if (!pos || !nrm) continue;
    const nV = pos.length / 3;
    const out = new Float32Array(nV * 3);

    // only the lamps that can reach this chunk at all
    const near = [];
    if (g.centre && g.radius !== undefined) {
      for (const L of lamps) {
        const dx = L.pos[0] - g.centre[0], dy = L.pos[1] - g.centre[1], dz = L.pos[2] - g.centre[2];
        const reach = L.range + g.radius;
        if (dx * dx + dy * dy + dz * dz <= reach * reach) near.push(L);
      }
    } else near.push(...lamps);
    pairs += near.length;

    for (const L of near) {
      // same clamp-then-gain as the live path, so baked and live lamps match in brightness
      const amp = Math.min(L.intensity, TRACK_LIGHT_MAX_INTENSITY) * TRACK_LIGHT_GAIN;
      if (amp <= 0.002) continue;
      const cr = L.color[0] * amp, cg = L.color[1] * amp, cb = L.color[2] * amp;
      const range = L.range, r2 = range * range;
      const dl = Math.hypot(L.dir[0], L.dir[1], L.dir[2]) || 1;
      const dxn = L.dir[0] / dl, dyn = L.dir[1] / dl, dzn = L.dir[2] / dl;
      const cosHalf = L.spotUsable ? Math.cos(Math.min(359, L.spot) * 0.5 * Math.PI / 180) : -1;
      const inner = cosHalf + (1 - cosHalf) * 0.35;

      for (let v = 0; v < nV; v++) {
        const o = v * 3;
        const tx = L.pos[0] - pos[o], ty = L.pos[1] - pos[o + 1], tz = L.pos[2] - pos[o + 2];
        const d2 = tx * tx + ty * ty + tz * tz;
        if (d2 > r2) continue;
        const d = Math.sqrt(d2) || 1e-3;
        const lx = tx / d, ly = ty / d, lz = tz / d;
        const ndl = nrm[o] * lx + nrm[o + 1] * ly + nrm[o + 2] * lz;
        if (ndl <= 0) continue;                       // a face turned away is not lit
        let att = 1 - d / range; att *= att;          // zero AT the range, as the shader does
        let cone = 1;
        if (cosHalf > -0.5) {
          const c = -(lx * dxn + ly * dyn + lz * dzn);
          let t = (c - cosHalf) / Math.max(1e-4, inner - cosHalf);
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          cone = t * t * (3 - 2 * t);                 // smoothstep, matching the shader
          if (cone <= 0) continue;
        }
        const k = ndl * att * cone;
        out[o] += cr * k; out[o + 1] += cg * k; out[o + 2] += cb * k;
      }
    }

    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, out, gl.STATIC_DRAW);
    g.lampBuf = b;
    litVerts += nV;
    g.pos = g.nrm = null;   // released: ~22 MB on a big track, and nothing reads them again
  }
  console.log(`[lamps] baked ${lamps.length} night lamp(s) into ${litVerts} vertices ` +
              `(${pairs} chunk-lamp pairs after bounds rejection)`);
}

// upload a list of baked kn5 mesh groups to the GPU

/* ============== THE ENVIRONMENT REMASTER — build, draw, tear down ==============
 * treeSys is not a group and never enters sceneGroups. Instances are packed 32 B each
 * (aInstA = xyz + height scale, aInstB = yaw + tintLerp + brightness + radius scale),
 * sorted by (type, 300 m cell) so each cell is one contiguous instanced draw with its own
 * bounding sphere for per-pass frustum culling. All instanced pointer/divisor state lives
 * in per-type VAOs — the rest of the renderer runs on the default VAO and never sees a
 * divisor (the leak the VAO design exists to prevent). */
let _treeTime = 0;   // one clock per frame, shared by lit + depth so the dapple sways WITH the canopy

function teardownTreeSys() {
  if (!treeSys) return;
  for (const ty of treeSys.types) {
    if (!ty) continue;
    gl.deleteVertexArray(ty.vao);
    gl.deleteBuffer(ty.vbMesh); gl.deleteBuffer(ty.vbNrm); gl.deleteBuffer(ty.vbUV); gl.deleteBuffer(ty.vbIdx);
    gl.deleteTexture(ty.tex);
  }
  gl.deleteBuffer(treeSys.instBuf);
  treeSys = null;
  updateRemasterUI();
}

function buildTreeSys(harvest, groups) {
  teardownTreeSys();
  if (!window.Remaster || !isGL2 || !progInstLit) { updateRemasterUI(); return; }
  /* only trees whose canopy came mostly from SUPPRESSED materials — an instance is worth
   * drawing only when it replaces something that stops drawing. The four giants keep
   * their originals (opaque, exonerated, the author's signature pieces). */
  const worth = harvest.filter(t => !t.giant && t.suppressedFrac > 0.5);
  if (!worth.length) { updateRemasterUI(); return; }
  const CELL = 300;
  const byKey = new Map();
  for (const t of worth) {
    const type = t.type === "sakura-pink" ? 1 : 0;
    const k = type + ":" + Math.floor(t.x / CELL) + ":" + Math.floor(t.z / CELL);
    let a = byKey.get(k); if (!a) { a = { type, trees: [] }; byKey.set(k, a); }
    a.trees.push(t);
  }
  const runsByType = [[], []];
  const data = new Float32Array(worth.length * 8);
  let off = 0;
  for (const [k, cell] of [...byKey.entries()].sort()) {
    const start = off;
    let x0 = 1/0, y0 = 1/0, z0 = 1/0, x1 = -1/0, y1 = -1/0, z1 = -1/0;
    for (const t of cell.trees) {
      const rnd = Remaster.mulberry32(Math.floor(t.tintSeed * 0xffffffff));
      /* height/1.3: the unit mesh's cards top out at y = 1.3, so the crown lands at the
       * measured tree top and starts about 7% up — matching the harvested canopyBottom
       * stats. radius*0.85/1.35: unit cards span 1.35 each way, shrunk 15% because the
       * harvested radius is geometric card extent while our denser textures read fuller
       * (0.29 vs 0.14-0.22 coverage). Both constants are look-tunable. */
      const hScale = t.height / 1.3;
      const rScale = Math.max(4, t.canopyRadius * 0.85 / 1.35);
      const o8 = off * 8;
      data[o8] = t.x; data[o8+1] = t.y; data[o8+2] = t.z; data[o8+3] = hScale;
      data[o8+4] = rnd() * Math.PI * 2;
      data[o8+5] = rnd();
      data[o8+6] = 0.85 + 0.3 * rnd();
      data[o8+7] = rScale;
      const rr = Math.max(rScale * 1.6, hScale * 1.4);
      if (t.x - rr < x0) x0 = t.x - rr; if (t.x + rr > x1) x1 = t.x + rr;
      if (t.y < y0) y0 = t.y; if (t.y + t.height > y1) y1 = t.y + t.height;
      if (t.z - rr < z0) z0 = t.z - rr; if (t.z + rr > z1) z1 = t.z + rr;
      off++;
    }
    runsByType[cell.type].push({ byteOff: start * 32, count: cell.trees.length,
      centre: [(x0+x1)/2, (y0+y1)/2, (z0+z1)/2], radius: 0.5 * Math.hypot(x1-x0, y1-y0, z1-z0) });
  }
  const instBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const specs = [
    { pal: "green",  meshSeed: 8, texSeed: 8, tintA: [0.80, 0.92, 0.62], tintB: [0.55, 0.68, 0.45] },
    { pal: "sakura", meshSeed: 7, texSeed: 7, tintA: [1.06, 0.94, 0.99], tintB: [0.92, 0.74, 0.80] },
  ];
  const types = [];
  for (let ty = 0; ty < 2; ty++) {
    if (!runsByType[ty].length) { types.push(null); continue; }
    const spec = specs[ty];
    const mesh = Remaster.makeTreeMesh(26, spec.meshSeed);
    const mips = Remaster.buildLeafMips(Remaster.generateLeafTexture(256, spec.pal, spec.texSeed), 256, { threshold: 0.5 });
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // level-by-level upload of the coverage-preserving chain — NEVER generateMipmap here;
    // regenerating would reintroduce the exact mip-alpha decay these trees exist to kill
    for (let l = 0; l < mips.length; l++)
      gl.texImage2D(gl.TEXTURE_2D, l, gl.RGBA, mips[l].w, mips[l].h, 0, gl.RGBA, gl.UNSIGNED_BYTE, mips[l].data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const mk = (d, tgt) => { const b = gl.createBuffer(); gl.bindBuffer(tgt, b); gl.bufferData(tgt, d, gl.STATIC_DRAW); return b; };
    const vbMesh = mk(mesh.pos, gl.ARRAY_BUFFER), vbNrm = mk(mesh.nrm, gl.ARRAY_BUFFER);
    const vbUV = mk(mesh.uv, gl.ARRAY_BUFFER), vbIdx = mk(mesh.idx, gl.ELEMENT_ARRAY_BUFFER);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbMesh); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbNrm);  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 12, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbUV);   gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 32, 0);  gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.FLOAT, false, 32, 16); gl.vertexAttribDivisor(4, 1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, vbIdx);
    gl.bindVertexArray(null);
    types.push({ vao, vbMesh, vbNrm, vbUV, vbIdx, idxCount: mesh.idx.length, tex,
                 tintA: spec.tintA, tintB: spec.tintB, ranges: runsByType[ty] });
  }
  treeSys = { types, instBuf, count: worth.length };
  updateRemasterUI();
  console.log("[remaster] " + worth.length + " instanced trees, " +
              (runsByType[0].length + runsByType[1].length) + " cell runs, 52 tris/tree");
}

/* Per-run draws re-point attribs 3/4 WHILE the VAO is bound (VAO-owned state, invisible
 * outside it) because WebGL2 has no baseInstance. */
function drawTreeRuns(planes, loc, eye) {
  // lit pass: runs sorted near-first each call, so close canopy fills depth and the
  // corridor behind it z-rejects — the same order-matters move that paid on the track
  let drawn = 0;
  for (const ty of treeSys.types) {
    if (!ty) continue;
    gl.bindTexture(gl.TEXTURE_2D, ty.tex);
    if (loc === instLoc) { gl.uniform3fv(instLoc.tintA, ty.tintA); gl.uniform3fv(instLoc.tintB, ty.tintB); }
    gl.bindVertexArray(ty.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, treeSys.instBuf);
    const visible = [];
    for (const r of ty.ranges) {
    if (planes && !sphereInFrustum(planes, r.centre, r.radius)) continue;
    if (eye) { const dx = r.centre[0]-eye[0], dz = r.centre[2]-eye[2]; r._d2 = dx*dx+dz*dz; }
    visible.push(r);
    }
    if (eye) visible.sort((a, b) => a._d2 - b._d2);
    for (const r of visible) {
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 32, r.byteOff);
      gl.vertexAttribPointer(4, 4, gl.FLOAT, false, 32, r.byteOff + 16);
      gl.drawElementsInstanced(gl.TRIANGLES, ty.idxCount, gl.UNSIGNED_SHORT, 0, r.count);
      drawn += r.count;
    }
  }
  gl.bindVertexArray(null);
  gl.activeTexture(gl.TEXTURE0);
  return drawn;
}

function drawTreesLit(vp, L, nightF, fogDv, planes) {
  if (!treeSys || !REMASTER_ON) { cullStat.trees = 0; cullStat.treesTotal = treeSys ? treeSys.count : 0; return; }
  GT.begin("trees");
  gl.useProgram(progInstLit);
  gl.uniformMatrix4fv(instLoc.vp, false, vp);
  gl.uniform1f(instLoc.time, _treeTime);
  gl.uniform3fv(instLoc.eye, camEye());
  gl.uniform3f(instLoc.sunDir, L.dir[0], L.dir[1], L.dir[2]);
  gl.uniform3f(instLoc.sunCol, L.sun[0], L.sun[1], L.sun[2]);
  gl.uniform3f(instLoc.ambSky, L.ambSky[0], L.ambSky[1], L.ambSky[2]);
  gl.uniform3f(instLoc.ambGround, L.ambGround[0], L.ambGround[1], L.ambGround[2]);
  gl.uniform3f(instLoc.fogC, L.fog[0], L.fog[1], L.fog[2]);
  gl.uniform1f(instLoc.fogD, fogDv);
  gl.uniform1f(instLoc.alphaRef, 0.5);
  // TREE_MODE carries over: 2 = unlit trees (shadow receive off), same lever as before
  const shOn = TREE_MODE < 2 && SHADOW_ON && shadowsRendered ? 1 : 0;
  gl.uniform1f(instLoc.shadowOn, shOn);
  if (shOn) {
    const c0 = SHADOW_CASCADES[0], c1 = SHADOW_CASCADES[1];
    gl.uniform1i(instLoc.shadowMap0, 1); gl.uniform1i(instLoc.shadowMap1, 3);
    gl.uniformMatrix4fv(instLoc.lightVP0, false, c0.vp);
    gl.uniformMatrix4fv(instLoc.lightVP1, false, c1.vp);
    gl.uniform1f(instLoc.shadowTexel0, 1 / c0.size); gl.uniform1f(instLoc.shadowTexel1, 1 / c1.size);
    gl.uniform1f(instLoc.shadowDepth0, c0.depth || 1);
    gl.uniform1f(instLoc.shadowSoft, 1);   // trees: PCF softness inside a canopy is
    // invisible detail — leaves are noise-shaped already. The track keeps its soft night
    // pools; the forest takes the 9-tap path and saves 4-17 taps on every surviving
    // fragment of the single largest night fill surface.
  }
  /* TREE DEPTH PREPASS — the deep-stack killer, measured into existence at the last turn
   * (90 fps with the remastered forest: enough canopy layers that even 52-tri trees drown
   * in fill). The forest rasterizes ONCE colour-off through the alpha-tested instanced
   * depth shader (same instWorld, same sway clock, so positions are bit-identical), which
   * primes the depth buffer; the lit pass then shades each pixel EXACTLY ONCE at LEQUAL
   * instead of once per overlapping card. Cost: a second raster of the forest at one
   * texture tap per fragment. Payback: the lit pass's 10-20 taps + shading run once per
   * pixel, not once per layer. The flat-0.5 prepass threshold vs the lit pass's
   * distance-lowered ramp means a ring of low-alpha texels at distance still overdraws —
   * correct image, partial saving there, full saving everywhere else. */
  gl.useProgram(progInstDepth);
  gl.uniformMatrix4fv(instDepthLoc.lightVP, false, vp);
  gl.uniform1f(instDepthLoc.time, _treeTime);
  gl.uniform1i(instDepthLoc.tex, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.colorMask(false, false, false, false);
  drawTreeRuns(planes, instDepthLoc);
  gl.colorMask(true, true, true, true);
  gl.useProgram(progInstLit);
  gl.depthFunc(gl.LEQUAL);   // lit fragments tie the prepass depth exactly; LESS would hole them
  gl.uniform1i(instLoc.tex, 0);
  gl.activeTexture(gl.TEXTURE0);
  cullStat.trees = drawTreeRuns(planes, instLoc, camEye());
  cullStat.treesTotal = treeSys.count;
  gl.depthFunc(gl.LESS);   // restore the renderer-wide default before anything else draws
  GT.end();
}

function drawTreesDepth(lightVP, planes) {
  // TREE_MODE 1+ = trees stop casting, the same measurement lever the campaign relies on
  if (!treeSys || !REMASTER_ON || TREE_MODE >= 1) return;
  gl.useProgram(progInstDepth);
  gl.uniformMatrix4fv(instDepthLoc.lightVP, false, lightVP);
  gl.uniform1f(instDepthLoc.time, _treeTime);
  gl.uniform1i(instDepthLoc.tex, 0);
  gl.activeTexture(gl.TEXTURE0);
  drawTreeRuns(planes, instDepthLoc);
}

function updateRemasterUI() {
  const btn = document.getElementById("btnRemaster");
  if (!btn) return;
  if (!treeSys) {
    btn.disabled = true; btn.classList.remove("on");
    btn.title = isGL2 ? "no replaceable trees on this track" : "remaster needs WebGL2";
  } else {
    btn.disabled = false;
    btn.classList.toggle("on", REMASTER_ON);
    btn.title = treeSys.count + " instanced trees replace the original canopy; off returns the author's";
  }
}

/* EVERY GPU-facing mesh group is built here — track chunks and car parts alike.
 *
 * This factory exists because two near-identical constructors (this site and an inline
 * push in the track loader) let three separate features land on the dead one on
 * 2026-07-25: the foliage policy had no flag to test, frustum culling had no bounds, and
 * the lamp bake had no vertex data — all live in code, all silently doing nothing, all
 * tests green. A field that any render pass reads must be set HERE, once, with a default;
 * per-kind extras (car: glass; track: the emissive family) ride in `extra`.
 * test_groupshape.js pins the contract: the field-union every pass reads must exist on
 * both kinds, and `posBuf:` may appear in exactly one object literal in this file.
 *
 * Notes carried from the old constructors:
 * - alphaRef: 0 on disk means "unset" — 280 of 294 materials say 0, and taking that
 *   literally would make every alpha-tested fence opaque (every texel passes `a < 0`).
 * - emissive/spec default to the neutral values the car pass uploads anyway, so cars
 *   gaining these fields changes nothing.
 * - centre/radius come from the chunker for EVERY scene — in world space for tracks, in
 *   MODEL space for cars. Passes must only cull with them against a matching frustum;
 *   today only track draws pass planes, and that is a call-convention contract, not a
 *   data guarantee.
 * - pos/nrm are kept until bakeTrackLamps releases them (track); cars keep them, and
 *   carLights/wheel code reads the raw scene groups instead. */
async function makeGroup(g, mat, texByName, fallbackRGB, extra) {
  let tex;
  try {
    const entry = mat.txDiffuse && texByName[mat.txDiffuse];
    tex = entry ? await makeSceneTexture(entry.blob, entry.name) : makeFallbackTexture(fallbackRGB);
  } catch (e) { tex = makeFallbackTexture(fallbackRGB); }
  const mk = (data, target) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; };
  return Object.assign({
    posBuf: mk(g.pos, gl.ARRAY_BUFFER), nrmBuf: mk(g.nrm, gl.ARRAY_BUFFER),
    uvBuf: mk(g.uv, gl.ARRAY_BUFFER), idxBuf: mk(g.idx, gl.ELEMENT_ARRAY_BUFFER),
    count: g.idx.length, tex,
    alphaTested: !!mat.alphaTested,
    translucent: mat.blendMode === 1,
    alphaRef: mat.alphaRef > 0 ? mat.alphaRef : 0.5,
    emissive: null, emisTex: null, spec: 0, specExp: 10,
    matName: mat.name || "?",
    foliage: isFoliageMaterial(mat),
    tris: (g.idx.length / 3) | 0,
    centre: g.centre, radius: g.radius,
    lampBuf: null,
    remastered: false,   // true only on track canopy the instanced trees replace
    glass: false,
    pos: g.pos, nrm: g.nrm,
  }, extra || {});
}

async function uploadGroups(groupList, scene, fallbackRGB) {
  const texByName = {};
  for (const t of scene.textures) texByName[t.name] = t;
  const out = [];
  for (const g of groupList) {
    const mat = scene.materials[g.materialId] || {};
    out.push(await makeGroup(g, mat, texByName, fallbackRGB, {
      glass: /glass/i.test(mat.name || "") && !/headlight/i.test(mat.name || ""),   // windscreen → reflective pass
    }));
  }
  return out;
}
// shared by track + car
async function uploadSceneGroups(scene, fallbackRGB) { return uploadGroups(scene.groups, scene, fallbackRGB); }

/* The engine layers come from the REPLAY'S car, not from wavs we ship.
 * There are 16 T-180 variants installed on this machine and they do not sound alike, so a fixed set
 * of samples is the wrong engine for fifteen of them. The car's FMOD bank holds its own ladder plus
 * the turbine/afterburner stack that the shipped subset never had. Failure is non-fatal by design:
 * no Tauri, no bank, an odd codec — BBAudio keeps the built-in wavs and the app just sounds as it
 * did before. */
async function loadCarSound(carId) {
  if (!inTauri || !carId || !window.BBAudio || !window.FSB5) return;
  try {
    const path = await tinvoke("find_car_bank", { carId });
    if (!path) return;
    const ab = await tinvoke("read_file", { path });
    const info = await BBAudio.setCarBank(ab, carId);
    if (info && info.voices) console.log(`[BBAudio] ${carId}: playing ${info.event} — ${info.voices} layers from its own bank`);
    else if (info && info.wrongCar) console.warn(`[BBAudio] no engine: the event map is ${info.wrongCar}, this replay is ${carId}`);
  } catch (e) {
    console.warn("[BBAudio] car bank unavailable for " + carId + " — no engine sound:", e);
  }
}

async function loadCarModel(carId) {
  if (!inTauri || !carId) return;
  try {
    const files = await tinvoke("find_car", { carId });
    if (!files || !files.length) return;
    const ab = await tinvoke("read_file", { path: files[0].path });
    const scene = KN5.extractScene(ab, { lod0Only: true, skipTransparent: false });   // keep glass (windscreen) — normally skipped
    carGroups = await uploadSceneGroups(scene, [150, 152, 158]);
    carGlass = carGroups.filter(g => g.glass);       // windscreen → reflective glass pass
    // `translucent`, not the old car-only alias `blend` — one name across both group kinds,
    // because a pass reading the alias on the other kind gets undefined and silently no-ops
    // (the exact shape of the 2026-07-25 foliage bug).
    carGroups = carGroups.filter(g => !g.translucent);   // opaque body only
    // light emitters from the model's own housings (model space): headlight/brakelight
    // bulbs as one centroid per side, and the LED arrays (white + red) clustered per lamp.
    // head = per-side beam origins (2); headLamps/tail = the individual 3-per-side lamps
    // that visibly glow; accentW/R = the body's LED arrays.
    carLights = { head: [], headLamps: [], tail: [], brake: [], accentW: [], accentR: [] };
    const clusterLamps = (g, th) => {   // greedy-cluster verts into individual lamps
      const p = g.pos, t2 = th * th, cl = [];
      for (let i = 0; i < p.length / 3; i++) { const x = p[i*3], y = p[i*3+1], z = p[i*3+2];
        let best = -1, bd = t2;
        for (let c = 0; c < cl.length; c++) { const q = cl[c]; const d = (q.x/q.c - x)**2 + (q.y/q.c - y)**2 + (q.z/q.c - z)**2; if (d < bd) { bd = d; best = c; } }
        if (best < 0) cl.push({ x, y, z, c: 1 }); else { const q = cl[best]; q.x += x; q.y += y; q.z += z; q.c++; } }
      return cl.filter(q => q.c > 8).map(q => [q.x/q.c, q.y/q.c, q.z/q.c]);
    };
    const sideMeans = lamps => {   // average the lamps on each side → 2 beam origins
      const L = [0,0,0,0], R = [0,0,0,0], out = [];
      for (const p of lamps) { const s = p[0] > 0 ? L : R; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++; }
      for (const c of [L, R]) if (c[3]) out.push([c[0]/c[3], c[1]/c[3], c[2]/c[3]]);
      return out;
    };
    for (const g of scene.groups) {
      const mat = scene.materials[g.materialId]; if (!mat) continue;
      if (/headlightbulb/i.test(mat.name)) { const l = clusterLamps(g, 0.10); carLights.headLamps.push(...l); carLights.head.push(...sideMeans(l)); }
      else if (/brakelightbulb/i.test(mat.name)) { const l = clusterLamps(g, 0.10); carLights.tail.push(...l); carLights.brake.push(...sideMeans(l)); }
      else if (/ledwhite/i.test(mat.name)) carLights.accentW.push(...clusterLamps(g, 0.07));
      else if (/ledred/i.test(mat.name)) carLights.accentR.push(...clusterLamps(g, 0.07));
      else if (/turbineglow/i.test(mat.name)) {   // turbine nozzle → plume + backfire origin
        // emit from the nozzle MOUTH (rearmost, min z), not the centroid, so the housing
        // occludes the plume and it only glows out the opening — not through the bodywork.
        const p = g.pos, n = p.length / 3; let cx = 0, cy = 0, minz = 1e9;
        for (let k = 0; k < n; k++) { cx += p[k*3]; cy += p[k*3+1]; if (p[k*3+2] < minz) minz = p[k*3+2]; }
        carNozzle = [cx/n, cy/n, minz];
      }
    }
    // steerable wheels (front pair steers to the line; the body keeps its crab)
    carWheels = [];
    for (const w of (scene.wheels || [])) {
      // rolling radius = furthest TYRE vertex from the pivot in the plane ⟂ the axle (model X)
      let r2 = 0;
      for (const g of w.rollGroups) { const p = g.pos; for (let k = 0; k < p.length; k += 3) {
        const dy = p[k+1] - w.pivot[1], dz = p[k+2] - w.pivot[2]; const d = dy*dy + dz*dz; if (d > r2) r2 = d; } }
      const radius = r2 > 1e-6 ? Math.sqrt(r2) : (w.pivot[1] || 0.35);
      const rollGpu = await uploadGroups(w.rollGroups, scene, [150, 152, 158]);
      const staticGpu = await uploadGroups(w.staticGroups, scene, [150, 152, 158]);
      carWheels.push({ corner: w.corner, pivot: w.pivot, front: /F$/.test(w.corner), radius, rollGroups: rollGpu, staticGroups: staticGpu });
    }
    // in-cockpit steering wheel (spins with steer)
    carSteerWheel = null;
    if (scene.steerWheel) {
      // keep a CPU copy of the wheel's vertices (downsampled if huge) — the
      // driver's grips get snapped onto the nearest actual MATERIAL (snapToMesh)
      // so the hands hold the physical handle, holes and all
      let total = 0; for (const g of scene.steerWheel.groups) total += g.pos.length;
      const step = 3 * Math.max(1, Math.ceil(total / 90000));   // ≤ ~30k verts kept
      const verts = [];
      for (const g of scene.steerWheel.groups) for (let i = 0; i + 2 < g.pos.length; i += step)
        verts.push(g.pos[i], g.pos[i+1], g.pos[i+2]);
      const sg = await uploadGroups(scene.steerWheel.groups, scene, [40, 42, 48]);
      carSteerWheel = { pivot: scene.steerWheel.pivot, ax: scene.steerWheel.ax, groups: sg, verts: new Float32Array(verts) };
    }
    // driver: the shared AC model, seated onto THIS car's wheel via its authored
    // driver_base_pos.knh (which repositions the skeleton so the hands grip the rim).
    try {
      const df = await tinvoke("find_driver", { carId });
      const driverFile = df && df.find(f => f.name === "driver");
      if (driverFile) {
        const poseFile = df.find(f => f.name === "pose");
        const dab = await tinvoke("read_file", { path: driverFile.path });
        const dscene = KN5.parseDriver(dab);
        const skel = { parent: dscene.nodes.map(n => n.parent), localBind: dscene.nodes.map(n => n.local),
                       bindWorld: dscene.nodes.map(n => n.world), name: dscene.nodes.map(n => n.name),
                       nameIndex: dscene.nameIndex, count: dscene.nodes.length };
        // this car's seated pose: name -> car-space bone matrix (row-vector)
        let poseWorld = null, poseLocal = null, neckPivot = [0, 1.08, 0.09];
        if (poseFile) {
          try {
            const pab = await tinvoke("read_file", { path: poseFile.path });
            const parsedPose = KN5.parseDriverPose(pab);
            poseWorld = parsedPose.world; poseLocal = parsedPose.local;
            const nk = poseWorld["DRIVER:RIG_Nek"]; if (nk) neckPivot = [nk[12], nk[13], nk[14]];
            // reposition each RIGID (head/helmet) mesh from bind to the seated pose.
            // The helmet/face hang off non-bone nodes, so walk up to the nearest
            // ancestor the seated pose defines (RIG_Head) and apply that bone's rigid
            // bind→seated delta: seatedVert = bindVert · inv(A.bindWorld) · knhWorld[A].
            for (const m of dscene.meshes) {
              if (m.skinned || m.ownerName == null) continue;
              let ai = dscene.nameIndex[m.ownerName];
              while (ai != null && ai >= 0 && !poseWorld[dscene.nodes[ai].name]) ai = dscene.nodes[ai].parent;
              if (ai == null || ai < 0) continue;
              const A = dscene.nodes[ai];
              const C = rvMul(rvInv(A.world), poseWorld[A.name]), p = m.pos, n = m.nrm;
              for (let v = 0; v < p.length / 3; v++) {
                const x = p[v*3], y = p[v*3+1], z = p[v*3+2];
                p[v*3]   = x*C[0]+y*C[4]+z*C[8]+C[12];
                p[v*3+1] = x*C[1]+y*C[5]+z*C[9]+C[13];
                p[v*3+2] = x*C[2]+y*C[6]+z*C[10]+C[14];
                const nx = n[v*3], ny = n[v*3+1], nz = n[v*3+2];
                const rx = nx*C[0]+ny*C[4]+nz*C[8], ry = nx*C[1]+ny*C[5]+nz*C[9], rz = nx*C[2]+ny*C[6]+nz*C[10];
                const l = Math.hypot(rx, ry, rz) || 1; n[v*3] = rx/l; n[v*3+1] = ry/l; n[v*3+2] = rz/l;
              }
            }
          } catch (e) { console.warn("driver pose load failed:", e); poseWorld = null; poseLocal = null; }
        }
        // hide the HANS device (RT_HANS) — the shoulder/neck collar clips ugly on our seated pose
        const isHans = m => /hans/i.test((dscene.materials[m.materialId] || {}).name || "");
        const headGroups = await uploadGroups(dscene.meshes.filter(m => !m.skinned && !isHans(m)), dscene, [170, 172, 178]);
        // skinned meshes get DYNAMIC pos/nrm buffers (skinned to the seated pose)
        const skinned = [];
        for (const m of dscene.meshes.filter(x => x.skinned && !isHans(x))) {
          const grp = (await uploadGroups([m], dscene, [170, 172, 178]))[0];
          gl.bindBuffer(gl.ARRAY_BUFFER, grp.posBuf); gl.bufferData(gl.ARRAY_BUFFER, m.pos, gl.DYNAMIC_DRAW);
          gl.bindBuffer(gl.ARRAY_BUFFER, grp.nrmBuf); gl.bufferData(gl.ARRAY_BUFFER, m.nrm, gl.DYNAMIC_DRAW);
          skinned.push({
            grp, bindPos: m.pos, bindNrm: m.nrm, bw: m.bw, bi: m.bi, invBind: m.invBind,
            boneNodeIdx: m.boneNames.map(bn => dscene.nameIndex[bn] != null ? dscene.nameIndex[bn] : -1),
            skinPos: new Float32Array(m.pos.length), skinNrm: new Float32Array(m.nrm.length),
          });
        }
        // arm-orbit rig: fixed shoulder + neutral elbow/hand (from the seated pose) +
        // each arm's descendant node set, so driverSeatedSkin can swing the hands with
        // the wheel. Needs the cockpit wheel (centre + spin axis) to orbit the grip.
        let arms = null, wheelC = null, wheelAxis = null;
        if (poseWorld && carSteerWheel) {
          wheelC = carSteerWheel.pivot;
          wheelAxis = v3nrm(carSteerWheel.ax[STEER_WHEEL_AXIS]);
          const originOf = nm => { const M = poseWorld[nm]; return M ? [M[12], M[13], M[14]] : null; };
          const subtreeOf = rootName => {   // node indices whose ancestor chain hits root
            const r = dscene.nameIndex[rootName]; const out = [];
            if (r == null) return out;
            for (let i = 0; i < dscene.nodes.length; i++) { let a = i; while (a >= 0 && a !== r) a = dscene.nodes[a].parent; if (a === r) out.push(i); }
            return out;
          };
          arms = [];
          for (const s of ["L", "R"]) {
            const S0 = originOf("DRIVER:RIG_Arm_"+s), E0 = originOf("DRIVER:RIG_ForeArm_"+s), W0 = originOf("DRIVER:RIG_HAND_"+s);
            if (!S0 || !E0 || !W0) continue;
            arms.push({ S0, E0, W0, side: s, L1: v3len(v3sub(E0, S0)), L2: v3len(v3sub(W0, E0)), pole: v3sub(E0, S0),
                        armSub: subtreeOf("DRIVER:RIG_Arm_"+s), foreSub: subtreeOf("DRIVER:RIG_ForeArm_"+s),
                        foreEndSub: subtreeOf("DRIVER:RIG_ForeArm_END_"+s),   // the distal twist bone — carries most of the forearm's skin
                        handSub: subtreeOf("DRIVER:RIG_HAND_"+s),   // hand+fingers → grip rolls with the wheel
                        gripBase: (s === "L" ? 1 : -1) * DRIVER_GRIP_UP });   // raise each hand up the rim
          }
          // put each hand's GRIP HOLLOW — the channel the curled fingers enclose,
          // measured from the whole digit ring (knuckles, mids, TIPS, thumb tips)
          // in the seated pose — onto the wheel's nearest actual material (the
          // handle bar). The wrist sits ~11 cm behind the contact, and the hand is
          // sculpted for a FAT rim, so on a thin bar the anchor is biased deeper
          // into the curl (DRIVER_GRIP_BIAS): the spare finger length then rests
          // on the hidden palm side instead of poking out the wheel's face.
          // (L fingers are Index/Middle/Ring/Pinkie 1-3, R fingers 4-6; thumbs
          // are HAND_<side>_Thumb1-3 in the shared AC rig.)
          if (carSteerWheel.verts && carSteerWheel.verts.length) for (const arm of arms) {
            const nums = arm.side === "L" ? [1, 2, 3] : [4, 5, 6];
            const ringPts = [], knuckPts = [], tipPts = [];
            for (const fam of ["Index", "Middle", "Ring", "Pinkie"]) for (let d = 0; d < 3; d++) {
              const p = originOf("DRIVER:HAND_" + fam + nums[d]);
              if (!p) continue;
              ringPts.push(p);
              if (d === 0) knuckPts.push(p);
              if (d === 2) tipPts.push(p);
            }
            for (const t of [2, 3]) { const p = originOf("DRIVER:HAND_" + arm.side + "_Thumb" + t); if (p) ringPts.push(p); }
            if (ringPts.length < 8 || !knuckPts.length || !tipPts.length) continue;   // rig without fingers → leave the authored pose alone
            const cen = pts => v3sc(pts.reduce((a, p) => v3add(a, p), [0, 0, 0]), 1 / pts.length);
            const hollow = cen(ringPts);
            const curlDir = v3nrm(v3sub(cen(tipPts), cen(knuckPts)));   // deeper into the curl
            const anchor = v3add(hollow, v3sc(curlDir, DRIVER_GRIP_BIAS));
            const shift = palmGrip(anchor, arm.W0, carSteerWheel.verts, DRIVER_PALM_OFFSET);
            if (!shift) continue;
            arm.G0 = v3add(arm.W0, v3sc(shift, DRIVER_GRIP_SNAP));
            arm.gripShift = v3sub(arm.G0, arm.W0);   // the hand mesh rides this shift onto the handle
          }
        }
        // the mod author's own lock-to-lock steering animation (arms + hands +
        // every finger, authored ON this wheel — palms wrapped around the grips).
        // When it binds, it drives the driver; the IK/snap path is the fallback.
        let steerAnim = null;
        const steerFile = df.find(f => f.name === "steer");
        if (steerFile && poseWorld && wheelC) {
          try {
            const anim = KN5.parseKsanim(await tinvoke("read_file", { path: steerFile.path }));
            steerAnim = driverAnimInit(anim, skel, poseWorld, poseLocal, wheelC, wheelAxis);
            if (steerAnim) console.log(`steer.ksanim bound: ${anim.frameCount} frames, authored lock ±${(steerAnim.lock * 180 / Math.PI).toFixed(0)}°`);
          } catch (e) { console.warn("steer anim load failed:", e); steerAnim = null; }
        }
        carDriver = { skinned, headGroups, skel, poseWorld, neckPivot, arms, wheelC, wheelAxis, steerAnim,
                      // the wheel's soft lock = the largest orbit BOTH hands can physically
                      // reach on THIS car's rig (shoulder lean included) — self-calibrated
                      gripLock: (arms && arms.length) ? gripLockCalib(arms, wheelC, wheelAxis, DRIVER_SHOULDER_REACH) : 0 };
        if (steerAnim) driverSkinUpload(driverAnimWorlds(steerAnim, animT(steerAnim, 0)));   // seat at anim centre
        // load-time seating: force it through, never let the rate cap defer the first pose
    else { driverPoseReset(); driverSeatedSkin(0, 0); }
      }
    } catch (e) { console.warn("driver load failed:", e); carDriver = null; }
  } catch (e) { console.warn("car model load failed:", e); carGroups = null; carWheels = null; carDriver = null; }
}

function loadReplayBuffer(ab, name) {
  droperr.textContent = "";
  try {
    resetTrackScene(); // a new replay starts with a clean track + car
    replay = ACReplay.parseReplay(ab);
    currentReplayName = name || "";     // so the compare picker can leave this run out of its own list
    compareRuns = [];                   // comparisons belong to the run that was loaded when they were chosen
    lapCompare = false;
    const cmpBtn = document.getElementById("btnLapCmp");
    if (cmpBtn) cmpBtn.classList.remove("on");
    if (typeof hideLapPicker === "function") hideLapPicker();
    if (typeof renderLapLegend === "function") renderLapLegend(null);
    selectCar(0);
    document.getElementById("fileinfo").textContent =
      `${name} · ${replay.track}${replay.trackConfig ? "/" + replay.trackConfig : ""} · ${replay.weather} · ${replay.intervalMs} ms`;
    drop.classList.add("hidden");
    document.getElementById("hud").classList.remove("hidden");
    document.getElementById("help").classList.remove("hidden");
    document.getElementById("transport").classList.remove("hidden");
    if (window.pokeTransport) window.pokeTransport();   // show, then auto-fade when idle
    const sel = document.getElementById("carsel");
    if (replay.cars.length > 1) {
      sel.classList.remove("hidden");
      sel.innerHTML = replay.cars.map((c, i) =>
        `<option value="${i}">${c.driver || c.carId} (${c.carId})</option>`).join("");
      sel.onchange = () => selectCar(+sel.value);
    } else sel.classList.add("hidden");
    maybeAutoLoadTrack(replay.track);
    if (replay.cars[0]) loadCarModel(replay.cars[0].carId);
    if (replay.cars[0]) loadCarSound(replay.cars[0].carId);
    // audio comes up ON by default (M mutes). Kick it off on the first replay; the webview's
    // autoplay lock is released by the load click itself, with a gesture fallback below.
    if (window.BBAudio && !audioAutoStarted) {
      audioAutoStarted = true;
      BBAudio.setEnabled(true).then(on => {
        const el = document.getElementById("audioind");
        if (el) { el.textContent = on ? "♪ sound on" : "♪ sound off"; el.style.opacity = on ? "1" : "0.5"; }
      });
    }
  } catch (err) {
    droperr.textContent = err.message;
    drop.classList.remove("hidden");
  }
}

function loadFile(file) {
  file.arrayBuffer().then(ab => loadReplayBuffer(ab, file.name));
}

/* ===================== native (Tauri) integration ===================== */
// One codebase, two modes. In a browser: drag-drop + File System Access.
// In the BLACKBOX app: native disk access — the replay folder is auto-listed,
// files load with no prompts, and a replay's track is fetched from the Steam
// AC install automatically. Feature-detected via the global Tauri API.
window.__bbStage = "reached TAURI probe (line ~5196)";
const TAURI = (window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
const inTauri = !!TAURI;
function tinvoke(cmd, args) { return TAURI.invoke(cmd, args); }

function fmtAgo(unixSec) {
  const d = Date.now() / 1000 - unixSec;
  if (d < 3600) return Math.round(d / 60) + "m ago";
  if (d < 86400) return Math.round(d / 3600) + "h ago";
  return Math.round(d / 86400) + "d ago";
}
function parseReplayName(name) {
  // ohyeah2389_t180_mach6_centrifuge__190726-094516.acreplay -> {track, car, stamp}
  const base = name.replace(/\.acreplay$/i, "");
  const stamp = (base.match(/(\d{6}-\d{6})$/) || [])[1] || "";
  const body = base.replace(/_+\d{6}-\d{6}$/, "");
  return { body, stamp };
}

async function loadReplayByPath(path, name) {
  droperr.textContent = "";
  try {
    const ab = await tinvoke("read_file", { path });
    loadReplayBuffer(ab, name);
  } catch (e) {
    droperr.textContent = "could not read " + name + ": " + e;
  }
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function assetUrl(p) { return TAURI.convertFileSrc(p); }

function hideOverlays() {
  document.getElementById("gallery").classList.add("hidden");
  document.getElementById("tracklist").classList.add("hidden");
}
function showGallery() {
  hideOverlays();
  document.getElementById("tracklist").classList.add("hidden");
  document.getElementById("gallery").classList.remove("hidden");
  // Tells the head watchdog the gallery genuinely opened. It checks this flag, not current
  // visibility: a user who picks a track within the watchdog's 2.5 s window has LEGITIMATELY
  // hidden the gallery, and painting the failure panel over their freshly loaded replay
  // would be the watchdog inventing the very kind of false alarm it exists to end.
  window.__bbGalleryShown = true;
}

/* ---- units (metric / imperial), user-toggleable in Settings ---- */
let units = localStorage.getItem("blackbox_units") || "metric";
function parseLengthMeters(s) {
  if (!s) return null;
  const m = String(s).toLowerCase().replace(",", ".").match(/([\d.]+)\s*(km|mi|miles|m)?/);
  if (!m) return null;
  const v = parseFloat(m[1]), u = m[2] || "";
  if (u === "km") return v * 1000;
  if (u === "mi" || u === "miles") return v * 1609.34;
  if (u === "m") return v;
  return v > 100 ? v : v * 1000; // no unit given: guess (>100 = metres)
}
function fmtDistance(meters) {
  if (meters == null) return "";
  if (units === "imperial") { const mi = meters / 1609.34; return (mi < 10 ? mi.toFixed(2) : mi.toFixed(1)) + " mi"; }
  const km = meters / 1000; return (km < 10 ? km.toFixed(2) : km.toFixed(1)) + " km";
}
function fmtWidth(s) {
  const m = parseFloat(String(s || "")); if (!isFinite(m)) return "";
  return units === "imperial" ? Math.round(m * 3.28084) + " ft" : Math.round(m) + " m";
}
function fmtSpeed(kph) {
  return isFinite(kph) ? (units === "imperial" ? Math.round(kph * 0.621371) + " mph" : Math.round(kph) + " km/h") : "—";
}
function trackMetaStr(t) {
  return [fmtDistance(parseLengthMeters(t.length)), t.run].filter(Boolean).join(" · ");
}

// draw our own top-down map from the track's road geometry (Rust track_outline),
// overlaid on the thumbnail. Points are normalized 0..1; fit preserving aspect.
async function drawTrackOutline(folder, canvas) {
  if (!canvas) return;
  try {
    const o = await tinvoke("track_outline", { folder });
    if (!o || !o.count || !o.points || !o.points.length) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height, pad = 14;
    const bw = o.bounds[2] - o.bounds[0], bh = o.bounds[3] - o.bounds[1];
    const aspect = (bw && bh) ? bw / bh : 1;
    let dw = W - 2 * pad, dh = H - 2 * pad;
    if (dw / dh > aspect) dw = dh * aspect; else dh = dw / aspect;
    const ox = (W - dw) / 2, oy = (H - dh) / 2;
    ctx.clearRect(0, 0, W, H);
    const ps = W > 420 ? 2.4 : 1.6;
    ctx.fillStyle = "rgba(242,245,250,0.7)";
    ctx.shadowColor = "rgba(226,58,46,0.95)"; ctx.shadowBlur = W > 420 ? 5 : 3;
    const p = o.points;
    for (let i = 0; i < p.length; i += 2) {
      const x = ox + p[i] * dw;
      const y = oy + (1 - p[i + 1]) * dh; // flip so it reads north-up
      ctx.fillRect(x, y, ps, ps);
    }
    ctx.shadowBlur = 0;
    canvas.classList.add("ready");
  } catch (e) { /* command may be absent or track unresolved — leave thumb as-is */ }
}

let allTracks = [], curTrack = 0;
async function renderGallery() {
  const sub = document.getElementById("gallerysub");
  document.getElementById("tvname").textContent = "scanning your Assetto Corsa install…";
  try {
    const tracks = await tinvoke("list_tracks");
    tracks.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())); // alphabetical
    allTracks = tracks;
    const driven = tracks.filter(t => t.replays > 0).length;
    sub.textContent = `${tracks.length} tracks · ${driven} driven`;
    await indexScreenshots();      // map AC's in-game screenshots to tracks (best-effort)
    showTrackAt(0);
  } catch (e) {
    document.getElementById("tvname").textContent = "could not scan tracks: " + e;
  }
}

// Index AC's in-game screenshots by track. Files are
// `Screenshot_<carId>_<trackId>_<timestamp>.jpg`; both ids can hold underscores,
// so the track is the LONGEST known folder id that ends the mid-section. Many of
// these are accidental button-presses — that randomness is the charm.
let screenshotsByTrack = {};
async function indexScreenshots() {
  screenshotsByTrack = {};
  let files;
  try { files = await tinvoke("list_screenshots"); }
  catch (e) { console.warn("screenshots unavailable:", e); return; }
  if (!files || !files.length) return;
  const folders = allTracks.map(t => (t.folder || "").toLowerCase()).filter(Boolean);
  // fallback index: a folder's last `_`-token → the folder, but only kept if that
  // token is unique across all folders (so a renamed track like onuris→chases_onuris
  // still lands, without risking an ambiguous mis-match).
  const lastTok = {};
  for (const f of folders) {
    const tk = f.split("_").pop();
    if (tk.length < 4) continue;
    (lastTok[tk] = lastTok[tk] || new Set()).add(f);
  }
  const tsRe = /_\d+(?:-\d+){3,}$/;   // trailing d-m-yy-h-m-s (+ optional dup index)
  for (const path of files) {
    const base = path.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
    const mid = base.replace(/^screenshot_/i, "").replace(tsRe, "").toLowerCase();
    let best = "";
    for (const f of folders) {                        // primary: longest folder that ends the mid
      if (f.length <= best.length) continue;
      if (mid === f || mid.endsWith("_" + f)) best = f;
    }
    if (!best) {                                       // fallback: unique last-token match
      const set = lastTok[mid.split("_").pop()];
      if (set && set.size === 1) best = [...set][0];
    }
    if (best) (screenshotsByTrack[best] = screenshotsByTrack[best] || []).push(path);
  }
}
function setTrackBackground(folder) {
  const bg = document.getElementById("tvbg");
  if (!bg) return;
  const shots = screenshotsByTrack[(folder || "").toLowerCase()] || [];
  if (!shots.length) { bg.classList.remove("on"); bg.style.backgroundImage = "none"; return; }
  const pick = shots[Math.floor(Math.random() * shots.length)];  // random accidental shot
  bg.style.backgroundImage = `url('${assetUrl(pick)}')`;
  bg.classList.add("on");
}

function showTrackAt(i) {
  if (!allTracks.length) return;
  curTrack = ((i % allTracks.length) + allTracks.length) % allTracks.length; // wrap
  const t = allTracks[curTrack];
  document.getElementById("tvname").textContent = t.name;
  setTrackBackground(t.folder);
  const thumb = document.getElementById("tvthumb");
  thumb.style.backgroundImage = t.preview ? `url('${assetUrl(t.preview)}')` : "none";
  const bits = [fmtDistance(parseLengthMeters(t.length)), t.run, t.country].filter(Boolean);
  document.getElementById("tvmeta").textContent = bits.join(" · ");
  const rbtn = document.getElementById("tvReplays");
  rbtn.textContent = t.replays ? `${t.replays} replay${t.replays === 1 ? "" : "s"} — view` : "no replays";
  rbtn.disabled = !t.replays;
  rbtn.onclick = t.replays ? () => openTrack(t) : null;
  document.getElementById("tvcount").textContent = `${curTrack + 1} / ${allTracks.length}`;
  const mapCv = document.getElementById("tvmap");
  mapCv.getContext("2d").clearRect(0, 0, mapCv.width, mapCv.height);
  drawTrackMap(t.folder, mapCv);
}
function trackStep(d) { showTrackAt(curTrack + d); }

// solid filled track map from the road triangles (Rust track_map_raster).
// Returns true on success; caller falls back to the dotted outline otherwise.
async function drawTrackMapRaster(folder, canvas) {
  try {
    const ab = await tinvoke("track_map_raster", { folder });
    const dv = new DataView(ab);
    const w = dv.getUint32(0, true), h = dv.getUint32(4, true);
    if (!w || !h || 24 + w * h > ab.byteLength) return false;
    const cov = new Uint8Array(ab, 24, w * h);
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(w, h), d = img.data;
    for (let i = 0; i < w * h; i++) {
      d[i * 4] = 236; d[i * 4 + 1] = 241; d[i * 4 + 2] = 249; d[i * 4 + 3] = cov[i];
    }
    ctx.putImageData(img, 0, 0);
    return true;
  } catch (e) { return false; }
}

function drawTrackMap(folder, canvas) {
  drawTrackMapRaster(folder, canvas).then(ok => {
    if (!ok) { canvas.width = 720; canvas.height = 720; drawTrackOutline(folder, canvas); }
  });
}

function fmtLapMs(ms) {
  return `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, "0")}`;
}
// fastest full lap = min lap time excluding the out-lap (laps[0] is the roll-in)
function fastestLap(ex) {
  if (!ex.laps || ex.laps.length < 2) return null;
  let best = Infinity;
  for (let i = 1; i < ex.laps.length; i++) best = Math.min(best, ex.laps[i].timeMs);
  return isFinite(best) ? best : null;
}
// date: prefer the DDMMYY-HHMMSS stamp AC embeds in the filename, else file mtime
function fmtReplayDate(r) {
  const m = r.name.match(/(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  const d = m ? new Date(2000 + +m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6])
              : new Date(r.modified * 1000);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
         " · " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

async function openTrack(t) {
  const list = document.getElementById("tracklist");
  const rows = document.getElementById("tlrows");
  document.getElementById("tltitle").textContent = esc(t.name);
  rows.innerHTML = `<div class="ovsub">loading…</div>`;
  document.getElementById("gallery").classList.add("hidden");
  list.classList.remove("hidden");

  // detail: track info + the generated layout map (drawn from geometry)
  const stat = (v, label) => v ? `<span class="tistat"><b>${esc(v)}</b>${label ? " " + label : ""}</span>` : "";
  document.getElementById("tlinfo").innerHTML =
    `<div class="tiname">${esc(t.name)}</div>`
    + (t.description ? `<div class="tidesc">${esc(t.description)}</div>` : "")
    + stat(fmtDistance(parseLengthMeters(t.length)), "length") + stat(fmtWidth(t.width), "wide") + stat(t.run, "")
    + stat(t.country, "") + (t.author ? `<span class="tistat">by ${esc(t.author)}</span>` : "")
    + `<span class="tistat" style="margin-top:4px"><b>${t.replays}</b> replay${t.replays === 1 ? "" : "s"}</span>`;
  const mapCv = document.getElementById("tlmap");
  mapCv.getContext("2d").clearRect(0, 0, mapCv.width, mapCv.height);
  drawTrackMap(t.folder, mapCv);
  document.getElementById("tlscroll").scrollTop = 0;
  let replays;
  try {
    replays = await tinvoke("replays_for_track", { track: t.folder });
  } catch (e) {
    rows.innerHTML = `<div class="ovsub" style="color:var(--accent)">${esc(e)}</div>`; return;
  }
  if (!replays.length) { rows.innerHTML = `<div class="ovsub">no replays for this track</div>`; return; }
  rows.innerHTML = "";
  const built = [];
  for (const r of replays) {
    const row = document.createElement("div");
    row.className = "tlrow";
    row.innerHTML =
      `<span class="car">…</span><span class="lap">—</span><span class="when">${esc(fmtReplayDate(r))}</span>`;
    row.addEventListener("click", () => { hideOverlays(); loadReplayByPath(r.path, r.name); });
    rows.appendChild(row);
    built.push({ r, row });
  }
  // fill car + fastest lap by parsing each replay (sequential — a few MB each)
  for (const { r, row } of built) {
    try {
      const ab = await tinvoke("read_file", { path: r.path });
      const rep = ACReplay.parseReplay(ab);
      const ex = ACReplay.extractCar(rep, 0);
      const car = (rep.cars[0] && rep.cars[0].carId) || parseReplayName(r.name).body;
      const best = fastestLap(ex);
      row.querySelector(".car").textContent = car;
      const lapEl = row.querySelector(".lap");
      lapEl.textContent = best ? fmtLapMs(best) : "—";
      if (best) lapEl.classList.add("has");
    } catch (e) {
      row.querySelector(".car").textContent = parseReplayName(r.name).body;
    }
  }
}

if (inTauri) {
  // browser-only affordances are replaced by the native track gallery
  document.getElementById("btnTracksDir").classList.add("hidden");
  document.getElementById("btnOpen2").classList.add("hidden");
  document.getElementById("hdrHome").style.display = "inline-block";
  document.getElementById("chipTrack").textContent =
    "NO TRACK LOADED — the ribbon is your driven line. The track loads itself once a replay is open.";
  document.getElementById("hdrHome").addEventListener("click", showGallery);
  document.getElementById("tlback").addEventListener("click", showGallery);
  const boot = () => { window.__bbStage = "boot() running"; showGallery(); renderGallery(); };
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", boot);
  else boot();
}

/* settings modal (units) — wired regardless of environment */
(function () {
  const modal = document.getElementById("settings");
  const segs = () => document.querySelectorAll("#unitToggle .seg");
  const markActive = () => segs().forEach(b => b.classList.toggle("on", b.dataset.u === units));
  const openBtn = document.getElementById("btnSettings");
  if (openBtn) openBtn.addEventListener("click", () => { markActive(); modal.classList.remove("hidden"); });
  // MSAA toggle — persists to localStorage; glcore.js reads it at context creation, so it
  // only takes effect on the next launch. The active side is highlighted from the SAME
  // source glcore read, so the UI shows what this session is actually running.
  const msegs = () => document.querySelectorAll("#msaaToggle .seg");
  const markMsaa = () => { let cur = "on"; try { cur = localStorage.getItem("bb_msaa") === "off" ? "off" : "on"; } catch (_) {}
    msegs().forEach(b => b.classList.toggle("on", b.dataset.m === cur)); };
  msegs().forEach(b => b.addEventListener("click", () => {
    try { localStorage.setItem("bb_msaa", b.dataset.m === "off" ? "off" : "on"); } catch (_) {}
    markMsaa();
  }));
  markMsaa();
  const closeBtn = document.getElementById("settingsClose");
  if (closeBtn) closeBtn.addEventListener("click", () => modal.classList.add("hidden"));
  if (modal) modal.addEventListener("click", e => { if (e.target === modal) modal.classList.add("hidden"); });
  segs().forEach(b => b.addEventListener("click", () => {
    units = b.dataset.u; localStorage.setItem("blackbox_units", units); markActive();
    if (inTauri && allTracks.length) showTrackAt(curTrack);   // refresh current track's units
    if (typeof ex !== "undefined" && ex && typeof refreshStatsChip === "function") refreshStatsChip();
  }));
})();

/* fullscreen track browser navigation: arrows, scroll wheel, arrow keys */
(function () {
  const view = document.getElementById("trackview");
  const prev = document.getElementById("tvPrev"), next = document.getElementById("tvNext");
  if (prev) prev.addEventListener("click", () => trackStep(-1));
  if (next) next.addEventListener("click", () => trackStep(1));
  let wheelLock = 0;
  if (view) view.addEventListener("wheel", (e) => {
    e.preventDefault();
    const now = performance.now();
    if (now - wheelLock < 40) return; // fast, but one notch = one track
    wheelLock = now;
    trackStep(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  addEventListener("keydown", (e) => {
    const g = document.getElementById("gallery");
    if (!g || g.classList.contains("hidden")) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { trackStep(1); e.preventDefault(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { trackStep(-1); e.preventDefault(); }
  });
})();

function selectCar(i) {
  ex = ACReplay.extractCar(replay, i);
  // cumulative travelled distance per frame (m), not carried across gaps — the wheel
  // roll-spin reads this so the tyres turn exactly with the car's motion.
  {
    const N = ex.N, cd = new Float64Array(N); let acc = 0;
    for (let k = 1; k < N; k++) {
      if (!(ex.gap && ex.gap[k])) {
        const dx = ex.pos[k*3] - ex.pos[(k-1)*3], dy = ex.pos[k*3+1] - ex.pos[(k-1)*3+1], dz = ex.pos[k*3+2] - ex.pos[(k-1)*3+2];
        acc += Math.hypot(dx, dy, dz);
      }
      cd[k] = acc;
    }
    ex.cumDist = cd;
  }
  ex.shifts = detectShifts(ex);   // kinematic upshift frames → exhaust backfires
  // REAL telemetry (if the replay was stamped by telemetry_logger): tail-align it onto
  // these N frames so effects can read actual rpm/throttle/brake/boost/slip instead of
  // guessing kinematically. null when the file has no BBTL blob → kinematic fallback stands.
  ex.tel = ACReplay.alignTelemetry(replay.telemetry, ex.N, ex.dt);
  { const tb = detectTelemetryBackfires(ex); if (tb && tb.length) ex.shifts = tb; }     // real gear/lift/limiter pops override the kinematic guess
  { const sl = computeWheelSlip(ex); ex.slip = sl.slip; ex.smokeSlip = sl.smokeSlip; }  // marks (instant) + smoke (fast-decel gated)
  {
    const mesh = buildTireMarkMesh(ex);
    markCount = mesh.length / 8;                       // 8 floats/vertex (pos3, frame, lap, intensity, cross, run)
    if (!markVBO) markVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, markVBO);
    gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
  }
  smoke.pool.length = 0; smokePrevT = null; AIR.cells.clear();   // clear live particles + air field for the new car
  smoke.accum[0] = smoke.accum[1] = smoke.accum[2] = smoke.accum[3] = 0;
  ensureSmokeAssets();                                 // bake noise texture + curl field once
  stats = ACReplay.runStats(ex);
  carSteerRef = steerRefCalib(ex);   // this run's wildest sustained steer → maps to the wheel's lock
  buildGeometry();
  tCur = frameRange()[0] * ex.dt;
  refreshStatsChip();
  const fmtLap = ms => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, "0")}`;
  document.getElementById("chipLaps").innerHTML = ex.laps.length
    ? "laps: " + ex.laps.map(l => `<b>${fmtLap(l.timeMs)}</b>`).join(" · ")
    : `<span class="dim">no completed laps detected</span>`;
}

function refreshStatsChip() {
  if (!stats) return;
  const dist = units === "imperial" ? (stats.distanceKm * 0.621371).toFixed(2) + " mi" : stats.distanceKm.toFixed(2) + " km";
  const vert = units === "imperial" ? Math.round(stats.verticalM * 3.28084) + " ft" : stats.verticalM.toFixed(0) + " m";
  document.getElementById("dstats").innerHTML =
    `<b>${fmtSpeed(stats.maxKph)}</b> max · ${fmtSpeed(stats.medianKph)} med · ` +
    `${dist} · vert ${vert}`;
}
