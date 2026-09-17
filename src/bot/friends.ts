import type { TgUser } from '../adapters/telegram';
import { DEFAULT_LOCATION_NAME } from '../config';
import { nearbyByPlace } from '../jobs/collect';
import { esc, fmtTime } from '../render/messages';
import type { Lang, Profile, Spot } from '../types';
import { oneLine } from './text';

const NAME_MAX = 64;
const USERNAME_MAX = 32;
/** Under a Telegram message's 4,096-character limit, with headroom for HTML entities. */
const MESSAGE_MAX = 4000;
const FLAGS: Record<Lang, string> = { en: '🇬🇧', ru: '🇷🇺' };

/** Cut by character, not by UTF-16 unit: an emoji never ends up split in two. */
const cap = (s: string, max: number): string => [...s].slice(0, max).join('');

/** A friend's Telegram name the way their profile keeps it: one line, no control character or bidi, length-capped. */
export function telegramName(from: TgUser | undefined): { name?: string; username?: string } {
  const name = cap(oneLine(`${from?.first_name ?? ''} ${from?.last_name ?? ''}`), NAME_MAX);
  const username = cap(oneLine(from?.username), USERNAME_MAX);
  return { ...(name ? { name } : {}), ...(username ? { username } : {}) };
}

/**
 * `/friends` for the admin: the counts, then one line per friend in arrival order — name (@handle), language, place
 * (Muizenberg, or the spot nearest their location), hours, join date and, if they no longer receive anything,
 * why. Split across several messages when the list exceeds one message's size.
 */
export function renderFriends(profiles: Profile[], spots: Spot[], radiusKm: number): string[] {
  const sorted = [...profiles].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const active = sorted.filter((p) => p.active).length;
  const blocked = sorted.filter((p) => !p.active && p.inactiveReason === 'blocked').length;
  const paused = sorted.length - active - blocked;
  const counts = [`${sorted.length} signed up`, `${active} active`];
  if (paused > 0) counts.push(`${paused} paused`);
  if (blocked > 0) counts.push(`${blocked} blocked the bot`);

  const nearbyAt = nearbyByPlace(spots, radiusKm);
  const place = (p: Profile): string => {
    if (p.location.source === 'default') return DEFAULT_LOCATION_NAME;
    const nearest = nearbyAt(p.location)[0];
    return nearest ? `near ${esc(nearest.spot.short)}` : 'out of range';
  };
  // A handle is unique, a name isn't: without a handle, the id tells apart two friends with the same name.
  const label = (p: Profile): string => {
    if (p.name) return `${esc(p.name)} (${p.username ? `@${esc(p.username)}` : `id ${p.chatId}`})`;
    return p.username ? `@${esc(p.username)}` : `id ${p.chatId}`;
  };
  const status = (p: Profile): string => {
    if (p.active) return '';
    return p.inactiveReason === 'blocked' ? ' · 🚫 blocked the bot' : ' · ⏸️ paused';
  };
  const lines = sorted.map((p, i) => {
    const hours = `${fmtTime(p.workHours.start)}–${fmtTime(p.workHours.end)}`;
    const joined = `${p.createdAt.slice(8, 10)}/${p.createdAt.slice(5, 7)}`;
    return `${i + 1}. ${label(p)} · ${FLAGS[p.lang] ?? p.lang} · ${place(p)} · ${hours} · since ${joined}${status(p)}`;
  });

  const messages: string[] = [];
  let current = `👥 <b>Friends</b> · ${counts.join(' · ')}\n`;
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
