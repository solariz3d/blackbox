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
uniform mat4 uMVP; uniform mat4 uModel;
varying vec3 vNrm; varying vec2 vUV; varying vec3 vWorld;
void main(){
  vec4 wp = uModel * vec4(aPos,1.0);
  gl_Position = uMVP * wp;
  vNrm = mat3(uModel) * aNrm;
  vUV = aUV;
  vWorld = wp.xyz;
}`;
const FST = `
precision mediump float;
varying vec3 vNrm; varying vec2 vUV; varying vec3 vWorld;
uniform sampler2D uTex;
uniform float uAlphaTest;
uniform float uAlpha;
uniform float uFogDensity; uniform vec3 uFogColor;
uniform vec3 uSunDir;            // direction TO the sun/moon (time-of-day driven)
uniform vec3 uSunCol;           // key-light colour + intensity (dim/cool at night)
uniform vec3 uAmbSky, uAmbGround; // hemisphere ambient: sky above, ground below
uniform vec3 uHeadA, uHeadB, uHeadDir; // headlight world positions + aim (cone spotlights)
uniform float uHeadInt;         // headlight intensity (0 by day, up at night)
uniform vec3 uBrakeA, uBrakeB, uBrakeDir; // tail-light world positions + backward aim
uniform float uBrakeInt;        // brake-light spill intensity (rises under braking, at night)
uniform sampler2D uShadowMap0, uShadowMap1;   // near + far cascade depth maps
uniform mat4 uLightVP0, uLightVP1;            // near + far light view-projections
uniform float uShadowOn, uShadowTexel0, uShadowTexel1;   // enable + 1/mapSize per cascade
uniform sampler2D uHeadDepth;   // scene depth from the headlight's view (beam occlusion)
uniform mat4 uHeadVP;           // headlight view-projection
uniform float uHeadOccOn;       // enable headlight occlusion
// one headlight: warm cone spotlight, distance-attenuated, cosine cone falloff
float headlamp(vec3 p){
  vec3 t = vWorld - p; float d = length(t);
  float cone = smoothstep(0.85, 0.97, dot(t / max(d, 1e-3), uHeadDir));  // wider cone
  return cone / (1.0 + 0.15 * d + 0.035 * d * d);                        // reaches further
}
// brake light: a wide, soft red wash spilling behind the car (not a focused beam)
float brakelamp(vec3 p){
  vec3 t = vWorld - p; float d = length(t);
  float back = smoothstep(-0.15, 0.7, dot(t / max(d, 1e-3), uBrakeDir)); // wide, favours behind
  return back / (1.0 + 0.35 * d + 0.14 * d * d);                         // short reach
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
// cascaded directional shadow: use the tight NEAR cascade where the fragment falls inside
// it (sharp), else the wide FAR cascade (distant track). The far cascade's depth range is
// large, so it needs a much bigger bias. 1 = fully lit.
float shadowFactor(vec3 wp, float bias){
  // near cascade (leave a small margin so it hands off to the far one before its edge)
  vec4 lp0 = uLightVP0 * vec4(wp, 1.0);
  vec3 c0 = lp0.xyz / lp0.w * 0.5 + 0.5;
  if (c0.x > 0.02 && c0.x < 0.98 && c0.y > 0.02 && c0.y < 0.98 && c0.z < 1.0)
    return pcf(uShadowMap0, c0.xy, c0.z, bias, uShadowTexel0);
  // far cascade, with a soft border fade so distant shadows don't pop at the box edge
  vec4 lp1 = uLightVP1 * vec4(wp, 1.0);
  vec3 c1 = lp1.xyz / lp1.w * 0.5 + 0.5;
  if (c1.z > 1.0) return 1.0;
  vec2 e = min(c1.xy, 1.0 - c1.xy);
  float edge = smoothstep(0.0, 0.05, min(e.x, e.y));
  if (edge <= 0.0) return 1.0;
  // far cascade spans the WHOLE track, so its NDC depth is very compressed — a small
  // fixed bias here is several metres of world offset (a big bias would peter-pan badly).
  return mix(1.0, pcf(uShadowMap1, c1.xy, c1.z, 0.0009, uShadowTexel1), edge);
}
void main(){
  vec4 tex = texture2D(uTex, vUV);
  if (uAlphaTest > 0.5 && tex.a < 0.5) discard;
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
  float sbias = 0.0006 + 0.0018 * (1.0 - ndl);
  vec3 wpS = vWorld + n * 0.06;
  float shF = uShadowOn > 0.5 ? shadowFactor(wpS, sbias) : 1.0;
  vec3 col = tex.rgb * (ambient + sunCol * (0.9 * wrap) * shF);
  // headlights actually light the road ahead (warm cones from the two lamps), and the
  // beam is occluded by scene geometry (banking, crests) so it can't shine through solids
  if (uHeadInt > 0.001) {
    float occ = uHeadOccOn > 0.5 ? headOcclusion() : 1.0;
    float lit = headlamp(uHeadA) + headlamp(uHeadB);
    col += tex.rgb * vec3(1.0, 0.85, 0.60) * (lit * uHeadInt * 5.5 * occ);
  }
  // brake lights spill red onto the road + surroundings behind the car (subtle)
  if (uBrakeInt > 0.001) {
    float b = brakelamp(uBrakeA) + brakelamp(uBrakeB);
    col += tex.rgb * vec3(1.0, 0.05, 0.02) * (b * uBrakeInt * 4.0);
  }
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
  mvp: gl.getUniformLocation(progT, "uMVP"),
  model: gl.getUniformLocation(progT, "uModel"),
  tex: gl.getUniformLocation(progT, "uTex"),
  alphaTest: gl.getUniformLocation(progT, "uAlphaTest"),
  alpha: gl.getUniformLocation(progT, "uAlpha"),
  fogD: gl.getUniformLocation(progT, "uFogDensity"),
  fogC: gl.getUniformLocation(progT, "uFogColor"),
  sun: gl.getUniformLocation(progT, "uSunDir"),
  sunCol: gl.getUniformLocation(progT, "uSunCol"),
  ambSky: gl.getUniformLocation(progT, "uAmbSky"),
  ambGround: gl.getUniformLocation(progT, "uAmbGround"),
  headA: gl.getUniformLocation(progT, "uHeadA"),
  headB: gl.getUniformLocation(progT, "uHeadB"),
  headDir: gl.getUniformLocation(progT, "uHeadDir"),
  headInt: gl.getUniformLocation(progT, "uHeadInt"),
  brakeA: gl.getUniformLocation(progT, "uBrakeA"),
  brakeB: gl.getUniformLocation(progT, "uBrakeB"),
  brakeDir: gl.getUniformLocation(progT, "uBrakeDir"),
  brakeInt: gl.getUniformLocation(progT, "uBrakeInt"),
  shadowMap0: gl.getUniformLocation(progT, "uShadowMap0"),
  shadowMap1: gl.getUniformLocation(progT, "uShadowMap1"),
  lightVP0: gl.getUniformLocation(progT, "uLightVP0"),
  lightVP1: gl.getUniformLocation(progT, "uLightVP1"),
  shadowOn: gl.getUniformLocation(progT, "uShadowOn"),
  shadowTexel0: gl.getUniformLocation(progT, "uShadowTexel0"),
  shadowTexel1: gl.getUniformLocation(progT, "uShadowTexel1"),
  headDepth: gl.getUniformLocation(progT, "uHeadDepth"),
  headVP: gl.getUniformLocation(progT, "uHeadVP"),
  headOccOn: gl.getUniformLocation(progT, "uHeadOccOn"),
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
