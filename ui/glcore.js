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
varying vec3 vNrm; varying vec2 vUV;
void main(){
  vec4 wp = uModel * vec4(aPos,1.0);
  gl_Position = uMVP * wp;
  vNrm = mat3(uModel) * aNrm;
  vUV = aUV;
}`;
const FST = `
precision mediump float;
varying vec3 vNrm; varying vec2 vUV;
uniform sampler2D uTex;
uniform float uAlphaTest;
uniform float uAlpha;
uniform float uFogDensity; uniform vec3 uFogColor;
uniform vec3 uSunDir;
void main(){
  vec4 tex = texture2D(uTex, vUV);
  if (uAlphaTest > 0.5 && tex.a < 0.5) discard;
  vec3 n = normalize(vNrm);
  // directional key light (warm) + hemisphere ambient: cool sky from above grading
  // to a dark warm ground below — gives terrain & banking real form without shadow maps
  float ndl = max(dot(n, normalize(uSunDir)), 0.0);
  float sky = 0.5 + 0.5 * n.y;
  vec3 ambient = mix(vec3(0.22, 0.23, 0.28), vec3(0.55, 0.63, 0.76), sky);
  vec3 sunCol = vec3(1.0, 0.95, 0.86);
  // soft wrap on the key so shaded faces don't crush to black
  float wrap = ndl * 0.85 + 0.15 * (0.5 + 0.5 * dot(n, normalize(uSunDir)));
  vec3 col = tex.rgb * (ambient + sunCol * (0.9 * wrap));
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
};
