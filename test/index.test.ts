import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import worker, { buildDeps, handleWebhookRequest, runCron, type AppDeps, type Env } from '../src/index';
import { CRON } from '../src/config';
import { Store } from '../src/adapters/kv';
import { Telegram } from '../src/adapters/telegram';
import { REGIONS } from '../src/data/index';
import { fakeFetch, jsonResponse } from './helpers/fakeFetch';
import { GOLDEN_DAILY, GOLDEN_SPOTS, goldenSwell, goldenWind } from './helpers/golden';
import { MemoryKV } from './helpers/memoryKv';
import { openMeteoServer } from './helpers/openMeteoServer';

function setup() {
  const kv = new MemoryKV();
  const tg = fakeFetch(() => jsonResponse({ ok: true }));
  const om = fakeFetch(openMeteoServer({ swell: goldenSwell(), wind: goldenWind(), daily: GOLDEN_DAILY }));
  const deps: AppDeps = {
    store: new Store(kv), telegram: new Telegram('t', tg.fn), spots: GOLDEN_SPOTS, regions: REGIONS, fetchFn: om.fn,
    inviteCode: undefined, adminChatId: 999, now: () => '2026-09-15T19:00', sleep: async () => {},
  };
  const env = { KV: kv, TELEGRAM_BOT_TOKEN: 't', WEBHOOK_SECRET: 's3cret' } as unknown as Env;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;
  return { deps, env, ctx, kv, tgCalls: tg.calls, flush: () => Promise.all(pending) };
}
const post = (body: unknown, secret?: string) =>
  new Request('https://w.example/webhook', { method: 'POST', body: JSON.stringify(body), headers: secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {} });
const update = { update_id: 1, message: { message_id: 1, chat: { id: 1, type: 'private' }, from: { id: 1, language_code: 'fr' }, text: '/start' } };

describe('webhook', () => {
  it('GET answers 200 with the worker name', async () => {
    const { deps, env, ctx } = setup();
    const res = await handleWebhookRequest(new Request('https://w.example/'), env, ctx, deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('should-i-work');
  });
  it('rejects a missing or wrong secret with 401', async () => {
    const { deps, env, ctx } = setup();
    expect((await handleWebhookRequest(post(update), env, ctx, deps)).status).toBe(401);
    expect((await handleWebhookRequest(post(update, 'nope'), env, ctx, deps)).status).toBe(401);
  });
  it('rejects an empty header when WEBHOOK_SECRET is unset', async () => {
    const { deps, env, ctx } = setup();
    const noSecretEnv = { ...env, WEBHOOK_SECRET: undefined } as unknown as Env;
    const req = new Request('https://w.example/webhook', {
      method: 'POST',
      body: JSON.stringify(update),
      headers: { 'X-Telegram-Bot-Api-Secret-Token': '' },
    });
    expect((await handleWebhookRequest(req, noSecretEnv, ctx, deps)).status).toBe(401);
  });
  it('rejects a non-JSON body with 400', async () => {
    const { deps, env, ctx } = setup();
    const req = new Request('https://w.example/webhook', { method: 'POST', body: '{', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's3cret' } });
    expect((await handleWebhookRequest(req, env, ctx, deps)).status).toBe(400);
  });
  it('answers 200 immediately and processes the update in the background', async () => {
    const { deps, env, ctx, tgCalls, flush } = setup();
    deps.inviteCode = 'surf';
    const startUpdate = { ...update, message: { ...update.message, text: '/start surf' } };
    const res = await handleWebhookRequest(post(startUpdate, 's3cret'), env, ctx, deps);
    expect(res.status).toBe(200);
    await flush();
    expect(tgCalls.some((c) => c.url.endsWith('/sendMessage'))).toBe(true);
    expect(await deps.store.getProfile(1)).toBeDefined();
  });
  it('reports a handler crash to the user and the admin', async () => {
    const { deps, env, ctx, tgCalls, flush } = setup();
    deps.store.getProfile = async () => { throw new Error('kv down'); };
    await handleWebhookRequest(post({ ...update, message: { ...update.message, text: '/now' } }, 's3cret'), env, ctx, deps);
    await flush();
    const bodies = tgCalls.map((c) => JSON.parse(String(c.init?.body)) as { chat_id: number; text: string });
    expect(bodies.find((b) => b.chat_id === 1)?.text).toBe('⚠️ Error, try again.');
    expect(bodies.find((b) => b.chat_id === 999)?.text).toContain('kv down');
  });
  it('reports a handler crash to the user in their own language (RU)', async () => {
    const { deps, env, ctx, tgCalls, flush } = setup();
    deps.store.getProfile = async () => { throw new Error('kv down'); };
    const ruUpdate = { ...update, message: { ...update.message, from: { id: 1, language_code: 'ru' }, text: '/now' } };
    await handleWebhookRequest(post(ruUpdate, 's3cret'), env, ctx, deps);
    await flush();
    const bodies = tgCalls.map((c) => JSON.parse(String(c.init?.body)) as { chat_id: number; text: string });
    expect(bodies.find((b) => b.chat_id === 1)?.text).toBe('⚠️ Ошибка, попробуй ещё раз.');
  });
});

describe('crons', () => {
  it('dispatches the evening and morning crons and ignores unknown ones', async () => {
    const { deps, kv } = setup();
    await deps.store.putProfiles({ '1': { chatId: 1, lang: 'en', workHours: { start: '09:00', end: '18:00' }, location: { lat: -34.1085, lon: 18.4715, source: 'default' }, active: true, createdAt: 'x' } });
    await runCron('0 17 * * *', deps);
    expect(kv.data.has('run:2026-09-16:evening')).toBe(true);
    await runCron('0 4 * * *', deps);
    expect(kv.data.has('run:2026-09-15:morning')).toBe(true);
    await expect(runCron('* * * * *', deps)).resolves.toBeUndefined();
  });
  it('dispatches the Sunday 19:05 SAST cron to the week ahead', async () => {
    const { deps, kv } = setup();
    await deps.store.putProfiles({ '1': { chatId: 1, lang: 'en', workHours: { start: '09:00', end: '18:00' }, location: { lat: -34.1085, lon: 18.4715, source: 'default' }, active: true, createdAt: 'x' } });
    await runCron(CRON.week, deps);
    expect(CRON.week).toBe('5 17 * * SUN');
    expect(kv.data.has('run:2026-09-16:week')).toBe(true);
  });
  it('dispatches the noon SAST cron to the big-day alert', async () => {
    const { deps, kv } = setup();
    await deps.store.putProfiles({ '1': { chatId: 1, lang: 'en', workHours: { start: '09:00', end: '18:00' }, location: { lat: -34.1085, lon: 18.4715, source: 'default' }, active: true, createdAt: 'x' } });
    await runCron(CRON.alert, deps);
    expect(CRON.alert).toBe('0 10 * * *');
    expect(kv.data.has('run:2026-09-15:alert')).toBe(true);
  });
  it("writes weekdays the way Cloudflare's scheduler reads them — 1 = Sunday … 7 = Saturday, or SUN–SAT; a Unix 0 is refused at deploy", () => {
    const day = '([1-7]|SUN|MON|TUE|WED|THU|FRI|SAT)';
    const weekday = new RegExp(`^(\\*|${day}([-,]${day})*)$`, 'i');
    for (const cron of Object.values(CRON)) expect(cron.split(' ')[4], cron).toMatch(weekday);
  });
  it('wrangler.toml declares every cron the code dispatches — a missing one would silence its run without an error', () => {
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    const line = /^crons\s*=\s*(\[[^\]]*\])/m.exec(toml);
    expect(line, 'wrangler.toml has no crons line').not.toBeNull();
    const declared = JSON.parse(line![1]) as string[];
    expect([...declared].sort()).toEqual(Object.values(CRON).sort());
  });
  it('logs the JobResult as JSON for each cron run', async () => {
    const { deps } = setup();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runCron('0 17 * * *', deps);
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('"skipped":false'))).toBe(true);
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('"cron":"0 17 * * *"'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
  it('tells the admin when a run throws, then rethrows', async () => {
    const { deps, tgCalls } = setup();
    deps.store.getProfiles = async () => { throw new Error('boom'); };
    await expect(runCron('0 17 * * *', deps)).rejects.toThrow('boom');
    const admin = tgCalls.map((c) => JSON.parse(String(c.init?.body)) as { chat_id: number; text: string }).find((b) => b.chat_id === 999);
    expect(admin?.text).toContain('boom');
  });
  it('the default export exposes fetch and scheduled', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.scheduled).toBe('function');
  });
});

describe('buildDeps', () => {
  it('drops a non-numeric ADMIN_CHAT_ID instead of storing NaN', () => {
    const { env } = setup();
    expect(buildDeps({ ...env, ADMIN_CHAT_ID: 'abc' } as Env).adminChatId).toBeUndefined();
  });
  it('parses a numeric ADMIN_CHAT_ID', () => {
    const { env } = setup();
    expect(buildDeps({ ...env, ADMIN_CHAT_ID: '999' } as Env).adminChatId).toBe(999);
  });
});
