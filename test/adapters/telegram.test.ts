import { describe, it, expect, vi } from 'vitest';
import { Telegram } from '../../src/adapters/telegram';
import { fakeFetch, jsonResponse } from '../helpers/fakeFetch';

const TOKEN = '123:abc';
const body = (call: { init?: RequestInit }) => JSON.parse(String(call.init?.body));

describe('Telegram.sendMessage', () => {
  it('posts HTML text without link preview and returns ok', async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse({ ok: true, result: { message_id: 1 } }));
    const tg = new Telegram(TOKEN, fn);
    await expect(tg.sendMessage(42, '<b>hi</b>')).resolves.toEqual({ ok: true });
    expect(calls[0].url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(calls[0].init?.method).toBe('POST');
    expect(body(calls[0])).toEqual({ chat_id: 42, text: '<b>hi</b>', parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });
  it('passes reply markup through', async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const markup = { inline_keyboard: [[{ text: '📋', callback_data: 'rep:2026-09-16' }]] };
    await new Telegram(TOKEN, fn).sendMessage(42, 'x', markup);
    expect(body(calls[0]).reply_markup).toEqual(markup);
  });
  it('maps 403 to blocked', async () => {
    const { fn } = fakeFetch(() => jsonResponse({ ok: false, description: 'Forbidden: bot was blocked by the user' }, 403));
    await expect(new Telegram(TOKEN, fn).sendMessage(42, 'x')).resolves.toEqual({
      ok: false, blocked: true, retryAfter: undefined, description: 'Forbidden: bot was blocked by the user',
    });
  });
  it('waits retry_after once on 429 then succeeds', async () => {
    let n = 0;
    const { fn, calls } = fakeFetch(() => (n++ === 0 ? jsonResponse({ ok: false, parameters: { retry_after: 3 } }, 429) : jsonResponse({ ok: true })));
    const sleep = vi.fn(async () => {});
    await expect(new Telegram(TOKEN, fn, sleep).sendMessage(42, 'x')).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(calls).toHaveLength(2);
  });
  it('reports other failures without blocking', async () => {
    const { fn } = fakeFetch(() => jsonResponse({ ok: false, description: 'Bad Request: message is too long' }, 400));
    await expect(new Telegram(TOKEN, fn).sendMessage(42, 'x')).resolves.toMatchObject({ ok: false, blocked: false, description: 'Bad Request: message is too long' });
  });
  it('survives a non-JSON body', async () => {
    const { fn } = fakeFetch(() => new Response('<html>502</html>', { status: 502 }));
    await expect(new Telegram(TOKEN, fn).sendMessage(42, 'x')).resolves.toMatchObject({ ok: false, blocked: false, description: 'HTTP 502' });
  });
  it('resolves to a structured failure when fetch itself rejects', async () => {
    const { fn } = fakeFetch(() => { throw new Error('ECONNRESET'); });
    await expect(new Telegram(TOKEN, fn).sendMessage(42, 'x')).resolves.toEqual({
      ok: false, blocked: false, retryAfter: undefined, description: 'network: Error: ECONNRESET',
    });
  });
});

describe('other methods', () => {
  it('answerCallbackQuery posts the id', async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    await new Telegram(TOKEN, fn).answerCallbackQuery('cb1');
    expect(calls[0].url).toBe('https://api.telegram.org/bot123:abc/answerCallbackQuery');
    expect(body(calls[0])).toEqual({ callback_query_id: 'cb1' });
  });
  it('setWebhook sends url, secret and allowed updates', async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse({ ok: true, description: 'Webhook was set' }));
    await expect(new Telegram(TOKEN, fn).setWebhook('https://w.example/webhook', 's3cret')).resolves.toEqual({ ok: true, description: 'Webhook was set' });
    expect(body(calls[0])).toEqual({
      url: 'https://w.example/webhook', secret_token: 's3cret', allowed_updates: ['message', 'callback_query'], drop_pending_updates: true,
    });
  });
});

describe('Telegram.getChat', () => {
  it('reads the name a user shows today', async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse({
      ok: true, result: { id: 42, type: 'private', first_name: 'Elzana', last_name: 'Mirsaitova', username: 'ElzanaMir', bio: 'surf' },
    }));
    await expect(new Telegram(TOKEN, fn).getChat(42)).resolves.toEqual({ id: 42, first_name: 'Elzana', last_name: 'Mirsaitova', username: 'ElzanaMir' });
    expect(calls[0].url).toBe('https://api.telegram.org/bot123:abc/getChat');
    expect(body(calls[0])).toEqual({ chat_id: 42 });
  });
  it('keeps only the text fields it knows, and nothing that is not text', async () => {
    const { fn } = fakeFetch(() => jsonResponse({ ok: true, result: { id: 42, type: 'private', first_name: 'Olga', last_name: 7, username: null } }));
    await expect(new Telegram(TOKEN, fn).getChat(42)).resolves.toEqual({ id: 42, first_name: 'Olga', last_name: undefined, username: undefined });
  });
  it('says nothing when Telegram refuses, answers oddly, or cannot be reached', async () => {
    const answers = [
      () => jsonResponse({ ok: false, description: 'Bad Request: chat not found' }, 400),
      () => jsonResponse({ ok: true }),
      () => jsonResponse({ ok: true, result: 'Olga' }),
      () => jsonResponse({ ok: true, result: { id: '42', first_name: 'Olga' } }),
      () => new Response('<html>502</html>', { status: 502 }),
      () => { throw new TypeError('fetch failed'); },
    ];
    for (const answer of answers) await expect(new Telegram(TOKEN, fakeFetch(answer).fn).getChat(42)).resolves.toBeUndefined();
  });
});
