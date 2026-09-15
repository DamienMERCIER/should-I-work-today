# Should I Work

Bot Telegram qui dit chaque soir à 19h (SAST) s'il faut aller travailler le lendemain ou surfer, à partir des spots connus dans un rayon de 20 km autour de Muizenberg (ou de la position envoyée). Confirmation le matin à 6h uniquement si c'est actionnable. Cloudflare Workers, plan gratuit, zéro dépendance runtime. Spec complète : `~/Delivery/superpowers-specs/should-I-work-today/2026-09-15-should-i-work-design.md`.

## Commandes du bot

`/start <code>` · `📍 Utilise ma position` · `🏠 Retour à Muizenberg` · `🔎 Maintenant` / `/now` · `/profil` · `/lang` · `/stop` · bouton `📋 Tous les spots`.

## Développement

```bash
nvm use            # Node 22
npm install
npm test           # vitest
npm run typecheck
npm run check:spots
npm run report -- --level intermediate --board both   # message du soir sur données live
npm run dev        # wrangler dev --test-scheduled ; POST /__scheduled?cron=0+17+*+*+* pour simuler 19h
```

Variables locales dans `.dev.vars` (ignoré par git) : `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET`, `INVITE_CODE`, `ADMIN_CHAT_ID`.

## Mise en production (une fois)

1. BotFather → `/newbot` → token. `/setcommands` : `now - le reste de la journée`, `profil - niveau, planche, heures`, `lang - langue`, `stop - plus de messages`.
2. `npx wrangler login`, puis `npx wrangler kv namespace create KV` → coller l'`id` dans `wrangler.toml`.
3. Secrets : `npx wrangler secret put TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET` (chaîne aléatoire, ex. `openssl rand -hex 24`), `INVITE_CODE`, `ADMIN_CHAT_ID` (ton `chat_id` — envoie `/start` au bot, lis `wrangler tail`, ou utilise @userinfobot).
4. `npm run deploy` → URL `https://should-i-work.<sous-domaine>.workers.dev`.
5. `TELEGRAM_BOT_TOKEN=… WEBHOOK_SECRET=… WORKER_URL=https://… npm run set-webhook`.
6. Depuis Telegram : `https://t.me/<bot>?start=<INVITE_CODE>`, deux taps, puis `🔎 Maintenant`.
7. GitHub (repo privé) → secrets `CLOUDFLARE_API_TOKEN` (template « Edit Cloudflare Workers ») et `CLOUDFLARE_ACCOUNT_ID` → chaque push sur `main` déploie.

## Exploitation

- Le push de 19h est le heartbeat ; toute erreur de run arrive sur Telegram à `ADMIN_CHAT_ID`.
- Logs : `npx wrangler tail`.
- Calibrer : comparer `npm run report` à Windguru/Surfline, ajuster `exposure` dans `src/data/spots.json` et les courbes dans `src/config.ts`. Un spot en `verified: false` s'affiche avec « ≈ ».
- Limites gratuites : 50 sous-requêtes par run → ~40 utilisateurs ; au-delà, l'admin reçoit « fan-out nécessaire ».

Données : Open-Meteo.com (CC-BY 4.0), usage non commercial.
