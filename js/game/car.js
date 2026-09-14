import { quat, v3, clamp } from '../core/math.js';
import { ROAD_HALF, WALL_U } from '../world/track.js';
import { GROUND_Y } from '../world/scenery.js';

const G = 9.81;
const STEER_RATE = 4.6;     // rad/s of lock movement
const WALL_BOUNCE = 0.22;   // fraction of the sideways hit that comes back
const WALL_BITE = 0.95;     // speed lost per m/s of sideways impact
const WALL_SCRUB = 18;      // m/s^2 lost while held hard against the barrier
const GRIP_SHARE = 0.4;     // how much of the friction budget power steals
const BRAKE_SHARE = 0.15;   // ... and how much braking does, nose-down and loaded
// Stopping is not limited by the cornering figure. aLatMax is what one end of
// the car can hold sideways; braking is all four wheels pulling the same way,
// on a nose that has just dived onto them, with the engine helping. Capping the
// brake at 0.95 of the cornering limit made the per-car brake figure below dead
// letter -- every car stopped at whatever its grip allowed and the "Travagem"
// bars meant nothing. The cap still bites where grip really is gone: on the
// kerb, and over a crest where there is no weight on the wheels at all.
const BRAKE_GRIP = 1.35;
// How much harder the air pushes back on a car standing on its brakes than on
// one merely coasting. The friction part of a stop is the same at any speed, so
// on its own it takes speed out in a straight line and the first moment of a
// stop from the top of sixth feels like nothing is happening. This term is the
// one that grows with speed, and it is what makes the start of the stop bite.
const BRAKE_DRAG = 3;
const HANDBRAKE_HOLD = 0.5; // fraction of cornering grip left when it is pulled
const HANDBRAKE_YAW = 1.7;  // rad/s of extra rotation as the rear steps out
const VU_DECAY = 3.2;       // how fast the tyres scrub a slide off
// Landing: vertical speed the suspension swallows for nothing, how quickly the
// rest turns into lost speed, and the most a landing can ever cost.
const LAND_FREE = 6;
const LAND_BITE = 50;
const LAND_MAX = 0.3;
const SUBSTEP = 1 / 120;

// Per-car handling. Coast braking is weighted toward engine braking rather than
// aero drag: a big quadratic term would make coasting nearly as strong as the
// brake at top speed, since braking is grip-limited, and the pedal would stop
// mattering. Used when no car spec is supplied (autopilot probes, tests).
export const DEFAULT_PHYS = {
  vmax: 63,          // m/s asymptote under full throttle
  accel: 8.8,
  brake: 18.5,
  mu: 1.45,
  muCurb: 0.95,      // two wheels over the line, on the kerb
  maxSteer: 0.6,     // rad, standstill lock
  wheelbase: 2.75,
  coastBase: 3.2,
  coastDrag: 0.0011,
  assist: 0.85,      // gentle realignment with the track
};

export const MODE = { ROAD: 0, AIR: 1, CRASHED: 2 };

// Slip at which the car is audibly and visibly away from you: the speedo turns
// red, the grip lamp lights and the tyres chirp. One number, so the warning a
// driver sees and the one they hear can never disagree.
export const SLIP_WARN = 0.35;

// Speed at which each gear tops out. Revs sweep up and drop back on each shift,
// which is what makes the engine note sound like a car rather than a siren.
// Scaled by the car's top speed so every car still pulls 6th at its own maximum.
const GEAR_TOPS = [0, 50, 85, 122, 160, 196, 232];

export function gearFor(speedKmh, topKmh = 232) {
  const k = topKmh / 232;
  let g = 1;
  while (g < 6 && speedKmh > GEAR_TOPS[g] * k) g++;
  const lo = GEAR_TOPS[g - 1] * k, hi = GEAR_TOPS[g] * k;
  return { gear: g, rpm: 0.22 + 0.78 * clamp((speedKmh - lo) / (hi - lo), 0, 1) };
}

const approach = (cur, target, rate, dt) => {
  const d = target - cur, m = rate * dt;
  return Math.abs(d) <= m ? target : cur + Math.sign(d) * m;
};

export class Car {
  constructor(track, phys) {
    this.track = track;
    this.phys = { ...DEFAULT_PHYS, ...(phys || {}) };
    this.respawnS = 0;
    this.reset(0);   // also seeds the camera; do not clear it afterwards
    // Counters, not flags: the audio layer remembers which it has already played,
    // so nothing has to reach in and clear them. Not reset on respawn.
    this.wallHits = 0;
    this.wallForce = 0;
    this.landings = 0;
    this.landForce = 0;
  }

  reset(s) {
    this.mode = MODE.ROAD;
    this.s = s;
    this.u = 0;
    this.v = 0;
    this.vu = 0;
    this.psi = 0;
    this.steer = 0;
    this.pos = [0, 0, 0];
    this.vel = [0, 0, 0];
    this.q = quat.id();
    this.angVel = [0, 0, 0];
    this.airTime = 0;
    this.prevH = 1;
    this.crashTimer = 0;
    this.onCurb = false;
    this.slip = 0;
    this.understeer = 0;
    this.gForce = 1;
    const f = this.track.frameAt(s);
    this.camPos = v3.mad(f.pos, f.up, 1.15);
    this.camQuat = f.sq;
    this._acc = 0;
  }

  get speedKmh() { return Math.abs(this.v) * 3.6; }

  crash(reason) {
    this.mode = MODE.CRASHED;
    this.crashTimer = 1.15;
    this.crashReason = reason;
    this.v = 0;
    this.vu = 0;
  }

  update(dt, input) {
    this._acc += Math.min(dt, 0.1);
    let steps = 0;
    while (this._acc >= SUBSTEP && steps < 12) {
      this._acc -= SUBSTEP;
      this.step(SUBSTEP, input);
      steps++;
    }
    this.updateCamera(dt);
  }

  step(dt, input) {
    if (this.mode === MODE.CRASHED) {
      this.crashTimer -= dt;
      if (this.crashTimer <= 0) this.reset(this.respawnS);
      return;
    }
    if (this.mode === MODE.AIR) this.stepAir(dt, input);
    else this.stepRoad(dt, input);
  }

  stepRoad(dt, input) {
    const f = this.track.frameAt(this.s);

    if (f.gap) { this.detach(f); return; }

    this.onCurb = Math.abs(this.u) > ROAD_HALF;

    const P = this.phys;
    const v = this.v;
    const absV = Math.abs(v);

    // Normal load per unit mass: path curvature plus gravity along the surface
    // normal. Going negative means the track can no longer hold the car — too
    // slow through a loop or corkscrew and you fall off it.
    const N = v * v * f.kUp + G * f.up[1];
    this.gForce = N / G;
    if (N < 0) { this.detach(f); return; }

    const aLatMax = (this.onCurb ? P.muCurb : P.mu) * Math.max(N, 0.4);
    const handbrake = input.handbrake && absV > 2 ? 1 : 0;

    // Longitudinal
    const heading = v3.add(v3.scale(f.fwd, Math.cos(this.psi)), v3.scale(f.right, Math.sin(this.psi)));
    let aLong = -G * heading[1];
    // The brake wins over the throttle, as it does in the pedal box of any car
    // built this century. It matters more here than in a car: a button is not a
    // pedal, the throttle is held down out of habit, and letting the engine
    // push against the brake was quietly eating a third of the stop.
    const throttle = input.brake > 0 ? 0 : input.throttle;
    if (throttle > 0) {
      aLong += throttle * P.accel * Math.max(0, 1 - absV / P.vmax) * (this.onCurb ? 0.85 : 1);
    }
    if (input.brake > 0) {
      const bmax = Math.min(P.brake, aLatMax * BRAKE_GRIP);
      if (v > 0.4) aLong -= input.brake * bmax;
      else aLong -= input.brake * P.accel * 0.45;   // reverse
    }
    // Engine braking and air resistance do not stop existing because the brake
    // went down -- and they are the part that scales with speed, so they are
    // what makes the first moment of a stop from top speed bite hardest. Left
    // out of a braking car, as they were, the brake lost the one thing that
    // lifting off still had. Closed throttle is the condition, not an idle
    // pedal, so this still never caps top speed.
    if (throttle === 0) {
      const drag = P.coastDrag * v * v * (input.brake > 0 ? BRAKE_DRAG : 1);
      aLong -= Math.sign(v) * (P.coastBase + drag);
    }
    if (this.onCurb) aLong -= Math.sign(v) * 1.6;
    if (handbrake) aLong -= Math.sign(v) * 7;

    this.v += aLong * dt;
    if (this.v < -9) this.v = -9;
    if (this.v > P.vmax * 1.02) this.v = P.vmax * 1.02;

    // Longitudinal and lateral load share one friction budget, so work out what
    // cornering grip is left before deciding how far the wheels may turn. Sizing
    // the lock off the total instead made full lock overrun the limit whenever
    // the throttle was down, which is to say almost always: a permanent slide.
    const used = Math.min(Math.abs(aLong), aLatMax);
    // Slowing down and speeding up do not cost the same cornering grip, because
    // they do not put the weight in the same place. On the brakes the car dives
    // and loads the wheels that steer it -- which is why trail-braking works at
    // all, and why a braking car should still turn in. On the power it squats
    // and takes weight *off* them, so the nose washes out instead. Charging both
    // at the same rate made the brake the worst thing you could touch before a
    // bend: the car slowed down and then ran straight on anyway.
    const share = aLong < 0 ? BRAKE_SHARE : GRIP_SHARE;
    const grip = Math.sqrt(Math.max(0, aLatMax * aLatMax - used * used * share));

    // Understeer: whether the corner is possible at all against what grip is
    // left, not the tyres' theoretical best -- braking (or accelerating) hard
    // already spends part of the very same budget the steering lock below
    // draws from, so trail-braking into a bend can cost real cornering power
    // before the wheel is ever turned. Measured against `grip` rather than
    // `aLatMax`, or braking into a corner that was only ever safe at full
    // grip would understeer with nothing telling the driver why.
    //
    // It has to be measured here, from the road, because nothing downstream can
    // see it. The steering lock below is capped at what grip allows, so the
    // tyres are never *asked* for more than they can give and `excess` -- the
    // sliding term -- stays exactly zero through a corner taken far too fast.
    // Understeer in this simulation is the car quietly refusing to turn, and
    // that refusal leaves no trace anywhere else.
    const demand = v * v * Math.abs(f.kRight) / Math.max(grip, 1);
    this.understeer = clamp((demand - 0.95) / 0.3, 0, 1);

    // The front wheels keep their grip under the handbrake, so the lock is not
    // reduced -- otherwise the car would just turn less and stay pinned to the
    // limit, which is why pulling it used to do nothing you could feel.
    const lock = Math.atan(Math.min(Math.tan(P.maxSteer), grip * P.wheelbase / Math.max(v * v, 6)));
    const rate = STEER_RATE * lock / P.maxSteer + 0.6;
    this.steer = clamp(approach(this.steer, input.steer * lock, rate, dt), -lock, lock);

    const gravLat = G * f.right[1];
    const omegaCmd = absV > 0.8 ? this.v * Math.tan(this.steer) / P.wheelbase : 0;
    const aTyreReq = this.v * omegaCmd + gravLat;

    // Locking the rear wheels is what actually breaks the car loose.
    const hold = grip * (handbrake ? HANDBRAKE_HOLD : 1);
    const aTyre = clamp(aTyreReq, -hold, hold);
    const excess = aTyreReq - aTyre;

    // How far past what the tyres can hold the car is -- whether that shows up
    // as the back stepping out or as the front simply not turning.
    this.slip = Math.min(1, Math.max(
      Math.abs(excess) / Math.max(aLatMax, 1), this.understeer));
    const omegaEff = absV > 0.8 ? (aTyre - gravLat) / this.v : 0;

    let dpsi = omegaEff - this.v * f.kRight;
    if (handbrake) dpsi += Math.sign(this.steer) * HANDBRAKE_YAW * clamp(absV / 8, 0, 1);
    // The realignment aid would fight the slide, so it stands down while sliding.
    dpsi -= this.psi * P.assist * (handbrake ? 0.15 : 1) * clamp(absV / 12, 0, 1);
    this.psi = clamp(this.psi + dpsi * dt, -1.25, 1.25);

    this.vu += -excess * dt;
    this.vu *= Math.exp(-dt * VU_DECAY);

    this.s += this.v * Math.cos(this.psi) * dt;
    this.u += (this.v * Math.sin(this.psi) + this.vu) * dt;
    this.hitWall(dt, input.steer);

    if (this.s < 0) { this.s = 0; this.v = Math.max(0, this.v); }
    this.airTime = 0;
  }

  // Barriers line both edges, so running wide costs speed instead of the race.
  hitWall(dt, steerInput) {
    if (Math.abs(this.u) <= WALL_U) return;
    const side = Math.sign(this.u);
    this.u = side * WALL_U;

    const closing = (this.v * Math.sin(this.psi) + this.vu) * side;
    if (closing > 0) {
      this.vu = -side * closing * WALL_BOUNCE;
      this.psi *= 0.3;
      this.v -= Math.sign(this.v) * Math.min(Math.abs(this.v), closing * WALL_BITE);
      this.slip = Math.max(this.slip, Math.min(1, closing / 10));
      if (closing > 1.2) { this.wallHits++; this.wallForce = closing; }
    } else {
      this.vu = 0;
    }

    // Friction rises with how hard the driver holds the car into the barrier, so
    // leaning on it through a corner is slower than braking for the corner.
    const press = clamp(steerInput * side, 0, 1);
    const scrub = WALL_SCRUB * (0.45 + 0.55 * press) * dt;
    this.v -= Math.sign(this.v) * Math.min(Math.abs(this.v), scrub);
  }

  detach(f) {
    const surface = v3.mad(f.pos, f.right, this.u);
    this.pos = v3.mad(surface, f.up, 0.05);
    const heading = v3.add(v3.scale(f.fwd, Math.cos(this.psi)), v3.scale(f.right, Math.sin(this.psi)));
    this.vel = v3.add(v3.scale(heading, this.v), v3.scale(f.right, this.vu));
    this.q = quat.mul(f.sq, quat.axisAngle([0, 1, 0], this.psi));
    // Keep a little of the ramp's rotation so the car pitches over the crest.
    this.angVel = [f.kUp * this.v * 0.55, 0, 0];
    this.mode = MODE.AIR;
    this.airTime = 0;
    this.prevH = 0.05;
    this.lastS = f.s;
  }

  stepAir(dt, input) {
    this.airTime += dt;
    this.vel[1] -= G * dt;
    this.pos = v3.mad(this.pos, this.vel, dt);
    this.gForce = 0;

    const w = this.angVel;
    const wl = Math.hypot(w[0], w[1], w[2]);
    if (wl > 1e-5) {
      this.q = quat.norm(quat.mul(this.q, quat.axisAngle([w[0] / wl, w[1] / wl, w[2] / wl], -wl * dt)));
    }

    if (this.pos[1] < GROUND_Y + 0.35) { this.crash('aterragem fora da pista'); return; }
    if (this.airTime > 6) { this.crash('perdeu a pista'); return; }

    const f = this.track.nearest(this.pos, this.lastS, 110);
    const d = v3.sub(this.pos, f.pos);
    const h = v3.dot(d, f.up);
    const lat = v3.dot(d, f.right);
    const sOff = v3.dot(d, f.fwd);
    this.lastS = f.s + sOff;

    // A crossing test on prevH is not enough: over a gap the car skims the
    // invisible ribbon and can slip under it before the road resumes. Landing on
    // any shallow penetration while descending catches that case too.
    const descending = v3.dot(this.vel, f.up) < 0.5;
    if (!f.gap && this.airTime > 0.08 && h <= 0 && h > -3 && descending
        && Math.abs(lat) < WALL_U + 2.5) {
      this.land(f, clamp(lat, -WALL_U, WALL_U), sOff);
      return;
    }
    this.prevH = h;
  }

  land(f, lat, sOff) {
    const impact = Math.max(0, -v3.dot(this.vel, f.up));
    const tangential = v3.sub(this.vel, v3.scale(f.up, v3.dot(this.vel, f.up)));
    const along = v3.dot(tangential, f.fwd);
    const side = v3.dot(tangential, f.right);

    this.mode = MODE.ROAD;
    this.s = Math.max(0, f.s + sOff);
    this.u = lat;
    this.v = Math.hypot(along, side) * (along < 0 ? -1 : 1);
    this.psi = clamp(Math.atan2(side, Math.abs(along) < 0.01 ? 0.01 : along), -1.1, 1.1);
    // What a landing costs in speed.
    //
    // The vertical part of the velocity is already gone by this point -- `v`
    // is built from the tangential part alone, which is what a car that lands
    // squarely actually keeps. This is the extra, for the tyres scrabbling and
    // the suspension packing down, and it used to be charged from the first
    // millimetre of drop: the Costa Verde's jump is entered at 178 km/h and
    // was rejoined at 126, a third of the speed gone with nothing the driver
    // could have done differently.
    //
    // A landing under LAND_FREE is absorbed by the suspension and costs
    // nothing, which is what a suspension is for. Past that it bites, and a
    // genuinely violent arrival still hurts -- the same jump now rejoins at
    // 164, and dropping off the top of a loop still does what it always did.
    const harsh = Math.max(0, impact - LAND_FREE);
    this.v *= 1 - clamp(harsh / LAND_BITE, 0, LAND_MAX);
    this.vu = 0;
    this.landings++;
    this.landForce = impact;
    this.airTime = 0;
  }

  // World transform for the cockpit camera.
  cameraTarget() {
    if (this.mode === MODE.AIR) {
      return { pos: v3.mad(this.pos, quat.up(this.q), 1.15), q: this.q };
    }
    const f = this.track.frameAt(this.s);
    const surface = v3.mad(f.pos, f.right, this.u);
    const q = quat.mul(f.sq, quat.axisAngle([0, 1, 0], this.psi));
    const pos = v3.mad(v3.mad(surface, f.up, 1.15), quat.fwd(q), 0.35);
    return { pos, q };
  }

  updateCamera(dt) {
    const t = this.cameraTarget();
    const kp = 1 - Math.exp(-dt / 0.055);
    const kq = 1 - Math.exp(-dt / 0.065);
    this.camPos = v3.lerp(this.camPos, t.pos, kp);
    this.camQuat = quat.nlerp(this.camQuat, t.q, kq);
  }
}
