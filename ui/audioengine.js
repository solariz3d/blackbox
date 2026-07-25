/* audioengine.js — BLACKBOX telemetry-driven soundscape (Web Audio, zero deps).
 *
 * The replay carries no audio; AC synthesizes engine sound from rpm/throttle. We do the same,
 * from the loader's real telemetry — so the sound IS the run, not a canned loop.
 *
 * Philosophy: play the car's OWN extracted samples as cleanly and crisply as possible — NO
 * synthesis or distortion faking an engine. Fidelity comes from (a) crossfading the real
 * rpm-band loops with playbackRate pitch-tracking, (b) blending the real on-load and off-load
 * recordings by throttle, and (c) transparent, full-range EQ (presence + air) — never a
 * lowpass dulling the top or a waveshaper muddying it. Backfire one-shots and a tasteful
 * reverb/echo return sit around the crisp, spatialized dry engine.
 *
 * Autoplay-safe; per-frame control via setTargetAtTime (never .value=, which zippers).
 */
window.BBAudio = (function () {
  const BASE = "audio/";
  const ON = [1642, 3754, 5591, 5972, 6365, 7065, 7348, 7644, 8700].map(r => ({ rpm: r, file: `eng_on_${r}.wav` }));
  const OFF = [4804, 5410, 6944].map(r => ({ rpm: r, file: `eng_off_${r}.wav` }));
  const MASTER_ON = 0.78;
  const RATE_LO = 0.8, RATE_HI = 1.26;   // per-band pitch clamp (~±3–4 semitones — keeps it clean)
  // Off-load bands stop at 6944 rpm, so at the top of the range the overrun layer hits the clamp
  // and sits pitch-locked BELOW the on-load layer — a lift reads as mush instead of a clean
  // "blwahhh". It gets its own, wider ceiling so it can still track up there.
  const RATE_HI_OFF = 1.5;
  // Rev expander. A driver who keeps the engine pinned hands the resynth almost no rpm movement
  // (measured on the T-180 run: p5–p95 = 7,088–9,105 rpm, 88% of the time nearest the top TWO of
  // nine bands, 27% above the highest recording — barely 4 semitones across a whole session, and
  // a fraction of that corner to corner). The samples are honest and the drone is real; what's
  // missing is contrast. So expand rpm about a pivot before it drives band selection and pitch:
  //     rpm' = pivot · (rpm/pivot)^expand
  // The pivot is the run's own median driving rpm, set per replay, so the engine's resting voice
  // stays where it was and only the DEVIATION is magnified — the same trick as a photo's contrast
  // curve, not a pitch shift. It also walks the effective rpm across more bands, so the timbre
  // changes and not just the pitch, which is most of what "revvy" actually is.
  // 1.0 = untouched/honest. Live on the header's "rev" slider; judged by ear, not by number.
  const REV_EXPAND_DEFAULT = 1.75;
  const REV_PIVOT_FALLBACK = 7000;   // used until a replay's telemetry gives its own median
  // harmonic engine (see buildHarmonic). Levels are the one thing that cannot be measured off the
  // recordings — they set how this mode sits against the sample bank, and that is an ear call.
  const HARM_LEVEL = 0.30;           // wavetable voices
  const HARM_NOISE = 0.55;           // scale on the measured between-harmonic residual
  const ENGINE_MODE_DEFAULT = "harmonic";   // "harmonic" | "sample" — A/B on the header button
  const CYL = 8;                          // firing-frequency cylinder count (tunable)
  const DIST_REF = 48, DIST_ROLLOFF = 1.4;   // distance falloff: LOUD car carries FAR (big 48m bubble) but KEEPS getting quieter with no plateau — ~38% at 96m, ~14% at 200m, ~4% at 500m, ~1.4% at 1000m (fly across the map and it genuinely fades out)

  let ctx, master, panner, engineMix;
  let onLayers = null, offLayers = null;  // [{rpm, src, g, width}]
  let bfBufs = [], eventGain = null;
  let firingOsc, subOsc, firingGain, subGain, lfo, burbleDepth, gritGain;   // synth body/burble + top-end grit
  let menaceOsc, menaceOsc2, menaceGain, menaceBP;   // "Ghost Rider" supernatural low guttural growl
  let turbineSrc, turbineGain;   // the car's REAL afterburner/jet sample — spools with boost, out the back
  let reverbSend, echoSend;   // ambient sends, swelled with distance to fake environment reflections
  let enabled = false, loading = false, ready = false;
  let lastRpm = 0, bfLast = 0, doppler = 1;   // doppler = flyby pitch multiplier (approach>1, recede<1)
  let revExpand = REV_EXPAND_DEFAULT, revPivot = REV_PIVOT_FALLBACK, lastRpmA = 0;
  let engineMode = ENGINE_MODE_DEFAULT;
  let harmProf = null, harmWave = null, harmVoice = null, harmBus = null, harmNoise = null, harmNoiseSrc = null;
  let carBankId = null;   // which car's bank is currently loaded (null = the built-in wavs)
  let tone = null, raw = false;   // our own EQ/colour chain, and whether it's bypassed
  let userVol = 1;   // user volume 0..1 (scales MASTER_ON) — driven by the header volume slider

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const biq = (type, freq, Q, g) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = freq; if (Q != null) b.Q.value = Q; if (g != null) b.gain.value = g; return b; };
  const gain = v => { const g = ctx.createGain(); g.gain.value = v; return g; };

  async function loadBuf(file) {
    const r = await fetch(BASE + file);
    if (!r.ok) throw new Error(r.status + " " + file);
    return ctx.decodeAudioData(await r.arrayBuffer());
  }
  // gentle tanh soft-clip — used ONLY as a transparent master ceiling, not for tone
  function tanhCurve(drive, n) {
    n = n || 2048; const c = new Float32Array(n), k = Math.tanh(drive);
    for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; c[i] = Math.tanh(drive * x) / k; }
    return c;
  }
  // A real-space impulse: pre-delay, decorrelated early reflections, and a smoothed (one-pole
  // low-passed) exponentially-decaying diffuse tail — NOT raw white noise, which sounds metallic/cheap.
  function reverbIR(sec, decay) {
    const rate = ctx.sampleRate, len = Math.max(1, sec * rate | 0), ir = ctx.createBuffer(2, len, rate);
    const pre = (0.008 * rate) | 0;   // 8 ms pre-delay
    const early = [[0.011, 0.5], [0.017, 0.42], [0.023, 0.35], [0.031, 0.3], [0.043, 0.24], [0.057, 0.2]];
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch); let lp = 0;
      for (let i = pre; i < len; i++) {
        const tt = (i - pre) / (len - pre);
        const n = (Math.random() * 2 - 1) * Math.pow(1 - tt, decay);
        lp += (n - lp) * 0.4;         // one-pole low-pass → smooth, dark, non-fizzy tail
        d[i] = lp;
      }
      for (const [t, g] of early) { const idx = pre + (t * rate | 0); if (idx < len) d[idx] += (ch ? -1 : 1) * g; }  // decorrelated L/R
    }
    return ir;
  }
  // stereo widener (mid-side): sides scaled by width, mid untouched (mono-safe). widens FX only.
  function widener(input, width) {
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    input.connect(split);
    const invA = gain(-1), invB = gain(-1);
    const mid = gain(1), side = gain(1), sideW = gain(width);
    const midL = gain(0.5), midR = gain(0.5), sideL = gain(0.5), sideR = gain(0.5);
    split.connect(midL, 0); split.connect(midR, 1); midL.connect(mid); midR.connect(mid);
    split.connect(sideL, 0); split.connect(invA, 1); invA.connect(sideR);
    sideL.connect(side); sideR.connect(side); side.connect(sideW);
    mid.connect(merge, 0, 0); sideW.connect(merge, 0, 0);
    mid.connect(merge, 0, 1); sideW.connect(invB); invB.connect(merge, 0, 1);
    return merge;
  }

  async function startLayer(band, bus) {
    const buf = await loadBuf(band.file);
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const g = gain(0); src.connect(g); g.connect(bus); src.start();
    return { rpm: band.rpm, src, g, width: 1000 };
  }
  function computeWidths(layers) {
    const n = layers.length;
    for (let k = 0; k < n; k++) {
      const prev = k > 0 ? layers[k].rpm - layers[k - 1].rpm : (n > 1 ? layers[1].rpm - layers[0].rpm : 1000);
      const next = k < n - 1 ? layers[k + 1].rpm - layers[k].rpm : (n > 1 ? layers[n - 1].rpm - layers[n - 2].rpm : 1000);
      layers[k].width = 1.8 * Math.min(prev, next);
    }
  }

  /* ---------------- the car's own bank ---------------- */
  /* Replace the built-in wav ladder with the layers out of the replay car's FMOD bank.
   *
   * The shipped wavs are one car's engine (the Mach 6) hand-pulled from its bank. There are 16 T-180
   * variants installed here alone and they do not sound alike, so those wavs are the wrong engine
   * for almost every replay. A car's bank also carries what the hand-pulled subset never did: the
   * full rpm ladder including the idle stages, and the turbine/afterburner spool that is half of
   * this car's voice.
   *
   * Everything is best-effort — a car whose bank is missing, Vorbis-encoded, or oddly named keeps
   * the built-in engine rather than going silent.
   */
  function bufFromSample(bank, s) {
    const pcm = FSB5.decode(bank, s);
    const buf = ctx.createBuffer(pcm.chans.length, pcm.frames, pcm.freq);
    for (let c = 0; c < pcm.chans.length; c++) buf.copyToChannel(pcm.chans[c], c);
    return buf;
  }
  function stopLayers(layers) {
    if (!layers) return;
    for (const l of layers) { try { l.src.stop(); } catch (e) { /* already stopped */ } l.g.disconnect(); }
  }
  function startBuf(buf, rpm, bus) {
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const g = gain(0); src.connect(g); g.connect(bus); src.start();
    return { rpm, src, g, width: 1000 };
  }

  async function setCarBank(arrayBuffer, carId) {
    if (!window.FSB5) return null;
    await ensureGraph();                        // needs a context to build buffers into
    // ensureGraph() returns immediately if a build is already in flight, and that build APPENDS its
    // wav layers to onLayers when it finishes — which would land on top of the bank layers we are
    // about to install. Wait it out.
    while (loading) await new Promise(r => setTimeout(r, 30));
    if (!ctx) return null;
    const bank = FSB5.parse(arrayBuffer);
    if (bank.codec !== 2) throw new Error("bank codec " + bank.codecName + " (only PCM16 is decoded)");
    const cls = FSB5.classify(bank);
    if (cls.on.length < 3) throw new Error("only " + cls.on.length + " engine layers found — keeping the built-in set");

    stopLayers(onLayers); stopLayers(offLayers);
    onLayers = []; offLayers = [];
    for (const s of cls.on) { try { onLayers.push(startBuf(bufFromSample(bank, s), s.rpm, engineMix)); } catch (e) { console.warn("[BBAudio] layer", s.name, e); } }
    for (const s of cls.off) { try { offLayers.push(startBuf(bufFromSample(bank, s), s.rpm, engineMix)); } catch (e) { console.warn("[BBAudio] off layer", s.name, e); } }
    onLayers.sort((a, b) => a.rpm - b.rpm); offLayers.sort((a, b) => a.rpm - b.rpm);
    computeWidths(onLayers); computeWidths(offLayers);

    // the turbine/afterburner spool — the longest such sample is the sustained loop, the short ones
    // are transients we do not have a trigger for yet
    if (cls.turbine.length && turbineSrc) {
      const best = cls.turbine.slice().sort((a, b) => b.dur - a.dur)[0];
      try {
        const buf = bufFromSample(bank, best);
        try { turbineSrc.stop(); } catch (e) { /* already stopped */ }
        turbineSrc = ctx.createBufferSource(); turbineSrc.buffer = buf; turbineSrc.loop = true;
        turbineSrc.connect(turbineGain); turbineSrc.start();
      } catch (e) { console.warn("[BBAudio] turbine layer", best.name, e); }
    }
    // backfires: prefer the exterior one-shots, and keep them short — a 20 s "backfire" in this bank
    // is a loop, not a pop, and firing one as an event would drown the engine
    const pops = cls.backfire.filter(s => s.dur > 0.05 && s.dur < 2.5).sort((a, b) => a.dur - b.dur).slice(0, 8);
    if (pops.length) {
      const bufs = [];
      for (const s of pops) { try { bufs.push(bufFromSample(bank, s)); } catch (e) { /* skip */ } }
      if (bufs.length) bfBufs = bufs;
    }
    carBankId = carId || null;
    carBank = bank;
    // AC's own authored event, if we have a decoded map for THIS car. Same discipline as the
    // harmonic profile: a map decoded from another car's bank would be the wrong recipe.
    let acInfo = null;
    const M = window.BBEventMap;
    if (M && (!M.car || !carBankId || M.car === carBankId)) {
      try { acInfo = buildEventEngine(bank, M); } catch (e) { console.warn("[BBAudio] event engine:", e); }
      if (acInfo) engineMode = "ac";
    } else if (M && M.car !== carBankId) {
      console.warn(`[BBAudio] event map is ${M.car}; this replay is ${carBankId} — regenerate with: node make_eventmap.js "<${carBankId}.bank>" out.json ui/eventmap.js ${carBankId}`);
    }
    // The harmonic profile was measured from ONE car. Running it over a different car's replay would
    // be that car's name on the Mach 6's engine — so hand the run back to the sample bank, which is
    // now this car's own layers and therefore right by construction.
    const P = window.BBEngineProfile;
    let modeChanged = null;
    if (engineMode === "harmonic" && P && P.car && carBankId && carBankId !== P.car) {
      engineMode = "sample";
      modeChanged = "sample";
      console.warn(`[BBAudio] harmonic profile is ${P.car}; this replay is ${carBankId} — using its own sampled layers instead. Regenerate with: BB_PROFILE_CAR=${carBankId} node make_engineprofile.js`);
    }
    return { on: onLayers.length, off: offLayers.length, turbine: cls.turbine.length, backfire: bfBufs.length,
             car: carBankId, modeChanged: acInfo ? "ac" : modeChanged, ac: acInfo };
  }

  /* ---------------- AC event engine: play the recipe as authored ---------------- */
  /* The other two modes are our own designs playing AC's samples. This one plays AC's own EVENT:
   * every looping instrument the car's FMOD bank places on the `rpms` sheet, each with the trigger
   * box, gain curves, static dB and autopitch root the sound designer authored.
   *
   * What the decode revealed, and why nothing we tuned by hand was going to get there:
   *  - `engine_ext`/`engine_int` are EMPTY STUBS in this bank. The engine is on `engine_custom`
   *    (CSP's extended-sound path), with `engine_ext_old` holding the legacy exterior layers.
   *  - 6–15 instruments are audible at once (mean 12). We were crossfading two.
   *  - Sustained beds — PinkNoise, als_front, sin5, IdleEngine_noise (+7 dB), combustion,
   *    afterburner near (+10 dB) — play across the whole range under the ladder. We played none.
   *  - The autopitch root is authored per instrument and is NOT the number in the sample's name
   *    (5972a_inside → 5900, 7348c → 7050, 6365d → 12800), so a name-derived ladder is detuned.
   *  - Gain curves come in fade-in/fade-out pairs that multiply into a trapezoid window.
   *  - AC does not extrapolate past a layer's trigger box: outside it, the layer is silent.
   * Decoded by make_eventmap.js into ui/eventmap.js; regenerate per car.
   */
  const AC_LEVEL = 0.22;          // headroom for a dozen simultaneous voices — an ear call, not authored
  const AC_EVENT_ORDER = ["engine_custom", "engine_ext_old", "engine_int_old"];
  let acVoices = null, acBus = null, acEvent = null, carBank = null;

  // piecewise-linear through the authored points, held flat outside them. The third field per point
  // ('shape') encodes curvature we have not decoded — linear is the honest approximation, and it is
  // exact wherever shape is 0, which is most points.
  function evalCurve(pts, x) {
    const n = pts.length;
    if (!n) return 1;
    if (x <= pts[0][0]) return pts[0][1];
    if (x >= pts[n - 1][0]) return pts[n - 1][1];
    for (let i = 1; i < n; i++) {
      if (x <= pts[i][0]) {
        const x0 = pts[i - 1][0], y0 = pts[i - 1][1], x1 = pts[i][0], y1 = pts[i][1];
        return y0 + (y1 - y0) * ((x - x0) / Math.max(1e-9, x1 - x0));
      }
    }
    return pts[n - 1][1];
  }

  function buildEventEngine(bank, map) {
    if (!map || !map.events) return null;
    const name = AC_EVENT_ORDER.find(n => map.events[n] && map.events[n].layers.length);
    if (!name) return null;
    if (acVoices) { for (const v of acVoices) { try { v.src.stop(); } catch (e) { /* stopped */ } v.g.disconnect(); } }
    acVoices = [];
    if (!acBus) { acBus = gain(0); acBus.connect(engineMix); }
    for (const L of map.events[name].layers) {
      const s = bank.samples[L.sample];
      if (!s) continue;
      try {
        const src = ctx.createBufferSource();
        src.buffer = bufFromSample(bank, s);
        src.loop = true;
        const g = gain(0);
        src.connect(g); g.connect(acBus); src.start();
        acVoices.push({ L, src, g, base: Math.pow(10, (L.db || 0) / 20) });
      } catch (e) { console.warn("[BBAudio] event layer", L.name, e); }
    }
    acEvent = name;
    return { event: name, voices: acVoices.length };
  }

  function driveEventEngine(rpm, throttle, now, TC) {
    if (!acVoices) return;
    for (const v of acVoices) {
      const L = v.L;
      const x = L.param === "throttle" ? throttle : rpm;
      let g = 0;
      if (x >= L.from && x <= L.to) {          // outside the trigger box AC plays nothing
        g = v.base;
        for (const c of L.curves) g *= evalCurve(c, x);
      }
      v.g.gain.setTargetAtTime(g * AC_LEVEL, now, TC);
      // autopitch off the authored root, unclamped — the ±3-semitone clamp was ours, not AC's.
      // root 0/1 marks an unpitched bed (PinkNoise, combustion, afterburner): leave it alone.
      const rate = L.root > 1 ? clamp(rpm / L.root, 0.15, 4) : 1;
      v.src.playbackRate.setTargetAtTime(rate * doppler, now, TC);
    }
  }

  /* ---------------- harmonic engine ---------------- */
  // One wavetable per measured recording; two oscillators per load bank (the neighbouring profiles)
  // crossfaded by rpm, both running at the true cycle frequency. Phases are pseudo-random but FIXED:
  // all-sine phases stack into an impulse train that reads as a buzzy sawtooth, and re-randomising
  // per frame would shimmer. Deterministic seed = the same engine every launch.
  function buildWave(prof) {
    const n = Math.min(prof.harm.length, 511);
    const re = new Float32Array(n + 1), im = new Float32Array(n + 1);
    let seed = 1337 + prof.rpm;
    for (let k = 1; k <= n; k++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const ph = (seed / 0x7fffffff) * Math.PI * 2;
      const a = prof.harm[k - 1] || 0;
      re[k] = a * Math.cos(ph); im[k] = a * Math.sin(ph);
    }
    return ctx.createPeriodicWave(re, im, { disableNormalization: false });
  }

  function buildHarmonic(dest) {
    const P = window.BBEngineProfile;
    harmProf = { on: [], off: [] };
    for (const p of P.profiles) (p.load === "on" ? harmProf.on : harmProf.off).push(p);
    harmProf.on.sort((a, b) => a.rpm - b.rpm);
    harmProf.off.sort((a, b) => a.rpm - b.rpm);
    if (!harmProf.on.length) { harmProf = null; return; }
    harmWave = new Map();
    for (const p of P.profiles) harmWave.set(p.file, buildWave(p));

    harmBus = gain(0);           // whole harmonic engine in/out (mode switch + level)
    harmBus.connect(dest);
    const mk = () => {
      const o = ctx.createOscillator();
      o.setPeriodicWave(harmWave.get(harmProf.on[0].file));
      const g = gain(0); o.connect(g); g.connect(harmBus); o.start();
      return { osc: o, g, cur: null };
    };
    harmVoice = { onA: mk(), onB: mk(), offA: mk(), offB: mk() };
    // the B voice of each pair carries a few cents of detune — two identical oscillators at one
    // frequency sum to a single rigid tone, and a real engine never holds one exactly
    harmVoice.onB.osc.detune.value = 7;
    harmVoice.offB.osc.detune.value = -7;

    // broadband bed between the harmonics (induction/turbulence). Without it a resynth is an organ:
    // the measured noise floor is 1–47% of these recordings' energy and carries the "air".
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    harmNoiseSrc = ctx.createBufferSource(); harmNoiseSrc.buffer = nb; harmNoiseSrc.loop = true;
    harmNoise = [];
    for (const [hz, q] of [[260, 0.8], [900, 0.9], [2600, 0.9], [6500, 0.8]]) {
      const bp = biq("bandpass", hz, q), g = gain(0);
      harmNoiseSrc.connect(bp); bp.connect(g); g.connect(harmBus);
      harmNoise.push({ bp, g, hz });
    }
    harmNoiseSrc.start();
  }

  // nearest two profiles around an rpm + the blend between them
  function pickPair(list, rpm) {
    if (rpm <= list[0].rpm) return { a: list[0], b: list[0], t: 0 };
    const last = list.length - 1;
    if (rpm >= list[last].rpm) return { a: list[last], b: list[last], t: 0 };
    let i = 0; while (i < last && list[i + 1].rpm < rpm) i++;
    const a = list[i], b = list[i + 1];
    return { a, b, t: (rpm - a.rpm) / Math.max(1, b.rpm - a.rpm) };
  }
  function setVoice(v, prof, f, gainV, now, TC) {
    if (v.cur !== prof.file) { v.osc.setPeriodicWave(harmWave.get(prof.file)); v.cur = prof.file; }
    v.osc.frequency.setTargetAtTime(f, now, TC);
    v.g.gain.setTargetAtTime(gainV, now, TC);
  }
  // rpm → the engine's real cycle frequency. THE point of this mode: no clamp, no band edges.
  function driveHarmonic(rpm, t, now, TC) {
    if (!harmProf) return;
    const f = clamp(rpm / 120, 3, 500) * doppler;
    const on = pickPair(harmProf.on, rpm), off = harmProf.off.length ? pickPair(harmProf.off, rpm) : null;
    const gOn = Math.sin(t * Math.PI / 2) * HARM_LEVEL, gOff = Math.cos(t * Math.PI / 2) * HARM_LEVEL * clamp((rpm - 3000) / 1500, 0, 1);
    setVoice(harmVoice.onA, on.a, f, gOn * Math.sqrt(1 - on.t), now, TC);
    setVoice(harmVoice.onB, on.b, f, gOn * Math.sqrt(on.t), now, TC);
    if (off) {
      setVoice(harmVoice.offA, off.a, f, gOff * Math.sqrt(1 - off.t), now, TC);
      setVoice(harmVoice.offB, off.b, f, gOff * Math.sqrt(off.t), now, TC);
    }
    // noise bed: blend the two profiles' measured residual, then the load blend, and track the
    // upper bands with rpm so the "air" rises with the engine instead of sitting still
    const E = window.BBEngineProfile.noiseEdges;
    const bandOf = (prof, k) => {                 // 8 measured bands → the 4 filters
      const i = k * 2;
      return ((prof.noise[i] || 0) + (prof.noise[i + 1] || 0)) * 0.5;
    };
    for (let k = 0; k < harmNoise.length; k++) {
      const nOn = bandOf(on.a, k) * (1 - on.t) + bandOf(on.b, k) * on.t;
      const nOff = off ? bandOf(off.a, k) * (1 - off.t) + bandOf(off.b, k) * off.t : nOn;
      const lvl = (nOn * Math.sin(t * Math.PI / 2) + nOff * Math.cos(t * Math.PI / 2)) * HARM_NOISE;
      harmNoise[k].g.gain.setTargetAtTime(clamp(lvl, 0, 0.5), now, 0.05);
      if (k >= 2) harmNoise[k].bp.frequency.setTargetAtTime(harmNoise[k].hz * clamp(rpm / 7000, 0.6, 1.5), now, 0.08);
    }
    void E;
  }

  async function ensureGraph() {
    if (ctx || loading) return;
    loading = true;
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    // ---- master: transparent level control only (limiter → soft ceiling → enable gain) ----
    master = gain(0.0); master.connect(ctx.destination);
    const softClip = ctx.createWaveShaper(); softClip.curve = tanhCurve(1.4); softClip.oversample = "4x"; softClip.connect(master);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.06;
    limiter.connect(softClip);
    const masterBus = gain(1.0); masterBus.connect(limiter);

    // ---- spatialized dry engine → masterBus ----
    panner = ctx.createPanner();
    // EXPONENTIAL falloff → a LOUD car that TRAVELS FAR. Big full bubble (DIST_REF=48) + gentle rolloff
    // (1.25) so it carries out to long range and only gradually diminishes (~17% at 200m, ~5% at 500m) —
    // no far plateau ("loud everywhere") but no near-silent cliff either. A regular car would fall off
    // sooner; the T-180 keeps carrying because it's loud and moving fast.
    panner.panningModel = "HRTF"; panner.distanceModel = "exponential"; panner.refDistance = DIST_REF; panner.rolloffFactor = DIST_ROLLOFF;
    // directional cone: the exhaust projects rearward — louder behind the car, quieter from the front
    panner.coneInnerAngle = 100; panner.coneOuterAngle = 260; panner.coneOuterGain = 0.45;
    // more DIRECTIONAL STEREO: run the HRTF output through a mid-side widener so the inter-aural
    // difference (the L↔R positional cue) is boosted — left/right car positions swing harder across
    // the field. Mono-safe (mid untouched); kept moderate (1.35) so the center doesn't go phasey/hollow.
    widener(panner, 1.35).connect(masterBus);

    // ---- clean, crisp, FULL-RANGE engine EQ (no lowpass, no distortion) → panner ----
    const engineTrim = gain(0.72);
    const engineSum = gain(1.0); engineSum.connect(engineTrim); engineTrim.connect(panner);
    const engineHP = biq("highpass", 40, 0.7);         // just clears subsonic rumble
    const topAir = biq("highshelf", 9000, null, 2);    // fine high-frequency detail (eased — hyped EQ reads "produced")
    const air = biq("highshelf", 5000, null, 5);       // crispness / top-end clarity
    const presence = biq("peaking", 3200, 1.0, 3);     // engine detail / bite
    const body = biq("peaking", 380, 0.8, 3);          // low-mid body / fullness (V8 weight)
    // Kept as references so RAW mode can flatten them. None of this EQ exists in Assetto Corsa — it
    // was tuned to make nine thin hand-pulled samples sound big, and now that the car's whole bank
    // loads it is colouring us AWAY from the game. Being able to switch it off is the only way to
    // hear what the car's own layers actually sound like.
    tone = { body, presence, air, topAir, gains: [3, 3, 5, 2] };
    engineMix = gain(1.0);
    engineMix.connect(body); body.connect(presence); presence.connect(air); air.connect(topAir); topAir.connect(engineHP); engineHP.connect(engineSum);
    // parallel TOP-END grit — distort ONLY the upper mids (hp 1.5k) so it adds rasp/EDGE, not mud;
    // blended under the clean tone and pushed harder on-throttle (aggression on power).
    gritGain = gain(0.0);
    const gritLP = biq("lowpass", 7000, 0.7); gritLP.connect(gritGain); gritGain.connect(engineSum);
    const gritWS = ctx.createWaveShaper(); gritWS.curve = tanhCurve(5); gritWS.oversample = "4x"; gritWS.connect(gritLP);
    const gritHP = biq("highpass", 1500, 0.7); gritHP.connect(gritWS);
    engineMix.connect(gritHP);
    // synth low-end BODY — the samples can't carry the sub, so add the firing fundamental
    // (rpm×cyl/120) + its octave for chest, amplitude-modulated for the throaty burble. Clean
    // (no distortion), routed PAST the sample EQ straight into the engine sum so it stays as body.
    const lowBus = gain(1.0), burbleAM = gain(1.0);
    lowBus.connect(burbleAM); burbleAM.connect(engineSum);
    lfo = ctx.createOscillator(); lfo.type = "triangle"; lfo.frequency.value = 8;
    burbleDepth = gain(0.05); lfo.connect(burbleDepth); burbleDepth.connect(burbleAM.gain); lfo.start();  // subtle — a regular tremolo reads synthetic
    firingOsc = ctx.createOscillator(); firingOsc.type = "sawtooth";
    const firingLP = biq("lowpass", 340, 0.7);   // let the exhaust note carry a bit higher before it's cut
    firingGain = gain(0.0); firingOsc.connect(firingLP); firingLP.connect(firingGain); firingGain.connect(lowBus); firingOsc.start();
    subOsc = ctx.createOscillator(); subOsc.type = "sine";
    subGain = gain(0.0); subOsc.connect(subGain); subGain.connect(lowBus); subOsc.start();
    // "MENACE" layer — a sustained guttural low growl (Ghost Rider). Two saws detuned so they BEAT
    // together (rough, animalistic — the roughness is the detune, NOT a rhythmic warble, which read as
    // a flat tire) → heavy distortion → dark resonant lowpass. Tracks rpm, routed dark into the sum.
    menaceOsc = ctx.createOscillator(); menaceOsc.type = "sawtooth";
    menaceOsc2 = ctx.createOscillator(); menaceOsc2.type = "sawtooth"; menaceOsc2.detune.value = 22;   // slow beat = growl
    const menaceWS = ctx.createWaveShaper(); menaceWS.curve = tanhCurve(7); menaceWS.oversample = "2x";
    menaceBP = biq("lowpass", 240, 3.5);   // dark body + a touch of resonance (var reused)
    menaceGain = gain(0);
    menaceOsc.connect(menaceWS); menaceOsc2.connect(menaceWS); menaceWS.connect(menaceBP); menaceBP.connect(menaceGain); menaceGain.connect(engineSum);
    menaceOsc.start(); menaceOsc2.start();
    // JET TURBINE layer — the car's REAL afterburner sample, looped, spooling up with turbo boost and
    // pitching with rpm. Routed out the back (→ engineSum → rear panner) as the jet flow whoosh.
    try {
      const tbuf = await loadBuf("turbine.wav");
      turbineSrc = ctx.createBufferSource(); turbineSrc.buffer = tbuf; turbineSrc.loop = true;
      turbineGain = gain(0); turbineSrc.connect(turbineGain); turbineGain.connect(engineSum); turbineSrc.start();
    } catch (e) { console.warn("[BBAudio] turbine", e); }

    // ---- HARMONIC ENGINE: the car's measured signature, replayed at the exact firing frequency ----
    // Why a second engine at all: the sample bank's ceiling is structural. A loop at a steady rate is
    // a drone, pitch-shift drags the formants with it (the ±3-semitone clamp), and rpm resolution is
    // however many recordings exist — which is why a pinned Mach 6, living 88% of a run nearest the
    // top two of nine bands, sounds flat however good the samples are.
    // The recordings themselves pointed the way out: they are 73–99% TONAL and every one is a harmonic
    // stack on the SAME grid, integer multiples of rpm/120 Hz (the four-stroke cycle fundamental —
    // verified, 9 of 12 within ±0.5%). So the sound is a harmonic series whose amplitudes move with
    // rpm and load, and that is directly resynthesizable: two wavetable oscillators carrying the
    // measured profiles of the neighbouring recordings, morphed by rpm, running at exactly rpm/120.
    // Pitch then tracks revs continuously — no clamp, no bands to run out of, no loop to drone on.
    // This is NOT the invented V8 muted on 2026-07-23. Nothing here is invented: every amplitude is
    // measured from the car's own audio by make_engineprofile.js. Same EQ, same panner, same cone.
    if (window.BBEngineProfile) buildHarmonic(engineMix);

    // ---- the real sample sets (on-load + off-load), rpm crossfaded, throttle blended ----
    onLayers = []; offLayers = [];
    for (const b of ON) { try { onLayers.push(await startLayer(b, engineMix)); } catch (e) { console.warn("[BBAudio] on", b.file, e); } }
    for (const b of OFF) { try { offLayers.push(await startLayer(b, engineMix)); } catch (e) { console.warn("[BBAudio] off", b.file, e); } }
    onLayers.sort((a, b) => a.rpm - b.rpm); offLayers.sort((a, b) => a.rpm - b.rpm);
    computeWidths(onLayers); computeWidths(offLayers);

    // ---- backfire one-shots → own EQ → panner ----
    const eventsBite = biq("peaking", 4200, 1.4, 3), eventsHP = biq("highpass", 120, 0.7);
    eventGain = gain(0.4); eventGain.connect(eventsHP); eventsHP.connect(eventsBite); eventsBite.connect(panner);
    for (let bn = 1; bn <= 5; bn++) { try { bfBufs.push(await loadBuf(`backfire${bn}.wav`)); } catch (e) { console.warn("[BBAudio] bf", bn, e); } }

    // ---- reverb + feedback-delay echo → fx EQ → widener → masterBus (ambient space, kept subtle
    //      so it doesn't wash the crisp dry engine) ----
    const fxSum = gain(1.0);
    const conv = ctx.createConvolver(); conv.buffer = reverbIR(1.1, 2.2);
    reverbSend = gain(0.10); reverbSend.connect(conv); conv.connect(fxSum);
    echoSend = gain(0.15);
    const delay = ctx.createDelay(1.0); delay.delayTime.value = 0.21;
    const fb = gain(0.32), damp = biq("lowpass", 3000, 0.7);
    echoSend.connect(delay); delay.connect(damp); damp.connect(fb); fb.connect(delay); damp.connect(fxSum);
    engineMix.connect(reverbSend); engineMix.connect(echoSend);
    const fxLP = biq("lowpass", 10000, 0.7), fxHP = biq("highpass", 200, 0.7);
    fxSum.connect(fxHP); fxHP.connect(fxLP);
    widener(fxLP, 1.3).connect(masterBus);

    ready = onLayers.length > 0;
    loading = false;
  }

  function tent(rpm, center, width) { const d = Math.abs(rpm - center) / width; return d >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * d)); }
  // rpm → the rpm the SAMPLE BANK is driven at (see REV_EXPAND_DEFAULT). Identity at expand = 1.
  function expandRpm(rpm) {
    if (revExpand === 1) return rpm;
    const p = revPivot > 0 ? revPivot : REV_PIVOT_FALLBACK;
    return clamp(p * Math.pow(rpm / p, revExpand), 500, 12000);
  }
  function driveBands(layers, rpm, busGain, now, TC, rateHi) {
    const hi = rateHi || RATE_HI;
    const n = layers.length; if (!n) return;
    const w = new Array(n);
    for (let k = 0; k < n; k++) w[k] = tent(rpm, layers[k].rpm, layers[k].width);
    if (rpm <= layers[0].rpm) { w.fill(0); w[0] = 1; }
    else if (rpm >= layers[n - 1].rpm) { w.fill(0); w[n - 1] = 1; }
    let ss = 0; for (let k = 0; k < n; k++) ss += w[k] * w[k];
    const norm = Math.sqrt(ss) || 1;
    for (let k = 0; k < n; k++) {
      layers[k].g.gain.setTargetAtTime((w[k] / norm) * busGain, now, TC);
      layers[k].src.playbackRate.setTargetAtTime(clamp(rpm / layers[k].rpm, RATE_LO, hi) * doppler, now, TC);
    }
  }

  function update(snap) {
    if (!enabled || !ready || !snap) return;
    const now = ctx.currentTime, TC = 0.03;
    const rpm = clamp(snap.rpm || 0, 500, 11000); lastRpm = rpm;
    const t = clamp(snap.gas == null ? 1 : snap.gas, 0, 1);
    // real on-load / off-load recordings, equal-power throttle blend (off-load exists ~4800–6900 rpm).
    // The BANKS run on the expanded rpm (contrast, see expandRpm); every other layer below stays on
    // the true rpm, because those track real physics (boost, growl) rather than the engine's voice.
    const rpmA = expandRpm(rpm); lastRpmA = rpmA;
    // ONE engine at a time — the two modes are an A/B, never a layer. Whichever is off is driven to
    // silence every frame rather than simply left alone, or the last gains it wrote would hang there.
    const acOn = engineMode === "ac" && acVoices && acVoices.length;
    const harmOn = engineMode === "harmonic" && harmProf && !acOn;
    const sampGain = (harmOn || acOn) ? 0 : 1;
    if (acBus) acBus.gain.setTargetAtTime(acOn ? 1 : 0, now, 0.05);
    if (acOn) driveEventEngine(rpm, t, now, TC);   // AC drives its curves off RAW rpm, not expanded
    driveBands(onLayers, rpmA, Math.sin(t * Math.PI / 2) * sampGain, now, TC);
    driveBands(offLayers, rpmA, Math.cos(t * Math.PI / 2) * clamp((rpm - 3000) / 1500, 0, 1) * sampGain, now, TC, RATE_HI_OFF);
    if (harmBus) harmBus.gain.setTargetAtTime(harmOn ? 1 : 0, now, 0.05);
    if (harmOn) driveHarmonic(rpmA, t, now, TC);
    // synth low body — the V8 chest/rumble. Pitch-shifted by doppler with the samples. (Restored:
    // halving these on the "natural voice" pass thinned it out into a high-revvy tone.)
    // Synthesis MUTED: the Mach 6's V8 is already in the recorded samples — layering a synthetic
    // firing/sub/grit V8 on top is exactly what made it stop sounding like the real engine.
    // Let the samples BE the engine; keep only the crisp EQ + spatialization around them.
    firingGain.gain.setTargetAtTime(0, now, 0.1);
    subGain.gain.setTargetAtTime(0, now, 0.1);
    gritGain.gain.setTargetAtTime(0, now, 0.1);
    // MENACE layer: deep guttural growl rising with rpm, present on-throttle
    const mf = (26 + rpm * 0.009) * doppler;
    menaceOsc.frequency.setTargetAtTime(mf, now, 0.05);
    menaceOsc2.frequency.setTargetAtTime(mf, now, 0.05);   // detune param gives the beat
    menaceGain.gain.setTargetAtTime(raw ? 0 : 0.07 + 0.11 * t, now, 0.08);   // raw = the car only, nothing of ours
    // jet turbine: spools with turbo BOOST, pitches up with rpm, dopplers on flyby — out the back
    if (turbineSrc) {
      const boostN = clamp(((snap.boost || 1) - 1.05) / 0.85, 0, 1);
      turbineGain.gain.setTargetAtTime(0.04 + 0.32 * boostN, now, 0.1);
      turbineSrc.playbackRate.setTargetAtTime((0.85 + 0.45 * clamp(rpm / 9000, 0, 1.2)) * doppler, now, 0.06);
    }
  }

  function setListener(px, py, pz, fx, fy, fz, ux, uy, uz) {
    if (!ctx) return;
    const L = ctx.listener;
    if (L.positionX) {
      L.positionX.value = px; L.positionY.value = py; L.positionZ.value = pz;
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz; L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz;
    } else { L.setPosition(px, py, pz); L.setOrientation(fx, fy, fz, ux, uy, uz); }
  }
  function setCarPos(x, y, z) {
    if (!panner) return;
    if (panner.positionX) { panner.positionX.value = x; panner.positionY.value = y; panner.positionZ.value = z; }
    else panner.setPosition(x, y, z);
  }
  // aim the source (the exhaust direction) so the cone projects the engine out the back of the car
  function setSourceDir(x, y, z) {
    if (!panner) return;
    if (panner.orientationX) { panner.orientationX.value = x; panner.orientationY.value = y; panner.orientationZ.value = z; }
    else panner.setOrientation(x, y, z);
  }
  // camera↔car distance: the reverb/echo bypass the panner, so drop THEM with distance too, matching
  // the dry falloff. NO FLOOR (was 0.15 + 0.85*df) — that constant floor was the plateau: once the dry
  // engine went faint far off, the never-dying wash was all you heard, so it "never got quieter." Now
  // the wash fades fully to zero with distance, so flying across the map genuinely goes silent.
  function setDistance(d) {
    if (!reverbSend || !ctx) return;
    const df = clamp(Math.pow(DIST_REF / Math.max(d, DIST_REF), DIST_ROLLOFF), 0, 1);  // tracks the dry panner exactly
    const now = ctx.currentTime;
    reverbSend.gain.setTargetAtTime(0.06 * df, now, 0.15);   // drier — let the natural voice carry
    echoSend.gain.setTargetAtTime(0.09 * df, now, 0.15);
  }
  // flyby doppler: pitch multiplier from the car's radial velocity vs the camera (approach>1, recede<1).
  // ASYMMETRIC: kill the pitch-UP almost entirely (approaching a 500km/h car screams like F1 from the
  // front), keep the full pitch-DOWN so the whoosh-away as it passes still drops into a fat V8.
  function setDoppler(rate) { doppler = clamp(rate, 0.62, 1.02); }
  function backfire() {
    if (!enabled || !ready || !bfBufs.length) return;
    const now = ctx.currentTime;
    if (now - bfLast < 0.05) return; bfLast = now;
    const buf = bfBufs[(Math.random() * bfBufs.length) | 0];
    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const g = gain(0.45 + Math.random() * 0.4); src.connect(g); g.connect(eventGain); src.start();
  }

  async function setEnabled(on) {
    if (on) {
      await ensureGraph();
      if (ctx.state === "suspended") await ctx.resume();
      enabled = true; master.gain.setTargetAtTime(userVol * MASTER_ON, ctx.currentTime, 0.08);
    } else if (ctx) { enabled = false; master.gain.setTargetAtTime(0.0, ctx.currentTime, 0.08); }
    return enabled;
  }
  // header volume slider: 0..1, scales the master ceiling. Applied live when the engine is on.
  function setVolume(v) {
    userVol = clamp(v == null ? 1 : v, 0, 1);
    if (master && enabled && ctx) master.gain.setTargetAtTime(userVol * MASTER_ON, ctx.currentTime, 0.05);
  }
  async function toggle() { return setEnabled(!enabled); }
  function isOn() { return enabled; }
  function resumeIfNeeded() { if (ctx && enabled && ctx.state === "suspended") ctx.resume(); }
  function dbg() { return { rpm: Math.round(lastRpm), rpmA: Math.round(lastRpmA), expand: revExpand, mode: engineMode,
                            hz: engineMode === "harmonic" ? +(lastRpmA / 120).toFixed(1) : 0,
                            bands: (onLayers ? onLayers.length : 0) + (offLayers ? offLayers.length : 0), on: enabled }; }
  // rev expander controls: the amount is the user's ear (header slider), the pivot is the run's
  // own median driving rpm (set per replay) so expansion pushes AWAY from how you actually drove.
  function setRevExpand(x) { revExpand = clamp(+x || 1, 1, 3); }
  function getRevExpand() { return revExpand; }
  function setRevPivot(p) { if (isFinite(p) && p > 1000) revPivot = p; }
  /* RAW: bypass everything we invented, leaving only the car's own samples, the panner and the
   * master ceiling. Nothing switched off here exists in Assetto Corsa — the EQ curve, the grit
   * waveshaper, the "menace" growl and the reverb/echo sends are all ours. They were tuned against
   * a thin nine-sample subset; with the car's whole bank loading, they are the largest remaining
   * difference between us and the game, and this is the A/B that shows it. */
  function setRaw(on) {
    raw = !!on;
    if (!ctx || !tone) return raw;
    const now = ctx.currentTime;
    const g = [tone.body, tone.presence, tone.air, tone.topAir];
    for (let i = 0; i < g.length; i++) g[i].gain.setTargetAtTime(raw ? 0 : tone.gains[i], now, 0.05);
    if (menaceGain) menaceGain.gain.setTargetAtTime(0, now, 0.05);        // update() re-drives it when raw clears
    if (gritGain) gritGain.gain.setTargetAtTime(0, now, 0.05);
    if (reverbSend) reverbSend.gain.setTargetAtTime(raw ? 0 : 0.06, now, 0.1);
    if (echoSend) echoSend.gain.setTargetAtTime(raw ? 0 : 0.10, now, 0.1);
    return raw;
  }
  function isRaw() { return raw; }
  /* What is actually feeding the engine right now — so "it sounds the same" can be diagnosed
   * instead of guessed at. */
  function sourceInfo() {
    if (engineMode === "ac" && acVoices) {
      let live = 0;
      for (const v of acVoices) if (v.g.gain.value > 0.001) live++;
      return { car: carBankId, mode: "ac", event: acEvent, voices: acVoices.length, live, raw };
    }
    return { car: carBankId, layers: (onLayers ? onLayers.length : 0), off: (offLayers ? offLayers.length : 0),
             rpmLo: onLayers && onLayers.length ? onLayers[0].rpm : 0,
             rpmHi: onLayers && onLayers.length ? onLayers[onLayers.length - 1].rpm : 0,
             mode: engineMode, raw };
  }
  // engine mode A/B. Falls back to the sample bank if the profile file is missing, so a stale build
  // or a failed generate degrades to the old engine rather than to silence.
  function setEngineMode(m) {
    if (m === "ac" && acVoices && acVoices.length) engineMode = "ac";
    else if (m === "harmonic" && (harmProf || !ctx)) engineMode = "harmonic";
    else engineMode = "sample";
    return engineMode;
  }
  function hasAcEvent() { return !!(acVoices && acVoices.length); }
  function getEngineMode() { return engineMode; }
  function hasHarmonic() { return !!(window.BBEngineProfile && (!ctx || harmProf)); }

  return { update, toggle, setEnabled, isOn, resumeIfNeeded, setListener, setCarPos, setSourceDir, setDistance, setDoppler, setVolume, backfire, dbg,
           setRevExpand, getRevExpand, setRevPivot, setEngineMode, getEngineMode, hasHarmonic,
           setCarBank, getCarBank: () => carBankId, setRaw, isRaw, sourceInfo, hasAcEvent };
})();
