import type { Board, Level, TideState, TideTrend, WindRelation } from '../../types';

export interface Strings {
  locale: string;
  /** N, NE, E, SE, S, SW, W, NW */
  cardinal: readonly [string, string, string, string, string, string, string, string];
  buttons: { useMyLocation: string; backHome: string; now: string; allSpots: string };
  levels: Record<Level, string>;
  boards: Record<Board, string>;
  relations: Record<WindRelation, string>;
  glassy: string;
  then: string;
  approx: string;
  today: string;
  tideStates: Record<TideState, string>;
  tideTrends: Record<TideTrend, string>;
  /** {time} */
  tideNext: { high: string; low: string };
  /** welcome: {home} {start} {end} */
  onboarding: { askLevel: string; askBoard: string; welcome: string };
  privateBot: string;
  help: string;
  /** summary: {level} {board} {start} {end} {location} · locationCustom: {lat} {lon} */
  profile: {
    summary: string; askHours: string; badHours: string; saved: string;
    locationDefault: string; locationCustom: string;
    changeLevel: string; changeBoard: string; changeHours: string;
  };
  lang: { ask: string; set: string };
  stopped: string;
  reactivated: string;
  locationSaved: string;
  backHomeDone: string;
  /** titres : {date} ; redBody : {radius} ; redBest : {spot} {score} {reason} */
  verdict: {
    green: string; greenEpicSuffix: string; greenWeekend: string; greenNow: string;
    dawn: string; dusk: string;
    red: string; redWeekend: string; redNow: string; redBody: string; redBest: string;
  };
  /** wind: {relation} {dir} {kt} · size: {ft} · period: {s} · tide: {state} */
  reasons: { wind: string; size: string; period: string; tide: string; dark: string };
  /** conditions: {ft} {dir} {s} {wind} {tide} · sun: {temp} {sunrise} */
  spotLine: { conditions: string; sun: string };
  /** {mm} */
  rain: string;
  /** confirmed: {verdict} · changed: {from} {to} · cause: {cause} · noDataKeep: {verdict} */
  morning: { confirmed: string; changed: string; cause: string; noDataKeep: string };
  causes: { wind: string; size: string; period: string; tide: string };
  /** green/dawn/dusk: {spot} {window} */
  shortVerdict: { green: string; dawn: string; dusk: string; red: string };
  /** title: {date} · closed: {spots} · tides: {list} · sun: {temp} {sunrise} {sunset} */
  details: { title: string; closed: string; tides: string; sun: string; license: string; noWindow: string; tooOld: string };
  /** none: {radius} · raw: {swell} {s} {dir} {kt} {windDir} · nearest: {list} · farFromCoast: {km} */
  coverage: { none: string; raw: string; nearest: string; farFromCoast: string };
  noData: string;
  error: string;
}
