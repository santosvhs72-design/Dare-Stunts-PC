// Canonical name for a key event, resilient to where the event came from.
//
// `KeyboardEvent.code` describes a *physical keyboard key*, and an Android TV
// remote is not a keyboard: WebView commonly delivers its D-pad events with
// `code` empty, so any handler keyed on `code` alone silently ignores every
// press. `key` and the legacy `keyCode` survive that, so fall through to them.
const BY_KEYCODE = {
  13: 'Enter', 27: 'Escape', 32: 'Space',
  37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
  65: 'KeyA', 68: 'KeyD', 71: 'KeyG', 77: 'KeyM', 82: 'KeyR', 83: 'KeyS', 87: 'KeyW',
};

export function keyName(e) {
  if (e.code) return e.code;
  if (e.key === ' ' || e.key === 'Spacebar') return 'Space';
  if (e.key && e.key.length === 1) return 'Key' + e.key.toUpperCase();
  if (e.key && e.key.length > 1) return e.key;          // ArrowUp, Enter, Escape
  return BY_KEYCODE[e.keyCode] || '';
}

// The `key` value that belongs with a canonical name, for the synthetic events
// the Android wrapper feeds in (see __tvKey in main.js).
export function keyValue(name) {
  if (name === 'Space') return ' ';
  if (name.startsWith('Key')) return name.slice(3).toLowerCase();
  return name;
}
