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
uniform sampler2D uShadowMap;   // car depth from the light's view (directional shadow map)
uniform mat4 uLightVP;          // light view-projection
uniform float uShadowOn, uShadowTexel;   // enable (0/1) + 1/mapSize for PCF
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
// directional shadow: project the fragment into light space and PCF-compare against the
// car's depth map, so the car casts a soft shadow that swings with the sun/moon. 1 = lit.
float shadowFactor(vec3 wp, float bias){
  vec4 lp = uLightVP * vec4(wp, 1.0);
  vec3 c = lp.xyz / lp.w * 0.5 + 0.5;
  if (c.z > 1.0) return 1.0;
  // fade the shadow out toward the map border instead of hard-cutting it — otherwise on
  // loops/corkscrews the stretched shadow pops in and out as it crosses the box edge.
  vec2 e = min(c.xy, 1.0 - c.xy);
  float edge = smoothstep(0.0, 0.08, min(e.x, e.y));
  if (edge <= 0.0) return 1.0;
  float sh = 0.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) {
    float d = texture2D(uShadowMap, c.xy + vec2(float(x), float(y)) * uShadowTexel).r;
    sh += (c.z - bias > d) ? 0.0 : 1.0;
  }
  return mix(1.0, sh / 9.0, edge);
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
  // slope-scaled bias: far more at grazing angles (low sun / dusk) so the shadow stops
  // shimmering, tighter when the surface faces the light. Then darken the key light.
  float sbias = 0.0016 + 0.007 * (1.0 - ndl);
  float shF = uShadowOn > 0.5 ? shadowFactor(vWorld, sbias) : 1.0;
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
  // light grade: a touch of saturation + contrast for depth
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 1.08);
  col = (col - 0.5) * 1.09 + 0.5;
  col = clamp(col, 0.0, 1.0);
  // aerial fog for depth
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
  shadowMap: gl.getUniformLocation(progT, "uShadowMap"),
  lightVP: gl.getUniformLocation(progT, "uLightVP"),
  shadowOn: gl.getUniformLocation(progT, "uShadowOn"),
  shadowTexel: gl.getUniformLocation(progT, "uShadowTexel"),
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
