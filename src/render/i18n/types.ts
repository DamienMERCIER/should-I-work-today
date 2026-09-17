import type { Wetsuit } from '../../engine/water';
import type { TideState, TideTrend, WindState } from '../../types';

export interface Strings {
  locale: string;
  /** N, NE, E, SE, S, SW, W, NW */
  cardinal: readonly [string, string, string, string, string, string, string, string];
  /** goTo: {spot} — the 📍 "go to this spot" map button (`src/render/messages.ts` `goButtons`). */
  buttons: { useMyLocation: string; backHome: string; now: string; allSpots: string; goTo: string };
  /** les six états de vent de surf-forecast, du plus propre au pire */
  windStates: Record<WindState, string>;
  then: string;
  today: string;
  tideStates: Record<TideState, string>;
  tideTrends: Record<TideTrend, string>;
  /** {time} */
  tideNext: { high: string; low: string };
  /** welcome: {home} {start} {end} */
  onboarding: { welcome: string };
  privateBot: string;
  help: string;
  /** summary: {start} {end} {location} · locationCustom: {lat} {lon} */
  profile: {
    summary: string; askHours: string; badHours: string; saved: string;
    locationDefault: string; locationCustom: string;
    changeHours: string;
  };
  lang: { ask: string; set: string };
  stopped: string;
  reactivated: string;
  locationSaved: string;
  backHomeDone: string;
  /** en tete d'un rapport « maintenant » bascule sur demain, faute de jour restant aujourd'hui */
  dayIsDone: string;
  /** titres : {date} ; redBody : {good} {radius} ; redTooShort : {radius} ; redBest : {spot} {stars} {reason} */
  verdict: {
    green: string; greenEpicSuffix: string; greenWeekend: string; greenNow: string;
    dawn: string; dusk: string;
    red: string; redWeekend: string; redNow: string; redBody: string; redTooShort: string; redBest: string;
  };
  /** raison d'un 🔴 quand ce n'est pas le vent (qui se décrit lui-même) : size: {m} */
  reasons: { size: string; dark: string; storm: string };
  /** conditions: {m} {dir} {s} {wind} {tide} · sun: {temp} {sunrise} */
  spotLine: { conditions: string; sun: string };
  /** {mm} */
  rain: string;
  /** la ligne 🌊 du spot mis en avant : {temp} {suit} · suits : la combinaison conseillée (`src/engine/water.ts`) */
  water: string;
  suits: Record<Wetsuit, string>;
  /** confirmed: {verdict} · changed: {from} {to} · cause: {cause} · noDataKeep: {verdict} */
  morning: { confirmed: string; changed: string; cause: string; noDataKeep: string };
  /** les étoiles ne dépendent que du vent et de la houle */
  causes: { wind: string; size: string };
  /** green/dawn/dusk: {spot} {window} */
  shortVerdict: { green: string; dawn: string; dusk: string; red: string };
  /** title: {date}, the "All spots" title — reserved for the future `/all` (`opts.all`) view; the day view's own default title is `dayView.title` · tides: {list} */
  details: { title: string; tides: string; tooOld: string };
  /**
   * The 📋 day-view chart (`renderSpotDay` / `renderDayView`), § day-view.md.
   * title: {date} (the default, non-`all` title — `details.title` "All spots" is used when `opts.all`)
   * peak: {stars} {time} · bestAt/fadesFrom: {time} {reasons} · flatSpots/moreSpots: {n} · sun: {sunrise} {sunset}
   * reasons.windDrops/windBuilds: {kt} · reasons.swellPeaks/swellDrops: {m}
   */
  dayView: {
    title: string;
    peak: string;
    bestAt: string;
    fadesFrom: string;
    flatSpots: string;
    /** /all only, when a dense cluster of open spots exceeds `ALL_SPOTS_CAP` (`src/render/messages.ts`): {n} */
    moreSpots: string;
    sun: string;
    /** les étoiles ne dépendent que du vent et de la houle ; la lumière dit quand ça s'arrête */
    reasons: {
      windDrops: string;
      windBuilds: string;
      swellPeaks: string;
      swellDrops: string;
      getsDark: string;
    };
  };
  /** La semaine à venir (`/week`, envoi du dimanche). best: {day} {spot} {stars} · trend: {day} */
  week: { title: string; best: string; today: string; nothing: string; noData: string; trend: string };
  /** none: {radius} · raw: {swell} {s} {dir} {kt} {windDir} · nearest: {list} · nearestItem: {spot} {km} · farFromCoast: {km} */
  coverage: { none: string; raw: string; nearest: string; nearestItem: string; farFromCoast: string };
  noData: string;
  error: string;
  /** `/all` and `/<spot>` router commands (`src/bot/spotMatch.ts`). ambiguous: {list} · outOfRadius: {spot} {km} {radius} */
  spotCommand: { ambiguous: string; outOfRadius: string };
  /** `/about` : one sentence + licence + spot count. text: {count} */
  about: { text: string };
}
