import regionsJson from '../src/data/regions.json';
import spotsJson from '../src/data/spots.json';
import { spotSlug } from '../src/bot/spotMatch';
import { validateRegions, validateSpots } from '../src/data/schema';
import { allWorldTuples, assignRegion, expandTuple, worldSpotId } from '../src/data/world';
import type { Region, Spot } from '../src/types';

const regionErrors = validateRegions(regionsJson);
const curatedRegions = regionErrors.length ? [] : (regionsJson as Region[]);
const curatedSpots = spotsJson as Spot[];
const errors = [...regionErrors, ...validateSpots(curatedSpots, curatedRegions)];

// --- world spots (src/data/spots-world.json) -----------------------------------------------------
// Deliberately NOT validated at module load (src/data/world.ts) — see its module doc: 8000 spots'
// worth of validation would itself threaten the Worker's 10 ms cold-start budget. This script is
// where that validation actually happens, in CI, expanding every tuple to a full Spot the same way
// `expandTuple` does at query time, so a bad tuple is caught here rather than at runtime.
const worldTuples = allWorldTuples();
const syntheticRegions = new Map<string, Region>();
const worldSpots: Spot[] = worldTuples.map((tuple) => {
  const spot = expandTuple(tuple, curatedRegions);
  if (!curatedRegions.some((r) => r.id === spot.region)) {
    const id = worldSpotId(tuple[0], tuple[2], tuple[3]);
    const region = assignRegion({ lat: tuple[2], lon: tuple[3], facing: tuple[4], id }, curatedRegions);
    syntheticRegions.set(region.id, region);
  }
  return spot;
});
const mergedRegions = [...curatedRegions, ...syntheticRegions.values()];

errors.push(...validateRegions(mergedRegions).map((e) => `world: ${e}`));
// Validated together with the curated set (not world spots alone) so a world spot can never quietly
// collide — same id, or same short within a shared region — with a curated one.
errors.push(...validateSpots([...curatedSpots, ...worldSpots], mergedRegions).map((e) => `world: ${e}`));

// validateSpots already enforces short ≤ 13 (≤ 11 since every world spot is unverified) — this is a
// belt-and-braces check spelled out because the import spec calls it out explicitly.
for (const spot of worldSpots) {
  if (spot.short.length > 13) errors.push(`world: ${spot.id}.short: "${spot.short}" is ${spot.short.length} chars, expected ≤ 13`);
}

// spotSlug (the Telegram /command derived from `short`) has no built-in uniqueness check of its own
// (src/bot/spotMatch.ts) — validateSpots only checks `short` for exact-string duplicates within a
// region. Two different short labels can still collapse to the same slug once normalised.
const idsBySlug = new Map<string, string[]>();
for (const spot of [...curatedSpots, ...worldSpots]) {
  const slug = spotSlug(spot);
  idsBySlug.set(slug, [...(idsBySlug.get(slug) ?? []), spot.id]);
}
for (const [slug, ids] of idsBySlug) {
  if (ids.length > 1) errors.push(`world: spotSlug collision "${slug}": ${ids.join(', ')}`);
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`spots.json OK — ${curatedSpots.length} spots, ${regionsJson.length} régions`);
console.log(`spots-world.json OK — ${worldSpots.length} world spots, ${syntheticRegions.size} synthetic region(s) beyond the curated ${curatedRegions.length}`);
