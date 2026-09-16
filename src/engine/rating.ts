import { angularDistance } from './geo';

/**
 * Note « façon surf-forecast » : étoiles 0..10 + couleur (or = propre, blanc = abîmé par l'onshore).
 *
 * Reconstruit le 16/09/2026 à partir de 78 lignes lues sur surf-forecast.com (Muizenberg, Long Beach,
 * Cape Town wavefinder, Papatowai NZ, Cathedral Rock AU) : note, hauteur, période, énergie, vent,
 * état du vent. Sur ces 78 lignes le modèle ci-dessous tombe juste 71 % du temps et à ±1 étoile 97 %
 * du temps (les tables du site arrondissent la hauteur au 0,1 m / 0,5 m et le vent aux 5 km/h, d'où
 * le bruit résiduel). Ce que les données disent, dans l'ordre d'importance :
 *
 *  1. La note de base ne dépend (presque) que de la HAUTEUR de houle dirigée vers le spot, en gros
 *     « une demi-étoile par pied » : 0,7 m → 2, 1,5 m → 3, 2,3 m → 4, 3 m → 5, 3,5 m → 6, 4 m → 7-8,
 *     5 m → 9. La période ne bouge la note qu'à la marge (±1 sur 10 s vs 18 s), contrairement à ce
 *     que laisse entendre la FAQ du site. L'énergie affichée vaut ≈ 2·H²·T² kJ.
 *  2. Le vent est un MULTIPLICATEUR brutal et asymétrique, en six états (glassy, off, cross-off,
 *     cross, cross-on, on) découpés en secteurs de 45° autour de la direction offshore :
 *     onshore et cross-onshore tombent à 0 dès 20 km/h (11 kt) ; cross-off tient jusqu'à 25 km/h
 *     puis s'effondre (35 km/h → ×0,4, 45 km/h → ×0,07) ; offshore ne coûte rien jusqu'à 30 km/h.
 *  3. La couleur : or quand le vent n'a pas de composante onshore (glassy, off, cross-off), blanc
 *     sinon (App Store : « gold = clean waves, white = onshore »).
 *
 * C'est la note du bot : `score.ts` l'applique à chaque heure de chaque spot, et ne garde du reste
 * (lumière, orage) que ce qui décide si une heure peut compter pour une session.
 */

export type WindState = 'glassy' | 'off' | 'cross-off' | 'cross' | 'cross-on' | 'on';

type Curve = ReadonlyArray<readonly [kmh: number, factor: number]>;

export const RATING = {
  /** En dessous, le site affiche « glassy » quel que soit l'angle (le vent est arrondi aux 5 km/h). */
  glassyMaxKmh: 5,
  /** Demi-largeur du secteur « off » / « on » ; les états intermédiaires prennent 45° chacun. */
  sectorHalfWidthDeg: 22.5,
  /**
   * Note de base = 1,81 + 0,37·H + 0,23·H² (H en m, houle dirigée vers le spot), bornée à 10.
   * Ajustement quadratique sur 44 lignes à vent propre (rmse 0,53). L'alternative linéaire
   * « 0,5 étoile par pied + 0,4 » fait aussi bien jusqu'à 3,5 m mais sous-estime 4 m et plus.
   */
  base: { c0: 1.81, c1: 0.37, c2: 0.23 },
  /** Hauteur (m) en dessous de laquelle c'est plat : 0 étoile quoi qu'il arrive. */
  flatBelowM: 0.3,
  /** Facteur vent par état, en km/h (unité des tables du site ; l'appelant passe des nœuds). */
  wind: {
    glassy: [[0, 1]] as Curve,
    off: [[30, 1], [35, 0.75], [45, 0.4], [55, 0]] as Curve,
    'cross-off': [[15, 1], [25, 0.9], [35, 0.4], [40, 0.2], [45, 0.07], [50, 0]] as Curve,
    cross: [[5, 1], [10, 0.83], [15, 0.65], [20, 0.4], [25, 0.15], [30, 0]] as Curve,
    'cross-on': [[3, 1], [5, 0.75], [10, 0.6], [15, 0.3], [20, 0]] as Curve,
    on: [[3, 1], [5, 0.7], [10, 0.45], [15, 0.1], [18, 0]] as Curve,
  },
  /** États sans composante onshore : étoiles « or ». */
  cleanStates: ['glassy', 'off', 'cross-off'] as readonly WindState[],
  /** kJ ≈ k·H²·T² ; k ajusté sur les tables (0,9..1,0 une fois les arrondis pris en compte). */
  energyK: 2,
} as const;

export const KT_TO_KMH = 1.852;

/** Linéaire par morceaux : valeur du premier point avant lui, du dernier après lui. */
function piecewise(curve: Curve, x: number): number {
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const [x0, y0] = curve[i - 1];
    const [x1, y1] = curve[i];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return last[1];
}

/**
 * État du vent façon surf-forecast : angle entre la direction D'OÙ vient le vent et la direction
 * offshore (facing + 180), en secteurs de 45° : off ≤ 22,5°, cross-off ≤ 67,5°, cross ≤ 112,5°,
 * cross-on ≤ 157,5°, on au-delà. Un vent sous `glassyMaxKmh` est « glassy » quel que soit l'angle.
 */
export function windState(windFromDeg: number, facingDeg: number, windKt: number): WindState {
  if (windKt * KT_TO_KMH < RATING.glassyMaxKmh) return 'glassy';
  const angle = angularDistance(windFromDeg, facingDeg + 180);
  const half = RATING.sectorHalfWidthDeg;
  if (angle <= half) return 'off';
  if (angle <= half + 45) return 'cross-off';
  if (angle <= half + 90) return 'cross';
  if (angle <= half + 135) return 'cross-on';
  return 'on';
}

/** Note de base continue 0..10, avant vent. `heightM` = houle dirigée vers le spot, près du bord. */
export function starBase(heightM: number): number {
  if (heightM < RATING.flatBelowM) return 0;
  const { c0, c1, c2 } = RATING.base;
  return Math.min(10, c0 + c1 * heightM + c2 * heightM * heightM);
}

/**
 * Étoiles avant arrondi : ce que valent une note de base et un facteur vent ensemble. Arrondi, c'est
 * la note affichée ; brut, c'est l'unité commune qui permet de peser ce que coûte le vent ou la houle
 * — explications 📋, raison d'un 🔴, cause d'un changement le matin — sans comparer deux facteurs qui
 * ne sont pas sur la même échelle.
 */
export function rawStars(base: number, windFactor: number): number {
  return base < 0.5 ? 0 : base * windFactor;
}

export function windStarFactor(state: WindState, windKt: number): number {
  return piecewise(RATING.wind[state], windKt * KT_TO_KMH);
}

/** Énergie « kJ » telle que le site l'affiche : ≈ 2·H²·T². Sert à parler la même langue que lui. */
export function energyKJ(heightM: number, periodS: number): number {
  return Math.round(RATING.energyK * heightM * heightM * periodS * periodS);
}

export interface StarInput {
  /** houle dirigée vers le spot, en mètres (près du bord, PAS la hauteur de face en pieds) */
  heightM: number;
  periodS: number;
  windKt: number;
  windFromDeg: number;
  facingDeg: number;
}

export interface StarRating {
  /** 0..10 entier, comparable à la colonne « Rating (10 max) » du site */
  stars: number;
  /** true = étoiles or (glassy, offshore, cross-offshore) ; false = blanches (le vent a une composante onshore) */
  clean: boolean;
  state: WindState;
  /** note de base avant vent, continue, pour le debug et la calibration */
  base: number;
  windFactor: number;
  energyKJ: number;
}

export function rateLikeSurfForecast(input: StarInput): StarRating {
  const state = windState(input.windFromDeg, input.facingDeg, input.windKt);
  const base = starBase(input.heightM);
  const windFactor = windStarFactor(state, input.windKt);
  const stars = Math.round(rawStars(base, windFactor));
  return {
    stars, base, windFactor, state,
    clean: RATING.cleanStates.includes(state),
    energyKJ: energyKJ(input.heightM, input.periodS),
  };
}

/**
 * Rendu texte pour Telegram, où l'on n'a pas de couleur : ★ pleines = or (propre), ☆ creuses = blanc
 * (onshore). `★★★★☆☆` n'existe pas : c'est tout l'un ou tout l'autre, comme sur le site.
 */
export function starGlyphs(rating: Pick<StarRating, 'stars' | 'clean'>): string {
  if (rating.stars === 0) return '·';
  return (rating.clean ? '★' : '☆').repeat(rating.stars);
}
