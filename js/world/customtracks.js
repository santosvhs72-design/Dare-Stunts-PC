// Where player-made tracks live, and what one looks like once saved.
//
// Kept apart from the editors on purpose: two very different interfaces build
// these objects -- the pointer-driven desktop editor and the controller-driven
// television one -- and both must produce and read exactly the same thing. It
// also means the TV build never has to pull in the desktop editor's DOM code
// just to list the tracks someone saved.
//
// A track belongs to whoever built it. It is stored under that profile's own
// key (profileKey('tracks') -- unprefixed for the default profile, exactly
// like its records or its chosen car), private by default: nobody else's
// track list ever includes it. Sharing does not move it anywhere or copy it
// -- it only sets a flag, and loadShared() finds every other profile's shared
// tracks by scanning every "*.tracks" key there is, the same technique
// ui/profiles.js already uses to wipe a deleted profile's own data. There is
// no registry of which profiles exist to consult instead.
import { profileKey, listProfiles } from '../ui/profiles.js';
import { clearRecord } from '../game/game.js';

const ownKey = () => profileKey('tracks');

function allTrackKeys() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === 'velocidadecega.tracks' || /^velocidadecega\.[^.]+\.tracks$/.test(k)) keys.push(k);
    }
  } catch { /* private mode */ }
  return keys;
}

// The profile id a "*.tracks" key belongs to. The default profile's own key
// carries no id segment at all -- see profileKey() in ui/profiles.js.
const ownerOf = key => key === 'velocidadecega.tracks'
  ? 'default'
  : key.slice('velocidadecega.'.length, -'.tracks'.length);

const read = key => {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
};
const write = (key, list) => {
  try { localStorage.setItem(key, JSON.stringify(list)); return true; } catch { return false; }
};

// This profile's own tracks, shared or not -- exactly what it always saw,
// just read from its own key instead of one every profile wrote to together.
export const loadCustom = () => read(ownKey()).filter(t => t && Array.isArray(t.pieces));

// Every other profile's tracks that their owner has chosen to share, tagged
// with who built them: the track picker's "Partilhadas" section says so, and
// only the owner ever gets the option to edit, delete or unshare one.
export function loadShared() {
  const mine = ownKey();
  const names = new Map(listProfiles().map(p => [p.id, p.name]));
  const out = [];
  for (const key of allTrackKeys()) {
    if (key === mine) continue;
    const ownerId = ownerOf(key);
    for (const t of read(key)) {
      if (t && Array.isArray(t.pieces) && t.shared) {
        out.push({ ...t, ownerId, ownerName: names.get(ownerId) || 'um piloto apagado' });
      }
    }
  }
  return out;
}

// Shared with the Android TV editor, which builds the same track objects
// through a different interface and must land in the same storage.
export function trackDefFrom({ pieces, length, name, id }) {
  return {
    id: id || `custom-${Date.now().toString(36)}`,
    name,
    custom: true,
    shared: false,   // private until its owner says otherwise
    difficulty: 4,
    diffLabel: 'Tua',
    desc: summarise(pieces, length),
    target: Math.max(20, Math.round(length / 21)),
    pieces: pieces.map(p => ({ ...p })),
  };
}

export function saveCustom(def) {
  const key = ownKey();
  const existing = read(key);
  // A track already on disk keeps whatever sharing choice it had; only a
  // track that has never been saved before starts out at trackDefFrom()'s own
  // default, since def itself always carries shared: false from there.
  const prior = existing.find(t => t.id === def.id);
  if (prior) def = { ...def, shared: prior.shared };
  const list = existing.filter(t => t.id !== def.id);
  list.push(def);
  return write(key, list);
}

export function deleteCustom(id) {
  const key = ownKey();
  write(key, read(key).filter(t => t.id !== id));
  clearRecord(id);   // this profile's own time, ghost and per-car bests on it
}

// Only ever called on a track found through loadCustom(), never through
// loadShared() -- there is no path in the interface from someone else's
// shared track back to this function.
export function setTrackShared(id, shared) {
  const key = ownKey();
  const list = read(key);
  const t = list.find(t => t.id === id);
  if (!t) return false;
  t.shared = shared;
  return write(key, list);
}

function summarise(pieces, length) {
  const count = t => pieces.filter(p => p.t === t).length;
  const bits = [`${(length / 1000).toFixed(2).replace('.', ',')} km`];
  const cps = count('cp');
  if (cps) bits.push(`${cps} checkpoint${cps > 1 ? 's' : ''}`);
  for (const [t, one, many] of [['loop', 'loop', 'loops'], ['cork', 'corkscrew', 'corkscrews'],
                                ['jump', 'salto', 'saltos'], ['hill', 'colina', 'colinas']]) {
    const n = count(t);
    if (n) bits.push(`${n} ${n > 1 ? many : one}`);
  }
  return bits.join(' · ');
}
