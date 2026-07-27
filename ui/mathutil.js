/* mathutil.js — pure matrix/vector helpers shared across BLACKBOX.
 *
 * TWO matrix conventions live here, and they are NOT interchangeable:
 *   • COLUMN-MAJOR (v' = M·v)  — the camera / GL / car-model side: mMul, mPerspective,
 *     mLookAt, rotP, scaleMat. These feed uMVP / uModel.
 *   • ROW-VECTOR, row-major (v' = v·M) — the kn5 / driver-skeleton side: rvMul, rvInv,
 *     rvTRS, rvFromTo, rvRotAbout, plus mXfPt/mRot which apply a row-vector matrix to a
 *     point/direction. This matches how kn5 stores node transforms.
 * Keep them straight: mixing an rv* matrix into a column-major path (or vice-versa) is the
 * classic source of "the car/driver is subtly wrong" bugs. Loaded as a plain <script>, so
 * every name below is a global available to the other scripts. */

const IDENT4 = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

/* ---- column-major (v' = M·v): camera + GL + car-model ---- */
function mPerspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0,  0, f, 0, 0,  0, 0, (far + near) * nf, -1,  0, 0, 2 * far * near * nf, 0];
}
function mLookAt(eye, at, up) {
  let zx = eye[0] - at[0], zy = eye[1] - at[1], zz = eye[2] - at[2];
  let zl = Math.hypot(zx, zy, zz); zx /= zl; zy /= zl; zz /= zl;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  const xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return [xx, yx, zx, 0,  xy, yy, zy, 0,  xz, yz, zz, 0,
          -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
          -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
          -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1];
}
function mMul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
/* Same product, into a caller-owned matrix — the column-major twin of rvMulInto below.
 * Same aliasing rule: `o` may alias neither `a` nor `b`, because every output element is
 * read from both inputs and writing into an input corrupts the columns still to come. */
function mMulInto(o, a, b) {
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
// column-major rotation of `ang` about axis (0=X,1=Y,2=Z) through a pivot
function rotP(axis, ang, px, py, pz) {
  const c = Math.cos(ang), s = Math.sin(ang);
  let R;
  if (axis === 0) R = [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1];
  else if (axis === 1) R = [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1];
  else R = [c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1];
  const rpx = R[0]*px + R[4]*py + R[8]*pz, rpy = R[1]*px + R[5]*py + R[9]*pz, rpz = R[2]*px + R[6]*py + R[10]*pz;
  R[12] = px - rpx; R[13] = py - rpy; R[14] = pz - rpz;
  return R;
}
function scaleMat(s) { return [s,0,0,0, 0,s,0,0, 0,0,s,0, 0,0,0,1]; }
// orthographic projection (column-major) — used for the directional shadow map's light camera
function mOrtho(l, r, b, t, n, f) {
  return [2/(r-l), 0, 0, 0,  0, 2/(t-b), 0, 0,  0, 0, -2/(f-n), 0,
          -(r+l)/(r-l), -(t+b)/(t-b), -(f+n)/(f-n), 1];
}

/* ---- vectors + row-vector point/dir transforms ---- */
const v3sub = (a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]], v3add=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]], v3sc=(a,s)=>[a[0]*s,a[1]*s,a[2]*s];
const v3dot = (a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2], v3len=a=>Math.hypot(a[0],a[1],a[2]), v3nrm=a=>{const l=v3len(a)||1;return[a[0]/l,a[1]/l,a[2]/l];};
const v3cross = (a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const mXfPt = (v,M)=>[v[0]*M[0]+v[1]*M[4]+v[2]*M[8]+M[12], v[0]*M[1]+v[1]*M[5]+v[2]*M[9]+M[13], v[0]*M[2]+v[1]*M[6]+v[2]*M[10]+M[14]];
const mRot = (v,M)=>[v[0]*M[0]+v[1]*M[4]+v[2]*M[8], v[0]*M[1]+v[1]*M[5]+v[2]*M[9], v[0]*M[2]+v[1]*M[6]+v[2]*M[10]];
const mT = p=>new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,p[0],p[1],p[2],1]);

/* ---- row-vector (v' = v·M, row-major): kn5 / driver-skeleton convention ---- */
function rvMul(a, b) { const o = new Float32Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[r*4+c] = a[r*4]*b[c] + a[r*4+1]*b[4+c] + a[r*4+2]*b[8+c] + a[r*4+3]*b[12+c]; return o; }
/* Same product, into a caller-owned matrix. Per-frame paths that call rvMul once per bone
 * allocate a 16-float matrix per bone per car per frame; at 360 Hz that is the largest
 * single contributor to a heap that was measured climbing from 160 MB to 320 MB across a
 * session, with collections costing 8-11 ms.
 *
 * `o` may alias neither `a` nor `b` — every element of the result is read from both inputs,
 * so writing into an input corrupts the rows still to be computed. Callers pass scratch. */
function rvMulInto(o, a, b) {
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++)
    o[r*4+c] = a[r*4]*b[c] + a[r*4+1]*b[4+c] + a[r*4+2]*b[8+c] + a[r*4+3]*b[12+c];
  return o;
}
const rvRotAbout = (M, R, piv) => rvMul(M, rvMul(rvMul(mT(v3sc(piv,-1)), R), mT(piv)));
function rvFromTo(u, v) {   // row-vector rotation taking unit u→v (shortest arc)
  u = v3nrm(u); v = v3nrm(v); let c = v3dot(u, v), ax = v3cross(u, v), s = v3len(ax);
  if (s < 1e-6) { if (c > 0) return new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]); const p = Math.abs(u[0]) < 0.9 ? [1,0,0] : [0,1,0]; ax = v3nrm(v3cross(u, p)); s = 0; c = -1; } else ax = v3sc(ax, 1/s);
  const x = ax[0], y = ax[1], z = ax[2], C = 1 - c;
  return new Float32Array([c+x*x*C, x*y*C+z*s, x*z*C-y*s, 0,  x*y*C-z*s, c+y*y*C, y*z*C+x*s, 0,  x*z*C+y*s, y*z*C-x*s, c+z*z*C, 0,  0,0,0,1]);
}
function rvInv(m) {   // general 4x4 inverse (row-major)
  const i = new Float32Array(16);
  i[0]=m[5]*m[10]*m[15]-m[5]*m[11]*m[14]-m[9]*m[6]*m[15]+m[9]*m[7]*m[14]+m[13]*m[6]*m[11]-m[13]*m[7]*m[10];
  i[4]=-m[4]*m[10]*m[15]+m[4]*m[11]*m[14]+m[8]*m[6]*m[15]-m[8]*m[7]*m[14]-m[12]*m[6]*m[11]+m[12]*m[7]*m[10];
  i[8]=m[4]*m[9]*m[15]-m[4]*m[11]*m[13]-m[8]*m[5]*m[15]+m[8]*m[7]*m[13]+m[12]*m[5]*m[11]-m[12]*m[7]*m[9];
  i[12]=-m[4]*m[9]*m[14]+m[4]*m[10]*m[13]+m[8]*m[5]*m[14]-m[8]*m[6]*m[13]-m[12]*m[5]*m[10]+m[12]*m[6]*m[9];
  i[1]=-m[1]*m[10]*m[15]+m[1]*m[11]*m[14]+m[9]*m[2]*m[15]-m[9]*m[3]*m[14]-m[13]*m[2]*m[11]+m[13]*m[3]*m[10];
  i[5]=m[0]*m[10]*m[15]-m[0]*m[11]*m[14]-m[8]*m[2]*m[15]+m[8]*m[3]*m[14]+m[12]*m[2]*m[11]-m[12]*m[3]*m[10];
  i[9]=-m[0]*m[9]*m[15]+m[0]*m[11]*m[13]+m[8]*m[1]*m[15]-m[8]*m[3]*m[13]-m[12]*m[1]*m[11]+m[12]*m[3]*m[9];
  i[13]=m[0]*m[9]*m[14]-m[0]*m[10]*m[13]-m[8]*m[1]*m[14]+m[8]*m[2]*m[13]+m[12]*m[1]*m[10]-m[12]*m[2]*m[9];
  i[2]=m[1]*m[6]*m[15]-m[1]*m[7]*m[14]-m[5]*m[2]*m[15]+m[5]*m[3]*m[14]+m[13]*m[2]*m[7]-m[13]*m[3]*m[6];
  i[6]=-m[0]*m[6]*m[15]+m[0]*m[7]*m[14]+m[4]*m[2]*m[15]-m[4]*m[3]*m[14]-m[12]*m[2]*m[7]+m[12]*m[3]*m[6];
  i[10]=m[0]*m[5]*m[15]-m[0]*m[7]*m[13]-m[4]*m[1]*m[15]+m[4]*m[3]*m[13]+m[12]*m[1]*m[7]-m[12]*m[3]*m[5];
  i[14]=-m[0]*m[5]*m[14]+m[0]*m[6]*m[13]+m[4]*m[1]*m[14]-m[4]*m[2]*m[13]-m[12]*m[1]*m[6]+m[12]*m[2]*m[5];
  i[3]=-m[1]*m[6]*m[11]+m[1]*m[7]*m[10]+m[5]*m[2]*m[11]-m[5]*m[3]*m[10]-m[9]*m[2]*m[7]+m[9]*m[3]*m[6];
  i[7]=m[0]*m[6]*m[11]-m[0]*m[7]*m[10]-m[4]*m[2]*m[11]+m[4]*m[3]*m[10]+m[8]*m[2]*m[7]-m[8]*m[3]*m[6];
  i[11]=-m[0]*m[5]*m[11]+m[0]*m[7]*m[9]+m[4]*m[1]*m[11]-m[4]*m[3]*m[9]-m[8]*m[1]*m[7]+m[8]*m[3]*m[5];
  i[15]=m[0]*m[5]*m[10]-m[0]*m[6]*m[9]-m[4]*m[1]*m[10]+m[4]*m[2]*m[9]+m[8]*m[1]*m[6]-m[8]*m[2]*m[5];
  let d = m[0]*i[0]+m[1]*i[4]+m[2]*i[8]+m[3]*i[12]; d = 1/d;
  const o = new Float32Array(16); for (let k = 0; k < 16; k++) o[k] = i[k]*d; return o;
}
function rvTRS(p, q, s) {   // q as (w,x,y,z); TRS = scale·rotate with translation in row 3
  const w = q[0], x = q[1], y = q[2], z = q[3]; const n = Math.hypot(x, y, z, w) || 1;
  const X = x/n, Y = y/n, Z = z/n, W = w/n;
  const xx=X*X, yy=Y*Y, zz=Z*Z, xy=X*Y, xz=X*Z, yz=Y*Z, wx=W*X, wy=W*Y, wz=W*Z;
  const sx = s[0], sy = s[1], sz = s[2];
  return new Float32Array([
    sx*(1-2*(yy+zz)), sx*(2*(xy+wz)),   sx*(2*(xz-wy)),   0,
    sy*(2*(xy-wz)),   sy*(1-2*(xx+zz)), sy*(2*(yz+wx)),   0,
    sz*(2*(xz+wy)),   sz*(2*(yz-wx)),   sz*(1-2*(xx+yy)), 0,
    p[0], p[1], p[2], 1,
  ]);
}
// 2-bone IK: elbow position for a wrist target Tg, upper/fore lengths L1/L2, pole hint
function ik2bone(S, Tg, L1, L2, pole) {
  let dv = v3sub(Tg, S), D = v3len(dv); const reach = L1 + L2;
  if (D > reach * 0.999) { D = reach * 0.999; Tg = v3add(S, v3sc(v3nrm(dv), D)); dv = v3sub(Tg, S); }
  const dir = v3nrm(dv);
  const a = (L1*L1 - L2*L2 + D*D) / (2*D), h = Math.sqrt(Math.max(0, L1*L1 - a*a));
  let pp = v3sub(pole, v3sc(dir, v3dot(pole, dir))); if (v3len(pp) < 1e-4) pp = [0,1,0]; pp = v3nrm(pp);
  return { E: v3add(v3add(S, v3sc(dir, a)), v3sc(pp, h)), W: Tg };
}

/* ---- frustum ---- */

/* The six clip planes of a view-projection, as [a,b,c,d] with a*x+b*y+c*z+d >= 0 INSIDE.
 * Gribb-Hartmann: each plane is a sum or difference of the matrix's w row with one of its
 * x/y/z rows. Our matrices are column-major with column vectors (`mMul` composes for
 * clip = M * world), so row r is m[r], m[4+r], m[8+r], m[12+r] — the strided read, not a
 * contiguous four. Getting that backwards yields planes that look plausible and cull the
 * wrong half of the world.
 *
 * Normalised, so the dot product is a signed distance in metres and a sphere test is just
 * `dist < -radius`. */
function frustumPlanes(m) {
  const row = (r) => [m[r], m[4 + r], m[8 + r], m[12 + r]];
  const [x, y, z, w] = [row(0), row(1), row(2), row(3)];
  const combine = (s, a, b) => {
    const p = [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2], a[3] + s * b[3]];
    const len = Math.hypot(p[0], p[1], p[2]) || 1;
    return [p[0] / len, p[1] / len, p[2] / len, p[3] / len];
  };
  return [
    combine(1, w, x), combine(-1, w, x),   // left, right
    combine(1, w, y), combine(-1, w, y),   // bottom, top
    combine(1, w, z), combine(-1, w, z),   // near, far
  ];
}

/** Does a world-space sphere touch the frustum? Conservative: false only when fully outside. */
function sphereInFrustum(planes, c, r) {
  for (const p of planes) {
    if (p[0] * c[0] + p[1] * c[1] + p[2] * c[2] + p[3] < -r) return false;
  }
  return true;
}

/* ---- misc ---- */
function easeK(rate, dt) { return 1 - Math.exp(-rate * Math.max(0, Math.min(0.1, dt))); }

if (typeof module !== "undefined") module.exports = {
  IDENT4, mPerspective, mLookAt, mMul, mMulInto, rotP, scaleMat, mOrtho,
  v3sub, v3add, v3sc, v3dot, v3len, v3nrm, v3cross, mXfPt, mRot, mT,
  rvMul, rvMulInto, rvRotAbout, rvFromTo, rvInv, rvTRS, ik2bone, easeK,
  frustumPlanes, sphereInFrustum,
};
