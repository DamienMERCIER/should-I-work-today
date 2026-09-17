import { windState, type WindState } from '../../src/engine/rating';

/**
 * L'orientation qu'attribue surf-forecast à un spot, retrouvée dans sa propre page : pour chaque créneau,
 * la ligne « Wind » donne la direction et la ligne « Wind State » l'effet (offshore, cross-shore…),
 * calculé par le site depuis cette orientation. On l'inverse avec les mêmes secteurs que les étoiles
 * (`windState`) : aucune requête de plus que la page déjà lue, et des états de vent qui collent au site
 * par construction.
 */
export interface WindSlot { windDir: string; state: WindState }

export interface WindFacing {
  /** milieu de l'arc des orientations qui expliquent le plus de créneaux, en degrés */
  facing: number;
  /** largeur de cet arc, au degré près : la précision de l'orientation (une vingtaine de degrés au mieux, la résolution du compas) */
  widthDeg: number;
  /** créneaux expliqués par ces orientations */
  explained: number;
  /** créneaux utilisables : direction connue du compas, et pas « glassy », qui ne dit rien de l'angle */
  usable: number;
}

export const WIND_FACING = {
  minSlots: 4,
  /** en dessous, les états affichés ne tiennent dans aucune orientation : la page ne tranche pas */
  minExplainedShare: 0.75,
  /** au-delà, les créneaux laissent deux côtés possibles (un seul vent en cross-shore) ou presque tout */
  maxArcDeg: 90,
} as const;

const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** assez de vent pour ne jamais être « glassy » : seul l'angle compte dans l'inversion */
const NOT_GLASSY_KT = 99;

/** L'orientation, ou `null` quand le vent de la page ne permet pas de trancher (§WIND_FACING). */
export function facingFromWind(slots: WindSlot[]): WindFacing | null {
  const usable = slots.flatMap((s) => {
    const i = COMPASS_16.indexOf(s.windDir.toUpperCase());
    return i < 0 || s.state === 'glassy' ? [] : [{ windFromDeg: i * 22.5, state: s.state }];
  });
  if (usable.length < WIND_FACING.minSlots) return null;

  const scores = Array.from({ length: 360 }, (_, facing) =>
    usable.filter((s) => windState(s.windFromDeg, facing, NOT_GLASSY_KT) === s.state).length);
  const explained = Math.max(...scores);
  if (explained < WIND_FACING.minExplainedShare * usable.length) return null;

  // L'arc qui couvre toutes les meilleures orientations est le complément du plus grand écart entre
  // deux d'entre elles, en faisant le tour du cadran : 349°…11° est centré sur 0°, pas sur 180°.
  const best = scores.flatMap((n, facing) => (n === explained ? [facing] : []));
  let largestGap = 0;
  let arcStart = best[0];
  best.forEach((facing, i) => {
    const next = i + 1 < best.length ? best[i + 1] : best[0] + 360;
    if (next - facing > largestGap) {
      largestGap = next - facing;
      arcStart = next % 360;
    }
  });
  const widthDeg = 360 - largestGap;
  // Des ex æquo séparés (315° et 0°, sans rien entre) ne forment pas un arc : leur milieu expliquerait moins de
  // créneaux que chacun d'eux. Un vrai arc contient chaque degré entre ses bords.
  if (best.length !== widthDeg + 1 || widthDeg > WIND_FACING.maxArcDeg) return null;
  return { facing: Math.round(arcStart + widthDeg / 2) % 360, widthDeg, explained, usable: usable.length };
}
