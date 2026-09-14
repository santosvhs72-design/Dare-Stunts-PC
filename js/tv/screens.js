// The TV screens: one job per screen, each a full page.
//
// The desktop build puts cars, tracks and controls on one scrolling page, which
// is right for a mouse and wrong for a remote: scrolling a long page with a
// D-pad is slow and it is easy to lose track of where the selection is. Here
// each choice gets its own screen with a single row to walk along.
import { CARS, carById } from '../game/cars.js';
import { TRACKS } from '../world/tracks.js';
import { getBest, getCarBests, clearRecord,
         getLaps, setLaps, LAP_CHOICES,
         getRaceMode, setRaceMode, MODE_RACE, MODE_TIME } from '../game/game.js';
import { formatTime } from '../game/hud.js';
import { loadCustom, loadShared, deleteCustom, setTrackShared } from '../world/customtracks.js';
import { walkTrack } from '../world/track.js';
import { drawTrackMap } from './map.js';
import { keyName } from '../ui/keys.js';
import { activePad, allPads } from '../ui/pads.js';
import { textEntry } from './keyboard.js';
import { listProfiles, activeProfileId, isDefaultProfile,
         createProfile, renameProfile, deleteProfile } from '../ui/profiles.js';

export const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const node = html => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild;
};

// Shown on the home screen, so a screenshot says which build produced it --
// which matters more here than it ever did on a television, because most of
// the work in this repository is about how the picture looks.
export const BUILD = '0.1-pc';

export const allTracks = () => [...TRACKS, ...loadCustom()];

const legend = items => `<div class="legend">${items.map(i =>
  `<span class="${i[0]}"><em>${i[1]}</em>${esc(i[2])}</span>`).join('')}
  <span class="pad" id="padStatus"></span></div>`;

// Keeps the focused card in the middle of the screen: the rail slides, the
// selection does not, so the eye never has to hunt for it.
function centreRail(inner, index) {
  const card = inner.children[index];
  if (!card) return;
  const view = inner.parentElement.clientWidth;
  inner.style.transform = `translateX(${Math.round(view / 2 - card.offsetLeft - card.offsetWidth / 2)}px)`;
}

/* ------------------------------------------------------------------ home -- */

export function homeScreen(app) {
  const items = [
    { id: 'play', label: 'Jogar', hint: 'escolher carro e pista' },
    { id: 'build', label: 'Construir pista', hint: '' },
    { id: 'sound', label: 'Som', hint: '' },
    { id: 'profile', label: 'Perfil', hint: '' },
    { id: 'pad', label: 'Testar Comando', hint: 'ver o que o jogo recebe' },
    { id: 'quit', label: 'Sair', hint: 'fechar a aplicação' },
  ];
  let i = 0;

  const el = node(`<div class="screen"><div class="safe">
    <div class="homewrap">
      <div class="homeside">
        <h1 class="brand">DARE <span>STUNTS</span></h1>
        <p class="sub">Loops, corkscrews e saltos. Contra o relógio.</p>
        <img class="homeart" src="img/capa.svg" alt="" width="960" height="540">
      </div>
      <div class="menu" id="menu"></div>
    </div>
    ${legend([['a', 'A', 'escolher'], ['', '↕', 'navegar'], ['', 'v', BUILD]])}
  </div></div>`);

  const paint = () => {
    const byId = id => items.find(it => it.id === id);
    byId('sound').hint = app.sound.muted ? 'desligado' : 'ligado';
    const active = listProfiles().find(p => p.id === activeProfileId());
    byId('profile').hint = active ? active.name : '';
    el.querySelector('#menu').innerHTML = items.map((it, n) =>
      `<div class="item${n === i ? ' on' : ''}">${esc(it.label)}
        <span class="hint">${esc(it.hint)}</span></div>`).join('');
  };
  paint();

  return {
    el,
    resumed: paint,   // coming back from the profiles screen, the name may have changed
    key(a) {
      if (a === 'up') { i = (i - 1 + items.length) % items.length; paint(); }
      else if (a === 'down') { i = (i + 1) % items.length; paint(); }
      else if (a === 'ok') {
        const id = items[i].id;
        if (id === 'play') app.push(carScreen(app));
        else if (id === 'build') app.openEditor(null);
        else if (id === 'profile') app.push(profilesScreen(app));
        else if (id === 'pad') app.push(padScreen(app));
        else if (id === 'quit') app.exit();
        else { app.sound.setMuted(!app.sound.muted); paint(); }
      }
    },
  };
}

/* --------------------------------------------------------------- profiles -- */

// Local profiles: one shared television, several people, each with their own
// car choice, records and ghosts. A rail of named cards, not a list -- the
// same left/right-to-browse, down-for-options language as the car and track
// pickers, so nothing about this screen has to be learned twice.
export function profilesScreen(app) {
  let list = listProfiles();
  let i = Math.max(0, list.findIndex(p => p.id === activeProfileId()));

  const el = node(`<div class="screen"><div class="safe">
    <div class="eyebrow">Perfis</div>
    <div class="rail"><div class="railinner" id="rail"></div></div>
    ${legend([['a', 'A', 'escolher'], ['b', 'B', 'voltar'],
              ['', '↓', 'opções'], ['', '↔', 'mudar de perfil']])}
  </div></div>`);
  const rail = el.querySelector('#rail');

  const build = () => {
    rail.innerHTML = list.map(p => `<div class="card" style="width:15vw">
        <div class="cname">${esc(p.name)}</div>
        <div class="ctag">${p.id === activeProfileId() ? 'em uso' : 'A para escolher'}</div>
      </div>`).join('')
      + `<div class="card" style="width:15vw">
           <div class="cname">+ Novo perfil</div>
           <div class="ctag">criar e dar nome</div>
         </div>`;
  };

  const paint = () => {
    [...rail.children].forEach((c, n) => c.classList.toggle('on', n === i));
    centreRail(rail, i);
  };

  // After a rename, a delete, or a new profile, the rail no longer matches
  // what is stored -- rebuilt from scratch rather than patched, the same way
  // the track picker's own refresh() rebuilds its rail after an edit.
  const refresh = () => {
    list = listProfiles();
    i = Math.min(i, list.length);   // list.length itself is the "new profile" card
    build(); paint();
  };

  build();

  const createNew = () => app.push(textEntry({
    title: 'Nome do novo perfil', value: '', max: 18,
    onDone: v => {
      app.pop();
      const id = createProfile(v || `Piloto ${list.length + 1}`);
      app.setProfile(id);
      refresh();
      i = Math.max(0, list.findIndex(p => p.id === id));
      paint();
    },
    onCancel: () => app.pop(),
  }));

  // A remote has no X or Y button, so renaming and deleting live behind the
  // same "press down for options" gesture the track and piece menus use --
  // "Escolher" repeats what A already does directly, exactly as "Correr em X"
  // repeats what A does on the track picker itself.
  const profileMenu = p => {
    const items = [
      { label: 'Escolher', run: () => { app.pop(); app.setProfile(p.id); refresh(); } },
      { label: 'Mudar o nome', run: () => { app.pop(); app.push(textEntry({
        title: 'Nome do perfil', value: p.name, max: 18,
        onDone: v => { app.pop(); if (v) renameProfile(p.id, v); refresh(); },
        onCancel: () => app.pop(),
      })); } },
    ];
    // The default profile owns this game's original, unprefixed storage --
    // there is nowhere else for that data to go, so it is the one profile
    // that is always here and never offered for deletion.
    if (!isDefaultProfile(p.id) && list.length > 1) {
      items.push({ label: 'Apagar perfil', run: () => { app.pop(); app.push(confirmModal({
        title: `Apagar "${p.name}"?`,
        text: 'O carro escolhido, os recordes e os fantasmas deste perfil desaparecem para sempre.',
        yes: 'Apagar', no: 'Manter',
        onYes: () => { deleteProfile(p.id); app.pop(); refresh(); },
        onNo: () => app.pop(),
      })); } });
    }
    let n = 0;
    const m = node(`<div class="modal"><div class="panel">
      <h2>${esc(p.name)}</h2><div class="menu" id="mi"></div>
      <div class="legend"><span class="a"><em>A</em>escolher</span>
        <span class="b"><em>B</em>fechar</span></div>
    </div></div>`);
    const paintM = () => {
      m.querySelector('#mi').innerHTML = items.map((it, k) =>
        `<div class="item${k === n ? ' on' : ''}">${esc(it.label)}</div>`).join('');
    };
    paintM();
    return {
      el: m,
      key(a) {
        if (a === 'up') { n = (n - 1 + items.length) % items.length; paintM(); }
        else if (a === 'down') { n = (n + 1) % items.length; paintM(); }
        else if (a === 'ok') items[n].run();
        else if (a === 'back') app.pop();
      },
    };
  };

  return {
    el,
    mounted: paint,          // offsetLeft is only real once the screen is in the DOM
    resumed: refresh,
    key(a) {
      const n = list.length + 1;   // profiles plus the "create" card
      if (a === 'left') { i = (i - 1 + n) % n; paint(); }
      else if (a === 'right') { i = (i + 1) % n; paint(); }
      else if (a === 'ok') {
        if (i === list.length) createNew();
        else { app.setProfile(list[i].id); refresh(); }   // "em uso" moves to this card
      }
      else if (a === 'back') app.pop();
      else if (a === 'down') {
        if (i === list.length) createNew();
        else app.push(profileMenu(list[i]));
      }
    },
  };
}

/* --------------------------------------------------------------- gamepad -- */

// What the page actually receives from a controller.
//
// A controller can fail in three different places and they look identical from
// the sofa: its buttons may never reach the page at all, the Gamepad API may
// not be exposed by this WebView, or several devices may be present -- a
// television usually offers its own remote as a gamepad too -- and the game may
// be listening to the wrong one. There is no console to open on a television,
// so this tells them apart: every pad the browser admits to, which of them the
// game is listening to, and the last few keys that arrived.
export function padScreen(app) {
  let seen = [];
  const el = node(`<div class="screen"><div class="safe">
    <div class="eyebrow">Comando</div>
    <p class="sub" id="padapi"></p>
    <div class="menu" id="padlist" style="min-width:56vw;margin-top:1vh"></div>
    <p class="sub" id="paddrive" style="margin-top:1.5vh"></p>
    <p class="sub" id="padkeys" style="margin-top:.6vh"></p>
    ${legend([['b', 'B', 'voltar'],
              ['', '↕', 'trava e vira ao mesmo tempo: os dois têm de acender juntos']])}
  </div></div>`);

  const onKey = e => {
    seen.unshift(`${keyName(e) || '?'} (${e.keyCode})`);
    seen = seen.slice(0, 6);
  };
  addEventListener('keydown', onKey);

  const paint = () => {
    const has = !!navigator.getGamepads;
    const pads = has ? allPads() : [];
    const chosen = has ? activePad() : null;
    el.querySelector('#padapi').textContent = !has
      ? 'Gamepad API indisponível nesta WebView — só as teclas abaixo chegam ao jogo'
      : pads.length
        ? `${pads.length} comando(s) ligado(s) · o jogo ouve o que foi usado por último`
        : 'Nenhum comando visível — carrega num botão do comando (só aparece depois disso)';
    el.querySelector('#padlist').innerHTML = pads.map(p => {
      const on = p.buttons.map((b, i) => (b && b.pressed ? i : null)).filter(i => i !== null);
      const ax = [...p.axes].slice(0, 4).map(a => a.toFixed(2)).join('  ');
      const mine = chosen && p.index === chosen.index;
      return `<div class="item${mine ? ' on' : ''}">${esc(p.id.slice(0, 52))}
        <span class="hint">botões ${on.length ? on.join(' ') : '—'} · eixos ${esc(ax)}</span></div>`;
    }).join('');
    el.querySelector('#padkeys').textContent = seen.length
      ? `Teclas recebidas: ${seen.join('   ')}`
      : 'Teclas recebidas: nenhuma ainda — o comando também deve aparecer aqui';

    // What driving itself makes of all that -- the part that actually reaches
    // the car, and the only place a controller that cannot do two things at
    // once shows itself. A D-pad is one switch: hold "down" to brake and it
    // cannot also report "left", so the car brakes beautifully and then refuses
    // to turn. Nothing in the list of buttons above would ever say so; holding
    // both and watching these two readings at the same time does.
    const d = app.input ? app.input.poll() : null;
    const bar = v => '▮'.repeat(Math.round(Math.abs(v) * 8)).padEnd(8, '·');
    el.querySelector('#paddrive').textContent = d
      ? `A conduzir agora:  acelerador ${bar(d.throttle)}  travão ${bar(d.brake)}  `
        + `direção ${d.steer < -0.05 ? '◀' : d.steer > 0.05 ? '▶' : '—'} ${bar(d.steer)}  `
        + `travão de mão ${d.handbrake ? 'SIM' : 'não'}`
      : '';
  };
  paint();
  const timer = setInterval(paint, 120);

  return {
    el,
    dispose() { clearInterval(timer); removeEventListener('keydown', onKey); },
    key(a) { if (a === 'back') app.pop(); },
  };
}

/* -------------------------------------------------------------- car pick -- */

export function carScreen(app) {
  let i = Math.max(0, CARS.findIndex(c => c.id === app.car.id));

  const el = node(`<div class="screen"><div class="safe">
    <div class="eyebrow">Escolhe o carro</div>
    <div class="rail"><div class="railinner" id="rail">${CARS.map(c => `
      <div class="card">
        <img src="${c.img}" alt="${esc(c.name)}" width="480" height="360">
        <div class="cname">${esc(c.name)}</div>
        <div class="ctag">${esc(c.tagline)}</div>
        <div class="cbest">${esc(c.best)}</div>
        <div class="bars">${Object.entries(c.bars).map(([k, v]) => `
          <div class="bar"><span>${esc(k)}</span><i><b style="width:${Math.round(v * 100)}%;
            background:${c.theme.accent}"></b></i></div>`).join('')}</div>
      </div>`).join('')}</div></div>
    ${legend([['a', 'A', 'confirmar'], ['b', 'B', 'voltar'], ['', '↔', 'trocar de carro']])}
  </div></div>`);

  const rail = el.querySelector('#rail');
  const paint = () => {
    [...rail.children].forEach((c, n) => c.classList.toggle('on', n === i));
    centreRail(rail, i);
  };

  return {
    el,
    mounted: paint,          // offsetLeft is only real once the screen is in the DOM
    key(a) {
      if (a === 'left') { i = (i - 1 + CARS.length) % CARS.length; paint(); }
      else if (a === 'right') { i = (i + 1) % CARS.length; paint(); }
      else if (a === 'ok') { app.setCar(CARS[i]); app.push(trackScreen(app)); }
      else if (a === 'back') app.pop();
    },
  };
}

/* ------------------------------------------------------------ track pick -- */

// One screen serves two purposes: the normal picker (official tracks plus
// this profile's own, exactly as it always was) and, pushed on top of it, a
// second visit to the very same screen showing what other profiles have
// shared -- reached through a trailing card in the first rail, the same way
// profilesScreen ends its own rail with a card for creating a new profile.
// Almost everything -- the map thumbnails, the record shown, the menu that
// opens on ↓ -- is identical either way; `shared` only changes where the
// list comes from and which of that menu's actions make sense for a track
// that belongs to somebody else.
export function trackScreen(app, { shared = false } = {}) {
  let list = shared ? loadShared() : allTracks();
  let i = 0;
  const walks = new Map();
  // A track is a circuit if its own geometry comes back to where it started;
  // the walk is already cached here for the map on each card.
  const walked = t => {
    if (!walks.has(t.id)) {
      try { walks.set(t.id, walkTrack(t.pieces)); } catch { walks.set(t.id, null); }
    }
    return walks.get(t.id);
  };
  const isCircuit = t => !!(walked(t) && walked(t).closed);
  const isRace = t => getRaceMode(t.id) === MODE_RACE;
  // Everything the choices on this screen add up to. Both ways of starting a
  // track go through here -- pressing OK on the card and picking "Correr" out
  // of its menu -- which they did not before, and the lap count chosen for a
  // circuit was quietly lost by the first of them.
  const runDef = t => ({
    ...t,
    ...(isCircuit(t) ? { laps: getLaps(t.id) } : {}),
    race: isRace(t),
  });
  // The trailing "Pistas partilhadas" card only exists on the first visit --
  // the shared screen has nothing further to lead to.
  const slots = () => list.length + (shared ? 0 : 1);

  const el = node(`<div class="screen"><div class="safe">
    <div class="eyebrow">${shared ? 'Pistas partilhadas' : 'Escolhe a pista'}
      &middot; <span id="carname"></span></div>
    <p class="sub" id="empty" style="display:none;max-width:44vw"></p>
    <div class="rail"><div class="railinner" id="rail"></div></div>
    <div id="lg"></div>
  </div></div>`);
  el.querySelector('#carname').textContent = app.car.name;

  const rail = el.querySelector('#rail');
  const emptyMsg = el.querySelector('#empty');

  const trackCard = t => {
    const best = getBest(t.id);
    const who = best && best.car ? ` &middot; ${esc(carById(best.car).name)}` : '';
    // The record card already names whichever car set the track record; next
    // to it, the same figure for the car already chosen on the previous
    // screen -- so a lap with a car that has never held the track outright
    // still has something of its own to aim at, without opening the full
    // per-car breakdown just to see it.
    const mine = getCarBests(t.id)[app.car.id];
    // "Tua" only means something on this profile's own list; a track found
    // through loadShared() is never that, so the chip says whose it is
    // instead of claiming it as this profile's difficulty tier.
    const chipLabel = t.ownerName ? 'Partilhada' : t.diffLabel;
    return `<div class="card tcard">
      <canvas></canvas>
      <div class="cname">${esc(t.name)}</div>
      <div class="ctag"><span class="chip d${t.difficulty}">${esc(chipLabel)}</span>
        ${t.ownerName ? ` &middot; por ${esc(t.ownerName)}` : ''}</div>
      <div class="cbest">${esc(t.desc)}</div>
      <div class="meta"><span>Alvo <b>${formatTime(t.target * 1000)}</b></span>
        <span>Recorde <b>${formatTime(best && best.ms)}</b>${who}</span></div>
      <div class="meta"><span>Contigo (${esc(app.car.name)}) <b>${formatTime(mine)}</b></span>
        ${isCircuit(t) ? `<span>Circuito <b>${getLaps(t.id)} voltas</b></span>` : ''}</div>
      <div class="meta"><span>${isRace(t) ? 'Corrida <b>contra um adversário</b>'
        : 'Contra o <b>relógio</b>'}</span></div>
    </div>`;
  };

  // Not a track at all: a door to the shared list, the same way
  // profilesScreen ends its rail with a card for creating a new profile.
  const shareCard = () => {
    const n = loadShared().length;
    return `<div class="card tcard" style="display:flex;flex-direction:column;
        justify-content:center;align-items:center;text-align:center">
      <div class="cname">Pistas partilhadas</div>
      <div class="ctag">${n ? `${n} pista${n > 1 ? 's' : ''} de outros perfis` : 'ainda nenhuma'}</div>
    </div>`;
  };

  const build = () => {
    rail.innerHTML = list.map(trackCard).join('') + (shared ? '' : shareCard());
  };

  // Drawing needs real element sizes, which only exist once the screen is in
  // the document -- called from mounted(), never from build().
  const drawMaps = () => {
    [...rail.children].forEach((card, n) => {
      const t = list[n];
      if (!t) return;   // the trailing "Pistas partilhadas" card has no map
      // Walking a 4 km track into frames is real work, so each track is walked
      // once and the result kept for as long as the screen lives.
      if (!walks.has(t.id)) {
        try { walks.set(t.id, walkTrack(t.pieces)); } catch { walks.set(t.id, null); }
      }
      drawTrackMap(card.querySelector('canvas'), walks.get(t.id), { labels: false, pad: 14 });
    });
  };

  const paint = () => {
    [...rail.children].forEach((c, n) => c.classList.toggle('on', n === i));
    centreRail(rail, i);
    // A shared list can genuinely be empty -- nobody else on this television
    // has shared anything yet -- and that is worth saying, rather than
    // leaving the rail looking like it failed to load.
    emptyMsg.style.display = shared && !list.length ? '' : 'none';
    emptyMsg.textContent = 'Ainda ninguém partilhou uma pista contigo. Um '
      + 'outro perfil pode partilhar a que construiu no menu da pista dele (↓).';
    const onShareCard = !shared && i === list.length;
    const mine = !shared && list[i] && list[i].custom;
    el.querySelector('#lg').innerHTML = legend(
      !list.length ? [['b', 'B', 'voltar']]
      : onShareCard ? [['a', 'A', 'ver'], ['b', 'B', 'voltar']]
      : mine ? [['a', 'A', 'correr'], ['b', 'B', 'voltar'], ['x', 'X', 'editar'], ['y', 'Y', 'apagar'],
                ['', '↓', 'opções']]
      : [['a', 'A', 'correr'], ['b', 'B', 'voltar'], ['', '↓', 'opções']]);
    app.paintPad();
  };

  const askDelete = () => {
    const t = list[i];
    app.push(confirmModal({
      title: 'Apagar pista?',
      text: `"${t.name}" e o seu recorde desaparecem para sempre.`,
      yes: 'Apagar', no: 'Manter',
      onYes: () => { deleteCustom(t.id); app.pop(); refresh(); },
      onNo: () => app.pop(),
    }));
  };

  // Records are worth a confirmation: the time and the ghost go together, and
  // the lap that set them is not coming back.
  const askClear = t => {
    const best = getBest(t.id);
    app.push(confirmModal({
      title: `Limpar o recorde de ${t.name}?`,
      text: `Apaga o tempo de ${formatTime(best && best.ms)}, o fantasma dessa volta`
          + ' e a melhor volta guardada de cada carro nesta pista.',
      yes: 'Limpar', no: 'Cancelar',
      onYes: () => { clearRecord(t.id); app.pop(); refresh(); },
      onNo: () => app.pop(),
    }));
  };

  // The overall record names the car that set it, but says nothing about how
  // the other two would have done -- and picking the right car for a circuit
  // is half the game. This is the one place all four numbers sit together.
  const recordsScreen = t => {
    const overall = getBest(t.id);
    const perCar = getCarBests(t.id);
    const el2 = node(`<div class="modal"><div class="panel">
      <h2>Recordes &middot; ${esc(t.name)}</h2>
      <p class="sub">Global <b>${formatTime(overall && overall.ms)}</b>${overall && overall.car
        ? ` &middot; ${esc(carById(overall.car).name)}` : ''}</p>
      <div class="menu" style="margin-top:1.4vh">${CARS.map(c => `
        <div class="item" style="cursor:default">${esc(c.name)}
          <span class="hint">${formatTime(perCar[c.id])}</span></div>`).join('')}</div>
      ${legend([['b', 'B', 'voltar']])}
    </div></div>`);
    return { el: el2, key(a) { if (a === 'back') app.pop(); } };
  };

  // A television remote has no X or Y button, so running, editing and deleting
  // all have to be reachable from the D-pad alone. A track found through
  // loadShared() only ever offers what makes sense to someone who is not its
  // owner: running it, seeing records, clearing your own. Editing, deleting
  // and the share switch itself stay with whoever built it.
  const trackMenu = () => {
    const t = list[i];
    // A label may be a function, so "Partilhar" can show the choice it is
    // about to flip without the menu having to be closed and reopened.
    const items = [
      { label: () => `${isRace(t) ? 'Corrida' : 'Contra o relógio'} em ${t.name}`,
        run: () => { app.pop(); app.startRace(runDef(t)); } },
      // Racing a car or racing the clock. The same track either way -- the
      // record it keeps is the same record, set on the same line -- so this is
      // a choice about company, not about which game is being played.
      { label: () => `Modo: ${isRace(t) ? 'corrida' : 'contra o relógio'}`,
        run: () => {
          setRaceMode(t.id, isRace(t) ? MODE_TIME : MODE_RACE);
          paintM(); refresh();
        } },
      { label: 'Ver recordes', run: () => { app.pop(); app.push(recordsScreen(t)); } },
    ];
    // Only a circuit has laps to choose. The record is the best single lap, so
    // changing this never puts times out of reach of each other.
    if (isCircuit(t)) {
      items.splice(2, 0, { label: () => `Voltas: ${getLaps(t.id)}`, run: () => {
        const k = LAP_CHOICES.indexOf(getLaps(t.id));
        setLaps(t.id, LAP_CHOICES[(k + 1) % LAP_CHOICES.length]);
        paintM(); refresh();
      } });
    }
    if (getBest(t.id)) {
      items.push({ label: 'Limpar o recorde', run: () => { app.pop(); askClear(t); } });
    }
    if (!shared && t.custom) {
      items.push({ label: () => `Partilhar: ${t.shared ? 'sim' : 'não'}`,
        run: () => { setTrackShared(t.id, !t.shared); t.shared = !t.shared; paintM(); } });
      items.push({ label: 'Editar esta pista', run: () => { app.pop(); app.openEditor(t); } });
      items.push({ label: 'Apagar esta pista', run: () => { app.pop(); askDelete(); } });
    }
    let n = 0;
    const m = node(`<div class="modal"><div class="panel">
      <h2>${esc(t.name)}</h2><div class="menu" id="mi"></div>
      <div class="legend"><span class="a"><em>A</em>escolher</span>
        <span class="b"><em>B</em>fechar</span></div>
    </div></div>`);
    const paintM = () => {
      m.querySelector('#mi').innerHTML = items.map((it, k) =>
        `<div class="item${k === n ? ' on' : ''}">${esc(
          typeof it.label === 'function' ? it.label() : it.label)}</div>`).join('');
    };
    paintM();
    return {
      el: m,
      key(a) {
        if (a === 'up') { n = (n - 1 + items.length) % items.length; paintM(); }
        else if (a === 'down') { n = (n + 1) % items.length; paintM(); }
        else if (a === 'ok') items[n].run();
        else if (a === 'back') app.pop();
      },
    };
  };

  const refresh = () => {
    list = shared ? loadShared() : allTracks();
    i = Math.min(i, Math.max(0, slots() - 1));
    build(); drawMaps(); paint();
  };

  build();

  return {
    el,
    mounted: () => { drawMaps(); paint(); },
    resumed: refresh,        // coming back from the editor or the share toggle
    key(a) {
      if (!slots()) { if (a === 'back') app.pop(); return; }
      if (a === 'left') { i = (i - 1 + slots()) % slots(); paint(); }
      else if (a === 'right') { i = (i + 1) % slots(); paint(); }
      else if (a === 'ok' || a === 'down') {
        if (i === list.length) { app.push(trackScreen(app, { shared: true })); return; }
        if (a === 'ok') app.startRace(runDef(list[i]));
        else app.push(trackMenu());
      }
      else if (a === 'back') app.pop();
      else if (a === 'x' && list[i] && list[i].custom) app.openEditor(list[i]);
      else if (a === 'y' && list[i] && list[i].custom) askDelete();
    },
  };
}

/* ------------------------------------------------------------- confirm -- */

export function confirmModal({ title, text, yes = 'Sim', no = 'Não', onYes, onNo }) {
  let i = 1;   // default to the harmless option
  const el = node(`<div class="modal"><div class="panel centered">
    <h2>${esc(title)}</h2>
    <p class="sub">${esc(text)}</p>
    <div class="menu" id="opts" style="margin-top:2vh"></div>
  </div></div>`);
  const paint = () => {
    el.querySelector('#opts').innerHTML = [yes, no].map((l, n) =>
      `<div class="item${n === i ? ' on' : ''}">${esc(l)}</div>`).join('');
  };
  paint();
  return {
    el,
    key(a) {
      if (a === 'up' || a === 'down' || a === 'left' || a === 'right') { i = 1 - i; paint(); }
      else if (a === 'ok') (i === 0 ? onYes : onNo)();
      else if (a === 'back') onNo();
    },
  };
}
