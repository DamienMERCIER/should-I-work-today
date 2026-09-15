import type { DailySun, SwellHour, WindHour } from '../../src/types';
import { jsonResponse } from './fakeFetch';

export function marineJson(series: SwellHour[]) {
  return {
    hourly: {
      time: series.map((h) => h.time),
      swell_wave_height: series.map((h) => h.primary.heightM),
      swell_wave_period: series.map((h) => h.primary.periodS),
      swell_wave_direction: series.map((h) => h.primary.directionDeg),
      secondary_swell_wave_height: series.map((h) => h.secondary.heightM),
      secondary_swell_wave_period: series.map((h) => h.secondary.periodS),
      secondary_swell_wave_direction: series.map((h) => h.secondary.directionDeg),
      wind_wave_height: series.map(() => 0.5),
      wave_height: series.map((h) => h.primary.heightM),
      sea_level_height_msl: series.map((h) => h.seaLevelM),
    },
  };
}

export function forecastJson(wind: WindHour[], daily: DailySun[]) {
  return {
    hourly: {
      time: wind.map((h) => h.time),
      wind_speed_10m: wind.map((h) => h.windKt),
      wind_direction_10m: wind.map((h) => h.windDirDeg),
      wind_gusts_10m: wind.map((h) => h.gustKt),
      temperature_2m: wind.map((h) => h.tempC),
      precipitation: wind.map((h) => h.precipMm),
      weather_code: wind.map((h) => h.weatherCode),
    },
    daily: {
      time: daily.map((d) => d.date),
      sunrise: daily.map((d) => d.sunrise),
      sunset: daily.map((d) => d.sunset),
      temperature_2m_max: daily.map((d) => d.tempMaxC),
      temperature_2m_min: daily.map((d) => d.tempMinC),
      precipitation_sum: daily.map((d) => d.precipMm),
    },
  };
}

export interface ServerData { swell: SwellHour[]; wind: WindHour[]; daily: DailySun[]; failMarine?: boolean; failForecast?: boolean }

/** Répond comme Open-Meteo : un objet pour un point, un tableau pour plusieurs. */
export function openMeteoServer(data: ServerData) {
  return (url: string): Response => {
    const points = (new URL(url).searchParams.get('latitude') ?? '').split(',').length;
    const one = url.includes('marine-api')
      ? (data.failMarine ? null : marineJson(data.swell))
      : (data.failForecast ? null : forecastJson(data.wind, data.daily));
    if (!one) return jsonResponse({ error: true, reason: 'boom' }, 500);
    return jsonResponse(points === 1 ? one : Array.from({ length: points }, () => one));
  };
}
