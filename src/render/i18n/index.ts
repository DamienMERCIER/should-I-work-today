import type { Lang } from '../../types';
import { fr } from './fr';
import { ru } from './ru';
import type { Strings } from './types';

export type { Strings };
export const STRINGS: Record<Lang, Strings> = { fr, ru };

/** Remplace chaque `{clé}` ; une clé absente est un bug de template → erreur. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`missing placeholder "${key}" in "${template}"`);
    return String(value);
  });
}

/** `language_code` Telegram → langue du bot (§2, décision 11). */
export function detectLang(languageCode?: string): Lang {
  return languageCode?.toLowerCase().startsWith('ru') ? 'ru' : 'fr';
}
