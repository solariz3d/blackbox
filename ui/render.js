/* render.js — render() — the whole per-frame draw sequence.
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

function render() {
  const w = cv.clientWidth, h = cv.clientHeight;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  gl.viewport(0, 0, cv.width, cv.height);
  const L = lightingFor(timeOfDay);           // sun/moon + atmosphere for this time of day
  const dayBright = Math.max(L.sun[0], L.sun[1], L.sun[2]);
  const nightF = Math.max(0, Math.min(1, (1.0 - dayBright) / 0.45));   // 0 by day → 1 deep night: fades the car lights in
  gl.clearColor(L.fog[0], L.fog[1], L.fog[2], 1);
  if (!ex) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); return; }
  const fa = followActive();
  // near plane: small in follow mode (the car is right in front — a 2u near plane
  // clipped it like a solid object); larger for the overview cam's depth precision.
  // shrink the near-clip as it zooms in → the camera reads "smaller" and can sit closer to geometry
  // (and the driver) without the near plane slicing through it.
  const zN = fa ? Math.max(0, Math.min(1, (1 - (follow.distMul || 1)) / 0.88)) : 0;
  /* Free-fly used a FIXED 2 m near plane, which is why the camera clipped into anything you tried
   * to approach: two metres of world in front of the lens was being cut away, so you could never
   * get near a wall, a kerb or the car itself. It now scales with how far out you are zoomed —
   * close in you get 8 cm and can nose right up to geometry; zoomed way out it returns to 2 m,
   * where depth precision matters more than proximity and nothing is near the lens anyway.
   * For reference, follow mode has always run 0.1 m against a 60 km far plane (a 600,000:1 ratio)
   * with no z-fighting in this scene, so 0.08 here is not new territory. */
  const zNear = fa ? (0.3 - 0.2 * zN) : 0.05;
  /* Depth precision follows the near:far RATIO, so the way to buy a tiny near plane is to stop
   * paying for a far one nothing uses: 60 km was rendering an empty horizon. 20 km still clears
   * any Assetto Corsa track by a wide margin, and 0.05:20000 is a 400,000:1 ratio — LESS than the
   * 600,000:1 that follow mode has always shipped without z-fighting in this scene. */
  const zFar = fa ? 60000 : 20000;
  const proj = mPerspective(fa ? (follow.rig.fov || 0.9) : 0.9, w / h, zNear, zFar);
  const view = mLookAt(camEye(), fa ? follow.rig.look : cam.target, fa ? (follow.rig.viewUp || follow.rig.up) : [0, 1, 0]);
  const mvp = new Float32Array(mMul(proj, view));
  // fog thins with chase distance (soft far-fade when pulled back), but clamp the
  // effective distance to a floor so zooming the follow cam in close doesn't blow the
  // density up and wash the background out — keeps the far fade without the close haze.
  /* THE MAGIC-TREES BUG, FOUND AT LAST (2026-07-26, after LOD, mip-alpha, texture
   * completeness, suppression and three cull systems were each exonerated by measurement):
   * fog density scaled with camera ZOOM, and in follow cam the 120 floor made it
   * 0.35/120 = 0.0029 — 24x the app's baseline. At that density 800 m is 90% fogged and
   * 1.2 km is 97%: everything distant dissolved into the fog colour — which at night
   * matches the sky — and "spawned in" on approach. Sakura's four giant landmark sakuras,
   * 126-181 m tall and MEANT to be seen across the map, were erased past ~800 m.
   *
   * The cap keeps the close-camera atmospheric haze the constant was tuned for, but
   * bounds visibility at roughly 4 km — the whole track reads, the landmarks stand, and
   * zoomed-out cameras keep their thinner fog untouched. Raise the cap toward 0.0029 for
   * more soup, lower it for clearer air; the keeper's law is that nothing may vanish. */
  const fogD = Math.min(0.00055, 0.35 / Math.max(cam.dist, 120));

  // car matrix computed up front so its headlights can light the TRACK too (not just
  // the car). carModelMatrix is now pure — it RETURNS {mat, steer} rather than setting
  // carSteerAngle — so ghosts can each get their own. We publish the primary's steer to
  // the global here, which is what the wheels, exo and HUD below still read.
  const i = Math.max(0, Math.min(ex.N - 1, Math.floor(tCur / ex.dt)));
  const carShown = carGroups && showCar && !ex.gap[i];
  const cmr = carShown ? carModelMatrix(tCur / ex.dt) : null;
  const cm = cmr ? cmr.mat : null;
  if (cmr) carSteerAngle = cmr.steer;
  // spatial audio: listener = camera, engine source = car's world position
  if (window.BBAudio && BBAudio.isOn()) {
    const aeye = camEye();
    const atgt = fa ? follow.rig.look : cam.target;
    const aup = fa ? (follow.rig.viewUp || follow.rig.up) : [0, 1, 0];
    let afx = atgt[0] - aeye[0], afy = atgt[1] - aeye[1], afz = atgt[2] - aeye[2];
    const afl = Math.hypot(afx, afy, afz) || 1; afx /= afl; afy /= afl; afz /= afl;
    BBAudio.setListener(aeye[0], aeye[1], aeye[2], afx, afy, afz, aup[0], aup[1], aup[2]);
    // WIND rides the CAMERA's own airspeed, not the car's — it is what the listener hears from
    // moving through air. Parked beside a car at 400 km/h there is no wind; chasing it there is.
    // Measured from the eye's actual world motion, so free-fly, orbit and follow-cam all feed it
    // without special cases. Smoothed hard: a single dropped frame must not gust.
    {
      const tn = performance.now();
      if (windPrev.t) {
        const dt = Math.min(0.25, (tn - windPrev.t) / 1000);
        if (dt > 0.001) {
          const mps = Math.hypot(aeye[0] - windPrev.p[0], aeye[1] - windPrev.p[1], aeye[2] - windPrev.p[2]) / dt;
          windPrev.kph += (Math.min(mps * 3.6, 1500) - windPrev.kph) * 0.12;   // one-pole smoother
          BBAudio.setWind(windPrev.kph);
        }
      }
      windPrev.t = tn; windPrev.p[0] = aeye[0]; windPrev.p[1] = aeye[1]; windPrev.p[2] = aeye[2];
    }
    if (!ex.gap[i]) {
      // emit from the REAR of the car (turbine nozzle, model-space → world via the car matrix), and
      // aim the source backward so the engine projects OUT THE BACK, not from the middle.
      let sx = ex.pos[i * 3], sy = ex.pos[i * 3 + 1], sz = ex.pos[i * 3 + 2];
      if (cm && carNozzle) {
        const L = carNozzle;
        sx = cm[0] * L[0] + cm[4] * L[1] + cm[8] * L[2] + cm[12];
        sy = cm[1] * L[0] + cm[5] * L[1] + cm[9] * L[2] + cm[13];
        sz = cm[2] * L[0] + cm[6] * L[1] + cm[10] * L[2] + cm[14];
      }
      BBAudio.setCarPos(sx, sy, sz);
      if (cm) { const bl = Math.hypot(cm[8], cm[9], cm[10]) || 1; BBAudio.setSourceDir(-cm[8] / bl, -cm[9] / bl, -cm[10] / bl); }
      const ddx = aeye[0] - sx, ddy = aeye[1] - sy, ddz = aeye[2] - sz;
      BBAudio.setDistance(Math.hypot(ddx, ddy, ddz));
      // flyby Doppler: pitch by the car's radial velocity relative to the camera (the "PHHEEW" as it blows past)
      const j1 = Math.min(ex.N - 1, i + 1), j0 = Math.max(0, i - 1), vdt = ((j1 - j0) * ex.dt) || ex.dt;
      const cvx = (ex.pos[j1 * 3] - ex.pos[j0 * 3]) / vdt, cvy = (ex.pos[j1 * 3 + 1] - ex.pos[j0 * 3 + 1]) / vdt, cvz = (ex.pos[j1 * 3 + 2] - ex.pos[j0 * 3 + 2]) / vdt;
      const rl2 = Math.hypot(sx - aeye[0], sy - aeye[1], sz - aeye[2]) || 1;
      const vRad = (cvx * (sx - aeye[0]) + cvy * (sy - aeye[1]) + cvz * (sz - aeye[2])) / rl2;   // + receding / − approaching (m/s)
      BBAudio.setDoppler(343 / (343 + vRad * rate));   // × replay rate so fast-forward flybys pitch too
    }
  }
  const headInt = (carShown && carLights && carLights.head.length >= 2) ? nightF : 0;
  // brake detection (no brake channel in these replays — verified by probing the frame
  // bytes): infer it, but physically. Start from gravity-corrected deceleration (so loops
  // and banking don't count), subtract cornering scrub (tyres bleeding speed in a turn is
  // not braking), then a deadzone for coasting/drag. Only real braking survives.
  const gforce = carShown ? carGForces(tCur / ex.dt) : null;
  const decelG = gforce ? gforce.brakeG - BRAKE_SCRUB * gforce.latG * gforce.latG : 0;
  const brakeF = Math.max(0, Math.min(1, (decelG - BRAKE_DEADZONE_G) / BRAKE_RANGE_G));
  const brakeInt = brakeF * nightF;           // red spill on the road behind, at night
  // cast-shadow pass: near cascade dynamic each frame; far cascade is the whole-track bake,
  // only re-rendered when the sun moved (time changed) — cheap during normal playback.
  shadowsRendered = false;
  // ghost poses BEFORE the shadow pass: they have to be in the depth map to cast onto the
  // track and onto each other, and solving them during the colour pass left them a frame
  // behind in the shadows.
  solveGhostPoses();
  if (SHADOW_ON && shadowReady && cm) {
    const timeChanged = timeOfDay !== staticBakeTime;
    GT.begin("shadow"); renderCarDepth(cm, L.dir, timeChanged); GT.end();
    if (trackAABB) staticBakeTime = timeOfDay;   // mark the static bake as current for this sun angle
    gl.viewport(0, 0, cv.width, cv.height);
  }
  // headlight-occlusion pass: scene depth from the headlight's view (night only, when the beam is on)
  let headVP = null;
  if (headInt > 0.001 && headReady && cm && carLights && carLights.head.length >= 2) {
    headVP = buildHeadVP(cm); renderHeadlightDepth(cm, headVP); gl.viewport(0, 0, cv.width, cv.height);
  }
  const setShadow = () => {
    if (shadowsRendered) {
      const c0 = SHADOW_CASCADES[0], c1 = SHADOW_CASCADES[1];
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, c0.tex);   // near cascade
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, c1.tex);   // far cascade (unit 2 is the headlight depth)
      gl.uniform1i(tLoc.shadowMap0, 1); gl.uniform1i(tLoc.shadowMap1, 3);
      gl.uniformMatrix4fv(tLoc.lightVP0, false, c0.vp); gl.uniformMatrix4fv(tLoc.lightVP1, false, c1.vp);
      gl.uniform1f(tLoc.shadowTexel0, 1 / c0.size); gl.uniform1f(tLoc.shadowTexel1, 1 / c1.size);
      gl.uniform1f(tLoc.shadowDepth0, c0.depth || 1);   // so the shader's metre-based bias converts correctly
      gl.uniform1f(tLoc.shadowOn, 1); _shadowBase = 1;
      /* Soften the shadow edge after dark. By day the sun is effectively a point and the
       * edge should stay crisp; at night the light through a roof opening is skylight from
       * a source the size of the sky, and a hard rim makes the pool read as a solid object
       * lying on the floor rather than as light. Scales with nightF so dusk crosses over
       * gradually instead of snapping. */
      gl.uniform1f(tLoc.shadowSoft, 1 + nightF * SHADOW_NIGHT_SOFT);
      gl.activeTexture(gl.TEXTURE0);
    } else { gl.uniform1f(tLoc.shadowOn, 0); _shadowBase = 0; }
  };

  // main render target: the HDR float buffer (then tonemapped to screen) or straight to
  // the canvas if float buffers aren't available. Clear happens here so the shadow passes
  // above (their own FBOs) run first.
  const usePost = hdrFX.ok && hdrFX.enabled;
  if (usePost) { resizeHDR(cv.width, cv.height); gl.bindFramebuffer(gl.FRAMEBUFFER, hdrFX.hdr.fbo); }
  else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, cv.width, cv.height);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // textured scene pass (track verts are already world-space → model = identity)
  if (sceneGroups) {
    GT.begin("track");
    _lm = {};   // the reset both comments promise: later passes change global state
                // (texture unit 0, blend) — including the tree atlas — so per-pass is
                // the only correct cache lifetime (spec finding: the reset never existed)
    // The camera's own frustum. Chunks outside it cannot contribute a pixel, so this is an
    // exact rejection, not an approximation — the same argument as the lamp cull.
    const camPlanes = frustumPlanes(mvp);
    cullStat.track = 0; cullStat.total = sceneGroups.length;
    /* FRONT-TO-BACK, opaque prefix only. The chunks used to draw in kn5-file → material →
     * cell insertion order — arbitrary in depth — so whether a canopy layer was z-rejected
     * or fully shaded was a coin flip on draw order, and sakura's corridors sit under a
     * median of 36 overlapping alpha-tested layers. Sorting near-first lets early-z kill
     * the layers behind the first surviving one: measured-model expectation is the shaded
     * count per pixel dropping from ~(1/a)ln(aN) ≈ 5.8 to ~1/a ≈ 2. Depth testing makes
     * this invisible for opaque/cutout geometry — the image is identical by construction.
     * The translucent tail keeps its original order and stays last (it blends; order IS
     * its appearance). ~800 chunk sort per frame is microseconds of CPU. */
    const drawList = sortedSceneGroups(camEye());
    gl.useProgram(progT);
    gl.uniformMatrix4fv(tLoc.mvp, false, mvp);
    gl.uniformMatrix4fv(tLoc.model, false, IDENT4);
    gl.uniform1f(tLoc.fogD, fogD);
    setSceneLighting(L);
    /* skipNight = lampsBaked: the night lamps are already in the vertex buffer, so sending
     * them again would double them AND put the 60-slot loop straight back. What is left for
     * the live path is always-on lamps, which is usually none at all. */
    setTrackLights(camEye(), nightF, mvp, lampsBaked);
    gl.uniform1f(tLoc.lampBake, (TRACK_LIGHTS_ON && lampsBaked) ? nightF : 0);
    // EVERY car's lamps light the track — a ghost's headlights fall on the road ahead of
    // it exactly like the reference car's. skip = -1: the track is lit by all of them.
    setCarLamps(allCarLamps(nightF, brakeInt, cm), headVP, -1);
    setShadow();                                // the car's cast shadow onto the track
    gl.uniform1i(tLoc.tex, 0);
    gl.uniform1i(tLoc.emisTex, 1);              // the emissive mask lives on unit 1
    gl.uniform3fv(tLoc.eye, camEye());          // for the specular half-vector
    gl.activeTexture(gl.TEXTURE0);
    for (const g of drawList) {
      /* TREE_MODE 2 — unlit foliage. A canopy is alpha-tested, so every one of its
       * fragments that survives the test still samples two shadow cascades and walks the
       * lamp loop, over hundreds of thousands of triangles of mostly-transparent quads.
       * Switching both off for these groups is what "remove tree lighting" means in the
       * keeper's Assetto workaround; the leaves keep their texture and the sun's diffuse
       * term, which is all that ever read as foliage anyway. */
      if (g.radius && !sphereInFrustum(camPlanes, g.centre, g.radius)) continue;
      if (treeHidden(g)) continue;   // lit: suppressed canopy is replaced by the instanced forest
      // foliage beyond the dissolve horizon is skipped outright — no draw, no state
      if (g.foliage && FOLIAGE_FADE_END > 0 && g._d2 !== undefined &&
          g._d2 > FOLIAGE_FADE_END * FOLIAGE_FADE_END) continue;
      if (MAT_DEBUG) {
        let mi = matOrder.indexOf(g.matName); if (mi < 0) { matOrder.push(g.matName); mi = matOrder.length - 1; }
        const c = MAT_PALETTE[mi % MAT_PALETTE.length];
        gl.uniform1f(tLoc.matDebug, 1); gl.uniform3f(tLoc.matDebugCol, c[0], c[1], c[2]);
      } else if (_lm.md !== 0) { _lm.md = 0; gl.uniform1f(tLoc.matDebug, 0); }
      cullStat.track++;
      /* REDUNDANT-STATE ELISION. 787 chunks share 32 materials on sakura, so most
       * chunk-to-chunk transitions change NOTHING about material state — but this loop
       * re-uploaded every uniform and rebound the texture for each one: ~10 driver calls
       * per chunk that the band-sorted order (see sortedSceneGroups) makes mostly
       * no-ops. Each call is a WebView2→ANGLE→D3D11 round trip; on a 43-chunk track the
       * waste is invisible, on a 787-chunk track it is a real CPU tax on every frame.
       * `_lm` (last material state) is reset each frame — other passes leave GL state
       * this loop cannot see. Correctness is untouched: the same values end up bound,
       * the calls that would have re-bound them are simply skipped. */
      const unlit = g.foliage && TREE_MODE >= 2;
      if (unlit !== _lm.unlit) {
        _lm.unlit = unlit;
        gl.uniform1i(tLoc.tLightN, unlit ? 0 : _tlN);
        gl.uniform1f(tLoc.shadowOn, unlit ? 0 : _shadowBase);
      }
      if (g.tex !== _lm.tex) {
        _lm.tex = g.tex;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, g.tex);
      }
      /* The dissolve rides the alpha threshold: raising it discards more of each card's
       * texels, so a distant tree thins instead of popping. g._d2 is this frame's camera
       * distance, computed by the sorter moments ago. Skip-at-END lives in the guard above
       * the state block so a skipped chunk costs nothing at all. */
      let aref = g.alphaRef;
      if (g.foliage && FOLIAGE_FADE_END > 0 && g._d2 !== undefined) {
        const d = Math.sqrt(g._d2);
        if (d > FOLIAGE_FADE_START) {
          const t = Math.min(1, (d - FOLIAGE_FADE_START) / Math.max(1, FOLIAGE_FADE_END - FOLIAGE_FADE_START));
          aref = Math.min(0.95, aref + t * (0.95 - aref));
        }
      }
      const at = g.alphaTested ? 1 : 0;
      if (at !== _lm.at || aref !== _lm.aref) {
        _lm.at = at; _lm.aref = aref;
        gl.uniform1f(tLoc.alphaTest, at);
        gl.uniform1f(tLoc.alphaRef, aref);
      }
      if (g.spec !== _lm.spec || g.specExp !== _lm.specExp) {
        _lm.spec = g.spec; _lm.specExp = g.specExp;
        gl.uniform2f(tLoc.spec, g.spec * TRACK_SPEC_GAIN, g.specExp);
      }
      if (g.emissive !== _lm.emissive || g.emisTex !== _lm.emisTex) {
        _lm.emissive = g.emissive; _lm.emisTex = g.emisTex;
        if (g.emissive) {
          gl.uniform3f(tLoc.emissive, g.emissive[0] * TRACK_EMISSIVE_GAIN,
                                      g.emissive[1] * TRACK_EMISSIVE_GAIN,
                                      g.emissive[2] * TRACK_EMISSIVE_GAIN);
          gl.uniform1f(tLoc.emisMap, g.emisTex ? 1 : 0);
          if (g.emisTex) {
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, g.emisTex);
            gl.activeTexture(gl.TEXTURE0);   // leave unit 0 current for the next tex bind
          }
        } else {
          gl.uniform3f(tLoc.emissive, 0, 0, 0);
          gl.uniform1f(tLoc.emisMap, 0);
        }
      }
      if (g.translucent !== _lm.blendOn) {
        _lm.blendOn = g.translucent;
        if (g.translucent) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
          gl.uniform1f(tLoc.alpha, 0.16);
        } else {
          gl.disable(gl.BLEND);
          gl.depthMask(true);
          gl.uniform1f(tLoc.alpha, 1.0);
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, g.posBuf);
      gl.enableVertexAttribArray(tLoc.pos);
      gl.vertexAttribPointer(tLoc.pos, 3, gl.FLOAT, false, 12, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.nrmBuf);
      gl.enableVertexAttribArray(tLoc.nrm);
      gl.vertexAttribPointer(tLoc.nrm, 3, gl.FLOAT, false, 12, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.uvBuf);
      gl.enableVertexAttribArray(tLoc.uv);
      gl.vertexAttribPointer(tLoc.uv, 2, gl.FLOAT, false, 8, 0);
      if (tLoc.lamp >= 0) {
        if (g.lampBuf) {
          gl.bindBuffer(gl.ARRAY_BUFFER, g.lampBuf);
          gl.enableVertexAttribArray(tLoc.lamp);
          gl.vertexAttribPointer(tLoc.lamp, 3, gl.FLOAT, false, 12, 0);
        } else {
          // a group with no bake (fallback geometry) falls back to a constant of zero,
          // which is the same as having no baked lamps rather than a wrong colour
          gl.disableVertexAttribArray(tLoc.lamp);
          gl.vertexAttrib3f(tLoc.lamp, 0, 0, 0);
        }
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.idxBuf);
      gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
    }
    gl.disableVertexAttribArray(tLoc.nrm);
    gl.disableVertexAttribArray(tLoc.uv);
    if (tLoc.lamp >= 0) { gl.disableVertexAttribArray(tLoc.lamp); gl.vertexAttrib3f(tLoc.lamp, 0, 0, 0); }
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    // an emissive-masked group leaves unit 1 selected, and every pass after this one binds
    // its textures assuming unit 0 is current — put it back
    gl.activeTexture(gl.TEXTURE0);
    GT.end();   // "track"
    // the remastered forest draws with the same frustum, after the sorted opaque track,
    // so early-z is already primed by near geometry
    drawTreesLit(mvp, L, nightF, fogD, camPlanes);
  }

  // tyre skid marks: dark ribbon on the track, revealed up to the current frame.
  // Drawn after the track (over it) and before the car, independent of carShown so
  // the rubber history stays visible even while the car is in a gap.
  {
    GT.begin("marks");
    let curLap = 0; if (ex.laps) for (const l of ex.laps) if (l.frame <= i) curLap++;
    drawTireMarks(mvp, L, fogD, tCur / ex.dt, curLap, markVBO, markCount, ex.dt);
    // every ghost's rubber, each revealed up to ITS own frame — so a car that locked up
    // into turn one has left its marks there and nowhere the others have not been yet
    for (const g of ghostDraws) {
      if (!g.run.markCount) continue;
      let gl2 = 0; if (g.run.ex.laps) for (const l of g.run.ex.laps) if (l.frame <= g.f) gl2++;
      // a ghost's own dt: g.f is its frame index, and a replay recorded at a different
      // interval must still fade its rubber over the same number of SECONDS
      drawTireMarks(mvp, L, fogD, g.f, gl2, g.run.markVBO, g.run.markCount, g.run.ex.dt);
    }
    GT.end();   // "marks"
  }

  gl.useProgram(prog);
  gl.uniformMatrix4fv(locMVP, false, mvp);
  gl.uniform1f(locFogD, fogD);
  gl.uniform3f(locFogC, L.fog[0], L.fog[1], L.fog[2]);   // line/ribbon fog matches the sky

  if (!sceneGroups) bindAndDraw(bufs.grid, bufs.gridN, gl.LINES);
  if (!sceneGroups && bufs.trackIdxN) {
    gl.bindBuffer(gl.ARRAY_BUFFER, bufs.trackPos);
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos, 3, gl.FLOAT, false, 12, 0);
    gl.disableVertexAttribArray(locCol);
    gl.vertexAttrib4f(locCol, 0.10, 0.125, 0.165, 1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufs.trackIdx);
    gl.drawElements(gl.TRIANGLES, bufs.trackIdxN, gl.UNSIGNED_INT, 0);
  }
  if (showLine) {
    bindAndDraw(bufs.ribbon, bufs.ribbonN, gl.TRIANGLES);
    bindAndDraw(bufs.line, bufs.lineN, gl.LINES);
    // comparison laps last, so they sit over the reference ribbon rather than inside it
    for (const o of (bufs.lapOverlays || [])) bindAndDraw(o.buf, o.n, gl.LINES);
  }

  // the car model on the cursor (its meshes are local-space → uModel = carMatrix).
  // i / carShown / cm were computed up front (above the track pass) for the headlights.
  if (carShown) {
    if (!(SHADOW_ON && shadowReady)) drawCarShadow(cm, mvp);   // contact blob only when cast shadows are off
    gl.useProgram(progT);
    gl.uniformMatrix4fv(tLoc.mvp, false, mvp);
    gl.uniform1f(tLoc.fogD, fogD);
    setSceneLighting(L);
    // cars are lit by the track's lamps too — and they MOVE, so theirs cannot be baked.
    // They keep the live loop, which is what the 64 slots and the frustum cull are for now.
    setTrackLights(camEye(), nightF, mvp);
    gl.uniform1f(tLoc.lampBake, 0);
    if (tLoc.lamp >= 0) { gl.disableVertexAttribArray(tLoc.lamp); gl.vertexAttrib3f(tLoc.lamp, 0, 0, 0); }
    // A car is never lit by its OWN lamps (the cones would pool on its own livery), but it
    // IS lit by every other car on track — which is the point of headlights appearing in
    // your mirrors. skip = 0 here: this pass draws the reference car.
    const carList = allCarLamps(nightF, brakeInt, cm);
    if (CAR_LIGHTS_ON) setCarLamps(carList, headVP, 0);
    else setCarLamps([], headVP, -1);
    // cars RECEIVE shadows now, so one body darkens another. Self-shadow acne was the
    // original reason this was off; the normal-offset plus the metric bias handles it.
    gl.uniform1f(tLoc.shadowOn, (CAR_SHADOWS && shadowsRendered) ? 1 : 0);
    gl.uniform1i(tLoc.tex, 0);
    gl.uniform1f(tLoc.alpha, 1.0);
    /* progT is shared with the track, and the track pass leaves its LAST material's
     * emissive and gloss bound. Without this reset the car inherits them — park behind
     * aurora's glowing strips and the bodywork lights up. The car keeps its own look:
     * these are the neutral values, so the car renders exactly as it did before. */
    gl.uniform3f(tLoc.emissive, 0, 0, 0);
    gl.uniform1f(tLoc.emisMap, 0);
    gl.uniform2f(tLoc.spec, 0, 10);
    gl.uniform1f(tLoc.alphaRef, 0.5);
    gl.activeTexture(gl.TEXTURE0);
    drawCarGroups(carGroups, cm);                              // body — keeps its crab
    drawGhostCars(mvp, headVP, nightF, carList);               // comparison laps, same car, own telemetry
    // the ghost pass left the last ghost's exclusion bound; put the reference car's own
    // lamp set back before its wheels, driver and glass are drawn
    if (CAR_LIGHTS_ON) setCarLamps(carList, headVP, 0);
    updateLapLegendLive();                                     // and their speed / delta, at this point on track
    if (carWheels) {                                           // wheels steer + roll, and sit at their REAL recorded positions
      const fp = tCur / ex.dt;
      const rollDist = wheelRollDistance(fp);
      const g = SUSP_ON ? carGForces(fp) : null;               // fallback procedural suspension (if no recorded data)
      for (const w of carWheels) {
        const roll = WHEEL_ROLL_SIGN * rollDist / (w.radius || 0.35);
        const kIdx = (/F$/i.test(w.corner) ? 0 : 2) + (/^L/i.test(w.corner) ? 0 : 1);   // FL/FR/RL/RR
        const W = wheelWorldAt(fp, kIdx);                      // recorded world position (real suspension over banking/bumps)
        if (W) {                                               // move the whole corner to the recorded wheel centre
          const tyre = wheelSteerModel(cm, w.pivot, carSteerAngle, roll, 0);
          const cage = wheelSteerModel(cm, w.pivot, carSteerAngle, 0, 0);
          const pw = mXfPt(w.pivot, cm), dx = W[0]-pw[0], dy = W[1]-pw[1], dz = W[2]-pw[2];
          tyre[12] += dx; tyre[13] += dy; tyre[14] += dz;
          cage[12] += dx; cage[13] += dy; cage[14] += dz;
          drawCarGroups(w.rollGroups, tyre); drawCarGroups(w.staticGroups, cage);
        } else {                                               // no recorded data → procedural lift fallback
          const lift = g ? wheelLift(w, g) : 0;
          drawCarGroups(w.rollGroups, wheelSteerModel(cm, w.pivot, carSteerAngle, roll, lift));
          drawCarGroups(w.staticGroups, wheelSteerModel(cm, w.pivot, carSteerAngle, 0, lift));
        }
      }
    }
    // cockpit wheel + driver: ONE spin drives both. The car's steer maps LINEARLY
    // (proportional the whole way — the wheel never visibly stalls while the car
    // keeps turning), scaled per-run so this replay's wildest steer (carSteerRef)
    // lands exactly at the lock. The lock is the authored steer animation's own
    // range when the car ships one, else the arms' calibrated IK reach.
    const animS = carDriver && carDriver.steerAnim;
    const effLock = animS ? animS.lock : Math.min(STEER_WHEEL_MAX, (carDriver && carDriver.gripLock) || Infinity);
    const kSteer = (carSteerRef > 1e-3 && isFinite(effLock)) ? effLock / carSteerRef : STEER_WHEEL_RATIO;
    const wheelSpin = Math.max(-effLock, Math.min(effLock, carSteerAngle * kSteer * STEER_WHEEL_SIGN));
    if (carSteerWheel)
      drawCarGroups(carSteerWheel.groups, axisSpinModel(cm, carSteerWheel.ax[STEER_WHEEL_AXIS], wheelSpin, carSteerWheel.pivot));
    if (carDriver) {                                           // driver: authored steer anim when present (palms wrapped on the grips), IK fallback otherwise
      const dp = driverPose(tCur / ex.dt, cm, carSteerAngle);
      if (animS) driverSkinUpload(driverAnimWorlds(animS, animT(animS, wheelSpin * DRIVER_GRIP_SPIN_SIGN)));
      else driverSeatedSkin(wheelSpin * DRIVER_GRIP_SPIN_SIGN, 0);   // hands ride the SAME spin as the wheel
      for (const sm of carDriver.skinned) drawCarGroups([sm.grp], dp.body);
      /* Drop the head when the camera is right on top of it. A helmet is ~20 cm across, so once the
       * eye is inside that radius the mesh straddles the near plane and you see its interior across
       * the frame — it reads as the helmet "clipping in from behind the camera". No near-plane value
       * fixes this: the geometry genuinely surrounds the lens. Measured against the neck pivot in
       * world space, so it applies to any camera that gets that close, not just one named mode. */
      let headOK = true;
      if (cm && carDriver.neckPivot) {
        const nk = carDriver.neckPivot;
        const hx = cm[0]*nk[0] + cm[4]*nk[1] + cm[8]*nk[2] + cm[12];
        const hy = cm[1]*nk[0] + cm[5]*nk[1] + cm[9]*nk[2] + cm[13];
        const hz = cm[2]*nk[0] + cm[6]*nk[1] + cm[10]*nk[2] + cm[14];
        const eye = camEye();
        headOK = Math.hypot(eye[0]-hx, eye[1]-hy, eye[2]-hz) > HEAD_HIDE_DIST;
      }
      if (headOK) drawCarGroups(carDriver.headGroups, dp.head);
    }
    // reflective WINDSCREEN — a transparent pass over the car: fresnel rim + sky/ground reflection +
    // a sharp sun glint that slides across as the car turns. Depth-tested but no depth-write, blended.
    if (carGlass && carGlass.length) {
      const eye = camEye();
      gl.useProgram(progGlass);
      gl.uniformMatrix4fv(gLoc.mvp, false, mvp); gl.uniformMatrix4fv(gLoc.model, false, cm);
      gl.uniform3f(gLoc.eye, eye[0], eye[1], eye[2]);
      gl.uniform3f(gLoc.sun, L.dir[0], L.dir[1], L.dir[2]);
      gl.uniform3f(gLoc.sunCol, L.sun[0], L.sun[1], L.sun[2]);
      gl.uniform3f(gLoc.sky, L.ambSky[0] * 1.4, L.ambSky[1] * 1.4, L.ambSky[2] * 1.5);
      gl.uniform3f(gLoc.ground, L.ambGround[0], L.ambGround[1], L.ambGround[2]);
      gl.uniform3f(gLoc.fogC, L.fog[0], L.fog[1], L.fog[2]); gl.uniform1f(gLoc.fogD, fogD);
      gl.uniform3f(gLoc.tint, 0.015, 0.02, 0.03); gl.uniform1f(gLoc.opacity, 0.10);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      // the reference car, then every ghost — same meshes, one model matrix each, so the
      // ghosts get the same windscreen rather than reading as unglazed shells
      for (const M of [cm, ...ghostDraws.map(g => g.mat)]) {
        gl.uniformMatrix4fv(gLoc.model, false, M);
        for (const g of carGlass) {
          gl.bindBuffer(gl.ARRAY_BUFFER, g.posBuf); gl.enableVertexAttribArray(gLoc.pos); gl.vertexAttribPointer(gLoc.pos, 3, gl.FLOAT, false, 12, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, g.nrmBuf); gl.enableVertexAttribArray(gLoc.nrm); gl.vertexAttribPointer(gLoc.nrm, 3, gl.FLOAT, false, 12, 0);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.idxBuf);
          gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
        }
      }
      gl.depthMask(true); gl.disable(gl.BLEND);
      gl.useProgram(progT);   // restore for the rest of the car pass
    }
    gl.disableVertexAttribArray(tLoc.nrm); gl.disableVertexAttribArray(tLoc.uv);
    if (showThruster) {
      const inten = turbineIntensity(i);
      if (inten > 0.03) drawThruster(cm, inten, mvp, 1 + nightF * 2.2);   // turbine cranks luminous at night
    }
    const bf = backfireAt(tCur / ex.dt);                                   // exhaust backfire on an upshift
    if (bf > 0.02) { const fov = fa ? (follow.rig.fov || 0.9) : 0.9; drawBackfire(cm, mvp, Math.tan(fov / 2), bf, nightF); }
    // ghosts fire their own turbine and their own backfires, off their own telemetry —
    // an upshift is a moment in a lap, so a ghost popping when the reference car shifts
    // would be describing the wrong drive
    for (const g of ghostDraws) {
      const gi = Math.max(0, Math.min(g.run.ex.N - 1, Math.round(g.f)));
      if (showThruster) {
        const gin = turbineIntensity(gi, g.run.ex);
        if (gin > 0.03) drawThruster(g.mat, gin, mvp, 1 + nightF * 2.2);
      }
      const gbf = backfireAt(g.f, g.run.ex);
      if (gbf > 0.02) { const fov = fa ? (follow.rig.fov || 0.9) : 0.9; drawBackfire(g.mat, mvp, Math.tan(fov / 2), gbf, nightF); }
    }
    if (carLights && nightF > 0.02) {           // tail bleed (flare on braking) + lamp glows at night
      const fov = fa ? (follow.rig.fov || 0.9) : 0.9;
      drawCarLights(cm, mvp, Math.tan(fov / 2), nightF, brakeF);
      drawLensFlare(cm, mvp, nightF);           // elegant headlamp glare when the beams face the camera
      // each ghost's lamps, braking on ITS OWN deceleration. Brake lights are the most
      // readable thing about a car ahead of you, so a ghost flashing when the REFERENCE
      // car brakes would be the most actively misleading pixel on screen.
      for (const g of ghostDraws) {
        const gg = carGForces(g.f, g.run.ex);
        const gdec = gg ? gg.brakeG - BRAKE_SCRUB * gg.latG * gg.latG : 0;
        const gbrake = Math.max(0, Math.min(1, (gdec - BRAKE_DEADZONE_G) / BRAKE_RANGE_G));
        drawCarLights(g.mat, mvp, Math.tan(fov / 2), nightF, gbrake);
        drawLensFlare(g.mat, mvp, nightF);
      }
    }
    gl.useProgram(prog);
  }

  // cursor point — shown when the car model isn't
  if (!carShown) {
    const cpt = new Float32Array([
      ex.pos[i * 3] + ex.nrm[i * 3] * 1.5,
      ex.pos[i * 3 + 1] + ex.nrm[i * 3 + 1] * 1.5,
      ex.pos[i * 3 + 2] + ex.nrm[i * 3 + 2] * 1.5,
      1, 1, 1, 1,
    ]);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufs.cursor);
    gl.bufferData(gl.ARRAY_BUFFER, cpt, gl.DYNAMIC_DRAW);
    gl.disable(gl.DEPTH_TEST);
    bindAndDraw(bufs.cursor, 1, gl.POINTS, 10);
    gl.enable(gl.DEPTH_TEST);
  }

  /* The track's own lamps, seen. Outside the carShown block on purpose — the lights of a
   * circuit do not depend on a car being on it — and after the scene and the cars, so the
   * depth buffer is complete and a lamp behind a grandstand or a car is correctly hidden. */
  {
    const lfov = fa ? (follow.rig.fov || 0.9) : 0.9;
    GT.begin("glare"); drawTrackLampGlare(mvp, nightF, Math.tan(lfov / 2)); GT.end();
  }

  // tyre smoke: live billboards off the same slip signal, into the HDR buffer so
  // it fogs + tonemaps with the scene. Steps on playback time (pause freezes it).
  // First copy scene depth to a texture so the smoke can do soft-particle fade (HDR path only).
  if (usePost && hdrFX.depthCopy) {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, hdrFX.hdr.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, hdrFX.depthCopy.fbo);
    gl.blitFramebuffer(0, 0, cv.width, cv.height, 0, 0, cv.width, cv.height, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, hdrFX.hdr.fbo);   // rebind the HDR target for the smoke draw
  }
  /* Timed because it is the prime suspect for a spike that appears with the follow cam
   * CLOSE to the car: a puff two metres from the lens covers a large part of the screen,
   * and transparent overdraw costs per covered pixel with no depth rejection to save it.
   * Nothing else in the frame scales with how near the camera is to the car. */
  GT.begin("smoke"); smokeStepAndDraw(mvp, view, L, fogD, i, nightF, usePost, zNear, zFar); GT.end();

  if (usePost) runHDR();   // HDR scene → bloom + ACES tonemap → screen (blacks black, light LIGHT)
}
