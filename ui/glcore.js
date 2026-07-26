/* glcore.js — WebGL context, shader programs, and their uniform/attrib locations.
 * Loaded before the main inline script (classic <script>, shared global scope), so
 * `gl`, `prog`, `progT`, `tLoc`, `shader()`, and the extension flags are globals the
 * rest of the app uses. The lit-scene fragment shader (FST) lives here — the day/night
 * lighting work edits it. Requires the <canvas id="gl"> to already be in the DOM. */

const cv = document.getElementById("gl");
const gl = cv.getContext("webgl2", { antialias: true }) || cv.getContext("webgl", { antialias: true });
const isGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;

function shader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

/* program 1: flat colour + fog — lines, ribbon, grid, cursor point */
const VS = `
attribute vec3 aPos; attribute vec4 aCol;
uniform mat4 uMVP; uniform float uPtSize;
varying vec4 vCol;
void main(){ gl_Position = uMVP * vec4(aPos,1.0); gl_PointSize = uPtSize; vCol = aCol; }`;
const FS = `
precision mediump float; varying vec4 vCol;
uniform float uFogDensity; uniform vec3 uFogColor;
void main(){
  float depth = gl_FragCoord.z / gl_FragCoord.w;
  float fog = clamp(exp(-uFogDensity * depth), 0.0, 1.0);
  gl_FragColor = vec4(mix(uFogColor, vCol.rgb, fog), vCol.a);
}`;
const prog = gl.createProgram();
gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(prog);
gl.useProgram(prog);
const locPos = gl.getAttribLocation(prog, "aPos");
const locCol = gl.getAttribLocation(prog, "aCol");
const locMVP = gl.getUniformLocation(prog, "uMVP");
const locPt = gl.getUniformLocation(prog, "uPtSize");
const locFogD = gl.getUniformLocation(prog, "uFogDensity");
const locFogC = gl.getUniformLocation(prog, "uFogColor");
gl.enable(gl.DEPTH_TEST);
gl.uniform3f(locFogC, 0.039, 0.051, 0.075);
gl.uniform1f(locFogD, 0.00012);

const extUint = isGL2 || gl.getExtension("OES_element_index_uint"); // core in GL2
const extS3TC = gl.getExtension("WEBGL_compressed_texture_s3tc");

/* program 2: textured + lit scene */
const VST = `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUV;
// BAKED LAMP LIGHT, per vertex. Track lamps never move and the track never moves, so their
// contribution to a static surface is a constant — computed once at load instead of by a
// 60-iteration loop in every fragment of every frame. Car geometry leaves this attribute
// unbound and gets the constant (0,0,0), which is what routes it down the live path.
attribute vec3 aLamp;
uniform mat4 uMVP; uniform mat4 uModel;
varying vec3 vNrm; varying vec2 vUV; varying vec3 vWorld; varying vec3 vLamp;
void main(){
  vec4 wp = uModel * vec4(aPos,1.0);
  gl_Position = uMVP * wp;
  vNrm = mat3(uModel) * aNrm;
  vUV = aUV;
  vWorld = wp.xyz;
  vLamp = aLamp;
}`;
const FST = `
precision mediump float;
varying vec3 vNrm; varying vec2 vUV; varying vec3 vWorld; varying vec3 vLamp;
uniform float uLampBake;   // night gate x master switch for the baked term; 0 disables it
uniform sampler2D uTex;
uniform float uAlphaTest;
uniform float uAlpha;
uniform vec3 uEye;               // camera position, for the specular half-vector
// PER-MATERIAL, from the kn5's property block. Defaults (0,0 / no emissive) reproduce the
// old flat-diffuse look exactly, which is what the car pass sets — this is a track feature.
uniform vec3 uEmissive;          // ksEmissive * gain; self-lit, unshadowed, no night gate
uniform float uEmisMap;          // 1 = a txEmissive mask exists on unit 1, 0 = use diffuse
uniform sampler2D uEmisTex;
uniform vec2 uSpec;              // x = ksSpecular, y = ksSpecularEXP
uniform float uAlphaRef;         // ksAlphaRef; 0 in the file means "use the default 0.5"
uniform float uFogDensity; uniform vec3 uFogColor;
uniform vec3 uSunDir;            // direction TO the sun/moon (time-of-day driven)
uniform vec3 uSunCol;           // key-light colour + intensity (dim/cool at night)
uniform vec3 uAmbSky, uAmbGround; // hemisphere ambient: sky above, ground below
// LAMPS ARE PER CAR, up to MAXCARS of them. This was one car's worth of uniforms, which
// meant that with several cars on track a car could only ever be lit by ONE other — so
// some pairs lit each other and some didn't, seemingly at random. Two lamps per car, so
// position array is 2*MAXCARS; aim and intensity are per car.
const int MAXCARS = 4;
uniform vec3 uHeadPos[2 * MAXCARS];   // headlight world positions (2 per car)
uniform vec3 uHeadAim[MAXCARS];       // per-car aim
uniform float uHeadInt[MAXCARS];      // per-car intensity (0 by day, up at night)
uniform vec3 uBrakePos[2 * MAXCARS];  // tail-light world positions
uniform vec3 uBrakeAim[MAXCARS];      // per-car backward aim
uniform float uBrakeInt[MAXCARS];     // per-car brake spill (rises under braking, at night)
uniform int uCarN;                    // how many of those slots are live

// TRACK LIGHTS — the floodlights and lamp posts the track author placed, read from CSP's
// LIGHT_SERIES config. Static in the world, unlike the car lamps above, so they are a
// separate set: a track can declare hundreds (nordic 207, thunderhead 156) and the CPU
// sends only the nearest handful each frame.
// 64, and this is the third value: 12 → 24 (sakura's 143 read as patchy from any distance)
// → 64. The same wall each time, because a slot budget below a track's lamp count does not
// merely dim the extras — it makes WHICH lamps are lit depend on where the camera is, so
// lamps switch on as you approach and others switch off behind you. The T-180 test track
// declares 60 (measured, test_tracklights.js) against 24 slots, which is why 36 of its
// pools were dark at any moment and the set changed as you drove.
//
// 64 is chosen to clear 60, not as a round number. It does NOT cover nordic (207) or
// thunderhead (156); those still swap, and the honest fix for them is clustered lighting
// rather than a bigger array — every fragment loops over every sent light, so this number
// is bounded by fill cost long before it is bounded by uniform space.
// Must match MAX_TLIGHTS in index.html.
const int MAXTLIGHTS = 64;
uniform vec3 uTLightPos[MAXTLIGHTS];   // world position
uniform vec3 uTLightCol[MAXTLIGHTS];   // colour * intensity, already night-scaled
uniform vec3 uTLightDir[MAXTLIGHTS];   // aim, for spots
uniform vec2 uTLightArg[MAXTLIGHTS];   // x = range (m), y = cos(half-angle), <0 = point light
uniform int uTLightN;
uniform sampler2D uShadowMap0, uShadowMap1;   // near + far cascade depth maps
uniform mat4 uLightVP0, uLightVP1;            // near + far light view-projections
uniform float uShadowOn, uShadowTexel0, uShadowTexel1;   // enable + 1/mapSize per cascade
uniform float uShadowDepth0;                  // near cascade's light-box depth, in METRES
uniform sampler2D uHeadDepth;   // scene depth from the headlight's view (beam occlusion)
uniform mat4 uHeadVP;           // headlight view-projection
uniform float uHeadOccOn;       // enable headlight occlusion
// one headlight: warm cone spotlight, distance-attenuated, cosine cone falloff
// nrm is the lit surface's normal, and it is not optional: without an N.L term a lamp
// lights every surface in its cone equally, INCLUDING ones facing away from it. On flat
// road that is invisible, which is why it survived — but put a car in another car's beam
// and the whole body glows, far side included, as if lit from within. N.L restores the
// terminator: a surface turned away from the lamp is dark because it is facing away.
// (This is FORM shadow only. One car's body still does not CAST a beam shadow onto
// another — that needs a depth map per lamp, i.e. a render pass per car.)
float headlamp(vec3 p, vec3 aim, vec3 nrm){
  vec3 t = vWorld - p; float d = length(t);
  vec3 dir = t / max(d, 1e-3);
  float cone = smoothstep(0.85, 0.97, dot(dir, aim));                    // wider cone
  float ndl = max(dot(nrm, -dir), 0.0);                                  // -dir = fragment -> lamp
  return cone * ndl / (1.0 + 0.15 * d + 0.035 * d * d);                  // reaches further
}
// brake light: a wide, soft red wash spilling behind the car (not a focused beam)
float brakelamp(vec3 p, vec3 aim, vec3 nrm){
  vec3 t = vWorld - p; float d = length(t);
  vec3 dir = t / max(d, 1e-3);
  float back = smoothstep(-0.15, 0.7, dot(dir, aim));                    // wide, favours behind
  float ndl = max(dot(nrm, -dir), 0.0);
  return back * ndl / (1.0 + 0.35 * d + 0.14 * d * d);                   // short reach
}
// is this fragment blocked from the headlight by scene geometry? sample the beam depth map
// (rendered from the headlight's view) so the track/banking actually occludes the beam.
float headOcclusion(){
  vec4 hp = uHeadVP * vec4(vWorld, 1.0);
  vec3 c = hp.xyz / hp.w * 0.5 + 0.5;
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  float stored = texture2D(uHeadDepth, c.xy).r;
  return (c.z - 0.004 > stored) ? 0.0 : 1.0;   // something nearer the lamp blocks the beam
}
// 3x3 PCF against one cascade
float pcf(sampler2D map, vec2 uv, float z, float bias, float texel){
  float sh = 0.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) {
    float d = texture2D(map, uv + vec2(float(x), float(y)) * texel).r;
    sh += (z - bias > d) ? 0.0 : 1.0;
  }
  return sh / 9.0;
}
// cascaded directional shadow: the tight NEAR cascade carries the sharp shadow under and
// around the car; the wide FAR cascade carries the rest of the track. The two are BLENDED
// across the near box's border instead of switched with an if. The hard switch was the
// pop: at a fixed radius from the car a crisp shadow snapped to the coarse whole-track
// one in a single pixel, which reads as shadows appearing as you drive up to them.
// 1 = fully lit.
float shadowFactor(vec3 wp, float bias){
  // near cascade weight — 1 well inside the box, easing to 0 across its outer border
  vec4 lp0 = uLightVP0 * vec4(wp, 1.0);
  vec3 c0 = lp0.xyz / lp0.w * 0.5 + 0.5;
  float wNear = 0.0;
  if (c0.z < 1.0) {
    vec2 e0 = min(c0.xy, 1.0 - c0.xy);
    wNear = smoothstep(0.02, 0.12, min(e0.x, e0.y));   // outer ~10% of the box is the fade
  }
  float sNear = wNear > 0.0 ? pcf(uShadowMap0, c0.xy, c0.z, bias, uShadowTexel0) : 1.0;
  if (wNear >= 1.0) return sNear;        // fully inside the near box — skip the far sample
  // far cascade, with its own soft fade at the very edge of the bake
  vec4 lp1 = uLightVP1 * vec4(wp, 1.0);
  vec3 c1 = lp1.xyz / lp1.w * 0.5 + 0.5;
  float sFar = 1.0;
  if (c1.z <= 1.0) {
    vec2 e1 = min(c1.xy, 1.0 - c1.xy);
    float edge = smoothstep(0.0, 0.05, min(e1.x, e1.y));
    // far cascade spans the WHOLE track, so its NDC depth is very compressed — a small
    // fixed bias here is several metres of world offset (a big bias would peter-pan badly).
    if (edge > 0.0) sFar = mix(1.0, pcf(uShadowMap1, c1.xy, c1.z, 0.0009, uShadowTexel1), edge);
  }
  return mix(sFar, sNear, wNear);
}
void main(){
  vec4 tex = texture2D(uTex, vUV);
  if (uAlphaTest > 0.5 && tex.a < uAlphaRef) discard;
  vec3 n = normalize(vNrm);
  // directional key light + hemisphere ambient, all driven by the time of day
  float ndl = max(dot(n, normalize(uSunDir)), 0.0);
  float sky = 0.5 + 0.5 * n.y;
  vec3 ambient = mix(uAmbGround, uAmbSky, sky);
  vec3 sunCol = uSunCol;
  // soft wrap on the key so shaded faces don't crush to black
  float wrap = ndl * 0.85 + 0.15 * (0.5 + 0.5 * dot(n, normalize(uSunDir)));
  // normal-offset bias: nudge the sample off the surface ALONG ITS NORMAL. This kills
  // self-shadow acne AND the peter-panning (shadow floating off) on banked surfaces —
  // a depth-only bias slides the shadow along an angled surface, this doesn't. So the
  // depth bias can stay small (just a touch more at grazing sun for dusk stability).
  // Bias is stated in METRES and converted to this cascade's depth range, not written as
  // a raw NDC number. An NDC bias silently changes meaning whenever the light box gets
  // deeper — the same 0.0006 is 10 cm in a 160 m box and 60 cm in a 1 km one, which is
  // the difference between correct and shadows floating off their objects.
  float sbias = (0.10 + 0.30 * (1.0 - ndl)) / max(uShadowDepth0, 1.0);
  vec3 wpS = vWorld + n * 0.06;
  float shF = uShadowOn > 0.5 ? shadowFactor(wpS, sbias) : 1.0;
  vec3 col = tex.rgb * (ambient + sunCol * (0.9 * wrap) * shF);
  /* Specular from the key light, Blinn-Phong, with the material's OWN gloss. Every track
   * material on disk carries ksSpecular (median 0.2) and ksSpecularEXP (median 10, up to
   * 1000) and the renderer was using neither, so asphalt, glass, painted kerbs and grass
   * all returned light identically — which is what made surfaces read as felt. Shadowed
   * with the same factor as the key, because a highlight from an occluded sun is a hole in
   * the illusion far more obvious than a missing one. Only where the sun actually lands
   * (ndl > 0), so back faces cannot pick up a rim of light from a source behind them. */
  if (uSpec.x > 0.001 && ndl > 0.0) {
    vec3 h = normalize(normalize(uSunDir) + normalize(uEye - vWorld));
    col += sunCol * (uSpec.x * pow(max(dot(n, h), 0.0), max(uSpec.y, 1.0)) * shF);
  }
  /* Track lights. Inverse-square would be physically right and looks wrong here: a lamp
   * with a declared RANGE is an artistic statement about how far it should reach, so the
   * falloff is normalised to that range and hits exactly zero at its edge. Without that a
   * light culled at its range boundary pops as it enters the sent set. */
  /* The baked term. On track geometry this replaces the loop below entirely — uTLightN is
   * set to 0 for those draws, so the loop exits on its first iteration. Interpolated across
   * the triangle by the rasteriser, which is free. */
  col += tex.rgb * vLamp * uLampBake;
  for (int i = 0; i < MAXTLIGHTS; i++) {
    if (i >= uTLightN) break;
    vec3 t = uTLightPos[i] - vWorld;
    float range = uTLightArg[i].x;
    /* REJECT BEFORE THE SQRT. Measured on the T-180 test track (test_lampdensity.js): a
     * fragment is in range of 9.9 lamps on average out of 60 sent, so 83% of the iterations
     * of this loop end here. Taking length() first paid a square root on every one of those
     * rejections; comparing squared distances is the identical test for non-negative values
     * and defers the sqrt to the ~17% that survive. */
    float d2 = dot(t, t);
    if (d2 > range * range) continue;
    float d = sqrt(d2);
    vec3 Ld = t / max(d, 1e-3);
    float ndl = max(dot(n, Ld), 0.0);          // a surface facing away is not lit
    if (ndl <= 0.0) continue;
    float att = 1.0 - d / max(range, 1e-3);
    att *= att;                                 // quadratic-ish, but zero AT the range
    float cone = 1.0;
    float cosHalf = uTLightArg[i].y;
    if (cosHalf > -0.5) {                       // a spot, not a point
      float c = dot(-Ld, uTLightDir[i]);
      cone = smoothstep(cosHalf, mix(cosHalf, 1.0, 0.35), c);
    }
    col += tex.rgb * uTLightCol[i] * (ndl * att * cone);
  }

  // Every car's headlights light the road ahead AND every other car. Occlusion is sampled
  // from car 0's beam depth map only — there is one such map, and the car whose beam the
  // chair is following is the one whose shadowing is worth being right.
  float occ = uHeadOccOn > 0.5 ? headOcclusion() : 1.0;
  for (int c = 0; c < MAXCARS; c++) {
    if (c >= uCarN) break;
    if (uHeadInt[c] > 0.001) {
      float lit = headlamp(uHeadPos[2 * c], uHeadAim[c], n) + headlamp(uHeadPos[2 * c + 1], uHeadAim[c], n);
      col += tex.rgb * vec3(1.0, 0.85, 0.60) * (lit * uHeadInt[c] * 5.5 * (c == 0 ? occ : 1.0));
    }
    // brake lights spill red onto the road + surroundings behind that car (subtle)
    if (uBrakeInt[c] > 0.001) {
      float b = brakelamp(uBrakePos[2 * c], uBrakeAim[c], n) + brakelamp(uBrakePos[2 * c + 1], uBrakeAim[c], n);
      col += tex.rgb * vec3(1.0, 0.05, 0.02) * (b * uBrakeInt[c] * 4.0);
    }
  }
  /* EMISSIVE — self-lit, so it is added after all the lighting and gated by none of it: not
   * by the shadow map, not by the night factor, not by N.L. That is the whole point of a
   * lit sign. It IS still fogged below, because distance haze sits between the eye and the
   * light no matter what made the light.
   *
   * The mask is what makes this correct rather than merely bright. Aurora's road materials
   * declare ksEmissive 3.0 with a txEmissive beside them, and the glow lives only where
   * that mask paints it — the strips. Without the mask the same number turns the entire
   * racing surface into a light box. Materials with no mask (thunderhead's LED panels) fall
   * back to the diffuse, which keeps their texture detail instead of flooding a flat colour. */
  vec3 emis = uEmisMap > 0.5 ? texture2D(uEmisTex, vUV).rgb : tex.rgb;
  col += uEmissive * emis;
  // aerial fog for depth (blend toward the sky colour). NOTE: output is UNCLAMPED HDR —
  // the ACES tonemap in the post pass owns the final tone; bright bits (> 1) bloom.
  float depth = gl_FragCoord.z / gl_FragCoord.w;
  float fog = clamp(exp(-uFogDensity * depth), 0.0, 1.0);
  gl_FragColor = vec4(mix(uFogColor, col, fog), uAlpha);
}`;
const progT = gl.createProgram();
gl.attachShader(progT, shader(gl.VERTEX_SHADER, VST));
gl.attachShader(progT, shader(gl.FRAGMENT_SHADER, FST));
gl.linkProgram(progT);
const tLoc = {
  pos: gl.getAttribLocation(progT, "aPos"),
  nrm: gl.getAttribLocation(progT, "aNrm"),
  uv: gl.getAttribLocation(progT, "aUV"),
  lamp: gl.getAttribLocation(progT, "aLamp"),
  lampBake: gl.getUniformLocation(progT, "uLampBake"),
  mvp: gl.getUniformLocation(progT, "uMVP"),
  model: gl.getUniformLocation(progT, "uModel"),
  tex: gl.getUniformLocation(progT, "uTex"),
  alphaTest: gl.getUniformLocation(progT, "uAlphaTest"),
  alpha: gl.getUniformLocation(progT, "uAlpha"),
  eye: gl.getUniformLocation(progT, "uEye"),
  emissive: gl.getUniformLocation(progT, "uEmissive"),
  emisMap: gl.getUniformLocation(progT, "uEmisMap"),
  emisTex: gl.getUniformLocation(progT, "uEmisTex"),
  spec: gl.getUniformLocation(progT, "uSpec"),
  alphaRef: gl.getUniformLocation(progT, "uAlphaRef"),
  fogD: gl.getUniformLocation(progT, "uFogDensity"),
  fogC: gl.getUniformLocation(progT, "uFogColor"),
  sun: gl.getUniformLocation(progT, "uSunDir"),
  sunCol: gl.getUniformLocation(progT, "uSunCol"),
  ambSky: gl.getUniformLocation(progT, "uAmbSky"),
  ambGround: gl.getUniformLocation(progT, "uAmbGround"),
  headPos: gl.getUniformLocation(progT, "uHeadPos"),
  headAim: gl.getUniformLocation(progT, "uHeadAim"),
  brakePos: gl.getUniformLocation(progT, "uBrakePos"),
  brakeAim: gl.getUniformLocation(progT, "uBrakeAim"),
  carN: gl.getUniformLocation(progT, "uCarN"),
  tLightPos: gl.getUniformLocation(progT, "uTLightPos"),
  tLightCol: gl.getUniformLocation(progT, "uTLightCol"),
  tLightDir: gl.getUniformLocation(progT, "uTLightDir"),
  tLightArg: gl.getUniformLocation(progT, "uTLightArg"),
  tLightN: gl.getUniformLocation(progT, "uTLightN"),
  headInt: gl.getUniformLocation(progT, "uHeadInt"),
  brakeInt: gl.getUniformLocation(progT, "uBrakeInt"),
  shadowMap0: gl.getUniformLocation(progT, "uShadowMap0"),
  shadowMap1: gl.getUniformLocation(progT, "uShadowMap1"),
  lightVP0: gl.getUniformLocation(progT, "uLightVP0"),
  lightVP1: gl.getUniformLocation(progT, "uLightVP1"),
  shadowOn: gl.getUniformLocation(progT, "uShadowOn"),
  shadowTexel0: gl.getUniformLocation(progT, "uShadowTexel0"),
  shadowTexel1: gl.getUniformLocation(progT, "uShadowTexel1"),
  shadowDepth0: gl.getUniformLocation(progT, "uShadowDepth0"),
  headDepth: gl.getUniformLocation(progT, "uHeadDepth"),
  headVP: gl.getUniformLocation(progT, "uHeadVP"),
  headOccOn: gl.getUniformLocation(progT, "uHeadOccOn"),
};

/* program 2b: reflective GLASS (windscreen) — fresnel rim + fake sky/ground reflection + a sharp
 * sun specular glint that slides across as the car moves. Semi-transparent, HDR out (the glint blooms). */
const progGlass = gl.createProgram();
gl.attachShader(progGlass, shader(gl.VERTEX_SHADER,
  "attribute vec3 aPos; attribute vec3 aNrm; uniform mat4 uMVP, uModel; varying vec3 vN, vW;" +
  "void main(){ vec4 wp = uModel*vec4(aPos,1.0); vW = wp.xyz; vN = mat3(uModel)*aNrm; gl_Position = uMVP*wp; }"));
gl.attachShader(progGlass, shader(gl.FRAGMENT_SHADER,
  "precision highp float; varying vec3 vN, vW;" +
  "uniform vec3 uEye, uSunDir, uSunCol, uSkyCol, uGroundCol, uFogColor, uTint; uniform float uFogDensity, uOpacity;" +
  "void main(){" +
  "  vec3 N = normalize(vN); vec3 V = normalize(uEye - vW); if (dot(N,V) < 0.0) N = -N;" +
  "  float ndv = max(dot(N,V), 0.0);" +
  "  float fres = pow(1.0 - ndv, 4.0);" +                                   // rim reflection, strong at grazing
  "  vec3 R = reflect(-V, N); float up = clamp(R.y*0.5+0.5, 0.0, 1.0);" +
  "  vec3 env = mix(uGroundCol, uSkyCol, up);" +                            // fake environment reflection
  "  float spec = pow(max(dot(R, normalize(uSunDir)), 0.0), 200.0);" +      // sharp sun glint
  "  vec3 col = mix(uTint, env, clamp(fres + 0.12, 0.0, 1.0)) + uSunCol * spec * 4.0;" +
  "  float alpha = clamp(uOpacity + fres*0.65 + spec, 0.0, 0.95);" +
  "  float depth = gl_FragCoord.z / gl_FragCoord.w; float fog = clamp(exp(-uFogDensity*depth), 0.0, 1.0);" +
  "  gl_FragColor = vec4(mix(uFogColor, col, fog), alpha);" +
  "}"));
gl.linkProgram(progGlass);
const gLoc = {
  pos: gl.getAttribLocation(progGlass, "aPos"), nrm: gl.getAttribLocation(progGlass, "aNrm"),
  mvp: gl.getUniformLocation(progGlass, "uMVP"), model: gl.getUniformLocation(progGlass, "uModel"),
  eye: gl.getUniformLocation(progGlass, "uEye"), sun: gl.getUniformLocation(progGlass, "uSunDir"),
  sunCol: gl.getUniformLocation(progGlass, "uSunCol"), sky: gl.getUniformLocation(progGlass, "uSkyCol"),
  ground: gl.getUniformLocation(progGlass, "uGroundCol"), fogC: gl.getUniformLocation(progGlass, "uFogColor"),
  fogD: gl.getUniformLocation(progGlass, "uFogDensity"), tint: gl.getUniformLocation(progGlass, "uTint"),
  opacity: gl.getUniformLocation(progGlass, "uOpacity"),
};

/* depth-only caster: renders the car from the light's view into the shadow map */
const progDepth = gl.createProgram();
gl.attachShader(progDepth, shader(gl.VERTEX_SHADER,
  "attribute vec3 aPos; uniform mat4 uLightVP, uModel;" +
  "void main(){ gl_Position = uLightVP * uModel * vec4(aPos,1.0); }"));
gl.attachShader(progDepth, shader(gl.FRAGMENT_SHADER,
  "precision mediump float; void main(){ gl_FragColor = vec4(1.0); }"));
gl.linkProgram(progDepth);
const depthLoc = {
  pos: gl.getAttribLocation(progDepth, "aPos"),
  lightVP: gl.getUniformLocation(progDepth, "uLightVP"),
  model: gl.getUniformLocation(progDepth, "uModel"),
};

/* program: tyre skid marks — a dark ribbon laid along the recorded contact patch.
 * The WHOLE mesh is prebuilt once (each vertex tagged with the frame + lap it was
 * laid at and its slip intensity); the shader reveals it up to the current frame,
 * so marks "draw on" as the car drives, scrub correctly, and cost ~nothing live.
 * uMarkMode 0 = reset each lap (show only the current lap); 1 = accumulate + fade. */
const progMark = gl.createProgram();
gl.attachShader(progMark, shader(gl.VERTEX_SHADER,
  "attribute vec3 aPos; attribute float aFrame; attribute float aLap; attribute float aInten;" +
  "attribute float aCross; attribute float aRun;" +
  "uniform mat4 uMVP; varying float vFrame; varying float vLap; varying float vInten;" +
  "varying float vCross; varying float vRun;" +
  "void main(){ gl_Position = uMVP*vec4(aPos,1.0); vFrame=aFrame; vLap=aLap; vInten=aInten; vCross=aCross; vRun=aRun; }"));
gl.attachShader(progMark, shader(gl.FRAGMENT_SHADER,
  "precision mediump float; varying float vFrame; varying float vLap; varying float vInten;" +
  "varying float vCross; varying float vRun;" +
  "uniform float uCurFrame, uCurLap, uMarkMode, uFadeFrames, uMarkAlpha;" +
  "uniform vec3 uMarkColor, uFogColor; uniform float uFogDensity;" +
  "void main(){" +
  "  if (vFrame > uCurFrame) discard;" +                                  // not laid yet
  "  float a = vInten;" +
  "  if (uMarkMode < 0.5) { if (abs(vLap - uCurLap) > 0.5) discard; }" +  // reset each lap
  "  else { a *= clamp(1.0 - (uCurFrame - vFrame)/uFadeFrames, 0.0, 1.0); }" +  // accumulate + fade
  // tread texture: fine longitudinal striations across the width, mottled grain along
  // the length, and feathered edges so the ribbon isn't a hard-edged rectangle.
  "  float edge = 1.0 - smoothstep(0.72, 1.0, abs(vCross));" +
  "  float stri = 0.60 + 0.40 * abs(sin(vCross * 30.0));" +               // ~10 tread lines across
  "  float grain = 0.80 + 0.20 * sin(vRun * 3.3 + vCross * 5.0);" +
  "  a *= uMarkAlpha * edge * stri * grain; if (a <= 0.01) discard;" +
  "  float depth = gl_FragCoord.z / gl_FragCoord.w;" +
  "  float fog = clamp(exp(-uFogDensity*depth), 0.0, 1.0);" +
  "  gl_FragColor = vec4(mix(uFogColor, uMarkColor, fog), a);" +
  "}"));
gl.linkProgram(progMark);
const markLoc = {
  pos: gl.getAttribLocation(progMark, "aPos"),
  frame: gl.getAttribLocation(progMark, "aFrame"),
  lap: gl.getAttribLocation(progMark, "aLap"),
  inten: gl.getAttribLocation(progMark, "aInten"),
  cross: gl.getAttribLocation(progMark, "aCross"),
  run: gl.getAttribLocation(progMark, "aRun"),
  mvp: gl.getUniformLocation(progMark, "uMVP"),
  curFrame: gl.getUniformLocation(progMark, "uCurFrame"),
  curLap: gl.getUniformLocation(progMark, "uCurLap"),
  mode: gl.getUniformLocation(progMark, "uMarkMode"),
  fade: gl.getUniformLocation(progMark, "uFadeFrames"),
  markAlpha: gl.getUniformLocation(progMark, "uMarkAlpha"),
  markColor: gl.getUniformLocation(progMark, "uMarkColor"),
  fogC: gl.getUniformLocation(progMark, "uFogColor"),
  fogD: gl.getUniformLocation(progMark, "uFogDensity"),
};

/* program: tyre smoke — soft camera-facing billboards, live-simulated in JS and
 * rebuilt into a dynamic VBO each frame. Emitted off the same slip signal as the
 * skid marks. Depth-tested (ground/car occlude it) but doesn't write depth. */
const progSmoke = gl.createProgram();
gl.attachShader(progSmoke, shader(gl.VERTEX_SHADER,
  "attribute vec3 aCenter; attribute vec2 aCorner; attribute float aSize; attribute float aAlpha;" +
  "attribute float aSeed; attribute float aLife;" +
  "uniform mat4 uMVP; uniform vec3 uCamRight, uCamUp;" +
  "varying vec2 vCorner; varying float vAlpha; varying float vSeed; varying float vLife;" +
  "void main(){ vec3 wp = aCenter + (uCamRight*aCorner.x + uCamUp*aCorner.y)*aSize;" +
  "  gl_Position = uMVP*vec4(wp,1.0); vCorner=aCorner; vAlpha=aAlpha; vSeed=aSeed; vLife=aLife; }"));
gl.attachShader(progSmoke, shader(gl.FRAGMENT_SHADER,
  "precision highp float;" +                                    // highp: linZ overflows mediump at far=60000
  "varying vec2 vCorner; varying float vAlpha; varying float vSeed; varying float vLife;" +
  "uniform sampler2D uNoise;" +                                  // baked domain-warped fbm, REPEAT wrap
  "uniform vec3 uCamRight, uCamUp;" +
  "uniform vec3 uSunDir, uSunCol, uAmbSky, uAmbGround;" +        // lit like the scene, output linear (blooms)
  "uniform vec3 uFogColor; uniform float uFogDensity;" +
  "uniform sampler2D uSceneDepth; uniform vec2 uScreen, uCamRange; uniform float uSoftOn, uFadeDist;" +
  "mat2 rot(float a){ float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }" +
  "float linZ(float d){ float z=d*2.0-1.0; float n=uCamRange.x, f=uCamRange.y; return (2.0*n*f)/(f+n - z*(f-n)); }" +
  "void main(){" +
  "  float r = length(vCorner); if (r > 1.0) discard;" +
  // baked noise: two rotated/scrolling layers, evolving over the particle's life → churn
  "  float ang = vSeed*6.2831;" +
  "  vec2 base = rot(ang)*(vCorner*0.5+0.5) + vSeed*7.0;" +
  "  vec2 uv1 = base + vec2(0.03,-0.12)*vLife;" +
  "  vec2 uv2 = base*1.7 + vec2(-0.07,0.05)*vLife + 3.1;" +
  "  float n = texture2D(uNoise, uv1).r*0.65 + texture2D(uNoise, uv2).r*0.35;" +
  // SMOOTH radial blob (metaball splat) so overlapping puffs sum into one seamless field;
  // noise only gently modulates internal density (no carved holes → nothing to look bubbly).
  "  float edge = smoothstep(1.0, 0.0, r); edge *= edge;" +
  "  float density = edge * (0.6 + 0.4*n);" +
  // shading: billboard spherical normal in world space → half-Lambert key + hemisphere ambient
  "  vec3 fwd = normalize(cross(uCamRight, uCamUp));" +
  "  vec3 N = normalize(uCamRight*vCorner.x + uCamUp*vCorner.y + fwd*sqrt(max(0.0,1.0-r*r)));" +
  "  float wrap = pow(max(dot(N, uSunDir)*0.5+0.5, 0.0), 2.0);" +
  "  float sky = 0.5 + 0.5*N.y;" +
  "  vec3 ambient = mix(uAmbGround, uAmbSky, sky);" +
  "  float vshadow = 0.55 + 0.45*(vCorner.y*0.5+0.5);" +          // lower part of the puff darker
  // base grey so smoke reads even when the scene lighting is crushed (night); the sun/
  // ambient add on top (day rims bloom). Without this, night smoke shades to ~black.
  "  vec3 col = (vec3(0.22) + ambient + uSunCol*wrap) * vshadow;" +
  // soft-particle depth fade (no hard line where smoke meets ground/car)
  "  float soft = 1.0;" +
  "  if (uSoftOn > 0.5) {" +
  "    float sd = texture2D(uSceneDepth, gl_FragCoord.xy/uScreen).r;" +
  // fail-safe: only fade where there's real geometry behind (sd in (0,1)). If the depth
  // copy is empty/sky, don't fade — show the puff rather than killing every fragment.
  "    if (sd > 0.0005 && sd < 0.999999) {" +
  "      soft = clamp((linZ(sd) - linZ(gl_FragCoord.z))/uFadeDist, 0.0, 1.0);" +
  "    }" +
  "  }" +
  "  float a = clamp(density,0.0,1.0) * vAlpha * soft;" +
  "  if (a <= 0.004) discard;" +
  "  float depth = gl_FragCoord.z / gl_FragCoord.w;" +
  "  float fog = clamp(exp(-uFogDensity*depth), 0.0, 1.0);" +
  "  vec3 outc = mix(uFogColor, col, fog);" +
  "  gl_FragColor = vec4(outc*a, a);" +                           // premultiplied
  "}"));
gl.linkProgram(progSmoke);
const smokeLoc = {
  center: gl.getAttribLocation(progSmoke, "aCenter"),
  corner: gl.getAttribLocation(progSmoke, "aCorner"),
  size: gl.getAttribLocation(progSmoke, "aSize"),
  alpha: gl.getAttribLocation(progSmoke, "aAlpha"),
  seed: gl.getAttribLocation(progSmoke, "aSeed"),
  life: gl.getAttribLocation(progSmoke, "aLife"),
  mvp: gl.getUniformLocation(progSmoke, "uMVP"),
  camRight: gl.getUniformLocation(progSmoke, "uCamRight"),
  camUp: gl.getUniformLocation(progSmoke, "uCamUp"),
  noise: gl.getUniformLocation(progSmoke, "uNoise"),
  sunDir: gl.getUniformLocation(progSmoke, "uSunDir"),
  sunCol: gl.getUniformLocation(progSmoke, "uSunCol"),
  ambSky: gl.getUniformLocation(progSmoke, "uAmbSky"),
  ambGround: gl.getUniformLocation(progSmoke, "uAmbGround"),
  fogC: gl.getUniformLocation(progSmoke, "uFogColor"),
  fogD: gl.getUniformLocation(progSmoke, "uFogDensity"),
  sceneDepth: gl.getUniformLocation(progSmoke, "uSceneDepth"),
  screen: gl.getUniformLocation(progSmoke, "uScreen"),
  camRange: gl.getUniformLocation(progSmoke, "uCamRange"),
  softOn: gl.getUniformLocation(progSmoke, "uSoftOn"),
  fadeDist: gl.getUniformLocation(progSmoke, "uFadeDist"),
};

/* smoke composite: read the additively-accumulated density buffer (rgb = Σ litColour·cov,
 * a = Σ cov) and map the summed density through a smooth ramp. Overlapping puffs sum, so
 * the ramp draws ONE boundary around the merged mass — the "bubbles" fuse into one field. */
const progSmokeComp = gl.createProgram();
gl.attachShader(progSmokeComp, shader(gl.VERTEX_SHADER,
  "attribute vec2 aP; varying vec2 vUv; void main(){ vUv = aP*0.5+0.5; gl_Position = vec4(aP,0.0,1.0); }"));
gl.attachShader(progSmokeComp, shader(gl.FRAGMENT_SHADER,
  "precision highp float; varying vec2 vUv;" +
  "uniform sampler2D uDens, uNoise, uSceneDepth;" +
  "uniform mat4 uInvVP; uniform vec3 uWind;" +
  "uniform float uLo, uHi, uTime, uErode;" +
  "float n2(vec2 p){ return texture2D(uNoise, p).r; }" +
  // pseudo-3D turbulence from the baked 2D noise: two planes × two octaves
  "float turb(vec3 p){" +
  "  float a = n2(p.xz*0.12)*0.6 + n2(p.yx*0.12+4.3)*0.4;" +
  "  float b = n2(p.xz*0.31+1.7)*0.6 + n2(p.zy*0.31+8.1)*0.4;" +
  "  return a*0.65 + b*0.35;" +
  "}" +
  "void main(){" +
  "  vec4 d = texture2D(uDens, vUv); float dens = d.a;" +
  "  if (dens <= 0.001) discard;" +
  // reconstruct the world point behind the smoke (≈ smoke position near the track) so the
  // turbulence is world-anchored (doesn't swim with the camera), advected by the wind.
  "  float sd = texture2D(uSceneDepth, vUv).r;" +
  "  vec4 wp = uInvVP * vec4(vUv*2.0-1.0, sd*2.0-1.0, 1.0); vec3 wpos = wp.xyz/wp.w;" +
  "  float t = turb(wpos - uWind*uTime);" +
  "  float cov0 = dens - uErode * t * dens;" +           // erode ∝ density → thin edges fray into wisps
  "  float cov = smoothstep(uLo, uHi, cov0);" +
  "  if (cov <= 0.003) discard;" +
  "  vec3 col = d.rgb / max(dens, 1e-4);" +              // coverage-weighted average lit colour
  "  gl_FragColor = vec4(col, cov);" +
  "}"));
gl.linkProgram(progSmokeComp);
const smokeCompLoc = {
  dens: gl.getUniformLocation(progSmokeComp, "uDens"),
  noise: gl.getUniformLocation(progSmokeComp, "uNoise"),
  sceneDepth: gl.getUniformLocation(progSmokeComp, "uSceneDepth"),
  invVP: gl.getUniformLocation(progSmokeComp, "uInvVP"),
  wind: gl.getUniformLocation(progSmokeComp, "uWind"),
  lo: gl.getUniformLocation(progSmokeComp, "uLo"),
  hi: gl.getUniformLocation(progSmokeComp, "uHi"),
  time: gl.getUniformLocation(progSmokeComp, "uTime"),
  erode: gl.getUniformLocation(progSmokeComp, "uErode"),
};
