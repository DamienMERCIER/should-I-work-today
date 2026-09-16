import type { Region, Spot } from '../types';

const LEVELS = ['beginner', 'intermediate', 'advanced'];
const TIDES = ['low', 'mid', 'high'];
const CHARACTERS = ['mellow', 'punchy', 'heavy'];
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, min: number, max: number, maxInclusive = true): boolean =>
  isNum(v) && v >= min && (maxInclusive ? v <= max : v < max);

export function validateRegions(input: unknown): string[] {
  if (!Array.isArray(input)) return ['regions: expected an array'];
  const errors: string[] = [];
  const seen = new Set<string>();
  input.forEach((r, i) => {
    const p = `regions[${i}]`;
    if (!isRecord(r)) return void errors.push(`${p}: expected an object`);
    if (typeof r.id !== 'string' || !ID_RE.test(r.id)) errors.push(`${p}.id: must be kebab-case`);
    else if (seen.has(r.id)) errors.push(`${p}.id: duplicate "${r.id}"`);
    else seen.add(r.id);
    if (typeof r.name !== 'string' || r.name.length === 0) errors.push(`${p}.name: expected non-empty string`);
    if (r.tz !== 'Africa/Johannesburg') errors.push(`${p}.tz: expected "Africa/Johannesburg"`);
    if (!isRecord(r.swellRef) || !inRange(r.swellRef.lat, -90, 90) || !inRange(r.swellRef.lon, -180, 180)) {
      errors.push(`${p}.swellRef: expected { lat, lon }`);
    }
  });
  return errors;
}

export function validateSpots(input: unknown, regions: Region[]): string[] {
  if (!Array.isArray(input)) return ['spots: expected an array'];
  const regionIds = new Set(regions.map((r) => r.id));
  const errors: string[] = [];
  const seen = new Set<string>();
  const seenShortByRegion = new Map<string, Set<string>>();
  input.forEach((s, i) => {
    const p = `spots[${i}]`;
    if (!isRecord(s)) return void errors.push(`${p}: expected an object`);
    if (typeof s.id !== 'string' || !ID_RE.test(s.id)) errors.push(`${p}.id: must be kebab-case`);
    else if (seen.has(s.id)) errors.push(`${p}.id: duplicate "${s.id}"`);
    else seen.add(s.id);
    if (typeof s.name !== 'string' || s.name.length === 0) errors.push(`${p}.name: expected non-empty string`);
    if (typeof s.short !== 'string' || s.short.length === 0) errors.push(`${p}.short: expected non-empty string`);
    else if (s.short.length > 13) errors.push(`${p}.short: expected ≤ 13 characters`);
    // le préfixe « ≈ » des spots non vérifiés consomme 2 colonnes du budget de largeur du tableau
    else if (s.verified === false && s.short.length > 11) errors.push(`${p}.short: expected ≤ 11 characters for an unverified spot (the ≈ prefix costs 2)`);
    else if (typeof s.region === 'string') {
      const inRegion = seenShortByRegion.get(s.region) ?? new Set<string>();
      if (inRegion.has(s.short)) errors.push(`${p}.short: duplicate "${s.short}" in region "${s.region}"`);
      else inRegion.add(s.short);
      seenShortByRegion.set(s.region, inRegion);
    }
    if (typeof s.region !== 'string' || !regionIds.has(s.region)) errors.push(`${p}.region: unknown region "${String(s.region)}"`);
    if (!inRange(s.lat, -90, 90)) errors.push(`${p}.lat: expected number in [-90, 90]`);
    if (!inRange(s.lon, -180, 180)) errors.push(`${p}.lon: expected number in [-180, 180]`);
    if (!inRange(s.facing, 0, 360, false)) errors.push(`${p}.facing: expected number in [0, 360)`);
    const w = s.swellWindow;
    if (!Array.isArray(w) || w.length !== 2 || !inRange(w[0], 0, 360) || !inRange(w[1], 0, 360)) {
      errors.push(`${p}.swellWindow: expected [from, to] in [0, 360]`);
    }
    if (!isNum(s.exposure) || s.exposure <= 0 || s.exposure > 1.5) errors.push(`${p}.exposure: expected number in (0, 1.5]`);
    errors.push(...validateTide(s.tide, p));
    errors.push(...validateLevels(s.levels, p));
    if (typeof s.character !== 'string' || !CHARACTERS.includes(s.character)) errors.push(`${p}.character: expected mellow | punchy | heavy`);
    if (typeof s.verified !== 'boolean') errors.push(`${p}.verified: expected boolean`);
    if (s.notes !== undefined && typeof s.notes !== 'string') errors.push(`${p}.notes: expected string`);
  });
  return errors;
}

function validateTide(tide: unknown, p: string): string[] {
  if (!isRecord(tide) || !Array.isArray(tide.best) || !Array.isArray(tide.forbidden)) return [`${p}.tide: expected { best: [], forbidden: [] }`];
  const errors: string[] = [];
  for (const key of ['best', 'forbidden'] as const) {
    for (const state of tide[key] as unknown[]) {
      if (typeof state !== 'string' || !TIDES.includes(state)) errors.push(`${p}.tide.${key}: unknown tide state "${String(state)}"`);
    }
  }
  if ((tide.best as unknown[]).some((x) => (tide.forbidden as unknown[]).includes(x))) errors.push(`${p}.tide: best and forbidden overlap`);
  return errors;
}

function validateLevels(levels: unknown, p: string): string[] {
  if (!isRecord(levels)) return [`${p}.levels: expected an object`];
  const keys = Object.keys(levels);
  if (keys.length === 0) return [`${p}.levels: at least one level required`];
  const errors: string[] = [];
  for (const key of keys) {
    if (!LEVELS.includes(key)) {
      errors.push(`${p}.levels: unknown level "${key}"`);
      continue;
    }
    const band = levels[key];
    if (!Array.isArray(band) || band.length !== 2 || !isNum(band[0]) || !isNum(band[1]) || band[0] <= 0 || band[0] >= band[1]) {
      errors.push(`${p}.levels.${key}: expected [min, max] with 0 < min < max`);
    }
  }
  return errors;
}

export function loadSpots(spotsJson: unknown, regionsJson: unknown): { spots: Spot[]; regions: Region[] } {
  const regionErrors = validateRegions(regionsJson);
  const regions = regionErrors.length === 0 ? (regionsJson as Region[]) : [];
  const errors = [...regionErrors, ...validateSpots(spotsJson, regions)];
  if (errors.length > 0) throw new Error(`Invalid spot data:\n${errors.join('\n')}`);
  return { spots: spotsJson as Spot[], regions };
}
