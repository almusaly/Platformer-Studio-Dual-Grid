/* =====================================================================
   Platformer Studio — tiny synthesized sound effects (Web Audio, offline)
   ===================================================================== */
(function (PS) {
  'use strict';

  let ctx = null;
  let master = null;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.5;
        master.connect(ctx.destination);
      } catch (e) { ctx = null; return null; }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function tone(t, freq, dur, { type = 'square', vol = 0.12, slide = 0 } = {}) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  const seq = (t, notes, step, opts) => notes.forEach((f, i) => tone(t + i * step, f, step * 1.6, opts));

  const SOUNDS = {
    jump: (t) => tone(t, 300, 0.14, { vol: 0.07, slide: 620 }),
    double: (t) => tone(t, 480, 0.14, { vol: 0.07, slide: 980, type: 'triangle' }),
    coin: (t) => { tone(t, 988, 0.07, { vol: 0.08 }); tone(t + 0.07, 1319, 0.2, { vol: 0.08 }); },
    chime: (t) => seq(t, [1046, 1318, 1568], 0.06, { type: 'triangle', vol: 0.12 }),
    power: (t) => seq(t, [523, 659, 784, 1046], 0.055, { vol: 0.07 }),
    hurt: (t) => tone(t, 320, 0.3, { type: 'sawtooth', vol: 0.09, slide: 70 }),
    stomp: (t) => tone(t, 220, 0.14, { vol: 0.1, slide: 60 }),
    win: (t) => { seq(t, [523, 659, 784], 0.11, { type: 'triangle', vol: 0.14 }); tone(t + 0.36, 1046, 0.5, { type: 'triangle', vol: 0.14 }); },
    lose: (t) => seq(t, [392, 330, 262, 196], 0.14, { type: 'triangle', vol: 0.13 }),
  };

  PS.Sfx = {
    NAMES: [
      { key: 'coin', name: 'Coin blip' },
      { key: 'chime', name: 'Chime' },
      { key: 'power', name: 'Power-up' },
      { key: 'none', name: 'No sound' },
    ],
    play(name) {
      if (!PS.state.prefs.sound || !SOUNDS[name]) return;
      if (!ensure()) return;
      try { SOUNDS[name](ctx.currentTime + 0.01); } catch (e) { /* audio is optional */ }
    },
    unlock() { if (PS.state.prefs.sound) ensure(); },
  };
})(window.PS);
