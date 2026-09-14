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
// Going faster stops paying at some point, and where that point is depends on
// the track. Past it, the extra speed carried into the corner is handed
// straight back to the barrier on the way out -- the Serra Alta is a second
// *slower* at 2.5 than at 1.7, with the car scraping a wall 13% of the time
// instead of 4%, and looking like it is being driven badly throughout.
//
// So flat out is measured rather than declared: these are tried and the best
// wins. Four runs of the track, which is the price of the one number every
// difficulty is then expressed against.
const FLAT_CANDIDATES = [1.0, 1.2, 1.45, 1.7];

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
  const v = Math.abs(car.v);
  // What the car can actually shed, near enough. Car.stepRoad caps braking at
  // what grip allows, which is less than this over a crest and on the kerb --
  // being a little optimistic here means braking a little late there, which is
  // what a driver does too.
  const brake = car.phys.brake * 0.9;

  // Look exactly as far as it takes to stop from here, plus a margin. Any
  // further and the road being read has no bearing on what the pedals should
  // be doing now.
  const horizon = v * v / (2 * brake) + 30;

  let vT = car.phys.vmax;
  let loopMin = 0;
  for (let d = 0; d < horizon; d += 4) {
    const g = d === 0 ? f
      : track.frameAt(wrap ? car.s + d : Math.min(car.s + d, track.length - 1));
    const k = Math.abs(g.kRight);
    if (k > 1e-4) {
      // How fast the car may be *there*, and therefore how fast it may be
      // *here* and still arrive at that speed.
      //
      // This is the whole difference between a driver and a speed limit. The
      // old version took the tightest corner anywhere in its lookahead and
      // drove at that speed for the entire stretch -- so it was already down
      // to 152 km/h a hundred metres before the Costa Verde's first bend,
      // which is a 131 m radius it could have taken at 203, and it stayed at
      // 152 all the way through and out the other side. Both halves of that
      // are fixed by the same line: far away, 2*a*d swamps the corner and it
      // does not slow down at all; on the way out, the corner behind it stops
      // counting and it is back on the throttle.
      const vSafe = Math.sqrt(budget / k);
      const allowed = Math.sqrt(vSafe * vSafe + 2 * brake * d);
      if (allowed < vT) vT = allowed;
    }
    // Vertical curvature is a loop, and a loop is the opposite problem: too
    // slow and the car falls off the top of it. A floor, not a ceiling.
    if (g.kUp > 0.008) loopMin = Math.max(loopMin, Math.sqrt(5 * 9.81 / g.kUp) * 1.18);
  }
  vT = Math.min(Math.max(vT, loopMin), car.phys.vmax);

  return {
    throttle: v < vT ? 1 : 0,
    brake: v > vT * 1.06 ? 1 : 0,
    // Enough lock to hold the bend at this speed, plus two corrections: back
    // towards the line being driven, and back in line with it.
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
  for (let p = wanted + 0.15; p <= 1.7; p += 0.15) {
    if (testDrive(track, { aggression: p, phys }).ok) return p;
  }
  // Nothing gets round this. The editor does not let such a track be saved, so
  // this is a built track from before it checked, or a shared one -- drive it
  // at what was asked and let the checkpoints pick the car up.
  return wanted;
}

// The fastest this driver gets round this track at all: the pace that does it
// and the time it takes. Null if nothing gets round at all.
export function flatOut(track, phys) {
  let best = null;
  for (const pace of FLAT_CANDIDATES) {
    const r = testDrive(track, { aggression: pace, phys });
    if (r.ok && (!best || r.seconds < best.seconds)) {
      best = { pace, seconds: r.seconds, ok: true };
    }
  }
  return best;
}

// The pace that gets this car round this track in about `seconds`.
//
// Solved per track, because pace does not mean the same thing on two different
// tracks. Pace is a fraction of the car's grip, so it only bites where grip is
// what limits the car: on the Costa Verde, whose corners are wide enough that
// the car is barely ever grip-limited, a whole step of pace is worth a couple
// of seconds; on the Vertigem it is worth ten. A difficulty chosen as a bare
// pace is therefore a different difficulty on every track.
//
// Five runs of the track, about 50 ms each, under the loading screen that is
// already there.
export function paceForTime(track, phys, seconds, maxPace = 1.7) {
  let lo = 0.3, hi = maxPace, best = null;
  for (let i = 0; i < 5; i++) {
    const mid = (lo + hi) / 2;
    const r = testDrive(track, { aggression: mid, phys, maxSeconds: seconds * 2 + 60 });
    // Not finishing means too slow for the loop, not too fast for the corner
    // -- see safePace. So look higher, never lower.
    if (!r.ok) { lo = mid; continue; }
    if (!best || Math.abs(r.seconds - seconds) < Math.abs(best.seconds - seconds)) {
      // `ok` because this pace was just driven round the whole track: the
      // caller does not need to check it again.
      best = { pace: mid, seconds: r.seconds, ok: true };
    }
    if (r.seconds > seconds) lo = mid; else hi = mid;
  }
  return best || { pace: maxPace, seconds: null, ok: false };
}
