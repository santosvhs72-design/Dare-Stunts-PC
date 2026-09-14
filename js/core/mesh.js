import { v3 } from './math.js';

export function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

export const shade = (c, f) => [
  Math.min(1, c[0] * f), Math.min(1, c[1] * f), Math.min(1, c[2] * f),
];

export class MeshData {
  constructor() { this.p = []; this.n = []; this.c = []; }

  get vertexCount() { return this.p.length / 3; }

  tri(a, b, c, col, normal) {
    const nr = normal || v3.norm(v3.cross(v3.sub(b, a), v3.sub(c, a)));
    for (const v of [a, b, c]) {
      this.p.push(v[0], v[1], v[2]);
      this.n.push(nr[0], nr[1], nr[2]);
      this.c.push(col[0], col[1], col[2]);
    }
  }

  // Vertices counter-clockwise seen from the front face.
  quad(a, b, c, d, col, normal) {
    const nr = normal || v3.norm(v3.cross(v3.sub(b, a), v3.sub(d, a)));
    this.tri(a, b, c, col, nr);
    this.tri(a, c, d, col, nr);
  }

  // Axis-aligned box; sides are darkened relative to the top.
  box(cx, cy, cz, sx, sy, sz, col) {
    const x0 = cx - sx, x1 = cx + sx, y0 = cy - sy, y1 = cy + sy, z0 = cz - sz, z1 = cz + sz;
    const top = shade(col, 1.12), side = shade(col, 0.78), dark = shade(col, 0.6);
    this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], top, [0, 1, 0]);
    this.quad([x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1], side, [0, 0, 1]);
    this.quad([x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z0], side, [0, 0, -1]);
    this.quad([x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0], dark, [1, 0, 0]);
    this.quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], dark, [-1, 0, 0]);
  }

  // Box turned about the vertical axis. Everything in this world that grows
  // out of the ground -- a tree, a pillar -- looks the same from every side,
  // so an axis-aligned box was always enough. A cow does not and a house does
  // not: a field of cattle all facing north reads as scenery, and a village of
  // houses all square to the same grid reads as a car park.
  boxY(cx, cy, cz, sx, sy, sz, yaw, col) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // Corner of the footprint, turned. The vertical axis is untouched.
    const p = (dx, dz, y) => [cx + dx * c + dz * s, y, cz - dx * s + dz * c];
    const y0 = cy - sy, y1 = cy + sy;
    const top = shade(col, 1.12), side = shade(col, 0.78), dark = shade(col, 0.6);
    // Face normals turn with the box; the top and bottom do not.
    const n = (dx, dz) => [dx * c + dz * s, 0, -dx * s + dz * c];
    this.quad(p(-sx, -sz, y1), p(-sx, sz, y1), p(sx, sz, y1), p(sx, -sz, y1), top, [0, 1, 0]);
    this.quad(p(-sx, sz, y0), p(-sx, sz, y1), p(sx, sz, y1), p(sx, sz, y0), side, n(0, 1));
    this.quad(p(sx, -sz, y0), p(sx, -sz, y1), p(-sx, -sz, y1), p(-sx, -sz, y0), side, n(0, -1));
    this.quad(p(sx, sz, y0), p(sx, sz, y1), p(sx, -sz, y1), p(sx, -sz, y0), dark, n(1, 0));
    this.quad(p(-sx, -sz, y0), p(-sx, -sz, y1), p(-sx, sz, y1), p(-sx, sz, y0), dark, n(-1, 0));
  }

  // Pyramid/cone approximation with `sides` faces; used for trees and hills.
  cone(cx, cy, cz, radius, height, sides, col, twist = 0) {
    const apex = [cx, cy + height, cz];
    for (let i = 0; i < sides; i++) {
      const a0 = twist + i / sides * Math.PI * 2, a1 = twist + (i + 1) / sides * Math.PI * 2;
      const p0 = [cx + Math.cos(a0) * radius, cy, cz + Math.sin(a0) * radius];
      const p1 = [cx + Math.cos(a1) * radius, cy, cz + Math.sin(a1) * radius];
      this.tri(p0, p1, apex, shade(col, 0.85 + 0.3 * Math.cos(a0 + 0.7)));
    }
  }

  bounds() {
    const p = this.p;
    if (!p.length) return { center: [0, 0, 0], radius: 0 };
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
      if (p[i + 2] < z0) z0 = p[i + 2]; if (p[i + 2] > z1) z1 = p[i + 2];
    }
    const center = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    return { center, radius: Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + 0.001 };
  }
}
