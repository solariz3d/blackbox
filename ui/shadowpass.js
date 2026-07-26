/* shadowpass.js — every offscreen target: the two shadow cascades, the headlight occlusion map and the HDR/bloom chain.
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

/* ===================== cascaded shadow maps =====================
 * The car + track render depth-only from the sun/moon direction into TWO cascades — a
 * tight near box (sharp shadow under/around the car) and a wide far box (distant track
 * geometry, ~1 km of coverage). The shader picks the near cascade when the fragment is in
 * it, else the far one, so we get both sharpness up close and long render distance for a
 * cinematic look. Needs WebGL2 depth textures; falls back to the contact-blob otherwise. */
let SHADOW_ON = true, shadowReady = false, shadowsRendered = false, staticBakeTime = null;


// Sharpness of a cascade is (2*R)/size metres per texel, so R is as much a resolution
// knob as size — and a free one. NEAR was spending a 180 m box to shadow a 4.5 m car.
const SHADOW_CASCADES = [
  // NEAR: dynamic, re-rendered every frame around the car. 80/8192 = 0.98 cm per texel
  // (was 180/4096 = 4.4 cm) — ~4.5x finer on the car's own cast shadow. This is the only
  // pass that costs per-frame fill; if the framerate suffers, drop size to 4096 first,
  // which still leaves 1.95 cm from the tighter R alone.
  { R: 40, size: 8192, dyn: true },
  // FAR: STATIC whole-track bake (R/centre from trackAABB), re-rendered only when the sun
  // moves — so resolution here is almost free at runtime, one bake for one memory cost.
  // At 4096 across a whole circuit a texel was tens of centimetres, which is why distant
  // shadows read as missing until you got close. 8192 halves that.
  { size: 8192, dyn: false },
];
(function initShadow() {
  if (!isGL2) return;
  let ok = true;
  // A cascade larger than the GPU allows fails texImage2D, the FBO comes back incomplete,
  // and shadows silently switch off entirely. Clamp instead: a smaller GPU should lose
  // sharpness, not shadows.
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  for (const c of SHADOW_CASCADES) {
    if (c.size > maxTex) { console.warn(`shadow cascade ${c.size} > MAX_TEXTURE_SIZE ${maxTex}; clamped`); c.size = maxTex; }
    c.vp = new Float32Array(IDENT4);   // never null (safe to bind before first bake)
    c.depth = 1;                       // metres; real value set with each vp (bias divisor)
    c.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, c.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, c.size, c.size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.NONE);
    c.fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, c.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, c.tex, 0);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    gl.clear(gl.DEPTH_BUFFER_BIT);   // start "all lit" so an unbaked far map casts nothing
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) ok = false;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); shadowReady = ok;
})();

// orthographic light box of half-extent R centred on `center`, looking along the sun/moon
// `reach` = how far TOWARD the light the box starts capturing casters, in metres, and it
// must NOT be derived from R. In light space a caster shadows the same (x,y) it occupies,
// so a tight box never loses a caster sideways — the only thing it can lose is one
// standing between the light and the near plane. Tying reach to R meant that shrinking
// the box for sharpness also amputated tall casters (grandstands, gantries): their
// shadows vanished inside the near cascade while the far cascade still had them, leaving
// a lit rectangle with hard edges that tracked the car. Returns the depth range too, so
// the shader can express its bias in metres instead of a range-dependent NDC number.
function buildLightVP(dir, R, center, reach) {
  const c = center, d = v3nrm(dir);
  const back = Math.max(reach || 0, R * 1.8);          // eye distance toward the light
  const depth = back + Math.max(reach || 0, R * 2.2);  // ...through to well below the box
  const eye = [c[0] + d[0]*back, c[1] + d[1]*back, c[2] + d[2]*back];
  const up = Math.abs(d[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0];
  return { vp: new Float32Array(mMul(mOrtho(-R, R, -R, R, 1, depth), mLookAt(eye, c, up))), depth };
}
// How far above the car the near cascade still collects shadow casters. Generous on
// purpose: it costs depth precision (24-bit over ~1.2 km is well under a millimetre) and
// nothing else, whereas being short silently deletes shadows.
const SHADOW_CASTER_REACH = 600;
// Shadow casters. NEAR cascade: dynamic every frame (track + car around the car, sharp).
// FAR cascade: the WHOLE track baked once — only re-rendered when the sun moved (time
// changed), covering the full track bounds. Track participates (banking blocks the sun);
// no front-cull (would drop the track top); slope-scaled bias in the shader handles acne.
function renderCarDepth(cm, dir, timeChanged) {
  gl.useProgram(progDepth);
  /* `planes` are the LIGHT's frustum, not the camera's — a shadow caster matters because it
   * is inside the light box, not because you can see it. Passing them in (rather than
   * deriving them here) is what lets the same drawG serve the near cascade, the far bake
   * and the car draws, each against its own volume. Ortho projections extract planes the
   * same way perspective ones do. */
  const drawG = (groups, model, planes) => {
    gl.uniformMatrix4fv(depthLoc.model, false, model);
    let drawn = 0;
    for (const g of groups) {
      if (g.foliage && TREE_MODE >= 1) continue;   // canopies stop casting; trunks still do
      if (treeHidden(g)) continue;   // cascades: the instanced depth pass casts the dapple instead
      if (planes && g.radius && !sphereInFrustum(planes, g.centre, g.radius)) continue;
      drawn++;
      gl.bindBuffer(gl.ARRAY_BUFFER, g.posBuf);
      gl.enableVertexAttribArray(depthLoc.pos); gl.vertexAttribPointer(depthLoc.pos, 3, gl.FLOAT, false, 12, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.idxBuf);
      gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
    }
    return drawn;
  };
  // NEAR — dynamic, every frame (track + car)
  const near = SHADOW_CASCADES[0];
  // reach is passed explicitly so a tall caster 600 m up-sun still lands in this map —
  // without it the box only reaches R*1.8 (71 m at R=40) and deletes grandstand shadows
  // The near cascade must cover EVERY car, not just the reference. Centred on the
  // reference at a fixed R, a ghost more than R away simply wasn't in the map and cast
  // nothing — which is most of a race, since spreading the cars out is the point. Centre
  // on the group and grow to enclose it: sharpness falls as the field spreads, which is
  // the honest trade (a 40 m box over one car is 1 cm per texel; a 120 m box is 3 cm).
  let cx = cm[12], cy = cm[13], cz = cm[14], spread = 0;
  if (ghostDraws.length) {
    for (const g of ghostDraws) { cx += g.mat[12]; cy += g.mat[13]; cz += g.mat[14]; }
    const n = 1 + ghostDraws.length;
    cx /= n; cy /= n; cz /= n;
    const far2 = (m) => Math.max(Math.abs(m[12] - cx), Math.abs(m[13] - cy), Math.abs(m[14] - cz));
    spread = far2(cm);
    for (const g of ghostDraws) spread = Math.max(spread, far2(g.mat));
  }
  const nearR = Math.max(near.R, spread + 12);   // +12 m so a car at the edge keeps its own shadow
  /* HOW FAR UP-SUN THE NEAR CASCADE MUST LOOK, derived rather than assumed.
   *
   * This was the flat SHADOW_CASTER_REACH above, and a constant cannot be right for every
   * track. Centrifuge is a dome enclosing the circuit with 1191 m of vertical: its roof sits
   * FURTHER up-sun than 600 m, so it fell outside the near box, the near cascade found no
   * occluder above the car, and reported the ground lit. The visible result is a pool of
   * light that travels with the car through what should be shade — the near box drawn in
   * light, exactly the shape of the box. The far cascade had the dome all along, which is
   * why everything OUTSIDE the box was correctly dark.
   *
   * The reach now comes from the scene's own bounds: the largest distance, along the light
   * direction, from the cascade centre to any corner of the whole-scene box. That is by
   * construction enough to contain every caster on the track, whatever its height, and it
   * costs only depth precision (24-bit over a couple of kilometres is still sub-millimetre)
   * — whereas being short silently deletes shadows, which is the failure this just had. */
  let reach = SHADOW_CASTER_REACH;
  if (sceneAABB) {
    const A = sceneAABB;
    for (let i = 0; i < 8; i++) {
      const px = (i & 1 ? A.x1 : A.x0) - cx;
      const py = (i & 2 ? A.y1 : A.y0) - cy;
      const pz = (i & 4 ? A.z1 : A.z0) - cz;
      const along = px * dir[0] + py * dir[1] + pz * dir[2];   // dir points TO the light
      if (along > reach) reach = along;
    }
  }
  const nlv = buildLightVP(dir, nearR, [cx, cy, cz], reach);
  near.vp = nlv.vp; near.depth = nlv.depth;
  gl.bindFramebuffer(gl.FRAMEBUFFER, near.fbo); gl.viewport(0, 0, near.size, near.size); gl.clear(gl.DEPTH_BUFFER_BIT);
  gl.uniformMatrix4fv(depthLoc.lightVP, false, near.vp);
  if (sceneGroups) cullStat.shadow = drawG(sceneGroups, IDENT4, frustumPlanes(near.vp));
  // instanced trees cast into the near map every frame, culled by the LIGHT box
  drawTreesDepth(near.vp, frustumPlanes(near.vp));
  gl.useProgram(progDepth);
  drawG(carGroups, cm);
  // ghosts cast too - a car with no shadow reads as floating, and with the car pass now
  // RECEIVING shadows this is also what makes one car darken another. Poses are solved
  // before this pass (solveGhostPoses), so they are current rather than a frame behind.
  for (const g of ghostDraws) drawG(carGroups, g.mat);
  if (carWheels) for (const w of carWheels) { const m = wheelSteerModel(cm, w.pivot, carSteerAngle, 0, 0); drawG(w.rollGroups, m); drawG(w.staticGroups, m); }
  // FAR — static whole-track bake, only when the sun moved (or first time this track)
  const far = SHADOW_CASCADES[1];
  if (trackAABB && (timeChanged || staticBakeTime === null)) {
    /* SIZE THE FAR BOX TO THE CASTERS, NOT TO THE ROAD.
     *
     * This was `trackAABB.radius + 120`, and trackAABB comes from the ROAD MESH — a box
     * drawn around the tarmac with a flat 120 m margin. That assumes casters sit near the
     * track. Centrifuge's caster is a dome ENCLOSING it: road radius 1206 m gives a 1326 m
     * box against a 1352 m scene, so the outermost dome sections are not in the depth map
     * at all. Light leaks through where the shell should block it, and because which part
     * of the dome covers a given point depends on the sun angle, the leak MOVES as the time
     * of day changes — patches appearing and sliding in ways the geometry cannot explain.
     *
     * The scene bounds are the honest extent, and they are already computed for the near
     * cascade's reach. Centred on the scene too, not on the road: a box centred on the
     * tarmac of an enclosing structure is off-centre for the thing doing the casting.
     *
     * CAPPED, because one bad chunk should not wreck the resolution of every track. The
     * T-180 test track carries a distant environment shell 3540 m across that casts nothing
     * anyone sees; sizing to it would quadruple the texel footprint of a 943 m circuit. The
     * cap keeps a genuinely enclosing caster (centrifuge, 1.1x the road) and rejects a
     * far-off backdrop (the test track, 6x). */
    const roadR = trackAABB.radius + 120;
    let fr = roadR, fc = [trackAABB.cx, trackAABB.cy, trackAABB.cz];
    if (sceneAABB) {
      const A = sceneAABB;
      const sc = [(A.x0 + A.x1) / 2, (A.y0 + A.y1) / 2, (A.z0 + A.z1) / 2];
      const sr = 0.5 * Math.hypot(A.x1 - A.x0, A.y1 - A.y0, A.z1 - A.z0);
      if (sr > fr && sr <= roadR * 2.5) { fr = sr; fc = sc; }
    }
    const flv = buildLightVP(dir, fr, fc);
    far.vp = flv.vp; far.depth = flv.depth;
    gl.bindFramebuffer(gl.FRAMEBUFFER, far.fbo); gl.viewport(0, 0, far.size, far.size); gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(depthLoc.lightVP, false, far.vp);
    // counted because "the ground outside the near box is always lit" has two very different
    // causes — the bake never running, or it running and drawing nothing — and they look
    // identical on screen
    if (sceneGroups) cullStat.far = drawG(sceneGroups, IDENT4, frustumPlanes(far.vp));   // track only — the car is in the near cascade
    drawTreesDepth(far.vp, null);   // the bake must hold every caster; runs only on sun moves
    gl.useProgram(progDepth);
    cullStat.bakes++;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); shadowsRendered = true;
}

/* headlight beam occlusion: the scene depth from the headlight's view, so track geometry
 * (banking, crests) blocks the beam instead of the light shining through solids. */
let HEAD_SIZE = 1024, headReady = false, headFbo = null, headDepthTex = null;
(function initHeadDepth() {
  if (!isGL2) return;
  headDepthTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, headDepthTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, HEAD_SIZE, HEAD_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.NONE);
  headFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, headFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, headDepthTex, 0);
  gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
  headReady = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
})();

// perspective from the headlight (midpoint of the two lamps) looking down the beam
function buildHeadVP(cm) {
  const h0 = carLights.head[0], h1 = carLights.head[1];
  const mid = [(h0[0]+h1[0])/2, (h0[1]+h1[1])/2, (h0[2]+h1[2])/2];
  const eye = mXfPt(mid, cm);
  let dx = cm[8] + cm[4]*0.06, dy = cm[9] + cm[5]*0.06, dz = cm[10] + cm[6]*0.06;
  const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
  const look = [eye[0] + dx*10, eye[1] + dy*10, eye[2] + dz*10];
  const up = Math.abs(dy) > 0.95 ? [0, 0, 1] : [0, 1, 0];
  return new Float32Array(mMul(mPerspective(1.4, 1, 0.25, 40), mLookAt(eye, look, up)));
}
// render the scene depth (track + car) from the headlight's view
function renderHeadlightDepth(cm, headVP) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, headFbo);
  gl.viewport(0, 0, HEAD_SIZE, HEAD_SIZE);
  gl.clear(gl.DEPTH_BUFFER_BIT);
  gl.useProgram(progDepth);
  gl.uniformMatrix4fv(depthLoc.lightVP, false, headVP);
  const drawG = (groups, model, planes) => {
    gl.uniformMatrix4fv(depthLoc.model, false, model);
    for (const g of groups) {
      if (g.foliage && TREE_MODE >= 1) continue;   // a canopy should not shadow your headlights either
      if (treeHidden(g)) continue;   // beam: same replacement, same reason
      if (planes && g.radius && !sphereInFrustum(planes, g.centre, g.radius)) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, g.posBuf);
      gl.enableVertexAttribArray(depthLoc.pos); gl.vertexAttribPointer(depthLoc.pos, 3, gl.FLOAT, false, 12, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.idxBuf);
      gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
    }
  };
  if (sceneGroups) drawG(sceneGroups, IDENT4, frustumPlanes(headVP));   // ONLY the track occludes the beam — the car
  // beam skip: trees deliberately do NOT occlude the headlight beam — beams are
  // road-aimed, canopy occlusion of one is invisible, and drawing the whole visible
  // forest into the beam depth map every night frame was pure cost. The cascades still
  // carry the canopy, so the dappled ground shadows are untouched.
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);       // must not occlude its own headlights (nose spar → black blob)
}

/* ===================== HDR pipeline (blacks black, light LIGHT) =====================
 * The scene renders into a float (RGBA16F) buffer with an UNCLAMPED range — the night
 * ambient sits near black, and the lights emit real HDR (values > 1). A post chain then
 * blooms only the genuinely-bright pixels (threshold ~1) and ACES-tonemaps to the screen,
 * so darkness stays crushed and highlights blow out. Needs EXT_color_buffer_float. */
const hdrFX = {
  ok: false, enabled: false, w: 0, h: 0, hdr: null, bloomA: null, bloomB: null, quad: null,   // HDR/bloom OFF for good (2026-07-23 — the bloomed look was disliked; toggle button removed)
  bright: null, blur: null, comp: null,
  exposure: 1.02, threshold: 1.35, bloomAmt: 0.75, sat: 1.32,
};
let HDR_EMIT = 2.7;   // how hard the car lamps/backfire emit into HDR (>1 so they bloom)
(function initHDR() {
  if (!isGL2 || !gl.getExtension("EXT_color_buffer_float")) return;
  gl.getExtension("OES_texture_float_linear");
  const VS = `attribute vec2 aP; varying vec2 vT; void main(){ vT = aP*0.5+0.5; gl_Position = vec4(aP,0.0,1.0); }`;
  const BRIGHT = `precision highp float; varying vec2 vT; uniform sampler2D uTex; uniform float uThresh;
    void main(){ vec3 c = texture2D(uTex, vT).rgb; float l = max(c.r, max(c.g, c.b));
      gl_FragColor = vec4(c * max(0.0, l - uThresh) / max(l, 1e-4), 1.0); }`;
  const BLUR = `precision highp float; varying vec2 vT; uniform sampler2D uTex; uniform vec2 uDir;
    void main(){ vec3 s = texture2D(uTex,vT).rgb*0.227027;
      s += (texture2D(uTex,vT+uDir*1.3846).rgb + texture2D(uTex,vT-uDir*1.3846).rgb)*0.316216;
      s += (texture2D(uTex,vT+uDir*3.2308).rgb + texture2D(uTex,vT-uDir*3.2308).rgb)*0.070270;
      gl_FragColor = vec4(s,1.0); }`;
  const COMP = `precision highp float; varying vec2 vT; uniform sampler2D uScene, uBloom;
    uniform float uExposure, uBloomAmt, uSat;
    vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
    void main(){
      vec3 c = texture2D(uScene, vT).rgb + texture2D(uBloom, vT).rgb * uBloomAmt;
      c = aces(c * uExposure);
      float l = dot(c, vec3(0.299,0.587,0.114));
      c = mix(vec3(l), c, uSat);
      gl_FragColor = vec4(c, 1.0);
    }`;
  const mk = fs => { const p = gl.createProgram(); gl.attachShader(p, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; };
  hdrFX.bright = mk(BRIGHT); hdrFX.blur = mk(BLUR); hdrFX.comp = mk(COMP);
  hdrFX.uB = { tex: gl.getUniformLocation(hdrFX.bright,"uTex"), thr: gl.getUniformLocation(hdrFX.bright,"uThresh") };
  hdrFX.uBl = { tex: gl.getUniformLocation(hdrFX.blur,"uTex"), dir: gl.getUniformLocation(hdrFX.blur,"uDir") };
  hdrFX.uC = { scene: gl.getUniformLocation(hdrFX.comp,"uScene"), bloom: gl.getUniformLocation(hdrFX.comp,"uBloom"),
    exp: gl.getUniformLocation(hdrFX.comp,"uExposure"), amt: gl.getUniformLocation(hdrFX.comp,"uBloomAmt"), sat: gl.getUniformLocation(hdrFX.comp,"uSat") };
  hdrFX.quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, hdrFX.quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  hdrFX.ok = true;
})();
function hdrTarget(w, h, depth) {
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  let dz = null;
  if (depth) { dz = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, dz);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, dz); }
  return { tex, fbo, dz, w, h };
}
// depth as a sampleable TEXTURE (the HDR fbo's own depth is a renderbuffer). We blit the
// scene depth into this each frame so the smoke pass can read it for soft-particle fade
// without a feedback loop (can't sample the depth attachment you're testing against).
function depthTexTarget(w, h) {
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
  return { tex, fbo, w, h };
}
function resizeHDR(w, h) {
  if (hdrFX.w === w && hdrFX.h === h && hdrFX.hdr) return;
  const del = t => { if (!t) return; gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); if (t.dz) gl.deleteRenderbuffer(t.dz); };
  del(hdrFX.hdr); del(hdrFX.bloomA); del(hdrFX.bloomB); del(hdrFX.depthCopy); del(hdrFX.smokeDens);
  const bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);
  hdrFX.hdr = hdrTarget(w, h, true); hdrFX.bloomA = hdrTarget(bw, bh, false); hdrFX.bloomB = hdrTarget(bw, bh, false);
  hdrFX.depthCopy = depthTexTarget(w, h); smoke.depthTex = hdrFX.depthCopy.tex;
  hdrFX.smokeDens = hdrTarget(bw, bh, false);           // half-res density accumulation for the seamless merge
  hdrFX.w = w; hdrFX.h = h; gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
function hdrTri(prog) { const l = gl.getAttribLocation(prog, "aP"); gl.bindBuffer(gl.ARRAY_BUFFER, hdrFX.quad);
  gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0); gl.drawArrays(gl.TRIANGLES, 0, 3); }
function runHDR() {
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.depthMask(false);
  const bw = hdrFX.bloomA.w, bh = hdrFX.bloomA.h;
  gl.bindFramebuffer(gl.FRAMEBUFFER, hdrFX.bloomA.fbo); gl.viewport(0, 0, bw, bh);
  gl.useProgram(hdrFX.bright); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, hdrFX.hdr.tex);
  gl.uniform1i(hdrFX.uB.tex, 0); gl.uniform1f(hdrFX.uB.thr, hdrFX.threshold); hdrTri(hdrFX.bright);
  gl.useProgram(hdrFX.blur); gl.uniform1i(hdrFX.uBl.tex, 0);
  for (let p = 0; p < 2; p++) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, hdrFX.bloomB.fbo); gl.viewport(0, 0, bw, bh);
    gl.bindTexture(gl.TEXTURE_2D, hdrFX.bloomA.tex); gl.uniform2f(hdrFX.uBl.dir, 1.0/bw, 0.0); hdrTri(hdrFX.blur);
    gl.bindFramebuffer(gl.FRAMEBUFFER, hdrFX.bloomA.fbo); gl.viewport(0, 0, bw, bh);
    gl.bindTexture(gl.TEXTURE_2D, hdrFX.bloomB.tex); gl.uniform2f(hdrFX.uBl.dir, 0.0, 1.0/bh); hdrTri(hdrFX.blur);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, cv.width, cv.height);
  gl.useProgram(hdrFX.comp);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, hdrFX.hdr.tex); gl.uniform1i(hdrFX.uC.scene, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, hdrFX.bloomA.tex); gl.uniform1i(hdrFX.uC.bloom, 1);
  gl.uniform1f(hdrFX.uC.exp, hdrFX.exposure); gl.uniform1f(hdrFX.uC.amt, hdrFX.bloomAmt); gl.uniform1f(hdrFX.uC.sat, hdrFX.sat);
  hdrTri(hdrFX.comp); gl.activeTexture(gl.TEXTURE0);
  gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
}
