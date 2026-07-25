/* make_engineprofile.js — measure the car's own harmonic signature out of its own recordings.
 *
 *   node make_engineprofile.js [ui/audio] [ui/engineprofile.js]
 *
 * WHY THIS EXISTS
 * The sample-bank engine (crossfaded loops + playbackRate) has a structural ceiling: a loop at a
 * steady rate is a drone, pitch-shifting drags formants and noise floor along with it (hence the
 * ±3-semitone clamp), and rpm resolution is however many recordings exist. Measured on a real run,
 * a driver who keeps the Mach 6 pinned spends 88% of a session nearest the top TWO of nine bands —
 * so the bank has nothing to crossfade and the engine sounds flat no matter how good the samples are.
 *
 * The recordings themselves say what to do instead. They are 73–93% TONAL, and every one of them is
 * a harmonic stack on the same grid: integer multiples of rpm/120 Hz — the four-stroke engine-cycle
 * fundamental (two crank revolutions per cycle). eng_on_7644's series simply starts on the 3rd
 * harmonic of that grid rather than the 1st. So the sound is not noise that happens to be pitched;
 * it IS a harmonic series whose amplitudes change with rpm and load.
 *
 * That is directly resynthesizable: extract amplitude per harmonic per recording here, and at
 * runtime drive a wavetable oscillator at exactly rpm/120 Hz, morphing between the neighbouring
 * profiles. Pitch then tracks rpm continuously with no clamp and no bands to run out of.
 *
 * NOT the synth layers that were muted on 2026-07-23: those were an INVENTED V8 laid over the
 * samples, which is why they stopped sounding like the car. Nothing here is invented — every
 * amplitude is measured from the car's own audio.
 *
 * Emitted as a classic script assigning window.BBEngineProfile (ui/ is classic scripts in shared
 * global scope, not modules — see CLAUDE.md), so it needs no fetch and no CORS.
 */
const fs = require("fs");
const path = require("path");

const AUDIO_DIR = process.argv[2] || path.join(__dirname, "ui", "audio");
const OUT = process.argv[3] || path.join(__dirname, "ui", "engineprofile.js");

const MAX_HARM = 220;     // harmonics kept per profile (rpm/120 grid reaches ~16 kHz by here at 8700)
const MAX_HZ = 11000;     // ignore anything above this — above the useful band and mostly hiss
const FFT_N = 32768;      // 1.34 Hz bins at 44.1 kHz: resolves the rpm/120 grid even at idle
const WINDOWS = 8;        // analysis windows averaged per file (kills one-off transients)

// ---------- wav ----------
function readWav(file) {
  const b = fs.readFileSync(file);
  const fmt = b.indexOf("fmt ");
  if (fmt < 0) throw new Error("no fmt chunk: " + file);
  const ch = b.readUInt16LE(fmt + 10), sr = b.readUInt32LE(fmt + 12), bits = b.readUInt16LE(fmt + 22);
  if (bits !== 16) throw new Error("expected 16-bit pcm: " + file);
  let o = 12, dataOff = -1, dataLen = 0;
  while (o < b.length - 8) {
    const id = b.toString("ascii", o, o + 4), len = b.readUInt32LE(o + 4);
    if (id === "data") { dataOff = o + 8; dataLen = Math.min(len, b.length - o - 8); break; }
    o += 8 + len + (len & 1);
  }
  if (dataOff < 0) throw new Error("no data chunk: " + file);
  const n = Math.floor(dataLen / (2 * ch));
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += b.readInt16LE(dataOff + (i * ch + c) * 2);
    x[i] = s / (ch * 32768);
  }
  return { x, sr, ch, dur: n / sr };
}

// ---------- fft ----------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// magnitude spectrum averaged over WINDOWS hann-windowed frames
function avgSpectrum(x, sr) {
  const N = Math.min(FFT_N, 1 << Math.floor(Math.log2(x.length)));
  const acc = new Float64Array(N / 2);
  let frames = 0;
  for (let k = 1; k <= WINDOWS; k++) {
    const at = Math.floor((x.length - N - 1) * (k / (WINDOWS + 1)));
    if (at < 0) continue;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[at + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    fft(re, im);
    for (let i = 0; i < N / 2; i++) acc[i] += Math.hypot(re[i], im[i]);
    frames++;
  }
  if (!frames) throw new Error("file too short to analyse");
  for (let i = 0; i < acc.length; i++) acc[i] /= frames;
  return { mag: acc, binHz: sr / N, N };
}

// amplitude at an arbitrary frequency: peak of the 3 bins around it (the recording's true rpm
// drifts a little from its label, so a strict single-bin read would undercount every harmonic)
function ampAt(mag, binHz, hz) {
  const c = hz / binHz;
  const i0 = Math.max(1, Math.round(c) - 1), i1 = Math.min(mag.length - 1, Math.round(c) + 1);
  let m = 0;
  for (let i = i0; i <= i1; i++) m = Math.max(m, mag[i]);
  return m;
}

// broadband floor near a frequency: median of a neighbourhood, excluding the harmonic bins
function floorAt(mag, binHz, hz, spanHz) {
  const c = Math.round(hz / binHz), w = Math.max(6, Math.round(spanHz / binHz));
  const v = [];
  for (let i = c - w; i <= c + w; i++) {
    if (i < 1 || i >= mag.length) continue;
    if (Math.abs(i - c) <= 2) continue;
    v.push(mag[i]);
  }
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[v.length >> 1];
}

/* Refine the grid: the label rpm is nominal and the recording drifts from it, so scan a small
 * range around rpm/120 and keep the fundamental whose harmonic comb collects the most energy.
 * Getting this wrong by even 1% smears every harmonic read at k=100+. */
function refineF0(mag, binHz, f0Guess) {
  let best = f0Guess, bestScore = -1;
  for (let m = -60; m <= 60; m++) {
    const f0 = f0Guess * (1 + m * 0.0008);           // ±4.8% in 0.08% steps
    let score = 0, used = 0;
    for (let k = 1; k <= 80; k++) {
      const hz = f0 * k;
      if (hz > MAX_HZ) break;
      const a = ampAt(mag, binHz, hz), fl = floorAt(mag, binHz, hz, f0 * 3);
      if (fl > 0) { score += Math.log((a + 1e-9) / (fl + 1e-9)); used++; }
    }
    if (used > 8) { score /= used; if (score > bestScore) { bestScore = score; best = f0; } }
  }
  return { f0: best, snr: bestScore };
}

const files = fs.readdirSync(AUDIO_DIR)
  .filter(f => /^eng_(on|off)_\d+\.wav$/.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
if (!files.length) { console.error("no eng_*.wav found in " + AUDIO_DIR); process.exit(1); }

const profiles = [];
console.log("analysing " + files.length + " recordings from " + AUDIO_DIR + "\n");
console.log("file                 rpm    f0(grid)  f0(found)  drift   harm  tonal%  rms");
console.log("-".repeat(82));

for (const f of files) {
  const { x, sr, dur } = readWav(path.join(AUDIO_DIR, f));
  const rpm = parseInt(f.match(/\d+/)[0]);
  const load = /_on_/.test(f) ? "on" : "off";
  const { mag, binHz } = avgSpectrum(x, sr);

  const grid = rpm / 120;                      // four-stroke cycle fundamental
  const { f0, snr } = refineF0(mag, binHz, grid);

  // harmonic amplitudes on the refined grid, and the broadband residual between them
  const harm = [];
  let tonal = 0, noise = 0;
  for (let k = 1; k <= MAX_HARM; k++) {
    const hz = f0 * k;
    if (hz > Math.min(MAX_HZ, sr / 2 - 100)) break;
    const a = ampAt(mag, binHz, hz);
    const fl = floorAt(mag, binHz, hz, f0 * 3);
    const clean = Math.max(0, a - fl);          // subtract the local noise floor: keep the TONE only
    harm.push(clean);
    tonal += clean * clean;
    noise += fl * fl;
  }
  const peak = Math.max(...harm, 1e-12);
  const norm = harm.map(v => +(v / peak).toFixed(4));

  // trailing zeros carry no information and triple the file size
  let last = norm.length - 1;
  while (last > 0 && norm[last] < 0.002) last--;
  const kept = norm.slice(0, last + 1);

  // residual noise as a coarse spectral tilt (8 log bands, relative to the tonal peak) — the
  // induction/turbulence bed the harmonics sit in; without it a resynth sounds like an organ
  const bands = [];
  const edges = [60, 150, 350, 800, 1600, 3000, 5500, 8000, 11000];
  for (let b = 0; b + 1 < edges.length; b++) {
    let s = 0, n = 0;
    for (let i = Math.round(edges[b] / binHz); i < Math.round(edges[b + 1] / binHz) && i < mag.length; i++) {
      const hz = i * binHz, near = Math.abs(hz / f0 - Math.round(hz / f0));
      if (near < 0.25) continue;                // skip harmonic bins: this is the BETWEEN
      s += mag[i] * mag[i]; n++;
    }
    bands.push(n ? +(Math.sqrt(s / n) / peak).toFixed(4) : 0);
  }

  let rms = 0;
  for (let i = 0; i < x.length; i++) rms += x[i] * x[i];
  rms = Math.sqrt(rms / x.length);

  const tonalPct = 100 * tonal / (tonal + noise + 1e-12);
  profiles.push({ file: f, rpm, load, f0: +f0.toFixed(3), order: +(f0 / (rpm / 60)).toFixed(3), harm: kept, noise: bands, rms: +rms.toFixed(4), snr: +snr.toFixed(2) });

  console.log(
    f.padEnd(21) + String(rpm).padEnd(7) +
    grid.toFixed(2).padEnd(10) + f0.toFixed(2).padEnd(11) +
    ((f0 / grid - 1) * 100).toFixed(2).padStart(5) + "%  " +
    String(kept.length).padEnd(6) + tonalPct.toFixed(1).padEnd(8) + rms.toFixed(4)
  );
}

const out = `/* engineprofile.js — GENERATED by make_engineprofile.js. Do not hand-edit.
 *
 * The Mach 6's own harmonic signature, measured out of ui/audio/eng_*.wav. Each profile is one
 * recording: 'harm' is amplitude per harmonic of rpm/120 Hz (the four-stroke cycle fundamental),
 * normalised so the loudest harmonic is 1.0; 'noise' is the broadband residual BETWEEN harmonics
 * in 8 bands (60/150/350/800/1600/3000/5500/8000/11000 Hz edges), same scale.
 *
 * Regenerate after changing the recordings:  node make_engineprofile.js
 */
window.BBEngineProfile = ${JSON.stringify({
  generated: "make_engineprofile.js",
  // WHICH CAR this was measured from. Harmonic mode is only honest for this one: playing the Mach
  // 6's harmonic signature over a Corsair replay would be a different engine wearing its name.
  car: process.env.BB_PROFILE_CAR || "ohyeah2389_t180_mach6",
  grid: "rpm/120",
  noiseEdges: [60, 150, 350, 800, 1600, 3000, 5500, 8000, 11000],
  profiles,
}, null, 1)};
`;
fs.writeFileSync(OUT, out);
console.log("\nwrote " + OUT + "  (" + (fs.statSync(OUT).size / 1024).toFixed(1) + " KB)");
