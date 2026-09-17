import type { WindSlot } from '../../scripts/lib/windFacing';

const HOURS = ['2 AM', '5 AM', '8 AM', '11 AM', '2 PM', '5 PM', '8 PM', '11 PM'];

/**
 * Une table « hourly » de surf-forecast réduite à ce que `parseForecastTable` lit — un créneau par vent
 * donné, huit par jour — pour les tests de l'import, qui en tirent l'orientation (§windFacing.ts).
 */
export function forecastTableHtml(winds: WindSlot[]): string {
  const n = winds.length;
  const days = Array.from({ length: Math.ceil(n / 8) }, (_, d) => `<th colspan="${Math.min(8, n - d * 8)}">Wednesday<br>${16 + d}</th>`).join('');
  const row = (label: string, values: string[]): string => `<tr><td>${label}</td>${values.map((v) => `<td>${v}</td>`).join('')}</tr>`;
  return [
    '<p>Issued: <b>1 am 16 Sep 2026</b></p><table>',
    `<tr><th></th>${days}</tr>`,
    `<tr><th></th>${winds.map((_, i) => `<th>${HOURS[i % 8]}</th>`).join('')}</tr>`,
    row('Rating', winds.map(() => '2')),
    row('Wave Height (m)', winds.map(() => '1.5<br>SW<br>12')),
    row('Wind (km/h)', winds.map((w) => `20<br>${w.windDir}`)),
    row('Wind State', winds.map((w) => w.state)),
    '</table>',
  ].join('\n');
}

/** Une semaine de sud-est à Muizenberg, onshore : 113°–134° l'expliquent, orientation 124° (§windFacing.test.ts). */
export const MUIZENBERG_WINDS: WindSlot[] = [
  ...Array.from({ length: 1 }, (): WindSlot => ({ windDir: 'SSE', state: 'on' })),
  ...Array.from({ length: 12 }, (): WindSlot => ({ windDir: 'SE', state: 'on' })),
  ...Array.from({ length: 6 }, (): WindSlot => ({ windDir: 'ESE', state: 'on' })),
];
