import type { FetchLike } from '../../src/adapters/http';

/**
 * See the robots.txt comment in `scripts/import-spots.ts` for the full explanation: every request
 * this importer makes must identify itself honestly, never impersonate a browser.
 */
export const USER_AGENT = 'should-i-work-bot/1.0 (personal surf forecast bot; +https://github.com/DamienMERCIER/should-I-work-today)';

/**
 * Wraps a `fetch`-like function so every request carries the honest, identifying User-Agent above,
 * without touching anything else about the request (Accept-Encoding included — §import-spots.ts
 * stage 2 comment on why that one is left to the runtime's default).
 */
export function createFetch(base: FetchLike = fetch): FetchLike {
  return (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('user-agent', USER_AGENT);
    return base(url, { ...init, headers });
  };
}
