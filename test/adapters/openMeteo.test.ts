import { describe, it, expect, vi } from 'vitest';
import {
  marineUrl, forecastUrl, peakPeriodUrl, parseMarine, parseForecast, parsePeakPeriod,
  fetchJsonWithRetry, fetchMarine, fetchForecast, fetchPeakPeriod, OpenMeteoError,
} from '../../src/adapters/openMeteo';
import { fakeFetch, jsonResponse } from '../helpers/fakeFetch';

const REF = { lat: -34.5, lon: 18.2 };
const MUIZ = { lat: -34.1085, lon: 18.4715 };

const peakLoc = {
  hourly: {
    time: ['2026-09-16T06:00', '2026-09-16T07:00', '2026-09-16T08:00'],
    swell_wave_peak_period: [13.1, null, 13.4],
  },
};

const marineLoc = {
  latitude: -34.458336, longitude: 18.208344,
  hourly: {
    time: ['2026-09-16T06:00', '2026-09-16T07:00', '2026-09-16T08:00'],
    swell_wave_height: [0.88, 0.9, null], swell_wave_period: [9.15, 9.2, 9.3], swell_wave_direction: [199, 200, 201],
    secondary_swell_wave_height: [0.82, 0.8, 0.8], secondary_swell_wave_period: [10.3, 10.3, 10.3], secondary_swell_wave_direction: [161, 162, 163],
    wind_wave_height: [1.72, 1.8, 1.9], wave_height: [2.26, 2.3, 2.4], sea_level_height_msl: [0.22, 0.1, -0.05],
  },
};
const forecastLoc = {
  latitude: -34.059753, longitude: 18.449999,
  hourly: {
    time: ['2026-09-16T06:00', '2026-09-16T07:00'],
    wind_speed_10m: [12.1, 12.6], wind_direction_10m: [323, 336], wind_gusts_10m: [30.5, 35.2],
    temperature_2m: [14.0, 14.6], precipitation: [0.0, 0.1], weather_code: [2, 51],
  },
  daily: {
    time: ['2026-09-16', '2026-09-17'], sunrise: ['2026-09-16T06:44', '2026-09-17T06:43'], sunset: ['2026-09-16T18:38', '2026-09-17T18:39'],
    temperature_2m_max: [16.1, 17.0], temperature_2m_min: [13.5, 12.9], precipitation_sum: [4.6, 0.0],
  },
};

describe('urls', () => {
  it('marineUrl lists points, tide variable, timezone and days', () => {
    const u = marineUrl([REF, MUIZ]);
    expect(u.startsWith('https://marine-api.open-meteo.com/v1/marine?')).toBe(true);
    expect(u).toContain('latitude=-34.5000%2C-34.1085');
    expect(u).toContain('longitude=18.2000%2C18.4715');
    expect(u).toContain('sea_level_height_msl');
    expect(u).toContain('timezone=Africa%2FJohannesburg');
    expect(u).toContain('forecast_days=3');
    expect(u).not.toContain('wind_wave_height');
  });
  it('marineUrl asks the sea surface temperature in the same call — no request added', () => {
    expect(marineUrl([REF, MUIZ])).toContain('sea_surface_temperature');
  });
  it('forecastUrl asks knots, the nearest cell and daily sun', () => {
    const u = forecastUrl([MUIZ], 2);
    expect(u.startsWith('https://api.open-meteo.com/v1/forecast?')).toBe(true);
    expect(u).toContain('wind_speed_unit=kn');
    // `nearest` et pas `sea` : une cellule forcée en pleine mer lisait le vent jusqu'à 10 km du
    // spot, et sous-estimait surtout les rafales (45 contre 58 km/h à Kommetjie).
    expect(u).toContain('cell_selection=nearest');
    expect(u).not.toContain('cell_selection=sea');
    // GFS, le modèle dont surf-forecast tire son vent : le 16/09/2026 il tombait à 4-5 km/h du site sur
    // Long Beach et Muizenberg, quand le modèle par défaut sous-estimait de 10 km/h sur les deux.
    expect(u).toContain('models=gfs_seamless');
    expect(u).toContain('daily=sunrise%2Csunset%2Ctemperature_2m_max%2Ctemperature_2m_min%2Cprecipitation_sum');
    expect(u).toContain('forecast_days=2');
  });
  it('peakPeriodUrl asks the gwam model for peak period only, no tide or secondary swell', () => {
    const u = peakPeriodUrl([REF]);
    expect(u.startsWith('https://marine-api.open-meteo.com/v1/marine?')).toBe(true);
    expect(u).toContain('hourly=swell_wave_peak_period');
    expect(u).toContain('models=gwam');
    expect(u).toContain('timezone=Africa%2FJohannesburg');
    expect(u).toContain('forecast_days=3');
    expect(u).not.toContain('sea_level_height_msl');
  });
});

describe('parseMarine', () => {
  it('maps a single-location object, null → 0', () => {
    const [series] = parseMarine(marineLoc);
    expect(series).toHaveLength(3);
    expect(series[0]).toEqual({
      time: '2026-09-16T06:00',
      primary: { heightM: 0.88, periodS: 9.15, directionDeg: 199 },
      secondary: { heightM: 0.82, periodS: 10.3, directionDeg: 161 },
      seaLevelM: 0.22,
    });
    expect(series[2].primary.heightM).toBe(0);
  });
  it('maps a multi-location array', () => {
    expect(parseMarine([marineLoc, marineLoc])).toHaveLength(2);
  });
  it('reads the sea temperature, leaving it unset — never 0 — for a null hour or a missing column', () => {
    const [series] = parseMarine({ ...marineLoc, hourly: { ...marineLoc.hourly, sea_surface_temperature: [13.4, null, 13.6] } });
    expect(series.map((h) => h.seaTempC)).toEqual([13.4, undefined, 13.6]);
    expect('seaTempC' in series[1]).toBe(false);
    expect(parseMarine(marineLoc)[0].some((h) => 'seaTempC' in h)).toBe(false);
  });
  it('ignores a sea temperature no sea can have, like a corrupted 1e308', () => {
    const [series] = parseMarine({ ...marineLoc, hourly: { ...marineLoc.hourly, sea_surface_temperature: [1e308, -40, 36] } });
    expect(series.map((h) => h.seaTempC)).toEqual([undefined, undefined, 36]);
  });
  it('ignores a sea temperature column that does not line up with the hours, and keeps the swell', () => {
    const [series] = parseMarine({ ...marineLoc, hourly: { ...marineLoc.hourly, sea_surface_temperature: [13.4] } });
    expect(series.map((h) => h.seaTempC)).toEqual([undefined, undefined, undefined]);
    expect(series[0].primary.heightM).toBe(0.88);
  });
  it('throws on a malformed payload', () => {
    expect(() => parseMarine({ error: true, reason: 'x' })).toThrow(OpenMeteoError);
  });
  it('throws when a column the engine consumes is missing', () => {
    const { swell_wave_height: _drop, ...hourlyWithoutSwell } = marineLoc.hourly;
    const broken = { ...marineLoc, hourly: hourlyWithoutSwell };
    expect(() => parseMarine(broken)).toThrow(OpenMeteoError);
    expect(() => parseMarine(broken)).toThrow(/missing or short column swell_wave_height/);
  });
  it('throws when a column is shorter than time', () => {
    const broken = { ...marineLoc, hourly: { ...marineLoc.hourly, sea_level_height_msl: [0.22] } };
    expect(() => parseMarine(broken)).toThrow(/missing or short column sea_level_height_msl/);
  });
});

describe('parseForecast', () => {
  it('maps wind in knots and daily sun', () => {
    const [f] = parseForecast(forecastLoc);
    expect(f.wind[1]).toEqual({ time: '2026-09-16T07:00', windKt: 12.6, windDirDeg: 336, gustKt: 35.2, tempC: 14.6, precipMm: 0.1, weatherCode: 51 });
    expect(f.daily[0]).toEqual({ date: '2026-09-16', sunrise: '2026-09-16T06:44', sunset: '2026-09-16T18:38', tempMaxC: 16.1, tempMinC: 13.5, precipMm: 4.6 });
  });
  it('throws instead of fabricating a missing sunrise', () => {
    const { sunrise: _drop, ...dailyWithoutSunrise } = forecastLoc.daily;
    const broken = { ...forecastLoc, daily: dailyWithoutSunrise };
    expect(() => parseForecast(broken)).toThrow(OpenMeteoError);
    expect(() => parseForecast(broken)).toThrow(/sunrise/);
  });
  it('throws when an hourly column the engine consumes is missing', () => {
    const { wind_speed_10m: _drop, ...hourlyWithoutWind } = forecastLoc.hourly;
    const broken = { ...forecastLoc, hourly: hourlyWithoutWind };
    expect(() => parseForecast(broken)).toThrow(/missing or short column wind_speed_10m/);
  });
});

describe('parsePeakPeriod', () => {
  it('maps a single-location object, preserving null (no fabricated 0)', () => {
    const [series] = parsePeakPeriod(peakLoc);
    expect(series).toEqual([
      { time: '2026-09-16T06:00', peakPeriodS: 13.1 },
      { time: '2026-09-16T07:00', peakPeriodS: null },
      { time: '2026-09-16T08:00', peakPeriodS: 13.4 },
    ]);
  });
  it('maps a multi-location array', () => {
    expect(parsePeakPeriod([peakLoc, peakLoc])).toHaveLength(2);
  });
  it('throws on a malformed payload', () => {
    expect(() => parsePeakPeriod({ error: true, reason: 'x' })).toThrow(OpenMeteoError);
  });
  it('throws when the peak-period column is missing', () => {
    const broken = { hourly: { time: peakLoc.hourly.time } };
    expect(() => parsePeakPeriod(broken)).toThrow(OpenMeteoError);
    expect(() => parsePeakPeriod(broken)).toThrow(/missing or short column swell_wave_peak_period/);
  });
  it('throws when the peak-period column is shorter than time', () => {
    const broken = { hourly: { time: peakLoc.hourly.time, swell_wave_peak_period: [13.1] } };
    expect(() => parsePeakPeriod(broken)).toThrow(/missing or short column swell_wave_peak_period/);
  });
});

describe('fetchJsonWithRetry', () => {
  it('retries once after a failure, waiting delayMs', async () => {
    let n = 0;
    const { fn, calls } = fakeFetch(() => (n++ === 0 ? jsonResponse({ nope: 1 }, 500) : jsonResponse({ ok: 1 })));
    const sleep = vi.fn(async () => {});
    await expect(fetchJsonWithRetry('https://x', fn, { sleep })).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });
  it('gives up after retries with the last status', async () => {
    const { fn } = fakeFetch(() => jsonResponse({}, 503));
    await expect(fetchJsonWithRetry('https://x', fn, { sleep: async () => {} })).rejects.toMatchObject({ name: 'OpenMeteoError', status: 503 });
  });
  it('wraps network errors', async () => {
    const { fn } = fakeFetch(() => { throw new Error('ECONNRESET'); });
    await expect(fetchJsonWithRetry('https://x', fn, { retries: 0 })).rejects.toThrow(/ECONNRESET/);
  });
  it('does not retry a non-retryable 4xx (bad parameters)', async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse({}, 400));
    const sleep = vi.fn(async () => {});
    await expect(fetchJsonWithRetry('https://x', fn, { sleep })).rejects.toMatchObject({ name: 'OpenMeteoError', status: 400 });
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('fetchMarine / fetchForecast', () => {
  it('returns one series per point', async () => {
    const { fn } = fakeFetch(() => jsonResponse([marineLoc, marineLoc]));
    await expect(fetchMarine([REF, MUIZ], fn)).resolves.toHaveLength(2);
  });
  it('rejects a location-count mismatch', async () => {
    const { fn } = fakeFetch(() => jsonResponse(marineLoc));
    await expect(fetchMarine([REF, MUIZ], fn)).rejects.toThrow(/expected 2 locations, got 1/);
    const { fn: fn2 } = fakeFetch(() => jsonResponse([forecastLoc, forecastLoc]));
    await expect(fetchForecast([MUIZ], fn2)).rejects.toThrow(/expected 1 locations, got 2/);
  });
  it('fetchPeakPeriod returns one series per point', async () => {
    const { fn } = fakeFetch(() => jsonResponse([peakLoc, peakLoc]));
    await expect(fetchPeakPeriod([REF, MUIZ], fn)).resolves.toHaveLength(2);
  });
  it('fetchPeakPeriod rejects a location-count mismatch', async () => {
    const { fn } = fakeFetch(() => jsonResponse(peakLoc));
    await expect(fetchPeakPeriod([REF, MUIZ], fn)).rejects.toThrow(/expected 2 locations, got 1/);
  });
});
