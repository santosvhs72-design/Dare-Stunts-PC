import { Renderer } from '../core/renderer.js';
import { buildTrack } from '../world/track.js';
import { buildSky, buildGround, buildScenery, skyFogColor, skyAmbient } from '../world/scenery.js';
import { Car, MODE, gearFor } from './car.js';
import { CARS } from './cars.js';
import { Hud, formatTime } from './hud.js';
import { clamp, quat, v3 } from '../core/math.js';
import { GhostRecorder, GhostPlayer, buildGhostMesh, ghostModelMatrix,
         loadGhost, saveGhost, clearGhost, lapSlice,
         GHOST_ALPHA, GHOST_AMBIENT } from './ghost.js';
import { profileKey } from '../ui/profiles.js';

const bestKey = id => profileKey(`best.${id}`);
const carBestKey = id => profileKey(`carbest.${id}`);

// Records are per track, not per car: picking the right car for the circuit is
// part of the game, so the record names the car that set it. Older records were
// stored as a bare number, and those are real user data worth keeping.
export function getBest(id) {
  let v = null;
  try { v = localStorage.getItem(bestKey(id)); } catch { return null; }
  if (v == null) return null;
  if (/^\d+$/.test(v)) return { ms: Number(v), car: null };
  try { return JSON.parse(v); } catch { return null; }
}

// The overall record names its car, but says nothing about how the other two
// would have done -- and picking the right car for a circuit is half the
// game. One best time per car, alongside the single overall one, so a lap
// with the Slow Hand can be judged against your own previous laps with it,
// not just against whichever car happens to hold the track outright.
export function getCarBests(id) {
  try {
    const v = JSON.parse(localStorage.getItem(carBestKey(id)));
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

export function getCarBest(id, carId) {
  const ms = getCarBests(id)[carId];
  return ms != null ? { ms } : null;
}

function saveCarBest(id, carId, ms) {
  const all = getCarBests(id);
  const rounded = Math.round(ms);
  if (all[carId] != null && all[carId] <= rounded) return;
  all[carId] = rounded;
  try { localStorage.setItem(carBestKey(id), JSON.stringify(all)); } catch { /* private mode */ }
}

// Wiping a record means every shape it comes in: the overall time, the
// per-car times, and the lap that set the overall one. Leaving the ghost
// behind would put a car on the road with nothing to compare it against, and
// loadGhostFor would then keep it forever -- it only discards a ghost that is
// *slower* than a stored record, and there would be none.
export function clearRecord(id) {
  try {
    localStorage.removeItem(bestKey(id));
    localStorage.removeItem(carBestKey(id));
  } catch { /* ignore */ }
  clearGhost(id);
}

function saveBest(id, ms, car) {
  try {
    localStorage.setItem(bestKey(id), JSON.stringify({ ms: Math.round(ms), car }));
  } catch { /* private mode */ }
}

export const STATE = {
  IDLE: 'idle', COUNTDOWN: 'countdown', RACING: 'racing',
  PAUSED: 'paused', FINISHED: 'finished', REPLAY: 'replay',
};

// How many times round a circuit, when the track itself does not say.
export const DEFAULT_LAPS = 3;

// How many times round, chosen per track and kept per profile. Only a circuit
// has any say in this; a sprint is one run of the course and always was.
export const LAP_CHOICES = [1, 2, 3, 5, 10];
const lapsKey = id => profileKey(`laps.${id}`);

export function getLaps(id) {
  let v = null;
  try { v = Number(localStorage.getItem(lapsKey(id))); } catch { return DEFAULT_LAPS; }
  return LAP_CHOICES.includes(v) ? v : DEFAULT_LAPS;
}

export function setLaps(id, n) {
  try { localStorage.setItem(lapsKey(id), String(n)); } catch { /* private mode */ }
}

// How the replay camera sits behind the car: back and up in the car's own
// frame (so it banks and dips with the road exactly as the car does), tilted
// down a little so the car sits in frame rather than at the bottom edge.
const REPLAY_BACK = 6.5;
const REPLAY_UP = 2.3;
const REPLAY_TILT = 0.22;   // rad, pitched down
const REPLAY_FOV = 62;

export class Game {
  constructor(glCanvas, hudCanvas, input, sound = null) {
    this.renderer = new Renderer(glCanvas);
    this.hud = new Hud(hudCanvas);
    this.input = input;
    this.sound = sound;
    this.state = STATE.IDLE;
    this.car0 = CARS[1];   // selected model; the middle one by default
    this.chunks = { sky: null, ground: [], scenery: [], road: [], tunnel: [], gates: [] };
    this.msg = null;
    this.onFinish = () => {};
    // Laps are always recorded -- it costs nothing and a record set anywhere
    // should be raceable anywhere -- but the ghost is only drawn where the
    // interface asks for it, so the desktop game stays exactly as it was.
    this.showGhost = false;
    this.ghost = null;
    this.ghostChunk = null;
    this.ghostRec = null;
    this.ghostDelta = null;
    // The lap just finished, kept in memory (not storage) so it can be
    // watched back regardless of whether it set any record.
    this.lastLap = null;
    this.replay = null;
    this.replayChunk = null;
    this.replayTimeMs = 0;
    this.replayPose = null;
    this.replayPaused = false;
    this.lastTime = 0;
    this.fov = 70;
    this.raf = null;
  }

  load(def) {
    const r = this.renderer;
    for (const k of ['ground', 'scenery', 'road', 'tunnel', 'gates']) r.dispose(this.chunks[k]);
    if (this.chunks.sky) r.dispose([this.chunks.sky]);

    const track = buildTrack(def);
    this.track = track;
    // The fog has to match the sky's own horizon (see skyFogColor), or the
    // distance where scenery fades out shows as a seam against the sky behind
    // it -- so it is set here, once, rather than left at the renderer's
    // built-in default.
    r.fogColor = skyFogColor(def.sky);
    this.ambient = skyAmbient(def.sky);
    this.chunks = {
      sky: r.upload(buildSky(def.sky)),
      ground: buildGround(track.bounds).map(m => r.upload(m)),
      scenery: buildScenery(track).map(m => r.upload(m)),
      road: track.roadMeshes.map(m => r.upload(m)),
      tunnel: track.tunnelMeshes.map(m => r.upload(m)),
      gates: track.gateMeshes.map(m => r.upload(m)),
    };
    this.car = new Car(track, this.car0.phys);
    this.def = def;
    // A track that comes back to its own start is driven in laps; one that
    // does not is the single run it has always been.
    this.laps = track.closed ? Math.max(1, def.laps || DEFAULT_LAPS) : 1;
    this.best = getBest(def.id);
    this.loadGhostFor(def.id);
    this.restart();
  }

  loadGhostFor(id) {
    const r = this.renderer;
    if (this.ghostChunk) { r.dispose([this.ghostChunk]); this.ghostChunk = null; }
    this.ghost = null;
    const data = loadGhost(id);
    if (!data) return;
    // A ghost whose lap is slower than the stored record is stale -- the record
    // was set elsewhere, or the ghost failed to save -- so it is not shown.
    const best = getBest(id);
    if (best && data.ms > best.ms + 1) return;
    this.ghost = new GhostPlayer(data, this.track);
    const car = CARS.find(c => c.id === data.car);
    this.ghostChunk = r.upload(buildGhostMesh(car && car.theme.accent));
  }

  restart() {
    this.car.respawnS = 0;
    this.car.reset(0);
    this.timeMs = 0;
    this.cpIndex = 0;
    this.lap = 0;
    this.lapTimes = [];
    this.lapStart = 0;
    this.state = STATE.COUNTDOWN;
    this.countdown = 3.6;
    this.msg = null;
    this.finalTime = null;
    this.newRecord = false;
    this.lastBeep = null;
    this.ghostRec = new GhostRecorder(this.track);
    this.ghostDelta = null;
    if (this.ghost) this.ghost.reset();
  }

  setMessage(text, sub = '', color = '#ffb43a', time = 1.4) {
    this.msg = { text, sub, color, time };
  }

  pause() { if (this.state === STATE.RACING || this.state === STATE.COUNTDOWN) this.state = STATE.PAUSED; }
  resume() { if (this.state === STATE.PAUSED) this.state = this.countdown > 0 ? STATE.COUNTDOWN : STATE.RACING; }

  start() {
    if (this.raf) return;
    this.lastTime = performance.now();
    const tick = now => {
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - this.lastTime) / 1000);
      this.lastTime = now;
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  frame(dt) {
    const input = this.input.poll();
    const idle = { throttle: 0, brake: 0, steer: 0, handbrake: false };

    if (this.state === STATE.COUNTDOWN) {
      this.countdown -= dt;
      this.car.update(dt, idle);
      if (this.countdown <= 0) {
        this.state = STATE.RACING;
        this.setMessage('JÁ!', '', '#5fd894', 0.8);
      }
    } else if (this.state === STATE.RACING) {
      this.timeMs += dt * 1000;
      this.car.update(dt, input);
      this.ghostRec.sample(this.car, this.timeMs);
      this.updateGhostDelta();
      this.checkProgress();
    } else if (this.state === STATE.FINISHED) {
      this.car.update(dt, idle);
    } else if (this.state === STATE.REPLAY) {
      if (!this.replayPaused) {
        this.replayTimeMs += dt * 1000;
        let pose = this.replay.at(this.replayTimeMs);
        // The lap always ends before this runs out of samples, so reaching
        // the end means it is time to start it over, not stop rendering.
        if (!pose) { this.replayTimeMs = 0; this.replay.reset(); pose = this.replay.at(0); }
        this.replayPose = pose;
      }
    } else {
      this.car.updateCamera(dt);
    }

    if (this.msg) {
      this.msg.time -= dt;
      if (this.msg.time <= 0) this.msg = null;
    }

    this.render(dt);
  }

  // A co-driver's call: which way, and how urgently, the road ahead needs more
  // lock than it currently has. Judged the same way the editor's autopilot
  // judges a bend -- the grip this car actually has against the curvature
  // coming up -- so the cue agrees with what the car can hold, car for car,
  // rather than flagging every gentle bend at any speed.
  //
  // Only a corner already too tight for the current speed counts, and how far
  // off is blended with how close it is: a hairpin ten car-lengths back on a
  // straight is nothing yet, and the same bend once braking should already
  // have started is everything.
  cornerAhead() {
    const car = this.car;
    if (car.mode !== MODE.ROAD) return null;
    const absV = Math.max(Math.abs(car.v), 6);
    const ahead = Math.min(90, absV * 1.6 + 18);
    const grip = this.car0.phys.mu * 9.81;
    let best = null;
    for (let d = 8; d < ahead; d += 6) {
      const ahead = this.track.closed ? car.s + d : Math.min(car.s + d, this.track.length - 1);
      const g = this.track.frameAt(ahead);
      const k = Math.abs(g.kRight);
      if (k < 2e-4) continue;
      const vSafe = Math.sqrt(grip / k);
      if (vSafe >= absV * 1.08) continue;   // this bend is not a problem yet
      const overspeed = clamp((absV - vSafe) / absV, 0, 1);
      const closeness = 1 - d / ahead;
      const urgency = overspeed * 0.6 + closeness * 0.4;
      if (!best || urgency > best.urgency) best = { dir: g.kRight > 0 ? 'r' : 'l', urgency };
    }
    return best && best.urgency > 0.15 ? best : null;
  }

  // How far ahead or behind the record holder you are, in milliseconds:
  // positive means the ghost reached this point sooner, so you are losing.
  // On a circuit the ghost is a single lap, so the comparison is lap against
  // lap: how far into this lap the car is, against how long the ghost took to
  // get that far into its own.
  lapDistance() {
    return this.track.closed ? this.car.s - this.lap * this.track.length : this.car.s;
  }

  lapTime() {
    return this.track.closed ? this.timeMs - this.lapStart : this.timeMs;
  }

  updateGhostDelta() {
    if (!this.showGhost || !this.ghost) { this.ghostDelta = null; return; }
    const tg = this.ghost.timeAt(this.lapDistance());
    this.ghostDelta = tg == null ? null : this.lapTime() - tg;
  }

  checkProgress() {
    const car = this.car;
    const cps = this.track.checkpoints;
    // The car's distance never wraps -- only the track under it does (see
    // frameAt in world/track.js) -- so a lap is just how much of it has been
    // run off, and the checkpoints of this lap sit a lap's length further on
    // than the ones of the last.
    const len = this.track.length;
    const lapBase = this.lap * len;

    if (this.cpIndex < cps.length && car.s - lapBase >= cps[this.cpIndex]) {
      car.respawnS = Math.max(0, lapBase + cps[this.cpIndex] - 4);
      this.cpIndex++;
      this.setMessage('CHECKPOINT', `${this.cpIndex} / ${cps.length}`, '#5fd894', 1.1);
      if (this.sound) this.sound.checkpoint();
    }

    if (car.mode === MODE.CRASHED && !this.crashShown) {
      this.crashShown = true;
      this.setMessage('FORA!', car.crashReason || '', '#ff7a7a', 1.2);
      if (this.sound) this.sound.crash();
    }
    if (car.mode !== MODE.CRASHED) this.crashShown = false;

    if (this.cpIndex >= cps.length && car.s - lapBase >= len - 12) {
      this.lap++;
      if (this.lap >= this.laps) this.finish();
      else {
        this.cpIndex = 0;
        if (this.ghost) this.ghost.reset();
        this.setMessage(`VOLTA ${this.lap + 1} / ${this.laps}`,
          formatTime(this.closeLap()), '#ffb43a', 1.6);
        if (this.sound) this.sound.checkpoint();
      }
    }
  }

  // The lap just crossed, in its own right rather than as a running total.
  closeLap() {
    const ms = this.timeMs - this.lapStart;
    this.lapTimes.push(ms);
    this.lapStart = this.timeMs;
    return ms;
  }

  bestLap() {
    return this.lapTimes.length ? Math.min(...this.lapTimes) : null;
  }

  // The part of the recording the record is actually about: on a circuit the
  // best lap alone, rebased to the start of the track; otherwise the whole run.
  recordRun() {
    if (!this.track.closed) return this.ghostRec;
    const k = this.lapTimes.indexOf(this.bestLap());
    let from = 0;
    for (let i = 0; i < k; i++) from += this.lapTimes[i];
    return lapSlice(this.ghostRec, from, from + this.lapTimes[k], k * this.track.length);
  }

  finish() {
    this.state = STATE.FINISHED;
    this.finalTime = this.timeMs;
    this.closeLap();      // the one being driven as the line came up
    // Kept regardless of whether this lap set any record: a replay is about
    // watching the drive just made, not about who holds the track.
    this.lastLap = { car: this.car0.id, p: this.ghostRec.p.slice(), ms: this.finalTime };

    // What the record is measured on. A circuit is scored on its best single
    // lap, not on the total: the total depends on how many laps were chosen,
    // and a best lap does not, so every time on the board stays comparable
    // with every other. A sprint has one lap and the two are the same number.
    const scored = this.track.closed ? this.bestLap() : this.finalTime;
    const prev = getBest(this.def.id);
    this.newRecord = prev == null || scored < prev.ms;
    // Kept apart from the overall record: a lap that beats your own previous
    // best with this car still means something even when a different car
    // already holds the track outright, and staying quiet about it would make
    // trying a car you are not fastest with feel pointless.
    const prevCar = getCarBest(this.def.id, this.car0.id);
    const newCarRecord = prevCar == null || scored < prevCar.ms;
    if (newCarRecord) saveCarBest(this.def.id, this.car0.id, scored);
    if (this.newRecord) {
      saveBest(this.def.id, scored, this.car0.id);
      this.best = { ms: Math.round(scored), car: this.car0.id };
      // The lap just driven becomes the ghost to beat -- and on a circuit that
      // is the best lap on its own, not the whole run, or it would be three
      // times longer than the time it claims to be. If storage refuses it,
      // drop any older ghost rather than leave one that no longer matches the
      // record it claims to be.
      if (saveGhost(this.def.id, this.recordRun(), this.car0.id, scored)) {
        this.loadGhostFor(this.def.id);
      } else {
        clearGhost(this.def.id);
        this.loadGhostFor(this.def.id);
      }
    }
    if (this.sound) this.sound.finish(this.newRecord);
    this.onFinish({
      time: this.finalTime, best: this.best, record: this.newRecord,
      // Worth telling apart from the overall record only when it is not also
      // one: "new record" already implies a new personal best with this car.
      carRecord: newCarRecord && !this.newRecord,
      lapTimes: this.lapTimes.slice(),
      circuit: this.track.closed,
      scored,
    });
  }

  // Watching the lap just driven, from outside the car -- the ghost mesh is
  // built for exactly this (an opaque, external view of a lap), so the same
  // GhostPlayer that reconstructs a saved ghost reconstructs this one too.
  startReplay() {
    if (!this.lastLap) return false;
    if (this.replayChunk) this.renderer.dispose([this.replayChunk]);
    this.replay = new GhostPlayer(this.lastLap, this.track);
    this.replayChunk = this.renderer.upload(buildGhostMesh(this.car0.theme.accent));
    this.replayTimeMs = 0;
    this.replayPose = this.replay.at(0);
    this.replayPaused = false;
    this.state = STATE.REPLAY;
    return true;
  }

  stopReplay() {
    if (this.replayChunk) { this.renderer.dispose([this.replayChunk]); this.replayChunk = null; }
    this.replay = null;
    this.replayPose = null;
    if (this.state === STATE.REPLAY) this.state = STATE.FINISHED;
  }

  toggleReplayPause() { this.replayPaused = !this.replayPaused; }

  render(dt) {
    const car = this.car;
    const targetFov = 68 + clamp(Math.abs(car.v), 0, 63) * 0.27;
    this.fov += (targetFov - this.fov) * Math.min(1, dt * 5);

    const r = this.renderer;
    // In a replay the camera follows the car from outside rather than sitting
    // in the cockpit -- everything from here on (fog, culling, the world
    // itself) stays exactly as driving left it, only the vantage point moves.
    let camQuat = car.camQuat, camPos = car.camPos, fov = this.fov;
    if (this.state === STATE.REPLAY && this.replayPose) {
      const p = this.replayPose;
      camQuat = quat.mul(p.q, quat.axisAngle([1, 0, 0], REPLAY_TILT));
      camPos = v3.mad(v3.mad(p.pos, quat.fwd(p.q), -REPLAY_BACK), quat.up(p.q), REPLAY_UP);
      fov = REPLAY_FOV;
    }
    r.beginFrame(camQuat, camPos, fov);
    r.drawSky(this.chunks.sky);
    // A dusk or twilight preset lowers this a little, never far: the ambient
    // term is a brightness floor (see the shader in core/renderer.js), and the
    // road still has to be as easy to read as it is at midday.
    const amb = this.ambient || 1;
    r.draw(this.chunks.ground, 0.66 * amb);
    r.draw(this.chunks.scenery, 0.58 * amb);
    r.draw(this.chunks.road, 0.72 * amb);
    r.draw(this.chunks.tunnel, 0.5 * amb);   // darker, so a bore feels enclosed
    r.draw(this.chunks.gates, 0.66 * amb);

    // Drawn last, over the finished scene, because it is blended.
    if (this.state === STATE.REPLAY && this.replayPose && this.replayChunk) {
      // Full ambient and opaque: this is the car, not a hint of one, so it
      // reads nothing like the faint record-holder ghost drawn alongside a
      // race in progress below.
      r.drawGhost(this.replayChunk, ghostModelMatrix(this.replayPose), 1, 1);
    } else if (this.showGhost && this.ghost && this.ghostChunk
        && this.state !== STATE.COUNTDOWN) {
      const pose = this.ghost.at(this.lapTime());
      if (pose) r.drawGhost(this.ghostChunk, ghostModelMatrix(pose), GHOST_AMBIENT, GHOST_ALPHA);
    }

    let message = '', sub = '', color = '#ffb43a';
    if (this.state === STATE.COUNTDOWN) {
      const n = Math.ceil(this.countdown - 0.6);
      message = n > 0 ? String(n) : 'JÁ!';
      sub = n > 0 ? 'Prepara-te' : '';
      color = n > 0 ? '#ffb43a' : '#5fd894';
      if (n !== this.lastBeep) {
        this.lastBeep = n;
        if (this.sound) this.sound.countdown(n);
      }
    } else if (this.msg) {
      message = this.msg.text; sub = this.msg.sub; color = this.msg.color;
    } else if (car.mode === MODE.ROAD && car.gForce < 0.4) {
      const f = this.track.frameAt(car.s);
      if (f.up[1] < 0.45) { message = 'ACELERA!'; color = '#ff7a7a'; }
    }

    const speed = car.speedKmh;
    const topKmh = this.car0.phys.vmax * 3.6;
    const { gear, rpm } = gearFor(speed, topKmh);
    // Only worth a call while actually racing: it would be noise over the
    // countdown, and meaningless once the car has stopped or come off.
    const corner = this.state === STATE.RACING ? this.cornerAhead() : null;

    if (this.sound) {
      this.sound.update({
        active: this.state === STATE.COUNTDOWN || this.state === STATE.RACING,
        rpm,
        throttle: this.input.throttle,
        speedKmh: speed,
        squeal: Math.max(car.slip - 0.12, car.onCurb ? 0.3 : 0),
        // Only the road can lose grip: airborne, car.slip still holds whatever
        // it read at take-off, and the tyres are not touching anything.
        slip: car.mode === MODE.ROAD ? car.slip : 0,
      });
      this.sound.follow(car);
    }

    // The cockpit is modelled for the driver's own seat; seen from behind the
    // car in a replay it would float over the picture meaning nothing, so it
    // is left off rather than drawn wrong.
    if (this.state === STATE.REPLAY) {
      this.hud.clear();
    } else {
      this.hud.draw({
        speedKmh: speed,
        topKmh,
        theme: this.car0.theme,
        rpm,
        gear: car.v < -0.5 ? 'R' : String(gear),
        steer: car.steer / this.car0.phys.maxSteer,
        throttle: this.input.throttle,
        brake: this.input.brake,
        slip: car.slip,
        cornerDir: corner ? corner.dir : null,
        cornerUrgency: corner ? corner.urgency : 0,
        timeMs: this.timeMs,
        bestMs: this.best ? this.best.ms : null,
        cpDone: this.cpIndex,
        cpTotal: this.track.checkpoints.length,
        progress: clamp((car.s - this.lap * this.track.length) / this.track.length, 0, 1),
        lap: this.lap + 1,
        laps: this.laps,
        lapTimes: this.lapTimes,
        lapMs: this.track.closed ? this.lapTime() : null,
        bestIsLap: this.track.closed,
        ghostDelta: this.ghostDelta,
        message, submessage: sub, messageColor: color,
      });
    }
  }
}
