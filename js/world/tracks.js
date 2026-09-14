// Tracks are plain data so the editor can open, edit and save them, and so
// custom tracks travel through localStorage as JSON.
//
// `sky` names one of the presets in world/scenery.js (SKY_PRESETS) -- each
// built-in track gets its own, for a bit of identity and variety between three
// otherwise similar green circuits. A track without one (every custom track,
// since nothing in the editor asks the builder to choose) just gets the
// default: buildSky() and skyFogColor() both fall back to 'dia' on their own.
const s = len => ({ t: 's', len });
const c = (r, a, dir, bank) => ({ t: 'c', r, a, dir, bank });
const ch = (r, a, dir, bank) => ({ t: 'chicane', r, a, dir, bank });
const hill = (deg, crest = 16) => ({ t: 'hill', deg, crest });
const jump = (deg, gap) => ({ t: 'jump', deg, gap });
const loop = r => ({ t: 'loop', r });
const cork = (len, dir, r = 10) => ({ t: 'cork', len, dir, r });
const tun = p => ({ ...p, tun: true });   // encloses any piece, loops included
const climb = (deg, len) => ({ t: 'climb', deg, len });
const drop = (deg, len) => ({ t: 'drop', deg, len });
const cp = () => ({ t: 'cp' });

export const TRACKS = [
  {
    id: 'costa',
    name: 'Costa Verde',
    difficulty: 1,
    diffLabel: 'Fácil',
    desc: 'Retas longas e curvas muito abertas. Recompensa velocidade máxima — terreno do Speed King.',
    sky: 'dia',
    target: 110,
    pieces: [
      s(330), cp(),
      c(130, 55, 'r', 8), tun(s(150)),
      hill(9),
      s(130), c(120, 80, 'l', 9), cp(),
      s(390), jump(9, 28),
      s(270), c(150, 60, 'r', 8), s(150), cp(),
      loop(20),
      s(210), c(130, 70, 'l', 9), s(170), cp(),
      c(160, 45, 'r', 7), s(390),
      hill(8),
      s(140), c(130, 50, 'l', 8), s(270),
    ],
  },
  {
    id: 'serra',
    name: 'Serra Alta',
    difficulty: 2,
    diffLabel: 'Média',
    desc: 'Retas e curvas médias, um loop em túnel e dois corkscrews. Circuito misto — feito para o Smooth Operator.',
    sky: 'entardecer',
    target: 143,
    pieces: [
      s(150), cp(),
      c(62, 90, 'r', 12), tun(s(70)),
      tun(loop(18)),
      s(60), ch(52, 42, 'l', 10), cp(),
      s(90), hill(12),
      s(120), jump(9, 32),
      s(140), c(58, 110, 'r', 14), cp(),
      s(90), cork(105, 'r'),
      s(80), c(68, 80, 'l', 11), s(60), cp(),
      climb(13, 52), c(66, 95, 'r', 12), s(60), drop(13, 52),
      s(70), jump(9, 30),
      s(130), loop(17), cp(),
      s(80), c(72, 100, 'l', 12), s(70),
      ch(48, 38, 'r', 9), cp(),
      s(80), hill(11),
      s(140), c(60, 105, 'r', 13),
      s(90), cork(110, 'l'),
      s(70), c(78, 70, 'l', 10), s(160),
    ],
  },
  {
    id: 'vertigem',
    name: 'Circuito Vertigem',
    difficulty: 3,
    diffLabel: 'Difícil',
    desc: 'Curvas muito apertadas e chicanes encadeadas, onde a aderência vale mais que a potência. Terreno do Slow Hand.',
    sky: 'crepusculo',
    target: 135,
    pieces: [
      s(60), cp(),
      c(34, 110, 'r', 16), s(22),
      ch(29, 50, 'l', 12),
      tun(s(28)), tun(loop(15)), cp(),
      s(24), c(32, 130, 'l', 16),
      s(22), jump(10, 34),
      s(75), cork(100, 'l'), cp(),
      s(26), hill(11),
      s(70), c(32, 105, 'r', 16), s(22),
      jump(10, 34),
      s(75), ch(28, 55, 'r', 13), cp(),
      climb(15, 48), c(35, 140, 'l', 15), s(22), drop(15, 48),
      s(24), loop(16), cp(),
      tun(cork(100, 'r')),
      s(24), c(30, 100, 'r', 16), cp(),
      s(22), jump(9, 30),
      s(75), ch(32, 48, 'l', 12),
      s(30), hill(10),
      s(80), c(36, 125, 'r', 15), cp(),
      s(30), climb(14, 44), ch(34, 44, 'l', 11), drop(14, 44),
      s(26), loop(17),
      s(30), c(40, 90, 'r', 12), s(70),
    ],
  },
];
