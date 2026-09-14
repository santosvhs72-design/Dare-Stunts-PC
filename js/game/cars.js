// Three cars, none better than the others: each trades top speed against grip,
// so the right choice depends on the circuit. Balance is verified by driving
// every car on every track with the editor's autopilot.
import { profileKey } from '../ui/profiles.js';

export const CARS = [
  {
    id: 'veloz',
    name: 'Speed King',
    tagline: 'Mais velocidade, menos aderência',
    best: 'Circuitos com retas longas e curvas abertas',
    bars: { Velocidade: 0.95, Aderência: 0.5, Travagem: 0.55 },
    phys: {
      vmax: 76, accel: 9, brake: 16, mu: 1.28, muCurb: 0.86,
      maxSteer: 0.55, wheelbase: 2.95, coastBase: 2.9, coastDrag: 0.0006, assist: 0.75,
    },
    img: 'img/lebre.png',
    // Paint and proportions only: the cockpit derives every other tone from
    // these, the way a box in the world derives its faces. The colours are the
    // world's own -- kerb red, and a grey warmed towards it.
    theme: {
      dash: '#4a3d39', body: '#9c4a41', rim: '#6b5d57',
      accent: '#c4423b', accent2: '#ffb43a',
      dashScale: 0.93, wheelScale: 1.04,
    },
  },
  {
    id: 'equilibrado',
    name: 'Smooth Operator',
    tagline: 'Equilíbrio entre velocidade e aderência',
    best: 'Circuitos mistos, com retas e algumas curvas lentas',
    bars: { Velocidade: 0.72, Aderência: 0.7, Travagem: 0.7 },
    phys: {
      vmax: 63, accel: 9.6, brake: 18.5, mu: 1.45, muCurb: 0.95,
      maxSteer: 0.6, wheelbase: 2.75, coastBase: 3.2, coastDrag: 0.0011, assist: 0.85,
    },
    img: 'img/corsario.png',
    theme: {
      dash: '#3e444e', body: '#a8843c', rim: '#5b626d',
      accent: '#ffb43a', accent2: '#aac6e2',
      dashScale: 1, wheelScale: 1,
    },
  },
  {
    id: 'aderente',
    name: 'Slow Hand',
    tagline: 'Mais aderência, menos velocidade',
    best: 'Circuitos lentos, com muitas curvas apertadas',
    bars: { Velocidade: 0.5, Aderência: 0.95, Travagem: 0.9 },
    phys: {
      vmax: 48, accel: 10.5, brake: 21, mu: 1.66, muCurb: 1.05,
      maxSteer: 0.66, wheelbase: 2.55, coastBase: 3.6, coastDrag: 0.0021, assist: 0.95,
    },
    img: 'img/tenaz.png',
    theme: {
      dash: '#38443e', body: '#4f8a68', rim: '#55655c',
      accent: '#4fbf7a', accent2: '#aac6e2',
      dashScale: 1.08, wheelScale: 1.12,
    },
  },
];

export const carById = id => CARS.find(c => c.id === id) || CARS[1];

// Which car was last chosen belongs to whoever chose it -- profileKey() reads
// the *current* profile each time, so switching profile and calling this again
// reads the new one's choice, not a value cached from before the switch.
export function loadCar() {
  try { return carById(localStorage.getItem(profileKey('car'))); } catch { return CARS[1]; }
}

export function saveCar(id) {
  try { localStorage.setItem(profileKey('car'), id); } catch { /* private mode */ }
}
