/* tracklights.js — CSP track light sources, resolved to concrete world lights.
 *
 * The sun stays ours: blackbox drives its own time-of-day sky and key light. What a track
 * knows that we cannot invent is where its LAMPS are — the floodlights, gantry lights and
 * tunnel strips its author placed. Those live in extension/ext_config.ini as LIGHT_SERIES
 * sections, and they are DATA, not rendering: a position, a colour, a cone, a range. That
 * is why this half is worth reading and CSP's shader replacements are not.
 *
 * The awkward part, and the reason this file exists rather than a regex at the call site:
 * a series carries no coordinates. It carries
 *
 *     MESHES = TorusLight?, StartFinishGate_SUB2
 *
 * and places one light AT EACH MATCHING MESH — hence "series". So resolving a config needs
 * the track's node names and positions, which is what extractScene's collectNodes gives.
 *
 * Pure data in, pure data out: no GL, no DOM, so test_tracklights.js can drive it.
 */
"use strict";

/** AC wildcards: ? is one character, * is any run. Case-insensitive, whole-name match. */
function meshPatternToRegExp(pat) {
  const esc = String(pat).trim().replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + esc.replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
}

const num = (s, d) => { const v = parseFloat(s); return isFinite(v) ? v : d; };
const list = (s) => String(s || "").split(",").map(x => x.trim()).filter(Boolean);

/** Parse an ext_config.ini into raw sections: [{family, index, keys:{}}] */
function parseIni(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/\s*;.*$/, "").replace(/\s*\/\/.*$/, "").trim();
    if (!line) continue;
    const h = /^\[([^\]]+)\]/.exec(line);
    if (h) {
      const name = h[1].trim();
      const fam = name.replace(/_(\.\.\.|\d+)$/, "").toUpperCase();
      cur = { family: fam, name, keys: {} };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    cur.keys[line.slice(0, eq).trim().toUpperCase()] = line.slice(eq + 1).trim();
  }
  return out;
}

/* CONDITION drives when a light is on. The full CSP condition language is a scripting
 * surface we are not implementing; what matters for a replay viewer is the common case —
 * night lights. Anything mentioning NIGHT is treated as night-gated, everything else as
 * always on, and the caller multiplies by its own night factor. Stated plainly because a
 * silent misreading here would light a track at noon. */
function conditionIsNight(cond) {
  return /night/i.test(String(cond || ""));
}

/**
 * Resolve a track's ext_config into concrete lights.
 *
 * @param iniText  contents of extension/ext_config.ini
 * @param nodes    [{name, pos}] from extractScene(..., {collectNodes:true})
 * @param opts     { max } — cap on lights returned (a track can declare hundreds)
 * @returns [{ pos, color:[r,g,b], intensity, range, dir, spot, sharpness, night }]
 */
function resolveTrackLights(iniText, nodes, opts) {
  const max = (opts && opts.max) || 4096;
  const secs = parseIni(iniText).filter(s => s.family === "LIGHT_SERIES" || s.family === "LIGHT");
  const byName = Array.isArray(nodes) ? nodes : [];
  const out = [];

  for (const s of secs) {
    const k = s.keys;
    if (/^(0|false|off)$/i.test(k.ACTIVE || "")) continue;

    const col = list(k.COLOR).map(Number);
    const color = [num(col[0], 1), num(col[1], 1), num(col[2], 1)];
    // COLOR's fourth component is INTENSITY, not alpha — "0.9, 0.95, 1.0, 3" is a
    // slightly blue lamp at 3x. Reading it as alpha would make every light dim and equal.
    const intensity = col.length > 3 ? num(col[3], 1) : 1;

    const d = list(k.DIRECTION).map(Number);
    const dir = d.length >= 3 ? [num(d[0], 0), num(d[1], -1), num(d[2], 0)] : [0, -1, 0];
    const range = num(k.RANGE, 60);
    // SPOT is the cone's full angle in DEGREES; 360 (or absent) means a point light.
    const spot = num(k.SPOT, 360);
    const sharpness = num(k.SPOT_SHARPNESS, 0.3);
    const night = conditionIsNight(k.CONDITION);
    const off = list(k.OFFSET).map(Number);
    const offset = off.length >= 3 ? [num(off[0], 0), num(off[1], 0), num(off[2], 0)] : [0, 0, 0];

    const push = (p) => {
      if (out.length >= max) return;
      out.push({
        pos: [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]],
        color, intensity, range, dir, spot, sharpness, night,
      });
    };

    // explicit coordinates (some tracks use these instead of meshes)
    const p = list(k.POSITION).map(Number);
    if (p.length >= 3) push([num(p[0], 0), num(p[1], 0), num(p[2], 0)]);

    // ...and one light per matching mesh, which is the usual form
    const pats = list(k.MESHES).map(meshPatternToRegExp);
    if (pats.length && byName.length) {
      for (const n of byName) {
        if (out.length >= max) break;
        if (pats.some(re => re.test(n.name))) push(n.pos);
      }
    }
  }
  return out;
}

/** The n lights most worth drawing from `eye` — nearest first, out-of-range dropped. */
function cullLights(lights, eye, n) {
  const scored = [];
  for (const L of lights) {
    const dx = L.pos[0] - eye[0], dy = L.pos[1] - eye[1], dz = L.pos[2] - eye[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    // past its own range plus a margin a lamp contributes nothing the eye can see
    const reach = (L.range + 40);
    if (d2 > reach * reach) continue;
    scored.push({ L, d2 });
  }
  scored.sort((a, b) => a.d2 - b.d2);
  return scored.slice(0, n).map(s => s.L);
}

const TrackLights = { parseIni, meshPatternToRegExp, conditionIsNight, resolveTrackLights, cullLights };
if (typeof module !== "undefined") module.exports = TrackLights;
if (typeof window !== "undefined") window.TrackLights = TrackLights;
