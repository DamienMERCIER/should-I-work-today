import { describe, it, expect } from 'vitest';
import { createFetch, USER_AGENT } from '../../scripts/lib/userAgentFetch';

describe('USER_AGENT', () => {
  it('is an honest, identifying UA — never a browser impersonation', () => {
    expect(USER_AGENT).toBe('should-i-work-bot/1.0 (personal surf forecast bot; +https://github.com/DamienMERCIER/should-I-work-today)');
  });
});

describe('createFetch', () => {
  it('adds the User-Agent header to every request', async () => {
    let seenHeaders: HeadersInit | undefined;
    const base = async (_url: string, init?: RequestInit) => {
      seenHeaders = init?.headers;
      return new Response('ok');
    };
    await createFetch(base)('https://example.test/');
    expect(new Headers(seenHeaders).get('user-agent')).toBe(USER_AGENT);
  });

  it('preserves headers the caller already set', async () => {
    let seenHeaders: HeadersInit | undefined;
    const base = async (_url: string, init?: RequestInit) => {
      seenHeaders = init?.headers;
      return new Response('ok');
    };
    await createFetch(base)('https://example.test/', { headers: { accept: 'text/html' } });
    const h = new Headers(seenHeaders);
    expect(h.get('accept')).toBe('text/html');
    expect(h.get('user-agent')).toBe(USER_AGENT);
  });

  it('passes the url through unchanged', async () => {
    let seenUrl = '';
    const base = async (url: string) => {
      seenUrl = url;
      return new Response('ok');
    };
    await createFetch(base)('https://example.test/path');
    expect(seenUrl).toBe('https://example.test/path');
  });
});
