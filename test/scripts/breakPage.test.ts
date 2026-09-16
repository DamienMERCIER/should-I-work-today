import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBreakPage, breakUrl } from '../../scripts/lib/breakPage';

const FIXTURE = readFileSync(join(__dirname, '../fixtures/surf-forecast-break.html'), 'utf8');

describe('parseBreakPage', () => {
  it('parses the saved fixture into name, lat, lon, type', () => {
    expect(parseBreakPage(FIXTURE)).toEqual({ name: 'Muizenberg', lat: -34.1026, lon: 18.4737, type: 'Beach' });
  });

  it('returns null, not a crash, for a page with no coordinate blob', () => {
    expect(parseBreakPage('<html><body>404 not found</body></html>')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseBreakPage('')).toBeNull();
  });

  it('returns null when the currentLocation blob is present but truncated mid-object', () => {
    const truncated = '..."maps":[{"currentLocation":{"name":"Broken","filename":"Broken","lat":-1.234,"lng"';
    expect(parseBreakPage(truncated)).toBeNull();
  });

  it('returns null when required fields are missing from the blob', () => {
    const noType = '"currentLocation":{"name":"NoType","filename":"NoType","lat":-1.5,"lng":2.5}';
    expect(parseBreakPage(noType)).toBeNull();
  });

  it('returns null when lat/lng are not finite numbers', () => {
    const badNum = '"currentLocation":{"name":"Bad","filename":"Bad","lat":"oops","lng":2.5,"type":"Beach"}';
    expect(parseBreakPage(badNum)).toBeNull();
  });
});

describe('breakUrl', () => {
  it('builds the forecasts/latest URL for a slug, the only /breaks/* path robots.txt allows for this bot', () => {
    expect(breakUrl('Muizenberg')).toBe('https://www.surf-forecast.com/breaks/Muizenberg/forecasts/latest');
  });
});
