import { BOARDS, LANGS, LEVELS, LOCK_TTL_S, REPORT_TTL_S } from '../config';
import type { Profile, Report } from '../types';

/**
 * Les champs fermés du profil viennent de KV, pas du code : une valeur retirée (le français,
 * le 2026-09-16) ou abîmée indexerait `STRINGS`/`Strings.levels` sur `undefined`, ce que `fill`
 * transforme en exception — donc un rendu impossible plutôt qu'une simple dégradation.
 * Une entrée qui n'est pas un objet passe telle quelle : les consommateurs la gèrent déjà,
 * et la faire échouer ici priverait tous les autres profils de leur run.
 */
function withSupportedFields(p: Profile): Profile {
  if (!p || typeof p !== 'object') return p;
  const lang = LANGS.includes(p.lang) ? p.lang : 'en';
  const level = LEVELS.includes(p.level) ? p.level : 'intermediate';
  const board = BOARDS.includes(p.board) ? p.board : 'both';
  return lang === p.lang && level === p.level && board === p.board ? p : { ...p, lang, level, board };
}

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

  async getReports(date: string): Promise<Record<string, Report>> {
    return ((await this.kv.get(`reports:${date}`, 'json')) as Record<string, Report> | null) ?? {};
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
