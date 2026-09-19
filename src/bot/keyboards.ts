import type { ReplyMarkup } from '../adapters/telegram';
import type { Strings } from '../render/i18n';
import { STAR_CHOICES } from '../config';
import type { Lang } from '../types';

/**
 * Under a refusal or a stranger's message, for the admin alone: one tap lets them in, in the language their
 * Telegram speaks. `admit:<id>:<lang>` stays far under Telegram's 64 bytes (a user id has at most 16 digits).
 */
export const letInKeyboard = (chatId: number, lang: Lang): ReplyMarkup => ({
  inline_keyboard: [[{ text: '✅ Let in', callback_data: `admit:${chatId}:${lang}` }]],
});

export const persistentKeyboard = (s: Strings): ReplyMarkup => ({
  // "Right now" takes the full-width row: it's by far the most used button.
  keyboard: [[{ text: s.buttons.now }], [{ text: s.buttons.backHome }, { text: s.buttons.useMyLocation, request_location: true }]],
  resize_keyboard: true,
  is_persistent: true,
});

export const profileKeyboard = (s: Strings): ReplyMarkup => ({
  inline_keyboard: [[
    { text: s.profile.changeHours, callback_data: 'prof:hours' },
    { text: s.profile.changeStars, callback_data: 'prof:stars' },
  ]],
});

/** The thresholds on offer, on one line: `3⭐` to `6⭐`. */
export const starsKeyboard = (): ReplyMarkup => ({
  inline_keyboard: [STAR_CHOICES.map((n) => ({ text: `${n}⭐`, callback_data: `stars:${n}` }))],
});

export const langKeyboard = (): ReplyMarkup => ({
  inline_keyboard: [[{ text: 'English', callback_data: 'lang:en' }, { text: 'Русский', callback_data: 'lang:ru' }]],
});
