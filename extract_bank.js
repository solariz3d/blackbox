/* extract_bank.js — pull the raw samples out of an Assetto Corsa car's FMOD sound bank.
 *
 *   node extract_bank.js <car.bank> <outdir> [nameFilterRegex]
 *   node extract_bank.js ".../content/cars/ohyeah2389_t180_mach6/sfx/ohyeah2389_t180_mach6.bank" out
 *
 * WHY
 * The engine layers in ui/audio/ were hand-pulled from ONE car (the Mach 6) and are baked in as if
 * they were "the engine sound". There are 16 T-180 variants installed on this machine alone, each
 * with its own bank — so any other car plays the wrong engine. This reads a bank directly, which is
 * the first half of making BLACKBOX sound like whatever car the replay actually holds.
 *
 * FORMAT (FMOD FSB5, as shipped by AC — verified PCM16 on the Mach 6 bank)
 *   header:  "FSB5" | u32 version | u32 numSamples | u32 sampleHeadersSize | u32 nameTableSize
 *            | u32 dataSize | u32 mode(codec) | ...  (headers begin at +0x3C)
 *   sample:  packed u64 — bit0 next-chunk flag, bits1-4 frequency index, bit5 channels-1,
 *            bits6-33 dataOffset/16, bits34-63 sample count; optional extra chunks follow.
 *   Read that word as two u32 halves and the fields straddle the boundary — hence BigInt.
 *
 * Only PCM16 is written. Other codecs (Vorbis especially) need a header rebuild that is a project
 * of its own; the tool reports the codec and stops rather than writing corrupt wavs.
 */
const fs = require("fs");
const path = require("path");

const CODEC = { 0: "none", 1: "PCM8", 2: "PCM16", 3: "PCM24", 4: "PCM32", 5: "PCMFLOAT", 6: "GCADPCM",
  7: "IMAADPCM", 8: "VAG", 9: "HEVAG", 10: "XMA", 11: "MPEG", 12: "CELT", 13: "AT9", 14: "XWMA",
  15: "VORBIS", 16: "FADPCM", 17: "OPUS" };
const FREQ = { 1: 8000, 2: 11000, 3: 11025, 4: 16000, 5: 22050, 6: 24000, 7: 32000, 8: 44100, 9: 48000, 10: 96000 };

function parseBank(buf) {
  let o = -1;
  for (let i = 0; i + 4 <= buf.length; i++)
    if (buf[i] === 0x46 && buf[i + 1] === 0x53 && buf[i + 2] === 0x42 && buf[i + 3] === 0x35) { o = i; break; }
  if (o < 0) throw new Error("no FSB5 chunk found — not an FMOD bank?");
  const n = buf.readUInt32LE(o + 8), shSize = buf.readUInt32LE(o + 12);
  const ntSize = buf.readUInt32LE(o + 16), dSize = buf.readUInt32LE(o + 20), mode = buf.readUInt32LE(o + 24);
  const hdr = o + 0x3C, names = hdr + shSize, data = names + ntSize;
  const nameAt = i => {
    if (!ntSize) return "sample_" + i;
    // the name table is a BARE array of u32 offsets — no count field in front of it. Assuming one
    // shifts every name by a sample, which is silently wrong: you get a full set of plausible
    // names attached to the wrong audio (caught by matching extracted PCM against the wavs already
    // in ui/audio — index 92 is 4.92s and named 8700a_front, and eng_on_8700.wav is 4.92s).
    const off = buf.readUInt32LE(names + i * 4);
    let p = names + off, e = p;
    while (e < buf.length && buf[e] !== 0 && e - p < 128) e++;
    return buf.toString("utf8", p, e) || "sample_" + i;
  };
  const list = [];
  let p = hdr;
  for (let i = 0; i < n; i++) {
    const raw = buf.readBigUInt64LE(p);
    const hasChunks = Number(raw & 1n);
    const freq = FREQ[Number((raw >> 1n) & 0xfn)] || 44100;
    const chans = Number((raw >> 5n) & 1n) + 1;
    const dataOff = Number((raw >> 6n) & 0xFFFFFFFn) * 16;
    const samples = Number((raw >> 34n) & 0x3FFFFFFFn);
    let q = p + 8;
    if (hasChunks) { let more = 1; while (more) { const c = buf.readUInt32LE(q); more = c & 1; q += 4 + ((c >> 1) & 0xffffff); } }
    list.push({ i, name: nameAt(i), freq, chans, samples, dataOff });
    p = q;
  }
  // a sample's byte length is the gap to the next one (the last runs to the end of the data block)
  for (let i = 0; i < list.length; i++)
    list[i].bytes = (i + 1 < list.length ? list[i + 1].dataOff : dSize) - list[i].dataOff;
  return { codec: mode, codecName: CODEC[mode] || String(mode), data, dataSize: dSize, list };
}

function writeWav(file, pcm, freq, chans) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(chans, 22);
  h.writeUInt32LE(freq, 24); h.writeUInt32LE(freq * chans * 2, 28); h.writeUInt16LE(chans * 2, 32);
  h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

const [bankPath, outDir, filter] = process.argv.slice(2);
if (!bankPath || !outDir) { console.error("usage: node extract_bank.js <car.bank> <outdir> [nameFilterRegex]"); process.exit(1); }
const buf = fs.readFileSync(bankPath);
const bank = parseBank(buf);
console.log(`${path.basename(bankPath)} — ${bank.list.length} samples, codec ${bank.codecName}, ${(bank.dataSize / 1048576).toFixed(1)} MB`);
if (bank.codec !== 2) {
  console.error(`\nthis bank is ${bank.codecName}, not PCM16 — extraction would produce corrupt audio, so nothing was written.`);
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const re = filter ? new RegExp(filter, "i") : null;
let wrote = 0, skipped = 0, secs = 0;
const used = new Map();
for (const s of bank.list) {
  if (re && !re.test(s.name)) { skipped++; continue; }
  if (s.bytes <= 0 || bank.data + s.dataOff + s.bytes > buf.length) { console.warn(`  skip ${s.name}: implausible extent`); continue; }
  // names repeat in the bank (several "backfireEXT_3") — suffix duplicates instead of overwriting
  const base = s.name.replace(/[^A-Za-z0-9_.-]+/g, "_") || ("sample_" + s.i);
  const nth = (used.get(base) || 0) + 1; used.set(base, nth);
  const file = path.join(outDir, base + (nth > 1 ? "__" + nth : "") + ".wav");
  writeWav(file, buf.subarray(bank.data + s.dataOff, bank.data + s.dataOff + s.bytes), s.freq, s.chans);
  wrote++; secs += s.samples / s.freq;
}
console.log(`wrote ${wrote} wav${skipped ? ` (${skipped} filtered out)` : ""} — ${(secs / 60).toFixed(1)} min of audio → ${outDir}`);
