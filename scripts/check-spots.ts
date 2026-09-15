import regionsJson from '../src/data/regions.json';
import spotsJson from '../src/data/spots.json';
import { validateRegions, validateSpots } from '../src/data/schema';
import type { Region } from '../src/types';

const regionErrors = validateRegions(regionsJson);
const errors = [...regionErrors, ...validateSpots(spotsJson, regionErrors.length ? [] : (regionsJson as Region[]))];
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`spots.json OK — ${spotsJson.length} spots, ${regionsJson.length} régions`);
