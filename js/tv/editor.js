// Track editor driven entirely by a controller.
//
// The desktop editor is a pointer tool: click a palette, drag sliders, click a
// row in a list. None of that survives a D-pad. This one is built the other way
// round -- the track is a strip you walk along with left/right, and every
// action is a face button whose meaning is printed on screen at all times.
// There are no hidden gestures and nothing needs aiming.
//
//   ←/→   move the cursor along the track      A  add a piece after the cursor
//   Y     adjust the piece under the cursor    X  delete it
//   LB/RB shuffle it earlier/later             ☰  track menu (test, save, name)
//
// Modes are modals stacked on top: adding, adjusting, naming and the menu each
// take over the buttons completely, so a button never means two things at once.
import { PIECE_TYPES, defaults, describe } from '../world/pieces.js';
import { walkTrack, buildTrack } from '../world/track.js';
import { testDrive } from '../editor/autopilot.js';
import { closeCircuit } from '../editor/close.js';
import { trackDefFrom, saveCustom, loadCustom, setTrackShared } from '../world/customtracks.js';
import { node, esc, confirmModal } from './screens.js';
import { getBest, clearRecord, DEFAULT_LAPS } from '../game/game.js';
import { formatTime } from '../game/hud.js';
import { textEntry } from './keyboard.js';
import { drawTrackMap } from './map.js';

const TYPE_ORDER = ['s', 'c', 'chicane', 'hill', 'climb', 'drop', 'jump', 'loop', 'cork', 'cp'];

const STARTER = [
  { t: 's', len: 80 }, { t: 'cp' },
  { t: 'c', r: 70, a: 70, dir: 'r', bank: 9 },
  { t: 's', len: 50 },
  { t: 'hill', deg: 10, crest: 16 },
  { t: 's', len: 60 }, { t: 'cp' },
  { t: 'loop', r: 19 },
  { t: 's', len: 55 },
  { t: 'c', r: 65, a: 80, dir: 'l', bank: 10 },
  { t: 's', len: 80 },
];

export function editorScreen(app, def) {
  let pieces = def ? def.pieces.map(p => ({ ...p })) : STARTER.map(p => ({ ...p }));
  let name = def ? def.name : '';
  let editingId = def ? def.id : null;
  let cursor = pieces.length ? 0 : -1;   // -1 means "before the first piece"
  let walk = null;
  let dirty = false;

  const el = node(`<div class="screen"><div class="safe">
    <div class="eyebrow">Construtor &middot; <span id="edname"></span></div>
    <div class="edwrap">
      <div class="edtop">
        <div class="edmap"><canvas id="edmap"></canvas></div>
        <div class="edside">
          <h4>Pista</h4>
          <div class="edstat" id="edstat"></div>
          <h4>Peça selecionada</h4>
          <div class="edstat" id="edsel"></div>
        </div>
      </div>
      <div class="strip"><div class="stripinner" id="strip"></div></div>
      <div class="msg" id="edmsg"></div>
    </div>
    <div id="edlg"></div>
  </div></div>`);

  const $ = id => el.querySelector(id);

  const message = (text, kind = '') => {
    $('#edmsg').textContent = text;
    $('#edmsg').className = `msg ${kind}`;
  };

  const legend = () => {
    const has = cursor >= 0;
    $('#edlg').innerHTML = `<div class="legend">
      <span><em>↔</em>percorrer</span>
      <span><em>↓</em>opções</span>
      <span class="a"><em>A</em>adicionar</span>
      <span class="y"><em>Y</em>${has ? 'ajustar' : '—'}</span>
      <span class="x"><em>X</em>${has ? 'apagar' : '—'}</span>
      <span class="b"><em>B</em>sair</span>
      <span class="pad" id="padStatus"></span></div>`;
    app.paintPad();
  };

  const stats = () => {
    if (!walk) { $('#edstat').textContent = 'pista vazia'; return; }
    const cps = pieces.filter(p => p.t === 'cp').length;
    $('#edstat').innerHTML = `Comprimento <b>${(walk.length / 1000).toFixed(2).replace('.', ',')} km</b><br>`
      + `Peças <b>${pieces.length}</b> &middot; Checkpoints <b>${cps}</b><br>`
      + `Desnível <b>${Math.round(walk.bounds.y1 - walk.bounds.y0)} m</b>`;
  };

  const selInfo = () => {
    const p = pieces[cursor];
    $('#edsel').innerHTML = p
      ? `<b>${esc(describe(p))}</b><br><span style="color:#6f8299">peça ${cursor + 1} de ${pieces.length}</span>`
      : '<span style="color:#6f8299">cursor no início da pista</span>';
  };

  const buildStrip = () => {
    const strip = $('#strip');
    strip.innerHTML = `<div class="pill end" data-i="-1">◀ início</div>`
      + pieces.map((p, n) =>
        `<div class="pill${p.t === 'cp' ? ' cp' : ''}" data-i="${n}">${esc(describe(p))}</div>`).join('');
  };

  const paintStrip = () => {
    const strip = $('#strip');
    for (const pill of strip.children) pill.classList.toggle('on', +pill.dataset.i === cursor);
    const sel = strip.querySelector('.on');
    if (sel) {
      const view = strip.parentElement.clientWidth;
      strip.style.transform =
        `translateX(${Math.round(Math.min(0, view / 2 - sel.offsetLeft - sel.offsetWidth / 2))}px)`;
    }
  };

  // Full recompute: the geometry, the map, the strip and the readouts all come
  // from the piece list, so anything that changes it comes through here.
  const refresh = () => {
    try { walk = pieces.length ? walkTrack(pieces) : null; }
    catch { walk = null; }
    buildStrip();
    paintStrip();
    stats();
    selInfo();
    legend();
    $('#edname').textContent = name || '(sem nome)';
    drawTrackMap($('#edmap'), walk, { selected: cursor });
  };

  const paint = () => {
    paintStrip(); selInfo(); legend();
    drawTrackMap($('#edmap'), walk, { selected: cursor });
  };

  const doDelete = () => {
    if (cursor < 0) return;
    const gone = describe(pieces[cursor]);
    pieces.splice(cursor, 1);
    cursor = Math.min(cursor, pieces.length - 1);
    dirty = true;
    message(`Apagada: ${gone}`);
    refresh();
  };

  // A copy lands right after the original, settings and all -- a chicane that
  // took a minute to tune is usually wanted twice.
  const doCopy = () => {
    if (cursor < 0) return;
    pieces.splice(cursor + 1, 0, { ...pieces[cursor] });
    cursor += 1;
    dirty = true;
    message(`Duplicada: ${describe(pieces[cursor])}`);
    refresh();
  };

  const swap = d => {
    const to = cursor + d;
    if (cursor < 0 || to < 0 || to >= pieces.length) return;
    [pieces[cursor], pieces[to]] = [pieces[to], pieces[cursor]];
    cursor = to; dirty = true; refresh();
  };

  /* ---------------------------------------------------------- add piece -- */

  const addModal = () => {
    let i = 0;
    const m = node(`<div class="modal"><div class="panel">
      <h2>Adicionar peça</h2>
      <p class="sub">Entra depois da posição atual.</p>
      <div class="grid" id="g">${TYPE_ORDER.map(t =>
        `<div class="gcell">${esc(PIECE_TYPES[t].label)}</div>`).join('')}</div>
      <div class="legend"><span class="a"><em>A</em>adicionar</span>
        <span class="b"><em>B</em>cancelar</span></div>
    </div></div>`);
    const cells = m.querySelectorAll('.gcell');
    const paintG = () => cells.forEach((c, n) => c.classList.toggle('on', n === i));
    paintG();
    const COLS = 4;
    return {
      el: m,
      key(a) {
        if (a === 'left') { i = (i - 1 + cells.length) % cells.length; paintG(); }
        else if (a === 'right') { i = (i + 1) % cells.length; paintG(); }
        else if (a === 'up') { i = Math.max(0, i - COLS); paintG(); }
        else if (a === 'down') { i = Math.min(cells.length - 1, i + COLS); paintG(); }
        else if (a === 'back') app.pop();
        else if (a === 'ok') {
          pieces.splice(cursor + 1, 0, defaults(TYPE_ORDER[i]));
          cursor += 1;
          dirty = true;
          app.pop();
          message(`${PIECE_TYPES[TYPE_ORDER[i]].label} adicionada.`);
          refresh();
        }
      },
    };
  };

  /* ------------------------------------------------------- adjust piece -- */

  const paramsModal = () => {
    const p = pieces[cursor];
    const spec = PIECE_TYPES[p.t];
    const rows = [];
    if (spec.dir) rows.push({ kind: 'dir', label: 'sentido' });
    if (spec.canTunnel) rows.push({ kind: 'tun', label: 'túnel' });
    for (const q of spec.params) rows.push({ kind: 'num', q, label: q.label });

    if (!rows.length) {
      return confirmModal({
        title: spec.label, text: 'Esta peça não tem ajustes.',
        yes: 'Voltar', no: 'Voltar', onYes: () => app.pop(), onNo: () => app.pop(),
      });
    }

    let i = 0;
    const m = node(`<div class="modal"><div class="panel">
      <h2>${esc(spec.label)}</h2>
      <div class="params" id="rows"></div>
      <div class="legend"><span><em>↔</em>alterar</span>
        <span class="a"><em>A</em>pronto</span><span class="b"><em>B</em>pronto</span></div>
    </div></div>`);

    const paintRows = () => {
      m.querySelector('#rows').innerHTML = rows.map((r, n) => {
        const on = n === i ? ' on' : '';
        if (r.kind === 'dir') {
          return `<div class="prow${on}"><span class="pname">sentido</span>
            <span class="ptrack"></span>
            <span class="pval">${p.dir === 'r' ? 'direita' : 'esquerda'}</span>
            <span class="arrows">◀ ▶</span></div>`;
        }
        if (r.kind === 'tun') {
          return `<div class="prow${on}"><span class="pname">túnel</span>
            <span class="ptrack"></span>
            <span class="pval">${p.tun ? 'sim' : 'não'}</span>
            <span class="arrows">◀ ▶</span></div>`;
        }
        const q = r.q;
        const pct = Math.round((p[q.k] - q.min) / (q.max - q.min) * 100);
        return `<div class="prow${on}"><span class="pname">${esc(q.label)}</span>
          <span class="ptrack"><span class="pfill" style="width:${pct}%"></span></span>
          <span class="pval">${p[q.k]}${q.unit}</span>
          <span class="arrows">◀ ▶</span></div>`;
      }).join('');
    };
    paintRows();

    const nudge = d => {
      const r = rows[i];
      if (r.kind === 'dir') p.dir = p.dir === 'r' ? 'l' : 'r';
      else if (r.kind === 'tun') p.tun = !p.tun;
      else {
        const q = r.q;
        p[q.k] = Math.min(q.max, Math.max(q.min, p[q.k] + d * q.step));
      }
      dirty = true;
      paintRows();
      refresh();          // the map updates live, so the shape is visible while adjusting
    };

    return {
      el: m,
      key(a) {
        if (a === 'up') { i = (i - 1 + rows.length) % rows.length; paintRows(); }
        else if (a === 'down') { i = (i + 1) % rows.length; paintRows(); }
        else if (a === 'left') nudge(-1);
        else if (a === 'right') nudge(1);
        else if (a === 'ok' || a === 'back' || a === 'y') app.pop();
      },
    };
  };

  /* --------------------------------------------------------- track menu -- */

  const runTest = () => {
    if (!walk || walk.length < 60) { message('Adiciona mais peças.', 'bad'); return null; }
    const car = app.car;
    message('A testar se é conduzível...');
    const run = testDrive(buildTrack({ pieces }), { phys: car && car.phys });
    if (run.ok) {
      message(`Conduzível com o ${car.name}: ${run.seconds.toFixed(1)} s, `
        + `máxima ${Math.round(run.topSpeed)} km/h.`, 'good');
    } else {
      const spot = run.failures.length ? run.failures[run.failures.length - 1] : null;
      message(spot
        ? `Falha com o ${car.name}: ${spot.reason} aos ${spot.s} m. Suaviza essa zona.`
        : `Não terminei — parou aos ${run.furthest} m.`, 'bad');
    }
    return run;
  };

  // Bringing the end of the track back to its own start, so it can be driven
  // in laps. The join is worked out rather than asked for -- closing a loop by
  // hand, with pieces of fixed radius, is not something anyone should have to
  // do -- and it lands as ordinary pieces the builder can then move or delete
  // like any other.
  const doClose = () => {
    if (!pieces.length) { message('Adiciona peças primeiro.', 'bad'); return; }
    if (walk && walk.closed) { message('Esta pista já é um circuito.', 'good'); return; }
    message('A fechar o circuito...');
    // The search walks the whole track a few hundred times, which on a long
    // one is a visible pause, so let the message paint before it starts.
    setTimeout(() => {
      const before = walk ? walk.length : 0;
      const closed = closeCircuit(pieces);
      if (!closed) {
        message('Não consegui fechar daqui. Tenta tirar ou encurtar a última peça.', 'bad');
        return;
      }
      pieces = closed;
      cursor = pieces.length - 1;
      dirty = true;
      refresh();
      const added = Math.round((walk ? walk.length : 0) - before);
      message(`Circuito fechado: +${added} m e ${DEFAULT_LAPS} voltas por corrida.`, 'good');
    }, 30);
  };

  const askName = (then) => app.push(textEntry({
    title: 'Nome da pista', value: name, max: 24,
    onDone: v => { app.pop(); if (v) { name = v; dirty = true; refresh(); then && then(); }
                   else message('A pista precisa de um nome.', 'bad'); },
    onCancel: () => app.pop(),
  }));

  const doSave = (andPlay) => {
    if (!name) { askName(() => doSave(andPlay)); return; }
    if (!walk || walk.length < 250) { message('A pista é demasiado curta (mínimo 250 m).', 'bad'); return; }
    const run = runTest();
    if (!run || !run.ok) return;      // never save something the car cannot finish
    const def2 = trackDefFrom({ pieces, length: walk.length, name, id: editingId });
    if (!saveCustom(def2)) { message('Não consegui guardar (armazenamento cheio?).', 'bad'); return; }
    editingId = def2.id;
    dirty = false;
    if (andPlay) app.startRace(def2);
    else message(`Guardada. Conduzível em ${run.seconds.toFixed(1)} s.`, 'good');
  };

  const exit = () => {
    if (!dirty) { app.pop(); return; }
    app.push(confirmModal({
      title: 'Sair sem guardar?', text: 'As alterações desta sessão perdem-se.',
      yes: 'Sair', no: 'Continuar a editar',
      onYes: () => { app.pop(); app.pop(); }, onNo: () => app.pop(),
    }));
  };

  // Whether the track being edited is shared, read fresh from storage rather
  // than kept in a variable here: sharing is a property of the saved track,
  // and this screen already treats editingId as the source of truth for
  // everything else about it (see the record check just below).
  const isShared = () => {
    const t = editingId && loadCustom().find(x => x.id === editingId);
    return !!(t && t.shared);
  };

  const menuModal = () => {
    const items = [
      { label: 'Testar com o ' + app.car.name, run: () => { app.pop(); runTest(); } },
      { label: 'Fechar circuito', run: () => { app.pop(); doClose(); } },
      { label: 'Guardar', run: () => { app.pop(); doSave(false); } },
      { label: 'Guardar e jogar', run: () => { app.pop(); doSave(true); } },
      { label: 'Mudar o nome', run: () => { app.pop(); askName(); } },
      { label: 'Limpar tudo', run: () => { app.pop(); app.push(confirmModal({
          title: 'Limpar a pista?', text: 'Ficas com uma pista vazia.',
          yes: 'Limpar', no: 'Cancelar',
          onYes: () => { pieces = []; cursor = -1; dirty = true; app.pop(); message('Pista limpa.'); refresh(); },
          onNo: () => app.pop(),
        })); } },
      { label: 'Sair do construtor', run: () => { app.pop(); exit(); } },
    ];
    // Only once the track has been saved is there anything to share or a
    // record to speak of -- and changing the layout is exactly when the old
    // time stops meaning anything.
    if (editingId) {
      items.splice(4, 0, { label: () => `Partilhar: ${isShared() ? 'sim' : 'não'}`,
        run: () => { setTrackShared(editingId, !isShared()); paintM(); } });
    }
    const best = editingId && getBest(editingId);
    if (best) {
      items.splice(5, 0, { label: 'Limpar o recorde', run: () => { app.pop(); app.push(confirmModal({
        title: 'Limpar o recorde?',
        text: `Apaga o tempo de ${formatTime(best.ms)}, o fantasma dessa volta`
            + ' e a melhor volta guardada de cada carro nesta pista.',
        yes: 'Limpar', no: 'Cancelar',
        onYes: () => { clearRecord(editingId); app.pop(); message('Recorde limpo.'); },
        onNo: () => app.pop(),
      })); } });
    }
    let i = 0;
    const m = node(`<div class="modal"><div class="panel">
      <h2>Pista</h2><div class="menu" id="mi"></div>
      <div class="legend"><span class="a"><em>A</em>escolher</span>
        <span class="b"><em>B</em>fechar</span></div>
    </div></div>`);
    const paintM = () => {
      m.querySelector('#mi').innerHTML = items.map((it, n) =>
        `<div class="item${n === i ? ' on' : ''}">${esc(
          typeof it.label === 'function' ? it.label() : it.label)}</div>`).join('');
    };
    paintM();
    return {
      el: m,
      key(a) {
        if (a === 'up') { i = (i - 1 + items.length) % items.length; paintM(); }
        else if (a === 'down') { i = (i + 1) % items.length; paintM(); }
        else if (a === 'ok') items[i].run();
        else if (a === 'back' || a === 'menu') app.pop();
      },
    };
  };

  // A television remote has no X, Y, shoulder or Start buttons -- only a D-pad,
  // OK and Back. Pressing down opens this, so every action is reachable with
  // the plainest remote in the house; the face buttons stay as shortcuts for
  // whoever is holding a gamepad.
  const pieceMenu = () => {
    const has = cursor >= 0;
    const items = [
      { label: 'Adicionar peça aqui', run: () => { app.pop(); app.push(addModal()); } },
    ];
    if (has) {
      items.push({ label: 'Ajustar esta peça', run: () => { app.pop(); app.push(paramsModal()); } });
      items.push({ label: 'Duplicar esta peça', run: () => { app.pop(); doCopy(); } });
      items.push({ label: 'Apagar esta peça', run: () => { app.pop(); doDelete(); } });
      if (cursor > 0) items.push({ label: 'Mover para trás', run: () => { app.pop(); swap(-1); } });
      if (cursor < pieces.length - 1) items.push({ label: 'Mover para a frente', run: () => { app.pop(); swap(1); } });
    }
    items.push({ label: 'Menu da pista...', run: () => { app.pop(); app.push(menuModal()); } });

    let i = 0;
    const m = node(`<div class="modal"><div class="panel">
      <h2>${esc(has ? describe(pieces[cursor]) : 'Início da pista')}</h2>
      <div class="menu" id="mi"></div>
      <div class="legend"><span class="a"><em>A</em>escolher</span>
        <span class="b"><em>B</em>fechar</span></div>
    </div></div>`);
    const paintM = () => {
      m.querySelector('#mi').innerHTML = items.map((it, n) =>
        `<div class="item${n === i ? ' on' : ''}">${esc(it.label)}</div>`).join('');
    };
    paintM();
    return {
      el: m,
      key(a) {
        if (a === 'up') { i = (i - 1 + items.length) % items.length; paintM(); }
        else if (a === 'down') { i = (i + 1) % items.length; paintM(); }
        else if (a === 'ok') items[i].run();
        else if (a === 'back') app.pop();
      },
    };
  };

  /* -------------------------------------------------------------- screen -- */

  return {
    el,
    mounted: refresh,
    resumed: paint,
    key(a) {
      if (a === 'left') { cursor = Math.max(-1, cursor - 1); paint(); }
      else if (a === 'right') { cursor = Math.min(pieces.length - 1, cursor + 1); paint(); }
      else if (a === 'ok') app.push(addModal());
      else if (a === 'y' && cursor >= 0) app.push(paramsModal());
      else if (a === 'x' && cursor >= 0) doDelete();
      else if ((a === 'l' || a === 'r') && cursor >= 0) swap(a === 'l' ? -1 : 1);
      else if (a === 'down') app.push(pieceMenu());
      else if (a === 'menu') app.push(menuModal());
      else if (a === 'back') exit();
    },
  };
}
