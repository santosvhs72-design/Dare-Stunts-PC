import { v3, quat } from '../core/math.js';
import { MeshData, hex, shade } from '../core/mesh.js';
import { Car, MODE } from './car.js';
import { plan } from './driver.js';
import { ROAD_HALF } from '../world/track.js';

// A car on the track with you, driven by the same reference driver the editor
// uses to decide whether a built track is possible at all (game/driver.js).
//
// It is a real car, not a recording: it has the same physics as yours, the
// same grip, the same walls to bounce off, and it is deciding what to do with
// the controls every frame. It can be baulked, it moves over when you come
// alongside, and if you touch it you both feel it. What it does not have is a
// racing line -- it drives the middle of the road and brakes for what is
// coming, which is quick enough to beat most laps and slow enough to be beaten
// by a good one.

// Its own colour, not one of the three cars'. Whichever car you picked, the
// rival drives the same model -- the race is about driving, not about the
// machinery -- so the paint is the only thing telling the two apart, and it
// cannot be a colour a player's car might also be wearing.
export const RIVAL_ACCENT = '#7fd0ff';

// How far the body floats above the surface, matching what the ghost uses.
const RIDE = 0.05;

// Close enough to be worth reacting to, along the road.
const NEAR_S = 14;
// Touching: the bodies are about 1.7 m wide, so a little under two.
const TOUCH_S = 4.2;
const TOUCH_U = 1.9;
// Which side of the road to take when someone is alongside. Just over half the
// road's half-width: out of the way, but well inside the kerbs.
const LANE = ROAD_HALF * 0.52;

// How hard the rival tries, as a share of the time the reference driver needs
// for this track flat out (see paceForShare in game/driver.js).
//
// A share and not a pace, and that distinction is the whole of this setting's
// history. It was a time first -- bisection against the track's own target --
// and that was wrong because a track's target is a generous number meant for a
// player. Then it was a bare pace, and that was wrong too, in a way that took
// longer to see: pace is a fraction of the car's grip, so it only bites where
// grip is what limits the car. On the Costa Verde, whose corners are wide
// enough that the car is barely ever grip-limited, 1.15 was within three
// seconds of flat out. On the Serra Alta it was seven off, and on the Vertigem
// ten -- the hardest rival in the game, leaving ten seconds on the table on
// the track with the tightest corners.
//
// A share fixes that by construction: 1.0 is flat out on whatever track this
// is, and every other level is a stated distance behind it.
export const RIVAL_LEVELS = [
  // About 25% off the pace, which is a comfortable win for a clean lap.
  { id: 'ameno', label: 'ameno', share: 0.80 },
  // Close enough that a good lap wins and a merely tidy one does not.
  { id: 'rapido', label: 'rápido', share: 0.91 },
  // Everything the reference driver has: never lifting, corners taken at
  // whatever the tyres will still hold, the odd barrier brushed. There is
  // nothing above this without teaching it to drive better.
  { id: 'impiedoso', label: 'impiedoso', share: 1 },
];

export const DEFAULT_LEVEL = 'rapido';

export const levelById = id =>
  RIVAL_LEVELS.find(l => l.id === id) || RIVAL_LEVELS.find(l => l.id === DEFAULT_LEVEL);

export class Rival {
  // `pace` is how close to the limit it drives -- solved for this track and
  // this car by paceForShare (game/driver.js) from the chosen level's share.
  constructor(track, phys, pace) {
    this.track = track;
    this.pace = pace;
    this.car = new Car(track, phys);
    this.reset();
  }

  reset() {
    this.car.respawnS = 0;
    this.car.reset(0);
    // Started alongside rather than inside you. The driver pulls back to the
    // middle within a few seconds, which is exactly what a car that got a
    // clean start off the outside of the grid would do.
    this.car.u = -2.4;
    this.cpIndex = 0;
    this.lap = 0;
    this.finishMs = null;
    this.lane = 0;
  }

  // One step of the rival's own race. `player` is the car it is racing, which
  // it can see; `finishS` is the distance at which its race is over.
  update(dt, timeMs, player, finishS) {
    const car = this.car;
    // Once it has finished it stops being part of the race and just rolls to a
    // stop, rather than carrying on round and coming back past you.
    if (this.finishMs != null) {
      car.update(dt, { throttle: 0, brake: 0.35, steer: 0, handbrake: false });
      return;
    }

    this.lane = this.laneFor(player);
    car.update(dt, plan(car, this.track, {
      pace: this.pace, wrap: this.track.closed, lane: this.lane,
    }));

    this.keepCheckpoints();
    if (car.s >= finishS) this.finishMs = timeMs;
  }

  // Where across the road to be. Normally the middle; out of the way when
  // there is a car alongside, on the opposite side to it.
  //
  // It moves over rather than defending, and that is a deliberate choice about
  // what this is for. A rival that blocks is a rival you lose to because it
  // was in the way, which is not the same as losing to a faster lap.
  laneFor(player) {
    if (!player) return 0;
    const ds = player.s - this.car.s;
    if (Math.abs(ds) > NEAR_S) return 0;
    const side = player.u >= this.car.u ? -1 : 1;
    // Full width only when genuinely level; fading in as you arrive, so it
    // does not jerk sideways the moment you come within range.
    const closeness = 1 - Math.abs(ds) / NEAR_S;
    return side * LANE * closeness;
  }

  // The same respawn rule the player gets: back to the last checkpoint passed,
  // not to wherever it happened to come off.
  keepCheckpoints() {
    const cps = this.track.checkpoints;
    const len = this.track.length;
    const lapBase = this.lap * len;
    if (this.cpIndex < cps.length && this.car.s - lapBase >= cps[this.cpIndex]) {
      this.car.respawnS = Math.max(0, lapBase + cps[this.cpIndex] - 4);
      this.cpIndex++;
    }
    if (this.cpIndex >= cps.length && this.car.s - lapBase >= len - 12) {
      this.lap++;
      this.cpIndex = 0;
    }
  }

  // Bodywork. Track coordinates on both sides, because that is what the cars
  // are: comparing world positions would have them collide through the middle
  // of a loop with one car on the outside of it.
  //
  // Deliberately gentle -- a shove apart and some speed out of whoever ran
  // into whom, and nothing that can spin either car. Touching in a corner
  // should cost a place, not the race.
  // Returns how hard the two touched, in the same units Sound.wallHit reads,
  // or 0 for no contact.
  contact(player) {
    const car = this.car;
    if (car.mode !== MODE.ROAD || player.mode !== MODE.ROAD) return 0;
    const ds = car.s - player.s;
    const du = car.u - player.u;
    if (Math.abs(ds) > TOUCH_S || Math.abs(du) > TOUCH_U) return 0;

    // Push apart along the road's width, hardest when most overlapped.
    const dir = du >= 0 ? 1 : -1;
    const overlap = (TOUCH_U - Math.abs(du)) * 0.5;
    car.u += overlap * dir;
    player.u -= overlap * dir;
    car.vu += overlap * dir * 4;
    player.vu -= overlap * dir * 4;

    // Whoever is behind loses more, because whoever is behind ran into whoever
    // is in front. Scaled by how much of the hit was head-on rather than a
    // graze down the side.
    const square = 1 - Math.abs(du) / TOUCH_U;
    const behind = ds < 0 ? car : player;
    const lost = 4.5 * square;
    behind.v = Math.max(0, behind.v - lost);
    // The speed that went missing is what the hit was worth, and it is already
    // in metres per second -- the same thing wallHit is given for a barrier.
    return lost;
  }

  // Where the body is in the world, for drawing. Same reconstruction the ghost
  // uses, so a rival inside a loop sits on the surface upside down like
  // everything else does.
  pose() {
    const car = this.car;
    if (car.mode === MODE.AIR) return { pos: car.pos, q: car.q };
    const f = this.track.frameAt(car.s);
    const pos = v3.mad(v3.mad(f.pos, f.right, car.u), f.up, RIDE);
    return { pos, q: quat.mul(f.sq, quat.axisAngle([0, 1, 0], car.psi)) };
  }

  // How far ahead of the player it is, in metres -- negative means behind.
  gapTo(player) {
    return this.car.s - player.s;
  }
}

// The rival's own bodywork, in its own colour. Same shape as the ghost's,
// because it is the same thing seen solid: this game has never needed a car
// model for the player, who is inside one.
export function buildRivalMesh() {
  const col = hex(RIVAL_ACCENT);
  const dark = shade(col, 0.3);
  const glass = shade(col, 0.55);
  const m = new MeshData();
  m.box(0, 0.52, 0.05, 0.86, 0.26, 2.00, col);
  m.box(0, 0.95, -0.25, 0.68, 0.22, 0.92, glass);
  m.box(0, 0.80, 1.55, 0.70, 0.10, 0.45, col);
  m.box(0, 1.02, -1.72, 0.72, 0.06, 0.12, col);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      m.box(sx * 0.88, 0.30, sz * 1.32, 0.10, 0.30, 0.30, dark);
    }
  }
  return m;
}
