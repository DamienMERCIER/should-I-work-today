import type { Lang } from '../../types';
import { en } from './en';
import { ru } from './ru';
import type { Strings } from './types';

export type { Strings };
export const STRINGS: Record<Lang, Strings> = { en, ru };

/** Replaces every `{key}`; a missing key is a template bug → error. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`missing placeholder "${key}" in "${template}"`);
    return String(value);
  });
}

/** Telegram's `language_code` → the bot's language (§2, decision 11). */
export function detectLang(languageCode?: string): Lang {
  return languageCode?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}
