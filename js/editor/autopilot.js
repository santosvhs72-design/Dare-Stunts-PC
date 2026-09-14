import { Car, MODE } from '../game/car.js';
import { clamp } from '../core/math.js';

// Lateral budget the reference driver plans around. It has to follow the car's
// own grip, otherwise a low-grip car gets driven at a high-grip car's corner
// speeds and the comparison between models is meaningless.
const gripOf = phys => (phys && phys.mu ? phys.mu : 1.45) * 9.81;

// Drives the track with a lookahead planner to answer one question: can this
// actually be finished? A piece-sequence editor makes it easy to build something
// impossible (a loop straight out of a hairpin), so the editor checks before
// letting a track be saved.
export function testDrive(track, { aggression = 1, maxSeconds = 240, phys = null } = {}) {
  const car = new Car(track, phys);
  car.respawnS = 0;
  const dt = 1 / 120;
  const GRIP = gripOf(car.phys);
  const budget = GRIP * aggression;
  const failures = [];
  let t = 0, crashes = 0, furthest = 0, cpIndex = 0, topSpeed = 0, stalled = 0;

  while (t < maxSeconds) {
    const f = track.frameAt(car.s);

    let maxK = 0, loopK = 0;
    const ahead = Math.max(22, car.v * 1.5 + 20);
    for (let d = 5; d < ahead; d += 5) {
      const g = track.frameAt(Math.min(car.s + d, track.length - 1));
      maxK = Math.max(maxK, Math.abs(g.kRight));
      if (g.kUp > 0.008) loopK = Math.max(loopK, g.kUp);
    }
    let vT = maxK > 1e-4 ? Math.sqrt(budget / maxK) : 999;
    if (loopK > 0) vT = Math.max(vT, Math.sqrt(5 * 9.81 / loopK) * 1.18);
    vT = Math.min(vT, car.phys.vmax);

    const wasCrashed = car.mode === MODE.CRASHED;
    car.update(dt, {
      throttle: car.v < vT ? 1 : 0,
      brake: car.v > vT * 1.06 ? 1 : 0,
      steer: clamp(car.v * car.v * f.kRight / GRIP - car.u * 0.055 - car.psi * 1.7, -1, 1),
      handbrake: false,
    });
    t += dt;
    topSpeed = Math.max(topSpeed, car.speedKmh);

    // A car stuck part-way up a loop it cannot clear will fall and retry forever,
    // so give up once it stops making progress rather than burning the full budget.
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
