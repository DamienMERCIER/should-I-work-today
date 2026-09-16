import type { ReplyMarkup } from '../adapters/telegram';
import type { Strings } from '../render/i18n';

export const persistentKeyboard = (s: Strings): ReplyMarkup => ({
  keyboard: [[{ text: s.buttons.useMyLocation, request_location: true }], [{ text: s.buttons.backHome }, { text: s.buttons.now }]],
  resize_keyboard: true,
  is_persistent: true,
});

export const levelKeyboard = (s: Strings): ReplyMarkup => ({
  inline_keyboard: [[
    { text: s.levels.beginner, callback_data: 'lvl:beginner' },
    { text: s.levels.intermediate, callback_data: 'lvl:intermediate' },
    { text: s.levels.advanced, callback_data: 'lvl:advanced' },
  ]],
});

export const boardKeyboard = (s: Strings): ReplyMarkup => ({
  inline_keyboard: [[
    { text: s.boards.longboard, callback_data: 'board:longboard' },
    { text: s.boards.shortboard, callback_data: 'board:shortboard' },
    { text: s.boards.both, callback_data: 'board:both' },
  ]],
});

export const profileKeyboard = (s: Strings): ReplyMarkup => ({
  inline_keyboard: [[
    { text: s.profile.changeLevel, callback_data: 'prof:level' },
    { text: s.profile.changeBoard, callback_data: 'prof:board' },
    { text: s.profile.changeHours, callback_data: 'prof:hours' },
  ]],
});

export const langKeyboard = (): ReplyMarkup => ({
  inline_keyboard: [[{ text: 'English', callback_data: 'lang:en' }, { text: 'Русский', callback_data: 'lang:ru' }]],
});
