// Installing the game as an app, and making it work without a network.
//
// Both are the browser's own machinery and neither is guaranteed: a browser
// may decide the game is installable and offer it, may decide it is already
// installed, or may not do either. So everything here is written to be asked
// rather than to announce -- the home screen asks whether there is anything to
// offer, and only shows an entry when there is.

let prompt = null;
let listeners = [];

const tell = () => { for (const fn of listeners) fn(); };

// Already running as an app rather than in a tab. Two ways to be true, because
// the display mode a browser actually grants is not always the one asked for
// (see display_override in the manifest).
export const isInstalled = () =>
  matchMedia('(display-mode: fullscreen)').matches
  || matchMedia('(display-mode: standalone)').matches
  || matchMedia('(display-mode: minimal-ui)').matches
  || navigator.standalone === true;

// Whether there is an install to offer right now.
export const canInstall = () => !!prompt && !isInstalled();

export const onChange = fn => { listeners.push(fn); };

// Ask the browser to install. Returns true if the person went through with it.
// Only ever called from a real key press: a browser will refuse a prompt that
// did not come from one, and is right to.
export async function install() {
  if (!prompt) return false;
  const e = prompt;
  prompt = null;
  e.prompt();
  const { outcome } = await e.userChoice;
  tell();
  return outcome === 'accepted';
}

// The browser decided the game qualifies. Holding on to the event is the whole
// trick: it is the only way to offer the install later, from our own menu,
// instead of whenever the browser felt like mentioning it.
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  prompt = e;
  tell();
});

addEventListener('appinstalled', () => { prompt = null; tell(); });

// Offline. Registered late so it never competes with the game's own files for
// the first connections -- the point of it is the *second* visit.
export function enableOffline() {
  if (!('serviceWorker' in navigator)) return;
  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Not being able to work offline is not a reason to not work.
    });
  });
}
