import type { Spot } from '../../src/types';

// `facing: 170` est volontairement figé à la valeur d'avant l'audit du 2026-09-16 (production : 150)
// pour que l'arithmétique du scénario golden reste stable. Les deux donnent `onshore` sur le vent
// golden (120°) ; si ce vent change de quadrant, remettre cette copie en phase avec spots.json.
export const MUIZENBERG: Spot = {
  id: 'muizenberg', name: "Muizenberg – Surfer's Corner", short: 'Muizenberg', region: 'cape-peninsula',
  lat: -34.1085, lon: 18.4715, facing: 170, swellWindow: [150, 250], exposure: 0.35,
  tide: { best: [], forbidden: [] },
  levels: { beginner: [1, 3], intermediate: [2, 5], advanced: [3, 6] },
  character: 'mellow', verified: true,
};

export const KOMMETJIE_LONG_BEACH: Spot = {
  id: 'kommetjie-long-beach', name: 'Kommetjie – Long Beach', short: 'Long Beach', region: 'cape-peninsula',
  lat: -34.133, lon: 18.329, facing: 300, swellWindow: [200, 290], exposure: 0.6,
  tide: { best: ['mid', 'high'], forbidden: [] },
  levels: { beginner: [1, 3], intermediate: [2, 5], advanced: [2, 5] },
  character: 'mellow', verified: true,
};

export const OUTER_KOM: Spot = {
  id: 'outer-kom', name: 'Kommetjie – Outer Kom', short: 'Outer Kom', region: 'cape-peninsula',
  lat: -34.142, lon: 18.319, facing: 280, swellWindow: [200, 280], exposure: 1.1,
  tide: { best: ['low', 'mid'], forbidden: [] },
  levels: { advanced: [5, 10] },
  character: 'heavy', verified: true,
};

export const SUN_SEPT = { sunrise: '2026-09-16T06:44', sunset: '2026-09-16T18:38' };
