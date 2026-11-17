// CHAINFIRE 3D — audio.js
// Fully synthesized WebAudio sound: oscillators + a code-generated noise
// buffer. No external audio files, no fetch, no network.
//
// The sim never sees this module: it owns its own seeded rng instance
// (mulberry32, fixed seed) used ONLY for ambient bird-chirp timing, and it
// never touches Date.now for game logic. Every method fails soft when the
// AudioContext is missing, locked, or muted — it never throws.
//
// Contract: createAudio() -> { unlock, setMuted, isMuted, play,
// startAmbient, stopAmbient, setMusicMood, update }

export function createAudio() {
  // ------------------------------------------------------------------
  // Own seeded rng (independent of the sim's rng). Only used to pick
  // the delay between ambient bird chirps.
  // ------------------------------------------------------------------
  let rngState = 0xa0d10 >>> 0;
  function rng() {
    rngState = (rngState + 0x6d2b79f5) >>> 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  let ctx = null; // AudioContext, created only inside unlock()
  let masterGain = null; // every node routes through this
  let sfxGain = null;
  let musicGain = null;
  let ambientGain = null;
  let noiseBuffer = null; // white-noise buffer, built once
  let muted = false;
  let ambientOn = false;
  let windNodes = null; // { src, filter, lfo, lfoGain } while ambient runs
  let musicNodes = null; // { oscs, gains, lfo, lfoGain } while a mood runs
  let musicMood = 'off';
  let chirpTimer = 4 + rng() * 6; // seconds until the next bird chirp
  let arpTimer = 0; // victory arpeggio step timer
  let arpIndex = 0;
  let callVol = 1; // per-call volume multiplier, set by play(), read by tone()/noise()

  const MASTER_LEVEL = 0.5;

  // ------------------------------------------------------------------
  // Small helpers — all no-op safely when there is no context.
  // ------------------------------------------------------------------
  function now() {
    return ctx ? ctx.currentTime : 0;
  }

  function makeNoiseBuffer() {
    const len = ctx.sampleRate; // 1 second of white noise
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) {
      data[i] = rng() * 2 - 1;
    }
    return buf;
  }

  // One oscillator blip with an attack/decay envelope.
  // opts: { type, freq, freqEnd, dur, vol, attack, delay }
  function tone(opts) {
    if (!ctx || !sfxGain) return;
    try {
      const t0 = now() + (opts.delay || 0);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = opts.type || 'sine';
      osc.frequency.setValueAtTime(Math.max(20, opts.freq || 440), t0);
      if (opts.freqEnd && opts.freqEnd !== opts.freq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqEnd), t0 + (opts.dur || 0.1));
      }
      const vol = (opts.vol != null ? opts.vol : 0.2) * callVol;
      const attack = opts.attack != null ? opts.attack : 0.005;
      const dur = opts.dur || 0.1;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t0 + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain);
      gain.connect(sfxGain);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    } catch (err) {
      // Fail soft: a single bad blip must never break the game.
    }
  }

  // Filtered noise burst. opts: { dur, vol, filterType, freq, freqEnd, q, delay }
  function noise(opts) {
    if (!ctx || !sfxGain || !noiseBuffer) return;
    try {
      const t0 = now() + (opts.delay || 0);
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = opts.filterType || 'lowpass';
      filter.frequency.setValueAtTime(opts.freq || 1000, t0);
      if (opts.freqEnd && opts.freqEnd !== opts.freq) {
        filter.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqEnd), t0 + (opts.dur || 0.2));
      }
      filter.Q.value = opts.q || 0.8;
      const gain = ctx.createGain();
      const vol = (opts.vol != null ? opts.vol : 0.2) * callVol;
      const dur = opts.dur || 0.2;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t0 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(sfxGain);
      src.start(t0);
      src.stop(t0 + dur + 0.05);
    } catch (err) {
      // Fail soft.
    }
  }

  // A short run of N tiny noise ticks (crackle / fizzle texture).
  function crackle(count, span, vol, freq) {
    for (let i = 0; i < count; i += 1) {
      noise({
        dur: 0.02 + rng() * 0.02,
        vol: vol * (0.5 + rng() * 0.5),
        filterType: 'bandpass',
        freq: freq * (0.7 + rng() * 0.6),
        q: 4,
        delay: (span * i) / count + rng() * 0.01,
      });
    }
  }

  // ------------------------------------------------------------------
  // One-shot sound bank. Every name is distinct in pitch, timbre and
  // rhythm. `pitch` (chain multiplier) raises the chain sound.
  // ------------------------------------------------------------------
  const SOUNDS = {
    // UI click: short bright square blip.
    click() {
      tone({ type: 'square', freq: 880, freqEnd: 660, dur: 0.05, vol: 0.12 });
    },

    // Defender shot (ROUND 3, item 1): a tiny dry pop — deliberately
    // quiet (vol 0.06) and short, because a full volley is 12 shots and
    // a loud crack per shot would read as a machine gun.
    shoot() {
      tone({ type: 'square', freq: 1400, freqEnd: 900, dur: 0.04, vol: 0.06 });
    },

    // Explosion: sub sine drop + low noise thump.
    boom() {
      tone({ type: 'sine', freq: 130, freqEnd: 38, dur: 0.5, vol: 0.5 });
      noise({ dur: 0.45, vol: 0.35, filterType: 'lowpass', freq: 500, freqEnd: 90 });
    },

    // Chain link: two rising triangle notes; pitch rises with the
    // chain multiplier (opts.pitch, 1 = x1). Each multiplier step is
    // +2 semitones so x8 sits a clear octave-ish above x1.
    chain(pitch) {
      const mult = Math.max(1, pitch || 1);
      const base = 523.25 * Math.pow(2, ((mult - 1) * 2) / 12);
      tone({ type: 'triangle', freq: base, dur: 0.09, vol: 0.25 });
      tone({ type: 'triangle', freq: base * 1.5, dur: 0.14, vol: 0.25, delay: 0.07 });
    },

    // Coin pickup: classic two-note sine ping, high and bright.
    coin() {
      tone({ type: 'sine', freq: 1318, dur: 0.07, vol: 0.18 });
      tone({ type: 'sine', freq: 1760, dur: 0.16, vol: 0.18, delay: 0.07 });
    },

    // War horn: two detuned saws a major third apart, lowpassed.
    horn() {
      tone({ type: 'sawtooth', freq: 220, dur: 0.45, vol: 0.16, attack: 0.03 });
      tone({ type: 'sawtooth', freq: 277, dur: 0.45, vol: 0.14, attack: 0.03 });
      tone({ type: 'sawtooth', freq: 110, dur: 0.45, vol: 0.12, attack: 0.03 });
    },

    // Heavy thud: low sine drop + a touch of low noise.
    thud() {
      tone({ type: 'sine', freq: 95, freqEnd: 48, dur: 0.16, vol: 0.4 });
      noise({ dur: 0.1, vol: 0.12, filterType: 'lowpass', freq: 300 });
    },

    // Backfire: descending saw snarl + a hiss.
    backfire() {
      tone({ type: 'sawtooth', freq: 320, freqEnd: 75, dur: 0.35, vol: 0.22 });
      noise({ dur: 0.3, vol: 0.14, filterType: 'bandpass', freq: 1800, freqEnd: 500, q: 2 });
    },

    // Fizzle: highpassed noise fizzing out, with a little crackle.
    fizzle() {
      noise({ dur: 0.6, vol: 0.16, filterType: 'highpass', freq: 2500, freqEnd: 900 });
      crackle(6, 0.5, 0.08, 4000);
    },

    // Shield break: inharmonic metallic clang + bright noise shard.
    shield_break() {
      tone({ type: 'square', freq: 1240, dur: 0.12, vol: 0.14 });
      tone({ type: 'square', freq: 1720, dur: 0.1, vol: 0.1, delay: 0.02 });
      tone({ type: 'triangle', freq: 830, freqEnd: 410, dur: 0.22, vol: 0.16 });
      noise({ dur: 0.18, vol: 0.14, filterType: 'highpass', freq: 3000 });
    },

    // Lit fuse: a run of sharp crackle ticks, no tonal body.
    fuse() {
      crackle(9, 0.35, 0.12, 3200);
    },

    // --- Per-character barks --------------------------------------
    // Cinderling: high quick squeak, twice.
    cinderling() {
      tone({ type: 'sine', freq: 1450, freqEnd: 2050, dur: 0.08, vol: 0.16 });
      tone({ type: 'sine', freq: 1600, freqEnd: 2200, dur: 0.07, vol: 0.13, delay: 0.09 });
    },

    // Torchbearer: low saw growl with a slow wobble.
    torchbearer() {
      tone({ type: 'sawtooth', freq: 95, freqEnd: 70, dur: 0.5, vol: 0.22, attack: 0.05 });
      tone({ type: 'sawtooth', freq: 142, freqEnd: 105, dur: 0.5, vol: 0.14, attack: 0.05 });
      noise({ dur: 0.4, vol: 0.08, filterType: 'lowpass', freq: 400 });
    },

    // Ironhide: metallic clang — square partials, fast decay.
    ironhide() {
      tone({ type: 'square', freq: 520, dur: 0.28, vol: 0.18 });
      tone({ type: 'square', freq: 781, dur: 0.22, vol: 0.12 });
      tone({ type: 'triangle', freq: 1244, dur: 0.18, vol: 0.1 });
      noise({ dur: 0.08, vol: 0.1, filterType: 'bandpass', freq: 2500, q: 6 });
    },

    // Saboteur: mischievous giggle — five quick notes, up-down-up.
    saboteur() {
      const notes = [920, 1240, 1010, 1420, 1120];
      notes.forEach(function (f, i) {
        tone({ type: 'sine', freq: f, dur: 0.06, vol: 0.15, delay: i * 0.07 });
      });
    },

    // Titan: deep stomp boom — sub drop, long tail, felt not heard.
    titan() {
      tone({ type: 'sine', freq: 65, freqEnd: 28, dur: 0.7, vol: 0.55 });
      noise({ dur: 0.5, vol: 0.2, filterType: 'lowpass', freq: 220, freqEnd: 60 });
    },

    // Wren (Captain): commanding two-note call, mid-high triangle.
    wren() {
      tone({ type: 'triangle', freq: 660, dur: 0.12, vol: 0.22 });
      tone({ type: 'triangle', freq: 880, dur: 0.18, vol: 0.22, delay: 0.12 });
    },

    // Pip: tiny chirp — one very short high sine sweep.
    pip() {
      tone({ type: 'sine', freq: 1850, freqEnd: 2450, dur: 0.06, vol: 0.14 });
    },

    // Thom: low grunt — short square drop.
    thom() {
      tone({ type: 'square', freq: 130, freqEnd: 82, dur: 0.18, vol: 0.2, attack: 0.02 });
      tone({ type: 'sine', freq: 90, freqEnd: 60, dur: 0.16, vol: 0.18, attack: 0.02 });
    },

    // Mira: brass clank — detuned saws + metallic ping.
    mira() {
      tone({ type: 'sawtooth', freq: 440, dur: 0.2, vol: 0.14 });
      tone({ type: 'sawtooth', freq: 466, dur: 0.2, vol: 0.14 });
      tone({ type: 'triangle', freq: 1175, dur: 0.12, vol: 0.12 });
    },
  };

  // ------------------------------------------------------------------
  // Ambient bed: looped wind noise (lowpassed, slow LFO swell) plus
  // bird chirps scheduled from update() on the seeded rng.
  // ------------------------------------------------------------------
  function startWind() {
    if (!ctx || !ambientGain || !noiseBuffer || windNodes) return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 420;
      filter.Q.value = 0.4;
      const gain = ctx.createGain();
      gain.gain.value = 0.05;
      // Slow swell LFO on the wind gain: 0.07 Hz, gentle.
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.07;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.025;
      lfo.connect(lfoGain);
      lfoGain.connect(gain.gain);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(ambientGain);
      src.start();
      lfo.start();
      windNodes = { src, filter, lfo, lfoGain, gain };
    } catch (err) {
      windNodes = null;
    }
  }

  function stopWind() {
    if (!windNodes) return;
    try {
      windNodes.src.stop();
      windNodes.lfo.stop();
      windNodes.src.disconnect();
      windNodes.lfo.disconnect();
      windNodes.gain.disconnect();
    } catch (err) {
      // Already stopped; ignore.
    }
    windNodes = null;
  }

  function birdChirp() {
    if (!ctx || !ambientGain) return;
    // Two or three quick descending chirps, pitch jittered by the
    // internal rng (audio-only; never leaks into the sim).
    const base = 2400 + rng() * 800;
    const count = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < count; i += 1) {
      const f = base * (1 - i * 0.08) * (0.95 + rng() * 0.1);
      tone({ type: 'sine', freq: f, freqEnd: f * 1.15, dur: 0.07, vol: 0.07, delay: i * 0.11 });
    }
  }

  // ------------------------------------------------------------------
  // Adaptive music pad: 2-3 detuned triangle oscillators on a slow
  // chord, per mood. Quiet by design (music gain ~0.05).
  // ------------------------------------------------------------------
  const MOODS = {
    calm: {
      chord: [261.63, 329.63, 392.0], // C major, warm
      level: 0.045,
      pulseHz: 0.1,
      pulseDepth: 0.015,
      arp: null,
    },
    tense: {
      chord: [220.0, 261.63, 329.63], // A minor, low
      level: 0.055,
      pulseHz: 2.2, // faster pulse = urgency
      pulseDepth: 0.02,
      arp: null,
    },
    victory: {
      chord: [261.63, 329.63, 392.0, 493.88], // C major 7, bright
      level: 0.05,
      pulseHz: 0.15,
      pulseDepth: 0.012,
      arp: [523.25, 659.25, 783.99, 987.77, 1046.5], // C5 E5 G5 B5 C6
    },
  };

  function stopMusic() {
    if (!musicNodes) return;
    try {
      musicNodes.oscs.forEach(function (osc) {
        try { osc.stop(); } catch (err) { /* already stopped */ }
        try { osc.disconnect(); } catch (err) { /* already gone */ }
      });
      try { musicNodes.lfo.stop(); } catch (err) { /* already stopped */ }
      try { musicNodes.lfo.disconnect(); } catch (err) { /* already gone */ }
      try { musicNodes.lfoGain.disconnect(); } catch (err) { /* already gone */ }
      musicNodes.gains.forEach(function (g) {
        try { g.disconnect(); } catch (err) { /* already gone */ }
      });
    } catch (err) {
      // Ignore teardown errors.
    }
    musicNodes = null;
    arpTimer = 0;
    arpIndex = 0;
  }

  function startMusic(mood) {
    if (!ctx || !musicGain) return;
    const spec = MOODS[mood];
    if (!spec) return;
    try {
      const oscs = [];
      const gains = [];
      spec.chord.slice(0, 3).forEach(function (freq, i) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        // Slight detune on the middle voice for warmth.
        osc.frequency.value = freq * (i === 1 ? 1.003 : 1);
        const g = ctx.createGain();
        g.gain.value = spec.level;
        osc.connect(g);
        g.connect(musicGain);
        osc.start();
        oscs.push(osc);
        gains.push(g);
      });
      // Pulse LFO on the music bus gain: slow swell (calm/victory)
      // or a faster heartbeat (tense).
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = spec.pulseHz;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = spec.pulseDepth;
      lfo.connect(lfoGain);
      lfoGain.connect(musicGain.gain);
      lfo.start();
      musicNodes = { oscs, gains, lfo, lfoGain };
    } catch (err) {
      musicNodes = null;
    }
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------
  function unlock() {
    try {
      if (ctx) {
        if (ctx.state === 'suspended') {
          const p = ctx.resume();
          if (p && typeof p.catch === 'function') p.catch(function () {});
        }
        return;
      }
      const AC =
        (typeof window !== 'undefined' &&
          (window.AudioContext || window.webkitAudioContext)) ||
        (typeof self !== 'undefined' && (self.AudioContext || self.webkitAudioContext)) ||
        null;
      if (!AC) return; // very old browser / headless: fail soft
      ctx = new AC();
      masterGain = ctx.createGain();
      masterGain.gain.value = muted ? 0 : MASTER_LEVEL;
      masterGain.connect(ctx.destination);
      sfxGain = ctx.createGain();
      sfxGain.gain.value = 0.9;
      sfxGain.connect(masterGain);
      musicGain = ctx.createGain();
      musicGain.gain.value = 1;
      musicGain.connect(masterGain);
      ambientGain = ctx.createGain();
      ambientGain.gain.value = 0.9;
      ambientGain.connect(masterGain);
      noiseBuffer = makeNoiseBuffer();
      if (ctx.state === 'suspended') {
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
      // Re-attach anything requested before unlock.
      if (ambientOn) startWind();
      if (musicMood !== 'off') startMusic(musicMood);
    } catch (err) {
      ctx = null; // stay silent; every method guards on ctx
    }
  }

  function setMuted(m) {
    muted = !!m;
    try {
      if (masterGain && ctx) {
        masterGain.gain.setTargetAtTime(muted ? 0 : MASTER_LEVEL, ctx.currentTime, 0.02);
      }
    } catch (err) {
      // Ignore.
    }
  }

  function isMuted() {
    return muted;
  }

  function play(name, opts) {
    try {
      if (muted || !ctx || ctx.state !== 'running') return;
      if (typeof name !== 'string') return;
      const fn = SOUNDS[name];
      if (!fn) return; // unknown name: silent no-op
      const o = opts || {};
      const pitch = typeof o.pitch === 'number' && isFinite(o.pitch) ? o.pitch : 1;
      const vol = typeof o.volume === 'number' && isFinite(o.volume) ? o.volume : 1;
      if (vol <= 0) return;
      callVol = Math.max(0, Math.min(2, vol));
      try {
        fn(pitch);
      } finally {
        callVol = 1;
      }
    } catch (err) {
      // Never throw from a one-shot.
    }
  }

  function startAmbient() {
    ambientOn = true;
    try {
      startWind();
    } catch (err) {
      // Fail soft.
    }
  }

  function stopAmbient() {
    ambientOn = false;
    try {
      stopWind();
    } catch (err) {
      // Fail soft.
    }
  }

  function setMusicMood(mood) {
    try {
      const next = mood === 'calm' || mood === 'tense' || mood === 'victory' ? mood : 'off';
      if (next === musicMood && musicNodes) return;
      musicMood = next;
      stopMusic();
      if (next !== 'off') startMusic(next);
    } catch (err) {
      // Fail soft.
    }
  }

  function update(dt) {
    try {
      if (!ctx || ctx.state !== 'running') return;
      const step = typeof dt === 'number' && isFinite(dt) && dt > 0 ? dt : 0;
      if (step <= 0) return;
      // Ambient bird chirps on the seeded schedule.
      if (ambientOn && windNodes) {
        chirpTimer -= step;
        if (chirpTimer <= 0) {
          birdChirp();
          chirpTimer = 6 + rng() * 14; // 6–20 s between chirps
        }
      }
      // Victory arpeggio: retune the top pad voice through a bright
      // major run, one step every 0.45 s.
      if (musicMood === 'victory' && musicNodes && MOODS.victory.arp) {
        arpTimer += step;
        if (arpTimer >= 0.45) {
          arpTimer = 0;
          const notes = MOODS.victory.arp;
          const f = notes[arpIndex % notes.length];
          arpIndex += 1;
          const top = musicNodes.oscs[musicNodes.oscs.length - 1];
          if (top) {
            try {
              top.frequency.setTargetAtTime(f, ctx.currentTime, 0.05);
            } catch (err) {
              // Ignore retune errors.
            }
          }
        }
      }
    } catch (err) {
      // update() must never throw.
    }
  }

  return {
    unlock,
    setMuted,
    isMuted,
    // Diagnostic (read-only): the AudioContext state, so a headless probe can
    // prove the context was actually running (tones scheduled), not merely
    // that play() was called. ROUND 3 (item 13).
    state: () => (ctx ? ctx.state : 'none'),
    play,
    startAmbient,
    stopAmbient,
    setMusicMood,
    update,
  };
}
