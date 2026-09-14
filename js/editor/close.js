// Closing a circuit: the pieces that take the end of a track back to its own
// beginning, so it can be driven in laps.
//
// The builder places pieces one after another from a cursor, and nothing makes
// that cursor come home -- a track that closes by hand is luck. So this works
// it out: a curve, a straight and a curve (the classic three-piece join), with
// the radius searched over until one of them lands.
//
// The arithmetic below is only a proposal. Every candidate is walked with the
// real track builder and measured with the real closure test, and only a
// candidate that actually closes is returned. That way nothing here has to be
// exactly right -- the banking, the ramp integrals, the way a piece rounds its
// own length -- it only has to be close enough for the search to find.
import { walkTrack, closes } from '../world/track.js';
import { quat } from '../core/math.js';

const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;
const turn = a => ((a % TAU) + TAU) % TAU;      // into [0, 2pi)

const RADII = [70, 90, 55, 110, 140, 45, 180, 34];
const STEEP = 14;            // degrees of a height-correcting climb
const LONG = 80;             // and the longest one piece is allowed to be
const BANK = 7;

const headOf = f => {
  const d = quat.fwd(f.sq || f.q);
  return Math.atan2(d[0], d[2]);
};

// Where the track has got to once every piece is walked, measured against
// where it began -- the first frame does not sit at exactly zero height, so
// "level" means level with the start, not level with the origin.
function endPose(pieces) {
  const w = walkTrack(pieces);
  const f = w.frames[w.frames.length - 1];
  return { x: f.pos[0], y: f.pos[1] - w.frames[0].pos[1], z: f.pos[2], psi: headOf(f) };
}

// Every three-piece join of one radius: curve, straight, curve, for each of the
// four ways round the two curves can go.
//
// Both curves the same way leaves the two turning circles on the same side of
// the straight, and the straight is the line between their centres. Opposite
// ways puts them either side of it, which is only possible if the circles are
// far enough apart to fit between them -- and which of the two crossing lines
// is the right one is a question of signs that is cheaper to answer by trying
// both than by getting right.
function* joins(p, R) {
  for (const d0 of ['r', 'l']) {
    for (const d1 of ['r', 'l']) {
      const s0 = d0 === 'r' ? 1 : -1, s1 = d1 === 'r' ? 1 : -1;
      // Centre of a turning circle is one radius off to the side being turned
      // to; the track starts at the origin facing +Z.
      const c0 = [p.x + s0 * R * Math.cos(p.psi), p.z - s0 * R * Math.sin(p.psi)];
      const c1 = [s1 * R, 0];
      const vx = c1[0] - c0[0], vz = c1[1] - c0[1];
      const D = Math.hypot(vx, vz);
      const theta = Math.atan2(vx, vz);
      let lines;
      if (d0 === d1) lines = [{ psiT: theta, run: D }];
      else if (D < 2 * R) continue;
      else {
        const al = Math.asin(2 * R / D), run = Math.sqrt(D * D - 4 * R * R);
        lines = [{ psiT: theta + al, run }, { psiT: theta - al, run }];
      }
      for (const { psiT, run } of lines) {
        const a1 = d0 === 'r' ? turn(psiT - p.psi) : turn(p.psi - psiT);
        const a2 = d1 === 'r' ? turn(-psiT) : turn(psiT);
        const u = [a1 * DEG, run, a2 * DEG];
        yield { u, d0, d1, R, pieces: shape(u, d0, d1, R) };
      }
    }
  }
}

// A circuit has to come back to its own height as well as its own place, and a
// climb is already a complete gesture -- it rises and returns to level on its
// own, so one of them is a step up, not a ramp needing a ramp back.
//
// How big a step a given climb is, is an integral over a pitch that varies
// along the piece. Nobody needs that in closed form: the length is bisected
// until the measured height lands, and where one piece at full tilt is not
// enough, another goes in front of it.
function levelOut(pieces, want = 0.12) {
  const out = [...pieces];
  for (let guard = 0; guard < 8; guard++) {
    const dy = endPose(out).y;
    if (Math.abs(dy) <= want) return out;
    const t = dy < 0 ? 'climb' : 'drop';        // the end sits low, so it climbs
    const most = { t, deg: STEEP, len: LONG };
    // Still short even at full tilt: take one whole step and look again.
    if (Math.abs(endPose([...out, most]).y) > want
        && Math.sign(endPose([...out, most]).y) === Math.sign(dy)) {
      out.push(most);
      continue;
    }
    // Two ways to size one piece. A gentle angle over a decent length is the
    // better-looking road, so it is tried first; only a step too big for that
    // falls back to standing the same length on end.
    for (const [k, lo0, hi0, fixed] of [['deg', 0.4, STEEP, 40], ['len', 1, LONG, STEEP]]) {
      const make = v => (k === 'deg' ? { t, deg: v, len: fixed } : { t, deg: fixed, len: v });
      let lo = lo0, hi = hi0;
      if (Math.sign(endPose([...out, make(hi)]).y) === Math.sign(dy)) continue;  // cannot reach
      for (let i = 0; i < 26; i++) {
        const mid = (lo + hi) / 2;
        const y = endPose([...out, make(mid)]).y;
        if (Math.abs(y) <= want) { out.push(make(mid)); return out; }
        if (dy < 0 ? y < 0 : y > 0) lo = mid; else hi = mid;
      }
      out.push(make((lo + hi) / 2));
      return out;
    }
    return out;
  }
  return out;
}

// How far a join misses by, as one number. The track is walked in one-metre
// steps and each step turns before it moves, so the road the builder actually
// lays is never quite the arc the arithmetic above drew -- over a few kilometres
// that difference is metres. Rather than model it, measure it.
const KHEAD = 60;            // metres a radian of heading error is worth

function miss(pieces) {
  const w = walkTrack(pieces);
  const a = w.frames[0], b = w.frames[w.frames.length - 1];
  let dh = headOf(b) - headOf(a);
  while (dh > Math.PI) dh -= TAU;
  while (dh < -Math.PI) dh += TAU;
  return {
    r: [b.pos[0] - a.pos[0], b.pos[2] - a.pos[2], dh * KHEAD],
    size: Math.hypot(b.pos[0] - a.pos[0], b.pos[2] - a.pos[2]) + Math.abs(dh) * KHEAD,
    length: w.length,
  };
}

// The join written out from its three numbers, so the search can vary them.
const shape = (u, d0, d1, R) => {
  const out = [];
  if (u[0] > 0.5) out.push({ t: 'c', r: R, a: u[0], dir: d0, bank: BANK });
  if (u[1] > 1) out.push({ t: 's', len: u[1] });
  if (u[2] > 0.5) out.push({ t: 'c', r: R, a: u[2], dir: d1, bank: BANK });
  return out;
};

// Newton on three numbers -- how far round the first curve goes, how long the
// straight is, how far round the last curve goes -- against the three things
// that have to come out right: two of position and one of heading.
function refine(base, u0, d0, d1, R) {
  let u = [...u0];
  for (let step = 0; step < 7; step++) {
    const f0 = miss([...base, ...shape(u, d0, d1, R)]);
    if (f0.size < 0.25) return [...base, ...shape(u, d0, d1, R)];
    const h = [0.4, 3, 0.4];                    // degrees, metres, degrees
    const J = [];
    for (let k = 0; k < 3; k++) {
      const up = [...u]; up[k] += h[k];
      const fk = miss([...base, ...shape(up, d0, d1, R)]);
      J.push([(fk.r[0] - f0.r[0]) / h[k], (fk.r[1] - f0.r[1]) / h[k], (fk.r[2] - f0.r[2]) / h[k]]);
    }
    // Solve J^T d = -r by Cramer. J is stored by column, so det works out the
    // same either way round.
    const m = [[J[0][0], J[1][0], J[2][0]], [J[0][1], J[1][1], J[2][1]], [J[0][2], J[1][2], J[2][2]]];
    const det3 = a =>
      a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
      - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
      + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    const D = det3(m);
    if (!isFinite(D) || Math.abs(D) < 1e-9) break;
    const b = [-f0.r[0], -f0.r[1], -f0.r[2]];
    const sub = k => m.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)));
    const d = [det3(sub(0)) / D, det3(sub(1)) / D, det3(sub(2)) / D];
    u = [turn((u[0] + d[0]) * Math.PI / 180) * DEG, Math.max(0, u[1] + d[1]),
         turn((u[2] + d[2]) * Math.PI / 180) * DEG];
  }
  const out = [...base, ...shape(u, d0, d1, R)];
  return miss(out).size < 0.5 ? out : null;
}

// Where the join would lie on top of road that is already there.
//
// Crossing is fine, and is no longer anything this has to avoid: two ribbons
// meeting at an angle are built as a proper junction now, with both roads
// dropping their barriers and letting each other through (markCrossings, in
// world/track.js). A figure of eight is a perfectly good circuit.
//
// What is still a mess is two ribbons running *along* each other at the same
// height: they fight over the same ground and neither reads as a road. So a
// clash is being close in plan, close in height, and pointed the same way.
//
// Frames are a metre apart, so comparing a long track against a long join pair
// by pair is millions of tests. They go into a coarse grid first, and only the
// nine squares around each point of the join are looked at.
// Measured between centrelines, so it has to be at least as wide as the road
// actually is: the barriers stand at 6.85 m either side, which is 13.7 m of
// tarmac from one outside edge to the other. At 11 m two ribbons could pass
// this test with their barriers overlapping by nearly three metres -- and a
// barrier across the road is not a near miss, it is a wall.
const CLASH_NEAR = 15;
// How far apart two headings have to be before this counts as crossing rather
// than overlapping. Generous: at 40 degrees two roads still meet in something
// that reads as a junction, and below that they are starting to merge.
const CLASH_ANGLE = Math.cos(40 * Math.PI / 180);
const CLASH_RISE = 4.5;      // metres of height that make it a flyover instead
// At least CLASH_NEAR, or the nine squares looked at around each point do not
// reach as far as the test they are there to serve and near misses slip
// through the corners of the grid.
const CELL = 16;
const KEEP = 26;             // the two ends, where the join is meant to meet

function clashes(frames, from) {
  const key = (a, b) => a + ',' + b;
  const grid = new Map();
  const endS = frames[frames.length - 1].s;
  for (let i = 0; i < from; i++) {
    const f = frames[i];
    if (f.s < KEEP) continue;                 // the start, which it must reach
    const k = key(Math.floor(f.pos[0] / CELL), Math.floor(f.pos[2] / CELL));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(f);
  }
  let n = 0;
  for (let i = from; i < frames.length; i++) {
    const f = frames[i];
    if (f.s > endS - KEEP) continue;          // where it comes home again
    const cx = Math.floor(f.pos[0] / CELL), cz = Math.floor(f.pos[2] / CELL);
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx++) {
      for (let dz = -1; dz <= 1 && !hit; dz++) {
        for (const g of grid.get(key(cx + dx, cz + dz)) || []) {
          if (Math.abs(g.pos[1] - f.pos[1]) > CLASH_RISE) continue;
          if (Math.hypot(g.pos[0] - f.pos[0], g.pos[2] - f.pos[2]) >= CLASH_NEAR) continue;
          // Pointed across it rather than along it: a junction, which is fine.
          const dot = g.fwd[0] * f.fwd[0] + g.fwd[2] * f.fwd[2];
          if (Math.abs(dot) < CLASH_ANGLE) continue;
          hit = true; break;
        }
      }
    }
    if (hit) n++;
  }
  return n;
}

// Generated pieces are rounded to something a person can read and then edit by
// hand. How far they can be rounded depends on the track, so it is tried coarse
// first and only kept if the track still closes afterwards.
const round = (v, d) => Number(v.toFixed(d));

function tidy(p, d) {
  if (p.t === 'c') return { ...p, a: round(p.a, d) };
  if (p.t === 's') return { ...p, len: round(p.len, d) };
  if (p.t === 'climb' || p.t === 'drop') return { ...p, deg: round(p.deg, d), len: round(p.len, d) };
  return p;
}

/**
 * Returns the piece list with a join appended so the track closes, or null if
 * no join was found. Never modifies the list it is given.
 */
export function closeCircuit(pieces) {
  if (!pieces || !pieces.length) return null;
  const base = levelOut(pieces);
  const p = endPose(base);

  const baseLen = walkTrack(base).length;
  const startOfJoin = w => {
    const i = w.frames.findIndex(f => f.s >= baseLen - 0.5);
    return i < 0 ? w.frames.length : i;
  };

  // Every shape the arithmetic can propose, each walked once and ranked by
  // whether it lands on the existing road and then by how close it already is.
  // Ranking on the rough shape rather than the refined one is deliberate:
  // refining is expensive and the refinement moves a join by metres, not by
  // enough to take it off a piece of road it was lying along.
  const tries = [];
  for (const R of RADII) {
    for (const j of joins(p, R)) {
      const w = walkTrack([...base, ...j.pieces]);
      tries.push({ ...j, bad: clashes(w.frames, startOfJoin(w)), off: miss([...base, ...j.pieces]).size });
    }
  }
  tries.sort((a, b) => (a.bad - b.bad) || (a.off - b.off));

  let best = null;
  for (const j of tries.slice(0, 6)) {
    const got = refine(base, j.u, j.d0, j.d1, j.R);
    if (!got) continue;
    if (!closes(walkTrack(got).frames)) continue;
    // Round the generated pieces to numbers a person can read and adjust. The
    // shift is centimetres, but it is still checked rather than assumed.
    let kept = got;
    for (const d of [1, 2, 3]) {
      const neat = got.map((q, i) => (i < pieces.length ? q : tidy(q, d)));
      if (closes(walkTrack(neat).frames)) { kept = neat; break; }
    }
    const wk = walkTrack(kept);
    const bad = clashes(wk.frames, startOfJoin(wk));
    // A join that keeps off the road already laid beats a shorter one that
    // does not, however much longer it has to go round to manage it.
    if (!best || bad < best.bad || (bad === best.bad && wk.length < best.length)) {
      best = { pieces: kept, length: wk.length, bad };
    }
  }
  return best ? best.pieces : null;
}
