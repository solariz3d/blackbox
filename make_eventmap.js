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
// search from the START, not from a fixed offset: the metadata region is 188 KB in the T-180's car
// bank but a different size in every other bank, and AC's shared common.bank puts FSB5 somewhere
// else entirely (a hardcoded 0x2e000 start made it read a bogus name table and crash).
const fsbOff = b.indexOf(Buffer.from("FSB5"), 0);
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
/* A curve's x axis is read TWO ways because the bank stores it two ways, and the choice is not
 * cosmetic. When the automation hangs off a parameter, x is a float in parameter units (rpm,
 * throttle 0..1). When it hangs off the TIMELINE, x is a u32 of MILLISECONDS — reading those
 * bytes as a float yields denormals that all round to 0.0, so a real 0→4800 ms fade-in decodes
 * as the meaningless point list [[0,0],[0,1]]. Keep both and pick by the source (below). */
const curves = new Map(), curvesMs = new Map();
for (const c of by(/CURV$/)) { const stride = b.readUInt16LE(c.o + 34), n = (c.sz - 36) / stride, pts = [], ms = [];
  for (let i = 0; i < n; i++) { const o = c.o + 36 + i * stride;
    pts.push({ x: b.readFloatLE(o), y: b.readFloatLE(o + 4), shape: b.readFloatLE(o + 8) });
    ms.push({ x: b.readUInt32LE(o), y: b.readFloatLE(o + 4), shape: b.readFloatLE(o + 8) }); }
  curves.set(guid(c.o), pts); curvesMs.set(guid(c.o), ms); }
const ctrlByTarget = new Map();
for (const c of by(/CTRL$/)) { const t = guid(c.o + 16);
  if (!ctrlByTarget.has(t)) ctrlByTarget.set(t, []);
  ctrlByTarget.get(t).push({ curveId: guid(c.o), paramId: guid(c.o + 32), prop: b.readUInt32LE(c.o + 64) }); }

/* Every inline array in this format is `u16 tagged, u16 stride, element[]` where tagged == 2n+1.
 * (tagged == 0 means "no list at all"; an even non-zero tag introduces a u16 byte-length blob
 * whose interior is not decoded.) The same rule governs CURV, PMLB, PLST and EVTB — TLNB is
 * where it had to be worked out, because a timeline holds FIVE of these arrays back to back and
 * an empty one occupies two bytes, so nothing sits at a fixed offset. */
function readArray(o, end) {
  if (o + 2 > end) return null;
  const tagged = b.readUInt16LE(o);
  if (tagged === 0) return { kind: "null", count: 0, next: o + 2 };
  if (tagged & 1) {
    const count = (tagged - 1) / 2;
    if (count === 0) return { kind: "empty", count: 0, next: o + 2 };
    if (o + 4 > end) return null;
    const stride = b.readUInt16LE(o + 2);
    if (o + 4 + count * stride > end) return null;
    return { kind: "array", count, stride, at: o + 4, next: o + 4 + count * stride };
  }
  if (o + 4 > end) return null;
  const len = b.readUInt16LE(o + 2);
  if (o + 4 + len > end) return null;
  return { kind: "blob", count: 0, len, at: o + 4, next: o + 4 + len };
}

/* TLNB = guid[16] timelineId, guid[16] ownerEventId, then exactly 5 arrays.
 * Instrument placements are the stride-24 arrays: guid[16], u32 startMs, u32 lengthMs.
 * Verified: 26/26 timelines in the T-180 bank and 17/17 in AC's common.bank consume exactly,
 * and every stride-24 element resolves to a real WAIT/MUIT instrument. */
const timelineByEvent = new Map(), timelineIds = new Set();
let tlnbExact = 0, tlnbBad = 0;
for (const c of by(/TMLN\/TLNB$/)) {
  timelineIds.add(guid(c.o));
  let o = c.o + 32; const end = c.o + c.sz, arrs = []; let broke = false;
  for (let i = 0; i < 5; i++) { const a = readArray(o, end); if (!a) { broke = true; break; } arrs.push(a); o = a.next; }
  if (broke || o !== end) { tlnbBad++; continue; }
  tlnbExact++;
  const owner = guid(c.o + 16);
  for (const a of arrs) {
    if (a.kind !== "array" || a.stride !== 24) continue;
    for (let k = 0; k < a.count; k++) {
      const at = a.at + k * 24;
      if (!timelineByEvent.has(owner)) timelineByEvent.set(owner, []);
      timelineByEvent.get(owner).push({ iid: guid(at), startMs: b.readUInt32LE(at + 16), lengthMs: b.readUInt32LE(at + 20), timelineId: guid(c.o) });
    }
  }
}

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

/* Automation on one object. CTRL +32 names the curve's x axis, and it is NOT always a parameter:
 * for timeline-placed instruments it is the TIMELINE, in which case x is milliseconds and the
 * curve is a fade envelope over the instrument's own duration, not a response to anything the
 * game feeds in. Those two cases must stay distinguishable downstream or a 0→4800 ms fade-in
 * gets mistaken for a parameter ramp. */
function automationOf(iid) {
  return (ctrlByTarget.get(iid) || []).map((a) => {
    const onTimeline = timelineIds.has(a.paramId);
    const ap = params.get(a.paramId);
    return {
      property: PROP[a.prop] ? PROP[a.prop].name : "unknown_prop_" + a.prop,
      property_enum: a.prop, units: PROP[a.prop] ? PROP[a.prop].units : "unknown",
      vs_parameter: onTimeline ? null : (ap ? ap.name : null),
      vs_parameter_guid: a.paramId,
      vs_timeline: onTimeline,
      x_units: onTimeline ? "milliseconds_on_timeline" : "parameter_units",
      points: (onTimeline ? curvesMs.get(a.curveId) : curves.get(a.curveId)) || []
    };
  });
}

// ---- build events from GUIDs.txt ----
const guidsTxt = fs.readFileSync(BANK.replace(/[^\\/]+$/, "GUIDs.txt"), "latin1");
const eventPaths = guidsTxt.split(/\r?\n/).map((l) => l.match(/\{([^}]+)\}\s+(event:\S+)/)).filter(Boolean)
  .map((m) => ({ guid: m[1], path: m[2], short: m[2].split("/").pop() }));

/* Surfaces and skids are timeline-placed, so they were invisible until TLNB was decoded and are
 * listed here now: running this against AC's shared content/sfx/common.bank yields the whole
 * surface set. Override with BB_EVENTS=a,b,c. */
const WANT = process.env.BB_EVENTS ? process.env.BB_EVENTS.split(",") : ["engine_ext", "engine_int", "turbine", "engine_ext_old", "engine_int_old", "engine_custom", "transmission", "gear_ext", "gear_grind", "skid_ext", "skid_int", "wheel", "wind", "turbo", "tractioncontrol_ext", "limiter", "backfire_ext", "turbine_fuelpump", "jumpjack_charge",
  "grass", "gravel", "kerb", "sand", "dirt", "old", "extraturf", "screw", "unscrew", "ambience"];
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
      const autos = automationOf(iid);
      const gainCurves = autos.filter((a) => a.property_enum === 4).map((a) => a.points);
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
  /* Timeline-placed instruments. AC leans on these far more than the parameter sheets for
   * anything that is not the engine: in common.bank every surface (grass, gravel, kerb, sand,
   * old, extraturf) and in a car bank the skids, limiter and jumpjack live here and nowhere
   * else, so a sheets-only reader reports them as silent stubs. */
  rec.timeline_instruments = [];
  for (const t of timelineByEvent.get(ev.guid) || []) {
    const inst = instruments.get(t.iid);
    if (!inst) { rec.timeline_instruments.push({ instrument_guid: t.iid, kind: "unknown",
      note: "timeline placement references an instrument GUID absent from WAIT/MUIT" }); continue; }
    const autos = automationOf(t.iid);
    rec.timeline_instruments.push({
      instrument_guid: t.iid, kind: inst.kind,
      sample_index: inst.sample_index ?? null, sample_name: inst.sample_name ?? null,
      playlist: inst.playlist ?? null,
      placement: { start_ms: t.startMs, length_ms: t.lengthMs, timeline_guid: t.timelineId },
      parameter: null,
      parameter_note: "timeline-placed: position is time, not a parameter value. Any gain curve " +
        "below with vs_timeline=true is a fade envelope over this instrument's own duration.",
      static_volume_db: inst.volume_db ?? null,
      static_pitch_semitones: inst.pitch_semitones ?? null,
      pitch_automated: autos.some((a) => a.property_enum === 1),
      loop_mode: inst.loop_mode ?? "unknown",
      autopitch_root: inst.float_at_69 ?? null,
      automation: autos,
      /* Surface volume does not live on the instrument — it lives on the group bus the
       * instrument feeds (prop#0, dB, vs speed/decay). Resolved here because an instrument-only
       * reader concludes, wrongly, that these events respond to nothing. */
      bus_automation: inst.output_bus_ref ? automationOf(inst.output_bus_ref) : [],
      output_bus_guid: inst.output_bus_ref ?? null
    });
  }
  rec.timeline_instrument_count = rec.timeline_instruments.length;

  if (rec.instrument_count === 0 && rec.timeline_instrument_count === 0) {
    const tl = by(/TMLN\/TLNB$/).filter((c) => guid(c.o + 16) === ev.guid).map((c) => c.sz);
    rec.note = "EMPTY EVENT in this bank: no parameter-sheet and no timeline instruments. " +
      "Timeline chunk sizes " + JSON.stringify(tl) + " (42 = minimum/empty). This event is a stub; " +
      "it produces no sound from this bank.";
  }
  /* Short names collide: AC's shared GUIDs.txt lists a `skid_ext` for every stock car, and only the
   * ones whose data lives in THIS bank decode to anything. Keep the populated one rather than
   * whichever happened to come last, or a real event reads as an empty stub. */
  const total = (r) => r.instrument_count + (r.timeline_instrument_count || 0);
  const prev = out.events[ev.short];
  if (!prev || (total(prev) === 0 && total(rec) > 0)) out.events[ev.short] = rec;
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
      "INST +24 u32 == 0xFFFFFFFF with +28 == 1 -> looping": "65 loop / 102 oneshot; every loop is a sustained engine/wind/tyre bed, every oneshot is a backfire/pop/door - 100% semantically coherent",
      "inline array header = u16 (2n+1), u16 stride": "one rule governs CURV, PMLB, PLST, EVTB and TLNB; consumes every one of those chunks exactly, in both the T-180 bank and AC common.bank. tagged 0 = no list; even non-zero = u16 byte-length blob",
      "TLNB = guid[16] timelineId, guid[16] ownerEventId, then exactly 5 inline arrays": "26/26 timelines exact in the T-180 bank, 17/17 in common.bank, zero misparses",
      "TLNB stride-24 element = guid[16] instrument, u32 startMs, u32 lengthMs": "every element resolved to a real WAIT/MUIT instrument in both banks (21/21)",
      "CTRL +32 is the curve's x-axis SOURCE and may be a TIMELINE, not a parameter": "common.bank: 33 parameter-sourced, 12 timeline-sourced, 0 unresolved",
      "timeline-sourced curve x is u32 milliseconds, not float": "reads as 0..4800 ms fade-ins and e.g. 355200..362660 ms fade-outs that land exactly at the end of the instrument's own 362660 ms length; as float the same bytes are denormals that all print as 0.0",
      "INST +0 guid = owning timeline (when timeline-placed)": "matches the TLNB timelineId for timeline instruments and is zero for parameter-sheet ones - this was previously listed as an unknown"
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
      "TLNB array slot meanings": "the 5 arrays are decoded structurally, but WHICH slot means what (master track vs sub-track vs markers) is not established; instruments were found in slots 0 and 1 and are collected from any stride-24 array",
      "TLNB even-tagged blob contents": "an even non-zero array tag introduces a u16 byte-length blob (seen at stride-22-ish sizes, never containing instrument GUIDs); interior not decoded - likely markers or tempo",
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
for (const [k, v] of Object.entries(out.events)) console.log("  " + k.padEnd(16) + " sheet=" + String(v.instrument_count).padStart(2) +
  " timeline=" + String(v.timeline_instrument_count || 0).padStart(2) + (v.note ? "  << stub" : ""));
console.log(`  TLNB timelines parsed: ${tlnbExact} exact, ${tlnbBad} misparsed`);

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
    /* Timeline-placed loops, in the same layer shape but explicitly NOT parameter-keyed.
     * `param: null` is load-bearing: the runtime keys layers by parameter name, and these
     * respond to no parameter at all — a skid loop is gated by the game setting the event's
     * volume, not by anything in the bank. Handing it `param: "rpms"` with from/to in
     * milliseconds would make it sound at every rpm forever. `from`/`to` stay null for the
     * same reason; the real extent is carried separately as fromMs/toMs. */
    for (const I of ev.timeline_instruments || []) {
      if (I.sample_index == null || I.loop_mode !== "loop") { oneshots++; continue; }
      const auto = (I.automation || []).filter(a => a.property_enum === 4 || a.property_enum === 0);
      // bus curves ride a real parameter (surfaces: dB vs speed/decay) and are the only thing
      // the game actually modulates these with, so they are the ones worth carrying
      const busAuto = (I.bus_automation || []).filter(a => a.property_enum === 0 && !a.vs_timeline);
      layers.push({
        sample: I.sample_index, name: I.sample_name,
        root: I.autopitch_root && I.autopitch_root > 1 ? I.autopitch_root : 0,
        param: null, from: null, to: null,
        place: "timeline", fromMs: I.placement.start_ms, toMs: I.placement.start_ms + I.placement.length_ms,
        db: I.static_volume_db || 0,
        semitones: I.static_pitch_semitones || 0,
        // `t: true` marks an x axis in milliseconds along this instrument's own timeline
        curves: auto.map(a => ({ db: a.property_enum === 0, t: !!a.vs_timeline, pts: a.points.map(p => [p.x, p.y]) }))
          .concat(busAuto.map(a => ({ db: true, t: false, bus: true, pts: a.points.map(p => [p.x, p.y]) }))),
        curveParams: auto.map(a => a.vs_timeline ? null : a.vs_parameter).concat(busAuto.map(a => a.vs_parameter)),
      });
    }
    // the parameter each event's sheets ride, so the runtime knows what to feed it
    if (layers.length) compact.events[name] = { layers, oneshots, params: [...new Set(layers.map(l => l.param).filter(Boolean))] };
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
