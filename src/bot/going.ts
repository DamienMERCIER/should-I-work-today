import { fill, STRINGS } from '../render/i18n';
import { esc, fmtDate, spotName, type RenderCtx } from '../render/messages';
import type { GoingEntry, Profile } from '../types';

/**
 * Qui va surfer ce jour-là, pour l'ami qui vient d'appuyer sur 🙋 : une ligne par spot, dans l'ordre où chacun a été choisi
 * en premier ; sur chaque ligne l'ami lui-même d'abord (« toi »), puis les autres dans l'ordre de leur appui, par leur nom
 * Telegram, leur @pseudo, ou « un ami » faute de mieux.
 */
export function renderGoing(date: string, entries: GoingEntry[], me: number, profiles: Record<string, Profile>, ctx: RenderCtx): string {
  const s = STRINGS[ctx.lang];
  const bySpot = new Map<string, GoingEntry[]>();
  for (const entry of [...entries].sort((a, b) => a.at.localeCompare(b.at))) {
    bySpot.set(entry.spotId, [...(bySpot.get(entry.spotId) ?? []), entry]);
  }
  const nameOf = (chatId: number): string => {
    if (chatId === me) return s.going.you;
    const p = profiles[String(chatId)];
    if (p?.name) return esc(p.name);
    return p?.username ? `@${esc(p.username)}` : s.going.someone;
  };
  const lines = [...bySpot].map(([spotId, list]) => {
    const names = [...list].sort((a, b) => Number(b.chatId === me) - Number(a.chatId === me)).map((e) => nameOf(e.chatId));
    return `${spotName(spotId, ctx, s)}: ${names.join(', ')}`;
  });
  return [fill(s.going.title, { date: fmtDate(date, ctx.lang) }), ...lines].join('\n');
}
