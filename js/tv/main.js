// Android TV shell: a stack of full screens, one input vocabulary, and the
// unchanged game underneath.
//
// The racing itself -- physics, rendering, HUD, sound -- is imported exactly as
// the desktop build uses it. Only the interface around it is different, because
// only the interface is wrong on a television.
import { Game, STATE } from '../game/game.js';
import { Input } from '../game/input.js';
import { Sound } from '../game/audio.js';
import { formatTime } from '../game/hud.js';
import { carById, loadCar, saveCar } from '../game/cars.js';
import { ghostShown, setGhostShown } from '../game/ghost.js';
import { setActiveProfile } from '../ui/profiles.js';
import { keyValue } from '../ui/keys.js';
import { TvInput } from './input.js';
import { homeScreen, node, esc } from './screens.js';
import { editorScreen } from './editor.js';

const ui = document.getElementById('ui');
const input = new Input();
const sound = new Sound();
const tv = new TvInput();

let game;
try {
  game = new Game(document.getElementById('gl'), document.getElementById('hud'), input, sound);
} catch (e) {
  ui.innerHTML = `<div class="screen"><div class="safe"><h1 class="brand">WebGL indisponível</h1>
    <p class="sub">${esc(e.message)}</p></div></div>`;
  throw e;
}

/* ------------------------------------------------------------ view stack -- */

const stack = [];
const top = () => stack[stack.length - 1];

// Show the topmost view plus any modals stacked on it, and hide whatever the
// nearest full screen covers. Without this the track picker would keep
// rendering its map canvases behind the editor.
function restack() {
  let showing = true;
  for (let i = stack.length - 1; i >= 0; i--) {
    const v = stack[i];
    if (!v.el) continue;
    v.el.style.display = showing ? '' : 'none';
    if (showing && !v.el.classList.contains('modal')) showing = false;
  }
}

const app = {
  car: loadCar(),
  sound,
  input,   // the "Comando" screen shows what driving actually makes of a press
  push(v) {
    stack.push(v);
    if (v.el) ui.appendChild(v.el);
    restack();
    if (v.mounted) v.mounted();
    app.paintPad();
  },
  pop() {
    const v = stack.pop();
    if (v && v.el) v.el.remove();
    if (v && v.dispose) v.dispose();
    restack();
    const t = top();
    if (t && t.resumed) t.resumed();
    app.paintPad();
  },
  reset(v) {
    while (stack.length) app.pop();
    app.push(v);
  },
  setCar(c) { app.car = c; game.car0 = c; saveCar(c.id); },
  // Switching profile changes whose records, ghosts and chosen car everything
  // else reads -- profileKey() (game.js, ghost.js, cars.js) looks up the
  // active profile fresh on every call, so nothing needs telling about the
  // switch except the two values this shell itself is holding onto here.
  setProfile(id) {
    setActiveProfile(id);
    app.car = loadCar();
    game.car0 = app.car;
  },
  // A browser tab a person opened themselves will refuse window.close(), and
  // that is the right outcome: on a PC the tab is theirs to close. The item
  // stays because the interface it belongs to came from the television build
  // whole, and removing one entry from a menu that is going to be rewritten
  // anyway would only make the two harder to compare.
  exit() { window.close(); },
  startRace(def) { startRace(def); },
  openEditor(def) { app.push(editorScreen(app, def)); },
  paintPad() {
    for (const p of ui.querySelectorAll('#padStatus')) {
      p.textContent = tv.padConnected ? `Comando: ${tv.padName.slice(0, 30)}` : 'Sem comando';
      p.classList.toggle('on', tv.padConnected);
    }
  },
};

/* ------------------------------------------------------------------ race -- */

let racing = false;

// While a race runs nothing is on screen but the game; this placeholder view
// exists only so the menu and back buttons still have somewhere to land.
//
// `drive: true` tells the central dispatcher below not to play the menu tick
// on up/down/left/right here: those are steering, arriving through the same
// D-pad and the same TvInput actions as menu navigation, and would otherwise
// click on every single input of an analogue stick held over into a turn.
const raceView = () => ({
  el: null,
  drive: true,
  // The one screen that is a car rather than a menu, so B is the handbrake
  // here and nothing else -- see the dispatcher below.
  car: true,
  key(a) {
    if (a === 'menu' || a === 'back') pauseRace();
    // G on a keyboard, Y on a pad. A remote has neither, so the pause menu
    // carries the same switch -- a shortcut is never the only way in.
    else if (a === 'ghost' || a === 'y') toggleGhost();
  },
});

function startRace(def) {
  const loading = node(`<div class="screen"><div class="safe centered"
    style="justify-content:center"><h1 class="brand">A construir a pista...</h1></div></div>`);
  app.push({ el: loading });
  // setTimeout rather than rAF: rAF never fires while the tab is hidden, and the
  // pause has to survive that to let the loading screen paint.
  setTimeout(() => {
    app.pop();
    sound.unlock();
    game.load(def);
    ui.classList.add('hidden');
    racing = true;
    app.push(raceView());
    game.start();
  }, 30);
}

function leaveRace() {
  racing = false;
  game.stop();
  ui.classList.remove('hidden');
}

// Watching the lap just finished, from outside the car. No `.modal` class on
// purpose: restack() (above) hides whatever is under a non-modal top of
// stack, so pushing this is what takes the result panel's dark backdrop off
// the screen and leaves the replay filling it, and popping it (Voltar) is
// what brings the result panel straight back.
function replayView() {
  const el = node(`<div class="safe" style="justify-content:flex-end;align-items:center">
    <div style="background:rgba(34,38,44,.82);border-radius:12px;padding:1vh 1.6vw;
      margin-bottom:1.6vh;font:700 1.5vw/1 ui-monospace,Menlo,monospace;color:#ffb43a">
      <span id="rp-time"></span>
    </div>
    <div class="legend">
      <span class="a"><em>A</em><span id="rp-pause">pausar</span></span>
      <span class="b"><em>B</em>sair</span>
    </div>
  </div>`);
  const timeEl = el.querySelector('#rp-time');
  const pauseEl = el.querySelector('#rp-pause');
  let raf = null;
  const tick = () => {
    const total = game.lastLap ? game.lastLap.ms : 0;
    timeEl.textContent = `${formatTime(Math.min(game.replayTimeMs, total))} / ${formatTime(total)}`;
    pauseEl.textContent = game.replayPaused ? 'continuar' : 'pausar';
    raf = requestAnimationFrame(tick);
  };
  return {
    el,
    drive: true,   // nothing here is menu navigation either
    mounted: tick,
    dispose() { if (raf) cancelAnimationFrame(raf); game.stopReplay(); },
    key(a) {
      if (a === 'back' || a === 'menu') app.pop();
      else if (a === 'ok') game.toggleReplayPause();
    },
  };
}

// Racing against a ghost is not always what you want: on a track you are still
// learning it is another car in the way, and the gap readout is a running
// commentary on losing. So it goes off and on mid-lap, and the choice sticks.
function toggleGhost() {
  if (!racing) return;
  const on = !game.showGhost;
  game.showGhost = on;
  setGhostShown(on);
  game.setMessage(on ? 'FANTASMA LIGADO' : 'FANTASMA DESLIGADO',
    on && !game.ghost ? 'ainda não há volta guardada nesta pista' : '',
    '#7fd0ff', 1.2);
}

function pauseRace() {
  if (!racing || game.state === STATE.PAUSED) return;
  game.pause();
  ui.classList.remove('hidden');
  app.push(pauseModal());
}

function pauseModal() {
  let view;
  const items = [
    { label: 'Continuar', run: () => { app.pop(); ui.classList.add('hidden'); game.resume(); } },
    { label: () => `Fantasma: ${game.showGhost ? 'ligado' : 'desligado'}`,
      run: () => { toggleGhost(); view.paint(); } },
    { label: 'Reiniciar', run: () => { app.pop(); ui.classList.add('hidden'); game.restart(); } },
    { label: 'Abandonar Corrida', run: () => { app.pop(); app.pop(); leaveRace(); } },
  ];
  view = listModal('Pausa', items, () => items[0].run());
  return view;
}

function listModal(title, items, onBack) {
  let i = 0;
  const el = node(`<div class="modal"><div class="panel centered">
    <h2>${esc(title)}</h2><div class="menu" id="mi" style="margin-top:1.4vh"></div>
    <div class="legend"><span class="a"><em>A</em>escolher</span>
      <span class="pad" id="padStatus"></span></div>
  </div></div>`);
  // A label may be a function, for an item that shows the state it switches.
  const paint = () => {
    el.querySelector('#mi').innerHTML = items.map((it, n) =>
      `<div class="item${n === i ? ' on' : ''}">${esc(
        typeof it.label === 'function' ? it.label() : it.label)}</div>`).join('');
  };
  paint();
  return {
    el,
    paint,
    key(a) {
      if (a === 'up') { i = (i - 1 + items.length) % items.length; paint(); }
      else if (a === 'down') { i = (i + 1) % items.length; paint(); }
      else if (a === 'ok') items[i].run();
      else if (a === 'back' || a === 'menu') onBack ? onBack() : app.pop();
    },
  };
}

game.onFinish = ({ time, best, record, carRecord, lapTimes, circuit, scored, won, rivalTime }) => {
  const who = best && best.car ? ` · ${carById(best.car).name}` : '';
  // On a circuit the board is about the best single lap, so say so rather than
  // letting a lap time sit next to a three-lap total as if they compared.
  const what = circuit ? 'Recorde por volta' : 'Recorde';
  const bestLine = `${what} ${formatTime(best && best.ms)}${esc(who)}`
    + ` · alvo ${formatTime(game.def.target * 1000)}`;
  // Three outcomes, not two: the overall record (unmistakable, it needs no
  // company), a personal best with this particular car even though someone
  // else's car still holds the track outright (worth naming, or trying a car
  // you are not fastest with would only ever feel like losing), or neither.
  // In a race, who won comes first and the record is a footnote; the clock
  // still ran and still counts, but it is not what the last two minutes were
  // about. In a time trial nothing here changes.
  const title = won === true ? 'Ganhaste!'
    : won === false ? 'Segundo lugar'
    : record ? 'Novo recorde!'
    : carRecord ? `Melhor com o ${esc(game.car0.name)}!` : 'Terminado';
  const recordLine = record
    ? `${circuit ? 'Melhor volta' : 'Melhor tempo'} em ${esc(game.def.name)}`
      + ` com o ${esc(game.car0.name)}${circuit ? `: ${formatTime(scored)}` : ''}`
    : bestLine;
  // The margin, when there is one to name: the rival only has a finish time if
  // it got there first, so a win is measured against nothing and just says so.
  const raceLine = won === true
    ? `Passaste a meta à frente do adversário${record ? ' &mdash; e com recorde' : ''}`
    : won === false && rivalTime != null
      ? `O adversário chegou ${formatTime(time - rivalTime)} antes de ti`
      : 'O adversário chegou primeiro';
  const sub = won == null ? recordLine : raceLine;
  // On a circuit the total is only half the story: which lap was the good one
  // is the part worth looking at, so every one of them is listed with the best
  // picked out.
  const best2 = lapTimes && lapTimes.length > 1 ? Math.min(...lapTimes) : null;
  const laps = best2 == null ? '' : `<div class="laps">${lapTimes.map((ms, i) =>
    `<div class="lap${ms === best2 ? ' best' : ''}"><span>Volta ${i + 1}</span>`
    + `<b>${formatTime(ms)}</b></div>`).join('')}</div>`;

  const el = node(`<div class="modal"><div class="panel centered">
    <h2>${title}</h2>
    <div class="bigtime">${formatTime(time)}</div>
    <p class="sub">${sub}</p>
    ${laps}
    <div class="menu" id="mi" style="margin-top:2vh"></div>
    <div class="legend"><span class="a"><em>A</em>escolher</span>
      <span class="pad" id="padStatus"></span></div>
  </div></div>`);

  const items = [
    { label: 'Outra volta', run: () => { app.pop(); ui.classList.add('hidden'); game.restart(); } },
    { label: 'Ver reposição', run: () => { game.startReplay(); app.push(replayView()); } },
    { label: 'Sair', run: () => { app.pop(); app.pop(); leaveRace(); } },
  ];
  let i = 0;
  const paint = () => {
    el.querySelector('#mi').innerHTML = items.map((it, n) =>
      `<div class="item${n === i ? ' on' : ''}">${esc(it.label)}</div>`).join('');
  };
  paint();

  ui.classList.remove('hidden');
  app.push({
    el,
    key(a) {
      if (a === 'up') { i = (i - 1 + items.length) % items.length; paint(); }
      else if (a === 'down') { i = (i + 1) % items.length; paint(); }
      else if (a === 'ok') items[i].run();
    },
  });
};

/* ----------------------------------------------------------------- input -- */

// Menu feedback: a click on every genuine change of highlight. Every screen
// but the race view uses up/down/left/right purely for navigation (see
// raceView's `drive` flag above for the one exception), and every one of
// them wraps at the ends rather than stopping dead -- so a directional
// action reaching here always did move the selection, and there is nowhere
// better to hook this once than the single point every action already
// passes through on its way to whichever screen is on top.
let audioTouched = false;
tv.on(a => {
  if (!audioTouched) { audioTouched = true; sound.unlock(); }
  const t = top();
  // The controller's B arrives as its own action. While a lap is running it is
  // the handbrake -- the driving layer reads it as a held key (KEYS in
  // game/input.js) and it must not also read as "back" and put the pause menu
  // up in the middle of a corner. Anywhere else there is no car holding it, and
  // it is exactly what "back" means. The remote's own Back key and Select still
  // send 'back' directly, so pausing with a remote is untouched.
  if (a === 'b') {
    if (t && t.car) return;
    a = 'back';
  }
  if (!(t && t.drive) && (a === 'up' || a === 'down' || a === 'left' || a === 'right')) sound.tick();
  if (t && t.key) t.key(a);
});

// The wrapper hands remote keys straight to the page (see MainActivity). They
// arrive as ordinary synthetic key events, which is all TvInput needs -- the TV
// interface never relies on DOM focus or default actions, so untrusted events
// are as good as real ones here.
window.__tvKey = (action, name) => {
  dispatchEvent(new KeyboardEvent(action === 'down' ? 'keydown' : 'keyup',
    { code: name, key: keyValue(name), bubbles: true, cancelable: true }));
};

// The whole point of this repository is how the picture looks, and judging
// that means putting the same corner of the same track side by side before and
// after a change. Driving there by hand never lands twice in the same place,
// so the game object is reachable from the outside: a test can load a track,
// put the car at a chosen distance along it and take the shot, and get the
// same framing every time. Nothing in the game reads this back -- it only ever
// hands the object out.
window.__game = () => game;

// Android's own Back button: close whatever is open, and only let the system
// exit the app when we are already at the home screen.
window.__tvBack = () => {
  if (stack.length > 1) { const t = top(); if (t && t.key) t.key('back'); return false; }
  return true;
};

addEventListener('resize', () => { game.renderer.resize(); game.hud.resize(); });

// Pad status is polled rather than pushed: a controller that is switched on
// after the app starts otherwise shows as missing forever.
setInterval(() => app.paintPad(), 600);

game.car0 = app.car;   // the Game drives whichever car the picker last confirmed
// The ghost is a TV-version feature; the desktop build records laps but never
// draws them, so it stays exactly as it was. On by default, until turned off.
game.showGhost = ghostShown();
app.push(homeScreen(app));
