import { fill, STRINGS } from '../render/i18n';
import { esc, fmtDate, spotName, type RenderCtx } from '../render/messages';
import type { GoingEntry, Profile } from '../types';

/**
 * Who's surfing that day, for the friend who just tapped 🙋: one line per spot, in the order each one was first
 * chosen; on each line the friend themselves first ("you"), then the others in the order they tapped, by their
 * Telegram name, their @handle, or "someone" failing that.
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
