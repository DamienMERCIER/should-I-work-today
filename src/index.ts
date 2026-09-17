import { safeEqual } from './adapters/http';
import { Store } from './adapters/kv';
import { Telegram, type TgUpdate } from './adapters/telegram';
import { handleUpdate, type BotDeps } from './bot/router';
import { CRON } from './config';
import { REGIONS, SPOTS } from './data/index';
import { nowLocal } from './engine/time';
import { notifyAdmin, runAlert, runEvening, runMorning, runWeek, type JobDeps, type JobResult } from './jobs/runs';
import { detectLang, STRINGS } from './render/i18n';

export interface Env {
  KV: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  INVITE_CODE?: string;
  ADMIN_CHAT_ID?: string;
}

export type AppDeps = BotDeps & JobDeps;

export function buildDeps(env: Env): AppDeps {
  if (!env.INVITE_CODE) console.warn('INVITE_CODE is not set — every /start is refused');
  const admin = Number(env.ADMIN_CHAT_ID);
  return {
    store: new Store(env.KV),
    telegram: new Telegram(env.TELEGRAM_BOT_TOKEN),
    spots: SPOTS,
    regions: REGIONS,
    fetchFn: (url, init) => fetch(url, init),
    inviteCode: env.INVITE_CODE,
    adminChatId: env.ADMIN_CHAT_ID && Number.isFinite(admin) ? admin : undefined,
    now: () => nowLocal(),
  };
}

async function processUpdate(update: TgUpdate, deps: AppDeps): Promise<void> {
  try {
    await handleUpdate(update, deps);
  } catch (err) {
    const chatId = update.message?.chat.id ?? update.callback_query?.from.id;
    const lang = detectLang(update.message?.from?.language_code ?? update.callback_query?.from.language_code);
    if (chatId !== undefined) await deps.telegram.sendMessage(chatId, STRINGS[lang].error).catch(() => undefined);
    await notifyAdmin(deps, `webhook: ${String(err)}`).catch(() => undefined);
  }
}

/** Répond 200 tout de suite et traite l'update en arrière-plan (§11). */
export async function handleWebhookRequest(request: Request, env: Env, ctx: ExecutionContext, deps: AppDeps = buildDeps(env)): Promise<Response> {
  if (request.method !== 'POST') return new Response('should-i-work', { status: 200 });
  const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!env.WEBHOOK_SECRET || header === null || !safeEqual(header, env.WEBHOOK_SECRET)) return new Response('unauthorized', { status: 401 });
  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return new Response('bad request', { status: 400 });
  }
  ctx.waitUntil(processUpdate(update, deps));
  return new Response('ok', { status: 200 });
}

export async function runCron(cron: string, deps: AppDeps): Promise<void> {
  try {
    let result: JobResult | undefined;
    if (cron === CRON.evening) result = await runEvening(deps);
    else if (cron === CRON.morning) result = await runMorning(deps);
    else if (cron === CRON.week) result = await runWeek(deps);
    else if (cron === CRON.alert) result = await runAlert(deps);
    else {
      console.warn(`unknown cron: ${cron}`);
      return;
    }
    console.log(JSON.stringify({ cron, ...result }));
  } catch (err) {
    await notifyAdmin(deps, `cron ${cron}: ${String(err)}`).catch(() => undefined);
    throw err;
  }
}

const worker = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => handleWebhookRequest(request, env, ctx),
  scheduled: (event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> => runCron(event.cron, buildDeps(env)),
} satisfies ExportedHandler<Env>;

export default worker;
