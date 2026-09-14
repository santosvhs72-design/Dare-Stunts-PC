// On-screen keyboard for naming a track.
//
// Text entry is the one thing a controller is genuinely bad at. Android's own
// TV keyboard would appear if we focused a real <input>, but the wrapper
// intercepts D-pad keys before the page sees them, so the system keyboard and
// our navigation would fight over the same presses. Drawing the keyboard
// ourselves keeps one input path and behaves identically in a browser, where
// the rest of this interface is developed and tested.
const ROWS = [
  'ABCDEFGHIJ'.split(''),
  'KLMNOPQRST'.split(''),
  'UVWXYZ0123'.split(''),
  '456789ÇÃÕÉ'.split(''),
  [
    { label: 'Espaço', v: ' ', wide: true },
    { label: '-', v: '-' },
    { label: '.', v: '.' },
    { label: 'Apagar', v: '\b' },
    { label: 'Pronto', v: '\n', wide: true },
  ],
];

const cellOf = c => (typeof c === 'string' ? { label: c, v: c } : c);

export function textEntry({ title = 'Nome', value = '', max = 24, onDone, onCancel }) {
  let text = value.slice(0, max);
  let r = 0, c = 0;

  const el = document.createElement('div');
  el.className = 'modal';
  el.innerHTML = `<div class="panel">
    <h2>${title}</h2>
    <div class="kbval" id="kbval"></div>
    <div class="kb" id="kb"></div>
    <div class="legend">
      <span class="a"><em>A</em>escrever</span>
      <span class="b"><em>B</em>voltar</span>
      <span class="y"><em>Y</em>apagar</span>
      <span><em>&#9776;</em>pronto</span>
    </div>
  </div>`;

  const kb = el.querySelector('#kb');
  ROWS.forEach((row, ri) => {
    const line = document.createElement('div');
    line.className = 'kbrow';
    row.forEach((raw, ci) => {
      const cell = cellOf(raw);
      const b = document.createElement('div');
      b.className = 'key' + (cell.wide ? ' wide' : '');
      b.textContent = cell.label;
      b.dataset.r = ri; b.dataset.c = ci;
      line.appendChild(b);
    });
    kb.appendChild(line);
  });

  const paint = () => {
    el.querySelector('#kbval').innerHTML =
      (text ? text.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])) : '')
      + '<span class="caret">|</span>';
    for (const b of kb.querySelectorAll('.key')) {
      b.classList.toggle('on', +b.dataset.r === r && +b.dataset.c === c);
    }
  };

  const commit = () => {
    const cell = cellOf(ROWS[r][c]);
    if (cell.v === '\n') { onDone(text.trim()); return; }
    if (cell.v === '\b') { text = text.slice(0, -1); paint(); return; }
    if (text.length < max) { text += cell.v; paint(); }
  };

  paint();

  return {
    el,
    key(a) {
      if (a === 'up') { r = (r - 1 + ROWS.length) % ROWS.length; c = Math.min(c, ROWS[r].length - 1); paint(); }
      else if (a === 'down') { r = (r + 1) % ROWS.length; c = Math.min(c, ROWS[r].length - 1); paint(); }
      else if (a === 'left') { c = (c - 1 + ROWS[r].length) % ROWS[r].length; paint(); }
      else if (a === 'right') { c = (c + 1) % ROWS[r].length; paint(); }
      else if (a === 'ok') commit();
      else if (a === 'y') { text = text.slice(0, -1); paint(); }
      else if (a === 'menu') onDone(text.trim());
      else if (a === 'back') onCancel();
    },
  };
}
