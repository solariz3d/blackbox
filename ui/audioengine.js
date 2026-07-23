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
  function driveBands(layers, rpm, busGain, now, TC) {
    const n = layers.length; if (!n) return;
    const w = new Array(n);
    for (let k = 0; k < n; k++) w[k] = tent(rpm, layers[k].rpm, layers[k].width);
    if (rpm <= layers[0].rpm) { w.fill(0); w[0] = 1; }
    else if (rpm >= layers[n - 1].rpm) { w.fill(0); w[n - 1] = 1; }
    let ss = 0; for (let k = 0; k < n; k++) ss += w[k] * w[k];
    const norm = Math.sqrt(ss) || 1;
    for (let k = 0; k < n; k++) {
      layers[k].g.gain.setTargetAtTime((w[k] / norm) * busGain, now, TC);
      layers[k].src.playbackRate.setTargetAtTime(clamp(rpm / layers[k].rpm, RATE_LO, RATE_HI) * doppler, now, TC);
    }
  }

  function update(snap) {
    if (!enabled || !ready || !snap) return;
    const now = ctx.currentTime, TC = 0.03;
    const rpm = clamp(snap.rpm || 0, 500, 11000); lastRpm = rpm;
    const t = clamp(snap.gas == null ? 1 : snap.gas, 0, 1);
    // real on-load / off-load recordings, equal-power throttle blend (off-load exists ~4800–6900 rpm)
    driveBands(onLayers, rpm, Math.sin(t * Math.PI / 2), now, TC);
    driveBands(offLayers, rpm, Math.cos(t * Math.PI / 2) * clamp((rpm - 3000) / 1500, 0, 1), now, TC);
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
    menaceGain.gain.setTargetAtTime(0.07 + 0.11 * t, now, 0.08);
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
  function dbg() { return { rpm: Math.round(lastRpm), bands: (onLayers ? onLayers.length : 0) + (offLayers ? offLayers.length : 0), on: enabled }; }

  return { update, toggle, setEnabled, isOn, resumeIfNeeded, setListener, setCarPos, setSourceDir, setDistance, setDoppler, setVolume, backfire, dbg };
})();
