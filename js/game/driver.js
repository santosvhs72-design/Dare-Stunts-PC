import { clamp } from '../core/math.js';
import { Car, MODE } from './car.js';

// The reference driver: what to do with the controls, given where the car is
// and what the road does next.
//
// This is the planner the editor's autopilot has always used to answer "can
// this track be finished at all". It lived inside that loop until something
// else needed it -- the computer-controlled rival -- and the two must not
// drift apart: the rival that races you is the same driver that decides
// whether a track you built is possible, which is the closest thing this game
// has to a definition of fair.
//
// It is not a racing line. It stays on the centre of the road and brakes for
// what is coming, and that is all it does; there is no apex-clipping here and
// no tyre model. It is quick enough to beat most people and slow enough to be
// beaten by someone driving well, which is the whole job.

// Lateral budget the driver plans around. It follows the car's own grip,
// otherwise a low-grip car gets driven at a high-grip car's corner speeds.
export const gripOf = phys => (phys && phys.mu ? phys.mu : 1.45) * 9.81;

// How hard to lean on the tyres, as a multiple of what the car actually has.
// Below 1 is a driver leaving something in hand; above 1 is one carrying more
// speed into a corner than the grip strictly allows, letting the understeer
// wash it off and occasionally brushing a barrier.
//
// This one is as fast as this driver goes, and it is not the largest number
// that could go here -- it is the one past which nothing gets faster.
//
// Measured on all three tracks: at 1.7 the Serra Alta comes out at 1:37 with
// the car against a barrier 4% of the time; at 2.5 it comes out at 1:38 with
// it against a barrier 13% of the time. Everything gained by carrying more
// speed into the corner is handed straight back to the wall on the way out,
// and the car looks like it is being driven badly while doing it. There is no
// setting above this worth having, only one that looks worse.
export const PACE_FLAT_OUT = 1.7;

// What the controls should be doing this instant.
//
// `wrap` says whether the road ahead continues past the end of the array. On a
// circuit it does -- frameAt takes the geometry round -- and a driver that
// stopped looking ahead at the finish line would brake hard on every lap. On a
// sprint it does not, and clamping is right.
//
// `lane` is where across the road the driver is trying to be, in metres from
// the centre. Zero is the middle of the road and is what the editor's
// validation run always uses; the rival moves it to get out of the way of a
// car alongside.
export function plan(car, track, { pace = 1, wrap = false, lane = 0 } = {}) {
  const grip = gripOf(car.phys);
  const budget = grip * pace;
  const f = track.frameAt(car.s);

  // The tightest thing between here and as far ahead as the car would take to
  // slow down for it.
  let maxK = 0, loopK = 0;
  const ahead = Math.max(22, car.v * 1.5 + 20);
  for (let d = 5; d < ahead; d += 5) {
    const g = track.frameAt(wrap ? car.s + d : Math.min(car.s + d, track.length - 1));
    maxK = Math.max(maxK, Math.abs(g.kRight));
    // Vertical curvature is a loop, and a loop is the opposite problem: too
    // slow and the car falls off the top of it.
    if (g.kUp > 0.008) loopK = Math.max(loopK, g.kUp);
  }
  let vT = maxK > 1e-4 ? Math.sqrt(budget / maxK) : 999;
  if (loopK > 0) vT = Math.max(vT, Math.sqrt(5 * 9.81 / loopK) * 1.18);
  vT = Math.min(vT, car.phys.vmax);

  return {
    throttle: car.v < vT ? 1 : 0,
    brake: car.v > vT * 1.06 ? 1 : 0,
    // Enough lock to hold the bend at this speed, plus two corrections: back
    // towards the middle of the road, and back in line with it.
    steer: clamp(car.v * car.v * f.kRight / grip - (car.u - lane) * 0.055 - car.psi * 1.7, -1, 1),
    handbrake: false,
  };
}

// Drives the whole track, as fast as `pace` allows, and reports what happened.
//
// The editor uses this to answer "can this be finished at all" before letting
// a built track be saved; safePace below uses it to check that a rival set to
// a given pace can get round. It never wraps past the end, circuit or not: it
// is asking about one run of the course, and a run that quietly went round
// again would never finish.
export function testDrive(track, { aggression = 1, maxSeconds = 240, phys = null } = {}) {
  const car = new Car(track, phys);
  car.respawnS = 0;
  const dt = 1 / 120;
  const failures = [];
  let t = 0, crashes = 0, furthest = 0, cpIndex = 0, topSpeed = 0, stalled = 0;

  while (t < maxSeconds) {
    const wasCrashed = car.mode === MODE.CRASHED;
    car.update(dt, plan(car, track, { pace: aggression }));
    t += dt;
    topSpeed = Math.max(topSpeed, car.speedKmh);

    // A car stuck part-way up a loop it cannot clear will fall and retry
    // forever, so give up once it stops making progress rather than burning
    // the full budget.
    if (car.s > furthest + 0.5) { furthest = car.s; stalled = 0; } else { stalled += dt; }
    if (stalled > 18) break;

    // Mirror the game's checkpoint respawns, or one bad corner would loop forever.
    if (cpIndex < track.checkpoints.length && car.s >= track.checkpoints[cpIndex]) {
      car.respawnS = Math.max(0, track.checkpoints[cpIndex] - 4);
      cpIndex++;
    }

    if (car.mode === MODE.CRASHED && !wasCrashed) {
      crashes++;
      failures.push({ s: Math.round(car.s), reason: car.crashReason || 'saiu da pista' });
      if (crashes >= 8) break;
    }

    if (car.s >= track.length - 12) {
      return { ok: true, seconds: t, crashes, topSpeed, failures, furthest: Math.round(track.length) };
    }
  }

  return { ok: false, seconds: t, crashes, topSpeed, failures, furthest: Math.round(furthest) };
}

// A pace this car can actually get round this track with.
//
// Almost always the one asked for. The exception is the loop: a car that goes
// through one too *slowly* falls off the top of it (see the normal load going
// negative in Car.stepRoad), so on a track with a loop there is a floor below
// which no amount of care gets round at all. A rival stuck at the bottom of a
// loop, falling and trying again, is worse than a rival that is harder than
// you asked for.
//
// Note which way this goes. Everywhere else in a racing game a lap that fails
// means going too fast; here the first thing to try is faster.
export function safePace(track, phys, wanted) {
  if (testDrive(track, { aggression: wanted, phys }).ok) return wanted;
  for (let p = wanted + 0.15; p <= PACE_FLAT_OUT; p += 0.15) {
    if (testDrive(track, { aggression: p, phys }).ok) return p;
  }
  // Nothing gets round this. The editor does not let such a track be saved, so
  // this is a built track from before it checked, or a shared one -- drive it
  // at what was asked and let the checkpoints pick the car up.
  return wanted;
}

// The pace that gets this car round this track in a given share of the time it
// takes flat out. `share` of 1 is flat out; 0.9 is a tenth slower than that.
//
// Solved per track, because pace does not mean the same thing on two different
// tracks. On the Costa Verde, whose corners are so open that the car is
// hardly ever grip-limited at all, going from 1.15 to flat out is worth three
// seconds; on the Serra Alta it is worth seven, and on the Vertigem ten. A
// difficulty picked as a bare pace is therefore a different difficulty on
// every track -- which is exactly the mistake that made the hardest rival
// beatable without trying on the two tracks that have real corners.
//
// Costs one run of the track for the reference time plus a handful for the
// search, about 40 ms each, under the loading screen that is already there.
export function paceForShare(track, phys, share) {
  const flat = testDrive(track, { aggression: PACE_FLAT_OUT, phys });
  if (share >= 1 || !flat.ok) {
    return { pace: PACE_FLAT_OUT, seconds: flat.seconds, ok: flat.ok };
  }
  const target = flat.seconds / share;

  let lo = 0.3, hi = PACE_FLAT_OUT, best = null;
  for (let i = 0; i < 5; i++) {
    const mid = (lo + hi) / 2;
    const r = testDrive(track, { aggression: mid, phys, maxSeconds: target * 2 + 60 });
    // Not finishing means too slow for the loop, not too fast for the corner
    // -- see safePace. So look higher, never lower.
    if (!r.ok) { lo = mid; continue; }
    if (!best || Math.abs(r.seconds - target) < Math.abs(best.seconds - target)) {
      // `ok` because this pace was just driven round the whole track: the
      // caller does not need to check it again.
      best = { pace: mid, seconds: r.seconds, ok: true };
    }
    if (r.seconds > target) lo = mid; else hi = mid;
  }
  return best || { pace: PACE_FLAT_OUT, seconds: flat.seconds, ok: flat.ok };
}
