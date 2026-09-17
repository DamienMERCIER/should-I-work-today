import type { Strings } from './types';

export const ru: Strings = {
  locale: 'ru-RU',
  cardinal: ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'],
  buttons: {
    useMyLocation: '📍 Использовать моё местоположение', backHome: '🏠 Вернуться в Muizenberg', now: '🔎 Сейчас', allSpots: '📋 Все споты', goTo: '📍 Маршрут до {spot}',
    going: '🙋 Я еду: {spot}', notGoing: '✖️ Я больше не еду',
  },
  windStates: { glassy: 'штиль', off: 'оффшор', 'cross-off': 'кросс-оффшор', cross: 'кросс', 'cross-on': 'кросс-оншор', on: 'оншор' },
  then: 'затем',
  today: 'сегодня',
  tideStates: { low: 'малая вода', mid: 'половина', high: 'полная вода' },
  tideTrends: { rising: 'прилив', falling: 'отлив' },
  tideNext: { high: 'полная {time}', low: 'малая {time}' },
  onboarding: {
    welcome:
      '🏄 Готово! Каждый вечер в 19:00 я скажу, работать завтра или идти сёрфить.\n' +
      '📍 {home} · работа {start}–{end} — отправь позицию, если переехал.\n' +
      '\n' +
      '<b>Когда я пишу</b>\n' +
      '🌅 6:00 — подтверждаю или поправляю день сёрфа\n' +
      '🔥 12:00 — большой день через 2–3 дня\n' +
      '📅 воскресенье 19:05 — неделя вперёд\n' +
      '\n' +
      '<b>Как читать</b>\n' +
      '⭐ чистая волна · ☆ испорчена оншором\n' +
      '🕐 часы · 🌊 уровень · ⭐ часы с жёлтыми звёздами\n' +
      '🌡️ температура воды и какой гидрик взять\n' +
      '\n' +
      '<b>Кнопки и команды</b>\n' +
      '🙋 Я еду — скажи, где катаешь, и посмотри, кто ещё едет\n' +
      '🔎 /now — остаток дня · /week — неделя вперёд\n' +
      '/all — все споты · /long_beach — день любого спота\n' +
      '/profile — рабочие часы · /lang · /stop\n' +
      '\n' +
      'Данные: Open-Meteo.com (CC-BY 4.0)',
  },
  privateBot: 'Приватный бот — нужна ссылка-приглашение.',
  help:
    'Команды:\n/now — остаток дня\n/week — неделя вперёд, лучший день первым\n/all — все споты\n/about — о боте\n' +
    '/profil — рабочие часы\n/lang — язык\n/stop — больше не писать\n📍 кнопка отправляет твою позицию\n' +
    'У каждого спота есть своя команда — например /long_beach покажет его день\n' +
    '🙋 «Я еду» под прогнозом — посмотри, кто ещё едет\n' +
    '⭐ чистая волна · ☆ испорчена оншором · 🌡️ вода и гидрик',
  profile: {
    summary: 'Профиль\nРабота: {start}–{end}\nПозиция: {location}',
    askHours: 'Напиши рабочие часы, например 9h-18h',
    badHours: 'Не понял. Формат: 9h-18h',
    saved: 'Сохранено.',
    locationDefault: 'Muizenberg (по умолчанию)',
    locationCustom: 'своя позиция ({lat}, {lon})',
    changeHours: 'Часы',
  },
  lang: { ask: 'Language / Язык', set: 'Язык: русский' },
  stopped: 'Ок, больше не пишу. /start — чтобы вернуться.',
  reactivated: 'С возвращением — профиль на месте.',
  locationSaved: 'Позиция сохранена — вечерний прогноз в 19:00 будет для неё.',
  locationNeeded: '📍 Местоположение не пришло. Включи доступ к геолокации для Telegram в настройках телефона и снова нажми «{button}» (или отправь через 📎 → Геопозиция).',
  backHomeDone: 'Позиция: снова Muizenberg.',
  dayIsDone: '🌙 На сегодня всё, света уже нет. Вот завтра:',
  verdict: {
    green: '🟢 <b>ЗАВТРА НЕ ИДИ НА РАБОТУ</b> ({date})',
    greenEpicSuffix: ' — будет эпично',
    greenWeekend: '🟢 <b>ЗАВТРА НА СЁРФ</b> ({date})',
    greenNow: '🟢 <b>ИДИ В ВОДУ</b> (сегодня)',
    dawn: '🌅 <b>ДОУН-ПАТРУЛЬ, ПОТОМ РАБОТА</b> ({date})',
    dusk: '🌇 <b>РАБОТА, ПОТОМ СЁРФ</b> ({date})',
    red: '🔴 <b>ЗАВТРА НА РАБОТУ</b> ({date})',
    redWeekend: '🔴 Завтра пусто ({date})',
    redNow: '🔴 Сегодня пусто',
    redBody: 'Ничего ≥ {good}★ в радиусе {radius} км.',
    redTooShort: 'Хорошее окно в радиусе {radius} км слишком короткое или попадает на работу.',
    redBest: 'Лучшее: {spot} {stars} ({reason})',
  },
  reasons: { size: 'волна {m} м', dark: 'темно', storm: 'гроза' },
  spotLine: { conditions: '{m} м · {dir} {s} с · {wind} · {tide}', sun: '☀️ {temp}° · восход {sunrise}' },
  rain: 'дождь {mm} мм',
  water: '🌡️ вода {temp}° · {suit}',
  suits: {
    lycra: 'лайкра', shorty: 'шорти', full32: 'гидрик 3/2', full43: 'гидрик 4/3',
    full54: 'гидрик 5/4 + боты', full54Cold: 'гидрик 5/4 + боты, перчатки, капюшон',
  },
  morning: {
    confirmed: '✅ Подтверждаю: {verdict}',
    changed: '⚠️ Изменение: {from} → {to}',
    cause: 'причина: {cause}',
    noDataKeep: '⚠️ Утром нет данных — остаётся вчерашний прогноз: {verdict}',
  },
  causes: { wind: 'ветер', size: 'волна' },
  shortVerdict: { green: '🟢 {spot} {window}', dawn: '🌅 доун-патруль {spot} {window}', dusk: '🌇 после работы {spot} {window}', red: '🔴 на работу' },
  details: {
    title: '📋 <b>Все споты</b> ({date})',
    tides: 'вода: {list}',
    tooOld: 'Слишком старое — набери /now.',
  },
  dayView: {
    title: '📋 <b>Твой день</b> ({date})',
    peak: 'пик {stars} в {time}',
    bestAt: 'лучшее в {time} — {reasons}',
    fadesFrom: 'спадает после {time} — {reasons}',
    flatSpots: '{n} спотов на 0★ весь день',
    moreSpots: 'ещё {n} спотов не показано — попробуй /<spot>',
    sun: '🌅 {sunrise} · 🌇 {sunset}',
    reasons: {
      windDrops: 'ветер стихает до {kt} kt',
      windBuilds: 'ветер усиливается до {kt} kt',
      windIs: 'ветер {state}',
      windTurns: 'ветер меняется на {state}',
      swellPeaks: 'пик волны {m} м',
      swellDrops: 'волна спадает до {m} м',
      getsDark: 'темнеет',
    },
  },
  going: { title: '🙋 <b>Кто едет</b> ({date})', you: 'ты', someone: 'друг', cancelled: '👌 Понял, {date} ты не едешь.' },
  alert: {
    title: '🔥 <b>БУДЕТ ЭПИЧНО</b> ({date})',
    footer: 'Планируй заранее — накануне вечером подтвержу.',
  },
  week: {
    title: '📅 <b>НЕДЕЛЯ ВПЕРЕДИ</b>',
    best: '⭐ Лучший день: {day} · {spot} {stars}',
    today: 'Сегодня',
    nothing: 'везде 0★',
    noData: 'нет данных',
    trend: 'С {day} — только тенденция: проверь ещё раз ближе к этому дню.',
  },
  coverage: {
    none: '📍 В радиусе {radius} км нет известных спотов.',
    raw: 'Условия здесь: волна {swell} м {s} с {dir} · ветер {kt} kt {windDir}',
    nearest: 'Ближайшие известные споты: {list}',
    nearestItem: '{spot} ({km} км)',
    farFromCoast: 'Ты далеко от океана — ближайший известный спот дальше {km} км.',
  },
  noData: '⚠️ Нет данных (Open-Meteo недоступен). Попробуй /now позже.',
  error: '⚠️ Ошибка, попробуй ещё раз.',
  spotCommand: {
    ambiguous: 'Несколько совпадений: {list} — уточни запрос.',
    outOfRadius: '{spot} — известный спот, но он в {km} км от тебя — за пределами радиуса {radius} км.',
  },
  about: {
    text: 'Should I Work каждый вечер проверяет {count} известных спотов и подсказывает: завтра сёрфить или работать.\nДанные: Open-Meteo.com (CC-BY 4.0)',
  },
};
