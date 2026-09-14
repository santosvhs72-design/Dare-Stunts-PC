import { v3, smoothstep } from '../core/math.js';
import { MeshData, hex, shade } from '../core/mesh.js';
import { DS, ROAD_HALF } from './track.js';

export const GROUND_Y = -0.8;

const GRASS = [hex('#4f7d3a'), hex('#487535'), hex('#547f3f'), hex('#6a6242')];
const HILL_COL = hex('#5c7f63');
const TRUNK = hex('#5a4632');
const LEAF = [hex('#37662f'), hex('#2f5c2b'), hex('#3f6f34'), hex('#4a6b2c')];
const POST = hex('#e6eaef');
const POST_RED = hex('#c4423b');

// Cattle and farm buildings: the land the road was built through, rather than
// more of the road. Deliberately pale and muted -- they sit in the middle
// distance and must never pull the eye off the next corner.
// Not white. A white cow in full sun lands above the bloom threshold (see
// BLOOM_THRESHOLD in core/renderer.js) and comes back as a glowing blob with
// its own shape washed out of it -- which is a fair description of what
// bloom is for and a terrible description of a cow. This is the off-white a
// Friesian actually is, and it stays under the line.
const HIDE = hex('#c8c2b4');
const HIDE_DARK = hex('#3a3632');
const HIDE_BROWN = hex('#7a5a3e');
const WALL_CREAM = hex('#d8cdbb');
const WALL_STONE = hex('#c3bcb0');
const ROOF_TILE = hex('#9c5442');
const ROOF_SLATE = hex('#5d5f63');
const TIMBER = hex('#6b5344');
const PANE = hex('#3d4650');

const rng = seed => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0;
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

// One sky per track, so a circuit is recognisable from the first second
// without reading its name -- and so three laps of the same three tracks do
// not all look like the same time of day. Only three colours define one:
// the smoothstep gradient below does the rest, exactly as it always did.
//
// The fog has to match a preset's horizon exactly (see skyFogColor), or the
// distance where scenery fades out would show as a seam against the sky
// behind it. skyAmbient nudges the world's own lighting floor to match the
// mood -- never far, since the road still has to be as easy to read as at
// midday.
export const SKY_PRESETS = {
  dia: {
    zenith: '#3f6ea8', horizon: '#aac6e2', below: '#6f8a63', ambient: 1,
  },
  entardecer: {
    zenith: '#7a5088', horizon: '#e7a066', below: '#5c6a48', ambient: 0.94,
  },
  crepusculo: {
    zenith: '#232c5e', horizon: '#9678ad', below: '#3a4a3e', ambient: 0.88,
  },
};

const skyOf = id => SKY_PRESETS[id] || SKY_PRESETS.dia;

export function buildSky(presetId) {
  const md = new MeshData();
  const p = skyOf(presetId);
  const zenith = hex(p.zenith), horizon = hex(p.horizon), below = hex(p.below);
  const lon = 20, lat = 12;
  const colAt = y => y >= 0
    ? v3.lerp(horizon, zenith, smoothstep(y * 1.35))
    : v3.lerp(horizon, below, smoothstep(-y * 2.2));

  for (let i = 0; i < lat; i++) {
    const t0 = i / lat * Math.PI, t1 = (i + 1) / lat * Math.PI;
    for (let j = 0; j < lon; j++) {
      const p0 = j / lon * Math.PI * 2, p1 = (j + 1) / lon * Math.PI * 2;
      const pt = (t, p) => [Math.sin(t) * Math.cos(p), Math.cos(t), Math.sin(t) * Math.sin(p)];
      const a = pt(t0, p0), b = pt(t1, p0), c = pt(t1, p1), d = pt(t0, p1);
      md.quad(
        v3.scale(a, 1000), v3.scale(b, 1000), v3.scale(c, 1000), v3.scale(d, 1000),
        colAt((Math.cos(t0) + Math.cos(t1)) / 2), [0, 1, 0],
      );
    }
  }
  return md;
}

export const skyFogColor = presetId => hex(skyOf(presetId).horizon);
export const skyAmbient = presetId => skyOf(presetId).ambient;

export function buildGround(bounds) {
  const tile = 28, margin = 460, chunkTiles = 9;
  const x0 = Math.floor((bounds.x0 - margin) / tile);
  const x1 = Math.ceil((bounds.x1 + margin) / tile);
  const z0 = Math.floor((bounds.z0 - margin) / tile);
  const z1 = Math.ceil((bounds.z1 + margin) / tile);
  const rand = rng(1337);
  const chunks = [];

  for (let cx = x0; cx <= x1; cx += chunkTiles) {
    for (let cz = z0; cz <= z1; cz += chunkTiles) {
      const md = new MeshData();
      for (let ix = cx; ix < Math.min(cx + chunkTiles, x1 + 1); ix++) {
        for (let iz = cz; iz < Math.min(cz + chunkTiles, z1 + 1); iz++) {
          const r = rand();
          let col = GRASS[(ix + iz) & 1];
          if (r > 0.965) col = GRASS[3];
          else if (r > 0.86) col = GRASS[2];
          const ax = ix * tile, az = iz * tile;
          md.quad(
            [ax, GROUND_Y, az], [ax, GROUND_Y, az + tile],
            [ax + tile, GROUND_Y, az + tile], [ax + tile, GROUND_Y, az],
            shade(col, 0.94 + r * 0.12), [0, 1, 0],
          );
        }
      }
      if (md.vertexCount) chunks.push(md);
    }
  }
  return chunks;
}

const CELL = 6;
const cellKey = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;

// Plan-view cells within `clearance` of any part of the ribbon.
function footprint(frames, clearance) {
  const blocked = new Set();
  const reach = Math.ceil(clearance / CELL);
  for (const f of frames) {
    const cx = Math.floor(f.pos[0] / CELL), cz = Math.floor(f.pos[2] / CELL);
    for (let i = -reach; i <= reach; i++) {
      for (let j = -reach; j <= reach; j++) {
        if (i * i + j * j <= reach * reach + 1) blocked.add(`${cx + i},${cz + j}`);
      }
    }
  }
  return blocked;
}

// A cow, about 2.2 m nose to tail and 1.4 m at the shoulder, which is life
// size. Built out of seven boxes and worth every one of them: the first
// version was a body, a head and four legs, and at any distance it read as a
// crate on stilts. What fixed it was narrowing the body to a cow's actual
// width, filling the gap between head and shoulders with a neck, and dropping
// the head below the line of the back -- a grazing animal looks down.
function cow(md, x, z, yaw, r) {
  const brown = r() < 0.3;
  const hide = brown ? HIDE_BROWN : HIDE;
  const y = GROUND_Y;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // Forward and sideways in the animal's own frame, so every part follows the
  // one turn the whole thing was given.
  const at = (fwd, side) => [x + side * c + fwd * s, z - side * s + fwd * c];
  const put = (fwd, side, up, sx, sy, sz, col) => {
    const [px, pz] = at(fwd, side);
    md.boxY(px, y + up, pz, sx, sy, sz, yaw, col);
  };

  put(0, 0, 1.06, 0.29, 0.32, 0.82, hide);          // barrel
  put(0.92, 0, 1.02, 0.22, 0.24, 0.24, hide);       // neck
  put(1.24, 0, 0.86, 0.2, 0.2, 0.28, brown ? shade(HIDE_BROWN, 0.75) : HIDE_DARK);
  put(-0.92, 0, 1.16, 0.05, 0.22, 0.06, HIDE_DARK); // tail
  for (const fwd of [0.6, -0.6]) {
    for (const side of [0.22, -0.22]) {
      put(fwd, side, 0.37, 0.1, 0.37, 0.1, shade(HIDE_DARK, 1.25));
    }
  }
  if (!brown) {
    // Patches, standing proud of the flank on both sides -- a hair was not
    // enough. At the distance these are ever seen, the patches are the whole
    // of what says "cow" rather than "white box", and a patch flush with the
    // flank is invisible from anywhere but dead abeam.
    for (let i = 0; i < 2; i++) {
      put((r() - 0.5) * 0.95, 0, 1.06 + (r() - 0.5) * 0.24,
          0.34, 0.2 + r() * 0.1, 0.22 + r() * 0.12, HIDE_DARK);
    }
  }
}

// A house: walls, a pitched roof, a door and two windows. Two shapes -- a
// cottage and a long barn -- because one repeated building is worse than none.
function house(md, x, z, yaw, r) {
  const barn = r() < 0.35;
  const w = barn ? 3.4 : 2.9 + r() * 0.8;        // half-width, across the ridge
  const d = barn ? 7.5 : 3.6 + r() * 1.2;        // half-depth, along the ridge
  const h = barn ? 3.0 : 2.7 + r() * 0.6;        // wall height
  const peak = barn ? 2.0 : 2.4;                 // roof rise above the wall top
  const wall = barn ? WALL_STONE : WALL_CREAM;
  const roof = r() < 0.5 ? ROOF_TILE : ROOF_SLATE;
  const y = GROUND_Y;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const at = (dx, dz) => [x + dx * c + dz * s, z - dx * s + dz * c];

  md.boxY(x, y + h / 2, z, w, h / 2, d, yaw, wall);

  // Pitched roof: two slopes meeting at a ridge, and a gable at each end. The
  // eaves overhang a little, which is most of what stops it reading as a lid.
  const ov = 0.35;
  const top = y + h, ridgeY = y + h + peak;
  const P = (dx, dz, yy) => { const [px, pz] = at(dx, dz); return [px, yy, pz]; };
  for (const sgn of [-1, 1]) {
    const eaveA = P(sgn * (w + ov), -(d + ov), top);
    const eaveB = P(sgn * (w + ov), d + ov, top);
    const ridgeA = P(0, -(d + ov), ridgeY);
    const ridgeB = P(0, d + ov, ridgeY);
    md.quad(eaveA, eaveB, ridgeB, ridgeA, shade(roof, sgn > 0 ? 1 : 0.82));
  }
  for (const sgn of [-1, 1]) {
    md.tri(P(-w, sgn * d, top), P(w, sgn * d, top), P(0, sgn * d, ridgeY),
           shade(wall, 0.9));
  }

  // A door and two windows on one long side, so the building has a front.
  const face = d + 0.02;
  const [dx0, dz0] = at(0, face);
  md.boxY(dx0, y + 0.95, dz0, 0.42, 0.95, 0.06, yaw, TIMBER);
  for (const off of [-w * 0.55, w * 0.55]) {
    const [wx, wz] = at(off, face);
    md.boxY(wx, y + h * 0.62, wz, 0.34, 0.34, 0.05, yaw, PANE);
  }
  if (!barn) {
    // A chimney, off to one end of the ridge.
    const [cx2, cz2] = at(w * 0.45, d * 0.45);
    md.boxY(cx2, ridgeY + 0.35, cz2, 0.22, 0.85, 0.22, yaw, shade(wall, 0.8));
  }
}

function tree(md, x, z, r) {
  const h = 4.5 + r() * 5.5;
  const rad = 1.6 + r() * 1.5;
  const leaf = LEAF[(r() * LEAF.length) | 0];
  md.box(x, GROUND_Y + h * 0.22, z, 0.34, h * 0.22, 0.34, TRUNK);
  md.cone(x, GROUND_Y + h * 0.32, z, rad, h * 0.62, 6, leaf, r() * 3);
  md.cone(x, GROUND_Y + h * 0.62, z, rad * 0.68, h * 0.5, 6, shade(leaf, 1.12), r() * 3);
}

export function buildScenery(track) {
  const chunks = [];
  const r = rng(7717);
  const frames = track.frames;

  // A tree is placed sideways from one frame, but the track may loop back over
  // that spot: at a loop the ribbon climbs straight through the ground beside
  // its own entry, which put trees inside the loop. So reject any position the
  // track occupies in plan view, wherever along the track that part comes from.
  const blocked = footprint(frames, 12);

  // Trees and marker posts follow the road, so sequential batches stay compact.
  let md = new MeshData();
  let batch = 0;
  const step = Math.round(9 / DS);

  for (let i = 0; i < frames.length; i += step) {
    const f = frames[i];
    const nearGround = f.pos[1] < 4.5 && f.up[1] > 0.88;

    if (nearGround && !f.gap && i % (step * 2) === 0) {
      for (const sgn of [-1, 1]) {
        const u = sgn * (ROAD_HALF + 1.9);
        const p = v3.mad(f.pos, f.right, u);
        const c = (i / step) % 4 < 2 ? POST : POST_RED;
        md.box(p[0], (GROUND_Y + p[1] + 0.55) / 2, p[2], 0.16, (p[1] + 0.55 - GROUND_Y) / 2, 0.16, c);
      }
    }

    if (nearGround) {
      const n = r() < 0.55 ? 3 : 2;
      for (let k = 0; k < n; k++) {
        const sgn = r() < 0.5 ? -1 : 1;
        const u = sgn * (13 + r() * 46);
        const p = v3.mad(f.pos, f.right, u);
        const x = p[0] + (r() - 0.5) * 8, z = p[2] + (r() - 0.5) * 8;
        if (blocked.has(cellKey(x, z))) continue;
        tree(md, x, z, r);
      }

      // Cattle, in ones and twos, well back from the road. Rare on purpose:
      // the whole point of a cow is that you notice it, and you stop noticing
      // the fourth one. Grazing animals cluster, so where there is one there
      // is usually another a few metres off, facing roughly the same way --
      // which is what makes a pair read as a herd rather than as two props.
      if (r() < 0.055) {
        const sgn = r() < 0.5 ? -1 : 1;
        const u = sgn * (26 + r() * 40);
        const p = v3.mad(f.pos, f.right, u);
        const yaw = r() * Math.PI * 2;
        const n2 = r() < 0.45 ? 2 : 1;
        for (let k = 0; k < n2; k++) {
          const x = p[0] + (r() - 0.5) * 9, z = p[2] + (r() - 0.5) * 9;
          if (blocked.has(cellKey(x, z))) continue;
          cow(md, x, z, yaw + (r() - 0.5) * 0.9, r);
        }
      }

      // A farmhouse or a barn, rarer still and further out. Kept beyond the
      // trees so it never blocks the view of the road, and given a facing of
      // its own rather than the road's -- a house that squares up to the
      // tarmac looks like it was put there for the race.
      if (r() < 0.02) {
        const sgn = r() < 0.5 ? -1 : 1;
        const u = sgn * (52 + r() * 46);
        const p = v3.mad(f.pos, f.right, u);
        const x = p[0] + (r() - 0.5) * 12, z = p[2] + (r() - 0.5) * 12;
        if (!blocked.has(cellKey(x, z))) house(md, x, z, r() * Math.PI * 2, r);
      }
    }

    if (++batch >= 26) { if (md.vertexCount) chunks.push(md); md = new MeshData(); batch = 0; }
  }
  if (md.vertexCount) chunks.push(md);

  // Distant hills ringing the whole circuit.
  const b = track.bounds;
  const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
  const reach = Math.max(b.x1 - b.x0, b.z1 - b.z0) / 2 + 300;
  const hm = new MeshData();
  for (let i = 0; i < 46; i++) {
    const a = i / 46 * Math.PI * 2 + r() * 0.12;
    const d = reach + r() * 240;
    const rad = 60 + r() * 120;
    hm.cone(cx + Math.cos(a) * d, GROUND_Y - 4, cz + Math.sin(a) * d,
            rad, 40 + r() * 90, 7, shade(HILL_COL, 0.9 + r() * 0.25), r() * 3);
  }
  chunks.push(hm);

  return chunks;
}
