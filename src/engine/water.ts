/** La combinaison conseillée, de la plus légère à la plus chaude. `full54Cold` : 5/4 avec chaussons, gants et cagoule. */
export type Wetsuit = 'lycra' | 'shorty' | 'full32' | 'full43' | 'full54' | 'full54Cold';

/**
 * La tenue pour une eau à `waterC` °C, arrondie au degré : le barème habituel des surf shops. Chaussons dès
 * la 5/4, gants et cagoule en plus à 10 °C et moins. Un conseil pour tout le monde, comme les étoiles : ni
 * frileux ni habitué.
 */
export function wetsuitFor(waterC: number): Wetsuit {
  if (waterC >= 24) return 'lycra';
  if (waterC >= 20) return 'shorty';
  if (waterC >= 17) return 'full32';
  if (waterC >= 14) return 'full43';
  if (waterC >= 11) return 'full54';
  return 'full54Cold';
}
