/* fsb5.js — read the samples out of an Assetto Corsa car's FMOD sound bank, in the browser.
 *
 * Every car ships its own engine. There are 16 T-180 variants installed on this machine and they do
 * not sound alike, so an app that ships one car's wavs plays the wrong engine for all the others.
 * This parses the replay's OWN car bank instead, which is also how the engine layers stop being
 * redistributed audio living in our repo.
 *
 * FSB5 layout (verified against the Mach 6 bank: 103 samples, PCM16, 68.9 MB):
 *   "FSB5" | u32 version | u32 numSamples | u32 sampleHeadersSize | u32 nameTableSize
 *          | u32 dataSize | u32 codec | ...        headers start at +0x3C
 *   sample header: packed u64 —
 *     bit 0      next-chunk flag        bits 1..4  frequency index
 *     bit 5      channels - 1           bits 6..33 data offset / 16
 *     bits 34..63 sample count
 *     followed by optional extra chunks when the flag is set.
 *   name table: a BARE array of u32 offsets — no count field. Assuming a count shifts every name
 *   by one sample, which is silently wrong (plausible names on the wrong audio); caught by matching
 *   extracted PCM against the wavs already in ui/audio. Do not "fix" this back.
 *
 * Only PCM16 is decoded — that is what AC ships. Anything else is reported, not guessed at.
 */
(function (root) {
  const FREQ = { 1: 8000, 2: 11000, 3: 11025, 4: 16000, 5: 22050, 6: 24000, 7: 32000, 8: 44100, 9: 48000, 10: 96000 };
  const CODEC = { 0: "none", 1: "PCM8", 2: "PCM16", 3: "PCM24", 4: "PCM32", 5: "PCMFLOAT", 6: "GCADPCM",
    7: "IMAADPCM", 8: "VAG", 9: "HEVAG", 10: "XMA", 11: "MPEG", 12: "CELT", 13: "AT9", 14: "XWMA",
    15: "VORBIS", 16: "FADPCM", 17: "OPUS" };

  function parse(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer);
    const dv = new DataView(arrayBuffer);
    let o = -1;
    for (let i = 0; i + 4 <= u8.length; i++)
      if (u8[i] === 0x46 && u8[i + 1] === 0x53 && u8[i + 2] === 0x42 && u8[i + 3] === 0x35) { o = i; break; }
    if (o < 0) throw new Error("no FSB5 chunk in bank");

    const numSamples = dv.getUint32(o + 8, true);
    const shSize = dv.getUint32(o + 12, true);
    const ntSize = dv.getUint32(o + 16, true);
    const dataSize = dv.getUint32(o + 20, true);
    const codec = dv.getUint32(o + 24, true);
    const hdr = o + 0x3c, names = hdr + shSize, data = names + ntSize;

    const nameAt = (i) => {
      if (!ntSize) return "sample_" + i;
      const off = dv.getUint32(names + i * 4, true);
      let p = names + off, e = p;
      while (e < u8.length && u8[e] !== 0 && e - p < 128) e++;
      let s = "";
      for (let k = p; k < e; k++) s += String.fromCharCode(u8[k]);
      return s || "sample_" + i;
    };

    const list = [];
    let p = hdr;
    for (let i = 0; i < numSamples; i++) {
      const raw = dv.getBigUint64(p, true);
      const hasChunks = Number(raw & 1n);
      const freq = FREQ[Number((raw >> 1n) & 0xfn)] || 44100;
      const chans = Number((raw >> 5n) & 1n) + 1;
      const dataOff = Number((raw >> 6n) & 0xfffffffn) * 16;
      const count = Number((raw >> 34n) & 0x3fffffffn);
      let q = p + 8;
      if (hasChunks) {
        let more = 1;
        while (more) { const c = dv.getUint32(q, true); more = c & 1; q += 4 + ((c >> 1) & 0xffffff); }
      }
      list.push({ index: i, name: nameAt(i), freq, chans, count, dataOff, dur: count / freq });
      p = q;
    }
    for (let i = 0; i < list.length; i++)
      list[i].bytes = (i + 1 < list.length ? list[i + 1].dataOff : dataSize) - list[i].dataOff;

    return { codec, codecName: CODEC[codec] || String(codec), dataStart: data, dataSize, samples: list, buffer: arrayBuffer };
  }

  /* One sample as planar float channels, ready for an AudioBuffer. */
  function decode(bank, sample) {
    if (bank.codec !== 2) throw new Error("bank is " + bank.codecName + ", only PCM16 is decoded");
    const start = bank.dataStart + sample.dataOff;
    const frames = Math.min(sample.count, Math.floor(sample.bytes / (2 * sample.chans)));
    const dv = new DataView(bank.buffer);
    const chans = [];
    for (let c = 0; c < sample.chans; c++) chans.push(new Float32Array(frames));
    for (let f = 0; f < frames; f++) {
      const base = start + f * sample.chans * 2;
      for (let c = 0; c < sample.chans; c++) chans[c][f] = dv.getInt16(base + c * 2, true) / 32768;
    }
    return { freq: sample.freq, frames, chans };
  }

  /* Sort the bank into the roles the engine actually plays.
   *
   * AC's naming convention, read off the Mach 6 bank: an engine layer is "<rpm><letter>" with an
   * optional suffix — 5591a_ext, 7348c, 8700a_front, 6944b_off, 5410d_off — plus idle stages named
   * idle_1837 / ext_idle_1642 / int_idle_1642. "_off" marks the off-load (overrun) recording; "int"
   * or "inside" marks the interior mix, which we skip because BLACKBOX listens from outside.
   */
  function classify(bank) {
    const out = { on: [], off: [], turbine: [], backfire: [], limiter: null, blowoff: null, als: [], skid: null, wind: null, other: [] };
    for (const s of bank.samples) {
      const n = s.name.toLowerCase();
      const interior = /(^|[^a-z])int(erior)?([^a-z]|$)|inside|_in_/.test(n);
      // An engine layer is named for its rpm and nothing else: "5591a_ext", "7348c", "6944b_off",
      // or an idle stage "idle_1837" / "ext_idle1635_front". The number must OWN the name — a loose
      // "any 3-5 digits" match drags in "911gt3_gears" as a 911 rpm layer and puts a gearbox
      // recording in the engine ladder.
      const rpm = (() => {
        const m = n.match(/^(\d{3,5})[a-z]?(?:_|$)/) || n.match(/idle_?(\d{3,5})(?:_|$)/);
        const v = m ? parseInt(m[1], 10) : 0;
        return v >= 500 && v <= 15000 ? v : 0;
      })();
      if (/backfire|_pop_|flutter|missgear/.test(n)) { out.backfire.push(s); continue; }
      if (/limiter/.test(n)) { out.limiter = out.limiter || s; continue; }
      if (/blowoff/.test(n)) { out.blowoff = out.blowoff || s; continue; }
      if (/\bals\b|als_/.test(n)) { out.als.push(s); continue; }
      if (/skid|tire_skid|tyre_rolling/.test(n)) { out.skid = out.skid || s; continue; }
      if (/wind/.test(n)) { out.wind = out.wind || s; continue; }
      if (/turbine|afterburner|kingair|^n1|^n2|\bn1\b|\bn2\b|turbo|fuel_?pump/.test(n)) { out.turbine.push(s); continue; }
      if (rpm) {
        (/_off|off$/.test(n) ? out.off : out.on).push(Object.assign({ rpm, interior }, s));
        continue;
      }
      out.other.push(s);
    }
    /* One layer per rpm. Exterior wins over an interior mix at the SAME rpm; between two of the same
     * kind the longer recording wins (fewer loop seams per second).
     *
     * Interior naming is not a reason to drop a layer outright — 5972a_inside is the only recording
     * anywhere near 6000 rpm in this bank, and the hand-pulled exterior set shipped it as
     * eng_on_5972. Excluding every "inside" name punched a hole in the ladder between 5591 and 6365
     * that the old built-in set did not have. Prefer exterior, fall back to whatever exists.
     */
    const dedupe = (arr) => {
      const by = new Map();
      for (const s of arr) {
        const cur = by.get(s.rpm);
        if (!cur) { by.set(s.rpm, s); continue; }
        const better = (cur.interior && !s.interior) ||
                       (cur.interior === s.interior && s.dur > cur.dur);
        if (better) by.set(s.rpm, s);
      }
      return [...by.values()].sort((a, b) => a.rpm - b.rpm);
    };
    out.on = dedupe(out.on);
    out.off = dedupe(out.off);
    return out;
  }

  const api = { parse, decode, classify };
  if (typeof module !== "undefined") module.exports = api;
  root.FSB5 = api;
})(typeof window !== "undefined" ? window : globalThis);
