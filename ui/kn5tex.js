/* kn5tex.js — decode .kn5-embedded texture blobs (PNG or DDS) into
 * WebGL-uploadable form. Zero dependencies, browser + Node.
 *
 * The kn5 texture block yields { name, blob }; blobs are either PNG files
 * (browser decodes those via createImageBitmap) or DDS files: DXT1/DXT3/DXT5
 * block-compressed or uncompressed 32-bit RGB/RGBA, optionally mipmapped.
 *
 * API:
 *   sniffFormat(u8)            -> "png" | "dds" | "jpg" | "unknown"
 *                                 ("jpg" occurs in the wild in mod-track kn5s;
 *                                 browsers decode it via createImageBitmap
 *                                 exactly like PNG)
 *   parseDDS(u8)               -> { width, height, format, mips }
 *                                 format: "dxt1"|"dxt3"|"dxt5"|"rgba8"
 *                                 mips[i]: { width, height, data:Uint8Array }
 *                                 (dxt mip data are subarray VIEWS into the
 *                                 input; rgba8 mips are fresh RGBA buffers)
 *   decodeDXT(mip, format)     -> Uint8Array RGBA (pure-JS BC1/BC2/BC3)
 *   uploadTexture(gl, parsed, extS3TC) -> WebGLTexture
 *   decodePNGDims(u8)          -> { width, height } from the IHDR chunk
 */
"use strict";

function texError(msg) { return new Error("kn5tex: " + msg); }

// ---------------------------------------------------------------- sniff

function sniffFormat(u8) {
  if (u8.length >= 8 &&
      u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47)
    return "png";
  if (u8.length >= 4 &&
      u8[0] === 0x44 && u8[1] === 0x44 && u8[2] === 0x53 && u8[3] === 0x20)
    return "dds";
  if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff)
    return "jpg"; // JPEG SOI — seen in mod-track kn5s; browser-decodable
  return "unknown";
}

// ---------------------------------------------------------------- DDS

// DDS_HEADER field offsets (from file start; magic occupies 0..3)
// 4 dwSize, 8 dwFlags, 12 dwHeight, 16 dwWidth, 20 dwPitchOrLinearSize,
// 24 dwDepth, 28 dwMipMapCount, 32 dwReserved1[11],
// 76 ddspf.dwSize, 80 ddspf.dwFlags, 84 ddspf.dwFourCC,
// 88 ddspf.dwRGBBitCount, 92/96/100/104 RGBA masks, 108 dwCaps, 112 dwCaps2
var DDSD_MIPMAPCOUNT = 0x20000;
var DDSD_DEPTH = 0x800000;
var DDPF_FOURCC = 0x4;
var DDPF_RGB = 0x40;
var DDSCAPS2_CUBEMAP = 0x200;

var DXGI_NAMES = {
  28: "R8G8B8A8_UNORM", 29: "R8G8B8A8_UNORM_SRGB", 87: "B8G8R8A8_UNORM",
  91: "B8G8R8A8_UNORM_SRGB", 70: "BC1_TYPELESS", 71: "BC1_UNORM",
  72: "BC1_UNORM_SRGB", 73: "BC2_TYPELESS", 74: "BC2_UNORM",
  75: "BC2_UNORM_SRGB", 76: "BC3_TYPELESS", 77: "BC3_UNORM",
  78: "BC3_UNORM_SRGB", 79: "BC4_TYPELESS", 80: "BC4_UNORM", 81: "BC4_SNORM",
  82: "BC5_TYPELESS", 83: "BC5_UNORM", 84: "BC5_SNORM",
  94: "BC6H_TYPELESS", 95: "BC6H_UF16", 96: "BC6H_SF16",
  97: "BC7_TYPELESS", 98: "BC7_UNORM", 99: "BC7_UNORM_SRGB",
};

// byte position of an 8-bit channel within a 32-bit little-endian texel,
// derived from its mask; -1 = no such channel
function maskToByteIndex(mask) {
  if (mask === 0x000000ff) return 0;
  if (mask === 0x0000ff00) return 1;
  if (mask === 0x00ff0000) return 2;
  if (mask === 0xff000000) return 3;
  return -1;
}

function parseDDS(u8) {
  if (sniffFormat(u8) !== "dds") throw texError("not a DDS file (bad magic)");
  if (u8.length < 128) throw texError("DDS truncated (header needs 128 bytes)");
  var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  var headerSize = dv.getUint32(4, true);
  if (headerSize !== 124) throw texError("bad DDS header size " + headerSize);
  var flags = dv.getUint32(8, true);
  var height = dv.getUint32(12, true);
  var width = dv.getUint32(16, true);
  var mipMapCount = dv.getUint32(28, true);
  var pfFlags = dv.getUint32(80, true);
  var fourCC = String.fromCharCode(u8[84], u8[85], u8[86], u8[87]);
  var bitCount = dv.getUint32(88, true);
  var rMask = dv.getUint32(92, true);
  var gMask = dv.getUint32(96, true);
  var bMask = dv.getUint32(100, true);
  var aMask = dv.getUint32(104, true);
  var caps2 = dv.getUint32(112, true);

  if (width === 0 || height === 0)
    throw texError("bad DDS dimensions " + width + "x" + height);
  if (caps2 & DDSCAPS2_CUBEMAP) throw texError("cubemap DDS not supported");
  if (flags & DDSD_DEPTH) throw texError("volume DDS not supported");

  var dataOff = 128;
  var format = null;   // "dxt1"|"dxt3"|"dxt5"|"rgba8"
  var blockBytes = 0;  // 0 = uncompressed

  if (pfFlags & DDPF_FOURCC) {
    if (fourCC === "DX10") {
      if (u8.length < 148) throw texError("DDS truncated (DX10 header)");
      var dxgi = dv.getUint32(128, true);
      throw texError("DX10 DDS not supported (DXGI format " +
                     (DXGI_NAMES[dxgi] || dxgi) + ")");
    }
    if (fourCC === "DXT1") { format = "dxt1"; blockBytes = 8; }
    else if (fourCC === "DXT3") { format = "dxt3"; blockBytes = 16; }
    else if (fourCC === "DXT5") { format = "dxt5"; blockBytes = 16; }
    else throw texError("unsupported DDS fourCC '" + fourCC + "'");
  } else if (pfFlags & DDPF_RGB) {
    if (bitCount !== 32)
      throw texError("unsupported uncompressed DDS bit count " + bitCount +
                     " (only 32-bit RGB/RGBA handled)");
    format = "rgba8";
  } else {
    throw texError("unsupported DDS pixel format (flags 0x" +
                   pfFlags.toString(16) + ")");
  }

  var nMips = (flags & DDSD_MIPMAPCOUNT) && mipMapCount > 0 ? mipMapCount : 1;

  // channel byte positions for uncompressed conversion to RGBA
  var ri = 0, gi = 0, bi = 0, ai = -1;
  if (format === "rgba8") {
    ri = maskToByteIndex(rMask);
    gi = maskToByteIndex(gMask);
    bi = maskToByteIndex(bMask);
    ai = maskToByteIndex(aMask); // -1 (mask 0) => opaque
    if (ri < 0 || gi < 0 || bi < 0)
      throw texError("unsupported 32-bit DDS channel masks r=0x" +
                     rMask.toString(16) + " g=0x" + gMask.toString(16) +
                     " b=0x" + bMask.toString(16));
  }

  var mips = [];
  var w = width, h = height;
  for (var m = 0; m < nMips; m++) {
    var size = blockBytes
      ? Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * blockBytes
      : w * h * 4;
    if (dataOff + size > u8.length)
      throw texError("DDS truncated: mip " + m + " needs " + size +
                     " bytes at " + dataOff + ", file has " + u8.length);
    var data;
    if (blockBytes) {
      data = u8.subarray(dataOff, dataOff + size); // view, no copy
    } else {
      // convert masked 32-bit texels to RGBA byte order
      data = new Uint8Array(size);
      for (var p = 0; p < size; p += 4) {
        data[p]     = u8[dataOff + p + ri];
        data[p + 1] = u8[dataOff + p + gi];
        data[p + 2] = u8[dataOff + p + bi];
        data[p + 3] = ai >= 0 ? u8[dataOff + p + ai] : 255;
      }
    }
    mips.push({ width: w, height: h, data: data });
    dataOff += size;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }

  return { width: width, height: height, format: format, mips: mips };
}

// ---------------------------------------------------------------- DXT decode

// expand RGB565 into rgba[i..i+2] with standard bit replication
function expand565(c, rgba, i) {
  var r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  rgba[i]     = (r << 3) | (r >> 2);
  rgba[i + 1] = (g << 2) | (g >> 4);
  rgba[i + 2] = (b << 3) | (b >> 2);
}

// decodeDXT({width, height, data}, "dxt1"|"dxt3"|"dxt5") -> Uint8Array RGBA.
// Standard BC1/BC2/BC3: 2 RGB565 endpoints + 2-bit color indices per block;
// DXT1 3-color + 1-bit-alpha mode when c0 <= c1 (BC2/BC3 color blocks are
// always 4-color); DXT3 explicit 4-bit alpha; DXT5 interpolated alpha with
// 3-bit indices.
function decodeDXT(mip, format) {
  var w = mip.width, h = mip.height, src = mip.data;
  var blockBytes = format === "dxt1" ? 8 : 16;
  if (format !== "dxt1" && format !== "dxt3" && format !== "dxt5")
    throw texError("decodeDXT: unknown format '" + format + "'");
  var bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4));
  if (src.length < bw * bh * blockBytes)
    throw texError("decodeDXT: data too short (" + src.length + " < " +
                   bw * bh * blockBytes + ")");
  var out = new Uint8Array(w * h * 4);
  var pal = new Uint8Array(16);     // 4 RGBA palette entries
  var apal = new Uint8Array(8);     // dxt5 alpha palette

  for (var by = 0; by < bh; by++) {
    for (var bx = 0; bx < bw; bx++) {
      var off = (by * bw + bx) * blockBytes;
      var cOff = format === "dxt1" ? off : off + 8;

      var c0 = src[cOff] | (src[cOff + 1] << 8);
      var c1 = src[cOff + 2] | (src[cOff + 3] << 8);
      expand565(c0, pal, 0);
      expand565(c1, pal, 4);
      pal[3] = 255; pal[7] = 255; pal[11] = 255; pal[15] = 255;
      if (format === "dxt1" && c0 <= c1) {
        // 3-color mode + 1-bit alpha
        pal[8]  = (pal[0] + pal[4]) >> 1;
        pal[9]  = (pal[1] + pal[5]) >> 1;
        pal[10] = (pal[2] + pal[6]) >> 1;
        pal[12] = 0; pal[13] = 0; pal[14] = 0; pal[15] = 0;
      } else {
        pal[8]  = Math.round((2 * pal[0] + pal[4]) / 3);
        pal[9]  = Math.round((2 * pal[1] + pal[5]) / 3);
        pal[10] = Math.round((2 * pal[2] + pal[6]) / 3);
        pal[12] = Math.round((pal[0] + 2 * pal[4]) / 3);
        pal[13] = Math.round((pal[1] + 2 * pal[5]) / 3);
        pal[14] = Math.round((pal[2] + 2 * pal[6]) / 3);
      }

      // dxt5 alpha palette + index bit streams (two little-endian 24-bit halves)
      var aBits0 = 0, aBits1 = 0;
      if (format === "dxt5") {
        var a0 = src[off], a1 = src[off + 1];
        apal[0] = a0; apal[1] = a1;
        if (a0 > a1) {
          for (var k = 0; k < 6; k++)
            apal[k + 2] = Math.round(((6 - k) * a0 + (k + 1) * a1) / 7);
        } else {
          for (var k2 = 0; k2 < 4; k2++)
            apal[k2 + 2] = Math.round(((4 - k2) * a0 + (k2 + 1) * a1) / 5);
          apal[6] = 0; apal[7] = 255;
        }
        aBits0 = src[off + 2] | (src[off + 3] << 8) | (src[off + 4] << 16);
        aBits1 = src[off + 5] | (src[off + 6] << 8) | (src[off + 7] << 16);
      }

      for (var py = 0; py < 4; py++) {
        var y = by * 4 + py;
        if (y >= h) break;
        var rowBits = src[cOff + 4 + py]; // 2-bit color indices for this row
        for (var px = 0; px < 4; px++) {
          var x = bx * 4 + px;
          if (x >= w) break;
          var ci = (rowBits >> (px * 2)) & 3;
          var o = (y * w + x) * 4;
          out[o]     = pal[ci * 4];
          out[o + 1] = pal[ci * 4 + 1];
          out[o + 2] = pal[ci * 4 + 2];
          if (format === "dxt1") {
            out[o + 3] = pal[ci * 4 + 3];
          } else if (format === "dxt3") {
            // 4 bits per texel, 2 texels per byte, rows of 2 bytes
            var an = src[off + py * 2 + (px >> 1)];
            var a4 = (px & 1) ? (an >> 4) : (an & 15);
            out[o + 3] = a4 * 17;
          } else { // dxt5
            var t = py * 4 + px;
            var ia = t < 8 ? (aBits0 >> (t * 3)) & 7
                           : (aBits1 >> ((t - 8) * 3)) & 7;
            out[o + 3] = apal[ia];
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- upload

function isPow2(n) { return n > 0 && (n & (n - 1)) === 0; }

// uploadTexture(gl, parsed, extS3TC) -> WebGLTexture
// parsed: result of parseDDS (or an { width, height, format:"rgba8", mips }
// built from a decoded PNG). extS3TC: WEBGL_compressed_texture_s3tc extension
// object or null — with it, dxt* mips upload compressed; without it (or for
// rgba8) falls back to decodeDXT + texImage2D. REPEAT wrapping for tiling
// track UVs; non-power-of-two textures get CLAMP_TO_EDGE + LINEAR without
// mipmaps (WebGL1 NPOT rules).
function uploadTexture(gl, parsed, extS3TC) {
  var tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  var pot = isPow2(parsed.width) && isPow2(parsed.height);
  var mips = parsed.mips;
  var fmt = parsed.format;
  var last = mips[mips.length - 1];
  var chainComplete = mips.length > 1 && last.width === 1 && last.height === 1;
  var hasMips = false;

  if (fmt !== "rgba8" && extS3TC) {
    var glFmt = fmt === "dxt1" ? extS3TC.COMPRESSED_RGBA_S3TC_DXT1_EXT
              : fmt === "dxt3" ? extS3TC.COMPRESSED_RGBA_S3TC_DXT3_EXT
              :                  extS3TC.COMPRESSED_RGBA_S3TC_DXT5_EXT;
    // mipmapped sampling needs POT (WebGL1) and a full chain down to 1x1
    var nLevels = (pot && chainComplete) ? mips.length : 1;
    for (var i = 0; i < nLevels; i++)
      gl.compressedTexImage2D(gl.TEXTURE_2D, i, glFmt,
                              mips[i].width, mips[i].height, 0, mips[i].data);
    hasMips = nLevels > 1;
  } else {
    var rgba = fmt === "rgba8" ? mips[0].data : decodeDXT(mips[0], fmt);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, parsed.width, parsed.height, 0,
                  gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    if (pot) { gl.generateMipmap(gl.TEXTURE_2D); hasMips = true; }
  }

  var wrap = pot ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
                   hasMips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

// ---------------------------------------------------------------- PNG dims

// PNG: 8-byte signature, then IHDR chunk: u32 length, "IHDR",
// u32 width (big-endian), u32 height (big-endian), ...
function decodePNGDims(u8) {
  if (sniffFormat(u8) !== "png") throw texError("not a PNG file (bad signature)");
  if (u8.length < 24) throw texError("PNG truncated (no IHDR)");
  if (u8[12] !== 0x49 || u8[13] !== 0x48 || u8[14] !== 0x44 || u8[15] !== 0x52)
    throw texError("PNG first chunk is not IHDR");
  var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return { width: dv.getUint32(16, false), height: dv.getUint32(20, false) };
}

// ---------------------------------------------------------------- exports

var KN5Tex = {
  sniffFormat: sniffFormat,
  parseDDS: parseDDS,
  decodeDXT: decodeDXT,
  uploadTexture: uploadTexture,
  decodePNGDims: decodePNGDims,
};

if (typeof module !== "undefined") module.exports = KN5Tex;
if (typeof window !== "undefined") window.KN5Tex = KN5Tex;
