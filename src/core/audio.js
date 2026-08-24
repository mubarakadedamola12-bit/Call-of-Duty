// Fully procedural sound: no audio files. Every effect is synthesised from
// noise buffers, oscillators and filters, through a shared reverb bus.

export class Audio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.masterVol = 0.55;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.masterVol;

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.knee.value = 22;
    this.comp.ratio.value = 8;
    this.comp.attack.value = 0.002;
    this.comp.release.value = 0.22;

    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);

    // Reverb: synthesised impulse (open desert / metal yard slap).
    this.verb = ctx.createConvolver();
    this.verb.buffer = this._impulse(1.9, 3.2);
    this.verbGain = ctx.createGain();
    this.verbGain.gain.value = 0.30;
    this.verb.connect(this.verbGain);
    this.verbGain.connect(this.master);

    // Noise sources reused everywhere.
    this.noise = this._noiseBuffer(2.0);
    this.pinkish = this._noiseBuffer(2.0, true);

    this._startAmbience();
    this.ready = true;
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  _noiseBuffer(seconds, pink = false) {
    const ctx = this.ctx;
    const n = (ctx.sampleRate * seconds) | 0;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (pink) {
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
      } else d[i] = w;
    }
    return buf;
  }

  _impulse(seconds, decay) {
    const ctx = this.ctx;
    const n = (ctx.sampleRate * seconds) | 0;
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        // Sparse early reflections over a smooth exponential tail.
        const tail = Math.pow(1 - t, decay);
        let s = (Math.random() * 2 - 1) * tail;
        if (i < ctx.sampleRate * 0.09 && Math.random() < 0.0016) s += (Math.random() * 2 - 1) * 0.9;
        d[i] = s;
      }
    }
    return buf;
  }

  _src(buffer, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    s.playbackRate.value = rate;
    return s;
  }

  /** Build a 3D-ish output chain: distance gain + stereo pan + reverb send. */
  _out(opts = {}) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const pan = ctx.createStereoPanner();
    pan.pan.value = opts.pan || 0;
    g.connect(pan);
    pan.connect(this.master);
    if (opts.verb !== 0) {
      const send = ctx.createGain();
      send.gain.value = opts.verb === undefined ? 0.30 : opts.verb;
      pan.connect(send);
      send.connect(this.verb);
    }
    if (opts.distance !== undefined && opts.distance > 0) {
      // Air absorption: distant shots lose their top end.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.max(700, 19000 - opts.distance * 330);
      g.disconnect();
      g.connect(lp);
      lp.connect(pan);
    }
    return g;
  }

  /* ------------------------------------------------------------- weapons */

  gunshot(profile = {}, spatial = {}) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const {
      body = 150, crack = 2600, dur = 0.30, punch = 1.0, tail = 0.55, supp = 0,
    } = profile;
    const dist = spatial.distance || 0;
    const distGain = 1 / (1 + dist * 0.085);
    const out = this._out({ pan: spatial.pan || 0, distance: dist, verb: 0.24 + Math.min(dist, 30) * 0.010 });
    out.gain.value = (spatial.gain === undefined ? 1 : spatial.gain) * distGain;
    out.connect(this.master);

    // 1. Transient crack — short filtered white noise.
    const n1 = this._src(this.noise, 1 + Math.random() * 0.1);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(crack * (supp ? 0.45 : 1), t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(220, crack * 0.22), t + dur * 0.7);
    bp.Q.value = 0.75;
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0, t);
    g1.gain.linearRampToValueAtTime(1.15 * punch * (supp ? 0.4 : 1), t + 0.0016);
    g1.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    n1.connect(bp); bp.connect(g1); g1.connect(out);
    n1.start(t); n1.stop(t + dur + 0.05);

    // 2. Low-end thump — pitch-dropping sine gives the chest punch.
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(body * 2.1, t);
    o.frequency.exponentialRampToValueAtTime(body * 0.42, t + 0.16);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.95 * punch, t);
    g2.gain.exponentialRampToValueAtTime(0.0008, t + 0.20);
    o.connect(g2); g2.connect(out);
    o.start(t); o.stop(t + 0.25);

    // 3. Mechanical action clack.
    const n3 = this._src(this.noise, 1.6);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 2400;
    const g3 = ctx.createGain();
    g3.gain.setValueAtTime(0.30, t + 0.012);
    g3.gain.exponentialRampToValueAtTime(0.0006, t + 0.075);
    n3.connect(hp); hp.connect(g3); g3.connect(out);
    n3.start(t + 0.012); n3.stop(t + 0.1);

    // 4. Tail — the environment answering back.
    if (tail > 0.01) {
      const n4 = this._src(this.pinkish, 0.85);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(3800, t);
      lp.frequency.exponentialRampToValueAtTime(500, t + 0.55);
      const g4 = ctx.createGain();
      g4.gain.setValueAtTime(0.0001, t);
      g4.gain.linearRampToValueAtTime(0.24 * tail * punch, t + 0.020);
      g4.gain.exponentialRampToValueAtTime(0.0004, t + 0.62);
      n4.connect(lp); lp.connect(g4); g4.connect(out);
      n4.start(t); n4.stop(t + 0.7);
    }
  }

  /** Supersonic crack as a round passes near the player. */
  whiz(pan = 0, close = 1) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._out({ pan, verb: 0.08 });
    out.gain.value = 0.42 * close;
    const n = this._src(this.noise, 1.4);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(5200, t);
    bp.frequency.exponentialRampToValueAtTime(1100, t + 0.13);
    bp.Q.value = 2.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(1, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.16);
    n.connect(bp); bp.connect(g); g.connect(out);
    n.start(t); n.stop(t + 0.2);
  }

  impact(kind = 'hard', pan = 0, distance = 0) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._out({ pan, distance, verb: 0.18 });
    out.gain.value = 0.55 / (1 + distance * 0.12);
    const n = this._src(this.noise, kind === 'metal' ? 1.5 : 1.0);
    const f = ctx.createBiquadFilter();
    if (kind === 'metal') { f.type = 'bandpass'; f.frequency.value = 3400; f.Q.value = 3.2; }
    else if (kind === 'flesh') { f.type = 'lowpass'; f.frequency.value = 900; }
    else { f.type = 'bandpass'; f.frequency.value = 1500; f.Q.value = 1.1; }
    const g = ctx.createGain();
    const d = kind === 'metal' ? 0.28 : 0.11;
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + d);
    n.connect(f); f.connect(g); g.connect(out);
    n.start(t); n.stop(t + d + 0.05);
    if (kind === 'metal') {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(1800 + Math.random() * 900, t);
      o.frequency.exponentialRampToValueAtTime(700, t + 0.25);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.20, t);
      g2.gain.exponentialRampToValueAtTime(0.0004, t + 0.28);
      o.connect(g2); g2.connect(out);
      o.start(t); o.stop(t + 0.3);
    }
  }

  explosion(distance = 0, pan = 0) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._out({ pan, distance, verb: 0.55 });
    out.gain.value = 1.5 / (1 + distance * 0.05);
    const n = this._src(this.pinkish, 0.55);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5200, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + 1.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1.4, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 1.3);
    n.connect(lp); lp.connect(g); g.connect(out);
    n.start(t); n.stop(t + 1.4);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(24, t + 0.6);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(1.6, t);
    g2.gain.exponentialRampToValueAtTime(0.0006, t + 0.75);
    o.connect(g2); g2.connect(out);
    o.start(t); o.stop(t + 0.8);
  }

  /* -------------------------------------------------------------- foley */

  click(freq = 2000, gain = 0.30, dur = 0.045, type = 'square') {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._out({ verb: 0.10 });
    out.gain.value = gain;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.55, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.8, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    const n = this._src(this.noise, 2);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1800;
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.55, t);
    gn.gain.exponentialRampToValueAtTime(0.0004, t + dur * 0.8);
    o.connect(g); g.connect(out);
    n.connect(hp); hp.connect(gn); gn.connect(out);
    o.start(t); o.stop(t + dur + 0.02);
    n.start(t); n.stop(t + dur + 0.02);
  }

  /** Magazine out / in / bolt — a small scripted sequence. */
  reload(stage) {
    if (!this.ready) return;
    if (stage === 'out') { this.click(700, 0.30, 0.09, 'square'); setTimeout(() => this.click(420, 0.22, 0.12, 'triangle'), 70); }
    else if (stage === 'in') { this.click(560, 0.34, 0.07); setTimeout(() => this.click(1100, 0.28, 0.05), 55); }
    else if (stage === 'bolt') { this.click(1500, 0.32, 0.06); setTimeout(() => this.click(900, 0.30, 0.09), 60); }
  }

  footstep(speed = 1, pan = 0) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._out({ pan, verb: 0.16 });
    out.gain.value = 0.16 * speed;
    const n = this._src(this.noise, 0.6 + Math.random() * 0.4);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 320 + Math.random() * 260;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + 0.11);
    n.connect(bp); bp.connect(g); g.connect(out);
    n.start(t); n.stop(t + 0.14);
  }

  shell(pan = 0) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.28 + Math.random() * 0.12;
    const out = this._out({ pan, verb: 0.20 });
    out.gain.value = 0.10;
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      const tt = t + i * (0.05 + Math.random() * 0.05);
      o.frequency.setValueAtTime(2600 + Math.random() * 1800, tt);
      o.frequency.exponentialRampToValueAtTime(1400, tt + 0.05);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.6 / (i + 1), tt);
      g.gain.exponentialRampToValueAtTime(0.0004, tt + 0.06);
      o.connect(g); g.connect(out);
      o.start(tt); o.stop(tt + 0.08);
    }
  }

  /* ----------------------------------------------------------------- UI */

  hitmarker(head = false) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._out({ verb: 0 });
    out.gain.value = head ? 0.30 : 0.20;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(head ? 2100 : 1500, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0004, t + (head ? 0.09 : 0.05));
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + 0.12);
  }

  tone(freqs, dur = 0.16, gain = 0.22, type = 'sine') {
    if (!this.ready) return;
    const ctx = this.ctx;
    freqs.forEach((f, i) => {
      const t = ctx.currentTime + i * dur * 0.7;
      const out = this._out({ verb: 0.12 });
      out.gain.value = gain;
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f, t);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.7, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + dur + 0.05);
    });
  }

  killConfirm() { this.tone([880, 1320], 0.13, 0.20, 'triangle'); }
  levelUp() { this.tone([523, 659, 784, 1047], 0.18, 0.18, 'triangle'); }
  deathSting() { this.tone([220, 165, 110], 0.42, 0.24, 'sawtooth'); }
  uiClick() { this.click(1400, 0.14, 0.03); }

  /** Wind bed + distant rumble, always running. */
  _startAmbience() {
    const ctx = this.ctx, t = ctx.currentTime;
    const n = this._src(this.pinkish, 0.30);
    n.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 520;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 380; bp.Q.value = 0.4;
    const g = ctx.createGain();
    g.gain.value = 0.055;
    n.connect(lp); lp.connect(bp); bp.connect(g); g.connect(this.master);
    n.start(t);
    this.windGain = g;
    this.windFilter = lp;

    // Slow LFO on the wind so it breathes.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 0.062;
    const lg = ctx.createGain(); lg.gain.value = 0.028;
    lfo.connect(lg); lg.connect(g.gain);
    lfo.start(t);
  }

  setMasterVolume(v) {
    this.masterVol = v;
    if (this.master) this.master.gain.value = v;
  }
}
