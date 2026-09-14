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
// speed into a corner than the grip strictly allows and relying on the
// understeer to wash it off. Measured on the Costa Verde, this runs a lap in
// 113 s at 0.35 and 79 s at 1.3, smoothly and without crashing at either end,
// which is what makes it something a difficulty can be solved for.
export const PACE_MIN = 0.3;
export const PACE_MAX = 1.35;

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
// a built track be saved; the rival uses it to find out how hard it has to try
// (see paceFor). It never wraps past the end, circuit or not: it is asking
// about one run of the course, and a run that quietly went round again would
// never finish.
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

// The pace that gets this car round this track in about `seconds`.
//
// Solved rather than guessed, because the same pace means very different times
// on a circuit of hairpins and on one of long straights -- the number that
// matters to a player is the time, and the time is what a track's own target
// is expressed in. Time falls smoothly as pace rises (113 s to 79 s across the
// range on the Costa Verde), so a handful of bisection steps land close, and
// each step costs about 40 ms.
//
// Returns the pace and the time it actually produces, which is not always the
// time asked for: at PACE_MIN the driver is still quicker than a slow target,
// and at PACE_MAX it cannot go faster however much is asked of it.
export function paceFor(track, phys, seconds, steps = 6) {
  let lo = PACE_MIN, hi = PACE_MAX;
  let best = null;
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    const r = testDrive(track, { aggression: mid, phys, maxSeconds: seconds * 3 + 60 });
    // A pace that cannot finish the track is too fast for it, whatever the
    // clock says -- treat it as such and look lower.
    if (!r.ok) { hi = mid; continue; }
    if (best === null || Math.abs(r.seconds - seconds) < Math.abs(best.seconds - seconds)) {
      best = { pace: mid, seconds: r.seconds };
    }
    if (r.seconds > seconds) lo = mid; else hi = mid;
  }
  return best || { pace: PACE_MIN, seconds: null };
}
