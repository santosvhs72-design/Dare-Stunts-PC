import { clamp } from '../core/math.js';
import { SLIP_WARN } from './car.js';

const MUTE_KEY = 'velocidadecega.mute';

// The moment grip goes.
//
// The tyre scrub layer below rises smoothly with slip, so a big slide is loud
// and a small one is almost nothing -- which says how far gone the car is but
// never says when it started, and the start is the part a driver has to react
// to. So the crossing gets a chirp of its own, on the same threshold that turns
// the speedo red (SLIP_WARN).
//
// It needs hysteresis and a gap: a car balanced on the limit crosses the
// threshold many times a second, and a cue that machine-guns is noise. It also
// needs speed, because on a banked or looping surface a stationary car reads as
// sliding -- gravity pulls it sideways and there is no cornering to speak of.
const SLIP_OFF = 0.18;   // slip must fall back below this before it can fire again
const SLIP_GAP = 0.45;   // seconds between chirps
const SLIP_KMH = 25;     // below this it is not a corner, it is a car standing still

const read = () => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } };
const write = m => { try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch { /* private mode */ } };

// Everything here is synthesised at runtime: no audio files to ship or load.
export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = read();
    this.wallSeen = 0;
    this.landSeen = 0;
    this.slipping = false;
    this.slipAt = -1e9;
  }

  // Browsers only allow an AudioContext to start from a user gesture.
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.build();
    } catch {
      this.ctx = null;
    }
  }

  get ready() { return this.ctx && this.ctx.state === 'running'; }

  setMuted(m) {
    this.muted = m;
    write(m);
    if (this.master) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.04);
    }
  }

  build() {
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(ctx.destination);

    const len = Math.floor(ctx.sampleRate * 2);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Engine: stacked detuned saws through a lowpass that opens with the revs.
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineLp = ctx.createBiquadFilter();
    this.engineLp.type = 'lowpass';
    this.engineLp.frequency.value = 600;
    this.engineLp.Q.value = 1.1;
    this.engineGain.connect(this.engineLp);
    this.engineLp.connect(this.master);

    this.oscs = [];
    for (const [type, mul, gain, detune] of [
      ['sawtooth', 1, 0.50, 0],
      ['sawtooth', 0.5, 0.40, 7],
      ['sawtooth', 1.5, 0.16, -5],
      ['square', 2, 0.10, 4],
    ]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g);
      g.connect(this.engineGain);
      o.start();
      this.oscs.push({ o, mul });
    }
    this.loopNoise(240, 0.9, 0.22, this.engineGain, 'bandpass');

    // Wind rush, so speed is audible even off the throttle.
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windLp = ctx.createBiquadFilter();
    this.windLp.type = 'lowpass';
    this.windLp.frequency.value = 500;
    this.windGain.connect(this.windLp);
    this.windLp.connect(this.master);
    this.loopNoise(0, 0, 1, this.windGain);

    // Tyre scrub, driven by the same slip value the speedo colour uses.
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealGain.connect(this.master);
    this.squealBp = this.loopNoise(1750, 5.5, 1, this.squealGain, 'bandpass');
  }

  loopNoise(freq, q, gain, dest, type) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    let node = src;
    let filter = null;
    if (type) {
      filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      filter.Q.value = q;
      src.connect(filter);
      node = filter;
    }
    const g = ctx.createGain();
    g.gain.value = gain;
    node.connect(g);
    g.connect(dest);
    src.start();
    return filter;
  }

  tone(freq, dur, { type = 'sine', vol = 0.3, to = null, delay = 0 } = {}) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  thump(dur, freq, q, vol) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(freq, t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.35), t + dur);
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  countdown(n) {
    if (n > 0) this.tone(560, 0.18, { type: 'square', vol: 0.16 });
    else this.tone(940, 0.42, { type: 'square', vol: 0.2 });
  }

  // Feedback for moving the highlight in a menu or along a rail: felt more
  // than heard. tone()'s fixed 15 ms attack is built for a chime, and a chime
  // is wrong for a click -- held to scroll a long list, it has to disappear
  // into one continuous texture rather than read as a string of separate
  // notes, so the attack here is a couple of milliseconds and the whole
  // sound is over before the next repeat (130 ms, see TvInput's HOLD_NEXT)
  // could ever overlap it.
  tick() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(1600, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.10, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.05);
  }

  checkpoint() {
    this.tone(880, 0.12, { type: 'triangle', vol: 0.18 });
    this.tone(1320, 0.26, { type: 'triangle', vol: 0.16, delay: 0.09 });
  }

  finish(record) {
    const notes = record ? [660, 880, 1100, 1320] : [880, 660, 550];
    notes.forEach((f, i) => this.tone(f, 0.4, { type: 'triangle', vol: 0.17, delay: i * 0.13 }));
  }

  crash() {
    this.thump(0.7, 420, 0.7, 0.5);
    this.tone(190, 0.6, { type: 'sawtooth', vol: 0.22, to: 55 });
  }

  wallHit(force) {
    const v = clamp(force / 12, 0.12, 1);
    this.thump(0.16 + v * 0.2, 900, 1.6, 0.28 * v);
    this.tone(120, 0.2, { type: 'square', vol: 0.16 * v, to: 70 });
  }

  landing(force) {
    const v = clamp(force / 18, 0.08, 1);
    if (v < 0.12) return;
    this.thump(0.2, 260, 1.1, 0.3 * v);
  }

  // A tyre letting go: a scrub that rises as the slide breaks away and falls
  // back as it settles. Noise through a tight bandpass is what a squeal is; the
  // tone under it only gives the chirp a centre a television speaker can carry,
  // since most of them have nothing below a few hundred hertz.
  slipChirp(v) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const dur = 0.24 + v * 0.22;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 8;
    bp.frequency.setValueAtTime(1150, t);
    bp.frequency.exponentialRampToValueAtTime(2100, t + dur * 0.35);
    bp.frequency.exponentialRampToValueAtTime(1500, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.17 + 0.17 * v, t + 0.035);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
    this.tone(720, dur * 0.75, { type: 'triangle', vol: 0.05 + 0.05 * v, to: 940 });
  }

  // Per-frame continuous layers.
  update(st) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const on = st.active ? 1 : 0;

    const f = 40 + st.rpm * 150;
    for (const { o, mul } of this.oscs) o.frequency.setTargetAtTime(f * mul, t, 0.045);

    const load = 0.4 + 0.6 * st.throttle;
    this.engineGain.gain.setTargetAtTime(on * 0.15 * load, t, 0.05);
    this.engineLp.frequency.setTargetAtTime(400 + st.rpm * 2400 + st.throttle * 800, t, 0.06);

    const sp = clamp(st.speedKmh / 230, 0, 1);
    this.windGain.gain.setTargetAtTime(on * 0.13 * sp * sp, t, 0.08);
    this.windLp.frequency.setTargetAtTime(320 + st.speedKmh * 5.5, t, 0.1);

    this.squealGain.gain.setTargetAtTime(on * 0.15 * clamp(st.squeal, 0, 1), t, 0.04);
    if (this.squealBp) this.squealBp.frequency.setTargetAtTime(1500 + sp * 900, t, 0.1);

    // Rising edge of a slide. st.slip is already zero unless the car is on the
    // road, so a jump and the moment after a crash cannot chirp.
    const slip = clamp(st.slip || 0, 0, 1);
    if (!st.active || slip < SLIP_OFF || st.speedKmh < SLIP_KMH) {
      this.slipping = false;
    } else if (slip > SLIP_WARN && !this.slipping && t - this.slipAt > SLIP_GAP) {
      this.slipping = true;
      this.slipAt = t;
      this.slipChirp(clamp((slip - SLIP_WARN) / (1 - SLIP_WARN), 0, 1));
    }
  }

  // Fires the one-shots the car has queued since the last call.
  follow(car) {
    if (car.wallHits !== this.wallSeen) {
      this.wallSeen = car.wallHits;
      this.wallHit(car.wallForce);
    }
    if (car.landings !== this.landSeen) {
      this.landSeen = car.landings;
      this.landing(car.landForce);
    }
  }
}
