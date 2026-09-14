// Which controller the game is listening to.
//
// getGamepads() hands back one slot per device, and the first slot is not
// necessarily the thing in someone's hands: an Android television commonly
// exposes its own remote as a gamepad too, in a slot of its own. Taking slot
// zero then means polling the remote and ignoring the controller -- which from
// the sofa reads as a controller that is recognised under the wrong name and
// whose buttons do nothing.
//
// So the pad that was last *used* wins, and until something is pressed the
// first connected one stands in. The menus and the driving input both ask
// through here, so the two can never end up listening to different devices.
const AXIS = 0.5;   // stick deflection that counts as someone using this pad

let lastIndex = null;

const stirring = p => p.buttons.some(b => b && b.pressed)
  || p.axes.some(a => Math.abs(a) > AXIS);

export function activePad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let first = null;
  for (const p of pads) {
    if (!p || !p.connected) continue;
    if (!first) first = p;
    // The slot index is the array position, so a remembered index still points
    // at the same device on the next poll.
    if (stirring(p)) { lastIndex = p.index; return p; }
  }
  const kept = lastIndex != null ? pads[lastIndex] : null;
  return kept && kept.connected ? kept : first;
}

// Every connected pad, for the screen that shows what the game can see.
export function allPads() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  return [...pads].filter(p => p && p.connected);
}
