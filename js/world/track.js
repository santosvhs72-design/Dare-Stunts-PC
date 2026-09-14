import { quat, v3, clamp } from '../core/math.js';
import { MeshData, hex, shade } from '../core/mesh.js';
import { expand } from './pieces.js';

export const DS = 1.0;              // metres between frames
export const ROAD_HALF = 5.6;       // full-grip half-width
export const WALL_U = 6.2;          // barrier face the car bounces off
const CURB_OUT = 6.35;
const CURB_H = 0.22;
const WALL_H = 0.8;
const WALL_OUT = 6.85;
const APRON = 0.75;
const MESH_STEP = 2;
const CHUNK_SEGMENTS = 30;

const COL = {
  asphaltA: hex('#5b6270'), asphaltB: hex('#525966'),
  line: hex('#e2e8ef'), curbA: hex('#c4423b'), curbB: hex('#eceff2'),
  apron: hex('#98a1ac'), pillar: hex('#9aa3ae'), rail: hex('#c3cad3'),
  tunnel: hex('#8b929c'), tunnelRib: hex('#6f767f'), tunnelLight: hex('#fff6e2'),
  portal: hex('#c9d0d8'), portalEdge: hex('#3a4048'),
  gateStart: hex('#4fbf7a'), gateCp: hex('#ffb43a'), gateEnd: hex('#e8ecf1'),
  gateDark: hex('#22262c'), post: hex('#5b636e'),
};

// Walks the piece list, integrating intrinsic rotations to produce surface frames.
function walk(segments) {
  const frames = [];
  const checkpoints = [];
  let q = quat.id();
  let pos = [0, 0, 0];
  let s = 0;

  for (const sg of segments) {
    if (sg.cp) { checkpoints.push(s); continue; }
    const steps = Math.max(1, Math.round(sg.len / DS));
    const ds = sg.len / steps;
    for (let i = 0; i < steps; i++) {
      frames.push({ q, pos, s, bank: sg.bank, gap: sg.gap, pi: sg.pi, tunnel: sg.tunnel, ds });
      // Pitch is nose-up positive, which is a negative rotation about local X.
      if (sg.yaw) q = quat.mul(q, quat.axisAngle([0, 1, 0], sg.yaw * ds));
      if (sg.pitch) q = quat.mul(q, quat.axisAngle([1, 0, 0], -sg.pitch * ds));
      if (sg.roll) q = quat.mul(q, quat.axisAngle([0, 0, 1], sg.roll * ds));
      q = quat.norm(q);
      pos = v3.mad(pos, quat.fwd(q), ds);
      s += ds;
    }
  }
  frames.push({ q, pos, s, bank: 0, gap: false, pi: -1, ds: DS });
  return { frames, checkpoints, length: s };
}

// Box-blur the bank targets so transitions into and out of banking are gradual.
function smoothBank(frames, passes = 3, radius = 9) {
  let bank = frames.map(f => f.bank);
  for (let p = 0; p < passes; p++) {
    const out = new Array(bank.length);
    for (let i = 0; i < bank.length; i++) {
      let sum = 0, n = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = i + k;
        if (j >= 0 && j < bank.length) { sum += bank[j]; n++; }
      }
      out[i] = sum / n;
    }
    bank = out;
  }
  frames.forEach((f, i) => { f.bank = bank[i]; });
}

function finalise(frames) {
  // Lift the whole ribbon so nothing dips below the ground plane.
  let minY = Infinity;
  for (const f of frames) minY = Math.min(minY, f.pos[1]);
  const lift = -minY + 0.05;

  for (const f of frames) {
    f.pos = [f.pos[0], f.pos[1] + lift, f.pos[2]];
    f.sq = f.bank ? quat.norm(quat.mul(f.q, quat.axisAngle([0, 0, 1], f.bank))) : f.q;
    f.fwd = quat.fwd(f.sq);
    f.up = quat.up(f.sq);
    f.right = quat.right(f.sq);
  }

  // Path curvature, resolved onto the surface axes.
  for (let i = 0; i < frames.length; i++) {
    const a = frames[i], b = frames[Math.min(i + 1, frames.length - 1)];
    const d = Math.max(a.ds, 1e-4);
    const dF = v3.scale(v3.sub(b.fwd, a.fwd), 1 / d);
    a.kUp = v3.dot(dF, a.up);
    a.kRight = v3.dot(dF, a.right);
  }
  return frames;
}

// Cross-section point: lateral offset u, height h above the surface.
const P = (f, u, h) => [
  f.pos[0] + f.right[0] * u + f.up[0] * h,
  f.pos[1] + f.right[1] * u + f.up[1] * h,
  f.pos[2] + f.right[2] * u + f.up[2] * h,
];

function strip(md, a, b, u0, h0, u1, h1, col, flip = false) {
  const p0 = P(a, u0, h0), p1 = P(b, u0, h0), p2 = P(b, u1, h1), p3 = P(a, u1, h1);
  if (flip) md.quad(p3, p2, p1, p0, col);
  else md.quad(p0, p1, p2, p3, col);
}

// Where the ribbon crosses itself at the same height.
//
// A track that comes back through its own path is an ordinary thing to build
// -- a figure of eight is the oldest circuit shape there is -- and the builder
// will happily close a circuit through one. What it was not is drivable: every
// stretch of road carries a kerb, a barrier and a skirt down both sides, so
// two ribbons meeting at grade put four walls across each other. The car
// arrives at 200 km/h and hits a barrier standing in the middle of the road.
//
// Passing over or under is a different matter and always worked: the world
// builds pillars for that. So a crossing is being close in plan *and* close in
// height, and what it needs is for both roads to drop their edges and let each
// other through.
const CROSS_NEAR = WALL_OUT * 2;    // barriers touching, 13.7 m between centres
const CROSS_RISE = 3;               // metres of height that make it a flyover
const CROSS_SEP = 80;               // frames: nearer than this is the same pass
const CROSS_OPEN = 7;               // metres of run-in either side of the meeting
// Two surfaces this close in height are the same piece of ground, and drawing
// both of them is a z-fight. One gives way; see below for which.
const CROSS_FLUSH = 0.4;
const CROSS_PAVE = 7;               // how close the centres must be to give way

function markCrossings(frames, closed) {
  const n = frames.length;
  const open = new Uint8Array(n);
  const hide = new Uint8Array(n);
  const CELL = 16;
  const grid = new Map();
  const key = (a, b) => a + ',' + b;
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const k = key(Math.floor(f.pos[0] / CELL), Math.floor(f.pos[2] / CELL));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  // On a circuit the first and last frames are neighbours, so how far apart two
  // frames are has to go round as well.
  const sep = (i, j) => {
    const d = Math.abs(i - j);
    return closed ? Math.min(d, n - d) : d;
  };

  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const cx = Math.floor(f.pos[0] / CELL), cz = Math.floor(f.pos[2] / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const j of grid.get(key(cx + dx, cz + dz)) || []) {
          if (sep(i, j) < CROSS_SEP) continue;
          const g = frames[j];
          const dy = g.pos[1] - f.pos[1];
          if (Math.abs(dy) > CROSS_RISE) continue;
          const d = Math.hypot(g.pos[0] - f.pos[0], g.pos[2] - f.pos[2]);
          if (d > CROSS_NEAR) continue;
          open[i] = 1;
          // Whoever is underneath gives up their tarmac, and where the two are
          // flush it is settled by index so that exactly one of the pair does
          // -- if both gave way there would be a hole in the road.
          if (d < CROSS_PAVE
              && (dy > CROSS_FLUSH || (Math.abs(dy) <= CROSS_FLUSH && j < i))) {
            hide[i] = 1;
          }
        }
      }
    }
  }

  // Open the edges a little before and after, so the barrier ends where the
  // junction begins rather than in the middle of it.
  const reach = Math.round(CROSS_OPEN / DS);
  const wide = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!open[i]) continue;
    for (let k = -reach; k <= reach; k++) {
      const j = closed ? ((i + k) % n + n) % n : i + k;
      if (j >= 0 && j < n) wide[j] = 1;
    }
  }
  return { open: wide, hide };
}

function buildRoad(frames, cross) {
  const chunks = [];
  let md = new MeshData();
  let segInChunk = 0;
  let curbToggle = 0;

  for (let i = 0; i + MESH_STEP < frames.length; i += MESH_STEP) {
    const a = frames[i], b = frames[i + MESH_STEP];
    if (!a.gap) {
      const tone = Math.floor(i / 16) % 2 ? COL.asphaltB : COL.asphaltA;

      // Inside a junction the other road is already covering this ground, and
      // two surfaces at the same height fight over every pixel of it.
      if (!cross.hide[i]) {
        strip(md, a, b, -ROAD_HALF, 0, -0.22, 0, tone);
        strip(md, a, b, 0.22, 0, ROAD_HALF, 0, tone);
        // Dashed centre line.
        const dash = Math.floor(i / (MESH_STEP * 4)) % 2 === 0;
        strip(md, a, b, -0.22, 0, 0.22, 0, dash ? COL.line : tone);
      }

      // A kerb, a barrier and a skirt down both sides -- except across a
      // junction, where they would be four walls in the middle of the road.
      if (!cross.open[i]) {
        const curb = curbToggle % 2 ? COL.curbA : COL.curbB;
        // Alternating shade reads as structural ribs, which is what makes a
        // loop legible as a concrete tube rather than a flat mass.
        const rib = shade(COL.apron, curbToggle % 4 < 2 ? 1 : 0.86);
        const rail = shade(COL.rail, curbToggle % 6 < 3 ? 1 : 0.9);
        for (const sgn of [-1, 1]) {
          const inner = sgn * ROAD_HALF, outer = sgn * CURB_OUT, wall = sgn * WALL_OUT;
          strip(md, a, b, inner, CURB_H, outer, CURB_H, curb, sgn < 0);
          strip(md, a, b, inner, 0, inner, CURB_H, shade(curb, 0.8), sgn < 0);
          // Barrier: the car bounces off this instead of leaving the track.
          strip(md, a, b, outer, CURB_H, outer, WALL_H, rail, sgn < 0);
          strip(md, a, b, outer, WALL_H, wall, WALL_H, shade(rail, 1.08), sgn < 0);
          // Striped on the outside too. These two faces are the rims of a loop
          // seen head-on, and plain grey made a loop an anonymous wall.
          strip(md, a, b, wall, WALL_H, wall, 0, shade(curb, 0.92), sgn < 0);
          strip(md, a, b, wall, 0, wall, -APRON, rib, sgn < 0);
        }
        // Banded underside: the outer skin of a loop, so it needs rhythm.
        strip(md, a, b, -WALL_OUT, -APRON, WALL_OUT, -APRON,
              shade(COL.apron, curbToggle % 4 < 2 ? 0.74 : 0.6), true);
      }
      curbToggle++;
    }

    if (++segInChunk >= CHUNK_SEGMENTS) {
      if (md.vertexCount) chunks.push(md);
      md = new MeshData();
      segInChunk = 0;
    }
  }
  if (md.vertexCount) chunks.push(md);
  return chunks;
}

// The bore is described in the surface frame, so it rolls and pitches with the
// road: enclose a loop and the tunnel goes over the top with it.
// Vertical side walls carrying an arch, which is what a road tunnel actually is.
// A pure dome springs from near road level and leaves a slot at each side that
// you can see the landscape through.
const BORE_HALF = 7.4;    // just outside the barriers at 6.85
const BORE_SPRING = 2.6;  // where the side wall becomes the arch
const BORE_CROWN = 6.4;
const BORE_FOOT = -0.9;   // tucked below the road apron
const ARCH_FACETS = 10;
const FACADE_W = 12;
const FACADE_H = 7.5;
const FACADE_CY = 2.2;    // rays fan out from here to square off the facade

// Cross-section as an explicit polyline: right foot, up the wall, over the arch,
// down the far wall to the left foot.
const BORE_SECTION = (() => {
  const pts = [[BORE_HALF, BORE_FOOT]];
  for (let i = 0; i <= ARCH_FACETS; i++) {
    const t = (i / ARCH_FACETS) * Math.PI;
    pts.push([Math.cos(t) * BORE_HALF, BORE_SPRING + Math.sin(t) * (BORE_CROWN - BORE_SPRING)]);
  }
  pts.push([-BORE_HALF, BORE_FOOT]);
  return pts;
})();

// Same direction, pushed out to a rectangle: the mouth then sits in a flat wall
// rather than ending at a zero-width cut.
function facadeOut(u, h) {
  const du = u, dh = h - FACADE_CY;
  const ku = Math.abs(du) > 1e-6 ? FACADE_W / Math.abs(du) : Infinity;
  const kh = Math.abs(dh) > 1e-6 ? FACADE_H / Math.abs(dh) : Infinity;
  const k = Math.min(ku, kh);
  return [du * k, FACADE_CY + dh * k];
}

// Pale concrete with a dark reveal at the opening, and built into its own mesh
// so it can be drawn with the brightly lit road group. The mouth only reads as a
// mouth when the wall is clearly lighter than the hole; matching their
// brightness is what turned the entrance into a flat slab.
function borePortal(md, f, flip) {
  for (let i = 0; i < BORE_SECTION.length - 1; i++) {
    const [u0, h0] = BORE_SECTION[i], [u1, h1] = BORE_SECTION[i + 1];
    const [ou0, oh0] = facadeOut(u0, h0), [ou1, oh1] = facadeOut(u1, h1);
    const mix = (a, b) => a + (b - a) * 0.13;

    const q0 = P(f, u0, h0), q1 = P(f, u1, h1);
    const r0 = P(f, mix(u0, ou0), mix(h0, oh0)), r1 = P(f, mix(u1, ou1), mix(h1, oh1));
    const s0 = P(f, ou0, oh0), s1 = P(f, ou1, oh1);
    const col = shade(COL.portal, i % 2 ? 1 : 0.93);

    if (flip) {
      md.quad(r0, r1, q1, q0, COL.portalEdge);
      md.quad(s0, s1, r1, r0, col);
    } else {
      md.quad(q0, q1, r1, r0, COL.portalEdge);
      md.quad(r0, r1, s1, s0, col);
    }
  }
}

function buildTunnels(frames) {
  const chunks = [];
  const portals = new MeshData();
  let md = new MeshData();
  let segInChunk = 0;
  let ring = 0;
  let inside = false;

  const flush = () => {
    if (md.vertexCount) chunks.push(md);
    md = new MeshData();
    segInChunk = 0;
  };

  for (let i = 0; i + MESH_STEP < frames.length; i += MESH_STEP) {
    const a = frames[i], b = frames[i + MESH_STEP];

    if (!a.tunnel) {
      if (inside) { borePortal(portals, a, false); inside = false; }
      flush();
      continue;
    }
    if (!inside) { borePortal(portals, a, true); inside = true; }

    // Ribs are colour only. Giving them a larger radius left an unclosed radial
    // slot at every rib boundary, which showed as sky through the crown.
    const base = ring % 4 === 0 ? COL.tunnelRib : COL.tunnel;

    for (let i = 0; i < BORE_SECTION.length - 1; i++) {
      const [u0, h0] = BORE_SECTION[i], [u1, h1] = BORE_SECTION[i + 1];
      // Strong facet-to-facet contrast so the shape of the bore is legible.
      const lift = (h0 + h1) / 2 / BORE_CROWN;
      const side = (u0 + u1) / 2 / BORE_HALF;
      const tone = 0.52 + 0.4 * lift + 0.14 * side;
      strip(md, a, b, u0, h0, u1, h1, shade(base, tone));
    }

    // Recessed strip lights along the crown.
    if (ring % 3 === 0) {
      const y = BORE_CROWN - 0.3;
      strip(md, a, b, -1.7, y, 1.7, y, COL.tunnelLight, true);
    }

    ring++;
    if (++segInChunk >= CHUNK_SEGMENTS) flush();
  }
  if (inside) borePortal(portals, frames[frames.length - 1], false);
  flush();
  return { bore: chunks, portals: portals.vertexCount ? [portals] : [] };
}

function buildSupports(frames) {
  const md = new MeshData();
  for (let i = 0; i < frames.length; i += 14) {
    const f = frames[i];
    if (f.gap || f.up[1] < 0.55) continue;
    const base = P(f, 0, -APRON);
    const h = base[1];
    if (h < 3.2) continue;
    md.box(base[0], h / 2, base[2], 0.8, h / 2, 0.8, COL.pillar);
  }
  return md.vertexCount ? [md] : [];
}

function gate(md, f, kind) {
  const colTop = kind === 'start' ? COL.gateStart : kind === 'end' ? COL.gateEnd : COL.gateCp;
  const postW = 0.42, height = 7.2, span = CURB_OUT + 1.1;

  for (const sgn of [-1, 1]) {
    for (let k = 0; k < 9; k++) {
      const y0 = k / 9 * height, y1 = (k + 1) / 9 * height;
      const c = k % 2 ? COL.gateDark : COL.post;
      const lo = P(f, sgn * span, y0), hi = P(f, sgn * span, y1);
      const mid = v3.scale(v3.add(lo, hi), 0.5);
      md.box(mid[0], mid[1], mid[2], postW, (y1 - y0) / 2 + 0.01, postW, c);
    }
  }
  // Banner across the top, split into blocks so it reads as striped.
  const blocks = 12;
  for (let k = 0; k < blocks; k++) {
    const u0 = -span + (2 * span) * k / blocks, u1 = -span + (2 * span) * (k + 1) / blocks;
    const c = k % 2 ? colTop : COL.gateDark;
    const p0 = P(f, u0, height), p1 = P(f, u1, height);
    const p2 = P(f, u1, height + 1.5), p3 = P(f, u0, height + 1.5);
    const back = v3.mad([0, 0, 0], f.fwd, 0.22);
    const q0 = v3.add(p0, back), q1 = v3.add(p1, back), q2 = v3.add(p2, back), q3 = v3.add(p3, back);
    md.quad(p0, p1, p2, p3, c);
    md.quad(q1, q0, q3, q2, shade(c, 0.7));
    md.quad(p3, p2, q2, q3, shade(c, 0.9));
  }
}

function buildGates(frames, checkpoints, length, closed) {
  const md = new MeshData();
  const at = s => frames[clamp(Math.round(s / DS), 0, frames.length - 1)];
  gate(md, at(6), 'start');
  for (const s of checkpoints) gate(md, at(s), 'cp');
  // On a circuit the finish *is* the start, so the two would be built in the
  // same place, one inside the other.
  if (!closed) gate(md, at(length - 8), 'end');
  return md.vertexCount ? [md] : [];
}

// Geometry only, no meshes: cheap enough for the editor to call on every edit.
export function walkTrack(pieces) {
  const { frames, checkpoints, length } = walk(expand(pieces));
  smoothBank(frames);
  finalise(frames);

  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const f of frames) {
    x0 = Math.min(x0, f.pos[0]); x1 = Math.max(x1, f.pos[0]);
    z0 = Math.min(z0, f.pos[2]); z1 = Math.max(z1, f.pos[2]);
    y0 = Math.min(y0, f.pos[1]); y1 = Math.max(y1, f.pos[1]);
  }

  return {
    frames, length,
    closed: closes(frames),
    rawCheckpoints: checkpoints,
    checkpoints: checkpoints.filter(s => s > 12 && s < length - 20),
    bounds: { x0, x1, z0, z1, y0, y1 },
  };
}

// A circuit is a track whose end meets its own beginning -- same place, same
// height, same way round. Nothing in a piece list forces that, so it is
// measured rather than declared: build something that happens to come back and
// it can be driven in laps, build something that does not and it stays the
// sprint it always was.
//
// The tolerances are tight on purpose. The seam is driven across at speed with
// the geometry wrapping underneath, so anything the frames do not agree on
// there is a sideways jolt in the picture -- half a metre is already the width
// of the painted line.
const CLOSE_GAP = 0.6;              // metres between the two ends
const CLOSE_RISE = 0.4;             // metres of step in height
const CLOSE_TURN = 2 * Math.PI / 180;

export function closes(frames) {
  const a = frames[0], b = frames[frames.length - 1];
  if (Math.hypot(b.pos[0] - a.pos[0], b.pos[2] - a.pos[2]) > CLOSE_GAP) return false;
  if (Math.abs(b.pos[1] - a.pos[1]) > CLOSE_RISE) return false;
  const fa = quat.fwd(a.sq || a.q), fb = quat.fwd(b.sq || b.q);
  let turn = Math.atan2(fb[0], fb[2]) - Math.atan2(fa[0], fa[2]);
  while (turn > Math.PI) turn -= 2 * Math.PI;
  while (turn < -Math.PI) turn += 2 * Math.PI;
  return Math.abs(turn) <= CLOSE_TURN;
}

export function buildTrack(def) {
  const base = walkTrack(def.pieces);
  const { frames, length } = base;
  const tunnels = buildTunnels(frames);
  const cross = markCrossings(frames, base.closed);

  return {
    ...base,
    def,
    roadMeshes: [...buildRoad(frames, cross), ...buildSupports(frames), ...tunnels.portals],
    tunnelMeshes: tunnels.bore,
    gateMeshes: buildGates(frames, base.rawCheckpoints, length, base.closed),

    // On a circuit only the *geometry* comes back around: a lap's worth of
    // distance is added to the reading, never taken off it. Everything that
    // counts distance -- the ghost, the checkpoints, the lap counter -- can
    // then go on assuming it only ever grows, which is what all of it was
    // written to assume. `base` is the lap this reading belongs to, and it
    // goes back onto the frame's own `s` on the way out, so a caller that
    // stores what it is handed does not quietly fall back a lap.
    frameAt(s) {
      const n = this.frames.length;
      const base = this.closed ? Math.floor(s / this.length) * this.length : 0;
      const x = clamp((s - base) / DS, 0, n - 1.0001);
      const i = Math.floor(x), t = x - i;
      const a = this.frames[i], b = this.frames[i + 1] || a;
      const sq = quat.nlerp(a.sq, b.sq, t);
      return {
        pos: v3.lerp(a.pos, b.pos, t),
        sq,
        fwd: quat.fwd(sq), up: quat.up(sq), right: quat.right(sq),
        kUp: a.kUp + (b.kUp - a.kUp) * t,
        kRight: a.kRight + (b.kRight - a.kRight) * t,
        gap: a.gap, tunnel: a.tunnel,
        bank: a.bank + (b.bank - a.bank) * t,
        s: base + a.s + (b.s - a.s) * t,
      };
    },

    // Nearest frame within a window, used to detect landings after a jump.
    nearest(worldPos, aroundS, window = 90) {
      const n = this.frames.length;
      const len = this.length;
      const base = this.closed ? Math.floor(aroundS / len) * len : 0;
      const mid = Math.round((aroundS - base) / DS);
      const half = Math.round(window / DS);
      let best = null, bestD = Infinity;
      for (let k = -half; k <= half; k += 2) {
        // A jump can take off before the line and land after it, so on a
        // circuit the window has to run past the end of the array and come
        // back in at the front.
        const i = this.closed ? ((mid + k) % n + n) % n : clamp(mid + k, 0, n - 1);
        const d = v3.dist(this.frames[i].pos, worldPos);
        if (d < bestD) { bestD = d; best = this.frames[i]; }
      }
      if (!this.closed) return best;
      // Hand back a distance in the same lap the caller is already in, rather
      // than one that has silently wrapped to the start of the track.
      let s = base + best.s;
      if (s - aroundS > len / 2) s -= len;
      if (aroundS - s > len / 2) s += len;
      return { ...best, s };
    },
  };
}
