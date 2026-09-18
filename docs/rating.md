# How the star rating was reconstructed

The bot rates a spot-hour the way surf-forecast.com does, so that a friend who cross-checks on the site sees the
same number. That rating is not a taste: it is swell directed at the spot, times a wind factor. No skill level, no
board, no tide, no time of day — those belong to the verdict, not to the stars.

This note is the evidence behind `src/engine/rating.ts`. It was written on 16/09/2026 from 78 readings taken from
surf-forecast.com on the same day: Muizenberg and Long Beach at 3-hour intervals, the Cape Town wavefinder over 7
days, and two spots high on the scale to cover its top end (Papatowai NZ, Cathedral Rock AU). The rows are in
[`data/sf-rows-2026-09-16.csv`](../data/sf-rows-2026-09-16.csv) and serve as golden tests in
`test/engine/rating.test.ts`.

## 1. Reading the same swell

The site reads its wave model at a coastal point specific to each break and shows the height of the swell directed
towards the break, in open water near the shore — warning that breaking waves are often smaller. That figure is a
coastal significant wave height, not a face height.

The bot therefore asks Open-Meteo for the swell at each spot's own cell, alongside the region's offshore reference
point (`swellRef`), in the same marine call — several coordinates cost one subrequest, so the precision is free.
The regional point remains the fallback, scaled by the spot's `exposure` (0.35 at Muizenberg, 1.1 at Outer Kom):
useful when a cell is missing, never as good as the spot's own.

Without that, the two numbers are not comparable: on 16/09 the site read 2.1 m SW 14 s at Muizenberg ("7 ft",
1812 kJ), where a face height derived from the regional point gives about 3 ft. Both are right inside their own
system, and the stars are computed on the coastal height.

## 2. Wind, in six states

Surf-forecast classifies wind into six states, in 45° sectors around the offshore direction: glassy (under
5 km/h), off, cross-off, cross, cross-on, on. The penalty is brutal and asymmetric — these are the factors the 78
rows show, in km/h, and they are the curves `RATING.wind` implements:

| wind state | observed factor |
|---|---|
| off | ×1 up to 30 km/h, ×0.75 at 35, ×0.4 at 45, 0 around 55 |
| cross-off | ×1 up to 15, ×0.9 at 25, ×0.4 at 35, ×0.2 at 40, ×0.07 at 45, 0 at 50 |
| cross | ×0.83 at 10, ×0.65 at 15, ×0.4 at 20, 0 around 30 |
| cross-on | ×0.75 at 5, ×0.6 at 10, ×0.3 at 15, 0 at 20 |
| on | ×0.7 at 5, ×0.45 at 10, ×0.1 at 15, 0 at 18 |

Two things stand out. Onshore is severe: 0 from 20 km/h (11 kt) on, even at 4.5 m 18 s at Cathedral Rock. Offshore
is tolerant: nothing moves before 30 km/h (16 kt). And the gap between cross-off and cross — one sector — is the
difference between a day worth having and a day that is over.

The site does not use gusts, so neither do the stars.

## 3. The formula

On the 44 rows with clean wind (glassy, off, light cross-off), the base rating depends almost entirely on height:

    base = 1.81 + 0.37·H + 0.23·H²   (H in m, swell directed at the spot, capped at 10)

Roughly half a star per foot: 0.7 m → 2, 1.5 m → 3, 2.3 m → 4, 3 m → 5, 3.5 m → 6, 4 m → 7-8, 5 m → 9. Period has
no measurable weight in these rows (±1 between 10 s and 18 s), despite what the site's FAQ suggests — worth
revisiting with more rows. The energy the site displays is worth ≈ 2·H²·T² kJ (ratio of 0.9 to 1.0 across our
rows).

Final rating = round(base × wind factor). The model lands exactly right on 71% of the 78 rows and within ±1 star
on 97%, which is about the best available when the site rounds heights to 0.1 m and winds to 5 km/h. The "!" the
site sometimes shows instead of a rating (Papatowai at 5 m and up with 30 km/h and up) is a danger flag, not a
rating; the comparison script stores it as it is.

## 4. Gold and white

According to the FAQ and the app's release notes, gold means clean waves (glassy, off, cross-off) and white a
rating spoilt by the wind. It is not a second score — it is the colour of the same one.

The web page draws a single star per slot, with the rating in its centre. On 18/09/2026, across 264 slots on 11
Cape spot pages, its colour followed the wind state without exception: yellow under off and cross-off winds, white
under cross and on winds, and white at 0 whatever the wind. Pure cross is white too — Bali Bay (Glen Reef, the site's page for
Glen Beach) showed 1★, 2★ and 3★ under a cross wind, all white, next to yellow ones of the same rating under
cross-off. (No cross-on hour was
rated above 0 that day.) The yellow deepens with the rating, from a pale `hsl(57, 100%, 79%)` at 1★ to a gold
`hsl(48, 100%, 56%)` at 9★.

A first check, on 17/09, had concluded that the colour followed the rating alone: none of the pages read that day
had a rated hour under a cross or onshore wind, so every star above 0 was yellow.

The bot applies the same rule, with its own wind state. Where its state lands one 45° sector away from the site's
— usually cross-off against the site's cross, when the spot's facing or the forecast wind direction differ from
the site's — the colours differ: 54 of 255 rated slots on 18/09, most of them at Sunset Beach, Witsands, Outer
Kom and Scarborough. `npm run compare:sf` measures that agreement spot by spot.

Telegram text has no colour, so the bot spells it out: ⭐ (the emoji, yellow on every client) for gold, ☆ for
white, `0★` for nothing at all, and a ⭐ line under the day chart marking the hours whose stars are gold.

## 5. Keeping it honest

`npm run compare:sf` reads the site's 3-hour table for every curated spot that has a slug, sets it against what
the engine computes for the same hours — regional swell, swell at the spot's cell, wind, stars — and appends the
rows to `data/sf-compare.csv`. Per spot it prints site vs bot average, mean error in stars for each swell source,
height and wind differences, and how often the wind state agrees. On a first run, `--dump-html tmp/` shows whether
the parser still finds the rows: it is written against the pages' rendered text, not their raw HTML, so a redesign
breaks it loudly rather than silently.

One limit worth keeping in mind: the site's own orientations are approximate (it has Long Beach facing north,
Outer Kom facing SW). Reproducing its stars exactly would mean reproducing those errors too. The goal is a rating
on the same scale with the same wind rules, using our own orientations — which is why the script measures the
wind-state disagreement spot by spot.
