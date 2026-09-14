import { DEG } from '../core/math.js';

const seg = o => ({ len: 0, yaw: 0, pitch: 0, roll: 0, bank: 0, gap: false, ...o });

const S = len => [seg({ len })];

// Banking tilts the outside edge up, so the surface normal leans into the turn.
const C = (radius, angleDeg, dir = 'r', bankDeg = 0) => {
  const a = angleDeg * DEG, len = radius * a, s = dir === 'r' ? 1 : -1;
  return [seg({ len, yaw: s * a / len, bank: -s * bankDeg * DEG })];
};

const UP = (deg, len) => [seg({ len, pitch: deg * DEG / len })];
const DN = (deg, len) => [seg({ len, pitch: -deg * DEG / len })];

// One turn of a helix: constant curvature bends the path toward the surface,
// constant torsion walks it along the axis. Returns to level after a full turn.
// Loops and corkscrews are the same primitive, only the proportions differ: a
// loop is a big radius advancing a little sideways, a corkscrew a small radius
// advancing a long way forward.
const helix = (radius, axialLen, sign) => {
  const c = axialLen / (2 * Math.PI);
  const d2 = radius * radius + c * c;
  return [seg({
    len: 2 * Math.PI * Math.sqrt(d2),
    pitch: radius / d2,
    roll: sign * c / d2,
  })];
};

// A planar loop cannot work: a curve that turns a full 360 deg and comes back
// level with both ends pointing the same way must cross itself, so the entry
// ribbon and the exit ribbon intersect and the car drives in through a wall and
// out through another. Measured clearance was 0.1-0.6 m for every teardrop
// weighting tried, circle included. Real loops dodge this the same way: they
// spiral slightly, so the rising and falling branches pass beside each other.
const LOOP_SHIFT = 26;   // sideways travel per turn, must clear the road width

const LOOP = (radius = 17, dir = 'r') =>
  helix(radius, LOOP_SHIFT, dir === 'r' ? 1 : -1);

// Rolling the surface along a straight path instead would leave the car with
// nothing holding it on past 90 degrees, and with the road only a metre away it
// would also be impossible to see ahead.
const CORK = (axialLen = 115, dir = 'r', radius = 10) =>
  helix(radius, axialLen, dir === 'r' ? 1 : -1);

const HILL = (deg = 13, crest = 16) => [
  ...UP(deg, 24), ...S(crest), ...DN(2 * deg, 46), ...S(crest), ...UP(deg, 24),
];

const riseStraight = (len, th) => len * Math.sin(th);
const riseArc = (len, th0, th1) => Math.abs(th1 - th0) < 1e-7
  ? len * Math.sin(th0)
  : len * (Math.cos(th0) - Math.cos(th1)) / (th1 - th0);

// The ribbon keeps going through the gap (invisible) so landings can be detected.
// The exit pitch is solved so the whole jump is altitude-neutral, which keeps
// tracks from drifting away from the ground plane as jumps accumulate.
const JUMP = (deg = 12, ramp = 22, gap = 34, landing = 16, out = 26) => {
  const d = deg * DEG;
  const net = e => riseArc(ramp, 0, d) + riseArc(gap, d, -e)
                 + riseStraight(landing, -e) + riseArc(out, -e, 0);

  let lo = 1e-4, hi = d;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (net(mid) > 0) lo = mid; else hi = mid;
  }
  const exit = (lo + hi) / 2;

  return [
    ...UP(deg, ramp),
    seg({ len: gap, pitch: -(exit + d) / gap, gap: true }),
    ...S(landing),
    seg({ len: out, pitch: exit / out }),
  ];
};

// Gain or lose altitude and come out level, so curves can then run flat on a
// viaduct. A curve held at a constant pitch would climb without ever returning.
const CLIMB = (deg, len) => [...UP(deg, len), ...DN(deg, len)];
const DROP = (deg, len) => [...DN(deg, len), ...UP(deg, len)];

const CHICANE = (radius, angleDeg, dir = 'r', bankDeg = 0) => [
  ...C(radius, angleDeg, dir, bankDeg),
  ...C(radius, angleDeg, dir === 'r' ? 'l' : 'r', bankDeg),
];

const CP = () => [seg({ len: 0, cp: true })];

// --- Serialisable piece descriptors ---
// A track is a list of plain objects like {t:'c', r:60, a:90, dir:'r', bank:10}.
// One descriptor is one piece the editor shows and the player places, even when
// it expands into several segments (a hill is five). Being plain data is what
// lets tracks be saved, shared and reopened for editing.

export const PIECE_TYPES = {
  s: {
    label: 'Reta', build: p => S(p.len),
    params: [{ k: 'len', label: 'comprimento', min: 10, max: 200, step: 5, def: 60, unit: 'm' }],
  },
  c: {
    label: 'Curva', build: p => C(p.r, p.a, p.dir, p.bank), dir: true,
    params: [
      { k: 'r', label: 'raio', min: 25, max: 140, step: 5, def: 60, unit: 'm' },
      { k: 'a', label: 'ângulo', min: 15, max: 150, step: 5, def: 80, unit: '°' },
      { k: 'bank', label: 'inclinação', min: 0, max: 20, step: 1, def: 10, unit: '°' },
    ],
  },
  chicane: {
    label: 'Chicane', build: p => CHICANE(p.r, p.a, p.dir, p.bank), dir: true,
    params: [
      { k: 'r', label: 'raio', min: 25, max: 90, step: 5, def: 45, unit: 'm' },
      { k: 'a', label: 'ângulo', min: 20, max: 60, step: 5, def: 42, unit: '°' },
      { k: 'bank', label: 'inclinação', min: 0, max: 18, step: 1, def: 10, unit: '°' },
    ],
  },
  hill: {
    label: 'Colina', build: p => HILL(p.deg, p.crest),
    params: [
      { k: 'deg', label: 'inclinação', min: 6, max: 16, step: 1, def: 11, unit: '°' },
      { k: 'crest', label: 'topo', min: 8, max: 40, step: 2, def: 16, unit: 'm' },
    ],
  },
  jump: {
    label: 'Salto', build: p => JUMP(p.deg, 22, p.gap),
    params: [
      { k: 'deg', label: 'rampa', min: 6, max: 14, step: 1, def: 10, unit: '°' },
      { k: 'gap', label: 'vão', min: 16, max: 46, step: 2, def: 30, unit: 'm' },
    ],
  },
  loop: {
    label: 'Loop', build: p => LOOP(p.r, p.dir), dir: true,
    params: [{ k: 'r', label: 'raio', min: 12, max: 26, step: 1, def: 18, unit: 'm' }],
  },
  cork: {
    label: 'Corkscrew', build: p => CORK(p.len, p.dir, p.r), dir: true,
    params: [
      { k: 'len', label: 'avanço', min: 80, max: 150, step: 5, def: 110, unit: 'm' },
      { k: 'r', label: 'raio', min: 9, max: 16, step: 1, def: 10, unit: 'm' },
    ],
  },
  climb: {
    label: 'Subida', build: p => CLIMB(p.deg, p.len),
    params: [
      { k: 'deg', label: 'inclinação', min: 6, max: 18, step: 1, def: 13, unit: '°' },
      { k: 'len', label: 'comprimento', min: 25, max: 80, step: 5, def: 50, unit: 'm' },
    ],
  },
  drop: {
    label: 'Descida', build: p => DROP(p.deg, p.len),
    params: [
      { k: 'deg', label: 'inclinação', min: 6, max: 18, step: 1, def: 13, unit: '°' },
      { k: 'len', label: 'comprimento', min: 25, max: 80, step: 5, def: 50, unit: 'm' },
    ],
  },
  cp: { label: 'Checkpoint', build: () => CP(), params: [] },
};

// Any real piece can be enclosed in a tunnel, loops and corkscrews included --
// that is the whole point of making it a property rather than its own piece.
for (const [t, spec] of Object.entries(PIECE_TYPES)) spec.canTunnel = t !== 'cp';

export function defaults(type) {
  const spec = PIECE_TYPES[type];
  const p = { t: type };
  for (const q of spec.params) p[q.k] = q.def;
  if (spec.dir) p.dir = 'r';
  return p;
}

export function describe(p) {
  const spec = PIECE_TYPES[p.t];
  if (!spec) return p.t;
  const bits = spec.params.map(q => `${p[q.k]}${q.unit}`);
  if (spec.dir) bits.unshift(p.dir === 'r' ? 'dir' : 'esq');
  if (p.tun && spec.canTunnel) bits.push('túnel');
  return bits.length ? `${spec.label} · ${bits.join(' · ')}` : spec.label;
}

// Descriptors to rate segments, tagging each with the piece it came from so the
// editor can highlight one piece inside the built geometry.
export function expand(pieces) {
  const out = [];
  pieces.forEach((p, i) => {
    const spec = PIECE_TYPES[p.t];
    if (!spec) return;
    const tunnel = !!p.tun && spec.canTunnel;
    for (const s of spec.build(p)) out.push({ ...s, pi: i, tunnel });
  });
  return out;
}

