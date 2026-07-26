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

/* CSP mesh-name wildcards, as the real configs actually use them.
 *
 * I first implemented '?' as exactly one character, which is the usual convention. The
 * track data says otherwise. Nordic declares
 *
 *     MESHES = Light.?_SUB2
 *
 * and its model contains Light.026_SUB0, Light.027_SUB0, ... — the '?' has to span THREE
 * characters, so it behaves as a run, like '*'. Under the one-character reading the
 * series matched nothing and the track stayed dark.
 *
 * The _SUBn suffix is a second trap. CSP splits a mesh per material at RUNTIME and
 * numbers the parts, so a config can name _SUB2 while the kn5 on disk holds _SUB0 for the
 * same object; the numbers are not stable across that split. Matching them literally is
 * matching an artefact. Both sides have the suffix stripped before comparison.
 *
 * What still discriminates correctly, and why this is not simply "match everything":
 * Light.026 is the lamp and LightPole.026 is the post holding it. The literal dot after
 * "Light" keeps the poles out — so nordic lights its lamps, not its scenery.
 */
const SUB_SUFFIX = /_SUB\d+$/i;

function meshPatternToRegExp(pat) {
  const base = String(pat).trim().replace(SUB_SUFFIX, "");
  const esc = base.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + esc.replace(/\*/g, ".*").replace(/\?/g, ".*") + "$", "i");
}

/** the name a pattern is compared against — same suffix stripping, so both sides agree */
function matchName(name) {
  return String(name || "").replace(SUB_SUFFIX, "");
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
 * Resolve a track's light configuration into concrete world lights.
 *
 * @param iniText  ONE config, or an ARRAY of them — see below
 * @param nodes    [{name, pos, mat}] from extractScene(..., {collectNodes:true})
 * @param opts     { max } — cap on lights returned (a track can declare hundreds)
 * @returns [{ pos, color:[r,g,b], intensity, range, dir, spot, sharpness, night }]
 *
 * WHY AN ARRAY. A track's lights are not necessarily in the track's own folder. CSP ships
 * per-track configs of its own under `extension/config/tracks/loaded/<track>.ini`, and for
 * several circuits that is the ONLY place they exist — ks_nordschleife declares 65 light
 * series there and none in its own folder, ks_nurburgring 34, macau 18, mugello 8. Reading
 * only `<track>/extension/ext_config.ini` therefore finds nothing and the track stays dark
 * with no indication anything was missed.
 *
 * So the caller passes every config that applies and they are merged. Order is irrelevant:
 * each series contributes its own lights independently.
 */
function resolveTrackLights(iniText, nodes, opts) {
  const max = (opts && opts.max) || 4096;
  const texts = Array.isArray(iniText) ? iniText : [iniText];
  const secs = texts.flatMap(t => parseIni(t))
    .filter(s => s.family === "LIGHT_SERIES" || s.family === "LIGHT");
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

    /* DIRECTION is usually a vector but can be the word NORMAL, meaning "aim along the
     * surface normal of the mesh this light sits on" (Miandros uses it for wall lamps).
     * We do not have per-mesh normals here, and guessing one would aim lamps confidently
     * in the wrong direction. Treated as a POINT light instead: omnidirectional is wrong
     * in a way that is obviously soft, rather than wrong in a way that looks deliberate. */
    const dirRaw = String(k.DIRECTION || "").trim();
    const normalAimed = /^normal$/i.test(dirRaw);
    const d = list(dirRaw).map(Number);
    const dir = (!normalAimed && d.length >= 3 && d.every(isFinite))
      ? [num(d[0], 0), num(d[1], -1), num(d[2], 0)] : [0, -1, 0];
    const range = num(k.RANGE, 60);
    /* FADE_AT is the author's stated distance at which the lamp stops being drawn, and it
     * is often much larger than RANGE — Miandros fades at 385 m on 200 m lamps, because a
     * stadium floodlight is visible from far outside the pool of light it casts. Culling
     * on RANGE alone would drop lights the author expected to still be on screen. */
    const fadeAt = num(k.FADE_AT, 0);
    // SPOT is the cone's full angle in DEGREES; 360 (or absent) means a point light.
    const spot = num(k.SPOT, 360);
    const sharpness = num(k.SPOT_SHARPNESS, 0.3);
    const night = conditionIsNight(k.CONDITION);
    const off = list(k.OFFSET).map(Number);
    const offset = off.length >= 3 ? [num(off[0], 0), num(off[1], 0), num(off[2], 0)] : [0, 0, 0];

    /* `radius` is the matched mesh's bounding-sphere radius, and it decides whether this
     * light has a POINT you can draw. A series names meshes, and not every mesh it names is
     * a lamp fixture: the T-180 test track's own config reads
     *
     *     MESHES = TorusLight?, StartFinishGate_SUB2, Roof_SUB2
     *
     * so the author is deliberately making the entire roof of the tube a light — a 682 m
     * glowing ceiling washing down onto the track, which is exactly right as illumination.
     * It has no location though. Its centre is a point in mid-air inside the structure, and
     * anything drawn there is both nowhere near a visible lamp and buried behind geometry.
     * 0 means "no mesh" — an explicitly positioned light, which is always a real point. */
    const push = (p, radius) => {
      if (out.length >= max) return;
      out.push({
        pos: [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]],
        color, intensity, range, dir, spot, sharpness, night,
        // a NORMAL-aimed lamp has no usable direction, so it is a point light
        spotUsable: !normalAimed && spot < 359,
        fadeAt: fadeAt > 0 ? fadeAt : range,
        radius: radius || 0,
      });
    };

    // explicit coordinates (some tracks use these instead of meshes)
    const p = list(k.POSITION).map(Number);
    if (p.length >= 3) push([num(p[0], 0), num(p[1], 0), num(p[2], 0)]);

    /* ...and one light per matching mesh. A series selects those either by NAME
     * (MESHES = TorusLight?) or by MATERIAL (MATERIALS = StreetLampGlow), and across this
     * library the two forms are used about equally — handling only MESHES left eleven of
     * fifteen T-180 tracks resolving nothing despite shipping a light config. */
    const meshPats = list(k.MESHES).map(meshPatternToRegExp);
    const matPats = list(k.MATERIALS).map(meshPatternToRegExp);
    if ((meshPats.length || matPats.length) && byName.length) {
      for (const n of byName) {
        if (out.length >= max) break;
        const nm = matchName(n.name);
        const hit = meshPats.some(re => re.test(nm)) ||
                    (n.mat && matPats.some(re => re.test(matchName(n.mat))));
        if (hit) push(n.pos, n.radius);
      }
    }
  }
  return out;
}

/**
 * The n lights worth sending to the shader, nearest the camera first.
 *
 * NO DISTANCE REJECTION, and the reasoning matters because I had it backwards twice.
 *
 * A lamp lights the ground AROUND ITSELF, not around the camera. Rejecting lamps further
 * than their own RANGE from the eye therefore answers the wrong question: stand 500 m away
 * from a circuit and every lamp fails that test, so nothing is sent and the entire track
 * goes black — while the pools of light you are looking at are exactly the thing that
 * should still be there. Illumination has to be visible as far as the source is.
 *
 * The reach test only ever looked correct because the chase camera sits on the car, inside
 * the pools. It is deleted rather than widened: there is no radius around the EYE that
 * answers a question about lamps lighting ground near THEMSELVES.
 *
 * What remains is a budget, not a cull. The shader carries a fixed number of slots, so the
 * nearest n to the camera win. That is an approximation with a known failure — from high
 * above a big circuit, pools beyond the nearest n stay unlit — and nearest-to-camera is
 * simply the best proxy available for "which pools fill the most of the screen".
 */
function cullLights(lights, eye, n) {
  const scored = [];
  for (const L of lights) {
    const dx = L.pos[0] - eye[0], dy = L.pos[1] - eye[1], dz = L.pos[2] - eye[2];
    scored.push({ L, d2: dx * dx + dy * dy + dz * dz });
  }
  scored.sort((a, b) => a.d2 - b.d2);
  return scored.slice(0, n).map(s => s.L);
}

const TrackLights = { parseIni, meshPatternToRegExp, conditionIsNight, resolveTrackLights, cullLights };
if (typeof module !== "undefined") module.exports = TrackLights;
if (typeof window !== "undefined") window.TrackLights = TrackLights;
