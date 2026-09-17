import type { TgUser } from '../adapters/telegram';
import { DEFAULT_LOCATION_NAME } from '../config';
import { nearbyByPlace } from '../jobs/collect';
import { esc, fmtTime } from '../render/messages';
import type { Lang, Profile, Spot } from '../types';
import { oneLine } from './text';

const NAME_MAX = 64;
const USERNAME_MAX = 32;
/** Sous les 4 096 caractères d'un message Telegram, avec de la marge pour les entités HTML. */
const MESSAGE_MAX = 4000;
const FLAGS: Record<Lang, string> = { en: '🇬🇧', ru: '🇷🇺' };

/** Coupé par caractère, pas par unité UTF-16 : un emoji ne se retrouve jamais coupé en deux. */
const cap = (s: string, max: number): string => [...s].slice(0, max).join('');

/** Le nom Telegram d'un ami tel que son profil le garde : une ligne, sans caractère de contrôle ni bidi, bornée. */
export function telegramName(from: TgUser | undefined): { name?: string; username?: string } {
  const name = cap(oneLine(`${from?.first_name ?? ''} ${from?.last_name ?? ''}`), NAME_MAX);
  const username = cap(oneLine(from?.username), USERNAME_MAX);
  return { ...(name ? { name } : {}), ...(username ? { username } : {}) };
}

/** En français, 0 et 1 prennent le singulier : « 0 inscrit », « 1 actif », « 2 actifs ». */
const count = (n: number, one: string, many: string): string => `${n} ${n <= 1 ? one : many}`;

/**
 * `/amis` pour l'admin : les chiffres, puis une ligne par ami dans l'ordre d'arrivée — nom (@pseudo), langue, lieu
 * (Muizenberg, ou le spot le plus proche de sa position), horaires, date d'arrivée et, s'il ne reçoit plus rien,
 * pourquoi. Découpé en plusieurs messages quand la liste dépasse la taille d'un message.
 */
export function renderFriends(profiles: Profile[], spots: Spot[], radiusKm: number): string[] {
  const sorted = [...profiles].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const active = sorted.filter((p) => p.active).length;
  const blocked = sorted.filter((p) => !p.active && p.inactiveReason === 'blocked').length;
  const paused = sorted.length - active - blocked;
  const counts = [count(sorted.length, 'inscrit', 'inscrits'), count(active, 'actif', 'actifs')];
  if (paused > 0) counts.push(`${paused} en pause`);
  if (blocked > 0) counts.push(`${blocked} ${blocked === 1 ? 'a' : 'ont'} bloqué le bot`);

  const nearbyAt = nearbyByPlace(spots, radiusKm);
  const place = (p: Profile): string => {
    if (p.location.source === 'default') return DEFAULT_LOCATION_NAME;
    const nearest = nearbyAt(p.location)[0];
    return nearest ? `près de ${esc(nearest.spot.short)}` : 'hors couverture';
  };
  // Un pseudo est unique, un nom non : sans pseudo, l'id départage deux amis qui s'appellent pareil.
  const label = (p: Profile): string => {
    if (p.name) return `${esc(p.name)} (${p.username ? `@${esc(p.username)}` : `id ${p.chatId}`})`;
    return p.username ? `@${esc(p.username)}` : `id ${p.chatId}`;
  };
  const status = (p: Profile): string => {
    if (p.active) return '';
    return p.inactiveReason === 'blocked' ? ' · 🚫 a bloqué le bot' : ' · ⏸️ en pause';
  };
  const lines = sorted.map((p, i) => {
    const hours = `${fmtTime(p.workHours.start)}–${fmtTime(p.workHours.end)}`;
    const joined = `${p.createdAt.slice(8, 10)}/${p.createdAt.slice(5, 7)}`;
    return `${i + 1}. ${label(p)} · ${FLAGS[p.lang] ?? p.lang} · ${place(p)} · ${hours} · depuis le ${joined}${status(p)}`;
  });

  const messages: string[] = [];
  let current = `👥 <b>Amis</b> · ${counts.join(' · ')}\n`;
  for (const line of lines) {
    if (current.length + 1 + line.length > MESSAGE_MAX) {
      messages.push(current);
      current = line;
    } else {
      current = `${current}\n${line}`;
    }
  }
  messages.push(current.trimEnd());
  return messages;
}
