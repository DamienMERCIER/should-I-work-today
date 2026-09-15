import regionsJson from './regions.json';
import spotsJson from './spots.json';
import { loadSpots } from './schema';

const loaded = loadSpots(spotsJson, regionsJson);
export const SPOTS = loaded.spots;
export const REGIONS = loaded.regions;
