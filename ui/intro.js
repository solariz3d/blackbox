/* intro.js — BLACKBOX title card. Simple and effective (after two elaborate
 * attempts missed): the wordmark resolves, a speed-colored line draws beneath
 * it, and it lands on a warm synthesized sound motif (a real musical resolve,
 * not sound effects). No WebGL, no assets. Click to skip. ~2.6s.
 */
(function () {
  "use strict";
  const root = document.getElementById("intro");
  const word = document.getElementById("introword");
  const line = document.getElementById("introline");
  if (!root || !word || !line) { if (root) root.remove(); return; }

  const DUR = 4.0;
  let targetW = word.offsetWidth || Math.min(innerWidth * 0.5, 560);

  // ---- dramatic cinematic sting: riser -> impact -> big chord bloom + reverb tail ----
  let actx = null;
  function reverbIR(ctx, secs, decay) {
    const len = (ctx.sampleRate * secs) | 0, ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return ir;
  }
  function noiseBuf(ctx, s) {
    const b = ctx.createBuffer(1, ctx.sampleRate * s, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function stinger() {
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
      const now = actx.currentTime;
      // limiter catches the many stacked layers so nothing clips (and glues it)
      const lim = actx.createDynamicsCompressor();
      lim.threshold.value = -6; lim.knee.value = 6; lim.ratio.value = 12;
      lim.attack.value = 0.003; lim.release.value = 0.25; lim.connect(actx.destination);
      const master = actx.createGain(); master.gain.value = 0.34; master.connect(lim);
      // convolution reverb for cinematic size; a "wet" bus feeds it
      const conv = actx.createConvolver(); conv.buffer = reverbIR(actx, 2.6, 3.2);
      const wet = actx.createGain(); wet.gain.value = 0.34; conv.connect(wet).connect(lim);
      const both = n => { n.connect(master); n.connect(conv); };  // dry + wet
      const R = now + 1.15; // the impact / resolve

      // sub swell through the card
      const sub = actx.createOscillator(); sub.type = "sine"; sub.frequency.value = 50;
      const subG = actx.createGain();
      subG.gain.setValueAtTime(0.0001, now);
      subG.gain.linearRampToValueAtTime(0.22, now + 0.7);
      subG.gain.linearRampToValueAtTime(0.14, R);
      subG.gain.linearRampToValueAtTime(0.0, now + 3.2);
      sub.connect(subG).connect(master); sub.start(now); sub.stop(now + 3.2);

      // RISER — whoosh + rising drone building tension into the impact
      const wh = actx.createBufferSource(); wh.buffer = noiseBuf(actx, 1.4);
      const whHP = actx.createBiquadFilter(); whHP.type = "highpass";
      whHP.frequency.setValueAtTime(300, now + 0.25);
      whHP.frequency.exponentialRampToValueAtTime(9000, R);
      const whG = actx.createGain();
      whG.gain.setValueAtTime(0.0001, now + 0.25);
      whG.gain.exponentialRampToValueAtTime(0.16, R - 0.02);
      whG.gain.exponentialRampToValueAtTime(0.001, R + 0.1);
      wh.connect(whHP).connect(whG); both(whG); wh.start(now + 0.25); wh.stop(R + 0.15);
      const dlp = actx.createBiquadFilter(); dlp.type = "lowpass";
      dlp.frequency.setValueAtTime(300, now + 0.3); dlp.frequency.exponentialRampToValueAtTime(2200, R);
      dlp.connect(master);
      const drG = actx.createGain();
      drG.gain.setValueAtTime(0.0001, now + 0.3);
      drG.gain.exponentialRampToValueAtTime(0.12, R - 0.03);
      drG.gain.exponentialRampToValueAtTime(0.001, R + 0.1);
      drG.connect(dlp);
      [60, 90].forEach(f0 => {
        const o = actx.createOscillator(); o.type = "sawtooth";
        o.frequency.setValueAtTime(f0, now + 0.3);
        o.frequency.exponentialRampToValueAtTime(f0 * 3, R);
        o.detune.value = (Math.random() - 0.5) * 12;
        o.connect(drG); o.start(now + 0.3); o.stop(R + 0.1);
      });

      // THE IMPACT — sub drop + braaam body + transient crack
      const drop = actx.createOscillator(); drop.type = "sine";
      drop.frequency.setValueAtTime(150, R); drop.frequency.exponentialRampToValueAtTime(36, R + 0.16);
      const dropG = actx.createGain();
      dropG.gain.setValueAtTime(0.0001, R); dropG.gain.linearRampToValueAtTime(0.5, R + 0.015);
      dropG.gain.exponentialRampToValueAtTime(0.001, R + 0.9);
      drop.connect(dropG).connect(master); drop.start(R); drop.stop(R + 0.95);

      const braaLP = actx.createBiquadFilter(); braaLP.type = "lowpass";
      braaLP.frequency.setValueAtTime(500, R); braaLP.frequency.exponentialRampToValueAtTime(1400, R + 0.3);
      const braaG = actx.createGain();
      braaG.gain.setValueAtTime(0.0001, R); braaG.gain.linearRampToValueAtTime(0.2, R + 0.02);
      braaG.gain.exponentialRampToValueAtTime(0.001, R + 1.6);
      braaLP.connect(braaG); both(braaG);
      [55, 82.4, 110].forEach(f => {
        [-6, 6].forEach(det => {
          const o = actx.createOscillator(); o.type = "sawtooth"; o.frequency.value = f; o.detune.value = det;
          o.connect(braaLP); o.start(R); o.stop(R + 1.65);
        });
      });
      const crack = actx.createBufferSource(); crack.buffer = noiseBuf(actx, 0.05);
      const crBP = actx.createBiquadFilter(); crBP.type = "bandpass"; crBP.frequency.value = 3200; crBP.Q.value = 1;
      const crG = actx.createGain();
      crG.gain.setValueAtTime(0.3, R); crG.gain.exponentialRampToValueAtTime(0.001, R + 0.12);
      crack.connect(crBP).connect(crG); both(crG); crack.start(R); crack.stop(R + 0.13);

      // CHORD BLOOM — big A-major voicing, detuned saws for richness, long tail
      [110, 220, 277.18, 329.63, 440].forEach((f, i) => {
        [-5, 5].forEach(det => {
          const o = actx.createOscillator(); o.type = i < 2 ? "sawtooth" : "triangle";
          o.frequency.value = f; o.detune.value = det;
          const g = actx.createGain();
          const amp = (i === 4 ? 0.05 : 0.08) / 1.4;
          g.gain.setValueAtTime(0.0001, R);
          g.gain.linearRampToValueAtTime(amp, R + 0.04);
          g.gain.exponentialRampToValueAtTime(0.001, R + 2.4);
          o.connect(g); both(g); o.start(R); o.stop(R + 2.5);
        });
      });

      // high shimmer ringing out into the reverb
      [880, 1108.73, 1318.5].forEach((f, i) => {
        const o = actx.createOscillator(); o.type = "sine"; o.frequency.value = f;
        const g = actx.createGain();
        g.gain.setValueAtTime(0.0001, R + 0.02); g.gain.linearRampToValueAtTime(0.05 - i * 0.012, R + 0.06);
        g.gain.exponentialRampToValueAtTime(0.001, R + 2.0);
        o.connect(g); both(g); o.start(R); o.stop(R + 2.1);
      });
    } catch (e) { /* audio optional */ }
  }

  function ss(a, b, t) { const x = Math.max(0, Math.min(1, (t - a) / (b - a))); return x * x * (3 - 2 * x); }

  const t0 = performance.now();
  let done = false, audioOn = false;
  function frame() {
    if (done) return;
    const t = (performance.now() - t0) / 1000;
    if (!audioOn && t > 0.02) { audioOn = true; stinger(); }
    if (t >= DUR) { finish(); return; }
    requestAnimationFrame(frame);

    const rev = ss(0.15, 0.85, t);            // wordmark resolves in
    word.style.opacity = rev.toFixed(3);
    word.style.transform = `scale(${(0.92 + rev * 0.08).toFixed(3)})`;

    const draw = ss(0.35, 1.15, t);           // line draws beneath
    line.style.width = (draw * targetW).toFixed(1) + "px";
    line.style.opacity = ss(0.32, 0.55, t).toFixed(3);

    // glow: subtle base, bright pulse on the resolve, then settle
    const pulse = t >= 1.15 ? Math.exp(-(t - 1.15) * 3.4) : 0;
    const g = 0.12 + pulse * 0.9;
    word.style.textShadow =
      `0 0 ${(22 * g).toFixed(1)}px rgba(226,58,46,${(0.7 * g).toFixed(2)}), ` +
      `0 0 ${(60 * g).toFixed(1)}px rgba(226,58,46,${(0.3 * g).toFixed(2)})`;

    if (t > DUR - 0.4) root.style.opacity = Math.max(0, (DUR - t) / 0.4).toFixed(3);
  }
  requestAnimationFrame(frame);

  function finish() {
    if (done) return; done = true;
    root.classList.add("gone");
    try { if (actx) setTimeout(() => actx.close(), 3000); } catch (e) {}
    setTimeout(() => { if (root && root.parentNode) root.parentNode.removeChild(root); }, 600);
  }
  root.addEventListener("click", finish);
  addEventListener("keydown", finish, { once: true });
  addEventListener("resize", () => { targetW = word.offsetWidth || targetW; });
})();
