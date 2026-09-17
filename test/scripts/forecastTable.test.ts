import { describe, it, expect } from 'vitest';
import { parseForecastTable } from '../../scripts/lib/forecastTable';

// L'import lit ~8 000 pages tierces sans surveillance : une page malformée ou piégée ne doit ni faire
// exploser la mémoire ni glisser autre chose qu'un état de vent connu.
const table = (dayCell: string, states: string[]): string => `
<p>Issued: <b>1 am 16 Sep 2026</b></p><table>
<tr><th></th>${dayCell}</tr>
<tr><th></th>${states.map((_, i) => `<th>${i * 3 + 2} AM</th>`).join('')}</tr>
<tr><td>Rating</td>${states.map(() => '<td>2</td>').join('')}</tr>
<tr><td>Wave Height (m)</td>${states.map(() => '<td>1.5<br>SW<br>12</td>').join('')}</tr>
<tr><td>Wind (km/h)</td>${states.map(() => '<td>20<br>SE</td>').join('')}</tr>
<tr><td>Wind State</td>${states.map((s) => `<td>${s}</td>`).join('')}</tr>
</table>`;

describe('parseForecastTable on hostile pages', () => {
  it('a day spanning millions of columns is not unrolled beyond the columns the table has', () => {
    const html = table('<th colspan="5000000">Wednesday<br>16</th>', ['on', 'off']);
    const t0 = performance.now();
    const slots = parseForecastTable(html);
    const elapsedMs = performance.now() - t0;
    expect(slots.map((s) => s.time)).toEqual(['2026-09-16T02:00', '2026-09-16T05:00']);
    expect(elapsedMs).toBeLessThan(100); // unrolled, 5 million columns take ~0.5 s and ~230 MB
  });

  it('a wind state cell named after an Object property (constructor, __proto__…) is not a wind state', () => {
    const html = table('<th colspan="3">Wednesday<br>16</th>', ['on', 'constructor', '__proto__']);
    expect(parseForecastTable(html).map((s) => s.state)).toEqual(['on']);
  });
});
