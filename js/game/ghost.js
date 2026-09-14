// The record holder's ghost: a replay of the fastest lap, driven alongside you.
//
// A lap is stored as the car's *track-relative* state rather than world
// coordinates -- arc length, lateral offset, height above the surface, and
// heading versus the track. Three reasons. It is compact; it interpolates
// cleanly, because all four vary smoothly even where the road itself loops or
// corkscrews; and reconstructing through track.frameAt() puts the ghost exactly
// on the surface it was driven on, upside down inside a loop included.
//
// Each sample also carries a forward offset, which is zero on the road but is
// the whole of a jump: airborne, the car's arc length stays pinned to the ramp
// it left, so without it a leap reconstructs as standing still on the lip.
//
// Samples sit at fixed time intervals, so sample k is the car at k*STEP_MS and
// playback needs no timestamps.
import { v3, quat, mat4 } from '../core/math.js';
import { MeshData, hex, shade } from '../core/mesh.js';
import { MODE } from './car.js';
import { profileKey } from '../ui/profiles.js';

// How the ghost is painted. It is a hint about a line, not a car in the race,
// so it stays faint enough to see the road through it; the raised ambient keeps
// it readable at that alpha, where shading alone would lose it against tarmac.
export const GHOST_ALPHA = 0.12;
export const GHOST_AMBIENT = 0.68;

export const STEP_MS = 50;          // 20 Hz; the line is smooth between samples
const KEY = id => profileKey(`ghost.${id}`);
const MAX_MS = 10 * 60 * 1000;      // refuse to grow without bound on a stuck run

const STRIDE = 5;    // s, lateral, height, forward, heading
// No car covers this much ground in one 50 ms sample (the fastest tops out
// near 4 m), so a bigger step is a respawn, not driving.
const MAX_STEP_M = 15;
const RIDE = 0.05;   // how far the body floats above the surface, as detach() uses

const r2 = x => Math.round(x * 100) / 100;
const r3 = x => Math.round(x * 1000) / 1000;

/* ------------------------------------------------------------- recording -- */

export class GhostRecorder {
  constructor(track) {
    this.track = track;
    this.p = [];
  }

  // Called every frame while racing; emits however many fixed-interval samples
  // the clock has passed, so the sample index is always time / STEP_MS.
  sample(car, timeMs) {
    if (timeMs > MAX_MS) return;
    while (this.p.length / STRIDE * STEP_MS <= timeMs) {
      const f = this.track.frameAt(car.s);
      let u, h, w = 0;
      if (car.mode === MODE.AIR) {
        // Airborne, the car really does have a world position, and its arc
        // length stays frozen at the take-off frame -- so offsets measured
        // against that frame put the jump back exactly where it flew.
        const d = v3.sub(car.pos, f.pos);
        u = v3.dot(d, f.right);
        h = v3.dot(d, f.up);
        w = v3.dot(d, f.fwd);
      } else {
        // On the road there is no world position to read: the simulation works
        // in track coordinates and the camera is derived from them every frame
        // (see Car.cameraTarget). The state itself is the position.
        u = car.u;
        h = RIDE;
      }
      this.p.push(r2(car.s), r2(u), r2(h), r2(w), r3(car.psi));
    }
  }
}

// One lap out of a recorded race, rebased so it starts where a lap starts.
//
// On a circuit the record is the best single lap, so that is the lap worth
// keeping and racing against -- the whole three-lap run would be three times
// too long and would never match the time it claims to be. Samples sit at
// fixed intervals, so the lap is a slice; the distances have a whole number of
// laps taken off them, which is what puts it back at the start of the track.
export function lapSlice(recorder, fromMs, toMs, dropS) {
  const p = recorder.p;
  const n = Math.floor(p.length / STRIDE);
  const a = Math.max(0, Math.floor(fromMs / STEP_MS));
  const b = Math.min(n - 1, Math.ceil(toMs / STEP_MS));
  const out = [];
  for (let i = a; i <= b; i++) {
    const k = i * STRIDE;
    out.push(r2(p[k] - dropS), p[k + 1], p[k + 2], p[k + 3], p[k + 4]);
  }
  return { p: out };
}

export function saveGhost(trackId, recorder, carId, ms) {
  if (!recorder || recorder.p.length < STRIDE * 2) return false;
  try {
    localStorage.setItem(KEY(trackId), JSON.stringify({
      v: 2, step: STEP_MS, car: carId, ms: Math.round(ms), p: recorder.p,
    }));
    return true;
  } catch { return false; }   // private mode, or quota
}

export function loadGhost(trackId) {
  let raw = null;
  try { raw = localStorage.getItem(KEY(trackId)); } catch { return null; }
  if (!raw) return null;
  try {
    const g = JSON.parse(raw);
    if (g && g.v !== 2) return null;   // older layout had no forward offset
    if (!g || !Array.isArray(g.p) || g.p.length < STRIDE * 2) return null;
    return g;
  } catch { return null; }
}

export function clearGhost(trackId) {
  try { localStorage.removeItem(KEY(trackId)); } catch { /* ignore */ }
}

// Whether the ghost is drawn at all, remembered between races. Deliberately not
// under KEY(): that namespace is one entry per track id, and a track called
// "show" would quietly overwrite the setting.
const SHOWN_KEY = 'velocidadecega.ghostvisible';

export function ghostShown() {
  try { return localStorage.getItem(SHOWN_KEY) !== '0'; } catch { return true; }
}

export function setGhostShown(on) {
  try { localStorage.setItem(SHOWN_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}

/* -------------------------------------------------------------- playback -- */

export class GhostPlayer {
  constructor(data, track) {
    this.p = data.p;
    this.step = data.step || STEP_MS;
    this.car = data.car || null;
    this.ms = data.ms || 0;
    this.track = track;
    this.n = Math.floor(this.p.length / STRIDE);
    this._cursor = 0;
  }

  // Where the ghost was at this point in its lap, or null once it has finished
  // (at which point there is nothing left to draw).
  // One sample, placed in the world.
  poseAt(k) {
    const p = this.p, a = k * STRIDE;
    const f = this.track.frameAt(p[a]);
    const pos = v3.add(
      v3.add(v3.mad(f.pos, f.right, p[a + 1]), v3.scale(f.up, p[a + 2])),
      v3.scale(f.fwd, p[a + 3]));
    // Heading is the track's own orientation turned about the surface normal,
    // so the ghost banks with the road and stays flat on it -- the same
    // expression Car.cameraTarget uses.
    const q = quat.mul(f.sq, quat.axisAngle([0, 1, 0], p[a + 4]));
    return { pos, q, s: p[a] };
  }

  at(timeMs) {
    const x = timeMs / this.step;
    if (x >= this.n - 1) return null;
    const i = Math.max(0, Math.floor(x));
    const t = x - i;
    // Blend the two reconstructed poses rather than the stored numbers. Across
    // a landing the numbers either side are measured against different track
    // frames, so averaging them means nothing -- averaging two world positions
    // always does.
    const j = Math.min(i + 1, this.n - 1);
    const A = this.poseAt(i), B = this.poseAt(j);
    // A respawn after a crash moves the car much further than any speed allows.
    // Blending across that jump would fling the ghost over the scenery, so hold
    // the earlier pose until the next sample instead.
    if (Math.abs(this.p[j * STRIDE] - this.p[i * STRIDE]) > MAX_STEP_M) return A;
    return {
      pos: v3.lerp(A.pos, B.pos, t),
      q: quat.nlerp(A.q, B.q, t),
      s: A.s + (B.s - A.s) * t,
    };
  }

  // Time the ghost took to reach this distance, for the gap readout. The cursor
  // only moves forward, so this stays O(1) per frame over a lap.
  timeAt(s) {
    const p = this.p;
    if (s <= p[0]) return 0;
    let i = this._cursor;
    while (i + 1 < this.n && p[(i + 1) * STRIDE] < s) i++;
    this._cursor = i;
    if (i + 1 >= this.n) return null;          // ghost never got this far
    const s0 = p[i * STRIDE], s1 = p[(i + 1) * STRIDE];
    const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    return (i + t) * this.step;
  }

  reset() { this._cursor = 0; }
}

/* ------------------------------------------------------------------ mesh -- */

// The game is first person and has never needed a car model, so the ghost
// brings its own. Kept deliberately blocky to match the flat-shaded world.
// Local +Z forward, +Y up, origin on the road surface.
export function buildGhostMesh(accentHex) {
  const col = hex(accentHex || '#ffb43a');
  const dark = shade(col, 0.35);
  const glass = shade(col, 0.7);
  const m = new MeshData();
  m.box(0, 0.52, 0.05, 0.86, 0.26, 2.00, col);      // chassis
  m.box(0, 0.95, -0.25, 0.68, 0.22, 0.92, glass);   // cabin
  m.box(0, 0.80, 1.55, 0.70, 0.10, 0.45, col);      // nose
  m.box(0, 1.02, -1.72, 0.72, 0.06, 0.12, col);     // rear wing
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      m.box(sx * 0.88, 0.30, sz * 1.32, 0.10, 0.30, 0.30, dark);
    }
  }
  return m;
}

export const ghostModelMatrix = (pose) => mat4.model(pose.q, pose.pos);
