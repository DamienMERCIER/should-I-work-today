# Data and credits

The MIT licence in `LICENSE` covers the code. The data this project ships or fetches comes from elsewhere, under its
own terms.

## Forecasts — Open-Meteo

Every wave, wind, tide and sea-temperature figure the bot shows comes from [Open-Meteo](https://open-meteo.com) at
request time, through its free non-commercial tier. Open-Meteo's data is published under
[CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/); the bot credits it in the message a new friend gets, and in
`/about`. Nothing forecast-related is stored in this repository — only the coordinates the bot asks about.

## Spots — `src/data/spots.json`

The 35 curated spots are our own work: the short labels, the wave window, the exposure, the tide preferences and the
notes were written and checked by hand for the Cape Peninsula and the rest of South Africa.

## Spots — `src/data/spots-world.json`

The 6,183 imported spots hold, for each break, a name, a short label, coordinates, the direction it faces and a coarse
type. These are geographical facts, gathered from surf-forecast.com's own pages by `scripts/import-spots.ts`:

- only the two paths surf-forecast.com's `robots.txt` allows for an identified crawler — its sitemaps and
  `/breaks/<slug>/forecasts/latest` — are ever requested;
- every request carries an honest, identifying User-Agent (`scripts/lib/userAgentFetch.ts`), and the crawl stays
  gentle: the sitemaps are read one at a time, the break pages four at a time with a 250 ms pause between requests
  (`scripts/lib/fetchBreaks.ts`), over a run that takes hours rather than minutes;
- no forecast, no rating, no page text and no image is kept — the facing angle is derived from the wind table and then
  the page is dropped.

The file is here so that the worker builds and deploys without a multi-day crawl. Use it the way this project does:
personal, non-commercial. If you plan anything else with it, ask surf-forecast.com first, or regenerate your own list
from another source.

## Ratings

The star ratings are reconstructed from public surf-forecast.com pages by our own formula (`src/engine/rating.ts`,
explained in `docs/rating.md`). They are our approximation, not surf-forecast's data, and they can be wrong — that is
the point of `npm run compare:sf`, which measures how far apart the two are.

`data/sf-rows-2026-09-16.csv` keeps the 78 readings that formula was fitted to — wave height, period, energy, wind and
the site's own star count for one day, five spots. They are here as the evidence behind `docs/rating.md` and as golden
cases in `test/engine/rating.test.ts`, nothing more; `npm run compare:sf` regenerates the equivalent for any day.
