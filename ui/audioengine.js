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
  let windVoices = null, windBus = null, windKph = 0;
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
  const WIND_FULL_KPH = 320;      // camera speed at which wind reaches full level
  const WIND_FLOOR_KPH = 25;      // below this the air is still
  const WIND_LEVEL = 0.30;

  function buildWind(bank, map) {
    const ev = map.events && map.events.wind;
    if (!ev || !ev.layers.length) return 0;
    if (windVoices) { for (const v of windVoices) { try { v.src.stop(); } catch (e) { /* stopped */ } v.g.disconnect(); } }
    windVoices = [];
    if (!windBus) { windBus = gain(1); windBus.connect(masterBus); }   // listener-local: NOT through the panner
    for (const L of ev.layers) {
      const s = bank.samples[L.sample];
      if (!s) continue;
      try {
        const src = ctx.createBufferSource();
        src.buffer = bufFromSample(bank, s);
        src.loop = true;
        const g = gain(0);
        src.connect(g); g.connect(windBus); src.start();
        windVoices.push({ L, src, g, base: Math.pow(10, (L.db || 0) / 20) });
      } catch (e) { console.warn("[BBAudio] wind layer", L.name, e); }
    }
    return windVoices.length;
  }

  /* Camera airspeed in km/h, from the viewer's own motion. Called per frame by the renderer. */
  function setWind(kph) {
    windKph = clamp(kph || 0, 0, 1200);
    if (!windVoices || !ctx) return;
    const now = ctx.currentTime;
    const n = clamp((windKph - WIND_FLOOR_KPH) / (WIND_FULL_KPH - WIND_FLOOR_KPH), 0, 1.6);
    // perceptual: airflow noise grows steeply then saturates, so square-root the normalised speed
    const lvl = Math.sqrt(n) * WIND_LEVEL;
    for (let i = 0; i < windVoices.length; i++) {
      const v = windVoices[i];
      // the deep layer leads at low speed, the mid layer takes over as it rises — two-band airflow
      const share = windVoices.length > 1 ? (i === 0 ? clamp(n, 0, 1) : clamp(1.15 - n, 0, 1)) : 1;
      v.g.gain.setTargetAtTime(lvl * share * v.base, now, 0.25);   // slow: wind should not flicker
      v.src.playbackRate.setTargetAtTime(0.88 + 0.42 * clamp(n, 0, 1.4), now, 0.3);
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
    return { event: name, voices: acVoices.length, engine: engineN, extra, wind };
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
           sourceInfo, setWind };
})();
