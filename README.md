# Should I Work

Bot Telegram qui dit chaque soir à 19h (SAST) s'il faut aller travailler le lendemain ou surfer, à partir des spots connus dans un rayon de 20 km autour de Muizenberg (ou de la position envoyée). La note est celle de surf-forecast.com, reconstruite en étoiles sur 10 (`src/engine/rating.ts`, pourquoi et comment dans `RAPPORT-surf-forecast.md`) : la même pour tout le monde, sans niveau ni planche. Le spot mis en avant donne aussi la température de l'eau (Open-Meteo, moyenne des heures de jour) et la combinaison à prendre, du lycra (≥ 24 °C) à la 5/4 avec chaussons, gants et cagoule (≤ 10 °C) — barème dans `src/engine/water.ts`. Confirmation le matin à 6h uniquement si c'est actionnable. À midi, une alerte quand une grosse journée (🟢 epic : ≥ 6★ assez longtemps) s'annonce à J+2 ou J+3, une seule fois par ami et par date. Cloudflare Workers, plan gratuit, zéro dépendance runtime. Spec complète : `~/Delivery/superpowers-specs/should-I-work-today/2026-09-15-should-i-work-design.md`.

## Commandes du bot

`/start <code>` · `📍 Use my location` · `🏠 Back to Muizenberg` · `🔎 Right now` / `/now` · `/week` (la semaine à venir, meilleur jour en tête ; envoyée aussi chaque dimanche à 19h05) · `/all` (et le bouton `📋 All spots` : un bouton par spot montré ouvre sa journée, comme sa commande) · `/about` · `/profil` (heures de travail et seuil d'étoiles : à partir de combien d'étoiles le bot dit d'aller surfer, 3 à 6, 4 par défaut) · `/lang` · `/stop` · bouton `📋 All spots` · bouton `🙋 <spot>` (« j'y vais », avec son `📍` sur la même ligne) sous le verdict quand il y a un créneau (🟢, 🌅, 🌇 — soir, matin, `/now`) ou sous le meilleur spot cité par un 🔴 (soir, `/now`), et sous chaque `/<spot>` pour ce spot : note où l'ami va ce jour-là et lui montre, à lui seul, qui y va ; `✖️` pour se désister · `/<spot>` (commande par spot dérivée du `short`, ex. `/long_beach` — voir `/about` et `src/bot/spotMatch.ts`) · `/amis` (admin seulement, absente de `/setcommands` : chaque ami avec son nom Telegram, sa langue, son lieu, ses horaires, sa date d'arrivée, et s'il s'est mis en pause ou a bloqué le bot).

## Développement

```bash
nvm use            # Node 22
npm install
npm test           # vitest
npm run typecheck
npm run check:spots
npm run report                                   # message du soir sur données live (--date, --lat, --lon, --lang)
npm run report -- --week                         # la semaine à venir, comme /week
npm run compare:sf                               # étoiles du bot face à surf-forecast, créneau par créneau → data/sf-compare.csv
npm run dev        # wrangler dev --test-scheduled ; POST /__scheduled?cron=0+17+*+*+* pour simuler 19h
```

Variables locales dans `.dev.vars` (ignoré par git) : `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET`, `INVITE_CODE`, `ADMIN_CHAT_ID`.

## Mise en production (une fois)

1. BotFather → `/newbot` → token. `/setcommands` : `now - the rest of the day`, `week - the week ahead, best day first`, `all - every spot, hour by hour`, `profile - work hours`, `lang - language`, `about - data and licence`, `stop - no more messages`.
2. `npx wrangler login`, puis `npx wrangler kv namespace create KV` → coller l'`id` dans `wrangler.toml`.
3. Secrets : `npx wrangler secret put TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET` (chaîne aléatoire, ex. `openssl rand -hex 24`), `INVITE_CODE` (**obligatoire** — le bot refuse tout `/start` sans lui ; ex. `openssl rand -hex 8`), `ADMIN_CHAT_ID` (ton `chat_id` — envoie `/start` au bot, lis `wrangler tail`, ou utilise @userinfobot).
4. `npm run deploy` → URL `https://should-i-work.<sous-domaine>.workers.dev`.
5. `TELEGRAM_BOT_TOKEN=… WEBHOOK_SECRET=… WORKER_URL=https://… npm run set-webhook`.
6. Depuis Telegram : `https://t.me/<bot>?start=<INVITE_CODE>`, puis `🔎 Right now`.
7. GitHub (repo privé) → secrets `CLOUDFLARE_API_TOKEN` (template « Edit Cloudflare Workers ») et `CLOUDFLARE_ACCOUNT_ID` → chaque push sur `main` déploie.

## Exploitation

- Le push de 19h est le heartbeat ; toute erreur de run arrive sur Telegram à `ADMIN_CHAT_ID`. L'admin y est aussi prévenu, avec le nom Telegram et l'id, de chaque ami qui rejoint le bot, de chaque accès refusé (sans code, mauvais code, `INVITE_CODE` absent) et de chaque inconnu qui écrit sans l'avoir rejoint. Le dimanche, un second cron à 19h05 envoie la semaine à venir. Chaque jour à 12h, un troisième cherche les grosses journées à J+2 et J+3 ; qui a été prévenu de quelle date est gardé 5 jours (`alerted:<date>:<chatId>`). Qui va où (bouton 🙋) : `going:<date>:<chatId>`, le spot et l'heure de l'appui en métadonnées, gardé 3 jours.
- Logs : `npx wrangler tail`.
- Calibrer : lancer `npm run compare:sf` chaque jour pendant quelques semaines ; le CSV met face à face étoiles, hauteurs, vent et état du vent du site et du bot, spot par spot. Les constantes de la note sont dans `src/engine/rating.ts`, les seuils du verdict dans `src/config.ts`, l'orientation de chaque spot (`facing`) dans `src/data/spots.json`.
- Verrou coincé (run planté après le verrou) : `npx wrangler kv key delete --binding KV "run:<date>:evening"` (ou `morning`, `week`, `alert` — celui-ci à la date du jour) avant de relancer.
- Limites gratuites : 50 requêtes externes par run (Open-Meteo, Telegram ; KV a sa propre limite de 1 000) → 44 amis sur une zone (au-delà, les profils les plus récents sont reportés et l'admin est prévenu) ; le CPU (10 ms) est l'autre plafond. Mesuré le 17/09/2026 à 40 amis sur deux zones, température de l'eau comprise : soir 2,7 ms, matin 2,2 ms, dimanche 5,3 ms, midi 2,8 ms (tous prévenus de deux grosses journées) — les rapports, verdicts et messages sont calculés une fois par groupe d'amis identique (lieu, horaires, langue). Revérifier dans `wrangler tail` si des spots s'ajoutent autour des amis.
- Profils : une clé KV par ami (`profile:<chatId>`, copie du profil en métadonnées pour tout lire en un `list`). L'ancienne clé commune `profiles` n'est plus écrite mais reste lue en secours pour les amis qui n'ont rien modifié depuis.

Données : Open-Meteo.com (CC-BY 4.0), usage non commercial.
