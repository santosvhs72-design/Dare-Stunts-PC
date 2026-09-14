export const DEG = Math.PI / 180;

export const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
export const smoothstep = t => (t = clamp(t, 0, 1), t * t * (3 - 2 * t));

export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  mad: (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: a => Math.hypot(a[0], a[1], a[2]),
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

export const quat = {
  id: () => [0, 0, 0, 1],

  mul(a, b) {
    const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  },

  axisAngle(axis, ang) {
    const h = ang * 0.5, s = Math.sin(h);
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
  },

  norm(q) {
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  },

  rotate(q, v) {
    const tx = 2 * (q[1] * v[2] - q[2] * v[1]);
    const ty = 2 * (q[2] * v[0] - q[0] * v[2]);
    const tz = 2 * (q[0] * v[1] - q[1] * v[0]);
    return [
      v[0] + q[3] * tx + q[1] * tz - q[2] * ty,
      v[1] + q[3] * ty + q[2] * tx - q[0] * tz,
      v[2] + q[3] * tz + q[0] * ty - q[1] * tx,
    ];
  },

  right: q => quat.rotate(q, [1, 0, 0]),
  up: q => quat.rotate(q, [0, 1, 0]),
  fwd: q => quat.rotate(q, [0, 0, 1]),

  nlerp(a, b, t) {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const s = d < 0 ? -1 : 1;
    return quat.norm([
      a[0] + (b[0] * s - a[0]) * t, a[1] + (b[1] * s - a[1]) * t,
      a[2] + (b[2] * s - a[2]) * t, a[3] + (b[3] * s - a[3]) * t,
    ]);
  },
};

export const mat4 = {
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ]);
  },

  // View matrix for a camera at pos with orientation q (local +Z is forward).
  view(q, pos, ignoreTranslation = false) {
    const r = quat.right(q), u = quat.up(q), f = quat.fwd(q);
    const tx = ignoreTranslation ? 0 : -v3.dot(r, pos);
    const ty = ignoreTranslation ? 0 : -v3.dot(u, pos);
    const tz = ignoreTranslation ? 0 : v3.dot(f, pos);
    return new Float32Array([
      r[0], u[0], -f[0], 0,
      r[1], u[1], -f[1], 0,
      r[2], u[2], -f[2], 0,
      tx, ty, tz, 1,
    ]);
  },

  // Places a rigid body in the world: the inverse of view(). Local +Z is
  // forward, +Y up, +X right, matching quat.fwd/up/right.
  model(q, pos) {
    const r = quat.right(q), u = quat.up(q), f = quat.fwd(q);
    return new Float32Array([
      r[0], r[1], r[2], 0,
      u[0], u[1], u[2], 0,
      f[0], f[1], f[2], 0,
      pos[0], pos[1], pos[2], 1,
    ]);
  },

  // A box rather than a pyramid. The sun is far enough away that its rays are
  // parallel, so what it sees is a slab of world, not a cone of it.
  ortho(l, r, b, t, n, f) {
    return new Float32Array([
      2 / (r - l), 0, 0, 0,
      0, 2 / (t - b), 0, 0,
      0, 0, -2 / (f - n), 0,
      -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1,
    ]);
  },

  // View matrix for something with no orientation of its own -- the sun, which
  // has a direction and nothing else. `fwd` is the way it looks; up is picked
  // arbitrarily, and any choice is as good as another for a light, as long as
  // it is not parallel to fwd.
  lookAlong(fwd, pos) {
    const f = v3.norm(fwd);
    const up0 = Math.abs(f[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
    const r = v3.norm(v3.cross(up0, f));
    const u = v3.cross(f, r);
    return new Float32Array([
      r[0], u[0], -f[0], 0,
      r[1], u[1], -f[1], 0,
      r[2], u[2], -f[2], 0,
      -v3.dot(r, pos), -v3.dot(u, pos), v3.dot(f, pos), 1,
    ]);
  },

  identity: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),

  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
                       a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  },
};

// Six frustum planes [nx,ny,nz,d] from a column-major proj*view matrix.
export function frustumPlanes(m) {
  const row = i => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
  const combine = (a, b, sign) => {
    const p = [a[0] + sign * b[0], a[1] + sign * b[1], a[2] + sign * b[2], a[3] + sign * b[3]];
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    return [p[0] / l, p[1] / l, p[2] / l, p[3] / l];
  };
  return [
    combine(r3, r0, 1), combine(r3, r0, -1),
    combine(r3, r1, 1), combine(r3, r1, -1),
    combine(r3, r2, 1), combine(r3, r2, -1),
  ];
}

export function sphereVisible(planes, c, r) {
  for (let i = 0; i < 6; i++) {
    const p = planes[i];
    if (p[0] * c[0] + p[1] * c[1] + p[2] * c[2] + p[3] < -r) return false;
  }
  return true;
}
