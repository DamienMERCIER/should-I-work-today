import type { ReplyMarkup } from '../adapters/telegram';
import type { Strings } from '../render/i18n';

export const persistentKeyboard = (s: Strings): ReplyMarkup => ({
  // « Right now » occupe la rangée pleine largeur : c'est le bouton de loin le plus utilisé.
  keyboard: [[{ text: s.buttons.now }], [{ text: s.buttons.backHome }, { text: s.buttons.useMyLocation, request_location: true }]],
  resize_keyboard: true,
  is_persistent: true,
});

export const profileKeyboard = (s: Strings): ReplyMarkup => ({
  inline_keyboard: [[{ text: s.profile.changeHours, callback_data: 'prof:hours' }]],
});

export const langKeyboard = (): ReplyMarkup => ({
  inline_keyboard: [[{ text: 'English', callback_data: 'lang:en' }, { text: 'Русский', callback_data: 'lang:ru' }]],
});
