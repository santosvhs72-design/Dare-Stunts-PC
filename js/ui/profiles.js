// Local profiles: this game runs on one shared television, and each person's
// records are their own. Everything a profile owns -- its chosen car, its
// records, its ghosts -- lives under a key namespaced with the profile's id;
// everything that belongs to the machine instead (custom tracks, whether the
// sound is muted, whether the ghost is drawn) stays outside any profile,
// because building a track or muting the TV is not something one person did
// just for themselves.
//
// The first profile is the exception: its data sits at the same bare keys
// this game has always used (`velocidadecega.best.<id>`, not
// `velocidadecega.default.best.<id>`). Someone who never opens the profiles
// screen never notices this module exists, and whatever they had already
// recorded before it existed keeps working.
const LIST_KEY = 'velocidadecega.profiles';
const ACTIVE_KEY = 'velocidadecega.activeprofile';
export const DEFAULT_PROFILE_ID = 'default';
const DEFAULT_NAME = 'Piloto 1';

const read = () => {
  try {
    const v = JSON.parse(localStorage.getItem(LIST_KEY));
    return Array.isArray(v) ? v.filter(p => p && p.id && p.name) : null;
  } catch { return null; }
};

const write = list => {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(list)); } catch { /* private mode */ }
};

// Fabricated, not stored, until something needs to persist a change to it --
// a solo player who never touches this screen leaves no trace of it existing.
export function listProfiles() {
  const v = read();
  return v && v.length ? v : [{ id: DEFAULT_PROFILE_ID, name: DEFAULT_NAME }];
}

export function activeProfileId() {
  try {
    const v = localStorage.getItem(ACTIVE_KEY);
    if (v) return v;
  } catch { /* ignore */ }
  return DEFAULT_PROFILE_ID;
}

export function setActiveProfile(id) {
  try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* private mode */ }
}

export function isDefaultProfile(id) { return id === DEFAULT_PROFILE_ID; }

// Where a profile's own data lives. The default profile keeps the game's
// original, unprefixed keys; every other one gets its own namespace.
export function profileKey(suffix) {
  const id = activeProfileId();
  return id === DEFAULT_PROFILE_ID
    ? `velocidadecega.${suffix}`
    : `velocidadecega.${id}.${suffix}`;
}

export function createProfile(name) {
  const list = listProfiles();
  const id = 'p' + Date.now().toString(36) + Math.floor(Math.random() * 36).toString(36);
  list.push({ id, name });
  write(list);
  return id;
}

export function renameProfile(id, name) {
  const list = listProfiles();
  const p = list.find(p => p.id === id);
  if (p) p.name = name;
  else list.push({ id, name });   // renaming the fabricated default persists it for the first time
  write(list);
}

// Every key this profile owns, found by prefix rather than kept in a registry:
// nothing else tracks which tracks a profile has a time or a ghost on.
function wipeProfileData(id) {
  if (id === DEFAULT_PROFILE_ID) return;   // its keys carry no prefix to search for
  const prefix = `velocidadecega.${id}.`;
  const doomed = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch { /* private mode */ }
}

// The default profile is never deletable: it is not one entry among several so
// much as the identity the rest of the game's storage already belongs to, and
// there always has to be somewhere for the active profile to fall back to.
export function deleteProfile(id) {
  if (id === DEFAULT_PROFILE_ID) return;
  const list = listProfiles().filter(p => p.id !== id);
  write(list.length ? list : [{ id: DEFAULT_PROFILE_ID, name: DEFAULT_NAME }]);
  wipeProfileData(id);
  if (activeProfileId() === id) setActiveProfile(DEFAULT_PROFILE_ID);
}
