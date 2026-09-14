// Plan view of a track, used both for the previews on the track picker and for
// the big map in the editor. Same drawing either way, so a track looks the same
// wherever you meet it.
import { ROAD_HALF } from '../world/track.js';
import { clamp } from '../core/math.js';

export function drawTrackMap(canvas, walk, opts = {}) {
  const { selected = -1, labels = true, pad = 22 } = opts;
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  if (!cssW || !cssH) return;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, cssW, cssH);

  if (!walk || walk.frames.length < 3) {
    ctx.fillStyle = 'rgba(200,215,235,.35)';
    ctx.font = `600 ${Math.round(cssH * 0.07)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('sem peças', cssW / 2, cssH / 2);
    return;
  }

  const b = walk.bounds;
  const span = Math.max(b.x1 - b.x0, b.z1 - b.z0, 60);
  const k = Math.min(cssW - pad * 2, cssH - pad * 2) / span;
  const ox = cssW / 2 - (b.x0 + b.x1) / 2 * k;
  const oz = cssH / 2 - (b.z0 + b.z1) / 2 * k;
  const X = f => ox + f.pos[0] * k;
  const Y = f => oz + f.pos[2] * k;

  const yRange = Math.max(1, b.y1 - b.y0);
  const step = Math.max(1, Math.round(1.5 / (k * 1.5) * 3));
  ctx.lineCap = 'round';

  // Tunnel casing first, so the road reads as running inside it.
  ctx.strokeStyle = '#2b323d';
  ctx.lineWidth = Math.max(5, ROAD_HALF * 2 * k * 1.1);
  for (let i = 0; i + step < walk.frames.length; i += step) {
    const a = walk.frames[i], c = walk.frames[i + step];
    if (!a.tunnel) continue;
    ctx.beginPath(); ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(c), Y(c)); ctx.stroke();
  }

  // Altitude ramp: a loop or a viaduct has to stand out from ground-level road,
  // which a flat plan view cannot show on its own.
  ctx.lineWidth = Math.max(2, ROAD_HALF * 2 * k * 0.5);
  for (let i = 0; i + step < walk.frames.length; i += step) {
    const a = walk.frames[i], c = walk.frames[i + step];
    if (a.gap) continue;
    const h = clamp((a.pos[1] - b.y0) / yRange, 0, 1);
    ctx.strokeStyle = `hsl(${210 - h * 190}, ${35 + h * 45}%, ${38 + h * 26}%)`;
    ctx.beginPath(); ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(c), Y(c)); ctx.stroke();
  }

  if (selected >= 0) {
    ctx.strokeStyle = '#ffb43a';
    ctx.lineWidth = Math.max(3.5, ROAD_HALF * 2 * k * 0.66);
    ctx.beginPath();
    let started = false;
    for (const f of walk.frames) {
      if (f.pi !== selected) { started = false; continue; }
      if (!started) { ctx.moveTo(X(f), Y(f)); started = true; } else ctx.lineTo(X(f), Y(f));
    }
    ctx.stroke();
  }

  for (const s of walk.checkpoints) {
    const f = walk.frames[clamp(Math.round(s), 0, walk.frames.length - 1)];
    ctx.fillStyle = '#ffd98a';
    ctx.beginPath(); ctx.arc(X(f), Y(f), Math.max(2, cssH * 0.012), 0, Math.PI * 2); ctx.fill();
  }

  const dot = (f, col, r) => {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(X(f), Y(f), r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(6,9,14,.85)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(X(f), Y(f), r, 0, Math.PI * 2); ctx.stroke();
  };
  const first = walk.frames[0], last = walk.frames[walk.frames.length - 1];
  const r = Math.max(3, cssH * 0.018);

  if (!labels) { dot(first, '#5fd894', r); dot(last, '#eef3f9', r); return; }

  // A track that doubles back needs words, not just colours, to say which end
  // is which.
  const marker = (f, col, text) => {
    dot(f, col, r);
    const fs = Math.max(9, Math.round(cssH * 0.045));
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    const w = ctx.measureText(text).width + fs;
    const x = clamp(X(f), w / 2 + 4, cssW - w / 2 - 4);
    const y = clamp(Y(f), fs * 2.4, cssH - 6);
    ctx.fillStyle = 'rgba(6,9,14,.82)';
    const bx = x - w / 2, by = y - fs * 2.2, bh = fs * 1.5;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, w, bh, 5); ctx.fill(); }
    else ctx.fillRect(bx, by, w, bh);
    ctx.fillStyle = col;
    ctx.fillText(text, x, by + fs * 1.1);
  };
  marker(first, '#5fd894', 'PARTIDA');
  marker(last, '#eef3f9', 'META');
}
