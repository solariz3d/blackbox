/* audioengine.js — BLACKBOX engine sound: Assetto Corsa's own event, played raw.
 *
 * ONE engine, no modes, no tone-shaping. The replay's car bank is parsed (fsb5.js), and the event
 * AC actually authored is played as authored: every looping instrument on the `rpms` sheet with its
 * trigger box, its gain curves, its static dB, and its own autopitch root. What reaches the output
 * is the car's samples, a 3D panner with the exhaust cone, and the master ceiling. Nothing else.
 *
 * How it got here, so none of it is re-litigated by ear later:
 *  - A crossfaded sample ladder (our own design) and a harmonic resynthesis of the measured
 *    signature (also ours) both sounded close to each other and not close to the game. Removed.
 *  - The reason was never the samples — ours WERE the bank's top-of-range layers. It was the mix:
 *    AC sounds 6–15 instruments simultaneously (14 at 8300 rpm on this car). We crossfaded two.
 *  - `engine_ext`/`engine_int` are EMPTY STUBS in this bank. The engine lives on `engine_custom`
 *    (CSP's extended-sound path), with `engine_ext_old` as the legacy exterior fallback.
 *  - The autopitch root is authored per instrument and is NOT the number in the sample's name
 *    (5972a_inside → 5900, 7348c → 7050, 6365d → 12800), so name-derived ladders are detuned.
 *  - AC plays nothing outside a layer's trigger box — no extrapolation past the top layer.
 *  - Everything BLACKBOX used to add — an EQ curve, a grit waveshaper, a "menace" growl, reverb and
 *    echo sends — existed to fatten a two-voice engine. Against a twelve-voice authored mix it was
 *    only colouring us away from the game. All of it is gone; this file is the raw path by design.
 *
 * The recipe comes from ui/eventmap.js, decoded per car by make_eventmap.js.
 * Autoplay-safe; per-frame control via setTargetAtTime (never .value=, which zippers).
 */
window.BBAudio = (function () {
  const BASE = "audio/";
  const MASTER_ON = 0.78;
  // headroom for a dozen simultaneous voices. The ONE number here that AC did not author — the
  // per-layer gains are the sound designer's, this only scales their sum into our headroom.
  // 0.22 was right for the engine event alone (summed gain ~11). With the turbine, gearbox and tyre
  // events alongside it the sum roughly doubles (~22 at speed), so this halves to keep the peak out
  // of the limiter — heavy limiting on a mix this dense pumps audibly.
  const AC_LEVEL = 0.11;
  // which ENGINE event to play, best first. engine_custom is the CSP path modern cars actually use;
  // engine_ext_old is the legacy exterior event; engine_int_old is a last resort so a car whose
  // exterior events are empty still makes sound.
  const AC_EVENT_ORDER = ["engine_custom", "engine_ext_old", "engine_int_old"];
  // events played ALONGSIDE the engine, as AC does — the car is not one event. `turbine` is the
  // jet spool (N1/N2/afterburner/combustion) that is half this car's voice; `transmission` is the
  // gearbox whine on drivetrain speed; `wheel` carries tyre_rolling on road speed.
  // NOT included: `wind` (rides air_pressure, which we don't have and would otherwise sit at full
  // blast), and `turbo` (authored at −80 dB — the designer muted it, so we honour that).
  const AC_EXTRA_EVENTS = ["turbine", "transmission", "wheel", "turbine_fuelpump"];
  const DIST_REF = 48, DIST_ROLLOFF = 1.4;   // LOUD car carries far, with no plateau: ~14% at 200m, ~4% at 500m

  let ctx, master, panner, engineMix, masterBus;
  let windVoices = null, windBus = null, windKph = 0, windWalk = 0;
  let acVoices = null, acBus = null, acEvent = null;
  let carBank = null, carBankId = null;
  let bfBufs = [], eventGain = null;
  let enabled = false, loading = false, ready = false;
  let lastRpm = 0, bfLast = 0, doppler = 1;   // doppler = flyby pitch multiplier (approach>1, recede<1)
  let userVol = 1;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const biq = (type, freq, Q, g) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = freq; if (Q != null) b.Q.value = Q; if (g != null) b.gain.value = g; return b; };
  const gain = v => { const g = ctx.createGain(); g.gain.value = v; return g; };

  async function loadBuf(file) {
    const r = await fetch(BASE + file);
    if (!r.ok) throw new Error(r.status + " " + file);
    return ctx.decodeAudioData(await r.arrayBuffer());
  }
  // gentle tanh soft-clip — a transparent master ceiling, not tone
  function tanhCurve(drive, n) {
    n = n || 2048; const c = new Float32Array(n), k = Math.tanh(drive);
    for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; c[i] = Math.tanh(drive * x) / k; }
    return c;
  }
  // stereo widener (mid-side): sides scaled, mid untouched (mono-safe). Positional cue only.
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

  async function ensureGraph() {
    if (ctx || loading) return;
    loading = true;
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    // ---- master: level + ceiling only ----
    master = gain(0.0); master.connect(ctx.destination);
    const softClip = ctx.createWaveShaper(); softClip.curve = tanhCurve(1.4); softClip.oversample = "4x"; softClip.connect(master);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.06;
    limiter.connect(softClip);
    masterBus = gain(1.0); masterBus.connect(limiter);

    // ---- spatialized engine → masterBus ----
    panner = ctx.createPanner();
    panner.panningModel = "HRTF"; panner.distanceModel = "exponential"; panner.refDistance = DIST_REF; panner.rolloffFactor = DIST_ROLLOFF;
    // the exhaust projects rearward — louder behind the car, quieter from the front
    panner.coneInnerAngle = 100; panner.coneOuterAngle = 260; panner.coneOuterGain = 0.45;
    widener(panner, 1.35).connect(masterBus);

    const engineTrim = gain(0.72);
    const engineSum = gain(1.0); engineSum.connect(engineTrim); engineTrim.connect(panner);
    const engineHP = biq("highpass", 40, 0.7);       // clears subsonic rumble; not tone-shaping
    engineMix = gain(1.0);
    engineMix.connect(engineHP); engineHP.connect(engineSum);

    // ---- backfire one-shots → panner ----
    eventGain = gain(0.4); eventGain.connect(panner);
    // fallback pops for a browser with no car bank; setCarBank replaces these with the car's own
    for (let bn = 1; bn <= 5; bn++) { try { bfBufs.push(await loadBuf(`backfire${bn}.wav`)); } catch (e) { /* bank will supply them */ } }

    ready = true;
    loading = false;
  }

  /* ---------------- the car's own bank ---------------- */
  function bufFromSample(bank, s) {
    const pcm = FSB5.decode(bank, s);
    const buf = ctx.createBuffer(pcm.chans.length, pcm.frames, pcm.freq);
    for (let c = 0; c < pcm.chans.length; c++) buf.copyToChannel(pcm.chans[c], c);
    return buf;
  }

  /* Load the replay car's FMOD bank and build its authored event.
   * Every car ships its own engine — there are 16 T-180 variants on this machine and they do not
   * sound alike — so the audio has to come from the replay's car. Best-effort throughout: a missing
   * bank, an unexpected codec or a map decoded from a different car leaves the engine silent rather
   * than playing the wrong car, and says so. */
  async function setCarBank(arrayBuffer, carId) {
    if (!window.FSB5) return null;
    await ensureGraph();
    // ensureGraph() returns immediately if a build is already in flight; wait it out so we don't
    // install voices into a half-built graph
    while (loading) await new Promise(r => setTimeout(r, 30));
    if (!ctx) return null;

    const bank = FSB5.parse(arrayBuffer);
    if (bank.codec !== 2) throw new Error("bank codec " + bank.codecName + " (only PCM16 is decoded)");
    carBank = bank; carBankId = carId || null;

    // the car's own pops, preferring short exterior one-shots — a 20 s "backfire" in this bank is a
    // loop, not a pop, and firing one as an event would drown the engine
    try {
      const cls = FSB5.classify(bank);
      const pops = cls.backfire.filter(s => s.dur > 0.05 && s.dur < 2.5).sort((a, b) => a.dur - b.dur).slice(0, 8);
      const bufs = [];
      for (const s of pops) { try { bufs.push(bufFromSample(bank, s)); } catch (e) { /* skip */ } }
      if (bufs.length) bfBufs = bufs;
    } catch (e) { console.warn("[BBAudio] backfire set:", e); }

    const M = window.BBEventMap;
    if (!M) { console.warn("[BBAudio] no ui/eventmap.js — no engine to play"); return { car: carBankId, voices: 0 }; }
    if (M.car && carBankId && M.car !== carBankId) {
      console.warn(`[BBAudio] event map is ${M.car}; this replay is ${carBankId}. Regenerate:\n  node make_eventmap.js "<${carBankId}.bank>" out.json ui/eventmap.js ${carBankId}`);
      return { car: carBankId, voices: 0, wrongCar: M.car };
    }
    const info = buildEventEngine(bank, M);
    return Object.assign({ car: carBankId }, info || { voices: 0 });
  }

  /* ---------------- AC event engine ---------------- */
  // piecewise-linear through the authored points, held flat outside them. The per-point 'shape'
  // field encodes curvature we have not decoded; linear is exact wherever shape is 0 (most points).
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

  function addEventVoices(bank, map, name) {
    const ev = map.events[name];
    if (!ev || !ev.layers.length) return 0;
    let n = 0;
    for (const L of ev.layers) {
      const s = bank.samples[L.sample];
      if (!s) continue;
      try {
        const src = ctx.createBufferSource();
        src.buffer = bufFromSample(bank, s);
        src.loop = true;
        const g = gain(0);
        src.connect(g); g.connect(acBus); src.start();
        acVoices.push({ L, src, g, event: name, base: Math.pow(10, (L.db || 0) / 20) });
        n++;
      } catch (e) { console.warn("[BBAudio] " + name + " layer", L.name, e); }
    }
    return n;
  }

  /* WIND — the one sound that belongs to the LISTENER, not the car.
   *
   * Everything else here is emitted by the car and spatialized through the panner. Wind is what the
   * camera hears from moving through air, so it is driven by the CAMERA's speed and goes straight to
   * the master bus with no panner, no distance falloff and no doppler. Park the camera beside a car
   * doing 400 km/h and there is no wind; fly with it and there is.
   *
   * This distinction does not exist in Assetto Corsa — its listener IS the driver, so car speed and
   * listener speed are the same number and its `wind` event rides `air_pressure`. A free-flying
   * camera makes them different, so the mapping below (speed → gain and pitch) is OURS, not the
   * sound designer's. It is the only invented element left in the engine, and it is stated here
   * rather than buried so it can be judged as such.
   */
  /* SKID — the one car sound the bank does not author.
   *
   * Decoding `skid_ext`/`skid_int` settled this rather than leaving it to taste: they declare ZERO
   * parameters, carry zero instrument automation, and their bus carries none either. The bank
   * supplies only the sample, a static −3 semitone detune and a loop flag — Assetto Corsa drives
   * skid volume from game code, not from the event. So there is no authored curve to honour here,
   * and mapping our own slip signal to gain is not a shortcut, it is the only thing the format
   * leaves to the consumer.
   *
   * The signal is the same per-wheel slide angle that already draws the tyre marks and feeds the
   * smoke (`computeWheelSlip`), which blends AC's real per-wheel `wheelSlip` when the replay
   * carries telemetry — so squeal, marks and smoke can never disagree about what the tyres did.
   */
  /* WHICH slip signal, and why it matters more than the thresholds:
   *
   * AC's own per-wheel `wheelSlip` (telemetry) is the honest one — >1 means that tyre is sliding,
   * and it is car-agnostic. Measured on the T-180 sample: p50 0.59, p90 1.92, p98 4.5, so onset
   * just above 1 and full by ~5 gives scrub in fast corners and a howl in a real slide.
   *
   * The kinematic angle (body heading vs velocity) is only a FALLBACK for replays with no
   * telemetry, and it is a poor one for this car specifically: the T-180 has four-wheel steering,
   * so the body crabs and that angle reads a median of 17° with a p90 of 47° — nothing like tyre
   * scrub. Thresholds for it are set high on purpose. Measuring this is what caught a first pass
   * that would have squealed through 70% of the lap.
   */
  const SKID_REAL_ON = 1.15, SKID_REAL_FULL = 5.0;    // AC wheelSlip units
  const SKID_KIN_ON = 25, SKID_KIN_FULL = 65;         // degrees, fallback only
  const SKID_MIN_KPH = 15;        // no squeal from a car that is barely rolling
  const SKID_LEVEL = 0.55;
  let skidVoice = null, skidGain = null;

  function buildSkid(bank, map) {
    const ev = (map.events && (map.events.skid_ext || map.events.skid_int)) || null;
    const L = ev && ev.layers && ev.layers.find(x => bank.samples[x.sample]);
    if (!L) return 0;
    if (skidVoice) { try { skidVoice.src.stop(); } catch (e) { /* stopped */ } skidVoice.g.disconnect(); }
    if (!skidGain) { skidGain = gain(1); skidGain.connect(engineMix); }   // from the car → spatialized
    try {
      const src = ctx.createBufferSource();
      src.buffer = bufFromSample(bank, bank.samples[L.sample]);
      src.loop = true;
      const g = gain(0);
      src.connect(g); g.connect(skidGain); src.start();
      // honour the authored detune even though the gain curve is ours to write
      skidVoice = { src, g, base: Math.pow(10, (L.db || 0) / 20), rate: Math.pow(2, (L.semitones || 0) / 12), name: L.name };
      return 1;
    } catch (e) { console.warn("[BBAudio] skid layer", L.name, e); return 0; }
  }

  function driveSkid(real, kinDeg, kph, now, TC) {
    if (!skidVoice) return;
    const n = real >= 0
      ? clamp((real - SKID_REAL_ON) / (SKID_REAL_FULL - SKID_REAL_ON), 0, 1)
      : clamp((kinDeg - SKID_KIN_ON) / (SKID_KIN_FULL - SKID_KIN_ON), 0, 1);
    const rolling = clamp((kph - SKID_MIN_KPH) / 20, 0, 1);
    const lvl = Math.pow(n, 1.2) * rolling * SKID_LEVEL * skidVoice.base;
    skidVoice.g.gain.setTargetAtTime(lvl, now, TC);
    // a harder slide scrubs brighter; the authored −3 semitones stays underneath
    skidVoice.src.playbackRate.setTargetAtTime(skidVoice.rate * (0.94 + 0.22 * n) * doppler, now, 0.08);
  }

  const WIND_FULL_KPH = 320;      // camera speed at which wind reaches full level
  const WIND_FLOOR_KPH = 25;      // below this the camera's own motion adds nothing
  /* AMBIENT AIR — audible standing still, and it grows with height.
   * Near the ground the air is quiet but never silent; get up above the scenery and you hear the
   * atmosphere moving, gusting harder with nothing to break it. So altitude contributes its own
   * wind independent of camera motion, and it deepens the gusting rather than only raising level:
   * high air is not just louder, it is less steady. */
  const WIND_GROUND = 0.10;       // never-silent floor at track level
  const WIND_ALT_FULL = 220;      // metres above the car at which ambient reaches full
  let windAlt = 0;
  /* 0.30 was too hot, and the reason is structural rather than a taste miss: the engine passes
   * through `engineTrim` (0.72) AND the panner's exhaust cone (down to 0.45 when the camera isn't
   * behind the car), while wind goes straight to the master bus with neither. So wind was arriving
   * ~2-3× hotter than the same nominal level on the engine, and only a turbine at full could out-
   * shout it. Judged by ear at speed; the curve is eased too, so mid-speed cruising stays quieter
   * and wind climbs mainly where it should — near the top. */
  const WIND_LEVEL = 0.055;

  /* Source matters more than level here. AC's `wind` event is authored for the DRIVER'S EAR inside
   * the cabin, so `wind_mid`/`wind_deep` carry road roar — played under a free-flying camera they
   * read as tyres rolling on tarmac, which is what they are. A camera in open air hears airflow, so
   * that is what this builds: broadband noise shaped by speed, two bands — a low rush that arrives
   * early and a high hiss that only really turns up near the top, which is how airflow behaves.
   * The noise itself is the bank's own `PinkNoise` sample where the car has one (it is a real
   * recording, used as a bed by the engine event), else a generated buffer.
   */
  function buildWind(bank, map) {
    void map;   // the authored wind event is deliberately unused — see above
    if (windVoices) { for (const v of windVoices) { try { v.src.stop(); } catch (e) { /* stopped */ } v.g.disconnect(); } }
    windVoices = [];
    if (!windBus) { windBus = gain(1); windBus.connect(masterBus); }   // listener-local: NOT through the panner

    let buf = null;
    const noiseSample = bank.samples.find(s => /^pinknoise$/i.test(s.name)) || bank.samples.find(s => /pinknoise|whitenoise/i.test(s.name));
    if (noiseSample) { try { buf = bufFromSample(bank, noiseSample); } catch (e) { buf = null; } }
    if (!buf) {
      buf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }  // pinkish
    }
    /* THREE bands, weighted hard toward the bottom. The first cut used a lowpass at 520 Hz plus a
     * HIGHPASS at 1800 — and a highpass passes everything above it, so most of the energy sat in
     * open hiss with no body underneath: "sand continuously moving". Airflow you feel is mostly
     * low-frequency roar with a mid presence and only a trace of top, so:
     *   low   — the roar, carries the weight, present from the start
     *   mid   — presence, half the level
     *   high  — a trace only, squared against speed so it barely exists until you are really moving
     * `gs` scales each band's contribution; `exp` is how hard it waits for speed.
     */
    for (const band of [
      { type: "lowpass",  hz: 150,  q: 0.7,  gs: 1.00, exp: 1, lead: 1 },
      { type: "bandpass", hz: 430,  q: 0.5,  gs: 0.45, exp: 1, lead: 0 },
      { type: "bandpass", hz: 1900, q: 0.45, gs: 0.10, exp: 2, lead: 0 },
    ]) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = buf; src.loop = true;
        const f = biq(band.type, band.hz, band.q);
        const g = gain(0);
        src.connect(f); f.connect(g); g.connect(windBus); src.start();
        windVoices.push({ src, g, f, band, base: 1 });
      } catch (e) { console.warn("[BBAudio] wind band", band.type, e); }
    }
    return windVoices.length;
  }

  /* Per-frame slip (worst wheel, degrees) and road speed. Separate from update() on purpose: slip
   * is kinematic, so a replay carrying no telemetry at all still squeals through the corners even
   * though it has no engine voice. */
  /// `real` = AC's worst-wheel wheelSlip, or -1 when the replay has no telemetry (then `kinDeg`,
  /// the kinematic slide angle, is used — see the thresholds above for why it is a weak proxy).
  function setSlip(real, kinDeg, kph) {
    if (!enabled || !ready || !ctx) return;
    driveSkid(real == null ? -1 : real, kinDeg || 0, kph || 0, ctx.currentTime, 0.04);
  }

  /* Camera airspeed in km/h, from the viewer's own motion. Called per frame by the renderer. */
  function setWind(kph, altitudeM) {
    windKph = clamp(kph || 0, 0, 1200);
    windAlt = clamp(altitudeM || 0, 0, 5000);
    if (!windVoices || !ctx) return;
    const now = ctx.currentTime;
    const motion = clamp((windKph - WIND_FLOOR_KPH) / (WIND_FULL_KPH - WIND_FLOOR_KPH), 0, 1.6);
    // altitude curve is sqrt-ish: the first hundred metres change the most, then it settles
    const alt = Math.sqrt(clamp(windAlt / WIND_ALT_FULL, 0, 1));
    // the two combine, they don't add: flying fast low ≈ hovering high, and doing both is only
    // a little more than either. Standing still at ground level still leaves WIND_GROUND.
    const n = Math.max(WIND_GROUND, motion, alt * 0.85, Math.min(1.6, 0.75 * (motion + alt)));
    // airflow noise grows with speed and saturates, but sqrt() put most of the rise in the first
    // third of the range — which is where the engine has to be heard. Eased to ^0.8 so wind stays
    // out of the way through mid-speed and only really arrives up top.
    /* TURBULENCE. Steady noise at a steady level is the giveaway that a sound is synthesized — real
     * airflow gusts, buffets and wanders. Three slow sines at deliberately incommensurate rates
     * (0.37 / 0.83 / 1.61 Hz — no common period, so the pattern never audibly repeats) plus a random
     * walk give the slow swell, and a faster flutter rides on top whose depth grows with speed,
     * because buffeting is what fast air does and still air does not. Driven here rather than with
     * LFO nodes since this runs per frame anyway. */
    const t = now;
    windWalk += (Math.random() - 0.5) * 0.08;
    windWalk = clamp(windWalk, -0.35, 0.35);
    const swell = 0.5 * Math.sin(t * 0.37) + 0.33 * Math.sin(t * 0.83 + 1.7) + 0.17 * Math.sin(t * 1.61 + 0.4);
    const flutter = Math.sin(t * 5.3 + 2.1) * 0.5 + Math.sin(t * 8.7) * 0.3;
    // high air gusts harder: nothing up there to break it up, so the swell deepens with altitude
    const gustDepth = 0.42 + 0.35 * clamp(windAlt / WIND_ALT_FULL, 0, 1);
    const gust = clamp(1 + gustDepth * swell + windWalk + flutter * 0.18 * clamp(n, 0, 1), 0.2, 1.9);
    const lvl = Math.pow(n, 0.8) * WIND_LEVEL * gust;
    for (const v of windVoices) {
      // each band waits for speed by its own exponent, so the sound gets BRIGHTER with speed rather
      // than just louder — the roar is there from the start, the top only shows up near the limit
      const b = v.band || { gs: 1, exp: 1 };
      const share = b.gs * Math.pow(clamp(n, 0, 1.4), b.exp || 1);
      // the two bands gust out of step (the hiss leads the rush slightly), so the sound moves
      // rather than pumping as one block — lockstep modulation reads as a tremolo, not as air
      const phase = v.band && v.band.lead ? 1 : 0.72 + 0.28 * gust;
      v.g.gain.setTargetAtTime(lvl * share * v.base * phase, now, 0.09);
      // sweep the filters with speed rather than pitching the noise: re-pitching a noise loop just
      // makes it louder and thinner, while moving the corner is what actually sounds like more air.
      // The corner wanders with the gust too, so timbre breathes instead of sitting still.
      if (v.f) {
        // the low band barely moves (a roar stays a roar); the upper bands sweep more, which is
        // where the sense of speed comes from without turning the whole thing into hiss
        const spread = b.lead ? 0.45 : 1.15;
        const hz = v.band.hz * (1 + spread * clamp(n, 0, 1.4)) * (0.9 + 0.2 * gust);
        v.f.frequency.setTargetAtTime(hz, now, 0.18);
      }
    }
  }

  function buildEventEngine(bank, map) {
    if (!map || !map.events) return null;
    const name = AC_EVENT_ORDER.find(n => map.events[n] && map.events[n].layers.length);
    if (!name) return null;
    if (acVoices) { for (const v of acVoices) { try { v.src.stop(); } catch (e) { /* stopped */ } v.g.disconnect(); } }
    acVoices = [];
    if (!acBus) { acBus = gain(1); acBus.connect(engineMix); }
    const engineN = addEventVoices(bank, map, name);
    const extra = [];
    for (const e of AC_EXTRA_EVENTS) {
      const n = addEventVoices(bank, map, e);
      if (n) extra.push(e + ":" + n);
    }
    acEvent = name;
    const wind = buildWind(bank, map);
    if (wind) extra.push("wind:" + wind + "(listener)");
    const skid = buildSkid(bank, map);
    if (skid) extra.push("skid:1(slip-driven)");
    return { event: name, voices: acVoices.length, engine: engineN, extra, wind, skid };
  }

  function update(snap) {
    if (!enabled || !ready || !snap || !acVoices) return;
    const now = ctx.currentTime, TC = 0.03;
    const rpm = clamp(snap.rpm || 0, 0, 25000); lastRpm = rpm;
    const t = clamp(snap.gas == null ? 1 : snap.gas, 0, 1);
    const kph = clamp(snap.speed || 0, 0, 800);
    /* The parameters AC feeds its events. Names are the bank's own (read out of the PRMB records),
     * so this table is the contract between the telemetry and the sound designer's curves.
     * `rpm` and `rpms` are the same engine speed under two names (the turbine event uses `rpm`).
     * The ones we cannot measure are held at rest: a car in a replay is undamaged and inflated. */
    const P = {
      rpms: rpm, rpm: rpm, throttle: t,
      speed: kph, drivetrain_speed: kph,
      boost: snap.boost || 0,
      inflation: 1, suspension_damage: 0, air_pressure: 1,
    };
    for (const v of acVoices) {
      const L = v.L;
      // timeline-placed layers carry no parameter and no trigger box (from/to are null). They are
      // driven elsewhere (skid) or not at all — never gate them on a null, which compares false and
      // would silence them without a word.
      if (L.param == null || L.from == null) continue;
      const x = P[L.param] != null ? P[L.param] : rpm;
      let g = 0;
      if (x >= L.from && x <= L.to) {          // outside the trigger box AC plays nothing
        g = v.base;
        for (let i = 0; i < L.curves.length; i++) {
          const c = L.curves[i];
          // a curve can ride a DIFFERENT parameter than the one that gates the instrument
          const cp = L.curveParams && L.curveParams[i];
          const cx = cp && P[cp] != null ? P[cp] : x;
          const y = evalCurve(c.pts || c, cx);
          g *= c.db ? Math.pow(10, y / 20) : y;   // bus_volume curves are dB, instrument_gain is linear
        }
      }
      v.g.gain.setTargetAtTime(g * AC_LEVEL, now, TC);
      // autopitch off the authored root, unclamped. root ≤ 1 marks an unpitched bed (PinkNoise,
      // combustion, tyre_rolling) — those play at native rate. Non-engine events pitch off their
      // own parameter: the gearbox rides drivetrain speed, not rpm.
      const pitchX = (L.param === "drivetrain_speed" || L.param === "speed") ? kph : rpm;
      const rate = L.root > 1 ? clamp(pitchX / L.root, 0.15, 4) : 1;
      v.src.playbackRate.setTargetAtTime(rate * doppler, now, TC);
    }
  }

  /* ---------------- spatialization ---------------- */
  function setListener(px, py, pz, fx, fy, fz, ux, uy, uz) {
    if (!ctx) return;
    const L = ctx.listener;
    if (L.positionX) {
      L.positionX.value = px; L.positionY.value = py; L.positionZ.value = pz;
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz;
    } else {
      L.setPosition(px, py, pz);
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }
  function setCarPos(x, y, z) {
    if (!panner) return;
    if (panner.positionX) { panner.positionX.value = x; panner.positionY.value = y; panner.positionZ.value = z; }
    else panner.setPosition(x, y, z);
  }
  // aim the exhaust cone out the back of the car
  function setSourceDir(x, y, z) {
    if (!panner) return;
    if (panner.orientationX) { panner.orientationX.value = x; panner.orientationY.value = y; panner.orientationZ.value = z; }
    else panner.setOrientation(x, y, z);
  }
  // kept for API compatibility: distance falloff is the panner's job now that the wet sends are gone
  function setDistance() { /* no ambient sends to duck — the panner handles distance */ }
  // flyby doppler. ASYMMETRIC: pitch-UP is nearly killed (approaching a 500 km/h car screams),
  // pitch-DOWN kept in full so the whoosh-away as it passes still drops.
  function setDoppler(rate) { doppler = clamp(rate, 0.62, 1.02); }

  function backfire() {
    if (!enabled || !ready || !bfBufs.length) return;
    const now = ctx.currentTime;
    if (now - bfLast < 0.05) return; bfLast = now;
    const buf = bfBufs[(Math.random() * bfBufs.length) | 0];
    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const g = gain(0.45 + Math.random() * 0.4); src.connect(g); g.connect(eventGain); src.start();
  }

  /* ---------------- transport ---------------- */
  async function setEnabled(on) {
    if (on) {
      await ensureGraph();
      if (ctx.state === "suspended") await ctx.resume();
      enabled = true; master.gain.setTargetAtTime(userVol * MASTER_ON, ctx.currentTime, 0.08);
    } else if (ctx) { enabled = false; master.gain.setTargetAtTime(0.0, ctx.currentTime, 0.08); }
    return enabled;
  }
  function setVolume(v) {
    userVol = clamp(v == null ? 1 : v, 0, 1);
    if (master && enabled && ctx) master.gain.setTargetAtTime(userVol * MASTER_ON, ctx.currentTime, 0.05);
  }
  async function toggle() { return setEnabled(!enabled); }
  function isOn() { return enabled; }
  function resumeIfNeeded() { if (ctx && enabled && ctx.state === "suspended") ctx.resume(); }

  /* What is actually sounding — so silence or wrongness can be diagnosed instead of guessed at. */
  function sourceInfo() {
    let live = 0;
    if (acVoices) for (const v of acVoices) if (v.g.gain.value > 0.001) live++;
    return { car: carBankId, event: acEvent, voices: acVoices ? acVoices.length : 0, live };
  }
  function dbg() { return { rpm: Math.round(lastRpm), on: enabled, voices: acVoices ? acVoices.length : 0 }; }

  return { update, toggle, setEnabled, isOn, resumeIfNeeded, setListener, setCarPos, setSourceDir,
           setDistance, setDoppler, setVolume, backfire, dbg, setCarBank, getCarBank: () => carBankId,
           sourceInfo, setWind, setSlip };
})();
