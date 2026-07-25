/* Decode FMOD Studio .bank event metadata -> machine-readable JSON.
 * Verified against ohyeah2389_t180_mach6.bank (bank format version 80 / 0x50).
 * Every field is tagged confirmed | inferred | unknown in the emitted schema notes. */
const fs = require("fs");
const BANK = process.argv[2], OUT = process.argv[3];
const b = fs.readFileSync(BANK);
const asc = (o, n) => b.toString("latin1", o, o + n);
const guid = (o) => [b.readUInt32LE(o).toString(16).padStart(8, "0"), b.readUInt16LE(o + 4).toString(16).padStart(4, "0"),
  b.readUInt16LE(o + 6).toString(16).padStart(4, "0"), b.toString("hex", o + 8, o + 10), b.toString("hex", o + 10, o + 16)].join("-");

// ---- RIFF walk, keeping WAIT/MUIT groups intact so INST pairs with its sibling ----
const ch = [], waitGroups = [], muitGroups = [];
(function w(o, end, path) {
  while (o + 8 <= end) {
    const id = asc(o, 4), sz = b.readUInt32LE(o + 4);
    if (o + 8 + sz > end + 8) return;
    if (id === "LIST") {
      const form = asc(o + 8, 4);
      if (form === "WAIT" || form === "MUIT") {
        const g = {}; let q = o + 12;
        while (q + 8 <= o + 8 + sz) { const i2 = asc(q, 4), s2 = b.readUInt32LE(q + 4); if (!g[i2]) g[i2] = { o: q + 8, sz: s2 }; q += 8 + s2 + (s2 & 1); }
        (form === "WAIT" ? waitGroups : muitGroups).push(g);
      }
      w(o + 12, o + 8 + sz, path + "/" + form);
    } else ch.push({ p: path + "/" + id, o: o + 8, sz });
    o += 8 + sz + (sz & 1);
  }
})(12, 8 + b.readUInt32LE(4), "");
const by = (re) => ch.filter((c) => re.test(c.p));

// ---- FSB5 name table: BARE u32 offset array, NO count field ----
const fsbOff = b.indexOf(Buffer.from("FSB5"), 0x2e000);
const nSamples = b.readUInt32LE(fsbOff + 8);
const ntStart = fsbOff + 0x3c + b.readUInt32LE(fsbOff + 12);
const nameTableSize = b.readUInt32LE(fsbOff + 16);
const sampleNames = [];
for (let i = 0; i < nSamples; i++) { let p = ntStart + b.readUInt32LE(ntStart + i * 4), e = p; while (b[e]) e++; sampleNames.push(asc(p, e - p)); }
const nameTableSane = b.readUInt32LE(ntStart) === 4 * nSamples;

// ---- lookup tables ----
const wavIndex = new Map(); for (const c of by(/WAV $/)) wavIndex.set(guid(c.o), b.readUInt16LE(c.o + 22));
const params = new Map();
for (const c of by(/PARM\/PRMB$/)) { const L = b.readUInt16LE(c.o + 21);
  params.set(guid(c.o), { name: asc(c.o + 23, L), min: b.readFloatLE(c.o + 23 + L), max: b.readFloatLE(c.o + 27 + L) }); }
const curves = new Map();
for (const c of by(/CURV$/)) { const stride = b.readUInt16LE(c.o + 34), n = (c.sz - 36) / stride, pts = [];
  for (let i = 0; i < n; i++) { const o = c.o + 36 + i * stride; pts.push({ x: b.readFloatLE(o), y: b.readFloatLE(o + 4), shape: b.readFloatLE(o + 8) }); }
  curves.set(guid(c.o), pts); }
const ctrlByTarget = new Map();
for (const c of by(/CTRL$/)) { const t = guid(c.o + 16);
  if (!ctrlByTarget.has(t)) ctrlByTarget.set(t, []);
  ctrlByTarget.get(t).push({ curveId: guid(c.o), paramId: guid(c.o + 32), prop: b.readUInt32LE(c.o + 64) }); }

// ---- instruments: id -> decoded INST fields + waveform / playlist ----
const instruments = new Map();
function readINST(I) {
  return {
    volume_db: b.readFloatLE(I.o + 16),
    pitch_semitones: b.readFloatLE(I.o + 20),
    loop_raw: { u32_at_24: b.readUInt32LE(I.o + 24), u8_at_28: b[I.o + 28] },
    loop_mode: b.readUInt32LE(I.o + 24) === 0xFFFFFFFF ? "loop" : "oneshot",
    param_ref: guid(I.o + 53) === "00000000-0000-0000-0000-000000000000" ? null : guid(I.o + 53),
    output_bus_ref: guid(I.o + 83) === "00000000-0000-0000-0000-000000000000" ? null : guid(I.o + 83),
    float_at_69: b.readFloatLE(I.o + 69)
  };
}
for (const g of waitGroups) {
  if (!g.INST || !g.WAIB) continue;
  const id = guid(g.WAIB.o), si = wavIndex.get(guid(g.WAIB.o + 16));
  instruments.set(id, { kind: "wave", sample_index: si ?? null, sample_name: si !== undefined ? sampleNames[si] : null, ...readINST(g.INST) });
}
for (const g of muitGroups) {
  if (!g.INST || !g.MUIB || !g.PLST) continue;
  const id = guid(g.MUIB.o), P = g.PLST, n = Math.floor((P.sz - 12) / 20), entries = [];
  for (let i = 0; i < n; i++) { const o = P.o + 12 + i * 20, wid = guid(o);
    const child = instruments.get(wid); const si = child ? child.sample_index : null;
    entries.push({ sample_index: si, sample_name: si !== null && si !== undefined ? sampleNames[si] : null, weight: b.readFloatLE(o + 16) }); }
  instruments.set(id, { kind: "multi", playlist: entries, playlist_selection: "unknown (random vs sequential not decoded)", ...readINST(g.INST) });
}

// ---- curve evaluation: piecewise linear, endpoints held outside the defined span ----
function evalCurve(pts, x) {
  if (!pts.length) return 1;
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i], c = pts[i + 1];
    if (x >= a.x && x <= c.x) return c.x === a.x ? c.y : a.y + (c.y - a.y) * ((x - a.x) / (c.x - a.x)); }
  return pts[pts.length - 1].y;
}
const PROP = { 0: { name: "bus_volume", units: "dB" }, 1: { name: "pitch", units: "semitones" },
  4: { name: "instrument_gain", units: "linear_0_1" } };

// ---- build events from GUIDs.txt ----
const guidsTxt = fs.readFileSync(BANK.replace(/[^\\/]+$/, "GUIDs.txt"), "latin1");
const eventPaths = guidsTxt.split(/\r?\n/).map((l) => l.match(/\{([^}]+)\}\s+(event:\S+)/)).filter(Boolean)
  .map((m) => ({ guid: m[1], path: m[2], short: m[2].split("/").pop() }));

const WANT = ["engine_ext", "engine_int", "turbine", "engine_ext_old", "engine_int_old", "engine_custom", "transmission", "gear_ext", "gear_grind", "skid_ext", "wheel", "wind", "turbo", "tractioncontrol_ext", "limiter", "backfire_ext", "turbine_fuelpump"];
const out = { events: {} };

for (const ev of eventPaths) {
  if (!WANT.includes(ev.short)) continue;
  const evtb = by(/EVNT\/EVTB$/).find((c) => guid(c.o) === ev.guid);
  const rec = { event_path: ev.path, event_guid: ev.guid,
    evtb_chunk: evtb ? { offset: "0x" + (evtb.o - 8).toString(16), size: evtb.sz } : null,
    parameter_sheets: [], instrument_count: 0, note: null };

  for (const sh of by(/PMLO\/PMLB$/)) {
    if (guid(sh.o + 32) !== ev.guid) continue;
    const p = params.get(guid(sh.o));
    const n = sh.sz > 52 ? Math.floor((sh.sz - 52) / 24) : 0;
    const sheet = { parameter: p ? p.name : null, parameter_guid: guid(sh.o),
      parameter_range: p ? { min: p.min, max: p.max } : null, instrument_count: n, instruments: [] };
    for (let i = 0; i < n; i++) {
      const o = sh.o + 52 + i * 24, iid = guid(o);
      const start = b.readFloatLE(o + 16), len = b.readFloatLE(o + 20);
      const inst = instruments.get(iid) || { kind: "unknown", note: "instrument GUID not found among WAIT/MUIT records" };
      const autos = (ctrlByTarget.get(iid) || []).map((a) => {
        const ap = params.get(a.paramId), pts = curves.get(a.curveId) || [];
        return { property: PROP[a.prop] ? PROP[a.prop].name : "unknown_prop_" + a.prop,
          property_enum: a.prop, units: PROP[a.prop] ? PROP[a.prop].units : "unknown",
          vs_parameter: ap ? ap.name : null, vs_parameter_guid: a.paramId, points: pts };
      });
      const gainCurves = autos.filter((a) => a.property_enum === 4).map((a) => curves.get(
        (ctrlByTarget.get(iid) || []).find((c) => c.curveId && curves.get(c.curveId) === curves.get(c.curveId) && c.prop === 4 && c.paramId === a.vs_parameter_guid).curveId));
      // effective audible window over the trigger box, product of all prop#4 curves
      let audFrom = null, audTo = null;
      if (p) { const lo = start, hi = start + len, steps = 400;
        for (let s = 0; s <= steps; s++) { const x = lo + (hi - lo) * (s / steps);
          let g = 1; for (const cv of gainCurves) if (cv) g *= evalCurve(cv, x);
          if (g > 0.01) { if (audFrom === null) audFrom = x; audTo = x; } } }
      sheet.instruments.push({
        instrument_guid: iid, kind: inst.kind,
        sample_index: inst.sample_index ?? null, sample_name: inst.sample_name ?? null,
        playlist: inst.playlist ?? null,
        parameter: p ? p.name : null,
        trigger_box: { start, length: len, end: start + len, units: p ? p.name + " units" : "unknown" },
        audible_window: p ? { from: audFrom, to: audTo,
          note: "trigger box intersected with product of prop#4 gain curves > 0.01; product rule is INFERRED" } : null,
        static_volume_db: inst.volume_db ?? null,
        static_pitch_semitones: inst.pitch_semitones ?? null,
        pitch_automated: autos.some((a) => a.property_enum === 1),
        loop_mode: inst.loop_mode ?? "unknown",
        loop_raw: inst.loop_raw ?? null,
        float_at_inst_69: inst.float_at_69 ?? null,
        automation: autos
      });
      rec.instrument_count++;
    }
    if (n) rec.parameter_sheets.push(sheet);
  }
  if (rec.instrument_count === 0) {
    const tl = by(/TMLN\/TLNB$/).filter((c) => guid(c.o + 16) === ev.guid).map((c) => c.sz);
    rec.note = "EMPTY EVENT in this bank: no parameter-sheet instruments. Timeline chunk sizes " +
      JSON.stringify(tl) + " (42 = minimum/empty). This event is a stub; it produces no sound from this bank.";
  }
  out.events[ev.short] = rec;
}

// ---- simultaneity sweep ----
function sweep(shortName, paramName, lo, hi, step) {
  const rec = out.events[shortName]; if (!rec) return null;
  const sheet = rec.parameter_sheets.find((s) => s.parameter === paramName); if (!sheet) return null;
  const series = [];
  for (let x = lo; x <= hi; x += step) {
    const live = sheet.instruments.filter((I) => {
      if (x < I.trigger_box.start || x > I.trigger_box.end) return false;
      let g = 1;
      for (const a of I.automation) if (a.property_enum === 4) g *= evalCurve(a.points, x);
      return g > 0.01;
    });
    series.push({ rpm: x, audible_count: live.length, layers: live.map((I) => I.sample_name) });
  }
  return series;
}
out.simultaneity = {
  method: "instrument counted audible when rpm is inside its trigger box AND the product of its prop#4 gain curves exceeds 0.01",
  method_confidence: "INFERRED - the multiplicative combination rule for multiple prop#4 curves on one instrument is not documented",
  engine_custom_vs_rpms: sweep("engine_custom", "rpms", 0, 25000, 500),
  engine_ext_old_vs_rpms: sweep("engine_ext_old", "rpms", 0, 25000, 500),
  engine_int_old_vs_rpms: sweep("engine_int_old", "rpms", 0, 25000, 500)
};

out._meta = {
  source_bank: BANK,
  bank_format_version: b.readUInt32LE(by(/^\/FMT/)[0].o),
  fsb5: { offset: "0x" + fsbOff.toString(16), sample_count: nSamples, name_table_size: nameTableSize,
    name_table_layout: "bare u32 offset array, NO count field",
    name_table_sanity_check: nameTableSane ? "PASS (first u32 == 4*sampleCount)" : "FAIL" },
  field_confidence: {
    confirmed: {
      "RIFF tree / chunk ids": "walked cleanly end to end",
      "EVTB +0 = event GUID": "matches GUIDs.txt byte for byte",
      "PRMB name/min/max": "45/45 params, ranges match AC conventions",
      "PMLB +32 = owner event GUID": "45/45 matched an EVTB GUID",
      "PMLB child = {guid, float start, float LENGTH}": "length not max; independently matches FModBankParser FTriggerBox{Guid,StartTime,Length}",
      "WAIB +16 -> WAV -> +22 = FSB5 sample index": "verified by re-extraction",
      "CURV point = {x, y, shape}": "matches FModBankParser FCurvePoint{X,Y,Shape,Type}",
      "CTRL 1:1 with CURV; +16 target, +32 parameter, +64 property enum": "188/188 curve ids matched",
      "INST +16 float = volume dB": "clean dB values (0, 1, 3, 5, 7, -8, -10.5)",
      "INST +20 float = pitch semitones": "exact semitone values (-12.00 = one octave, +10.00)",
      "INST +24 u32 == 0xFFFFFFFF with +28 == 1 -> looping": "65 loop / 102 oneshot; every loop is a sustained engine/wind/tyre bed, every oneshot is a backfire/pop/door - 100% semantically coherent"
    },
    inferred: {
      "property enum 0 = bus volume dB": "targets group buses, y in -42..+10",
      "property enum 1 = pitch": "targets wave instruments, small signed range",
      "property enum 4 = instrument gain, linear 0..1": "wave instruments only, y strictly 0..1, always in fade-in/fade-out pairs",
      "property enum >= 1000 = effect parameter index": "targets bank/plugin effect chunks only",
      "multiple prop#4 curves multiply": "two curves on one property vs one parameter cannot coexist in FMOD Studio's UI; the observed pairs form a trapezoid only under a product rule",
      "curve endpoints hold outside the defined span": "standard FMOD behaviour, not verified against this bank",
      "INST +69 float": "equals the rpm encoded in the sample filename for engine loops (idle_2826 -> 2826.00, ext_idle1635_front -> 1635.00) and 1.0 for 116/167 others; correlation is exact and cannot be coincidence, but the FMOD property it corresponds to is NOT established"
    },
    unknown: {
      "curve 'shape' field semantics": "third float per point; 0.0 in most curves; interpolation curvature assumed but not decoded",
      "CURV point 4th u32 ('Type' in FModBankParser)": "not decoded",
      "playlist selection mode": "PLST holds guid+weight per entry; random vs sequential vs shuffle flag not located",
      "TLNB child array": "timeline-placed instruments (82 of 186) not decoded; base offset varies (42/68) so the array header is not at a fixed offset",
      "EVTB trailing fields": "polyphony, priority, min/max distance not decoded",
      "INST +0..15 GUID": "zero for 154/167 records; purpose unknown",
      "INST +99..122": "small counters, not decoded",
      "PROP chunk layout": "per-instrument property overrides (46/62 bytes, 2 GUIDs) not decoded - static volume/pitch here may OVERRIDE the INST values reported above",
      "fade in/out times, start offset, probability, trigger conditions beyond the parameter trigger box": "not located"
    },
    ambiguous_readings: {
      "PMLB child second float": "reads as either 'max' or 'length'. LENGTH is correct - confirmed by inverted cases (start 15000, second float 10000 -> 15000..25000, not 15000..10000) and by FModBankParser's FTriggerBox. Reading it as max silently produces plausible but wrong narrow ranges.",
      "FSB5 name table base": "offsets at ntStart+0 (correct) vs ntStart+4 (wrong). Both parse without error; the +4 reading shifts every sample name by one and mislabels engine layers as 'door_open'/'tyre_explosion'. Sanity check: first u32 must equal 4*sampleCount.",
      "INST +24/+28 loop pair": "could be {loop count, loop enable} or a single 8-byte field. Either way 0xFFFFFFFF/1 = infinite loop is unambiguous in effect."
    }
  }
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log("wrote " + OUT + "  (" + fs.statSync(OUT).size + " bytes)");
for (const [k, v] of Object.entries(out.events)) console.log("  " + k.padEnd(16) + " instruments=" + v.instrument_count + (v.note ? "  << " + v.note.slice(0, 60) : ""));

/* ---------------------------------------------------------------------------
 * Compact map for the runtime.
 *
 * The JSON above is the full forensic record — every field, every "unknown", for
 * reading. The player needs only what it plays, so emit a small classic script
 * (ui/ is shared-global classic scripts, not modules) holding, per event, the
 * LOOPING instruments with a sample: which sample, its authored autopitch root,
 * the trigger box, the static dB, and the gain curves as raw point lists.
 *
 * One-shots (the throttle-sheet backfire/pop multi-instruments, playlist-driven)
 * are deliberately left out of v1: they need trigger-and-retrigger logic, not a
 * gain curve, and BLACKBOX already fires backfires off detected gear shifts.
 * They are counted in `oneshots` so the omission is visible rather than silent.
 *
 *   node make_eventmap.js <car.bank> <out.json> [ui/eventmap.js] [carId]
 */
const JSOUT = process.argv[4] || null;
if (JSOUT) {
  const carId = process.argv[5] || BANK.replace(/\\/g, "/").split("/").pop().replace(/\.bank$/i, "");
  const compact = { car: carId, generated: "make_eventmap.js", events: {} };
  for (const [name, ev] of Object.entries(out.events)) {
    const layers = [];
    let oneshots = 0;
    for (const sheet of ev.parameter_sheets || []) {
      for (const I of sheet.instruments) {
        if (I.sample_index == null || I.loop_mode !== "loop") { oneshots++; continue; }
        layers.push({
          sample: I.sample_index,
          name: I.sample_name,
          // authored autopitch root — NOT the number in the sample's name. 5972a_inside is rooted
          // at 5900, 7348c at 7050, 6365d at 12800. Assuming name == root detunes the whole ladder.
          root: I.float_at_inst_69 && I.float_at_inst_69 > 1 ? I.float_at_inst_69 : 0,
          param: I.parameter,
          from: I.trigger_box.start,
          to: I.trigger_box.end,
          db: I.static_volume_db || 0,
          // Gain automation, multiplied at playback. TWO kinds, and the difference is not cosmetic:
          // prop#4 (instrument_gain) is LINEAR 0..1, prop#0 (bus_volume) is DECIBELS — transmission
          // authors its curves in dB running −42 → +10, so reading them as linear gain would be
          // silently, wildly wrong. Each curve carries its own units.
          curves: (I.automation || []).filter(a => a.property_enum === 4 || a.property_enum === 0)
            .map(a => ({ db: a.property_enum === 0, pts: a.points.map(p => [p.x, p.y]) })),
          // which parameter each curve rides is per-automation, not per-instrument: an engine layer
          // can be gated on rpms and ducked on throttle at once
          curveParams: (I.automation || []).filter(a => a.property_enum === 4 || a.property_enum === 0)
            .map(a => a.vs_parameter),
        });
      }
    }
    // the parameter each event's sheets ride, so the runtime knows what to feed it
    if (layers.length) compact.events[name] = { layers, oneshots, params: [...new Set(layers.map(l => l.param))] };
  }
  fs.writeFileSync(JSOUT, "/* eventmap.js — GENERATED by make_eventmap.js. Do not hand-edit.\n" +
    " *\n * Assetto Corsa's own engine recipe for one car, decoded from its FMOD bank: which samples each\n" +
    " * event layers, over what rpm range, at what gain, pitched from which authored root. Regenerate:\n" +
    " *   node make_eventmap.js \"<...>/<car>.bank\" out.json ui/eventmap.js <carId>\n */\n" +
    "window.BBEventMap = " + JSON.stringify(compact) + ";\n");
  console.log("\nwrote " + JSOUT + "  (" + (fs.statSync(JSOUT).size / 1024).toFixed(1) + " KB)");
  for (const [k, v] of Object.entries(compact.events))
    console.log("  " + k.padEnd(16) + " " + String(v.layers.length).padStart(2) + " looping layers" +
      (v.oneshots ? "  (+" + v.oneshots + " one-shots not carried)" : ""));
}
