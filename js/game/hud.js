import { v3 } from '../core/math.js';
import { hex, shade } from '../core/mesh.js';
import { SLIP_WARN } from './car.js';

export function formatTime(ms) {
  if (ms == null) return '--:--.--';
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000);
  const s = Math.floor(t / 1000) % 60;
  const c = Math.floor(t / 10) % 100;
  return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

// The cockpit, modelled rather than drawn.
//
// Painting a dashboard as flat bands across the bottom of the screen never
// belongs to the picture behind it: the world is in perspective, converging on
// a vanishing point, and every one of its faces is shaded by how it happens to
// be turned towards the sun. So this is a small model of a car interior in
// metres, with the driver's eye at the origin -- +x right, +y up, +z forward --
// projected through the same pinhole as the camera and shaded with the same
// expression as the vertex shader. The moulding then recedes to the same point
// as the road and catches the light the same way, because it is being lit by
// the same arithmetic.
//
// It is drawn in Canvas 2D rather than as a mesh in the scene for one reason:
// the instruments have numbers on them, and text has to stay upright and sharp.
// So the surfaces are projected, and the dials are then drawn face-on at the
// projected position and size of where they are mounted.
const FOV = 68 * Math.PI / 180;      // the camera's own field of view at rest
const LIGHT = v3.norm([0.42, 0.82, 0.38]);   // Renderer.light
const AMBIENT = 0.46;                // an interior sits in its own shade

// The shader's lighting, line for line (see VS in core/renderer.js): a
// brightness floor, a hemispheric term for sky above and bounce below, and
// plain diffuse for the sun.
const litFor = (n, amb = AMBIENT) => {
  const diff = Math.max(n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2], 0);
  const hemi = 0.5 + 0.5 * n[1];
  return amb + (1 - amb) * (0.45 * hemi + 0.55 * diff);
};

const css = c => '#' + c.map(v => Math.round(Math.min(1, v) * 255).toString(16).padStart(2, '0')).join('');
const tone = (c, f) => css(shade(hex(c), f));

// Straight from the world's own palette: the rails, the lines, the kerbs, the
// gates. The instruments are made of track furniture.
const STEEL = '#c3cad3';    // rail
const SLATE = '#3a4048';    // portal edge
const DARKEST = '#22262c';  // gate frame -- the darkest colour in the world
const PRINT = '#e2e8ef';    // road line
const AMBER = '#ffb43a';    // checkpoint gate
const GREEN = '#4fbf7a';    // start gate
const RED = '#c4423b';      // kerb

// A car supplies its paint and how high the driver sits; every other tone is
// derived, the way a box in the scenery derives its faces.
//
// The moulding is dark on purpose, and not only for contrast: a dashboard top
// is matte and near-black in every real car, because a pale one mirrors itself
// in the windscreen. At road brightness it also came out the exact value of
// asphalt, and the whole interior dissolved into the picture behind it.
const BASE = {
  dash: '#3e444e', body: '#c3cad3', rim: '#5b626d',
  accent: AMBER, accent2: PRINT,
  dashScale: 1, wheelScale: 1,
};

// The interior, in metres from the eye. Six columns across and three rows deep:
// the windscreen sill, the lip of the cowl, and the bottom of the fascia. The
// sill stays at nearly one height across the width and only draws back towards
// the doors -- pitching it down at the corners as well sends the dash plunging
// into the bottom corners of the picture and opens a wedge of road where the
// car's own body should be.
const COLS = [
  //  x     sill z   y      lip z   y      foot z   y
  [-1.05,   0.72, -0.24,   0.66, -0.275,  0.62, -0.86],
  [-0.60,   0.82, -0.22,   0.74, -0.255,  0.70, -0.84],
  [-0.21,   0.88, -0.21,   0.78, -0.245,  0.74, -0.82],
  [0.21,    0.88, -0.21,   0.78, -0.245,  0.74, -0.82],
  [0.60,    0.82, -0.22,   0.74, -0.255,  0.70, -0.84],
  [1.05,    0.72, -0.24,   0.66, -0.275,  0.62, -0.86],
];

const NOSE = { z: 2.05, y: -0.37, x: 0.86 };  // far end of the bonnet
// The rim crosses the bottom of the speedometer, as a real one does -- which
// does hide the needle at walking pace. That is what the figures in the left
// panel are for; dropping the wheel far enough to clear the dial left the
// cockpit without a visible steering wheel at all, which is worse.
const WHEEL = { y: -0.47, z: 0.60, r: 0.195, tube: 0.03, tilt: 0.34 };

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export class Hud {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    // Pixels per radian at the image plane, from the vertical field of view.
    this.k = (this.h / 2) / Math.tan(FOV / 2);
  }

  // Pinhole projection: the same one the camera uses, so a surface modelled
  // here lands where the same surface would land if it were in the scene.
  px(p) { return this.w / 2 + p[0] / p[2] * this.k; }
  py(p) { return this.h / 2 - p[1] / p[2] * this.k; }
  // Size of something r metres across, mounted at depth z.
  pr(r, z) { return r / z * this.k; }

  // One flat face. The normal comes from the geometry, and is turned to face
  // the eye so that winding order cannot quietly invert the lighting.
  face(pts, base, amb) {
    const ctx = this.ctx;
    let n = v3.norm(v3.cross(v3.sub(pts[1], pts[0]), v3.sub(pts[2], pts[0])));
    if (n[0] * pts[0][0] + n[1] * pts[0][1] + n[2] * pts[0][2] > 0) n = v3.scale(n, -1);
    ctx.fillStyle = tone(base, litFor(n, amb));
    ctx.beginPath();
    ctx.moveTo(this.px(pts[0]), this.py(pts[0]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(this.px(pts[i]), this.py(pts[i]));
    ctx.closePath();
    ctx.fill();
  }

  // Nothing to overlay -- used instead of draw() where the cockpit itself
  // would not make sense (a replay watched from outside the car).
  clear() {
    this.resize();
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
  }

  draw(st) {
    this.resize();
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const t = { ...BASE, ...(st.theme || {}) };
    // How high the driver sits: a bigger scale lifts the eye, which shows more
    // of the moulding, which is what the old flat dash meant by the same knob.
    const sit = 1 / (t.dashScale || 1);
    const col = COLS.map(c => [c[0],
      [c[0], c[2] * sit, c[1]], [c[0], c[4] * sit, c[3]], [c[0], c[6] * sit, c[5]]]);

    this.drawBonnet(ctx, col, t, sit);
    this.drawDash(ctx, col, t);
    this.drawCluster(ctx, col, st, t);
    this.drawWheel(ctx, st, t, sit);
    this.drawPosts(ctx, t);
    this.drawTop(ctx, this.w, this.h, st);
    if (st.message) this.drawMessage(ctx, this.w, this.h, st);
  }

  // The car's own nose, seen over the sill and through the screen. It tapers
  // towards the vanishing point because it is actually further away there --
  // which is the single strongest cue that the cockpit is in the same space as
  // the road under it.
  drawBonnet(ctx, col, t, sit) {
    const far = x => [x * NOSE.x / 1.05, NOSE.y * sit, NOSE.z];
    for (let i = 0; i < col.length - 1; i++) {
      this.face([far(col[i][0]), far(col[i + 1][0]), col[i + 1][1], col[i][1]], t.body, 0.62);
    }
  }

  drawDash(ctx, col, t) {
    // Top of the moulding: nearly horizontal, so it catches the sky and reads
    // bright. Then the fascia, turned towards the driver and away from the sun.
    // The step between the two is the whole of the moulding's thickness, and it
    // comes out of the light alone -- around 0.94 against 0.66.
    for (let i = 0; i < col.length - 1; i++) {
      this.face([col[i][1], col[i + 1][1], col[i + 1][2], col[i][2]], t.dash, AMBIENT);
    }
    for (let i = 0; i < col.length - 1; i++) {
      this.face([col[i][2], col[i + 1][2], col[i + 1][3], col[i][3]], t.dash, AMBIENT);
    }
  }

  // Windscreen posts. A hundred degrees of horizontal field of view puts the
  // real ones outside the frame entirely, and a view with no frame at all reads
  // as a dashboard floating in mid-air -- so these are drawn at the edge of the
  // picture, the one part of the cockpit that is staged rather than modelled.
  drawPosts(ctx, t) {
    const w = this.w, h = this.h;
    const foot = this.py([1.05, -0.45, 0.54]);
    const pw = Math.max(12, w * 0.022);
    ctx.fillStyle = tone(t.dash, litFor([0, 0.2, -0.98]) * 0.62);
    for (const s of [-1, 1]) {
      const x = s < 0 ? 0 : w;
      const d = s < 0 ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + d * pw * 0.5, 0);
      ctx.lineTo(x + d * pw * 1.8, Math.min(h, foot));
      ctx.lineTo(x, Math.min(h, foot));
      ctx.closePath();
      ctx.fill();
    }
  }

  drawCluster(ctx, col, st, t) {
    const lip = this.py(col[2][2]);          // centre column, lip of the cowl
    const band = this.h - lip;
    const cx = this.w / 2, cy = lip + band * 0.46;
    const R = band * 0.4, sr = band * 0.26;
    const sdx = Math.min(band * 1.15, this.w * 0.26);
    const slipping = st.slip > SLIP_WARN;

    const topKmh = st.topKmh || 240;
    const ticks = 8;
    const step = [10, 20, 25, 30, 40, 50, 60].find(v => v * ticks >= topKmh) || 80;
    this.gauge(cx, cy, R, st.speedKmh / (step * ticks), t, {
      ticks, step, every: 2, needle: slipping ? RED : t.accent,
    });
    this.gauge(cx - sdx, cy, sr, Math.max(0, Math.min(1, st.rpm)), t, {
      ticks: 8, step: 1, every: 4, label: 'RPM x1000', redline: 0.82,
      value: st.gear, valueCol: t.accent2,
    });
    this.gauge(cx + sdx, cy, sr, st.progress, t, {
      ticks: 4, marks: ['0', '', '1/2', '', '1'], label: 'PISTA', needle: GREEN,
    });

    this.drawTurnCue(cx, cy, R, st);
    this.drawPanel(ctx, st, t, lip, band, cx - sdx - sr * 1.4, -1, slipping);
    this.drawPanel(ctx, st, t, lip, band, cx + sdx + sr * 1.4, 1, slipping);
  }

  // A co-driver's call, mounted where a real cluster mounts its own turn
  // indicators: flanking the top of the speedometer, in the sunken ring the
  // gauge's own hole leaves around it. Both sides sit here all the time, dim,
  // the way an unlit indicator does -- the one the road is about to bend
  // towards lights up, brighter the less room is left to react.
  drawTurnCue(cx, cy, r, st) {
    const ctx = this.ctx;
    const dir = st.cornerDir;
    const urg = st.cornerUrgency || 0;
    const y = cy - r * 1.16;
    const size = r * 0.15;
    for (const side of [-1, 1]) {
      const on = dir === (side < 0 ? 'l' : 'r');
      const x = cx + side * r * 0.5;
      ctx.beginPath();
      if (side < 0) {
        ctx.moveTo(x + size, y - size);
        ctx.lineTo(x - size * 0.65, y);
        ctx.lineTo(x + size, y + size);
      } else {
        ctx.moveTo(x - size, y - size);
        ctx.lineTo(x + size * 0.65, y);
        ctx.lineTo(x - size, y + size);
      }
      ctx.closePath();
      // Unlit is a printed outline, the same language the tick marks and
      // labels around it are drawn in -- a dim fill against the recess it
      // sits in came out all but invisible, which read as a cue that only
      // exists once it has something to say rather than one waiting quietly.
      if (on) { ctx.fillStyle = tone(AMBER, 0.7 + 0.55 * urg); ctx.fill(); }
      else {
        ctx.strokeStyle = tone(PRINT, 0.32);
        ctx.lineWidth = Math.max(1, r * 0.022);
        ctx.stroke();
      }
    }
  }

  // The two outer panels: the speed in figures with its warning lamps on the
  // left, an air vent on the right. Both are let into the fascia, so they are
  // projected from the same model as everything else.
  drawPanel(ctx, st, t, lip, band, edge, side, slipping) {
    const bw = Math.min(band * 1.0, side < 0 ? edge - 12 : this.w - edge - 12);
    if (bw < 60) return;
    const x = side < 0 ? edge - bw : edge;
    const yy = lip + band * 0.18, bh = band * 0.62;
    // Let into the fascia: the recess is the same moulding with the light off
    // it, and the lip below catches it again.
    ctx.fillStyle = tone(t.dash, 0.34);
    ctx.fillRect(x, yy, bw, bh);
    ctx.fillStyle = tone(t.dash, litFor([0, 0.9, -0.44]));
    ctx.fillRect(x, yy + bh, bw, Math.max(2, bh * 0.07));

    if (side < 0) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = slipping ? RED : PRINT;
      ctx.font = `700 ${Math.round(bh * 0.46)}px ${MONO}`;
      ctx.fillText(String(Math.round(st.speedKmh)), x + bw * 0.5, yy + bh * 0.52);
      ctx.fillStyle = tone(PRINT, 0.5);
      ctx.font = `700 ${Math.round(bh * 0.13)}px ${FONT}`;
      ctx.fillText('KM/H', x + bw * 0.5, yy + bh * 0.68);

      const lamps = [[st.throttle > 0.05, GREEN], [st.brake > 0.05, RED], [slipping, AMBER]];
      const r = Math.max(4, bh * 0.09);
      lamps.forEach(([on, c], i) => {
        const lx = x + bw * (0.26 + i * 0.24), ly = yy + bh * 0.85;
        ctx.fillStyle = on ? c : tone(t.dash, 0.3);
        ctx.beginPath(); ctx.arc(lx, ly, r, 0, Math.PI * 2); ctx.fill();
        if (on) {
          ctx.fillStyle = tone(c, 1.3);
          ctx.beginPath(); ctx.arc(lx, ly - r * 0.28, r * 0.44, 0, Math.PI * 2); ctx.fill();
        }
      });
    } else {
      const n = 3, gap = bh * 0.09, sh = (bh - gap * (n + 1)) / n;
      for (let i = 0; i < n; i++) {
        const sy = yy + gap + i * (sh + gap);
        ctx.fillStyle = tone(t.dash, litFor([0, 0.55, -0.83]));
        ctx.fillRect(x + bw * 0.07, sy, bw * 0.86, sh);
        ctx.fillStyle = tone(t.dash, 0.34);
        ctx.fillRect(x + bw * 0.07, sy + sh * 0.6, bw * 0.86, sh * 0.4);
      }
    }
  }

  // A round instrument, drawn face-on at the projected position and size of
  // where it is mounted: a ring lit from above, a sunken face, printed marks
  // and a needle.
  gauge(cx, cy, r, frac, t, o = {}) {
    const ctx = this.ctx;
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    const ang = a0 + (a1 - a0) * Math.max(0, Math.min(1, frac || 0));

    // The hole it sits in, so the ring has something to be recessed into.
    ctx.fillStyle = tone(t.dash, 0.3);
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.36, 0, Math.PI * 2); ctx.fill();

    const ring = r * 1.17;
    ctx.fillStyle = tone(STEEL, litFor([0, -0.5, -0.86]));
    ctx.beginPath(); ctx.arc(cx, cy, ring, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = tone(STEEL, litFor([0, 0.6, -0.8]));
    ctx.beginPath(); ctx.arc(cx, cy, ring, Math.PI, Math.PI * 2); ctx.fill();
    ctx.fillStyle = SLATE;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.05, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = DARKEST;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();

    if (o.redline != null) {
      ctx.strokeStyle = RED;
      ctx.lineWidth = Math.max(3, r * 0.09);
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.87, a0 + (a1 - a0) * o.redline, a1);
      ctx.stroke();
    }

    const n = o.ticks || 8;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * (i / n);
      const c = Math.cos(a), s = Math.sin(a);
      ctx.strokeStyle = PRINT;
      ctx.lineWidth = Math.max(2, r * 0.07);
      ctx.beginPath();
      ctx.moveTo(cx + c * r * 0.96, cy + s * r * 0.96);
      ctx.lineTo(cx + c * r * 0.83, cy + s * r * 0.83);
      ctx.stroke();
      if (i < n) {
        const am = a0 + (a1 - a0) * ((i + 0.5) / n);
        ctx.lineWidth = Math.max(1, r * 0.03);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(am) * r * 0.96, cy + Math.sin(am) * r * 0.96);
        ctx.lineTo(cx + Math.cos(am) * r * 0.89, cy + Math.sin(am) * r * 0.89);
        ctx.stroke();
      }
      // A dial this size cannot print every number legibly, so a busy face
      // prints every other one and lets the marks carry the rest.
      const mark = i % (o.every || 1) !== 0 ? null
        : (o.marks ? o.marks[i] : (o.step != null ? String(i * o.step) : null));
      if (mark) {
        ctx.fillStyle = PRINT;
        ctx.font = `700 ${Math.round(r * 0.23)}px ${MONO}`;
        ctx.fillText(mark, cx + c * r * 0.62, cy + s * r * 0.62);
      }
    }

    if (o.label) {
      ctx.fillStyle = tone(PRINT, 0.5);
      ctx.font = `700 ${Math.round(r * 0.17)}px ${FONT}`;
      ctx.fillText(o.label, cx, cy + r * 0.68);
    }

    if (o.value != null) {
      const fs = Math.round(r * 0.34);
      const vy = cy + r * 0.4;
      ctx.font = `700 ${fs}px ${MONO}`;
      const bw = Math.max(fs * 1.7, ctx.measureText(o.value).width + fs * 0.8);
      ctx.fillStyle = tone(SLATE, 0.8);
      ctx.fillRect(cx - bw / 2, vy - fs * 0.7, bw, fs * 1.4);
      ctx.fillStyle = o.valueCol || PRINT;
      ctx.fillText(o.value, cx, vy);
    }

    const c = Math.cos(ang), s = Math.sin(ang);
    const hub = r * 0.075;
    ctx.fillStyle = o.needle || t.accent;
    ctx.beginPath();
    ctx.moveTo(cx + c * r * 0.9, cy + s * r * 0.9);
    ctx.lineTo(cx - s * hub, cy + c * hub);
    ctx.lineTo(cx - c * r * 0.17, cy - s * r * 0.17);
    ctx.lineTo(cx + s * hub, cy - c * hub);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = tone(STEEL, litFor([0, 0.8, -0.6]));
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.1, 0, Math.PI * 2); ctx.fill();

    // The glass. One straight-edged wedge, no gradient: enough to say there is
    // something over the face without pretending to be a photograph.
    ctx.fillStyle = 'rgba(226,232,239,.055)';
    ctx.beginPath();
    ctx.moveTo(cx - r, cy - r * 0.35);
    ctx.lineTo(cx + r * 0.25, cy - r);
    ctx.lineTo(cx + r * 0.75, cy - r);
    ctx.lineTo(cx - r * 0.72, cy + r * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.textBaseline = 'alphabetic';
  }

  // The wheel is a ring of quads standing in front of the fascia, tilted back
  // the way a steering column tilts. Each segment is shaded by the way its own
  // piece of the rim is turned, so the top of the rim catches the light and the
  // underside falls into shadow -- and when it turns, the highlight stays put
  // while the grips travel, because the light does not turn with it.
  drawWheel(ctx, st, t, sit) {
    const N = 40;
    const cy = WHEEL.y * sit, cz = WHEEL.z;
    const R = WHEEL.r * (t.wheelScale || 1), tube = WHEEL.tube * (t.wheelScale || 1);
    const ct = Math.cos(WHEEL.tilt), stl = Math.sin(WHEEL.tilt);
    // Wheel plane: x to the right, and an up axis leaned back towards the
    // driver. The plane's normal points up-and-back, out of the column.
    const U = [1, 0, 0], V = [0, ct, -stl];
    const turn = -st.steer * 2.1;
    const at = (a, rad) => [
      Math.cos(a) * rad * U[0],
      cy + Math.sin(a) * rad * V[1],
      cz + Math.sin(a) * rad * V[2],
    ];

    const rim = [];
    for (let i = 0; i <= N; i++) {
      const a = turn + i / N * Math.PI * 2;
      rim.push([at(a, R - tube), at(a, R + tube), a]);
    }
    for (let i = 0; i < N; i++) {
      const [ai, bi, a] = rim[i], [aj, bj] = rim[i + 1];
      // A rim is a tube: the surface you see rolls from facing the driver at
      // the middle of its width to facing outwards at the edges. Blending the
      // radial direction into the plane normal gives each segment its own
      // normal, and that is what makes a flat ring read as round.
      const radial = v3.norm([Math.cos(a), Math.sin(a) * V[1], Math.sin(a) * V[2]]);
      const lit = litFor(v3.norm([
        radial[0] * 0.55, radial[1] * 0.55 + 0.42, radial[2] * 0.55 - 0.72]));
      ctx.fillStyle = tone(t.rim, lit);
      ctx.beginPath();
      ctx.moveTo(this.px(ai), this.py(ai));
      ctx.lineTo(this.px(bi), this.py(bi));
      ctx.lineTo(this.px(bj), this.py(bj));
      ctx.lineTo(this.px(aj), this.py(aj));
      ctx.closePath();
      ctx.fill();
    }

    // Spokes and boss.
    const hubR = R * 0.22;
    for (const off of [0, 2.094, 4.189]) {
      const a = turn + Math.PI / 2 + off;
      const p0 = at(a - 0.075, hubR), p1 = at(a + 0.075, hubR);
      const p2 = at(a + 0.045, R), p3 = at(a - 0.045, R);
      this.face([p0, p1, p2, p3], t.rim, 0.42);
    }
    const boss = [];
    for (let i = 0; i < 16; i++) boss.push(at(turn + i / 16 * Math.PI * 2, hubR));
    this.face(boss, t.rim, 0.5);

    // The mark that says where straight ahead is.
    const m0 = at(turn + Math.PI / 2 - 0.07, R - tube), m1 = at(turn + Math.PI / 2 + 0.07, R - tube);
    const m2 = at(turn + Math.PI / 2 + 0.07, R + tube), m3 = at(turn + Math.PI / 2 - 0.07, R + tube);
    ctx.fillStyle = t.accent;
    ctx.beginPath();
    ctx.moveTo(this.px(m0), this.py(m0));
    ctx.lineTo(this.px(m1), this.py(m1));
    ctx.lineTo(this.px(m2), this.py(m2));
    ctx.lineTo(this.px(m3), this.py(m3));
    ctx.closePath();
    ctx.fill();
  }

  drawTop(ctx, w, h, st) {
    const pad = Math.max(14, w * 0.02);
    const top = Math.max(16, h * 0.035);
    const panel = (x, y, pw, ph) => {
      ctx.fillStyle = 'rgba(34,38,44,.82)';
      ctx.fillRect(x, y, pw, ph);
      ctx.fillStyle = tone(STEEL, 0.78);
      ctx.fillRect(x, y, pw, 2);
    };

    ctx.textAlign = 'center';
    panel(w / 2 - 108, top, 216, 56);
    ctx.fillStyle = AMBER;
    ctx.font = `700 32px ${MONO}`;
    ctx.fillText(formatTime(st.timeMs), w / 2, top + 38);

    // The lap being driven, under the total. On a circuit the total is a sum
    // of laps and says little on its own; this is the number being raced.
    let below = top + 56;
    if (st.lapMs != null) {
      panel(w / 2 - 108, below + 6, 216, 30);
      ctx.fillStyle = tone(PRINT, 0.5);
      ctx.font = `600 10px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText('ESTA VOLTA', w / 2 - 94, below + 26);
      ctx.textAlign = 'right';
      ctx.fillStyle = PRINT;
      ctx.font = `700 19px ${MONO}`;
      ctx.fillText(formatTime(st.lapMs), w / 2 + 94, below + 27);
      below += 36;
      ctx.textAlign = 'center';
    }

    // Gap to the record holder's ghost. Only drawn when there is a ghost, so
    // the cockpit is untouched in a plain time trial -- and it earns its space,
    // because for most of a lap the ghost is out of sight behind or ahead.
    if (st.ghostDelta != null) {
      const d = st.ghostDelta / 1000;
      const ahead = d < 0;
      const label = `${ahead ? '−' : '+'}${Math.abs(d).toFixed(2)}`;
      ctx.font = `700 20px ${MONO}`;
      const bw = Math.max(96, ctx.measureText(label).width + 30);
      panel(w / 2 - bw / 2, below + 6, bw, 32);
      ctx.fillStyle = ahead ? GREEN : RED;
      ctx.fillText(label, w / 2, below + 28);
      below += 38;
    }

    // Laps already done, under the clock, with the best of them picked out.
    // Only on a circuit, and only once there is one -- on a single run the
    // clock above is the whole story and this would be an empty box.
    const done = st.lapTimes || [];
    if (done.length) {
      const rowH = 22, y0 = below + 6;
      const bw = 150;
      panel(w / 2 - bw / 2, y0, bw, rowH * done.length + 10);
      const best = Math.min(...done);
      ctx.font = `700 15px ${MONO}`;
      done.forEach((ms, i) => {
        const y = y0 + 22 + i * rowH;
        const top3 = ms === best && done.length > 1;
        ctx.textAlign = 'left';
        ctx.fillStyle = tone(PRINT, 0.5);
        ctx.fillText(`V${i + 1}`, w / 2 - bw / 2 + 14, y);
        ctx.textAlign = 'right';
        ctx.fillStyle = top3 ? GREEN : PRINT;
        ctx.fillText(formatTime(ms), w / 2 + bw / 2 - 14, y);
      });
    }

    ctx.textAlign = 'left';
    panel(pad, top, 172, 62);
    ctx.fillStyle = tone(PRINT, 0.5);
    ctx.font = `600 10px ${FONT}`;
    // On a circuit the lap is the thing being counted; on a sprint there is
    // only ever one, and the checkpoints are what say how far along you are.
    const laps = st.laps > 1;
    ctx.fillText(laps ? 'VOLTA' : 'CHECKPOINTS', pad + 14, top + 20);
    ctx.fillStyle = PRINT;
    ctx.font = `700 22px ${FONT}`;
    ctx.fillText(laps ? `${st.lap} / ${st.laps}` : `${st.cpDone} / ${st.cpTotal}`,
      pad + 14, top + 46);

    const bx = pad + 92, bw = 66;
    ctx.fillStyle = SLATE;
    ctx.fillRect(bx, top + 34, bw, 6);
    ctx.fillStyle = GREEN;
    ctx.fillRect(bx, top + 34, Math.max(3, bw * st.progress), 6);
    ctx.fillStyle = tone(PRINT, 0.5);
    ctx.font = `600 10px ${MONO}`;
    ctx.fillText(`${Math.round(st.progress * 100)}%`, bx, top + 22);

    ctx.textAlign = 'right';
    panel(w - pad - 172, top, 172, 62);
    ctx.fillStyle = tone(PRINT, 0.5);
    ctx.font = `600 10px ${FONT}`;
    ctx.fillText(st.bestIsLap ? 'MELHOR VOLTA' : 'MELHOR', w - pad - 14, top + 20);
    ctx.fillStyle = st.bestMs == null ? tone(PRINT, 0.5) : GREEN;
    ctx.font = `700 20px ${MONO}`;
    ctx.fillText(formatTime(st.bestMs), w - pad - 14, top + 46);
  }

  drawMessage(ctx, w, h, st) {
    const y = h * 0.32;
    ctx.textAlign = 'center';
    ctx.font = `800 ${Math.round(Math.min(72, w * 0.09))}px ${FONT}`;
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(34,38,44,.85)';
    ctx.strokeText(st.message, w / 2, y);
    ctx.fillStyle = st.messageColor || AMBER;
    ctx.fillText(st.message, w / 2, y);
    if (st.submessage) {
      ctx.font = `600 ${Math.round(Math.min(22, w * 0.028))}px ${FONT}`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(34,38,44,.85)';
      ctx.strokeText(st.submessage, w / 2, y + 38);
      ctx.fillStyle = PRINT;
      ctx.fillText(st.submessage, w / 2, y + 38);
    }
  }
}
