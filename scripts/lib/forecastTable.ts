/**
 * La table « hourly » de `/breaks/<slug>/forecasts/latest` sur surf-forecast.com : note, houle, énergie,
 * vent et état du vent, créneau par créneau. Lue par le script de comparaison (`npm run compare:sf`) et
 * par l'import des spots du monde, qui en déduit l'orientation de chaque spot (§windFacing.ts).
 */
import type { WindState } from '../../src/engine/rating';

export interface SfSlot {
  /** 'YYYY-MM-DDTHH:00', heure locale du spot */
  time: string;
  /** null quand le site affiche « ! » (très gros / dangereux) */
  rating: number | null;
  heightM: number;
  dir: string;
  periodS: number;
  energyKJ: number;
  windKmh: number;
  windDir: string;
  state: WindState;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const text = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

interface Cell { text: string; colspan: number }

function rowsOf(html: string): Cell[][] {
  const rows: Cell[][] = [];
  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: Cell[] = [];
    for (const td of tr[1].matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi)) {
      const colspan = Number(/colspan\s*=\s*["']?(\d+)/i.exec(td[2])?.[1] ?? 1);
      cells.push({ text: text(td[3]), colspan });
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

const STATE_MAP: Record<string, WindState> = {
  glassy: 'glassy', off: 'off', 'cross-off': 'cross-off', cross: 'cross', 'cross-on': 'cross-on', on: 'on',
  'off-shore': 'off', 'on-shore': 'on', 'cross-shore': 'cross', 'cross-offshore': 'cross-off', 'cross-onshore': 'cross-on',
};

/** Date d'émission « Issued: 7 am 16 Sep 2026 » → { day, month (0..11), year }. */
function issuedDate(html: string): { day: number; month: number; year: number } | null {
  const m = /Issued:[\s\S]{0,80}?(\d{1,2})\s*(?:am|pm)\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/i.exec(html);
  if (!m) return null;
  const month = MONTHS.indexOf(m[3].toLowerCase());
  return month < 0 ? null : { day: Number(m[2]), month, year: Number(m[4]) };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function parseForecastTable(html: string, fallbackNow = new Date()): SfSlot[] {
  const rows = rowsOf(html);
  const dayRow = rows.find((r) => r.filter((c) => /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+\d{1,2}$/i.test(c.text)).length >= 1);
  const timeRow = rows.find((r) => r.filter((c) => /^\d{1,2}\s*(am|pm)$/i.test(c.text)).length >= 2);
  if (!dayRow || !timeRow) return [];

  // colonnes horaires
  const times = timeRow.filter((c) => /^\d{1,2}\s*(am|pm)$/i.test(c.text)).map((c) => {
    const m = /^(\d{1,2})\s*(am|pm)$/i.exec(c.text)!;
    let h = Number(m[1]) % 12;
    if (m[2].toLowerCase() === 'pm') h += 12;
    return h;
  });

  // colonnes → jour du mois, en déroulant les colspan de la ligne des jours
  const issued = issuedDate(html);
  let month = issued?.month ?? fallbackNow.getMonth();
  let year = issued?.year ?? fallbackNow.getFullYear();
  let prevDay = issued?.day ?? fallbackNow.getDate();
  const dates: string[] = [];
  for (const c of dayRow) {
    const m = /^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+(\d{1,2})$/i.exec(c.text);
    if (!m) continue;
    const day = Number(m[1]);
    if (day < prevDay) {
      month += 1;
      if (month > 11) { month = 0; year += 1; }
    }
    prevDay = day;
    // borné par les colonnes horaires : un colspan de plusieurs millions (page malformée ou piégée) ne se déroule pas
    for (let i = 0; i < c.colspan && dates.length < times.length; i++) dates.push(`${year}-${pad2(month + 1)}-${pad2(day)}`);
  }
  const n = Math.min(times.length, dates.length);
  if (n === 0) return [];

  const lastN = (r: Cell[]): string[] => r.slice(-n).map((c) => c.text);
  const findRow = (test: (label: string) => boolean): string[] | undefined => {
    const r = rows.find((row) => row.length > n && test(row[0].text.toLowerCase()));
    return r ? lastN(r) : undefined;
  };
  const rating = findRow((l) => l.startsWith('rating'));
  const wave = findRow((l) => l.startsWith('wave') && l.includes('height'));
  const energy = findRow((l) => l.includes('kj'));
  const wind = findRow((l) => l.startsWith('wind (') || l.startsWith('wind('));
  const state = findRow((l) => l.startsWith('wind state'));
  if (!rating || !wave || !wind || !state) return [];

  const slots: SfSlot[] = [];
  for (let i = 0; i < n; i++) {
    const w = /^(\d+(?:\.\d+)?)\s+([NESW]{1,3})\s+(\d+)/i.exec(wave[i]);
    const v = /^(\d+)\s+([NESW]{1,3})/i.exec(wind[i]);
    const stateKey = state[i].toLowerCase().replace(/\s+/g, '-');
    // `Object.hasOwn` : « constructor » ou « __proto__ » ne sont pas des états de vent, même s'ils existent sur tout objet
    const st = Object.hasOwn(STATE_MAP, stateKey) ? STATE_MAP[stateKey] : undefined;
    if (!w || !v || !st) continue;
    const r = rating[i].trim();
    slots.push({
      time: `${dates[i]}T${pad2(times[i])}:00`,
      rating: /^\d+$/.test(r) ? Number(r) : null,
      heightM: Number(w[1]), dir: w[2].toUpperCase(), periodS: Number(w[3]),
      energyKJ: energy ? Number(energy[i]) || 0 : 0,
      windKmh: Number(v[1]), windDir: v[2].toUpperCase(), state: st,
    });
  }
  return slots;
}
