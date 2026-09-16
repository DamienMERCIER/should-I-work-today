import { LANGS, LOCK_TTL_S, REPORT_TTL_S } from '../config';
import type { Profile, Report } from '../types';

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

/** Sous-ensemble de KVNamespace utilisé par l'application (facile à simuler en test). */
export interface KVStore {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export type RunKind = 'evening' | 'morning';

export class Store {
  constructor(private readonly kv: KVStore) {}

  async getProfiles(): Promise<Record<string, Profile>> {
    const stored = ((await this.kv.get('profiles', 'json')) as Record<string, Profile> | null) ?? {};
    return Object.fromEntries(Object.entries(stored).map(([id, p]) => [id, withSupportedFields(p)]));
  }

  async putProfiles(profiles: Record<string, Profile>): Promise<void> {
    await this.kv.put('profiles', JSON.stringify(profiles));
  }

  async getProfile(chatId: number): Promise<Profile | undefined> {
    return (await this.getProfiles())[String(chatId)];
  }

  /** Lecture-modification-écriture : 2 sous-requêtes, dernier écrivain gagnant (§4). */
  async updateProfile(chatId: number, update: (current: Profile | undefined) => Profile): Promise<Profile> {
    const all = await this.getProfiles();
    const next = update(all[String(chatId)]);
    all[String(chatId)] = next;
    await this.putProfiles(all);
    return next;
  }

  /**
   * Un rapport écrit avant les étoiles (16/09/2026) n'a ni `stars`, ni `heightM`, ni `windState` :
   * rendu tel quel il donnait « NaN–NaN m · undefined SE » et dix étoiles creuses, et le run du matin
   * l'aurait comparé à un rapport neuf pour annoncer un faux changement. On le traite comme absent :
   * aujourd'hui se recalcule, un jour plus ancien répond « trop vieux ». Ils expirent en 48 h.
   */
  async getReports(date: string): Promise<Record<string, Report>> {
    const stored = ((await this.kv.get(`reports:${date}`, 'json')) as Record<string, Report> | null) ?? {};
    return Object.fromEntries(Object.entries(stored).filter(([, r]) => hasCurrentShape(r)));
  }

  async putReports(date: string, reports: Record<string, Report>): Promise<void> {
    await this.kv.put(`reports:${date}`, JSON.stringify(reports), { expirationTtl: REPORT_TTL_S });
  }

  /** true si le verrou vient d'être posé, false s'il existait déjà (cron rejoué, §11). */
  async acquireLock(date: string, run: RunKind, now: string): Promise<boolean> {
    const key = `run:${date}:${run}`;
    if (await this.kv.get(key, 'json')) return false;
    await this.kv.put(key, JSON.stringify({ startedAt: now }), { expirationTtl: LOCK_TTL_S });
    return true;
  }
}
