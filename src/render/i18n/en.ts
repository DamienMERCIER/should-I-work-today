import type { Strings } from './types';

export const en: Strings = {
  locale: 'en-GB',
  cardinal: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
  buttons: {
    useMyLocation: '📍 Use my location', backHome: '🏠 Back to Muizenberg', now: '🔎 Right now', allSpots: '📋 All spots', goTo: '📍 Go to {spot}',
    going: "🙋 I'm going: {spot}", notGoing: "✖️ I'm not going any more",
  },
  windStates: { glassy: 'glassy', off: 'offshore', 'cross-off': 'cross-offshore', cross: 'cross-shore', 'cross-on': 'cross-onshore', on: 'onshore' },
  then: 'then',
  today: 'today',
  tideStates: { low: 'low', mid: 'mid', high: 'high' },
  tideTrends: { rising: 'incoming tide', falling: 'outgoing tide' },
  tideNext: { high: 'high {time}', low: 'low {time}' },
  onboarding: {
    welcome:
      '🏄 All set! Every evening at 19:00 I tell you whether to work tomorrow or go surf.\n' +
      '📍 {home} · work {start}–{end} — send your location if you move.\n' +
      '\n' +
      '<b>When I write</b>\n' +
      '🌅 6:00 — I confirm or update a surf day\n' +
      '🔥 12:00 — a big day coming in 2–3 days\n' +
      '📅 Sunday 19:05 — the week ahead\n' +
      '\n' +
      '<b>How to read it</b>\n' +
      '⭐ clean waves · ☆ spoilt by onshore wind\n' +
      '🕐 hours · 🌊 level · ⭐ hours with yellow stars\n' +
      '🌡️ water temperature and the wetsuit to take\n' +
      '\n' +
      '<b>Buttons and commands</b>\n' +
      "🙋 I'm going — say where you surf, see who else goes\n" +
      '🔎 /now — the rest of today · /week — the week ahead\n' +
      "/all — every spot · /long_beach — any spot's day\n" +
      '/profile — work hours · /lang · /stop\n' +
      '\n' +
      'Data: Open-Meteo.com (CC-BY 4.0)',
  },
  privateBot: 'Private bot — you need the invite link.',
  help:
    'Commands:\n/now — the rest of the day\n/week — the week ahead, best day first\n/all — every spot\n/about — about this bot\n' +
    '/profile — work hours\n/lang — language\n/stop — no more messages\n📍 the button sends your location\n' +
    'Each spot has its own command too — e.g. /long_beach shows its day\n' +
    "🙋 I'm going, under a forecast — see who else goes\n" +
    '⭐ clean waves · ☆ spoilt by onshore wind · 🌡️ water and wetsuit',
  profile: {
    summary: 'Profile\nWork: {start}–{end}\nLocation: {location}',
    askHours: 'Send your work hours, e.g. 9-18',
    badHours: "I didn't get that. Format: 9-18",
    saved: 'Saved.',
    locationDefault: 'Muizenberg (default)',
    locationCustom: 'custom location ({lat}, {lon})',
    changeHours: 'Hours',
  },
  lang: { ask: 'Language / Язык', set: 'Language: English' },
  stopped: 'OK, no more messages. /start to come back.',
  reactivated: 'Good to see you again — your profile is still here.',
  locationSaved: 'Location saved — the 19:00 verdict will use it.',
  locationNeeded: "📍 Your location didn't come through. Turn on location access for Telegram in your phone settings, then tap “{button}” again (or send it via 📎 → Location).",
  backHomeDone: 'Location: back to Muizenberg.',
  dayIsDone: '🌙 Today is done, the light has gone. Here is tomorrow:',
  verdict: {
    green: "🟢 <b>DON'T GO TO WORK TOMORROW</b> ({date})",
    greenEpicSuffix: " — it's firing",
    greenWeekend: '🟢 <b>GO SURF TOMORROW</b> ({date})',
    greenNow: '🟢 <b>GO SURF</b> (today)',
    dawn: '🌅 <b>DAWN PATROL, THEN WORK</b> ({date})',
    dusk: '🌇 <b>WORK, THEN GO SURF</b> ({date})',
    red: '🔴 <b>GO TO WORK TOMORROW</b> ({date})',
    redWeekend: '🔴 Nothing tomorrow ({date})',
    redNow: '🔴 Nothing today',
    redBody: 'Nothing ≥ {good}★ within {radius} km.',
    redTooShort: 'The good window within {radius} km is too short or clashes with work.',
    redBest: 'Best: {spot} {stars} ({reason})',
  },
  reasons: { size: 'swell {m} m', dark: 'dark', storm: 'thunderstorm' },
  spotLine: { conditions: '{m} m · {dir} {s} s · {wind} · {tide}', sun: '☀️ {temp}° · sunrise {sunrise}' },
  rain: 'rain {mm} mm',
  water: '🌡️ water {temp}° · {suit}',
  suits: {
    lycra: 'lycra', shorty: 'shorty', full32: '3/2 wetsuit', full43: '4/3 wetsuit',
    full54: '5/4 wetsuit + booties', full54Cold: '5/4 wetsuit + booties, gloves, hood',
  },
  morning: {
    confirmed: '✅ Confirmed: {verdict}',
    changed: '⚠️ Change: {from} → {to}',
    cause: 'cause: {cause}',
    noDataKeep: "⚠️ No data this morning — last night's verdict stands: {verdict}",
  },
  causes: { wind: 'wind', size: 'swell' },
  shortVerdict: { green: '🟢 {spot} {window}', dawn: '🌅 dawn patrol {spot} {window}', dusk: '🌇 after work {spot} {window}', red: '🔴 go to work' },
  details: {
    title: '📋 <b>All spots</b> ({date})',
    tides: 'tide: {list}',
    tooOld: 'Too old — run /now.',
  },
  dayView: {
    title: '📋 <b>Your day</b> ({date})',
    peak: 'peak {stars} at {time}',
    bestAt: 'best at {time} — {reasons}',
    fadesFrom: 'fades from {time} — {reasons}',
    flatSpots: '{n} spots at 0★ all day',
    moreSpots: '+{n} more spots not shown — try /<spot>',
    sun: '🌅 {sunrise} · 🌇 {sunset}',
    reasons: {
      windDrops: 'wind drops to {kt} kt',
      windBuilds: 'wind builds to {kt} kt',
      windIs: '{state} wind',
      windTurns: 'wind turns {state}',
      swellPeaks: 'swell peaks at {m} m',
      swellDrops: 'swell drops to {m} m',
      getsDark: 'gets dark',
    },
  },
  going: { title: "🙋 <b>Who's going</b> ({date})", you: 'you', someone: 'a friend', cancelled: "👌 Noted, you're not going on {date}." },
  alert: {
    title: '🔥 <b>BIG DAY AHEAD</b> ({date})',
    footer: "Plan ahead — I'll confirm the evening before.",
  },
  week: {
    title: '📅 <b>THE WEEK AHEAD</b>',
    best: '⭐ Best: {day} · {spot} {stars}',
    today: 'Today',
    nothing: '0★ everywhere',
    noData: 'no data',
    trend: 'From {day} on, a trend only: check again closer to the day.',
  },
  coverage: {
    none: '📍 No known spot within {radius} km.',
    raw: 'Raw conditions here: swell {swell} m {s} s {dir} · wind {kt} kt {windDir}',
    nearest: 'Nearest known spots: {list}',
    nearestItem: '{spot} ({km} km)',
    farFromCoast: 'You are far from the ocean — the nearest known spot is more than {km} km away.',
  },
  noData: '⚠️ No data (Open-Meteo unreachable). Try /now later.',
  error: '⚠️ Error, try again.',
  spotCommand: {
    ambiguous: 'Multiple matches: {list} — be more specific.',
    outOfRadius: '{spot} is a known spot, but it is {km} km away — outside your {radius} km radius.',
  },
  about: {
    text: 'Should I Work checks {count} known surf spots every evening and tells you whether to work tomorrow or go surf.\nData: Open-Meteo.com (CC-BY 4.0)',
  },
};
