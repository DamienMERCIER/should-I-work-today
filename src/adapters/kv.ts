import { LANGS, LOCK_TTL_S, REPORT_TTL_S } from '../config';
import type { Profile, Report, SpotHour, SpotResult } from '../types';
import { sleep as defaultSleep } from './http';

/**
 * Champs qu'une version antérieure écrivait et que plus rien ne lit : niveau, planche et étape de
 * l'ancien onboarding en deux questions (retirés le 2026-09-16, la note étant désormais celle de
 * surf-forecast). Les garder ferait traîner un ami resté entre les deux questions hors des envois
 * du soir, qui écartaient les profils en cours d'onboarding.
 */
const LEGACY_KEYS = ['level', 'board', 'onboarding'] as const;

/**
 * Les champs fermés du profil viennent de KV, pas du code : une langue retirée (le français,
 * le 2026-09-16) ou abîmée indexerait `STRINGS` sur `undefined`, ce que `fill` transforme en
 * exception — donc un rendu impossible plutôt qu'une simple dégradation.
 * Une entrée qui n'est pas un objet passe telle quelle : les consommateurs la gèrent déjà,
 * et la faire échouer ici priverait tous les autres profils de leur run.
 */
function withSupportedFields(p: Profile): Profile {
  if (!p || typeof p !== 'object') return p;
  const lang = LANGS.includes(p.lang) ? p.lang : 'en';
  const legacy = LEGACY_KEYS.some((k) => k in p);
  if (lang === p.lang && !legacy) return p;
  const next: Record<string, unknown> = { ...p, lang };
  for (const k of LEGACY_KEYS) delete next[k];
  return next as unknown as Profile;
}

/**
 * Tous les rapports d'un jour partagent une seule clé KV : ce test ne doit jamais lever, sinon un seul
 * enregistrement abîmé (écriture partielle, schéma futur) ferait échouer la lecture pour tout le monde.
 * Chaque niveau est donc vérifié avant d'être lu, et un rapport douteux est simplement écarté.
 */
const hasCurrentShape = (r: Report): boolean =>
  Boolean(r) && Array.isArray(r.spots) &&
  r.spots.every((s) => Boolean(s) && Array.isArray(s.hours) && s.hours.every((h) => Boolean(h) && typeof h.stars === 'number'));

export interface KVListResult {
  keys: { name: string; metadata?: unknown }[];
  list_complete: boolean;
  cursor?: string;
}

/**
 * Les rapports d'un jour stockent chaque spot-journée une seule fois. Tous les amis d'un envoi partagent la même
 * évaluation d'un spot (§buildReportList) et ne diffèrent que par la distance : à 40 amis, le format d'avant
 * (un rapport complet par ami) pesait 2,7 Mo, sérialisés deux fois le soir et relus le matin (17/09/2026).
 * Le tableau `hours` sert d'identité : les copies `{ ...evaluated, distanceKm }` le partagent, et deux journées
 * différentes du même spot — le matin garde le rapport du soir d'un ami sans données — restent séparées.
 */
type StoredSpotDay = Omit<SpotResult, 'spotId' | 'distanceKm'>;
interface StoredSpotRef { spotId: string; distanceKm: number; day: number }
interface StoredReports {
  v: 2;
  days: StoredSpotDay[];
  reports: Record<string, Omit<Report, 'spots'> & { spots: StoredSpotRef[] }>;
}

function packReports(reports: Record<string, Report>): StoredReports {
  const dayIndex = new Map<SpotHour[], number>();
  const days: StoredSpotDay[] = [];
  const packed: StoredReports['reports'] = {};
  for (const [id, report] of Object.entries(reports)) {
    const spots = report.spots.map(({ spotId, distanceKm, ...day }) => {
      let index = dayIndex.get(day.hours);
      if (index === undefined) {
        index = days.push(day) - 1;
        dayIndex.set(day.hours, index);
      }
      return { spotId, distanceKm, day: index };
    });
    packed[id] = { ...report, spots };
  }
  return { v: 2, days, reports: packed };
}

const isPacked = (stored: unknown): stored is StoredReports =>
  typeof stored === 'object' && stored !== null && (stored as StoredReports).v === 2 &&
  Array.isArray((stored as StoredReports).days) && typeof (stored as StoredReports).reports === 'object';

/** Un rapport qui pointe vers une journée absente garde un spot `null`, que `hasCurrentShape` écarte ensuite. */
function unpackReports(stored: unknown): Record<string, Report> {
  if (!isPacked(stored)) return (stored as Record<string, Report> | null) ?? {};
  const out: Record<string, Report> = {};
  for (const [id, report] of Object.entries(stored.reports ?? {})) {
    if (!report || !Array.isArray(report.spots)) {
      out[id] = report as unknown as Report;
      continue;
    }
    const spots = report.spots.map((ref) => {
      const day = ref ? stored.days[ref.day] : undefined;
      return day ? { spotId: ref.spotId, distanceKm: ref.distanceKm, ...day } : null;
    });
    out[id] = { ...report, spots } as unknown as Report;
  }
  return out;
}

/** Sous-ensemble de KVNamespace utilisé par l'application (facile à simuler en test). */
export interface KVStore {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<KVListResult>;
}

export type RunKind = 'evening' | 'morning' | 'week';

/**
 * Un profil par clé : deux amis ne réécrivent jamais la même entrée. Jusqu'au 17/09/2026, tous les profils
 * partageaient la clé `profiles`, relue puis réécrite en entier : deux inscriptions dans la même seconde
 * s'effaçaient (KV garde la dernière écriture) ou la seconde était refusée (une écriture par seconde par clé).
 */
const PROFILE_PREFIX = 'profile:';
/** L'ancienne clé commune : lue en secours pour les amis qui n'ont encore rien modifié, plus jamais écrite. */
const LEGACY_PROFILES_KEY = 'profiles';
/** Le profil voyage aussi en métadonnées (1 024 octets permis, ~200 utilisés) : un `list` lit tout le monde. */
const METADATA_MAX_BYTES = 1024;
/** KV refuse une seconde écriture sur la même clé dans la seconde (429) : un nouvel essai attend un peu plus. */
const SAME_KEY_RETRY_MS = 1100;

export interface StoreOptions {
  sleep?: (ms: number) => Promise<void>;
}

export class Store {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly kv: KVStore, opts: StoreOptions = {}) {
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private async legacyProfiles(): Promise<Record<string, Profile>> {
    const stored = ((await this.kv.get(LEGACY_PROFILES_KEY, 'json')) as Record<string, Profile> | null) ?? {};
    return Object.fromEntries(Object.entries(stored).map(([id, p]) => [id, withSupportedFields(p)]));
  }

  /**
   * Tous les profils : l'ancienne clé commune, puis une page de `list` après l'autre, l'entrée propre l'emportant.
   * `list` suit les écritures avec jusqu'à une minute de retard ailleurs dans le réseau : un ami inscrit ou modifié
   * juste avant un envoi peut y manquer ou y figurer dans son état précédent, et reçoit le suivant.
   */
  async getProfiles(): Promise<Record<string, Profile>> {
    const all = await this.legacyProfiles();
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix: PROFILE_PREFIX, cursor });
      for (const { name, metadata } of page.keys) {
        const profile = (metadata ?? (await this.kv.get(name, 'json'))) as Profile | null;
        if (profile) all[name.slice(PROFILE_PREFIX.length)] = withSupportedFields(profile);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return all;
  }

  async getProfile(chatId: number): Promise<Profile | undefined> {
    const own = (await this.kv.get(`${PROFILE_PREFIX}${chatId}`, 'json')) as Profile | null;
    if (own) return withSupportedFields(own);
    return (await this.legacyProfiles())[String(chatId)];
  }

  /** Écrit chaque profil sous sa propre clé (les autres restent tels quels). */
  async putProfiles(profiles: Record<string, Profile>): Promise<void> {
    for (const [id, profile] of Object.entries(profiles)) await this.putProfileAt(id, profile);
  }

  /** Lecture-modification-écriture de ce seul profil : un autre ami ne peut plus l'effacer. */
  async updateProfile(chatId: number, update: (current: Profile | undefined) => Profile): Promise<Profile> {
    const next = update(await this.getProfile(chatId));
    await this.putProfileAt(String(chatId), next);
    return next;
  }

  private async putProfileAt(id: string, profile: Profile): Promise<void> {
    const key = `${PROFILE_PREFIX}${id}`;
    const value = JSON.stringify(profile);
    const options = new TextEncoder().encode(value).length <= METADATA_MAX_BYTES ? { metadata: profile } : undefined;
    try {
      await this.kv.put(key, value, options);
    } catch {
      // Le 429 d'une seconde écriture dans la seconde, ou une panne passagère : la même écriture, une fois, un peu plus
      // tard. Sans dépendre du texte de l'erreur ; un second échec remonte tel quel.
      await this.sleep(SAME_KEY_RETRY_MS);
      await this.kv.put(key, value, options);
    }
  }

  /**
   * Un rapport écrit avant les étoiles (16/09/2026) n'a ni `stars`, ni `heightM`, ni `windState` :
   * rendu tel quel il donnait « NaN–NaN m · undefined SE » et dix étoiles creuses, et le run du matin
   * l'aurait comparé à un rapport neuf pour annoncer un faux changement. On le traite comme absent :
   * aujourd'hui se recalcule, un jour plus ancien répond « trop vieux ». Ils expirent en 48 h.
   */
  async getReports(date: string): Promise<Record<string, Report>> {
    const stored = unpackReports(await this.kv.get(`reports:${date}`, 'json'));
    return Object.fromEntries(Object.entries(stored).filter(([, r]) => hasCurrentShape(r)));
  }

  async putReports(date: string, reports: Record<string, Report>): Promise<void> {
    await this.kv.put(`reports:${date}`, JSON.stringify(packReports(reports)), { expirationTtl: REPORT_TTL_S });
  }

  /** true si le verrou vient d'être posé, false s'il existait déjà (cron rejoué, §11). */
  async acquireLock(date: string, run: RunKind, now: string): Promise<boolean> {
    const key = `run:${date}:${run}`;
    if (await this.kv.get(key, 'json')) return false;
    await this.kv.put(key, JSON.stringify({ startedAt: now }), { expirationTtl: LOCK_TTL_S });
    return true;
  }
}
