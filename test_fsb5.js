/* test_fsb5.js — the bank parser, against a real Assetto Corsa car bank.
 *
 *   node test_fsb5.js ["<path to car.bank>"]
 *
 * Defaults to the Mach 6 bank in a local Steam install and SKIPS (exit 0) if it isn't there, so the
 * suite still runs on a machine with no Assetto Corsa. The parser is pure and browser-side, so it
 * can be exercised headlessly — which matters, because the failure it guards against is silent: an
 * off-by-one in the name table yields a full set of plausible names attached to the wrong audio.
 */
const fs = require("fs");
const path = require("path");
const FSB5 = require("./ui/fsb5.js");

/* Resolved, not assumed. This hardcoded the default Steam directory and so skipped forever
 * on any machine whose library is on another drive — reporting "no local install" while
 * Assetto Corsa sat on G:. A permanent skip is a dead test wearing a reasonable excuse. */
const E = require("./testenv.js");
const carDir = E.carDir("t180_mach6");
const DEFAULT = carDir ? require("path").join(carDir, "sfx", "ohyeah2389_t180_mach6.bank") : null;
const bankPath = process.argv[2] || DEFAULT;
if (!bankPath) E.skip("no car bank given and no Assetto Corsa install found");
if (!fs.existsSync(bankPath)) {
  console.log("SKIP: no car bank at " + bankPath + " (needs a local Assetto Corsa install)");
  process.exit(0);
}

let fails = 0;
const check = (ok, msg) => { console.log((ok ? "  ok   " : "  FAIL ") + msg); if (!ok) fails++; };

const buf = fs.readFileSync(bankPath);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const bank = FSB5.parse(ab);
console.log(`${path.basename(bankPath)} — ${bank.samples.length} samples, ${bank.codecName}, ${(bank.dataSize / 1048576).toFixed(1)} MB\n`);

console.log("parse");
check(bank.samples.length > 20, `found ${bank.samples.length} samples`);
check(bank.codec === 2, `codec is PCM16 (${bank.codecName})`);
check(bank.samples.every(s => s.freq >= 8000 && s.freq <= 96000), "every sample has a sane rate");
check(bank.samples.every(s => s.bytes > 0 && s.dataOff + s.bytes <= bank.dataSize + 16), "every extent lies inside the data block");
check(bank.samples.every(s => s.name && s.name.length > 0), "every sample has a name");

console.log("\nname table alignment (the silent failure)");
/* The name table is a bare offset array; assuming a count field in front of it shifts every name by
 * one sample, so you get a complete set of plausible names on the WRONG audio and nothing looks
 * broken. Durations alone can't catch that (I got them from the broken run and they agreed with it).
 * The invariant that can: ui/audio/eng_on_<rpm>.wav was extracted from this same bank by a different
 * tool at a different time, so the bank sample named for that rpm must CONTAIN that wav's samples.
 * Two independent extractions agreeing is evidence; a duration typed into a test is not.
 */
const byName = new Map(bank.samples.map(s => [s.name, s]));
function wavPcm(file) {                       // → Int16Array of interleaved samples
  const b = fs.readFileSync(file);
  let o = 12;
  while (o < b.length - 8) {
    const id = b.toString("ascii", o, o + 4), len = b.readUInt32LE(o + 4);
    if (id === "data") {
      const d = b.subarray(o + 8, o + 8 + Math.min(len, b.length - o - 8));
      return new Int16Array(d.buffer, d.byteOffset, Math.floor(d.length / 2));
    }
    o += 8 + len + (len & 1);
  }
  return new Int16Array(0);
}
function bankPcm(sample) {                    // → Int16Array of the raw sample data
  const start = bank.dataStart + sample.dataOff;
  return new Int16Array(bank.buffer.slice(start, start + sample.bytes - (sample.bytes % 2)));
}
function containsRun(hay, needle, at) {       // does hay contain needle's 2048-sample probe?
  const probe = needle.subarray(at, at + 2048);
  if (probe.length < 512) return false;
  outer:
  for (let i = 0; i + probe.length <= hay.length; i++) {
    if (hay[i] !== probe[0]) continue;
    for (let k = 1; k < probe.length; k++) if (hay[i + k] !== probe[k]) continue outer;
    return true;
  }
  return false;
}
for (const [wav, name] of [["eng_on_8700.wav", "8700a_front"], ["eng_on_5591.wav", "5591a_ext"], ["eng_off_6944.wav", "6944b_off"]]) {
  const f = path.join(__dirname, "ui", "audio", wav);
  const s = byName.get(name);
  if (!fs.existsSync(f) || !s) { check(false, `${wav} ↔ ${name}: missing (${!s ? "no such sample in bank" : "no shipped wav"})`); continue; }
  const need = wavPcm(f);
  check(containsRun(bankPcm(s), need, Math.floor(need.length / 2) & ~1),
        `${wav} audio is found inside the bank sample named ${name} (${s.dur.toFixed(2)}s)`);
}

console.log("\ndecode");
const s = byName.get("8700a_front");
const pcm = FSB5.decode(bank, s);
let peak = 0, energy = 0;
for (const ch of pcm.chans) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > peak) peak = v; energy += v * v; }
const rms = Math.sqrt(energy / (pcm.frames * pcm.chans.length));
console.log(`  8700a_front: ${pcm.frames} frames, ${pcm.chans.length}ch @ ${pcm.freq}Hz, peak ${peak.toFixed(3)}, rms ${rms.toFixed(4)}`);
check(pcm.frames > 1000, "decodes a plausible number of frames");
check(peak > 0.05 && peak <= 1.0, "peak is in range and not silence");
check(rms > 0.005, "carries real energy (not a block of zeros)");
check(pcm.chans.every(c => c.every(v => v >= -1.001 && v <= 1.001)), "all samples normalised to ±1");

console.log("\nclassification");
const c = FSB5.classify(bank);
console.log(`  on-load ${c.on.length}: ${c.on.map(x => x.rpm).join(", ")}`);
console.log(`  off-load ${c.off.length}: ${c.off.map(x => x.rpm).join(", ")}`);
console.log(`  turbine ${c.turbine.length}, backfire ${c.backfire.length}, als ${c.als.length}, other ${c.other.length}`);
check(c.on.length >= 6, `found an on-load rpm ladder (${c.on.length} layers)`);
check(c.off.length >= 2, `found off-load layers (${c.off.length})`);
check(c.on.every((x, i, a) => i === 0 || x.rpm > a[i - 1].rpm), "on-load ladder is sorted and free of duplicate rpm");
check(c.turbine.length >= 2, `found the turbine/afterburner layers the shipped wavs never had (${c.turbine.length})`);
check(c.backfire.length >= 3, `found backfire one-shots (${c.backfire.length})`);
// An interior mix is allowed ONLY where nothing exterior covers that rpm — dropping them outright
// punched a hole between 5591 and 6365 that the hand-pulled built-in set didn't have (it shipped
// 5972a_inside as eng_on_5972). So the rule is "exterior wins at the same rpm", not "never interior".
const interiorKept = c.on.filter(x => x.interior);
const shadowed = interiorKept.filter(x => bank.samples.some(o => o !== x && !/inside|_in_|(^|[^a-z])int([^a-z]|$)/i.test(o.name) && new RegExp("^" + x.rpm).test(o.name)));
check(shadowed.length === 0, `interior layers kept only where no exterior covers that rpm (${interiorKept.length} kept: ${interiorKept.map(x => x.rpm).join(", ") || "none"})`);
check(c.on.some(x => x.rpm >= 5900 && x.rpm <= 6050), "the ~5972 rung is present (the hole this rule was written for)");
// the ladder must actually cover the top of the range, which is where a pinned car lives
const top = c.on.length ? c.on[c.on.length - 1].rpm : 0;
check(top >= 7000, `ladder reaches ${top} rpm`);

console.log(fails ? `\n${fails} FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
