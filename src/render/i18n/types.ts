import type { Wetsuit } from '../../engine/water';
import type { TideState, TideTrend, WindState } from '../../types';

export interface Strings {
  locale: string;
  /** N, NE, E, SE, S, SW, W, NW */
  cardinal: readonly [string, string, string, string, string, string, string, string];
  /** goTo: {spot} — the "go to this spot" map button, after its 📍, medal, 🌅 or 🌇 (`src/render/messages.ts` `goButtons`). */
  buttons: { useMyLocation: string; backHome: string; now: string; allSpots: string; goTo: string; going: string; notGoing: string };
  /** the six surf-forecast wind states, from cleanest to worst */
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
  /** summary: {start} {end} {location} {stars} · locationCustom: {lat} {lon} */
  profile: {
    summary: string; askHours: string; badHours: string; saved: string;
    locationDefault: string; locationCustom: string;
    changeHours: string;
    /** the button and the question for the star threshold (`STAR_CHOICES`) */
    changeStars: string; askStars: string;
  };
  lang: { ask: string; set: string };
  stopped: string;
  reactivated: string;
  locationSaved: string;
  /** the 📍 button arrived as plain text, with no position (location denied, or cut off for Telegram): {button} */
  locationNeeded: string;
  backHomeDone: string;
  /** heads a "now" report that switches to tomorrow, for lack of any day left today */
  dayIsDone: string;
  /** titles: {date} ; redBody: {good} {radius} ; redTooShort: {radius} ; redBest: {spot} {stars} {reason} ; redRanked: {medal} {spot} {stars} {reason} */
  verdict: {
    green: string; greenEpicSuffix: string; greenWeekend: string; greenNow: string;
    dawn: string; dusk: string;
    red: string; redWeekend: string; redNow: string; redBody: string; redTooShort: string; redBest: string; redRanked: string;
  };
  /** a 🔴's reason when it isn't the wind (which describes itself): size: {m} */
  reasons: { size: string; dark: string; storm: string };
  /** conditions: {m} {dir} {s} {wind} {tide} · sun: {temp} {sunrise} */
  spotLine: { conditions: string; sun: string };
  /** {mm} */
  rain: string;
  /** the 🌡️ line of the featured spot: {temp} {suit} · suits: the recommended wetsuit (`src/engine/water.ts`) */
  water: string;
  suits: Record<Wetsuit, string>;
  /** confirmed: {verdict} · changed: {from} {to} · cause: {cause} · noDataKeep: {verdict} */
  morning: { confirmed: string; changed: string; cause: string; noDataKeep: string };
  /** stars depend only on wind and swell */
  causes: { wind: string; size: string };
  /** green/dawn/dusk: {spot} {window} */
  shortVerdict: { green: string; dawn: string; dusk: string; red: string };
  /** title: {date}, the "All spots" title — reserved for the future `/all` (`opts.all`) view; the day view's own default title is `dayView.title` · tides: {list} */
  details: { title: string; tides: string; tooOld: string };
  /**
   * The 📋 day-view chart (`renderSpotDay` / `renderDayView`), § day-view.md.
   * title: {date} (the default, non-`all` title — `details.title` "All spots" is used when `opts.all`)
   * peak: {stars} {time} · bestAt/fadesFrom: {time} {reasons} · flatSpots/moreSpots: {n} · sun: {sunrise} {sunset}
   * reasons.windDrops/windBuilds: {kt} · reasons.windIs/windTurns: {state} · reasons.swellPeaks/swellDrops: {m}
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
    /** stars depend only on wind and swell; light says when it stops */
    reasons: {
      windDrops: string;
      windBuilds: string;
      /** the peak's wind when it's cleaner than elsewhere in the day: "offshore wind" */
      windIs: string;
      /** the fade hour's wind when it has become less clean: "wind turns onshore" */
      windTurns: string;
      swellPeaks: string;
      swellDrops: string;
      getsDark: string;
    };
  };
  /** 🙋 who's surfing that day. title: {date} · cancelled: {date} ; `buttons.going`: {spot} */
  going: { title: string; you: string; someone: string; cancelled: string };
  /** The midday alert, a big day at D+2 or D+3. title: {date} */
  alert: { title: string; footer: string };
  /** The week ahead (`/week`, the Sunday send). best: {day} {spot} {stars} · trend: {day} */
  week: { title: string; best: string; today: string; nothing: string; noData: string; trend: string };
  /** none: {radius} · raw: {swell} {s} {dir} {kt} {windDir} · nearest: {list} · nearestItem: {spot} {km} · farFromCoast: {km} */
  coverage: { none: string; raw: string; nearest: string; nearestItem: string; farFromCoast: string };
  noData: string;
  error: string;
  /**
   * `/all` and `/<spot>` router commands (`src/bot/spotMatch.ts`). ambiguous: {list} · outOfRadius: {spot} {km} {radius} ·
   * detailsHint — the last line of 📋 and `/all`, above the spot buttons (`spotDayRows`)
   */
  spotCommand: { ambiguous: string; outOfRadius: string; detailsHint: string };
  /** `/about` : one sentence + licence + spot count. text: {count} */
  about: { text: string };
}
