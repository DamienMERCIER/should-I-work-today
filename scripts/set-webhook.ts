import { Telegram } from '../src/adapters/telegram';

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.WEBHOOK_SECRET;
const workerUrl = process.env.WORKER_URL;
if (!token || !secret || !workerUrl) {
  console.error('Usage: TELEGRAM_BOT_TOKEN=… WEBHOOK_SECRET=… WORKER_URL=https://should-i-work.<subdomain>.workers.dev npm run set-webhook');
  process.exit(1);
}

const url = `${workerUrl.replace(/\/$/, '')}/webhook`;
const res = await new Telegram(token, (u, init) => fetch(u, init)).setWebhook(url, secret);
console.log(res.ok ? `Webhook set: ${url}` : `Failed: ${res.description ?? 'unexpected response'}`);
process.exit(res.ok ? 0 : 1);
